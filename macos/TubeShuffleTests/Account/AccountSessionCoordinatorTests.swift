import AppKit
import Auth
import Combine
import Foundation
import XCTest
@testable import TubeShuffle

// Test-target-only bridge: this synthetic label assumes server traversal completion;
// it does not exercise pagination or prove a consistent server snapshot.
@MainActor
private struct SyntheticAPIAccountLinkService: AccountLinkService {
    let client: APIClient

    func list(bearer: String) async throws -> AccountLinkPage {
        let response = try await client.links(bearer: bearer)
        return AccountLinkPage(links: response.links, completeness: .serverTraversalCompleteNonSnapshot)
    }

    func save(_ playlistID: String, bearer: String) async throws -> PlaylistLinkDTO {
        try await client.saveLink(playlistID, bearer: bearer).link
    }

    func unlink(_ playlistID: String, bearer: String) async throws {
        try await client.deleteLink(playlistID, bearer: bearer)
    }
}

@MainActor
final class AccountSessionCoordinatorTests: XCTestCase {
    func testBundledTubeShuffleSetupRequiresExplicitLoadingAndDoesNotSignIn() async throws {
        let model = NativeAccountModel()
        XCTAssertEqual(model.apiURL, "")
        XCTAssertFalse(model.configured)
        XCTAssertFalse(model.canFetchPlaylists)
        XCTAssertTrue(model.loadTubeShuffleSetup())
        XCTAssertEqual(model.apiURL, "https://www.tubeshuffle.online")
        XCTAssertEqual(model.supabaseURL, "https://rkgbxjwmnlsmguhctguf.supabase.co")
        XCTAssertTrue(model.publishableKey.hasPrefix("sb_publishable_"))
        XCTAssertFalse(model.configured)
        XCTAssertEqual(model.state, .signedOut)
        XCTAssertFalse(model.busy)
        let result = await model.fetchPlaylist("PLSyntheticImport0001")
        XCTAssertNil(result)
        XCTAssertFalse(model.canFetchPlaylists)
    }

    func testPublicSetupRoundTripDoesNotConfigureOrStartAccount() throws {
        let configuration = try NativeAccountConfiguration(supabaseOrigin: URL(string: "https://example.supabase.co")!,
            publishableKey: "sb_publishable_abcdefghijklmnopqrstuv", applicationAPIOrigin: URL(string: "https://example.test")!)
        let data = try NativeAccountSetupDocument.encode(configuration)
        XCTAssertEqual(try NativeAccountSetupDocument.decode(data), configuration)
        let model = NativeAccountModel()
        try model.applySetup(data)
        XCTAssertEqual(model.apiURL, "https://example.test")
        XCTAssertFalse(model.configured)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.state, .signedOut)
    }

    func testPublicSetupRejectsUnknownFieldsDuplicatesAndOversizedInput() throws {
        let valid = "{\"format\":\"tubeshuffle-account-setup\",\"version\":1,\"supabaseOrigin\":\"https://example.supabase.co\",\"publishableKey\":\"sb_publishable_abcdefghijklmnopqrstuv\",\"applicationAPIOrigin\":\"https://example.test\"}"
        for invalid in [valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"token\":\"do-not-import\""),
                        valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1"),
                        valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1.00000000000000001"),
                        valid.replacingOccurrences(of: "sb_publishable_abcdefghijklmnopqrstuv", with: "sb_secret_abcdefghijklmnopqrstuv"),
                        valid.replacingOccurrences(of: "https://example.test", with: "http://example.test"),
                        valid + String(repeating: " ", count: 8_192)] {
            XCTAssertThrowsError(try NativeAccountSetupDocument.decode(Data(invalid.utf8)))
        }
        let oversized = try NativeAccountConfiguration(supabaseOrigin: URL(string: "https://example.supabase.co")!,
            publishableKey: "sb_publishable_" + String(repeating: "a", count: 8_192),
            applicationAPIOrigin: URL(string: "https://example.test")!)
        XCTAssertThrowsError(try NativeAccountSetupDocument.encode(oversized))
    }

    func testInvalidPublicSetupKeepsCurrentFormValues() {
        let model = NativeAccountModel()
        model.apiURL = "https://previous.test"
        XCTAssertThrowsError(try model.applySetup(Data("{}".utf8)))
        XCTAssertEqual(model.apiURL, "https://previous.test")
        XCTAssertFalse(model.configured)
    }

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

