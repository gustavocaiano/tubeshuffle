import AppKit
import XCTest
@testable import TubeShuffle

@MainActor
final class PlayerCoordinatorTests: XCTestCase {
    private enum LoadError: Error { case failed }

    private final class Bridge {
        var pending: [Int: CheckedContinuation<Void, Error>] = [:]
        var calls: [(String, Int)] = []
        var started: XCTestExpectation?
        var finished: XCTestExpectation?
        var fireWatchdog: (@MainActor () -> Void)?

        func load(_ id: String, _ generation: Int) async throws {
            calls.append((id, generation))
            try await withCheckedThrowingContinuation { continuation in
                pending[generation] = continuation
                started?.fulfill()
                started = nil
            }
        }

        func complete(_ generation: Int, success: Bool) {
            guard let continuation = pending.removeValue(forKey: generation) else {
                XCTFail("No pending load for generation \(generation)"); return
            }
            if success { continuation.resume() }
            else { continuation.resume(throwing: LoadError.failed) }
        }
    }

    private func setup(_ bridge: Bridge) -> (PlayerCoordinator, NSWindow) {
        let hooks = PlayerCoordinator.TestHooks(
            load: { try await bridge.load($0, $1) },
            progress: { _ in (0, 100) }, draw: { 0 },
            onMutationWatchdogArmed: { bridge.fireWatchdog = $0 },
            onLoadFinished: { bridge.finished?.fulfill(); bridge.finished = nil }
        )
        let coordinator = PlayerCoordinator(testHooks: hooks)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
                              styleMask: [.titled], backing: .buffered, defer: false)
        coordinator.attach(window: window)
        coordinator.player.onEvent?(.ready(1))
        return (coordinator, window)
    }

    func testCurrentErrorIsNotOverwrittenByAutoplayBlocked() {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        XCTAssertTrue(coordinator.canTransport)
        let generation = coordinator.queueState.activeGeneration
        coordinator.player.onEvent?(.error(generation, 100))
        XCTAssertEqual(coordinator.status, "Player error: unavailable or private (100)")
        XCTAssertFalse(coordinator.ready)
        XCTAssertFalse(coordinator.canTransport)
        XCTAssertFalse(coordinator.canSeek)
        XCTAssertFalse(coordinator.canShuffleSampleQueue)
        XCTAssertFalse(coordinator.nowPlayingAvailable)
        XCTAssertTrue(coordinator.canNext) // manual selection can recover with a new generation

        coordinator.player.onEvent?(.autoplayBlocked(generation))
        XCTAssertEqual(coordinator.status, "Player error: unavailable or private (100)")
        XCTAssertFalse(coordinator.ready)
        XCTAssertFalse(coordinator.canTransport)
        XCTAssertFalse(coordinator.canSeek)
        XCTAssertFalse(coordinator.canShuffleSampleQueue)
        XCTAssertFalse(coordinator.nowPlayingAvailable)
        XCTAssertTrue(coordinator.canNext)
    }

    func testPendingShuffleBuffersPlayingWithoutClaimingOldQueueIsPlaying() async {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        let original = coordinator.queue.map(\.id)
        bridge.started = expectation(description: "shuffle load started")
        let started = bridge.started!
        coordinator.shuffleSampleQueue()
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(bridge.calls.count, 1)
        XCTAssertEqual(bridge.calls[0].1, 2)

        coordinator.player.onEvent?(.ready(2))
        coordinator.player.onEvent?(.state(1, 1)) // old generation cannot arm the pending occurrence
        XCTAssertFalse(coordinator.queueState.hasBufferedPlaying)
        coordinator.player.onEvent?(.state(2, 1))
        XCTAssertEqual(coordinator.status, "Loading shuffled queue…")
        XCTAssertTrue(coordinator.isShuffledQueuePending)
        XCTAssertEqual(coordinator.queue.map(\.id), original)
        XCTAssertEqual(coordinator.index, 0)
        XCTAssertEqual(coordinator.queueState.activeGeneration, 1)
        XCTAssertTrue(coordinator.queueState.hasBufferedPlaying)
        XCTAssertFalse(coordinator.nowPlayingAvailable)
        XCTAssertFalse(coordinator.canTransport)
        coordinator.player.onEvent?(.state(1, 0)) // stale ended cannot consume buffered playing
        XCTAssertEqual(coordinator.status, "Loading shuffled queue…")
        XCTAssertTrue(coordinator.queueState.hasBufferedPlaying)

        bridge.finished = expectation(description: "shuffle load accepted")
        let finished = bridge.finished!
        bridge.complete(2, success: true)
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(coordinator.status, "Player ready")
        XCTAssertEqual(coordinator.queue.map(\.id), [1, 2, 3, 4, 5, 0])
        XCTAssertEqual(coordinator.index, 0)
        XCTAssertEqual(coordinator.queueState.activeGeneration, 2)
        XCTAssertEqual(coordinator.queueState.accepted, 1)
        XCTAssertFalse(coordinator.queueState.hasBufferedPlaying)
        XCTAssertFalse(coordinator.isShuffledQueuePending)
        XCTAssertTrue(coordinator.canTransport)
        XCTAssertTrue(coordinator.nowPlayingAvailable)

        coordinator.player.onEvent?(.state(1, 0))
        XCTAssertEqual(coordinator.status, "Player ready")
        XCTAssertEqual(bridge.calls.count, 1)
        bridge.started = expectation(description: "buffered playing arms natural advance")
        let nextStarted = bridge.started!
        coordinator.player.onEvent?(.state(2, 0))
        await fulfillment(of: [nextStarted], timeout: 2)
        XCTAssertEqual(bridge.calls.count, 2)
        XCTAssertEqual(bridge.calls[1].0, coordinator.queue[1].videoID)
        XCTAssertEqual(bridge.calls[1].1, 3)
        bridge.finished = expectation(description: "natural advance accepted")
        let nextFinished = bridge.finished!
        coordinator.player.onEvent?(.ready(3))
        bridge.complete(3, success: true)
        await fulfillment(of: [nextFinished], timeout: 2)
        XCTAssertEqual(coordinator.index, 1)
        XCTAssertEqual(coordinator.queueState.activeGeneration, 3)
    }

    func testCommitBufferedPlayingAndActiveErrorRejectsLateReady() async {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        let original = coordinator.queue.map(\.id)
        XCTAssertTrue(coordinator.canShuffleSampleQueue)
        bridge.started = expectation(description: "shuffle load started")
        coordinator.shuffleSampleQueue()
        coordinator.shuffleSampleQueue() // second request is rejected
        XCTAssertTrue(coordinator.isShuffledQueuePending)
        XCTAssertFalse(coordinator.canShuffleSampleQueue)
        XCTAssertEqual(coordinator.queue.map(\.id), original)
        await fulfillment(of: [bridge.started!], timeout: 2)
        XCTAssertEqual(bridge.calls.count, 1)
        XCTAssertEqual(bridge.calls[0].0, coordinator.queue[1].videoID)
        coordinator.player.onEvent?(.error(1, 100)) // stale error cannot quarantine new generation
        XCTAssertFalse(coordinator.recoveryRequired)
        coordinator.player.onEvent?(.ready(2))
        coordinator.player.onEvent?(.state(2, 1))
        bridge.finished = expectation(description: "shuffle load committed")
        let finished = bridge.finished!
        bridge.complete(2, success: true)
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(coordinator.queue.map(\.id), [1, 2, 3, 4, 5, 0])
        XCTAssertEqual(coordinator.index, 0)
        XCTAssertEqual(coordinator.queueState.activeGeneration, 2)
        XCTAssertFalse(coordinator.failedShuffledQueue)
        XCTAssertTrue(coordinator.canTransport)
        XCTAssertTrue(coordinator.nowPlayingAvailable)
        coordinator.player.onEvent?(.error(1, 100))
        XCTAssertTrue(coordinator.canTransport)
        coordinator.player.onEvent?(.error(2, 100))
        XCTAssertFalse(coordinator.ready)
        XCTAssertFalse(coordinator.canTransport)
        XCTAssertFalse(coordinator.canSeek)
        XCTAssertFalse(coordinator.nowPlayingAvailable)
        coordinator.player.onEvent?(.ready(2))
        coordinator.player.onEvent?(.state(2, 1))
        XCTAssertFalse(coordinator.canTransport)
        XCTAssertFalse(coordinator.nowPlayingAvailable)
        bridge.started = expectation(description: "manual next after error")
        let nextStarted = bridge.started!
        coordinator.next()
        XCTAssertEqual(coordinator.status, "Loading item…")
        await fulfillment(of: [nextStarted], timeout: 2)
        XCTAssertEqual(bridge.calls.last?.1, 3)
        coordinator.player.onEvent?(.error(2, 100)) // old error cannot poison the replacement
        bridge.finished = expectation(description: "manual next accepted")
        let nextFinished = bridge.finished!
        bridge.complete(3, success: true) // readiness may arrive after acceptance
        await fulfillment(of: [nextFinished], timeout: 2)
        XCTAssertFalse(coordinator.canTransport)
        coordinator.player.onEvent?(.ready(3))
        XCTAssertTrue(coordinator.canTransport)
        XCTAssertFalse(coordinator.recoveryRequired)
    }

    func testPendingPlayerErrorMarksStagedFailureAndRejectsCompletion() async {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        let original = coordinator.queue.map(\.id)
        bridge.started = expectation(description: "load started")
        let started = bridge.started!
        coordinator.shuffleSampleQueue()
        await fulfillment(of: [started], timeout: 2)
        coordinator.player.onEvent?(.error(2, 100))
        XCTAssertTrue(coordinator.failedShuffledQueue)
        XCTAssertTrue(coordinator.recoveryRequired)
        XCTAssertNil(coordinator.queueState.failedTarget)
        bridge.finished = expectation(description: "late completion")
        let finished = bridge.finished!
        bridge.complete(2, success: true)
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(coordinator.queue.map(\.id), original)
        XCTAssertEqual(coordinator.queueState.accepted, 0)
        XCTAssertFalse(coordinator.canTransport)
    }

    func testFailedStagedLoadDoesNotMarkOldQueueItem() async {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        let original = coordinator.queue.map(\.id)
        coordinator.player.onEvent?(.autoplayBlocked(1))
        XCTAssertEqual(coordinator.status, "Playback blocked; press Play")
        bridge.started = expectation(description: "load started")
        let started = bridge.started!
        coordinator.shuffleSampleQueue()
        XCTAssertEqual(coordinator.status, "Loading shuffled queue…")
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(coordinator.status, "Loading shuffled queue…")
        XCTAssertTrue(coordinator.isShuffledQueuePending)
        XCTAssertEqual(coordinator.queue.map(\.id), original)
        XCTAssertFalse(coordinator.canTransport)
        bridge.finished = expectation(description: "failed load handled")
        let finished = bridge.finished!
        bridge.complete(2, success: false)
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(coordinator.queue.map(\.id), original)
        XCTAssertNil(coordinator.queueState.failedTarget)
        XCTAssertTrue(coordinator.failedShuffledQueue)
        XCTAssertFalse(coordinator.isShuffledQueuePending)
        XCTAssertTrue(coordinator.recoveryRequired)
        XCTAssertTrue(coordinator.log.contains { $0.contains("shuffled queue load failed for generation 2") })
        XCTAssertFalse(coordinator.log.contains { $0.contains("target marked failed") })
        coordinator.player.onEvent?(.ready(2))
        XCTAssertFalse(coordinator.canTransport)
    }

    func testBufferedPlayingEndedAdvancesInCommittedOrder() async {
        let bridge = Bridge()
        let (coordinator, window) = setup(bridge)
        defer { withExtendedLifetime(window) {} }
        bridge.started = expectation(description: "first load")
        let started = bridge.started!
        coordinator.shuffleSampleQueue()
        await fulfillment(of: [started], timeout: 2)
        coordinator.player.onEvent?(.ready(2))
        coordinator.player.onEvent?(.state(2, 1))
        coordinator.player.onEvent?(.state(2, 0))
        coordinator.player.onEvent?(.state(2, 0))
        bridge.started = expectation(description: "natural load")
        let nextStarted = bridge.started!
        bridge.complete(2, success: true)
        await fulfillment(of: [nextStarted], timeout: 2)
        XCTAssertEqual(bridge.calls.count, 2)
        XCTAssertEqual(bridge.calls[1].0, coordinator.queue[1].videoID)
        XCTAssertEqual(bridge.calls[1].1, 3)
        coordinator.player.onEvent?(.ready(3))
        bridge.finished = expectation(description: "natural load complete")
        let finished = bridge.finished!
        bridge.complete(3, success: true)
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(coordinator.index, 1)
        XCTAssertFalse(coordinator.failedShuffledQueue)
    }

    func testTimeoutAndCloseQuarantineLateCallbacks() async {
        for close in [false, true] {
            let bridge = Bridge()
            let (coordinator, window) = setup(bridge)
            let original = coordinator.queue.map(\.id)
            bridge.started = expectation(description: "stalled load")
            let started = bridge.started!
            coordinator.shuffleSampleQueue()
            await fulfillment(of: [started], timeout: 2)
            if close {
                NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: window)
            } else {
                XCTAssertNotNil(bridge.fireWatchdog)
                bridge.fireWatchdog?()
            }
            XCTAssertTrue(coordinator.recoveryRequired)
            XCTAssertTrue(coordinator.failedShuffledQueue)
            XCTAssertFalse(coordinator.isShuffledQueuePending)
            coordinator.player.onEvent?(.ready(2))
            coordinator.player.onEvent?(.state(2, 1))
            bridge.finished = expectation(description: "late completion ignored")
            let finished = bridge.finished!
            bridge.complete(2, success: true)
            await fulfillment(of: [finished], timeout: 2)
            XCTAssertEqual(coordinator.queue.map(\.id), original)
            XCTAssertEqual(coordinator.queueState.accepted, 0)
            XCTAssertFalse(coordinator.canTransport)
            XCTAssertFalse(coordinator.nowPlayingAvailable)
            withExtendedLifetime(window) {}
        }
    }
}
