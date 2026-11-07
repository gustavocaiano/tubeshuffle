import AppKit
import SwiftUI

@MainActor
protocol NativePlaylistSource: AnyObject {
    var canFetchPlaylists: Bool { get }
    var message: String? { get }
    func fetchPlaylist(_ id: String) async -> YouTubePlaylistDTO?
}

@MainActor
final class NativeAccountModel: ObservableObject, NativePlaylistSource {
    @Published var supabaseURL = ""
    @Published var publishableKey = ""
    @Published var apiURL = ""
    @Published private(set) var configured = false
    @Published private(set) var state = AccountState.signedOut
    @Published private(set) var busy = false
    @Published private(set) var links: [PlaylistLinkDTO] = []
    @Published private(set) var uncertain = false
    @Published var message: String?
    private var service: AccountSessionCoordinator?
    private weak var window: NSWindow?
    private var operation: Task<Void, Never>?
    private var generation = UUID()
    private var suggestionsCache: [String: DailySuggestionsDTO] = [:]
    private var suggestionsOrder: [String] = []
    private var closeObserver: NSObjectProtocol?

    var canFetchPlaylists: Bool { configured && state == .signedIn && !busy }

    @discardableResult
    func loadTubeShuffleSetup() -> Bool {
        guard !configured, !busy else { return false }
        do {
            guard let url = Bundle.main.url(forResource: "TubeShuffle-account-setup", withExtension: "json") else {
                throw NativeAccountSetupDocument.Failure.invalidDocument
            }
            try applySetup(Data(contentsOf: url))
            return true
        } catch {
            message = "TubeShuffle setup could not be loaded. You can load a public setup file in Advanced settings."
            return false
        }
    }

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        self.window = window
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            Task { @MainActor in
                // Drain active account work on close. Idle saved credentials
                // remain available only through explicit Resume on the next run.
                guard let self, self.busy else { return }
                self.signOut()
            }
        }
    }

    deinit { if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) } }

    func applySetup(_ data: Data) throws {
        guard !configured, !busy else { return }
        let value = try NativeAccountSetupDocument.decode(data)
        supabaseURL = value.supabaseOrigin.absoluteString
        publishableKey = value.publishableKey
        apiURL = value.applicationAPIOrigin.absoluteString
        message = "Setup loaded. Review the origins and choose Use this configuration. Sign-in remains a separate action."
    }

    func loadSetup() {
        guard !configured, !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Load account setup"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try applySetup(NativeTransferFiles.read(url)) }
        catch { message = "Setup was not loaded. Use a valid TubeShuffle setup JSON with HTTPS origins and a publishable key, up to 8 KB." }
    }

    func saveSetup() {
        guard !busy else { return }
        do {
            guard let auth = URL(string: supabaseURL), let api = URL(string: apiURL) else { throw NativeAccountSetupDocument.Failure.invalidDocument }
            let value = try NativeAccountConfiguration(supabaseOrigin: auth, publishableKey: publishableKey, applicationAPIOrigin: api)
            let data = try NativeAccountSetupDocument.encode(value)
            let panel = NSSavePanel()
            panel.title = "Save public account setup"
            panel.nameFieldStringValue = "tubeshuffle-account-setup.json"
            panel.allowedContentTypes = [.json]
            panel.message = "Only service origins and the public publishable key are included. No login tokens or library data. Choose a new filename."
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try NativeTransferFiles.writeNew(data, at: url)
            message = "Public setup saved. Load it explicitly on your next run; sign-in remains separate."
        } catch { message = "Setup could not be saved. Check the public configuration and choose a new filename; existing files are kept." }
    }

    func configure() {
        guard !configured, !busy, let window else { return }
        do {
            guard let auth = URL(string: supabaseURL), let api = URL(string: apiURL) else { throw APIClientError.invalidOrigin }
            let config = try NativeAccountConfiguration(supabaseOrigin: auth, publishableKey: publishableKey, applicationAPIOrigin: api)
            service = try NativeAccountServiceFactory(configuration: config).makeCoordinator(browser: TransientAuthBrowser(anchor: window))
            configured = true; message = "Configuration ready. Sign in or resume a saved session to contact your configured services."
        } catch { message = "Use HTTPS origins and a Supabase publishable key. Service-role keys and secrets are not accepted." }
    }

    func authenticate(resume: Bool = false, refresh: Bool = false) {
        guard !busy, let service else { return }
        let epoch = generation
        busy = true; links = []; message = nil
        suggestionsCache = [:]; suggestionsOrder = []
        operation = Task {
            if refresh { await service.refresh() }
            else if resume { await service.restore() }
            else { await service.signIn() }
            guard generation == epoch else { return }
            state = service.state; uncertain = service.hasUncertainMutations; busy = false
            if state != .signedIn { message = "Sign-in was not completed. You can try again or clear this app’s local session." }
        }
    }

    func signOut() {
        guard let service else { return }
        generation = UUID(); let epoch = generation
        operation?.cancel(); links = []; state = .invalidating; busy = true
        suggestionsCache = [:]; suggestionsOrder = []
        operation = Task {
            let cleared = await service.signOut()
            guard generation == epoch else { return }
            state = service.state; busy = false; uncertain = service.hasUncertainMutations
            message = cleared ? "This app’s local session was cleared. Your provider session and local library are unchanged." : "Local sign-out could not be verified. Retry clearing the session; do not assume it was removed."
        }
    }

    func loadLinks() {
        guard !busy, let service else { return }
        let epoch = generation
        busy = true; message = nil
        operation = Task {
            let result = await service.list()
            guard generation == epoch else { return }
            defer { state = service.state; uncertain = service.hasUncertainMutations; busy = false }
            switch result {
            case .success(let page): links = page.links; message = "Links loaded. Concurrent cloud changes may not be included. No local content was downloaded."
            default: links = []; message = "Cloud links could not be read. Refresh the session or check the service, then retry."
            }
        }
    }

    func saveLink(_ id: String, remove: Bool = false) {
        guard !busy, !uncertain, let service else { return }
        let epoch = generation
        busy = true; message = nil
        operation = Task {
            let succeeded: Bool
            if remove {
                if case .success = await service.unlink(id) { succeeded = true } else { succeeded = false }
            } else {
                if case .success = await service.save(id) { succeeded = true } else { succeeded = false }
            }
            guard generation == epoch else { return }
            busy = false; state = service.state; uncertain = service.hasUncertainMutations
            if succeeded {
                if remove { links.removeAll { $0.youtubePlaylistId == id } }
                message = remove ? "Cloud link removed. Local content was kept." : "Playlist ID saved in your account. Library content and history remain local."
            } else { message = "The server outcome could not be confirmed. Read the cloud links before deciding whether to retry; the operation may already have completed." }
        }
    }

    func acknowledgeUncertainty() {
        guard !busy else { return }
        service?.acknowledgeMutationUncertainty(); uncertain = service?.hasUncertainMutations ?? false
    }

    func fetchPlaylist(_ id: String) async -> YouTubePlaylistDTO? {
        guard canFetchPlaylists, let service else { message = "Connect your TubeShuffle account before importing a playlist."; return nil }
        let epoch = generation
        busy = true; message = nil
        let result = await service.playlist(id: id)
        guard generation == epoch else { return nil }
        defer { busy = false; state = service.state }
        if case .success(let dto) = result { return dto }
        message = "The playlist API is unavailable. Check your account, access, quota or connection; no local playlist was changed."
        return nil
    }

    func fetchSuggestions(_ input: SuggestionsRequest) async -> DailySuggestionsDTO? {
        guard !busy, let service else { return nil }
        let day = String(NativeLibraryModel.timestamp().prefix(10))
        let key = day + ":" + input.playlistId
        if let cached = suggestionsCache[key] { return cached }
        let epoch = generation; busy = true
        let result = await service.suggestions(input)
        guard generation == epoch else { return nil }
        defer { busy = false; state = service.state }
        if case .success(let value) = result {
            guard value.playlistId == input.playlistId, value.dateKey == day, value.suggestions.count <= 5 else {
                message = "The suggestions response could not be confirmed."; return nil
            }
            suggestionsCache[key] = value; suggestionsOrder.append(key)
            while suggestionsOrder.count > 20 { suggestionsCache.removeValue(forKey: suggestionsOrder.removeFirst()) }
            return value
        }
        message = "Suggestions are unavailable. Check account access, quota or connection before retrying."
        return nil
    }
}

