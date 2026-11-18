import AppKit
import SwiftUI
import WebKit
import XCTest
@testable import TubeShuffle

@MainActor
final class PlaylistRefreshTests: XCTestCase {
    private let playlistID = PlaylistID("local-playlist")
    private let youtubePlaylist = "PLSyntheticRefresh01"
    private let stamp = "2026-03-03T00:00:00.000Z"

    // MARK: Refresh plan

    func testPlanKeepsIdentityForRemainingTracksAndReportsChanges() throws {
        let existing = LibrarySnapshot(playlists: [localPlaylist()], occurrences: [
            occurrence("a", video: "AAAAAAAAAAA", position: 0),
            occurrence("b", video: "BBBBBBBBBBB", position: 1),
            occurrence("c", video: "CCCCCCCCCCC", position: 2)
        ], history: [history("h-a", "a"), history("h-b", "b")])
        // On YouTube B was removed, C moved to the front and D was added.
        let plan = try PlaylistRefreshPlan.make(existing: existing, playlistId: playlistID,
            fetched: fetched(["CCCCCCCCCCC", "AAAAAAAAAAA", "DDDDDDDDDDD"]), refreshedAt: stamp)
        XCTAssertEqual(plan.kept.map(\.id), [OccurrenceID("c"), OccurrenceID("a")])
        XCTAssertEqual(plan.kept.map(\.position), [0, 1])
        XCTAssertEqual(plan.kept.first?.title, "Remote CCCCCCCCCCC", "Metadata comes from the refreshed playlist")
        XCTAssertEqual(plan.added.map(\.youtubeId), ["DDDDDDDDDDD"])
        XCTAssertEqual(plan.added.first?.id, OccurrenceID("fresh-2"))
        XCTAssertEqual(plan.added.first?.playlistId, playlistID)
        XCTAssertEqual(plan.removed, [OccurrenceID("b")])
        XCTAssertTrue(plan.changesTracks)
        XCTAssertEqual(plan.playlist.id, playlistID)
        XCTAssertEqual(plan.playlist.youtubeId, youtubePlaylist)
        XCTAssertEqual(plan.playlist.title, "Remote title")
        XCTAssertEqual(plan.playlist.createdAt, "2026-01-01T00:00:00.000Z")
        XCTAssertEqual(plan.playlist.updatedAt, stamp)
        let after = plan.applied(to: existing)
        XCTAssertEqual(after.history.map(\.id), [HistoryID("h-a")], "Only the removed track's history goes with it")
        XCTAssertEqual(Set(after.occurrences.map(\.id)), [OccurrenceID("a"), OccurrenceID("c"), OccurrenceID("fresh-2")])
    }

    func testRepeatedVideosArePairedInPlaylistOrder() throws {
        let existing = LibrarySnapshot(playlists: [localPlaylist()], occurrences: [
            occurrence("first", video: "AAAAAAAAAAA", position: 0),
            occurrence("second", video: "AAAAAAAAAAA", position: 1),
            occurrence("other", video: "BBBBBBBBBBB", position: 2)
        ], history: [])
        let plan = try PlaylistRefreshPlan.make(existing: existing, playlistId: playlistID,
            fetched: fetched(["BBBBBBBBBBB", "AAAAAAAAAAA"]), refreshedAt: stamp)
        XCTAssertEqual(plan.kept.map(\.id), [OccurrenceID("other"), OccurrenceID("first")])
        XCTAssertEqual(plan.removed, [OccurrenceID("second")])
        XCTAssertTrue(plan.added.isEmpty)
    }

    func testUnchangedPlaylistReportsNoTrackChanges() throws {
        let existing = LibrarySnapshot(playlists: [localPlaylist()], occurrences: [
            occurrence("a", video: "AAAAAAAAAAA", position: 0), occurrence("b", video: "BBBBBBBBBBB", position: 1)
        ], history: [])
        let plan = try PlaylistRefreshPlan.make(existing: existing, playlistId: playlistID,
            fetched: fetched(["AAAAAAAAAAA", "BBBBBBBBBBB"]), refreshedAt: stamp)
        XCTAssertFalse(plan.changesTracks)
        XCTAssertEqual(plan.kept.map(\.id), [OccurrenceID("a"), OccurrenceID("b")])
    }

