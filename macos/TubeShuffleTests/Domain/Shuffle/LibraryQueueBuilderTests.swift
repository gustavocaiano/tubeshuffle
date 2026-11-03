import XCTest
@testable import TubeShuffle

final class LibraryQueueBuilderTests: XCTestCase {
    private func playlist(_ id: String = "p") -> LibraryPlaylist {
        LibraryPlaylist(id: PlaylistID(id), youtubeId: "yt", title: "Playlist", description: nil,
                        thumbnail: nil, channelTitle: nil, videoCount: 0, createdAt: "", updatedAt: "")
    }

    private func occurrence(_ id: String, playlist: String = "p", title: String = "Title",
                            channel: String = "Channel", description: String? = nil,
                            tags: [String]? = nil, category: String? = nil,
                            duration: Double = 0) -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID(playlist), youtubeId: "same-video",
                          title: title, channelTitle: channel, thumbnail: "thumb", duration: duration,
                          position: 42, viewCount: 123, likeCount: 45, description: description,
                          tags: tags, categoryId: category, publishedAt: "date")
    }

    private func watched(_ id: String, playlist: String = "p", completed: Bool = true) -> LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID("event-" + id), playlistId: PlaylistID(playlist),
                            videoId: OccurrenceID(id), watchedAt: "", watchedSeconds: 1, completed: completed)
    }

    func testNormalShuffleFiltersOccurrencesWithoutDeduplicatingOrMutating() {
        let a = occurrence("a"), b = occurrence("b"), c = occurrence("c")
        let other = occurrence("other", playlist: "other")
        let snapshot = LibrarySnapshot(playlists: [playlist(), playlist("other")],
                                       occurrences: [a, other, b, c], history: [watched("b"), watched("c", completed: false)])
        let before = snapshot
        var draws = 0
        let all = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: .normal,
                                            excludeWatched: false) { draws += 1; return 0 }
        XCTAssertEqual(all, [b, c, a])
        XCTAssertEqual(draws, 2)
        draws = 0
        let unwatched = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: .normal,
                                                  excludeWatched: true) { draws += 1; return 0 }
        XCTAssertEqual(unwatched, [c, a])
        XCTAssertEqual(draws, 1)
        XCTAssertEqual(snapshot, before)
    }

    func testSmartUsesFilteredIndicesAndAllMetadata() {
        let a = occurrence("a", title: "hard", duration: 120)
        let b = occurrence("b", title: "sad", duration: 500)
        let c = occurrence("c", title: "chill", duration: 300)
        let snapshot = LibrarySnapshot(playlists: [playlist()], occurrences: [a, b, c], history: [watched("b")])
        let before = snapshot
        let result = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: .smart,
                                               excludeWatched: true) { 0 }
        XCTAssertEqual(result, [c, a])
        XCTAssertEqual(Set(result.map(\.id)), Set([a.id, c.id]))
        XCTAssertEqual(snapshot, before)

        let rich = occurrence("rich", title: "Ti\u{301}tle", channel: "Canal", description: "Descrição",
                              tags: ["alegre", "lofi"], category: "10", duration: 123)
        let input = LibraryQueueBuilder.energyInput(rich)
        XCTAssertEqual(Array(input.title.unicodeScalars), Array(rich.title.unicodeScalars))
        XCTAssertEqual(input.channelTitle, rich.channelTitle)
        XCTAssertEqual(input.description, rich.description)
        XCTAssertEqual(input.tags, rich.tags)
        XCTAssertEqual(input.categoryId, rich.categoryId)
        XCTAssertEqual(input.duration, rich.duration)
    }

    func testSmartDrawsAreDeterministicWithWatchedFilterDisabled() {
        let a = occurrence("a"), b = occurrence("b"), c = occurrence("c")
        let snapshot = LibrarySnapshot(playlists: [playlist()], occurrences: [a, b, c], history: [watched("b")])
        var draws = 0
        let result = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: .smart,
                                               excludeWatched: false) { draws += 1; return 0 }
        XCTAssertEqual(result, [b, c, a])
        XCTAssertEqual(draws, 2)
    }

    func testSmartMatchesShuffleV1OnFilteredCandidatesWithVariedDraws() {
        let hype1 = occurrence("hype1", title: "hard")
        let chill1 = occurrence("chill1", title: "chill")
        let sad1 = occurrence("sad1", title: "sad")
        let hype2 = occurrence("hype2", title: "hype")
        let chill2 = occurrence("chill2", title: "calm")
        let sad2 = occurrence("sad2", title: "lonely")
        let excluded = occurrence("excluded", title: "party")
        let other = occurrence("other", playlist: "other", title: "hard")
        let candidates = [hype1, chill1, sad1, hype2, chill2, sad2]
        let snapshot = LibrarySnapshot(playlists: [playlist(), playlist("other")],
                                       occurrences: [hype1, excluded, chill1, other, sad1, hype2, chill2, sad2],
                                       history: [watched("excluded"), watched("chill1", completed: false)])
        let inputs = candidates.map {
            EnergyTrackInput(title: $0.title, channelTitle: $0.channelTitle, description: $0.description,
                             tags: $0.tags, categoryId: $0.categoryId, duration: $0.duration)
        }
        XCTAssertEqual(Set(inputs.map { ShuffleV1.classify($0).bucket }), Set([.hype, .chill, .melancholy]))

        let values = [0.12, 0.76, 0.49, 0.94]
        var expectedDraws = 0
        let indices = ShuffleV1.smartShuffle(inputs) {
            defer { expectedDraws += 1 }
            return values[expectedDraws % values.count]
        }
        var actualDraws = 0
        let actual = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: .smart,
                                               excludeWatched: true) {
            defer { actualDraws += 1 }
            return values[actualDraws % values.count]
        }
        XCTAssertEqual(actual, indices.map { candidates[$0] })
        XCTAssertEqual(expectedDraws, 3)
        XCTAssertEqual(actualDraws, expectedDraws)
    }

    func testNoSelectionMissingPlaylistEmptyAndAllWatchedConsumeNoDraws() {
        let a = occurrence("a")
        let snapshot = LibrarySnapshot(playlists: [playlist()], occurrences: [a], history: [watched("a")])
        let emptyPlaylist = LibrarySnapshot(playlists: [playlist()], occurrences: [], history: [])
        let orphan = LibrarySnapshot(playlists: [], occurrences: [a], history: [])
        let failDraw: () -> Double = { XCTFail("Unexpected draw"); return 0 }
        for mode in [LibraryQueueBuilder.Mode.normal, .smart] {
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: snapshot, playlistId: nil, mode: mode, excludeWatched: false, draw: failDraw).isEmpty)
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("missing"), mode: mode, excludeWatched: false, draw: failDraw).isEmpty)
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: .empty, playlistId: PlaylistID("p"), mode: mode, excludeWatched: false, draw: failDraw).isEmpty)
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: emptyPlaylist, playlistId: PlaylistID("p"), mode: mode, excludeWatched: false, draw: failDraw).isEmpty)
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: orphan, playlistId: PlaylistID("p"), mode: mode, excludeWatched: false, draw: failDraw).isEmpty)
            XCTAssertTrue(LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("p"), mode: mode, excludeWatched: true, draw: failDraw).isEmpty)
        }
    }

    func testExactUnicodePlaylistAndOccurrenceIdentity() {
        let composed = "\u{e9}", decomposed = "e\u{301}"
        let a = occurrence(composed, playlist: composed)
        let b = occurrence(decomposed, playlist: composed)
        let c = occurrence(composed, playlist: decomposed)
        let snapshot = LibrarySnapshot(playlists: [playlist(composed), playlist(decomposed)], occurrences: [a, b, c],
                                       history: [watched(composed, playlist: composed)])
        for mode in [LibraryQueueBuilder.Mode.normal, .smart] {
            XCTAssertEqual(LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID(composed), mode: mode, excludeWatched: true) { 0 }, [b])
            XCTAssertEqual(LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID(decomposed), mode: mode, excludeWatched: true) { 0 }, [c])
        }
    }
}
