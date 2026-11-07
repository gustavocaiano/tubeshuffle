import AppKit
import Combine
import SwiftUI
import WebKit

@MainActor
final class NativeListeningSession: Identifiable {
    let id = UUID()
    let playlist: LibraryPlaylist
    let coordinator: PlayerCoordinator
    let occurrencesByID: [OccurrenceID: LibraryOccurrence]
    private var readySubscription: AnyCancellable?

    init(items: [LibraryOccurrence], playlist: LibraryPlaylist, library: NativeLibraryModel, index: Int = 0, autoplay: Bool = false, testHooks: PlayerCoordinator.TestHooks? = nil) {
        self.playlist = playlist
        occurrencesByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        coordinator = PlayerCoordinator(initialItems: items.enumerated().map { index, item in
            PlayerCoordinator.Item(id: index, videoID: item.youtubeId, localOccurrenceID: item.id, title: item.title, channel: item.channelTitle)
        }, initialIndex: index, testHooks: testHooks)
        let epoch = library.generation
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
            readySubscription = coordinator.$ready.filter { $0 }.first().sink { [weak coordinator] _ in
                Task { @MainActor in coordinator?.play() }
            }
        }
    }
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
    let connectAccount: () -> Void
    let openApp: () -> Void
    let cancel: () -> Void
    let imported: (PlaylistID) -> Void
    @FocusState private var inputFocused: Bool

    private var hasLocalLibrary: Bool { library.isOpen && !library.isDemo }
    private var validLink: Bool { NativeLibraryModel.playlistID(input) != nil }
    private var canImport: Bool { !fixtureMode && hasLocalLibrary && validLink && account.canFetchPlaylists && !library.busy }

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
                            Button("Create library…", action: createLibrary).buttonStyle(NativeActionStyle())
                            Button("Open library…", action: openLibrary).buttonStyle(NativeActionStyle())
                        }
                    }.padding(14).modifier(NativeCard(radius: 16))
                } else {
                    Label("Save to: \(library.location)", systemImage: "folder").font(.callout).lineLimit(2)
                }
                if account.state != .signedIn {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Connect your account").font(.headline)
                            Text("Sign in to TubeShuffle to load the playlist from YouTube.").font(.callout).foregroundStyle(NativeUIStyle.secondary)
                        }
                        Spacer(minLength: 0)
                        Button("Connect", action: connectAccount).buttonStyle(NativeActionStyle())
                            .disabled(!hasLocalLibrary || account.busy).accessibilityIdentifier("import.connect")
                    }.padding(14).modifier(NativeCard(radius: 16))
                }
                if library.busy { ProgressView("Importing playlist…").controlSize(.small) }
                if let message = library.message {
                    Text(message).font(.callout).foregroundStyle(NativeUIStyle.secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("import.message")
                }
                Text("Saving the link to your account is optional and separate. Existing playlists and history are kept.")
                    .font(.caption).foregroundStyle(NativeUIStyle.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).buttonStyle(NativeActionStyle()).keyboardShortcut(.cancelAction).disabled(library.busy)
                if !fixtureMode {
                    Button("Import playlist", action: importPlaylist).buttonStyle(NativeActionStyle(prominent: true))
                        .disabled(!canImport).accessibilityIdentifier("import.submit")
                }
            }
        }.padding(24).frame(width: width).background(NativeUIStyle.background).foregroundStyle(.white)
            .interactiveDismissDisabled(library.busy)
            .onAppear { inputFocused = !fixtureMode }
    }

    private func importPlaylist() {
        guard canImport else { return }
        Task { if let id = await library.importPlaylist(input, account: account) { imported(id) } }
    }
}

@MainActor
struct NativeLibraryView: View {
    @StateObject private var library: NativeLibraryModel
    @StateObject private var account = NativeAccountModel()
    @StateObject private var queuePreparation = NativeQueuePreparation()
    @State private var selected: PlaylistID?
    @State private var listening: NativeListeningSession?
    @State private var showingAccount = false
    @State private var showingLibrary = false
    @State private var showingImport = false
    @State private var libraryNextAction: LibraryAction?
    @State private var importAfterAccount = false
    @State private var importNextStep: ImportNextStep?
    @State private var showingShortcuts = false
    @State private var playlistInput = ""
    @State private var suggestions: [SuggestedVideoDTO] = []
    @State private var suggestionsMessage: String?
    @State private var suggestionsBusy = false
    @State private var mode = 0
    @State private var stage = false
    @AppStorage private var excludeWatched: Bool
    @AppStorage private var showArtwork: Bool
    @AppStorage private var focus: Bool
    @AppStorage private var zoom: Double
    @State private var windowWidth: CGFloat = 1280
    private var observeBounds: (([String: CGRect]) -> Void)?
    private enum ImportNextStep { case createLibrary, openLibrary, account, ordinaryApp }
    private enum LibraryAction { case importPlaylist, createLibrary, openLibrary, importJSON, exportJSON, closeLibrary, account }

