import AppKit
import SwiftUI
import WebKit
import XCTest
@testable import TubeShuffle

@MainActor
final class NativeUIRenderingTests: XCTestCase {
    func testRealNativeLayoutAndArtworkAtDesktopAndCompactSizes() async throws {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-ui-render-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false)
        var measurements: [[String: Any]] = []
        // These render real SwiftUI views. The media region in live cases uses a
        // static bundled fixture instead of YouTube; no audio/network claim.
        for (name, size, live, focus, stage) in [
            ("ready-1280x860", NSSize(width: 1280, height: 860), false, false, false),
            ("paused-1280x860", NSSize(width: 1280, height: 860), true, false, false),
            ("paused-1100x720", NSSize(width: 1100, height: 720), true, false, false),
            ("paused-760x680", NSSize(width: 760, height: 680), true, false, false),
            ("focus-1100x720", NSSize(width: 1100, height: 720), true, true, false),
            ("stage-1100x720", NSSize(width: 1100, height: 720), true, false, true),
            ("paused-1600x1000", NSSize(width: 1600, height: 1000), true, false, false)
        ] {
            let library = NativeLibraryModel()
            library.openDemo()
            let preferences = try XCTUnwrap(UserDefaults(suiteName: "tubeshuffle-ui-render-\(UUID().uuidString)"))
            preferences.set(focus, forKey: "native.focus")
            let fixture = NativeLibraryFixture.snapshot
            let session: NativeListeningSession? = live ? NativeListeningSession(items: fixture.occurrences, playlist: fixture.playlists[0], library: library,
                testHooks: .init(load: { _, _ in }, progress: { _ in (0, 100) }, draw: { 0.5 })) : nil
            var bounds: [String: CGRect] = [:]
            let root = NativeLibraryView(library: library, preferences: preferences, session: session, stage: stage) { bounds = $0 }
            let host = NSHostingView(rootView: root)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.setContentSize(size)
            window.orderBack(nil)
            host.layoutSubtreeIfNeeded()
            if let session {
                let url = try XCTUnwrap(Bundle.main.url(forResource: fixture.occurrences[0].youtubeId, withExtension: "jpg", subdirectory: "DemoArtwork"))
                let image = try Data(contentsOf: url).base64EncodedString()
                session.coordinator.player.webView.loadHTMLString("<html><body style='margin:0;background:black'><img style='width:100%;height:100%;object-fit:contain' src='data:image/jpeg;base64,\(image)'></body></html>", baseURL: URL(string: "https://com.tubeshuffle.playbacklab/"))
                var loaded = false
                for _ in 0..<30 {
                    loaded = (try? await session.coordinator.player.webView.evaluateJavaScript("document.images.length === 1 && document.images[0].complete")) as? Bool == true
                    if loaded { break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                XCTAssertTrue(loaded, "Static image must load through the real navigation policy")
                session.coordinator.player.onEvent?(.ready(1))
                session.coordinator.player.onEvent?(.state(1, 2))
            }
            try await Task.sleep(nanoseconds: 350_000_000)
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let video = try XCTUnwrap(bounds["video"], name)
            let transport = try XCTUnwrap(bounds["transport"], name)
            let deck = try XCTUnwrap(bounds["deck"], name)
            for (key, rect) in bounds {
                XCTAssertGreaterThanOrEqual(rect.minX, -1, "\(name) \(key) overflow left")
                XCTAssertLessThanOrEqual(rect.maxX, size.width + 1, "\(name) \(key) overflow right")
            }
            XCTAssertGreaterThanOrEqual(video.minY, 0, name)
            XCTAssertGreaterThanOrEqual(video.height, 200, name)
            XCTAssertEqual(video.width / video.height, 16 / 9, accuracy: 0.01, name)
            XCTAssertLessThanOrEqual(transport.maxY, size.height, "\(name): transport below viewport")
            XCTAssertLessThanOrEqual(deck.maxY, size.height, "\(name): deck below viewport")
            XCTAssertGreaterThan(transport.minY, video.maxY, name)
            // Keep the exact geometry asserted above; scrolling for an additional
            // capture updates the live preference dictionary asynchronously.
            let initialBounds = bounds
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: output.appendingPathComponent(name + ".png"), options: .withoutOverwriting)
            if name == "paused-1280x860" || name == "paused-760x680", let scroll = firstScrollView(host) {
                scroll.contentView.scroll(to: NSPoint(x: 0, y: 540))
                scroll.reflectScrolledClipView(scroll.contentView)
                try await Task.sleep(nanoseconds: 150_000_000)
                host.layoutSubtreeIfNeeded()
                let lower = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: lower)
                try XCTUnwrap(lower.representation(using: .png, properties: [:])).write(to: output.appendingPathComponent("lower-" + name + ".png"))
                measurements.append(["case": "lower-" + name, "width": size.width, "height": size.height,
                    "media": "Static bundled image in the real WKWebView; synthetic paused event",
                    "boundsCoordinateSpace": "Content viewport after scrolling down 540 points; offscreen upper content is expected",
                    "initialViewportAssertionsPassed": false,
                    "bounds": bounds.mapValues { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] }])
            }
            measurements.append(["case": name, "width": size.width, "height": size.height,
                "media": live ? "Static bundled image in the real WKWebView; synthetic paused event" : "Real idle view, bundled demo artwork", "boundsCoordinateSpace": "Initial unscrolled content viewport",
                "initialViewportAssertionsPassed": true,
                "bounds": initialBounds.mapValues { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] }])
            session?.coordinator.stop()
            window.close()
            library.closeLibrary()
        }
        try JSONSerialization.data(withJSONObject: measurements, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("measurements.json"))
        print("NATIVE_UI_CAPTURE_DIR=\(output.path)")
    }

    private func firstScrollView(_ view: NSView) -> NSScrollView? {
        if let scroll = view as? NSScrollView { return scroll }
        return view.subviews.lazy.compactMap { self.firstScrollView($0) }.first
    }

    func testDemoArtworkAndValidatedFallbackAreAvailable() throws {
        for item in NativeLibraryFixture.snapshot.occurrences {
            let url = try XCTUnwrap(Bundle.main.url(forResource: item.youtubeId, withExtension: "jpg", subdirectory: "DemoArtwork"))
            XCTAssertNotNil(NSImage(contentsOf: url))
            XCTAssertEqual(NativeArtwork.url(thumbnail: "", videoID: item.youtubeId)?.host, "i.ytimg.com")
        }
        XCTAssertNil(NativeArtwork.url(thumbnail: "http://untrusted.test/image", videoID: "invalid"))
        XCTAssertNil(NativeArtwork.url(thumbnail: "https://name:secret@i.ytimg.com/image", videoID: "invalid"))
    }

    func testResizeAndFocusKeepTheExistingPlayerAndOccurrence() async throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let preferences = try XCTUnwrap(UserDefaults(suiteName: "tubeshuffle-ui-retention-\(UUID().uuidString)"))
        var loads = 0
        let session = NativeListeningSession(items: fixture.occurrences, playlist: fixture.playlists[0], library: library,
            testHooks: .init(load: { _, _ in loads += 1 }, progress: { _ in (0, 100) }, draw: { 0.5 }))
        let host = NSHostingView(rootView: NativeLibraryView(library: library, preferences: preferences, session: session))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderBack(nil)
        defer { session.coordinator.stop(); window.close(); library.closeLibrary() }
        for (width, height, focus) in [(1280, 860, false), (760, 680, false), (1100, 720, true), (1600, 1000, false)] {
            preferences.set(focus, forKey: "native.focus")
            window.setContentSize(NSSize(width: width, height: height))
            try await Task.sleep(nanoseconds: 150_000_000)
            host.layoutSubtreeIfNeeded()
            let players = webViews(in: host)
            XCTAssertEqual(players.count, 1)
            XCTAssertTrue(players.first === session.coordinator.player.webView)
            XCTAssertTrue(session.coordinator.player.webView.window === window)
            XCTAssertEqual(session.coordinator.queueState.expectedGeneration, 1)
            XCTAssertEqual(session.coordinator.index, 0)
            XCTAssertFalse(session.coordinator.recoveryRequired)
        }
        XCTAssertEqual(loads, 0, "Layout and Focus changes must not request a media reload")
    }

    private func webViews(in view: NSView) -> [WKWebView] {
        if let player = view as? WKWebView { return [player] }
        return view.subviews.flatMap { webViews(in: $0) }
    }

    func testVolumeUsesAcceptedGenerationAndDoesNotInventPlayback() async {
        var commands: [(Double, Int)] = []
        let completed = expectation(description: "volume command")
        let hooks = PlayerCoordinator.TestHooks(load: { _, _ in }, progress: { _ in (0, 100) }, draw: { 0.5 }, volume: { value, generation in
            commands.append((value, generation)); completed.fulfill()
        })
        let subject = PlayerCoordinator(testHooks: hooks)
        let window = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        subject.attach(window: window)
        subject.setVolume(0.2)
        XCTAssertTrue(commands.isEmpty)
        subject.player.onEvent?(.ready(1))
        subject.player.onEvent?(.state(1, 2))
        subject.setVolume(0.4)
        await fulfillment(of: [completed], timeout: 1)
        XCTAssertEqual(commands.first?.0, 0.4)
        XCTAssertEqual(commands.first?.1, 1)
        XCTAssertFalse(subject.isPlaying)
        XCTAssertEqual(subject.volume, 0.4)
        subject.stop()
        withExtendedLifetime(window) {}
    }
}
