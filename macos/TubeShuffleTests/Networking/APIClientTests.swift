import Foundation
import XCTest
@testable import TubeShuffle

final class APIClientTests: XCTestCase {
    final class Stub: APITransport {
        var requests: [URLRequest] = []
        var handler: (URLRequest) async throws -> (Data, URLResponse)
        init(_ handler: @escaping (URLRequest) async throws -> (Data, URLResponse)) { self.handler = handler }
        func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            return try await handler(request)
        }
    }

    private func response(_ request: URLRequest, _ status: Int, _ json: String = "", headers: [String: String] = [:]) -> (Data, URLResponse) {
        (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }

    func testPlaylistQueryCannotInjectAndUsesBearer() async throws {
        let stub = Stub { request in
            self.response(request, 200, #"{"id":"x","title":"t","description":null,"thumbnail":null,"channelTitle":null,"videoCount":0,"videos":[]}"#)
        }
        let client = try APIClient(origin: URL(string: "https://example.test/")!, transport: stub)
        _ = try await client.playlist(id: "abc+&list=evil?#/é", bearer: "abc.def-_")
        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/youtube/playlist")
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "playlistId", value: "abc+&list=evil?#/é")])
        XCTAssertTrue(request.url!.absoluteString.contains("%2B"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc.def-_")
        XCTAssertNil(request.httpBody)
    }

    func testSuggestionsAndLinkMethodsAndBodies() async throws {
        let stub = Stub { request in
            switch (request.httpMethod, request.url!.path) {
            case ("POST", "/api/youtube/suggestions"):
                return self.response(request, 200, #"{"playlistId":"p","generatedAt":"now","dateKey":"d","query":"q","quotaCost":0,"suggestions":[]}"#)
            case ("GET", "/api/playlist-links"):
                return self.response(request, 200, #"{"links":[]}"#)
            case ("POST", "/api/playlist-links"):
                return self.response(request, 201, #"{"link":{"youtubePlaylistId":"abcdefghij","createdAt":"2026-01-01T00:00:00.000Z"}}"#)
            default: return self.response(request, 204)
            }
        }
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: stub)
        _ = try await client.suggestions(SuggestionsRequest(playlistId: "p", seeds: [SuggestionSeed(title: "t", channelTitle: "c")]))
        _ = try await client.links()
        _ = try await client.saveLink("https://youtube.com/playlist?list=abcdefghij")
        try await client.deleteLink("abcdefghij")
        XCTAssertEqual(stub.requests.map { $0.httpMethod! }, ["POST", "GET", "POST", "DELETE"])
        XCTAssertEqual(stub.requests[3].url?.path, "/api/playlist-links/abcdefghij")
        XCTAssertNil(stub.requests[3].httpBody)
        XCTAssertNil(stub.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(stub.requests[0].value(forHTTPHeaderField: "Content-Type"), "application/json")
        let suggestion = try XCTUnwrap(try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as? [String: Any])
        XCTAssertEqual(suggestion["playlistId"] as? String, "p")
        XCTAssertEqual((suggestion["seeds"] as? [[String: Any]])?.first?["channelTitle"] as? String, "c")
        let link = try XCTUnwrap(try JSONSerialization.jsonObject(with: stub.requests[2].httpBody!) as? [String: String])
        XCTAssertEqual(link, ["playlistId": "https://youtube.com/playlist?list=abcdefghij"])
    }

    func testRejectsInvalidOriginsCredentialsAndPathInjectionBeforeTransport() async throws {
        let stub = Stub { _ in XCTFail("unexpected request"); throw CancellationError() }
        for origin in ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?x=1", "https://example.test/#fragment", "file:///tmp"] {
            XCTAssertThrowsError(try APIClient(origin: URL(string: origin)!, transport: stub), origin)
        }
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: stub)
        for id in ["../abcdefghij", "abcdefghij%2fother", "abcdefghij/other", "abcdefghij?x=1", "abcdefghij#x"] {
            do { try await client.deleteLink(id); XCTFail("accepted \(id)") }
            catch { XCTAssertEqual(error as? APIClientError, .invalidPathID) }
        }
        do { _ = try await client.links(bearer: "secret\r\nInjected: yes"); XCTFail("accepted credential") }
        catch { XCTAssertEqual(error as? APIClientError, .invalidCredential) }
        XCTAssertTrue(stub.requests.isEmpty)
    }

    func testErrorsAreClassifiedAndNeverExposeServerText() async throws {
        let secret = "sensitive-token"
        let stub = Stub { request in
            self.response(request, 429, #"{"error":{"code":"rate_limited","message":"sensitive-token"}}"#, headers: ["Retry-After": "12"])
        }
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: stub)
        do { _ = try await client.links(bearer: secret); XCTFail("expected error") }
        catch {
            XCTAssertEqual(error as? APIClientError, .http(status: 429, retryAfter: 12, kind: .structured(code: "rate_limited")))
            XCTAssertFalse(String(reflecting: error).contains(secret))
        }
        stub.handler = { self.response($0, 502, #"{"error":"sensitive-token"}"#) }
        do { _ = try await client.links(); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIClientError, .http(status: 502, retryAfter: nil, kind: .legacy)); XCTAssertFalse(String(reflecting: error).contains(secret)) }
        stub.handler = { self.response($0, 302, "", headers: ["Location": "https://other.test/"]) }
        do { _ = try await client.links(); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIClientError, .http(status: 302, retryAfter: nil, kind: .unknown)) }
    }

    func testMalformedNonHTTPAndCancellation() async throws {
        let stub = Stub { self.response($0, 200, "not json") }
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: stub)
        do { _ = try await client.links(); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIClientError, .malformedResponse) }
        stub.handler = { request in (Data(), URLResponse(url: request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)) }
        do { _ = try await client.links(); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIClientError, .nonHTTPResponse) }
        stub.handler = { _ in throw URLError(.cancelled) }
        do { _ = try await client.links(); XCTFail("expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        stub.handler = { _ in throw URLError(.cannotConnectToHost) }
        do { _ = try await client.links(); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIClientError, .transport) }
    }

    func testURLSessionAdapterRejectsRedirects() {
        let delegate = BoundedHTTPTransport()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let original = URLRequest(url: URL(string: "https://example.test/")!)
        let task = session.dataTask(with: original) // Not resumed; no request is sent.
        var redirected = URLRequest(url: URL(string: "https://other.test/")!)
        redirected.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
        let response = HTTPURLResponse(url: original.url!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        var called = false
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: redirected) {
            called = true
            XCTAssertNil($0)
        }
        XCTAssertTrue(called)
    }

    func testClientRejectsLateSuccessfulTransportCompletionAfterCancellation() async throws {
        let started = expectation(description: "transport started")
        let finished = expectation(description: "client finished")
        let transport = ControlledTransport(started: started)
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: transport)
        let task = Task {
            defer { finished.fulfill() }
            do { _ = try await client.links(); XCTFail("cancelled client returned late success") }
            catch { XCTAssertTrue(error is CancellationError, "Expected CancellationError, got \(error)") }
        }
        defer { task.cancel(); transport.complete() }
        await fulfillment(of: [started], timeout: 5)
        task.cancel()
        transport.complete()
        await fulfillment(of: [finished], timeout: 5)
    }

    func testConcurrentTransportUseAndCleanup() async throws {
        var adapter: URLSessionAPITransport? = URLSessionAPITransport(protocolClasses: [SuccessfulProtocol.self])
        weak var weakAdapter = adapter
        let request = URLRequest(url: URL(string: "https://example.test/concurrent")!)
        try await withThrowingTaskGroup(of: Void.self) { group in
            let transport = try XCTUnwrap(adapter)
            for _ in 0..<30 {
                group.addTask {
                    let (data, response) = try await transport.send(request)
                    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                    XCTAssertEqual(data, Data("ok".utf8))
                }
            }
            try await group.waitForAll()
        }
        adapter = nil
        XCTAssertNil(weakAdapter)
    }

    func testResponseBudgetIncludesAdvertisedDeliveredAndErrorBodies() async throws {
        let transport = URLSessionAPITransport(protocolClasses: [BoundedAPIProtocol.self], responseLimit: 256)
        for path in ["exact", "overflow", "misleading", "advertised", "error"] {
            var request = URLRequest(url: URL(string: "https://example.invalid/\(path)")!)
            request.timeoutInterval = 2
            do {
                let (data, _) = try await transport.send(request)
                XCTAssertEqual(path, "exact", "oversized response must be rejected")
                XCTAssertEqual(data, Data(repeating: 42, count: 256))
            } catch {
                XCTAssertNotEqual(path, "exact")
                XCTAssertEqual(error as? APIClientError, .responseTooLarge, path)
            }
        }
        // A custom transport must not bypass the client's decoding budget.
        let stub = Stub { request in
            (Data(repeating: 42, count: APIClient.maximumResponseBytes + 1),
             HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
        }
        let client = try APIClient(origin: URL(string: "https://example.invalid")!, transport: stub)
        do { _ = try await client.links(); XCTFail("oversized custom transport response accepted") }
        catch { XCTAssertEqual(error as? APIClientError, .responseTooLarge) }
    }

    func testStreamingResponseCancellationStopsReceiving() async throws {
        let started = expectation(description: "stream response started")
        let stopped = expectation(description: "stream cancelled")
        let host = UUID().uuidString.lowercased() + ".invalid"
        BoundedAPIProtocol.observe(host, started: started, stopped: stopped)
        defer { BoundedAPIProtocol.remove(host) }
        let transport = URLSessionAPITransport(protocolClasses: [BoundedAPIProtocol.self], responseLimit: 256)
        let request = URLRequest(url: URL(string: "https://\(host)/cancel")!)
        let operation = Task { try await transport.send(request) }
        await fulfillment(of: [started], timeout: 2)
        operation.cancel()
        do { _ = try await operation.value; XCTFail("cancelled stream returned") }
        catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
        await fulfillment(of: [stopped], timeout: 2)
    }

    func testAdvertisedOversizeCancelsOnResponseCallbackBeforeReceivingBody() async throws {
        let started = expectation(description: "synthetic request started")
        let stopped = expectation(description: "oversized request cancelled")
        let host = UUID().uuidString.lowercased() + ".invalid"
        BoundedAPIProtocol.observe(host, started: started, stopped: stopped)
        defer { BoundedAPIProtocol.remove(host) }
        let transport = BoundedHTTPTransport(protocolClasses: [BoundedAPIProtocol.self], maximumResponseBytes: 256)
        let request = URLRequest(url: URL(string: "https://\(host)/cancel")!)
        let operation = Task { try await transport.fetch(request) }
        await fulfillment(of: [started], timeout: 2)
        // URLProtocol on this OS withholds its response callback until body/EOF.
        // Direct callback delivery tests immediate policy rejection, independently
        // of that simulator limitation. No real HTTP behavior is claimed here.
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request) // Not resumed.
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Length": "257"])!
        transport.urlSession(session, dataTask: task, didReceive: response) { disposition in
            XCTAssertEqual(disposition, .cancel)
        }
        do { _ = try await operation.value; XCTFail("oversized headers accepted") }
        catch { XCTAssertEqual(error as? BoundedHTTPTransport.Failure, .responseTooLarge) }
        await fulfillment(of: [stopped], timeout: 2)
    }

    func testUnexpectedStatusDeleteBodyAndRetryAfter() async throws {
        let stub = Stub { self.response($0, 201, #"{"links":[]}"#) }
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: stub)
        do { _ = try await client.links(); XCTFail("expected status error") }
        catch { XCTAssertEqual(error as? APIClientError, .http(status: 201, retryAfter: nil, kind: .unknown)) }
        stub.handler = { self.response($0, 204, "unexpected") }
        do { try await client.deleteLink("abcdefghij"); XCTFail("expected malformed response") }
        catch { XCTAssertEqual(error as? APIClientError, .malformedResponse) }
        for value in ["-1", "1.5", "Wed, 21 Oct 2015 07:28:00 GMT", "999999999999999999999999999"] {
            stub.handler = { self.response($0, 503, "", headers: ["Retry-After": value]) }
            do { _ = try await client.links(); XCTFail("expected status error") }
            catch { XCTAssertEqual(error as? APIClientError, .http(status: 503, retryAfter: nil, kind: .unknown)) }
        }
    }
}

