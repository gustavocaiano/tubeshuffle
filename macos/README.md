# Playback Lab — P0 only

This is an isolated feasibility experiment, not the native product. It uses one retained WKWebView hosting the official YouTube iframe player and a native-owned queue of six fixed public example IDs. Account sign-in is unavailable by default; a private diagnostic is described below. It has no configured cloud data or API keys, downloads, or media workaround. Video availability and embedding permissions may change. Background playback is not established or approved.

The owner reported successful Mac `xcodebuild` tests at `4517340` and `8880af3`. At `ca96cb0`, a diagnostic live login reached a callback with an empty fragment, the exchange succeeded, and the UI showed Signed in. The owner confirmed the temporary native callback allowlist entry was removed. This does not establish release security, production deployment, background playback, or safe native import; existing security, history/transfer, and policy gates remain open.

The owner reported Mac Xcode tests at `e03c0e5`: 170 tests, one skipped, zero failures. In a separately approved temporary diagnostic, one synthetic owner link was created manually via SQL after an owner-zero precondition, bypassing the app RPC and RLS. The private diagnostic authenticated the owner and a distinct second account; the selected owner row was visible to the owner and hidden from the second account. The owner confirmed successful execution of the exact fixture cleanup SQL and removal of local files and the temporary callback allowlist entry. This is one read observation, not proof of general RLS or security, Google's current provider, token expiry or forgery handling, write denial, deployment, policy compliance, or import safety. Existing gates remain open.

For the owner-authorized shorter P0 runs on 2026-10-28, the existing fixture was reordered to `ScMzIvxBSi4`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ysz5S6PUM-U`. The first two items allow shorter natural-ending observations; those runs did not configure shortened end times. The final item displayed “Video unavailable” on this Mac. Original-order results and revised-order results are recorded separately in the plan.

## Build on the owner's Mac

1. Check `xcodebuild -version`, `swift --version`, and the installed SDK; This project targets macOS 13 or later; actual host/Xcode compatibility and signing must be checked locally.
2. Open `TubeShuffle.xcodeproj`, select the shared **TubeShuffle** scheme and an appropriate signing team if needed. The sandbox enables outgoing network connections. Run, or from the repository root:

   ```sh
   xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS' build
   ```

   On the tested Apple Silicon Mac, the default build attempted x86_64 while the package built arm64. This command succeeded with the local initializer fix included:

   ```sh
   xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/tubeshuffle-p0-derived ONLY_ACTIVE_ARCH=YES build
   ```

The bundle ID is `com.tubeshuffle.playbacklab`; the HTML base URL and iframe origin are `https://com.tubeshuffle.playbacklab`. Actual HTTP Referer delivery and error-153 absence must be checked on the Mac; configuration alone does not prove identification.

The deterministic queue checks can also run separately from the XCTest target:

```sh
swiftc macos/TubeShuffle/Playback/QueueState.swift macos/TubeShuffleTests/Playback/QueueStateTests.swift -o /tmp/tubeshuffle-queue-tests
/tmp/tubeshuffle-queue-tests
```

These standalone checks cover the coordinator's pure startup, queue, generation-correlation, readiness-gate, mutation-gate, seek-gate, playback-intent, progress-admission and remote-eligibility state seams, including deferred ends, timeouts, invalidations, stale ready callbacks and superseded command snapshots. They do not instantiate the AppKit/WKWebView coordinator or verify publisher timing, watchdog firing, slider interaction, remote-command delivery, or teardown on macOS; exercise those on a Mac as described below.

Startup has a 15-second ready watchdog; failure or timeout requires a full app restart, and late readiness cannot recover the session. Every coordinator-issued load arms the same bounded 15-second readiness watchdog for its occurrence generation: transport, next, seek, remote commands and progress polling stay disabled until that generation reports ready, and a load that fails, completes without readiness, or times out requires a restart instead of leaving controls enabled against an unverified instance. Readiness is per occurrence and never carries across a load. Closing the player window also requires a restart: the retained view cannot safely re-arm the queue from its prior observations. Progress polling admits at most two outstanding evaluations globally, with a ten-second retry delay. Load and play/pause mutations have a ten-second watchdog. These safeguards do not authenticate iframe callbacks.

