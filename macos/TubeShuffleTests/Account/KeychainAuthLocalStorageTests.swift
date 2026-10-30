import Foundation
import Security
import XCTest

private final class MemoryKeychain: KeychainBackend {
    private struct ItemID: Hashable {
        let service: String
        let key: String
    }
    private var values: [ItemID: Data] = [:]
    var addError: OSStatus?
    var updateError: OSStatus?
    var readError: OSStatus?
    var deleteError: OSStatus?
    private func id(_ service: String, _ key: String) -> ItemID { ItemID(service: service, key: key) }
    func add(service: String, key: String, value: Data) -> OSStatus {
        if let error = addError { return error }
        let id = id(service, key)
        guard values[id] == nil else { return errSecDuplicateItem }
        values[id] = value; return errSecSuccess
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        if let error = updateError { return error }
        let id = id(service, key)
        guard values[id] != nil else { return errSecItemNotFound }
        values[id] = value; return errSecSuccess
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        if let error = readError { return (error, nil) }
        guard let value = values[id(service, key)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }
    func delete(service: String, key: String) -> OSStatus {
        if let error = deleteError { return error }
        return values.removeValue(forKey: id(service, key)) == nil ? errSecItemNotFound : errSecSuccess
    }
}

// Hooks model interleavings between distinct storage instances without relying on timing.
private final class RaceKeychain: KeychainBackend {
    let memory = MemoryKeychain()
    var afterUpdateMiss: (() -> Void)?
    var afterDuplicateAdd: (() -> Void)?

    func add(service: String, key: String, value: Data) -> OSStatus {
        let status = memory.add(service: service, key: key, value: value)
        if status == errSecDuplicateItem, let hook = afterDuplicateAdd {
            afterDuplicateAdd = nil
            hook()
        }
        return status
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        let status = memory.update(service: service, key: key, value: value)
        if status == errSecItemNotFound, let hook = afterUpdateMiss {
            afterUpdateMiss = nil
            hook()
        }
        return status
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        memory.read(service: service, key: key)
    }
    func delete(service: String, key: String) -> OSStatus {
        memory.delete(service: service, key: key)
    }
}

private final class LockedFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var failed = false
    func record() { lock.lock(); defer { lock.unlock() }; failed = true }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return failed }
}

final class KeychainAuthLocalStorageTests: XCTestCase {
    func testNamespacesWithSeparatorsDoNotCollide() throws {
        let backend = MemoryKeychain()
        let first = KeychainAuthLocalStorage(service: "a:b", backend: backend)
        let second = KeychainAuthLocalStorage(service: "a", backend: backend)
        try first.store(key: "c", value: Data([1]))
        try second.store(key: "b:c", value: Data([2]))
        XCTAssertEqual(try first.retrieve(key: "c"), Data([1]))
        XCTAssertEqual(try second.retrieve(key: "b:c"), Data([2]))
        try first.remove(key: "c")
        XCTAssertEqual(try second.retrieve(key: "b:c"), Data([2]))
    }

    func testSeparateInstancesDuplicateAddUpdatesExistingItem() throws {
        let backend = RaceKeychain()
        let first = KeychainAuthLocalStorage(service: "race", backend: backend)
        let second = KeychainAuthLocalStorage(service: "race", backend: backend)
        var otherError: Error?
        backend.afterUpdateMiss = {
            do { try second.store(key: "key", value: Data([2])) } catch { otherError = error }
        }
        try first.store(key: "key", value: Data([1]))
        XCTAssertNil(otherError)
        XCTAssertEqual(try second.retrieve(key: "key"), Data([1]))
    }

    func testSeparateInstancesDeletionAfterDuplicateFailsClosed() throws {
        let backend = RaceKeychain()
        let first = KeychainAuthLocalStorage(service: "race", backend: backend)
        let second = KeychainAuthLocalStorage(service: "race", backend: backend)
        let unrelated = KeychainAuthLocalStorage(service: "other", backend: backend)
        try unrelated.store(key: "key", value: Data([9]))
        var otherError: Error?
        backend.afterUpdateMiss = {
            do { try second.store(key: "key", value: Data([2])) } catch { otherError = error }
        }
        backend.afterDuplicateAdd = {
            do { try second.remove(key: "key") } catch { otherError = error }
        }
        XCTAssertThrowsError(try first.store(key: "key", value: Data([1]))) { error in
            XCTAssertEqual(error as? KeychainStorageError, KeychainStorageError(operation: .update, status: errSecItemNotFound))
        }
        XCTAssertNil(otherError)
        XCTAssertNil(try second.retrieve(key: "key"))
        XCTAssertEqual(try unrelated.retrieve(key: "key"), Data([9]))
    }

