import SwiftUI
import AppKit
import WebKit

@MainActor
protocol TemporaryAccountService: AnyObject {
    func signInExpiry() async throws -> Date
    func cancel()
    func signOutLocally()
}

@MainActor
final class AccountViewModel: NSObject, ObservableObject {
    enum State: Equatable { case unavailable, signedOut, signingIn, signedIn, failure }
    typealias Factory = @MainActor (NSWindow) throws -> any TemporaryAccountService

    @Published private(set) var state: State
    private let factory: Factory?
    private weak var window: NSWindow?
    private var service: (any TemporaryAccountService)?
    private(set) var operation: Task<Void, Never>?
    private var expiryTask: Task<Void, Never>?
    private var expiry: Date?
    private var generation = UUID()

    init(factory: Factory? = nil) {
        self.factory = factory
        state = factory == nil ? .unavailable : .signedOut
        super.init()
    }

    func attach(window: NSWindow) {
        if self.window === window { return }
        if let existing = self.window {
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: existing)
            clearAccount()
        }
        self.window = window
        NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose(_:)),
                                               name: NSWindow.willCloseNotification, object: window)
    }

    @objc private func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, self.window === window else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: window)
        self.window = nil
        clearAccount()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func signIn() {
        guard state == .signedOut || state == .failure, let factory else { return }
        guard let window else { state = .failure; return }
        let service: any TemporaryAccountService
        do { service = try factory(window) } catch { state = .failure; return }
        self.service = service
        let current = UUID()
        generation = current
        state = .signingIn
        operation = Task { [weak self] in
            do {
                let expiry = try await service.signInExpiry()
                guard let self, self.generation == current else { return }
                guard expiry.timeIntervalSinceNow > 0, expiry.timeIntervalSinceNow.isFinite else {
                    self.signOut(); return
                }
                self.expiry = expiry
                self.state = .signedIn
                self.scheduleExpiry(current: current, expiry: expiry)
            } catch {
                guard let self, self.generation == current else { return }
                service.signOutLocally()
                self.service = nil
                self.state = .failure
            }
        }
    }

    func cancel() { clearAccount() }
    func signOut() { clearAccount() }

    func checkExpiry() {
        if let expiry, expiry <= Date() { signOut() }
    }

    private func clearAccount() {
        generation = UUID()
        operation?.cancel(); operation = nil
        expiryTask?.cancel(); expiryTask = nil
        service?.cancel()
        service?.signOutLocally(); service = nil
        expiry = nil
        state = factory == nil ? .unavailable : .signedOut
    }

    private func scheduleExpiry(current: UUID, expiry: Date) {
        expiryTask?.cancel()
        expiryTask = Task { [weak self] in
            // Wake periodically so wall-clock changes do not leave a stale session active.
            while !Task.isCancelled {
                let remaining = expiry.timeIntervalSinceNow
                if remaining <= 0 {
                    guard let self, self.generation == current else { return }
                    self.signOut()
                    return
                }
                try? await Task.sleep(nanoseconds: UInt64(min(remaining, 60) * 1_000_000_000))
            }
        }
    }
}

@main
struct TubeShuffleApp: App {
    @StateObject private var coordinator = PlayerCoordinator()
    @StateObject private var account: AccountViewModel = {
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        if ProcessInfo.processInfo.arguments.contains("--local-oauth-diagnostic") {
            LocalOAuthDiagnosticOutput.emit(.ready)
            return AccountViewModel(factory: { try LocalOAuthDiagnosticService(window: $0) })
        }
        #endif
        return AccountViewModel()
    }()

    var body: some Scene {
        Window("TubeShuffle Playback Lab", id: "player") {
            ContentView(coordinator: coordinator, account: account)
                .frame(minWidth: 780, minHeight: 620)
        }
    }
}

struct ContentView: View {
    @ObservedObject var coordinator: PlayerCoordinator
    @ObservedObject var account: AccountViewModel
    @State private var seeking = false
    @State private var seekPosition: Double = 0
    @State private var seekOccurrence: Int?

