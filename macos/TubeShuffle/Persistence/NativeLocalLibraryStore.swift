import Darwin
import Foundation
import SwiftData

struct NativeSavedQueue: Codable, Equatable {
    let version: Int
    let playlistID: String
    let occurrenceIDs: [String]
    let index: Int

    func resolve(in snapshot: LibrarySnapshot) throws -> [LibraryOccurrence] {
        guard version == 1, !occurrenceIDs.isEmpty, occurrenceIDs.count <= 50_000,
              occurrenceIDs.indices.contains(index),
              snapshot.playlists.contains(where: { $0.id == PlaylistID(playlistID) }),
              Set(occurrenceIDs.map(OccurrenceID.init)).count == occurrenceIDs.count else {
            throw NativeLocalLibraryStore.Failure.invalidSnapshot
        }
        let byID = Dictionary(uniqueKeysWithValues: snapshot.occurrences.map { ($0.id, $0) })
        return try occurrenceIDs.map { id in
            guard let item = byID[OccurrenceID(id)], item.playlistId == PlaylistID(playlistID) else {
                throw NativeLocalLibraryStore.Failure.ambiguousHistory
            }
            return item
        }
    }
}

// Local-only persistence boundary. This intentionally has no app-directory
// policy: the caller must present the create/open choice and supply a private
// directory it owns. It never discovers, repairs, migrates, or deletes a
// library destination.
@MainActor
final class NativeLocalLibraryStore: @preconcurrency LibraryRepository {
    enum Failure: Error, Equatable {
        case unavailable
        case alreadyOpen
        case missingStore
        case incompatibleStore
        case destinationNotEmpty
        case nonEmptyLibrary
        case invalidSnapshot
        case duplicatePlaylist
        case duplicateOccurrence
        case duplicateHistory
        case ambiguousHistory
        case saveFailed
    }

    struct Limits: Equatable {
        let playlists: Int
        let occurrences: Int
        let history: Int

        static let localDefault = Limits(playlists: 5_000, occurrences: 50_000, history: 100_000)
    }

    fileprivate static let markerName = ".tubeshuffle-local-library-v1"
    fileprivate static let lockName = ".tubeshuffle-local-library.lock"
    fileprivate static let storeName = "library.store"
    private static let queueName = "queue-v1.json"
    private static let queueByteLimit = 10_485_760
    fileprivate static let marker = Array("TubeShuffle local library schema 1\n".utf8)
    fileprivate static let sqliteHeader = Array("SQLite format 3\0".utf8)

    private static let maximumLimits = Limits(playlists: 5_000, occurrences: 50_000, history: 100_000)

    private let directory: URL
    private let lock: CooperativeLibraryLock
    private let container: ModelContainer
    private let context: ModelContext
    private let limits: Limits

    private init(directory: URL, lock: CooperativeLibraryLock, container: ModelContainer, limits: Limits) {
        self.directory = directory
        self.lock = lock
        self.container = container
        self.limits = limits
        context = ModelContext(container)
        context.autosaveEnabled = false
    }

    // The destination directory must already exist, be a private real
    // directory, and be empty. Creating the store is therefore an explicit UI
    // action, never an incidental side effect of reading a library.
    static func createNew(at directory: URL, limits: Limits = .localDefault) throws -> NativeLocalLibraryStore {
        try validateLimits(limits)
        let root = try PrivateDirectory.open(directory)
        defer { root.close() }
        try root.requireEmpty()
        let lock = try CooperativeLibraryLock(directory: root, createIfMissing: true)
        do {
            try root.requireOnlyLockFile(lockName)
            guard !root.exists(markerName), !root.exists(storeName),
                  !root.exists(storeName + "-wal"), !root.exists(storeName + "-shm") else {
                throw Failure.destinationNotEmpty
            }
            let container = try makeContainer(at: directory)
            let store = NativeLocalLibraryStore(directory: directory, lock: lock, container: container, limits: limits)
            guard try store.snapshot() == .empty else { throw Failure.destinationNotEmpty }
            guard try root.readRegular(storeName, limit: sqliteHeader.count, prefix: true) == sqliteHeader else {
                throw Failure.incompatibleStore
            }
            try root.writeNew(markerName, bytes: marker)
            return store
        } catch let error as Failure {
            throw error
        } catch {
            throw Failure.unavailable
        }
    }

