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
    #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
    private(set) var twoAccountDiagnostic: TwoAccountDiagnosticModel?
    #endif

    init(factory: Factory? = nil) {
        self.factory = factory
        state = factory == nil ? .unavailable : .signedOut
        super.init()
    }
    #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
    convenience init(twoAccountDiagnostic: TwoAccountDiagnosticModel) {
        self.init()
        self.twoAccountDiagnostic = twoAccountDiagnostic
    }
    #endif

    func attach(window: NSWindow) {
        if self.window === window { return }
        if let existing = self.window {
            NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: existing)
            clearAccount()
        }
        self.window = window
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        twoAccountDiagnostic?.attach(window: window)
        #endif
        NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose(_:)),
                                               name: NSWindow.willCloseNotification, object: window)
    }

    @objc private func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, self.window === window else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: window)
        self.window = nil
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        twoAccountDiagnostic?.detach()
        #endif
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
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        twoAccountDiagnostic?.reset()
        #endif
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
    private let diagnostic = ProcessInfo.processInfo.arguments.contains { $0 == "--playback-lab" || $0.hasPrefix("--local-") }

    init() {
        guard ProcessInfo.processInfo.arguments.dropFirst().elementsEqual(["--prepare-personal-import"]) else { return }
        do {
            let configuration = try NativePersonalImportServices.live.configuration()
            let digest = try NativePersonalImportCredential(configuration: configuration).prepare()
            FileHandle.standardOutput.write(Data((digest + "\n").utf8))
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("Personal import access could not be prepared. No existing credential was replaced.\n".utf8))
            exit(1)
        }
    }

    var body: some Scene {
        Window("TubeShuffle", id: "player") {
            if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
                // Hosted synthetic tests must not open libraries, preferences,
                // credentials or a live player merely by launching their host.
                Color.clear.frame(width: 1, height: 1)
            } else if diagnostic {
                PlaybackLabRoot().frame(minWidth: 780, minHeight: 620)
            } else {
                NativeLibraryView().frame(minWidth: 480, minHeight: 680)
            }
        }.defaultSize(width: 1280, height: 860)
            .commands { NativeZoomCommands() }
    }
}

private struct PlaybackLabRoot: View {
    @StateObject private var coordinator = PlayerCoordinator()
    @StateObject private var account: AccountViewModel = {
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        if ProcessInfo.processInfo.arguments.contains("--local-two-account-diagnostic") {
            return AccountViewModel(twoAccountDiagnostic: TwoAccountDiagnosticModel())
        }
        if ProcessInfo.processInfo.arguments.contains("--local-oauth-diagnostic") {
            return AccountViewModel(factory: { try LocalOAuthDiagnosticService(window: $0) })
        }
        #endif
        return AccountViewModel()
    }()

    var body: some View { ContentView(coordinator: coordinator, account: account) }
}

