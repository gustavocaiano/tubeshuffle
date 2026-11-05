import Darwin
import Foundation
import SwiftData
#if !TUBESHUFFLE_STANDALONE_LIBRARY_PROBE
@testable import TubeShuffle
#endif

// Headless lifecycle boundary only. This file is test-target only and is not
// compiled into, or referenced by, the application target.
// The lock is cooperative, not a defence against another process replacing its
// inode, ignoring flock, changing paths, or opening the database directly.
// A version marker and SQLite header are not a corruption check, compatibility
// proof, or migration gate. SwiftData may migrate or physically write while
// opening, including on a failed open. No automatic recovery is attempted here.
// Provisioning failures leave all partial artifacts in place; there is no reset,
// cleanup, retry, history/credential sync, import, or app integration here.
// Ancestor path races and uncooperative same-user writers are not prevented.
@MainActor
final class ExperimentalLocalLibraryStore {
    enum Failure: Error, Equatable {
        case unavailable
        case alreadyOwned
        case invalidStore
    }
    enum Mode { case createNew, openExisting }

    private static let marker = Array("TubeShuffle local library 1\n".utf8)
    private static let sqliteHeader = Array("SQLite format 3\0".utf8)
    // Never remove entries, even when inspection or ModelContainer construction
    // fails. SwiftData exposes no verified close here. This intentionally retains
    // both the descriptor and any successful container until process exit.
    private static var owners: [String: ExperimentalLocalLibraryStore] = [:]
    private let lockDescriptor: Int32
    private var container: ModelContainer?

    #if DEBUG
    // Deterministic standalone-probe observation points. They default to nil;
    // the before hook runs immediately before ModelContainer construction and
    // the after hook only after a container has been constructed and assigned
    // to the process-lifetime owner. Neither is available in the app target.
    static var beforeContainerConstructionForTesting: (() throws -> Void)?
    static var afterContainerAssignedForTesting: (() throws -> Void)?
    #endif

    private init(lockDescriptor: Int32) { self.lockDescriptor = lockDescriptor }

    #if DEBUG
    // The caller must own an exclusive synthetic directory. Not an app setting.
    static func testing(_ mode: Mode, root: URL) throws -> ExperimentalLocalLibraryStore {
        try open(mode, root: root)
    }
    #endif

    private static func open(_ mode: Mode, root: URL) throws -> ExperimentalLocalLibraryStore {
        let rootFD = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard rootFD >= 0 else { throw Failure.unavailable }
        defer { close(rootFD) }
        var info = stat()
        guard fstat(rootFD, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else { throw Failure.unavailable }
        let identity = "\(info.st_dev):\(info.st_ino)"
        guard owners[identity] == nil else { throw Failure.alreadyOwned }

        // This separate inode is never unlinked or replaced by this boundary.
        let fd = openat(rootFD, "library.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.unavailable }
        var lockInfo = stat()
        guard fstat(fd, &lockInfo) == 0, (lockInfo.st_mode & S_IFMT) == S_IFREG,
              lockInfo.st_uid == geteuid(), lockInfo.st_nlink == 1,
              (lockInfo.st_mode & 0o077) == 0 else {
            close(fd); throw Failure.unavailable
        }
        var interruptedAttempts = 0
        while true {
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { break }
            let code = errno
            if code == EINTR && interruptedAttempts < 8 {
                interruptedAttempts += 1
                continue
            }
            close(fd)
            if code == EWOULDBLOCK || code == EAGAIN { throw Failure.alreadyOwned }
            throw Failure.unavailable
        }
        let owner = ExperimentalLocalLibraryStore(lockDescriptor: fd)
        owners[identity] = owner

        if case .createNew = mode {
            // EEXIST is a hard failure, including empty or partial directories.
            guard mkdirat(rootFD, "library", 0o700) == 0 else { throw Failure.invalidStore }
        }
        let directory = openat(rootFD, "library", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw Failure.invalidStore }
        defer { close(directory) }
        var directoryInfo = stat()
        guard fstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == geteuid(),
              (directoryInfo.st_mode & 0o077) == 0 else { throw Failure.invalidStore }

        if case .openExisting = mode {
            guard try readRegular(directory, name: "version", limit: 64) == marker,
                  try readRegular(directory, name: "library.store", limit: sqliteHeader.count, prefix: true) == sqliteHeader
            else { throw Failure.invalidStore }
            // Reject substituted sidecars before SwiftData is allowed to open.
            for name in ["library.store-wal", "library.store-shm"] {
                var sidecar = stat()
                if fstatat(directory, name, &sidecar, AT_SYMLINK_NOFOLLOW) == 0 {
                    guard (sidecar.st_mode & S_IFMT) == S_IFREG, sidecar.st_uid == geteuid(),
                          sidecar.st_nlink == 1 else { throw Failure.invalidStore }
                } else if errno != ENOENT { throw Failure.invalidStore }
            }
        }

        let schema = Schema([StoredPlaylist.self, StoredOccurrence.self, StoredHistoryEvent.self])
        let storeURL = root.appendingPathComponent("library", isDirectory: true).appendingPathComponent("library.store")
        let config = ModelConfiguration("LocalLibrary", schema: schema, url: storeURL, cloudKitDatabase: .none)
        #if DEBUG
        try Self.beforeContainerConstructionForTesting?()
        #endif
        do { owner.container = try ModelContainer(for: schema, configurations: [config]) }
        catch { throw Failure.invalidStore }
        #if DEBUG
        try Self.afterContainerAssignedForTesting?()
        #endif

        if case .createNew = mode {
            guard try readRegular(directory, name: "library.store", limit: sqliteHeader.count, prefix: true) == sqliteHeader
            else { throw Failure.invalidStore }
            // Write the completion marker last, without overwriting anything.
            // On any error leave the incomplete directory in place for diagnosis.
            let markerFD = openat(directory, "version.pending", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard markerFD >= 0 else { throw Failure.invalidStore }
            defer { close(markerFD) }
            let written = marker.withUnsafeBytes { Darwin.write(markerFD, $0.baseAddress!, $0.count) }
            guard written == marker.count, fsync(markerFD) == 0 else { throw Failure.invalidStore }
            // linkat fails if version exists; unlike rename it cannot replace it.
            // A failed unlink leaves two links and readRegular rejects the marker.
            guard linkat(directory, "version.pending", directory, "version", 0) == 0,
                  unlinkat(directory, "version.pending", 0) == 0 else { throw Failure.invalidStore }
        }
        return owner
    }

    private static func readRegular(_ directory: Int32, name: String, limit: Int, prefix: Bool = false) throws -> [UInt8] {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.invalidStore }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1 else { throw Failure.invalidStore }
        var bytes = [UInt8](repeating: 0, count: limit + (prefix ? 0 : 1))
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
        guard count >= 0 else { throw Failure.invalidStore }
        return Array(bytes.prefix(count))
    }
}
