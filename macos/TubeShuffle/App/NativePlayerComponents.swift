import AppKit
import SwiftUI
import WebKit

struct NativePlayerViewControls: View {
    @Binding var showArtwork: Bool
    @Binding var focus: Bool
    @Binding var stage: Bool
    var compact = false
    var stacked = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 10))
            layout {
                HStack(spacing: 3) {
                    viewButton("Video", symbol: "video", selected: !focus) { focus = false }
                    viewButton("Focus", symbol: "headphones", selected: focus) { focus = true }
                }.padding(compact ? 3 : 4).background(.black.opacity(0.30), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(NativeUIStyle.border))
                HStack(spacing: 10) {
                    Spacer(minLength: 4)
                    Toggle("Artwork", isOn: $showArtwork).toggleStyle(NativeSwitch()).font(.system(size: 11))
                    Button { stage.toggle() } label: { Label(stage ? "Exit Stage" : "Stage", systemImage: stage ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }
                        .buttonStyle(NativeActionStyle()).help("Expand the player; Escape returns to your queue")
                }
            }.frame(height: stacked ? 74 : (compact ? 36 : 40))
            if !compact {
                Text(focus ? "Just the music and your queue. Switch to Video to watch." : "Watch the video, or choose Focus for a quieter listening view.")
                    .font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
            }
        }.nativeBounds("viewControls")
    }
    private func viewButton(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(title, systemImage: symbol).font(.system(size: 12, weight: .medium)).padding(.horizontal, 12).frame(height: compact ? 28 : 32)
            .foregroundStyle(selected ? Color.black : NativeUIStyle.secondary)
            .background(selected ? Color.white : .clear, in: RoundedRectangle(cornerRadius: 9))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct NativeFocusArtwork: View {
    let item: LibraryOccurrence?
    let demo: Bool
    var body: some View {
        NativeArtwork(videoID: item?.youtubeId ?? "", thumbnail: item?.thumbnail ?? "", bundledDemo: demo, radius: 12)
            .frame(width: 80, height: 80).nativeBounds("focusArtwork")
            .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
    }
}

struct NativeNowPlaying: View {
    let caption: String
    let title: String
    let channel: String
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            Text(caption).font(.system(size: compact ? 9 : 10)).foregroundStyle(.white.opacity(0.45))
            Text(title).font(.system(size: compact ? 15 : 17, weight: .semibold)).tracking(-0.3).lineLimit(1)
            Text(channel).font(.system(size: compact ? 11 : 12)).foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
        }.frame(maxWidth: .infinity, minHeight: compact ? 48 : 64, maxHeight: compact ? 48 : 64, alignment: .leading)
    }
}

