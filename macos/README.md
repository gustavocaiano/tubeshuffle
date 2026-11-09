# TubeShuffle native app — local integration

Normal launch now opens the SwiftUI library, not the Playback Lab. It never opens a library, reads Keychain credentials or contacts account services automatically. Use **Library** to explicitly create/open a local library or import a playlist. The ordinary interface has no demo entry; synthetic rehearsal mode is available only through the explicit test launcher. The player is created only when starting a queue. This is a local prototype awaiting UI, live-account/security and release-policy acceptance.

The listening screen follows the web interface: dark rounded player and queue cards, visible thumbnails, centered transport, Normal/Smart shuffle and Daily Suggestions. The top bar contains only the TubeShuffle brand and **Library**. Its menu contains **Your playlists…**, playlist import, create/open, JSON transfer, close and Account. The playlist grid also keeps its actions inside Library; **Options** opens the same management choices. The minimum window is **480 × 680 points**. Narrow windows stack the queue and expose **Queue** and **Shuffle** jumps; view and volume controls wrap when needed. **Cmd+ / Cmd−** zoom the interface from 80% to 125%; **Cmd0** restores 100%. Cmd= also increases zoom. The same actions are in View. Zoom is a local preference; demo runs use a fresh isolated preference suite. At larger zoom in a short window, scroll vertically to reach lower controls.

**Focus** shows an **80-point thumbnail** and the track information, with no visible video. Artwork off removes the thumbnail too. The existing WKWebView is retained and genuinely hidden with AppKit; no page visibility signal is falsified, no media is extracted, and switching views sends no playback/load command. **Video** reveals that same player. **Stage** expands the selected presentation; Stage or Escape returns to the queue. The visible video remains 16:9. Real audio and automatic advancement while Focus hides the view still need owner observation and remain subject to the open YouTube policy gate.

**Play** starts the displayed track in playlist order. **Shuffle & listen** is an explicit action in **Shape your queue**; once listening it becomes **Reshuffle queue**. Selecting a queue row plays that occurrence. The owner-requested removal of **Stop & close** leaves ordinary Play/Pause controls; closing the library/window or quitting tears down playback. A recovery error offers **Restart player**, preserving order/selection and waiting for Play. Artwork uses stored YouTube thumbnails, with a validated video-ID fallback; the demo includes small bundled thumbnails available without network access. Media playback still requires the official YouTube embed and a network connection.

The macOS application icon uses the website's unchanged [favicon](../public/favicon.svg), packaged as `Resources/AppIcon.icns` for Dock and Finder. Regenerate its standard and Retina representations on a Mac with the repository's Node dependencies installed: `node macos/scripts/generate-app-icon.mjs`. Xcode copies the icon into the app bundle; the delivery script verifies the bundled bytes and records both the icon and original SVG hashes.

## Import a YouTube playlist

Use **Library → Import YouTube playlist…**, the import button inside **Library → Your playlists…**, or **Cmd+L**. The welcome screen has only **Open Library**; import and account controls are not permanently displayed. Paste a public YouTube playlist URL or its ID. Links from a video or `youtu.be` are supported when they contain `list=`; standalone video/channel links are not playlist imports.

1. Choose **Create library…** for a new local library, or explicitly open a compatible library. Use a disposable destination for acceptance checks.
2. Choose **Import playlist**. If personal access has been set up on this Mac and on the server, no account sign-in is needed. Otherwise, before starting an import, choose **Library → Account → Use TubeShuffle → Sign in with Google**. **Use TubeShuffle** selects bundled public service origins and a publishable key; sign-in is a separate explicit action.
3. Tracks and distinct occurrences are saved locally. Saving the playlist ID to the account is optional and separate. Errors keep the dialog and link open; importing a playlist already present is blocked without replacing its content/history. **Cancel** also cancels an in-progress import; a late response is discarded.

