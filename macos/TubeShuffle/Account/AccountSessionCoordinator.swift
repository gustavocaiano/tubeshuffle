import AppKit
import Auth
import Foundation
import Security

// These boundaries deliberately have no persistence, SDK, or transport policy.
struct AccountSession {
    let bearer: String
    // Stable, non-secret provider account identity, unchanged across token refreshes.
    let accountID: String
}

@MainActor
protocol AccountAuthenticationService {
    func restore() async throws -> AccountSession?
    func signIn() async throws -> AccountSession
    func refresh(_ session: AccountSession) async throws -> AccountSession
    // On success local credentials are removed and every authentication operation
    // started before this call is fenced from persisting credentials afterward.
    // This does not promise provider-side revocation.
    func signOut() async throws
}

@MainActor
protocol AccountLinkService {
    func list(bearer: String) async throws -> AccountLinkPage
    func save(_ playlistID: String, bearer: String) async throws -> PlaylistLinkDTO
    func unlink(_ playlistID: String, bearer: String) async throws
}

/// Optional capability: older link-only test doubles remain valid, while the
/// configured production service can fetch playlist data with its bearer held
/// entirely below the view-model boundary.
@MainActor
protocol AccountPlaylistService {
    func playlist(id: String, bearer: String) async throws -> YouTubePlaylistDTO
    func suggestions(_ input: SuggestionsRequest, bearer: String) async throws -> DailySuggestionsDTO
}

/// The only cloud records exposed to the native account flow are playlist
/// links.  The API client already applies the bearer and owner checks on the
/// server; this adapter deliberately does not inspect or upload local library
/// data, history, queue state, or preferences.
@MainActor
struct APIAccountLinkService: AccountLinkService, AccountPlaylistService {
    let client: APIClient

    func list(bearer: String) async throws -> AccountLinkPage {
        let response = try await client.links(bearer: bearer)
        // The current endpoint performs its own complete traversal. It is not
        // a snapshot: writes racing the request can still be missed.
        return AccountLinkPage(links: response.links, completeness: .serverTraversalCompleteNonSnapshot)
    }

    func save(_ playlistID: String, bearer: String) async throws -> PlaylistLinkDTO {
        try await client.saveLink(playlistID, bearer: bearer).link
    }

    func unlink(_ playlistID: String, bearer: String) async throws {
        try await client.deleteLink(playlistID, bearer: bearer)
    }

    func playlist(id: String, bearer: String) async throws -> YouTubePlaylistDTO {
        try await client.playlist(id: id, bearer: bearer)
    }

    func suggestions(_ input: SuggestionsRequest, bearer: String) async throws -> DailySuggestionsDTO {
        try await client.suggestions(input, bearer: bearer)
    }
}

// GET returns { links }, after server-side keyset pagination, with no client
// cursor. Completion is not snapshot isolation: concurrent writes may be missed.
struct AccountLinkPage {
    let links: [PlaylistLinkDTO]
    let completeness: Completeness

    enum Completeness {
        case serverTraversalCompleteNonSnapshot
    }
}

// No underlying errors, server text, or credentials cross this boundary.
enum AccountFailure: Equatable {
    case authentication, authenticationCancelled, invalidCredential, links, mutationOutcomeUnknown, invalidationFailed
}

enum AccountState: Equatable {
    case signedOut, restoring, signedIn, invalidating, recoverableError(AccountFailure)
}

enum AccountResult<Value> {
    case success(Value)
    case unavailable
    // A cancelled or failed mutation may already have committed remotely.
    case mutationOutcomeUnknown
}

@MainActor
final class AccountSessionCoordinator {
    private let authentication: any AccountAuthenticationService
    private let links: any AccountLinkService
    private let playlists: (any AccountPlaylistService)?
    private var session: AccountSession?
    private var generation = UUID()
    private var activeAuthentication: UUID?
    private var tasks: [UUID: () -> Void] = [:]
    private var pendingMutations: [UUID: String] = [:]
    private var uncertainMutations: [String: Set<UUID>] = [:]
    private(set) var state: AccountState = .signedOut

    var hasUncertainMutations: Bool {
        guard let accountID = session?.accountID else { return false }
        // A dispatched mutation is unresolved even before cancellation's
        // asynchronous MainActor callback has had a chance to run.
        return pendingMutations.values.contains(accountID)
            || !(uncertainMutations[accountID]?.isEmpty ?? true)
    }

