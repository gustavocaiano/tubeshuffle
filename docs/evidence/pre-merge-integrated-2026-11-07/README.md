# Integrated review and merge checkpoint — 2026-11-07

The requested security, performance and bug review produced three fixes PRs, now merged into `t3/native-macos-app`. Combined validation passed at **`1dae52481e7d49e2c371b5ee819663867ada80bd`**. This evidence commit changes documentation only. Parent [PR #11](https://github.com/gustavocaiano/tubeshuffle/pull/11) is still open at this recorded checkpoint; its final head must have successful checks before merge. GitHub records the eventual merge rather than this pre-merge document predicting it.

The owner's request authorizes these reviewed code merges. Merging the parent triggers the existing automatic web deployment from `main`; no separate manual deployment is being initiated. Installer publication, production schema/repair work, access to real libraries and YouTube policy approval remain outside this authorization.

## Review coverage and disposition

Three independent initial reviews inspected native account/transport/WebKit security, native import/UI/player correctness and performance, and web/API/storage/dependency behavior. The parent additionally reviewed local store/transfer paths, reproduced production-adapter PKCE retries and measured storage performance. The scope includes the original parent diff and relevant unchanged integration code; several corrected bugs predated PR #11. No credential leak, owner-authorization bypass or arbitrary bridge JavaScript injection was established. That is a review result, not proof that all security defects are absent.

| Fix PR | Corrections and review |
| --- | --- |
| [#12 — native](https://github.com/gustavocaiano/tubeshuffle/pull/12) | Usable-session recovery after failed reads; one-shot PKCE exchange in the actual production adapter; bounded API response transport; exact icon/config validation; publication timestamp normalization; background conversion/queue calculation with stale-result fencing; compatible key and Smart-shuffle optimization; explicit system-media publication ownership. A separate independent fix review returned **Accept**, with no blocking finding. Root validated the hosted suite, disposable store/import probes and Release package. [Evidence](../pre-merge-native-2026-11-07/README.md). |
| [#13 — suggestions](https://github.com/gustavocaiano/tubeshuffle/pull/13) | Streamed request-byte enforcement, bounded UTF-8 client payloads, original storage-generation/cancellation ownership, full normalized cache fingerprints, bounded/expiring server caches and rate buckets. Root reviewed the production diff and regression tests before merge; no blocker found. [Evidence](../pre-merge-web-suggestions-2026-11-07/README.md). |
| [#14 — dependencies](https://github.com/gustavocaiano/tubeshuffle/pull/14) | Next **16.4.5**, Sharp **0.35.5**, PostCSS **8.5.23** and compatible affected runtime utilities. Root checked maintainer advisory ranges, resolved versions/integrities, runtime engines and the synthetic optimizer harness. The image allowlist, SVG denial and null installer manifest are preserved. [Evidence and residual tooling triage](../pre-merge-dependencies-2026-11-07/README.md). |

All three exact reviewed PR heads had successful Vercel/Preview Comments checks and were mergeable before integration. There were no remote blocking reviews. Independent native acceptance is a delegated review, not a GitHub approval fabricated on its behalf; the root's web/dependency reviews are recorded in PR comments. [Source commits and merge commits](validation.json).

## Combined verification

Fresh root checkout run on macOS arm64, Node 26.5.0/npm 12.0.2, after all three merges:

| Check | Result |
| --- | --- |
| Clean locked install | **Pass**, 812 packages; existing npm lifecycle policy retained. [Log](install.log). |
| Web regression suite | **536 passed / two existing skips / zero failures**, 26 test files. Includes the new suggestions cases with the updated dependencies. [Log](unit.log). |
| Synthetic HTTP API integration | **Six passed**, real local routes/SDK against simulated providers. [Log](integration.log). |
| Built image optimizer | **13 scenarios passed** (14 Node tests including the parent): PNG/JPEG/WebP/AVIF resizing, cache/304 behavior, disguised/padded SVG and invalid-image denial, unapproved source rejection. [Log](image-optimizer.log). |
| TypeScript | **Pass**, after generating the current build's route types. [Log](typecheck.log). |
| Lint | **Pass**, zero errors; two retained warnings: existing `_id` and the newly reported existing account callback effect. The latter is warning-only in that component, not disabled globally. [Log](lint.log). |
| Production build | **Pass**, Next 16.4.5/Turbopack. Local font CSS fixture; real font delivery/rendering is not tested by this build. [Log](build.log). |
| Fresh production dependency audit | **Zero findings**, exit 0. [Raw response](audit-production.log). This is neither an all-dependency audit nor a security guarantee. |
| Native input/package recheck | All **89 inputs** and the ZIP checksum still match the candidate tested at `34ae786`. Native suite: **262 executed / 260 passed / two existing skips / zero failures**, with Release/signature/package checks passed. The full native suite was not repeated for web/documentation changes. [Source-bound evidence](validation.json), [native results](../pre-merge-native-2026-11-07/README.md). |

Tests/build/optimizer received an allowlisted environment with the existing loopback network guard; the integration harness uses disposable files and simulated credentials/providers. No real library, browser profile, app window, Keychain login or production API was used in this combined run. The Node guard is defense in depth, not an OS firewall. Temporary synthetic image files were removed and the test servers closed. Package/advisory reads and authorized GitHub operations are separate from application testing.

Reproduce with `npm ci --no-audit --no-fund`, then `npm test`, `npm run lint`, `node --test tests/integration/p2-http.test.mjs`, the [guarded build/optimizer commands](../pre-merge-dependencies-2026-11-07/README.md#validation-and-environment), and `node node_modules/typescript/bin/tsc --noEmit`. Use only the documented synthetic environment. [Validation manifest](validation.json) records commands, outcomes, log hashes and the exact source/config Git objects; it does not include service credentials.

## Residual engineering work and release gates

- The full dependency review still reports **30 development-only package findings**: one low, 16 moderate, ten high and three critical. That audit was performed by the dependency task on the same final lockfile, not repeated or relabelled as clean by the parent. The affected tooling is not imported by the application; no untrusted test input, public Vitest/mocker endpoint or shadcn MCP service was exercised. The [complete triage](../pre-merge-dependencies-2026-11-07/README.md#audit-and-residual-tooling-gates) retains affected versions and prerequisites. Upgrade and validate those tooling chains before exposing them or processing untrusted inputs; absence of a demonstrated application exploit does not remove the advisories.
- SwiftData remains on MainActor. The 5,000-item synthetic queue-advance measurement improved from 3.667 s to 0.135 s, but this is a single-run comparison. Large-library scrolling, retained thumbnail memory, 50,000-item behavior and audible playback under load remain unmeasured. Pure cancelled work may finish in the background; stale results are fenced before publication/commit.
- Suggestions caches/rate limits remain process-local, and a write committed before generation invalidation cannot be rolled back. YouTube upstream deadlines, response bounds and cancellation across long playlist pagination remain further hardening work; no outage/quota-exhaustion claim is made.
- Browser startup/schema/localStorage and multiple-context results remain separately attributed to the earlier disposable-browser harness. This run adds synthetic suggestions-generation coverage; it does not rerun native IndexedDB/Safari or validate production data. `.slim/deepwork/browser-storage-provisioning/` is missing; context comes from tracked handoff/phase-2 plans and implementation, without crediting absent artifacts.
- Live Google/PKCE and signed-Keychain behavior, owner/non-owner JWT/RLS execution, physical UI/media keys, detailed Focus/minimize/Cmd+H audio/advancement and disposable GUI transfer/reopen remain acceptance gates. The owner's positive UI/playback feedback is qualitative evidence only. JSON remains unencrypted, excludes queue/preferences/suggestions/credentials/media, and discloses omitted orphan/ambiguous events without reconstructing history.
- Browser and native libraries remain separate. Supabase scope remains playlist links/IDs on the existing Free-only design. No paid resource, production schema change, automatic repair or real-data access is introduced.
- The installer manifest remains **null**. The native ZIP is a local arm64 ad-hoc candidate, not a Developer ID-signed/notarized release. YouTube policy and hidden/minimized playback approval remain unresolved even if functional tests pass. Installer publication and rollout require their own reviewed evidence and authorization.
