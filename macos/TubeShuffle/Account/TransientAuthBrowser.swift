import AppKit
import AuthenticationServices
import Foundation

@MainActor
protocol TransientAuthSession: AnyObject {
    func start() -> Bool
    func cancel()
}

@MainActor
private final class SystemAuthSession: TransientAuthSession {
    private let session: ASWebAuthenticationSession
    // AuthenticationServices does not own its presentation context provider.
    private let provider: ASWebAuthenticationPresentationContextProviding

    init(url: URL, callbackScheme: String, provider: ASWebAuthenticationPresentationContextProviding,
         completion: @escaping (URL?, Error?) -> Void) {
        self.provider = provider
        session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completion)
        session.presentationContextProvider = provider
        session.prefersEphemeralWebBrowserSession = true
    }

    func start() -> Bool { session.start() }
    func cancel() { session.cancel() }
}

@MainActor
private final class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    init(anchor: ASPresentationAnchor) { self.anchor = anchor }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor }
}

/// Browser transport only. The returned URL is untrusted and must be validated
/// and bound to the outstanding OAuth flow by the caller; never log it.
@MainActor
final class TransientAuthBrowser {
    enum Failure: Error, Equatable {
        case alreadyRunning, couldNotStart, cancelled, browserFailure, missingCallback, missingAnchor
    }

    typealias Factory = @MainActor (URL, String, ASWebAuthenticationPresentationContextProviding,
                                    @escaping (URL?, Error?) -> Void) -> any TransientAuthSession

    private weak var anchor: ASPresentationAnchor?
    private let factory: Factory
    private var session: (any TransientAuthSession)?
    private var pending: (id: UUID, continuation: CheckedContinuation<URL, Error>)?

    init(anchor: ASPresentationAnchor?, factory: @escaping Factory = { url, scheme, provider, completion in
        SystemAuthSession(url: url, callbackScheme: scheme, provider: provider, completion: completion)
    }) {
        self.anchor = anchor
        self.factory = factory
    }

    func start(url: URL, callbackScheme: String) async throws -> URL {
        guard pending == nil else { throw Failure.alreadyRunning }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: Failure.cancelled)
                    return
                }
                guard let anchor else {
                    continuation.resume(throwing: Failure.missingAnchor)
                    return
                }
                pending = (id, continuation)
                let context = AuthPresentationContext(anchor: anchor)
                let browserSession = factory(url, callbackScheme, context) { [weak self] url, error in
                    // Do not retain or expose the OS error, which may contain sensitive text.
                    let result: Result<URL, Failure>
                    if let error = error as NSError? {
                        if error.domain == ASWebAuthenticationSessionErrorDomain &&
                            error.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                            result = .failure(.cancelled)
                        } else {
                            result = .failure(.browserFailure)
                        }
                    }
                    else if let url = url { result = .success(url) }
                    else { result = .failure(.missingCallback) }
                    Task { @MainActor [weak self] in self?.finish(id: id, result: result) }
                }
                session = browserSession
                guard !Task.isCancelled else {
                    cancel(id: id)
                    return
                }
                if !browserSession.start() { finish(id: id, result: .failure(.couldNotStart)) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id: id) }
        }
    }

    func cancel() {
        guard let id = pending?.id else { return }
        cancel(id: id)
    }

    private func cancel(id: UUID) {
        guard pending?.id == id else { return }
        let active = session
        active?.cancel()
        finish(id: id, result: .failure(.cancelled))
    }

    private func finish(id: UUID, result: Result<URL, Failure>) {
        guard let current = pending, current.id == id else { return }
        pending = nil
        session = nil
        current.continuation.resume(with: result.mapError { $0 as Error })
    }
}
