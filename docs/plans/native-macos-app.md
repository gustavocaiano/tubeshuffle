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

## P0 evidence — prototype handoff and owner Mac results

Recorded 2026-10-28 from repository inspection in a Linux workspace. This records configuration and scope only; it is **not** native evidence.

**Existing implementation state**

- Prototype implementation commit: `5b1d5e764e39cbeb620ea940e0823e67795d62a0` on branch `t3/macos-app`; pull request: https://github.com/gustavocaiano/tubeshuffle/pull/9. The branch may contain subsequent documentation commits; use its current head for testing.
- Dependency pin: YouTubePlayerKit 2.0.5, resolved revision `1ae827573024ab13dd6adea33b25d3eef6ff667c`, exact-version requirement in the project and `Package.resolved`. The revision is an upstream package pin, not a commit of this repository.
- Bundle identity: `com.tubeshuffle.playbacklab`; deployment target macOS 13.0; sandbox with outgoing-client networking. Whether the required HTTP Referer is actually delivered remains unverified.
- Fixed sample queue (six IDs, in order): `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ScMzIvxBSi4`, `ysz5S6PUM-U`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`. Availability and embed permission are unverified.
- No XCTest target was found during review; standalone queue-state checks are not executed coverage.

**Mac evidence: none**

No Xcode build, signing, package resolution, launch, playback, audio observation, error-153 check, lifecycle experiment, or natural transition has been performed. No hidden/minimized/Cmd+H result exists in either direction. Linux static checks are not native evidence. Populate this section from the owner's Mac session, then record the owner's explicit go/no-go separately from the unresolved policy conflict; do not present a technical pass as permission or compliance.

### Owner Mac session — 2026-10-28: technical NO-GO

This entry supersedes the earlier “Mac evidence: none” for the checks below only. P0 remains open; no owner decision to start P1 has been made.

- Checkout: clean `t3/macos-app` at `50ab4f4f51451ee7c10c53ec6866786aab0706c1` before testing; includes prototype `5b1d5e764e39cbeb620ea940e0823e67795d62a0`. Test build adds one compile fix: explicit `QueueState.init(count:)`, since private stored properties made the synthesized initializer inaccessible. No playback logic changed.
- Environment: macOS 27.0.1 (`26A434`), Apple Silicon; Xcode 26.6 (`17F113`), Apple Swift 6.3.3 (`swiftlang-6.3.3.1.3`), macOS SDK 26.5. Local timezone Europe/Lisbon; evidence timestamps UTC. These are local command outputs, not assumed OS/toolchain compatibility.
- Verified built bundle `com.tubeshuffle.playbacklab`; ad-hoc “Sign to Run Locally,” app sandbox and outgoing-client network entitlement. YouTubePlayerKit resolved to 2.0.5 / `1ae827573024ab13dd6adea33b25d3eef6ff667c`. Initial tests used the original fixture. The owner subsequently explicitly authorized a shorter fixed fixture: existing IDs reordered to `ScMzIvxBSi4`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ysz5S6PUM-U`, with matching initial player source. Rebuilt successfully with the same command; no playback/bridge logic or start/end times changed. Revised-run results apply to this recorded fixture revision, not the original commit's ordering.
- Build: the README's default build failed with unresolved YouTubePlayerKit for x86_64 while the package built arm64. After the initializer fix, `xcodebuild -project macos/TubeShuffle.xcodeproj -scheme TubeShuffle -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/tubeshuffle-p0-derived ONLY_ACTIVE_ARCH=YES build` passed and the app launched. A traditional-headermap warning remains. Both documented standalone queue-state commands passed after the fix; no XCTest target was added.
- Identity: pinned source derives `https://com.tubeshuffle.playbacklab` and uses it as HTML base URL. Foreground ready and audible playback succeeded; no raw 153 observed in this session. Actual outgoing HTTP Referer has **not** been captured, so identity delivery is not proven. No private traffic, credentials, or personal URLs were collected. Policy revision history and embedded-client identity guidance were re-read on this date.
- Evidence method: native Accessibility reads of the existing sanitized event log every 15 seconds, without restoring hidden/minimized windows or sending player commands. Full temporary logs are under `/tmp/tubeshuffle-p0-evidence/`; the app log rolls over after 500 entries. The durable [condensed event log](../evidence/native-macos-p0-2026-10-28.log) omits repetitive progress entries. Full native sequences 1–493 (revised minimized) and 1–489 (revised hidden) have no capture gaps, so rollover does not explain the missing Playing observations. Owner reports establish audio; callbacks alone do not. A blank native test window covered the player for occlusion, and was closed afterward. Screenshot capture by the agent was unavailable; the owner supplied the item-4 error screenshot.