struct NativeIdleDeck: View {
    let item: LibraryOccurrence?
    let count: Int
    @Binding var showArtwork: Bool
    @Binding var focus: Bool
    @Binding var stage: Bool
    let metrics: NativePlayerLayout
    let demo: Bool
    let play: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: metrics.compactChrome ? 8 : 12) {
            NativePlayerViewControls(showArtwork: $showArtwork, focus: $focus, stage: $stage, compact: metrics.compactChrome, stacked: metrics.stackedViewControls)
            ZStack {
                if focus {
                    if showArtwork { NativeFocusArtwork(item: item, demo: demo) }
                } else if showArtwork, let item {
                    NativeArtwork(videoID: item.youtubeId, thumbnail: item.thumbnail, bundledDemo: demo, radius: 14)
                    LinearGradient(colors: [.black.opacity(0.1), .black.opacity(0.45)], startPoint: .top, endPoint: .bottom)
                }
                if !focus { Button(action: play) {
                    Image(systemName: "play.fill").font(.system(size: 24, weight: .semibold)).offset(x: 2)
                        .foregroundStyle(.black).frame(width: 64, height: 64).background(.white, in: Circle())
                        .shadow(color: .black.opacity(0.30), radius: 16, y: 4)
                }.buttonStyle(.plain).help("Play this playlist").accessibilityLabel("Play this playlist in its displayed order").disabled(count == 0) }
            }.frame(width: focus ? metrics.playerWidth - metrics.cardInset * 2 : metrics.videoWidth, height: metrics.mediaHeight)
                .background(focus ? Color.clear : Color.black).clipShape(RoundedRectangle(cornerRadius: 14))
                .accessibilityIdentifier("player.viewport").nativeBounds("media").frame(maxWidth: .infinity)
            NativeNowPlaying(caption: "Ready to listen · \(count) videos", title: item?.title ?? "Your next listen starts here", channel: item?.channelTitle ?? "Choose a playlist from your library", compact: metrics.compactChrome)
            VStack(spacing: metrics.compactChrome ? 6 : 8) {
                Rectangle().fill(NativeUIStyle.border).frame(height: 1)
                HStack(spacing: 10) {
                    Text("0:00")
                    Capsule().fill(.white.opacity(0.15)).frame(height: 4)
                    Text(item.map { $0.duration > 0 ? nativeTimeLabel($0.duration) : "—" } ?? "—")
                }.font(.system(size: 10)).monospacedDigit().foregroundStyle(NativeUIStyle.secondary).frame(height: metrics.compactChrome ? 18 : 22)
                HStack {
                    Spacer()
                    Image(systemName: "backward.end").foregroundStyle(.white.opacity(0.25)).frame(width: 36)
                    Button(action: play) { Image(systemName: "play.fill").offset(x: 1).frame(width: metrics.compactChrome ? 36 : 42, height: metrics.compactChrome ? 36 : 42).foregroundStyle(.black).background(.white, in: Circle()) }
                        .buttonStyle(.plain).help("Play this playlist").accessibilityLabel("Play this playlist in its displayed order").disabled(count == 0)
                    Image(systemName: "forward.end").foregroundStyle(.white.opacity(0.25)).frame(width: 36)
                    Spacer()
                }
            }.frame(height: metrics.transportHeight).nativeBounds("transport")
        }.padding(metrics.cardInset).modifier(NativeCard())
    }
}

struct NativeLiveDeck: View {
    @ObservedObject var coordinator: PlayerCoordinator
    let session: NativeListeningSession
    @Binding var showArtwork: Bool
    @Binding var focus: Bool
    @Binding var stage: Bool
    let metrics: NativePlayerLayout
    let demo: Bool
    let restart: () -> Void

    private var current: PlayerCoordinator.Item { coordinator.queue[coordinator.index] }
    var body: some View {
        VStack(alignment: .leading, spacing: metrics.compactChrome ? 8 : 12) {
            NativePlayerViewControls(showArtwork: $showArtwork, focus: $focus, stage: $stage, compact: metrics.compactChrome, stacked: metrics.stackedViewControls)
            // Same NSViewRepresentable identity in Video, Focus, Stage and resize.
            // Focus uses real native hiding; no page visibility override or playback command.
            ZStack {
                NativePlayerWebView(player: coordinator.player, hidden: focus)
                    .frame(width: metrics.videoWidth, height: metrics.videoHeight)
                    .background(focus ? Color.clear : Color.black).clipShape(RoundedRectangle(cornerRadius: 14))
                    .accessibilityIdentifier("player.viewport").accessibilityHidden(focus).nativeBounds("video")
                if focus && showArtwork {
                    NativeFocusArtwork(item: current.localOccurrenceID.flatMap { session.occurrencesByID[$0] }, demo: demo)
                }
            }.frame(height: metrics.mediaHeight).frame(maxWidth: .infinity).clipped().nativeBounds("media")
            NativeNowPlaying(caption: "Now playing · Track \(coordinator.index + 1) of \(coordinator.queue.count)",
                title: current.title ?? current.videoID, channel: current.channel ?? session.playlist.title, compact: metrics.compactChrome)
            NativeTransport(coordinator: coordinator, compact: metrics.compactChrome, stackedVolume: metrics.stackedVolume).frame(height: metrics.transportHeight).nativeBounds("transport")
            if coordinator.recoveryRequired {
                HStack {
                    Text("Playback needs a fresh start. Your library and queue are safe.").font(.system(size: 12))
                    Spacer()
                    Button("Restart player", action: restart).buttonStyle(NativeActionStyle())
                }.foregroundStyle(.yellow)
            }
        }.padding(metrics.cardInset).modifier(NativeCard())
            .background(NativeWindowAttachment { coordinator.attach(window: $0) })
    }
}

