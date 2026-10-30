import XCTest
@testable import TubeShuffle

@MainActor
final class AuthOperationGateTests: XCTestCase {
    private struct SecretError: Error, CustomStringConvertible {
        var description: String { "sensitive-provider-credential" }
    }

    private final class Fake {
        var persisted: String?
        var calls: [String] = []
        var pending: CheckedContinuation<Void, Never>?
        var started: (() -> Void)?
        var cancelled: (() -> Void)?
        var invalidated: (() -> Void)?
        var failInvalidation = false

        func exchange(_ name: String) async {
            calls.append(name)
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    pending = continuation
                    started?()
                }
            } onCancel: {
                Task { @MainActor in self.cancelled?() }
            }
            // Deliberately ignores cancellation and persists after resumption.
            persisted = "credential"
        }

        func finish() { let value = pending; pending = nil; value?.resume() }

        func invalidate() throws {
            calls.append("invalidate")
            invalidated?()
            if failInvalidation { throw SecretError() }
            persisted = nil
        }
    }

    func testSignOutDrainsDelayedExchangeAndRefreshBeforeInvalidation() async throws {
        for operation in ["exchange", "refresh"] {
            let fake = Fake()
            let gate = AuthOperationGate { try fake.invalidate() }
            let started = expectation(description: "operation started")
            let cancelled = expectation(description: "cancellation requested")
            fake.started = { started.fulfill() }
            fake.cancelled = { cancelled.fulfill() }
            let auth = Task { try await gate.run { await fake.exchange(operation) } }
            await fulfillment(of: [started], timeout: 1)
            let signOut = Task { try await gate.signOutLocally() }
            await fulfillment(of: [cancelled], timeout: 1)
            XCTAssertEqual(fake.calls, [operation])
            do {
                try await gate.run { XCTFail("admission must be closed") }
                XCTFail("expected closed admission")
            } catch let error as AuthOperationGate.Failure {
                XCTAssertEqual(error, .admissionClosed)
            }
            do {
                try await gate.signOutLocally()
                XCTFail("expected concurrent invalidation rejection")
            } catch let error as AuthOperationGate.Failure {
                XCTAssertEqual(error, .invalidationInProgress)
            }
            fake.finish()
            try await signOut.value
            // Do not wait for the original run() caller's deferred cleanup.
            let reopened = try await gate.run { "reopened" }
            XCTAssertEqual(reopened, "reopened")
            _ = try await auth.value
            XCTAssertEqual(fake.calls, [operation, "invalidate"])
            XCTAssertNil(fake.persisted)
        }
    }

    func testFailureIsSanitizedAndAdmissionStaysClosedUntilRetry() async throws {
        let fake = Fake()
        fake.persisted = "credential"
        fake.failInvalidation = true
        let gate = AuthOperationGate { try fake.invalidate() }
        do {
            try await gate.signOutLocally()
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? AuthOperationGate.Failure, .invalidationFailed)
            XCTAssertFalse(String(describing: error).contains("sensitive-provider-credential"))
        }
        do {
            try await gate.run { XCTFail("must remain blocked") }
            XCTFail("expected closed admission")
        } catch let error as AuthOperationGate.Failure {
            XCTAssertEqual(error, .admissionClosed)
        }
        XCTAssertEqual(fake.persisted, "credential")
        fake.failInvalidation = false
        try await gate.signOutLocally()
        XCTAssertNil(fake.persisted)
        let result = try await gate.run { 42 }
        XCTAssertEqual(result, 42)
        XCTAssertEqual(fake.calls, ["invalidate", "invalidate"])
    }

    func testConcurrentAuthenticationIsRejectedWhileOperationIsSuspended() async throws {
        let fake = Fake()
        let gate = AuthOperationGate { try fake.invalidate() }
        let started = expectation(description: "restore started")
        fake.started = { started.fulfill() }
        let first = Task { try await gate.run { await fake.exchange("restore") } }
        await fulfillment(of: [started], timeout: 1)
        for _ in 0..<2 {
            do {
                try await gate.run { XCTFail("overlapping operation ran") }
                XCTFail("expected busy")
            } catch let error as AuthOperationGate.Failure {
                XCTAssertEqual(error, .busy)
            }
        }
        XCTAssertEqual(fake.calls, ["restore"])
        fake.finish()
        try await first.value
        let result = try await gate.run { "next" }
        XCTAssertEqual(result, "next")
    }
}