    func testPlanRefusesEmptyMismatchedOrUnknownPlaylists() {
        let existing = LibrarySnapshot(playlists: [localPlaylist()], occurrences: [occurrence("a", video: "AAAAAAAAAAA", position: 0)], history: [])
        XCTAssertThrowsError(try PlaylistRefreshPlan.make(existing: existing, playlistId: playlistID, fetched: fetched([]), refreshedAt: stamp)) {
            XCTAssertEqual($0 as? PlaylistRefreshPlan.Failure, .emptyResult)
        }
        XCTAssertThrowsError(try PlaylistRefreshPlan.make(existing: existing, playlistId: playlistID,
            fetched: fetched(["AAAAAAAAAAA"], youtubeID: "PLDifferentPlaylist1"), refreshedAt: stamp)) {
            XCTAssertEqual($0 as? PlaylistRefreshPlan.Failure, .mismatchedPlaylist)
        }
        XCTAssertThrowsError(try PlaylistRefreshPlan.make(existing: existing, playlistId: PlaylistID("missing"),
            fetched: fetched(["AAAAAAAAAAA"]), refreshedAt: stamp)) {
            XCTAssertEqual($0 as? PlaylistRefreshPlan.Failure, .unknownPlaylist)
        }
    }

    // MARK: Persistence

    func testStoredRefreshKeepsHistoryAndSurvivesReopen() throws {
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: NativeLocalLibraryStore? = try NativeLocalLibraryStore.createNew(at: directory)
        try store!.importIntoEmpty(seed())
        let plan = try PlaylistRefreshPlan.make(existing: try store!.snapshot(), playlistId: playlistID,
            fetched: fetched(["AAAAAAAAAAA", "DDDDDDDDDDD"]), refreshedAt: stamp)
        try store!.applyRefresh(plan)
        store = nil
        let reopened = try NativeLocalLibraryStore.openExisting(at: directory)
        let value = try reopened.snapshot()
        XCTAssertEqual(Set(value.occurrences.map(\.id)), [OccurrenceID("a"), OccurrenceID("fresh-1")])
        XCTAssertEqual(value.occurrences.first { $0.id == OccurrenceID("a") }?.title, "Remote AAAAAAAAAAA")
        XCTAssertEqual(value.history.map(\.id), [HistoryID("h-a")])
        XCTAssertEqual(value.playlists.map(\.title), ["Remote title"])
        XCTAssertThrowsError(try reopened.applyRefresh(plan), "A plan made for an older state of the playlist is refused")
        XCTAssertEqual(try reopened.snapshot(), value)
    }

    func testLibraryRefreshUpdatesTracksAndSavedQueue() async throws {
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: NativeLocalLibraryStore? = try NativeLocalLibraryStore.createNew(at: directory)
        try store!.importIntoEmpty(seed())
        let library = try NativeLibraryModel(store: store!, at: directory)
        // The model holds the only reference, so closing it releases the library lock.
        store = nil
        defer { library.closeLibrary() }
        library.saveQueue(items: [item(0, "b"), item(1, "a")], index: 1, playlist: playlistID, epoch: library.generation)
        XCTAssertEqual(library.savedQueue?.occurrenceIDs, ["b", "a"])
        let source = RefreshSource(response: try dto(["AAAAAAAAAAA", "DDDDDDDDDDD"]))
        let result = await library.refreshPlaylist(playlistID, account: source)
        let outcome = try XCTUnwrap(result)
        XCTAssertEqual(source.requests, [youtubePlaylist])
        XCTAssertEqual(outcome.removed, [OccurrenceID("b")])
        XCTAssertEqual(outcome.added.map(\.youtubeId), ["DDDDDDDDDDD"])
        XCTAssertEqual(library.snapshot.occurrences.filter { $0.playlistId == playlistID }.count, 2)
        XCTAssertEqual(library.snapshot.history.map(\.id), [HistoryID("h-a")])
        XCTAssertEqual(library.savedQueue?.occurrenceIDs, ["a"], "The saved queue drops the removed track")
        XCTAssertEqual(library.savedQueue?.index, 0)
        XCTAssertFalse(library.busy)
        XCTAssertNil(library.refreshing)
        XCTAssertTrue(library.message?.contains("1 new track, 1 removed") == true, library.message ?? "")
        let saved = library.snapshot
        library.closeLibrary()
        let reopened = try NativeLocalLibraryStore.openExisting(at: directory)
        XCTAssertEqual(try reopened.snapshot(), saved)
        XCTAssertEqual(try reopened.savedQueue()?.occurrenceIDs, ["a"], "Reopening never reports a broken queue")
    }

