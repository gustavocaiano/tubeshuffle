import Auth
import Foundation
import Security

// Test-target-only prototype. No production service namespace is defined here.
protocol KeychainBackend {
    func add(service: String, key: String, value: Data) -> OSStatus
    func update(service: String, key: String, value: Data) -> OSStatus
    func read(service: String, key: String) -> (OSStatus, Data?)
    func delete(service: String, key: String) -> OSStatus
}

private struct SecurityKeychainBackend: KeychainBackend {
    private func query(_ service: String, _ key: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: key]
    }

    func add(service: String, key: String, value: Data) -> OSStatus {
        var attributes = query(service, key)
        attributes[kSecValueData] = value
        // Desired policy: device-only, available after first unlock until reboot.
        // This attribute's effect on the selected macOS Keychain domain is not
        // established; verify domain, signing and lock-state behavior separately.
        // No access group or synchronizable attribute is requested.
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(service: String, key: String, value: Data) -> OSStatus {
        SecItemUpdate(query(service, key) as CFDictionary, [kSecValueData: value] as CFDictionary)
    }

    func read(service: String, key: String) -> (OSStatus, Data?) {
        var attributes = query(service, key)
        attributes[kSecReturnData] = true
        attributes[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        return (status, result as? Data)
    }

    func delete(service: String, key: String) -> OSStatus {
        SecItemDelete(query(service, key) as CFDictionary)
    }
}

// Deliberately contains no key, value, underlying error, or Security message.
struct KeychainStorageError: Error, Equatable {
    enum Operation: String { case add, update, read, delete }
    let operation: Operation
    let status: OSStatus
}

final class KeychainAuthLocalStorage: AuthLocalStorage, @unchecked Sendable {
    private let service: String
    private let backend: any KeychainBackend
    private let lock = NSLock()

    init(service: String, backend: (any KeychainBackend)? = nil) {
        precondition(!service.isEmpty, "A Keychain service namespace is required")
        self.service = service
        self.backend = backend ?? SecurityKeychainBackend()
    }

    func store(key: String, value: Data) throws {
        lock.lock(); defer { lock.unlock() }
        let status = backend.update(service: service, key: key, value: value)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainStorageError(operation: .update, status: status) }
        let added = backend.add(service: service, key: key, value: value)
        if added == errSecSuccess { return }
        // Another instance/process can create the item after the update missed.
        if added == errSecDuplicateItem {
            let retried = backend.update(service: service, key: key, value: value)
            // A concurrent deletion may make this update miss. Fail closed rather
            // than re-add and risk overwriting an item created by another writer.
            guard retried == errSecSuccess else { throw KeychainStorageError(operation: .update, status: retried) }
            return
        }
        throw KeychainStorageError(operation: .add, status: added)
    }

    func retrieve(key: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        let (status, data) = backend.read(service: service, key: key)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainStorageError(operation: .read, status: status) }
        guard let data = data else { throw KeychainStorageError(operation: .read, status: errSecDecode) }
        return data
    }

    func remove(key: String) throws {
        lock.lock(); defer { lock.unlock() }
        let status = backend.delete(service: service, key: key)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStorageError(operation: .delete, status: status)
        }
    }
}