    func testBinaryEmptyReplacementAndDistinctKeys() throws {
        let storage = KeychainAuthLocalStorage(service: "unit", backend: MemoryKeychain())
        XCTAssertNil(try storage.retrieve(key: "missing"))
        try storage.remove(key: "missing")
        let binary = Data([0, 255, 128, 1])
        try storage.store(key: "a", value: binary)
        try storage.store(key: "b", value: Data())
        XCTAssertEqual(try storage.retrieve(key: "a"), binary)
        XCTAssertEqual(try storage.retrieve(key: "b"), Data())
        try storage.store(key: "a", value: Data([42]))
        XCTAssertEqual(try storage.retrieve(key: "a"), Data([42]))
        try storage.remove(key: "a")
        try storage.remove(key: "a")
        XCTAssertNil(try storage.retrieve(key: "a"))
        XCTAssertEqual(try storage.retrieve(key: "b"), Data())
    }

    func testFailuresAreSanitizedAndDoNotDestroyExistingValue() throws {
        let backend = MemoryKeychain()
        let storage = KeychainAuthLocalStorage(service: "unit", backend: backend)
        let key = "private-key-sentinel", value = Data("secret-value-sentinel".utf8)
        try storage.store(key: key, value: value)
        func check(_ operation: KeychainStorageError.Operation, _ action: () throws -> Void) {
            XCTAssertThrowsError(try action()) { error in
                XCTAssertEqual(error as? KeychainStorageError, KeychainStorageError(operation: operation, status: errSecInteractionNotAllowed))
                let text = "\(error) \(String(reflecting: error)) \((error as NSError).localizedDescription)"
                XCTAssertFalse(text.contains(key)); XCTAssertFalse(text.contains("secret-value-sentinel"))
            }
        }
        backend.updateError = errSecInteractionNotAllowed
        check(.update) { try storage.store(key: key, value: Data()) }
        backend.updateError = nil
        backend.addError = errSecInteractionNotAllowed
        check(.add) { try storage.store(key: "new", value: value) }
        backend.addError = nil
        backend.readError = errSecInteractionNotAllowed
        check(.read) { _ = try storage.retrieve(key: key) }
        backend.readError = nil
        backend.deleteError = errSecInteractionNotAllowed
        check(.delete) { try storage.remove(key: key) }
        backend.deleteError = nil
        XCTAssertEqual(try storage.retrieve(key: key), value)
    }

    func testConcurrentCallsOnOneInstance() {
        let storage = KeychainAuthLocalStorage(service: "unit", backend: MemoryKeychain())
        let failures = LockedFailure()
        DispatchQueue.concurrentPerform(iterations: 200) { index in
            do {
                let key = "key-\(index)"
                let value = Data([UInt8(index)])
                try storage.store(key: key, value: value)
                if try storage.retrieve(key: key) != value { throw KeychainStorageError(operation: .read, status: errSecDecode) }
                try storage.remove(key: key)
            } catch {
                failures.record()
            }
        }
        XCTAssertFalse(failures.get())
    }

    func testRealKeychainUsesIsolatedServiceAndTargetedCleanup() throws {
        let service = "com.tubeshuffle.tests.keychain.\(UUID().uuidString)"
        let storage = KeychainAuthLocalStorage(service: service)
        let keys = ["fixture-a", "fixture-b"]
        // Only these exact test keys in this unique service are ever deleted.
        defer {
            for key in keys {
                do {
                    try storage.remove(key: key)
                } catch {
                    XCTFail("Failed to clean up a test Keychain item")
                }
            }
        }
        try storage.store(key: keys[0], value: Data([0, 255, 1]))
        try storage.store(key: keys[1], value: Data())
        XCTAssertEqual(try storage.retrieve(key: keys[0]), Data([0, 255, 1]))
        XCTAssertEqual(try storage.retrieve(key: keys[1]), Data())
        try storage.store(key: keys[0], value: Data([7]))
        XCTAssertEqual(try storage.retrieve(key: keys[0]), Data([7]))
        try storage.remove(key: keys[0])
        try storage.remove(key: keys[0])
        XCTAssertNil(try storage.retrieve(key: keys[0]))
    }
}
