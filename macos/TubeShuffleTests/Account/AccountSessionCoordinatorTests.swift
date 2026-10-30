import XCTest
@testable import TubeShuffle

@MainActor
final class AccountSessionCoordinatorTests: XCTestCase {
    enum Failure: Error { case secretBearingError }

    final class Auth: AccountAuthenticationService {
        var called: (() -> Void)?
        var pending: CheckedContinuation<AccountSession?, Error>?
        var calls: [String] = []
        var epoch = 0
        var persisted: String?
        var suspendSignOut = false
        var signOutCalled: (() -> Void)?
        var pendingSignOut: CheckedContinuation<Void, Error>?
        func restore() async throws -> AccountSession? { try await wait("restore") }
        func signIn() async throws -> AccountSession { try await wait("signIn")! }
        func refresh(_ session: AccountSession) async throws -> AccountSession { try await wait("refresh")! }
        func signOut() async throws {
            calls.append("signOut")
            epoch += 1
            if suspendSignOut {
                try await withCheckedThrowingContinuation { continuation in
                    pendingSignOut = continuation
                    signOutCalled?()
                }
            }
            persisted = nil
        }
        private func wait(_ name: String) async throws -> AccountSession? {
            calls.append(name)
            let started = epoch
            let result: AccountSession? = try await withCheckedThrowingContinuation { continuation in
                pending = continuation
                called?()
            }
            if started == epoch { persisted = result?.bearer }
            return result
        }
        func finishSignOut(failing: Bool = false) {
            let continuation = pendingSignOut; pendingSignOut = nil
            if failing { continuation?.resume(throwing: Failure.secretBearingError) }
            else { continuation?.resume(returning: ()) }
        }
        func finish(_ token: String?, accountID: String? = nil) {
            let continuation = pending; pending = nil
            continuation?.resume(returning: token.map { AccountSession(bearer: $0, accountID: accountID ?? $0) })
        }
        func fail() { let continuation = pending; pending = nil; continuation?.resume(throwing: Failure.secretBearingError) }
    }

    final class Links: AccountLinkService {
        var called: (() -> Void)?
        var pending: [(String, CheckedContinuation<PlaylistLinkDTO?, Error>)] = []
        var calls: [String] = []
        var bearers: [String] = []
        let link = PlaylistLinkDTO(youtubePlaylistId: "abcdefghij", createdAt: "2026-01-01T00:00:00.000Z")
        func list(bearer: String) async throws -> AccountLinkPage {
            let result = try await wait("list", bearer)
            return AccountLinkPage(links: result.map { [$0] } ?? [], completeness: .serverTraversalCompleteNonSnapshot)
        }
        func save(_ playlistID: String, bearer: String) async throws -> PlaylistLinkDTO {
            try await wait("save", bearer)!
        }
        func unlink(_ playlistID: String, bearer: String) async throws { _ = try await wait("unlink", bearer) }
        private func wait(_ name: String, _ bearer: String) async throws -> PlaylistLinkDTO? {
            calls.append(name); bearers.append(bearer)
            return try await withCheckedThrowingContinuation { continuation in
                pending.append((name, continuation))
                called?()
            }
        }
        func finish(_ name: String? = nil) { take(name)?.resume(returning: link) }
        func fail(_ name: String? = nil) { take(name)?.resume(throwing: Failure.secretBearingError) }
        private func take(_ name: String?) -> CheckedContinuation<PlaylistLinkDTO?, Error>? {
            guard let index = pending.firstIndex(where: { name == nil || $0.0 == name }) else { return nil }
            return pending.remove(at: index).1
        }
    }

    // Models only writers contained within the gate, not an SDK or Keychain fence.
    final class GatedAuth: AccountAuthenticationService {
        var persisted: String?
        var calls: [String] = []
        var pending: CheckedContinuation<Void, Never>?
        var started: (() -> Void)?
        var cancelled: (() -> Void)?
        lazy var gate = AuthOperationGate { [unowned self] in
            self.calls.append("invalidate")
            self.persisted = nil
        }

        func restore() async throws -> AccountSession? { try await exchange("restore") }
        func signIn() async throws -> AccountSession { try await exchange("signIn") }
        func refresh(_ session: AccountSession) async throws -> AccountSession { try await exchange("refresh") }
        func signOut() async throws { try await gate.signOutLocally() }