    func testFailedOrEmptyRefreshChangesNothing() async throws {
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try NativeLocalLibraryStore.createNew(at: directory)
        try store.importIntoEmpty(seed())
        let library = try NativeLibraryModel(store: store, at: directory)
        defer { library.closeLibrary() }
        let before = library.snapshot
        let source = RefreshSource(response: nil)
        source.message = "Synthetic service unavailable"
        let unavailable = await library.refreshPlaylist(playlistID, account: source)
        XCTAssertNil(unavailable)
        XCTAssertEqual(library.message, source.message)
        XCTAssertEqual(library.snapshot, before)
        source.response = try dto([])
        let empty = await library.refreshPlaylist(playlistID, account: source)
        XCTAssertNil(empty)
        XCTAssertEqual(library.snapshot, before)
        source.canFetchPlaylists = false
        let busy = await library.refreshPlaylist(playlistID, account: source)
        XCTAssertNil(busy)
        XCTAssertEqual(source.requests.count, 2, "A busy account is not asked again")
        let demo = NativeLibraryModel()
        demo.openDemo()
        let demoSource = RefreshSource(response: try dto(["AAAAAAAAAAA"]))
        let demoResult = await demo.refreshPlaylist(NativeLibraryFixture.snapshot.playlists[0].id, account: demoSource)
        XCTAssertTrue(demoSource.requests.isEmpty)
        XCTAssertNil(demoResult)
        XCTAssertEqual(demo.snapshot, NativeLibraryFixture.snapshot)
    }

    func testStartupRefreshContinuesPastAnUnavailablePlaylist() async throws {
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try NativeLocalLibraryStore.createNew(at: directory)
        try store.importIntoEmpty(seed())
        let otherID = PlaylistID("other-playlist")
        let otherYouTubeID = "PLSyntheticRefresh02"
        let other = localPlaylist(id: otherID, youtubeID: otherYouTubeID)
        try store.addNewPlaylist(other, occurrences: [occurrence("other", video: "CCCCCCCCCCC", position: 0, playlist: otherID)])
        let library = try NativeLibraryModel(store: store, at: directory)
        defer { library.closeLibrary() }
        let first = try XCTUnwrap(library.snapshot.playlists.first)
        let second = try XCTUnwrap(library.snapshot.playlists.last)
        let response = try dto(["EEEEEEEEEEE"], youtubeID: second.youtubeId)
        var requests: [String] = []
        var outcomes: [PlaylistID] = []

        await library.refreshPlaylistsOnStartup(fetchPlaylist: { id in
            XCTAssertFalse(library.busy, "The library is usable during startup requests")
            requests.append(id)
            if id == first.youtubeId { throw APIClientError.http(status: 404, retryAfter: nil, kind: .legacy) }
            return response
        }, didRefresh: { outcomes.append($0.playlist.id) })

        XCTAssertEqual(requests, [first.youtubeId, second.youtubeId])
        XCTAssertEqual(outcomes, [second.id])
        XCTAssertTrue(library.snapshot.playlists.contains(first))
        XCTAssertEqual(try store.snapshot().occurrences.filter { $0.playlistId == second.id }.map(\.youtubeId), ["EEEEEEEEEEE"])
        XCTAssertNil(library.message)
    }

    func testStartupRefreshIgnoresPartialRemovalsAndDiscardsResultsAfterClose() async throws {
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try NativeLocalLibraryStore.createNew(at: directory)
        try store.importIntoEmpty(seed())
        let library = try NativeLibraryModel(store: store, at: directory)
        let original = library.snapshot
        let partial = try dto(["AAAAAAAAAAA"], reportedCount: 2)
        await library.refreshPlaylistsOnStartup(fetchPlaylist: { _ in partial },
            didRefresh: { _ in XCTFail("A partial response cannot remove tracks or history") })
        XCTAssertEqual(try store.snapshot(), original)

        let complete = try dto(["AAAAAAAAAAA", "DDDDDDDDDDD"])
        await library.refreshPlaylistsOnStartup(fetchPlaylist: { _ in
            library.closeLibrary()
            return complete
        }, didRefresh: { _ in XCTFail("A closed library must discard late responses") })
        XCTAssertFalse(library.isOpen)
        XCTAssertEqual(try store.snapshot(), original)
    }

