import AppKit
import Combine
import SwiftUI
import WebKit

@MainActor
final class NativeListeningSession: Identifiable {
    /// One track of the queue. A suggestion added with Play next plays like any
    /// other track, but it is not in the library: it records no history and the
    /// saved queue leaves it out.
    enum Entry {
        case occurrence(LibraryOccurrence)
        case suggestion(SuggestedVideoDTO)
    }

    let id = UUID()
    private(set) var playlist: LibraryPlaylist
    let coordinator: PlayerCoordinator
    /// The queue plays the playlist in its own order (In order, or the idle Play
    /// control), so a refresh puts new tracks at their place in the playlist.
    let inOrder: Bool
    private(set) var occurrencesByID: [OccurrenceID: LibraryOccurrence]
    /// Suggestions in the queue, by queue item ID.
    private(set) var suggestionsByItem: [Int: SuggestedVideoDTO] = [:]
    private let libraryGeneration: UUID
    private let hasRestarted: Bool
    private let testHooks: PlayerCoordinator.TestHooks?
    private var initialPlayRequested = false
    private var readySubscription: AnyCancellable?

    convenience init(items: [LibraryOccurrence], playlist: LibraryPlaylist, library: NativeLibraryModel, index: Int = 0,
                     autoplay: Bool = false, volume: Double = 1, inOrder: Bool = false, testHooks: PlayerCoordinator.TestHooks? = nil) {
        self.init(entries: items.map { Entry.occurrence($0) }, playlist: playlist, library: library, index: index,
                  autoplay: autoplay, volume: volume, inOrder: inOrder, testHooks: testHooks)
    }

    init(entries: [Entry], playlist: LibraryPlaylist, library: NativeLibraryModel, index: Int = 0, autoplay: Bool = false,
         volume: Double = 1, inOrder: Bool = false, testHooks: PlayerCoordinator.TestHooks? = nil, hasRestarted: Bool = false) {
        self.playlist = playlist
        self.inOrder = inOrder
        self.hasRestarted = hasRestarted
        self.testHooks = testHooks
        libraryGeneration = library.generation
        var occurrences: [OccurrenceID: LibraryOccurrence] = [:]
        var suggestions: [Int: SuggestedVideoDTO] = [:]
        var items: [PlayerCoordinator.Item] = []
        for (offset, entry) in entries.enumerated() {
            switch entry {
            case .occurrence(let value):
                let earlier = occurrences.updateValue(value, forKey: value.id)
                precondition(earlier == nil, "A queue holds each occurrence once")
                items.append(PlayerCoordinator.Item(id: offset, videoID: value.youtubeId, localOccurrenceID: value.id,
                                                    title: value.title, channel: value.channelTitle))
            case .suggestion(let value):
                suggestions[offset] = value
                items.append(PlayerCoordinator.Item(id: offset, videoID: value.youtubeId, title: value.title, channel: value.channelTitle))
            }
        }
        occurrencesByID = occurrences
        suggestionsByItem = suggestions
        coordinator = PlayerCoordinator(initialItems: items, initialIndex: index, volume: volume, testHooks: testHooks)
        let epoch = libraryGeneration
        coordinator.onNaturalCompletion = { [weak library] item in
            library?.recordNaturalCompletion(item, playlist: playlist.id, epoch: epoch)
        }
        coordinator.onQueueChanged = { [weak library] items, index in
            library?.saveQueue(items: items, index: index, playlist: playlist.id, epoch: epoch)
        }
        library.saveQueue(items: coordinator.queue, index: index, playlist: playlist.id, epoch: epoch)
        if autoplay {
            // Only an explicit Play/Shuffle/row action requests this one-shot play.
            // Resume, launch and view/size changes never request playback.
            initialPlayRequested = true
            readySubscription = coordinator.$ready.filter { $0 }.first().sink { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.coordinator.canTransport else { return }
                    self.initialPlayRequested = false
                    self.coordinator.play()
                }
            }
        }
    }

    var canRestartAutomatically: Bool {
        !hasRestarted && coordinator.recovery?.allowsAutomaticReload == true
    }

    func restarted(in library: NativeLibraryModel, automatically: Bool) -> NativeListeningSession? {
        guard library.generation == libraryGeneration, coordinator.recoveryRequired,
              !automatically || canRestartAutomatically else { return nil }
        let items = coordinator.queue
        let entries = items.compactMap { entry(for: $0) }
        guard entries.count == items.count else { return nil }

        // Retire the old bridge before starting another. Keep the last accepted
        // selection and only carry over an explicit Play that never ran.
        coordinator.stop()
        return NativeListeningSession(entries: entries, playlist: playlist, library: library,
            index: coordinator.index, autoplay: automatically && initialPlayRequested, volume: coordinator.volume,
            inOrder: inOrder, testHooks: testHooks, hasRestarted: true)
    }

    /// Brings the live queue up to date after its playlist was refreshed without
    /// interrupting the current track: tracks that left the playlist leave the
    /// queue (the one playing now is allowed to finish) and new tracks are placed
    /// at random positions among the upcoming ones, or at their place in the
    /// playlist when the queue plays in order. Suggestions stay where they are.
    /// `occurrences` are all of the refreshed playlist's tracks; `added` are the
    /// ones that are new to it. Returns false when the player is busy and the
    /// queue was left unchanged.
    @discardableResult
    func applyRefresh(playlist updated: LibraryPlaylist, occurrences: [LibraryOccurrence], added: [LibraryOccurrence],
                      draw: () -> Double = { Double.random(in: 0..<1) }) -> Bool {
        var latest: [OccurrenceID: LibraryOccurrence] = [:]
        for item in occurrences { latest[item.id] = item }
        let queue = coordinator.queue, current = coordinator.index
        guard queue.indices.contains(current) else { return false }
        func refreshed(_ entry: PlayerCoordinator.Item) -> PlayerCoordinator.Item? {
            guard let id = entry.localOccurrenceID else { return suggestionsByItem[entry.id] == nil ? nil : entry }
            guard let value = latest[id] else { return nil }
            return PlayerCoordinator.Item(id: entry.id, videoID: entry.videoID, localOccurrenceID: id,
                                          title: value.title, channel: value.channelTitle)
        }
        let played = queue[..<current].compactMap(refreshed)
        var upcoming = queue[(current + 1)...].compactMap(refreshed)
        var nextID = (queue.map(\.id).max() ?? -1) + 1
        let queued = Set(queue.compactMap(\.localOccurrenceID))
        for value in added where !queued.contains(value.id) && latest[value.id] != nil {
            let slot: Int
            if inOrder {
                // Before the first upcoming track that comes later in the playlist.
                slot = upcoming.firstIndex { entry in
                    entry.localOccurrenceID.flatMap { latest[$0] }.map { $0.position > value.position } ?? false
                } ?? upcoming.count
            } else {
                slot = min(upcoming.count, max(0, Int(draw() * Double(upcoming.count + 1))))
            }
            upcoming.insert(PlayerCoordinator.Item(id: nextID, videoID: value.youtubeId, localOccurrenceID: value.id,
                                                   title: value.title, channel: value.channelTitle), at: slot)
            nextID += 1
        }
        let now = refreshed(queue[current]) ?? queue[current]
        // Rows read these values when the coordinator publishes the new queue.
        for (id, value) in latest { occurrencesByID[id] = value }
        playlist = updated
        return coordinator.replaceQueue(played + [now] + upcoming, currentIndex: played.count)
    }

    /// Plays a suggestion right after the current track, like the website's
    /// Next. The current track keeps playing; asking again moves a queued copy
    /// up instead of adding another. Returns false when the player is busy (for
    /// example while a track loads) and the queue was left unchanged.
    @discardableResult
    func playNext(_ suggestion: SuggestedVideoDTO) -> Bool {
        let queue = coordinator.queue, current = coordinator.index
        guard queue.indices.contains(current), Self.isPlayable(suggestion) else { return false }
        let id = (queue.map(\.id).max() ?? -1) + 1
        let item = PlayerCoordinator.Item(id: id, videoID: suggestion.youtubeId, title: suggestion.title, channel: suggestion.channelTitle)
        let updated = queueWithNext(queue, after: current, item: item) { isSuggestion($0) && $0.videoID == suggestion.youtubeId }
        // Rows read the suggestion when the coordinator publishes the new queue.
        suggestionsByItem[id] = suggestion
        guard coordinator.replaceQueue(updated, currentIndex: current) else {
            suggestionsByItem[id] = nil
            return false
        }
        let kept = Set(updated.map(\.id))
        suggestionsByItem = suggestionsByItem.filter { kept.contains($0.key) }
        return true
    }

    static func isPlayable(_ suggestion: SuggestedVideoDTO) -> Bool {
        suggestion.youtubeId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    }

    func isSuggestion(_ item: PlayerCoordinator.Item) -> Bool {
        item.localOccurrenceID == nil && suggestionsByItem[item.id] != nil
    }

    func entry(for item: PlayerCoordinator.Item) -> Entry? {
        if let id = item.localOccurrenceID { return occurrencesByID[id].map { Entry.occurrence($0) } }
        return suggestionsByItem[item.id].map { Entry.suggestion($0) }
    }

    /// What the player and the queue show for a queue item. A suggestion gets a
    /// stand-in for display only; it is never stored or given to the library.
    func displayOccurrence(for item: PlayerCoordinator.Item) -> LibraryOccurrence? {
        switch entry(for: item) {
        case .occurrence(let value)?:
            return value
        case .suggestion(let value)?:
            return LibraryOccurrence(id: Self.displayID(forItem: item.id), playlistId: playlist.id, youtubeId: value.youtubeId,
                                     title: value.title, channelTitle: value.channelTitle, thumbnail: value.thumbnail,
                                     duration: value.duration, position: -1, viewCount: nil, likeCount: nil, description: nil,
                                     tags: nil, categoryId: nil, publishedAt: nil)
        case nil:
            return nil
        }
    }

    /// The display ID of a suggestion's queue row.
    static func displayID(forItem id: Int) -> OccurrenceID { OccurrenceID("suggestion:\(id)") }
}