Personal access is implemented locally but is **not yet verified on the production service**. The signed app's explicit `--prepare-personal-import` operation can create or reuse an origin-bound, 256-bit device credential in Keychain and output only its SHA-256 digest for the server's sensitive `TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256` setting. The raw device credential never belongs in server configuration, a URL, logs or chat. This credential permits playlist reads and suggestions; it does not grant account or cloud-link access. Removing the server setting and redeploying revokes the device path. No credential is prepared automatically at launch, and no existing Keychain item is overwritten or deleted. The existing account route remains available.

Suggestions are requested explicitly and send the playlist ID and up to five track titles, channels and durations to the TubeShuffle service to form YouTube searches. Track descriptions, tags, queue and history are not sent by the Mac. Personal-device results stay in the app's bounded in-memory cache and are not stored in the server's result cache; they are not part of the library export.

The `--ui-fixture` demo keeps account access disabled even after opening a disposable library. Its import dialog offers **Open TubeShuffle**, which opens an ordinary app instance without selecting a library or signing in. Account configuration is per run. **Advanced settings** retains manual origins/key entry and explicit public setup JSON load/save.

## One grouped UI rehearsal

From the repository root on this Apple Silicon Mac:

```sh
./macos/scripts/run-ui-fixture.sh
```

The script builds the current checkout in a new temporary directory and opens an **in-memory synthetic demo** with `--ui-fixture`. It prints the rehearsal directory and build log. Account access stays disabled for the fixture run, and preference changes use a fresh isolated suite. It does not select a real library, deploy anything or delete its rehearsal files. Signing is disabled for this local build; signing, Keychain entitlement and distribution behavior remain separate checks. A first run may download the pinned Swift package.

Send one results block after these checks, marking anything not tried as **not tested**:

1. **Interface:** Library grid, thumbnails/queue, resize down to 480 × 680, Queue/Shuffle jumps, Focus/Stage, keyboard navigation and VoiceOver if available. Check Cmd+ / Cmd− / Cmd0, including after clicking the video. Focus must show only the small thumbnail and track information; Video must restore the existing player. Library file shortcuts: Cmd+N / Cmd+O; transfer: Cmd+Shift+I / Cmd+Shift+E; playback: Cmd+Option+P toggles play/pause, Cmd+Option+Left/Right selects previous/next; Escape leaves Stage. The listening interface intentionally uses the web's dark appearance.
2. **Listening:** use Shuffle → Shuffle & listen, then Play if required. Check audio, queue advancement, row selection, seek, volume, Focus/Video, minimize/restore and Cmd+H/restore from this UI. Closing the library/window or quitting must stop playback; the Stop & close button was removed at the owner's request. Note errors or missing advancement; do not infer audio from displayed counters. The owner positively assessed the overall UI, but did not supply detailed audio/advancement results for this revised Focus behavior.
3. **Local transfer/persistence:** use Library → Export library to save the demo JSON **inside the printed rehearsal directory**. Choose Library → New library and give a new folder name inside that directory. Preview/import the JSON; check counts and any omission notice. Start a queue in this imported synthetic library, then stop playback, close/reopen that library and choose Resume queue. It must retain the exact occurrence/order/selection and wait for Play. Compare content/history after reopening. A second import into this nonempty library must be blocked.

The queue and preferences are **not transferred** by JSON: create the queue after importing to test its persistence. Natural observed ends are recorded once for the exact local occurrence; seeks/manual skips do not fabricate completions. Listening seconds are recorded as zero (not measured), not inferred from track duration. Suggestions opened on YouTube have no local listening events and are excluded from export/history.

In a macOS file panel, use **Cmd+Shift+G** to navigate to the printed rehearsal directory, then enter only a filename in **Save As**. Pasting a full path into the filename field can create a filename containing colon characters instead of navigating there. Confirm the selected directory before saving or creating a library.

