import AppKit
import Foundation
import UniformTypeIdentifiers

@MainActor
final class NativeLibraryModel: ObservableObject {
    @Published private(set) var snapshot = LibrarySnapshot.empty
    @Published private(set) var isOpen = false
    @Published private(set) var isDemo = false
    @Published private(set) var busy = false
    @Published private(set) var refreshing: PlaylistID?
    @Published private(set) var location = ""
    @Published private(set) var savedQueue: NativeSavedQueue?
    @Published var message: String?
    @Published var pendingImport: TransferV1.ImportPreview?
    private(set) var generation = UUID()
    private var store: NativeLocalLibraryStore?
    private var scopedURL: URL?
    private weak var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    private let calculations: NativeLibraryCalculations
    private let recents: NativeRecentLibrary?
    private var activeOperation: UUID?
    private var cancelCalculation: (() -> Void)?
    private var choosingFile = false
    #if DEBUG
    /// Tests answer file panels here instead of presenting them.
    var answerFilePanelForTesting: ((NSSavePanel) -> URL?)?
    #endif

    init(calculations: NativeLibraryCalculations = .init(), recents: NativeRecentLibrary? = nil) {
        self.calculations = calculations
        self.recents = recents
    }

    // An already-open store can be supplied without invoking a file panel.
    // Its caller is responsible for URL access; no library is discovered here.
    convenience init(store: NativeLocalLibraryStore, at url: URL, calculations: NativeLibraryCalculations = .init()) throws {
        self.init(calculations: calculations)
        try install(store, at: url, scoped: false)
    }

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        self.window = window
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.closeLibrary() }
        }
    }

    deinit { if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) } }

    /// File panels open as a sheet on the library window instead of `runModal()`.
    /// A modal loop started from a main-actor task (as export does) starves every
    /// other main-actor job until it ends, so the player's progress checks never
    /// finish and playback is declared stalled. A sheet keeps playback, media keys
    /// and the rest of the app running while a location is chosen.
    private func choose(_ panel: NSSavePanel) async -> URL? {
        guard !choosingFile else { return nil }
        #if DEBUG
        if let answerFilePanelForTesting { return answerFilePanelForTesting(panel) }
        #endif
        choosingFile = true
        defer { choosingFile = false }
        let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            if let window, window.isVisible, window.attachedSheet == nil {
                panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            } else {
                panel.begin { continuation.resume(returning: $0) }
            }
        }
        return response == .OK ? panel.url : nil
    }

    func createLibrary() async {
        guard !busy else { return }
        let panel = NSSavePanel()
        panel.title = "Create an empty local library"
        panel.prompt = "Create library"
        panel.nameFieldStringValue = "TubeShuffle Library"
        panel.message = "Choose a new folder name. Existing folders and libraries are never replaced."
        guard let url = await choose(panel), !busy else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        do {
            // Never use withIntermediateDirectories: an existing destination is an error.
            guard !FileManager.default.fileExists(atPath: url.path) else { throw NativeLocalLibraryStore.Failure.destinationNotEmpty }
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let next = try NativeLocalLibraryStore.createNew(at: url)
            try install(next, at: url, scoped: scoped)
            recents?.remember(url)
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            message = "Could not create the library. Any newly created files have been kept; choose a different new folder."
        }
    }

    func openLibrary() async {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Open a TubeShuffle library folder"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        guard let url = await choose(panel), !busy else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        do {
            try install(NativeLocalLibraryStore.openExisting(at: url), at: url, scoped: scoped)
            recents?.remember(url)
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            message = "Could not open this library. It may be in use, incomplete or incompatible. Its files have been kept; no repair was attempted."
        }
    }

    /// Reopens the library chosen in an earlier session, with exactly the checks
    /// and lock of an explicit open. Nothing is created or repaired; on failure
    /// the remembered location is kept and the user can open a library again.
    func reopenRecentLibrary() {
        guard !isOpen, !busy, let recents, recents.hasLibrary else { return }
        guard let resolved = recents.resolve() else {
            message = "Your last library could not be found. Choose Library → Open library… to select it again."
            return
        }
        let url = resolved.url
        let scoped = url.startAccessingSecurityScopedResource()
        do {
            try install(NativeLocalLibraryStore.openExisting(at: url), at: url, scoped: scoped)
            if resolved.stale { recents.remember(url) }
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            message = "Your last library “\(url.lastPathComponent)” could not be reopened. It may be open in another window, moved or incompatible. Its files have been kept; choose Library → Open library… to try again."
        }
    }

    /// An explicit close also stops the library from reopening at the next launch.
    func closeAndForgetLibrary() {
        recents?.forget()
        closeLibrary()
    }

    private func install(_ next: NativeLocalLibraryStore, at url: URL, scoped: Bool) throws {
        let value = try next.snapshot()
        closeLibrary()
        store = next; snapshot = value; isOpen = true; isDemo = false
        location = url.lastPathComponent
        if scoped { scopedURL = url }
        do { savedQueue = try next.savedQueue() }
        catch { message = "The library is open, but its saved queue could not be read. The queue file was kept and playback has not started." }
    }

    func closeLibrary() {
        cancelCalculation?(); cancelCalculation = nil; activeOperation = nil; busy = false; refreshing = nil
        generation = UUID(); pendingImport = nil; savedQueue = nil; store = nil
        if let scopedURL { scopedURL.stopAccessingSecurityScopedResource() }
        scopedURL = nil; snapshot = .empty; isOpen = false; isDemo = false; location = ""; message = nil
    }

    func openDemo() {
        closeLibrary()
        snapshot = NativeLibraryFixture.snapshot
        isOpen = true; isDemo = true; location = "Demo library · not saved"
    }

    func previewImport() {
        guard isOpen, !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Preview a TubeShuffle transfer"
        panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        let epoch = generation
        Task {
            guard let url = await choose(panel), generation == epoch, isOpen, !busy else { return }
            let operation = beginOperation()
            defer { finishOperation(operation) }
            do {
                let data = try NativeTransferFiles.read(url)
                let source = try await calculate { try TransferV1.decode(data) }
                guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return }
                pendingImport = TransferV1.prepareFreshImport(source, destination: snapshot)
            } catch {
                guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return }
                message = "This file could not be imported. It must be a valid v1 transfer within the 10 MB, 500,000-value and nesting limits. No library records were written."
            }
        }
    }

    func confirmImport() {
        guard !busy, let preview = pendingImport, preview.mayCreateFreshLibrary, snapshot == .empty, let store else { return }
        do {
            try store.importIntoEmpty(preview.source.snapshot)
            snapshot = try store.snapshot(); pendingImport = nil
            message = "Imported locally. \(preview.source.omittedOrphans.count) orphan history events were omitted. Nothing was uploaded."
        } catch {
            message = "Import did not complete. No automatic retry will run. Reopen and inspect the library before trying again."
        }
    }

    func exportLibrary() {
        guard isOpen, !busy else { return }
        let source = snapshot, epoch = generation
        let operation = beginOperation()
        Task {
            defer { finishOperation(operation) }
            do {
                let stamp = Self.timestamp()
                let result = try await calculate { try TransferV1.encode(snapshot: source, exportedAt: stamp) }
                guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return }
                let panel = NSSavePanel()
                panel.title = "Export local library"
                panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "tubeshuffle-library.json"
                panel.message = "Unencrypted JSON. \(result.omittedOrphans.count) orphan history events omitted. Queue, preferences, suggestions, credentials and media are excluded. Choose a new filename."
                guard let url = await choose(panel), generation == epoch, activeOperation == operation, !Task.isCancelled else { return }
                try NativeTransferFiles.writeNew(result.data, at: url)
                message = "Export saved. \(result.omittedOrphans.count) orphan history events were omitted."
            } catch {
                guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return }
                message = "Export could not be completed. Existing files were not replaced. If a new partial file remains, keep it and choose a new filename."
            }
        }
    }

    func importPlaylist(_ input: String, account: any NativePlaylistSource) async -> PlaylistID? {
        guard isOpen, !isDemo, !busy else { return nil }
        guard let id = Self.playlistID(input) else { message = "Paste a public YouTube playlist link containing list=, or a playlist ID."; return nil }
        guard !snapshot.playlists.contains(where: { $0.youtubeId == id }) else {
            message = "This playlist is already in your library. Open it and choose Refresh to get its latest tracks."
            return nil
        }
        guard account.canFetchPlaylists else { message = "Wait for the current account operation before importing a playlist."; return nil }
        let epoch = generation
        let operation = beginOperation()
        defer { finishOperation(operation) }
        let response = await account.fetchPlaylist(id)
        guard generation == epoch, activeOperation == operation, !Task.isCancelled, store != nil else { return nil }
        guard let dto = response else { message = account.message ?? "The playlist could not be loaded. Check your connection and try again."; return nil }
        do {
            let stamp = Self.timestamp(), convert = calculations.convertPlaylist
            let preview = try await calculate { try convert(id, dto, stamp) }
            guard generation == epoch, activeOperation == operation, !Task.isCancelled, let store else { return nil }
            guard let playlist = preview.snapshot.playlists.first else { return nil }
            try store.addNewPlaylist(playlist, occurrences: preview.snapshot.occurrences)
            snapshot = try store.snapshot()
            message = preview.warnings.isEmpty ? "“\(playlist.title)” was added to your playlists." : "Playlist added locally, but the reported count differs from the received items. This may be a partial playlist; no missing items were invented."
            return playlist.id
        } catch {
            guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return nil }
            message = "The playlist could not be added safely. Existing playlists and history were preserved."
        }
        return nil
    }

    /// Brings one playlist up to date with YouTube: new tracks are added, tracks
    /// that left the playlist are removed (with their listening history) and
    /// every other track keeps its identity and history. Nothing changes if the
    /// fetch or the save fails.
    func refreshPlaylist(_ id: PlaylistID, account: any NativePlaylistSource) async -> NativePlaylistRefreshOutcome? {
        guard isOpen, !isDemo, !busy, let current = snapshot.playlists.first(where: { $0.id == id }) else { return nil }
        guard account.canFetchPlaylists else { message = "Wait for the current account operation before refreshing a playlist."; return nil }
        let epoch = generation
        let operation = beginOperation()
        refreshing = id
        defer {
            if activeOperation == operation { refreshing = nil }
            finishOperation(operation)
        }
        let response = await account.fetchPlaylist(current.youtubeId)
        guard generation == epoch, activeOperation == operation, !Task.isCancelled, store != nil else { return nil }
        guard let dto = response else {
            message = account.message ?? "The playlist could not be refreshed. Check your connection and try again; nothing was changed."
            return nil
        }
        return await applyPlaylistRefresh(current, dto: dto, operation: operation)
    }

    /// A launch pass uses one request at a time and yields to foreground library
    /// work. A failure that affects access to the service ends the pass.
    func refreshPlaylistsOnStartup(fetchPlaylist: (String) async throws -> YouTubePlaylistDTO,
                                   didRefresh: (NativePlaylistRefreshOutcome) -> Void) async {
        guard isOpen, !isDemo else { return }
        let epoch = generation
        for playlist in snapshot.playlists {
            guard generation == epoch, !Task.isCancelled else { return }
            guard !busy, snapshot.playlists.contains(playlist) else { continue }
            let dto: YouTubePlaylistDTO
            do {
                dto = try await fetchPlaylist(playlist.youtubeId)
            } catch APIClientError.http(let status, _, _) where status == 400 || status == 404 || status == 422 {
                continue
            } catch {
                return
            }
            guard generation == epoch, !Task.isCancelled else { return }
            guard !busy, snapshot.playlists.contains(playlist) else { continue }
            if let outcome = await applyPlaylistRefresh(playlist, dto: dto, operation: nil) {
                didRefresh(outcome)
            }
        }
    }

    private func applyPlaylistRefresh(_ playlist: LibraryPlaylist, dto: YouTubePlaylistDTO,
                                      operation: UUID?) async -> NativePlaylistRefreshOutcome? {
        let epoch = generation
        let isManual = operation != nil
        do {
            let stamp = Self.timestamp(), convert = calculations.convertPlaylist, source = snapshot
            let plan: PlaylistRefreshPlan? = try await calculate(trackOperation: isManual) {
                let fetched = try convert(playlist.youtubeId, dto, stamp)
                let plan = try PlaylistRefreshPlan.make(existing: source, playlistId: playlist.id,
                                                        fetched: fetched.snapshot, refreshedAt: stamp)
                // A count mismatch can indicate a partial response. Automatic
                // refresh must not delete tracks or history based on it.
                guard isManual || plan.removed.isEmpty || fetched.warnings.isEmpty else { return nil }
                return plan
            }
            guard let plan, generation == epoch, activeOperation == operation, !Task.isCancelled,
                  snapshot.playlists.contains(playlist), let store else { return nil }
            try store.applyRefresh(plan)
            snapshot = try store.snapshot()
            let queueKept = reconcileSavedQueue(after: plan, store: store)
            if isManual || !queueKept {
                message = Self.refreshSummary(plan) + (queueKept ? "" : " The saved queue could not be updated; start a new shuffle.")
            }
            return NativePlaylistRefreshOutcome(playlist: plan.playlist, added: plan.added, removed: plan.removed)
        } catch PlaylistRefreshPlan.Failure.emptyResult {
            guard isManual, generation == epoch, activeOperation == operation, !Task.isCancelled else { return nil }
            message = "YouTube returned no playable tracks for this playlist, so nothing was changed."
        } catch {
            guard isManual, generation == epoch, activeOperation == operation, !Task.isCancelled else { return nil }
            message = "The playlist could not be refreshed safely. Nothing was changed."
        }
        return nil
    }

    // A saved queue may name tracks a refresh removed. Keep the remaining order
    // and move the position to the next remaining track; with nothing left the
    // queue is removed, so reopening the library never reports a broken queue.
    private func reconcileSavedQueue(after plan: PlaylistRefreshPlan, store: NativeLocalLibraryStore) -> Bool {
        guard let saved = savedQueue, PlaylistID(saved.playlistID) == plan.playlist.id, !plan.removed.isEmpty else { return true }
        let removed = Set(plan.removed)
        let remaining = saved.occurrenceIDs.filter { !removed.contains(OccurrenceID($0)) }
        guard remaining.count != saved.occurrenceIDs.count else { return true }
        do {
            if remaining.isEmpty {
                try store.removeSavedQueue()
                savedQueue = nil
            } else {
                let before = saved.occurrenceIDs.prefix(saved.index).filter { !removed.contains(OccurrenceID($0)) }.count
                let next = NativeSavedQueue(version: 1, playlistID: saved.playlistID, occurrenceIDs: remaining,
                                            index: min(before, remaining.count - 1))
                try store.saveQueue(next)
                savedQueue = next
            }
            return true
        } catch {
            return false
        }
    }

    static func refreshSummary(_ plan: PlaylistRefreshPlan) -> String {
        guard plan.changesTracks else { return "“\(plan.playlist.title)” is up to date. No tracks were added or removed." }
        var parts: [String] = []
        if !plan.added.isEmpty { parts.append("\(plan.added.count) new track\(plan.added.count == 1 ? "" : "s")") }
        if !plan.removed.isEmpty { parts.append("\(plan.removed.count) removed") }
        return "“\(plan.playlist.title)” updated: " + parts.joined(separator: ", ") + "."
    }

    private func beginOperation() -> UUID {
        let token = UUID()
        activeOperation = token; busy = true; message = nil
        return token
    }

    private func finishOperation(_ token: UUID) {
        guard activeOperation == token else { return }
        activeOperation = nil; cancelCalculation = nil; busy = false
    }

    private func calculate<T>(trackOperation: Bool = true, _ work: @escaping @Sendable () throws -> T) async throws -> T {
        let task = Task.detached(priority: trackOperation ? .userInitiated : .utility) {
            try Task.checkCancellation()
            let value = try work()
            try Task.checkCancellation()
            return value
        }
        if trackOperation { cancelCalculation = { task.cancel() } }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    func recordNaturalCompletion(_ item: PlayerCoordinator.Item, playlist: PlaylistID, epoch: UUID) {
        guard generation == epoch, let occurrence = item.localOccurrenceID,
              snapshot.occurrences.contains(where: { $0.id == occurrence && $0.playlistId == playlist }) else { return }
        let event = LibraryHistoryEvent(id: HistoryID(UUID().uuidString), playlistId: playlist, videoId: occurrence,
                                        watchedAt: Self.timestamp(), watchedSeconds: 0, completed: true)
        // Natural end is observed; elapsed listening duration is not inferred.
        do {
            if let store { try store.recordCompletion(event); snapshot = try store.snapshot() }
            else if isDemo { snapshot = .init(playlists: snapshot.playlists, occurrences: snapshot.occurrences, history: snapshot.history + [event]) }
        } catch { message = "Playback continued, but this completion could not be saved. History was not retried or remapped." }
    }

    func saveQueue(items: [PlayerCoordinator.Item], index: Int, playlist: PlaylistID, epoch: UUID) {
        guard generation == epoch, items.indices.contains(index) else { return }
        // A refresh can remove tracks that are still in a live queue, even the
        // one playing, and suggestions played next are not library tracks at
        // all. Save only tracks the playlist has; the saved position then moves
        // to the next of those.
        let present = Set(snapshot.occurrences.lazy.filter { $0.playlistId == playlist }.map(\.id))
        var ids: [String] = []
        var position = 0
        for (offset, item) in items.enumerated() {
            guard let id = item.localOccurrenceID, present.contains(id) else { continue }
            if offset < index { position += 1 }
            ids.append(id.rawValue)
        }
        guard !ids.isEmpty else { return }
        let value = NativeSavedQueue(version: 1, playlistID: playlist.rawValue, occurrenceIDs: ids, index: min(position, ids.count - 1))
        guard value != savedQueue else { return }
        do {
            _ = try value.resolve(in: snapshot)
            if let store { try store.saveQueue(value) }
            savedQueue = value
        } catch { message = "Playback changed, but its queue could not be saved. The previous queue was kept; this write will not be retried automatically." }
    }

    static func timestamp() -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    static func playlistID(_ input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 2_048 else { return nil }
        var value = text
        let hosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]
        let bareURL = hosts.contains { text.lowercased().hasPrefix($0 + "/") }
        if text.contains("://") || bareURL {
            guard let url = URLComponents(string: bareURL ? "https://" + text : text), url.scheme?.lowercased() == "https",
                  let host = url.host?.lowercased(), hosts.contains(host),
                  url.user == nil, url.password == nil, url.port == nil || url.port == 443,
                  let ids = url.queryItems?.filter({ $0.name == "list" }), ids.count == 1,
                  let id = ids.first?.value else { return nil }
            value = id
        }
        guard let match = value.range(of: "^[A-Za-z0-9_-]{10,80}$", options: .regularExpression),
              match == value.startIndex..<value.endIndex else { return nil }
        return value
    }
}