    init(library: NativeLibraryModel? = nil, preferences: UserDefaults? = nil, session: NativeListeningSession? = nil,
         stage: Bool = false, observeBounds: (([String: CGRect]) -> Void)? = nil) {
        let model = library ?? NativeLibraryModel()
        _library = StateObject(wrappedValue: model)
        _selected = State(initialValue: model.snapshot.playlists.first?.id)
        _listening = State(initialValue: session)
        _stage = State(initialValue: stage)
        self.observeBounds = observeBounds
        let store = preferences ?? NativeUIEnvironment.preferences
        _excludeWatched = AppStorage(wrappedValue: false, "native.excludeWatched", store: store)
        _showArtwork = AppStorage(wrappedValue: true, "native.showArtwork", store: store)
        _focus = AppStorage(wrappedValue: false, "native.focus", store: store)
        _zoom = AppStorage(wrappedValue: 1, "native.interfaceZoom", store: store)
    }

    private var playlist: LibraryPlaylist? { library.snapshot.playlists.first { $0.id == selected } }
    private var occurrences: [LibraryOccurrence] { library.snapshot.occurrences.filter { $0.playlistId == selected }.sorted { $0.position < $1.position } }
    private var zoomBinding: Binding<Double>? {
        showingAccount || showingLibrary || showingImport || showingShortcuts || library.pendingImport != nil ? nil : $zoom
    }
    private func sheetWidth(_ maximum: CGFloat) -> CGFloat { min(maximum, max(320, windowWidth - 32)) }

