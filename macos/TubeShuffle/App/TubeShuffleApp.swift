import SwiftUI
import AppKit
import YouTubePlayerKit

@main
struct TubeShuffleApp: App {
    @StateObject private var coordinator = PlayerCoordinator()

    var body: some Scene {
        Window("TubeShuffle Playback Lab", id: "player") {
            ContentView(coordinator: coordinator)
                .frame(minWidth: 780, minHeight: 620)
        }
    }
}

struct ContentView: View {
    @ObservedObject var coordinator: PlayerCoordinator
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
            }
            HStack(alignment: .top, spacing: 16) {
                YouTubePlayerView(coordinator.player)
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
                Button("Capture state probe", action: coordinator.captureEmissionProbe).disabled(!coordinator.canCaptureEmissionProbe)
                    .help("Capture callbacks even after a player error when the bridge is safe to use. Unavailable during operations or recovery; a stalled bridge cannot be captured safely.")
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
        }.padding(20).background(WindowObserver(coordinator: coordinator))
    }
}

private struct WindowObserver: NSViewRepresentable {
    let coordinator: PlayerCoordinator
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { if let window = view.window { coordinator.attach(window: window) } }
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { if let window = view.window { coordinator.attach(window: window) } }
    }
}
