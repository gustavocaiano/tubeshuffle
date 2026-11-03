import Auth
import AppKit
import Foundation
import Security
import Darwin

/// One ephemeral session per fetch. Only response bytes retained by this delegate
/// are bounded; Foundation may transiently deliver a larger individual chunk or
/// decompress before delivery. The limit is an application policy, not a bound on
/// Foundation's internal buffering, decompression, or total process memory.
final class TransientOAuthTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let responseLimit = 256 * 1024
    enum Failure: Error { case responseTooLarge, redirect, invalidResponse, network, alreadyUsed }

    private let lock = NSLock()
    private let protocolClasses: [AnyClass]?
    private var continuation: CheckedContinuation<(Data, URLResponse), Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var started = false
    private var finished = false
    private var response: URLResponse?
    private var body = Data()

    init(protocolClasses: [AnyClass]? = nil) { self.protocolClasses = protocolClasses }

    func fetch(_ request: URLRequest) async throws -> (Data, URLResponse) {
        guard claim() else { throw Failure.alreadyUsed }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if finished {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                let configuration = URLSessionConfiguration.ephemeral
                configuration.urlCache = nil
                configuration.urlCredentialStorage = nil
                configuration.httpCookieStorage = nil
                configuration.httpShouldSetCookies = false
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                if let protocolClasses { configuration.protocolClasses = protocolClasses }
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                var request = request
                request.httpShouldHandleCookies = false
                let task = session.dataTask(with: request)
                self.session = session
                self.task = task
                task.resume()
                lock.unlock()
            }
        } onCancel: { self.cancel() }
    }

    private func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !started else { return false }
        started = true
        return true
    }

    private func cancel() {
        finish(.failure(CancellationError()))
    }

    private func finish(_ result: Result<(Data, URLResponse), Error>) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        let task = self.task, session = self.session
        self.task = nil; self.session = nil
        body = Data(); response = nil
        lock.unlock()
        task?.cancel()
        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        finish(.failure(Failure.redirect))
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            finish(.failure(Failure.invalidResponse)); completionHandler(.cancel); return
        }
        guard !(300...399).contains(http.statusCode) else {
            finish(.failure(Failure.redirect)); completionHandler(.cancel); return
        }
        if let length = http.value(forHTTPHeaderField: "Content-Length") {
            let trimmed = length.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, trimmed.utf8.allSatisfy({ (48...57).contains($0) }),
                  let value = UInt64(trimmed), value <= UInt64(Self.responseLimit) else {
                finish(.failure(Failure.responseTooLarge)); completionHandler(.cancel); return
            }
        }
        guard response.expectedContentLength <= Int64(Self.responseLimit) else {
            finish(.failure(Failure.responseTooLarge)); completionHandler(.cancel); return
        }
        lock.lock()
        if !finished { self.response = response }
        lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let tooLarge = !finished && data.count > Self.responseLimit - body.count
        if !finished && !tooLarge { body.append(data) }
        lock.unlock()
        if tooLarge { finish(.failure(Failure.responseTooLarge)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { finish(.failure(Failure.network)); return }
        lock.lock()
        let response = self.response, body = self.body
        lock.unlock()
        guard let response else { finish(.failure(Failure.invalidResponse)); return }
        finish(.success((body, response)))
    }
}

#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
/// Private, opt-in diagnostic configuration. The file contains only the modern
/// publishable key, never a URL or a privileged credential.
enum LocalOAuthDiagnosticConfiguration {
    enum Failure: Error { case unavailable }
    static let origin = URL(string: "https://rkgbxjwmnlsmguhctguf.supabase.co")!
    static let redirect = URL(string: "com.tubeshuffle.playbacklab://auth/callback")!

