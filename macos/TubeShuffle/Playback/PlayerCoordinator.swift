import AppKit
import Combine
import Foundation
import MediaPlayer
import WebKit

@MainActor
final class PlayerCoordinator: ObservableObject {
    struct Item: Identifiable {
        let id: Int
        let videoID: String
        var localOccurrenceID: OccurrenceID? = nil
        var title: String? = nil
        var channel: String? = nil
    }

    // Queue and accepted state share one publication, so a replacement cannot
    // expose a new order paired with the old index (or vice versa).
    private struct PlaybackQueue {
        var items: [Item]
        var state: QueueState
    }
    // Fixed public examples; availability and embed permission can change.
    @Published private var playbackQueue = PlaybackQueue(
        items: ["ScMzIvxBSi4", "jNQXAC9IVRw", "dQw4w9WgXcQ", "M7lc1UVf-VE", "aqz-KE-bpKQ", "ysz5S6PUM-U"]
            .enumerated().map { Item(id: $0.offset, videoID: $0.element) },
        state: QueueState(count: 6)
    ) {
        didSet {
            if oldValue.state.index != playbackQueue.state.index || oldValue.items.map(\.id) != playbackQueue.items.map(\.id) {
                onQueueChanged?(playbackQueue.items, playbackQueue.state.index)
            }
        }
    }
    private(set) var queue: [Item] {
        get { playbackQueue.items }
        set { playbackQueue.items = newValue }
    }
    private(set) var queueState: QueueState {
        get { playbackQueue.state }
        set { playbackQueue.state = newValue }
    }
    let player = DirectPlayer()
    private var stagedShuffledQueue: [Item]?
    @Published private(set) var isShuffledQueuePending = false
    @Published private(set) var failedShuffledQueue = false
    var index: Int { queueState.index }
    @Published private(set) var status = "Waiting for player"
    @Published private(set) var log: [String] = []
    @Published private(set) var ready = false
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var duration: Double = 0
    private var observedPlaying = false
    var isPlaying: Bool { observedPlaying }
    @Published private(set) var volume: Double = 1
    private var intent = PlaybackIntent()
    @Published private var seekGate = SeekGate()
    private var deferredSeekEnd = false
    private var progressEligible = false
    private var windowOpen = false
    private var windowGeneration = 0
    private var playerError = false
    private var startupGate = StartupGate()
    // Readiness is per occurrence: it holds only while the generation that
    // reported ready is still the expected one.
    private var readyGeneration: Int?
    private var readinessGate = ReadinessGate()
    @Published private var mutationInFlight = false
    private var mutationGate = MutationGate()
    @Published private(set) var recoveryRequired = false
    private let remoteEligibility = RemoteEligibility()
    @Published private(set) var occurrence = 0
    @Published private var progressAdmission = ProgressAdmission()
    private var progressTimeoutLogged = false
    private var remoteHandlers: [(MPRemoteCommand, Any)] = []
    private var subscriptions = Set<AnyCancellable>()
    private weak var playerWindow: NSWindow?
    private var sequence = 0
    private let started = ProcessInfo.processInfo.systemUptime
    // Injection is limited to the bridge boundaries exercised by coordinator
    // tests; admission, callbacks, state transitions and completion stay real.
    struct TestHooks {
        var load: @MainActor (String, Int) async throws -> Void
        var progress: @MainActor (Int) async throws -> (Double, Double)
        var draw: () -> Double
        var onMutationWatchdogArmed: ((@escaping @MainActor () -> Void) -> Void)? = nil
        var onLoadFinished: (() -> Void)? = nil
        var volume: (@MainActor (Double, Int) async throws -> Void)? = nil
    }
    private let testHooks: TestHooks?
    var onNaturalCompletion: ((Item) -> Void)?
    var onQueueChanged: (([Item], Int) -> Void)?
    private var lastCompletedGeneration: Int?

