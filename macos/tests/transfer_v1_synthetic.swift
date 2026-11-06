import Foundation

@main
struct TransferV1Synthetic {
    static func main() throws {
        let playlist = LibraryPlaylist(id: PlaylistID("local-playlist"), youtubeId: "PL123456789", title: "Sample", description: nil, thumbnail: nil, channelTitle: nil, videoCount: 2, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z")
        let first = LibraryOccurrence(id: OccurrenceID("occurrence-a"), playlistId: playlist.id, youtubeId: "abcdefghijk", title: "First", channelTitle: "Artist", thumbnail: "", duration: 180, position: 0, viewCount: nil, likeCount: nil, description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        // Repeating a YouTube video ID is legal; stable occurrence identity is retained.
        let second = LibraryOccurrence(id: OccurrenceID("occurrence-b"), playlistId: playlist.id, youtubeId: "abcdefghijk", title: "Second", channelTitle: "Artist", thumbnail: "", duration: 181.5, position: 1, viewCount: 0, likeCount: nil, description: "", tags: ["live"], categoryId: nil, publishedAt: nil)
        let retained = LibraryHistoryEvent(id: HistoryID("history-retained"), playlistId: playlist.id, videoId: second.id, watchedAt: "2026-10-28T01:00:00.000Z", watchedSeconds: 181.5, completed: true)
        let orphan = LibraryHistoryEvent(id: HistoryID("history-orphan"), playlistId: playlist.id, videoId: OccurrenceID("removed-occurrence"), watchedAt: "2026-10-28T01:01:00.000Z", watchedSeconds: 0, completed: false)
        let source = LibrarySnapshot(playlists: [playlist], occurrences: [first, second], history: [retained, orphan])

        let exported = try TransferV1.encode(snapshot: source, exportedAt: "2026-10-28T02:00:00.000Z")
        precondition(exported.omittedOrphans == [.init(id: "history-orphan", reason: "missing_video")])
        let decoded = try TransferV1.decode(exported.data)
        precondition(decoded.snapshot.playlists == [playlist])
        precondition(decoded.snapshot.occurrences == [first, second])
        precondition(decoded.snapshot.history == [retained])
        precondition(TransferV1.prepareFreshImport(decoded, destination: .empty).mayCreateFreshLibrary)
        precondition(!TransferV1.prepareFreshImport(decoded, destination: source).mayCreateFreshLibrary)

        let unknown = Data("{\"format\":\"tubeshuffle-transfer\",\"version\":1,\"exportedAt\":\"2026-10-28T02:00:00.000Z\",\"playlists\":[],\"videos\":[],\"history\":[],\"extra\":true}".utf8)
        do { _ = try TransferV1.decode(unknown); preconditionFailure("unknown envelope key accepted") }
        catch TransferV1.Error.invalid { }
        print("TransferV1 synthetic checks passed")
    }
}