struct NativePlaylistRefreshOutcome {
    let playlist: LibraryPlaylist
    let added: [LibraryOccurrence]
    let removed: [OccurrenceID]
    var changesTracks: Bool { !added.isEmpty || !removed.isEmpty }
}

/// Remembers the library folder the user last created or opened, as a
/// security-scoped bookmark, so the next launch reopens it without a file panel.
/// Only the location is stored; explicitly closing the library forgets it.
struct NativeRecentLibrary {
    static let key = "native.recentLibraryBookmark"
    let defaults: UserDefaults

    var hasLibrary: Bool { defaults.data(forKey: Self.key) != nil }

    func remember(_ url: URL) {
        guard let data = try? url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
        defaults.set(data, forKey: Self.key)
    }

    func resolve() -> (url: URL, stale: Bool)? {
        guard let data = defaults.data(forKey: Self.key) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI],
                                 relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        return (url, stale)
    }

    func forget() { defaults.removeObject(forKey: Self.key) }
}

// Immutable inputs cross the executor boundary; stores and UI stay on MainActor.
struct NativeLibraryCalculations {
    var convertPlaylist: @Sendable (String, YouTubePlaylistDTO, String) throws -> PlaylistAPIImport.Result = {
        try PlaylistAPIImport.make(requestedPlaylistID: $0, dto: $1, importedAt: $2)
    }
    var buildQueue: @Sendable (LibrarySnapshot, PlaylistID, LibraryQueueBuilder.Mode, Bool) -> [LibraryOccurrence] = {
        LibraryQueueBuilder.build(snapshot: $0, playlistId: $1, mode: $2, excludeWatched: $3, draw: { Double.random(in: 0..<1) })
    }
}

