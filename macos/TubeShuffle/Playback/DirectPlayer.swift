import AppKit
import WebKit
import CoreFoundation

// Owns one web view for the coordinator's lifetime. Generations attribute callbacks
// to player instances, not authenticated remote video identity; the top-level API
// script can still forge messages. Main-frame/origin checks remain essential.
@MainActor
final class DirectPlayer: NSObject, WKNavigationDelegate {
    enum Event { case iframeReady, ready(Int), state(Int, Int), error(Int, Int), autoplayBlocked(Int), failure }
    var onEvent: ((Event) -> Void)?
    let webView: WKWebView
    private let proxy = MessageProxy()
    private let origin = "https://com.tubeshuffle.playbacklab"
    private var initialNavigation = true
    private var started = false
    // Generation 1 is the initial fixture. The coordinator supplies strictly larger
    // generations for replacements, before issuing commands for that occurrence.
    private(set) var generation = 1
    private let maximumGeneration = 9_007_199_254_740_991

    override init() {
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        proxy.owner = self
        configuration.userContentController.add(proxy, name: "events")
        webView.navigationDelegate = self
    }

    func start() {
        guard !started else { return }
        started = true
        guard Bundle.main.bundleIdentifier == "com.tubeshuffle.playbacklab",
              let base = URL(string: origin + "/") else { onEvent?(.failure); return }
        webView.loadHTMLString("""
        <!doctype html><html><head><meta name="referrer" content="strict-origin-when-cross-origin">
        <style>html,body,#container {width:100%;height:100%;margin:0} #container iframe {display:block;width:100%;height:100%;border:0}</style></head>
        <body><div id="container"></div><script>
        let player = null, currentGeneration = 0, playerReady = false;
        function emit(type,value,generation) { window.webkit.messageHandlers.events.postMessage({type:type,value:value,generation:generation}); }
        function replacePlayer(generation, videoId, autoplay) {
          if (!Number.isSafeInteger(generation) || generation <= currentGeneration) throw new Error('stale generation');
          currentGeneration = generation;
          playerReady = false;
          if (player) { player.destroy(); player = null; }
          const container = document.getElementById('container');
          container.replaceChildren();
          const node = document.createElement('div');
          node.id = 'player-' + generation;
          container.appendChild(node);
          const active = () => generation === currentGeneration;
          player = new YT.Player(node.id, {width:'100%',height:'100%',videoId:videoId,
            playerVars:{origin:'\(origin)',playsinline:1},
            events:{onReady:e=>{ if (!active()) return; playerReady = true; emit('ready',null,generation); if (autoplay) e.target.playVideo(); },
              onStateChange:e=>{ if (active()) emit('state',e.data,generation); },
              onError:e=>{ if (active()) emit('error',e.data,generation); },
              onAutoplayBlocked:()=>{ if (active()) emit('autoplayBlocked',null,generation); }}});
        }
        function onYouTubeIframeAPIReady() {
          emit('iframeReady',null,null);
          replacePlayer(1,'ScMzIvxBSi4',false);
        }
        function command(kind,generation,value) {
          if (generation !== currentGeneration || !playerReady || !player) throw new Error('stale or not ready');
          if (kind === 'play') player.playVideo();
          else if (kind === 'pause') player.pauseVideo();
          else if (kind === 'seek') player.seekTo(value,true);
          else if (kind === 'time') return player.getCurrentTime();
          else if (kind === 'duration') return player.getDuration();
          else throw new Error('unknown command');
        }
        </script><script src="https://www.youtube.com/iframe_api" onerror="emit('failure',null,null)"></script></body></html>
        """, baseURL: base)
    }

    private func evaluate(_ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value) }
            }
        }
    }
    func play(generation: Int) async throws {
        guard generation == self.generation else { throw BridgeError.invalid }
        _ = try await evaluate("command('play',\(generation))")
    }
    func pause(generation: Int) async throws {
        guard generation == self.generation else { throw BridgeError.invalid }
        _ = try await evaluate("command('pause',\(generation))")
    }
    func load(videoID: String, generation: Int) async throws {
        guard generation > self.generation, generation <= maximumGeneration,
              videoID.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { throw BridgeError.invalid }
        self.generation = generation
        _ = try await evaluate("replacePlayer(\(generation),'\(videoID)',true)")
    }
    func seek(to value: Double, generation: Int) async throws {
        guard generation == self.generation, value.isFinite && value >= 0 else { throw BridgeError.invalid }
        _ = try await evaluate("command('seek',\(generation),\(value))")
    }
    func getCurrentTime(generation: Int) async throws -> Double { try await number("time", generation: generation) }
    func getDuration(generation: Int) async throws -> Double { try await number("duration", generation: generation) }
    private func number(_ name: String, generation: Int) async throws -> Double {
        guard generation == self.generation else { throw BridgeError.invalid }
        guard let value = try await evaluate("command('\(name)',\(generation))") as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { throw BridgeError.invalid }
        return value.doubleValue
    }
    private enum BridgeError: Error { case invalid }

    fileprivate func receive(_ message: WKScriptMessage) {
        let frame = message.frameInfo, security = frame.securityOrigin
        guard message.webView === webView, message.name == "events", frame.isMainFrame,
              security.protocol == "https", security.host == "com.tubeshuffle.playbacklab",
              security.port == 0 || security.port == 443,
              let body = message.body as? [String: Any], Set(body.keys) == Set(["type", "value", "generation"]),
              let type = body["type"] as? String else { return }
        if type == "iframeReady" || type == "failure" {
            guard body["value"] is NSNull, body["generation"] is NSNull else { return }
            onEvent?(type == "iframeReady" ? .iframeReady : .failure)
            return
        }
        guard let number = body["generation"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue == Double(generation) else { return }
        switch type {
        case "ready", "autoplayBlocked":
            guard body["value"] is NSNull else { return }
            switch type {
            case "ready": onEvent?(.ready(generation))
            default: onEvent?(.autoplayBlocked(generation))
            }
        case "state", "error":
            guard let value = body["value"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
                  value.doubleValue >= -1, value.doubleValue <= 1000 else { return }
            let code = value.intValue
            guard type != "state" || [-1, 0, 1, 2, 3, 5].contains(code) else { return }
            onEvent?(type == "state" ? .state(generation, code) : .error(generation, code))
        default: return
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let target = action.targetFrame else { decisionHandler(.cancel); return }
        if target.isMainFrame {
            let allowed = initialNavigation && url.absoluteString == origin + "/"
            if allowed { initialNavigation = false }
            decisionHandler(allowed ? .allow : .cancel)
        } else { decisionHandler(url.scheme == "https" || url.absoluteString == "about:blank" ? .allow : .cancel) }
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { initialNavigation = false }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onEvent?(.failure) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { onEvent?(.failure) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onEvent?(.failure) }

    deinit { webView.configuration.userContentController.removeScriptMessageHandler(forName: "events") }
}

private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: DirectPlayer?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}