Use only these synthetic files, without account login or a real library. Keep the rehearsal files until the results are reviewed. Automated SwiftUI checks cover geometry, demo artwork, actual native Focus hiding, retained-player identity across resize/Focus/zoom and synthetic key-event routing with the WKWebView focused. They render static media fixtures, not live audio; physical keyboard/file-panel behavior and subjective acceptance remain owner-observed. A successful build is not a UI/audio pass.

## Current local behavior and limits

- Content/history use SwiftData with CloudKit disabled. Creation requires a new private folder; existing open requires the runtime marker, compatible structure and a cooperative exclusive lock. No library discovery, missing-store creation, repair, merge or destructive refresh runs automatically. SwiftData has no public general no-migration open guarantee; arbitrary or old real stores are not approved by the synthetic checks.
- Queue is a versioned local JSON sidecar containing only exact occurrence IDs/order/selection. Opening a library never starts audio. A missing sidecar is distinct from an invalid one; malformed/unknown queue files are kept and reported. Queue/history commits are separate; the app does not claim an atomic transaction across them.
- Transfer v1 preserves IDs and valid history; orphan history is counted and omitted. Nonempty destinations are blocked. Input is capped at 10 MB, 500,000 JSON values and depth 8. A nominally valid but more complex file may be rejected by the resource cap. Files are unencrypted; export never replaces an existing filename. Old overwritten duplicate occurrences cannot be reconstructed.
- Account setup uses HTTPS origins and a Supabase **publishable** key, for Supabase Free only. **Use TubeShuffle** explicitly selects the bundled public configuration. Advanced settings also supports manual entry and **Load setup JSON…** / **Save public setup…**. Loading an external file only fills the form: review it, choose **Use this configuration**, then explicitly sign in or resume. No setup, credentials or services are activated at launch. Google PKCE uses the system authentication browser; credentials are isolated in Keychain by configuration. Sign-in does not upload or fetch playlist content. Cloud save/remove changes only IDs and is explicit. Resume/refresh are explicit; a failed mutation may already have committed and is not retried automatically.
- Live provider/owner/RLS behavior, actual callback delivery and real Keychain behavior remain external/manual gates. Read-only inspection confirmed Google enabled, the existing owner pin and expected catalog settings; it did not test live login or policy execution. The exact native callback `com.tubeshuffle.playbacklab://auth/callback` has since been added to the allowlist and verified by read-back, preserving both earlier redirects. Site URL is now the canonical HTTPS website. No SQL migration occurred. The Vercel additions were observed in the production deployment after the owner's merge on 2026-11-06; live account acceptance remains pending.
- Suggestions cache at most five results per request/UTC day and 20 entries in app memory, scoped to the active account or personal-device run. They open on YouTube; they are not silently inserted into a local playlist/history. Quota/network/service-paused failures preserve local contents.
- Normal/Smart shuffle, the embedded player, native queue/transport/seeking/volume, local filtering and preferences are implemented. Rendering checks cover desktop/narrow/zoom/Focus/Stage layouts and bundled artwork. The Focus change is explicitly a thumbnail-only presentation; native visibility actually changes and WebKit/YouTube remain free to pause or throttle. Accessibility, live artwork requests, OS interaction and playback through this UI still need owner observation. There are no transcripts, stream downloads, hidden keepalives or visibility/identity spoofing.

Run the historical lab explicitly with `--playback-lab`; `--local-oauth-diagnostic` and `--local-two-account-diagnostic` remain separate diagnostic paths. The sections below retain earlier evidence and procedures, not current product acceptance.

## Local delivery and browser coexistence

The website remains available at **https://www.tubeshuffle.online/**. The native app does not replace it or open its browser profile. Web IndexedDB/localStorage and native SwiftData/queue files are separate. There is no automatic content, queue, history or preference sync. Account links are shared only when the account service is configured and working; the cloud stores IDs, not local library contents.

