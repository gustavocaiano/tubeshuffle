# Native macOS TubeShuffle

## Status and chosen direction

Planning document plus an isolated P0 prototype handoff. Saving this plan creates no application code, infrastructure, branch, commit, or pull request. The separate P0 prototype exists as uncommitted working-tree files under `macos/`; no dedicated prototype commit, PR, or Mac evidence exists yet.

**Chosen direction:** a genuinely native SwiftUI application under `macos/`, sharing authenticated Vercel data APIs with the existing website. Use a WKWebView-based official YouTube embedded player only for video playback—not for the application interface.

**First delivery is an isolated playback prototype, not the full application.** Background listening is a near-essential user requirement. Prove ordinary minimized/hidden-window playback on the owner's Mac before investing in authentication, storage, or polished UI. Full implementation remains blocked on a subsequent explicit go/no-go decision covering both observed behavior and the unresolved YouTube policy conflict.

The owner has explicitly authorized building and running this isolated personal-use POC despite the disclosed policy conflict. That authorization is recorded risk acceptance for a diagnostic experiment in `docs/production-restrictions.md`; it is **not** YouTube permission, **not** a legal determination, and **not** release approval.

User decisions recorded:

- Beautiful native Mac interface; not a repackaged website.
- Personal use, with the owner's Mac and Xcode available for testing.
- Google sign-in, restricted to the owner initially.
- Account saves **playlist links/YouTube playlist IDs only**.
- Playlist contents, queue, playback history, and preferences remain local.
- Explicit browser export/native import; no automatic full-library synchronization.
- Online-only playback is acceptable; no downloads or offline media.
- Supabase Auth + Postgres is approved on the Free plan. No paid upgrade without approval.
- The first implementation milestone should be a dedicated prototype PR, followed by a pull-and-test handoff to a new chat on the Mac.

## Approaches considered

### A. Native window loading the deployed website

SwiftUI hosts the current Vercel website in WKWebView.

- Pros: smallest implementation; existing interface and server routes reused; website updates reach the app immediately.
- Cons: does not meet the native-interface goal; separate browser/app storage; website availability affects the entire interface; does not resolve YouTube's background policy.
- Decision: fallback only if the user changes the native-UI priority. A wrapper is not a background-playback guarantee.

### B. Native SwiftUI interface + shared API — selected

SwiftUI owns application UI/state; URLSession calls Vercel; the supported embedded YouTube player handles media directly.

- Pros: strongest Mac experience; independent interface; web and Mac share authentication and saved links; existing data API and TypeScript behavioral fixtures remain useful.
- Cons: React components/stores must be reimplemented; native playback needs real-Mac evidence; two interfaces to maintain while the website remains active.
- This is a sound long-term architecture even if the owner eventually uses only the Mac client. It does not require converting every operation into an API call.

### C. Bundled React interface + desktop shell

- Pros: substantial web UI reuse; application interface can ship with the binary.
- Cons: Next.js routing/server assumptions need adaptation; Electron adds Chromium overhead; native feel requires additional work; YouTube asks for OS-provided WebViews where available.
- Decision: not selected. Neither Electron nor Tauri removes the background-policy question.

## Discovery: existing integration points

Read root and relevant nested codemaps before changing their folders. References below are planning-time anchors, not frozen line numbers.

