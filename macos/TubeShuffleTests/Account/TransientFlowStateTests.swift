import Foundation
import XCTest
@testable import TubeShuffle

@MainActor
final class TransientFlowStateTests: XCTestCase {
    private let redirect = "example-app://auth.example/callback"

    private func controller() throws -> TransientFlowState<String> {
        TransientFlowState(validator: try TransientOAuthCallback(redirect: redirect))
    }

    private func rejected(_ expected: TransientFlowState<String>.Failure,
                          _ action: () async throws -> String) async {
        do { _ = try await action(); XCTFail("Expected rejection") }
        catch { XCTAssertEqual(error as? TransientFlowState<String>.Failure, expected) }
    }

    func testCorrelationGenerationReplayAndSuccessfulLogin() async throws {
        let subject = try controller()
        let old = RevocableSessionMemory()
        let first = try subject.start(correlation: "old", revoke: { old.revokeAndClear() }, exchange: { $0 })
        subject.cancel()
        let memory = RevocableSessionMemory()
        var codes: [String] = []
        let current = try subject.start(correlation: "\u{00e9}", revoke: { memory.revokeAndClear() }) { code in
            codes.append(code)
            return "session"
        }
        let callback = redirect + "?code=secret"
        await rejected(.stale) { try await subject.receive(generation: first, correlation: "old", callback: callback) }
        await rejected(.invalidCorrelation) { try await subject.receive(generation: current, correlation: "e\u{0301}", callback: callback) }
        await rejected(.invalidCorrelation) { try await subject.receive(generation: current, correlation: "old", callback: callback) }
        await rejected(.invalidCallback) { try await subject.receive(generation: current, correlation: "\u{00e9}", callback: self.redirect + "?code=") }
        XCTAssertTrue(codes.isEmpty)
        let result = try await subject.receive(generation: current, correlation: "\u{00e9}", callback: callback)
        XCTAssertEqual(result, "session")
        XCTAssertEqual(subject.session, "session")
        XCTAssertEqual(subject.state, .signedIn)
        XCTAssertEqual(codes, ["secret"])
        await rejected(.stale) { try await subject.receive(generation: current, correlation: "\u{00e9}", callback: callback) }
        subject.logout()
        XCTAssertNil(subject.session)
        XCTAssertThrowsError(try memory.store(key: "late", value: Data()))
    }

    func testCancelAndLogoutDrainIgnoringCancellation() async throws {
        for useLogout in [false, true] {
            let subject = try controller()
            let memory = RevocableSessionMemory()
            try memory.store(key: "session", value: Data([1]))
            let started = expectation(description: "exchange started")
            var continuation: CheckedContinuation<String, Never>?
            let id = try subject.start(correlation: "one", revoke: { memory.revokeAndClear() }) { _ in
                await withCheckedContinuation { pending in
                    continuation = pending
                    started.fulfill()
                }
            }
            let receive = Task { @MainActor in
                try await subject.receive(generation: id, correlation: "one", callback: self.redirect + "?code=one")
            }
            await fulfillment(of: [started], timeout: 1)
            await rejected(.stale) { try await subject.receive(generation: id, correlation: "one", callback: self.redirect + "?code=two") }
            if useLogout { subject.logout() } else { subject.cancel() }
            XCTAssertEqual(subject.state, .draining)
            XCTAssertNil(try memory.retrieve(key: "session"))
            XCTAssertThrowsError(try memory.store(key: "late", value: Data([2])))
            XCTAssertThrowsError(try subject.start(correlation: "two", revoke: {}, exchange: { $0 })) {
                XCTAssertEqual($0 as? TransientFlowState<String>.Failure, .busy)
            }
            continuation?.resume(returning: "late session")
            do { _ = try await receive.value; XCTFail("Late result accepted") }
            catch { XCTAssertEqual(error as? TransientFlowState<String>.Failure, .stale) }
            XCTAssertNil(subject.session)
            XCTAssertEqual(subject.state, .signedOut)
            XCTAssertNoThrow(try subject.start(correlation: "two", revoke: {}, exchange: { $0 }))
        }
    }

