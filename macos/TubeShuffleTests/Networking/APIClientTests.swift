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
        let delegate = RedirectRejectingDelegate()
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