    // Existing libraries are never created implicitly. The completion marker
    // and SQLite header are checked before SwiftData is allowed to open the
    // database. SwiftData has no public no-migration open mode, so this marker
    // is a fail-closed compatibility preflight for stores created by this
    // exact boundary; it is not a general physical-read-only or corruption
    // guarantee for arbitrary SQLite files.
    static func openExisting(at directory: URL, limits: Limits = .localDefault) throws -> NativeLocalLibraryStore {
        try validateLimits(limits)
        let root: PrivateDirectory
        do { root = try PrivateDirectory.open(directory) }
        catch { throw Failure.missingStore }
        defer { root.close() }
        guard root.exists(markerName), root.exists(storeName) else { throw Failure.missingStore }
        let lock = try CooperativeLibraryLock(directory: root, createIfMissing: false)
        do {
            guard try root.readRegular(markerName, limit: marker.count) == marker,
                  try root.readRegular(storeName, limit: sqliteHeader.count, prefix: true) == sqliteHeader else {
                throw Failure.incompatibleStore
            }
            try root.validateOptionalSQLiteSidecars(storeName)
            let container = try makeContainer(at: directory)
            let store = NativeLocalLibraryStore(directory: directory, lock: lock, container: container, limits: limits)
            _ = try store.snapshot()
            return store
        } catch let error as Failure {
            throw error
        } catch {
            throw Failure.incompatibleStore
        }
    }

    func snapshot() throws -> LibrarySnapshot {
        let playlists = try boundedFetch(StoredPlaylist.self, limit: limits.playlists)
        let occurrences = try boundedFetch(StoredOccurrence.self, limit: limits.occurrences)
        let history = try boundedFetch(StoredHistoryEvent.self, limit: limits.history)
        let snapshot = LibrarySnapshot(
            playlists: playlists.map(\.value),
            occurrences: occurrences.map(\.value),
            history: history.map(\.value)
        )
        try validate(snapshot, limits: limits)
        return Self.ordered(snapshot)
    }

    // The transfer layer must validate its payload before calling this method.
    // We validate again before reading/writing and only permit an exactly empty
    // destination. This is deliberately not a merge, refresh, or continuity
    // inference operation.
    func importIntoEmpty(_ incoming: LibrarySnapshot) throws {
        try validate(incoming, limits: limits)
        guard try snapshot() == .empty else { throw Failure.nonEmptyLibrary }
        do {
            incoming.playlists.forEach { context.insert(StoredPlaylist($0)) }
            incoming.occurrences.forEach { context.insert(StoredOccurrence($0)) }
            incoming.history.forEach { context.insert(StoredHistoryEvent($0)) }
            try context.save()
        } catch {
            context.rollback()
            throw Failure.saveFailed
        }
    }

    // Adds only a new bundle obtained from an API. Existing playlist IDs,
    // YouTube IDs, occurrences, and their positions are never refreshed.
    func addNewPlaylist(_ playlist: LibraryPlaylist, occurrences: [LibraryOccurrence]) throws {
        let candidate = LibrarySnapshot(playlists: [playlist], occurrences: occurrences, history: [])
        try validate(candidate, limits: limits)
        let existing = try snapshot()
        guard !existing.playlists.contains(where: { $0.id == playlist.id || Self.exactEqual($0.youtubeId, playlist.youtubeId) }) else {
            throw Failure.duplicatePlaylist
        }
        let ids = Set(existing.occurrences.map(\.id))
        guard !occurrences.contains(where: { ids.contains($0.id) }) else { throw Failure.duplicateOccurrence }
        guard existing.playlists.count < limits.playlists,
              existing.occurrences.count <= limits.occurrences - occurrences.count else {
            throw Failure.invalidSnapshot
        }
        do {
            context.insert(StoredPlaylist(playlist))
            occurrences.forEach { context.insert(StoredOccurrence($0)) }
            try context.save()
        } catch {
            context.rollback()
            throw Failure.saveFailed
        }
    }

