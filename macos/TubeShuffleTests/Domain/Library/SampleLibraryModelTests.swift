import XCTest
@testable import TubeShuffle

final class SampleLibraryModelTests: XCTestCase {
    func testSamplePlaylistsAndOccurrenceSpecificWatchedStatus() {
        let model = SampleLibraryModel()
        XCTAssertEqual(model.snapshot.playlists.count, 2)
        let first = model.snapshot.playlists[0]
        let items = model.occurrences(for: first.id)
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0].youtubeId, items[2].youtubeId)
        XCTAssertNotEqual(items[0].id, items[2].id)
        XCTAssertTrue(model.isWatched(items[0]))
        XCTAssertFalse(model.isWatched(items[2]))
        XCTAssertEqual(model.occurrences(for: model.snapshot.playlists[1].id).count, 2)
        XCTAssertTrue(model.occurrences(for: PlaylistID("unknown")).isEmpty)
    }
}
