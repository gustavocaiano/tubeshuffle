# TubeShuffle native app — local integration

Normal launch now opens the SwiftUI library, not the Playback Lab. It never opens a library, reads Keychain credentials or contacts account services automatically. Create/open a local library explicitly, or choose **Try the demo**. The player is created only when starting a queue. This is a local prototype awaiting UI, live-account/security and release-policy acceptance.

The listening screen now follows the web interface: dark rounded player and queue cards, visible thumbnails, centered transport, Normal/Smart shuffle and Daily Suggestions. **Library** opens the playlist grid; **Library files** contains create/open/import/export. The minimum window is 760 × 680 points. Narrow windows stack the queue below the player and expose **Queue** and **Shuffle** jump buttons. The video remains 16:9 and the transport fits in the initial viewport. **Focus** makes the visible video smaller; **Stage** expands the player and hides surrounding navigation until Stage or Escape is pressed. Neither mode replaces the player or hides its video behind artwork.

**Play** starts the displayed track in playlist order. **Shuffle & listen** is an explicit action in **Shape your queue**; once listening it becomes **Reshuffle queue**. Selecting a queue row plays that occurrence. **Stop & close** tears down the player. Artwork uses stored YouTube thumbnails, with a validated video-ID fallback; the demo includes small bundled thumbnails so its artwork is available without network access. Media playback still requires the official YouTube embed and a network connection.

## One grouped UI rehearsal

From the repository root on this Apple Silicon Mac:

```sh
./macos/scripts/run-ui-fixture.sh
```

The script builds the current checkout in a new temporary directory and opens an **in-memory synthetic demo** with `--ui-fixture`. It prints the rehearsal directory and build log. Account access stays disabled for the fixture run, and preference changes use a fresh isolated suite. It does not select a real library, deploy anything or delete its rehearsal files. Signing is disabled for this local build; signing, Keychain entitlement and distribution behavior remain separate checks. A first run may download the pinned Swift package.

Send one results block after these checks, marking anything not tried as **not tested**:

1. **Interface:** Library grid, thumbnails/queue, resize down to 760 × 680, Queue/Shuffle jumps, Focus/Stage, keyboard navigation and VoiceOver if available. Confirm that the visible YouTube player and transport fit. Library file shortcuts: Cmd+N / Cmd+O; transfer: Cmd+Shift+I / Cmd+Shift+E; playback: Cmd+Option+P toggles play/pause, Cmd+Option+Left/Right selects previous/next; Escape leaves Stage. The listening interface intentionally uses the web's dark appearance.
2. **Listening:** use Shuffle → Shuffle & listen, then Play if required. Check audio, queue advancement, row selection, seek, volume, minimize/restore and Cmd+H/restore from this UI. Stop & close must stop playback. Note errors or missing advancement; do not infer audio from displayed counters. The owner reported that playback seemed good in the previous UI; exact observations for the redesigned controls remain unverified.
3. **Local transfer/persistence:** use Library files → Export library to save the demo JSON **inside the printed rehearsal directory**. Choose Library files → New library and give a new folder name inside that directory. Preview/import the JSON; check counts and any omission notice. Start a queue in this imported synthetic library, then stop playback, close/reopen that library and choose Resume queue. It must retain the exact occurrence/order/selection and wait for Play. Compare content/history after reopening. A second import into this nonempty library must be blocked.

The queue and preferences are **not transferred** by JSON: create the queue after importing to test its persistence. Natural observed ends are recorded once for the exact local occurrence; seeks/manual skips do not fabricate completions. Listening seconds are recorded as zero (not measured), not inferred from track duration. Suggestions opened on YouTube have no local listening events and are excluded from export/history.

In a macOS file panel, use **Cmd+Shift+G** to navigate to the printed rehearsal directory, then enter only a filename in **Save As**. Pasting a full path into the filename field can create a filename containing colon characters instead of navigating there. Confirm the selected directory before saving or creating a library.

Use only these synthetic files, without account login or a real library. Keep the rehearsal files until the results are reviewed. Automated SwiftUI rendering checks cover geometry, demo artwork and retained-player identity across resize/Focus. They render static media fixtures, not live audio; OS keyboard/file-panel behavior and subjective UI acceptance remain owner-observed. A successful build is not a UI/audio pass.

## Current local behavior and limits

