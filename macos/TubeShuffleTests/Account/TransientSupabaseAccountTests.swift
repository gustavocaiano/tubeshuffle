import Auth
import AppKit
import Foundation
import XCTest
@testable import TubeShuffle

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

    #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
    func testTemporaryDiagnosticEventsAreStageOnly() async throws {
        typealias Event = TransientSupabaseAccount.DiagnosticEvent
        func run(_ launch: @escaping @MainActor (URL, String) async throws -> URL) async throws -> [Event] {
            let transport = Transport()
            var events: [Event] = []
            var account: TransientSupabaseAccount? = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin,
                publishableKey: key, baseRedirect: redirect, launch: launch, closeBrowser: {},
                fetch: { try await transport.send($0) })
            weak var weakAccount = account
            var attempts: [UUID] = []
            account?.diagnosticSink = { attempt, event in attempts.append(attempt); events.append(event) }
            do { _ = try await account!.signIn(); XCTFail("expected rejection") } catch {}
            XCTAssertEqual(Set(attempts).count, 1)
            account = nil
            XCTAssertNil(weakAccount, "diagnostic exchange closure must not retain the account")
            return events
        }
        let browser = try await run { _, _ in throw TransientAuthBrowser.Failure.browserFailure }
        XCTAssertEqual(browser, [.browserFailed])
        let cancelled = try await run { _, _ in throw TransientAuthBrowser.Failure.cancelled }
        XCTAssertEqual(cancelled, [.browserCancelled])
        let missing = try await run { _, _ in throw TransientAuthBrowser.Failure.missingCallback }
        XCTAssertEqual(missing, [.browserMissingCallback])
        let malformed = try await run { _, _ in URL(string: "example-app://auth.example/callback?secret=sentinel")! }
        XCTAssertEqual(malformed, [.callbackReceived, .callbackRejected])
        let mismatch = try await run { url, _ in self.callback(url, correlation: "wrong-epoch") }
        XCTAssertEqual(mismatch, [.callbackReceived, .correlationRejected])
        let exchange = try await run { url, _ in self.callback(url) }
        XCTAssertEqual(exchange, [.callbackReceived, .exchangeStarted, .exchangeFailed])
        XCTAssertFalse(exchange.map(\.rawValue).joined().contains("sentinel"))
    }

    func testTemporaryDiagnosticAttemptsHaveIndependentLabels() async throws {
        let transport = Transport()
        let account = try TransientSupabaseAccount(authURL: endpoint, trustedProjectOrigin: origin,
            publishableKey: key, baseRedirect: redirect,
            launch: { _, _ in throw TransientAuthBrowser.Failure.browserFailure }, closeBrowser: {},
            fetch: { try await transport.send($0) })
        var attempts: [UUID] = []
        account.diagnosticSink = { attempt, _ in attempts.append(attempt) }
        for _ in 0..<2 {
            do { _ = try await account.signIn(); XCTFail("expected rejection") } catch {}
        }
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(Set(attempts).count, 2)
    }
    #endif

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