private enum NativeUIEnvironment {
    static let isFixture = ProcessInfo.processInfo.arguments.contains("--ui-fixture")
    static let preferences: UserDefaults = isFixture
        ? UserDefaults(suiteName: "com.tubeshuffle.ui-fixture.\(UUID().uuidString)")! : .standard
}

@MainActor
struct NativePlaylistImportView: View {
    @ObservedObject var library: NativeLibraryModel
    @ObservedObject var account: NativeAccountModel
    @Binding var input: String
    let fixtureMode: Bool
    let width: CGFloat
    let createLibrary: () -> Void
    let openLibrary: () -> Void
    let openApp: () -> Void
    let cancel: () -> Void
    let imported: (PlaylistID) -> Void
    var observeBounds: (([String: CGRect]) -> Void)? = nil
    @FocusState private var inputFocused: Bool
    @State private var importTask: Task<Void, Never>?

    private var hasLocalLibrary: Bool { library.isOpen && !library.isDemo }
    private var validLink: Bool { NativeLibraryModel.playlistID(input) != nil }
    private var canImport: Bool { !fixtureMode && hasLocalLibrary && validLink && !account.busy && !library.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Image(systemName: "link").font(.title2)
                Text("Import YouTube playlist").font(.system(size: 23, weight: .bold)).tracking(-0.5)
            }
            if fixtureMode {
                Text("This demo uses sample tracks and keeps account access off. Open TubeShuffle to import your own playlists.")
                    .foregroundStyle(NativeUIStyle.secondary)
                Button("Open TubeShuffle", action: openApp).buttonStyle(NativeActionStyle(prominent: true))
                    .accessibilityIdentifier("import.openApp")
            } else {
                Text("Paste a public playlist link. Its tracks are saved on this Mac.").foregroundStyle(NativeUIStyle.secondary)
                TextField("https://www.youtube.com/playlist?list=…", text: $input)
                    .textFieldStyle(.roundedBorder).focused($inputFocused)
                    .accessibilityLabel("YouTube playlist link").accessibilityIdentifier("import.playlistURL")
                    .disabled(library.busy).onSubmit(importPlaylist)
                if !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !validLink {
                    Label("Use a playlist link with list=, or a playlist ID. Single-video and channel links are not supported.", systemImage: "exclamationmark.circle")
                        .font(.callout).foregroundStyle(.yellow).fixedSize(horizontal: false, vertical: true)
                }
                if !hasLocalLibrary {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Choose a local library", systemImage: "folder").font(.headline)
                        Text("Create a library for these tracks, or open one you already use.").font(.callout).foregroundStyle(NativeUIStyle.secondary)
                        HStack(spacing: 10) {
                            Button("Create library…", action: createLibrary).buttonStyle(NativeActionStyle()).nativeBounds("import.createLibrary")
                            Button("Open library…", action: openLibrary).buttonStyle(NativeActionStyle())
                        }
                    }.padding(14).modifier(NativeCard(radius: 16))
                } else {
                    Label("Save to: \(library.location)", systemImage: "folder").font(.callout).lineLimit(2)
                }
                if library.busy { ProgressView("Importing playlist…").controlSize(.small) }
                if let message = library.message {
                    Text(message).font(.callout).foregroundStyle(NativeUIStyle.secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("import.message")
                }
                Text("Existing playlists and history are kept.")
                    .font(.caption).foregroundStyle(NativeUIStyle.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { importTask?.cancel(); cancel() }
                    .buttonStyle(NativeActionStyle()).keyboardShortcut(.cancelAction).nativeBounds("import.cancel")
                if !fixtureMode {
                    Button("Import playlist", action: importPlaylist).buttonStyle(NativeActionStyle(prominent: true))
                        .disabled(!canImport).accessibilityIdentifier("import.submit").nativeBounds("import.submit")
                }
            }
        }.padding(24).frame(width: width).background(NativeUIStyle.background).foregroundStyle(.white)
            .coordinateSpace(name: "native.window")
            .onPreferenceChange(NativeUIBounds.self) { observeBounds?($0) }
            .interactiveDismissDisabled(library.busy)
            .onAppear { inputFocused = !fixtureMode }
            .onDisappear { importTask?.cancel() }
    }

    private func importPlaylist() {
        guard canImport, importTask == nil else { return }
        let source = NativeImportPlaylistSource(account: account)
        importTask = Task {
            let id = await library.importPlaylist(input, account: source)
            importTask = nil
            if !Task.isCancelled, let id { imported(id) }
        }
    }
}