    func testProviderErrorConsumesFlowAndRejectsAllReplay() async throws {
        let subject = try controller()
        let memory = RevocableSessionMemory()
        let id = try subject.start(correlation: "correlation", revoke: { memory.revokeAndClear() }, exchange: { $0 })
        let error = redirect + "?error=private-secret"
        await rejected(.providerError) {
            try await subject.receive(generation: id, correlation: "correlation", callback: error)
        }
        XCTAssertEqual(subject.state, .failed(.providerError))
        XCTAssertThrowsError(try memory.store(key: "late", value: Data()))
        await rejected(.stale) { try await subject.receive(generation: id, correlation: "correlation", callback: error) }
        await rejected(.stale) { try await subject.receive(generation: id, correlation: "correlation", callback: self.redirect + "?code=replay") }
    }

    func testPreCancelledReceiveNeverDispatchesExchange() async throws {
        let subject = try controller()
        let memory = RevocableSessionMemory()
        var dispatched = false
        let id = try subject.start(correlation: "one", revoke: { memory.revokeAndClear() }) { _ in
            dispatched = true
            return "session"
        }
        let receive = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await subject.receive(generation: id, correlation: "one", callback: self.redirect + "?code=one")
        }
        do { _ = try await receive.value; XCTFail("Expected rejection") }
        catch { XCTAssertEqual(error as? TransientFlowState<String>.Failure, .stale) }
        XCTAssertFalse(dispatched)
        XCTAssertThrowsError(try memory.store(key: "late", value: Data()))
        XCTAssertEqual(subject.state, .signedOut)
    }

    func testCallerCancellationRevokesBeforeMainActorCanRunAndDrainsExchange() async throws {
        let subject = try controller()
        let memory = RevocableSessionMemory()
        try memory.store(key: "session", value: Data([1]))
        let started = expectation(description: "exchange started")
        var continuation: CheckedContinuation<Void, Never>?
        let id = try subject.start(correlation: "one", revoke: { memory.revokeAndClear() }) { _ in
            await withCheckedContinuation { pending in
                continuation = pending
                started.fulfill()
            }
            XCTAssertTrue(Task.isCancelled)
            XCTAssertThrowsError(try memory.store(key: "late", value: Data([2])))
            return "late session"
        }
        let receive = Task { @MainActor in
            try await subject.receive(generation: id, correlation: "one", callback: self.redirect + "?code=one")
        }
        await fulfillment(of: [started], timeout: 1)
        // Block this actor until cancellation has returned on another thread.
        // No queued MainActor cleanup can run before these memory assertions.
        let cancelled = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { receive.cancel(); cancelled.signal() }
        XCTAssertEqual(cancelled.wait(timeout: .now() + 2), .success)
        XCTAssertNil(try memory.retrieve(key: "session"))
        XCTAssertThrowsError(try memory.store(key: "immediate", value: Data()))
        XCTAssertThrowsError(try subject.start(correlation: "two", revoke: {}, exchange: { $0 })) {
            XCTAssertEqual($0 as? TransientFlowState<String>.Failure, .busy)
        }
        continuation?.resume()
        do { _ = try await receive.value; XCTFail("Late result accepted") }
        catch { XCTAssertEqual(error as? TransientFlowState<String>.Failure, .stale) }
        XCTAssertNil(subject.session)
        XCTAssertEqual(subject.state, .signedOut)
        XCTAssertNoThrow(try subject.start(correlation: "two", revoke: {}, exchange: { $0 }))
    }

    func testErrorsAreSanitizedAndFailedExchangeRevokesMemory() async throws {
        struct SecretError: Error { let secret = "private-secret" }
        let subject = try controller()
        let memory = RevocableSessionMemory()
        let id = try subject.start(correlation: "correlation", revoke: { memory.revokeAndClear() }) { _ in throw SecretError() }
        await rejected(.exchangeFailed) {
            try await subject.receive(generation: id, correlation: "correlation", callback: self.redirect + "?code=private-secret")
        }
        XCTAssertEqual(subject.state, .failed(.exchangeFailed))
        XCTAssertNil(subject.session)
        XCTAssertThrowsError(try memory.store(key: "late", value: Data()))
    }
}
