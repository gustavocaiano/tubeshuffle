import Auth
import CryptoKit
import Foundation
import Security

// Reserved for new installations only. This does not migrate any prior service.
// The envelope identifies this format, not the writer's identity. Neither the
// lock nor the read-before-mutation checks fence other processes or crashes.
protocol NativeCredentialBackend {
    func add(service: String, key: String, value: Data) -> OSStatus
    func update(service: String, key: String, value: Data) -> OSStatus
    func read(service: String, key: String) -> (OSStatus, Data?)
    func delete(service: String, key: String) -> OSStatus
}

private struct NativeSecurityCredentialBackend: NativeCredentialBackend {
    private func query(_ service: String, _ key: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: service, kSecAttrAccount: key]
    }
    func add(service: String, key: String, value: Data) -> OSStatus {
        var item = query(service, key)
        item[kSecValueData] = value
        // Domain and lock-state behavior must be verified on the actual Mac.
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil)
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        SecItemUpdate(query(service, key) as CFDictionary, [kSecValueData: value] as CFDictionary)
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        var item = query(service, key)
        item[kSecReturnData] = true
        item[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        return (status, result as? Data)
    }
    func delete(service: String, key: String) -> OSStatus {
        SecItemDelete(query(service, key) as CFDictionary)
    }
}

final class NativeCredentialStorage: AuthLocalStorage, @unchecked Sendable {
    static let servicePrefix = "com.tubeshuffle.native.auth.v2"
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
    let service: String
    private let lock = NSLock()
    private var ledger: [Observation] = []

    /// Only the configuration-scoped initializer is for production use. This
    /// compatibility initializer remains useful to synthetic tests but is not
    /// selected by `NativeAccountServiceFactory` and never migrates old items.
    init(backend: any NativeCredentialBackend) {
        service = "\(Self.servicePrefix).synthetic"
        self.backend = backend
    }

    init(configuration: NativeAccountConfiguration, backend: (any NativeCredentialBackend)? = nil) {
        service = Self.serviceNamespace(for: configuration)
        self.backend = backend ?? NativeSecurityCredentialBackend()
    }

    static func serviceNamespace(for configuration: NativeAccountConfiguration) -> String {
        // Length separators make this unambiguous even if a future allowed
        // configuration component gains a delimiter. The publishable key is
        // public configuration, never a credential.
        let canonical = [configuration.supabaseOrigin.absoluteString, configuration.applicationAPIOrigin.absoluteString,
                         configuration.publishableKey].map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return servicePrefix + "." + digest.map { String(format: "%02x", $0) }.joined()
    }
    var observations: [Observation] { lock.lock(); defer { lock.unlock() }; return ledger }

    private func note(_ operation: Observation.Operation, _ category: Observation.Category) {
        ledger.append(Observation(operation: operation, category: category))
    }
    private func allowed(_ key: String) -> Bool { key == Self.sessionKey || key == Self.verifierKey }
    private func readOwned(_ key: String, operation: Observation.Operation) throws -> Data? {
        let (status, raw) = backend.read(service: service, key: key)
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
        let status = existing == nil ? backend.add(service: service, key: key, value: wrapped) : backend.update(service: service, key: key, value: wrapped)
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
        let status = backend.delete(service: service, key: key)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            note(.remove, .removeFailure); throw Failure.removeFailed
        }
    }
}