@MainActor
private final class SyntheticAccountAuth: AccountAuthenticationService {
    private(set) var signInCount = 0
    func restore() async throws -> AccountSession? { try await signIn() }
    func signIn() async throws -> AccountSession {
        signInCount += 1
        return AccountSession(bearer: "synthetic-token-\(signInCount)", accountID: "synthetic-account-\(signInCount)")
    }
    func refresh(_ session: AccountSession) async throws -> AccountSession { session }
    func signOut() async throws {}
}

// Never performs I/O and intentionally ignores cancellation while a response is held.
private actor SyntheticAccountTransport: APITransport {
    private(set) var requests: [URLRequest] = []
    var status: Int = 200
    var body = ""
    var hold = false
    var started: XCTestExpectation?
    private var failure: URLError?
    private var pending: CheckedContinuation<(Data, URLResponse), Error>?
    private var heldRequest: URLRequest?

    func configure(status: Int, body: String, hold: Bool = false, started: XCTestExpectation? = nil, failure: URLError? = nil) {
        self.status = status; self.body = body; self.hold = hold; self.started = started
        self.failure = failure
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        if let failure { throw failure }
        if hold {
            return try await withCheckedThrowingContinuation { continuation in
                pending = continuation; heldRequest = request; started?.fulfill()
            }
        }
        return response(request)
    }

    func complete() {
        // Also release a request that arrives after an expectation timeout.
        hold = false
        guard let pending = pending, let request = heldRequest else { return }
        self.pending = nil; heldRequest = nil
        pending.resume(returning: response(request))
    }

    private func response(_ request: URLRequest) -> (Data, URLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
final class AccountAPIIntegrationTests: XCTestCase {
    private let id = "abcdefghij"
    private let linkJSON = #"{"youtubePlaylistId":"abcdefghij","createdAt":"2026-01-01T00:00:00.000Z"}"#

    private func makeCoordinator(_ transport: SyntheticAccountTransport) throws -> AccountSessionCoordinator {
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: transport)
        return AccountSessionCoordinator(authentication: SyntheticAccountAuth(), links: SyntheticAPIAccountLinkService(client: client))
    }

    func testExplicitLinkRequestsAndNonSnapshotTraversal() async throws {
        let transport = SyntheticAccountTransport()
        let coordinator = try makeCoordinator(transport)
        await coordinator.signIn()
        let before = await transport.requests
        XCTAssertTrue(before.isEmpty)

        await transport.configure(status: 200, body: "{\"links\":[\(linkJSON)]}")
        if case .success(let page) = await coordinator.list() {
            XCTAssertEqual(page.links.map(\.youtubePlaylistId), [id])
            XCTAssertEqual(page.completeness, .serverTraversalCompleteNonSnapshot)
        } else { XCTFail("list failed") }

        await transport.configure(status: 201, body: "{\"link\":\(linkJSON)}")
        if case .success(let link) = await coordinator.save(id) { XCTAssertEqual(link.youtubePlaylistId, id) }
        else { XCTFail("save failed") }
        await transport.configure(status: 204, body: "")
        if case .success = await coordinator.unlink(id) {} else { XCTFail("unlink failed") }

        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.httpMethod }, ["GET", "POST", "DELETE"])
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/playlist-links", "/api/playlist-links", "/api/playlist-links/abcdefghij"])
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token-1" && $0.url?.query == nil })
        guard requests.count == 3 else { return }
        XCTAssertNil(requests[0].httpBody)
        XCTAssertNil(requests[2].httpBody)
        let body = try XCTUnwrap(requests[1].httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["playlistId": id])
    }

    func testServerErrorsAreSanitizedAndNeverRetried() async throws {
        for operation in ["list", "save", "unlink"] {
            let transport = SyntheticAccountTransport()
            let coordinator = try makeCoordinator(transport)
            await coordinator.signIn()
            await transport.configure(status: 503, body: #"{"error":{"code":"internal_error","message":"synthetic-token private server detail"}}"#)
            switch operation {
            case "list":
                if case .unavailable = await coordinator.list() {} else { XCTFail() }
                XCTAssertEqual(coordinator.state, .recoverableError(.links))
            case "save":
                if case .mutationOutcomeUnknown = await coordinator.save(id) {} else { XCTFail() }
                XCTAssertEqual(coordinator.state, .recoverableError(.mutationOutcomeUnknown))
                XCTAssertTrue(coordinator.hasUncertainMutations)
            default:
                if case .mutationOutcomeUnknown = await coordinator.unlink(id) {} else { XCTFail() }
                XCTAssertEqual(coordinator.state, .recoverableError(.mutationOutcomeUnknown))
                XCTAssertTrue(coordinator.hasUncertainMutations)
            }
            XCTAssertFalse(String(reflecting: coordinator.state).contains("synthetic-token"))
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 1)
        }
    }

    func testLateResponsesAfterCancellationOrSignOutAreDiscarded() async throws {
        for operation in ["list", "save", "unlink"] {
            for signOut in [false, true] {
                let transport = SyntheticAccountTransport()
                let coordinator = try makeCoordinator(transport)
                await coordinator.signIn()
                let started = expectation(description: "synthetic request started")
                let body = operation == "list" ? "{\"links\":[\(linkJSON)]}" : (operation == "save" ? "{\"link\":\(linkJSON)}" : "")
                await transport.configure(status: operation == "unlink" ? 204 : 200, body: body, hold: true, started: started)
                let playlistID = id
                let task = Task { () -> Bool in
                    switch operation {
                    case "list": if case .unavailable = await coordinator.list() { return true }
                    case "save": if case .mutationOutcomeUnknown = await coordinator.save(playlistID) { return true }
                    default: if case .mutationOutcomeUnknown = await coordinator.unlink(playlistID) { return true }
                    }
                    return false
                }
                await fulfillment(of: [started], timeout: 1)
                if signOut {
                    _ = await coordinator.signOut()
                    await coordinator.signIn()
                    XCTAssertEqual(coordinator.state, .signedIn)
                    XCTAssertFalse(coordinator.hasUncertainMutations)
                } else { task.cancel() }
                await transport.complete()
                let discarded = await task.value
                XCTAssertTrue(discarded)
                if signOut {
                    XCTAssertEqual(coordinator.state, .signedIn)
                    XCTAssertFalse(coordinator.hasUncertainMutations)
                } else if operation != "list" {
                    XCTAssertTrue(coordinator.hasUncertainMutations)
                }
                let requests = await transport.requests
                XCTAssertEqual(requests.count, 1)
                if signOut {
                    await transport.configure(status: 200, body: "{\"links\":[\(linkJSON)]}")
                    if case .success = await coordinator.list() {} else { XCTFail("new account list failed") }
                    let finalRequests = await transport.requests
                    XCTAssertEqual(finalRequests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token-2")
                    XCTAssertEqual(coordinator.state, .signedIn)
                    XCTAssertFalse(coordinator.hasUncertainMutations)
                }
            }
        }
    }
}

