import Auth
import Foundation
import Security
import XCTest

@testable import TubeShuffle

// This entire probe is test-only. It never uses Security's real backend.
private final class SyntheticBackend: KeychainBackend, @unchecked Sendable {
    enum Operation { case read, write, delete }
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var failures: [Operation: Set<String>] = [:]

    func fail(_ operation: Operation, key: String, enabled: Bool) {
        lock.lock(); defer { lock.unlock() }
        if enabled { failures[operation, default: []].insert(key) }
        else { failures[operation]?.remove(key) }
    }
    func add(service: String, key: String, value: Data) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        if failures[.write, default: []].contains(key) { return errSecNotAvailable }
        if values[key] != nil { return errSecDuplicateItem }
        values[key] = value
        return errSecSuccess
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        if failures[.write, default: []].contains(key) { return errSecNotAvailable }
        guard values[key] != nil else { return errSecItemNotFound }
        values[key] = value
        return errSecSuccess
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        lock.lock(); defer { lock.unlock() }
        if failures[.read, default: []].contains(key) { return (errSecNotAvailable, nil) }
        guard let value = values[key] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }
    func delete(service: String, key: String) -> OSStatus {
        lock.lock(); defer { lock.unlock() }
        if failures[.delete, default: []].contains(key) { return errSecNotAvailable }
        return values.removeValue(forKey: key) == nil ? errSecItemNotFound : errSecSuccess
    }
}

// Only operation, coarse category and generation are retained, never keys/errors/data.
// Generation is sampled when a failure is recorded: it is a temporal marker, not
// an operation-scoped token, so concurrent operations may share a generation.
private final class RecordingStorage: AuthLocalStorage, @unchecked Sendable {
    struct Failure: Equatable {
        enum Operation { case store, retrieve, remove }
        enum Category { case storage }
        let operation: Operation
        let category: Category
        let generation: Int
    }
    private let inner: KeychainAuthLocalStorage
    private let lock = NSLock()
    private var recorded: [Failure] = []
    private var currentGeneration = 0
    init(_ inner: KeychainAuthLocalStorage) { self.inner = inner }
    func nextGeneration() { lock.lock(); defer { lock.unlock() }; currentGeneration += 1 }
    var failures: [Failure] { lock.lock(); defer { lock.unlock() }; return recorded }
    private func record(_ operation: Failure.Operation) {
        lock.lock(); defer { lock.unlock() }
        recorded.append(Failure(operation: operation, category: .storage, generation: currentGeneration))
    }
    func store(key: String, value: Data) throws {
        do { try inner.store(key: key, value: value) } catch { record(.store); throw error }
    }
    func retrieve(key: String) throws -> Data? {
        do { return try inner.retrieve(key: key) } catch { record(.retrieve); throw error }
    }
    func remove(key: String) throws {
        do { try inner.remove(key: key) } catch { record(.remove); throw error }
    }
}

private final class RequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var requests: Int { lock.lock(); defer { lock.unlock() }; return count }
    func reject() throws -> (Data, URLResponse) {
        lock.lock(); count += 1; lock.unlock()
        throw URLError(.notConnectedToInternet)
    }
}

// Release is idempotent and also works before the writer installs its continuation.
@MainActor
private final class WriterLatch {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait(started: XCTestExpectation) async {
        await withCheckedContinuation { pending in
            if released { pending.resume() }
            else { continuation = pending }
            started.fulfill()
        }
    }

