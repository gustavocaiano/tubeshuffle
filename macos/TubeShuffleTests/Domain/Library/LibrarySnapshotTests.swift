import XCTest
@testable import TubeShuffle

private struct InMemoryLibraryRepository: LibraryRepository {
    let value: LibrarySnapshot
    func snapshot() throws -> LibrarySnapshot { value }
}

final class LibrarySnapshotTests: XCTestCase {
    private func occurrence(_ id: String, position: Int, playlist: String = "playlist") -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID(playlist), youtubeId: "same-video",
                          title: "Title", channelTitle: "Channel", thumbnail: "", duration: 10,
                          position: position, viewCount: nil, likeCount: nil, description: nil,
                          tags: nil, categoryId: nil, publishedAt: nil)
    }

    private func event(_ id: String, video: String, playlist: String = "playlist", completed: Bool = true) -> LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID(id), playlistId: PlaylistID(playlist), videoId: OccurrenceID(video),
                            watchedAt: "2026-01-01T00:00:00.000Z", watchedSeconds: 10, completed: completed)
    }

    func testUnwatchedFiltersCompletedOccurrencesAndPreservesInputOrder() {
        let first = occurrence("first", position: 8)
        let second = occurrence("second", position: 2)
        let third = occurrence("third", position: 0)
        let other = occurrence("first", position: 1, playlist: "other")
        let snapshot = LibrarySnapshot(playlists: [], occurrences: [third, other, first, second, first], history: [
            event("1", video: "second"), event("2", video: "second"),
            event("3", video: "first", completed: false), event("4", video: "third", playlist: "other"),
            event("5", video: "missing")
        ])
        let before = snapshot
        XCTAssertEqual(snapshot.unwatchedOccurrences(for: PlaylistID("playlist")), [third, first, first])
        XCTAssertEqual(snapshot.unwatchedOccurrences(for: PlaylistID("playlist")), [third, first, first])
        XCTAssertEqual(snapshot, before)
    }

    func testUnwatchedUsesExactUnicodeIdentityForPlaylistAndOccurrence() {
        let composed = "\u{e9}"
        let decomposed = "e\u{301}"
        let a = occurrence(composed, position: 0, playlist: composed)
        let b = occurrence(decomposed, position: 1, playlist: composed)
        let c = occurrence(composed, position: 2, playlist: decomposed)
        let snapshot = LibrarySnapshot(playlists: [], occurrences: [a, b, c], history: [
            event("1", video: composed, playlist: composed),
            event("2", video: decomposed, playlist: decomposed)
        ])
        XCTAssertEqual(snapshot.unwatchedOccurrences(for: PlaylistID(composed)), [b])
        XCTAssertEqual(snapshot.unwatchedOccurrences(for: PlaylistID(decomposed)), [c])
    }

    func testUnwatchedEmptyMissingAndAllCompleted() {
        let first = occurrence("first", position: 0)
        let second = occurrence("second", position: 1)
        XCTAssertTrue(LibrarySnapshot.empty.unwatchedOccurrences(for: PlaylistID("playlist")).isEmpty)
        let noHistory = LibrarySnapshot(playlists: [], occurrences: [first, second], history: [])
        XCTAssertEqual(noHistory.unwatchedOccurrences(for: PlaylistID("playlist")), [first, second])
        XCTAssertTrue(noHistory.unwatchedOccurrences(for: PlaylistID("missing")).isEmpty)
        let allWatched = LibrarySnapshot(playlists: [], occurrences: [first, second, first], history: [
            event("1", video: "first", completed: false), event("2", video: "first"), event("3", video: "second")
        ])
        XCTAssertTrue(allWatched.unwatchedOccurrences(for: PlaylistID("playlist")).isEmpty)
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