@MainActor
final class NativeAccountModelRecoveryTests: XCTestCase {
    private let playlistJSON = #"{"id":"PLSyntheticImport0001","title":"Synthetic","description":null,"thumbnail":null,"channelTitle":null,"videoCount":0,"videos":[]}"#

    private func waitUntilIdle(_ model: NativeAccountModel) async {
        let idle = expectation(description: "account operation finished")
        let observation = model.$busy.filter { !$0 }.first().sink { _ in idle.fulfill() }
        await fulfillment(of: [idle], timeout: 2)
        withExtendedLifetime(observation) {}
    }

    func testFailedPlaylistReadsCanRetryAndReadCloudLinksWithoutReauthentication() async throws {
        for status in [404, 429, 503, 0] {
            let transport = SyntheticAccountTransport(), authentication = SyntheticAccountAuth()
            let client = try APIClient(origin: URL(string: "https://example.test")!, transport: transport)
            let service = AccountSessionCoordinator(authentication: authentication, links: APIAccountLinkService(client: client))
            let model = NativeAccountModel(service: service)
            model.authenticate()
            await waitUntilIdle(model)
            XCTAssertTrue(model.canFetchPlaylists)
            await transport.configure(status: status, body: "{}", failure: status == 0 ? URLError(.notConnectedToInternet) : nil)
            let failed = await model.fetchPlaylist("PLUnavailable0001")
            XCTAssertNil(failed)
            XCTAssertEqual(model.state, .recoverableError(.links))
            XCTAssertTrue(model.hasUsableSession)
            XCTAssertTrue(model.canFetchPlaylists)

            await transport.configure(status: 200, body: playlistJSON)
            let recovered = await model.fetchPlaylist("PLSyntheticImport0001")
            XCTAssertEqual(recovered?.id, "PLSyntheticImport0001")
            await transport.configure(status: 503, body: "{}")
            _ = await model.fetchPlaylist("PLUnavailable0001")
            await transport.configure(status: 200, body: #"{"links":[]}"#)
            model.loadLinks()
            await waitUntilIdle(model)
            XCTAssertEqual(model.state, .signedIn)
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 4)
            XCTAssertEqual(requests.last?.url?.path, "/api/playlist-links")
            XCTAssertEqual(authentication.signInCount, 1)
        }
    }