The 2026-11-05 anonymous check observed homepage **200** and playlist-links API **503**; the [initial Vercel audit](../docs/evidence/native-delivery/vercel-readonly-audit.json) identified five missing account variables. Those were [configured](../docs/evidence/native-delivery/configuration-apply.json), preserving existing variables and preview/development. The owner subsequently merged PR #10. On **2026-11-06**, production was verified **READY at `2bc341c`**, with all five variables and the integrated browser storage protection included in the deployed source. Homepage/dashboard returned **200** and the anonymous API returned **401**. No real browser profile or library was opened; these HTTP checks do not establish authenticated account or storage acceptance. Supabase's native callback, canonical Site URL and Google configuration were also rechecked without mutation. [Current evidence and owner handoff](../docs/evidence/native-acceptance-2026-11-06/README.md). The agent did not perform the merge/deploy or any SQL migration. Future production changes still require separate authorization.

Build a fresh, isolated Apple Silicon candidate from the repository root:

```sh
python3 -B macos/scripts/prepare-local-delivery.py
```

This runs the hosted suite and a Release build with pinned package versions, verifies unchanged native source hashes, signs only its new app copy ad hoc, verifies the signature/entitlements/arm64 architecture, and produces a ZIP, `SHA256SUMS`, logs and `build-info.json` in a unique ignored `build/tubeshuffle-delivery-*` directory. It does not install, overwrite an earlier candidate, deploy or notarize. It is a repeatable preparation procedure, not a claim of bit-for-bit deterministic Xcode output.

Keep the extracted **TubeShuffle Local** folder together. **Open Demo.command** starts the isolated in-memory demo; **Open TubeShuffle.command** starts the ordinary empty entry screen. Requires macOS 14+ and Apple Silicon. The package is **not Developer ID signed or notarized**, and it is not an approved public release. No valid local Developer ID identity was found. Do not disable Gatekeeper globally.

### Website download and release handoff

The web app's `/macos` page is linked from its navigation, homepage and footer. It describes requirements, ZIP installation, Library setup, owner-account restrictions and explicit JSON transfer. The browser continues to work independently. No real library or account is accessed by the page. The preview image is copied, unchanged, from the synthetic native UI capture in `docs/evidence/native-library-menu-2026-11-07/captures/paused-1280x860.png`.

`src/config/macos-release.json` is deliberately `null`. The page therefore says that the public download is unavailable, disables its download button and keeps a working browser link. No local candidate, download URL or public release approval is implied. No runtime lookup of GitHub's “latest” release occurs.

To enable a public download **after separate distribution approval**:

1. Close the required acceptance and YouTube policy gates. Obtain the owner's explicit authorization to publish the reviewed artifact. Source/PR approval alone is not release authorization.
2. Produce an Apple Silicon ZIP containing the app and its instructions. Sign the app with a valid Developer ID, notarize/staple it, and validate a fresh downloaded copy on a disposable Mac library, including Gatekeeper, launch, account and transfer behavior. The existing ad-hoc delivery script does **not** do this.
3. Publish the approved ZIP as an asset of a versioned release in `gustavocaiano/tubeshuffle`, with release notes, source commit, requirements and checksum. Download the exact asset again and verify its SHA-256. This upload is a separately authorized action.
4. Replace the manifest with those actual values in a reviewed change, for example:

   ```json
   {
     "version": "0.1.0",
     "tag": "macos-v0.1.0",
     "fileName": "TubeShuffle-0.1.0-macos-arm64.zip",
     "sha256": "<64 lowercase hexadecimal characters from the published ZIP>"
   }
   ```

   This example is intentionally not a valid release manifest. Use the actual version/tag/checksum, not the local ad-hoc candidate's values. The resolver derives URLs only under this repository's GitHub releases; incomplete metadata, mutable `latest` tags, mismatched versions, path traversal and non-arm64/non-ZIP filenames stay unavailable. Parsing the manifest validates its shape, **not** the artifact's signature, availability or release approval. Those require the preceding evidence.
