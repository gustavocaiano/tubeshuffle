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
    func add(key: String, value: Data) -> OSStatus {
        calls.append("add:\(key)")
        if let status = addStatus { return status }
        guard values[key] == nil else { return errSecDuplicateItem }
        values[key] = value; return errSecSuccess
    }
    func update(key: String, value: Data) -> OSStatus {
        calls.append("update:\(key)")
        if let status = updateStatus { return status }
        guard values[key] != nil else { return errSecItemNotFound }
        values[key] = value; return errSecSuccess
    }
    func read(key: String) -> (OSStatus, Data?) {
        calls.append("read:\(key)")
        if let status = readStatus { return (status, nil) }
        guard let value = values[key] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }
    func delete(key: String) -> OSStatus {
        calls.append("delete:\(key)")
        if let status = deleteStatus { return status }
        return values.removeValue(forKey: key) == nil ? errSecItemNotFound : errSecSuccess
    }
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
        XCTAssertEqual(NativeCredentialStorage.service, "com.tubeshuffle.native.auth.v1")
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
        backend.values[session] = unknown
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .collision) }
        XCTAssertThrowsError(try storage.store(key: session, value: Data()))
        XCTAssertThrowsError(try storage.remove(key: session))
        XCTAssertEqual(backend.values[session], unknown)
        XCTAssertFalse(backend.calls.contains { $0.hasPrefix("update:") || $0.hasPrefix("delete:") })
        backend.values.removeValue(forKey: session)
        backend.calls.removeAll()
        backend.addStatus = errSecDuplicateItem
        XCTAssertThrowsError(try storage.store(key: session, value: Data())) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .collision) }
        XCTAssertEqual(backend.calls, ["read:\(session)", "add:\(session)"])
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
        let before = backend.values[session]
        XCTAssertThrowsError(try storage.retrieve(key: session)) { XCTAssertEqual($0 as? NativeCredentialStorage.Failure, .corrupt) }
        XCTAssertEqual(backend.values[session], before)
    }
}
