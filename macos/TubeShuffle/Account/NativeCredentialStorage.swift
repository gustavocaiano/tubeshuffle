import Auth
import Foundation
import Security

// Reserved for new installations only. This does not migrate any prior service.
// The envelope identifies this format, not the writer's identity. Neither the
// lock nor the read-before-mutation checks fence other processes or crashes.
protocol NativeCredentialBackend {
    func add(key: String, value: Data) -> OSStatus
    func update(key: String, value: Data) -> OSStatus
    func read(key: String) -> (OSStatus, Data?)
    func delete(key: String) -> OSStatus
}

private struct NativeSecurityCredentialBackend: NativeCredentialBackend {
    private func query(_ key: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: NativeCredentialStorage.service, kSecAttrAccount: key]
    }
    func add(key: String, value: Data) -> OSStatus {
        var item = query(key)
        item[kSecValueData] = value
        // Domain and lock-state behavior must be verified on the actual Mac.
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil)
    }
    func update(key: String, value: Data) -> OSStatus {
        SecItemUpdate(query(key) as CFDictionary, [kSecValueData: value] as CFDictionary)
    }
    func read(key: String) -> (OSStatus, Data?) {
        var item = query(key)
        item[kSecReturnData] = true
        item[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        return (status, result as? Data)
    }
    func delete(key: String) -> OSStatus {
        SecItemDelete(query(key) as CFDictionary)
    }
}

final class NativeCredentialStorage: AuthLocalStorage, @unchecked Sendable {
    static let service = "com.tubeshuffle.native.auth.v1"
    static let sessionKey = "session.v1"
    static let verifierKey = "session.v1-code-verifier"
    private static let legacyKey = "supabase.session"
    private static let prefix = Data("TubeShuffle.NativeCredential.v1\0".utf8)

    enum Failure: Error, Equatable { case denied, collision, readFailed, corrupt, writeFailed, removeFailed }
    struct Observation: Equatable {
        enum Operation { case store, retrieve, remove }
        enum Category { case absent, corrupt, collision, denied, readFailure, writeFailure, removeFailure }
        let operation: Operation
        let category: Category
    }
    private let backend: any NativeCredentialBackend
    private let lock = NSLock()
    private var ledger: [Observation] = []

    init() { backend = NativeSecurityCredentialBackend() }
    init(backend: any NativeCredentialBackend) { self.backend = backend }
    var observations: [Observation] { lock.lock(); defer { lock.unlock() }; return ledger }

    private func note(_ operation: Observation.Operation, _ category: Observation.Category) {
        ledger.append(Observation(operation: operation, category: category))
    }
    private func allowed(_ key: String) -> Bool { key == Self.sessionKey || key == Self.verifierKey }
    private func readOwned(_ key: String, operation: Observation.Operation) throws -> Data? {
        let (status, raw) = backend.read(key: key)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let raw else {
            note(operation, .readFailure); throw Failure.readFailed
        }
        guard raw.starts(with: Self.prefix) else {
            note(operation, .collision); throw Failure.collision
        }
        return Data(raw.dropFirst(Self.prefix.count))
    }
    func store(key: String, value: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard allowed(key) else { note(.store, .denied); throw Failure.denied }
        let existing = try readOwned(key, operation: .store)
        let wrapped = Self.prefix + value
        let status = existing == nil ? backend.add(key: key, value: wrapped) : backend.update(key: key, value: wrapped)
        // Never retry a duplicate add: its owner is unknown.
        guard status == errSecSuccess else {
            if status == errSecDuplicateItem { note(.store, .collision); throw Failure.collision }
            note(.store, .writeFailure); throw Failure.writeFailed
        }
    }
    func retrieve(key: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        if key == Self.legacyKey { return nil } // Logical SDK probe only; no backend access.
        guard allowed(key) else { note(.retrieve, .denied); throw Failure.denied }
        guard let data = try readOwned(key, operation: .retrieve) else {
            if key == Self.sessionKey { note(.retrieve, .absent) }
            return nil
        }
        // Pinned SDK SessionStorage uses Foundation's default JSONDecoder.
        if key == Self.sessionKey, (try? JSONDecoder().decode(Session.self, from: data)) == nil {
            note(.retrieve, .corrupt); throw Failure.corrupt
        }
        return data
    }
    func remove(key: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard allowed(key) else { note(.remove, .denied); throw Failure.denied }
        guard try readOwned(key, operation: .remove) != nil else { return }
        let status = backend.delete(key: key)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            note(.remove, .removeFailure); throw Failure.removeFailed
        }
    }
}
