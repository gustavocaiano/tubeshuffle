import Foundation
@testable import TubeShuffle

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
