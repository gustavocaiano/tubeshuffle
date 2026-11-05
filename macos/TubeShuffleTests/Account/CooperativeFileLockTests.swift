import Darwin
import Foundation
import XCTest

// Test-only experiment. The directory and the single lock inode are created by
// the fixture and must not be renamed, unlinked, or replaced until every user
// has exited. flock is advisory: this does not defend against an uncooperative
// same-user process, prove app-container identity, or establish signing.
private final class CooperativeFileLock {
    enum Failure: Error, Equatable {
        case invalidName
        case openFailed(Int32)
        case invalidFile
        case timedOut
        case lockFailed(Int32)
        case unlockFailed(Int32)
    }

    private var descriptor: Int32 = -1

    init(directory: Int32, name: String, timeout: TimeInterval) throws {
        guard !name.isEmpty, name != ".", name != "..",
              !name.contains("/"), !name.utf8.contains(0) else {
            throw Failure.invalidName
        }
        // O_NONBLOCK prevents opening a substituted FIFO from hanging before
        // fstat rejects it; O_NOFOLLOW rejects the final-component symlink.
        let fd = openat(directory, name, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.openFailed(errno) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1,
              (info.st_mode & 0o077) == 0 else {
            close(fd)
            throw Failure.invalidFile
        }

        let deadline = ProcessInfo.processInfo.systemUptime + max(0, timeout)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            guard code == EWOULDBLOCK || code == EAGAIN || code == EINTR else {
                close(fd)
                throw Failure.lockFailed(code)
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                close(fd)
                throw Failure.timedOut
            }
            usleep(1_000)
        }
        descriptor = fd
    }

    func release() throws {
        guard descriptor >= 0 else { return }
        let fd = descriptor
        descriptor = -1
        let result = flock(fd, LOCK_UN)
        let code = errno
        close(fd)
        if result != 0 { throw Failure.unlockFailed(code) }
    }

    deinit {
        if descriptor >= 0 { close(descriptor) }
    }
}

final class CooperativeFileLockTests: XCTestCase {
    // Only this fixture creates/removes names, and cleanup happens after every
    // lock and subprocess using its directory has exited.
    private final class Fixture {
        let url: URL
        let directory: Int32
        let name = "lock"

        init() throws {
            url = FileManager.default.temporaryDirectory
                .appendingPathComponent("cooperative-lock-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else {
                let code = errno
                try? FileManager.default.removeItem(at: url)
                throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
            }
            directory = fd
            let file = openat(fd, name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard file >= 0 else {
                let code = errno
                close(fd)
                try? FileManager.default.removeItem(at: url)
                throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
            }
            close(file)
        }

        deinit {
            close(directory)
            try? FileManager.default.removeItem(at: url)
        }

        func lock(timeout: TimeInterval = 0) throws -> CooperativeFileLock {
            try CooperativeFileLock(directory: directory, name: name, timeout: timeout)
        }
    }

    func testIndependentDescriptorsContendThenRelease() throws {
        let fixture = try Fixture()
        let first = try fixture.lock()
        XCTAssertThrowsError(try fixture.lock(timeout: 0.03)) {
            XCTAssertEqual($0 as? CooperativeFileLock.Failure, .timedOut)
        }
        try first.release()
        let second = try fixture.lock()
        try second.release()
        try first.release() // Explicit release is idempotent.
    }

    func testSymlinkAndNonRegularFileAreRejected() throws {
        let fixture = try Fixture()
        guard symlinkat(fixture.name, fixture.directory, "link") == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: "link", timeout: 0)) {
            XCTAssertEqual($0 as? CooperativeFileLock.Failure, .openFailed(ELOOP))
        }
        guard mkdirat(fixture.directory, "directory", 0o700) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: "directory", timeout: 0)) {
            XCTAssertEqual($0 as? CooperativeFileLock.Failure, .openFailed(EISDIR))
        }
        guard mkfifoat(fixture.directory, "fifo", 0o600) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: "fifo", timeout: 0)) {
            XCTAssertEqual($0 as? CooperativeFileLock.Failure, .invalidFile)
        }
        // Rejecting a symlink never disturbs its target.
        let lock = try fixture.lock()
        try lock.release()
    }

    func testInvalidNamesAreRejectedBeforeOpening() throws {
        let fixture = try Fixture()
        for name in ["", ".", "..", "../lock", "/lock", "dir/lock", "lock\0suffix"] {
            XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: name, timeout: 0)) {
                XCTAssertEqual($0 as? CooperativeFileLock.Failure, .invalidName)
            }
        }
    }

    func testHardLinkIsRejected() throws {
        let fixture = try Fixture()
        guard linkat(fixture.directory, fixture.name, fixture.directory, "alias", 0) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        for name in [fixture.name, "alias"] {
            XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: name, timeout: 0)) {
                XCTAssertEqual($0 as? CooperativeFileLock.Failure, .invalidFile)
            }
        }
    }

    func testReplacementDemonstratesInodeStabilityRequirement() throws {
        let fixture = try Fixture()
        let original = try fixture.lock()
        // Deliberately violate the fixture's stable-inode contract to show that
        // advisory locks cannot prevent a replacement from creating a second lock.
        guard renameat(fixture.directory, fixture.name, fixture.directory, "old-lock") == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let replacement = openat(fixture.directory, fixture.name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard replacement >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        close(replacement)
        let second = try fixture.lock()
        XCTAssertThrowsError(try CooperativeFileLock(directory: fixture.directory, name: "old-lock", timeout: 0)) {
            XCTAssertEqual($0 as? CooperativeFileLock.Failure, .timedOut)
        }
        try second.release()
        try original.release()
    }

    func testProcessDeathReleasesLock() throws {
        throw XCTSkip("Cross-process death coverage unavailable: no safely bounded child reaping helper; hosted sandbox may also prohibit process launch")
    }
}
