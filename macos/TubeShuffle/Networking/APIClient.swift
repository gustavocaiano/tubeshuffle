import Foundation

// Transport is injected so tests never need a network. Implementations must not
// follow redirects or retain requests; the production adapter enforces both.
protocol APITransport {
    func send(_ request: URLRequest) async throws -> (Data, URLResponse)
}

final class URLSessionAPITransport: APITransport {
    private let session: URLSession

    // The delegate is owned by the session and must not own this transport.
    // Construct the session eagerly so simultaneous sends share one instance.
    init(protocolClasses: [AnyClass]? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        if let protocolClasses = protocolClasses { configuration.protocolClasses = protocolClasses }
        session = URLSession(configuration: configuration, delegate: RedirectRejectingDelegate(), delegateQueue: nil)
    }

    deinit {
        session.finishTasksAndInvalidate()
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }

}

final class RedirectRejectingDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// No raw URLs, response text, tokens or underlying transport errors are exposed.
enum APIClientError: Error, Equatable {
    case invalidOrigin, invalidCredential, invalidPathID
    case transport, nonHTTPResponse, malformedResponse
    case http(status: Int, retryAfter: Int?, kind: ServerErrorKind)
}

enum ServerErrorKind: Equatable {
    case structured(code: String?)
    case legacy
    case unknown
}

struct SuggestionSeed: Encodable {
    let title: String
    let channelTitle: String
    var description: String? = nil
    var categoryId: String? = nil
    var tags: [String]? = nil
    var duration: Double? = nil
}

struct SuggestionsRequest: Encodable {
    let playlistId: String
    let seeds: [SuggestionSeed]
    var playlistTitle: String? = nil
    var refreshToken: String? = nil
    var excludeVideoIds: [String]? = nil
    var dateKey: String? = nil
}

struct APIClient {
    private let origin: URL
    private let transport: any APITransport

    init(origin: URL, transport: any APITransport) throws {
        guard let parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw APIClientError.invalidOrigin
        }
        self.origin = origin
        self.transport = transport
    }

    func playlist(id: String, bearer: String? = nil) async throws -> YouTubePlaylistDTO {
        try await request(path: "/api/youtube/playlist", method: "GET",
                          query: [URLQueryItem(name: "playlistId", value: id)], bearer: bearer,
                          expected: [200], body: nil)
    }

    func suggestions(_ input: SuggestionsRequest, bearer: String? = nil) async throws -> DailySuggestionsDTO {
        let body = try JSONEncoder().encode(input)
        return try await request(path: "/api/youtube/suggestions", method: "POST", bearer: bearer,
                                 expected: [200], body: body)
    }

    func links(bearer: String? = nil) async throws -> PlaylistLinksResponseDTO {
        try await request(path: "/api/playlist-links", method: "GET", bearer: bearer, expected: [200], body: nil)
    }

    func saveLink(_ playlistId: String, bearer: String? = nil) async throws -> PlaylistLinkResponseDTO {
        let body = try JSONEncoder().encode(LinkBody(playlistId: playlistId))
        return try await request(path: "/api/playlist-links", method: "POST", bearer: bearer,
                                 expected: [200, 201], body: body)
    }

    func deleteLink(_ playlistId: String, bearer: String? = nil) async throws {
        // Valid IDs are already a single unreserved segment, excluding dots,
        // escapes, slashes and any alternate representation of a path.
        let bytes = Array(playlistId.utf8)
        guard (10...80).contains(bytes.count), bytes.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }) else { throw APIClientError.invalidPathID }
        let (data, response) = try await send(path: "/api/playlist-links/\(playlistId)", method: "DELETE", bearer: bearer, body: nil)
        try Self.check(response, data: data, expected: [204])
        guard data.isEmpty else { throw APIClientError.malformedResponse }
    }

    private struct LinkBody: Encodable { let playlistId: String }

    private func request<T: Decodable>(path: String, method: String, query: [URLQueryItem] = [], bearer: String?, expected: [Int], body: Data?) async throws -> T {
        let (data, response) = try await send(path: path, method: method, query: query, bearer: bearer, body: body)
        try Self.check(response, data: data, expected: expected)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIClientError.malformedResponse }
    }

    private func send(path: String, method: String, query: [URLQueryItem] = [], bearer: String?, body: Data?) async throws -> (Data, URLResponse) {
        try Task.checkCancellation()
        // Restrict credentials to RFC 6750 b64token characters to prevent header injection.
        if let bearer = bearer {
            let bytes = Array(bearer.utf8)
            let core = bytes.prefix { $0 != 61 }
            guard !core.isEmpty, core.allSatisfy({
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95, 126, 43, 47].contains($0)
            }), bytes.dropFirst(core.count).allSatisfy({ $0 == 61 }) else { throw APIClientError.invalidCredential }
        }
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw APIClientError.invalidOrigin }
        components.path = path
        if !query.isEmpty {
            components.queryItems = query
            // URLSearchParams on the server treats '+' as a space; Foundation's
            // query item encoder leaves it literal unless escaped explicitly.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else { throw APIClientError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer = bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let result = try await transport.send(request)
            try Task.checkCancellation()
            return result
        } catch is CancellationError { throw CancellationError() }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw APIClientError.transport
        }
    }

    private static func check(_ response: URLResponse, data: Data, expected: [Int]) throws {
        guard let http = response as? HTTPURLResponse else { throw APIClientError.nonHTTPResponse }
        guard expected.contains(http.statusCode) else {
            let value = http.value(forHTTPHeaderField: "Retry-After")
            let retry: Int? = value.flatMap { text in
                guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
                return Int(text)
            }
            let decoder = JSONDecoder()
            let kind: ServerErrorKind
            if let error = try? decoder.decode(OwnerAPIErrorDTO.self, from: data) {
                // Only established codes are safe to propagate from an untrusted server.
                let known = ["unauthenticated", "auth_unavailable", "forbidden", "invalid_request", "payload_too_large", "unsupported_media_type", "rate_limited", "internal_error", "link_limit"]
                kind = .structured(code: known.contains(error.error.code) ? error.error.code : nil)
            } else if (try? decoder.decode(LegacyAPIErrorDTO.self, from: data)) != nil {
                kind = .legacy
            } else { kind = .unknown }
            throw APIClientError.http(status: http.statusCode, retryAfter: retry, kind: kind)
        }
    }
}