@MainActor
final class NativeQueuePreparation: ObservableObject {
    @Published private(set) var busy = false
    private let calculations: NativeLibraryCalculations
    private var operation: UUID?
    private var worker: Task<[LibraryOccurrence], Never>?

    init(calculations: NativeLibraryCalculations = .init()) { self.calculations = calculations }

    func cancel() {
        operation = nil; worker?.cancel(); worker = nil; busy = false
    }

    func prepare(snapshot: LibrarySnapshot, playlist: PlaylistID, mode: LibraryQueueBuilder.Mode,
                 excludeWatched: Bool) async -> [LibraryOccurrence]? {
        cancel()
        let token = UUID(), build = calculations.buildQueue
        operation = token; busy = true
        let task = Task.detached(priority: .userInitiated) {
            guard !Task.isCancelled else { return [LibraryOccurrence]() }
            return build(snapshot, playlist, mode, excludeWatched)
        }
        worker = task
        defer {
            if operation == token { operation = nil; worker = nil; busy = false }
        }
        let items = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        guard operation == token, !Task.isCancelled, !task.isCancelled else { return nil }
        return items
    }
}

enum NativeTransferFiles {
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw TransferV1.Error.invalidEnvelope("file") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: TransferV1.maximumBytes + 1) ?? Data()
        guard data.count <= TransferV1.maximumBytes else { throw TransferV1.Error.raw(.tooLarge) }
        return data
    }

    static func writeNew(_ data: Data, at url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        try data.write(to: url, options: [.withoutOverwriting])
    }
}

