import Foundation

@main
struct StandaloneNativeLocalLibraryProbe {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 2 else { exit(64) }
        let mode = arguments[0]
        let root = URL(fileURLWithPath: arguments[1], isDirectory: true)
        let status = await MainActor.run { run(mode: mode, root: root) }
        exit(status)
    }

    @MainActor
    private static func run(mode: String, root: URL) -> Int32 {
        do {
            switch mode {
            case "exercise": try exercise(root)
            case "create-hold": try createAndHold(root)
            case "contend": try contend(root)
            case "open": try open(root)
            default: return 64
            }
            return 0
        } catch {
            emit("error", "\(error)")
            return 1
        }
    }

    @MainActor
    private static func exercise(_ root: URL) throws {
        let absent = root.deletingLastPathComponent().appendingPathComponent("absent", isDirectory: true)
        try FileManager.default.createDirectory(at: absent, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        do {
            _ = try NativeLocalLibraryStore.openExisting(at: absent)
            throw ProbeFailure.assertion
        } catch NativeLocalLibraryStore.Failure.missingStore { }
        guard (try? FileManager.default.contentsOfDirectory(atPath: absent.path))?.isEmpty == true else {
            throw ProbeFailure.assertion
        }
        let playlist = LibraryPlaylist(id: PlaylistID("playlist-1"), youtubeId: "youtube-playlist-1",
                                       title: "Synthetic playlist", description: nil, thumbnail: nil,
                                       channelTitle: "Synthetic", videoCount: 2,
                                       createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
        let first = occurrence("occurrence-1", position: 0, playlist: playlist.id)
        let second = occurrence("occurrence-2", position: 1, playlist: playlist.id)
        let snapshot = LibrarySnapshot(playlists: [playlist], occurrences: [first, second], history: [])
        let completion = LibraryHistoryEvent(id: HistoryID("event-1"), playlistId: playlist.id, videoId: first.id,
                                             watchedAt: "2026-01-01T00:01:00Z", watchedSeconds: 12, completed: true)
        let conflicting = LibraryHistoryEvent(id: completion.id, playlistId: playlist.id, videoId: second.id,
                                              watchedAt: completion.watchedAt, watchedSeconds: completion.watchedSeconds,
                                              completed: true)
        try autoreleasepool {
            let store = try NativeLocalLibraryStore.createNew(at: root)
            guard try store.snapshot() == .empty else { throw ProbeFailure.assertion }
            do {
                _ = try NativeLocalLibraryStore.openExisting(at: root)
                throw ProbeFailure.assertion
            } catch NativeLocalLibraryStore.Failure.alreadyOpen { }
            let duplicate = LibrarySnapshot(playlists: [playlist], occurrences: [first, first], history: [])
            do {
                try store.importIntoEmpty(duplicate)
                throw ProbeFailure.assertion
            } catch NativeLocalLibraryStore.Failure.invalidSnapshot { }
            guard try store.snapshot() == .empty else { throw ProbeFailure.assertion }
            try store.importIntoEmpty(snapshot)
            guard try store.snapshot() == snapshot else { throw ProbeFailure.assertion }
            do {
                try store.importIntoEmpty(snapshot)
                throw ProbeFailure.assertion
            } catch NativeLocalLibraryStore.Failure.nonEmptyLibrary { }
            do {
                try store.addNewPlaylist(playlist, occurrences: [first, second])
                throw ProbeFailure.assertion
            } catch NativeLocalLibraryStore.Failure.duplicatePlaylist { }
            try store.recordCompletion(completion)
            try store.recordCompletion(completion)
            do {
                try store.recordCompletion(conflicting)
                throw ProbeFailure.assertion
            } catch NativeLocalLibraryStore.Failure.ambiguousHistory { }
            guard try store.snapshot().history == [completion] else { throw ProbeFailure.assertion }
        }
        let reopened = try NativeLocalLibraryStore.openExisting(at: root)
        guard try reopened.snapshot().history == [completion] else { throw ProbeFailure.assertion }

        let bounded = root.deletingLastPathComponent().appendingPathComponent("bounded", isDirectory: true)
        try FileManager.default.createDirectory(at: bounded, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        let third = occurrence("occurrence-3", position: 2, playlist: playlist.id)
        try autoreleasepool {
            let wide = try NativeLocalLibraryStore.createNew(
                at: bounded, limits: .init(playlists: 1, occurrences: 3, history: 1))
            try wide.importIntoEmpty(LibrarySnapshot(playlists: [playlist], occurrences: [first, second, third], history: []))
        }
        do {
            _ = try NativeLocalLibraryStore.openExisting(
                at: bounded, limits: .init(playlists: 1, occurrences: 2, history: 1))
            throw ProbeFailure.assertion
        } catch NativeLocalLibraryStore.Failure.invalidSnapshot { }
        emit("ok", "exercise")
    }

    @MainActor
    private static func createAndHold(_ root: URL) throws {
        let store = try NativeLocalLibraryStore.createNew(at: root)
        emit("holding", "create")
        _ = readLine()
        withExtendedLifetime(store) { }
    }

    @MainActor
    private static func contend(_ root: URL) throws {
        do {
            _ = try NativeLocalLibraryStore.openExisting(at: root)
            throw ProbeFailure.assertion
        } catch NativeLocalLibraryStore.Failure.alreadyOpen {
            emit("ok", "contention")
        }
    }

    @MainActor
    private static func open(_ root: URL) throws {
        let store = try NativeLocalLibraryStore.openExisting(at: root)
        _ = try store.snapshot()
        emit("ok", "open")
    }

    private static func occurrence(_ id: String, position: Int, playlist: PlaylistID) -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: playlist, youtubeId: "video-\(id)",
                          title: "Synthetic \(id)", channelTitle: "Synthetic", thumbnail: "thumbnail",
                          duration: 120, position: position, viewCount: nil, likeCount: nil,
                          description: nil, tags: nil, categoryId: nil, publishedAt: nil)
    }

    private static func emit(_ event: String, _ value: String) {
        print("{\"event\":\"\(event)\",\"value\":\"\(value)\"}")
        fflush(stdout)
    }

    private enum ProbeFailure: Error { case assertion }
}