    // Acknowledgement applies only to completed mutations of the current account.
    // Pending operations can still change the server after acknowledgement.
    func acknowledgeMutationUncertainty() {
        guard let accountID = session?.accountID else { return }
        guard let uncertain = uncertainMutations[accountID] else { return }
        let pending = uncertain.filter { pendingMutations[$0] == accountID }
        if pending.isEmpty { uncertainMutations.removeValue(forKey: accountID) }
        else { uncertainMutations[accountID] = pending }
    }

    init(authentication: any AccountAuthenticationService, links: any AccountLinkService) {
        self.authentication = authentication
        self.links = links
        playlists = links as? any AccountPlaylistService
    }

    private func invalidate() {
        for (id, accountID) in pendingMutations {
            uncertainMutations[accountID, default: []].insert(id)
        }
        generation = UUID()
        let cancellations = Array(tasks.values)
        tasks.removeAll()
        cancellations.forEach { $0() }
        session = nil
    }

    // Concurrent attempts are rejected; only the owner can complete invalidation.
    @discardableResult
    func signOut() async -> Bool {
        guard state != .invalidating else { return false }
        invalidate()
        state = .invalidating
        do {
            try await authentication.signOut()
            activeAuthentication = nil
            state = .signedOut
            return true
        } catch {
            state = .recoverableError(.invalidationFailed)
            return false
        }
    }

    private var authenticationBlocked: Bool {
        state == .invalidating || state == .recoverableError(.invalidationFailed)
            || state == .recoverableError(.authenticationCancelled) || activeAuthentication != nil
    }

    // Cancellation cannot prove that the service did not persist credentials.
    // Require explicit sign-out before another attempt, after the operation returns.
    private func authenticationWasCancelled(_ current: UUID) -> Bool {
        guard current == generation else { return true }
        guard !Task.isCancelled else {
            state = .recoverableError(.authenticationCancelled)
            return true
        }
        return false
    }