        private func exchange(_ name: String) async throws -> AccountSession {
            try await gate.run {
                self.calls.append(name)
                await withTaskCancellationHandler {
                    await withCheckedContinuation { continuation in
                        self.pending = continuation
                        self.started?()
                    }
                } onCancel: {
                    Task { @MainActor in self.cancelled?() }
                }
                // Intentionally noncooperative, including the final credential write.
                self.persisted = name
                return AccountSession(bearer: name, accountID: name)
            }
        }

        func finish() { let continuation = pending; pending = nil; continuation?.resume() }
    }

    func testGatedAuthenticationRejectsOverlapAndSignOutDrainsBeforeNextAttempt() async {
        let auth = GatedAuth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        defer { auth.finish() }
        let started = expectation(description: "first authentication started")
        let cancelled = expectation(description: "first authentication cancelled")
        auth.started = { started.fulfill() }
        auth.cancelled = { cancelled.fulfill() }
        let first = Task { await coordinator.signIn() }
        await fulfillment(of: [started], timeout: 1)
        await coordinator.restore()
        await coordinator.signIn()
        await coordinator.refresh()
        XCTAssertEqual(auth.calls, ["signIn"])
        XCTAssertEqual(coordinator.state, .restoring)

        let signOut = Task { await coordinator.signOut() }
        await fulfillment(of: [cancelled], timeout: 1)
        XCTAssertEqual(coordinator.state, .invalidating)
        await coordinator.signIn()
        XCTAssertEqual(auth.calls, ["signIn"])
        auth.finish()
        let signedOut = await signOut.value
        XCTAssertTrue(signedOut)
        await first.value
        XCTAssertNil(auth.persisted)
        XCTAssertEqual(auth.calls, ["signIn", "invalidate"])

        let laterStarted = expectation(description: "later authentication started")
        auth.started = { laterStarted.fulfill() }
        auth.cancelled = nil
        let later = Task { await coordinator.restore() }
        await fulfillment(of: [laterStarted], timeout: 1)
        auth.finish()
        await later.value
        XCTAssertEqual(coordinator.state, .signedIn)
        XCTAssertEqual(auth.persisted, "restore")
        XCTAssertEqual(auth.calls, ["signIn", "invalidate", "restore"])
    }

    func testCancelledAuthenticationRequiresSignOutAfterActualCompletion() async {
        let auth = GatedAuth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        defer { auth.finish() }
        let started = expectation(description: "authentication started")
        let cancelled = expectation(description: "cancellation requested")
        auth.started = { started.fulfill() }
        auth.cancelled = { cancelled.fulfill() }
        let attempt = Task { await coordinator.restore() }
        await fulfillment(of: [started], timeout: 1)
        attempt.cancel()
        await fulfillment(of: [cancelled], timeout: 1)
        XCTAssertEqual(coordinator.state, .restoring)
        await coordinator.signIn()
        XCTAssertEqual(auth.calls, ["restore"])
        auth.finish()
        await attempt.value
        XCTAssertEqual(coordinator.state, .recoverableError(.authenticationCancelled))
        await coordinator.signIn()
        XCTAssertEqual(auth.calls, ["restore"])
        let signedOut = await coordinator.signOut()
        XCTAssertTrue(signedOut)
        XCTAssertNil(auth.persisted)
        XCTAssertEqual(coordinator.state, .signedOut)
    }