| UTC / session sequence | Action / occurrence | Audio and event evidence | Result / limitation |
| --- | --- | --- | --- |
| 14:03:19–14:04:23 / first session #5–#200 | Foreground item 1; Play, Pause | iframe-ready → ready → buffering (3) → playing (1); Pause → paused (2). Owner subsequently reported hearing playback. | Foreground playback works in this environment. |
| 14:06:23 / first session #620–#628 | Manual Next, 1 → 2 | Requested/accepted 1/1; buffering callback, no subsequent playing callback captured, despite owner-confirmed audio. | Audible playback and callback state disagree; UI remained Buffering. |
| 14:07:20 / first session #635 onward | Finder active, player still visible | Owner confirmed audio continues and player remains visible. | Current-track continuation only. |
| 14:07:44–14:08:07 / first session #949–#1044 | Fully covered by test window, then restored | Occlusion false → true; owner confirmed audio under full cover and after restoration. | Current-track continuation only. |
| 14:08:52–14:09:23 / second session #34–#40 | Manual load of item 4 `ysz5S6PUM-U`, then Play | Requested/accepted 3/3, Unstarted (-1); embed and owner's screenshot say “Video unavailable / This video is not available”; owner reports no audio. No numeric 100/101/150/153 callback captured. | Fixture availability failure; not by itself a wrapper failure. No minimized test began on this item. |
| 14:10:41–14:11:03 / second session #46–#147 | Manual recovery 4 → 5, then natural 5 → 6 | Owner heard item 5 and then Rick Astley. Ended (0) → natural load request → accepted → buffering; totals requested/accepted 5/5, natural-observed remained 0 because no item-6 playing callback arrived. | One audible natural transition, before minimization. Counter/event mismatch remains unresolved. |
| 14:11:12 / second session #185 | Minimize item 6 | Minimized notification recorded after the 5 → 6 transition. | Does not count as a minimized transition; item 6 is last in queue. |
| 14:13:22–14:13:35 / third session #362–#425 | Owner minimized and sought near end, 1 → 2 | Owner heard next video start. Ended → natural-reason load accepted while minimized; no subsequent playing callback captured; requested/accepted 1/1, natural-observed 0. | **Seek-assisted supplemental result**, not an untouched natural-ending run. Subsequent pause/restoration makes this run unsuitable for the natural acceptance count. |
| 14:14:18–14:14:20 / fourth session #16–#29 | Original fixture: fresh item 1, then minimize without seeking | Playing callback precedes minimization; owner explicitly confirmed audible while minimized. Requested/accepted/natural-observed 0/0/0. | Stopped before first ending when owner chose the shorter fixture; no natural-transition result from this run. |
| 14:21:18–14:21:21 / revised minimized session #18–#30 | Revised fixture: item 1 playing, then minimized | Owner confirmed audio. Playing (1) precedes minimized notification. | No seeking; window stayed minimized through both endings below. |
| 14:22:52 / revised minimized session #401–#415 | First natural ending, 1 → 2 | Ended (0) → natural request → accepted → buffering (3). Owner heard “Me at the zoo” start. Requested/accepted/natural-observed 1/1/0. No item-2 playing callback. | First audible natural transition while minimized; observation counter fails to reflect it. |
| 14:23:12 / revised minimized session #491–#493 | Item 2 naturally ends; expected 2 → 3 | Ended (0) → “ended ignored or buffered”; no request for item 3. Owner confirms audio stopped after item 2 and queue 3 never started. Totals remain 1/1/0. | **FAIL:** second natural transition missing. Queue guard was never re-armed by a playing callback for item 2. No duplicate load observed. |
| 14:25:29–14:25:31 / revised hidden session #16–#25 | Fresh item 1 playing, then actual Cmd+H | Playing (1) → app hidden/inactive; owner confirmed audible while hidden. | No seeking; app remained hidden through both endings below. |
| 14:27:04 / revised hidden session #399–#411 | First natural ending, 1 → 2 | Ended → natural request → accepted → buffering; no item-2 playing callback. Owner confirms hearing item 2. Requested/accepted/natural-observed 1/1/0. | First audible natural transition while hidden. |
| 14:27:24 / revised hidden session #487–#489 | Item 2 naturally ends; expected 2 → 3 | Ended → ignored; no request for item 3, counts remain 1/1/0. App still hidden when checked at 14:27:40. | **FAIL:** second natural transition missing, same sequence as minimized run. |
| 14:28:29–14:28:37 / revised hidden session #495–#545 | Post-run playing/pause events on item 2, then two manual skips to item 4 | A later Playing observation increased natural-observed to 1, after the failed hidden interval had ended; intervening user/player activity is unattributed. Manual load totals then 3/3/1; owner confirms restored item-4 audio. | The late counter change cannot retroactively establish a successful hidden transition or trusted occurrence identity. Manual recovery works; UI can still report Buffering during audible playback. |
| 14:31:13–14:31:19 / revised hidden session #1170–#1197 | Control-Cmd-Q lock, owner unlock | Owner confirmed audio continued while locked and after unlock. App inactive/occlusion/active events captured; no explicit session-lock callback. Occurrence 4, totals 3/3/1. | Short lock/unlock audio observation only; no natural transition under lock tested. |
| After lock / actions log | Sleep attempts | `pmset sleepnow` failed with `0xe00002e2`; standard System Events sleep returned success but owner confirmed the Mac did not sleep. No sleep/wake notification or matching system sleep entry found. | **Not tested:** actual sleep/wake recovery. No continuous-sleep playback claim. |
| 14:33:59–14:34:20 / revised hidden session #1841–#1843 | Wi-Fi off and active Ethernet service disabled; manual Next 4 → 5 while offline; both restored after 20 seconds | Load API accepted (totals 4/4/1), buffering (3), no audible recovery. Restoration commands succeeded; Wi-Fi On, Ethernet Enabled, original default interface restored. Owner reported still silent/buffering. | **FAIL:** automatic recovery from an offline-issued load. Offline route absence was not independently sampled; both configured paths were disabled successfully. |
| 14:35:38 onward / revised hidden session #1845–#1848 | One native Play after reconnect | Command completed, owner still heard no audio; state later Unstarted (-1), no numeric iframe error. Fresh credential-free HEAD to YouTube iframe API returned 200. | Manual Play also failed to recover this load. No retry loop or player workaround added. Cold relaunch tested separately next. |
| 14:41:46–14:43:41 / relaunched foreground session #18–#500 | Cold relaunch and Play, then natural 1 → 2 → 3 | Owner confirms relaunch recovered audible playback. Both natural loads received Playing callbacks this time; requested/accepted/natural-observed reached 2/2/2. App active and window visible in lifecycle log throughout these transitions. Audio at each individual transition was not separately confirmed. | Successful callback sequence in a foreground control run; does not repair or invalidate the two failed hidden/minimized runs. Two subsequent manual skips landed on item 5, not item 4; the agent corrected its baseline label before close. |
| 14:46:05 / saved pre-close log + external observation | Native Close button during owner-confirmed audible item 5 | Window close also ended the process; owner confirmed audio stopped. No TubeShuffle crash report found. Last saved totals 4/4/2. | No closed-window continuation. Post-close event log inaccessible; process/audio observations recorded separately. No claim about the termination's internal cause. |
| 14:48:55–14:49:02 / final session #18 + external observation | Fresh launch, Play for about ten seconds, then explicit Quit | Playing callback captured before Quit; process absent afterward. Owner confirmed hearing audio start and then stop on Quit. Totals 0/0/0. | Explicit Quit stops playback/process. App, test occluder, and log collector are stopped; original network settings restored. |

