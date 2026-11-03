#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
import Foundation
import AppKit
import XCTest
@testable import TubeShuffle

private final class OfflineDiagnosticURLProtocol: URLProtocol {
    static var body = Data()
    static var holdOpen = false
    static var started: XCTestExpectation?
    static var stopped: XCTestExpectation?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.started?.fulfill()
        if Self.holdOpen { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { Self.stopped?.fulfill() }
}

@MainActor
final class TwoAccountReadOnlyDiagnosticTests: XCTestCase {
    private let key = "sb_publishable_abcdefghijklmnopqrstuv_12345678"
    private let owner = "owner.synthetic.token"
    private let second = "second.synthetic.token"

    private final class FakeAccount: DiagnosticAccount {
        var pending: CheckedContinuation<(String, Date), Error>?
        var started: XCTestExpectation?
        var revocations = 0
        func signInCredential() async throws -> (String, Date) {
            try await withCheckedThrowingContinuation { pending = $0; started?.fulfill() }
        }
        func revoke() { revocations += 1 }
        func finish(_ token: String, expiry: Date = Date().addingTimeInterval(3600)) {
            pending?.resume(returning: (token, expiry)); pending = nil
        }
    }

    func testSequentialFlowAndLocalCleanup() async {
        let first = FakeAccount(), secondAccount = FakeAccount()
        first.started = expectation(description: "owner starts")
        secondAccount.started = expectation(description: "second starts")
        let stub = Stub(); stub.bodies = fixture()
        var calls = 0
        let model = TwoAccountDiagnosticModel(factory: { _, _ in
            calls += 1; return calls == 1 ? first : secondAccount
        }, readKey: { self.key }, diagnostic: TwoAccountReadOnlyDiagnostic(transport: stub))
        let window = NSWindow(); model.attach(window: window)
        model.startSecond(); XCTAssertEqual(calls, 0)
        model.startOwner()
        await fulfillment(of: [first.started!], timeout: 1)
        model.startSecond(); XCTAssertEqual(calls, 1)
        let firstOperation = model.operation
        first.finish(owner); await firstOperation?.value
        XCTAssertEqual(model.state, .secondReady)
        model.startSecond()
        await fulfillment(of: [secondAccount.started!], timeout: 1)
        let secondOperation = model.operation
        secondAccount.finish(second); await secondOperation?.value
        XCTAssertEqual(model.state, .result(.confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount))
        XCTAssertEqual(first.revocations, 1); XCTAssertEqual(secondAccount.revocations, 1)
        XCTAssertEqual(stub.requests.count, 6)
        withExtendedLifetime(window) {}
    }

    func testCloseFencesLateCompletionAndBlocksRetryUntilDrained() async {
        let account = FakeAccount(); account.started = expectation(description: "owner starts")
        var calls = 0
        let model = TwoAccountDiagnosticModel(factory: { _, _ in calls += 1; return account }, readKey: { self.key })
        let window = NSWindow(); model.attach(window: window); model.startOwner()
        await fulfillment(of: [account.started!], timeout: 1)
        let operation = model.operation
        model.detach()
        XCTAssertEqual(account.revocations, 1)
        model.attach(window: window); model.startOwner()
        XCTAssertEqual(calls, 1)
        account.finish(owner); await operation?.value
        XCTAssertEqual(model.state, .idle)
        XCTAssertFalse(model.draining)
        withExtendedLifetime(window) {}
    }

    func testExpiredOwnerSessionFailsAndRevokesWithoutReads() async {
        let account = FakeAccount(); account.started = expectation(description: "owner starts")
        let stub = Stub()
        let model = TwoAccountDiagnosticModel(factory: { _, _ in account }, readKey: { self.key },
            diagnostic: TwoAccountReadOnlyDiagnostic(transport: stub))
        let window = NSWindow(); model.attach(window: window); model.startOwner()
        await fulfillment(of: [account.started!], timeout: 1)
        let operation = model.operation
        account.finish(owner, expiry: Date().addingTimeInterval(-1))
        await operation?.value
        XCTAssertEqual(model.state, .failure)
        XCTAssertEqual(account.revocations, 1)
        XCTAssertTrue(stub.requests.isEmpty)
        withExtendedLifetime(window) {}
    }