- `src/app/api/youtube/playlist/route.ts:268`: existing GET playlist proxy; `YOUTUBE_API_KEY` is read server-side. Accepts `playlistId` or `list`, validates identifiers, paginates up to 5,000 playlist items, and returns `YouTubePlaylistData` or `{ error }`.
- `src/app/api/youtube/suggestions/route.ts:484`: existing POST suggestions proxy. Request bounds, process-local rate limiting, and in-memory caching exist. These are not a durable deployment-wide quota boundary.
- Both routes are currently unauthenticated. There are no existing account sessions or cloud playlist records to migrate.
- `src/types/playlist.ts:1–24,85–106`: playlist/video/suggestion DTOs. Nullable metadata, optional fields, duration units, and date strings need explicit Swift decoding tests.
- `src/types/playlist.ts:26–62`: local playlist/video/history entities. Local UUIDs, YouTube IDs, and repeated playlist occurrences are different identities.
- `src/lib/storage/browser-db.ts`, `src/lib/storage/index.ts`, `src/stores/playlist-store.ts`: IndexedDB library/history and repository facade. No library-file export/import exists today. Playlist deletion can leave orphan history; transfer must handle this explicitly.
- `src/stores/player-store.ts:63–298`: local queue/transport persistence; `src/stores/playback-store.ts`: runtime playback progress.
- `src/lib/shuffle/{shuffle-service,energy-classifier,energy-flow}.ts`: Normal/Fisher–Yates and Smart metadata-derived energy-wave shuffle. Smart is not artist-spacing, BPM analysis, or an AI service.
- `src/components/playlist/VideoPlayer.tsx:256–417`, `src/lib/media/youtube-queue.ts`: iframe lifecycle, queue mirroring, browser media controls. The Chromium silent-audio workaround is not a native implementation strategy.
- `src/lib/services/youtube-browser.ts`: alternate public-key client-direct mode exists in source. Actual deployed configuration has not been inspected; do not claim that a key is currently exposed.
- `tests/unit/`: Vitest shuffle, queue, playback, and utility coverage; no API-handler contract tests were found.

## Architecture and ownership of data

```text
Web React UI                         Mac SwiftUI UI
  cookie session                       native PKCE session / Keychain
         \                            /       |
          authenticated Next.js APIs           local SwiftData
                 |                            metadata/history/queue
                 +-- YouTube Data API          |
                 |   server-only API key       WKWebView official iframe
                 |                            -> YouTube media directly
                 +-- Supabase Auth + Postgres
                     owner identity + saved playlist IDs
```

### Vercel remains the application API

Keep the existing `/api/youtube/playlist` and `/api/youtube/suggestions` URLs and add authentication without changing successful payloads unnecessarily. Add contract fixtures/tests rather than a speculative `/v1` rewrite.

Add a small authenticated bookmark resource:

- `GET /api/playlist-links`
- `POST /api/playlist-links`
- `DELETE /api/playlist-links/[playlistId]`

Listing, saving, and deleting links must make **zero YouTube API calls**. Metadata import/refresh is a separate explicit operation. Shuffle, queue editing, and history recording stay local. Never proxy video/audio through Vercel or Supabase.

### Keys, authentication, and authorization

- Keep `YOUTUBE_API_KEY` exclusively in server-only Vercel environment variables. Never put it in Swift, a shipped configuration file, `NEXT_PUBLIC_*`, transfer files, logs, or the player bridge.
- Restrict the key to required Google APIs where compatible with Vercel deployment; do not assume a static outbound IP or browser-referrer restriction works for a serverless server key. Configure conservative Google quota limits and monitoring.
- Browser: Supabase SSR cookie sessions. Native: Google identity login through Supabase PKCE and ASWebAuthenticationSession, with the selected SDK's token persistence explicitly verified in Keychain.
- Use identity scopes only. No YouTube-account read/write scopes or Google refresh tokens for YouTube access are needed.
- Google login can temporarily open system-managed browser authentication; ordinary use remains a native app. Do not perform OAuth inside the player webview.
- Verify credentials using supported server validation, initially `getUser`, not unverified JWT decoding or trusting a client-supplied user ID/session payload.
- Require an administratively pinned owner UUID after verified first-login bootstrap. Do not authorize through editable user metadata, a UI email check, or Google consent-screen test users alone.
- Enforce the owner guard inside **every** quota-consuming handler before any upstream request. Browser session-refresh middleware/proxy is not the authorization boundary.
- Native calls use bearer access tokens; browser calls use cookies. Reject malformed bearer credentials instead of silently falling back to another identity.
- Protect cookie-authenticated mutations against CSRF/cross-origin requests, redact credentials/callback URLs, avoid shared caching of authenticated data, and test logout/expiry/refresh.
- URLSession is not governed by browser CORS. Do not add wildcard CORS or treat an origin header as authentication.
- Remove or disable the anonymous/client-direct API-key path from the production web client. A desktop-only token or protected wrapper would not secure remaining public quota endpoints.
- Owner authentication does not prevent accidental quota exhaustion. Bound request work/retries, preserve input caps, cache daily suggestions locally, expose useful 429/quota failures, and avoid indiscriminate retries of 5xx responses. Decide any durable usage-counter service separately; do not quietly introduce another paid backend.