    func testSuggestionsFailureDoesNotDisableImportsOrClearMutationUncertainty() async throws {
        let transport = SyntheticAccountTransport(), authentication = SyntheticAccountAuth()
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: transport)
        let service = AccountSessionCoordinator(authentication: authentication, links: APIAccountLinkService(client: client))
        let model = NativeAccountModel(service: service)
        model.authenticate()
        await waitUntilIdle(model)
        await transport.configure(status: 503, body: "{}")
        let suggestions = await model.fetchSuggestions(SuggestionsRequest(playlistId: "PLSyntheticImport0001", seeds: []))
        XCTAssertNil(suggestions)
        XCTAssertTrue(model.canFetchPlaylists)
        model.saveLink("PLSyntheticImport0001")
        await waitUntilIdle(model)
        XCTAssertTrue(model.uncertain)
        XCTAssertTrue(model.canFetchPlaylists)
        await transport.configure(status: 200, body: playlistJSON)
        let recovered = await model.fetchPlaylist("PLSyntheticImport0001")
        XCTAssertNotNil(recovered)
        model.saveLink("PLSyntheticImport0001")
        XCTAssertTrue(model.uncertain)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 3, "uncertain mutation must not be retried")
        XCTAssertEqual(authentication.signInCount, 1)
    }

    func testSignedOutAndCancelledAuthenticationCannotImport() async throws {
        let transport = SyntheticAccountTransport(), authentication = AccountSessionCoordinatorTests.Auth()
        let client = try APIClient(origin: URL(string: "https://example.test")!, transport: transport)
        let service = AccountSessionCoordinator(authentication: authentication, links: APIAccountLinkService(client: client))
        let model = NativeAccountModel(service: service)
        XCTAssertFalse(model.hasUsableSession)
        let signedOut = await model.fetchPlaylist("PLSyntheticImport0001")
        XCTAssertNil(signedOut)

        let started = expectation(description: "authentication started")
        authentication.called = { started.fulfill() }
        let operation = Task { await service.signIn() }
        await fulfillment(of: [started], timeout: 2)
        operation.cancel()
        authentication.finish("late-synthetic-token")
        await operation.value
        XCTAssertEqual(service.state, .recoverableError(.authenticationCancelled))
        XCTAssertFalse(model.hasUsableSession)
        XCTAssertFalse(model.canFetchPlaylists)
        let cancelled = await model.fetchPlaylist("PLSyntheticImport0001")
        XCTAssertNil(cancelled)
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }
}

final class NativeAccountConfigurationTests: XCTestCase {
    private let key = "sb_publishable_synthetic_only"

    func testExplicitConfigurationAcceptsOnlyNonSecretHTTPSOriginsAndFixedCallback() throws {
        let configuration = try NativeAccountConfiguration(
            supabaseOrigin: try XCTUnwrap(URL(string: "https://example.supabase.co")),
            publishableKey: key,
            applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.example.test"))
        )
        XCTAssertEqual(configuration.authURL.absoluteString, "https://example.supabase.co/auth/v1")
        XCTAssertEqual(configuration.redirect, NativeAccountConfiguration.requiredRedirect)
    }

    func testConfigurationRejectsSecretLikeOrUnsafeInputsBeforeAnyServiceIsMade() throws {
        XCTAssertThrowsError(try NativeAccountConfiguration(
            supabaseOrigin: try XCTUnwrap(URL(string: "http://example.supabase.co")),
            publishableKey: key,
            applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.example.test"))
        ))
        XCTAssertThrowsError(try NativeAccountConfiguration(
            supabaseOrigin: try XCTUnwrap(URL(string: "https://example.supabase.co")),
            publishableKey: "eyJservice_role.synthetic",
            applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.example.test"))
        ))
        XCTAssertThrowsError(try NativeAccountConfiguration(
            supabaseOrigin: try XCTUnwrap(URL(string: "https://example.supabase.co")),
            publishableKey: key,
            applicationAPIOrigin: try XCTUnwrap(URL(string: "http://api.example.test"))
        ))
        XCTAssertThrowsError(try NativeAccountConfiguration(
            supabaseOrigin: try XCTUnwrap(URL(string: "https://example.supabase.co")),
            publishableKey: key,
            applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.example.test")),
            redirect: try XCTUnwrap(URL(string: "com.example.other://auth/callback"))
        ))
    }
}