    var body: some View {
        GeometryReader { geometry in
            let scale = CGFloat(NativeInterfaceZoom.clamped(zoom))
            let size = CGSize(width: geometry.size.width / scale, height: geometry.size.height / scale)
            let metrics = NativePlayerLayout(width: size.width, height: size.height, stage: stage, focus: focus, showArtwork: showArtwork, scale: scale)
            VStack(spacing: 0) {
                if !stage { navigationBar(metrics) }
                ScrollViewReader { scroll in
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: metrics.sectionSpacing) {
                        if let playlist {
                            if !stage { playlistHeading(playlist, metrics: metrics, scroll: scroll) }
                            playerColumns(metrics, playlist: playlist, scroll: scroll).id("player")
                            if !stage {
                                shufflePanel(playlist, scroll: scroll).frame(width: metrics.playerWidth).id("shuffle")
                                suggestionsPanel
                            }
                        } else { welcome }
                        if let message = library.message { notice(message) }
                        if library.busy { ProgressView("Working with your library…").tint(.white) }
                        if !stage {
                            HStack {
                                Text(library.isDemo ? "Demo library · sample videos · changes stay in memory" : "Library content and listening history stay on this Mac")
                                Spacer(minLength: 0)
                            }.font(.system(size: 11)).foregroundStyle(.white.opacity(0.35)).padding(.top, 4)
                        }
                    }
                    .frame(width: metrics.contentWidth, alignment: .leading)
                    .padding(.top, metrics.pageTopInset).padding(.bottom, 28)
                    .frame(maxWidth: .infinity)
                }.scrollIndicators(.visible)
                }
            }
            .background {
                ZStack(alignment: .top) {
                    NativeUIStyle.background
                    RadialGradient(colors: [.white.opacity(0.09), .clear], center: .top, startRadius: 0, endRadius: 650).frame(height: 600)
                }.ignoresSafeArea()
            }
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
        .sheet(isPresented: $showingAccount, onDismiss: {
            if importAfterAccount { importAfterAccount = false; showingImport = true }
        }) { NativeAccountView(account: account, localPlaylist: playlist, demo: library.isDemo || NativeUIEnvironment.isFixture, width: sheetWidth(650)) }
        .sheet(isPresented: $showingLibrary, onDismiss: continueLibraryAction) { libraryBrowser }
        .sheet(isPresented: $showingImport, onDismiss: continuePlaylistImport) { playlistImport }
        .sheet(isPresented: $showingShortcuts) { shortcuts }
        .sheet(isPresented: Binding(get: { library.pendingImport != nil }, set: { if !$0 { library.pendingImport = nil } })) { transferPreview }
        .onChange(of: selected) { queuePreparation.cancel(); suggestions = []; suggestionsMessage = nil }
        .onChange(of: library.generation) { stopPlayback() }
        .onChange(of: mode) { queuePreparation.cancel() }
        .onChange(of: excludeWatched) { queuePreparation.cancel() }
        .onChange(of: library.snapshot.playlists.map(\.id)) { ids in if selected == nil { selected = ids.first } }
        .onExitCommand { if stage { stage = false } }
        .onDisappear { stopPlayback() }
        .onAppear { if NativeUIEnvironment.isFixture, !library.isOpen { library.openDemo(); selectFirst() } }
    }

    private func navigationBar(_ metrics: NativePlayerLayout) -> some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "shuffle").font(.system(size: 15, weight: .semibold)).frame(width: 30, height: 30)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
                Text("TubeShuffle").font(.system(size: 15, weight: .bold))
            }
            Spacer(minLength: 8)
            Menu {
                Button("Your playlists…") { showingLibrary = true }
                Divider()
                libraryActions
            } label: { Label("Library", systemImage: "square.grid.2x2").frame(minHeight: 36) }
                .menuStyle(.borderlessButton).fixedSize().font(.system(size: 13, weight: .medium))
                .accessibilityIdentifier("library.menu").help("Playlists, import, library files and account")
                .nativeBounds("libraryAction")
        }.foregroundStyle(.white.opacity(0.80)).padding(.horizontal, metrics.narrow ? 12 : 28).frame(height: metrics.navigationHeight)
            .background(.black.opacity(0.45)).overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.07)).frame(height: 1) }
            .nativeBounds("navigation")
    }

    @ViewBuilder private var libraryActions: some View {
        Group {
            Button("Import YouTube playlist…", action: presentPlaylistImport).keyboardShortcut("l", modifiers: .command)
            Button("New library…") { performLibraryAction(.createLibrary) }.keyboardShortcut("n", modifiers: .command)
            Button("Open library…") { performLibraryAction(.openLibrary) }.keyboardShortcut("o", modifiers: .command)
            Divider()
            Button("Import JSON…") { performLibraryAction(.importJSON) }.disabled(!library.isOpen).keyboardShortcut("i", modifiers: [.command, .shift])
            Button("Export library…") { performLibraryAction(.exportJSON) }.disabled(!library.isOpen).keyboardShortcut("e", modifiers: [.command, .shift])
            if library.isOpen { Button("Close library") { performLibraryAction(.closeLibrary) } }
            Divider()
            Button("Account…") { performLibraryAction(.account) }.disabled(NativeUIEnvironment.isFixture)
        }.disabled(library.busy)
    }

    private func playlistHeading(_ playlist: LibraryPlaylist, metrics: NativePlayerLayout, scroll: ScrollViewProxy) -> some View {
        let layout = metrics.narrow ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 16))
        return layout {
            HStack(spacing: metrics.narrow ? 8 : 16) {
                NativeIconButton(symbol: "arrow.left", label: "Back to library") { showingLibrary = true }
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
                Button { scroll.scrollTo("shuffle", anchor: .bottom) } label: { Label("Shuffle", systemImage: "shuffle") }.buttonStyle(NativeActionStyle())
                if library.savedQueue != nil, listening == nil {
                    Button("Resume queue", action: resumeQueue).buttonStyle(NativeActionStyle())
                }
            }
        }.frame(height: metrics.headingHeight).nativeBounds("heading")
    }

    private func playerColumns(_ metrics: NativePlayerLayout, playlist: LibraryPlaylist, scroll: ScrollViewProxy) -> some View {
        let layout = metrics.horizontal ? AnyLayout(HStackLayout(alignment: .top, spacing: 20)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 20))
        return layout {
            Group {
                if let listening {
                    NativeLiveDeck(coordinator: listening.coordinator, session: listening, showArtwork: $showArtwork, focus: $focus,
                        stage: $stage, metrics: metrics, demo: library.isDemo, restart: restartPlayback)
                        .id(listening.id)
                } else {
                    NativeIdleDeck(item: occurrences.first, count: occurrences.count, showArtwork: $showArtwork, focus: $focus,
                        stage: $stage, metrics: metrics, demo: library.isDemo) { beginSession(items: occurrences, playlist: playlist, index: 0, autoplay: true) }
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
                                beginSession(items: occurrences, playlist: playlist, index: index, autoplay: true)
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
                shuffleChoice("Normal", subtitle: "Every track, a surprise", value: 0)
                shuffleChoice("Smart", subtitle: "A smoother energy flow", value: 1)
            }.padding(4).background(.black.opacity(0.32), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(NativeUIStyle.border))
            Button { scroll.scrollTo("player", anchor: .top); startQueue(playlist) } label: {
                Label(shuffleButtonTitle, systemImage: "shuffle").frame(maxWidth: .infinity)
            }.buttonStyle(NativeActionStyle(prominent: true)).disabled(occurrences.isEmpty || library.busy || queuePreparation.busy)
            Rectangle().fill(NativeUIStyle.border).frame(height: 1)
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Skip watched").font(.system(size: 13, weight: .medium))
                    Text("Leave completed tracks out of your next shuffle.").font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary)
                }
                Spacer(minLength: 12)
                Toggle("", isOn: $excludeWatched).toggleStyle(NativeSwitch()).accessibilityLabel("Skip watched")
            }
            Button { showingShortcuts = true } label: { Label("Shortcuts & media keys", systemImage: "keyboard").frame(maxWidth: .infinity) }
                .buttonStyle(NativeActionStyle())
        }.padding(16).modifier(NativeCard())
    }

    private func shuffleChoice(_ title: String, subtitle: String, value: Int) -> some View {
        Button { mode = value } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(subtitle).font(.system(size: 11)).opacity(0.60)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                .foregroundStyle(mode == value ? Color.black : Color.white)
                .background(mode == value ? Color.white : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).accessibilityAddTraits(mode == value ? .isSelected : [])
    }

    private var suggestionsPanel: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Daily Suggestions").font(.system(size: 23, weight: .bold)).tracking(-0.5)
                Spacer()
                if account.state == .signedIn && !library.isDemo {
                    Button(suggestionsBusy ? "Finding…" : "Find suggestions", action: loadSuggestions)
                        .buttonStyle(NativeActionStyle()).disabled(suggestionsBusy)
                }
            }
            if suggestions.isEmpty {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "sparkles").foregroundStyle(Color.yellow.opacity(0.8))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(library.isDemo ? "Discover more with your account" : "A little inspiration for your next listen").font(.system(size: 13, weight: .medium))
                        Text(suggestionsMessage ?? (library.isDemo ? "Suggestions are off in the demo. Your sample queue is ready to explore." : "Connect your account to find suggestions for this playlist."))
                            .font(.system(size: 12)).foregroundStyle(NativeUIStyle.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if !library.isDemo { Button("Account") { showingAccount = true }.buttonStyle(NativeActionStyle()).disabled(NativeUIEnvironment.isFixture) }
                }.padding(16).background(Color.yellow.opacity(0.065), in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(Color.yellow.opacity(0.10)))
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 16) {
                    ForEach(Array(suggestions.prefix(5).enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 8) {
                            NativeArtwork(videoID: item.youtubeId).frame(height: 110)
                            Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                            Text(item.channelTitle).font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary)
                            if item.youtubeId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
                               let url = URL(string: "https://www.youtube.com/watch?v=\(item.youtubeId)") { Link("Open on YouTube ↗", destination: url).font(.system(size: 12)) }
                        }
                    }
                }
                Text("Suggestions open on YouTube. Their listening events are not in this library or its export.").font(.caption).foregroundStyle(NativeUIStyle.secondary)
            }
        }.padding(22).modifier(NativeCard())
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(library.isOpen ? "Your library, ready for a new mix." : "Your music. A different order.").font(.system(size: 34, weight: .bold)).tracking(-1)
            Text("Open Library to add your playlists and start listening.").font(.system(size: 15)).foregroundStyle(NativeUIStyle.secondary)
            Button("Open Library") { showingLibrary = true }.buttonStyle(NativeActionStyle(prominent: true))
        }.frame(maxWidth: .infinity, alignment: .leading).padding(32).padding(.vertical, 50).modifier(NativeCard())
    }

    private var librarySubtitle: String {
        if library.isDemo { return "Demo · six public playback examples" }
        if library.isOpen { return library.location }
        return "Your playlists, saved on this Mac."
    }

    private var libraryBrowser: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("Library").font(.system(size: 26, weight: .bold)); Spacer(); Button("Done") { showingLibrary = false }.buttonStyle(NativeActionStyle()) }
            Text(librarySubtitle).font(.system(size: 12)).foregroundStyle(NativeUIStyle.secondary)
            ScrollView {
                if library.snapshot.playlists.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "music.note.list").font(.system(size: 30)).foregroundStyle(NativeUIStyle.secondary)
                        Text("No playlists yet").font(.system(size: 18, weight: .semibold))
                        Text("Import a YouTube playlist to start your library.").font(.callout).foregroundStyle(NativeUIStyle.secondary)
                    }.frame(maxWidth: .infinity).padding(.vertical, 56)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 230))], spacing: 16) {
                    ForEach(library.snapshot.playlists, id: \.id) { item in
                        let tracks = library.snapshot.occurrences.filter { $0.playlistId == item.id }
                        Button {
                            if selected != item.id { stopPlayback() }
                            selected = item.id; showingLibrary = false
                        } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                NativeArtwork(videoID: tracks.first?.youtubeId ?? "", thumbnail: item.thumbnail ?? "", bundledDemo: library.isDemo).frame(height: 125)
                                Text(item.title).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                                Text("\(tracks.count) videos · Open playlist").font(.system(size: 12)).foregroundStyle(NativeUIStyle.secondary)
                            }.padding(12).modifier(NativeCard(radius: 20))
                        }.buttonStyle(.plain)
                    }
                }
            }.frame(minHeight: 220, maxHeight: 380)
            HStack(spacing: 12) {
                Button("Import YouTube playlist", action: presentPlaylistImport).buttonStyle(NativeActionStyle(prominent: true))
                    .accessibilityIdentifier("library.importYouTube").disabled(library.busy)
                Spacer(minLength: 0)
                Menu("Options") { libraryActions }.menuStyle(.borderlessButton).fixedSize()
            }
        }.padding(28).frame(width: sheetWidth(640)).background(NativeUIStyle.background).foregroundStyle(.white)
    }

    private var shortcuts: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Shortcuts & media keys").font(.title2.bold())
            ForEach([("Play / pause", "⌘⌥P"), ("Previous / next", "⌘⌥← / →"), ("Zoom in / out", "⌘+ / ⌘−"), ("Actual size", "⌘0"), ("Leave Stage", "Esc"), ("Import YouTube playlist", "⌘L"), ("New / open library", "⌘N / ⌘O"), ("Import / export JSON", "⌘⇧I / ⌘⇧E")], id: \.0) { label, keys in
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
        }.padding(16).modifier(NativeCard(radius: 16))
    }

    private var playlistImport: some View {
        NativePlaylistImportView(library: library, account: account, input: $playlistInput,
            fixtureMode: NativeUIEnvironment.isFixture, width: sheetWidth(540),
            createLibrary: { leaveImport(for: .createLibrary) }, openLibrary: { leaveImport(for: .openLibrary) },
            connectAccount: { leaveImport(for: .account) }, openApp: { leaveImport(for: .ordinaryApp) },
            cancel: { showingImport = false }, imported: { id in
                stopPlayback(); selected = id; playlistInput = ""; showingImport = false
            })
    }

    private func presentPlaylistImport() {
        performLibraryAction(.importPlaylist)
    }

    private func performLibraryAction(_ action: LibraryAction) {
        guard !library.busy else { return }
        if showingLibrary { libraryNextAction = action; showingLibrary = false }
        else { applyLibraryAction(action) }
    }

    private func continueLibraryAction() {
        guard let action = libraryNextAction else { return }
        libraryNextAction = nil
        applyLibraryAction(action)
    }

    private func applyLibraryAction(_ action: LibraryAction) {
        guard !library.busy else { return }
        switch action {
        case .importPlaylist: library.message = nil; showingImport = true
        case .createLibrary: stopPlayback(); library.createLibrary(); selectFirst()
        case .openLibrary: stopPlayback(); library.openLibrary(); selectFirst()
        case .importJSON: library.previewImport()
        case .exportJSON: library.exportLibrary()
        case .closeLibrary: stopPlayback(); library.closeLibrary(); selected = nil
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
            stopPlayback(); library.createLibrary(); selectFirst(); showingImport = true
        case .openLibrary:
            stopPlayback(); library.openLibrary(); selectFirst(); showingImport = true
        case .account:
            importAfterAccount = true; showingAccount = true
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
                HStack { Spacer(); Button("Cancel") { library.pendingImport = nil }; Button("Import into empty library") { library.confirmImport(); selectFirst() }.disabled(!preview.mayCreateFreshLibrary || library.isDemo).buttonStyle(.borderedProminent) }
            }.padding(24).frame(width: sheetWidth(620))
        }
    }

    private func selectFirst() { selected = library.snapshot.playlists.first?.id }
    private func stopPlayback() { queuePreparation.cancel(); listening?.coordinator.stop(); listening = nil }
    private func restartPlayback() {
        guard let listening, listening.coordinator.recoveryRequired else { return }
        let items = listening.coordinator.queue.compactMap { $0.localOccurrenceID.flatMap { listening.occurrencesByID[$0] } }
        guard items.count == listening.coordinator.queue.count else { return }
        beginSession(items: items, playlist: listening.playlist, index: listening.coordinator.index, autoplay: false)
    }
    private func resumeQueue() {
        guard let saved = library.savedQueue,
              let playlist = library.snapshot.playlists.first(where: { $0.id == PlaylistID(saved.playlistID) }) else { return }
        do {
            let items = try saved.resolve(in: library.snapshot)
            selected = playlist.id
            beginSession(items: items, playlist: playlist, index: saved.index, autoplay: false)
        } catch { library.message = "The saved queue no longer matches this library. No occurrence identities were inferred." }
    }
    private func startQueue(_ playlist: LibraryPlaylist) {
        let source = library.snapshot, epoch = library.generation, selectedID = selected
        let requestedMode = mode, requestedExclusion = excludeWatched, sessionID = listening?.id
        Task {
            guard epoch == library.generation, selected == selectedID, listening?.id == sessionID else { return }
            let items = await queuePreparation.prepare(snapshot: source, playlist: playlist.id,
                mode: requestedMode == 0 ? .normal : .smart, excludeWatched: requestedExclusion)
            guard let items, epoch == library.generation, selected == selectedID, listening?.id == sessionID,
                  mode == requestedMode, excludeWatched == requestedExclusion else { return }
            beginSession(items: items, playlist: playlist, index: 0, autoplay: true)
        }
    }
    private var shuffleButtonTitle: String {
        if queuePreparation.busy { return "Shuffling…" }
        return listening == nil ? "Shuffle & listen" : "Reshuffle queue"
    }
    private func beginSession(items: [LibraryOccurrence], playlist: LibraryPlaylist, index: Int, autoplay: Bool) {
        guard !items.isEmpty else { library.message = "No tracks match this filter. Try turning Skip watched off."; return }
        guard items.allSatisfy({ $0.youtubeId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil }) else {
            library.message = "This queue contains an ID that cannot be played. No occurrences were silently skipped."; return
        }
        stopPlayback()
        listening = NativeListeningSession(items: items, playlist: playlist, library: library, index: index, autoplay: autoplay)
    }

    private func loadSuggestions() {
        guard let playlist, !suggestionsBusy else { return }
        let epoch = library.generation, selectedID = selected
        let seeds = occurrences.prefix(5).map { SuggestionSeed(title: $0.title, channelTitle: $0.channelTitle, description: $0.description, categoryId: $0.categoryId, tags: $0.tags, duration: $0.duration) }
        suggestionsBusy = true
        Task {
            let result = await account.fetchSuggestions(.init(playlistId: playlist.youtubeId, seeds: seeds, playlistTitle: playlist.title))
            suggestionsBusy = false
            guard epoch == library.generation, selectedID == selected else { return }
            suggestions = result?.suggestions ?? []
            suggestionsMessage = result == nil ? account.message : "Suggestions open on YouTube. Their listening events are not recorded in this library or included in its export."
        }
    }
}

struct NativeWindowAttachment: NSViewRepresentable {
    let attached: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView { let view = WindowTrackingView(); view.attached = attached; return view }
    func updateNSView(_ view: NSView, context: Context) { if let window = view.window { attached(window) } }
}