### Supabase: deliberately small cloud scope

Table: `playlist_links(user_id, youtube_playlist_id, created_at)`, unique on `(user_id, youtube_playlist_id)`.

- Normalize supported YouTube playlist URLs to IDs; store IDs, not arbitrary URLs.
- Enable RLS and restrict grants. Policies must enforce both row ownership and the server-managed approved-owner restriction. `auth.uid() = user_id` alone is insufficient for owner-only access.
- Test direct database API access with a non-owner session. Protecting Next.js alone cannot replace RLS because the publishable key is public.
- Supabase URL/publishable key may ship to clients. Service-role/secret keys and Google OAuth client secret remain server/provider configuration only; routine bookmark operations should use the user's identity and RLS.
- No video files, full playlist contents, playback history, queue, or preferences in Postgres.
- Saving a link is idempotent. Existing local links upload only through explicit user action; no surprise upload on login.
- Cloud unlink and local deletion are separate actions. Unlinking must not wipe local contents/history, and stale local data must not automatically recreate an unlinked bookmark.
- Fetch saved IDs on login/explicit refresh; fetch unknown metadata on demand, not one automatic YouTube request per saved link. Handle concurrent save/delete with server-confirmed state and refetch after conflicts/failures.
- Sign-out clears tokens and cloud-view state, cancels account requests, and retains local data on disk unless the owner explicitly requests deletion. Late responses must not repopulate signed-out state. Future multi-account support requires separate local-account ownership; it is not part of v1.

Free plan pricing checked during planning: $0/month, social OAuth, 50,000 monthly active users, 500 MB database/project, two active projects. Free projects pause after one week of inactivity; automatic backups are not included. These limits can change. Handle service-paused/unavailable states without deleting local data, keep file exports, and require approval for a paid upgrade. A local export is not a backup of Google/Supabase configuration.

### Native persistence and interchange

Select **local-only SwiftData**, behind a small repository boundary, for growing play history, watched filtering, incremental writes, and transactional imports. Explicitly disable CloudKit integration. Do not ship a parallel JSON-file database. Codable atomic files were considered but would acquire indexing/history/recovery complexity here.

Use a separate versioned JSON exchange format, shared by browser and Mac:

- Format identifier, `schemaVersion`, export timestamp, playlists, video occurrences, and play history.
- Preserve local UUIDs, YouTube IDs, playlist positions, timestamps, and metadata needed for Smart shuffle.
- Do not deduplicate repeated video occurrences by YouTube ID or confuse `LocalPlayEvent.videoId` with a YouTube ID.
- Export a consistent IndexedDB snapshot. Exclude credentials, media, transient playback progress, daily-suggestion cache, and active queue/UI preferences in v1; explain these exclusions in the UI.
- Validate file size/count limits, schema, IDs, dates, referential integrity, and strings before committing. Future/unknown major versions fail safely. Define explicit migrations as the format evolves.
- Default import is a previewed merge by stable record IDs: repeated imports are idempotent; identical records are ignored, missing records added, conflicting records remain unchanged with an explicit summary. Preserve intentional repeated occurrences with different IDs.
- Omit/report orphan history without silently attaching it to unrelated videos. Invalid input must not partially replace the existing library.
- Native export produces the same portable format. Browser restore/import can be a later addition; browser export and native import/export are required initially.

### Native player and design boundary

An app-owned coordinator retains one player instance through SwiftUI view updates. Native state owns queue intent; actual iframe events own observed playback state. There must be one advancement authority—not competing iframe and Swift next-track loops.

Start the prototype with **YouTubePlayerKit**, a maintained MIT SwiftUI/WKWebView official-iframe wrapper. The prototype currently pins tagged release 2.0.5 at revision `1ae827573024ab13dd6adea33b25d3eef6ff667c` (recorded in `macos/TubeShuffle.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`), but compatibility with the owner's actual Xcode/Swift installation is unverified. Do not assume current `main` manifests match a release. Its README says background audio is unsupported; adopting it does not establish support or policy permission.