@MainActor
struct NativeLibraryView: View {
    @StateObject private var library: NativeLibraryModel
    @StateObject private var account = NativeAccountModel()
    @StateObject private var queuePreparation = NativeQueuePreparation()
    // The playlist whose page is mounted. During playback it stays mounted (and
    // equal to the playing playlist) while the home grid is shown on top.
    @State private var selected: PlaylistID?
    @State private var showingHome = false
    @State private var listening: NativeListeningSession?
    @State private var showingAccount = false
    @State private var showingImport = false
    @State private var importNextStep: ImportNextStep?
    @State private var showingShortcuts = false
    @State private var playlistInput = ""
    @State private var suggestions: [SuggestedVideoDTO] = []
    @State private var suggestionsMessage: String?
    @State private var suggestionsBusy = false
    @State private var stage = false
    @AppStorage private var mode: Int
    @AppStorage private var excludeWatched: Bool
    @AppStorage private var showArtwork: Bool
    @AppStorage private var focus: Bool
    @AppStorage private var zoom: Double
    @State private var windowWidth: CGFloat = 1280
    private let restoresRecentLibrary: Bool
    private var observeBounds: (([String: CGRect]) -> Void)?
    private enum ImportNextStep { case createLibrary, openLibrary, ordinaryApp }
    private enum LibraryAction { case importPlaylist, createLibrary, openLibrary, importJSON, exportJSON, closeLibrary, account }
    private struct HomeEntry { let playlist: LibraryPlaylist; let count: Int; let firstVideoID: String }

    init(library: NativeLibraryModel? = nil, preferences: UserDefaults? = nil, session: NativeListeningSession? = nil,
         stage: Bool = false, initialImportForTesting: String? = nil, suggestionsForTesting: [SuggestedVideoDTO] = [],
         observeBounds: (([String: CGRect]) -> Void)? = nil) {
        _showingImport = State(initialValue: initialImportForTesting != nil)
        _playlistInput = State(initialValue: initialImportForTesting ?? "")
        _suggestions = State(initialValue: suggestionsForTesting)
        let store = preferences ?? NativeUIEnvironment.preferences
        // Only the app's own library reopens the last location. Injected
        // libraries (tests) and the synthetic demo never read or change it.
        let restores = library == nil && !NativeUIEnvironment.isFixture
        let model = library ?? NativeLibraryModel(recents: restores ? NativeRecentLibrary(defaults: store) : nil)
        restoresRecentLibrary = restores
        _library = StateObject(wrappedValue: model)
        _selected = State(initialValue: session?.playlist.id ?? model.snapshot.playlists.first?.id)
        _listening = State(initialValue: session)
        _stage = State(initialValue: stage)
        self.observeBounds = observeBounds
        _mode = AppStorage(wrappedValue: 0, "native.shuffleMode", store: store)
        _excludeWatched = AppStorage(wrappedValue: false, "native.excludeWatched", store: store)
        _showArtwork = AppStorage(wrappedValue: true, "native.showArtwork", store: store)
        _focus = AppStorage(wrappedValue: false, "native.focus", store: store)
        _zoom = AppStorage(wrappedValue: 1, "native.interfaceZoom", store: store)
    }

    private var playlist: LibraryPlaylist? { library.snapshot.playlists.first { $0.id == selected } }
    private var occurrences: [LibraryOccurrence] { library.snapshot.occurrences.filter { $0.playlistId == selected }.sorted { $0.position < $1.position } }
    private var showsHome: Bool { playlist == nil || showingHome }
    private var zoomBinding: Binding<Double>? {
        showingAccount || showingImport || showingShortcuts || library.pendingImport != nil ? nil : $zoom
    }
    private func sheetWidth(_ maximum: CGFloat) -> CGFloat { min(maximum, max(320, windowWidth - 32)) }