private final class NativeAuthenticationBackend: NativeCredentialBackend {
    private var values: [String: Data] = [:]
    private func namespaced(_ service: String, _ key: String) -> String { service + "\u{0}" + key }
    func add(service: String, key: String, value: Data) -> OSStatus {
        let name = namespaced(service, key)
        guard values[name] == nil else { return errSecDuplicateItem }
        values[name] = value; return errSecSuccess
    }
    func update(service: String, key: String, value: Data) -> OSStatus {
        let name = namespaced(service, key)
        guard values[name] != nil else { return errSecItemNotFound }
        values[name] = value; return errSecSuccess
    }
    func read(service: String, key: String) -> (OSStatus, Data?) {
        let value = values[namespaced(service, key)]
        return value.map { (errSecSuccess, $0) } ?? (errSecItemNotFound, nil)
    }
    func delete(service: String, key: String) -> OSStatus {
        values.removeValue(forKey: namespaced(service, key)) == nil ? errSecItemNotFound : errSecSuccess
    }
}

@MainActor
private final class NativeAuthenticationBrowserSession: TransientAuthSession {
    var startAction: () -> Void = {}
    var cancelCount = 0
    func start() -> Bool { startAction(); return true }
    func cancel() { cancelCount += 1 }
}

@MainActor
final class NativeSupabaseAccountAuthenticationTests: XCTestCase {
    private func configuration() throws -> NativeAccountConfiguration {
        try NativeAccountConfiguration(supabaseOrigin: try XCTUnwrap(URL(string: "https://example.supabase.co")),
                                       publishableKey: "sb_publishable_synthetic",
                                       applicationAPIOrigin: try XCTUnwrap(URL(string: "https://api.example.test")))
    }

    private func sessionData(access: String = "synthetic-access", refresh: String = "synthetic-refresh", encoder: JSONEncoder = JSONEncoder()) throws -> Data {
        let user = User(id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, appMetadata: [:], userMetadata: [:], aud: "authenticated",
                        createdAt: Date(timeIntervalSince1970: 0), updatedAt: Date(timeIntervalSince1970: 0))
        return try encoder.encode(Session(accessToken: access, tokenType: "bearer", expiresIn: 3600,
                                                expiresAt: 4_102_444_800, refreshToken: refresh, user: user))
    }

