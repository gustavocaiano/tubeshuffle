import Foundation
import Darwin
import SwiftData
import XCTest
@testable import TubeShuffle

final class SwiftDataLibraryRepositoryTests: XCTestCase {
    private let schema = Schema([StoredPlaylist.self, StoredOccurrence.self, StoredHistoryEvent.self])

    private func memory() throws -> ModelContainer {
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: [config])
    }
    private func disk(_ url: URL) throws -> ModelContainer {
        let config = ModelConfiguration("LibraryTest", schema: schema, url: url, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: [config])
    }
    private func playlist(_ id: String = "p") -> LibraryPlaylist {
        LibraryPlaylist(id: PlaylistID(id), youtubeId: "playlist-youtube", title: "Title", description: "description",
                        thumbnail: nil, channelTitle: "channel", videoCount: 2, createdAt: "created", updatedAt: "updated")
    }
    private func occurrence(_ id: String, _ position: Int, playlist: String = "p") -> LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID(playlist), youtubeId: "repeat", title: "title",
                          channelTitle: "channel", thumbnail: "thumb", duration: 2.5, position: position,
                          viewCount: 4, likeCount: nil, description: "detail", tags: ["one", "é"],
                          categoryId: nil, publishedAt: "date")
    }
    private func event(_ id: String = "p", video: String = "é", playlist: String = "p") -> LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID(id), playlistId: PlaylistID(playlist), videoId: OccurrenceID(video),
                            watchedAt: "watched", watchedSeconds: 1.25, completed: true)
    }
    private func seed(_ context: ModelContext) throws {
        context.insert(StoredPlaylist(playlist()))
        context.insert(StoredOccurrence(occurrence("é", 1)))
        context.insert(StoredOccurrence(occurrence("e\u{301}", 0)))
        context.insert(StoredHistoryEvent(event()))
        try context.save()
    }
    private func check(_ context: ModelContext, file: StaticString = #filePath, line: UInt = #line) throws {
        let snapshot = try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()
        XCTAssertEqual(snapshot.playlists, [playlist()], file: file, line: line)
        XCTAssertEqual(snapshot.occurrences, [occurrence("e\u{301}", 0), occurrence("é", 1)], file: file, line: line)
        XCTAssertEqual(snapshot.history, [event()], file: file, line: line)
        XCTAssertEqual(Array(snapshot.occurrences[0].id.rawValue.utf8), Array("e\u{301}".utf8), file: file, line: line)
        XCTAssertEqual(Array(snapshot.occurrences[1].id.rawValue.utf8), Array("é".utf8), file: file, line: line)
        XCTAssertEqual(Array(snapshot.history[0].videoId.rawValue.utf8), Array("é".utf8), file: file, line: line)
        XCTAssertEqual(snapshot.occurrences.map(\.youtubeId), ["repeat", "repeat"], file: file, line: line)
    }
    func testMemorySnapshot() throws {
        let container = try memory(); let context = ModelContext(container)
        context.autosaveEnabled = false
        try seed(context); try check(context)
    }
    func testNewContainerReopensUniqueDiskStore() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("TubeShuffle-Library-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("library.store")
        try autoreleasepool {
            let container = try disk(url); let context = ModelContext(container)
            context.autosaveEnabled = false; try seed(context)
        }
        try autoreleasepool {
            let container = try disk(url); let context = ModelContext(container)
            context.autosaveEnabled = false; try check(context)
        }
    }
    func testDuplicateIDsRejectedInEachNamespace() throws {
        for kind in 0..<3 {
            let container = try memory(); let context = ModelContext(container)
            context.insert(StoredPlaylist(playlist()))
            if kind == 0 { context.insert(StoredPlaylist(playlist())) }
            context.insert(StoredOccurrence(occurrence("v", 0)))
            if kind == 1 { context.insert(StoredOccurrence(occurrence("v", 1))) }
            context.insert(StoredHistoryEvent(event(video: "v")))
            if kind == 2 { context.insert(StoredHistoryEvent(event(video: "v"))) }
            XCTAssertThrowsError(try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()) {
                guard case LibrarySnapshotStorageError.duplicateID = $0 else { return XCTFail("unexpected error: \($0)") }
            }
        }
    }
    func testCorruptKeysAndDanglingReferencesRejected() throws {
        for kind in 0..<7 {
            let container = try memory(); let context = ModelContext(container)
            let p = StoredPlaylist(playlist()); let v = StoredOccurrence(occurrence("v", 0))
            let h = StoredHistoryEvent(event(video: "v"))
            switch kind {
            case 0: p.key = "70ff"
            case 1: v.playlistKey = "bad"
            case 2: h.videoKey = "bad"
            case 3: v.playlistId = "missing"; v.playlistKey = LibraryStorageKey.encode(v.playlistId)
            case 4: h.videoId = "missing"; h.videoKey = LibraryStorageKey.encode(h.videoId)
            case 5: h.playlistId = "missing"; h.playlistKey = LibraryStorageKey.encode(h.playlistId)
            default: p.id = "\u{0}"; p.key = LibraryStorageKey.encode(p.id)
            }
            context.insert(p); context.insert(v); context.insert(h)
            XCTAssertThrowsError(try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()) { error in
                if [0, 1, 2, 6].contains(kind) {
                    guard case LibrarySnapshotStorageError.invalidKey = error else { return XCTFail("unexpected error: \(error)") }
                } else {
                    guard case LibrarySnapshotStorageError.danglingReference = error else { return XCTFail("unexpected error: \(error)") }
                }
            }
        }
    }
    func testCrossPlaylistHistoryRejected() throws {
        let container = try memory(); let context = ModelContext(container)
        context.insert(StoredPlaylist(playlist())); context.insert(StoredPlaylist(playlist("other")))
        context.insert(StoredOccurrence(occurrence("v", 0)))
        context.insert(StoredHistoryEvent(event(video: "v", playlist: "other")))
        XCTAssertThrowsError(try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()) {
            guard case LibrarySnapshotStorageError.danglingReference = $0 else { return XCTFail("unexpected error: \($0)") }
        }
    }

    func testOptionalValuesAndBothBooleanValuesSurviveRead() throws {
        let container = try memory(); let context = ModelContext(container)
        let p = StoredPlaylist(playlist()); p.detail = nil; p.thumbnail = ""; p.channelTitle = ""
        let absent = StoredOccurrence(occurrence("absent", 0))
        absent.viewCount = nil; absent.likeCount = nil; absent.detail = nil
        absent.tags = nil; absent.categoryId = nil; absent.publishedAt = nil
        let empty = StoredOccurrence(occurrence("empty", 1))
        empty.viewCount = 0; empty.likeCount = 0; empty.detail = ""
        empty.tags = []; empty.categoryId = ""; empty.publishedAt = ""
        let yes = StoredHistoryEvent(event("yes", video: "absent"))
        let no = StoredHistoryEvent(event("no", video: "empty")); no.completed = false
        context.insert(p); context.insert(absent); context.insert(empty); context.insert(yes); context.insert(no)
        try context.save()
        let result = try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()
        XCTAssertNil(result.playlists[0].description)
        XCTAssertEqual(result.playlists[0].thumbnail, "")
        XCTAssertEqual(result.playlists[0].channelTitle, "")
        XCTAssertNil(result.occurrences[0].viewCount); XCTAssertNil(result.occurrences[0].likeCount)
        XCTAssertNil(result.occurrences[0].description); XCTAssertNil(result.occurrences[0].tags)
        XCTAssertNil(result.occurrences[0].categoryId); XCTAssertNil(result.occurrences[0].publishedAt)
        XCTAssertEqual(result.occurrences[1].viewCount, 0); XCTAssertEqual(result.occurrences[1].likeCount, 0)
        XCTAssertEqual(result.occurrences[1].description, ""); XCTAssertEqual(result.occurrences[1].tags, [])
        XCTAssertEqual(result.occurrences[1].categoryId, ""); XCTAssertEqual(result.occurrences[1].publishedAt, "")
        XCTAssertEqual(result.history.map(\.completed), [false, true])
    }

    func testOrderingDoesNotDependOnInsertionOrder() throws {
        for reverse in [false, true] {
            let container = try memory(); let context = ModelContext(container)
            let playlists = [playlist("a"), playlist("b")]
            let occurrences = [occurrence("z", 1, playlist: "a"), occurrence("x", 0, playlist: "a"),
                               occurrence("y", 0, playlist: "b")]
            let events = [event("z", video: "z", playlist: "a"), event("a", video: "y", playlist: "b")]
            for value in reverse ? Array(playlists.reversed()) : playlists { context.insert(StoredPlaylist(value)) }
            for value in reverse ? Array(occurrences.reversed()) : occurrences { context.insert(StoredOccurrence(value)) }
            for value in reverse ? Array(events.reversed()) : events { context.insert(StoredHistoryEvent(value)) }
            try context.save()
            let result = try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()
            XCTAssertEqual(result.playlists.map { $0.id.rawValue }, ["a", "b"])
            XCTAssertEqual(result.occurrences.map { $0.id.rawValue }, ["x", "z", "y"])
            XCTAssertEqual(result.history.map { $0.id.rawValue }, ["a", "z"])
        }
    }

    func testDuplicatePositionsRejectedPerPlaylist() throws {
        let container = try memory(); let context = ModelContext(container)
        context.insert(StoredPlaylist(playlist()))
        context.insert(StoredOccurrence(occurrence("a", 0)))
        context.insert(StoredOccurrence(occurrence("b", 0)))
        XCTAssertThrowsError(try ExperimentalExclusiveStoreDestinationInvariantReader(context: context).readAssumingExternallyExclusiveStore()) {
            guard case LibrarySnapshotStorageError.duplicatePosition = $0 else { return XCTFail("unexpected error: \($0)") }
        }
    }

    // mkdir must create the directory exclusively: createDirectory can accept an
    // existing directory, which would make cleanup of an unknown fixture unsafe.
    private func withRehearsalDirectory(_ directory: URL, _ body: (URL) throws -> Void) throws {
        guard mkdir(directory.path, 0o700) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }

    private func rehearsalDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("TubeShuffle-Rehearsal-\(UUID().uuidString)", isDirectory: true)
    }

    // Sequential, single-owner use of a private disposable directory supplies
    // the exclusivity assumption for this test, not the ModelContext itself.
    // Opening a SwiftData store may still write physical database metadata.
    private func withRehearsalContext<T>(_ url: URL, _ body: (ModelContext) throws -> T) throws -> T {
        try autoreleasepool {
            let container = try disk(url)
            let context = ModelContext(container)
            context.autosaveEnabled = false
            return try body(context)
        }
    }

    private func readRehearsal(_ url: URL) throws -> LibrarySnapshot {
        try withRehearsalContext(url) { context in
            try ExperimentalExclusiveStoreDestinationInvariantReader(context: context)
                .readAssumingExternallyExclusiveStore()
        }
    }

    func testDisposableDiskRehearsalReopenFilterShuffleAndReopen() throws {
        let first = playlist("a"), second = playlist("b")
        let composed = occurrence("é", 0, playlist: "a")
        let decomposed = occurrence("e\u{301}", 1, playlist: "a")
        let remaining = occurrence("remaining", 2, playlist: "a")
        let other = occurrence("other", 0, playlist: "b")
        let completed = event("event-a", video: "é", playlist: "a")
        let partial = LibraryHistoryEvent(id: HistoryID("event-b"), playlistId: PlaylistID("a"),
                                          videoId: decomposed.id, watchedAt: "later", watchedSeconds: 0.5,
                                          completed: false)
        let expected = LibrarySnapshot(playlists: [first, second],
                                       occurrences: [composed, decomposed, remaining, other],
                                       history: [completed, partial])
        try withRehearsalDirectory(rehearsalDirectory()) { directory in
            let url = directory.appendingPathComponent("library.store")
            try withRehearsalContext(url) { context in
                for value in expected.playlists { context.insert(StoredPlaylist(value)) }
                for value in expected.occurrences { context.insert(StoredOccurrence(value)) }
                for value in expected.history { context.insert(StoredHistoryEvent(value)) }
                try context.save()
            }
            let snapshot = try readRehearsal(url)
            XCTAssertEqual(snapshot, expected)
            XCTAssertEqual(snapshot.occurrences.map(\.youtubeId), ["repeat", "repeat", "repeat", "repeat"])
            for mode in [LibraryQueueBuilder.Mode.normal, .smart] {
                let queue = LibraryQueueBuilder.build(snapshot: snapshot, playlistId: PlaylistID("a"),
                                                      mode: mode, excludeWatched: true) { 0 }
                XCTAssertEqual(queue.count, 2)
                XCTAssertEqual(Set(queue.map(\.id)), Set([decomposed.id, remaining.id]))
                XCTAssertEqual(queue.first(where: { $0.id == decomposed.id }).map { Array($0.id.rawValue.utf8) },
                               Array("e\u{301}".utf8))
                XCTAssertFalse(queue.contains { $0.id == composed.id || $0.id == other.id })
            }
            XCTAssertEqual(snapshot, expected)
            XCTAssertEqual(try readRehearsal(url), expected)
        }
    }

    func testDisposableDiskRehearsalPropagatesInvariantFailureAfterReopen() throws {
        try withRehearsalDirectory(rehearsalDirectory()) { directory in
            let url = directory.appendingPathComponent("library.store")
            try withRehearsalContext(url) { context in
                context.insert(StoredPlaylist(playlist()))
                context.insert(StoredOccurrence(occurrence("one", 0)))
                context.insert(StoredOccurrence(occurrence("two", 0)))
                try context.save()
            }
            XCTAssertThrowsError(try readRehearsal(url)) {
                guard case LibrarySnapshotStorageError.duplicatePosition = $0 else {
                    return XCTFail("unexpected error: \($0)")
                }
            }
        }
    }

    func testDisposableDiskRehearsalPropagatesOpenFailureWithoutReplacingFixture() throws {
        try withRehearsalDirectory(rehearsalDirectory()) { directory in
            let blocked = directory.appendingPathComponent("not-a-directory")
            let sentinel = Data("synthetic fixture".utf8)
            try sentinel.write(to: blocked, options: .withoutOverwriting)
            XCTAssertThrowsError(try readRehearsal(blocked.appendingPathComponent("library.store")))
            XCTAssertEqual(try Data(contentsOf: blocked), sentinel)
        }
    }

    func testDisposableDiskRehearsalRefusesPreexistingDirectory() throws {
        try withRehearsalDirectory(rehearsalDirectory()) { directory in
            let occupied = directory.appendingPathComponent("occupied", isDirectory: true)
            try FileManager.default.createDirectory(at: occupied, withIntermediateDirectories: false)
            let sentinel = occupied.appendingPathComponent("sentinel")
            let bytes = Data("do not replace".utf8)
            try bytes.write(to: sentinel, options: .withoutOverwriting)
            XCTAssertThrowsError(try withRehearsalDirectory(occupied) { _ in
                XCTFail("Existing fixture must not be used")
            }) {
                XCTAssertEqual(($0 as? POSIXError)?.code, .EEXIST)
            }
            XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
        }
    }
}