    static func readKey(path: String) throws -> String {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o7777) == 0o600,
              info.st_nlink == 1, info.st_size > 0, info.st_size <= 256 else {
            throw Failure.unavailable
        }
        var bytes = [UInt8](repeating: 0, count: 257)
        var total = 0
        while total < bytes.count {
            let count = bytes.withUnsafeMutableBytes { buffer in
                read(fd, buffer.baseAddress!.advanced(by: total), buffer.count - total)
            }
            if count == 0 { break }
            guard count > 0 else { throw Failure.unavailable }
            total += count
        }
        guard Int64(total) == info.st_size, total <= 256,
              var key = String(bytes: bytes.prefix(total), encoding: .utf8) else { throw Failure.unavailable }
        if key.hasSuffix("\n") { key.removeLast() }
        let keyBytes = Array(key.utf8)
        // Documented platform format: prefix, 22 random characters, separator,
        // eight checksum characters. The server validates the opaque key.
        guard keyBytes.count == 46, keyBytes[37] == 95,
              TransientSupabaseAccount.validPublishableKey(key) else { throw Failure.unavailable }
        return key
    }
}

@MainActor
final class LocalOAuthDiagnosticService: TemporaryAccountService {
    private let account: TransientSupabaseAccount

    init(window: NSWindow) throws {
        let key = try LocalOAuthDiagnosticConfiguration.readKey(path: NSHomeDirectory() + "/oauth-diagnostic-key")
        let origin = LocalOAuthDiagnosticConfiguration.origin
        account = try TransientSupabaseAccount(authURL: origin.appendingPathComponent("auth/v1"),
            trustedProjectOrigin: origin, publishableKey: key,
            baseRedirect: LocalOAuthDiagnosticConfiguration.redirect, browser: TransientAuthBrowser(anchor: window))
    }

    func signInExpiry() async throws -> Date { Date(timeIntervalSince1970: try await account.signIn().expiresAt) }
    func cancel() { account.cancel() }
    func signOutLocally() { account.logout() }
}
#endif

/// Unconnected, memory-only experiment. Integration must establish the provenance
/// of the trusted project origin and publishable key from trusted app configuration.
/// Hosted callback allowlisting and the complete PKCE flow remain unverified.
@MainActor
final class TransientSupabaseAccount {
    enum Failure: Error { case busy, randomUnavailable, invalidConfiguration, authorizationFailed }

    private let authURL: URL
    private let publishableKey: String
    private let baseRedirect: URL
    private let validator: TransientOAuthCallback
    private let flow: TransientFlowState<Session>
    private let launch: @MainActor (URL, String) async throws -> URL
    private let closeBrowser: @MainActor () -> Void
    private let fetch: AuthClient.FetchHandler
    private var running = false

    convenience init(authURL: URL, trustedProjectOrigin: URL, publishableKey: String,
         baseRedirect: URL, browser: TransientAuthBrowser) throws {
        try self.init(authURL: authURL, trustedProjectOrigin: trustedProjectOrigin,
                      publishableKey: publishableKey, baseRedirect: baseRedirect,
                      launch: { try await browser.start(url: $0, callbackScheme: $1) },
                      closeBrowser: { browser.cancel() }, fetch: { try await TransientOAuthTransport().fetch($0) })
    }

    // The injected transport is for deterministic tests; it must not follow redirects.
    init(authURL: URL, trustedProjectOrigin: URL, publishableKey: String, baseRedirect: URL,
         launch: @escaping @MainActor (URL, String) async throws -> URL,
         closeBrowser: @escaping @MainActor () -> Void,
         fetch: @escaping AuthClient.FetchHandler) throws {
        guard Self.validEndpoint(authURL, trustedOrigin: trustedProjectOrigin),
              Self.validPublishableKey(publishableKey) else { throw Failure.invalidConfiguration }
        let validator = try TransientOAuthCallback(redirect: baseRedirect.absoluteString, correlationKey: "flow_correlation")
        guard baseRedirect.scheme != nil else { throw Failure.invalidConfiguration }
        self.authURL = authURL
        self.publishableKey = publishableKey
        self.baseRedirect = baseRedirect
        self.validator = validator
        self.flow = TransientFlowState(validator: validator)
        self.launch = launch
        self.closeBrowser = closeBrowser
        self.fetch = fetch
    }