    private func run<T>(onCancellation: (@MainActor () -> Void)? = nil, _ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let id = UUID()
        let task = Task { @MainActor in try await operation() }
        tasks[id] = { task.cancel() }
        defer { tasks.removeValue(forKey: id) }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
            if let onCancellation = onCancellation {
                Task { @MainActor in onCancellation() }
            }
        }
    }

    private func valid(_ session: AccountSession) -> Bool {
        // Match APIClient's RFC 6750 b64token validation before accepting a session.
        let bytes = Array(session.bearer.utf8)
        let core = bytes.prefix { $0 != 61 }
        return !session.accountID.isEmpty && !core.isEmpty && core.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95, 126, 43, 47].contains($0)
        } && bytes.dropFirst(core.count).allSatisfy { $0 == 61 }
    }

    func restore() async {
        guard !authenticationBlocked else { return }
        invalidate()
        let current = generation
        let attempt = UUID()
        activeAuthentication = attempt
        defer { if activeAuthentication == attempt { activeAuthentication = nil } }
        state = .restoring
        do {
            let restored = try await run { try await self.authentication.restore() }
            guard !authenticationWasCancelled(current) else { return }
            guard let restored = restored else { state = .signedOut; return }
            guard valid(restored) else { state = .recoverableError(.invalidCredential); return }
            session = restored
            state = .signedIn
        } catch {
            guard !authenticationWasCancelled(current) else { return }
            state = .recoverableError(.authentication)
        }
    }

    func signIn() async {
        guard !authenticationBlocked else { return }
        invalidate()
        let current = generation
        let attempt = UUID()
        activeAuthentication = attempt
        defer { if activeAuthentication == attempt { activeAuthentication = nil } }
        state = .restoring
        do {
            let signedIn = try await run { try await self.authentication.signIn() }
            guard !authenticationWasCancelled(current) else { return }
            guard valid(signedIn) else { state = .recoverableError(.invalidCredential); return }
            session = signedIn
            state = .signedIn
        } catch {
            guard !authenticationWasCancelled(current) else { return }
            state = .recoverableError(.authentication)
        }
    }

    func refresh() async {
        guard !authenticationBlocked else { return }
        guard let previous = session, valid(previous) else { return }
        // Refresh supersedes all operations using the old credential.
        invalidate()
        let current = generation
        let attempt = UUID()
        activeAuthentication = attempt
        defer { if activeAuthentication == attempt { activeAuthentication = nil } }
        state = .restoring
        do {
            let refreshed = try await run { try await self.authentication.refresh(previous) }
            guard !authenticationWasCancelled(current) else { return }
            guard valid(refreshed) else { state = .recoverableError(.invalidCredential); return }
            session = refreshed
            state = .signedIn
        } catch {
            guard !authenticationWasCancelled(current) else { return }
            state = .recoverableError(.authentication)
        }
    }

    func list() async -> AccountResult<AccountLinkPage> {
        guard let session = session, valid(session) else { return .unavailable }
        let current = generation
        do {
            let result = try await run { try await self.links.list(bearer: session.bearer) }
            guard current == generation, !Task.isCancelled else { return .unavailable }
            state = .signedIn
            return .success(result)
        } catch {
            guard current == generation, !Task.isCancelled else { return .unavailable }
            state = .recoverableError(.links)
            return .unavailable
        }
    }

    func playlist(id: String) async -> AccountResult<YouTubePlaylistDTO> {
        guard let playlists else { return .unavailable }
        return await read { bearer in try await playlists.playlist(id: id, bearer: bearer) }
    }

    func suggestions(_ input: SuggestionsRequest) async -> AccountResult<DailySuggestionsDTO> {
        guard let playlists else { return .unavailable }
        return await read { bearer in try await playlists.suggestions(input, bearer: bearer) }
    }

    private func read<T>(_ operation: @escaping @MainActor (String) async throws -> T) async -> AccountResult<T> {
        guard let session = session, valid(session) else { return .unavailable }
        let current = generation
        do {
            let result = try await run { try await operation(session.bearer) }
            guard current == generation, !Task.isCancelled else { return .unavailable }
            state = .signedIn
            return .success(result)
        } catch {
            guard current == generation, !Task.isCancelled else { return .unavailable }
            state = .recoverableError(.links)
            return .unavailable
        }
    }

    func save(_ playlistID: String) async -> AccountResult<PlaylistLinkDTO> {
        await mutate { service, bearer in try await service.save(playlistID, bearer: bearer) }
    }

    func unlink(_ playlistID: String) async -> AccountResult<Void> {
        await mutate { service, bearer in try await service.unlink(playlistID, bearer: bearer) }
    }

    private func mutate<T>(_ operation: @escaping @MainActor (any AccountLinkService, String) async throws -> T) async -> AccountResult<T> {
        guard let session = session, valid(session) else { return .unavailable }
        let current = generation
        let mutationID = UUID()
        pendingMutations[mutationID] = session.accountID
        defer { pendingMutations.removeValue(forKey: mutationID) }
        do {
            let result = try await run(onCancellation: { [weak self] in
                guard let self = self, self.pendingMutations[mutationID] != nil else { return }
                self.uncertainMutations[session.accountID, default: []].insert(mutationID)
            }) { try await operation(self.links, session.bearer) }
            guard current == generation else { return .mutationOutcomeUnknown }
            guard !Task.isCancelled else {
                uncertainMutations[session.accountID, default: []].insert(mutationID)
                return .mutationOutcomeUnknown
            }
            state = .signedIn
            return .success(result)
        } catch {
            if current == generation {
                uncertainMutations[session.accountID, default: []].insert(mutationID)
            }
            if current == generation, !Task.isCancelled { state = .recoverableError(.mutationOutcomeUnknown) }
            return .mutationOutcomeUnknown
        }
    }
}

// MARK: - Normal native account service

/// Explicit, non-secret configuration supplied by the person using the app.
/// It is never discovered automatically. A setup document can be selected
/// explicitly and reviewed in the account form before use. Service-role keys
/// and OAuth client secrets are not accepted here.
struct NativeAccountConfiguration: Equatable {
    enum Failure: Error, Equatable { case invalidSupabaseOrigin, invalidPublishableKey, invalidAPIOrigin, invalidRedirect }
    static let requiredRedirect = URL(string: "com.tubeshuffle.playbacklab://auth/callback")!

    let supabaseOrigin: URL
    let publishableKey: String
    let applicationAPIOrigin: URL
    let redirect: URL

    init(supabaseOrigin: URL, publishableKey: String, applicationAPIOrigin: URL,
         redirect: URL = Self.requiredRedirect) throws {
        guard TransientSupabaseAccount.validEndpoint(supabaseOrigin.appendingPathComponent("auth/v1"), trustedOrigin: supabaseOrigin) else {
            throw Failure.invalidSupabaseOrigin
        }
        guard TransientSupabaseAccount.validPublishableKey(publishableKey) else { throw Failure.invalidPublishableKey }
        guard Self.validAPIOrigin(applicationAPIOrigin) else { throw Failure.invalidAPIOrigin }
        guard redirect == Self.requiredRedirect else { throw Failure.invalidRedirect }
        _ = try TransientOAuthCallback(redirect: redirect.absoluteString, correlationKey: "flow_correlation")
        self.supabaseOrigin = supabaseOrigin
        self.publishableKey = publishableKey
        self.applicationAPIOrigin = applicationAPIOrigin
        self.redirect = redirect
    }