Configure documented app identification/referrer using the stable bundle ID and supported origin configuration. Prove actual ready/playback behavior and error-153 absence on Mac; do not assume `file://`, arbitrary custom schemes, or fabricated identity will work. Do not add a localhost Next.js server by default.

If library bridge/lifecycle behavior is the identified blocker, compare a minimal direct WKWebView implementation. This is not permission to bypass an imposed background restriction, spoof visibility/identity, extract streams, suppress ads, or add hidden-player keepalive tricks.

Keep the YouTube player, controls, branding, captions/settings, ads, and links unobscured while the window displays it. Native controls may complement documented API behavior. Restrict navigation and validate bridge message source/frame and payloads; never pass account tokens, file access, arbitrary scripts, or privileged operations through the bridge. Evaluate the actual library's callback mechanism rather than assuming a particular bridge API.

**UI/UX owner: @designer.** Native sidebar/library, stable visible video region, queue, small toolbar, restrained system materials, system typography, semantic light/dark colors, and one restrained accent. No website-like ambient backgrounds or excessive frosted cards. Preserve accessibility, keyboard focus, Reduce Motion/Transparency, and meaningful error states.

- Separate selected playlist/item from currently playing item. Browsing must not unexpectedly replace playback.
- Include URL import, refresh, Normal/Smart shuffle, watched filtering, queue edits, and daily suggestions; suggestions failures must not block playback.
- Use “Refresh from YouTube,” not ambiguous cross-device “sync.” Saved-link sync and local contents must be distinguishable.
- Do not port video-obscuring Stage/No Artwork modes. An artwork preference may hide library/queue thumbnails, never the embedded video.
- Native media controls are optional until lifecycle/behavior is demonstrated; no silent-audio workaround or sleeping-Mac playback promise.

## Playback feasibility and policy gate

Official YouTube policy III.I.9 prohibits creating, including, or promoting background-player features. The official compliance guide's "Do not" list names this exact case: allowing background play "even when your API service window is closed or minimized." Minimized windows, Cmd+H, full occlusion, and closed-player continuation therefore fall inside the named prohibition rather than being an inference; no personal-use, single-user, or non-distribution exemption was found. This is a contractual risk, **not a proof of technical impossibility**. A successful Mac experiment does not establish compliance, and owner acceptance cannot override platform terms.

Background listening remains recorded as a core requirement. Do not silently replace it with visible-only playback or insert forced-pause behavior as an assumed user preference. P0 observes ordinary behavior without bypasses under the owner's recorded personal-use risk acceptance. After evidence, return to the owner for a go/no-go or product/source rethink; that decision is separate from the policy conflict and is not release approval. Do not label background playback supported or compliant by default.

The prototype must distinguish:

- Window visible while another application is active.
- Fully occluded, minimized, and app hidden with Cmd+H.
- Window restoration, screen lock, and wake/reconnect recovery.
- Closing a window versus quitting the process.
- System sleep, which is not continuous-playback acceptance scope.

Record audio continuation, player events/errors, current occurrence, advancement count, and lifecycle timestamps. Observe at least two **natural** ended-to-next transitions while minimized and two while hidden. A current video continuing alone is insufficient. Exercise native-controlled advancement as well as normal playback; seek-near-end is supplemental, not a replacement for natural endings. Use multiple public embed-allowed videos and log unavailable/bot-check/153 failures distinctly.

No official Apple guarantee of WKWebView minimized/hidden YouTube continuation was found. Existing projects demonstrate embedding, and some small full-site wrappers claim hidden audio, but they do not prove this exact supported-iframe queue use case. Revalidate after relevant OS/player/library updates.

## Implementation phases and write scopes

No phase is implemented by saving this document. `ship` should read this file, preserve completed gates, and delegate only the authorized phase.

### P0 — Isolated Mac playback prototype and PR handoff

**Owner:** @designer for the minimal native test surface; mechanical bridge/project follow-up may be assigned to @fixer sequentially. **Write scope:** `macos/TubeShuffle.xcodeproj/`, `macos/TubeShuffle/{App,Playback,Resources}/`, `macos/TubeShuffleTests/Playback/`, `macos/README.md`; narrowly scoped `.gitignore` changes for native artifacts; this plan's P0 evidence section.

