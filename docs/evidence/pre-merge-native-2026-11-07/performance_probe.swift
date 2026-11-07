import Foundation

@main
struct PerformanceProbe {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-review-perf-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        print("fixture: \(root.path)")
        try await MainActor.run {
            let count = 5_000
            let playlist = LibraryPlaylist(id: PlaylistID("synthetic-playlist-0000000000000001"), youtubeId: "PLSyntheticReview0001", title: "Synthetic review", description: nil, thumbnail: nil, channelTitle: nil, videoCount: count, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z")
            let items = (0..<count).map { i in
                LibraryOccurrence(id: OccurrenceID("synthetic-occurrence-\(i)-000000000001"), playlistId: playlist.id, youtubeId: "ScMzIvxBSi4", title: "Synthetic music track \(i)", channelTitle: "Synthetic channel", thumbnail: "", duration: 240, position: i, viewCount: nil, likeCount: nil, description: nil, tags: nil, categoryId: "10", publishedAt: nil)
            }
            let snapshot = LibrarySnapshot(playlists: [playlist], occurrences: items, history: [])
            let store = try NativeLocalLibraryStore.createNew(at: root)
            try timed("import-5000") { try store.importIntoEmpty(snapshot) }
            try timed("snapshot-5000") { _ = try store.snapshot() }
            let queue = NativeSavedQueue(version: 1, playlistID: playlist.id.rawValue, occurrenceIDs: items.map { $0.id.rawValue }, index: 0)
            try timed("save-queue-5000") { try store.saveQueue(queue) }
            try timed("advance-queue-5000") { try store.saveQueue(NativeSavedQueue(version: 1, playlistID: queue.playlistID, occurrenceIDs: queue.occurrenceIDs, index: 1)) }
            timed("smart-shuffle-5000") { _ = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: playlist.id, mode: .smart, excludeWatched: false, draw: { 0.5 }) }
            try timed("transfer-export-5000") { _ = try TransferV1.encode(snapshot: snapshot, exportedAt: "2026-01-01T00:00:00.000Z") }
        }
        // Keep this uniquely created disposable fixture for reproducible inspection.
    }
    static func timed(_ label: String, operation: () throws -> Void) rethrows {
        let start = ProcessInfo.processInfo.systemUptime
        try operation()
        print("\(label): \(ProcessInfo.processInfo.systemUptime - start)")
        fflush(stdout)
    }
}