struct ContentView: View {
    @ObservedObject var coordinator: PlayerCoordinator
    @ObservedObject var account: AccountViewModel
    @State private var seeking = false
    @State private var seekPosition: Double = 0
    @State private var seekOccurrence: Int?
    @State private var showingSampleLibrary = false

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
                Button { showingSampleLibrary = true } label: {
                    Label("Sample library", systemImage: "books.vertical")
                }
                .sheet(isPresented: $showingSampleLibrary) {
                    SampleLibraryView()
                }
                AccountControl(account: account)
            }
            HStack(alignment: .top, spacing: 16) {
                PlayerWebView(player: coordinator.player)
                    .frame(minWidth: 480, minHeight: 270)
                    .aspectRatio(16 / 9, contentMode: .fit)
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Queue").font(.headline)
                        Text("SAMPLE").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Button(action: coordinator.shuffleSampleQueue) {
                        Label("Shuffle sample queue", systemImage: "shuffle")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!coordinator.canShuffleSampleQueue)
                    .help("Create a new shuffled queue from the sample videos.")
                    .accessibilityHint("Creates a new shuffled queue from the sample videos.")
                    Button(action: coordinator.shuffleUpcoming) {
                        Label("Shuffle upcoming", systemImage: "shuffle")
                    }
                    .disabled(!coordinator.canShuffleUpcoming)
                    .help("Shuffle the upcoming items in this sample queue, leaving the current item in place.")
                    .accessibilityHint("Changes the order of upcoming items without changing the current item.")
                    ForEach(Array(coordinator.queue.enumerated()), id: \.element.id) { position, item in
                        HStack(spacing: 8) {
                            Image(systemName: position == coordinator.index ? "circle.inset.filled" : "circle")
                                .frame(width: 16).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(position + 1). \(item.videoID)").font(.system(.caption, design: .monospaced))
                                if position == coordinator.index {
                                    Text("Last accepted").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }.accessibilityLabel("Item \(position + 1), \(item.videoID)\(position == coordinator.index ? ", last accepted" : "")")
                    }
                    Spacer(minLength: 0)
                    Text("Natural observed: \(coordinator.queueState.observedNatural)").font(.caption).foregroundStyle(.secondary)
                    Text("Requested \(coordinator.queueState.requested) · accepted \(coordinator.queueState.accepted)").font(.caption).foregroundStyle(.secondary)
                    if coordinator.isShuffledQueuePending {
                        Text("Loading shuffled queue…").font(.caption)
                    } else if let pending = coordinator.queueState.pending {
                        Text("Loading item \(pending.target + 1)").font(.caption)
                    }
                    if coordinator.failedShuffledQueue {
                        Text("Shuffled queue could not load").font(.caption)
                    } else if let failed = coordinator.queueState.failedTarget {
                        Text("Item \(failed + 1) command failed").font(.caption)
                    }
                    if !coordinator.isShuffledQueuePending && !coordinator.recoveryRequired && coordinator.index == coordinator.queue.count - 1 {
                        Text("Last item in queue. Next is unavailable.")
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
                if !coordinator.isShuffledQueuePending && !coordinator.recoveryRequired && coordinator.index == coordinator.queue.count - 1 {
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

    @ViewBuilder var body: some View {
        #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
        if let diagnostic = account.twoAccountDiagnostic {
            Button { showingAccount = true } label: { Label("Private check", systemImage: "person.2") }
                .sheet(isPresented: $showingAccount, onDismiss: { diagnostic.reset() }) {
                    VStack(alignment: .leading, spacing: 16) {
                        TwoAccountDiagnosticControl(model: diagnostic)
                        Divider()
                        HStack { Spacer(); Button("Close") { diagnostic.reset(); showingAccount = false } }
                    }.padding(20).frame(width: 360)
                }
        } else {
            standardControl
        }
        #else
        standardControl
        #endif
    }

    private var standardControl: some View {
        Button { showingAccount.toggle() } label: {
            Label(label, systemImage: account.state == .signedIn ? "person.crop.circle.fill" : "person.crop.circle")
        }
        .popover(isPresented: $showingAccount, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Account").font(.headline)
                accountContent
            }
            .padding(16).frame(width: 300, alignment: .leading)
        }
    }

    private var accountContent: some View {
        VStack(alignment: .leading, spacing: 12) {
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
    }
}

#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
private struct TwoAccountDiagnosticControl: View {
    @ObservedObject var model: TwoAccountDiagnosticModel
    private func resultText(_ result: TwoAccountReadOnlyDiagnostic.Outcome) -> String {
        switch result {
        case .confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount:
            return "The selected owner row was hidden from the second account. This single check does not establish general isolation or the provider used for either sign-in."
        case .rowIsolationInconclusive:
            return "Inconclusive: the owner read did not establish a usable owner row."
        case .rowIsolationFailure:
            return "The second account returned a row. This check did not pass."
        case .sameIdentity:
            return "Both sign-ins resolved to the same account. Try again with two accounts."
        case .linkedAccountInconclusive:
            return "Account evidence was inconclusive."
        default:
            return "The check could not be completed. No broader conclusion can be drawn."
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Private two-account check").font(.headline)
            Text("Sign in as the owner, then as a different account. The check only reads fixed account and link endpoints. On cancel, panel close, or quit, the app drops its local sessions; in-flight operations may briefly retain copies. Provider sessions are not revoked.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            switch model.state {
            case .idle:
                Button("Sign in as owner") { model.startOwner() }.disabled(model.draining)
            case .ownerSigningIn, .secondSigningIn, .checking:
                HStack { ProgressView().controlSize(.small); Text("Working…"); Spacer(); Button("Cancel") { model.reset() } }
            case .secondReady:
                Button("Sign in as second account") { model.startSecond() }.disabled(model.draining)
                Button("Cancel") { model.reset() }
            case .result(let result):
                Text(resultText(result)).font(.callout).fixedSize(horizontal: false, vertical: true)
                Button("Done") { model.reset() }.disabled(model.draining)
            case .failure:
                Text("The check could not be completed. The app dropped its local sessions; in-flight operations may briefly retain copies. Provider sessions were not revoked.").font(.callout)
                Button("Try again") { model.reset() }.disabled(model.draining)
            }
        }
    }
}
#endif

private struct PlayerWebView: NSViewRepresentable {
    let player: DirectPlayer
    func makeNSView(context: Context) -> WKWebView { player.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
