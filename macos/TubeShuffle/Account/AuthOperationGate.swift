import Foundation

// All credential-producing work, including its final persistence, must finish
// inside the supplied operation. Escaped tasks or other writers are not fenced.
// This is local-device invalidation, not remote revocation, and provides no
// cross-process or crash guarantee. Cancellation is a request, not a deadline.
@MainActor
final class AuthOperationGate {
    enum Failure: Error, Equatable {
        case busy
        case admissionClosed
        case invalidationInProgress
        case invalidationFailed
    }

    private enum Admission { case open, invalidating, failed }
    private var admission: Admission = .open
    private var active: (id: UUID, cancel: () -> Void, drain: () async -> Void)?
    private let invalidateLocalCredentials: @MainActor () async throws -> Void

    init(invalidateLocalCredentials: @escaping @MainActor () async throws -> Void) {
        self.invalidateLocalCredentials = invalidateLocalCredentials
    }

    // Concurrent restore/sign-in/refresh attempts are rejected, not queued.
    func run<Value>(_ operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        guard admission == .open else { throw Failure.admissionClosed }
        guard active == nil else { throw Failure.busy }
        let id = UUID()
        let task = Task { @MainActor in try await operation() }
        active = (id, { task.cancel() }, { _ = await task.result })
        defer {
            if active?.id == id { active = nil }
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    // On failure admission remains closed until an explicit successful retry.
    func signOutLocally() async throws {
        guard admission != .invalidating else { throw Failure.invalidationInProgress }
        admission = .invalidating // Close before the first suspension.
        let prior = active
        prior?.cancel()
        await prior?.drain() // Wait for actual completion, even if cancellation is ignored.
        if let prior = prior, active?.id == prior.id { active = nil }
        do {
            try await invalidateLocalCredentials()
            admission = .open
        } catch {
            admission = .failed
            // Do not expose provider errors, descriptions, or credentials.
            throw Failure.invalidationFailed
        }
    }
}
