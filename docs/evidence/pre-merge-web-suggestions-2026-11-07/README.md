# Pre-merge web suggestions fixes — 2026-11-07

Implemented in the isolated `t3/web-suggestions-hardening` checkout starting at `e9bf84b87def0ec2251473dd988cbab061b7fa1a`, the reviewed head of [PR #11](https://github.com/gustavocaiano/tubeshuffle/pull/11). The fixes PR targets **`t3/native-macos-app`**, not `main`; the parent owns integration and merging.

Tested implementation commits:

- `b867b7ba770913fdd2c70b7fb8b2af5ea59351d8` — bounded requests, shared input policy, full fingerprints, bounded server state and route tests.
- `26959c795906866a310b30be847cffbebe52dc2d` — generation/cancellation ownership, browser payload/cache wiring and component/storage tests.

The evidence commits add only this report, measurements, source hashes and check logs. Native sources, the shared native plan, dependency manifests and lockfile are unchanged.

## Findings resolved

1. **Actual request bytes.** Suggestions now use the same extracted bounded stream reader as playlist links. The route rejects actual bodies larger than **128,000 bytes** before UTF-8 decoding/JSON parsing, even without or with misleading `Content-Length`. Declared oversize remains an early rejection. Invalid UTF-8 is rejected. Owner authorization still precedes body reads, cache access and upstream quota consumption. Dates must be real, canonical `YYYY-MM-DD` values; an omitted date keeps the existing UTC fallback. Every supplied exclusion must be an 11-character YouTube ID; invalid or excessive exclusions fail rather than silently disappear.
2. **Storage ownership.** Metadata facade methods accept an optional originating generation while preserving their safe defaults. Suggestions pass that generation through cache and refresh-marker reads/writes. Requests observe abort signals and the real storage subscription; they check ownership after asynchronous boundaries. UI/query scopes include the generation, day, playlist and complete normalized payload. Unmount/input changes cancel refreshes, and success checks ownership before publishing. A deferred response after invalidate/recheck cannot write into the new generation or populate its query/refresh state. The once/day marker is read within the guarded request, alongside the cache, rather than an independent mount effect. Missing storage still requires separate explicit creation.
3. **Payload budget.** Client and server share metadata caps (40 seeds; title/channel/description/tag/category limits), exclusion validation and normalization. Browser serialization measures actual JSON UTF-8 bytes against **100 KiB**, below the unchanged server limit. It removes descriptions, then tags, then trailing seeds as needed, preserving at least one seed and every exclusion. IDs are deduplicated and sorted. Up to **5,005 unique exclusions** are admitted: all 5,000 supported playlist videos plus the previous five suggestions for Again. More than that fails explicitly. This is an additive server allowance; native sources/contracts were not edited.
4. **Complete cache identity.** SHA-256 covers all normalized server inputs, including playlist title, every seed field, seed order, the entire canonical exclusion set, day, playlist identity and refresh token. Algorithm/cache version is now 3. Browser queries use the complete canonical base payload, and persisted records require its SHA-256 fingerprint. A successful Again replaces that base input's daily result, with its separately stored once/day marker. Legacy cache records are ignored, not migrated or deleted.
5. **Bounded process state.** The server result cache holds at most **256 entries**, evicts expired entries and then the oldest insertion at capacity. Rate state holds at most **1,024 hashed client keys**, preserving the existing **30 requests/hour** limit. Expired counters are evicted even on cache hits. A full live rate map refuses a new client key with 429 rather than evicting a live quota counter. No service, cloud history or durable quota store was introduced.

## Validation

All requests and data in these checks are synthetic. Tests import the actual source modules; reviewer source-copy probes were not used as implementation replacements or as acceptance tests.

| Command | Final result | Evidence |
| --- | --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage npm test` | **536 passed, 2 existing skips, 0 failures** across 26 files | [web-tests.log](web-tests.log) |
| `node --test tests/integration/p2-http.test.mjs` | **6 passed, 0 failures** | [http-integration.log](http-integration.log) |
| `npx tsc --noEmit` | Passed | [typecheck.log](typecheck.log) |
| `npm run lint` | Passed; existing unused `_id` warning in `playlist-store.ts:76` | [lint.log](lint.log) |
| `npm run build` | Passed; Next.js 16.2.9 production build | [build.log](build.log) |
| `git diff --check` | Passed | Recorded at commit preparation |

Captured logs initially tripped the whitespace check; trailing whitespace and terminal blank lines were normalized without changing their results. The final diff check passes.

Node was `v26.5.0`; dependencies were installed from the existing lockfile using `npm ci --ignore-scripts --no-audit --no-fund`. The Node webstorage flag avoids the host's experimental storage implementation in Vitest. No dependency patch or audit clearance is claimed.

**59 new tests:** 44 real-route cases, 3 fake-clock/cardinality cases against the production server-state class, and 12 component/storage cases. Existing quota-guard tests now also verify the real guard rejects requests without reading their bodies. Existing playlist-link tests verify the extracted reader retains that route's 4 KiB behavior.

- Route cases cover 300,204-byte streamed bodies with absent/low/invalid/negative/high declared lengths; exact 128,000-byte acceptance and next-byte rejection; Unicode byte counting across chunks; canonical/leap dates; malformed IDs and UTF-8; 5,000/5,005 exclusions; cache hits/misses for equal endpoint/count lists with a different middle ID, every seed field and playlist title; hourly rate and daily cache expiry.
- RTL cases render the actual `DailySuggestions` with TanStack Query and import the actual metadata facade, initializer, storage session and provisioning coordinator. Only the native IndexedDB API is replaced by an in-memory event/transaction fixture, with an exact synthetic name allowlist; the test target leaf is substituted. Fetch is stubbed and rejects external URLs. Cases cover missing/no-create, stale reads/writes, transaction invalidation, deferred query/refresh after recheck, unmount cancellation, successful refresh/remount, changed inputs and a 5,000-video Unicode payload.
- The existing HTTP harness runs copied current application sources and real SDK/route code in a disposable loopback Next instance against simulated Auth/PostgREST/YouTube providers. Its existing network guard redirects/blocklists requests; it is not an OS firewall or live-provider/security test. No application browser window was opened.

[Measured serialized payload sizes](payload-sizes.json) were obtained by importing the committed input policy directly with Node. All cases retain 5,000 IDs initially and 5,005 on refresh. The ASCII case is 84,827 bytes; Unicode is 100,027 bytes; a heavy JSON-escaping case is 102,399 bytes and retains 33 seeds. All fit 102,400 bytes and are covered by route acceptance tests. Refresh also fits the budget. [Source manifest](source-manifest.json) binds the evidence to the tested files.

**Intermediate failures, resolved:** the first cold typecheck lacked Next-generated image declarations for the existing macOS preview import; the production build generated the declarations and subsequent standalone typechecking passed. Two new test-fixture type errors (`addedAt` on `LocalVideo` and a missing suggestion `query`) were corrected. The new deferred-refresh test initially failed because a mount-time marker read could occur while recheck still held its control gate; moving that read into the guarded request resolved it. These earlier failures are not counted as passes. Final logs above cover the corrected implementation.

## Limits and handoff

- These tests do not establish native IndexedDB behavior/durability, Safari/cross-tab scheduling, real profiles, real libraries, live OAuth/RLS, YouTube relevance or production quota behavior. The two existing native-IDB tests remain skipped in jsdom. No live browser/native app windows, production requests, login, migrations, schema changes, configuration mutations, deployments or releases were performed by this task.
- Generation invalidation cannot undo a transaction that already committed before invalidation; existing storage semantics preserve that distinction. No automatic write replay or database creation was added. A refresh cache write and its once/day marker are separate transactions, as before.
- Cache/quota state is process-local, lost on process restart and not shared across deployment instances. Header-based client identity and cache-hit quota behavior are unchanged. Capacity is an in-process bound, not a durable global quota guarantee.
- Metadata reduction can reduce suggestion specificity for very large payloads; preserving all exclusion IDs takes priority. Local historical cache rows are not deleted or migrated.
- The parent handles review and merging. Nothing here authorizes installer publication, release or YouTube policy acceptance.
