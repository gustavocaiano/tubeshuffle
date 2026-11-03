import Auth
import AppKit
import Foundation
import XCTest
@testable import TubeShuffle

// TEMPORARY: keep the watchdog outcome safe to read across concurrent tasks.
private final class OversizeWatchdogState: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func recordFired() { lock.lock(); fired = true; lock.unlock() }
    func didFire() -> Bool { lock.lock(); defer { lock.unlock() }; return fired }
}

private final class SyntheticOAuthProtocol: URLProtocol {
    typealias Handler = (SyntheticOAuthProtocol) -> Void
    private static let lock = NSLock()
    private static var handlers: [String: Handler] = [:]
    private static var stops: [String: () -> Void] = [:]

    static func configure(_ id: String, handler: @escaping Handler, stopped: (() -> Void)? = nil) {
        lock.lock(); defer { lock.unlock() }
        handlers[id] = handler
        stops[id] = stopped
    }
    static func remove(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        handlers.removeValue(forKey: id)
        stops.removeValue(forKey: id)
    }
    override class func canInit(with request: URLRequest) -> Bool {
        guard let host = request.url?.host else { return false }
        lock.lock(); defer { lock.unlock() }
        return handlers[host] != nil
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url!.host!]; Self.lock.unlock()
        handler?(self)
    }
    override func stopLoading() {
        Self.lock.lock(); let stopped = Self.stops[request.url!.host!]; Self.lock.unlock()
        stopped?()
    }
    func respond(status: Int = 200, headers: [String: String] = [:], chunks: [Data] = []) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class TransientOAuthTransportTests: XCTestCase {
    private let id = UUID().uuidString.lowercased() + ".invalid"
    private var request: URLRequest { URLRequest(url: URL(string: "https://\(id)/token?code=code-sentinel")!) }

    override func tearDown() {
        SyntheticOAuthProtocol.remove(id)
        super.tearDown()
    }
    private func configure(_ handler: @escaping SyntheticOAuthProtocol.Handler, stopped: (() -> Void)? = nil) {
        SyntheticOAuthProtocol.configure(id, handler: handler, stopped: stopped)
    }
    private func fetch() async throws -> (Data, URLResponse) {
        try await TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self]).fetch(request)
    }
    func testSuccessAndExactBound() async throws {
        for size in [12, TransientOAuthTransport.responseLimit] {
            let bytes = Data(repeating: 42, count: size)
            configure { $0.respond(headers: ["Content-Length": "\(size)"], chunks: [bytes]) }
            let (body, response) = try await fetch()
            XCTAssertEqual(body, bytes)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
    }
    func testDeliveredOverBoundWithMisleadingLengthFailsClosed() async {
        let limit = TransientOAuthTransport.responseLimit
        // Direct delegate injection proves the byte accounting even if an HTTP
        // stack would truncate a mismatched wire Content-Length. It does not
        // test actual decompression or Foundation's internal buffering.
        for headers in [[:], ["Content-Length": "1"]] {
            let started = expectation(description: "request started")
            let stopped = expectation(description: "over-limit request stopped")
            configure({ _ in started.fulfill() }, stopped: { stopped.fulfill() })
            let transport = TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self])
            let operation = Task { try await transport.fetch(request) }
            await fulfillment(of: [started], timeout: 1)
            let session = URLSession(configuration: .ephemeral)
            let dummy = session.dataTask(with: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!
            transport.urlSession(session, dataTask: dummy, didReceive: response) { _ in }
            transport.urlSession(session, dataTask: dummy, didReceive: Data(repeating: 1, count: limit))
            transport.urlSession(session, dataTask: dummy, didReceive: Data([2]))
            do { _ = try await operation.value; XCTFail("oversized response accepted") }
            catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .responseTooLarge) }
            await fulfillment(of: [stopped], timeout: 1)
            session.invalidateAndCancel()
        }
    }
    func testBoundedNonSuccessResponseIsReturned() async throws {
        let data = Data("synthetic error".utf8)
        configure { $0.respond(status: 400, chunks: [data]) }
        let (body, response) = try await fetch()
        XCTAssertEqual(body, data)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 400)
    }
    func testRedirectStatusRejectedWithoutFollowing() async {
        let requests = expectation(description: "only initial request")
        requests.assertForOverFulfill = true
        configure { protocolInstance in
            requests.fulfill()
            protocolInstance.respond(status: 302, headers: ["Location": "/secret"])
        }
        do { _ = try await fetch(); XCTFail("redirect accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .redirect) }
        await fulfillment(of: [requests], timeout: 1)
    }
    func testURLProtocolRedirectNotificationRejected() async {
        // This confirms the synthetic protocol emitted a redirect notification,
        // not that Foundation invoked the transport's redirect delegate callback.
        let redirected = expectation(description: "protocol emitted redirect notification")
        let initial = expectation(description: "only initial request")
        initial.assertForOverFulfill = true
        configure { instance in
            initial.fulfill()
            let destination = URLRequest(url: instance.request.url!.deletingLastPathComponent().appendingPathComponent("secret"))
            let response = HTTPURLResponse(url: instance.request.url!, statusCode: 302, httpVersion: nil,
                                           headerFields: ["Location": destination.url!.absoluteString])!
            instance.client?.urlProtocol(instance, wasRedirectedTo: destination, redirectResponse: response)
            redirected.fulfill()
        }
        do { _ = try await fetch(); XCTFail("redirect accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .redirect) }
        await fulfillment(of: [redirected, initial], timeout: 1)
    }
    func testRedirectDelegateRejectsProposedRequest() async {
        let started = expectation(description: "initial request started")
        let stopped = expectation(description: "initial request stopped")
        let redirectedRequest = expectation(description: "no redirected request")
        redirectedRequest.isInverted = true
        configure({ instance in
            if instance.request.url?.path == "/secret" { redirectedRequest.fulfill() }
            else { started.fulfill() }
        }, stopped: { stopped.fulfill() })
        let transport = TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self])
        let operation = Task { try await transport.fetch(request) }
        await fulfillment(of: [started], timeout: 1)

        // Direct invocation tests the delegate decision, not Foundation's
        // redirect delivery or real HTTP redirect integration.
        let session = URLSession(configuration: .ephemeral)
        let dummy = session.dataTask(with: request)
        let destination = URLRequest(url: request.url!.deletingLastPathComponent().appendingPathComponent("secret"))
        let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil,
                                       headerFields: ["Location": destination.url!.absoluteString])!
        var completionCount = 0
        transport.urlSession(session, task: dummy, willPerformHTTPRedirection: response, newRequest: destination) { proposedRequest in
            completionCount += 1
            XCTAssertNil(proposedRequest, "the redirect must not be followed")
        }
        XCTAssertEqual(completionCount, 1)
        do { _ = try await operation.value; XCTFail("redirect accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .redirect) }
        await fulfillment(of: [stopped], timeout: 1)
        // This bounded observation only covers the synthetic protocol, not HTTP integration.
        await fulfillment(of: [redirectedRequest], timeout: 0.1)
        session.invalidateAndCancel()
    }
    func testCancellationStopsPendingRequest() async {
        let started = expectation(description: "request started")
        let stopped = expectation(description: "request stopped")
        configure({ _ in started.fulfill() }, stopped: { stopped.fulfill() })
        let task = Task { try await fetch() }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        do { _ = try await task.value; XCTFail("cancellation ignored") }
        catch { XCTAssertTrue(error is CancellationError) }
        await fulfillment(of: [stopped], timeout: 1)
    }
    func testEarlyOversizeCancelsUnderlyingTask() async {
        let stopped = expectation(description: "oversized request stopped")
        configure({ instance in
            print("[DEBUG-oauth-oversize] protocol_start")
            let response = HTTPURLResponse(url: instance.request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Length": "\(TransientOAuthTransport.responseLimit + 1)"])!
            print(instance.client == nil ? "[DEBUG-oauth-oversize] protocol_client_missing" : "[DEBUG-oauth-oversize] protocol_response_sending")
            instance.client?.urlProtocol(instance, didReceive: response, cacheStoragePolicy: .notAllowed)
            print("[DEBUG-oauth-oversize] protocol_response_returned")
        }, stopped: {
            print("[DEBUG-oauth-oversize] protocol_stop")
            stopped.fulfill()
        })
        let transport = TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self], oversizeProbe: {
            print("[DEBUG-oauth-oversize] \($0)")
        })
        let operation = Task { try await transport.fetch(request) }
        let watchdogState = OversizeWatchdogState()
        // TEMPORARY: attempt cancellation after five seconds; this does not bound the process.
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            watchdogState.recordFired()
            print("[DEBUG-oauth-oversize] watchdog_timeout_cancel")
            operation.cancel()
        }
        do { _ = try await operation.value; XCTFail("oversized response accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .responseTooLarge) }
        watchdog.cancel()
        await watchdog.value
        XCTAssertFalse(watchdogState.didFire(), "watchdog fired before the synthetic operation completed")
        await fulfillment(of: [stopped], timeout: 1)
    }
    func testReuseAndConcurrentInvocationAreRejected() async throws {
        let started = expectation(description: "first request started")
        configure { _ in started.fulfill() }
        let transport = TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self])
        let first = Task { try await transport.fetch(request) }
        await fulfillment(of: [started], timeout: 1)
        do { _ = try await transport.fetch(request); XCTFail("concurrent use accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .alreadyUsed) }
        first.cancel()
        do { _ = try await first.value; XCTFail("cancellation ignored") } catch { XCTAssertTrue(error is CancellationError) }
        do { _ = try await transport.fetch(request); XCTFail("reuse accepted") }
        catch { XCTAssertEqual(error as? TransientOAuthTransport.Failure, .alreadyUsed) }
    }
    func testCompletionBeforeCancellationRemainsSuccessful() async throws {
        configure { $0.respond(chunks: [Data([1])]) }
        let task = Task { try await fetch() }
        let (body, _) = try await task.value
        task.cancel()
        XCTAssertEqual(body, Data([1]))
    }
    func testCancellationRacingCompletionSelectsOneTerminalResult() async {
        // Invoke delegate callbacks directly to race terminal selection without
        // sending URLProtocol callbacks after stopLoading (which is invalid).
        for _ in 0..<20 {
            let started = expectation(description: "request started")
            configure { _ in started.fulfill() }
            let transport = TransientOAuthTransport(protocolClasses: [SyntheticOAuthProtocol.self])
            let operation = Task { try await transport.fetch(request) }
            await fulfillment(of: [started], timeout: 1)
            let session = URLSession(configuration: .ephemeral)
            let dummy = session.dataTask(with: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            transport.urlSession(session, dataTask: dummy, didReceive: response) { _ in }
            DispatchQueue.global().async { operation.cancel() }
            transport.urlSession(session, task: dummy, didCompleteWithError: nil)
            do {
                let (_, result) = try await operation.value
                XCTAssertEqual((result as? HTTPURLResponse)?.statusCode, 200)
            } catch { XCTAssertTrue(error is CancellationError) }
            session.invalidateAndCancel()
        }
    }
    func testErrorsDoNotExposeSensitiveRequestOrResponse() async {
        configure { $0.respond(status: 302, headers: ["Location": "/token-sentinel"]) }
        do { _ = try await fetch(); XCTFail("redirect accepted") }
        catch {
            let description = String(reflecting: error)
            XCTAssertFalse(description.contains("code-sentinel"))
            XCTAssertFalse(description.contains("token-sentinel"))
            XCTAssertFalse(description.contains("secret.invalid"))
        }
    }
}

#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
final class LocalOAuthDiagnosticConfigurationTests: XCTestCase {
    func testPrivateRuntimeFileFailsClosed() throws {
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? manager.removeItem(at: directory) }
        let file = directory.appendingPathComponent("key")
        let synthetic = "sb_publishable_abcdefghijklmnopqrstuv_12345678"
        func write(_ value: String, mode: Int = 0o600) throws {
            try Data(value.utf8).write(to: file)
            try manager.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
        }
        XCTAssertThrowsError(try LocalOAuthDiagnosticConfiguration.readKey(path: file.path))
        try write(synthetic + "\n")
        XCTAssertEqual(try LocalOAuthDiagnosticConfiguration.readKey(path: file.path), synthetic)
        try write(synthetic, mode: 0o644)
        XCTAssertThrowsError(try LocalOAuthDiagnosticConfiguration.readKey(path: file.path))
        for invalid in ["sb_" + "secret_abcdefghijklmnopqrstuv_12345678", "eyJhbGciOiJIUzI1NiJ9.service_role.signature",
                        "sb_publishable_short", synthetic + "\n\n", synthetic + " ", String(repeating: "x", count: 257)] {
            try write(invalid)
            XCTAssertThrowsError(try LocalOAuthDiagnosticConfiguration.readKey(path: file.path))
        }
        try write(synthetic)
        let link = directory.appendingPathComponent("link")
        try manager.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try LocalOAuthDiagnosticConfiguration.readKey(path: link.path))
    }

    func testPinnedDestination() {
        let origin = LocalOAuthDiagnosticConfiguration.origin
        XCTAssertEqual(origin.absoluteString, "https://rkgbxjwmnlsmguhctguf.supabase.co")
        XCTAssertTrue(TransientSupabaseAccount.validEndpoint(origin.appendingPathComponent("auth/v1"), trustedOrigin: origin))
        XCTAssertFalse(TransientSupabaseAccount.validEndpoint(URL(string: "https://evil.example/auth/v1")!, trustedOrigin: origin))
    }
}

#endif

final class CallbackRegistrationTests: XCTestCase {
    func testHostAppDeclaresCallbackScheme() throws {
        let scheme = "com.tubeshuffle.playbacklab"
        let types = try XCTUnwrap(Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]])
        XCTAssertTrue(types.contains { ($0["CFBundleURLSchemes"] as? [String])?.contains(scheme) == true })
        XCTAssertEqual(Bundle.main.bundleIdentifier, scheme)
    }
}

