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
// Count-based attribution is valid only with exclusive access: no unrelated SDK
// entry points or external writers may touch this instance during an operation.
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
    var onStore: (@Sendable (String, Data) -> Void)?
    init(_ inner: KeychainAuthLocalStorage) { self.inner = inner }
    func nextGeneration() { lock.lock(); defer { lock.unlock() }; currentGeneration += 1 }
    var failures: [Failure] { lock.lock(); defer { lock.unlock() }; return recorded }
    private func record(_ operation: Failure.Operation) {
        lock.lock(); defer { lock.unlock() }
        recorded.append(Failure(operation: operation, category: .storage, generation: currentGeneration))
    }
    func store(key: String, value: Data) throws {
        do { try inner.store(key: key, value: value); onStore?(key, value) } catch { record(.store); throw error }
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

// Test-only ownership boundary. This is not a cross-process or crash fence.
// v2.55.5 refresh creates an unstructured task, but its public refresh/session
// awaits that task through its synchronous storage update. Do not add SDK entry
// points without re-establishing that property; cancellation is not a deadline.
@MainActor
private final class OwnedSyntheticAuth {
    enum Failure: Error, Equatable { case operation, storage }
    // A normal SDK return is not proof of revocation: it can skip the request
    // without a session and treats certain HTTP errors as success.
    enum Remote: Equatable { case sdkReturned, sdkFailed }
    struct SignOutResult: Equatable { let remote: Remote }
    private let storage: RecordingStorage
    private let key: String
    private let client: AuthClient
    private final class State {
        var remote: Remote = .sdkFailed
    }
    private let state: State
    private let gate: AuthOperationGate
    private let cancelled: (@Sendable () -> Void)?
    var lastRemote: Remote { state.remote }

    init(storage: RecordingStorage, key: String,
         cancelled: (@Sendable () -> Void)? = nil,
         beforeCleanup: (@MainActor () -> Void)? = nil,
         fetch: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse)) {
        self.storage = storage
        self.key = key
        self.cancelled = cancelled
        let client = AuthClient(url: URL(string: "https://example.invalid")!, storageKey: key,
                                localStorage: storage, fetch: fetch, autoRefreshToken: false)
        self.client = client
        let state = State()
        self.state = state
        // The gate owns these dependencies, not the owner itself: no owner/gate cycle.
        gate = AuthOperationGate {
            beforeCleanup?()
            let before = storage.failures.count
            do { try await client.signOut(scope: .local); state.remote = .sdkReturned }
            catch { state.remote = .sdkFailed }
            var failed = storage.failures.count != before
            for item in [key, "supabase.session", "\(key)-code-verifier"] {
                do { try storage.remove(key: item) } catch { failed = true }
            }
            for item in [key, "supabase.session", "\(key)-code-verifier"] {
                do { if try storage.retrieve(key: item) != nil { failed = true } }
                catch { failed = true }
            }
            if failed { throw Failure.storage }
        }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) async throws {
        try await gate.run { [storage, cancelled] in
            try await withTaskCancellationHandler {
            let before = storage.failures.count
            var failed = false
            do { try await operation() } catch { failed = true }
            if storage.failures.count != before { throw Failure.storage }
            if failed { throw Failure.operation }
            } onCancel: { cancelled?() }
        }
    }
    func restore() async throws { try await perform { [client] in _ = try await client.session } }
    func refresh() async throws { try await perform { [client] in _ = try await client.refreshSession() } }
    func signOut() async throws -> SignOutResult {
        try await gate.signOutLocally()
        return SignOutResult(remote: state.remote)
    }
}