    // Completion refers to one exact local occurrence. Repeating the same
    // event ID with byte-for-byte equivalent values is idempotent; a reused ID
    // with different values is ambiguous and rejected without overwriting it.
    func recordCompletion(_ event: LibraryHistoryEvent) throws {
        guard event.completed else { throw Failure.invalidSnapshot }
        try validate(LibrarySnapshot(playlists: [], occurrences: [], history: [event]), limits: limits,
                     allowReferencesOutsideSnapshot: true)
        let existing = try snapshot()
        if let prior = existing.history.first(where: { $0.id == event.id }) {
            guard prior == event else { throw Failure.ambiguousHistory }
            return
        }
        guard existing.history.count < limits.history else { throw Failure.invalidSnapshot }
        guard existing.playlists.contains(where: { $0.id == event.playlistId }),
              existing.occurrences.contains(where: { $0.id == event.videoId && $0.playlistId == event.playlistId }) else {
            throw Failure.ambiguousHistory
        }
        do {
            context.insert(StoredHistoryEvent(event))
            try context.save()
        } catch {
            context.rollback()
            throw Failure.saveFailed
        }
    }

    // Queue is a local sidecar: no database schema change and no transfer/cloud
    // inclusion. It stores exact occurrence references, never media or credentials.
    // Opening a library does not start playback or silently reset a bad sidecar.
    func savedQueue() throws -> NativeSavedQueue? {
        let root = try PrivateDirectory.open(directory)
        defer { root.close() }
        guard root.exists(Self.queueName) else { return nil }
        let queue = try decodeQueue(root.readRegular(Self.queueName, limit: Self.queueByteLimit))
        _ = try queue.resolve(in: snapshot())
        return queue
    }

    func saveQueue(_ queue: NativeSavedQueue) throws {
        _ = try queue.resolve(in: snapshot())
        let data = try JSONEncoder().encode(queue)
        guard data.count <= Self.queueByteLimit else { throw Failure.invalidSnapshot }
        let root = try PrivateDirectory.open(directory)
        defer { root.close() }
        if root.exists(Self.queueName) {
            // Refuse unrecognised or symlinked files instead of replacing them.
            _ = try decodeQueue(root.readRegular(Self.queueName, limit: Self.queueByteLimit))
            try data.write(to: directory.appendingPathComponent(Self.queueName), options: .atomic)
        } else {
            try root.writeNew(Self.queueName, bytes: Array(data))
        }
    }

    private func decodeQueue(_ bytes: [UInt8]) throws -> NativeSavedQueue {
        guard bytes.count <= Self.queueByteLimit else { throw Failure.invalidSnapshot }
        let data = Data(bytes)
        let document = try RawJSONScanner.scan(data, maximumNodes: 50_010, maximumDepth: 4)
        let keys = Set(document.nodes.filter { $0.parent == 0 }.compactMap(\.key))
        guard keys == Set(["version", "playlistID", "occurrenceIDs", "index"]) else { throw Failure.incompatibleStore }
        let queue = try JSONDecoder().decode(NativeSavedQueue.self, from: data)
        guard queue.version == 1 else { throw Failure.incompatibleStore }
        return queue
    }

    private func boundedFetch<T: PersistentModel>(_ type: T.Type, limit: Int) throws -> [T] {
        var descriptor = FetchDescriptor<T>()
        descriptor.fetchLimit = limit + 1
        let values = try context.fetch(descriptor)
        guard values.count <= limit else { throw Failure.invalidSnapshot }
        return values
    }

    private static func makeContainer(at directory: URL) throws -> ModelContainer {
        let schema = Schema([StoredPlaylist.self, StoredOccurrence.self, StoredHistoryEvent.self])
        let storeURL = directory.appendingPathComponent(storeName, isDirectory: false)
        let configuration = ModelConfiguration("TubeShuffleLocalLibrary", schema: schema,
                                               url: storeURL, cloudKitDatabase: .none)
        return try ModelContainer(for: schema, configurations: [configuration])
    }

    private static func validateLimits(_ limits: Limits) throws {
        guard (1...maximumLimits.playlists).contains(limits.playlists),
              (1...maximumLimits.occurrences).contains(limits.occurrences),
              (1...maximumLimits.history).contains(limits.history) else {
            throw Failure.invalidSnapshot
        }
    }

    private func validate(_ snapshot: LibrarySnapshot, limits: Limits,
                          allowReferencesOutsideSnapshot: Bool = false) throws {
        try Self.validate(snapshot, limits: limits, allowReferencesOutsideSnapshot: allowReferencesOutsideSnapshot)
    }