    var body: some View {
        GeometryReader { geometry in
            let scale = CGFloat(NativeInterfaceZoom.clamped(zoom))
            let size = CGSize(width: geometry.size.width / scale, height: geometry.size.height / scale)
            let metrics = NativePlayerLayout(width: size.width, height: size.height, stage: stage, focus: focus, showArtwork: showArtwork, scale: scale)
            VStack(spacing: 0) {
                if !stage { navigationBar(metrics) }
                ZStack(alignment: .top) {
                    if let playlist {
                        // While the home grid is shown during playback, the player
                        // page and its single web view stay mounted underneath, so
                        // browsing playlists never stops or reloads the music.
                        playlistPage(playlist, metrics: metrics)
                            .opacity(showsHome ? 0 : 1)
                            .allowsHitTesting(!showsHome)
                            .accessibilityHidden(showsHome)
                    }
                    if showsHome { homePage(metrics) }
                }
            }
            .overlay(alignment: .bottom) {
                if let message = library.message {
                    notice(message).frame(maxWidth: min(560, size.width - 24)).padding(.bottom, 16)
                }
            }
            .background { pageBackground }
            .frame(width: size.width, height: size.height)
            .scaleEffect(scale, anchor: .topLeading)
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            .onChange(of: geometry.size.width, initial: true) { windowWidth = geometry.size.width }
        }
        .coordinateSpace(name: "native.window")
        .onPreferenceChange(NativeUIBounds.self) { observeBounds?($0) }
        .foregroundStyle(.white).tint(.white).preferredColorScheme(.dark)
        .background(NativeWindowAttachment { account.attach($0); library.attach($0) })
        .background(NativeZoomKeyboard(zoom: $zoom))
        .focusedSceneValue(\.nativeInterfaceZoom, zoomBinding)
        .sheet(isPresented: $showingAccount) { NativeAccountView(account: account, localPlaylist: playlist, demo: library.isDemo || NativeUIEnvironment.isFixture, width: sheetWidth(650)) }
        .sheet(isPresented: $showingImport, onDismiss: continuePlaylistImport) { playlistImport }
        .sheet(isPresented: $showingShortcuts) { shortcuts }
        .sheet(isPresented: Binding(get: { library.pendingImport != nil }, set: { if !$0 { library.pendingImport = nil } })) { transferPreview }
        // A different (or closed) library invalidates the session and the page.
        .onChange(of: library.generation) { stopPlayback(); selectPage(nil); showingHome = false; stage = false }
        .onChange(of: excludeWatched) { queuePreparation.cancel() }
        .onExitCommand { if stage { stage = false } }
        .onDisappear { stopPlayback() }
        .onAppear {
            if NativeUIEnvironment.isFixture, !library.isOpen { library.openDemo() }
            else if restoresRecentLibrary { library.reopenRecentLibrary() }
        }
        .task(id: library.message) { await dismissMessageLater() }
    }

    private var pageBackground: some View {
        ZStack(alignment: .top) {
            NativeUIStyle.background
            RadialGradient(colors: [.white.opacity(0.09), .clear], center: .top, startRadius: 0, endRadius: 650).frame(height: 600)
        }.ignoresSafeArea()
    }

