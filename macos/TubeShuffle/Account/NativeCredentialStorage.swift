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

/// A separate, origin-bound credential for personal playlist reads only. It
/// never reads, replaces or removes the account session or an unknown item.
final class NativePersonalImportCredential {
    enum Failure: Error, Equatable { case collision, corrupt, readFailed, writeFailed, randomFailed }
    static let key = "device-token.v1"
    private static let prefix = Data("TubeShuffle.PersonalImport.v1\0".utf8)
    private let backend: any NativeCredentialBackend
    private let lock = NSLock()
    let service: String

    init(configuration: NativeAccountConfiguration, backend: (any NativeCredentialBackend)? = nil) {
        let origin = configuration.applicationAPIOrigin.absoluteString
        let digest = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
        service = "com.tubeshuffle.native.personal-import.v1." + digest
        self.backend = backend ?? NativeSecurityCredentialBackend()
    }

    private func readOwned() throws -> String? {
        let (status, raw) = backend.read(service: service, key: Self.key)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let raw else { throw Failure.readFailed }
        guard raw.starts(with: Self.prefix) else { throw Failure.collision }
        guard let token = String(data: raw.dropFirst(Self.prefix.count), encoding: .utf8),
              PersonalImportToken.isValid(token) else { throw Failure.corrupt }
        return token
    }

    func retrieve() throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try readOwned()
    }

    /// Returns only a digest suitable for the server. A pre-existing valid
    /// credential is reused; collisions and failed writes are never retried.
    func prepare(randomBytes: () throws -> Data = NativePersonalImportCredential.randomBytes) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let token: String
        if let existing = try readOwned() { token = existing }
        else {
            let bytes = try randomBytes()
            guard bytes.count == 32 else { throw Failure.randomFailed }
            token = PersonalImportToken.encode(bytes)
            let status = backend.add(service: service, key: Self.key, value: Self.prefix + Data(token.utf8))
            guard status == errSecSuccess else { throw status == errSecDuplicateItem ? Failure.collision : Failure.writeFailed }
        }
        return SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func randomBytes() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        guard status == errSecSuccess else { throw Failure.randomFailed }
        return Data(bytes)
    }
}