- Scaffold one native target/scheme, `TubeShuffle`, and a persistent player coordinator. Minimal readable test controls, not the polished product.
- Use approximately six fixed public embed-allowed video IDs and a local queue fixture. The current fixture is `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ScMzIvxBSi4`, `ysz5S6PUM-U`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`; availability and embed eligibility are unverified until Mac testing. No YouTube API key, Supabase, cloud schema, auth, or web changes are required.
- Pin the player dependency (currently 2.0.5), document bundle identity/referrer configuration (`com.tubeshuffle.playbacklab`), expose safe event diagnostics, and document known limitations.
- In the future implementation session, create a dedicated prototype branch/PR, record its exact SHA/branch/URL, and provide the Mac prompt below. Do not merge or start later phases before user review. Parent handles repository PR linking and push verification when that work is actually requested.
- **Validation owner:** parent coordinates; owner/new Mac session performs actual Xcode build and interactive tests. Linux static checks are not native evidence.
- **Exit:** recorded technical observations and explicit owner go/no-go. A failure stops expensive downstream work rather than triggering unbounded workaround attempts.

### P1 — Freeze contracts and test vectors

**Owner:** @fixer. **Write scope:** new `shared/contracts/`, `shared/fixtures/`, and contract-focused tests under `tests/unit/`; this plan's agreed contract notes.

- Define existing API DTO/error fixtures, playlist-link CRUD semantics, and the versioned transfer schema.
- Add Smart classifier/ordering and queue-identity fixtures. Inject reproducible random inputs for cross-language comparisons; cover unknown metadata, Unicode normalization, repeated occurrences, and 10/24-track wave boundaries.
- Define owner auth errors, local/cloud deletion distinctions, and transfer validation/merge behavior before separate clients implement them.
- **Validation owner:** parent; @fast-generic runs relevant Vitest checks. No live YouTube quota is required for fixtures.

### P2 — Shared owner authentication, bookmark database, and API protection

**Owner:** @fixer. **Write scope:** `supabase/`, `src/lib/auth/`, `src/lib/server/`, `src/app/api/`, auth callback route(s), Next session-refresh proxy, `.env.example`, `package.json`, `package-lock.json`, backend/auth tests, and setup documentation.

- Add Supabase web SSR integration, shared validated cookie/bearer owner guard, migration/RLS policies, and saved-link CRUD.
- Protect both existing YouTube handlers before upstream fetches. Preserve existing payloads/bounds and remove production anonymous bypass paths.
- Define owner bootstrap/admin restriction and account deletion/session lifecycle expectations; disable unused auth providers/anonymous sign-in.
- Add no-shared-cache and cookie mutation protections. Keep operational quota limits distinct from authentication.
- Coordinate server deployment with web sign-in UI; do not deploy protected APIs first and knowingly strand the existing dashboard.
- **Validation owner:** parent/security lane. Prove anonymous/non-owner/forged/expired requests make zero upstream calls; owner cookie and bearer calls work; direct RLS cannot bypass owner restrictions; bookmark CRUD makes zero YouTube calls.

### P3A — Native domain, auth, API, persistence, and shuffle

**Owner:** @fixer. **Write scope:** `macos/TubeShuffle/{Domain,Persistence,Networking,Authentication,Playback}/`, corresponding non-UI native tests, and serialized native project/package integration.

- Implement Codable DTOs, URLSession clients, system-browser PKCE service, tested Keychain/session refresh, SwiftData repository, transfer codec, and native Normal/Smart shuffle.
- Preserve occurrence identities, exactly-once history/advancement, local watched filtering, daily-suggestion cache limits, and non-destructive refresh.
- Account links load independently of local metadata; no implicit cloud upload or metadata fanout. Implement sign-out/in-flight cancellation semantics.
- **Validation owner:** parent; @fast-generic runs XCTest on a Mac runner/session. Check tagged SDK compatibility before relying on APIs or storage defaults.

### P3B — Browser snapshot exporter

**Owner:** @fixer. **Write scope:** `src/lib/storage/`, new `src/lib/transfer/`, exporter unit tests. No dashboard/UI ownership.

- Read a consistent snapshot of local playlists/video occurrences/history and serialize the agreed format.
- Enforce omissions and integrity handling; preserve the existing storage schema and user data.
- **Validation owner:** parent; fixture-based Vitest coverage of round-trip semantics, duplicates, orphan history, large payload bounds, and secret exclusion.

### P4A — Web account, saved-link, and export UI — UI/UX lane

**Owner:** @designer. **Write scope:** login/account pages/components, dashboard and relevant playlist import controls, navigation/account affordances, and their UI tests. Backend/storage logic remains with P2/P3B owners.

- Add owner Google sign-in, denied-account/cancel/error states, logout, saved-link list/save/remove, explicit upload of existing local IDs, and library export.
- Explain what is account-saved versus local. Preserve existing IndexedDB library, shuffle/player behavior, preferences, and history.
- Keep informational pages public. Only authenticated/authorized access reaches protected data operations.
- **Validation owner:** parent plus designer accessibility/interaction review; existing browser regression tests plus manual owner-session flows.

### P4B — Polished native application — UI/UX lane

**Owner:** @designer. **Write scope:** `macos/TubeShuffle/{App,Features,DesignSystem,Assets.xcassets}/`, UI tests and approved native assets. Do not independently edit the active persistence/network/playback lane.

- Compose native sign-in, library/sidebar, import/transfer preview, player/queue, suggestions, settings, and keyboard commands.
- Handle empty/filter-empty, unavailable video, buffering, autoplay gesture, token expiry, API quota/service pause, invalid transfer, and network failure without local data loss.
- Keep playback stable while browsing, enforce player dimensions, and make light/dark/keyboard/VoiceOver behavior intentional.
- Do not flatten the designer's interaction/visual choices during later mechanical integration. Throwaway mockups, if needed, belong in a gitignored location and are deleted after design acceptance.
- **Validation owner:** designer for presentation; parent/owner on the Mac for actual behavior, accessibility, and library fidelity.

### P5 — Integrated acceptance and personal-use handoff

**Owner:** parent integrates; @fixer handles bounded nonvisual findings; @designer owns visual/interaction findings. **Write scope:** native project integration, release/test documentation, acceptance tests, this plan's evidence; functional fixes return to their owning lane.

- Run web lint/tests/build and native build/XCTest; exercise live Google web/Mac callback and refresh/logout on the owner's Mac.
- Verify API/RLS denial paths, credentials absent from artifacts/logs/transfer, and no public legacy route or client-direct quota bypass.
- Test 5,000-item imports, multiple playlists, >200 queue occurrences, edits during playback, corrupt/unsupported transfer files, transactional failures, and native app relaunch/update with local data intact.
- Re-run hidden/minimized natural advancement after final integration; validate volume/seek/error recovery and history exactly once. Record limitations honestly.
- Provide personal Xcode run/install instructions and update/retest procedure. Public download/App Store, notarized distribution, and automatic updater infrastructure are deferred.
- **Exit:** owner acceptance with evidence. No claim of macOS 27 behavior based solely on Linux tests or a library README.

## Execution Order

```text
P0 -> owner Mac evidence + explicit go/no-go -> P1
P1 -> P2 and P3B in parallel
P2 -> P3A
P2 + P3B -> P4A
P3A -> P4B
P4A + P4B -> P5
```

- P0 is isolated because neither cloud auth nor polished UI can fix a failed core playback premise.
- P1 freezes schemas/identities first so independent Swift/web lanes do not invent incompatible formats.
- P2 and P3B have disjoint server/auth versus browser-storage scopes and can run concurrently.
- Native service integration waits for stable authenticated contracts; web account UI waits for auth and export services.
- Native and web UI lanes can run concurrently once their service dependencies are ready; they own different platform directories.
- Native project/Package.resolved changes have one integration owner at a time. Feature lanes request project wiring rather than concurrently rewriting the project file. Root dependency manifests belong to P2 only.
- P5 waits for all writers to reconcile. Reuse unchanged test evidence; rerun checks only when their inputs changed or a release gate requires it.

## Verification budget and evidence ownership

- **Player premise:** owner/Mac session, P0 and final changed-state recheck. Observe actual audio/events and natural queue transitions; do not infer from mocks or current-video continuation.
- **Credential/owner boundary:** backend owner, mocked upstream request counters plus real RLS tests using owner/non-owner identities. Prove denial before YouTube calls.
- **Contract and algorithm parity:** P1/P3A owners, shared fixtures under Vitest/XCTest; no live API usage for deterministic logic.
- **Local data/transfer integrity:** persistence/export owners, transactional and repeat-import tests with UUID/YouTube-ID/occurrence distinctions and malformed files.
- **Cloud link semantics:** backend/client owners, zero-upstream assertion for CRUD, opt-in upload, deletion/no-resurrection, sign-out late-response tests.
- **Native design:** designer + owner, real window sizes/appearance/accessibility and player focus. Screenshots alone cannot prove interaction or playback.
- **Repository regression:** @fast-generic runs `npm run lint`, `npm run test`, `npm run build` after code changes. A failing pre-existing check is reported separately, not hidden or fixed opportunistically.
- **Mac commands once P0 creates the project:** `xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS' build`; add the corresponding `test` run when the scheme has its test target. Verify signing and selected SDK on the actual Mac. These commands have not been run during planning.