**Technical recommendation: NO-GO for P1/full application work.** Both untouched minimized and Cmd+H runs produced one audible natural transition and then missed the required second transition. Missing native Playing observations left the queue guard unarmed; the following Ended event was ignored. No duplicate natural load was observed in either acceptance interval. This establishes the immediate advancement failure, not whether YouTube, WebKit lifecycle/event delivery, or the library's custom-scheme bridge caused the missing callback. The later foreground 2/2/2 result shows the behavior is not uniformly broken. Offline-load reconnect recovery also failed until relaunch.

**Bounded next P0 proposal, not implemented:** compare a minimal direct WKWebView official-iframe player with the same revised fixture, actual bundle identity, documented referrer method, ordinary window lifecycle, and sanitized event/counter evidence. A validated script-message callback path can isolate event transport from the wrapper. Measure actual outgoing Referer without retaining cookies or private traffic. Do not remove the queue guard as a speculative fix, spoof visibility/identity, add keepalives, or bypass player restrictions. Stop for the owner's choice to continue that comparison or stop/change direction.

**Limitations and separate policy decision:** actual sleep/wake recovery and HTTP Referer delivery remain unverified; CSS viewport size was not independently measured. Lock/occlusion/inactive audio observations do not establish natural queue advancement in those states. Owner reports media keys do not work; media-key/Now Playing integration remains deferred. The owner-authorized diagnostic and any future technical success are **not YouTube permission or release approval**. The documented policy conflict remains unresolved and release-blocking. No P1, backend, accounts, storage, sync, or polished-UI work was started, and no owner go decision is recorded. The compile fix, revised fixture, README, and evidence are included in the Mac-session handoff commit.
