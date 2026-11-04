import Darwin
import Foundation
import XCTest
@testable import TubeShuffle

#if DEBUG
// Every root is created exclusively and is synthetic. These fixtures are
// deliberately not removed during the hosted test process: the implementation
// retains locks and possibly SwiftData resources until that process exits.
@MainActor
final class LocalLibraryStoreTests: XCTestCase {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("TubeShuffle-Lifecycle-\(UUID().uuidString)", isDirectory: true)
        guard mkdir(url.path, 0o700) == 0 else { throw POSIXError(.EIO) }
        return url
    }

    private func library(_ root: URL) throws -> URL {
        let url = root.appendingPathComponent("library", isDirectory: true)
        guard mkdir(url.path, 0o700) == 0 else { throw POSIXError(.EIO) }
        return url
    }

    private func write(_ value: String, to url: URL) throws {
        try Data(value.utf8).write(to: url, options: .withoutOverwriting)
    }

    func testCreateAndProcessLifetimeOwnership() throws {
        let dir = try root()
        _ = try ExperimentalLocalLibraryStore.testing(.createNew, root: dir)
        let library = dir.appendingPathComponent("library")
        XCTAssertEqual(try Data(contentsOf: library.appendingPathComponent("version")),
                       Data("TubeShuffle local library 1\n".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.appendingPathComponent("library.store").path))
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .alreadyOwned)
        }
        let fd = open(dir.appendingPathComponent("library.lock").path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(fd, 0)
        if fd >= 0 { defer { close(fd) }; XCTAssertNotEqual(flock(fd, LOCK_EX | LOCK_NB), 0) }
    }

    func testCreateRefusesExistingDirectoryAndPreservesSentinel() throws {
        let dir = try root(), target = try library(dir)
        let sentinel = target.appendingPathComponent("sentinel")
        try write("preserve", to: sentinel)
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.createNew, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .invalidStore)
        }
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("preserve".utf8))
    }

    func testOpenMissingOrInvalidMarkerAndMissingStoreRejects() throws {
        for marker in [Optional<String>.none, .some("unknown version\n"), .some("TubeShuffle local library 1\n")] {
            let dir = try root(), target = try library(dir)
            let sentinel = target.appendingPathComponent("sentinel")
            try write("preserve", to: sentinel)
            if let marker { try write(marker, to: target.appendingPathComponent("version")) }
            XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
                XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .invalidStore)
            }
            XCTAssertEqual(try Data(contentsOf: sentinel), Data("preserve".utf8))
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.appendingPathComponent("library.store").path))
        }
        let absent = try root()
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: absent))
        XCTAssertFalse(FileManager.default.fileExists(atPath: absent.appendingPathComponent("library").path))
    }

    func testCorruptHeaderAndSymlinkAreRejectedWithoutReplacement() throws {
        for useSymlink in [false, true] {
            let dir = try root(), target = try library(dir)
            try write("TubeShuffle local library 1\n", to: target.appendingPathComponent("version"))
            let sentinel = target.appendingPathComponent("sentinel")
            try write("not a database", to: sentinel)
            let store = target.appendingPathComponent("library.store")
            if useSymlink {
                XCTAssertEqual(symlink("sentinel", store.path), 0)
            } else {
                try write("not a database", to: store)
            }
            XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
                XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .invalidStore)
            }
            XCTAssertEqual(try Data(contentsOf: sentinel), Data("not a database".utf8))
        }
    }

    func testUnknownMarkerDoesNotOpenSyntheticStore() throws {
        let dir = try root(), target = try library(dir)
        try write("TubeShuffle local library 99\n", to: target.appendingPathComponent("version"))
        let store = target.appendingPathComponent("library.store")
        let bytes = Data("SQLite format 3\0synthetic sentinel".utf8)
        try bytes.write(to: store, options: .withoutOverwriting)
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .invalidStore)
        }
        XCTAssertEqual(try Data(contentsOf: store), bytes)
    }

    func testRejectedInspectionStillOwnsLock() throws {
        let dir = try root()
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir))
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.createNew, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .alreadyOwned)
        }
    }

    func testExistingCooperativeLockPreventsInspection() throws {
        let dir = try root(), target = try library(dir)
        let sentinel = target.appendingPathComponent("sentinel")
        try write("preserve", to: sentinel)
        let fd = open(dir.appendingPathComponent("library.lock").path,
                      O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw POSIXError(.EIO) }
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.createNew, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .alreadyOwned)
        }
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("preserve".utf8))
    }

    func testFailedSwiftDataOpenStillOwnsLock() throws {
        let dir = try root(), target = try library(dir)
        try write("TubeShuffle local library 1\n", to: target.appendingPathComponent("version"))
        let store = target.appendingPathComponent("library.store")
        let corrupt = Data("SQLite format 3\0invalid truncated synthetic database".utf8)
        try corrupt.write(to: store, options: .withoutOverwriting)
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .invalidStore)
        }
        XCTAssertThrowsError(try ExperimentalLocalLibraryStore.testing(.openExisting, root: dir)) {
            XCTAssertEqual($0 as? ExperimentalLocalLibraryStore.Failure, .alreadyOwned)
        }
        // An attempted SwiftData open may make physical writes.
    }

    func testSuccessfulExistingStoreReopenRequiresSeparateProcess() throws {
        throw XCTSkip("A safe reopen requires a separately exited fixture process; see macos/tests/run_standalone_library_store_probe.py for the external harness.")
    }
}
#endif
