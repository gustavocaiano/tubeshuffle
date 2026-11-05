import Auth
import Foundation
import Security
import XCTest
@testable import TubeShuffle

private final class NativeMemoryBackend: NativeCredentialBackend {
    var values: [String: Data] = [:]
    var calls: [String] = []
    var readStatus: OSStatus?
    var addStatus: OSStatus?
    var updateStatus: OSStatus?
    var deleteStatus: OSStatus?
    private func namespaced(_ service: String, _ key: String) -> String { service + "\u{0}" + key }
    func add(service: String, key: String, value: Data) -> OSStatus {
        calls.append("add:\(service):\(key)")
        if let status = addStatus { return status }
        let namespaced = namespaced(service, key)
        guard values[namespaced] == nil else { return errSecDuplicateItem }
        values[namespaced] = value; return errSecSuccess
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        calls.append("update:\(service):\(key)")
        if let status = updateStatus { return status }
        let namespaced = namespaced(service, key)
        guard values[namespaced] != nil else { return errSecItemNotFound }
        values[namespaced] = value; return errSecSuccess
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        calls.append("read:\(service):\(key)")
        if let status = readStatus { return (status, nil) }
        guard let value = values[namespaced(service, key)] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }
    func delete(service: String, key: String) -> OSStatus {
        calls.append("delete:\(service):\(key)")
        if let status = deleteStatus { return status }
        return values.removeValue(forKey: namespaced(service, key)) == nil ? errSecItemNotFound : errSecSuccess
    }

    func value(service: String, key: String) -> Data? { values[namespaced(service, key)] }
    func set(_ value: Data, service: String, key: String) { values[namespaced(service, key)] = value }
}

final class NativeCredentialStorageTests: XCTestCase {
    private let session = NativeCredentialStorage.sessionKey
    private let verifier = NativeCredentialStorage.verifierKey

    private func sessionData() throws -> Data {
        let user = User(id: UUID(), appMetadata: [:], userMetadata: [:], aud: "synthetic",
                        createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        return try JSONEncoder().encode(Session(accessToken: "synthetic", tokenType: "bearer", expiresIn: 3600,
                                                expiresAt: 4102444800, refreshToken: "synthetic", user: user))
    }
    func testOnlyReservedKeysReachBackend() throws {
        let backend = NativeMemoryBackend(), storage = NativeCredentialStorage(backend: backend)
        XCTAssertEqual(storage.service, "com.tubeshuffle.native.auth.v2.synthetic")
        XCTAssertNil(try storage.retrieve(key: "supabase.session"))
        for key in ["supabase.session", "other", "session.v1-other"] {
            XCTAssertThrowsError(try storage.store(key: key, value: Data()))
            XCTAssertThrowsError(try storage.remove(key: key))
            if key != "supabase.session" { XCTAssertThrowsError(try storage.retrieve(key: key)) }
        }
        XCTAssertTrue(backend.calls.isEmpty)
        let data = try sessionData()
        try storage.store(key: session, value: data)
        XCTAssertEqual(try storage.retrieve(key: session), data)
        try storage.store(key: verifier, value: Data([1, 2]))
        try storage.store(key: verifier, value: Data([3]))
        XCTAssertEqual(try storage.retrieve(key: verifier), Data([3]))
        try storage.remove(key: session)
        try storage.remove(key: verifier)
        XCTAssertNil(try storage.retrieve(key: session))
    }
    func testAbsentCorruptAndReadFailureAreDistinct() throws {
        let backend = NativeMemoryBackend(), storage = NativeCredentialStorage(backend: backend)
        XCTAssertNil(try storage.retrieve(key: session))
        try storage.store(key: session, value: Data("invalid".utf8))
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .corrupt) }
        backend.readStatus = errSecNotAvailable
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .readFailed) }
        XCTAssertEqual(storage.observations.map(\.category), [.absent, .corrupt, .readFailure])
    }
    func testUnknownCollisionNeverMutatesAndDuplicateNeverRetries() throws {
        let backend = NativeMemoryBackend(), storage = NativeCredentialStorage(backend: backend)
        let unknown = Data([0, 1, 2])
        backend.set(unknown, service: storage.service, key: session)
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .collision) }
        XCTAssertThrowsError(try storage.store(key: session, value: Data()))
        XCTAssertThrowsError(try storage.remove(key: session))
        XCTAssertEqual(backend.value(service: storage.service, key: session), unknown)
        XCTAssertFalse(backend.calls.contains { $0.hasPrefix("update:") || $0.hasPrefix("delete:") })
        backend.values.removeAll()
        backend.calls.removeAll()
        backend.addStatus = errSecDuplicateItem
        XCTAssertThrowsError(try storage.store(key: session, value: Data())) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .collision) }
        XCTAssertEqual(backend.calls, ["read:\(storage.service):\(session)", "add:\(storage.service):\(session)"])
    }
    func testBackendFailuresAreSanitizedAndRecorded() throws {
        let backend = NativeMemoryBackend(), storage = NativeCredentialStorage(backend: backend)
        backend.addStatus = errSecNotAvailable
        XCTAssertThrowsError(try storage.store(key: verifier, value: Data([1])))
        backend.addStatus = nil
        try storage.store(key: verifier, value: Data([1]))
        backend.updateStatus = errSecNotAvailable
        XCTAssertThrowsError(try storage.store(key: verifier, value: Data([2])))
        backend.deleteStatus = errSecNotAvailable
        XCTAssertThrowsError(try storage.remove(key: verifier))
        XCTAssertEqual(storage.observations.map(\.category), [.writeFailure, .writeFailure, .removeFailure])
    }
    func testLegacyEnvelopeIsCorruptNotMigrated() throws {
        let backend = NativeMemoryBackend(), storage = NativeCredentialStorage(backend: backend)
        let object = try JSONSerialization.jsonObject(with: sessionData())
        let legacy = try JSONSerialization.data(withJSONObject: ["session": object, "expiration_date": 0])
        try storage.store(key: session, value: legacy)
        let before = backend.value(service: storage.service, key: session)
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .corrupt) }
        XCTAssertEqual(backend.value(service: storage.service, key: session), before)
    }

    func testConfigurationNamespacesKeepSameKeysInSeparateStores() throws {
        let first = try NativeAccountConfiguration(supabaseOrigin: try XCTUnwrap(URL(string: "https://one.supabase.co")),
                                                   publishableKey: "sb_publishable_synthetic", applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.one.test")))
        let second = try NativeAccountConfiguration(supabaseOrigin: try XCTUnwrap(URL(string: "https://two.supabase.co")),
                                                    publishableKey: "sb_publishable_synthetic", applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.two.test")))
        let backend = NativeMemoryBackend()
        let one = NativeCredentialStorage(configuration: first, backend: backend)
        let two = NativeCredentialStorage(configuration: second, backend: backend)
        XCTAssertNotEqual(one.service, two.service)
        XCTAssertTrue(one.service.hasPrefix(NativeCredentialStorage.servicePrefix + "."))
        let data = try sessionData()
        try one.store(key: session, value: data)
        XCTAssertEqual(try one.retrieve(key: session), data)
        XCTAssertNil(try two.retrieve(key: session))
        let storedBefore = backend.value(service: one.service, key: session)
        XCTAssertNotNil(storedBefore) // Backend retains the ownership envelope.
        try two.remove(key: session)
        XCTAssertEqual(backend.value(service: one.service, key: session), storedBefore)
        XCTAssertNil(backend.value(service: two.service, key: session))
    }
}
