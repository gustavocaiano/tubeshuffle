import AppKit
import WebKit
import Foundation
import CoreFoundation

// This is an independent diagnostic, not a playback implementation for the app.
final class Lab: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    let videos = ["ScMzIvxBSi4", "jNQXAC9IVRw", "dQw4w9WgXcQ", "M7lc1UVf-VE", "aqz-KE-bpKQ", "ysz5S6PUM-U"]
    var queue = QueueState(count: 6)
    var window: NSWindow!
    var web: WKWebView!
    var ready = false
    var sequence = 0
    let started = ProcessInfo.processInfo.systemUptime
    let clock = ISO8601DateFormatter()
    var origin = ""
    var initialMainFrameNavigationAvailable = true

    func log(_ text: String) {
        sequence += 1
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        print("#\(sequence) \(clock.string(from: Date())) +\(String(format: "%.3f", elapsed))s | occurrence=\(queue.index + 1)/6 \(videos[queue.index]) requested=\(queue.requested) accepted=\(queue.accepted) natural-observed=\(queue.observedNatural) | \(text)")
        fflush(stdout)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Comparison", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Comparison", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = menu
        guard let bundle = Bundle.main.bundleIdentifier,
              bundle == "com.tubeshuffle.playbacklab",
              let base = URL(string: "https://\(bundle)/") else {
            print("Missing or unexpected bundle identifier; refusing to start")
            NSApp.terminate(nil); return
        }
        origin = "https://\(bundle)"
        log("session start bundle=\(bundle) base=\(origin)/; actual HTTP Referer unverified")
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "events")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 650), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Direct WKWebView Playback Comparison"
        window.contentMinSize = NSSize(width: 480, height: 360)
        window.delegate = self
        let stack = NSStackView()
        stack.orientation = .vertical; stack.spacing = 8
        let buttons = NSStackView()
        for (title, action) in [("Play", #selector(play)), ("Pause", #selector(pause)), ("Next", #selector(next))] {
            buttons.addArrangedSubview(NSButton(title: title, target: self, action: action))
        }
        stack.addArrangedSubview(buttons); stack.addArrangedSubview(web)
        window.contentView = stack
        web.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        web.heightAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let center = NotificationCenter.default
        for (name, label) in [(NSApplication.didBecomeActiveNotification, "app active"), (NSApplication.didResignActiveNotification, "app inactive"), (NSApplication.didHideNotification, "app hidden"), (NSApplication.didUnhideNotification, "app unhidden")] {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.log(label) }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.log("system will sleep") }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.log("system woke") }
        web.loadHTMLString(html(), baseURL: base)
    }

    func html() -> String {
        // Values come only from the fixed bundle identifier and compile-time fixture.
        return """
        <!doctype html><html><head><meta name="referrer" content="strict-origin-when-cross-origin">
        <style>html, body { width: 100%; height: 100%; margin: 0; } #player { display: block; width: 100%; height: 100%; border: 0; }</style></head>
        <body><div id="player"></div>
        <script>
        let player;
        function emit(type, value) { window.webkit.messageHandlers.events.postMessage({type:type, value:value}); }
        function onYouTubeIframeAPIReady() {
          emit('iframeReady', null);
          player = new YT.Player('player', {width:'100%', height:'100%', videoId:'\(videos[0])',
            playerVars:{origin:'\(origin)', playsinline:1},
            events:{onReady:()=>emit('ready', null), onStateChange:e=>emit('state', e.data), onError:e=>emit('error', e.data)}});
        }
        function command(kind, id) {
          if (!player || typeof player.playVideo !== 'function') throw new Error('not ready');
          if (kind === 'play') player.playVideo();
          else if (kind === 'pause') player.pauseVideo();
          else if (kind === 'load') player.loadVideoById(id);
          else throw new Error('unknown command');
        }
        </script><script src="https://www.youtube.com/iframe_api"></script></body></html>
        """
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let security = frame.securityOrigin
        guard message.webView === web, message.name == "events", frame.isMainFrame,
              security.protocol == "https", security.host == Bundle.main.bundleIdentifier,
              (security.port == 0 || security.port == 443),
              let body = message.body as? [String: Any], Set(body.keys) == Set(["type", "value"]),
              let type = body["type"] as? String else { log("bridge rejected source or shape"); return }
        switch type {
        case "iframeReady", "ready":
            guard body["value"] is NSNull else { log("bridge rejected payload"); return }
            log("iframe event \(type)")
            if type == "ready" { ready = true }
        case "state", "error":
            guard let n = body["value"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite, n.doubleValue == Double(n.intValue),
                  (-1...1000).contains(n.intValue),
                  type != "state" || [-1, 0, 1, 2, 3, 5].contains(n.intValue) else { log("bridge rejected numeric payload"); return }
            let value = n.intValue
            log("iframe event \(type)=\(value); occurrence attribution unverified")
            if type == "error" { queue.invalidatePlayback(); return }
            if value == 1 { queue.playing(); log("playing observed; candidate only") }
            if value == 0 {
                if queue.ended() { requestNext(reason: .natural) }
                else { log("ended ignored or buffered; attribution unavailable") }
            }
        default: log("bridge rejected event type")
        }
    }

    func run(_ script: String, completion: @escaping (Bool) -> Void) {
        web.evaluateJavaScript(script) { [weak self] _, error in
            if error != nil { self?.log("command evaluation failed (details redacted)") }
            completion(error == nil)
        }
    }
    @objc func play() { log("play requested"); run("command('play')") { [weak self] ok in self?.log("play evaluation \(ok ? "completed" : "failed"); not playback proof") } }
    @objc func pause() { log("pause requested"); run("command('pause')") { [weak self] ok in self?.log("pause evaluation \(ok ? "completed" : "failed")") } }
    @objc func next() { requestNext(reason: .manual) }
    func requestNext(reason: QueueState.Reason) {
        guard let req = queue.request(queue.nextTarget, reason: reason, allowed: ready) else { log("load not issued: not ready, pending or end of queue"); return }
        log("load requested reason=\(reason.rawValue) target=\(req.target + 1) \(videos[req.target]) generation=\(req.generation)")
        run("command('load','\(videos[req.target])')") { [weak self] ok in
            guard let self = self else { return }
            let buffered = self.queue.complete(req, success: ok)
            self.log("load evaluation \(ok ? "accepted" : "failed") generation=\(req.generation); not playback proof")
            if buffered { self.log("buffered ended processed"); self.requestNext(reason: .natural) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // Never open popups, external links, or navigate the app-owned document.
        if action.targetFrame == nil { log("popup navigation blocked"); decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == true {
            let allowed = initialMainFrameNavigationAvailable && url.absoluteString == "\(origin)/"
            if allowed { initialMainFrameNavigationAvailable = false }
            if !allowed { log("main-frame navigation blocked") }
            decisionHandler(allowed ? .allow : .cancel); return
        }
        // YouTube uses multiple HTTPS hosts for embeds/ads; this is not a host allowlist.
        decisionHandler(url.scheme == "https" || url.absoluteString == "about:blank" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // Some WebKit versions may commit loadHTMLString without a policy callback.
        initialMainFrameNavigationAvailable = false
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { log("navigation provisional failure (details redacted)") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { log("navigation failure (details redacted)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { ready = false; queue.invalidatePlayback(); log("web content process terminated") }
    func windowDidMiniaturize(_ notification: Notification) { log("window minimized") }
    func windowDidDeminiaturize(_ notification: Notification) { log("window restored") }
    func windowDidChangeOcclusionState(_ notification: Notification) { log("window occlusion-visible=\(window.occlusionState.contains(.visible)) minimized=\(window.isMiniaturized); not visibility proof") }
    func windowWillClose(_ notification: Notification) { log("window closing"); NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { log("application terminating") }
}

let app = NSApplication.shared
let lab = Lab()
app.setActivationPolicy(.regular)
app.delegate = lab
app.run()