@MainActor
final class AccountViewModelTests: XCTestCase {
    private final class FakeAccount: TemporaryAccountService {
        var continuation: CheckedContinuation<Date, Error>?
        var localSignOuts = 0
        var cancellations = 0
        var started: XCTestExpectation?
        func signInExpiry() async throws -> Date {
            try await withCheckedThrowingContinuation {
                continuation = $0
                started?.fulfill()
            }
        }
        func cancel() { cancellations += 1 }
        func signOutLocally() { localSignOuts += 1 }
        func complete(_ expiry: Date) {
            let pending = continuation
            continuation = nil
            pending?.resume(returning: expiry)
        }
    }

    func testUnavailableByDefault() {
        let model = AccountViewModel()
        XCTAssertEqual(model.state, .unavailable)
        model.signIn()
        XCTAssertEqual(model.state, .unavailable)
    }

    func testCancelledLateCompletionCannotRestoreSession() async {
        let fake = FakeAccount()
        fake.started = expectation(description: "sign-in started")
        let model = AccountViewModel(factory: { _ in fake })
        let window = NSWindow()
        model.attach(window: window)
        model.signIn()
        XCTAssertEqual(model.state, .signingIn)
        let operation = model.operation
        await fulfillment(of: [fake.started!], timeout: 1)
        model.cancel()
        fake.complete(Date().addingTimeInterval(3600))
        await operation?.value
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertEqual(fake.localSignOuts, 1)
        XCTAssertEqual(fake.cancellations, 1)
        withExtendedLifetime(window) {}
    }