## Future PR and Mac new-chat handoff

During the authorized P0 implementation, the parent creates/pushes the dedicated prototype branch, opens/links the PR, and records exact branch, PR URL, commit SHA, dependency pin, and sample IDs here. No placeholders should be presented as an existing PR. Current state: the prototype is untracked in the working tree on branch `t3/macos-app`; no dedicated prototype commit, PR, or commit SHA is recorded.

On the Mac, fetch the recorded branch and check it out without overwriting local changes. For a new local branch: `git fetch origin`, then `git switch --track origin/<prototype-branch>`. If it already exists, switch to it and use `git pull --ff-only` after checking local changes.

Copy-paste prompt for a new Mac chat:

> We are testing TubeShuffle's native macOS playback prototype, not building the full app yet. Read `codemap.md`, `docs/plans/native-macos-app.md`, and `macos/README.md` from this checkout. Confirm the recorded prototype commit, macOS/Xcode/Swift versions, bundle identity, and pinned player package. Build/run the `TubeShuffle` scheme using this Mac. Do not implement Supabase, account sync, storage, or polished UI in this session.
>
> Test the fixed public-video queue: foreground playback and identity/referrer/errors; at least two natural next-track transitions while minimized and two while Cmd+H-hidden; app switching/occlusion/restoration; lock and wake/reconnect recovery. Record audio, player event ordering, occurrence index, advancement count, and any duplicate/missing events. Do not confuse continued current-track audio with a working queue. Do not promise playback during system sleep.
>
> Do not force pauses, spoof identity/visibility, extract or download media, suppress player features, or add hidden-player keepalive tricks. If the player library appears to fail, collect evidence before proposing a minimal direct-WKWebView comparison. Keep logs free of credentials and personal URLs. Append concise environment/results/limitations to the plan's P0 evidence section and give me a technical go/no-go recommendation separately from the unresolved YouTube-policy decision. Stop for my decision before P1 or any backend/full-UI work.