    var authURL: URL { supabaseOrigin.appendingPathComponent("auth/v1") }

    private static func validAPIOrigin(_ origin: URL) -> Bool {
        guard let parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else { return false }
        return true
    }
}

/// Portable public setup only. Tokens, passwords and owner pins have no fields.
enum NativeAccountSetupDocument {
    enum Failure: Error { case invalidDocument }
    static let maximumBytes = 8_192
    private struct Payload: Codable {
        let format: String
        let version: Int
        let supabaseOrigin: String
        let publishableKey: String
        let applicationAPIOrigin: String
    }

    static func decode(_ data: Data) throws -> NativeAccountConfiguration {
        guard data.count <= maximumBytes else { throw Failure.invalidDocument }
        let document = try RawJSONScanner.scan(data, maximumNodes: 6, maximumDepth: 2)
        guard document.nodes.count == 6,
              case .object = document.nodes[0].value,
              Set(document.nodes.dropFirst().compactMap(\.key)) == Set(["format", "version", "supabaseOrigin", "publishableKey", "applicationAPIOrigin"]),
              let version = document.nodes.first(where: { $0.key == "version" }),
              case .number("1") = version.value else { throw Failure.invalidDocument }
        let payload = try JSONDecoder().decode(Payload.self, from: data)
        guard payload.format == "tubeshuffle-account-setup",
              let auth = URL(string: payload.supabaseOrigin),
              let api = URL(string: payload.applicationAPIOrigin) else { throw Failure.invalidDocument }
        return try NativeAccountConfiguration(supabaseOrigin: auth, publishableKey: payload.publishableKey, applicationAPIOrigin: api)
    }

    static func encode(_ configuration: NativeAccountConfiguration) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(Payload(format: "tubeshuffle-account-setup", version: 1,
            supabaseOrigin: configuration.supabaseOrigin.absoluteString, publishableKey: configuration.publishableKey,
            applicationAPIOrigin: configuration.applicationAPIOrigin.absoluteString))
        guard data.count <= maximumBytes else { throw Failure.invalidDocument }
        return data
    }
}

/// A SwiftUI-facing factory with explicit dependencies. Constructing it does no
/// Keychain I/O, network request, browser launch, restore, or implicit upload.
@MainActor
struct NativeAccountServiceFactory {
    let configuration: NativeAccountConfiguration

    func makeCoordinator(browser: TransientAuthBrowser, storage: NativeCredentialStorage? = nil,
                         transport: any APITransport = URLSessionAPITransport(),
                         fetch: @escaping AuthClient.FetchHandler = { try await TransientOAuthTransport().fetch($0) }) throws -> AccountSessionCoordinator {
        let auth = try NativeSupabaseAccountAuthentication(configuration: configuration, browser: browser,
                                                            storage: storage ?? NativeCredentialStorage(configuration: configuration), fetch: fetch)
        return AccountSessionCoordinator(authentication: auth,
                                         links: APIAccountLinkService(client: try APIClient(origin: configuration.applicationAPIOrigin, transport: transport)))
    }
}

/// Google PKCE authentication with a system browser. Only the session and PKCE
/// verifier use the dedicated Keychain namespace. Sign-out drains active work,
/// clears and verifies those keys, and drops the in-memory SDK client; it is not
/// a guarantee of remote revocation, cross-process fencing, or crash recovery.
@MainActor
final class NativeSupabaseAccountAuthentication: AccountAuthenticationService {
    enum Failure: Error { case invalidSession, storage, authorization }

    private let configuration: NativeAccountConfiguration
    private let browser: TransientAuthBrowser
    private let storage: NativeCredentialStorage
    private let fetch: AuthClient.FetchHandler
    private var client: AuthClient?
    private let gate: AuthOperationGate

    init(configuration: NativeAccountConfiguration, browser: TransientAuthBrowser,
         storage: NativeCredentialStorage? = nil,
         fetch: @escaping AuthClient.FetchHandler = { try await TransientOAuthTransport().fetch($0) }) throws {
        let resolvedStorage = storage ?? NativeCredentialStorage(configuration: configuration)
        self.configuration = configuration
        self.browser = browser
        self.storage = resolvedStorage
        self.fetch = fetch
        gate = AuthOperationGate { [resolvedStorage] in
            var failed = false
            for key in [NativeCredentialStorage.sessionKey, NativeCredentialStorage.verifierKey] {
                do { try resolvedStorage.remove(key: key) } catch { failed = true }
            }
            for key in [NativeCredentialStorage.sessionKey, NativeCredentialStorage.verifierKey] {
                do { if try resolvedStorage.retrieve(key: key) != nil { failed = true } }
                catch { failed = true }
            }
            if failed { throw Failure.storage }
        }
    }