    func testSavedQueueSkipsTracksTheLibraryNoLongerHas() {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        var items = fixture.occurrences.prefix(3).enumerated().map {
            PlayerCoordinator.Item(id: $0.offset, videoID: $0.element.youtubeId, localOccurrenceID: $0.element.id)
        }
        items.insert(PlayerCoordinator.Item(id: 9, videoID: "ScMzIvxBSi4", localOccurrenceID: OccurrenceID("removed-by-refresh")), at: 1)
        library.saveQueue(items: items, index: 1, playlist: fixture.playlists[0].id, epoch: library.generation)
        XCTAssertEqual(library.savedQueue?.occurrenceIDs, fixture.occurrences.prefix(3).map(\.id.rawValue))
        XCTAssertEqual(library.savedQueue?.index, 1, "A removed current track saves the next remaining one")
        XCTAssertNil(library.message)
    }

    func testSavedQueueLeavesOutSuggestions() {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        var items = fixture.occurrences.prefix(3).enumerated().map {
            PlayerCoordinator.Item(id: $0.offset, videoID: $0.element.youtubeId, localOccurrenceID: $0.element.id)
        }
        items.insert(PlayerCoordinator.Item(id: 9, videoID: "AAAAAAAAAAA", title: "Suggested"), at: 1)
        library.saveQueue(items: items, index: 1, playlist: fixture.playlists[0].id, epoch: library.generation)
        XCTAssertEqual(library.savedQueue?.occurrenceIDs, fixture.occurrences.prefix(3).map(\.id.rawValue))
        XCTAssertEqual(library.savedQueue?.index, 1, "A suggestion playing now saves the next library track")
        XCTAssertNil(library.message)
    }

    // MARK: Live queue

