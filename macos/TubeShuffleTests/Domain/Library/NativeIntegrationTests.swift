import AppKit
import XCTest
@testable import TubeShuffle

@MainActor
final class NativeIntegrationTests: XCTestCase {
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
