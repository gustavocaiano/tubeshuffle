import AppKit
import Combine
import Foundation
import MediaPlayer
import YouTubePlayerKit

// MediaPlayer callbacks can arrive on any thread; this snapshot is advisory and
// all commands are revalidated on the main actor before being issued.
private final class RemoteEligibility {
    private let lock = NSLock()
    private var values = (transport: false, next: false, seek: false, generation: 0)
    func update(transport: Bool, next: Bool, seek: Bool, generation: Int) {
        lock.lock(); defer { lock.unlock() }
        values = (transport, next, seek, generation)
    }
    func read() -> (transport: Bool, next: Bool, seek: Bool, generation: Int) {
        lock.lock(); defer { lock.unlock() }; return values
    }
}

@MainActor
final class PlayerCoordinator: ObservableObject {
    struct Item: Identifiable {
        let id: Int
        let videoID: String
    }

    // Fixed public examples; availability and embed permission can change.
    let queue = ["ScMzIvxBSi4", "jNQXAC9IVRw", "dQw4w9WgXcQ", "M7lc1UVf-VE", "aqz-KE-bpKQ", "ysz5S6PUM-U"]
        .enumerated().map { Item(id: $0.offset, videoID: $0.element) }
    let player = YouTubePlayer(source: .video(id: "ScMzIvxBSi4"))
    @Published private(set) var queueState = QueueState(count: 6)
    var index: Int { queueState.index }
    @Published private(set) var status = "Waiting for player"
    @Published private(set) var log: [String] = []
    @Published private(set) var ready = false
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var duration: Double = 0
    private var observedPlaying = false
    private var intent = PlaybackIntent()
    @Published private var seekGate = SeekGate()
    private var deferredSeekEnd = false
    private var progressEligible = false
    private var windowOpen = false
    private var windowGeneration = 0
    private var playerError = false
    @Published private var mutationInFlight = false
    private var mutationGate = MutationGate()
    @Published private(set) var recoveryRequired = false
    private let remoteEligibility = RemoteEligibility()
    @Published private(set) var occurrence = 0
    private var progressAdmission = ProgressAdmission()
    private var progressTimeoutLogged = false
    private var remoteHandlers: [(MPRemoteCommand, Any)] = []
    private var subscriptions = Set<AnyCancellable>()
    private weak var playerWindow: NSWindow?
    private var sequence = 0
    private let started = ProcessInfo.processInfo.systemUptime