struct NativeAccountView: View {
    @ObservedObject var account: NativeAccountModel
    let localPlaylist: LibraryPlaylist?
    let demo: Bool
    var width: CGFloat = 650
    @Environment(\.dismiss) private var dismiss
    @State private var removing: String?
    @State private var advanced = false
    private var actionLayout: AnyLayout {
        width < 600 ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout())
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text("Account & cloud links").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
                Text("Supabase Free · only playlist IDs are stored in the cloud. Content, queue, history and preferences stay on this Mac.")
                    .foregroundStyle(.secondary)
                if demo {
                    Label("Account access is disabled in the demo library.", systemImage: "person.crop.circle.badge.xmark")
                } else if !account.configured {
                    Text("Connect your TubeShuffle account to import public YouTube playlists.")
                    Button("Use TubeShuffle") {
                        if account.loadTubeShuffleSetup() { account.configure() }
                    }.buttonStyle(NativeActionStyle(prominent: true)).accessibilityIdentifier("account.useTubeShuffle")
                    Text("Uses tubeshuffle.online. Google sign-in is a separate step; nothing is uploaded automatically.")
                        .font(.callout).foregroundStyle(.secondary)
                    DisclosureGroup("Advanced settings", isExpanded: $advanced) {
                        VStack(alignment: .leading, spacing: 12) {
                            Button("Load setup JSON…") { account.loadSetup() }
                            TextField("Supabase URL · https://project.supabase.co", text: $account.supabaseURL)
                            TextField("Supabase publishable key · sb_publishable_…", text: $account.publishableKey)
                            TextField("Application API origin · https://…", text: $account.apiURL)
                            Text("Choose another service or load a public setup file. Configuration is kept for this run; sign-in remains explicit.")
                                .font(.callout).foregroundStyle(.secondary)
                            actionLayout {
                                Button("Use this configuration") { account.configure() }
                                Button("Save public setup…") { account.saveSetup() }
                            }
                        }.padding(.top, 12)
                    }
                } else {
                    HStack {
                        if account.busy { ProgressView().controlSize(.small); Text("Working…") }
                        else if account.state == .signedIn { Label("Signed in", systemImage: "person.crop.circle.fill") }
                        else { Text("Sign in to continue") }
                        Spacer()
                        Button(account.busy ? "Cancel / clear session" : "Clear local sign-in") { account.signOut() }
                            .disabled(account.state == .invalidating)
                    }
                    actionLayout {
                        Button("Sign in with Google") { account.authenticate() }.buttonStyle(NativeActionStyle(prominent: true))
                        Button("Resume saved session") { account.authenticate(resume: true) }
                        Button("Refresh session") { account.authenticate(refresh: true) }
                    }.disabled(account.busy)
                    if account.state == .signedIn || account.uncertain {
                        Divider()
                        actionLayout {
                            Button("Read cloud links") { account.loadLinks() }.disabled(account.busy)
                            if let localPlaylist {
                                Button("Save selected playlist ID") { account.saveLink(localPlaylist.youtubeId) }
                                    .disabled(account.busy || account.uncertain || account.state != .signedIn)
                            }
                        }
                        List(account.links, id: \.youtubePlaylistId) { link in
                            HStack {
                                Text(link.youtubePlaylistId).textSelection(.enabled)
                                Spacer()
                                Button("Remove link") { removing = link.youtubePlaylistId }.disabled(account.busy || account.uncertain)
                            }
                        }.frame(height: 140)
                        if account.uncertain {
                            Text("A previous cloud change has an uncertain outcome. Reading links does not undo it.")
                            Button("I checked the links; allow another change") { account.acknowledgeUncertainty() }.disabled(account.busy)
                        }
                    }
                }
                if let message = account.message { Text(message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
                Text("Personal prototype. Live account security and YouTube release policy still require acceptance.").font(.caption).foregroundStyle(.secondary)
            }
            .padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(width: width, height: demo ? 260 : 590)
        .background(NativeUIStyle.background).foregroundStyle(.white).tint(.white)
        .buttonStyle(NativeActionStyle())
        .textFieldStyle(.roundedBorder)
        .confirmationDialog("Remove only this cloud link?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove link", role: .destructive) { if let id = removing { account.saveLink(id, remove: true) }; removing = nil }
        } message: { Text("The local playlist and its history will be kept. No automatic upload will restore this link.") }
    }
}