    nonisolated private static func response(_ body: Data, _ request: URLRequest) -> (Data, URLResponse) {
        (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }

    private func callback(from authorizationURL: URL) throws -> URL {
        let items = URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let redirect = try XCTUnwrap(items.first(where: { $0.name == "redirect_to" })?.value)
        var components = try XCTUnwrap(URLComponents(string: redirect))
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "code", value: "synthetic-code")]
        return try XCTUnwrap(components.url)
    }

    func testGooglePKCESucceedsThroughSystemBrowserAdapterWithoutExposingBearer() async throws {
        let config = try configuration(), backend = NativeAuthenticationBackend()
        let storage = NativeCredentialStorage(configuration: config, backend: backend)
        let window = NSWindow(), started = expectation(description: "browser started")
        let browser = TransientAuthBrowser(anchor: window) { url, _, _, completion in
            let session = NativeAuthenticationBrowserSession()
            session.startAction = {
                started.fulfill()
                let result = try? self.callback(from: url)
                Task { @MainActor in completion(result ?? nil, nil) }
            }
            return session
        }
        // The HTTP API uses ISO dates/snake case; SDK persistence uses its own
        // JSONEncoder defaults. Keep those two fixture formats distinct.
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let payload = try sessionData(encoder: encoder)
        let service = try NativeSupabaseAccountAuthentication(configuration: config, browser: browser, storage: storage) { request in
            XCTAssertEqual(request.url?.path, "/auth/v1/token")
            return Self.response(payload, request)
        }
        let task = Task { try await service.signIn() }
        await fulfillment(of: [started], timeout: 1)
        let account = try await task.value
        XCTAssertEqual(account.bearer, "synthetic-access")
        XCTAssertEqual(account.accountID, "00000000-0000-4000-8000-000000000001")
        XCTAssertNotNil(try storage.retrieve(key: NativeCredentialStorage.sessionKey))
    }

    func testWrongCallbackAndCancellationClearOwnedSessionAndVerifier() async throws {
        for mode in ["wrong", "cancel"] {
            let config = try configuration(), backend = NativeAuthenticationBackend()
            let storage = NativeCredentialStorage(configuration: config, backend: backend)
            let window = NSWindow(), started = expectation(description: "browser \(mode) started")
            var fake: NativeAuthenticationBrowserSession?
            let browser = TransientAuthBrowser(anchor: window) { url, _, _, completion in
                let session = NativeAuthenticationBrowserSession()
                fake = session
                session.startAction = {
                    started.fulfill()
                    if mode == "wrong" {
                        var invalid = try! self.callback(from: url)
                        var components = URLComponents(url: invalid, resolvingAgainstBaseURL: false)!
                        components.queryItems = components.queryItems?.map {
                            $0.name == "flow_correlation" ? URLQueryItem(name: $0.name, value: "wrong") : $0
                        }
                        invalid = components.url!
                        Task { @MainActor in completion(invalid, nil) }
                    }
                }
                return session
            }
            let service = try NativeSupabaseAccountAuthentication(configuration: config, browser: browser, storage: storage) { _ in
                throw URLError(.notConnectedToInternet)
            }
            let task = Task { () -> Result<AccountSession, Error> in
                do { return .success(try await service.signIn()) }
                catch { return .failure(error) }
            }
            await fulfillment(of: [started], timeout: 1)
            if mode == "cancel" { task.cancel() }
            let result = await task.value
            if case .success = result { XCTFail("authentication must not succeed") }
            XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.sessionKey))
            XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.verifierKey))
            if mode == "cancel" { XCTAssertEqual(fake?.cancelCount, 1) }
        }
    }

    func testProductionPKCEExchangeNeverRetriesServerOrNetworkFailures() async throws {
        for offline in [false, true] {
            let config = try configuration(), backend = NativeAuthenticationBackend()
            let storage = NativeCredentialStorage(configuration: config, backend: backend)
            let window = NSWindow(), attempts = NativeExchangeAttempts()
            let browser = TransientAuthBrowser(anchor: window) { url, _, _, completion in
                let session = NativeAuthenticationBrowserSession()
                session.startAction = {
                    let callback = try? self.callback(from: url)
                    Task { @MainActor in completion(callback, nil) }
                }
                return session
            }
            let service = try NativeSupabaseAccountAuthentication(configuration: config, browser: browser, storage: storage) { request in
                await attempts.record(request)
                if offline { throw URLError(.notConnectedToInternet) }
                return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
            }
            do { _ = try await service.signIn(); XCTFail("exchange must fail") }
            catch {}
            let requests = await attempts.requests
            XCTAssertEqual(requests.count, 1, "one-time PKCE code must not be replayed after a failed exchange")
            XCTAssertEqual(requests.first?.httpMethod, "POST")
            XCTAssertEqual(requests.first?.url?.query, "grant_type=pkce")
            XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.sessionKey))
            XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.verifierKey))
        }
    }

    func testRefreshFailureRemovesPriorSessionAndVerifier() async throws {
        let config = try configuration(), backend = NativeAuthenticationBackend()
        let storage = NativeCredentialStorage(configuration: config, backend: backend)
        try storage.store(key: NativeCredentialStorage.sessionKey, value: sessionData())
        try storage.store(key: NativeCredentialStorage.verifierKey, value: Data("synthetic-verifier".utf8))
        let browser = TransientAuthBrowser(anchor: NSWindow()) { _, _, _, _ in NativeAuthenticationBrowserSession() }
        let service = try NativeSupabaseAccountAuthentication(configuration: config, browser: browser, storage: storage) { _ in
            throw URLError(.notConnectedToInternet)
        }
        let existing = AccountSession(bearer: "synthetic-access", accountID: "00000000-0000-4000-8000-000000000001")
        do { _ = try await service.refresh(existing); XCTFail("expected refresh failure") }
        catch {}
        XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.sessionKey))
        XCTAssertNil(try storage.retrieve(key: NativeCredentialStorage.verifierKey))
    }
}

private actor NativeExchangeAttempts {
    private(set) var requests: [URLRequest] = []
    func record(_ request: URLRequest) { requests.append(request) }
}
