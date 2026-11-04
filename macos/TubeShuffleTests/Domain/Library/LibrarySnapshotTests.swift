import XCTest
@testable import TubeShuffle

private struct InMemoryLibraryRepository: LibraryRepository {
    let value: LibrarySnapshot
    func snapshot() throws -> LibrarySnapshot { value }
}

// Synthetic fixtures intentionally use non-wire-valid YouTube IDs, timestamps,
// and NaN durations to exercise the value comparator only. They are not
// transfer-validation fixtures.
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

    private func playlist(id: String = "playlist",
                          youtubeId: String = "playlist-youtube",
                          title: String = "Playlist",
                          description: String? = nil,
                          thumbnail: String? = nil,
                          channelTitle: String? = nil,
                          videoCount: Int = 2,
                          createdAt: String = "2026-01-01T00:00:00.000Z",
                          updatedAt: String = "2026-01-01T00:00:00.000Z") -> LibraryPlaylist {
        LibraryPlaylist(id: PlaylistID(id), youtubeId: youtubeId, title: title, description: description,
                        thumbnail: thumbnail, channelTitle: channelTitle, videoCount: videoCount,
                        createdAt: createdAt, updatedAt: updatedAt)
    }

    private func occurrence(id: String = "occurrence",
                            playlistId: String = "playlist",
                            youtubeId: String = "video",
                            title: String = "Title",
                            channelTitle: String = "Channel",
                            thumbnail: String = "thumbnail",
                            duration: Double = 10,
                            position: Int = 0,
                            viewCount: Int? = nil,
                            likeCount: Int? = nil,
                            description: String? = nil,
                            tags: [String]? = nil,
                            categoryId: String? = nil,
                            publishedAt: String? = nil) -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID(playlistId), youtubeId: youtubeId,
                          title: title, channelTitle: channelTitle, thumbnail: thumbnail, duration: duration,
                          position: position, viewCount: viewCount, likeCount: likeCount, description: description,
                          tags: tags, categoryId: categoryId, publishedAt: publishedAt)
    }

    private func historyEvent(id: String = "event",
                              playlistId: String = "playlist",
                              videoId: String = "occurrence",
                              watchedAt: String = "2026-01-01T00:00:00.000Z",
                              watchedSeconds: Double = 10,
                              completed: Bool = true) -> LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID(id), playlistId: PlaylistID(playlistId), videoId: OccurrenceID(videoId),
                            watchedAt: watchedAt, watchedSeconds: watchedSeconds, completed: completed)
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

    func testPlaylistEqualityComparesEveryFieldWithExactScalars() {
        let composed = "\u{e9}"
        let decomposed = "e\u{301}"
        let base = playlist()

        XCTAssertEqual(base, playlist())
        XCTAssertNotEqual(base, playlist(id: "other"))
        XCTAssertNotEqual(base, playlist(youtubeId: composed))
        XCTAssertNotEqual(playlist(youtubeId: composed), playlist(youtubeId: decomposed))
        XCTAssertNotEqual(playlist(title: composed), playlist(title: decomposed))
        XCTAssertNotEqual(playlist(description: composed), playlist(description: decomposed))
        XCTAssertNotEqual(playlist(thumbnail: composed), playlist(thumbnail: decomposed))
        XCTAssertNotEqual(playlist(channelTitle: composed), playlist(channelTitle: decomposed))
        XCTAssertNotEqual(playlist(createdAt: composed), playlist(createdAt: decomposed))
        XCTAssertNotEqual(playlist(updatedAt: composed), playlist(updatedAt: decomposed))
        XCTAssertNotEqual(base, playlist(videoCount: 3))

        // Identical non-ASCII metadata is equal.
        XCTAssertEqual(playlist(title: composed, description: composed, thumbnail: composed, channelTitle: composed),
                       playlist(title: composed, description: composed, thumbnail: composed, channelTitle: composed))

        // Nil and empty optional strings are distinct values.
        XCTAssertNotEqual(playlist(description: nil), playlist(description: ""))
        XCTAssertNotEqual(playlist(thumbnail: nil), playlist(thumbnail: ""))
        XCTAssertNotEqual(playlist(channelTitle: nil), playlist(channelTitle: ""))
        XCTAssertEqual(playlist(description: ""), playlist(description: ""))
        XCTAssertEqual(playlist(thumbnail: ""), playlist(thumbnail: ""))
        XCTAssertEqual(playlist(channelTitle: ""), playlist(channelTitle: ""))
        XCTAssertEqual(playlist(description: nil), playlist(description: nil))
    }

    func testOccurrenceEqualityComparesEveryFieldWithExactScalars() {
        let composed = "\u{e9}"
        let decomposed = "e\u{301}"
        let base = occurrence()

        XCTAssertEqual(base, occurrence())
        XCTAssertNotEqual(base, occurrence(id: "other"))
        XCTAssertNotEqual(base, occurrence(playlistId: "other"))
        XCTAssertNotEqual(occurrence(youtubeId: composed), occurrence(youtubeId: decomposed))
        XCTAssertNotEqual(occurrence(title: composed), occurrence(title: decomposed))
        XCTAssertNotEqual(occurrence(channelTitle: composed), occurrence(channelTitle: decomposed))
        XCTAssertNotEqual(occurrence(thumbnail: composed), occurrence(thumbnail: decomposed))
        XCTAssertNotEqual(base, occurrence(duration: 11))
        XCTAssertNotEqual(base, occurrence(position: 1))
        XCTAssertNotEqual(base, occurrence(viewCount: 0))
        XCTAssertNotEqual(base, occurrence(likeCount: 0))
        XCTAssertNotEqual(occurrence(description: composed), occurrence(description: decomposed))
        XCTAssertNotEqual(occurrence(categoryId: composed), occurrence(categoryId: decomposed))
        XCTAssertNotEqual(occurrence(publishedAt: composed), occurrence(publishedAt: decomposed))

        // Numeric equality keeps normal Swift semantics.
        XCTAssertEqual(occurrence(duration: 0), occurrence(duration: -0.0))
        XCTAssertNotEqual(occurrence(duration: .nan), occurrence(duration: .nan))
        XCTAssertEqual(occurrence(viewCount: 0), occurrence(viewCount: 0))
        XCTAssertNotEqual(occurrence(viewCount: 0), occurrence(viewCount: 1))
        XCTAssertNotEqual(occurrence(viewCount: nil), occurrence(viewCount: 0))
        XCTAssertNotEqual(occurrence(likeCount: 0), occurrence(likeCount: 1))
        XCTAssertNotEqual(occurrence(likeCount: nil), occurrence(likeCount: 0))

        // Nil and empty optionals remain distinct.
        XCTAssertNotEqual(occurrence(description: nil), occurrence(description: ""))
        XCTAssertNotEqual(occurrence(categoryId: nil), occurrence(categoryId: ""))
        XCTAssertNotEqual(occurrence(publishedAt: nil), occurrence(publishedAt: ""))

        // Tags preserve nil versus empty, order, and per-item scalar sequence.
        XCTAssertNotEqual(occurrence(tags: nil), occurrence(tags: []))
        XCTAssertNotEqual(occurrence(tags: []), occurrence(tags: ["tag"]))
        XCTAssertNotEqual(occurrence(tags: ["a", "b"]), occurrence(tags: ["b", "a"]))
        XCTAssertNotEqual(occurrence(tags: [composed]), occurrence(tags: [decomposed]))
        XCTAssertNotEqual(occurrence(tags: ["a", composed]), occurrence(tags: ["a", decomposed]))
        XCTAssertEqual(occurrence(tags: ["a", "b"]), occurrence(tags: ["a", "b"]))
        XCTAssertEqual(occurrence(tags: []), occurrence(tags: []))
        XCTAssertEqual(occurrence(tags: nil), occurrence(tags: nil))

        // Identical non-ASCII metadata and tags are equal.
        XCTAssertEqual(occurrence(title: composed, channelTitle: composed, thumbnail: composed,
                                  description: composed, tags: [composed, "tag"], categoryId: composed,
                                  publishedAt: composed),
                       occurrence(title: composed, channelTitle: composed, thumbnail: composed,
                                  description: composed, tags: [composed, "tag"], categoryId: composed,
                                  publishedAt: composed))
    }

    func testHistoryEventEqualityComparesEveryFieldWithExactScalars() {
        let composed = "\u{e9}"
        let decomposed = "e\u{301}"
        let base = historyEvent()

        XCTAssertEqual(base, historyEvent())
        XCTAssertNotEqual(base, historyEvent(id: "other"))
        XCTAssertNotEqual(base, historyEvent(playlistId: "other"))
        XCTAssertNotEqual(base, historyEvent(videoId: "other"))
        XCTAssertNotEqual(historyEvent(watchedAt: composed), historyEvent(watchedAt: decomposed))
        XCTAssertNotEqual(base, historyEvent(watchedSeconds: 11))
        XCTAssertNotEqual(base, historyEvent(completed: false))
        XCTAssertEqual(historyEvent(watchedSeconds: 0), historyEvent(watchedSeconds: -0.0))
        XCTAssertNotEqual(historyEvent(watchedSeconds: .nan), historyEvent(watchedSeconds: .nan))
    }

    func testSnapshotEqualityComposesRecordEquality() {
        let composed = "\u{e9}"
        let decomposed = "e\u{301}"
        let basePlaylist = playlist()
        let baseOccurrence = occurrence()
        let baseEvent = historyEvent()
        let base = LibrarySnapshot(playlists: [basePlaylist], occurrences: [baseOccurrence], history: [baseEvent])

        XCTAssertEqual(base, LibrarySnapshot(playlists: [basePlaylist], occurrences: [baseOccurrence], history: [baseEvent]))
        XCTAssertNotEqual(base, .empty)
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [], occurrences: [baseOccurrence], history: [baseEvent]))
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [basePlaylist], occurrences: [], history: [baseEvent]))
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [basePlaylist], occurrences: [baseOccurrence], history: []))

        // A single-field record difference propagates through the snapshot.
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [playlist(title: composed)], occurrences: [baseOccurrence], history: [baseEvent]))
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [playlist(description: "")], occurrences: [baseOccurrence], history: [baseEvent]))
        XCTAssertNotEqual(LibrarySnapshot(playlists: [playlist(description: nil)], occurrences: [baseOccurrence], history: [baseEvent]),
                          LibrarySnapshot(playlists: [playlist(description: "")], occurrences: [baseOccurrence], history: [baseEvent]))
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [basePlaylist], occurrences: [occurrence(tags: ["a", composed])], history: [baseEvent]))
        XCTAssertNotEqual(base, LibrarySnapshot(playlists: [basePlaylist], occurrences: [baseOccurrence], history: [historyEvent(watchedAt: composed)]))

        // Composed and decomposed spellings of a non-ID field are not equal.
        XCTAssertNotEqual(LibrarySnapshot(playlists: [], occurrences: [occurrence(title: composed)], history: []),
                          LibrarySnapshot(playlists: [], occurrences: [occurrence(title: decomposed)], history: []))
        XCTAssertNotEqual(LibrarySnapshot(playlists: [], occurrences: [occurrence(tags: [composed])], history: []),
                          LibrarySnapshot(playlists: [], occurrences: [occurrence(tags: [decomposed])], history: []))

        // Array order and repeated values are significant.
        let second = occurrence(id: "second", position: 1)
        XCTAssertNotEqual(LibrarySnapshot(playlists: [], occurrences: [baseOccurrence, second], history: []),
                          LibrarySnapshot(playlists: [], occurrences: [second, baseOccurrence], history: []))
        XCTAssertNotEqual(LibrarySnapshot(playlists: [], occurrences: [baseOccurrence, baseOccurrence], history: []),
                          LibrarySnapshot(playlists: [], occurrences: [baseOccurrence], history: []))
    }
}
