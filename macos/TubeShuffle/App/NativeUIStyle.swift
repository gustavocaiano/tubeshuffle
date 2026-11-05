import AppKit
import SwiftUI

struct NativeUIBounds: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

extension View {
    func nativeBounds(_ name: String) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: NativeUIBounds.self, value: [name: geometry.frame(in: .named("native.window"))])
        })
    }
}

// Native equivalents of the web player's charcoal surfaces and white controls.
enum NativeUIStyle {
    static let background = Color(red: 0.031, green: 0.031, blue: 0.027)
    static let secondary = Color.white.opacity(0.58)
    static let border = Color.white.opacity(0.10)
    static let card = Color.white.opacity(0.045)
}

struct NativeCard: ViewModifier {
    var radius: CGFloat = 26
    func body(content: Content) -> some View {
        content.background(NativeUIStyle.card, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(NativeUIStyle.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 16, y: 8)
    }
}

struct NativeActionStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 14).frame(minHeight: 36)
            .foregroundStyle(prominent ? Color.black : Color.white.opacity(0.88))
            .background(prominent ? Color.white : Color.white.opacity(configuration.isPressed ? 0.14 : 0.065), in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(Color.white.opacity(prominent ? 0 : 0.10)))
            .opacity(enabled ? 1 : 0.38)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
    }
}

struct NativeIconButton: View {
    let symbol: String
    let label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 15, weight: .medium)).frame(width: 36, height: 36).contentShape(Rectangle()) }
            .buttonStyle(.plain).help(label).accessibilityLabel(label)
    }
}

struct NativeSwitch: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 8) {
                configuration.label.foregroundStyle(NativeUIStyle.secondary)
                Capsule().fill(Color.white.opacity(configuration.isOn ? 0.90 : 0.18))
                    .frame(width: 28, height: 16)
                    .overlay(Circle().fill(configuration.isOn ? Color.black : Color.white).frame(width: 12, height: 12).offset(x: configuration.isOn ? 6 : -6))
            }.contentShape(Rectangle()).frame(minHeight: 32)
        }.buttonStyle(.plain).accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

struct NativeArtwork: View {
    let videoID: String
    var thumbnail = ""
    var bundledDemo = false
    var radius: CGFloat = 10

    static func url(thumbnail: String, videoID: String) -> URL? {
        if let url = URL(string: thumbnail), url.scheme == "https", url.host == "i.ytimg.com",
           url.user == nil, url.password == nil { return url }
        guard videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://i.ytimg.com/vi/\(videoID)/hqdefault.jpg")
    }

    private var bundledImage: NSImage? {
        guard bundledDemo, let url = Bundle.main.url(forResource: videoID, withExtension: "jpg", subdirectory: "DemoArtwork") else { return nil }
        return NSImage(contentsOf: url)
    }

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let image = bundledImage {
                    Image(nsImage: image).resizable().scaledToFill()
                } else if let url = Self.url(thumbnail: thumbnail, videoID: videoID) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() }
                        else { fallback }
                    }
                } else { fallback }
            }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
        }
        .clipShape(RoundedRectangle(cornerRadius: radius))
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color.white.opacity(0.1)))
        .accessibilityHidden(true)
    }
    private var fallback: some View {
        ZStack { Color.white.opacity(0.06); Image(systemName: "music.note").font(.title3).foregroundStyle(.white.opacity(0.30)) }
    }
}

