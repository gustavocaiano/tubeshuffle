import AppKit
import XCTest
@testable import TubeShuffle

@MainActor
final class NativeIntegrationTests: XCTestCase {
    func testYouTubePlaylistLinksAcceptSharedFormatsAndRejectOtherTargets() {
        let id = "PLSyntheticImport0001"
        for input in [id, "  \(id)\n", "https://www.youtube.com/playlist?list=\(id)",
                      "https://m.youtube.com/watch?v=ScMzIvxBSi4&list=\(id)&index=2",
                      "https://youtu.be/ScMzIvxBSi4?si=example&list=\(id)",
                      "youtube.com/playlist?list=\(id)", "https://WWW.YOUTUBE.COM/playlist?list=\(id)"] {
            XCTAssertEqual(NativeLibraryModel.playlistID(input), id, input)
        }
        for input in ["", "https://www.youtube.com/watch?v=ScMzIvxBSi4", "https://youtu.be/ScMzIvxBSi4",
                      "https://www.youtube.com/@example", "https://youtube.com.evil.test/playlist?list=\(id)",
                      "https://name:password@youtube.com/playlist?list=\(id)", "https://youtube.com:444/playlist?list=\(id)",
                      "https://youtube.com/playlist?list=\(id)&list=anotherPlaylist", "https://youtube.com/playlist?list=%0Abadvalue123",
                      "https://youtube.com/playlist?list=\(id)%0A",
                      "http://youtube.com/playlist?list=\(id)", String(repeating: "a", count: 2_049)] {
            XCTAssertNil(NativeLibraryModel.playlistID(input), input)
        }
    }

    func testPlaylistImportGatesDoNotFetchOrCreateImplicitLibraries() async throws {
        let source = PlaylistSource(response: try playlistDTO())
        let empty = NativeLibraryModel()
        let missingLibrary = await empty.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(missingLibrary)
        empty.openDemo()
        let demoImport = await empty.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(demoImport)
        XCTAssertEqual(empty.snapshot, NativeLibraryFixture.snapshot)
        let (library, directory) = try importLibrary()
        defer { library.closeLibrary(); try? FileManager.default.removeItem(at: directory) }
        let invalidLink = await library.importPlaylist("https://example.test/?list=PLSyntheticImport0001", account: source)
        XCTAssertNil(invalidLink)
        source.canFetchPlaylists = false
        let signedOut = await library.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(signedOut)
        XCTAssertEqual(source.requests, [])
        XCTAssertEqual(library.snapshot, .empty)
        XCTAssertFalse(library.busy)
    }

    func testPlaylistImportAddsDistinctOccurrencesAndRejectsDuplicateWithoutChangingHistory() async throws {
        let (library, directory) = try importLibrary(seed: NativeLibraryFixture.snapshot)
        defer { library.closeLibrary(); try? FileManager.default.removeItem(at: directory) }
        let original = NativeLibraryFixture.snapshot
        library.recordNaturalCompletion(.init(id: 0, videoID: original.occurrences[0].youtubeId,
            localOccurrenceID: original.occurrences[0].id), playlist: original.playlists[0].id, epoch: library.generation)
        let before = library.snapshot
        XCTAssertEqual(before.history.count, 1)
        let source = PlaylistSource(response: try playlistDTO())
        let result = await library.importPlaylist("https://youtu.be/ScMzIvxBSi4?list=PLSyntheticImport0001", account: source)
        let imported = try XCTUnwrap(result)
        XCTAssertEqual(source.requests, ["PLSyntheticImport0001"])
        XCTAssertEqual(library.snapshot.playlists.count, 2)
        let added = library.snapshot.occurrences.filter { $0.playlistId == imported }
        XCTAssertEqual(added.count, 2)
        XCTAssertEqual(Set(added.map(\.id)).count, 2, "Repeated video IDs remain distinct local occurrences")
        XCTAssertEqual(library.snapshot.history, before.history)
        XCTAssertEqual(library.snapshot.occurrences.filter { $0.playlistId != imported }, before.occurrences)
        let saved = library.snapshot
        let duplicate = await library.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(duplicate)
        XCTAssertEqual(source.requests.count, 1, "Duplicate import must not fetch again or replace history")
        XCTAssertEqual(library.snapshot, saved)
        library.closeLibrary()
        var reopened: NativeLocalLibraryStore? = try NativeLocalLibraryStore.openExisting(at: directory)
        XCTAssertEqual(try reopened!.snapshot(), saved)
        reopened = nil
    }

