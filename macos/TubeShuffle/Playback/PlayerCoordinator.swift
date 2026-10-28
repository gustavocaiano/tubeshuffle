import AppKit
import Combine
import Foundation
import YouTubePlayerKit

@MainActor
final class PlayerCoordinator: ObservableObject {
    struct Item: Identifiable {
        let id: Int
        let videoID: String
    }

    // Fixed public examples; availability and embed permission can change.
    let queue = ["M7lc1UVf-VE", "aqz-KE-bpKQ", "ScMzIvxBSi4", "ysz5S6PUM-U", "jNQXAC9IVRw", "dQw4w9WgXcQ"]
        .enumerated().map { Item(id: $0.offset, videoID: $0.element) }
    let player = YouTubePlayer(source: .video(id: "M7lc1UVf-VE"))
    @Published private(set) var queueState = QueueState(count: 6)
    var index: Int { queueState.index }
    @Published private(set) var status = "Waiting for player"
    @Published private(set) var log: [String] = []
    @Published private(set) var ready = false
    private var subscriptions = Set<AnyCancellable>()
    private weak var playerWindow: NSWindow?
    private var sequence = 0
    private let started = ProcessInfo.processInfo.systemUptime

    init() {
        record("Session started; bundle \(Bundle.main.bundleIdentifier ?? "missing")")
        player.statePublisher.sink { [weak self] state in
            guard let self else { return }
            self.ready = state.isReady
            switch state {
            case .idle: self.status = "Waiting for player"
            case .ready: self.status = "Player ready"
            case .error(let error):
                self.queueState.invalidatePlayback()
                self.status = "Player error: \(Self.errorLabel(error)); try Next"
            }
            self.record("player state: \(self.status)")
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
        status = "Playback: \(state)"
        record(status)
        if state == .playing { queueState.playing() }
        if state == .ended {
            if queueState.ended() { advanceNaturally() }
            else { record("ended ignored or buffered; occurrence attribution unavailable") }
        }
    }

    private func advanceNaturally() {
        guard index + 1 < queue.count else { record("queue finished"); return }
        select(index + 1, reason: .natural)
    }

    func select(_ next: Int, reason: QueueState.Reason = .manual) {
        // A manual skip is permitted in library error state; whether evaluate works
        // there is a Mac observation, not a guarantee.
        guard let request = queueState.request(next, reason: reason, allowed: ready || reason == .manual) else {
            record("load rejected: \(reason.rawValue), target \(next + 1)"); return
        }
        record("load requested: \(reason.rawValue), target \(next + 1) \(queue[next].videoID), generation \(request.generation)")
        Task {
            do {
                try await player.load(source: .video(id: queue[next].videoID))
                let buffered = queueState.complete(request, success: true)
                record("load command accepted, generation \(request.generation); not proof of playback")
                if buffered { record("processing buffered playing/ended pair (unattributed)"); advanceNaturally() }
            } catch {
                _ = queueState.complete(request, success: false)
                record("load command failed, generation \(request.generation); target marked failed (details redacted)")
            }
        }
    }

    func play() { command("play") { try await self.player.play() } }
    func pause() { command("pause") { try await self.player.pause() } }
    func next() { select(queueState.nextTarget) }
    var canNext: Bool { queueState.pending == nil && queueState.nextTarget < queue.count }

    func attach(window: NSWindow) {
        guard playerWindow !== window else { return }
        playerWindow = window
        record("player window attached: \(window.windowNumber), occlusion-visible=\(window.occlusionState.contains(.visible)); not a visibility proof")
    }

    private func command(_ name: String, action: @escaping @MainActor () async throws -> Void) {
        guard ready else { return }
        Task {
            do { try await action(); record("\(name) command completed") }
            catch { record("\(name) command failed (details redacted)") }
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