    func testRealTransportRejectsOversizeOfflineBody() async {
        OfflineDiagnosticURLProtocol.holdOpen = false
        OfflineDiagnosticURLProtocol.started = nil
        OfflineDiagnosticURLProtocol.stopped = nil
        OfflineDiagnosticURLProtocol.body = Data(repeating: 120, count: DiagnosticEphemeralTransport.limit + 1)
        let transport = DiagnosticEphemeralTransport(protocolClasses: [OfflineDiagnosticURLProtocol.self])
        do {
            _ = try await transport.get(URLRequest(url: URL(string: "https://offline.invalid/")!))
            XCTFail("Oversize response accepted")
        } catch { }
    }

    func testRealTransportCancellationStopsOfflineRequest() async {
        let started = expectation(description: "URLProtocol started")
        let stopped = expectation(description: "URLProtocol stopped")
        OfflineDiagnosticURLProtocol.started = started
        OfflineDiagnosticURLProtocol.stopped = stopped
        OfflineDiagnosticURLProtocol.holdOpen = true
        defer {
            OfflineDiagnosticURLProtocol.started = nil
            OfflineDiagnosticURLProtocol.stopped = nil
            OfflineDiagnosticURLProtocol.holdOpen = false
        }
        let transport = DiagnosticEphemeralTransport(protocolClasses: [OfflineDiagnosticURLProtocol.self])
        let task = Task { try await transport.get(URLRequest(url: URL(string: "https://offline.invalid/")!)) }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [stopped], timeout: 2)
        do { _ = try await task.value; XCTFail("Cancelled request succeeded") } catch { }
    }