    init() {
        setupRemoteCommands()
        Timer.publish(every: 1, on: .main, in: .common).autoconnect()
            .sink { [weak self] _ in self?.refreshProgress() }.store(in: &subscriptions)
        record("Session started; bundle \(Bundle.main.bundleIdentifier ?? "missing")")
        player.statePublisher.sink { [weak self] state in
            guard let self else { return }
            self.ready = state.isReady
            if case .error = state { self.playerError = true } else { self.playerError = false }
            switch state {
            case .idle:
                self.queueState.invalidatePlayback()
                self.invalidateSeek()
                self.resetProgress()
                self.status = "Waiting for player"
            case .ready: self.status = "Player ready"
            case .error(let error):
                self.queueState.invalidatePlayback()
                self.invalidateSeek()
                self.resetProgress()
                self.status = "Player error: \(Self.errorLabel(error))"
            }
            self.record("player state: \(self.status)")
            self.publishNowPlaying()
        }.store(in: &subscriptions)
        player.eventPublisher.sink { [weak self] event in
            // Event payloads are untrusted and may contain URLs; only numeric data is logged.
            let raw = event.data?.value ?? ""
            let safe = Int(raw).map(String.init) ?? (raw.isEmpty ? "none" : "non-numeric redacted")
            self?.record("event \(event.name.rawValue), data \(safe)")
        }.store(in: &subscriptions)
        player.playbackStatePublisher.sink { [weak self] state in
            self?.playbackChanged(state)
        }.store(in: &subscriptions)
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
                    self.mutationGate.invalidate()
                    if self.mutationGate.restartRequired { self.requireRestart("player operation interrupted by window close") }
                    self.windowOpen = false
                    self.windowGeneration += 1
                    self.playerWindow = nil
                    self.queueState.invalidatePlayback()
                    self.invalidateSeek()
                    self.resetProgress()
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

    private func playbackChanged(_ state: YouTubePlayer.PlaybackState) {
        guard ready, windowOpen, !recoveryRequired else { return }
        observedPlaying = state == .playing
        if state == .playing { intent.observe(true); progressEligible = queueState.pending == nil }
        if state == .paused || state == .ended { intent.observe(false) }
        publishNowPlaying()
        refreshProgress()
        status = "Playback: \(state)"
        record(status)
        if state == .playing { queueState.playing() }
        if state == .ended {
            if queueState.ended() {
                if seekGate.seeking { deferredSeekEnd = true }
                else if mutationInFlight { mutationGate.deferEnd(mutationContext) }
                else { advanceNaturally() }
            }
            else { record("ended ignored or buffered; occurrence attribution unavailable") }
        }
    }

    private func advanceNaturally() {
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

    private func mutationWatchdog(_ token: Int) -> Task<Void, Never> {
        Task {
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            if mutationGate.timeout(token) { requireRestart("player mutation stalled") }
        }
    }

    func select(_ next: Int, reason: QueueState.Reason = .manual) {
        guard !seekGate.seeking, !mutationInFlight, !recoveryRequired,
              let request = queueState.request(next, reason: reason, allowed: windowOpen && (ready || (reason == .manual && playerError))) else {
            record("load rejected: \(reason.rawValue), target \(next + 1)"); return
        }
        seekGate.invalidate()
        resetProgress()
        guard let token = mutationGate.begin() else { return }
        mutationInFlight = true
        let watchdog = mutationWatchdog(token)
        let generation = windowGeneration
        publishNowPlaying()
        record("load requested: \(reason.rawValue), target \(next + 1) \(queue[next].videoID), generation \(request.generation)")
        Task {
            defer {
                watchdog.cancel()
                let advance = mutationGate.finish(token, current: mutationContext)
                mutationInFlight = false
                publishNowPlaying()
                if advance && windowOpen && ready && !recoveryRequired { advanceNaturally() }
            }
            guard windowOpen, generation == windowGeneration else { return }
            do {
                try await player.load(source: .video(id: queue[next].videoID))
                guard !recoveryRequired, windowOpen, generation == windowGeneration, queueState.pending?.generation == request.generation else { return }
                let playingCandidate = queueState.hasBufferedPlaying
                let buffered = queueState.complete(request, success: true)
                progressEligible = playingCandidate && !buffered && ready && windowOpen
                publishNowPlaying()
                refreshProgress()
                record("load command accepted, generation \(request.generation); not proof of playback")
                if buffered {
                    record("processing buffered playing/ended pair (unattributed)")
                    mutationGate.deferEnd(mutationContext)
                }
            } catch {
                guard !recoveryRequired, windowOpen, generation == windowGeneration, queueState.pending?.generation == request.generation else { return }
                _ = queueState.complete(request, success: false)
                resetProgress()
                record("load command failed, generation \(request.generation); target marked failed (details redacted)")
            }
        }
    }

    func play() { command("play", wantsPlayback: true) { try await self.player.play() } }
    func pause() { command("pause", wantsPlayback: false) { try await self.player.pause() } }
    func next() { select(queueState.nextTarget) }
    var canTransport: Bool { ready && windowOpen && !recoveryRequired && !mutationInFlight && !seekGate.seeking && queueState.pending == nil }
    var canNext: Bool { windowOpen && (ready || playerError) && !recoveryRequired && !mutationInFlight && !seekGate.seeking && queueState.pending == nil && queueState.nextTarget < queue.count }

    var canSeek: Bool { canTransport && duration.isFinite && duration > 0 }

    func seek(to seconds: Double, occurrence expectedOccurrence: Int? = nil) {
        guard (expectedOccurrence == nil || expectedOccurrence == occurrence), canSeek, seconds.isFinite, let token = seekGate.begin() else { return }
        let target = min(max(0, seconds), duration)
        let generation = windowGeneration
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
                try await player.seek(to: Measurement(value: target, unit: UnitDuration.seconds))
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
        Task {
            defer { progressAdmission.finish(id: ticket.id) }
            do {
                let time = try await player.getCurrentTime().converted(to: .seconds).value
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation) else { return }
                let length = try await player.getDuration().converted(to: .seconds).value
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation), ready, windowOpen, !recoveryRequired, progressEligible, queueState.pending == nil, !seekGate.seeking else { return }
                guard let snapshot = ProgressSnapshot(elapsed: time, duration: length) else {
                    elapsed = 0; duration = 0; publishNowPlaying(); return
                }
                duration = snapshot.duration
                elapsed = snapshot.elapsed
                progressTimeoutLogged = false
                publishNowPlaying()
            } catch {
                guard progressAdmission.isCurrent(id: ticket.id, generation: ticket.generation) else { return }
                elapsed = 0; duration = 0
                if !progressTimeoutLogged { record("progress evaluation failed (details redacted)"); progressTimeoutLogged = true }
                publishNowPlaying()
            }
        }
    }