    func release() {
        guard !released else { return }
        released = true
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
}

@MainActor
final class AuthStorageProbeTests: XCTestCase {
    private let legacy = "supabase.session"
    private func sessionData() throws -> Data {
        let user = User(id: UUID(), appMetadata: [:], userMetadata: [:], aud: "synthetic",
                        createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        let session = Session(accessToken: "synthetic-access", tokenType: "bearer", expiresIn: 3600,
                              expiresAt: Date().timeIntervalSince1970 + 3600,
                              refreshToken: "synthetic-refresh", user: user)
        return try JSONEncoder().encode(session)
    }
    private func makeStorage() -> (SyntheticBackend, RecordingStorage, String, RequestCounter) {
        let backend = SyntheticBackend()
        let key = "test.synthetic.\(UUID().uuidString)"
        let storage = RecordingStorage(KeychainAuthLocalStorage(service: "synthetic-only", backend: backend))
        return (backend, storage, key, RequestCounter())
    }
    private func client(_ storage: RecordingStorage, _ key: String, _ counter: RequestCounter) -> AuthClient {
        AuthClient(url: URL(string: "https://example.invalid")!, storageKey: key, localStorage: storage,
                   fetch: { _ in try counter.reject() }, autoRefreshToken: false)
    }
    // AuthClient probes exercise currentSession reads/migration and OAuth URL
    // generation's verifier write. They do not exercise SDK session writes,
    // SDK session deletion, verifier retrieval/removal, or SDK sign-out.
    func testCurrentSessionAndSwallowedReadFailure() throws {
        let (backend, storage, key, requests) = makeStorage()
        try storage.store(key: key, value: sessionData())
        let auth = client(storage, key, requests)
        XCTAssertEqual(auth.currentSession?.accessToken, "synthetic-access")
        storage.nextGeneration()
        backend.fail(.read, key: key, enabled: true)
        XCTAssertNil(auth.currentSession)
        XCTAssertTrue(storage.failures.contains { $0.operation == .retrieve && $0.generation == 1 })
        XCTAssertEqual(requests.requests, 0)
    }
    func testLegacyMigrationAndDestinationWriteFailure() throws {
        let (backend, storage, key, requests) = makeStorage()
        try storage.store(key: legacy, value: sessionData())
        backend.fail(.write, key: key, enabled: true)
        let auth = client(storage, key, requests)
        XCTAssertNil(auth.currentSession)
        XCTAssertTrue(storage.failures.contains { $0.operation == .store })
        XCTAssertNotNil(try storage.retrieve(key: legacy))
        backend.fail(.write, key: key, enabled: false)
        XCTAssertEqual(auth.currentSession?.accessToken, "synthetic-access")
        XCTAssertNotNil(try storage.retrieve(key: key))
        XCTAssertNil(try storage.retrieve(key: legacy))
        XCTAssertEqual(requests.requests, 0)
    }
    func testLegacyDeleteFailureCanResurrectSession() throws {
        let (backend, storage, key, requests) = makeStorage()
        try storage.store(key: legacy, value: sessionData())
        backend.fail(.delete, key: legacy, enabled: true)
        let auth = client(storage, key, requests)
        XCTAssertNotNil(auth.currentSession)
        XCTAssertTrue(storage.failures.contains { $0.operation == .remove })
        XCTAssertNotNil(try storage.retrieve(key: legacy))
        try storage.remove(key: key)
        backend.fail(.delete, key: legacy, enabled: false)
        XCTAssertNotNil(auth.currentSession) // Legacy migration restores the removed destination.
        XCTAssertNotNil(try storage.retrieve(key: key))
        XCTAssertNil(try storage.retrieve(key: legacy))
        XCTAssertEqual(requests.requests, 0)
    }

    func testPKCEVerifierUsesConfiguredKeyWithoutNetwork() throws {
        let (_, storage, key, requests) = makeStorage()
        let auth = AuthClient(url: URL(string: "https://example.invalid")!, flowType: .pkce,
                              storageKey: key, localStorage: storage,
                              fetch: { _ in try requests.reject() }, autoRefreshToken: false)
        _ = try auth.getOAuthSignInURL(provider: .google)
        XCTAssertNotNil(try storage.retrieve(key: "\(key)-code-verifier"))
        XCTAssertTrue(storage.failures.isEmpty)
        XCTAssertEqual(requests.requests, 0)
    }

    // This uses a synthetic writer and gate invalidation, not AuthClient sign-out
    // or an SDK session/verifier write or delete path.
    func testGatedSyntheticWriterIsDrainedAndAllKeysVerifiedOnRetry() async throws {
        let (backend, storage, key, _) = makeStorage()
        let verifier = "\(key)-code-verifier" // v2.55.5 CodeVerifierStorage configured-key rule.
        let data = try sessionData()
        let started = expectation(description: "writer entered")
        let cancelled = expectation(description: "writer cancellation requested")
        let latch = WriterLatch()
        var invalidationStarted = false
        let gate = AuthOperationGate {
            invalidationStarted = true
            storage.nextGeneration()
            for item in [key, self.legacy, verifier] { try storage.remove(key: item) }
            for item in [key, self.legacy, verifier] {
                guard try storage.retrieve(key: item) == nil else { throw URLError(.cannotRemoveFile) }
            }
        }
        try storage.store(key: legacy, value: data)
        try storage.store(key: verifier, value: Data("synthetic-verifier".utf8))
        let writerFinished = expectation(description: "writer finished")
        var writerResult: Result<Void, Error>?
        let writer = Task {
            do {
                try await gate.run {
                    await withTaskCancellationHandler {
                        await latch.wait(started: started)
                    } onCancel: { cancelled.fulfill() }
                    try storage.store(key: key, value: data) // Intentionally ignores cancellation.
                }
                writerResult = .success(())
            } catch { writerResult = .failure(error) }
            writerFinished.fulfill()
        }
        defer { latch.release(); writer.cancel() }
        await fulfillment(of: [started], timeout: 1)
        backend.fail(.delete, key: legacy, enabled: true)
        let logoutFinished = expectation(description: "local invalidation finished")
        var logoutResult: Result<Void, Error>?
        let logout = Task {
            do { try await gate.signOutLocally(); logoutResult = .success(()) }
            catch { logoutResult = .failure(error) }
            logoutFinished.fulfill()
        }
        defer { logout.cancel() }
        await fulfillment(of: [cancelled], timeout: 1)
        XCTAssertFalse(invalidationStarted)
        latch.release()
        await fulfillment(of: [logoutFinished, writerFinished], timeout: 1)
        guard let logoutResult, let writerResult else { return }
        switch logoutResult {
        case .success: XCTFail("expected failed local invalidation")
        case .failure(let error): XCTAssertEqual(error as? AuthOperationGate.Failure, .invalidationFailed)
        }
        try writerResult.get()

        let retryFinished = expectation(description: "closed admission and retry finished")
        let retry = Task {
            defer { retryFinished.fulfill() }
            do { try await gate.run {}; XCTFail("admission must remain closed") }
            catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .admissionClosed) }
            XCTAssertTrue(storage.failures.contains { $0.operation == .remove && $0.generation == 1 })
            backend.fail(.delete, key: legacy, enabled: false)
            do {
                try await gate.signOutLocally()
                for item in [key, legacy, verifier] { XCTAssertNil(try storage.retrieve(key: item)) }
                try await gate.run {}
            } catch { XCTFail("retry failed: \(error)") }
        }
        defer { retry.cancel() }
        await fulfillment(of: [retryFinished], timeout: 1)
    }
}