    private final class Stub: DiagnosticTransport {
        var requests: [URLRequest] = []
        var bodies = [String]()
        var status = 200
        var redirectResponse = false
        func get(_ request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard !bodies.isEmpty else { throw CancellationError() }
            let body = bodies.removeFirst()
            let url = redirectResponse ? URL(string: "https://other.invalid/")! : request.url!
            return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    private func user(_ suffix: String) -> String {
        let id = "00000000-0000-0000-0000-00000000000\(suffix)"
        return #"{"id":"\#(id)","is_anonymous":false,"email":"synthetic@example.invalid","email_confirmed_at":"2025-01-01T00:00:00Z","identities":[{"provider":"google","user_id":"\#(id)"}]}"#
    }

    private func fixture(_ ownerRows: String = #"[{"youtube_playlist_id":"private-row","user_id":"00000000-0000-0000-0000-000000000001"}]"#,
                         _ secondRows: String = "[]") -> [String] {
        [user("1"), user("2"), "true", "false", ownerRows, secondRows]
    }

    // This asserts one owner-visible row and an empty second-account limited read;
    // it does not prove general RLS isolation or that the owner cannot see others' rows.
    func testSelectedOwnerRowHiddenFromSecondAccountUsesOnlyFixedRequests() async {
        let stub = Stub(); stub.bodies = fixture()
        let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
        XCTAssertEqual(result, .confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount)
        XCTAssertEqual(stub.requests.map { $0.url!.absoluteString }, [
            "https://rkgbxjwmnlsmguhctguf.supabase.co/auth/v1/user",
            "https://rkgbxjwmnlsmguhctguf.supabase.co/auth/v1/user",
            "https://rkgbxjwmnlsmguhctguf.supabase.co/rest/v1/rpc/is_approved_owner",
            "https://rkgbxjwmnlsmguhctguf.supabase.co/rest/v1/rpc/is_approved_owner",
            "https://rkgbxjwmnlsmguhctguf.supabase.co/rest/v1/playlist_links?select=youtube_playlist_id,user_id&limit=1",
            "https://rkgbxjwmnlsmguhctguf.supabase.co/rest/v1/playlist_links?select=youtube_playlist_id,user_id&limit=1"])
        XCTAssertTrue(stub.requests.allSatisfy { $0.httpMethod == "GET" && $0.httpBody == nil && !$0.httpShouldHandleCookies })
        XCTAssertEqual(stub.requests.map { $0.value(forHTTPHeaderField: "Authorization")! },
                       ["Bearer \(owner)", "Bearer \(second)", "Bearer \(owner)", "Bearer \(second)", "Bearer \(owner)", "Bearer \(second)"])
    }

    func testEmailShapeForEachAccountFailsClosedWithoutDisclosingEmail() async {
        let invalid = ["not-an-email", "@example.com", "user@", "user@@example.com",
                       "user name@example.com", " user@example.com", "user@example.com ",
                       ".user@example.com", "user..name@example.com", "user.@example.com",
                       "user@example", "user@.example.com", "user@example..com",
                       "user@-example.com", "user@example-.com", "user@example.com\n"]
        for email in invalid {
            for badIndex in 0...1 {
                let stub = Stub()
                // JSON encode so control characters remain valid JSON and exercise email validation.
                let encoded = String(data: try! JSONEncoder().encode(email), encoding: .utf8)!
                let bad = user(badIndex == 0 ? "1" : "2")
                    .replacingOccurrences(of: #""synthetic@example.invalid""#, with: encoded)
                stub.bodies = badIndex == 0 ? [bad] : [user("1"), bad]
                let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
                XCTAssertEqual(result, .linkedAccountInconclusive)
                XCTAssertEqual(stub.requests.count, badIndex + 1)
                XCTAssertFalse(String(reflecting: result).contains(email))
            }
        }
    }

    func testValidEmailShapeVariantsForEachAccount() async {
        for email in ["user@example.com", "First.Last+tag@sub.example.org", "user_name-42@EXAMPLE.COM", "a!b@example-domain.test"] {
            for index in 0...1 {
                let stub = Stub()
                stub.bodies = fixture()
                stub.bodies[index] = stub.bodies[index].replacingOccurrences(of: "synthetic@example.invalid", with: email)
                let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
                XCTAssertEqual(result, .confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount)
                XCTAssertFalse(String(reflecting: result).contains(email))
            }
        }
    }

    func testIsolationAndIdentityOutcomes() async {
        let cases: [([String], TwoAccountReadOnlyDiagnostic.Outcome)] = [
            (fixture("[]"), .rowIsolationInconclusive),
            (fixture("[]", #"[{"youtube_playlist_id":"other-row-123","user_id":"00000000-0000-0000-0000-000000000002"}]"#), .rowIsolationFailure),
            (fixture(fixture()[4], fixture()[4]), .rowIsolationFailure),
            (fixture(#"[{"youtube_playlist_id":"private-row","user_id":"00000000-0000-0000-0000-000000000002"}]"#), .rowIsolationInconclusive),
            (fixture(#"[{"youtube_playlist_id":"private-row"}]"#), .rowIsolationInconclusive),
            (fixture(#"[{"youtube_playlist_id":"private-row","user_id":"invalid"}]"#), .rowIsolationInconclusive),
            (fixture(#"[{"youtube_playlist_id":"private-row","user_id":"00000000-0000-0000-0000-000000000001"},{"youtube_playlist_id":"private-row","user_id":"00000000-0000-0000-0000-000000000001"}]"#), .rowIsolationInconclusive),
            (fixture(fixture()[4], #"[{"youtube_playlist_id":"private-row"}]"#), .rowIsolationInconclusive),
            ([fixture()[0], fixture()[0]], .sameIdentity),
            (Array(fixture().prefix(2)) + ["false"], .ownerCheckFailed),
            (Array(fixture().prefix(2)) + ["true", "true"], .nonOwnerCheckFailed)
        ]
        for (bodies, expected) in cases {
            let stub = Stub(); stub.bodies = bodies
            let actual = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
            XCTAssertEqual(actual, expected)
            XCTAssertFalse(String(reflecting: actual).contains("private-row"))
        }
    }

    func testBothAccountsRequireExplicitConsistentLinkedAccountEvidence() async {
        let good = user("1")
        let malformed = [
            good.replacingOccurrences(of: #""is_anonymous":false"#, with: #""is_anonymous":true"#),
            good.replacingOccurrences(of: #""is_anonymous":false,"#, with: ""),
            good.replacingOccurrences(of: #""is_anonymous":false"#, with: #""is_anonymous":"false""#),
            good.replacingOccurrences(of: #""2025-01-01T00:00:00Z""#, with: "null"),
            good.replacingOccurrences(of: #""2025-01-01T00:00:00Z""#, with: #""  ""#),
            good.replacingOccurrences(of: #""2025-01-01T00:00:00Z""#, with: #""not-a-date""#),
            good.replacingOccurrences(of: #""2025-01-01T00:00:00Z""#, with: #""2025-02-30T00:00:00Z""#),
            good.replacingOccurrences(of: #""2025-01-01T00:00:00Z""#, with: #""2025-01-01T00:00:00+99:00""#),
            good.replacingOccurrences(of: #""email":"synthetic@example.invalid","#, with: ""),
            good.replacingOccurrences(of: #""synthetic@example.invalid""#, with: #""  ""#),
            good.replacingOccurrences(of: #""google""#, with: #""email""#),
            good.replacingOccurrences(of: #""identities":[{"provider":"google","user_id":"00000000-0000-0000-0000-000000000001"}]"#, with: #""identities":[]"#),
            good.replacingOccurrences(of: #""identities":"#, with: #""missing_identities":"#),
            good.replacingOccurrences(of: #""user_id":"00000000-0000-0000-0000-000000000001""#, with: #""user_id":"00000000-0000-0000-0000-000000000002""#),
            good.replacingOccurrences(of: #""identities":[{"provider":"google","user_id":"00000000-0000-0000-0000-000000000001"}]"#, with: #""identities":[{"provider":"google"}]"#),
            "not-json"
        ]
        for bad in malformed {
            for badIndex in 0...1 {
                let stub = Stub()
                stub.bodies = badIndex == 0 ? [bad] : [user("2"), bad]
                let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
                XCTAssertEqual(result, .linkedAccountInconclusive)
                XCTAssertEqual(stub.requests.count, badIndex + 1)
                XCTAssertFalse(String(reflecting: result).contains("00000000"))
                XCTAssertFalse(String(reflecting: result).contains(owner))
                XCTAssertFalse(String(reflecting: result).contains("synthetic@example.invalid"))
            }
        }
    }

    func testValidConfirmationTimestampVariants() async {
        for timestamp in ["2025-01-01T00:00:00Z", "2025-01-01T00:00:00.123456Z",
                          "2025-01-01T03:00:00+03:00", "2025-01-01T00:00:00.123-05:30"] {
            let stub = Stub()
            stub.bodies = fixture().map { $0.replacingOccurrences(of: "2025-01-01T00:00:00Z", with: timestamp) }
            let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
            XCTAssertEqual(result, .confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount)
        }
    }

    func testMalformedOversizeRedirectAndBadCredentialsFailClosed() async {
        for body in [String(repeating: "x", count: DiagnosticEphemeralTransport.limit + 1)] {
            let stub = Stub(); stub.bodies = [body]
            let result = await TwoAccountReadOnlyDiagnostic(transport: stub).verify(ownerToken: owner, secondToken: second, publishableKey: key)
            XCTAssertEqual(result, .unavailable)
        }
        let stub = Stub(); stub.bodies = fixture(); stub.redirectResponse = true
        let diagnostic = TwoAccountReadOnlyDiagnostic(transport: stub)
        let redirected = await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key)
        XCTAssertEqual(redirected, .unavailable)
        stub.redirectResponse = false; stub.status = 302
        let rejectedStatus = await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key)
        XCTAssertEqual(rejectedStatus, .unavailable)
        let count = stub.requests.count
        let invalid = await diagnostic.verify(ownerToken: "secret\r\nHeader:x", secondToken: second, publishableKey: key)
        XCTAssertEqual(invalid, .invalidCredential)
        XCTAssertEqual(stub.requests.count, count)
    }

    private final class Delayed: DiagnosticTransport {
        let started: XCTestExpectation
        var continuation: CheckedContinuation<(Data, URLResponse), Error>?
        var request: URLRequest?
        init(_ started: XCTestExpectation) { self.started = started }
        func get(_ request: URLRequest) async throws -> (Data, URLResponse) {
            try await withCheckedThrowingContinuation { continuation in
                self.request = request; self.continuation = continuation; started.fulfill()
            }
        }
        func complete() {
            let response = HTTPURLResponse(url: request!.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            continuation?.resume(returning: (Data(#"{"id":"00000000-0000-0000-0000-000000000001"}"#.utf8), response))
            continuation = nil; request = nil
        }
    }

    // Ignores task cancellation and returns a valid response only when released.
    private final class StagedTransport: DiagnosticTransport {
        let heldIndex: Int
        let started: XCTestExpectation
        let bodies: [String]
        var requests: [URLRequest] = []
        var pending: CheckedContinuation<(Data, URLResponse), Error>?
        init(heldIndex: Int, started: XCTestExpectation, bodies: [String]) {
            self.heldIndex = heldIndex; self.started = started; self.bodies = bodies
        }
        func get(_ request: URLRequest) async throws -> (Data, URLResponse) {
            let index = requests.count
            requests.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            if index == heldIndex {
                return try await withCheckedThrowingContinuation { continuation in
                    pending = continuation; started.fulfill()
                }
            }
            return (Data(bodies[index].utf8), response)
        }
        func release() {
            let response = HTTPURLResponse(url: requests[heldIndex].url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            pending?.resume(returning: (Data(bodies[heldIndex].utf8), response)); pending = nil
        }
    }

    func testCancellationAtEveryReadRejectsNoncooperativeLateResults() async {
        for index in 0..<6 {
            for revoke in [false, true] {
                let started = expectation(description: "read \(index), revoke \(revoke)")
                let stub = StagedTransport(heldIndex: index, started: started, bodies: fixture())
                let diagnostic = TwoAccountReadOnlyDiagnostic(transport: stub)
                let task = Task { await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key) }
                await fulfillment(of: [started], timeout: 2)
                if revoke { diagnostic.revoke() } else { task.cancel() }
                let busy = await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key)
                XCTAssertEqual(busy, .busy)
                stub.release()
                let result = await task.value
                XCTAssertEqual(result, .cancelled, "read \(index), revoke \(revoke)")
                XCTAssertEqual(stub.requests.count, index + 1)
            }
        }
    }

    func testResetAndCloseAtEveryReadFenceLateModelResults() async {
        for index in 0..<6 {
            for close in [false, true] {
                let first = FakeAccount(), secondAccount = FakeAccount()
                first.started = expectation(description: "owner starts")
                secondAccount.started = expectation(description: "second starts")
                let started = expectation(description: "read \(index), close \(close)")
                let stub = StagedTransport(heldIndex: index, started: started, bodies: fixture())
                var calls = 0
                let model = TwoAccountDiagnosticModel(factory: { _, _ in
                    calls += 1; return calls == 1 ? first : secondAccount
                }, readKey: { self.key }, diagnostic: TwoAccountReadOnlyDiagnostic(transport: stub))
                let window = NSWindow(); model.attach(window: window); model.startOwner()
                await fulfillment(of: [first.started!], timeout: 2)
                let ownerOperation = model.operation
                first.finish(owner); await ownerOperation?.value
                model.startSecond()
                await fulfillment(of: [secondAccount.started!], timeout: 2)
                let operation = model.operation
                secondAccount.finish(second)
                await fulfillment(of: [started], timeout: 2)
                if close { model.detach(); model.attach(window: window) } else { model.reset() }
                XCTAssertEqual(model.state, .idle)
                XCTAssertEqual(first.revocations, 1); XCTAssertEqual(secondAccount.revocations, 1)
                XCTAssertTrue(model.draining)
                model.startOwner(); XCTAssertEqual(calls, 2)
                stub.release(); await operation?.value
                XCTAssertEqual(model.state, .idle)
                XCTAssertFalse(model.draining)
                XCTAssertEqual(stub.requests.count, index + 1)
                withExtendedLifetime(window) {}
            }
        }
    }

    private final class CancellationAware: DiagnosticTransport {
        let started: XCTestExpectation
        let cancelled: XCTestExpectation
        init(started: XCTestExpectation, cancelled: XCTestExpectation) {
            self.started = started; self.cancelled = cancelled
        }
        func get(_ request: URLRequest) async throws -> (Data, URLResponse) {
            started.fulfill()
            do {
                try await Task.sleep(nanoseconds: 60_000_000_000)
                throw CancellationError()
            } catch {
                if Task.isCancelled { cancelled.fulfill() }
                throw error
            }
        }
    }

    func testRevocationCancelsInFlightTask() async {
        let started = expectation(description: "request started")
        let cancelled = expectation(description: "transport task cancelled")
        let diagnostic = TwoAccountReadOnlyDiagnostic(transport: CancellationAware(started: started, cancelled: cancelled))
        let task = Task { await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key) }
        await fulfillment(of: [started], timeout: 2)
        diagnostic.revoke()
        await fulfillment(of: [cancelled], timeout: 2)
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
    }

    func testCallerCancellationCancelsInFlightTask() async {
        let started = expectation(description: "request started")
        let cancelled = expectation(description: "transport task cancelled")
        let diagnostic = TwoAccountReadOnlyDiagnostic(transport: CancellationAware(started: started, cancelled: cancelled))
        let task = Task { await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key) }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [cancelled], timeout: 2)
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
    }

    func testRevocationRejectsLateResultAndBusy() async {
        let started = expectation(description: "request started")
        let stub = Delayed(started)
        let diagnostic = TwoAccountReadOnlyDiagnostic(transport: stub)
        let task = Task { await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key) }
        await fulfillment(of: [started], timeout: 2)
        let busy = await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key)
        XCTAssertEqual(busy, .busy)
        diagnostic.revoke()
        stub.complete()
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
    }

    func testTaskCancellationRejectsLateSuccess() async {
        let started = expectation(description: "request started")
        let stub = Delayed(started)
        let diagnostic = TwoAccountReadOnlyDiagnostic(transport: stub)
        let task = Task { await diagnostic.verify(ownerToken: owner, secondToken: second, publishableKey: key) }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        stub.complete()
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
    }
}
#endif
