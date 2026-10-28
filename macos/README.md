# Playback Lab — P0 only

This is an isolated feasibility experiment, not the native product. It uses one retained YouTubePlayerKit player and a native-owned queue of six fixed public example IDs. It does not contain accounts, cloud data, API keys, downloads, or a media workaround. Video availability and embedding permissions may change. The player library explicitly does **not** support background audio.

For the owner-authorized shorter P0 runs on 2026-10-28, the existing fixture was reordered to `ScMzIvxBSi4`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ysz5S6PUM-U`. The first two items allow shorter natural-ending observations; no seeking or shortened end times are configured. The final item displayed “Video unavailable” on this Mac. Original-order results and revised-order results are recorded separately in the plan.

## Build on the owner's Mac

1. Check `xcodebuild -version`, `swift --version`, and the installed SDK; YouTubePlayerKit 2.0.5 requires Swift tools 6.0 (Xcode 16 or later). This project targets macOS 13 or later; actual host/Xcode compatibility and signing must be checked locally.
2. Open `TubeShuffle.xcodeproj`, select the shared **TubeShuffle** scheme and an appropriate signing team if needed. The sandbox enables outgoing network connections. Resolve packages and run, or from the repository root:

   ```sh
   xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS' build
   ```

   On the tested Apple Silicon Mac, the default build attempted x86_64 while the package built arm64. This command succeeded with the local initializer fix included:

   ```sh
   xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/tubeshuffle-p0-derived ONLY_ACTIVE_ARCH=YES build
   ```

The exact package version and tag revision are pinned in the project and `Package.resolved`. The installed bundle ID is `com.tubeshuffle.playbacklab`; the tagged library derives `https://com.tubeshuffle.playbacklab` as its iframe origin and HTML base URL. Do not replace it with an unrelated identity. The iframe `origin` and `widget_referrer` are not themselves an HTTP Referer header. Verify actual ready/playback and specifically error 153 on the Mac; the source configuration does not prove YouTube receives or accepts the required identification.

The deterministic queue checks are separate from Xcode's scheme (there is no XCTest target):

```sh
swiftc macos/TubeShuffle/Playback/QueueState.swift macos/TubeShuffleTests/Playback/QueueStateTests.swift -o /tmp/tubeshuffle-queue-tests
/tmp/tubeshuffle-queue-tests
```

## Experiment and record

Start playback visibly. The log has ordered sequence numbers, fractional UTC and monotonic elapsed time, last command-accepted occurrence, counters, lifecycle and sanitized events. The initial occurrence is a fixture, not a confirmed load. “Requested” is an issued load; “accepted” means its API call returned successfully, not that video played; “natural observed” means a natural-ended request was followed by a playing callback, not authenticated proof. Next remains available on errors and tries the following item; after a failed command it skips the failed target. This does not count as a natural transition. The wrapper evaluates load commands directly even in error state, but whether recovery succeeds must be tested on Mac; report failures instead of assuming it works. Copy the log frequently: it is in-memory only, capped at 500 entries and lost on quit or potentially inaccessible after window close. Copy it **before** close/quit and record subsequent observations separately. Observe actual audible playback, OS/Xcode versions, connection changes, and bot-check/unavailable screens; callbacks cannot establish them. Numeric event data include iframe errors 2, 5, 100, 101/150 and 153; nonnumeric payloads are redacted. Do not paste credentials, private URLs, or personal data into logs.

* Try foreground playback, switching to another app with the window visible, and full occlusion. Exercise Play, Pause and Next; manual Next is not a natural advance.
* Restart the app for a fresh queue. Minimize it and observe at least **two natural ended-to-next transitions**, then restore and record audio, events, occurrence, and advance count. Merely continuing the current track does not pass.
* Restart and repeat with Cmd+H-hidden for at least two natural transitions; restore and record the same observations. Seeking near the end is supplemental, not a substitute for natural endings.
* Exercise screen lock/unlock, sleep/wake and reconnect, restoration, closing the window versus quitting the process. Record what happens, not an assumed result. Continuous system-sleep playback is not an acceptance criterion.
* Report missing or duplicate transitions, command failures, 153, unavailable or non-embeddable items, and bot checks distinctly. Capture evidence and stop for an explicit owner go/no-go before P1.

**Policy:** YouTube's developer policy III.I.9 prohibits background-player features; automatic initiation while the player is not sufficiently visible is a separate documented visibility concern. The owner requested this temporary hidden/minimized experiment despite that conflict. Personal use and technical success do not establish permission or compliance. No visibility/identity spoofing, keepalives, extraction, ad suppression, or bypasses are implemented. See https://developers.google.com/youtube/terms/developer-policies and https://developers.google.com/youtube/terms/required-minimum-functionality.

The requirements guide specifically gives minimized or closed windows as examples of background players; scripted initiation when insufficiently visible is a distinct concern. The owner accepted the risk of this isolated diagnostic, not YouTube authorization. The policy risk remains release-blocking; see the [restriction register](../docs/production-restrictions.md).

### Manual evidence worksheet

Record environment: date/time zone, macOS, Xcode/Swift, bundle ID, network, test build/commit, and how Referer/153 were checked without recording private traffic. For **each** lifecycle action and each transition, record a separate row, including at least two natural transitions in each minimized and hidden run:

| UTC time / log sequence | Action and window state | Previous video/occurrence | Next video/occurrence | Audio heard before/after | Event and requested/accepted/observed counters | Result/errors |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Include visible-but-inactive, fully occluded, minimize/restore, hide/unhide, lock/unlock, sleep/wake, reconnect, close, and quit. Note whether transitions were natural, manual or seek-assisted; capture raw 100, 101, 150 and 153 separately. Record actual video identity and media time manually where visible; the bridge does not authenticate either. Occlusion notifications and the system's `visible` flag are not proof that the player is actually on screen. Save a copy of the log before it rolls over or the window closes, and correlate by sequence/time.

## Bridge and observation limits

The tagged wrapper's callback bridge uses custom-scheme navigation, not a script-message handler. Its callback delegate does not visibly authenticate source frame or payload origin, and its navigation handling is not a verified strict allowlist. Callback-derived playback events **can initiate queue loads**, so forged or stale events could trigger unintended advancement, not just contaminate logs. This isolated POC sends no credentials or privileged operations through the bridge and does not enable URL-bearing debug logging. Harden or replace callback validation before adding privileges or relying on it for trusted automation; do not use this bridge as a security boundary.

Individual video loads make the native coordinator the only advancement authority; it does not use iframe playlist advancement. Playing/ended pairs received while a load is in flight are buffered until its result; duplicate ended events without a new playing observation are ignored. Callbacks have no occurrence identity: delayed or forged events can still arm or advance the wrong item and the counters do not prove exactly-once advancement. Compare event order and audio on the Mac. The wrapper deduplicates its playback-state publisher; raw event names/numeric data are also logged. No bot-check-specific callback is guaranteed. Window closing can dismantle the player view and the wrapper may pause it; process lifetime and recovery must be observed rather than assumed. No native build, playback, identity or policy conclusion was established on Linux.