Each coordinator-issued load carries a strictly increasing occurrence generation (the bridge starts at generation 1 with its built-in fixture, so the first issued load uses 2; retries and repeated loads of the same video ID each reserve the next unique generation). The bridge tags every callback with the generation of the player instance that produced it, and every command names the generation it expects. The coordinator processes a callback only when its tag names the pending or active occurrence; stale tags are rejected and logged, replacing the previous fail-closed restart on the first Playing or Ended callback after a load. Playing/Ended callbacks that arrive while a load or transport command is in flight are buffered and processed only if that command completes for the same generation; late command completions after recovery or window changes are discarded. This correlation attributes callbacks to coordinator-issued player instances, not to authenticated remote video identity: the generation tag is supplied by the page script itself, so the top-level API script can still forge messages, and main-frame/origin validation identifies the sender channel only. A ready callback establishes per-instance readiness only — it is never treated as playing and does not prove the loaded video; a load command completing is likewise not proof of playback. A failed regular selection load marks its queue target failed; a failed staged shuffled-queue load instead discards the stage without marking an unrelated item in the retained queue failed. Neither is silently skipped, and both require a restart: the bridge reserves the new occurrence generation before evaluating the load command, so a failure leaves the previous occurrence untrusted and no manual control may reuse it. An iframe error that names a pending load generation requires a restart: the new instance has already replaced the previous player, so the previous occurrence cannot be trusted as active, and the in-flight load completion is then rejected with no further effects. A progress evaluation is bound to the occurrence it polled: one that names the active occurrence and fails requires a restart, while a stale evaluation that fails after a generation advance is discarded by its admission ticket and has no effect. System remote commands read an eligibility snapshot bound to the window generation and the occurrence; a queued command applies only while both still match, and a remote seek is bound to the occurrence it was admitted for, so a natural advance between the system callback and execution discards the command instead of acting on the new item. After a failed load the session is quarantined and requires a restart: transport and Next stay disabled, and no manual action reuses the previous occurrence.

## Sample queue shuffle controls

**Shuffle sample queue** stages a permutation of the entire current sample queue, including the current and previously visited items, and requests a load of its first item. The displayed queue and last accepted position remain unchanged while the load is pending; the staged queue and its first position are committed together when the load command is accepted. Acceptance is not proof of playback or video identity. A failed staged load discards the staged queue and requires a restart, without attributing the failure to an item in the retained queue.

**Shuffle upcoming** only permutes the suffix after the current item, retaining the current item and earlier queue positions; it does not issue a load. Either shuffle may produce the same order. These controls operate only on the in-memory sample queue: neither implements a persistent playlist, Smart shuffle, or playback history.

## Next Mac test: one short foreground run

Build the current app on the Mac. Start a fresh process, press Play once, and confirm audio. Keep the player visible; do not seek, pause, skip, minimize, or hide. Observe the first two natural transitions (1→2 and 2→3): with generation-correlated callbacks they should advance without the restart-required message; a stale Playing or Ended callback is instead rejected and logged with its generation, and controls re-enable only after each new occurrence reports ready. Restart is still required for bridge or navigation failure, the startup watchdog, a per-generation readiness timeout, an error during a pending load, a failed load command, a failed active-occurrence progress evaluation, a stalled mutation or seek, or a window close. Copy the log before quitting. Record build/OS, audible items, state events, errors, and requested/accepted/natural-observed totals. This is the only requested test; do not run network or background experiments. A pass is not policy approval or authenticated occurrence identity.

### Progress and system controls

The native position slider complements the unobscured embedded controls. It is disabled until the current occurrence reports ready and a playing callback with a positive duration is observed; after a load, a missing or deduplicated playing callback can leave progress unavailable, and a missing ready callback now ends in the readiness watchdog's restart instead of enabled controls. Generation tags attribute callbacks to player instances, not authenticated remote video identity, so even these observations can be stale or misattributed. Position and duration are polled from the iframe under the active occurrence's generation and may disappear on errors or stalled evaluations; an evaluation that fails while naming the active occurrence requires a restart, and a stale one is discarded by its admission ticket. Drag to seek; the displayed position follows subsequent observations, not command acceptance. The system Now Playing entry identifies only the last accepted fixture position, not a verified playing video. Its state follows playback callbacks, which have previously disagreed with audible playback; playback speed is not assumed. Play, pause, toggle, next and position commands are routed to the same native coordinator. System callback success means queued for validation, not that the iframe executed the command; asynchronous failures and commands superseded by an occurrence or window change are recorded in the event log. A seek marks that occurrence as seek-assisted even if the command fails; its ending cannot count as a natural observation.

The log records sanitized events and last accepted item, not verified video identity. Accepted commands do not prove playback. Generation tags are supplied by the page script and remain unauthenticated; a forged or stale tag is rejected only insofar as it does not name the pending or active occurrence. No Linux test proves native playback.

YouTube's background-player policy conflict remains release-blocking; the owner-authorized diagnostic is not YouTube permission. The hidden-window autoplay interaction is a separate unresolved issue: YouTube's required-minimum-functionality rules govern automatic and scripted initiation relative to player visibility, and whether a new occurrence's scripted initiation or a natural advancement is delayed, blocked, or throttled while the window is hidden, minimized, or occluded is unverified; the prototype neither observes nor influences that behavior, and the readiness and evaluation safeguards above treat an instance that never becomes ready or stops answering as restart-required rather than working around it. Occurrence identity itself remains unverified: every safeguard attributes callbacks to coordinator-issued player instances, never to authenticated remote video identity. No visibility or identity spoofing, keepalive, extraction, ad suppression or playback bypass is implemented. See [restrictions](../docs/production-restrictions.md).
# Native account scaffolding

The private Debug-only two-account read diagnostic has an explicitly opted-in app caller. A
successful result means that one limited owner read returned an owner-owned row
and the second account's limited read returned no rows. This is only a one-row,
two-account read result: it does not establish general RLS isolation or that the
owner cannot see other users' rows. The checks use fixed read-only requests; they
do not authorize a live run or a broader query. Email shape and confirmation
metadata do not prove deliverability or Google verification of the email.

