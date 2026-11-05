# Native macOS TubeShuffle

## Status and chosen direction

This plan includes historical planning and P0 handoff records; later evidence does not close the outstanding acceptance gates.

### Current continuation — 2026-11-05 (local work, no rollout)

The normal entry point now opens a native SwiftUI library, with local persistence, transfer, queue/player and explicit account/API integration. The implementation is ready for a synthetic owner UI rehearsal; **integrated acceptance and release are not complete**. The original phase scopes and older observations below are historical where they conflict with this status.

The owner explicitly requested continued implementation of the entire plan after reporting working playback. This authorizes safe local wiring and disposable tests beyond the earlier handoff's stop-before-wiring checkpoint. It does not authorize real-library access, live-account diagnostics, production migration, deployment or release. A `/goal` was not required or started.

The continuation started from clean `e168bd5`, branch `t3/native-macos-app`. That integration and UI rework are now committed at `051bb26`; the later delivery/setup additions below remain uncommitted. Neither checkpoint implies deployment. All three requested tracked documents were available. **All** `.slim/deepwork/browser-storage-provisioning/` artifacts were missing, including the Phase 2 research and Phase 1 review/validation reports. Their reported conclusions were not treated as newly verified evidence. Context was reconstructed from source, fixtures and tracked history. No `macos/codemap.md` exists; the root map and native sources supplied that context.

| Milestone | Implemented in this checkout | Tested and remaining gate |
| --- | --- | --- |
| Browser storage Phase 2 + confirmation | Exact test-only target-leaf replacement; integrated existing-only startup, one-shot create confirmation, schema preflight, generation-owned transactions and UI states | 13 real-module scenarios plus a two-tab concurrency/draining run passed in disposable Incognito fixtures. IDB/localStorage effects measured separately. No real-profile, Safari, durability or rollout validation. |
| P0 playback | Retained direct WKWebView; native occurrence queue, readiness/generation safeguards; current library queue and stop/teardown integration | Owner's earlier qualitative playback confirmation remains attributed below. Current native mock/behavior tests pass; actual audio, window restoration and final UI integration await the grouped Mac rehearsal. YouTube policy remains open. |
| P1 contracts | Shared API/owner/shuffle/transfer fixtures; Swift DTO, classifier, queue and transfer validation | Web and hosted Swift tests pass, including shared transfer validation and resource bounds. V1 does not prove cross-device occurrence continuity. |
| P2 account/APIs | Existing cookie/bearer guards, CSRF, bookmark routes and SQL/RLS sources; web account UI | Six synthetic HTTP tests pass. No new live JWT/RLS, migration or deployment evidence. Supabase Free only; cloud scope remains IDs/links. |
| P3A native services | Explicit system-browser Google PKCE, configuration-scoped Keychain adapter, resume/refresh/sign-out draining, guarded API links/content/suggestions, SwiftData local library and Normal/Smart shuffle | Synthetic native auth/API/storage tests and separate-process local-store probe pass. Real callback allowlist, owner/provider configuration, signed Keychain behavior and live API acceptance remain external gates. |
| P3B transfer | Existing browser export/disclosure UI; bounded strict native v1 codec, preview, orphan disclosure, empty-library transaction and no-clobber export | Snapshot round-trip, malformed/resource-bound cases, 5,000 occurrences, repeated IDs, idempotent completion and blocked reimport tested. No real-library import or ambiguous merge is authorized. |
| P4 native interface | Web-style SwiftUI listening screen, Library grid, demo, explicit create/open, API add, account/links, transfer preview, thumbnails, bounded 16:9 player/queue, seek/volume, Focus/Stage, suggestions and shortcuts | Reworked after owner rejected the first layout. Seven actual native render cases and resize/player-identity checks pass; independent visual review below. Final owner acceptance, keyboard/VoiceOver, real playback and OS file panels remain manual. |
| P5 acceptance | Synthetic integration, regression checks, retained evidence, isolated owner rehearsal script | In progress. Manual UI result, live-account/security validation and policy/release review remain outstanding. No production acceptance or rollout. |

#### Storage integration and transfer boundary

`browser-session.ts` now owns the production coordinator. Ordinary reads check existing-only and cannot silently recreate an absent database. Creation requires separate one-shot confirmation, followed by validation and an explicit existing check. The facade does not expose a raw handle to repositories. It captures a generation before asynchronous work, waits for transaction completion, invalidates/aborts active work on version changes and requires recheck rather than replaying writes. Queries/player/export are gated by current storage readiness/generation. The low-level `initializeStorage` hook remains for internal/test code; this is not a claim of a security sandbox around arbitrary same-origin JavaScript.

The v1 database name, version and schema are unchanged. Existing schema is checked without repair before the preserved metadata policy runs. A successful IDB metadata commit followed by localStorage failure is a distinct blocked state; no cross-system rollback is claimed. The integrated two-tab test confirms cooperative closure and stale-work rejection. An explicitly uncooperative fixture handle still causes blocked/draining; this is not universal coordination against unrelated scripts.

[Phase 2 decision and observations](browser-storage-phase2.md), [final source-bound browser evidence](../evidence/browser-storage-integrated-final-2026-11-05.json), [harness instructions](../../tests/browser/storage-startup/README.md). Earlier raw results remain separate historical files.

Native transfer permits only a fresh/empty library. Reimport into a populated library, destructive refresh and ambiguous continuity mapping remain blocked. Exact stored occurrence IDs and history are preserved without asserting provenance. Orphan history excluded from v1 is listed/count-disclosed and stays in its source; inactive completion journals and suggestion listening events are outside that export. Queue, preferences, credentials and media are excluded. Normal/Smart queue order and selection persist in a local versioned sidecar, separately from SwiftData history; neither cross-file atomicity nor crash durability is promised. Restoring a saved queue does not start playback. Natural observed ends record once for their exact local occurrence; watched seconds remain zero because listening duration is not measured.