    func testFailedOrStalePlaylistImportDoesNotWriteAndPartialCountIsDisclosed() async throws {
        let (library, directory) = try importLibrary()
        defer { library.closeLibrary(); try? FileManager.default.removeItem(at: directory) }
        let source = PlaylistSource(response: nil)
        source.message = "Synthetic account service unavailable"
        let unavailable = await library.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(unavailable)
        XCTAssertEqual(library.message, source.message)
        XCTAssertEqual(library.snapshot, .empty)
        source.response = try playlistDTO(id: "PLDifferentImport0002")
        let mismatched = await library.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNil(mismatched)
        XCTAssertEqual(library.snapshot, .empty)
        source.response = try playlistDTO(declaredCount: 3)
        let partial = await library.importPlaylist("PLSyntheticImport0001", account: source)
        XCTAssertNotNil(partial)
        XCTAssertEqual(library.snapshot.occurrences.count, 2)
        XCTAssertEqual(library.snapshot.playlists[0].videoCount, 3)
        XCTAssertTrue(library.message?.contains("partial playlist") == true)
        let saved = library.snapshot
        source.response = try playlistDTO(id: "PLAnotherImport0003")
        source.onFetch = { library.closeLibrary() }
        let stale = await library.importPlaylist("PLAnotherImport0003", account: source)
        XCTAssertNil(stale)
        XCTAssertFalse(library.isOpen)
        var reopened: NativeLocalLibraryStore? = try NativeLocalLibraryStore.openExisting(at: directory)
        XCTAssertEqual(try reopened!.snapshot(), saved)
        reopened = nil
    }

    private final class PlaylistSource: NativePlaylistSource {
        var canFetchPlaylists = true
        var message: String?
        var response: YouTubePlaylistDTO?
        var requests: [String] = []
        var onFetch: (() -> Void)?
        init(response: YouTubePlaylistDTO?) { self.response = response }
        func fetchPlaylist(_ id: String) async -> YouTubePlaylistDTO? {
            requests.append(id); onFetch?(); return response
        }
    }

    private func importLibrary(seed: LibrarySnapshot? = nil) throws -> (NativeLibraryModel, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-link-import-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let store = try NativeLocalLibraryStore.createNew(at: directory)
        if let seed { try store.importIntoEmpty(seed) }
        return (try NativeLibraryModel(store: store, at: directory), directory)
    }

