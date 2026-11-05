# Direct WKWebView P0 comparison

Standalone, owner-authorized diagnostic, not a fix or product. It uses no YouTubePlayerKit dependency and does not modify the original app. Its six-item fixture is exactly the revised P0 ordering. Each run starts at item 1 with no seeks, no custom start/end times, and a single app-owned advancement authority. `QueueState.swift` is a snapshot of the P0 coordinator's queue gate, intentionally retained for comparison; changing the original later does not change this copy.

## Build and run on the owner's Mac

From the repository root, with Xcode command-line tools selected:

```sh
xcodebuild -version; swift --version; sw_vers
sh macos/Comparison/build.sh /tmp/tubeshuffle-comparison
codesign -d --entitlements :- '/tmp/tubeshuffle-comparison/Direct Playback Comparison.app'
defaults read '/tmp/tubeshuffle-comparison/Direct Playback Comparison.app/Contents/Info' CFBundleIdentifier
'/tmp/tubeshuffle-comparison/Direct Playback Comparison.app/Contents/MacOS/Comparison' > /tmp/tubeshuffle-comparison/run.log 2>&1
```

The last command stays running until Close or Quit; use a separate Terminal to read the log. Start a fresh process and a distinct log for each test. Keep the original app stopped: both use the same bundle ID deliberately, and simultaneous instances could confuse lifecycle and attribution. The build is ad-hoc signed with the same sandbox and outgoing network entitlement; check signing, architecture and SDK locally. The executable is launched inside its `.app` bundle so `Bundle.main` provides the real identity. No shared Xcode project or third-party packages are used. Build artifacts and logs are outside the repository; delete `/tmp/tubeshuffle-comparison` after collecting sanitized evidence.

## Protocol

1. Capture build revision, macOS/Xcode versions, time zone, identity, network setup and any unavailable/bot-check/error screen. Wait for iframe `ready`, then press Play. Owner confirms audible sound; no event or counter proves audio.
2. Foreground control: observe two natural transitions, logging each actual audible occurrence, events and counts. Manual Next tests app-controlled loading separately.
3. Fresh run: start item 1 visibly, confirm audio, minimize normally, and observe two untouched natural endings without seeking/restoring. Record timestamps, actual audio and transition outcomes. Restore only afterward. Fresh run: repeat using real Cmd+H. A seek-assisted run is supplemental only. Log is written continuously to stdout, so it can be inspected externally without restoring the app; no polling or timer is injected into the player.
4. Fresh run, foreground: after playback, disable **all** active network paths using System Settings, verify route/connectivity is actually absent without recording addresses, then press Next once. Restore the original settings, verify connectivity and observe recovery; press Play once if desired and label it. Record sequence and owner audio before/after; do not retry automatically. Restore every changed network setting even if the test fails.
5. Compare raw ready/state/error sequences and requested/accepted/natural-observed counters with `docs/evidence/native-macos-p0-2026-10-28.log`, including lifecycle events. Record error 153, other numeric errors, missing callbacks, unavailable screens and offline recovery separately. Close/quit ends the process. No system-sleep continuation is assumed.

The log contains UTC wall time, monotonic elapsed time and sequence numbers. Requested means a command was issued; accepted means JavaScript evaluation returned without error, not that the video loaded or played. The natural-observed count is only a subsequent Playing callback, which can be stale or misattributed. The initial item is merely configured. The copied gate suppresses repeated Ended without a fresh Playing, matching P0's relevant behavior; it is not a speculative fix. The user must observe audio. Actual Referer delivery is unverified: bundle-derived `https://com.tubeshuffle.playbacklab/` is the HTML base, and the iframe `origin` is set from the same actual bundle ID. Neither proves an outgoing HTTP header. If separately measuring headers, inspect only the relevant Referer value with an approved method; do not retain cookies, credentials, private URLs, or unrelated traffic.

## Security and limits

Only the expected WKWebView's main-frame HTTPS bundle-derived origin and strictly typed, bounded event payloads are accepted. Top-level navigation away and popup navigation are blocked; subframe navigation is limited to HTTPS or `about:blank`, not host-allowlisted, because embeds can use multiple services. This is not a complete network boundary. Remote iframe API script runs in the top document and could forge messages; frame/origin checks cannot authenticate callbacks or establish the identity of the video that produced an event. Late callbacks may be attributed to the wrong request and trigger a load. No credentials, privileged operations, arbitrary incoming scripts, media extraction, visibility/identity spoofing, keepalives, ad suppression or policy conclusions are included. This is a diagnostic comparison only; a pass does not prove cause, release permission or policy compliance. See the P0 plan and `macos/README.md` for the existing risk and evidence limitations.

The security origin and initial navigation of `loadHTMLString(_:baseURL:)` must be verified on the owner's WebKit version: if it reports an opaque/different origin or initial navigation is blocked, callbacks will be rejected or the player will not load. The initial main-frame policy action, if delivered, is allowed once only for the exact base URL; committing the initial document also closes that allowance in case WebKit does not deliver that action. On Mac, verify initial loading and callbacks, then verify same-origin replacements (including reload and query/fragment navigations), external navigations and popups are blocked while the YouTube iframe still loads. Resize to the minimum window size and confirm the entire player and controls remain visible and usable. Record observed WebKit behavior; do not relax validation without investigating it. The direct iframe, its player settings, timing, and script-message path differ from the wrapper, so even a different result does not uniquely identify the cause.