struct NativeTransport: View {
    @ObservedObject var coordinator: PlayerCoordinator
    var compact = false
    var stackedVolume = false
    @State private var seeking = false
    @State private var seekValue: Double = 0
    @State private var seekOccurrence: Int?
    @State private var volumeValue: Double = 1
    @State private var changingVolume = false

    var body: some View {
        VStack(spacing: compact ? 6 : 8) {
            Rectangle().fill(NativeUIStyle.border).frame(height: 1)
            HStack(spacing: 10) {
                Text(nativeTimeLabel(seeking ? seekValue : coordinator.elapsed)).frame(width: 30)
                Slider(value: Binding(get: { seeking ? seekValue : coordinator.elapsed }, set: { value in
                    seekValue = value
                    if !seeking { coordinator.seek(to: value, occurrence: coordinator.occurrence) }
                }), in: 0...max(1, coordinator.duration), onEditingChanged: { editing in
                    if editing { seekValue = coordinator.elapsed; seekOccurrence = coordinator.occurrence; seeking = true }
                    else { seeking = false; if let occurrence = seekOccurrence { coordinator.seek(to: seekValue, occurrence: occurrence) }; seekOccurrence = nil }
                }).disabled(!coordinator.canSeek).accessibilityLabel("Playback position")
                Text(nativeTimeLabel(coordinator.duration)).frame(width: 30)
            }.font(.system(size: 10)).monospacedDigit().foregroundStyle(NativeUIStyle.secondary).frame(height: compact ? 18 : 22)
            ZStack {
                HStack(spacing: 12) {
                    NativeIconButton(symbol: "backward.end", label: "Previous track") { coordinator.select(max(0, coordinator.index - 1)) }
                        .disabled(!coordinator.canTransport || coordinator.index == 0).keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                    Button { coordinator.isPlaying ? coordinator.pause() : coordinator.play() } label: {
                        Image(systemName: coordinator.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 17, weight: .semibold))
                            .offset(x: coordinator.isPlaying ? 0 : 1).foregroundStyle(.black).frame(width: compact ? 36 : 42, height: compact ? 36 : 42).background(.white, in: Circle())
                    }.buttonStyle(.plain).disabled(!coordinator.canTransport)
                        .keyboardShortcut("p", modifiers: [.command, .option]).help(coordinator.isPlaying ? "Pause" : "Play")
                        .accessibilityLabel(coordinator.isPlaying ? "Pause" : "Play")
                    NativeIconButton(symbol: "forward.end", label: "Next track", action: coordinator.next)
                        .disabled(!coordinator.canNext).keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                }
                HStack {
                    Spacer()
                    if !stackedVolume { volume }
                }
            }.frame(height: compact ? 36 : 42)
            if stackedVolume { volume.frame(maxWidth: .infinity, alignment: .trailing).frame(height: 20) }
        }.onChange(of: coordinator.occurrence) { seekOccurrence = nil; seeking = false }
    }

    private var volume: some View {
        HStack(spacing: 6) {
            Image(systemName: "speaker.wave.2").font(.system(size: 11)).foregroundStyle(NativeUIStyle.secondary)
            Slider(value: Binding(get: { changingVolume ? volumeValue : coordinator.volume }, set: { value in
                volumeValue = value
                if !changingVolume { coordinator.setVolume(value) }
            }), in: 0...1, onEditingChanged: { editing in
                if editing { volumeValue = coordinator.volume; changingVolume = true }
                else { changingVolume = false; coordinator.setVolume(volumeValue) }
            }).frame(width: 70).disabled(!coordinator.canTransport).accessibilityLabel("Volume")
        }.fixedSize()
    }
}

