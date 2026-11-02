import Auth
import Foundation

// Create a separate instance for each authentication generation; never reuse a
// revoked instance. This storage deliberately has no persistent backing store.
final class RevocableSessionMemory: AuthLocalStorage, @unchecked Sendable {
    enum StorageError: Error, Equatable {
        case revoked
    }

    private let lock = NSLock()
    private var values: [Data: Data] = [:]
    private var revoked = false

    func store(key: String, value: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !revoked else { throw StorageError.revoked }
        values[Data(key.utf8)] = value
    }

    func retrieve(key: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return revoked ? nil : values[Data(key.utf8)]
    }

    func remove(key: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: Data(key.utf8))
    }

    func revokeAndClear() {
        lock.lock(); defer { lock.unlock() }
        revoked = true
        values.removeAll()
    }
}
