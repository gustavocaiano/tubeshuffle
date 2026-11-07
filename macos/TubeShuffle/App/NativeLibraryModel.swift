import AppKit
import Foundation
import UniformTypeIdentifiers

@MainActor
final class NativeLibraryModel: ObservableObject {
    @Published private(set) var snapshot = LibrarySnapshot.empty
    @Published private(set) var isOpen = false
    @Published private(set) var isDemo = false
    @Published private(set) var busy = false
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
    private var activeOperation: UUID?
    private var cancelCalculation: (() -> Void)?

    init(calculations: NativeLibraryCalculations = .init()) { self.calculations = calculations }

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

    func createLibrary() {
        guard !busy else { return }
        let panel = NSSavePanel()
        panel.title = "Create an empty local library"
        panel.prompt = "Create library"
        panel.nameFieldStringValue = "TubeShuffle Library"
        panel.message = "Choose a new folder name. Existing folders and libraries are never replaced."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        do {
            // Never use withIntermediateDirectories: an existing destination is an error.
            guard !FileManager.default.fileExists(atPath: url.path) else { throw NativeLocalLibraryStore.Failure.destinationNotEmpty }
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let next = try NativeLocalLibraryStore.createNew(at: url)
            try install(next, at: url, scoped: scoped)
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            message = "Could not create the library. Any newly created files have been kept; choose a different new folder."
        }
    }

    func openLibrary() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Open a TubeShuffle library folder"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        do { try install(NativeLocalLibraryStore.openExisting(at: url), at: url, scoped: scoped) }
        catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            message = "Could not open this library. It may be in use, incomplete or incompatible. Its files have been kept; no repair was attempted."
        }
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
        cancelCalculation?(); cancelCalculation = nil; activeOperation = nil; busy = false
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
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let epoch = generation
        let operation = beginOperation()
        Task {
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
                guard panel.runModal() == .OK, let url = panel.url else { return }
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
            message = "This playlist is already in your library. Its tracks and history have been kept."
            return nil
        }
        guard account.canFetchPlaylists else { message = "Connect your TubeShuffle account before importing a playlist."; return nil }
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
            message = preview.warnings.isEmpty ? "Playlist added locally. Saving its cloud link is a separate action." : "Playlist added locally, but the reported count differs from the received items. This may be a partial playlist; no missing items were invented."
            return playlist.id
        } catch {
            guard generation == epoch, activeOperation == operation, !Task.isCancelled else { return nil }
            message = "The playlist could not be added safely. Existing playlists and history were preserved. Refreshing or replacing a playlist is not supported."
        }
        return nil
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

    private func calculate<T>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        let task = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let value = try work()
            try Task.checkCancellation()
            return value
        }
        cancelCalculation = { task.cancel() }
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
        guard generation == epoch else { return }
        let ids = items.compactMap(\.localOccurrenceID).map(\.rawValue)
        guard ids.count == items.count else { return }
        let value = NativeSavedQueue(version: 1, playlistID: playlist.rawValue, occurrenceIDs: ids, index: index)
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