    func testExplicitCallsAndSessionTransitions() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        if case .unavailable = await coordinator.list() {} else { XCTFail() }
        XCTAssertTrue(links.calls.isEmpty)
        let called = expectation(description: "restore")
        auth.called = { called.fulfill() }
        let restore = Task { await coordinator.restore() }
        await fulfillment(of: [called], timeout: 1)
        XCTAssertEqual(coordinator.state, .restoring)
        auth.finish("token")
        await restore.value
        XCTAssertEqual(coordinator.state, .signedIn)
        XCTAssertTrue(links.calls.isEmpty)
        let listed = expectation(description: "list")
        links.called = { listed.fulfill() }
        let list = Task { await coordinator.list() }
        await fulfillment(of: [listed], timeout: 1)
        links.finish()
        if case .success(let page) = await list.value {
            XCTAssertEqual(page.links, [links.link])
            XCTAssertEqual(page.completeness, .serverTraversalCompleteNonSnapshot)
        } else { XCTFail() }
        XCTAssertEqual(links.calls, ["list"])
        XCTAssertEqual(links.bearers, ["token"])
        await coordinator.signOut()
        XCTAssertEqual(coordinator.state, .signedOut)
    }

    func testAuthenticationFailuresAndEmptyBearer() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        for token in ["", "  ", " token", "token\n", "a=b", "=", "tökén", "a,b"] {
            let called = expectation(description: "sign in")
            auth.called = { called.fulfill() }
            let task = Task { await coordinator.signIn() }
            await fulfillment(of: [called], timeout: 1)
            auth.finish(token); await task.value
            XCTAssertEqual(coordinator.state, .recoverableError(.invalidCredential))
            if case .unavailable = await coordinator.save("abcdefghij") {} else { XCTFail() }
        }
        let called = expectation(description: "failure")
        auth.called = { called.fulfill() }
        let task = Task { await coordinator.restore() }
        await fulfillment(of: [called], timeout: 1)
        auth.fail(); await task.value
        XCTAssertEqual(coordinator.state, .recoverableError(.authentication))
        XCTAssertTrue(links.calls.isEmpty)
    }

    func testSignOutFencesPendingSignInAndRejectsOperationsUntilComplete() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        let started = expectation(description: "sign in started")
        auth.called = { started.fulfill() }
        let signIn = Task { await coordinator.signIn() }
        await fulfillment(of: [started], timeout: 1)

        auth.suspendSignOut = true
        let invalidating = expectation(description: "invalidating")
        auth.signOutCalled = { invalidating.fulfill() }
        let signOut = Task { await coordinator.signOut() }
        await fulfillment(of: [invalidating], timeout: 1)
        XCTAssertEqual(coordinator.state, .invalidating)
        let concurrent = await coordinator.signOut()
        XCTAssertFalse(concurrent)
        await coordinator.restore()
        await coordinator.signIn()
        await coordinator.refresh()
        if case .unavailable = await coordinator.list() {} else { XCTFail() }
        if case .unavailable = await coordinator.save("abcdefghij") {} else { XCTFail() }
        if case .unavailable = await coordinator.unlink("abcdefghij") {} else { XCTFail() }
        XCTAssertEqual(auth.calls, ["signIn", "signOut"])
        XCTAssertTrue(links.calls.isEmpty)
        XCTAssertEqual(coordinator.state, .invalidating)

        auth.finishSignOut()
        let succeeded = await signOut.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(coordinator.state, .signedOut)
        auth.finish("late-token")
        await signIn.value
        XCTAssertNil(auth.persisted)
        XCTAssertEqual(coordinator.state, .signedOut)
    }

    func testFailedInvalidationBlocksAuthenticationUntilExplicitRetry() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        XCTAssertEqual(auth.persisted, "old")
        auth.suspendSignOut = true
        let failed = expectation(description: "first invalidation")
        auth.signOutCalled = { failed.fulfill() }
        let first = Task { await coordinator.signOut() }
        await fulfillment(of: [failed], timeout: 1)
        auth.finishSignOut(failing: true)
        let firstResult = await first.value
        XCTAssertFalse(firstResult)
        XCTAssertEqual(coordinator.state, .recoverableError(.invalidationFailed))
        await coordinator.restore()
        await coordinator.signIn()
        await coordinator.refresh()
        if case .unavailable = await coordinator.list() {} else { XCTFail() }
        XCTAssertEqual(auth.calls, ["signIn", "signOut"])
        XCTAssertTrue(links.calls.isEmpty)
        XCTAssertEqual(coordinator.state, .recoverableError(.invalidationFailed))

        let retried = expectation(description: "retry invalidation")
        auth.signOutCalled = { retried.fulfill() }
        let retry = Task { await coordinator.signOut() }
        await fulfillment(of: [retried], timeout: 1)
        XCTAssertEqual(coordinator.state, .invalidating)
        auth.finishSignOut()
        let retryResult = await retry.value
        XCTAssertTrue(retryResult)
        XCTAssertNil(auth.persisted)
        XCTAssertEqual(coordinator.state, .signedOut)
        await establish(coordinator, auth, token: "new")
        XCTAssertEqual(auth.persisted, "new")
    }

    func testLateAuthenticationCannotReplaceNewSession() async {
        for operation in ["restore", "signIn", "refresh"] {
            let auth = Auth(), links = Links()
            let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
            if operation == "refresh" { await establish(coordinator, auth) }
            let called = expectation(description: operation)
            auth.called = { called.fulfill() }
            let old = Task {
                switch operation {
                case "restore": await coordinator.restore()
                case "signIn": await coordinator.signIn()
                default: await coordinator.refresh()
                }
            }
            await fulfillment(of: [called], timeout: 1)
            let oldContinuation = auth.pending; auth.pending = nil
            await coordinator.signOut()
            await establish(coordinator, auth, token: "new")
            oldContinuation?.resume(returning: AccountSession(bearer: "old", accountID: "old"))
            await old.value
            XCTAssertEqual(coordinator.state, .signedIn)
            let listed = expectation(description: "new token")
            links.called = { listed.fulfill() }
            let list = Task { await coordinator.list() }
            await fulfillment(of: [listed], timeout: 1)
            links.finish(); _ = await list.value
            XCTAssertEqual(links.bearers, ["new"])
        }
    }

    func testLateLinkOperationsAndUncertainMutations() async {
        for operation in ["list", "save", "unlink"] {
            let auth = Auth(), links = Links()
            let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
            await establish(coordinator, auth)
            let called = expectation(description: operation)
            links.called = { called.fulfill() }
            let old = Task {
                switch operation {
                case "list":
                    if case .unavailable = await coordinator.list() { return true }; return false
                case "save":
                    if case .mutationOutcomeUnknown = await coordinator.save("abcdefghij") { return true }; return false
                default:
                    if case .mutationOutcomeUnknown = await coordinator.unlink("abcdefghij") { return true }; return false
                }
            }
            await fulfillment(of: [called], timeout: 1)
            await coordinator.signOut()
            await establish(coordinator, auth, token: "new")
            links.finish()
            let discarded = await old.value
            XCTAssertTrue(discarded)
            XCTAssertEqual(coordinator.state, .signedIn)
            XCTAssertEqual(links.calls, [operation]) // no replay or implicit list
        }
    }

    func testLinkFailuresAreSanitizedAndNotRetried() async {
        for operation in ["list", "save", "unlink"] {
            let auth = Auth(), links = Links()
            let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
            await establish(coordinator, auth)
            let called = expectation(description: operation)
            links.called = { called.fulfill() }
            let task = Task {
                switch operation {
                case "list": _ = await coordinator.list()
                case "save": _ = await coordinator.save("abcdefghij")
                default: _ = await coordinator.unlink("abcdefghij")
                }
            }
            await fulfillment(of: [called], timeout: 1)
            links.fail(); await task.value
            XCTAssertEqual(coordinator.state, .recoverableError(operation == "list" ? .links : .mutationOutcomeUnknown))
            XCTAssertEqual(links.calls, [operation])
        }
    }

    func testConcurrentSuccessDoesNotClearMutationUncertainty() async {
        for failureFirst in [true, false] {
            let auth = Auth(), links = Links()
            let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
            await establish(coordinator, auth)
            let started = expectation(description: "both dispatched")
            started.expectedFulfillmentCount = 2
            links.called = { started.fulfill() }
            let mutation = Task { await coordinator.unlink("abcdefghij") }
            let list = Task { await coordinator.list() }
            await fulfillment(of: [started], timeout: 1)
            if failureFirst {
                links.fail("unlink"); _ = await mutation.value
                links.finish("list"); _ = await list.value
            } else {
                links.finish("list"); _ = await list.value
                links.fail("unlink"); _ = await mutation.value
            }
            XCTAssertTrue(coordinator.hasUncertainMutations)
            let saved = expectation(description: "save dispatched")
            links.called = { saved.fulfill() }
            let save = Task { await coordinator.save("abcdefghij") }
            await fulfillment(of: [saved], timeout: 1)
            links.finish("save"); _ = await save.value
            XCTAssertTrue(coordinator.hasUncertainMutations)
            coordinator.acknowledgeMutationUncertainty()
            XCTAssertFalse(coordinator.hasUncertainMutations)
            XCTAssertEqual(links.calls.filter { $0 == "unlink" }.count, 1)
        }
    }

    func testCancelledMutationAndAccountIsolationAcrossGenerations() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        let called = expectation(description: "mutation dispatched")
        links.called = { called.fulfill() }
        let mutation = Task { await coordinator.save("abcdefghij") }
        await fulfillment(of: [called], timeout: 1)
        await coordinator.signOut()
        await establish(coordinator, auth, token: "new")
        XCTAssertFalse(coordinator.hasUncertainMutations)
        links.finish("save")
        if case .mutationOutcomeUnknown = await mutation.value {} else { XCTFail() }
        XCTAssertFalse(coordinator.hasUncertainMutations)
        await coordinator.signOut()
        await establish(coordinator, auth, token: "old")
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertFalse(coordinator.hasUncertainMutations)
        XCTAssertEqual(links.calls, ["save"])
    }

    func testCallerCancellationLeavesUncertaintyEvenIfServiceSucceeds() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        let called = expectation(description: "mutation dispatched")
        links.called = { called.fulfill() }
        let mutation = Task { await coordinator.unlink("abcdefghij") }
        await fulfillment(of: [called], timeout: 1)
        mutation.cancel()
        links.finish("unlink")
        if case .mutationOutcomeUnknown = await mutation.value {} else { XCTFail() }
        XCTAssertTrue(coordinator.hasUncertainMutations)
    }

    func testPendingCancellationIsImmediatelyConservativeAndCannotBeAcknowledged() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        let called = expectation(description: "mutation dispatched")
        links.called = { called.fulfill() }
        let mutation = Task { await coordinator.unlink("abcdefghij") }
        await fulfillment(of: [called], timeout: 1)
        XCTAssertTrue(coordinator.hasUncertainMutations)
        mutation.cancel()
        // No actor suspension between cancellation and observation: the
        // cancellation handler's MainActor task cannot have run yet.
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertTrue(coordinator.hasUncertainMutations)
        links.finish("unlink")
        if case .mutationOutcomeUnknown = await mutation.value {} else { XCTFail() }
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertFalse(coordinator.hasUncertainMutations)
    }

    func testRefreshPreservesPendingUncertaintyForSameAccountBeforeLateResponse() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        let called = expectation(description: "mutation dispatched")
        links.called = { called.fulfill() }
        let mutation = Task { await coordinator.save("abcdefghij") }
        await fulfillment(of: [called], timeout: 1)
        let refreshing = expectation(description: "refresh dispatched")
        auth.called = { refreshing.fulfill() }
        let refresh = Task { await coordinator.refresh() }
        await fulfillment(of: [refreshing], timeout: 1)
        auth.finish("rotated", accountID: "old")
        await refresh.value
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertTrue(coordinator.hasUncertainMutations)
        links.finish("save")
        if case .mutationOutcomeUnknown = await mutation.value {} else { XCTFail() }
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertFalse(coordinator.hasUncertainMutations)
        XCTAssertEqual(coordinator.state, .signedIn)
        XCTAssertEqual(links.calls, ["save"])
    }

    func testAcknowledgementKeepsEachPendingMutationAcrossGenerationsAndAccounts() async {
        let auth = Auth(), links = Links()
        let coordinator = AccountSessionCoordinator(authentication: auth, links: links)
        await establish(coordinator, auth)
        let started = expectation(description: "both mutations dispatched")
        started.expectedFulfillmentCount = 2
        links.called = { started.fulfill() }
        let save = Task { await coordinator.save("abcdefghij") }
        let unlink = Task { await coordinator.unlink("abcdefghij") }
        await fulfillment(of: [started], timeout: 1)

        let refreshing = expectation(description: "refresh dispatched")
        auth.called = { refreshing.fulfill() }
        let refresh = Task { await coordinator.refresh() }
        await fulfillment(of: [refreshing], timeout: 1)
        auth.finish("rotated", accountID: "old")
        await refresh.value
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertTrue(coordinator.hasUncertainMutations)

        links.finish("save")
        if case .mutationOutcomeUnknown = await save.value {} else { XCTFail() }
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertTrue(coordinator.hasUncertainMutations) // unlink is still pending

        await coordinator.signOut()
        await establish(coordinator, auth, token: "other")
        XCTAssertFalse(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty() // cannot acknowledge old account
        links.fail("unlink")
        if case .mutationOutcomeUnknown = await unlink.value {} else { XCTFail() }
        XCTAssertFalse(coordinator.hasUncertainMutations)

        await coordinator.signOut()
        await establish(coordinator, auth, token: "old")
        XCTAssertTrue(coordinator.hasUncertainMutations)
        coordinator.acknowledgeMutationUncertainty()
        XCTAssertFalse(coordinator.hasUncertainMutations)
        XCTAssertEqual(links.calls.filter { $0 == "save" }.count, 1)
        XCTAssertEqual(links.calls.filter { $0 == "unlink" }.count, 1)
        XCTAssertEqual(links.calls.count, 2) // no replay or implicit list
    }

    private func establish(_ coordinator: AccountSessionCoordinator, _ auth: Auth, token: String = "old") async {
        let called = expectation(description: "establish")
        auth.called = { called.fulfill() }
        let task = Task { await coordinator.signIn() }
        await fulfillment(of: [called], timeout: 1)
        auth.finish(token); await task.value
        XCTAssertEqual(coordinator.state, .signedIn)
    }
}