#### Verification actually performed

- Web: `NODE_OPTIONS=--no-experimental-webstorage npm test` — **22 files, 461 passed, 2 skipped**. The two existing IndexedDB-gated skips are not counted as passed. The guarded browser harness independently tests native IndexedDB/export behavior.
- `npx tsc --noEmit` and `NEXT_TELEMETRY_DISABLED=1 npm run build` passed. `npm run lint` passed with zero errors and one existing unused `_id` warning in `playlist-store.ts:76`. No deployment.
- `node --test tests/integration/p2-http.test.mjs` — **6 passed**, simulated loopback providers; unchanged backend inputs. This is not live Supabase JWT verification, PostgreSQL RLS or OAuth.
- Native before the UI rework: **235 hosted XCTest cases executed, 233 passed, 2 skipped, zero failures**, using macOS **27.0.1 (26A434), arm64; Xcode 26.6 (17F113)**. That test host opened no product library/account UI. Player/network/credential seams use synthetic dependencies; store tests use fresh disposable roots. The native build used explicit arm64, pinned packages and `CODE_SIGNING_ALLOWED=NO`, so signing/distribution/real Keychain behavior is unverified. The later UI suite below supersedes this test count.
- `python3 -B macos/tests/test_account_build_config.py`: **6 offline structural checks passed**. The UI launcher passed `zsh -n`; it was not launched by the agent.
- Skips: `CooperativeFileLockTests.testProcessDeathReleasesLock` lacks safe hosted child reaping; `LocalLibraryStoreTests.testSuccessfulExistingStoreReopenRequiresSeparateProcess` delegates reopening to the standalone fixture harness. Skips remain skips. The standalone old-store lifecycle probe reported five scenarios; the new native-store probe separately passed transactional import/no-overwrite, second-process lock contention and reopening after the holder exits. Neither proves crash durability.
- The new native PKCE success test initially failed because its simulated HTTP response used persistence-format numeric dates. The SDK's HTTP decoder expects ISO strings. Correcting the fixture format and awaiting the browser expectation produced the passing suite; production validation was not relaxed. Earlier intermediate test counts are superseded, not added together.
- [Native/regression evidence summary](../evidence/native-integration-2026-11-05.json) records commands, source hashes, log/result locations and limitations. Native integration covers a 5,000-occurrence import and queue, exact history/queue reopening, shared validation vectors, malformed/resource-limited JSON and no-clobber file export. This is not a 5,000-row visual/performance result or an app-update acceptance test.
- Browser handles/tabs closed and loopback runners stopped. No real library/profile opened, native production `deleteDatabase`, SQL migration, real account request, upload, paid service, secret/configuration change, deploy or rollout.

#### Native UI rework — owner feedback on 2026-11-05

The owner subsequently supplied screenshots rejecting the first native layout: the player extended beyond the viewport, the interface was unintuitive and thumbnails were missing. The web screenshot is the visual reference. The owner also reported **“reprodução parece estar bom”**; this is a qualitative report about that run, not new transition counts, error logs or acceptance of the redesigned controls. The previous UI is superseded by the changes below.