    func testLiveQueueKeepsTheCurrentTrackAndAddsNewOnes() {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let occurrences = fixture.occurrences
        let session = NativeListeningSession(items: occurrences, playlist: fixture.playlists[0], library: library, index: 1,
            testHooks: .init(load: { _, _ in XCTFail("A queue update must not reload the current track") }, progress: { _ in (0, 100) }, draw: { 0 }))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { session.coordinator.stop(); withExtendedLifetime(window) {} }
        session.coordinator.attach(window: window)
        session.coordinator.player.onEvent?(.ready(1))
        let current = session.coordinator.queue[1]
        let removed: Set<OccurrenceID> = [occurrences[0].id, occurrences[3].id]
        let added = LibraryOccurrence(id: OccurrenceID("demo-new"), playlistId: fixture.playlists[0].id, youtubeId: "dQw4w9WgXcQ",
            title: "New track", channelTitle: "Synthetic", thumbnail: "", duration: 0, position: 6, viewCount: nil, likeCount: nil,
            description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        let refreshed = occurrences.filter { !removed.contains($0.id) } + [added]
        XCTAssertTrue(session.applyRefresh(playlist: fixture.playlists[0], occurrences: refreshed, added: [added], draw: { 0 }))
        XCTAssertEqual(session.coordinator.queue[session.coordinator.index].id, current.id, "The current track keeps playing")
        XCTAssertEqual(session.coordinator.index, 0, "The removed track left the part already played")
        XCTAssertEqual(session.coordinator.queue.compactMap(\.localOccurrenceID),
                       [occurrences[1].id, added.id, occurrences[2].id, occurrences[4].id, occurrences[5].id])
        XCTAssertEqual(session.coordinator.queueState.count, 5)
        XCTAssertEqual(session.coordinator.queueState.requested, 0, "No load was requested")
        XCTAssertEqual(session.occurrencesByID[added.id], added)
        // The demo library itself was not refreshed, so its saved queue only
        // names tracks the library still has.
        XCTAssertEqual(library.savedQueue?.occurrenceIDs, [occurrences[1].id, occurrences[2].id, occurrences[4].id, occurrences[5].id].map(\.rawValue))
    }

    func testPlayNextPutsASuggestionAfterTheCurrentTrackWithoutReloadingOrSavingIt() throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let occurrences = fixture.occurrences
        let session = NativeListeningSession(items: occurrences, playlist: fixture.playlists[0], library: library, index: 1,
            testHooks: .init(load: { _, _ in XCTFail("Play next must not reload the current track") }, progress: { _ in (0, 100) }, draw: { 0 }))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { session.coordinator.stop(); withExtendedLifetime(window) {} }
        let first = try syntheticSuggestion("AAAAAAAAAAA", title: "First suggestion")
        let second = try syntheticSuggestion("BBBBBBBBBBB", title: "Second suggestion")
        XCTAssertFalse(session.playNext(first), "Not before the player is ready")
        XCTAssertTrue(session.suggestionsByItem.isEmpty)
        session.coordinator.attach(window: window)
        session.coordinator.player.onEvent?(.ready(1))
        let saved = try XCTUnwrap(library.savedQueue)
        let current = session.coordinator.queue[1]

        XCTAssertTrue(session.playNext(first))
        let queue = session.coordinator.queue
        XCTAssertEqual(session.coordinator.index, 1)
        XCTAssertEqual(queue[1].id, current.id, "The current track keeps playing")
        XCTAssertEqual(queue[2].videoID, first.youtubeId)
        XCTAssertNil(queue[2].localOccurrenceID, "A suggestion is not a library occurrence")
        XCTAssertTrue(session.isSuggestion(queue[2]))
        XCTAssertEqual(queue.compactMap(\.localOccurrenceID), occurrences.map(\.id), "Library tracks keep their order")
        XCTAssertEqual(session.coordinator.queueState.requested, 0, "No load was requested")
        XCTAssertEqual(library.savedQueue, saved, "The saved queue holds library tracks only")
        let row = try XCTUnwrap(session.displayOccurrence(for: queue[2]))
        XCTAssertEqual(row.title, "First suggestion")
        XCTAssertFalse(library.snapshot.occurrences.contains { $0.id == row.id }, "The row stand-in is not a library record")

        XCTAssertTrue(session.playNext(second))
        XCTAssertTrue(session.playNext(first), "Asking again moves the suggestion up instead of adding it twice")
        XCTAssertEqual(session.coordinator.queue.map(\.videoID),
                       [occurrences[0].youtubeId, occurrences[1].youtubeId, first.youtubeId, second.youtubeId] + occurrences[2...].map(\.youtubeId))
        XCTAssertEqual(session.suggestionsByItem.count, 2)
        XCTAssertEqual(library.savedQueue, saved)

        // Restart player rebuilds the same queue, suggestions included, at the same track.
        let entries = session.coordinator.queue.compactMap { session.entry(for: $0) }
        XCTAssertEqual(entries.count, session.coordinator.queue.count)
        let restarted = NativeListeningSession(entries: entries, playlist: fixture.playlists[0], library: library, index: 1,
            testHooks: .init(load: { _, _ in XCTFail("A restart waits for Play") }, progress: { _ in (0, 100) }, draw: { 0 }))
        defer { restarted.coordinator.stop() }
        XCTAssertEqual(restarted.coordinator.queue.map(\.videoID), session.coordinator.queue.map(\.videoID))
        XCTAssertTrue(restarted.isSuggestion(restarted.coordinator.queue[2]))
        XCTAssertEqual(library.savedQueue, saved)
    }