    private func timeLabel(_ seconds: Double) -> String {
        let value = Int(max(0, seconds.isFinite ? seconds : 0))
        return String(format: "%d:%02d", value / 60, value % 60)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Playback Lab").font(.title2.weight(.semibold))
                    Text("Native queue · YouTube embedded player").foregroundStyle(.secondary)
                }
                Spacer()
                Text("P0 PROTOTYPE").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                AccountControl(account: account)
            }
            HStack(alignment: .top, spacing: 16) {
                PlayerWebView(player: coordinator.player)
                    .frame(minWidth: 480, minHeight: 270)
                    .aspectRatio(16 / 9, contentMode: .fit)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Queue").font(.headline)
                    ForEach(coordinator.queue) { item in
                        HStack(spacing: 8) {
                            Image(systemName: item.id == coordinator.index ? "play.fill" : "circle")
                                .frame(width: 16).foregroundStyle(item.id == coordinator.index ? Color.blue : Color.secondary)
                            Text("\(item.id + 1). \(item.videoID)").font(.system(.caption, design: .monospaced))
                        }.accessibilityLabel("Item \(item.id + 1), \(item.videoID)\(item.id == coordinator.index ? ", last accepted" : "")")
                    }
                    Spacer(minLength: 0)
                    Text("Natural observed: \(coordinator.queueState.observedNatural)").font(.caption).foregroundStyle(.secondary)
                    Text("Requested \(coordinator.queueState.requested) · accepted \(coordinator.queueState.accepted)").font(.caption).foregroundStyle(.secondary)
                    if let pending = coordinator.queueState.pending { Text("Loading item \(pending.target + 1)").font(.caption) }
                    if let failed = coordinator.queueState.failedTarget { Text("Item \(failed + 1) command failed").font(.caption) }
                    if coordinator.index == coordinator.queue.count - 1 {
                        Text("Last item in queue. Next is unavailable. If the video cannot play, quit and reopen to restart the queue.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }.frame(minWidth: 180, alignment: .leading)
            }
            HStack {
                Button("Play", action: coordinator.play).disabled(!coordinator.canTransport)
                Button("Pause", action: coordinator.pause).disabled(!coordinator.canTransport)
                Button("Next", action: coordinator.next).disabled(!coordinator.canNext)
                if coordinator.recoveryRequired {
                    Button("Quit to recover") { NSApp.terminate(nil) }
                        .help("Reopen the app to create a fresh player.")
                }
                if !coordinator.recoveryRequired && coordinator.index == coordinator.queue.count - 1 {
                    Button("Quit to restart") { NSApp.terminate(nil) }
                        .help("Reopen the app to start the queue again.")
                }
                Spacer()
                Text(coordinator.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 10) {
                Text(timeLabel(seeking ? seekPosition : coordinator.elapsed))
                    .monospacedDigit().foregroundStyle(.secondary)
                Slider(value: Binding(
                    get: { seeking ? seekPosition : coordinator.elapsed },
                    set: { value in
                        if seeking && seekOccurrence != coordinator.occurrence { return }
                        seekPosition = value
                        if !seeking && coordinator.canSeek { coordinator.seek(to: value, occurrence: coordinator.occurrence) }
                    }
                ), in: 0...max(coordinator.duration, 1), onEditingChanged: { editing in
                    if editing { seekPosition = coordinator.elapsed; seekOccurrence = coordinator.occurrence; seeking = true }
                    else {
                        let occurrence = seekOccurrence
                        seeking = false; seekOccurrence = nil
                        if let occurrence { coordinator.seek(to: seekPosition, occurrence: occurrence) }
                    }
                })
                .disabled(!coordinator.canSeek)
                .onChange(of: coordinator.occurrence) { _ in
                    seekOccurrence = nil
                }
                .accessibilityLabel("Playback position")
                .accessibilityValue("\(timeLabel(seeking ? seekPosition : coordinator.elapsed)) of \(timeLabel(coordinator.duration))")
                Text(timeLabel(coordinator.duration)).monospacedDigit().foregroundStyle(.secondary)
            }.font(.caption)
            Divider()
            HStack {
                Text("Event log").font(.headline)
                Spacer()
                Text("Most recent 500 entries · select to copy").font(.caption).foregroundStyle(.secondary)
            }
            ScrollView {
                Text(coordinator.log.joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }.padding(20).background(WindowObserver(coordinator: coordinator, account: account))
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                account.checkExpiry()
            }
    }
}

private struct WindowObserver: NSViewRepresentable {
    let coordinator: PlayerCoordinator
    let account: AccountViewModel
    func makeNSView(context: Context) -> NSView {
        let view = WindowTrackingView()
        view.attached = { [weak coordinator, weak account] window in
            account?.attach(window: window)
            coordinator?.attach(window: window)
        }
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {
        if let window = view.window { account.attach(window: window); coordinator.attach(window: window) }
    }
}

final class WindowTrackingView: NSView {
    var attached: ((NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { attached?(window) }
    }
}

private struct AccountControl: View {
    @ObservedObject var account: AccountViewModel
    @State private var showingAccount = false

    private var label: String {
        switch account.state {
        case .unavailable: return "Account unavailable"
        case .signedOut: return "Account"
        case .signingIn: return "Signing in"
        case .signedIn: return "Signed in"
        case .failure: return "Account issue"
        }
    }

    var body: some View {
        Button { showingAccount.toggle() } label: {
            Label(label, systemImage: account.state == .signedIn ? "person.crop.circle.fill" : "person.crop.circle")
        }
        .popover(isPresented: $showingAccount, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Account").font(.headline)
                Text("Sign-in is temporary and stays in memory while the app is open. Signing out here only clears this app’s session; it does not sign you out elsewhere.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Divider()
                switch account.state {
                case .unavailable:
                    Text("Sign-in is not configured yet.").font(.callout)
                case .signedOut:
                    Button("Sign in with Google") { account.signIn() }
                case .signingIn:
                    HStack { ProgressView().controlSize(.small); Text("Signing in…"); Spacer(); Button("Cancel") { account.cancel() } }
                case .signedIn:
                    HStack { Label("Signed in", systemImage: "checkmark.circle.fill").foregroundStyle(.green); Spacer(); Button("Sign out") { account.signOut() } }
                case .failure:
                    Text("Couldn’t sign in. Please try again.").font(.callout)
                    Button("Try again") { account.signIn() }
                }
            }
            .padding(16).frame(width: 300, alignment: .leading)
        }
    }
}

private struct PlayerWebView: NSViewRepresentable {
    let player: DirectPlayer
    func makeNSView(context: Context) -> WKWebView { player.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