// The continuation deliberately ignores cancellation, as can a network transport.
private actor DelayedRefreshTransport {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    private let started: XCTestExpectation
    private let refresh = StubTransport(.refresh)
    private let logout = StubTransport(.logout, bearer: "synthetic-rotated-access")
    var logoutCounts: (Int, Int) { logout.counts }
    init(started: XCTestExpectation) { self.started = started }
    func fetch(_ request: URLRequest) async throws -> (Data, URLResponse) {
        if request.url?.path == "/token" {
            // Validate before blocking, and never fall through to a real network.
            let response = try refresh.fetch(request)
            await withCheckedContinuation { pending in
                if released { pending.resume() } else { continuation = pending }
                started.fulfill()
            }
            return response
        }
        return try logout.fetch(request)
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

// The transport accepts exactly one synthetic endpoint and never falls through to networking.
private final class StubTransport: @unchecked Sendable {
    enum Endpoint { case logout, refresh }
    private let lock = NSLock()
    private var accepted = 0
    private var rejected = 0
    private var validRefreshBody = false
    let endpoint: Endpoint
    private let bearer: String
    init(_ endpoint: Endpoint, bearer: String = "synthetic-access") { self.endpoint = endpoint; self.bearer = bearer }
    var counts: (Int, Int) { lock.lock(); defer { lock.unlock() }; return (accepted, rejected) }
    var sawExpectedRefreshBody: Bool { lock.lock(); defer { lock.unlock() }; return validRefreshBody }

    func fetch(_ request: URLRequest) throws -> (Data, URLResponse) {
        let components = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        let expectedPath = endpoint == .logout ? "/logout" : "/token"
        let expectedQuery = endpoint == .logout ? URLQueryItem(name: "scope", value: "local")
            : URLQueryItem(name: "grant_type", value: "refresh_token")
        let authorizationOK = endpoint != .logout || request.value(forHTTPHeaderField: "Authorization") == "Bearer \(bearer)"
        let refreshBodyOK: Bool
        if endpoint == .refresh, let body = request.httpBody,
           let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
            refreshBodyOK = json["refresh_token"] as? String == "synthetic-refresh"
        } else {
            refreshBodyOK = endpoint != .refresh
        }
        if endpoint == .refresh {
            lock.lock(); validRefreshBody = refreshBodyOK; lock.unlock()
        }
        guard let url = request.url, url.scheme == "https", url.host == "example.invalid",
              request.httpMethod == "POST", components?.path == expectedPath,
              components?.queryItems == [expectedQuery], authorizationOK, refreshBodyOK else {
            lock.lock(); rejected += 1; lock.unlock()
            throw URLError(.unsupportedURL)
        }
        lock.lock(); accepted += 1; lock.unlock()
        let body: Data
        if endpoint == .refresh {
            body = Data("""
            {"access_token":"synthetic-rotated-access","token_type":"bearer","expires_in":3600,
             "expires_at":4102444800,"refresh_token":"synthetic-rotated-refresh",
             "user":{"id":"00000000-0000-0000-0000-000000000001","aud":"synthetic",
             "app_metadata":{},"user_metadata":{},"created_at":"2020-01-01T00:00:00Z",
             "updated_at":"2020-01-01T00:00:00Z"}}
            """.utf8)
        } else { body = Data() }
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                      headerFields: ["Content-Type": "application/json"])!)
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

    // Timeout bounds the test's wait, not the lifetime of an SDK task that ignores cancellation.
    private func bounded(_ operation: @escaping @MainActor () async throws -> Void) async throws {
        let finished = expectation(description: "owned probe finished")
        var result: Result<Void, Error>?
        let task = Task { @MainActor in
            do { try await operation(); result = .success(()) }
            catch { result = .failure(error) }
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 5)
        guard let result else { task.cancel(); throw URLError(.timedOut) }
        try result.get()
    }

    func testOwnedRefreshDrainsBeforeCleanupAndRetry() async throws {
        try await bounded { [self] in
        let (backend, storage, key, _) = makeStorage()
        try storage.store(key: key, value: sessionData())
        try storage.store(key: "\(key)-code-verifier", value: Data("synthetic".utf8))
        try storage.store(key: legacy, value: sessionData())
        let started = expectation(description: "refresh reached synthetic transport")
        let cancelled = expectation(description: "gate requested refresh cancellation")
        let rotatedWritten = expectation(description: "rotated session persisted")
        var sawRotatedBeforeCleanup = false
        storage.onStore = { writtenKey, data in
            guard writtenKey == key, let session = try? JSONDecoder().decode(Session.self, from: data),
                  session.accessToken == "synthetic-rotated-access" else { return }
            rotatedWritten.fulfill()
        }
        let transport = DelayedRefreshTransport(started: started)
        let service = OwnedSyntheticAuth(storage: storage, key: key,
            cancelled: { cancelled.fulfill() }, beforeCleanup: {
                if let data = try? storage.retrieve(key: key),
                   let session = try? JSONDecoder().decode(Session.self, from: data) {
                    sawRotatedBeforeCleanup = session.accessToken == "synthetic-rotated-access"
                }
            }, fetch: { try await transport.fetch($0) })
        let refreshDone = expectation(description: "refresh completed")
        var refreshResult: Result<Void, Error>?
        let refresh = Task {
            defer { refreshDone.fulfill() }
            do { try await service.refresh(); refreshResult = .success(()) }
            catch { refreshResult = .failure(error) }
        }
        defer { refresh.cancel(); Task { await transport.release() } }
        await fulfillment(of: [started], timeout: 2)
        backend.fail(.delete, key: legacy, enabled: true)
        let finished = expectation(description: "signout completed")
        var outcome: Result<OwnedSyntheticAuth.SignOutResult, Error>?
        let logout = Task {
            do { outcome = .success(try await service.signOut()) }
            catch { outcome = .failure(error) }
            finished.fulfill()
        }
        defer { logout.cancel(); backend.fail(.delete, key: legacy, enabled: false) }
        await fulfillment(of: [cancelled], timeout: 2)
        do { try await service.restore(); XCTFail("admission must already be closed") }
        catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .admissionClosed) }
        XCTAssertNotNil(try storage.retrieve(key: key))
        await transport.release()
        await fulfillment(of: [rotatedWritten, refreshDone, finished], timeout: 2)
        XCTAssertTrue(sawRotatedBeforeCleanup)
        let logoutCounts = await transport.logoutCounts
        XCTAssertEqual(logoutCounts.0, 1)
        XCTAssertEqual(logoutCounts.1, 0)
        XCTAssertEqual(service.lastRemote, .sdkReturned)
        guard let refreshResult else { return XCTFail("refresh did not finish") }
        try refreshResult.get()
        guard let outcome else { return XCTFail("signout did not finish") }
        switch outcome {
        case .success: XCTFail("cleanup failure must be reported")
        case .failure(let error): XCTAssertEqual(error as? AuthOperationGate.Failure, .invalidationFailed)
        }
        do { try await service.restore(); XCTFail("admission must remain closed") }
        catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .admissionClosed) }
        backend.fail(.delete, key: legacy, enabled: false)
        _ = try await service.signOut()
        for item in [key, legacy, "\(key)-code-verifier"] {
            XCTAssertNil(try storage.retrieve(key: item))
        }
        }
    }

    func testOwnedServiceDetectsSwallowedSDKStorageFailure() async throws {
        try await bounded { [self] in
        let (backend, storage, key, _) = makeStorage()
        try storage.store(key: key, value: sessionData())
        let transport = StubTransport(.refresh)
        let service = OwnedSyntheticAuth(storage: storage, key: key, fetch: { try transport.fetch($0) })
        backend.fail(.write, key: key, enabled: true)
        defer { backend.fail(.write, key: key, enabled: false) }
        do { try await service.refresh(); XCTFail("swallowed write must fail") }
        catch { XCTAssertEqual(error as? OwnedSyntheticAuth.Failure, .storage) }
        XCTAssertEqual(transport.counts.0, 1)
        XCTAssertEqual(transport.counts.1, 0)
        }
    }

    func testOwnedServiceReportsRemoteFailureSeparatelyFromLocalCleanup() async throws {
        try await bounded { [self] in
        let (_, storage, key, requests) = makeStorage()
        try storage.store(key: key, value: sessionData())
        try storage.store(key: legacy, value: sessionData())
        try storage.store(key: "\(key)-code-verifier", value: Data("synthetic".utf8))
        let service = OwnedSyntheticAuth(storage: storage, key: key, fetch: { _ in try requests.reject() })
        let result = try await service.signOut()
        XCTAssertEqual(result.remote, .sdkFailed)
        XCTAssertEqual(requests.requests, 1)
        for item in [key, legacy, "\(key)-code-verifier"] {
            XCTAssertNil(try storage.retrieve(key: item))
        }
        }
    }

    func testOwnedCleanupReportsVerificationReadFailure() async throws {
        try await bounded { [self] in
            let (backend, storage, key, requests) = makeStorage()
            try storage.store(key: key, value: sessionData())
            let service = OwnedSyntheticAuth(storage: storage, key: key, fetch: { _ in try requests.reject() })
            // The legacy key is read during verification, after all removals.
            backend.fail(.read, key: legacy, enabled: true)
            defer { backend.fail(.read, key: legacy, enabled: false) }
            do { _ = try await service.signOut(); XCTFail("verification failure must close admission") }
            catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .invalidationFailed) }
            XCTAssertTrue(storage.failures.contains { $0.operation == .retrieve })
            do { try await service.restore(); XCTFail("admission must remain closed") }
            catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .admissionClosed) }
            backend.fail(.read, key: legacy, enabled: false)
            _ = try await service.signOut()
            XCTAssertNil(try storage.retrieve(key: legacy))
        }
    }

    func testOwnedReportsRemoteAndCleanupFailureTogether() async throws {
        try await bounded { [self] in
            let (backend, storage, key, requests) = makeStorage()
            try storage.store(key: key, value: sessionData())
            try storage.store(key: legacy, value: sessionData())
            let service = OwnedSyntheticAuth(storage: storage, key: key, fetch: { _ in try requests.reject() })
            backend.fail(.delete, key: legacy, enabled: true)
            defer { backend.fail(.delete, key: legacy, enabled: false) }
            do { _ = try await service.signOut(); XCTFail("cleanup failure must be reported") }
            catch { XCTAssertEqual(error as? AuthOperationGate.Failure, .invalidationFailed) }
            XCTAssertEqual(service.lastRemote, .sdkFailed)
            XCTAssertEqual(requests.requests, 1)
            XCTAssertNotNil(try storage.retrieve(key: legacy))
            backend.fail(.delete, key: legacy, enabled: false)
            _ = try await service.signOut()
            XCTAssertNil(try storage.retrieve(key: legacy))
        }
    }
    // Recorder generations are temporal markers, not operation-scoped attribution.
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

    func testSDKLocalSignOutRecordsSwallowedRemoveFailureAndControl() async throws {
        for fails in [true, false] {
            let finished = expectation(description: "synthetic sign-out finished")
            var result: Result<Void, Error>?
            let task = Task { @MainActor in
              defer { finished.fulfill() }
              do {
            let (backend, storage, key, _) = self.makeStorage()
            let verifier = "\(key)-code-verifier"
            let original = try self.sessionData()
            try storage.store(key: key, value: original)
            try storage.store(key: verifier, value: Data("synthetic-verifier".utf8))
            let transport = StubTransport(.logout)
            let auth = AuthClient(url: URL(string: "https://example.invalid")!, storageKey: key,
                                  localStorage: storage, fetch: { try transport.fetch($0) }, autoRefreshToken: false)
            storage.nextGeneration()
            backend.fail(.delete, key: key, enabled: fails)
            defer {
                backend.fail(.delete, key: key, enabled: false)
                for item in [key, self.legacy, verifier] { try? storage.remove(key: item) }
            }
            try await auth.signOut(scope: .local)
            XCTAssertEqual(transport.counts.0, 1)
            XCTAssertEqual(transport.counts.1, 0)
            XCTAssertEqual(storage.failures.contains { $0.operation == .remove && $0.generation == 1 }, fails)
            if fails {
                XCTAssertTrue(try storage.retrieve(key: key) == original)
            } else {
                XCTAssertNil(try storage.retrieve(key: key))
            }
            // Observe the SDK result before our cleanup without assuming verifier policy.
            let verifierAfterSignOut = try storage.retrieve(key: verifier)
            XCTAssertTrue(verifierAfterSignOut == nil || verifierAfterSignOut == Data("synthetic-verifier".utf8))
            backend.fail(.delete, key: key, enabled: false)
            for item in [key, self.legacy, verifier] { try storage.remove(key: item) }
            for item in [key, self.legacy, verifier] { XCTAssertNil(try storage.retrieve(key: item)) }
              result = .success(())
              } catch { result = .failure(error) }
            }
            await fulfillment(of: [finished], timeout: 2)
            guard let result else { task.cancel(); return }
            try result.get()
        }
    }

    func testSDKRefreshRecordsSwallowedStoreFailureAndControl() async throws {
        for fails in [true, false] {
            let finished = expectation(description: "synthetic refresh finished")
            var result: Result<Void, Error>?
            let task = Task { @MainActor in
              defer { finished.fulfill() }
              do {
            let (backend, storage, key, _) = self.makeStorage()
            let original = try self.sessionData()
            try storage.store(key: key, value: original)
            let transport = StubTransport(.refresh)
            let auth = AuthClient(url: URL(string: "https://example.invalid")!, storageKey: key,
                                  localStorage: storage, fetch: { try transport.fetch($0) }, autoRefreshToken: false)
            storage.nextGeneration()
            backend.fail(.write, key: key, enabled: fails)
            defer {
                backend.fail(.write, key: key, enabled: false)
                for item in [key, self.legacy, "\(key)-code-verifier"] { try? storage.remove(key: item) }
            }
            let rotated = try await auth.refreshSession()
            XCTAssertTrue(rotated.accessToken == "synthetic-rotated-access")
            XCTAssertTrue(rotated.refreshToken == "synthetic-rotated-refresh")
            XCTAssertEqual(transport.counts.0, 1)
            XCTAssertEqual(transport.counts.1, 0)
            XCTAssertEqual(storage.failures.contains { $0.operation == .store && $0.generation == 1 }, fails)
            XCTAssertTrue(transport.sawExpectedRefreshBody)
            if fails {
                XCTAssertTrue(try storage.retrieve(key: key) == original)
                XCTAssertTrue(auth.currentSession?.accessToken == "synthetic-access")
            } else {
                XCTAssertTrue(auth.currentSession?.accessToken == "synthetic-rotated-access")
                let persisted = try XCTUnwrap(storage.retrieve(key: key))
                let decoded = try JSONDecoder().decode(Session.self, from: persisted)
                XCTAssertTrue(decoded.accessToken == "synthetic-rotated-access")
                XCTAssertTrue(decoded.refreshToken == "synthetic-rotated-refresh")
            }
              result = .success(())
              } catch { result = .failure(error) }
            }
            await fulfillment(of: [finished], timeout: 2)
            guard let result else { task.cancel(); return }
            try result.get()
        }
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
            backend.fail(.delete, key: self.legacy, enabled: false)
            do {
                try await gate.signOutLocally()
                for item in [key, self.legacy, verifier] { XCTAssertNil(try storage.retrieve(key: item)) }
                try await gate.run {}
            } catch { XCTFail("retry failed: \(error)") }
        }
        defer { retry.cancel() }
        await fulfillment(of: [retryFinished], timeout: 1)
    }
}