## Council review and reconciliation

The council recommends a gated native/API build. Alpha and gamma supplied substantive, aligned reviews; beta's configured model was unavailable and its bounded retry produced no confirmed response. There was no substitute model and no three-seat unanimity claim.

Chosen direction after review: isolated player proof first; SwiftUI + persistent WKWebView boundary; authenticated existing Vercel APIs; Supabase Google identity and playlist IDs only; local SwiftData and independent JSON interchange. An advisory preference for Codable files was considered; SwiftData was selected for growing history, indexed filtering, and transactional import rather than building file-database machinery. Background support/policy is deliberately unresolved, not engineered away.

## Prerequisites and deferred decisions

- Before P0: inspect/pin the actual tagged player release against the owner's Xcode; choose stable bundle ID and sample embed-allowed videos. Partially done: YouTubePlayerKit is pinned to 2.0.5 (`1ae827573024ab13dd6adea33b25d3eef6ff667c`), the bundle ID is `com.tubeshuffle.playbacklab`, and the six sample IDs are fixed but not verified as embed-eligible. Xcode/SDK compatibility and actual identity/referrer delivery remain unverified. Target the owner's macOS 27 environment; select the deployment minimum from verified SDK/package compatibility rather than making OS-release/architecture assumptions.
- After P0: owner decides whether to proceed, change the product/source, or stop. A technical pass is not policy clearance.
- Before P2 live deployment: create Supabase Free project/region, configure Google consent/OAuth and exact web/native callback allowlists, bootstrap/pin owner identity, apply tested RLS migrations, and configure Vercel secrets. Provision nothing during planning. Request secrets through the host's secure mechanism, never pasted into chat or committed files.
- Verify the tagged Supabase Swift SDK, Xcode requirements, actual Keychain storage/entitlements, and cancellation/refresh behavior. Current upstream manifests are not a guarantee of released compatibility.
- Supabase inactivity pauses and API/network failure need clear recovery; no paid upgrade or keepalive workaround is assumed.
- No accounts for other users, cloud history, full-library sync, YouTube account management, audio-only/download modes, or public distribution in this version.