    func restore() async throws -> AccountSession? {
        try await gate.run { [self] in
            let before = storage.observations.count
            // Avoid even an SDK session operation when our owned session key is
            // absent. If it exists, `session` refreshes an expired token rather
            // than handing the API an already-expired bearer.
            guard try storage.retrieve(key: NativeCredentialStorage.sessionKey) != nil else { return nil }
            let value = try await makeClient().session
            try ensureStorageHealthy(since: before)
            return try accountSession(from: value)
        }
    }

    func signIn() async throws -> AccountSession {
        try await gate.run { [self] in
            do {
                let before = storage.observations.count
                let correlation = try randomCorrelation()
                guard var components = URLComponents(url: configuration.redirect, resolvingAgainstBaseURL: false) else { throw Failure.authorization }
                components.queryItems = [URLQueryItem(name: "flow_correlation", value: correlation)]
                guard let redirect = components.url, let scheme = configuration.redirect.scheme else { throw Failure.authorization }
                let validator = try TransientOAuthCallback(redirect: configuration.redirect.absoluteString, correlationKey: "flow_correlation")
                let auth = makeClient(redirect: redirect)
                return try await withTaskCancellationHandler {
                    let url = try auth.getOAuthSignInURL(provider: .google, redirectTo: redirect)
                    let callback = try await browser.start(url: url, callbackScheme: scheme)
                    guard try validator.correlation(from: callback.absoluteString) == correlation else { throw Failure.authorization }
                    let session = try await auth.exchangeCodeForSession(authCode: validator.code(from: callback.absoluteString))
                    try Task.checkCancellation()
                    try ensureStorageHealthy(since: before)
                    return try accountSession(from: session)
                } onCancel: {
                    Task { @MainActor [browser] in browser.cancel() }
                }
            } catch is CancellationError {
                try clearOwnedCredentialsAfterFailedAuthentication()
                throw CancellationError()
            } catch {
                // A failed exchange may have written a session or left a PKCE
                // verifier. Do not make a later attempt inherit either value.
                try clearOwnedCredentialsAfterFailedAuthentication()
                throw Failure.authorization
            }
        }
    }

    func refresh(_ session: AccountSession) async throws -> AccountSession {
        try await gate.run { [self] in
            do {
                let before = storage.observations.count
                let refreshed = try await makeClient().refreshSession()
                try Task.checkCancellation()
                let result = try accountSession(from: refreshed)
                try ensureStorageHealthy(since: before)
                guard result.accountID == session.accountID else { throw Failure.invalidSession }
                return result
            } catch {
                try clearOwnedCredentialsAfterFailedAuthentication()
                throw error
            }
        }
    }

    func signOut() async throws {
        browser.cancel()
        try await gate.signOutLocally()
        client = nil
    }

    private func makeClient(redirect: URL? = nil) -> AuthClient {
        if let client, redirect == nil { return client }
        let value = AuthClient(configuration: .init(url: configuration.authURL, headers: ["apikey": configuration.publishableKey],
            flowType: .pkce, redirectToURL: redirect ?? configuration.redirect, storageKey: NativeCredentialStorage.sessionKey,
            localStorage: storage, logger: nil, fetch: fetch, autoRefreshToken: false))
        client = value
        return value
    }

    private func ensureStorageHealthy(since start: Int) throws {
        if storage.observations.dropFirst(start).contains(where: { $0.category != .absent }) { throw Failure.storage }
    }

    private func clearOwnedCredentialsAfterFailedAuthentication() throws {
        var failed = false
        for key in [NativeCredentialStorage.sessionKey, NativeCredentialStorage.verifierKey] {
            do { try storage.remove(key: key) } catch { failed = true }
        }
        for key in [NativeCredentialStorage.sessionKey, NativeCredentialStorage.verifierKey] {
            do { if try storage.retrieve(key: key) != nil { failed = true } }
            catch { failed = true }
        }
        client = nil
        if failed { throw Failure.storage }
    }

    private func accountSession(from session: Session) throws -> AccountSession {
        guard !session.accessToken.isEmpty else { throw Failure.invalidSession }
        return AccountSession(bearer: session.accessToken, accountID: session.user.id.uuidString.lowercased())
    }

    private func randomCorrelation() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.authorization }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