    func testExpiredCompletionSignsOutLocally() async {
        let fake = FakeAccount()
        fake.started = expectation(description: "sign-in started")
        let model = AccountViewModel(factory: { _ in fake })
        let window = NSWindow()
        model.attach(window: window)
        model.signIn()
        let operation = model.operation
        await fulfillment(of: [fake.started!], timeout: 1)
        fake.complete(Date().addingTimeInterval(-1))
        await operation?.value
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertEqual(fake.localSignOuts, 1)
        withExtendedLifetime(window) {}
    }

    func testWindowCloseCancelsAndStaleCompletionCannotAffectRetry() async {
        let first = FakeAccount(), second = FakeAccount()
        first.started = expectation(description: "first started")
        second.started = expectation(description: "retry started")
        var count = 0
        let model = AccountViewModel(factory: { _ in
            count += 1
            return count == 1 ? first : second
        })
        let window = NSWindow(), replacement = NSWindow()
        model.attach(window: window)
        model.signIn()
        let oldOperation = model.operation
        await fulfillment(of: [first.started!], timeout: 1)
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: window)
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertEqual(first.cancellations, 1)
        XCTAssertEqual(first.localSignOuts, 1)

        model.attach(window: replacement)
        model.signIn()
        let newOperation = model.operation
        await fulfillment(of: [second.started!], timeout: 1)
        first.complete(Date().addingTimeInterval(3600))
        await oldOperation?.value
        XCTAssertEqual(model.state, .signingIn)
        second.complete(Date().addingTimeInterval(3600))
        await newOperation?.value
        XCTAssertEqual(model.state, .signedIn)
        model.signOut()
    }

    func testRepeatedAttachAndUnrelatedWindowCloseDoNotCancel() async {
        let fake = FakeAccount()
        fake.started = expectation(description: "started")
        let model = AccountViewModel(factory: { _ in fake })
        let window = NSWindow(), other = NSWindow()
        model.attach(window: window)
        model.signIn()
        let operation = model.operation
        await fulfillment(of: [fake.started!], timeout: 1)
        model.attach(window: window)
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: other)
        XCTAssertEqual(model.state, .signingIn)
        XCTAssertEqual(fake.cancellations, 0)
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: window)
        fake.complete(Date().addingTimeInterval(3600))
        await operation?.value
        XCTAssertEqual(model.state, .signedOut)
    }

    func testRemovedTrackingViewDoesNotEndSessionButWindowCloseDoes() async {
        let fake = FakeAccount()
        fake.started = expectation(description: "started")
        let model = AccountViewModel(factory: { _ in fake })
        let window = NSWindow()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        window.contentView = container
        let view = WindowTrackingView()
        view.attached = { [weak model] in model?.attach(window: $0) }
        container.addSubview(view)
        model.signIn()
        let operation = model.operation
        await fulfillment(of: [fake.started!], timeout: 1)
        view.removeFromSuperview()
        XCTAssertEqual(model.state, .signingIn)
        XCTAssertEqual(fake.cancellations, 0)
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: window)
        XCTAssertEqual(fake.cancellations, 1)
        fake.complete(Date().addingTimeInterval(3600))
        await operation?.value
        XCTAssertEqual(model.state, .signedOut)
    }
}