    init(initialItems: [Item]? = nil, initialIndex: Int = 0, testHooks: TestHooks? = nil) {
        self.testHooks = testHooks
        if let initialItems {
            precondition(!initialItems.isEmpty && Set(initialItems.map(\.id)).count == initialItems.count)
            playbackQueue = PlaybackQueue(items: initialItems, state: QueueState(count: initialItems.count, initialIndex: initialIndex))
        }
        if testHooks == nil {
            setupRemoteCommands()
            Timer.publish(every: 1, on: .main, in: .common).autoconnect()
                .sink { [weak self] _ in self?.refreshProgress() }.store(in: &subscriptions)
        }
        record("Session started; bundle \(Bundle.main.bundleIdentifier ?? "missing")")
        player.onEvent = { [weak self] event in
            guard let self else { return }
            guard !self.recoveryRequired else { return }
            switch event {
            case .iframeReady: self.record("iframe API ready")
            case .ready(let generation):
                // The bridge tags readiness with the occurrence generation it was
                // loaded under. Readiness is per instance: it never carries across
                // a load, is never treated as playing, does not prove the loaded
                // video, and cannot undo a terminal startup failure: fail/timeout
                // always require a restart, and recovery blocks every callback above.
                guard generation == self.queueState.expectedGeneration else {
                    self.record("stale ready event generation \(generation); expected \(self.queueState.expectedGeneration); rejected")
                    return
                }
                // An active occurrence's error is terminal for that occurrence;
                // a late duplicate ready must not re-enable transport or playback.
                guard !self.playerError || self.queueState.pending != nil else {
                    self.record("ready after active player error rejected")
                    return
                }
                _ = self.startupGate.ready()
                _ = self.readinessGate.ready(generation)
                self.readyGeneration = generation
                self.playerError = false
                self.syncReady()
                self.status = "Player ready"; self.record(self.status); self.publishNowPlaying()
                self.refreshProgress()
            case .state(let generation, let value):
                self.playbackChanged(value, generation: generation)
            case .error(let generation, let code):
                guard generation == self.queueState.expectedGeneration else {
                    self.record("stale error event generation \(generation); expected \(self.queueState.expectedGeneration); rejected")
                    return
                }
                if self.queueState.pending != nil {
                    // The pending instance already replaced the previous player, so
                    // the previous occurrence cannot be trusted as active. Quarantine
                    // the session: the in-flight load completion is rejected below and
                    // has no further effects.
                    self.failOccurrence("player error \(Self.errorLabel(code)) while load generation \(generation) was pending")
                } else {
                    self.playerError = true
                    self.readyGeneration = nil
                    self.ready = false
                    self.queueState.invalidatePlayback(); self.invalidateSeek(); self.resetProgress()
                    self.status = "Player error: \(Self.errorLabel(code))"
                    self.record(self.status); self.publishNowPlaying()
                }
            case .autoplayBlocked(let generation):
                guard generation == self.queueState.expectedGeneration else {
                    self.record("stale autoplay-blocked event generation \(generation); expected \(self.queueState.expectedGeneration); rejected")
                    return
                }
                guard !self.playerError else { return }
                self.status = "Playback blocked; press Play"
                self.record(self.status)
            case .failure:
                guard self.startupGate.fail() else { return }
                self.failOccurrence("player bridge or navigation failed")
            }
        }
        if testHooks == nil {
            player.start(videoID: queue[index].videoID)
            Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                guard let self, self.startupGate.timeout() else { return }
                self.failOccurrence("player startup timed out")
            }
        }
        let app = NotificationCenter.default
        for (name, label) in [(NSApplication.didBecomeActiveNotification, "app active"),
                              (NSApplication.didResignActiveNotification, "app inactive"),
                              (NSApplication.didHideNotification, "app hidden"),
                              (NSApplication.didUnhideNotification, "app unhidden")] {
            app.publisher(for: name).sink { [weak self] _ in self?.record(label) }.store(in: &subscriptions)
        }
        for (name, label) in [(NSWindow.didMiniaturizeNotification, "window minimized"),
                              (NSWindow.didDeminiaturizeNotification, "window restored"),
                              (NSWindow.didChangeOcclusionStateNotification, "window occlusion changed"),
                              (NSWindow.willCloseNotification, "window closing")] {
            app.publisher(for: name).sink { [weak self] notification in
                guard let self, let window = notification.object as? NSWindow, window === self.playerWindow else { return }
                self.record("\(label); window \(window.windowNumber), occlusion-visible=\(window.occlusionState.contains(.visible)), miniaturized=\(window.isMiniaturized)")
                if name == NSWindow.willCloseNotification {
                    self.failStagedShuffledQueueIfNeeded()
                    self.mutationGate.invalidate()
                    if self.mutationGate.restartRequired { self.requireRestart("player operation interrupted by window close") }
                    self.windowOpen = false
                    self.windowGeneration += 1
                    self.playerWindow = nil
                    self.readinessGate.abandon()
                    self.readyGeneration = nil
                    self.ready = false
                    self.queueState.invalidatePlayback()
                    self.invalidateSeek()
                    self.resetProgress()
                    self.requireRestart("player window closed; retained playback state cannot be safely re-armed")
                    self.stop()
                }
            }.store(in: &subscriptions)
        }
        let workspace = NSWorkspace.shared.notificationCenter
        for (name, label) in [(NSWorkspace.willSleepNotification, "system will sleep"),
                              (NSWorkspace.didWakeNotification, "system woke"),
                              (NSWorkspace.sessionDidResignActiveNotification, "session inactive / possible lock"),
                              (NSWorkspace.sessionDidBecomeActiveNotification, "session active / possible unlock")] {
            workspace.publisher(for: name).sink { [weak self] _ in self?.record(label) }.store(in: &subscriptions)
        }
    }

    private func playbackChanged(_ state: Int, generation: Int) {
        guard ready, windowOpen, !recoveryRequired else { return }
        // Generation correlation replaces the former fail-closed second-transition
        // gate: the bridge tags each callback with the generation the coordinator
        // issued for that player instance, so a Playing/Ended callback is buffered
        // or processed only when it names the pending or active occurrence. The
        // tag attributes to an instance, not to authenticated remote video identity.
        guard queueState.expects(generation: generation) else {
            record("stale iframe state \(state) generation \(generation); expected \(queueState.expectedGeneration); rejected")
            return
        }
        record("iframe state \(state) generation \(generation)")
        observedPlaying = state == 1
        if state == 1 { intent.observe(true); progressEligible = queueState.pending == nil }
        if state == 2 || state == 0 { intent.observe(false) }
        publishNowPlaying()
        refreshProgress()
        if queueState.pending != nil {
            status = isShuffledQueuePending ? "Loading shuffled queue…" : "Loading item…"
        } else {
            status = "Playback: \([ -1: "Unstarted", 0: "Ended", 1: "Playing", 2: "Paused", 3: "Buffering", 5: "Cued" ][state] ?? "Unknown")"
        }
        record(status)
        if state == 1 { queueState.playing() }
        if state == 0 {
            if queueState.ended() {
                if seekGate.seeking { deferredSeekEnd = true }
                else if mutationInFlight { mutationGate.deferEnd(mutationContext) }
                else { advanceNaturally() }
            }
            else { record("ended generation \(generation) ignored or buffered; no armed playing observation") }
        }
    }

    private func advanceNaturally() {
        if !queueState.lastEndWasSeekAssisted, lastCompletedGeneration != queueState.activeGeneration {
            lastCompletedGeneration = queueState.activeGeneration
            onNaturalCompletion?(queue[index])
        }
        guard index + 1 < queue.count else { record("queue finished"); return }
        select(index + 1, reason: queueState.lastEndWasSeekAssisted ? .seekAssisted : .natural)
    }

    private var mutationContext: MutationGate.Context { .init(occurrence: occurrence, lifecycle: windowGeneration) }

    private func requireRestart(_ reason: String) {
        recoveryRequired = true
        status = "Player stalled. Quit and reopen the app to recover safely."
        record("\(reason); app restart required")
        publishNowPlaying()
    }

    // Terminal occurrence failure: the session cannot continue safely, so every
    // in-flight effect is invalidated and a restart is required. Late command
    // completions are rejected by their generation and lifecycle guards.
    private func failOccurrence(_ reason: String) {
        failStagedShuffledQueueIfNeeded()
        mutationGate.invalidate()
        readinessGate.abandon()
        ready = false
        readyGeneration = nil
        playerError = true
        queueState.invalidatePlayback()
        invalidateSeek()
        resetProgress()
        requireRestart(reason)
    }

    // Readiness is re-derived whenever the pending or active generation changes;
    // a ready callback for a superseded generation cannot re-enable controls.
    private func syncReady() {
        let nowReady = readyGeneration == queueState.expectedGeneration
        guard nowReady != ready else { return }
        ready = nowReady
        publishNowPlaying()
    }

    private func mutationWatchdog(_ token: Int) -> Task<Void, Never> {
        testHooks?.onMutationWatchdogArmed? { [weak self] in self?.mutationTimedOut(token) }
        return Task {
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            mutationTimedOut(token)
        }
    }

    private func mutationTimedOut(_ token: Int) {
        if mutationGate.timeout(token) {
            if isShuffledQueuePending { failOccurrence("shuffled queue load stalled") }
            else { requireRestart("player mutation stalled") }
        }
    }

    // Each issued player generation has a bounded readiness watchdog: a load
    // that completes without a ready callback requires a restart instead of
    // leaving controls enabled against an unverified instance.
    private func readinessWatchdog(_ token: Int, generation: Int) -> Task<Void, Never> {
        Task {
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard windowOpen, !recoveryRequired else { return }
            if readinessGate.timeout(token) { failOccurrence("player generation \(generation) readiness timed out") }
        }
    }

    func select(_ next: Int, reason: QueueState.Reason = .manual) {
        beginLoad(next, reason: reason, stagedQueue: nil)
    }

    private func beginLoad(_ next: Int, reason: QueueState.Reason, stagedQueue: [Item]?) {
        guard !seekGate.seeking, !mutationInFlight, !recoveryRequired,
              stagedQueue == nil || canShuffleSampleQueue,
              windowOpen && (ready || (reason == .manual && playerError)),
              let token = mutationGate.begin() else {
            record("load rejected: \(reason.rawValue), target \(next + 1)"); return
        }
        // Acquire the mutation before reserving a generation; even a rejected
        // request must release it without leaving a dangling pending load.
        guard let request = queueState.request(next, reason: reason, allowed: true) else {
            _ = mutationGate.finish(token, current: mutationContext)
            record("load rejected: \(reason.rawValue), target \(next + 1)")
            return
        }
        // A manual selection after an active player error creates a fresh
        // generation; it does not replay or re-enable the failed occurrence.
        playerError = false
        if let stagedQueue {
            stagedShuffledQueue = stagedQueue
            failedShuffledQueue = false
            isShuffledQueuePending = true
        }
        seekGate.invalidate()
        resetProgress()
        status = stagedQueue == nil ? "Loading item…" : "Loading shuffled queue…"
        // The new occurrence is not ready yet; controls stay disabled until its
        // own ready callback names this generation.
        syncReady()
        mutationInFlight = true
        let watchdog = mutationWatchdog(token)
        let readinessTicket = readinessGate.arm(generation: request.generation)
        let readinessTask = readinessTicket.map { readinessWatchdog($0, generation: request.generation) }
        let generation = windowGeneration
        publishNowPlaying()
        let videoID = (stagedQueue ?? queue)[next].videoID
        record("load requested: \(reason.rawValue), target \(next + 1) \(videoID), generation \(request.generation)")
        Task {
            defer {
                watchdog.cancel()
                let advance = mutationGate.finish(token, current: mutationContext)
                mutationInFlight = false
                publishNowPlaying()
                if advance && windowOpen && ready && !recoveryRequired { advanceNaturally() }
                testHooks?.onLoadFinished?()
            }
            guard windowOpen, generation == windowGeneration else { return }
            do {
                // The request generation is strictly greater than every earlier
                // occurrence, including retries and duplicate video IDs, so the
                // bridge accepts it and tags this instance's callbacks with it.
                if let testHooks { try await testHooks.load(videoID, request.generation) }
                else { try await player.load(videoID: videoID, generation: request.generation) }
                guard !recoveryRequired, windowOpen, generation == windowGeneration, queueState.pending?.generation == request.generation else { return }
                let playingCandidate = queueState.hasBufferedPlaying
                var acceptedQueue = playbackQueue
                let buffered = acceptedQueue.state.complete(request, success: true)
                if let stagedQueue = stagedShuffledQueue {
                    acceptedQueue.items = stagedQueue
                }
                // No suspension or separate @Published assignments between the
                // new order and its accepted index/generation.
                playbackQueue = acceptedQueue
                discardStagedShuffledQueue()
                failedShuffledQueue = false
                syncReady()
                status = ready ? "Player ready" : "Waiting for player"
                progressEligible = playingCandidate && !buffered && ready && windowOpen
                publishNowPlaying()
                refreshProgress()
                record("load command accepted, generation \(request.generation); not proof of playback")
                if buffered {
                    record("processing buffered playing/ended pair for generation \(request.generation)")
                    mutationGate.deferEnd(mutationContext)
                }
            } catch {
                guard !recoveryRequired, windowOpen, generation == windowGeneration, queueState.pending?.generation == request.generation else { return }
                readinessTask?.cancel()
                let failedShuffle = stagedShuffledQueue != nil
                _ = queueState.complete(request, success: false, markFailedTarget: !failedShuffle)
                // DirectPlayer advances its generation before evaluating the load,
                // so a failed load leaves the previous instance untrusted and its
                // controls must never re-enable. Fail closed: quarantine the
                // pending occurrence like a pending error; there is no manual path
                // that reuses the old occurrence.
                failOccurrence(failedShuffle
                    ? "shuffled queue load failed for generation \(request.generation) (details redacted)"
                    : "load command failed for generation \(request.generation); target marked failed (details redacted)")
            }
        }
    }

    func play() { command("play", wantsPlayback: true) { generation in try await self.player.play(generation: generation) } }
    func pause() { command("pause", wantsPlayback: false) { generation in try await self.player.pause(generation: generation) } }
    func setVolume(_ value: Double) {
        guard value.isFinite else { return }
        let value = min(1, max(0, value))
        command("volume", wantsPlayback: nil) { generation in
            if let volume = self.testHooks?.volume { try await volume(value, generation) }
            else { try await self.player.setVolume(value, generation: generation) }
            guard self.windowOpen, !self.recoveryRequired, self.queueState.activeGeneration == generation else { return }
            self.volume = value
        }
    }
    func next() { select(queueState.nextTarget) }
    var canTransport: Bool { ready && !playerError && windowOpen && !recoveryRequired && !mutationInFlight && !mutationGate.busy && !seekGate.seeking && queueState.pending == nil }
    var canNext: Bool { windowOpen && (ready || playerError) && !recoveryRequired && !mutationInFlight && !mutationGate.busy && !seekGate.seeking && queueState.pending == nil && queueState.nextTarget < queue.count }

    var canShuffleUpcoming: Bool {
        shuffleAdmission.allows(count: queue.count, index: index)
    }

    private var shuffleAdmission: UpcomingShuffleAdmission {
        UpcomingShuffleAdmission(
            ready: ready, windowOpen: windowOpen, recoveryRequired: recoveryRequired,
            playerError: playerError, pendingLoad: queueState.pending != nil || queueState.failedTarget != nil,
            mutationInFlight: mutationInFlight || mutationGate.busy, seeking: seekGate.seeking,
            deferredSeekEnd: deferredSeekEnd, readinessAwaiting: readinessGate.awaiting,
            restartRequired: mutationGate.restartRequired || readinessGate.restartRequired,
            progressInFlight: progressAdmission.inFlight
        )
    }

    func shuffleUpcoming() {
        guard canShuffleUpcoming else { return }
        queue = shuffledUpcoming(queue, after: index) { Double.random(in: 0..<1) }
    }

    var canShuffleSampleQueue: Bool {
        !isShuffledQueuePending && shuffleAdmission.allowsSampleQueue(count: queue.count, index: index)
    }

    func shuffleSampleQueue() {
        guard canShuffleSampleQueue else { return }
        let staged = shuffledSampleQueue(queue) { testHooks?.draw() ?? Double.random(in: 0..<1) }
        beginLoad(0, reason: .manual, stagedQueue: staged)
    }

    private func discardStagedShuffledQueue() {
        stagedShuffledQueue = nil
        if isShuffledQueuePending { isShuffledQueuePending = false }
    }

    private func failStagedShuffledQueueIfNeeded() {
        if stagedShuffledQueue != nil { failedShuffledQueue = true }
        discardStagedShuffledQueue()
    }

    var canSeek: Bool { canTransport && duration.isFinite && duration > 0 }

    func seek(to seconds: Double, occurrence expectedOccurrence: Int? = nil) {
        guard (expectedOccurrence == nil || expectedOccurrence == occurrence), canSeek, seconds.isFinite, let token = seekGate.begin() else { return }
        let target = min(max(0, seconds), duration)
        let generation = windowGeneration
        let occurrenceGeneration = queueState.activeGeneration
        queueState.markSeekAssisted()
        progressAdmission.invalidate()
        publishNowPlaying()
        let watchdog = Task {
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            guard seekGate.isActive(token) else { return }
            recoveryRequired = true
            status = "Seek stalled. Quit and reopen to recover safely."
            record("seek stalled; restart required to avoid a late seek on another item")
            publishNowPlaying()
        }
        Task {
            defer {
                watchdog.cancel()
                let valid = seekGate.isActive(token)
                seekGate.finish(token)
                if valid && deferredSeekEnd && !recoveryRequired && windowOpen && generation == windowGeneration { deferredSeekEnd = false; advanceNaturally() }
                publishNowPlaying()
            }
            do {
                guard !recoveryRequired, windowOpen, generation == windowGeneration, seekGate.isActive(token) else { return }
                try await player.seek(to: target, generation: occurrenceGeneration)
                guard windowOpen, generation == windowGeneration, seekGate.isActive(token) else { return }
                record("seek command accepted; position awaits observation")
            } catch {
                guard windowOpen, generation == windowGeneration, seekGate.isActive(token) else { return }
                record("seek command failed (details redacted)")
            }
        }
    }

    private func invalidateSeek() {
        // The bridge cannot cancel an already issued seek. Release the UI gate,
        // but do not issue more mutations on a player that may complete it late.
        if seekGate.seeking {
            recoveryRequired = true
            record("seek invalidated; restart required because the player operation may still complete")
        }
        seekGate.invalidate()
    }

    private func resetProgress() {
        occurrence += 1
        progressAdmission.invalidate()
        progressEligible = false
        deferredSeekEnd = false
        elapsed = 0
        duration = 0
        observedPlaying = false
        intent.observe(false)
        publishNowPlaying()
    }

    private func refreshProgress() {
        let now = ProcessInfo.processInfo.systemUptime
        if windowOpen && !recoveryRequired && progressAdmission.stalled(now: now) {
            progressAdmission.invalidate()
            requireRestart("progress polling exhausted its two outstanding evaluations")
            return
        }
        guard ready, windowOpen, !recoveryRequired, progressEligible, queueState.pending == nil, !seekGate.seeking else { return }
        guard let ticket = progressAdmission.begin(now: now) else {
            if progressAdmission.saturated && !progressTimeoutLogged {
                progressTimeoutLogged = true
                record("progress polling stalled; waiting for an outstanding player evaluation")
            }
            return
        }
        // Evaluations name the active occurrence; a load completing mid-poll
        // changes the bridge generation and rejects the stale evaluation.
        let occurrenceGeneration = queueState.activeGeneration
        Task {
            defer { progressAdmission.finish(id: ticket.id) }
            do {
                let time: Double
                let length: Double
                if let testHooks {
                    (time, length) = try await testHooks.progress(occurrenceGeneration)
                } else {
                    time = try await player.getCurrentTime(generation: occurrenceGeneration)
                    guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation) else { return }
                    length = try await player.getDuration(generation: occurrenceGeneration)
                }
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation) else { return }
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation), ready, windowOpen, !recoveryRequired, progressEligible, queueState.pending == nil, !seekGate.seeking else { return }
                guard let snapshot = ProgressSnapshot(elapsed: time, duration: length) else {
                    elapsed = 0; duration = 0; publishNowPlaying(); return
                }
                duration = snapshot.duration
                elapsed = snapshot.elapsed
                progressTimeoutLogged = false
                publishNowPlaying()
            } catch {
                // A stale evaluation that fails after a generation advance was
                // already invalidated above and has no effect. A failure on a
                // still-current ticket names the active occurrence: a ready
                // instance that cannot answer a basic evaluation cannot be
                // trusted for further observations, so the session fails closed.
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation), !recoveryRequired, windowOpen else { return }
                elapsed = 0; duration = 0
                requireRestart("progress evaluation failed for the active occurrence")
            }
        }
    }

    private func publishNowPlaying() {
        guard testHooks == nil else { return }
        let center = MPRemoteCommandCenter.shared()
        let available = canTransport
        remoteEligibility.update(transport: available, next: canNext, seek: canSeek, window: windowGeneration, occurrence: occurrence)
        center.playCommand.isEnabled = available
        center.pauseCommand.isEnabled = available
        center.togglePlayPauseCommand.isEnabled = available
        center.nextTrackCommand.isEnabled = canNext
        center.changePlaybackPositionCommand.isEnabled = canSeek
        let nowPlaying = MPNowPlayingInfoCenter.default()
        guard nowPlayingAvailable else {
            nowPlaying.nowPlayingInfo = nil
            nowPlaying.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: queue[index].title ?? "Playback Lab · last accepted item \(index + 1)"
        ]
        if let artist = queue[index].channel { info[MPMediaItemPropertyArtist] = artist }
        // The embedded player may change speed; do not assert a rate of 1.
        if !observedPlaying { info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0 }
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        }
        nowPlaying.nowPlayingInfo = info
        nowPlaying.playbackState = observedPlaying ? .playing : .paused
    }

    var nowPlayingAvailable: Bool {
        ready && !playerError && windowOpen && !recoveryRequired && queueState.pending == nil
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func register(_ command: MPRemoteCommand, kind: Int, _ action: @escaping @MainActor (Double?, Int) -> MPRemoteCommandHandlerStatus) {
            let snapshot = remoteEligibility
            let token = command.addTarget { event in
                // Never synchronously wait for the main queue from a system callback.
                // Success means queued for validation, not accepted by the player.
                let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                let eligibility = snapshot.read()
                guard kind == 0 ? eligibility.transport : (kind == 1 ? eligibility.next : eligibility.seek && position?.isFinite == true) else { return .commandFailed }
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // The snapshot is bound to the window generation and the
                    // occurrence; a natural advance or window change between the
                    // system callback and this task discards the command instead
                    // of applying it to a superseded player.
                    guard self.windowOpen, self.windowGeneration == eligibility.window, self.occurrence == eligibility.occurrence else {
                        self.record("system command discarded; window or occurrence superseded")
                        return
                    }
                    if action(position, eligibility.occurrence) != .success { self.record("system command rejected (player unavailable or busy)") }
                }
                return .success
            }
            remoteHandlers.append((command, token))
        }
        register(center.playCommand, kind: 0) { [weak self] _, _ in
            guard let self, self.canTransport else { return .commandFailed }
            self.play(); return .success
        }
        register(center.pauseCommand, kind: 0) { [weak self] _, _ in
            guard let self, self.canTransport else { return .commandFailed }
            self.pause(); return .success
        }
        register(center.togglePlayPauseCommand, kind: 0) { [weak self] _, _ in
            guard let self, self.canTransport else { return .commandFailed }
            if self.intent.wantsPlayback { self.pause() } else { self.play() }; return .success
        }
        register(center.nextTrackCommand, kind: 1) { [weak self] _, _ in
            guard let self, self.canNext else { return .commandFailed }
            self.next(); return .success
        }
        register(center.changePlaybackPositionCommand, kind: 2) { [weak self] position, boundOccurrence in
            guard let self, self.canSeek, let position, position.isFinite else { return .commandFailed }
            self.seek(to: position, occurrence: boundOccurrence); return .success
        }
    }

    deinit {
        for (command, token) in remoteHandlers { command.removeTarget(token) }
        if testHooks == nil {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
        }
    }

    /// A closed listening surface cannot retain media, remote controls or callbacks.
    func stop() {
        windowOpen = false
        recoveryRequired = true
        onNaturalCompletion = nil
        onQueueChanged = nil
        subscriptions.removeAll()
        player.stop()
        for (command, token) in remoteHandlers { command.removeTarget(token) }
        remoteHandlers.removeAll()
        publishNowPlaying()
    }

    func attach(window: NSWindow) {
        guard playerWindow !== window else { return }
        if isShuffledQueuePending {
            failOccurrence("shuffled queue load interrupted by window replacement")
        }
        playerWindow = window
        windowGeneration += 1
        windowOpen = true
        publishNowPlaying()
        record("player window attached: \(window.windowNumber), occlusion-visible=\(window.occlusionState.contains(.visible)); not a visibility proof")
    }

    private func command(_ name: String, wantsPlayback: Bool?, action: @escaping @MainActor (Int) async throws -> Void) {
        guard canTransport, let mutation = mutationGate.begin() else { return }
        let token = wantsPlayback.map { intent.admit($0) }
        let generation = windowGeneration
        // No load can interleave with this mutation (select requires
        // !mutationInFlight), so the active occurrence cannot change underneath it.
        let occurrenceGeneration = queueState.activeGeneration
        mutationInFlight = true
        let watchdog = mutationWatchdog(mutation)
        publishNowPlaying()
        Task {
            defer {
                watchdog.cancel()
                let advance = mutationGate.finish(mutation, current: mutationContext)
                mutationInFlight = false
                publishNowPlaying()
                if advance && windowOpen && ready && !recoveryRequired { advanceNaturally() }
            }
            guard windowOpen, generation == windowGeneration else { return }
            do {
                try await action(occurrenceGeneration)
                guard !recoveryRequired, windowOpen, generation == windowGeneration else { return }
                record("\(name) command completed for generation \(occurrenceGeneration)")
            } catch {
                guard !recoveryRequired, windowOpen, generation == windowGeneration else { return }
                if let token { intent.failed(token) }
                record("\(name) command failed for generation \(occurrenceGeneration) (details redacted)")
            }
        }
    }

    func record(_ message: String) {
        sequence += 1
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stamp = formatter.string(from: Date())
        let elapsed = String(format: "%.3f", ProcessInfo.processInfo.systemUptime - started)
        log.append("#\(sequence) \(stamp) +\(elapsed)s | last accepted \(index + 1)/\(queue.count) \(queue[index].videoID) | requested \(queueState.requested) accepted \(queueState.accepted) natural-observed \(queueState.observedNatural) | \(message)")
        if log.count > 500 { log.removeFirst(log.count - 500) }
    }

    private static func errorLabel(_ code: Int) -> String {
        switch code {
        case 2: return "invalid source (2)"
        case 5: return "HTML5 failure (5)"
        case 100: return "unavailable or private (100)"
        case 101, 150: return "embedding prohibited (\(code))"
        case 153: return "missing client identification (153)"
        default: return "iframe error (\(code))"
        }
    }
}