enum NativeLibraryFixture {
    static let snapshot: LibrarySnapshot = {
        let id = PlaylistID("demo-playlist"), date = "2026-01-01T00:00:00.000Z"
        let playlist = LibraryPlaylist(id: id, youtubeId: "PL_DEMO_ONLY_01", title: "A little room to shuffle",
            description: "Synthetic library for interface checks", thumbnail: nil, channelTitle: "Demo", videoCount: 6, createdAt: date, updatedAt: date)
        let videos = ["ScMzIvxBSi4", "jNQXAC9IVRw", "dQw4w9WgXcQ", "M7lc1UVf-VE", "aqz-KE-bpKQ", "ScMzIvxBSi4"]
        let items = videos.enumerated().map { index, video in
            LibraryOccurrence(id: OccurrenceID("demo-occurrence-\(index)"), playlistId: id, youtubeId: video,
                title: ["A little room to shuffle — playback sample", "Me at the zoo", "Never Gonna Give You Up — Rick Astley", "YouTube player · public example", "Big Buck Bunny · Blender Foundation", "Another listen — repeated occurrence"][index], channelTitle: "Public playback example", thumbnail: "https://i.ytimg.com/vi/\(video)/hqdefault.jpg", duration: 0, position: index,
                viewCount: nil, likeCount: nil, description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        }
        return LibrarySnapshot(playlists: [playlist], occurrences: items, history: [])
    }()
}
