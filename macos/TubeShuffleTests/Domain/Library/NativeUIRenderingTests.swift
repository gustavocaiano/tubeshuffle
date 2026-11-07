import AppKit
import SwiftUI
import WebKit
import XCTest
@testable import TubeShuffle

@MainActor
final class NativeUIRenderingTests: XCTestCase {
    func testPlaylistImportAndAccountSheetsFitTheMinimumWindow() async throws {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-import-render-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false)
        let directory = output.appendingPathComponent("Disposable library", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let local = try NativeLibraryModel(store: NativeLocalLibraryStore.createNew(at: directory), at: directory)
        defer { local.closeLibrary() }
        let empty = NativeLibraryModel()
        let account = NativeAccountModel()
        let configured = NativeAccountModel()
        let anchor = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
        anchor.isReleasedWhenClosed = false
        defer { anchor.close() }
        configured.attach(anchor)
        XCTAssertTrue(configured.loadTubeShuffleSetup())
        configured.configure()
        XCTAssertTrue(configured.configured)
        XCTAssertEqual(configured.state, .signedOut)
        func importer(_ library: NativeLibraryModel, input: String = "", fixture: Bool = false) -> AnyView {
            AnyView(NativePlaylistImportView(library: library, account: account, input: .constant(input), fixtureMode: fixture, width: 448,
                createLibrary: {}, openLibrary: {}, connectAccount: {}, openApp: {}, cancel: {}, imported: { _ in }))
        }
        local.message = "The playlist API is unavailable. Check your account, access, quota or connection; no local playlist was changed."
        let cases: [(String, AnyView)] = [
            ("fixture", importer(empty, fixture: true)),
            ("choose-library", importer(empty, input: "https://youtube.com/watch?v=ScMzIvxBSi4")),
            ("local-account-and-error", importer(local, input: "https://www.youtube.com/playlist?list=PLSyntheticImport0001")),
            ("account-setup", AnyView(NativeAccountView(account: account, localPlaylist: nil, demo: false, width: 448))),
            ("account-sign-in", AnyView(NativeAccountView(account: configured, localPlaylist: nil, demo: false, width: 448)))
        ]
        var measurements: [[String: Any]] = []
        for (name, root) in cases {
            let host = NSHostingView(rootView: root.preferredColorScheme(.dark))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 448, height: 620), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.orderBack(nil)
            try await Task.sleep(nanoseconds: 150_000_000)
            host.layoutSubtreeIfNeeded()
            let size = host.fittingSize
            XCTAssertEqual(size.width, 448, accuracy: 1, name)
            XCTAssertGreaterThan(size.height, 100, name)
            XCTAssertLessThanOrEqual(size.height, 620, "\(name): sheet exceeds the 480 × 680 window")
            window.setContentSize(size)
            host.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: output.appendingPathComponent(name + ".png"))
            measurements.append(["case": name, "width": size.width, "height": size.height, "liveAccountOrNetwork": false])
            window.close()
        }
        try JSONSerialization.data(withJSONObject: measurements, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("measurements.json"))
        print("NATIVE_IMPORT_CAPTURE_DIR=\(output.path)")
    }

    func testRealNativeLayoutAndArtworkAtDesktopAndCompactSizes() async throws {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("tubeshuffle-ui-render-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false)
        var measurements: [[String: Any]] = []
        // These render real SwiftUI views. The media region in live cases uses a
        // static bundled fixture instead of YouTube; no audio/network claim.
        for (name, size, live, focus, stage, artwork, zoom) in [
            ("ready-1280x860", NSSize(width: 1280, height: 860), false, false, false, true, 1.0),
            ("paused-1280x860", NSSize(width: 1280, height: 860), true, false, false, true, 1.0),
            ("paused-1100x720", NSSize(width: 1100, height: 720), true, false, false, true, 1.0),
            ("paused-760x680", NSSize(width: 760, height: 680), true, false, false, true, 1.0),
            ("focus-1100x720", NSSize(width: 1100, height: 720), true, true, false, true, 1.0),
            ("stage-1100x720", NSSize(width: 1100, height: 720), true, false, true, true, 1.0),
            ("paused-1600x1000", NSSize(width: 1600, height: 1000), true, false, false, true, 1.0),
            ("paused-480x680", NSSize(width: 480, height: 680), true, false, false, true, 1.0),
            ("focus-480x680", NSSize(width: 480, height: 680), true, true, false, true, 1.0),
            ("focus-no-artwork-480x680", NSSize(width: 480, height: 680), true, true, false, false, 1.0),
            ("ready-focus-480x680", NSSize(width: 480, height: 680), false, true, false, true, 1.0),
            ("zoom80-480x680", NSSize(width: 480, height: 680), true, false, false, true, 0.8),
            ("zoom125-480x800", NSSize(width: 480, height: 800), true, false, false, true, 1.25),
            ("focus-zoom125-480x680", NSSize(width: 480, height: 680), true, true, false, true, 1.25),
            ("stage-focus-480x680", NSSize(width: 480, height: 680), true, true, true, true, 1.0)
        ] {
            let library = NativeLibraryModel()
            library.openDemo()
            let preferences = try XCTUnwrap(UserDefaults(suiteName: "tubeshuffle-ui-render-\(UUID().uuidString)"))
            preferences.set(focus, forKey: "native.focus")
            preferences.set(artwork, forKey: "native.showArtwork")
            preferences.set(zoom, forKey: "native.interfaceZoom")
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
            let media = try XCTUnwrap(bounds["media"], name)
            let video = try XCTUnwrap(bounds["video"] ?? bounds["media"], name)
            let transport = try XCTUnwrap(bounds["transport"], name)
            let deck = try XCTUnwrap(bounds["deck"], name)
            for (key, rect) in bounds {
                if focus && key == "video" { continue } // Retained native view is actually hidden.
                XCTAssertGreaterThanOrEqual(rect.minX, -1, "\(name) \(key) overflow left")
                XCTAssertLessThanOrEqual(rect.maxX, size.width + 1, "\(name) \(key) overflow right")
            }
            XCTAssertGreaterThanOrEqual(media.minY, 0, name)
            if focus {
                if let session { XCTAssertTrue(session.coordinator.player.webView.isHiddenOrHasHiddenAncestor, name) }
                if artwork {
                    let thumbnail = try XCTUnwrap(bounds["focusArtwork"], name)
                    XCTAssertEqual(thumbnail.width, 80 * zoom, accuracy: 1, name)
                    XCTAssertEqual(thumbnail.height, thumbnail.width, accuracy: 1, name)
                } else { XCTAssertNil(bounds["focusArtwork"], name) }
            } else {
                if let session { XCTAssertFalse(session.coordinator.player.webView.isHiddenOrHasHiddenAncestor, name) }
                XCTAssertGreaterThanOrEqual(video.height, 199, name)
                XCTAssertEqual(video.width / video.height, 16 / 9, accuracy: 0.01, name)
            }
            XCTAssertLessThanOrEqual(transport.maxY, size.height, "\(name): transport below viewport")
            XCTAssertLessThanOrEqual(deck.maxY, size.height, "\(name): deck below viewport")
            XCTAssertGreaterThan(transport.minY, media.maxY, name)
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
            measurements.append(["case": name, "width": size.width, "height": size.height, "zoom": zoom, "focus": focus, "artwork": artwork,
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

    func testResizeFocusAndZoomKeepTheExistingPlayerAndOccurrence() async throws {
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
        for (width, height, focus, zoom) in [(1280, 860, false, 1.0), (480, 680, false, 0.8), (480, 800, false, 1.25), (480, 680, true, 1.25), (1100, 720, true, 1.0), (1600, 1000, false, 1.0)] {
            preferences.set(focus, forKey: "native.focus")
            preferences.set(zoom, forKey: "native.interfaceZoom")
            window.setContentSize(NSSize(width: width, height: height))
            try await Task.sleep(nanoseconds: 150_000_000)
            host.layoutSubtreeIfNeeded()
            let players = webViews(in: host)
            XCTAssertEqual(players.count, 1)
            XCTAssertTrue(players.first === session.coordinator.player.webView)
            XCTAssertTrue(session.coordinator.player.webView.window === window)
            XCTAssertEqual(session.coordinator.player.webView.isHiddenOrHasHiddenAncestor, focus)
            XCTAssertEqual(session.coordinator.queueState.expectedGeneration, 1)
            XCTAssertEqual(session.coordinator.index, 0)
            XCTAssertFalse(session.coordinator.recoveryRequired)
        }
        XCTAssertEqual(loads, 0, "Layout, Focus and zoom must not request a media reload")
    }

    func testCommandZoomWithWebViewFocusedAndWindowCloseStopsThePlayer() async throws {
        let library = NativeLibraryModel()
        library.openDemo()
        let fixture = NativeLibraryFixture.snapshot
        let preferences = try XCTUnwrap(UserDefaults(suiteName: "tubeshuffle-ui-zoom-\(UUID().uuidString)"))
        let session = NativeListeningSession(items: fixture.occurrences, playlist: fixture.playlists[0], library: library,
            testHooks: .init(load: { _, _ in XCTFail("Zoom must not reload media") }, progress: { _ in (0, 100) }, draw: { 0.5 }))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: NativeLibraryView(library: library, preferences: preferences, session: session))
        window.contentView = host
        window.orderBack(nil)
        defer { session.coordinator.stop(); window.close(); library.closeLibrary() }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 150_000_000)
        window.makeFirstResponder(session.coordinator.player.webView)
        for (characters, modifiers, expected) in [
            ("-", NSEvent.ModifierFlags.command, 0.9),
            ("-", .command, 0.8), ("-", .command, 0.8),
            ("=", .command, 0.9), ("+", [.command, .shift], 1.0),
            ("+", .command, 1.1), ("+", .command, 1.25), ("+", .command, 1.25),
            ("0", .command, 1.0), ("-", [], 1.0), ("-", [.command, .option], 1.0)
        ] {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                windowNumber: window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                isARepeat: false, keyCode: 0))
            NSApp.sendEvent(event)
            try await Task.sleep(nanoseconds: 80_000_000)
            XCTAssertEqual(preferences.double(forKey: "native.interfaceZoom"), expected, accuracy: 0.001, characters)
        }
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.isReleasedWhenClosed = false
        window.beginSheet(sheet, completionHandler: { _ in })
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "-", charactersIgnoringModifiers: "-", isARepeat: false, keyCode: 0))
        NSApp.sendEvent(event)
        XCTAssertEqual(preferences.double(forKey: "native.interfaceZoom"), 1)
        window.endSheet(sheet); sheet.close()
        window.close()
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertNil(session.coordinator.player.onEvent, "Closing the native window must tear down the media bridge")
        XCTAssertNil(session.coordinator.onNaturalCompletion)
        XCTAssertFalse(session.coordinator.canTransport)
        XCTAssertFalse(library.isOpen)
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