- Content/history use SwiftData with CloudKit disabled. Creation requires a new private folder; existing open requires the runtime marker, compatible structure and a cooperative exclusive lock. No library discovery, missing-store creation, repair, merge or destructive refresh runs automatically. SwiftData has no public general no-migration open guarantee; arbitrary or old real stores are not approved by the synthetic checks.
- Queue is a versioned local JSON sidecar containing only exact occurrence IDs/order/selection. Opening a library never starts audio. A missing sidecar is distinct from an invalid one; malformed/unknown queue files are kept and reported. Queue/history commits are separate; the app does not claim an atomic transaction across them.
- Transfer v1 preserves IDs and valid history; orphan history is counted and omitted. Nonempty destinations are blocked. Input is capped at 10 MB, 500,000 JSON values and depth 8. A nominally valid but more complex file may be rejected by the resource cap. Files are unencrypted; export never replaces an existing filename. Old overwritten duplicate occurrences cannot be reconstructed.
- Account setup uses explicitly entered HTTPS origins and a Supabase **publishable** key, for Supabase Free only. Configuration is per run; **Load setup JSON…** and **Save public setup…** let you carry that public configuration between runs. Loading only fills the form: review it, choose **Use this configuration**, then explicitly sign in or resume. No configuration file is discovered automatically. Google PKCE uses the system authentication browser; credentials are isolated in Keychain by configuration. Sign-in does not upload or fetch playlist content. Cloud save/remove changes only IDs and is explicit. Resume/refresh are explicit; a failed mutation may already have committed and is not retried automatically.
- Account callback activation, live provider/owner/RLS behavior and real Keychain behavior remain external/manual gates. Read-only inspection confirmed Google enabled, the existing owner pin and expected catalog settings; it did not test live login or policy execution. The exact native callback `com.tubeshuffle.playbacklab://auth/callback` is currently absent from the allowlist. No Supabase setting or SQL migration was changed. The Vercel configuration additions below await a separate deployment.
- Suggestions cache at most five results per playlist/UTC day and 20 entries in memory, scoped to the active account run. They open on YouTube; they are not silently inserted into a local playlist/history. Quota/network/service-paused failures preserve local contents.
- Normal/Smart shuffle, a visible embedded player, native queue/transport/seeking/volume, local filtering and preferences are implemented. Rendering checks cover seven desktop/compact/Focus/Stage layouts and bundled artwork. Accessibility, live artwork requests, OS interaction and playback through this UI still need owner observation. There are no transcripts, stream downloads, hidden keepalives or visibility/identity overrides.

Run the historical lab explicitly with `--playback-lab`; `--local-oauth-diagnostic` and `--local-two-account-diagnostic` remain separate diagnostic paths. The sections below retain earlier evidence and procedures, not current product acceptance.

## Local delivery and browser coexistence

The website remains available at **https://www.tubeshuffle.online/**. The native app does not replace it or open its browser profile. Web IndexedDB/localStorage and native SwiftData/queue files are separate. There is no automatic content, queue, history or preference sync. Account links are shared only when the account service is configured and working; the cloud stores IDs, not local library contents.

The 2026-11-05 anonymous public check observed **200** on the homepage and **503** on `/api/playlist-links`. That is not a full web acceptance result. The initial [Vercel audit](../docs/evidence/native-delivery/vercel-readonly-audit.json) found five missing account variables. They have since been [added to production configuration](../docs/evidence/native-delivery/configuration-apply.json), preserving existing variables and leaving preview/development unchanged. The running deployment remains at `e168bd5`; it does not acquire those values until a new deployment, and the checkout's newer storage protection has not been rolled out there. Supabase reads verified the project/key/pin and catalog settings, but the native callback and canonical Site URL still need Auth configuration access. No Supabase mutation, SQL migration or deployment occurred. Live-account acceptance remains pending.

Build a fresh, isolated Apple Silicon candidate from the repository root:

```sh
python3 -B macos/scripts/prepare-local-delivery.py
```

This runs the hosted suite and a Release build with pinned package versions, verifies unchanged native source hashes, signs only its new app copy ad hoc, verifies the signature/entitlements/arm64 architecture, and produces a ZIP, `SHA256SUMS`, logs and `build-info.json` in a unique ignored `build/tubeshuffle-delivery-*` directory. It does not install, overwrite an earlier candidate, deploy or notarize. It is a repeatable preparation procedure, not a claim of bit-for-bit deterministic Xcode output.

Keep the extracted **TubeShuffle Local** folder together. **Open Demo.command** starts the isolated in-memory demo; **Open TubeShuffle.command** starts the ordinary empty entry screen. Requires macOS 14+ and Apple Silicon. The package is **not Developer ID signed or notarized**, and it is not an approved public release. No valid local Developer ID identity was found. Do not disable Gatekeeper globally.

Public setup JSON has exactly these fields (replace the placeholders before loading):

```json
{
  "format": "tubeshuffle-account-setup",
  "version": 1,
  "supabaseOrigin": "https://YOUR_PROJECT.supabase.co",
  "publishableKey": "<verified project publishable key>",
  "applicationAPIOrigin": "https://www.tubeshuffle.online"
}
```

The parser rejects unknown/duplicate fields, invalid origins, non-publishable keys and files larger than 8 KB. Export has the same size bound and never overwrites an existing file. Access/refresh tokens, owner pins, Vercel tokens and server API keys do not belong in this file. A public key's syntax does not prove its project provenance. A [setup JSON from the verified project](../build/tubeshuffle-delivery-_fcy8y2w/TubeShuffle-account-setup.json) is prepared beside the candidate ZIP. Load it in the ordinary app's Account form; the demo disables Account. Loading is not live acceptance: the native callback, deployment and owner sign-in test remain pending.

See the [delivery evidence and remaining gates](../docs/evidence/native-delivery/README.md) for the prepared candidate, exact counts and the limited UI observations. The grouped rehearsal above remains the single place to report unverified keyboard, audio and file-panel behavior. Passing it does not resolve YouTube policy.

# Playback Lab — historical P0 instructions

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
