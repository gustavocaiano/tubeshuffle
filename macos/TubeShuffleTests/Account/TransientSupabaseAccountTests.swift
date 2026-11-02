import Auth
import Foundation
import XCTest
@testable import TubeShuffle

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