    private func navigationBar(_ metrics: NativePlayerLayout) -> some View {
        HStack(spacing: 12) {
            Button(action: goHome) {
                HStack(spacing: 8) {
                    Image(systemName: "shuffle").font(.system(size: 15, weight: .semibold)).frame(width: 30, height: 30)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
                    Text("TubeShuffle").font(.system(size: 15, weight: .bold))
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).help("Your playlists").accessibilityLabel("TubeShuffle, your playlists")
            Spacer(minLength: 8)
            if library.busy { ProgressView().controlSize(.small) }
            Button(action: goHome) {
                Label("Playlists", systemImage: "square.grid.2x2").frame(minHeight: 36).contentShape(Rectangle())
            }.buttonStyle(.plain).font(.system(size: 13, weight: showsHome ? .semibold : .medium))
                .foregroundStyle(showsHome ? Color.white : Color.white.opacity(0.80))
                .accessibilityIdentifier("library.playlists").help("Your saved playlists")
            Menu { libraryActions } label: { Label("Library", systemImage: "folder").frame(minHeight: 36) }
                .menuStyle(.borderlessButton).fixedSize().font(.system(size: 13, weight: .medium))
                .accessibilityIdentifier("library.menu").help("Import, library files and account")
                .nativeBounds("libraryAction")
        }.foregroundStyle(.white.opacity(0.80)).padding(.horizontal, metrics.narrow ? 12 : 28).frame(height: metrics.navigationHeight)
            .background(.black.opacity(0.45)).overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.07)).frame(height: 1) }
            .nativeBounds("navigation")
    }

    @ViewBuilder private var libraryActions: some View {
        Group {
            Button("Import YouTube playlist…", action: presentPlaylistImport).keyboardShortcut("l", modifiers: .command)
            Divider()
            Button("New library…") { performLibraryAction(.createLibrary) }.keyboardShortcut("n", modifiers: .command)
            Button("Open library…") { performLibraryAction(.openLibrary) }.keyboardShortcut("o", modifiers: .command)
            Divider()
            Button("Import JSON…") { performLibraryAction(.importJSON) }.disabled(!library.isOpen).keyboardShortcut("i", modifiers: [.command, .shift])
            Button("Export library…") { performLibraryAction(.exportJSON) }.disabled(!library.isOpen).keyboardShortcut("e", modifiers: [.command, .shift])
            if library.isOpen { Button("Close library") { performLibraryAction(.closeLibrary) } }
            Divider()
            Button("Shortcuts & media keys") { showingShortcuts = true }
            Button("Account…") { performLibraryAction(.account) }.disabled(NativeUIEnvironment.isFixture)
        }.disabled(library.busy)
    }

    // MARK: Home

    private func homePage(_ metrics: NativePlayerLayout) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: metrics.sectionSpacing) {
                if let listening {
                    NativeMiniPlayer(coordinator: listening.coordinator, session: listening, showArtwork: showArtwork,
                                     demo: library.isDemo, open: returnToPlayer)
                } else if let resume = resumableQueue {
                    resumeCard(playlist: resume.playlist, index: resume.index, count: resume.count)
                }
                if library.isOpen {
                    libraryHeader(metrics)
                    playlistGrid
                } else { welcome }
                footer
            }
            .frame(width: metrics.contentWidth, alignment: .leading)
            .padding(.top, metrics.pageTopInset).padding(.bottom, 28)
            .frame(maxWidth: .infinity)
        }.scrollIndicators(.visible).background { pageBackground }.nativeBounds("home")
    }

    private var resumableQueue: (playlist: LibraryPlaylist, index: Int, count: Int)? {
        guard listening == nil, let saved = library.savedQueue,
              let playlist = library.snapshot.playlists.first(where: { $0.id == PlaylistID(saved.playlistID) }) else { return nil }
        return (playlist, saved.index, saved.occurrenceIDs.count)
    }

    private func resumeCard(playlist: LibraryPlaylist, index: Int, count: Int) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath").font(.system(size: 17, weight: .medium)).frame(width: 40, height: 40)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text("Continue where you left off").font(.system(size: 13, weight: .semibold))
                Text("\(playlist.title) · Track \(index + 1) of \(count)").font(.system(size: 11))
                    .foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Button("Resume queue", action: resumeQueue).buttonStyle(NativeActionStyle())
        }.padding(12).modifier(NativeCard(radius: 18)).nativeBounds("resume")
    }

    private func libraryHeader(_ metrics: NativePlayerLayout) -> some View {
        let layout = metrics.narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14)) : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
        return layout {
            VStack(alignment: .leading, spacing: 6) {
                Text("YOUR LIBRARY").font(.system(size: 11, weight: .semibold)).tracking(2.5).foregroundStyle(.white.opacity(0.42))
                Text("My Playlists").font(.system(size: metrics.narrow ? 28 : 34, weight: .heavy)).tracking(-1)
                Text(librarySubtitle).font(.system(size: 13)).foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if !library.isDemo {
                Button(action: presentPlaylistImport) { Label("Import playlist", systemImage: "plus") }
                    .buttonStyle(NativeActionStyle(prominent: true)).disabled(library.busy)
                    .accessibilityIdentifier("library.importYouTube").help("Add a public YouTube playlist (⌘L)")
            }
        }.padding(22).modifier(NativeCard()).nativeBounds("libraryHeader")
    }

    private var librarySubtitle: String {
        if library.isDemo { return "Demo · sample videos · changes stay in memory" }
        let count = library.snapshot.playlists.count
        return "\(count) playlist\(count == 1 ? "" : "s") ready to shuffle · \(library.location)"
    }

    private var homeEntries: [HomeEntry] {
        var counts: [PlaylistID: Int] = [:]
        var first: [PlaylistID: (position: Int, video: String)] = [:]
        for item in library.snapshot.occurrences {
            counts[item.playlistId, default: 0] += 1
            if let known = first[item.playlistId], known.position <= item.position { continue }
            first[item.playlistId] = (item.position, item.youtubeId)
        }
        return library.snapshot.playlists
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            .map { HomeEntry(playlist: $0, count: counts[$0.id] ?? 0, firstVideoID: first[$0.id]?.video ?? "") }
    }

    @ViewBuilder private var playlistGrid: some View {
        let entries = homeEntries
        if entries.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "music.note.list").font(.system(size: 30)).foregroundStyle(NativeUIStyle.secondary)
                Text("No playlists yet").font(.system(size: 18, weight: .semibold))
                Text("Import a public YouTube playlist to start listening.").font(.callout).foregroundStyle(NativeUIStyle.secondary)
                if !library.isDemo {
                    Button("Import your first playlist", action: presentPlaylistImport)
                        .buttonStyle(NativeActionStyle(prominent: true)).disabled(library.busy)
                }
            }.frame(maxWidth: .infinity).padding(.vertical, 48).modifier(NativeCard())
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 16)], alignment: .leading, spacing: 16) {
                ForEach(entries, id: \.playlist.id) { entry in
                    NativePlaylistCard(playlist: entry.playlist, count: entry.count, firstVideoID: entry.firstVideoID,
                                       showArtwork: showArtwork, demo: library.isDemo,
                                       session: listening?.playlist.id == entry.playlist.id ? listening?.coordinator : nil,
                                       refreshing: library.refreshing == entry.playlist.id,
                                       canRefresh: !library.isDemo && !library.busy, inOrder: playsInOrder,
                                       open: { openPlaylist(entry.playlist.id) },
                                       refresh: { refreshPlaylist(entry.playlist.id) })
                }
            }.nativeBounds("playlistGrid")
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Your music. A different order.").font(.system(size: 34, weight: .bold)).tracking(-1)
            Text("Open the library with your playlists, or create a new one on this Mac. TubeShuffle opens it again automatically next time.")
                .font(.system(size: 15)).foregroundStyle(NativeUIStyle.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Open library…") { performLibraryAction(.openLibrary) }.buttonStyle(NativeActionStyle(prominent: true))
                    .accessibilityIdentifier("welcome.openLibrary")
                Button("Create library…") { performLibraryAction(.createLibrary) }.buttonStyle(NativeActionStyle())
                    .accessibilityIdentifier("welcome.createLibrary")
            }.disabled(library.busy)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(32).padding(.vertical, 30).modifier(NativeCard()).nativeBounds("welcome")
    }

    private var footer: some View {
        HStack {
            Text(library.isDemo ? "Demo library · sample videos · changes stay in memory" : "Library content and listening history stay on this Mac")
            Spacer(minLength: 0)
        }.font(.system(size: 11)).foregroundStyle(.white.opacity(0.35)).padding(.top, 4)
    }

    // MARK: Playlist page

    private func playlistPage(_ playlist: LibraryPlaylist, metrics: NativePlayerLayout) -> some View {
        ScrollViewReader { scroll in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: metrics.sectionSpacing) {
                    if !stage { playlistHeading(playlist, metrics: metrics, scroll: scroll) }
                    playerColumns(metrics, playlist: playlist, scroll: scroll).id("player")
                    if !stage {
                        shufflePanel(playlist, scroll: scroll).frame(width: metrics.playerWidth).id("shuffle")
                        suggestionsPanel
                        footer
                    }
                }
                .frame(width: metrics.contentWidth, alignment: .leading)
                .padding(.top, metrics.pageTopInset).padding(.bottom, 28)
                .frame(maxWidth: .infinity)
            }.scrollIndicators(.visible)
        }
    }

    private func playlistHeading(_ playlist: LibraryPlaylist, metrics: NativePlayerLayout, scroll: ScrollViewProxy) -> some View {
        let layout = metrics.narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 16))
        let refreshingThis = library.refreshing == playlist.id
        return layout {
            HStack(spacing: metrics.narrow ? 8 : 16) {
                NativeIconButton(symbol: "arrow.left", label: "Back to your playlists", action: goHome)
                VStack(alignment: .leading, spacing: metrics.compactChrome ? 4 : 5) {
                    Text(playlist.title).font(.system(size: metrics.compactChrome ? 22 : 26, weight: .bold)).tracking(-0.6).lineLimit(1)
                    HStack(spacing: 7) {
                        Text(playlist.channelTitle ?? "Local playlist")
                        Text("·")
                        Text("\(occurrences.count) videos")
                        if !library.isDemo, let url = URL(string: "https://www.youtube.com/playlist?list=\(playlist.youtubeId)") {
                            Link(destination: url) { Label("YouTube", systemImage: "arrow.up.right.square") }
                        }
                    }.font(.system(size: metrics.compactChrome ? 11 : 12)).foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                if !metrics.horizontal {
                    Button { scroll.scrollTo("queue", anchor: .top) } label: { Label("Queue", systemImage: "list.bullet") }.buttonStyle(NativeActionStyle())
                }
                if !library.isDemo {
                    Button { refreshPlaylist(playlist.id) } label: {
                        Label(refreshingThis ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                    }.buttonStyle(NativeActionStyle()).disabled(library.busy || showsHome)
                        .keyboardShortcut("r", modifiers: .command)
                        .help("Get the tracks added to or removed from this playlist on YouTube (⌘R)")
                        .accessibilityIdentifier("playlist.refresh")
                }
                Button { scroll.scrollTo("player", anchor: .top); startQueue(playlist) } label: {
                    Label(playsInOrder ? "Play in order" : "Shuffle", systemImage: queueSymbol)
                }.buttonStyle(NativeActionStyle()).disabled(occurrences.isEmpty || queuePreparation.busy)
                    .help(playsInOrder ? "Play this playlist again from its first track" : "Shuffle this playlist again and keep listening")
            }
        }.frame(height: metrics.headingHeight).nativeBounds("heading")
    }

    private func playerColumns(_ metrics: NativePlayerLayout, playlist: LibraryPlaylist, scroll: ScrollViewProxy) -> some View {
        let layout = metrics.horizontal ? AnyLayout(HStackLayout(alignment: .top, spacing: 20)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 20))
        return layout {
            Group {
                if let listening {
                    NativeLiveDeck(coordinator: listening.coordinator, session: listening, showArtwork: $showArtwork, focus: $focus,
                        stage: $stage, metrics: metrics, demo: library.isDemo, restart: { restartPlayback(listening, automatically: $0) },
                        covered: showsHome)
                        .id(listening.id)
                } else {
                    NativeIdleDeck(item: occurrences.first, count: occurrences.count, showArtwork: $showArtwork, focus: $focus,
                        stage: $stage, metrics: metrics, demo: library.isDemo) {
                            beginSession(items: occurrences, playlist: playlist, index: 0, autoplay: true, inOrder: true)
                        }
                }
            }.frame(width: metrics.playerWidth).nativeBounds("deck")
            if !stage {
                Group {
                    if let listening {
                        NativeLiveQueue(coordinator: listening.coordinator, session: listening, showArtwork: showArtwork, demo: library.isDemo, height: metrics.horizontal ? metrics.deckHeight : 420, revealPlayer: { scroll.scrollTo("player", anchor: .top) })
                    } else {
                        NativeQueueCard(items: occurrences, currentIndex: nil, showArtwork: showArtwork, demo: library.isDemo,
                            height: metrics.horizontal ? metrics.deckHeight : 420, canSelect: !library.busy) { index in
                                scroll.scrollTo("player", anchor: .top)
                                beginSession(items: occurrences, playlist: playlist, index: index, autoplay: true, inOrder: true)
                            }
                    }
                }.frame(width: metrics.queueWidth).id("queue")
            }
        }.frame(width: metrics.contentWidth, alignment: .leading)
    }

    private func shufflePanel(_ playlist: LibraryPlaylist, scroll: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Shape your queue").font(.system(size: 13, weight: .semibold))
            HStack(spacing: 4) {
                shuffleChoice("Normal", subtitle: "Every track, a surprise", value: 0, playlist: playlist, scroll: scroll)
                shuffleChoice("Smart", subtitle: "A smoother energy flow", value: 1, playlist: playlist, scroll: scroll)
                shuffleChoice("In order", subtitle: "The playlist as it is", value: Self.inOrderMode, playlist: playlist, scroll: scroll)
            }.fixedSize(horizontal: false, vertical: true) // Choices share the height of the tallest one.
                .padding(4).background(.black.opacity(0.32), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(NativeUIStyle.border))
                .nativeBounds("queueModes")
            Button { scroll.scrollTo("player", anchor: .top); startQueue(playlist) } label: {
                Label(shuffleButtonTitle, systemImage: queueSymbol).frame(maxWidth: .infinity)
            }.buttonStyle(NativeActionStyle(prominent: true)).disabled(occurrences.isEmpty || queuePreparation.busy)
            Rectangle().fill(NativeUIStyle.border).frame(height: 1)
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Skip watched").font(.system(size: 13, weight: .medium))
                    Text("Leave completed tracks out of your next queue.").font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary)
                }
                Spacer(minLength: 12)
                Toggle("", isOn: $excludeWatched).toggleStyle(NativeSwitch()).accessibilityLabel("Skip watched")
            }
            Button { showingShortcuts = true } label: { Label("Shortcuts & media keys", systemImage: "keyboard").frame(maxWidth: .infinity) }
                .buttonStyle(NativeActionStyle())
        }.padding(16).modifier(NativeCard())
    }

    // Like the website, choosing a mode shuffles again straight away; In order
    // starts again from the playlist's first track.
    private func shuffleChoice(_ title: String, subtitle: String, value: Int, playlist: LibraryPlaylist, scroll: ScrollViewProxy) -> some View {
        Button {
            mode = value
            scroll.scrollTo("player", anchor: .top)
            startQueue(playlist, mode: value)
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(subtitle).font(.system(size: 11)).opacity(0.60)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(10)
                .foregroundStyle(mode == value ? Color.black : Color.white)
                .background(mode == value ? Color.white : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(occurrences.isEmpty || queuePreparation.busy)
            .accessibilityAddTraits(mode == value ? .isSelected : [])
            .help(value == Self.inOrderMode ? "Play the playlist in its own order" : "Shuffle with \(title)")
    }

    private var suggestionsPanel: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Daily Suggestions").font(.system(size: 23, weight: .bold)).tracking(-0.5)
                Spacer()
                if !library.isDemo && !NativeUIEnvironment.isFixture {
                    Button(suggestionsBusy ? "Finding…" : "Find suggestions", action: loadSuggestions)
                        .buttonStyle(NativeActionStyle()).disabled(suggestionsBusy || account.busy)
                }
            }
            if suggestions.isEmpty {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "sparkles").foregroundStyle(Color.yellow.opacity(0.8))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("A little inspiration for your next listen").font(.system(size: 13, weight: .medium))
                        Text(suggestionsMessage ?? (library.isDemo || NativeUIEnvironment.isFixture ? "Suggestions are off in the demo. Your sample queue is ready to explore." : "Uses a few track titles and artists to search YouTube."))
                            .font(.system(size: 12)).foregroundStyle(NativeUIStyle.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }.padding(16).background(Color.yellow.opacity(0.065), in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(Color.yellow.opacity(0.10)))
            } else {
                // Play next adds to the queue of this playlist, once it is playing.
                let session = listening?.playlist.id == selected ? listening : nil
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 16) {
                    ForEach(Array(suggestions.prefix(5).enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 8) {
                            NativeArtwork(videoID: item.youtubeId, thumbnail: item.thumbnail, bundledDemo: library.isDemo).frame(height: 110)
                            Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(2, reservesSpace: true)
                            Text(item.channelTitle).font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
                            NativeSuggestionPlayNext(suggestion: item, session: session) {
                                library.message = "The player is busy. Choose Play next again in a moment."
                            }
                            if NativeListeningSession.isPlayable(item),
                               let url = URL(string: "https://www.youtube.com/watch?v=\(item.youtubeId)") { Link("Open on YouTube ↗", destination: url).font(.system(size: 12)) }
                        }
                    }
                }
                Text("Play next adds a suggestion to the queue that is playing, after the current track. Suggestions are not added to this playlist, its history or export.")
                    .font(.caption).foregroundStyle(NativeUIStyle.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(22).modifier(NativeCard()).nativeBounds("suggestions")
    }

    // MARK: Sheets and messages

    private var shortcuts: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Shortcuts & media keys").font(.title2.bold())
            ForEach([("Play / pause", "⌘⌥P"), ("Previous / next", "⌘⌥← / →"), ("Refresh playlist", "⌘R"), ("Zoom in / out", "⌘+ / ⌘−"), ("Actual size", "⌘0"), ("Leave Stage", "Esc"), ("Import YouTube playlist", "⌘L"), ("New / open library", "⌘N / ⌘O"), ("Import / export JSON", "⌘⇧I / ⌘⇧E")], id: \.0) { label, keys in
                HStack { Text(label); Spacer(); Text(keys).foregroundStyle(NativeUIStyle.secondary).monospaced() }
            }
            Text("System media keys use the same player controls. Playback must be ready first.").font(.caption).foregroundStyle(NativeUIStyle.secondary)
            Button("Done") { showingShortcuts = false }.buttonStyle(NativeActionStyle(prominent: true)).frame(maxWidth: .infinity, alignment: .trailing)
        }.padding(28).frame(width: sheetWidth(440)).background(NativeUIStyle.background)
    }

    private func notice(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle")
            Text(message).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            NativeIconButton(symbol: "xmark", label: "Dismiss message") { library.message = nil }
        }.padding(14).background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(NativeUIStyle.border))
            .shadow(color: .black.opacity(0.45), radius: 18, y: 8)
            .padding(.horizontal, 12).nativeBounds("notice")
    }

    // Messages fade after a while, like the website's toasts, but never while a
    // sheet that shows the same message is open.
    private func dismissMessageLater() async {
        guard library.message != nil else { return }
        try? await Task.sleep(nanoseconds: 10_000_000_000)
        // A sheet may still be showing this message; it goes once the sheet closes.
        while !Task.isCancelled, showingImport || showingAccount || library.pendingImport != nil {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        guard !Task.isCancelled else { return }
        library.message = nil
    }

    private var playlistImport: some View {
        NativePlaylistImportView(library: library, account: account, input: $playlistInput,
            fixtureMode: NativeUIEnvironment.isFixture, width: sheetWidth(540),
            createLibrary: { leaveImport(for: .createLibrary) }, openLibrary: { leaveImport(for: .openLibrary) },
            openApp: { leaveImport(for: .ordinaryApp) },
            cancel: { showingImport = false }, imported: { _ in
                // The new playlist appears in the grid; playback (if any) continues.
                playlistInput = ""; showingImport = false; goHome()
            }, observeBounds: observeBounds)
    }

    private func presentPlaylistImport() {
        performLibraryAction(.importPlaylist)
    }

    // Library changes reset the page through the generation change, so a
    // cancelled file panel leaves the current playlist and playback alone.
    private func performLibraryAction(_ action: LibraryAction) {
        guard !library.busy else { return }
        switch action {
        case .importPlaylist: library.message = nil; showingImport = true
        case .createLibrary: Task { await library.createLibrary() }
        case .openLibrary: Task { await library.openLibrary() }
        case .importJSON: library.previewImport()
        case .exportJSON: library.exportLibrary()
        case .closeLibrary: stopPlayback(); library.closeAndForgetLibrary()
        case .account: showingAccount = true
        }
    }

    private func leaveImport(for step: ImportNextStep) {
        importNextStep = step
        showingImport = false
    }

    private func continuePlaylistImport() {
        let step = importNextStep
        importNextStep = nil
        switch step {
        case .createLibrary:
            Task { await library.createLibrary(); reopenImportAfterFilePanel() }
        case .openLibrary:
            Task { await library.openLibrary(); reopenImportAfterFilePanel() }
        case .ordinaryApp:
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            configuration.arguments = []
            Task {
                do { _ = try await NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) }
                catch { library.message = "The regular app could not be opened. Launch Open TubeShuffle.command from the delivery folder." }
            }
        case nil: break
        }
    }

    private func reopenImportAfterFilePanel() {
        // The import sheet returns once the file panel has closed; presenting it
        // on the next turn lets the panel's sheet finish leaving the window.
        DispatchQueue.main.async { showingImport = true }
    }

    @ViewBuilder private var transferPreview: some View {
        if let preview = library.pendingImport {
            VStack(alignment: .leading, spacing: 16) {
                Text("Review transfer").font(.title2.bold())
                Text("\(preview.source.snapshot.playlists.count) playlists · \(preview.source.snapshot.occurrences.count) occurrences · \(preview.source.snapshot.history.count) history events")
                Text("\(preview.source.omittedOrphans.count) orphan history events will be omitted.").fontWeight(.semibold)
                ForEach(preview.disclosures, id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
                if !preview.source.omittedOrphans.isEmpty {
                    ScrollView { VStack(alignment: .leading) { ForEach(Array(preview.source.omittedOrphans.prefix(20).enumerated()), id: \.offset) { _, item in Text("\(item.id): \(item.reason)").font(.caption).textSelection(.enabled) } } }.frame(maxHeight: 100)
                    if preview.source.omittedOrphans.count > 20 { Text("Only the first 20 omissions are shown.").font(.caption) }
                }
                if !preview.mayCreateFreshLibrary { Label("This library is not empty. Create a new library to import this file.", systemImage: "exclamationmark.circle") }
                HStack { Spacer(); Button("Cancel") { library.pendingImport = nil }; Button("Import into empty library") { library.confirmImport(); goHome() }.disabled(!preview.mayCreateFreshLibrary || library.isDemo).buttonStyle(.borderedProminent) }
            }.padding(24).frame(width: sheetWidth(620))
        }
    }

    // MARK: Navigation and playback

    private func selectPage(_ id: PlaylistID?) {
        if selected != id { suggestions = []; suggestionsMessage = nil }
        selected = id
    }

    private func goHome() {
        stage = false
        showingHome = true
        // Without playback there is nothing to keep mounted under the grid.
        if listening == nil { queuePreparation.cancel(); selectPage(nil) }
    }

    private func returnToPlayer() {
        guard listening != nil else { return }
        showingHome = false
    }

    /// Opening a playlist shuffles it and starts listening, like the website.
    /// Opening the playlist that is already playing just returns to it.
    private func openPlaylist(_ id: PlaylistID) {
        guard let target = library.snapshot.playlists.first(where: { $0.id == id }) else { return }
        if let listening, listening.playlist.id == id { selectPage(id); showingHome = false; return }
        stopPlayback()
        selectPage(id)
        showingHome = false
        guard library.snapshot.occurrences.contains(where: { $0.playlistId == id }) else { return }
        startQueue(target)
    }

    private func refreshPlaylist(_ id: PlaylistID) {
        guard !library.busy, !library.isDemo else { return }
        let source = NativeImportPlaylistSource(account: account)
        Task {
            guard let outcome = await library.refreshPlaylist(id, account: source), outcome.changesTracks else { return }
            guard let listening, listening.playlist.id == id else { return }
            let current = library.snapshot.occurrences.filter { $0.playlistId == id }
            if !listening.applyRefresh(playlist: outcome.playlist, occurrences: current, added: outcome.added) {
                library.message = (library.message.map { $0 + " " } ?? "") + "Shuffle again to bring the changes into the queue that is playing."
            }
        }
    }

    private func stopPlayback() { queuePreparation.cancel(); listening?.coordinator.stop(); listening = nil }
    private func restartPlayback(_ failedSession: NativeListeningSession, automatically: Bool) {
        guard listening === failedSession, !automatically || !queuePreparation.busy,
              let replacement = failedSession.restarted(in: library, automatically: automatically) else { return }
        queuePreparation.cancel()
        listening = replacement
    }
    private func resumeQueue() {
        guard let saved = library.savedQueue,
              let playlist = library.snapshot.playlists.first(where: { $0.id == PlaylistID(saved.playlistID) }) else { return }
        do {
            let items = try saved.resolve(in: library.snapshot)
            selectPage(playlist.id)
            showingHome = false
            beginSession(items: items, playlist: playlist, index: saved.index, autoplay: false)
        } catch { library.message = "The saved queue no longer matches this library. No occurrence identities were inferred." }
    }
    private func startQueue(_ playlist: LibraryPlaylist, mode requested: Int? = nil) {
        let source = library.snapshot, epoch = library.generation, selectedID = selected
        let requestedMode = requested ?? mode, requestedExclusion = excludeWatched, sessionID = listening?.id
        Task {
            guard epoch == library.generation, selected == selectedID, listening?.id == sessionID else { return }
            let items = await queuePreparation.prepare(snapshot: source, playlist: playlist.id,
                mode: Self.queueMode(requestedMode), excludeWatched: requestedExclusion)
            // A newer shuffle supersedes this one inside the preparation itself.
            guard let items, epoch == library.generation, selected == selectedID, listening?.id == sessionID,
                  excludeWatched == requestedExclusion else { return }
            beginSession(items: items, playlist: playlist, index: 0, autoplay: true, inOrder: requestedMode == Self.inOrderMode)
        }
    }
    /// Stored values of the queue mode preference: 0 Normal, 1 Smart, 2 In order.
    private static let inOrderMode = 2
    private static func queueMode(_ value: Int) -> LibraryQueueBuilder.Mode {
        switch value {
        case 1: return .smart
        case inOrderMode: return .inOrder
        default: return .normal
        }
    }
    private var playsInOrder: Bool { mode == Self.inOrderMode }
    private var queueSymbol: String { playsInOrder ? "list.number" : "shuffle" }
    private var shuffleButtonTitle: String {
        if queuePreparation.busy { return playsInOrder ? "Preparing…" : "Shuffling…" }
        if playsInOrder { return listening == nil ? "Play in order" : "Play from the start" }
        return listening == nil ? "Shuffle & listen" : "Reshuffle queue"
    }
    private func beginSession(items: [LibraryOccurrence], playlist: LibraryPlaylist, index: Int, autoplay: Bool, inOrder: Bool = false) {
        guard !items.isEmpty else { library.message = "No tracks match this filter. Try turning Skip watched off."; return }
        guard items.allSatisfy({ $0.youtubeId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil }) else {
            library.message = "This queue contains an ID that cannot be played. No occurrences were silently skipped."; return
        }
        // A new queue keeps the volume chosen in the one it replaces.
        let volume = listening?.coordinator.volume ?? 1
        stopPlayback()
        listening = NativeListeningSession(items: items, playlist: playlist, library: library, index: index, autoplay: autoplay,
                                           volume: volume, inOrder: inOrder)
    }

    private func loadSuggestions() {
        guard let playlist, !suggestionsBusy else { return }
        let epoch = library.generation, selectedID = selected
        let seeds = occurrences.prefix(5).map { SuggestionSeed.minimal(title: $0.title, channelTitle: $0.channelTitle, duration: $0.duration) }
        suggestionsBusy = true
        Task {
            let result = await account.fetchSuggestions(.init(playlistId: playlist.youtubeId, seeds: seeds))
            suggestionsBusy = false
            guard epoch == library.generation, selectedID == selected else { return }
            suggestions = result?.suggestions ?? []
            suggestionsMessage = result == nil ? account.message : "No suggestions today. Try again tomorrow."
        }
    }
}

struct NativeWindowAttachment: NSViewRepresentable {
    let attached: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView { let view = WindowTrackingView(); view.attached = attached; return view }
    func updateNSView(_ view: NSView, context: Context) { if let window = view.window { attached(window) } }
}
