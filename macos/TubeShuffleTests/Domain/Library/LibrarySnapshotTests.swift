import XCTest
@testable import TubeShuffle

private struct InMemoryLibraryRepository: LibraryRepository {
    let value: LibrarySnapshot
    func snapshot() throws -> LibrarySnapshot { value }
}

final class LibrarySnapshotTests: XCTestCase {
    private func occurrence(_ id: String, position: Int) -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID("playlist"), youtubeId: "same-video",
                          title: "Title", channelTitle: "Channel", thumbnail: "", duration: 10,
                          position: position, viewCount: nil, likeCount: nil, description: nil,
                          tags: nil, categoryId: nil, publishedAt: nil)
    }

    func testRepeatedYouTubeVideoKeepsDistinctOccurrencesAndHistoryReference() throws {
        let first = occurrence("first", position: 0)
        let second = occurrence("second", position: 1)
        let event = LibraryHistoryEvent(id: HistoryID("event"), playlistId: PlaylistID("playlist"),
                                        videoId: second.id, watchedAt: "2026-01-01T00:00:00.000Z",
                                        watchedSeconds: 10, completed: true)
        let playlist = LibraryPlaylist(id: PlaylistID("playlist"), youtubeId: "playlist-youtube", title: "Playlist",
                                       description: nil, thumbnail: nil, channelTitle: nil, videoCount: 2,
                                       createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z")
        let repository = InMemoryLibraryRepository(value: LibrarySnapshot(playlists: [playlist], occurrences: [first, second], history: [event]))
        let snapshot = try repository.snapshot()
        XCTAssertEqual(snapshot.occurrences.map(\.youtubeId), ["same-video", "same-video"])
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(snapshot.occurrences.first { $0.id == snapshot.history[0].videoId }?.position, 1)
        XCTAssertEqual(snapshot.history[0].playlistId, second.playlistId)
        XCTAssertEqual(snapshot.history[0].playlistId, snapshot.playlists[0].id)
    }

    func testNamespacesAndExactUnicodeIdentity() {
        let playlist = PlaylistID("same")
        let occurrence = OccurrenceID("same")
        let event = HistoryID("same")
        let distinct: Set<AnyHashable> = [AnyHashable(playlist), AnyHashable(occurrence), AnyHashable(event)]
        XCTAssertEqual(distinct.count, 3)
        let composed = OccurrenceID("\u{e9}")
        let decomposed = OccurrenceID("e\u{301}")
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertEqual(Set([composed, decomposed]).count, 2)
        XCTAssertEqual(composed, OccurrenceID("\u{e9}"))
        XCTAssertEqual([composed: 1, decomposed: 2][decomposed], 2)
    }

    func testEmptySnapshot() throws {
        let snapshot = try InMemoryLibraryRepository(value: .empty).snapshot()
        XCTAssertEqual(snapshot, .empty)
        XCTAssertTrue(snapshot.playlists.isEmpty)
        XCTAssertTrue(snapshot.occurrences.isEmpty)
        XCTAssertTrue(snapshot.history.isEmpty)
    }
}
