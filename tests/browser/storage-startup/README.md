# Phase 2: real browser storage startup on disposable fixtures

This harness now exercises the **integrated storage session and provisioning coordinator** with the production source graph and only a test target substitution. Missing startup must abort creation; a separate explicit confirmation is required. Earlier evidence files describe the pre-integration defects and remain historical.

Run `node tests/browser/storage-startup/serve.mjs`. It prints a random loopback URL after all build gates pass. Open that URL only in a disposable/Incognito profile. In T3, select `profileId: "incognito"` explicitly when opening a new preview tab; never reuse a user's application tab. Run `await window.runStorageIntegration()` in that tab. The result contains thirteen outcomes, source hashes and traces. Record it before closing the tab. A repeat needs a new server run/URL and disposable context.

The server serves in-memory bundles only, binds to literal IPv4 loopback, checks the peer address, uses a random route prefix, and stops on SIGINT/SIGTERM/SIGHUP or after fifteen minutes. Close all fixture tabs and stop the server when finished. It does not start the application, launch a browser, remove profile directories or call `deleteDatabase`. Profile lifetime/disposal is owned by the browser host; closing a tab does **not** establish physical profile deletion. No production profile is used in the recorded run.

## Target substitution

`browser-db.ts` imports/re-exports its unchanged name/version from the two-constant `browser-db-target.ts`. Only the test build uses an esbuild plugin to resolve that exact leaf to a virtual module. The plugin checks the import spelling, importing file and real resolved path. It never replaces the opener, schema function, facade, metadata initializer, exporter, playlist repository or provisioning coordinator. There is no runtime target switch in application code.

Every run first builds the same entry without the plugin and checks that the production target remains present. That baseline bundle is never served. The substituted bundles must contain the real application modules and virtual leaf, contain no production target, and have no external imports. An uninstalled guard prevents execution of the application bundle. See esbuild's [plugin resolution documentation](https://esbuild.github.io/plugins/#on-resolve) and [metafile documentation](https://esbuild.github.io/api/#metafile).

## Isolation and coverage

- Exact runtime-unique name allowlists in each realm; production and legacy names denied before native open. All `deleteDatabase` calls denied, including fixtures. Only versions 1/2 are accepted; v2 is used solely for synthetic lifecycle tests, not a proposed application version.
- Blocking bootstrap before application code on each page and iframe. Workers and network APIs blocked; CSP disables connections/workers and permits same-origin scripts/frames. This is not an OS firewall or protection against hostile same-user code. Native IndexedDB events are real; the localStorage denial faults are injected.
- localStorage method/property guards and exact key allowlist. The root refuses a nonempty localStorage origin without reading values. A synthetic unrelated sentinel and **all** allowlisted keys are checked after each scenario. Schema/index descriptions and library/history rows are compared independently of metadata/marker effects.
- Thirteen scenarios: guard negative controls; absent startup; preserved records/metadata; legacy signal; injected localStorage read/write failures; incomplete same-version schema; generation invalidation on versionchange; concurrent application confirmations; blocked coordinator drain; real exporter initialization/omission; repository history lookup/preservation; injected abort after history request success. Each has two independent module realms in same-origin iframes.
- The negative-control scenario deliberately attempts denied production/legacy opens, deletion, unknown storage access, `clear` and `fetch`, in both realms. Its counters must be exactly seven denials/one delete attempt/one network attempt per realm, with **zero native opens**. All other scenarios require zero denials/deletes/network attempts. Do not summarize these as “zero attempts” across the entire run.
- New fixture seeding checks exact name, version, `oldVersion === 0`, and live upgrade transaction before any schema or row write. The representative fixture schema is **not** a production validator. The application schema remains v1. Session/generation and confirmation integration live in the application modules, not in this independent seeder.

## Additional two-tab check

The server also provides `<printed-url>realm/tabs/index.html`. Open it in two new tabs using the **same disposable profile**, with no application tab involved. Both export `fixture` and its guard. The recorded check used these steps, via preview evaluation:

1. In each tab call `fixture.storage.listLocalPlaylists()`; expect `missing`, no records or metadata writes and eligibility for a separate confirmation.
2. Schedule `fixture.storage.confirmBrowserStorageCreation()` in both tabs for the same future timestamp. Expect one application `ready` and one `recheck-required`. Explicitly call `recheckBrowserStorage()` on the latter. No claim of simultaneous CPU execution: these are overlapping independently scheduled native requests.
3. In tab A hold `window.syntheticBlocker = await fixture.rawBlocker()`. It is a deliberately uncooperative fixture connection, not the app session.
4. In tab B use `window.drainCoordinator = fixture.coordinator(2)`; `openExisting()` rejects `blocked` and remains `draining`. Both **application** sessions should close cooperatively and invalidate their generations on versionchange.
5. Close `syntheticBlocker` in A. Wait boundedly in B for `fixture.guard.pending() === 0`; the isolated v2 coordinator requires a recheck, and its late upgrade is aborted. Recheck the application sessions explicitly; `snapshot()` must still show v1, original schema and unchanged rows/meta.
6. Record state/traces, close handles with `fixture.guard.close()`, verify no pending requests or unexpected/deletion/network attempts, then close both tabs. Record these extra checks separately from the root suite.

This checks two actual tabs as well as iframe realms, but not separate browser processes, Safari, crash recovery, physical durability, storage eviction or any real library. It does not prove every possible cross-tab ordering or acceptance against real libraries. UI/query subscription behavior has separate RTL tests; the harness is not a full Next.js-page or Safari UI test.