The app declares a proposed native callback locally. A custom URL scheme is not exclusive to this app. The temporary diagnostic allowlist entry was removed as reported above; the diagnostic does not establish a production callback configuration.

Sign-in remains unavailable by default. A **private local Debug diagnostic** can be explicitly enabled as described below. With the checked-in build settings, a normal Release build does not enable it, even with the launch argument. Build setting overrides can define both compilation conditions in another configuration and are outside this guarantee. No origin or key is taken from build settings or Info.plist. This experiment is not production account integration.

Run offline structural checks with `python3 macos/tests/test_account_build_config.py`. A Mac/Xcode build and tests are still required to verify Swift compilation and the actual bundle.

### Private OAuth diagnostic (owner Mac only)

Do not run live authentication until the parent security review and Mac verification are complete. This is an explicitly enabled experiment, not playlist sync. The code pins the user-confirmed project origin `https://rkgbxjwmnlsmguhctguf.supabase.co`. It checks the runtime key's modern publishable-key format, not its project provenance; a valid-looking key may belong to a different project. Obtain the matching publishable key directly from that project's trusted dashboard. Legacy JWT, service-role, and secret keys are rejected by the format check; the server must validate the opaque key. Never post keys, callback URLs, tokens, provider errors, or screenshots containing them in chat or logs.

1. Build and launch the Debug app normally once, then quit, so macOS creates its sandbox container. Verify the local bundle ID is `com.tubeshuffle.playbacklab`. Use a private Mac account, disable terminal session recording, and avoid screen sharing. The diagnostic needs network access and a pre-existing, separately configured Google/Supabase OAuth setup and exact callback allowlist; this change makes **no remote configuration changes**. The callback is `com.tubeshuffle.playbacklab://auth/callback`; custom schemes are not exclusive, and successful callback correlation is not proof of exclusive delivery.
2. In a local terminal, create the file in the app container, outside the repository. Enter the matching publishable key silently when prompted; do not paste it into a command, Xcode setting, chat, or a file under version control:

   ```zsh
   umask 077
   target="$HOME/Library/Containers/com.tubeshuffle.playbacklab/Data/oauth-diagnostic-key"
   read -rs 'key?Publishable key: '
   (set -C; print -r -- "$key" > "$target")
   unset key target
   ```

   Before writing, verify the container and parent directories are trusted, owned and controlled by your private account, and have no unexpected ACL entries or shared access. Do not run this on a shared or untrusted account or with untrusted processes running as that user. The no-clobber write must succeed; if the path already exists, inspect and remove it locally before retrying. The file must be a regular, single-link file owned by the current user with mode `0600`; a symlink at the final path component and other mode bits are rejected. The file contains only the key and an optional single trailing newline. The file is not embedded in the app. The diagnostic fails closed if its checks or read fail, but those checks do not validate ACLs or parent directories and do not protect against hostile processes running as the same user. They do not guarantee secrecy.
3. In Xcode select the Debug configuration and add `--local-oauth-diagnostic` to the scheme's Run arguments. Launch the app and use its account control only when authorized. No credentials, callback, provider error, or identity are shown in the app. Sign-out, cancellation, window close and process exit clear local in-memory session state; sign-out is not provider-side revocation. Browser behavior and OS-managed caches are outside the app's persistence guarantees. OAuth itself creates/uses provider-side authentication sessions; the diagnostic performs no playlist or application-data API operations.
4. Quit the app, remove the launch argument, and delete `~/Library/Containers/com.tubeshuffle.playbacklab/Data/oauth-diagnostic-key`. Do not commit the runtime file. Remove it even after failure; deletion is not guaranteed secure erasure. Review provider-side session/revocation separately if required. A normal subsequent run remains unavailable.

The reported diagnostic result above is limited to that run; broader browser, PKCE, callback correlation, sandbox and cleanup behavior still require verification. No token is stored in Keychain by this diagnostic.

### Private two-account read diagnostic

Do not run live authentication or reads until the parent security review and Mac verification are complete and the owner separately authorizes the run. Follow the trusted-machine and sandbox publishable-key-file preparation and cleanup above. The publishable key is the only credential exempted from the no-credentials-in-files requirement. Do not add the single-account launch argument at the same time. Instead, opt in with `--local-two-account-diagnostic` in the Debug scheme. Open **Private check**, sign in as the owner, then sign in as a different account. No account data is displayed. Close the panel or cancel to clear the app's sessions locally; provider-side sessions are not revoked. The browser and OS are outside the app's persistence guarantees.

The fixed GET-only checks read both identities and owner-approval status, and at most one link row per account. They do not access the local library or write application data remotely. OAuth itself may create provider-side sessions. If the owner has no usable row, the row result is inconclusive. A positive result only means the selected owner row was hidden from the second account in this limited check; it is not a general security or current-provider claim. No live run, callback allowlist change, deployment, or remote configuration change is authorized by this implementation. Remove the argument and key file afterward.