5. Run the web checks and verify download, notes and checksum against the published asset before separately authorized web rollout. Recheck page instructions if package layout or account access changes. Set the manifest back to `null` in a reviewed change to withdraw the website link; that does not delete an existing release asset.

No environment secret or Supabase plan change is needed for this download surface.

### Public account setup

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

The parser rejects unknown/duplicate fields, invalid origins, non-publishable keys and files larger than 8 KB. Export has the same size bound and never overwrites an existing file. Access/refresh tokens, owner pins, Vercel tokens and server API keys do not belong in this file. A public key's syntax does not prove its project provenance. The [public setup from the verified project](TubeShuffle/Resources/TubeShuffle-account-setup.json) is now bundled for the explicit **Use TubeShuffle** action; the packaging script checks its exact bytes and five allowed fields. Earlier packages keep their external setup files. The fixture demo disables Account. Actual callback delivery and owner sign-in/API acceptance remain pending; production deployment was separately verified on November 6.

The [latest candidate and evidence](../docs/evidence/native-library-menu-2026-11-07/README.md) simplify navigation into **Library**, remove demo entry buttons and preserve the [guided playlist importer](../docs/evidence/native-playlist-import-2026-11-07/README.md): **247 native tests passed, two remained skipped**, Release/package checks passed, and a fresh Sol 6.1 UI review scored this scope **9.0/10**. Packaged-app menu and sheet transitions were observed without login; actual Google/API import remains for owner validation. The [earlier UI evidence](../docs/evidence/native-ui-refinement/README.md) covers thumbnail Focus, zoom and the 480-point window. The [earlier delivery/configuration evidence](../docs/evidence/native-delivery/README.md) preserves its own package, observations and remaining gates. The grouped rehearsal above remains the single place to report unverified physical keyboard, audio and file-panel behavior. Passing it does not resolve YouTube policy.

# Playback Lab — historical P0 instructions

This is an isolated feasibility experiment, not the native product. It uses one retained WKWebView hosting the official YouTube iframe player and a native-owned queue of six fixed public example IDs. Account sign-in is unavailable by default; a private diagnostic is described below. It has no configured cloud data or API keys, downloads, or media workaround. Video availability and embedding permissions may change. Background playback is not established or approved.

The owner reported successful Mac `xcodebuild` tests at `4517340` and `8880af3`. At `ca96cb0`, a diagnostic live login reached a callback with an empty fragment, the exchange succeeded, and the UI showed Signed in. The owner confirmed the temporary native callback allowlist entry was removed. This does not establish release security, production deployment, background playback, or safe native import; existing security, history/transfer, and policy gates remain open.

The owner reported Mac Xcode tests at `e03c0e5`: 170 tests, one skipped, zero failures. In a separately approved temporary diagnostic, one synthetic owner link was created manually via SQL after an owner-zero precondition, bypassing the app RPC and RLS. The private diagnostic authenticated the owner and a distinct second account; the selected owner row was visible to the owner and hidden from the second account. The owner confirmed successful execution of the exact fixture cleanup SQL and removal of local files and the temporary callback allowlist entry. This is one read observation, not proof of general RLS or security, Google's current provider, token expiry or forgery handling, write denial, deployment, policy compliance, or import safety. Existing gates remain open.

For the owner-authorized shorter P0 runs on 2026-10-28, the existing fixture was reordered to `ScMzIvxBSi4`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ysz5S6PUM-U`. The first two items allow shorter natural-ending observations; those runs did not configure shortened end times. The final item displayed “Video unavailable” on this Mac. Original-order results and revised-order results are recorded separately in the plan.

## Build on the owner's Mac

1. Check `xcodebuild -version`, `swift --version`, and the installed SDK; this project targets macOS 14 or later; actual host/Xcode compatibility and signing must be checked locally.
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