    func testPlayNextIsRefusedWhileATrackLoads() throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let session = NativeListeningSession(items: fixture.occurrences, playlist: fixture.playlists[0], library: library,
            testHooks: .init(load: { _, _ in try await Task.sleep(nanoseconds: 2_000_000_000) }, progress: { _ in (0, 100) }, draw: { 0 }))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { session.coordinator.stop(); withExtendedLifetime(window) {} }
        session.coordinator.attach(window: window)
        session.coordinator.player.onEvent?(.ready(1))
        XCTAssertTrue(session.coordinator.canReplaceQueue)
        session.coordinator.select(3)
        XCTAssertFalse(session.coordinator.canReplaceQueue)
        let before = session.coordinator.queue.map(\.id)
        XCTAssertFalse(session.playNext(try syntheticSuggestion("AAAAAAAAAAA", title: "Suggested")), "A pending load refers to the current order")
        XCTAssertEqual(session.coordinator.queue.map(\.id), before)
        XCTAssertTrue(session.suggestionsByItem.isEmpty)
    }

    func testASuggestionPlaysInTurnWithoutListeningHistory() async throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let loads = LoadLog()
        let session = NativeListeningSession(items: fixture.occurrences, playlist: fixture.playlists[0], library: library,
            testHooks: .init(load: { video, _ in loads.videos.append(video) }, progress: { _ in (0, 100) }, draw: { 0 },
                             onLoadFinished: { loads.finished?.fulfill(); loads.finished = nil }))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { session.coordinator.stop(); withExtendedLifetime(window) {} }
        let player = session.coordinator.player
        session.coordinator.attach(window: window)
        player.onEvent?(.ready(1))
        let suggested = try syntheticSuggestion("AAAAAAAAAAA", title: "Suggested")
        XCTAssertTrue(session.playNext(suggested))
        let history = library.snapshot.history.count

        // The first track ends: it is recorded and the suggestion plays next.
        let suggestionLoaded = expectation(description: "suggestion loaded")
        loads.finished = suggestionLoaded
        player.onEvent?(.state(1, 1))
        player.onEvent?(.state(1, 0))
        await fulfillment(of: [suggestionLoaded], timeout: 2)
        XCTAssertEqual(loads.videos, [suggested.youtubeId])
        XCTAssertEqual(session.coordinator.index, 1)
        XCTAssertEqual(library.snapshot.history.count, history + 1)
        XCTAssertEqual(library.snapshot.history.last?.videoId, fixture.occurrences[0].id)

        // The suggestion ends: playback continues with the playlist, nothing is recorded.
        let nextLoaded = expectation(description: "next track loaded")
        loads.finished = nextLoaded
        player.onEvent?(.ready(2))
        player.onEvent?(.state(2, 1))
        player.onEvent?(.state(2, 0))
        await fulfillment(of: [nextLoaded], timeout: 2)
        XCTAssertEqual(loads.videos, [suggested.youtubeId, fixture.occurrences[1].youtubeId])
        XCTAssertEqual(session.coordinator.index, 2)
        XCTAssertEqual(library.snapshot.history.count, history + 1, "A suggestion has no listening history")
    }

    func testRefreshKeepsSuggestionsAndAnInOrderQueuePlacesNewTracksByPosition() throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let occurrences = fixture.occurrences
        let session = NativeListeningSession(items: occurrences, playlist: fixture.playlists[0], library: library, index: 1, inOrder: true,
            testHooks: .init(load: { _, _ in XCTFail("A queue update must not reload the current track") }, progress: { _ in (0, 100) }, draw: { 0 }))
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { session.coordinator.stop(); withExtendedLifetime(window) {} }
        session.coordinator.attach(window: window)
        session.coordinator.player.onEvent?(.ready(1))
        XCTAssertTrue(session.playNext(try syntheticSuggestion("AAAAAAAAAAA", title: "Suggested")))
        // A new track took the place of occurrences[3] on YouTube and another was added at the end.
        func track(_ id: String, position: Int) -> LibraryOccurrence {
            LibraryOccurrence(id: OccurrenceID(id), playlistId: fixture.playlists[0].id, youtubeId: "dQw4w9WgXcQ", title: id,
                              channelTitle: "Synthetic", thumbnail: "", duration: 0, position: position, viewCount: nil, likeCount: nil,
                              description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        }
        let replacement = track("demo-replacement", position: 3), appended = track("demo-appended", position: 6)
        let refreshed = occurrences.filter { $0.id != occurrences[3].id } + [replacement, appended]
        XCTAssertTrue(session.applyRefresh(playlist: fixture.playlists[0], occurrences: refreshed, added: [replacement, appended],
                                           draw: { XCTFail("In order places new tracks without drawing"); return 0 }))
        let queue = session.coordinator.queue
        XCTAssertEqual(session.coordinator.index, 1)
        XCTAssertTrue(session.isSuggestion(queue[2]), "The suggestion still plays next")
        XCTAssertEqual(queue.compactMap(\.localOccurrenceID),
                       [occurrences[0].id, occurrences[1].id, occurrences[2].id, replacement.id, occurrences[4].id, occurrences[5].id, appended.id])
        XCTAssertEqual(session.coordinator.queueState.requested, 0)
    }

    func testQueueReplacementIsRefusedForAnotherCurrentItemOrDuringALoad() {
        let items = (0..<3).map { PlayerCoordinator.Item(id: $0, videoID: "ScMzIvxBSi4", localOccurrenceID: OccurrenceID("occurrence-\($0)")) }
        let hooks = PlayerCoordinator.TestHooks(load: { _, _ in try await Task.sleep(nanoseconds: 2_000_000_000) }, progress: { _ in (0, 100) }, draw: { 0 })
        let subject = PlayerCoordinator(initialItems: items, testHooks: hooks)
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { subject.stop(); withExtendedLifetime(window) {} }
        XCTAssertFalse(subject.replaceQueue(items, currentIndex: 0), "Not before the player is ready")
        subject.attach(window: window)
        subject.player.onEvent?(.ready(1))
        XCTAssertFalse(subject.replaceQueue([items[1], items[0]], currentIndex: 0), "The current item must stay current")
        XCTAssertTrue(subject.replaceQueue([items[2], items[0]], currentIndex: 1))
        XCTAssertEqual(subject.queue.map(\.id), [2, 0])
        XCTAssertEqual(subject.index, 1)
        subject.select(0)
        XCTAssertNotNil(subject.queueState.pending)
        XCTAssertFalse(subject.replaceQueue([items[2], items[0], items[1]], currentIndex: 1), "Never while a load is pending")
        XCTAssertEqual(subject.queue.map(\.id), [2, 0])
    }

    // MARK: Reopening the last library

    func testRecentLibraryReopensAfterRestartAndExplicitCloseForgetsIt() throws {
        let suite = "tubeshuffle-recent-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = try temporaryLibraryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: NativeLocalLibraryStore? = try NativeLocalLibraryStore.createNew(at: directory)
        try store!.importIntoEmpty(seed())
        store = nil
        let recents = NativeRecentLibrary(defaults: defaults)
        recents.remember(directory)
        XCTAssertTrue(recents.hasLibrary, "A security-scoped bookmark for the library folder must be creatable")
        let first = NativeLibraryModel(recents: recents)
        first.reopenRecentLibrary()
        XCTAssertTrue(first.isOpen)
        XCTAssertEqual(first.snapshot.playlists.map(\.id), [playlistID])
        first.closeLibrary()
        XCTAssertTrue(recents.hasLibrary, "Closing the window keeps the library for the next launch")
        let second = NativeLibraryModel(recents: recents)
        second.reopenRecentLibrary()
        XCTAssertTrue(second.isOpen)
        second.closeAndForgetLibrary()
        XCTAssertFalse(recents.hasLibrary, "Close library forgets it")
        let third = NativeLibraryModel(recents: recents)
        third.reopenRecentLibrary()
        XCTAssertFalse(third.isOpen)
        XCTAssertNil(third.message)
    }

    // MARK: Home page

    func testHomeShowsPlaylistsDirectlyWithoutOverflow() async throws {
        for size in [NSSize(width: 1280, height: 860), NSSize(width: 480, height: 680)] {
            let library = NativeLibraryModel()
            let preferences = try XCTUnwrap(UserDefaults(suiteName: "tubeshuffle-home-\(UUID().uuidString)"))
            var bounds: [String: CGRect] = [:]
            let host = NSHostingView(rootView: NativeLibraryView(library: library, preferences: preferences) { bounds = $0 })
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.setContentSize(size)
            window.orderBack(nil)
            defer { window.close(); library.closeLibrary() }
            try await Task.sleep(nanoseconds: 250_000_000)
            host.layoutSubtreeIfNeeded()
            XCTAssertNotNil(bounds["welcome"], "\(size): without a library, open/create are offered directly")
            library.openDemo()
            try await Task.sleep(nanoseconds: 350_000_000)
            host.layoutSubtreeIfNeeded()
            let grid = try XCTUnwrap(bounds["playlistGrid"], "\(size): saved playlists are on the home page")
            XCTAssertNotNil(bounds["libraryHeader"], "\(size)")
            XCTAssertNil(bounds["deck"], "\(size): no player exists until a playlist is opened")
            XCTAssertGreaterThan(grid.height, 100, "\(size)")
            for (key, rect) in bounds {
                XCTAssertGreaterThanOrEqual(rect.minX, -1, "\(size) \(key) overflows left")
                XCTAssertLessThanOrEqual(rect.maxX, size.width + 1, "\(size) \(key) overflows right")
            }
        }
    }

    func testPlayerViewTakesNoClicksWhileTheGridCoversIt() {
        let view = CoverableWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 120), configuration: WKWebViewConfiguration())
        let inside = NSPoint(x: 100, y: 60)
        XCTAssertNotNil(view.hitTest(inside))
        view.ignoresMouse = true
        XCTAssertNil(view.hitTest(inside), "Clicks must reach the grid drawn over the player")
        view.ignoresMouse = false
        XCTAssertNotNil(view.hitTest(inside))
    }

    // MARK: Fixtures

    private final class RefreshSource: NativePlaylistSource {
        var canFetchPlaylists = true
        var message: String?
        var response: YouTubePlaylistDTO?
        var requests: [String] = []
        init(response: YouTubePlaylistDTO?) { self.response = response }
        func fetchPlaylist(_ id: String) async -> YouTubePlaylistDTO? { requests.append(id); return response }
    }

    private func occurrence(_ id: String, video: String, position: Int, playlist: PlaylistID? = nil, title: String? = nil) -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: playlist ?? playlistID, youtubeId: video, title: title ?? "Track \(id)",
                          channelTitle: "Synthetic channel", thumbnail: "", duration: 120, position: position, viewCount: nil,
                          likeCount: nil, description: nil, tags: nil, categoryId: nil, publishedAt: nil)
    }

    private func localPlaylist(id: PlaylistID? = nil, youtubeID: String? = nil) -> LibraryPlaylist {
        LibraryPlaylist(id: id ?? playlistID, youtubeId: youtubeID ?? youtubePlaylist, title: "Local title", description: nil, thumbnail: nil,
                        channelTitle: "Synthetic channel", videoCount: 2, createdAt: "2026-01-01T00:00:00.000Z",
                        updatedAt: "2026-01-01T00:00:00.000Z")
    }

    private func history(_ id: String, _ occurrence: String) -> LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID(id), playlistId: playlistID, videoId: OccurrenceID(occurrence),
                            watchedAt: "2026-01-02T00:00:00.000Z", watchedSeconds: 0, completed: true)
    }

    private func seed() -> LibrarySnapshot {
        LibrarySnapshot(playlists: [localPlaylist()], occurrences: [
            occurrence("a", video: "AAAAAAAAAAA", position: 0), occurrence("b", video: "BBBBBBBBBBB", position: 1)
        ], history: [history("h-a", "a"), history("h-b", "b")])
    }

    private final class LoadLog {
        var videos: [String] = []
        var finished: XCTestExpectation?
    }

    private func item(_ id: Int, _ occurrence: String) -> PlayerCoordinator.Item {
        PlayerCoordinator.Item(id: id, videoID: "AAAAAAAAAAA", localOccurrenceID: OccurrenceID(occurrence))
    }

    private func fetched(_ videos: [String], youtubeID: String? = nil) -> LibrarySnapshot {
        let remote = PlaylistID("fresh-playlist")
        let playlist = LibraryPlaylist(id: remote, youtubeId: youtubeID ?? youtubePlaylist, title: "Remote title",
                                       description: "Remote description", thumbnail: nil, channelTitle: "Remote channel",
                                       videoCount: videos.count, createdAt: stamp, updatedAt: stamp)
        let items = videos.enumerated().map { index, video in
            occurrence("fresh-\(index)", video: video, position: index, playlist: remote, title: "Remote \(video)")
        }
        return LibrarySnapshot(playlists: [playlist], occurrences: items, history: [])
    }

    private func dto(_ videos: [String], youtubeID: String? = nil, reportedCount: Int? = nil) throws -> YouTubePlaylistDTO {
        let items: [[String: Any]] = videos.enumerated().map { position, video in
            ["id": video, "title": "Remote \(video)", "channelTitle": "Remote channel", "thumbnail": "", "duration": 94, "position": position]
        }
        let data = try JSONSerialization.data(withJSONObject: ["id": youtubeID ?? youtubePlaylist, "title": "Remote title", "description": NSNull(),
            "thumbnail": NSNull(), "channelTitle": "Remote channel", "videoCount": reportedCount ?? videos.count, "videos": items])
        return try JSONDecoder().decode(YouTubePlaylistDTO.self, from: data)
    }

    private func temporaryLibraryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-refresh-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return directory
    }
}

/// A daily suggestion as the service sends it (the DTO only decodes).
func syntheticSuggestion(_ video: String, title: String) throws -> SuggestedVideoDTO {
    let fields: [String: Any] = ["id": "suggestion-\(video)", "youtubeId": video, "title": title, "channelTitle": "Suggested channel",
                                 "thumbnail": "", "duration": 200, "url": "https://www.youtube.com/watch?v=\(video)",
                                 "reason": "synthetic", "query": "synthetic"]
    return try JSONDecoder().decode(SuggestedVideoDTO.self, from: JSONSerialization.data(withJSONObject: fields))
}