struct NativeLiveQueue: View {
    @ObservedObject var coordinator: PlayerCoordinator
    let session: NativeListeningSession
    let showArtwork: Bool
    let demo: Bool
    let height: CGFloat
    var revealPlayer: () -> Void
    var body: some View {
        NativeQueueCard(items: coordinator.queue.compactMap { $0.localOccurrenceID.flatMap { session.occurrencesByID[$0] } },
            currentIndex: coordinator.index, showArtwork: showArtwork, demo: demo, height: height,
            canSelect: coordinator.canTransport, status: coordinator.status, select: { revealPlayer(); coordinator.select($0) })
    }
}

struct NativeQueueCard: View {
    let items: [LibraryOccurrence]
    let currentIndex: Int?
    let showArtwork: Bool
    let demo: Bool
    let height: CGFloat
    let canSelect: Bool
    var status: String? = nil
    let select: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Queue").font(.system(size: 14, weight: .semibold))
                    Text(currentIndex.map { "Track \($0 + 1) of \(items.count)" } ?? "Pick a track or shuffle to start")
                        .font(.system(size: 10)).foregroundStyle(NativeUIStyle.secondary)
                }
                Spacer(minLength: 8)
                Text("\(items.count) videos").font(.system(size: 10, weight: .medium)).padding(.horizontal, 8).padding(.vertical, 4)
                    .background(.white.opacity(0.09), in: Capsule())
            }
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            row(item, index: index).id(item.id)
                        }
                    }
                }.onChange(of: currentIndex) { index in
                    if let index, items.indices.contains(index) { proxy.scrollTo(items[index].id, anchor: .center) }
                }
            }
            if let status {
                Text(status.replacingOccurrences(of: "Playback: ", with: "")).font(.system(size: 10))
                    .foregroundStyle(NativeUIStyle.secondary).lineLimit(2).accessibilityLabel("Player status: \(status)")
            }
        }.padding(16).frame(height: height).modifier(NativeCard()).accessibilityIdentifier("player.queue").nativeBounds("queue")
    }

    private func row(_ item: LibraryOccurrence, index: Int) -> some View {
        let active = currentIndex == index
        return HStack(spacing: 0) {
            Button { select(index) } label: {
                HStack(spacing: 10) {
                    if showArtwork {
                        NativeArtwork(videoID: item.youtubeId, thumbnail: item.thumbnail, bundledDemo: demo)
                            .frame(width: 46, height: 46)
                            .overlay { if active { Image(systemName: "waveform").font(.system(size: 18, weight: .bold)).shadow(color: .black, radius: 4) } }
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.system(size: 12, weight: active ? .semibold : .regular)).lineLimit(2)
                            .foregroundStyle(.white.opacity(active ? 1 : 0.72)).frame(maxWidth: .infinity, alignment: .leading)
                        Text("\(index + 1) · \(item.channelTitle)\(item.duration > 0 ? " · " + nativeTimeLabel(item.duration) : "")")
                            .font(.system(size: 10)).foregroundStyle(.white.opacity(0.42)).lineLimit(1)
                    }
                }.padding(.leading, 10).padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!canSelect)
                .accessibilityLabel("\(index + 1). \(item.title), \(item.channelTitle)")
                .accessibilityAddTraits(active ? .isSelected : [])
            Menu {
                Button("Play this track") { select(index) }.disabled(!canSelect)
                if let url = URL(string: "https://www.youtube.com/watch?v=\(item.youtubeId)"), item.youtubeId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil {
                    Link("Open on YouTube", destination: url)
                }
            } label: { Image(systemName: "ellipsis").frame(width: 32, height: 40) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Actions for \(item.title)").padding(.trailing, 4)
        }
        .background(active ? Color.white.opacity(0.13) : Color.clear, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(active ? Color.white.opacity(0.14) : .clear))
        .overlay(alignment: .leading) { if active { Capsule().fill(.white).frame(width: 3).padding(.vertical, 12) } }
    }
}

struct NativePlayerWebView: NSViewRepresentable {
    let player: DirectPlayer
    var hidden = false
    func makeNSView(context: Context) -> WKWebView { player.webView.isHidden = hidden; return player.webView }
    func updateNSView(_ view: WKWebView, context: Context) { view.isHidden = hidden }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: WKWebView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 480, height: proposal.height ?? 270)
    }
}