    private func playlistDTO(id: String = "PLSyntheticImport0001", declaredCount: Int = 2) throws -> YouTubePlaylistDTO {
        let videos: [[String: Any]] = (0..<2).map { position in
            ["id": "ScMzIvxBSi4", "title": "Synthetic track \(position)", "channelTitle": "Synthetic channel",
             "thumbnail": "", "duration": 94, "position": position]
        }
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "title": "Synthetic imported playlist",
            "description": NSNull(), "thumbnail": NSNull(), "channelTitle": "Synthetic channel", "videoCount": declaredCount, "videos": videos])
        return try JSONDecoder().decode(YouTubePlaylistDTO.self, from: data)
    }

    func testTransferPersistsAndReopensWithoutChangingOccurrenceHistory() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: url) }
        var store: NativeLocalLibraryStore? = try NativeLocalLibraryStore.createNew(at: url)
        let fixture = NativeLibraryFixture.snapshot
        let encoded = try TransferV1.encode(snapshot: fixture, exportedAt: "2026-01-01T00:00:00.000Z")
        let decoded = try TransferV1.decode(encoded.data)
        try store!.importIntoEmpty(decoded.snapshot)
        let event = LibraryHistoryEvent(id: HistoryID("integration-end"), playlistId: fixture.playlists[0].id,
            videoId: fixture.occurrences[5].id, watchedAt: "2026-01-01T01:00:00.000Z", watchedSeconds: 0, completed: true)
        try store!.recordCompletion(event); try store!.recordCompletion(event)
        let queue = NativeSavedQueue(version: 1, playlistID: fixture.playlists[0].id.rawValue,
            occurrenceIDs: fixture.occurrences.reversed().map { $0.id.rawValue }, index: 2)
        try store!.saveQueue(queue)
        let before = try store!.snapshot()
        XCTAssertEqual(before.history, [event])
        XCTAssertEqual(before.occurrences.count, 6)
        XCTAssertEqual(before.unwatchedOccurrences(for: fixture.playlists[0].id).count, 5)
        XCTAssertThrowsError(try store!.importIntoEmpty(decoded.snapshot))
        store = nil
        store = try NativeLocalLibraryStore.openExisting(at: url)
        XCTAssertEqual(try store!.snapshot(), before)
        XCTAssertEqual(try store!.savedQueue(), queue)
        let invalid = NativeSavedQueue(version: 1, playlistID: queue.playlistID, occurrenceIDs: ["unknown"], index: 0)
        XCTAssertThrowsError(try store!.saveQueue(invalid))
        XCTAssertEqual(try store!.savedQueue(), queue)
        let reexport = try TransferV1.encode(snapshot: before, exportedAt: "2026-01-01T02:00:00.000Z")
        XCTAssertEqual(try TransferV1.decode(reexport.data).snapshot, before)
        store = nil
    }

    func testFiveThousandOccurrenceTransferAndQueueRetainDistinctIDs() throws {
        let fixture = NativeLibraryFixture.snapshot
        let base = fixture.occurrences[0]
        let items = (0..<5_000).map { i in
            LibraryOccurrence(id: OccurrenceID("large-\(i)"), playlistId: base.playlistId, youtubeId: base.youtubeId,
                title: base.title, channelTitle: base.channelTitle, thumbnail: "", duration: 100, position: i,
                viewCount: nil, likeCount: nil, description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        }
        let value = LibrarySnapshot(playlists: fixture.playlists, occurrences: items, history: [])
        let encoded = try TransferV1.encode(snapshot: value, exportedAt: "2026-01-01T00:00:00.000Z")
        XCTAssertEqual(try TransferV1.decode(encoded.data).snapshot, value)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-5000-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: url) }
        var store: NativeLocalLibraryStore? = try NativeLocalLibraryStore.createNew(at: url)
        try store!.importIntoEmpty(TransferV1.decode(encoded.data).snapshot)
        XCTAssertEqual(try store!.snapshot().occurrences.count, 5_000)
        store = nil
        let queue = LibraryQueueBuilder.build(snapshot: value, playlistId: base.playlistId, mode: .smart, excludeWatched: true, draw: { 0.5 })
        XCTAssertEqual(queue.count, 5_000)
        XCTAssertEqual(Set(queue.map(\.id)), Set(items.map(\.id)))
    }

    func testNaturalLastItemCompletionIsOnceAndStopRevokesCallbacks() {
        let item = PlayerCoordinator.Item(id: 0, videoID: "ScMzIvxBSi4", localOccurrenceID: OccurrenceID("exact-occurrence"), title: "Synthetic")
        let hooks = PlayerCoordinator.TestHooks(load: { _, _ in XCTFail("No next item exists") }, progress: { _ in (0, 100) }, draw: { 0 })
        let subject = PlayerCoordinator(initialItems: [item], testHooks: hooks)
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        defer { subject.stop(); withExtendedLifetime(window) {} }
        var completed: [OccurrenceID] = []
        subject.onNaturalCompletion = { if let id = $0.localOccurrenceID { completed.append(id) } }
        subject.attach(window: window)
        subject.player.onEvent?(.ready(1))
        subject.player.onEvent?(.state(1, 1))
        subject.player.onEvent?(.state(1, 0))
        subject.player.onEvent?(.state(1, 0))
        XCTAssertEqual(completed, [OccurrenceID("exact-occurrence")])
        subject.stop()
        XCTAssertNil(subject.player.onEvent)
        XCTAssertFalse(subject.canTransport)
    }

    func testRestoredQueueStartsAtExactSavedOccurrenceWithoutCompletionOrLoad() {
        let items = (0..<3).map { PlayerCoordinator.Item(id: $0, videoID: "ScMzIvxBSi4", localOccurrenceID: OccurrenceID("occurrence-\($0)")) }
        let hooks = PlayerCoordinator.TestHooks(load: { _, _ in XCTFail("Restoration must not request autoplay") }, progress: { _ in (0, 100) }, draw: { 0 })
        let subject = PlayerCoordinator(initialItems: items, initialIndex: 2, testHooks: hooks)
        subject.onNaturalCompletion = { _ in XCTFail("Restoration must not invent history") }
        XCTAssertEqual(subject.index, 2)
        XCTAssertEqual(subject.queue[subject.index].localOccurrenceID, OccurrenceID("occurrence-2"))
        XCTAssertEqual(subject.queueState.requested, 0)
        subject.stop()
    }

    func testTransferResourceLimitsRejectBeforeBuildingAnUnboundedTree() {
        let deep = Data((String(repeating: "[", count: 30) + "0" + String(repeating: "]", count: 30)).utf8)
        XCTAssertThrowsError(try TransferV1.decode(deep)) { error in
            XCTAssertEqual(error as? TransferV1.Error, .raw(.resourceLimit))
        }
        XCTAssertThrowsError(try RawJSONScanner.scan(Data("[1,2,3]".utf8), maximumNodes: 3, maximumDepth: 8)) { error in
            XCTAssertEqual(error as? RawJSONError, .resourceLimit)
        }
    }

    func testSharedValidationVectorsAndFractionalIntegerDoNotSilentlyRound() throws {
        let url = try XCTUnwrap(Bundle(for: NativeIntegrationTests.self).url(forResource: "transfer-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let vectors = try XCTUnwrap((fixture["vectors"] as? [String: Any])?["validation"] as? [[String: Any]])
        for vector in vectors where vector["generator"] == nil {
            let data: Data
            if let raw = vector["raw"] as? String { data = Data(raw.utf8) }
            else { data = try JSONSerialization.data(withJSONObject: XCTUnwrap(vector["document"])) }
            if vector["expected"] as? String == "valid" { XCTAssertNoThrow(try TransferV1.decode(data), "\(vector["name"] ?? "vector")") }
            else { XCTAssertThrowsError(try TransferV1.decode(data), "\(vector["name"] ?? "vector")") }
        }
        let envelope = "{\"format\":\"tubeshuffle-transfer\",\"version\":1.00000000000000001,\"exportedAt\":\"2026-01-01T00:00:00.000Z\",\"playlists\":[],\"videos\":[],\"history\":[]}"
        XCTAssertThrowsError(try TransferV1.decode(Data(envelope.utf8)))
    }

    func testFileExportNeverReplacesAnExistingFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-export-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try NativeTransferFiles.writeNew(Data("first".utf8), at: url)
        XCTAssertThrowsError(try NativeTransferFiles.writeNew(Data("second".utf8), at: url))
        XCTAssertEqual(try Data(contentsOf: url), Data("first".utf8))
    }
}
