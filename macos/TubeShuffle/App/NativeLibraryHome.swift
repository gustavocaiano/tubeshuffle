import SwiftUI

/// One saved playlist on the home grid. The whole card opens the playlist,
/// which shuffles it and starts listening; refreshing lives in its menu.
struct NativePlaylistCard: View {
    let playlist: LibraryPlaylist
    let count: Int
    let firstVideoID: String
    let showArtwork: Bool
    let demo: Bool
    /// The player of the queue taken from this playlist, if one is playing or paused.
    let session: PlayerCoordinator?
    let refreshing: Bool
    let canRefresh: Bool
    let open: () -> Void
    let refresh: () -> Void
    private var playing: Bool { session != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 10) {
                    artwork.frame(height: 118).frame(maxWidth: .infinity)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(playlist.title).font(.system(size: 14, weight: .semibold)).lineLimit(2, reservesSpace: true)
                            .multilineTextAlignment(.leading)
                        Text(playlist.channelTitle ?? "YouTube playlist").font(.system(size: 11))
                            .foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("\(playlist.title), \(count) videos")
                .accessibilityHint(playing ? "Returns to the playlist that is playing." : "Shuffles this playlist and starts listening.")
            HStack(spacing: 6) {
                Button(action: open) {
                    Label(playing ? "Now playing" : "Shuffle & Play", systemImage: playing ? "waveform" : "shuffle")
                        .frame(maxWidth: .infinity)
                }.buttonStyle(NativeActionStyle(prominent: !playing)).disabled(count == 0 && !playing)
                Menu {
                    Button(refreshing ? "Refreshing…" : "Refresh from YouTube", action: refresh).disabled(!canRefresh)
                    if !demo, let url = URL(string: "https://www.youtube.com/playlist?list=\(playlist.youtubeId)") {
                        Link("Open on YouTube", destination: url)
                    }
                } label: { Image(systemName: "ellipsis").frame(width: 30, height: 36) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel("More actions for \(playlist.title)")
            }
        }.padding(12).modifier(NativeCard(radius: 20))
    }

    private var artwork: some View {
        ZStack(alignment: .bottomTrailing) {
            if showArtwork {
                NativeArtwork(videoID: firstVideoID, thumbnail: playlist.thumbnail ?? "", bundledDemo: demo, radius: 14)
            } else {
                ZStack {
                    Color.white.opacity(0.06)
                    Image(systemName: "music.note.list").font(.title2).foregroundStyle(.white.opacity(0.35))
                }.clipShape(RoundedRectangle(cornerRadius: 14))
            }
            Text("\(count) videos").font(.system(size: 10, weight: .semibold)).padding(.horizontal, 8).padding(.vertical, 4)
                .background(.black.opacity(0.72), in: Capsule()).padding(8)
            if refreshing || playing {
                HStack(spacing: 6) {
                    if refreshing {
                        ProgressView().controlSize(.small)
                        Text("Refreshing").font(.system(size: 10, weight: .semibold))
                    } else if let session {
                        NativePlaybackState(coordinator: session)
                    }
                }.padding(.horizontal, 8).padding(.vertical, 5).background(.black.opacity(0.72), in: Capsule())
                    .padding(8).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
}

/// Says whether a card's player is playing or paused, following it as it changes.
private struct NativePlaybackState: View {
    @ObservedObject var coordinator: PlayerCoordinator

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: coordinator.isPlaying ? "waveform" : "pause.fill")
            Text(coordinator.isPlaying ? "Playing" : "Paused").font(.system(size: 10, weight: .semibold))
        }
    }
}

/// Shown above the playlists while music plays, so browsing never hides what
/// is playing. It controls the same coordinator as the player page.
struct NativeMiniPlayer: View {
    @ObservedObject var coordinator: PlayerCoordinator
    let session: NativeListeningSession
    let showArtwork: Bool
    let demo: Bool
    let open: () -> Void

    var body: some View {
        let current = coordinator.queue[coordinator.index]
        let occurrence = current.localOccurrenceID.flatMap { session.occurrencesByID[$0] }
        HStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 12) {
                    if showArtwork {
                        NativeArtwork(videoID: current.videoID, thumbnail: occurrence?.thumbnail ?? "", bundledDemo: demo, radius: 10)
                            .frame(width: 48, height: 48)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Now playing · \(session.playlist.title) · Track \(coordinator.index + 1) of \(coordinator.queue.count)")
                            .font(.system(size: 10)).foregroundStyle(.white.opacity(0.50)).lineLimit(1)
                        Text(current.title ?? current.videoID).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        Text(current.channel ?? session.playlist.title).font(.system(size: 11))
                            .foregroundStyle(NativeUIStyle.secondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).help("Back to the player").accessibilityLabel("Now playing: \(current.title ?? current.videoID). Back to the player.")
            Button { coordinator.isPlaying ? coordinator.pause() : coordinator.play() } label: {
                Image(systemName: coordinator.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 14, weight: .semibold))
                    .offset(x: coordinator.isPlaying ? 0 : 1).foregroundStyle(.black).frame(width: 36, height: 36).background(.white, in: Circle())
            }.buttonStyle(.plain).disabled(!coordinator.canTransport)
                .help(coordinator.isPlaying ? "Pause" : "Play").accessibilityLabel(coordinator.isPlaying ? "Pause" : "Play")
            NativeIconButton(symbol: "forward.end", label: "Next track", action: coordinator.next).disabled(!coordinator.canNext)
            Button("Open player", action: open).buttonStyle(NativeActionStyle())
        }.padding(12).modifier(NativeCard(radius: 18)).nativeBounds("miniPlayer")
    }
}