/// Explicit proposals prevent WKWebView's intrinsic size from widening the window.
/// Short windows reduce the video box; the page scrolls vertically, never horizontally.
struct NativePlayerLayout {
    let contentWidth: CGFloat
    let playerWidth: CGFloat
    let queueWidth: CGFloat
    private(set) var videoHeight: CGFloat = 0
    let horizontal: Bool
    let inset: CGFloat
    let compactChrome: Bool
    let narrow: Bool
    let focus: Bool
    let showArtwork: Bool
    var stackedViewControls: Bool { playerWidth - cardInset * 2 < 390 }
    var stackedVolume: Bool { playerWidth - cardInset * 2 < 360 }
    var cardInset: CGFloat { compactChrome ? 12 : 16 }
    var pageTopInset: CGFloat { if narrow { return 8 }; return compactChrome ? 12 : 24 }
    var sectionSpacing: CGFloat { compactChrome ? 12 : 20 }
    var navigationHeight: CGFloat { if narrow { return 40 }; return compactChrome ? 44 : 54 }
    var headingHeight: CGFloat { if narrow { return 80 }; return compactChrome ? 44 : 60 }
    var viewControlsHeight: CGFloat { if stackedViewControls { return 74 }; return compactChrome ? 36 : 64 }
    var transportHeight: CGFloat { (compactChrome ? 68 : 80) + (stackedVolume ? 26 : 0) }
    var mediaHeight: CGFloat { if !focus { return videoHeight }; return showArtwork ? 128 : 0 }
    var deckOverhead: CGFloat {
        viewControlsHeight + (compactChrome ? 48 : 64) + transportHeight
            + (compactChrome ? 24 : 36) + cardInset * 2
    }
    var deckHeight: CGFloat { mediaHeight + deckOverhead }
    var videoWidth: CGFloat { min(playerWidth - cardInset * 2, videoHeight * 16 / 9) }
    init(width: CGFloat, height: CGFloat, stage: Bool = false, focus: Bool = false, showArtwork: Bool = true, scale: CGFloat = 1) {
        self.focus = focus
        self.showArtwork = showArtwork
        narrow = width < 660
        compactChrome = height < 800 || stage || narrow
        if narrow { inset = 12 } else { inset = width < 900 ? 20 : 28 }
        contentWidth = max(280, min(1240, width - inset * 2))
        horizontal = contentWidth >= 940 && !stage
        queueWidth = horizontal ? min(328, contentWidth * 0.28) : contentWidth
        playerWidth = horizontal ? contentWidth - queueWidth - 20 : contentWidth
        var top = pageTopInset
        if !stage { top += navigationHeight + headingHeight + sectionSpacing }
        let ideal = (playerWidth - cardInset * 2) * 9 / 16
        let viewportLimit = max(200 / scale, height - top - deckOverhead - 8 / scale)
        videoHeight = min(ideal, viewportLimit)
    }
}

enum NativeInterfaceZoom {
    static let levels: [Double] = [0.8, 0.9, 1, 1.1, 1.25]
    static func clamped(_ value: Double) -> Double {
        guard value.isFinite else { return 1 }
        return min(levels.last!, max(levels.first!, value))
    }
    static func increased(_ value: Double) -> Double { levels.first { $0 > clamped(value) + 0.001 } ?? levels.last! }
    static func decreased(_ value: Double) -> Double { levels.last { $0 < clamped(value) - 0.001 } ?? levels.first! }
}

private struct NativeZoomKey: FocusedValueKey { typealias Value = Binding<Double> }
extension FocusedValues {
    var nativeInterfaceZoom: Binding<Double>? {
        get { self[NativeZoomKey.self] }
        set { self[NativeZoomKey.self] = newValue }
    }
}

struct NativeZoomCommands: Commands {
    @FocusedBinding(\.nativeInterfaceZoom) private var zoom
    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("Zoom In") { if let zoom { self.zoom = NativeInterfaceZoom.increased(zoom) } }
                .keyboardShortcut("+", modifiers: .command).disabled(zoom == nil || (zoom ?? 1) >= 1.25)
            Button("Zoom Out") { if let zoom { self.zoom = NativeInterfaceZoom.decreased(zoom) } }
                .keyboardShortcut("-", modifiers: .command).disabled(zoom == nil || (zoom ?? 1) <= 0.8)
            Button("Actual Size") { zoom = 1 }.keyboardShortcut("0", modifiers: .command).disabled(zoom == nil)
        }
    }
}

/// Handles both keyboard layouts with a dedicated + key and Cmd+= / Cmd+Shift+=.
/// The local monitor belongs to this native window; sheets and other windows pass through.
struct NativeZoomKeyboard: NSViewRepresentable {
    @Binding var zoom: Double
    func makeNSView(context: Context) -> NativeZoomKeyView { NativeZoomKeyView() }
    func updateNSView(_ view: NativeZoomKeyView, context: Context) {
        view.changeZoom = { action in
            switch action {
            case .increase: zoom = NativeInterfaceZoom.increased(zoom)
            case .decrease: zoom = NativeInterfaceZoom.decreased(zoom)
            case .reset: zoom = 1
            }
        }
    }
    static func dismantleNSView(_ view: NativeZoomKeyView, coordinator: ()) { view.removeMonitor() }
}

final class NativeZoomKeyView: NSView {
    enum Action { case increase, decrease, reset }
    var changeZoom: ((Action) -> Void)?
    private var monitor: Any?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeMonitor()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.window, event.window === window,
                  window.attachedSheet == nil, let action = Self.action(for: event) else { return event }
            self.changeZoom?(action)
            return nil
        }
    }
    static func action(for event: NSEvent) -> Action? {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard modifiers == .command || modifiers == [.command, .shift] else { return nil }
        switch event.charactersIgnoringModifiers {
        case "+", "=": return .increase
        case "-": return .decrease
        case "0" where modifiers == .command: return .reset
        default: return nil
        }
    }
    func removeMonitor() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}

func nativeTimeLabel(_ seconds: Double) -> String {
    let value = Int(max(0, seconds.isFinite ? seconds : 0))
    return String(format: "%d:%02d", value / 60, value % 60)
}
