# Playback Lab — P0 only

This is an isolated feasibility experiment, not the native product. It uses one retained YouTubePlayerKit player and a native-owned queue of six fixed public example IDs. It does not contain accounts, cloud data, API keys, downloads, or a media workaround. Video availability and embedding permissions may change. The player library explicitly does **not** support background audio.

For the owner-authorized shorter P0 runs on 2026-10-28, the existing fixture was reordered to `ScMzIvxBSi4`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ysz5S6PUM-U`. The first two items allow shorter natural-ending observations; those runs did not configure shortened end times. The final item displayed “Video unavailable” on this Mac. Original-order results and revised-order results are recorded separately in the plan.

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

These standalone checks cover the coordinator's pure queue, mutation-gate, seek-gate, playback-intent and progress-admission state seams, including deferred ends, timeout, invalidation and late completions. They do not instantiate the AppKit/YouTubePlayerKit coordinator or verify publisher timing, slider interaction, remote commands, or teardown on macOS; exercise those on a Mac as described below.

Progress polling admits at most two outstanding evaluations globally, with a ten-second retry delay. Invalidating an occurrence rejects stale results but does not release a slot until the evaluation finishes. When both evaluations have stalled for ten seconds, **Quit to recover** requests a full app restart; no additional evaluations are started. Load and play/pause mutations also have a ten-second watchdog: timeout or window closure during a mutation requires a full app restart, even if the old operation later returns. Closing and reopening the window cannot cancel bridge operations. Ended events during transport are deferred until completion only if occurrence and window lifecycle still match. These safeguards do not authenticate iframe callbacks.

## Experiment and record

### Next Mac test: one foreground run only

This is a diagnostic, **not a fix** for the recorded missing Playing callback. Build the current app using the arm64 command above. Start a fresh process and press Play once; confirm audible item 1. Leave the window foreground and do not seek, pause, press Next, minimize, or hide. Observe the first two natural transitions (1→2 and 2→3); if playback stops after item 2, stop waiting once its ending is apparent. After the observation, press **Capture state probe** once, then copy the event log before quitting. Record briefly: build/OS, audible items and transition outcomes, raw `onStateChange` events, the probe line and requested/accepted/natural-observed totals. No other scenarios or network tests are requested in this run.

The temporary probe adds a bounded list of state callback values and page-relative milliseconds immediately before the wrapper's existing custom-scheme navigation; it does not control playback or advance the queue. The button reads this list once after the run using the existing mutation gate and watchdog. It can be used when the player is not ready or reports an error, provided the window is open and no operation, seek, pending load, or recovery blocks safe evaluation. It is unavailable during recovery because an invalidated operation may still complete; a stalled bridge cannot safely be captured and requires a restart. A probe that itself stalls also requires a restart and yields no snapshot. Compare its ordered values with the native raw state events, not the deduplicated playback publisher. Page-relative time has a different origin from the native log: correlate by order and nearby state sequences, not absolute timestamps. A JS 1 with no corresponding native raw 1 suggests delivery/processing loss; no JS 1 suggests the wrapper callback was not invoked, but neither proves why, authenticates occurrence identity, or excludes probe effects. Failed/empty/truncated probes are inconclusive. The list retains at most 100 callbacks; a 100-row snapshot is marked potentially truncated because earlier rows may have been dropped. The native log retains 500 entries, so copy before rollover. Do not include private data. Remove this temporary probe after the investigation as recorded in `.slim/debug/macos-playback.md`.

The last queue item disables Next because there is no later item. An unavailable screen without a numeric error is not a classified iframe error. The final-item message offers quit and reopen to restart; it does not skip or diagnose the video.

### Progress and system controls

The native position slider complements the unobscured embedded controls. It is disabled until a playing callback and a positive duration are observed; after a load, a missing or deduplicated playing callback can leave progress unavailable. Callbacks have no authenticated occurrence identity, so even these observations can be stale or misattributed. Position and duration are polled from the iframe and may disappear on errors or stalled evaluations. Drag to seek; the displayed position follows subsequent observations, not command acceptance. The system Now Playing entry identifies only the last accepted fixture position, not a verified playing video. Its state follows playback callbacks, which have previously disagreed with audible playback; playback speed is not assumed. Play, pause, toggle, next and position commands are routed to the same native coordinator. System callback success means queued for validation, not that the iframe executed the command; asynchronous failures are recorded in the event log. A seek marks that occurrence as seek-assisted even if the command fails; its ending cannot count as a natural observation.

The following historical worksheet describes broader P0 investigations, not the next requested Mac test. Media-key routing and Now Playing behavior cannot be established on Linux. These controls do not resolve the documented P0 failures or policy restriction.

Start playback visibly. The log has ordered sequence numbers, fractional UTC and monotonic elapsed time, last command-accepted occurrence, counters, lifecycle and sanitized events. The initial occurrence is a fixture, not a confirmed load. “Requested” is an issued load; “accepted” means its API call returned successfully, not that video played; “natural observed” means a natural-ended request was followed by a playing callback, not authenticated proof. Manual Next is available in a player error state as a recovery attempt; it can fail and is not proof of recovery. After a failed load it skips the failed target. If a native seek stalls for ten seconds, transport remains locked and **Quit to recover** exits the app; reopen it to create a fresh player, rather than allowing a late seek against a different item. Closing and reopening the window alone cannot cancel that seek. Seek-assisted endings are marked separately and do not count as natural observations. Copy the log frequently: it is in-memory only, capped at 500 entries and lost on quit or potentially inaccessible after window close. Copy it **before** close/quit and record subsequent observations separately. Observe actual audible playback, OS/Xcode versions, connection changes, and bot-check/unavailable screens; callbacks cannot establish them. Numeric event data include iframe errors 2, 5, 100, 101/150 and 153; nonnumeric payloads are redacted. Do not paste credentials, private URLs, or personal data into logs.

Stop for an explicit owner go/no-go before P1. Report numeric errors only when observed.

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