// Ignores cancellation deliberately so the client must reject a late 200 itself.
private final class ControlledTransport: APITransport {
    private let lock = NSLock()
    private let started: XCTestExpectation
    private var continuation: CheckedContinuation<(Data, URLResponse), Error>?
    private var request: URLRequest?
    private var released = false

    init(started: XCTestExpectation) { self.started = started }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.request = request
            self.continuation = continuation
            let shouldRelease = released
            lock.unlock()
            started.fulfill()
            if shouldRelease { complete() }
        }
    }

    func complete() {
        lock.lock()
        released = true
        let continuation = self.continuation
        let request = self.request
        self.continuation = nil
        lock.unlock()
        if let continuation = continuation, let request = request {
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            continuation.resume(returning: (Data(#"{"links":[]}"#.utf8), response))
        }
    }
}

private final class SuccessfulProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("ok".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class BoundedAPIProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var observations: [String: (XCTestExpectation, XCTestExpectation)] = [:]

    static func observe(_ host: String, started: XCTestExpectation, stopped: XCTestExpectation) {
        lock.lock(); defer { lock.unlock() }
        observations[host] = (started, stopped)
    }
    static func remove(_ host: String) {
        lock.lock(); defer { lock.unlock() }
        observations.removeValue(forKey: host)
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        var headers: [String: String] = [:]
        if path == "/exact" { headers["Content-Length"] = "256" }
        if path == "/advertised" { headers["Content-Length"] = "257" }
        if path == "/misleading" { headers["Content-Length"] = "1" }
        let response = HTTPURLResponse(url: request.url!, statusCode: path == "/error" ? 503 : 200,
                                       httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if path == "/cancel" {
            Self.lock.lock(); let observation = Self.observations[request.url!.host!]; Self.lock.unlock()
            observation?.0.fulfill()
            return
        }
        if path == "/advertised" { client?.urlProtocolDidFinishLoading(self); return }
        client?.urlProtocol(self, didLoad: Data(repeating: 42, count: 128))
        client?.urlProtocol(self, didLoad: Data(repeating: 42, count: 128))
        if path != "/exact" { client?.urlProtocol(self, didLoad: Data([42])) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {
        Self.lock.lock(); let observation = Self.observations[request.url!.host!]; Self.lock.unlock()
        observation?.1.fulfill()
    }
}