    private func publishNowPlaying() {
        let center = MPRemoteCommandCenter.shared()
        let available = canTransport
        remoteEligibility.update(transport: available, next: canNext, seek: canSeek, generation: windowGeneration)
        center.playCommand.isEnabled = available
        center.pauseCommand.isEnabled = available
        center.togglePlayPauseCommand.isEnabled = available
        center.nextTrackCommand.isEnabled = canNext
        center.changePlaybackPositionCommand.isEnabled = canSeek
        let nowPlaying = MPNowPlayingInfoCenter.default()
        guard ready && windowOpen else {
            nowPlaying.nowPlayingInfo = nil
            nowPlaying.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: "Playback Lab · last accepted item \(index + 1)"
        ]
        // The embedded player may change speed; do not assert a rate of 1.
        if !observedPlaying { info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0 }
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        }
        nowPlaying.nowPlayingInfo = info
        nowPlaying.playbackState = observedPlaying ? .playing : .paused
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        func register(_ command: MPRemoteCommand, kind: Int, _ action: @escaping @MainActor (Double?) -> MPRemoteCommandHandlerStatus) {
            let snapshot = remoteEligibility
            let token = command.addTarget { event in
                // Never synchronously wait for the main queue from a system callback.
                // Success means queued for validation, not accepted by the player.
                let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime
                let eligibility = snapshot.read()
                guard kind == 0 ? eligibility.transport : (kind == 1 ? eligibility.next : eligibility.seek && position?.isFinite == true) else { return .commandFailed }
                Task { @MainActor [weak self] in
                    guard let self, self.windowOpen, self.windowGeneration == eligibility.generation else { return }
                    if action(position) != .success { self.record("system command rejected (player unavailable or busy)") }
                }
                return .success
            }
            remoteHandlers.append((command, token))
        }
        register(center.playCommand, kind: 0) { [weak self] _ in
            guard let self, self.canTransport else { return .commandFailed }
            self.play(); return .success
        }
        register(center.pauseCommand, kind: 0) { [weak self] _ in
            guard let self, self.canTransport else { return .commandFailed }
            self.pause(); return .success
        }
        register(center.togglePlayPauseCommand, kind: 0) { [weak self] _ in
            guard let self, self.canTransport else { return .commandFailed }
            if self.intent.wantsPlayback { self.pause() } else { self.play() }; return .success
        }
        register(center.nextTrackCommand, kind: 1) { [weak self] _ in
            guard let self, self.canNext else { return .commandFailed }
            self.next(); return .success
        }
        register(center.changePlaybackPositionCommand, kind: 2) { [weak self] position in
            guard let self, self.canSeek, let position, position.isFinite else { return .commandFailed }
            self.seek(to: position); return .success
        }
    }

    deinit {
        for (command, token) in remoteHandlers { command.removeTarget(token) }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    func attach(window: NSWindow) {
        guard playerWindow !== window else { return }
        playerWindow = window
        windowGeneration += 1
        windowOpen = true
        publishNowPlaying()
        record("player window attached: \(window.windowNumber), occlusion-visible=\(window.occlusionState.contains(.visible)); not a visibility proof")
    }

    private func command(_ name: String, wantsPlayback: Bool, action: @escaping @MainActor () async throws -> Void) {
        guard canTransport, let mutation = mutationGate.begin() else { return }
        let token = intent.admit(wantsPlayback)
        let generation = windowGeneration
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
                try await action()
                guard !recoveryRequired, windowOpen, generation == windowGeneration else { return }
                record("\(name) command completed")
            } catch {
                guard !recoveryRequired, windowOpen, generation == windowGeneration else { return }
                intent.failed(token)
                record("\(name) command failed (details redacted)")
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

    private static func errorLabel(_ error: YouTubePlayer.Error) -> String {
        switch error {
        case .invalidSource: return "invalid source (2)"
        case .html5NotSupported: return "HTML5 failure (5)"
        case .notFound: return "unavailable or private (100)"
        case .embeddedVideoPlayingNotAllowed: return "embedding prohibited (101/150)"
        case .missingAPIClientIdentification: return "missing client identification (153)"
        case .iFrameApiFailedToLoad: return "iframe API failed to load"
        case .webContentProcessDidTerminate: return "web content process terminated"
        case .setupFailed: return "setup failed (details redacted)"
        case .didFailProvisionalNavigation, .didFailNavigation: return "navigation failed (details redacted)"
        }
    }
}