    private static func validate(_ snapshot: LibrarySnapshot, limits: Limits,
                                 allowReferencesOutsideSnapshot: Bool = false) throws {
        guard snapshot.playlists.count <= limits.playlists,
              snapshot.occurrences.count <= limits.occurrences,
              snapshot.history.count <= limits.history else { throw Failure.invalidSnapshot }
        var playlists = Set<PlaylistID>()
        var playlistYouTube = Set<String>()
        var occurrences = [OccurrenceID: PlaylistID]()
        var positions = [PlaylistID: Set<Int>]()
        var history = Set<HistoryID>()
        for value in snapshot.playlists {
            guard validID(value.id.rawValue), validText(value.youtubeId), validText(value.title),
                  validOptionalText(value.description), validOptionalText(value.thumbnail),
                  validOptionalText(value.channelTitle), value.videoCount >= 0,
                  validText(value.createdAt), validText(value.updatedAt),
                  playlists.insert(value.id).inserted, playlistYouTube.insert(value.youtubeId).inserted else {
                throw Failure.invalidSnapshot
            }
        }
        for value in snapshot.occurrences {
            guard validID(value.id.rawValue), validID(value.playlistId.rawValue), validText(value.youtubeId),
                  validText(value.title), validText(value.channelTitle), validText(value.thumbnail),
                  value.duration.isFinite, value.duration >= 0, value.position >= 0,
                  value.viewCount.map({ $0 >= 0 }) ?? true, value.likeCount.map({ $0 >= 0 }) ?? true,
                  validOptionalText(value.description), validOptionalStrings(value.tags),
                  validOptionalText(value.categoryId), validOptionalText(value.publishedAt),
                  occurrences.updateValue(value.playlistId, forKey: value.id) == nil,
                  positions[value.playlistId, default: []].insert(value.position).inserted,
                  allowReferencesOutsideSnapshot || playlists.contains(value.playlistId) else {
                throw Failure.invalidSnapshot
            }
        }
        for value in snapshot.history {
            guard validID(value.id.rawValue), validID(value.playlistId.rawValue), validID(value.videoId.rawValue),
                  validText(value.watchedAt), value.watchedSeconds.isFinite, value.watchedSeconds >= 0,
                  history.insert(value.id).inserted else { throw Failure.invalidSnapshot }
            if !allowReferencesOutsideSnapshot {
                guard playlists.contains(value.playlistId), occurrences[value.videoId] == value.playlistId else {
                    throw Failure.invalidSnapshot
                }
            }
        }
    }

    private static func validID(_ value: String) -> Bool { LibraryStorageKey.valid(LibraryStorageKey.encode(value), original: value) }
    private static func validText(_ value: String) -> Bool {
        // Empty thumbnails/optional strings and description newlines are legal
        // transfer values. Only identifiers have the stricter control-character
        // rule; never rewrite a valid record to satisfy persistence.
        value.unicodeScalars.count <= 16_384
    }
    private static func validOptionalText(_ value: String?) -> Bool { value.map(validText) ?? true }
    private static func validOptionalStrings(_ values: [String]?) -> Bool {
        guard let values else { return true }
        return values.count <= 512 && values.allSatisfy(validText)
    }

    private static func ordered(_ snapshot: LibrarySnapshot) -> LibrarySnapshot {
        LibrarySnapshot(
            playlists: snapshot.playlists.sorted { LibraryStorageKey.encode($0.id.rawValue) < LibraryStorageKey.encode($1.id.rawValue) },
            occurrences: snapshot.occurrences.sorted {
                let lhs = LibraryStorageKey.encode($0.playlistId.rawValue)
                let rhs = LibraryStorageKey.encode($1.playlistId.rawValue)
                if lhs != rhs { return lhs < rhs }
                if $0.position != $1.position { return $0.position < $1.position }
                return LibraryStorageKey.encode($0.id.rawValue) < LibraryStorageKey.encode($1.id.rawValue)
            },
            history: snapshot.history.sorted { LibraryStorageKey.encode($0.id.rawValue) < LibraryStorageKey.encode($1.id.rawValue) }
        )
    }

    private static func exactEqual(_ lhs: String, _ rhs: String) -> Bool {
        lhs.unicodeScalars.elementsEqual(rhs.unicodeScalars)
    }
}

@MainActor
private final class CooperativeLibraryLock {
    // Creation is main-actor confined; deinit is nonisolated in Swift 6, so
    // the release path must be explicitly opted out of actor checking.
    nonisolated(unsafe) private static var claimedDirectories = Set<String>()
    private let descriptor: Int32
    private let directoryIdentity: String

