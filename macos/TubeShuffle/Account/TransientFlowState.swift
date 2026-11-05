import Foundation

/// Coordinates one in-memory authorization generation. The adapter must bind
/// extract trusted correlation from the callback and bind it to the actual
/// authorization attempt; PKCE must bind the code to that attempt's verifier.
/// Do not merely attach the current generation/correlation to any incoming URL.
/// The callback parser does not validate OAuth state or bind a code to a flow.
/// Injected closures alone cannot prove these integration properties.
/// All credential-producing work and persistence must finish inside `exchange`;
/// escaped writers, remote revocation and other processes are outside this fence.
@MainActor
final class TransientFlowState<Session> {
    enum State: Equatable {
        case signedOut, authorizing, exchanging, draining, signedIn
        case failed(Failure)
    }

    enum Failure: Error, Equatable {
        case busy, invalidCorrelation, invalidCallback, providerError, exchangeFailed, stale
    }

    private struct Flow {
        let id: UUID
        let correlation: [UInt8]
        let revoke: @Sendable () -> Void
        let exchange: @MainActor (String) async throws -> Session
    }

    // Serializes cancellation with publication. Revocation is synchronous and
    // thread-safe, so it does not depend on MainActor becoming available.
    private final class CancellationFence: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false
        private let revoke: @Sendable () -> Void

        init(revoke: @escaping @Sendable () -> Void) { self.revoke = revoke }

        func cancel() {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { return }
            cancelled = true
            revoke()
        }

        func ifActive(_ body: () -> Void) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { return false }
            body()
            return true
        }
    }

    private let validator: TransientOAuthCallback
    private var flow: Flow?
    private var exchangeTask: Task<Session, Error>?
    private(set) var state: State = .signedOut
    private(set) var session: Session?

    init(validator: TransientOAuthCallback) {
        self.validator = validator
    }

    /// `revoke` must synchronously and permanently revoke this generation's
    /// fresh memory, from any thread. The adapter must not reuse that memory
    /// in another flow, and revocation must tolerate repeated calls.
    func start(correlation: String, revoke: @escaping @Sendable () -> Void,
               exchange: @escaping @MainActor (String) async throws -> Session) throws -> UUID {
        guard flow == nil, exchangeTask == nil, session == nil else { throw Failure.busy }
        guard !correlation.utf8.isEmpty else { throw Failure.invalidCorrelation }
        let id = UUID()
        flow = Flow(id: id, correlation: Array(correlation.utf8), revoke: revoke, exchange: exchange)
        state = .authorizing
        return id
    }

    /// Only the first valid, correctly associated callback starts an exchange.
    /// Rejecting a mismatched or malformed callback does not consume the flow.
    func receive(generation: UUID, correlation: String, callback: String) async throws -> Session {
        guard let current = flow, current.id == generation, state == .authorizing else { throw Failure.stale }
        guard current.correlation.elementsEqual(correlation.utf8) else { throw Failure.invalidCorrelation }
        guard !Task.isCancelled else {
            current.revoke()
            flow = nil
            state = .signedOut
            throw Failure.stale
        }
        let code: String
        do {
            code = try validator.code(from: callback)
        } catch TransientOAuthCallback.ValidationError.providerError {
            current.revoke()
            flow = nil
            state = .failed(.providerError)
            throw Failure.providerError
        } catch {
            throw Failure.invalidCallback
        }

        state = .exchanging // Consume before starting or awaiting the operation.
        let fence = CancellationFence(revoke: current.revoke)
        let task = Task { @MainActor in
            try Task.checkCancellation()
            return try await current.exchange(code)
        }
        exchangeTask = task
        return try await withTaskCancellationHandler {
            let result = await task.result
            // This point is reached only when the exchange itself has returned.
            exchangeTask = nil
            var completion: Result<Session, Failure>?
            let active = fence.ifActive {
                guard flow?.id == current.id, state == .exchanging, !Task.isCancelled else { return }
                switch result {
                case .success(let value):
                    session = value
                    state = .signedIn
                    completion = .success(value)
                case .failure:
                    current.revoke()
                    flow = nil
                    state = .failed(.exchangeFailed)
                    completion = .failure(.exchangeFailed)
                }
            }
            if active, let completion { return try completion.get() }
            if flow?.id == current.id { current.revoke(); flow = nil }
            state = .signedOut
            throw Failure.stale
        } onCancel: {
            fence.cancel()
            task.cancel()
            Task { @MainActor [weak self] in
                guard let self, self.flow?.id == current.id else { return }
                self.flow = nil
                self.session = nil
                self.state = self.exchangeTask == nil ? .signedOut : .draining
            }
        }
    }

    /// Synchronous invalidation: memory is revoked before this method returns.
    /// A cancelled exchange continues to own admission until it actually exits.
    func cancel() {
        flow?.revoke()
        flow = nil
        session = nil
        if let task = exchangeTask {
            state = .draining
            task.cancel()
        } else {
            state = .signedOut
        }
    }

    func logout() { cancel() }
}