## Sources and confidence limits

Context7 was attempted during research but its monthly quota was exhausted. Official documentation and public SDK source were used instead. No native build, live OAuth, RLS deployment, or playback test has been performed in this Linux planning workspace.

- YouTube required embed identity, WebView type, and visible-player requirements: https://developers.google.com/youtube/terms/required-minimum-functionality
- YouTube policy, including background-player prohibition: https://developers.google.com/youtube/terms/developer-policies
- YouTube iframe API/errors: https://developers.google.com/youtube/iframe_api_reference
- Maintained wrapper and its limitations: https://github.com/SvenTiigi/YouTubePlayerKit
- Relevant issue examples, not proof of this Mac's behavior: https://github.com/SvenTiigi/YouTubePlayerKit/issues/146 and https://github.com/SvenTiigi/YouTubePlayerKit/issues/162
- Swift OAuth flow: https://supabase.com/docs/reference/swift/auth-signinwithoauth
- Browser SSR/session validation: https://supabase.com/docs/guides/auth/server-side/creating-a-client
- Google provider setup: https://supabase.com/docs/guides/auth/social-sign-in/auth-google
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Swift SDK manifest/storage source; inspect a pinned release at implementation: https://github.com/supabase/supabase-swift
- Free-plan pricing/limits: https://supabase.com/pricing
- Mac build prerequisite: https://developer.apple.com/xcode/system-requirements/

## P0 evidence — prototype scaffolded, no Mac evidence

Recorded 2026-10-28 from repository inspection in a Linux workspace. This records configuration and scope only; it is **not** native evidence.

**Existing implementation state**

- Prototype files exist under `macos/` (untracked working-tree files on branch `t3/macos-app`, not committed). No dedicated prototype commit SHA, branch URL, or pull request is recorded; none should be inferred.
- Dependency pin: YouTubePlayerKit 2.0.5, resolved revision `1ae827573024ab13dd6adea33b25d3eef6ff667c`, exact-version requirement in the project and `Package.resolved`. The revision is an upstream package pin, not a commit of this repository.
- Bundle identity: `com.tubeshuffle.playbacklab`; deployment target macOS 13.0; sandbox with outgoing-client networking. Whether the required HTTP Referer is actually delivered remains unverified.
- Fixed sample queue (six IDs, in order): `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ScMzIvxBSi4`, `ysz5S6PUM-U`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`. Availability and embed permission are unverified.
- No XCTest target was found during review; standalone queue-state checks are not executed coverage.

**Mac evidence: none**

No Xcode build, signing, package resolution, launch, playback, audio observation, error-153 check, lifecycle experiment, or natural transition has been performed. No hidden/minimized/Cmd+H result exists in either direction. Linux static checks are not native evidence. Populate this section from the owner's Mac session, then record the owner's explicit go/no-go separately from the unresolved policy conflict; do not present a technical pass as permission or compliance.