- Replaced the split sidebar/list/player layout with the web's centered listening screen: charcoal cards, playlist heading, player left and thumbnail queue right, white round transport, Shape your queue and Daily Suggestions. Library navigation opens a native grid sheet. Application UI remains SwiftUI; only the supported player uses WKWebView.
- Bounded the player proposal and preserved 16:9 within the window height. At 760 × 680 the queue stacks beneath it; Queue/Shuffle jumps make the lower sections discoverable. Stage expands the visible player; Focus keeps a smaller visible video. The same player/occurrence survives resize and Focus. No visibility spoofing or hidden playback workaround was added.
- Added real thumbnail rendering with validated fallback URLs and bundled demo JPEGs. Initial Play follows the displayed playlist order; shuffle requires its named action. Stop & close is explicit. Native volume shares the existing generation/mutation safeguards and does not manufacture playback state.
- Latest hosted arm64 run: **239 cases executed, 237 passed, 2 skipped, zero failures**. Four added UI tests cover actual SwiftUI geometry at seven sizes/states, demo artwork/fallback, retained WKWebView/generation/selection across resize/Focus, and volume admission without invented playback. The two existing skips remain the same. Tests use in-memory synthetic data, fresh preference suites and static bundled-image HTML in the actual WKWebView; no login, real library, live audio or YouTube playback was used.
- First independent Sol 6.1 review: **8.2/10**. Fixed its four findings: short-window video aspect, compact Queue/Shuffle discovery, misleading initial Play/shuffle behavior and unlabeled Stop/close. Added belowfold captures. The initially white test WK region was a fixture-origin rejection, fixed by using the genuine allowed app base URL; production navigation safeguards were unchanged. The first rating is retained, not overwritten. Follow-up review and source-bound evidence are recorded in [UI rework evidence](../evidence/native-ui-rework/README.md).
- Second independent Sol 6.1 review: **8.8/10**. Reduced vertical navigation/card/transport spacing in short windows and Stage to give the 16:9 video more room. Corrected the measurement export to retain the initial asserted geometry and label additional scrolled geometry separately. Neither finding was dismissed or counted as a pass before correction.
- Third independent Sol 6.1 review: **9.0/10**, meeting the requested visual-similarity threshold. No remaining visual blocker was identified; minor differences remain in desktop inset, queue density and shortcut-button width. After the final layout-only changes, **all four UI tests passed again** with a fresh arm64 build. [Validation manifest and hashes](../evidence/native-ui-rework/validation.json), [final review](../evidence/native-ui-rework/review-3.json) and [actual native captures](../evidence/native-ui-rework/README.md#retained-evidence) retain the evidence. This does not close manual or release gates.
- A fresh `run-ui-fixture.sh` build/launch of the redesigned checkout succeeded; the fixture process was observed. The new disposable directory is `tubeshuffle-ui.xCiSUvPbBU` under the Mac's temporary root. [Launch evidence](../evidence/native-ui-rework/demo-launch.json) records the full path and hashes. No playback was initiated by the agent. The new demo is ready for the owner's grouped check; no manual pass is inferred from launching it.

These rendering checks and reviews establish a bounded visual result, not owner approval, OS interaction, audio reliability, signed Keychain behavior or YouTube policy compliance. No existing libraries or browser profiles were opened, and no deployment/migration occurred.

#### Local delivery preparation — 2026-11-05

The owner requested confirmation of continued browser use, configuration and final delivery preparation. The website and native application coexist with separate local stores; JSON transfer is explicit and the account cloud scope remains links/IDs only. No browser profile or real library was opened. A fresh anonymous public check reached the canonical homepage at `https://www.tubeshuffle.online` (**200**), but `GET /api/playlist-links` returned **503**. This is partial reachability, not full production acceptance or proof that the storage changes have been deployed.

The existing Vercel CLI credential was invalid and the first private replacement-token request was declined. The owner subsequently requested another private card and supplied a working Vercel token. The initial GET-only inspection confirmed the correct project/domains and production at `e168bd5`. At that checkpoint, both the project and deployed environment lacked `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `OWNER_USER_ID`, `APP_ORIGIN` and `CSRF_HMAC_SECRET`; the missing account configuration explains the guard's 503. Only the two existing YouTube variables were configured. [Initial read-only Vercel audit](../evidence/native-delivery/vercel-readonly-audit.json). The global CLI credential was not overwritten. The subsequent Supabase inspection and Vercel additions below supersede that configuration checkpoint. There is no verified local Developer ID signing identity.

- Added explicit public setup JSON load/save to the account form. Loading validates and fills the form without configuring services, reading Keychain or signing in. Exactly five fields, version 1, HTTPS origins, publishable-key validation and an 8 KB bound apply; duplicate/unknown fields and credential fields are rejected. Export uses no-clobber writing. Manual entry remains available.
- `macos/scripts/prepare-local-delivery.py` runs the full hosted suite and Release build in a fresh ignored directory, checks unchanged native sources, signs its own copy ad hoc and verifies entitlements/arm64/signature. It packages launchers, instructions, source/binary hashes and a ZIP checksum. It does not install, deploy, notarize or replace an existing candidate.
- Final candidate: **242 XCTest cases executed; 240 passed, 2 existing skips, zero failures**. Release build, ad-hoc signature, exact entitlements, ZIP integrity/checksum and all 85 native source hashes verified. Six offline account-build checks passed. The three added tests cover setup round-trip/no automatic account activation, strict malformed/oversized rejection and preserving the form on failure.
- The guarded browser harness passed all **13** outcomes again with native IndexedDB/localStorage in disposable Incognito iframe realms. The earlier two-tab concurrency run remains separately attributed; it was not rerun for this package. The standalone native local-library process/lock/reopen probe also passed. Neither establishes crash durability, Safari behavior or real-data safety.
- Limited actual GUI observations on the first delivery candidate: Library/Done, Focus/Stage and explicit Exit Stage actions worked; resizing was accepted; the public synthetic queue reached a displayed **Playing** state, showed progress, survived minimize/restore requests, and **Stop & close** removed the player. This does not prove audible audio, two natural transitions or hidden playback. Hide returned false; keyboard event delivery through the automation was not established. The export panel wrote a synthetic JSON with one playlist/six occurrences/zero history. The automation initially put an absolute path in the filename field; macOS treated the separators as filename characters in Documents. That exact new fixture file was preserved inside the rehearsal directory and its accidental duplicate removed. No existing file was replaced. Full UI create/import/reopen remains unvalidated; model/process tests are separate evidence.

[Delivery evidence, package and remaining checks](../evidence/native-delivery/README.md), [local delivery instructions](../../macos/README.md#local-delivery-and-browser-coexistence). The package is a **local candidate**, not a notarized or policy-approved release. The existing 9.0/10 Sol 6.1 rating remains visual evidence; it is not account, audio or delivery approval.

**Supabase configuration follow-up:** after repeated private cards ended, a request held open through token submission succeeded. GET reads verified the expected active TubeShuffle project, Google enabled, one modern publishable key, web callback listed, native callback absent, and Site URL still localhost. The Data API excludes `private`. Five fixed read-only SQL queries inspected the existing single owner pin and catalog ACL/role/function/policy metadata, without reading playlist rows or Auth users. Both installed RPC bodies exactly match the corrected migration; permissions, policy expression shape and stored function references match the intended configuration. An initial textual policy comparison missed PostgreSQL's omitted visible-schema prefix; the corrected comparison and initial result are separately recorded. No policy was changed. Live JWT/RLS, indirect memberships and concurrency are not established by these reads. [Sanitized audit](../evidence/native-delivery/supabase-readonly-audit.json).

The public native setup JSON is prepared adjacent to the delivery ZIP. Private configuration values stay outside the repository and ZIP. The exact remaining Supabase change is to set Site URL to the canonical HTTPS website and append the native callback, preserving both existing redirect URLs. Applying that requires Project Settings/Auth Config Read-write access; the supplied token was requested for inspection. The additional private write-access request timed out without a response, so no Supabase mutation was attempted. These changes do not require a new project, paid plan, resource, schema change or owner-pin rewrite; the current billing plan itself was not verified through the available scope.

**Vercel configuration applied, no deploy:** under the owner's configuration request, the five absent production variables were added individually with `upsert=false` after rechecking the project, existing owner pin and publishable key. Each creation returned HTTP 201. Read-back verified the five IDs/types/production targets and unchanged metadata for both existing YouTube variables. Owner/CSRF are sensitive; origins/publishable key are encrypted. Preview/development were unchanged. The production deployment ID and `e168bd5` commit remained unchanged, so the current deployment still lacks the new values and the newer browser storage protection. [Sanitized configuration result](../evidence/native-delivery/configuration-apply.json). No real-library access, login, SQL mutation, migration or deployment occurred. Live account acceptance, the grouped Mac result and YouTube policy remain open.

#### Next acceptance gates — grouped, without repeating the old P0 request

**Owner rehearsal update:** the owner ran `./macos/scripts/run-ui-fixture.sh` and supplied its successful shell output for temporary directory `tubeshuffle-ui.NEWwD9f6cz` (reported 21 seconds). The agent read that run's `build.log` and verified `BUILD SUCCEEDED`. [Build artifact evidence](../evidence/native-ui-fixture-build-NEWwD9f6cz.json) records the log and binary hashes. The subsequent screenshots/layout rejection and qualitative playback report are recorded above. No transfer/reopening result or detailed keyboard/restoration result has been supplied.

1. **Owner UI rehearsal:** build/open a fresh demo of the reworked checkout with the same script and use the revised [macos/README.md](../../macos/README.md#one-grouped-ui-rehearsal). It opens an in-memory demo, isolates preference keys in a fresh suite and disables account access for that run. For transfer/reopen checks, create files only inside its printed temporary directory. Group observations into one block; mark untried steps as not tested. Automated layout evidence does not replace the owner's judgment or actual audio/OS behavior. The earlier “sim funciona sempre” and later qualitative report remain attributed to their own runs.
2. **Account/API acceptance:** separately configure/review the exact native callback and owner-only Supabase Free/API deployment, then authorize a bounded live test. No current callback allowance is assumed; the prior diagnostic allowance was reported removed. Keep configuration/key entry local, never paste credentials in a result block. Before authorization, tests remain mocked. No automatic paid plan or service keepalive.
3. **Data and release:** real-library access, any schema/migration action, rollout and release each require review, evidence and separate permission. SwiftData has no asserted physical no-migration guarantee merely from the marker/header check; do not open real stores on that assumption. Ambiguous merge/continuity remains unsupported. YouTube background/autoplay policy is still a release gate even if the technical UI rehearsal passes. No stream extraction, identity/visibility spoofing, hidden keepalive or transcript feature was added.

#### Earlier checkpoints retained as historical evidence

The initial Phase 2 run passed 11 scenarios plus two tabs but **observed defects**: auto-creation, cached closed handles, missing schema preflight and partial IDB/localStorage effects. It did not validate production protection. The next history-boundary run passed 13 scenarios after moving completed-ID lookup inside the facade, still before full wiring. Their raw evidence remains [initial](../evidence/browser-storage-phase2-2026-11-05.json), [history boundary](../evidence/browser-storage-history-boundary-2026-11-05.json) and [first integrated run](../evidence/browser-storage-integrated-2026-11-05.json). The final integrated evidence above supersedes those implementation descriptions. Correction to the initial audit: browser export/disclosure UI already existed at `e168bd5`; that audit's claim that it was absent was incorrect.

`npm ci --ignore-scripts` preserved dependency manifests and reported 37 audit findings (1 low, 18 moderate, 14 high, 4 critical); no dependency remediation or release-security claim. Node 26.5.0's native webstorage caused 41 early test failures; propagating `--no-experimental-webstorage` via `NODE_OPTIONS` to Vitest workers yielded the then-current 455 passes/2 skips. Later added regression cases produce the final 461/2 above. The initial default Mac destination attempted x86_64 with arm64 package modules; the explicit arm64 command succeeded. These were environment/command findings, not new platform-support claims.

**Owner playback confirmation received:** after clarification that “transições” means automatic changes between songs, the owner replied **“sim funciona sempre”**. In context this is their qualitative report of working playback/advancement with the app visible, minimized and Cmd+H-hidden. Exact transition counts, durations, event/error traces, restoration details and binary fingerprint were not supplied. The request named `e168bd5` and native source was unchanged at that earlier checkpoint; this does not authenticate the running binary. The report permits incremental development under the owner's continuation instruction. It does not erase historical failures, prove universal reliability or resolve YouTube policy. Native source has since changed for library/player integration, covered by the new grouped UI rehearsal above.

### Historical evidence — 2026-11-03

- The owner reported successful Mac `xcodebuild` test runs at `4517340` and `8880af3`. At `ca96cb0`, a diagnostic live login reached a callback with an empty fragment, the exchange succeeded, and the UI showed Signed in. The owner confirmed removal of the temporary native callback allowlist entry. This is diagnostic evidence, not release authorization.
- The owner reported Mac Xcode tests at `e03c0e5`: 170 tests, one skipped, zero failures. For a separately approved temporary diagnostic, one synthetic owner link was created manually via SQL after an owner-zero precondition; this bypassed the app RPC and RLS. The private diagnostic authenticated the owner and a distinct second account: the selected owner row was visible to the owner and hidden from the second account. The owner confirmed successful execution of the exact fixture cleanup SQL and removal of local files and the temporary callback allowlist entry.
- Local synthetic auth tests passed: 38 unit and 6 integration. In isolated PostgreSQL 16, `owner_links` SQL tests including the claims matrix passed; concurrency tests passed for same and different IDs at 4,999 and for rollback/retry.
- Today's authorized GET-only live probe observed an anonymous permission-denied response, an inconclusive invalid-bearer result, and a private-schema exposure error response. All results are inconclusive without an independent positive control for the key, route, and project.
- The two-account result is one read observation, not proof of general RLS or security, Google's current provider, token expiry or forgery handling, write denial, deployment, policy compliance, or import safety. The earlier probe remains inconclusive; real JWT validation, live release security, production deployment, background playback, and safe native import remain unestablished. Existing security, history/transfer, and YouTube policy gates remain open.

**Chosen direction:** a genuinely native SwiftUI application under `macos/`, sharing authenticated Vercel data APIs with the existing website. Use a WKWebView-based official YouTube embedded player only for video playback—not for the application interface.

**Original first-delivery gate (historical; current continuation above): isolated playback prototype.** Background listening is a near-essential user requirement. Prove ordinary minimized/hidden-window playback on the owner's Mac before investing in authentication, storage, or polished UI. Full implementation remains blocked on a subsequent explicit go/no-go decision covering both observed behavior and the unresolved YouTube policy conflict.

The owner has explicitly authorized building and running this isolated personal-use POC despite the disclosed policy conflict. That authorization is recorded risk acceptance for a diagnostic experiment in `docs/production-restrictions.md`; it is **not** YouTube permission, **not** a legal determination, and **not** release approval.

User decisions recorded:

- Beautiful native Mac interface; not a repackaged website.
- Personal use, with the owner's Mac and Xcode available for testing.
- Google sign-in, restricted to the owner initially.
- Account saves **playlist links/YouTube playlist IDs only**.
- Playlist contents, queue, playback history, and preferences remain local.
- Explicit browser export/native import; no automatic full-library synchronization.
- Online-only playback is acceptable; no downloads or offline media.
- Browser local database: an absent database must **not** be auto-created. Offer a separate, explicit one-shot confirmation before creation; absence is not user consent and does not prove first use. This decision is now integrated locally and fixture-tested; production rollout remains unapproved.
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

## Discovery: original planning-time integration points

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
- Default import is a previewed merge with verified occurrence continuity or explicit evidence-backed user confirmation; equal IDs alone do not establish continuity. Repeated imports are idempotent only when mappings remain safe; identical records are ignored, missing records added, conflicting records remain unchanged with an explicit summary. Preserve intentional repeated occurrences with different IDs.
- Omit/report orphan history without silently attaching it to unrelated videos. Invalid input must not partially replace the existing library.
- Native export produces the same portable format. Browser restore/import can be a later addition; browser export and native import/export are required initially.

### Completion events, export scope, and journal experiment — 2026-11-04

- **Owner decision.** Suggestion- and unknown-provenance completion events may remain browser-local and be excluded from the current transfer export temporarily. The export/UI must clearly disclose that omission rather than imply completeness. Existing play history must not be deleted or rewritten. This is a temporary scope decision, not a final schema or retention policy.
- **Inert fact module.** Commit `43c29f7` adds a pure, immutable playback-completion contract with no store, network, player, repository, history, or app wiring. It validates and copies caller input but proves no playback occurrence, lineage, or exactly-once behavior.
- **Disposable journal experiment (experimental/inert).** `src/lib/storage/disposable-completion-journal.ts` and `tests/browser/completion-journal-guard.*` write unresolved assertion rows through a caller-owned IndexedDB handle. There is no app, production schema, or history integration. The test-name prefix is only a guard, not proof of disposability. The native-IndexedDB browser guard uses a fresh loopback origin, ephemeral Chrome profile, and runtime-unique fixture names with observed `oldVersion 0` creation. Local Linux validation (not owner Mac) reported the isolated guard run twice, both `ok` with 25 outcomes: runtime-unique synthetic databases were created only after observed `oldVersion 0`, the temporary profile was cleaned up, and no application database was opened. Browser controls remain best-effort, not an OS firewall. No production protection or durability is claimed.
- **Inert playback attempt model (experimental/inert).** `src/lib/media/playback-attempts.ts` is an in-memory caller-recognized attempt state machine with no player, storage, journal, repository, or network integration. Only an explicit `ended` signal with an asserted matching attempt ID can produce or reuse a fact; inferred transitions and unassociated events remain unresolved. The caller's assertion can be wrong, and a stale event may be accepted if mislabeled. No exactly-once, proven attribution, lineage, or persistence is claimed; state is bounded to one active and one completed attempt and is lost on reload.
- **Native test-only upgrade rehearsal (experimental).** `tests/browser/journal-upgrade-guard.ts` with `JOURNAL_GUARD_MODE=upgrade` models an additive v1→v2 `completionJournal` upgrade using native IndexedDB on four runtime-unique synthetic databases in a fresh loopback/ephemeral Chromium profile. It uses a representative synthetic v1 schema and rows, including an orphan history row and schema-version marker. Scenarios cover cooperative versionchange, blocked open with late success closed, deliberate abort with retry, and disposal of a pending opener. Reported local Chromium validation (not owner Mac) produced 5 outcomes. This is not the production database/version/open path or an open-cache migration; it does not cover production cache retry, real tabs, Safari, export, or real history. Fixture cleanup remains best-effort, browser controls are not an OS firewall, and the cleanup fault helper is a focused self-check rather than end-to-end cleanup proof.
- **Production schema upgrade unresolved.** The journal writer still neither opens, creates, upgrades, nor migrates a database. The test-only v1→v2 rehearsal does not establish a production schema version, upgrade, or migration path for `completionJournal`.
- **Production blocked-tab behavior unresolved.** The test-only rehearsal models one real blocker and closes a late success, but production cross-tab open/upgrade/delete handling, cache retry, and real-tab behavior remain unimplemented and untested.
- **Incarnation proof unresolved.** Issuance authority is a module-instance `WeakMap`; clones, other realms, and reloaded module instances must reissue. There is no durable tab/process incarnation, retry, or exactly-once proof, and equal IDs alone do not establish continuity.
- **Export disclosure unresolved.** The agreed temporary omission of suggestion/unknown completion events from export has not been implemented or verified in user-facing disclosure.
- **Local failure unresolved.** Journal writes may reject, including an indeterminate completion after a queued add commits. App-level retry, reconciliation, and history projection behavior are absent.
- **Old history unresolved.** This experiment does not delete, rewrite, backfill, or reconcile existing history. The journal guard checks that a synthetic pre-existing row stays unchanged, and the upgrade rehearsal preserves a synthetic orphan row; old-history continuity and real-data behavior remain open.

### Browser storage provisioning — Phase 1 status, 2026-11-05

- **Owner decision (recorded 2026-11-04).** An absent local database must **not** be auto-created. The app must offer a separate, explicit one-shot confirmation before creation. A missing observation is not user consent and does not prove first use. This is an owner decision, not an implemented integration: the **current production opener still auto-creates on absence** until an approved integration replaces it.
- **Inert target-bound coordinator.** `src/lib/storage/browser-provisioning.ts` binds an immutable target `{ name, version }` at construction. Existing-only opens abort unexpected upgrades; only a confirmed missing observation makes the caller `eligibleForConfirmation`; `confirmCreateOnce` consumes that eligibility once. Target mismatches, unreadable results, failed closes, unsupervised/uncertain outcomes, and unexpected terminal errors after schema code latch `indeterminate`. A blocked drain or `existing-found` requires an explicit `checkExistingAgain` before another ordinary request. A committed creation is validated before `created` is reported. The module has no application import or production wiring and writes no metadata.
- **Synthetic evidence.** The test lane reports 42 local native-Chromium synthetic scenarios across 45 runtime-unique fixture names passing against this coordinator. The run uses native IndexedDB in a disposable Chromium profile, a loopback server, an exact fixture-name allowlist, runtime-unique fixture names, and no `deleteDatabase`; it does not open `tubeshuffle_local` or touch real user data. A focused, owner-authorized review of the schema-rollback evidence found no remaining blocker. The rollback claim is limited to the synthetic schema transaction; it does not prove callback side effects outside that transaction. These are local Linux Chromium results, not owner-Mac evidence.
- **Explicit non-claims.** No real database was tested. No production wiring exists. There is no actual first-use detection, backup, cross-tab coordination or data preservation, production migration, crash recovery, or durability guarantee. The inert coordinator is not release-ready storage.
- **Next gates (not implemented).**
  - Integrate existing-only startup and the explicit one-shot confirmation; remove the production opener's automatic-create path only in that approved integration.
  - Review and approve the metadata-initializer policy; any metadata write must be explicit, guarded, and transactional, with the same uncertainty and validation rules.
  - Design the versionchange UI/generation contract and the paused/blocked/uncertain UX, including user disclosure. Pull-only `getStatus()` is insufficient for production.
  - Resolve production migration and old-tab behavior: schema versioning, stale/blocked tabs, rollback uncertainty, and preservation of existing history.
  - Add exact tests against the production shared code with unique isolated databases. The synthetic test-only guard and local Chromium runner are not production coverage.

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

These are the original requirements and ownership scopes. Use the current status above for implementation/evidence; old future-tense notes here are not a fresh audit. No phase is implemented by saving this document. `ship` should read this file, preserve completed gates, and delegate only the authorized phase.

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

P1 contract artifacts live in `shared/contracts/` and portable JSON vectors in `shared/fixtures/`. Existing handler examples are explicitly separate from proposed owner API and transfer v1. The proposed merge specifies stable-ID reconciliation, orphan omission/reporting and atomic transactions; neither an importer nor transactional behavior is implemented by these vectors. Existing browser video keys are composite and duplicate YouTube occurrences overwritten by IndexedDB cannot be recovered. Local delete can leave orphan history; cloud unlink is distinct. Shuffle vectors use specified injected draws and occurrence identities; Swift parity remains unverified. P1 does not resolve P0 hidden/minimized playback or YouTube policy questions.

P1 transfer integration gate: all matched occurrences, including equal legacy composite IDs and cross-device copies, require verified continuity or an explicit evidence-backed user mapping; V1 supplies no trusted provenance by default; ambiguous history stays unmapped with non-destructive recovery. Both clients must consume the transfer and sync vectors. Before shipping transfer, every destructive refresh route, including re-import of an existing playlist, must atomically preserve/remap occurrence and history references or be blocked without writes; current browser sync does not meet this requirement. IndexedDB optional own `undefined` maps to wire absence before validation; null and malformed values remain errors. These are proposed requirements, not implemented behavior.

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


### Updated controls and direct-WKWebView Mac session — 95e614a: technical NO-GO for P1

**Scope/environment.** Started clean on `t3/macos-app` at `95e614af5ddd9f361e40d3ecb5f7d6855ead8b79`. macOS 27.0.1 (`26A434`), Xcode 26.6 (`17F113`), Swift 6.3.3, macOS SDK 26.5, Apple Silicon, Europe/Lisbon; evidence UTC. Both executables use actual bundle ID `com.tubeshuffle.playbacklab`, ad-hoc signing, sandbox and outgoing network entitlement. Native package remains YouTubePlayerKit 2.0.5 / `1ae827573024ab13dd6adea33b25d3eef6ff667c`. Both use the revised six-ID fixture recorded above. No implementation or dependency changes were made during this test session; the two playback binaries were run separately, never concurrently.

**Build/state checks.** Native arm64 build passed using the README's `ONLY_ACTIVE_ARCH=YES` command. `sh macos/Comparison/build.sh /tmp/tubeshuffle-comparison-95e614a` passed. The documented updated standalone state checks passed. Comparison `QueueState.swift` matches `03856f5` byte-for-byte; that snapshot's matching earlier standalone checks also passed. These checks do not prove AppKit, iframe, progress or MediaPlayer behavior.

**Evidence.** [Sanitized event log](../evidence/native-macos-p0-95e614a-2026-10-28.log) includes native controls/lifecycle events, each comparison run, navigation probes and aborted network attempts. Native Accessibility reads every five seconds copied the existing log without restoring windows or sending player commands. Raw temporary records/build outputs remain in `/tmp/tubeshuffle-p0-95e614a/`. Native acceptance sequences are complete through foreground #487, minimized #489 and hidden #490; missing Playing observations are not capture-rollover gaps. Repetitive progress records are omitted from the durable log. Audio is owner-observed, not inferred from counters.

| Untouched natural-transition run (UTC) | Updated native wrapper | Unmodified direct WKWebView |
| --- | --- | --- |
| Foreground | 16:37:33 Playing; natural 1→2 at 16:39:07; item-2 Ended at 16:39:27 received then ignored. Owner heard both items then silence. No item 3. **FAIL**, totals requested/accepted/natural-observed **1/1/0**. No window-state change in this interval. | Natural 1→2 at 16:55:00 and 2→3 at 16:55:19–20 both delivered ended → accepted load → playing. Owner heard all three videos and both automatic transitions. **PASS for this run**, totals **2/2/2**. |
| Minimized | Playing 16:40:05, minimized 16:40:08. Natural 1→2 at 16:41:39; item-2 Ended 16:41:59 received then ignored. Owner confirmed first transition then silence. **FAIL**, **1/1/0**. Progress continued on item 1 while minimized. | Playing 16:56:42, minimized 16:57:07. Natural 1→2 at 16:58:16–17, 2→3 at 16:58:36–37. Owner confirmed both were audible while minimized. **PASS for this run**, **2/2/2**. |
| Actual Cmd+H | Playing and owner-confirmed visible audio 16:43:38; hidden 16:43:54. Natural 1→2 at 16:45:12; item-2 Ended 16:45:32 received then ignored. Owner confirmed first transition then silence. **FAIL**, **1/1/0**. | Playing 17:02:17.115, hidden 17:02:17.747. Natural 1→2 at 17:03:51–52, 2→3 at 17:04:10–11. Both complete event sequences, **2/2/2**, no restoration/seek/manual load in interval. **Callback check passes; final owner audio confirmation pending.** |

Across the three native acceptance runs, **no Playing was observed for item 2 at the wrapper's native event boundary**; its later Ended was received and explicitly rejected by queue logic because the gate was unarmed. This does **not** establish that YouTube never emitted Playing: JavaScript emission and bridge transport were not independently recorded. No duplicate natural load was observed in these intervals. Direct state messages contained Playing for each next occurrence and its copied gate advanced twice. Callback frame/origin validation and counters still cannot authenticate occurrence identity or exclude every stale/forged callback.

| Native control/recovery check | Observation and limits |
| --- | --- |
| Progress and native Play/Pause/Next | Initial slider enabled and elapsed advanced while Playing. Manual Next started item 3; native Pause stopped audible playback; `0:04 / 3:33` observed. After a load with missing Playing, position/duration could remain `0:00 / 0:00` despite audio. A subsequent Play/Pause cycle restored positive duration (`22:23` on item 4). |
| Seeking | Accessibility value action moved to `0:30`; owner mouse drag settled near `1:00`. Owner separately confirmed macOS Control Center scrubber, then embedded YouTube scrubber; the native display followed both. Accepted seek commands logged. These occurrences were excluded from natural results. Automated AX keyboard focus failed (`-10006`); keyboard and VoiceOver seeking are not validated. |
| Physical media keys | Owner confirmed Play/Pause resumes and Next advances. Previous does nothing; there is no previous-track handler in this prototype. Routing observations do not establish behavior for every keyboard or competing app. |
| Control Center | Owner saw expected last-accepted fixture entry and confirmed audible Play/Pause, Next from item 4→5 and seeking. Last-accepted title is diagnostic metadata, not verified video identity; missing callbacks can make state/progress stale. |
| Competing media app | A locally generated quiet test tone was played in QuickTime; no media was downloaded. With QuickTime active, physical Play/Pause paused its tone while TubeShuffle continued. With TubeShuffle active, it paused TubeShuffle while the tone continued. Owner confirmed both. Only the generated document was closed; unrelated documents were untouched. |
| Close/reopen and restart | Two owner Close/Quit actions were confirmed as owner actions, not diagnosed crashes. No TubeShuffle crash report found. Relaunch recovered initial playback and controls; physical routing and Control Center seek worked after restart. A controlled native AXCloseButton press also ended the process, followed by successful fresh launch. The queue defect recurred after relaunch, so restart is not a lasting fix. Direct Close and Quit logged termination and ended their processes. Control Center entry removal immediately after close was not independently verified. |
| Unavailable/end of queue | Owner confirmed item 6 displays Video unavailable, is silent, and disables Next. Native log had accepted load, buffering (3), Unstarted (-1), zero progress; no numeric iframe error. Do not relabel this as 100/101/150/153. |
| Stalls/watchdogs | Natural queue stalls reproduced above. No runtime progress/seek/mutation watchdog timeout or Quit-to-recover state was captured. Watchdog state seams passed standalone checks; their actual timed UI recovery remains unverified. |

**Excluded preparations.** Initial foreground attempt briefly minimized, and a later restart received five manual Next requests within 18 seconds; both are excluded from clean acceptance. An early Cmd+H attempt hid before playback was established and emitted `onAutoplayBlocked` at 16:42:35; it is not a hidden natural-transition result. The first direct hidden preparation remained visible while audio confirmation was pending and advanced once; it was paused/closed and excluded. The final direct hidden run above is fresh, unmodified, and starts Playing before actual hiding. An accidental close during the first Control Center seek attempt made that attempt inconclusive; the later successful seek was separately confirmed.

**Comparison startup/navigation/minimum size.** A separate temporary copy of the comparison source added only finite navigation/geometry probes, run 16:52:20–44 with no playback. Initial iframeReady/ready messages passed the existing strict validation; initial document allowance was closed. At content size 480×360, measured viewport and iframe were **480×328 CSS pixels**. Reload, same-origin query replacement, fragment navigation and external top-level replacement each logged main-frame navigation blocked; original URL remained unchanged. Popup evaluation returned false, with one visible window and no popup-policy log: no popup was created, but the delegate's popup branch was not established. Validation was not relaxed. After the unmodified foreground playback run, the minimum outer frame measured 480×392 points; owner confirmed the whole video/YouTube controls were visible, unobscured and usable for Pause/Play. CSS dimensions came from the separate probe, not inference from native points. A sandbox-extension stderr warning appeared on comparison launch but did not prevent ready, playback or probes.

**Offline/reconnect — skipped at owner's direction.** Two CLI disconnect attempts failed verification: default route and public iframe-API HEAD still succeeded, so the harness issued **no Next** and restored the settings. A transient restoration check lacked connectivity; a later check confirmed route/HEAD 200. Wi-Fi-only power setting was verified; Ethernet route removal remained unreliable. The owner explicitly requested skipping internet-connection testing rather than a physical disconnect. Neither updated player's offline-load/reconnect recovery was tested. Earlier-commit results are not reused as 95e614a results. No further network-disconnect attempts were made.

**Technical recommendation: NO-GO for P1/full application work; continue only bounded P0 investigation.** Native queue advancement failed in clean foreground, minimized and hidden runs despite working transport/system controls. Direct comparison delivered two transitions in each state, with final hidden audio confirmation still pending. This narrows the investigation but does **not** identify the hidden-playback cause: bridge transport, callback subscriptions, player options/timing, progress polling and coordinator safeguards differ. Next proposed step is to align those settings and add sanitized real JavaScript-event-emission versus native-receipt evidence before choosing a wrapper fix or transport replacement. Keep the queue guard intact; no speculative guard removal, identity/visibility spoofing, keepalives or stream extraction.

**Limits/policy decision.** Actual outgoing HTTP Referer remains unverified; no numeric 153 was captured. WebKit/app update behavior, broad media-key ownership, keyboard/VoiceOver seeking and actual sleep/wake recovery are not established. These are diagnostic observations, not support promises. YouTube restrictions remain unresolved and release-blocking; owner authorization and technical success are **not YouTube permission, compliance, or release approval**. No P1, backend, authentication, storage, sync or polished-UI work began. Both players, the navigation probe and the log collector are stopped; the generated QuickTime document is closed and original Wi-Fi On/Ethernet Enabled settings are restored. Results and sanitized logs are included in this handoff commit.

### Experimental local store lifecycle probe — 486038b → f73200a (test-only)

**Owner Mac evidence — 2026-11-04.** The owner reported the standalone process lifecycle probe passing all cases at commit `486038b`: create/hold with a contender denied, then exit/reap and a separate-process reopen; SIGKILL release followed by reopen; a preflight failure retaining the lock; a deterministic failure injected immediately after container assignment retaining the lock, with an incomplete reopen rejected; and an incomplete fixture rejected.

**Final clean run — f73200a.** After removing the temporary root-validation diagnostic, the owner reported the same five lifecycle scenarios passing on the clean commit `f73200a`. Only the standalone helper was compiled; no full Xcode test suite was run. This is probe-level evidence for those exact commits only.

**Bounded scope and open gates.**

- The store boundary is test-only and experimental: it is outside the application target and has no static production entry point, application-support path or app caller. Probe cases use local synthetic fixtures under the fixed canonical private-tmp base. No real user data and no import are involved.
- These results do not establish physical read-only operation, migration-free opening of an existing store, database/file integrity, or durability across power loss or crashes. Same-user adversarial or noncooperative writers are out of scope.
- The snapshot reader remains unbounded and not actor-confined.
- Full Xcode test runs for the new store boundary, including negative-path Swift behavioral XCTest coverage, are not established. These probe results do not extend to later commits, uncommitted changes or later phases, and imply no production readiness or release approval.

### Owner-reported full Xcode scheme success — e6d6584 (2026-11-04)

- **Attributed evidence.** The owner reported `** TEST SUCCEEDED **` after a `git pull` for `e6d6584` and the full Xcode scheme command from the prior conversation. This is a full-scheme success report only. The new scalar-exact snapshot equality and compact scanner tests were intended to be part of that scheme, but individual test execution, passing, count, and skip status were not supplied; no claim is made that those specific tests ran or passed. Exact node-stride values were not provided, so no measured memory saving is claimed.
- **Host/network limit.** The Xcode suite is hosted by the app, and the owner reports that hosted app can load YouTube. This does not establish network isolation for the test suite, and no such claim is made.
- **Still unresolved.** The scanner's total memory bound, occurrence/history continuity, production storage/migration, and real-data import remain open. This owner-reported pass does not close those gates or imply production readiness, policy compliance, or release approval.

### Owner-reported full Xcode scheme success — 7f2dfb6 (2026-11-04)

- **Attributed evidence.** The owner reported `** TEST SUCCEEDED **` after a full Xcode scheme test on pulled `7f2dfb6`, which contains the scanner object-stack commit `070427b`. This is a full-scheme success report only. Individual test execution, passing, count, and skip status were not supplied; no claim is made that specific new tests ran or passed. Node-stride output was not supplied, so no measured memory saving or safety bound is claimed.
- **Host/network limit.** The Xcode suite is hosted by the app, and the owner reports that the test host may load YouTube. This does not establish network isolation for the test suite, and no such claim is made.
- **Still unresolved.** Scanner total memory/resource bound, occurrence/history continuity, production storage/migration, and real-data import remain open. This owner-reported pass does not imply production readiness, policy compliance, or release approval.