    // Require a canonical DNS origin and the exact SDK auth base path; no implicit
    // port, encoded path, userinfo, query, fragment, or alternate spelling.
    nonisolated static func validEndpoint(_ endpoint: URL, trustedOrigin: URL) -> Bool {
        guard let parts = URLComponents(url: trustedOrigin, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.percentEncodedPath.isEmpty, parts.query == nil, parts.fragment == nil,
              trustedOrigin.absoluteString == "https://\(host)",
              host == host.lowercased(), host.utf8.count <= 253 else { return false }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-" &&
            label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }) else { return false }
        return endpoint.absoluteString == "https://\(host)/auth/v1"
    }

    // Only the modern publishable-key format is accepted; legacy JWT keys cannot
    // safely be distinguished from service-role JWTs without trusted metadata.
    nonisolated static func validPublishableKey(_ key: String) -> Bool {
        let prefix = "sb_publishable_"
        guard key.hasPrefix(prefix), key.utf8.count > prefix.utf8.count else { return false }
        return key.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45
        }
    }

    var session: Session? { flow.session }

    func signIn() async throws -> Session {
        guard !running else { throw Failure.busy }
        running = true
        defer { running = false }
        let memory = RevocableSessionMemory()
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            memory.revokeAndClear()
            throw Failure.randomUnavailable
        }
        let correlation = bytes.map { String(format: "%02x", $0) }.joined()
        guard var redirect = URLComponents(url: baseRedirect, resolvingAgainstBaseURL: false) else {
            memory.revokeAndClear(); throw Failure.invalidConfiguration
        }
        redirect.queryItems = [URLQueryItem(name: "flow_correlation", value: correlation)]
        guard let redirectURL = redirect.url, let scheme = baseRedirect.scheme else {
            memory.revokeAndClear(); throw Failure.invalidConfiguration
        }
        let client = AuthClient(configuration: .init(
            url: authURL, headers: ["apikey": publishableKey], flowType: .pkce, redirectToURL: redirectURL,
            localStorage: memory, logger: nil, fetch: Self.noPKCERetry(fetch), autoRefreshToken: false
        ))
        let generation: UUID
        do {
            generation = try flow.start(correlation: correlation, revoke: { memory.revokeAndClear() },
                                        exchange: { try await client.exchangeCodeForSession(authCode: $0) })
        } catch {
            memory.revokeAndClear()
            throw Failure.busy
        }
        do {
            return try await withTaskCancellationHandler {
                let url = try client.getOAuthSignInURL(provider: .google, redirectTo: redirectURL)
                let callback = try await launch(url, scheme)
                // Never synthesize this value from the current flow: it comes from
                // the actual callback and is checked before any token request.
                let received = try validator.correlation(from: callback.absoluteString)
                return try await flow.receive(generation: generation, correlation: received, callback: callback.absoluteString)
            } onCancel: {
                memory.revokeAndClear()
            }
        } catch {
            flow.cancel()
            throw Failure.authorizationFailed // never propagate provider text or URLs
        }
    }

    /// Synchronous revocation precedes browser cancellation and any suspension.
    func cancel() { flow.cancel(); closeBrowser() }
    func logout() { cancel() } // Local only; no remote sign-out request.

    private struct NonRetryableExchangeFailure: Error {}

    // In SDK 2.55.5 the retry interceptor retries only URLError or selected
    // statuses. Convert retryable transport failures and selected statuses for
    // the one-shot PKCE POST to a private error; retain other bounded responses
    // for the SDK's normal error handling and preserve non-URL policy failures.
    // This controls SDK retries, not provider-side behavior or URLSession internals.
    private static func noPKCERetry(_ fetch: @escaping AuthClient.FetchHandler) -> AuthClient.FetchHandler {
        { request in
            let isExchange = request.httpMethod == "POST" && request.url?.lastPathComponent == "token" &&
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains {
                    $0.name == "grant_type" && $0.value == "pkce"
                } == true
            guard isExchange else { return try await fetch(request) }
            do {
                let response = try await fetch(request)
                guard let http = response.1 as? HTTPURLResponse else { throw NonRetryableExchangeFailure() }
                if [408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 530].contains(http.statusCode) {
                    throw NonRetryableExchangeFailure()
                }
                return response
            } catch is CancellationError { throw CancellationError() }
              catch let error as TransientOAuthTransport.Failure { throw error }
              catch is URLError { throw NonRetryableExchangeFailure() }
              catch { throw error }
        }
    }
}