    init(directory: PrivateDirectory, createIfMissing: Bool) throws {
        var directoryInfo = stat()
        guard fstat(directory.descriptor, &directoryInfo) == 0 else { throw NativeLocalLibraryStore.Failure.unavailable }
        let directoryIdentity = "\(directoryInfo.st_dev):\(directoryInfo.st_ino)"
        guard !Self.claimedDirectories.contains(directoryIdentity) else { throw NativeLocalLibraryStore.Failure.alreadyOpen }
        let creation = createIfMissing ? O_CREAT : 0
        let descriptor = openat(directory.descriptor, ".tubeshuffle-local-library.lock",
                                O_RDWR | creation | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw NativeLocalLibraryStore.Failure.unavailable }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1, (info.st_mode & 0o077) == 0 else {
            close(descriptor); throw NativeLocalLibraryStore.Failure.unavailable
        }
        var tries = 0
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            if code == EINTR, tries < 8 { tries += 1; continue }
            close(descriptor)
            if code == EWOULDBLOCK || code == EAGAIN { throw NativeLocalLibraryStore.Failure.alreadyOpen }
            throw NativeLocalLibraryStore.Failure.unavailable
        }
        self.descriptor = descriptor
        self.directoryIdentity = directoryIdentity
        Self.claimedDirectories.insert(directoryIdentity)
    }

    deinit {
        Self.claimedDirectories.remove(directoryIdentity)
        _ = flock(descriptor, LOCK_UN)
        _ = close(descriptor)
    }
}

private final class PrivateDirectory {
    private(set) var descriptor: Int32
    private init(_ descriptor: Int32) { self.descriptor = descriptor }
    deinit { close() }

    static func open(_ url: URL) throws -> PrivateDirectory {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw NativeLocalLibraryStore.Failure.unavailable }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
            Darwin.close(descriptor); throw NativeLocalLibraryStore.Failure.unavailable
        }
        return PrivateDirectory(descriptor)
    }

    func close() {
        guard descriptor >= 0 else { return }
        _ = Darwin.close(descriptor)
        descriptor = -1
    }

    func exists(_ name: String) -> Bool {
        var info = stat()
        if fstatat(descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 { return true }
        return false
    }

    func requireOnlyLockFile(_ lock: String) throws {
        guard let stream = fdopendir(Darwin.dup(descriptor)) else { throw NativeLocalLibraryStore.Failure.unavailable }
        defer { closedir(stream) }
        var names: Set<String> = []
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                String(cString: UnsafeRawPointer(pointer).assumingMemoryBound(to: CChar.self))
            }
            if name != "." && name != ".." { names.insert(name) }
        }
        guard names.isEmpty || names == Set([lock]) else { throw NativeLocalLibraryStore.Failure.destinationNotEmpty }
    }

    func requireEmpty() throws {
        guard let stream = fdopendir(Darwin.dup(descriptor)) else { throw NativeLocalLibraryStore.Failure.unavailable }
        defer { closedir(stream) }
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                String(cString: UnsafeRawPointer(pointer).assumingMemoryBound(to: CChar.self))
            }
            if name != "." && name != ".." { throw NativeLocalLibraryStore.Failure.destinationNotEmpty }
        }
    }

    func readRegular(_ name: String, limit: Int, prefix: Bool = false) throws -> [UInt8] {
        let fd = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw NativeLocalLibraryStore.Failure.incompatibleStore }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1 else { throw NativeLocalLibraryStore.Failure.incompatibleStore }
        var bytes = [UInt8](repeating: 0, count: limit + (prefix ? 0 : 1))
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count >= 0 else { throw NativeLocalLibraryStore.Failure.incompatibleStore }
        return Array(bytes.prefix(count))
    }

    func validateOptionalSQLiteSidecars(_ name: String) throws {
        for suffix in ["-wal", "-shm"] {
            var info = stat()
            if fstatat(descriptor, name + suffix, &info, AT_SYMLINK_NOFOLLOW) == 0 {
                guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == geteuid(), info.st_nlink == 1 else {
                    throw NativeLocalLibraryStore.Failure.incompatibleStore
                }
            } else if errno != ENOENT { throw NativeLocalLibraryStore.Failure.incompatibleStore }
        }
    }

    func writeNew(_ name: String, bytes: [UInt8]) throws {
        let fd = openat(descriptor, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeLocalLibraryStore.Failure.unavailable }
        defer { Darwin.close(fd) }
        let count = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard count == bytes.count, fsync(fd) == 0 else { throw NativeLocalLibraryStore.Failure.unavailable }
    }
}