@MainActor
final class TransientSupabaseAccountTests: XCTestCase {
    private let redirect = URL(string: "example-app://auth.example/callback")!
    private let endpoint = URL(string: "https://auth.example/auth/v1")!
    private let origin = URL(string: "https://auth.example")!
    private let key = "sb_publishable_synthetic_test"

    private actor Transport {
        var requests: [URLRequest] = []
        var continuation: CheckedContinuation<Void, Never>?
        var arrival: CheckedContinuation<Void, Never>?
        var delayed = false
        var networkFailure = false
        func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            arrival?.resume(); arrival = nil
            if networkFailure { throw URLError(.timedOut) }
            if delayed { await withCheckedContinuation { continuation = $0 } }
            let body = delayed ? Data("""
                {"access_token":"token-sentinel","token_type":"bearer","expires_in":3600,
                 "expires_at":4102444800,"refresh_token":"refresh-sentinel",
                 "user":{"id":"00000000-0000-0000-0000-000000000001","aud":"authenticated",
                 "created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}}
                """.utf8) : Data()
            return (body, HTTPURLResponse(url: request.url!, statusCode: delayed ? 200 : 503, httpVersion: nil, headerFields: nil)!)
        }
        func enableDelay() { delayed = true }
        func enableNetworkFailure() { networkFailure = true }
        func release() { continuation?.resume(); continuation = nil }
        func count() -> Int { requests.count }
        func waitForRequest() async {
            if !requests.isEmpty { return }
            await withCheckedContinuation { arrival = $0 }
        }
    }

    private func callback(_ authorization: URL, correlation: String? = nil) -> URL {
        let items = URLComponents(url: authorization, resolvingAgainstBaseURL: false)!.queryItems!
        let target = items.first { $0.name == "redirect_to" }!.value!
        var parts = URLComponents(string: target)!
        if let correlation { parts.queryItems = [URLQueryItem(name: "flow_correlation", value: correlation)] }
        parts.queryItems!.append(URLQueryItem(name: "code", value: "code-sentinel"))
        return parts.url!
    }

    func testMismatchedCorrelationNeverExchanges() async throws {
        let transport = Transport()
        let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin, publishableKey: key, baseRedirect: redirect,
            launch: { url, _ in self.callback(url, correlation: "wrong-epoch") }, closeBrowser: {},
            fetch: { try await transport.send($0) })
        do { _ = try await account.signIn(); XCTFail("expected rejection") } catch {}
        let count = await transport.count()
        XCTAssertEqual(count, 0)
        XCTAssertNil(account.session)
    }

    func testEmptyFragmentStillRequiresMatchingCorrelationBeforeExchange() async throws {
        for mismatch in [false, true] {
            let transport = Transport()
            let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin,
                publishableKey: key, baseRedirect: redirect, launch: { url, _ in
                    let callback = self.callback(url, correlation: mismatch ? "wrong-epoch" : nil)
                    let withEmptyFragment = URL(string: callback.absoluteString + "#")!
                    XCTAssertTrue(withEmptyFragment.absoluteString.hasSuffix("#"))
                    XCTAssertEqual(withEmptyFragment.absoluteString.filter { $0 == "#" }.count, 1)
                    return withEmptyFragment
                }, closeBrowser: {}, fetch: { try await transport.send($0) })
            do { _ = try await account.signIn(); XCTFail("synthetic transport must fail") } catch {}
            let count = await transport.count()
            XCTAssertEqual(count, mismatch ? 0 : 1)
            XCTAssertNil(account.session)
        }
    }

    func testPKCEPostFailureIsNotRetriedAndLogoutIsLocal() async throws {
        let transport = Transport()
        let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin, publishableKey: key, baseRedirect: redirect,
            launch: { url, _ in self.callback(url) }, closeBrowser: {}, fetch: { try await transport.send($0) })
        do { _ = try await account.signIn(); XCTFail("expected rejection") } catch {
            XCTAssertFalse(String(reflecting: error).contains("code-sentinel"))
        }
        account.logout()
        let count = await transport.count()
        XCTAssertEqual(count, 1)
        XCTAssertNil(account.session)
    }

    func testDuplicateCorrelationRejected() throws {
        let validator = try TransientOAuthCallback(redirect: redirect.absoluteString, correlationKey: "flow_correlation")
        XCTAssertThrowsError(try validator.correlation(from: redirect.absoluteString + "?flow_correlation=a&flow_correlation=b&code=x"))
        XCTAssertThrowsError(try validator.correlation(from: redirect.absoluteString + "?code=x"))
    }

    func testLateExchangeAfterCancelCannotPublishAndAdmissionDrains() async throws {
        let transport = Transport()
        await transport.enableDelay()
        let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin, publishableKey: key, baseRedirect: redirect,
            launch: { url, _ in self.callback(url) }, closeBrowser: {}, fetch: { try await transport.send($0) })
        let task = Task { try await account.signIn() }
        await transport.waitForRequest()
        account.cancel()
        do { _ = try await account.signIn(); XCTFail("draining must reject") } catch {}
        await transport.release()
        do { _ = try await task.value; XCTFail("late success must be discarded") } catch {
            XCTAssertFalse(String(reflecting: error).contains("token-sentinel"))
        }
        XCTAssertNil(account.session)
        account.logout()
        let count = await transport.count()
        XCTAssertEqual(count, 1)
    }

    func testConfigurationRejectsUntrustedAndNoncanonicalURLsAndKeys() throws {
        let invalidEndpoints = [
            "http://auth.example/auth/v1", "https://evil.example/auth/v1",
            "https://auth.example.evil.example/auth/v1", "https://user@auth.example/auth/v1",
            "https://user:password@auth.example/auth/v1", "https://auth.example/auth/v1?x=y",
            "https://auth.example/auth/v1#fragment", "https://auth.example/auth/v1/",
            "https://auth.example/auth/v1/../v1", "https://auth.example/auth%2Fv1",
            "https://auth.example:443/auth/v1", "https://auth.example/other"
        ]
        func make(_ endpoint: URL, _ origin: URL, _ key: String) throws -> TransientSupabaseAccount {
            try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin,
                publishableKey: key, baseRedirect: redirect,
                launch: { _, _ in throw CancellationError() }, closeBrowser: {},
                fetch: { _ in throw CancellationError() })
        }
        for value in invalidEndpoints {
            guard let url = URL(string: value) else { continue }
            XCTAssertThrowsError(try make(url, origin, key), "invalid endpoint accepted")
        }
        for value in ["http://auth.example", "https://user@auth.example", "https://auth.example/",
                      "https://auth.example?x=y", "https://auth.example#f", "https://auth.example:443",
                      "https://AUTH.example"] {
            guard let url = URL(string: value) else { continue }
            XCTAssertThrowsError(try make(endpoint, url, key), "invalid origin accepted")
        }
        for invalidKey in ["", "sb_publishable_", "sb_secret_secret", "eyJhbGciOiJIUzI1NiJ9.service_role.signature",
                           "sb_publishable_a\nInjected: x", "sb_publishable_a\rb", "sb_publishable_a b"] {
            XCTAssertThrowsError(try make(endpoint, origin, invalidKey)) { error in
                XCTAssertFalse(String(reflecting: error).contains(invalidKey) && !invalidKey.isEmpty)
            }
        }
        XCTAssertNoThrow(try make(endpoint, origin, key))
    }

    func testNetworkFailureIsNotRetried() async throws {
        let transport = Transport()
        await transport.enableNetworkFailure()
        let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin,
            publishableKey: key, baseRedirect: redirect, launch: { url, _ in self.callback(url) },
            closeBrowser: {}, fetch: { try await transport.send($0) })
        do { _ = try await account.signIn(); XCTFail("expected rejection") } catch {}
        let count = await transport.count()
        XCTAssertEqual(count, 1)
        XCTAssertNil(account.session)
    }
}
