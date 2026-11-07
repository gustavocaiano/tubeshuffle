# Pre-merge web dependency remediation — 2026-11-07

Base: `e9bf84b87def0ec2251473dd988cbab061b7fa1a`, isolated branch `t3/patch-runtime-dependencies`, for [PR #11](https://github.com/gustavocaiano/tubeshuffle/pull/11). The fixes PR targets **`t3/native-macos-app`**, not `main`; the parent handles integration and merging.

Implementation commit: `74f44d657f640d4d63aba95be6f4fa3d77a2c004`.

The production dependency audit is clean after a reproducible install. Next's actual image optimizer passed local HTTP tests with generated images, including SVG rejection. This is dependency and synthetic regression evidence, **not production, native, policy or release acceptance**. The full audit still reports **30 dev-only findings**; their paths and remaining gates are recorded below.

## Changes and resolved paths

The checkout initially had no `node_modules`. `npm ci --ignore-scripts --no-audit --no-fund` installed the original lock without changing it, and `npm ls` verified the baseline. [Original tree](tree-before.json), [original lock entries](lock-before.json), [final tree](tree-after.json), [registry metadata](registry-versions.json), [versions, engines and hashes](validation.json).

| Dependency path from the project | Installed before → after | Reason |
| --- | --- | --- |
| `next` | 16.2.9 → **16.4.5** | Patched stable release for the image-optimizer SVG rejection bypass and earlier Next advisories. Manifest minimum raised to `^16.4.5`. |
| `next → sharp` | 0.34.5 → **0.35.5** | Next 16.4.5 requests `^0.35.5` itself; no forced Sharp override or direct dependency. |
| `sharp → @img/sharp-* / @img/sharp-libvips-*` | 0.34.5 / 1.2.4 → **0.35.5 / 1.3.4** | Native binary families follow the patched Sharp dependency. Local arm64 binary reports **librsvg 2.63.2**, libvips 8.18.7. |
| `next → postcss` (also build tooling) | 8.5.15 → **8.5.23** | Raise the existing override; leaving it at 8.5.15 would force a vulnerable version even after upgrading Next. |
| `next → postcss → nanoid` | 3.3.13 → **3.3.20** | Compatible 3.x refresh of the audit-affected generator. |
| `next → postcss → source-map-js` | 1.2.1 → **1.2.2** | Compatible patched source-map parser. |
| `next → baseline-browser-mapping` | 2.9.19 → **2.11.35** | Compatible 2.x refresh past the invalid-input process-termination fix. |
| `eslint-config-next → @next/eslint-plugin-next` | 16.1.6 → **16.4.5** | Align framework tooling; its required TypeScript ESLint/React Hooks dependencies also move within their supported ranges. |

There is exactly one locked copy of each of Next, Sharp, PostCSS, nanoid, source-map-js and baseline-browser-mapping, at `node_modules/<name>`. `npm ls` exits 0. React/React DOM, Vitest, application/suggestions sources, native sources, the shared plan and `next.config.ts` are unchanged. `src/config/macos-release.json` remains byte-for-byte **`null\n`**. No installer was selected or published.

Only `package.json`, `package-lock.json`, a narrow ESLint compatibility entry and this evidence directory change. React Hooks 7.1 newly flags the existing one-shot `auth_result` state update in `AccountPanel.tsx:54`. The rule remains enabled, with **warning** severity only for that file, so the finding stays visible without changing sign-in behavior in this patch. Lint now reports that warning and the pre-existing unused `_id` warning. A later account-component refactor can remove the compatibility entry.

## Official advisory applicability

Maintainer advisories and npm registry metadata were checked on November 7, 2026. At that check the stable `latest` tags were Next **16.4.5** and Sharp **0.35.5**; no prerelease was selected.

| Primary advisory | Applicability and disposition |
| --- | --- |
| [Sharp GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) | Original installed Sharp 0.34.5 is in the affected `<0.35.5` range. The maintainer describes possible RCE on glibc Linux under specific runtime conditions and requires librsvg 2.63.2 for a global library. The local bundled library is now 2.63.2. The macOS run does not establish Linux exploitability or the deployed host's native libraries. |
| [Next GHSA-7qx7-33qx-rqx2](https://github.com/vercel/next.js/security/advisories/GHSA-7qx7-33qx-rqx2) | Original 16.2.9 falls in affected 16.0.0–16.4.4; patched at 16.4.5. The app enables remote image optimization for four hosts, with default SVG denial. This makes the optimizer relevant even though SVGs were intended to be denied. The advisory specifically discusses self-hosting; no hosting-specific immunity is assumed. Synthetic HTTP rejection cases pass on 16.4.5. |
| [Next GHSA-p3m5-59mp-jv5r](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r) | Version affected, but the documented prerequisite is an App Router Server Action. Source search found no `use server` actions; the application uses route handlers. No reachable Server Action path established. Upgrade also exceeds the 16.4.1 fix. |
| [Next GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) | Requires attacker-controlled SVG values passed into Node `next/og` ImageResponse. No `next/og` or ImageResponse usage found; no Edge runtime declarations found either. No affected image-generation route established. Upgrade exceeds 16.3.6. |
| [Vitest browser GHSA-p63j-vcc4-9vmv](https://github.com/vitest-dev/vitest/security/advisories/GHSA-p63j-vcc4-9vmv) | Applies to **`@vitest/browser`**, not merely a same-numbered `vitest` install. Browser package absent from both lock/install, no Browser Mode configuration; tests use jsdom. Optional peer metadata is not an installed dependency. The 3.2.7 browser patch exists, but this advisory alone does not justify changing the test runner. Other actual Vitest dependencies remain separately flagged below. |
| [PostCSS GHSA-fxqj-rqcc-2cmp](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp) | Affected through 8.5.22, fixed at 8.5.23. No application path accepting arbitrary CSS for server transformation was found; still present in the production graph, so the compatible override fix is applied. |

Additional production-graph patches follow the maintainers' [source-map-js 1.2.2 release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2), [nanoid 3.3.18 fix](https://github.com/ai/nanoid/releases/tag/3.3.18), and [baseline-browser-mapping 2.11.0 fix](https://github.com/web-platform-dx/baseline-browser-mapping/releases/tag/v2.11.0). Version matches do not prove application reachability: no direct application imports or attacker-controlled calls into these utility APIs were found.

The fresh npm audit includes older Next/Sharp findings as well. **GHSA-7qx7-33qx-rqx2 was absent from that audit response**, so a zero audit alone was not used to establish its remediation; the maintainer's range, installed version and synthetic optimizer checks were checked independently.

## Audit and residual tooling gates

- [Fresh audit before](audit-before.json): **37** package findings — 1 low, 18 moderate, 14 high, 4 critical. This is npm's package/metavulnerability count, not 37 independently exploitable application bugs.
- [Fresh production-only audit after](audit-production-after.json): **0**, exit 0.
- [Fresh full audit after](audit-after.json): **30** — 1 low, 16 moderate, 10 high, 3 critical; exit 1, honestly retained. Every reported node has `dev: true` in the final lock.
- [Complete residual triage](audit-triage.json) retains every name, installed path/version, advisory range/URL and npm recommendation. [Normalized npm explain paths](dev-paths-after.json) trace representative findings to their tooling roots.

| Remaining family | Reachability assessment and next gate |
| --- | --- |
| `vitest@3.2.6 → tinypool@1.1.1`, `@vitest/mocker@3.2.6`, `vite@7.3.5` | Dev-only, trusted jsdom tests here; no public test API, Browser Mode or standalone mocker/interceptor plugin configured. [Tinypool worker-options](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3) and [run-options](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr) advisories require a prototype-pollution chain, not demonstrated here. The [mocker redirect](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) and [manual-registration](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) advisories identify public plugin registration paths absent from this config. **Still vulnerable versions**, not cleared: migrate/validate tooling before admitting untrusted test code or exposing development services. |
| `shadcn@3.8.4 → @modelcontextprotocol/sdk → express → proxy-addr@2.0.7`, Hono/body-parser/qs, and generator utility chains | CLI/MCP/generation dependencies, not imported by the application. No shadcn CLI or MCP server started. `proxy-addr` is the third critical package finding; Vitest and tinypool account for the other two. Its trust-proxy use is not an app route. Review compatible CLI/transitive updates before running untrusted registries or operating these servers. |
| ESLint/TypeScript ESLint and generator parsers (`minimatch`, `brace-expansion`, `@humanfs/node`, `fast-uri`, `js-yaml`, `browserslist`, `postcss-selector-parser`, `zod`, `deepmerge`, etc.) | Dev-only input processing; this run uses checked-in source/configuration. Matching package ranges remain recorded, without a claim of universal non-exploitability. Evaluate these chains with the tooling upgrade; aligning ESLint config alone does not remove every transitive advisory. |

No `npm audit fix` was run. Its proposed graph-wide fixes include downgrading `shadcn` to 1.0.0 and Next's ESLint config to 15.5.29, or moving Vitest to 5.1.0. Those are not a reviewed compatibility plan. This patch deliberately closes the affected production graph and aligns framework tooling; **the remaining development graph is not represented as audit-clean or approved for untrusted use**.

## Validation and environment

macOS 27.0.1, arm64, Node **26.5.0**, npm **12.0.2**. Next and Sharp now both require Node **>=20.9.0**, preserving Next's existing production minimum. The updated ESLint visitor-keys transitive package requires `^20.19.0 || ^22.13.0 || >=24`; the existing Vite requires `^20.19.0 || >=22.12.0`. This machine satisfies those engines. Other Node versions and Linux binaries were not executed.

| Check | Result / evidence |
| --- | --- |
| `npm ci --no-audit --no-fund` from final lock | Pass, 812 installed packages. npm 12's existing lifecycle policy blocked esbuild/fsevents/msw/unrs-resolver scripts; no approvals or npm configuration changes. Required binaries worked in subsequent checks. [Log](install-after.log). |
| `npm test` | **477 passed, 2 existing skips**, 23 files. Node 26's experimental Web Storage disabled, matching established repo validation. [Log](tests.log). |
| `node --test tests/integration/p2-http.test.mjs` | **6 passed**, disposable Next/SDK routes and simulated providers, loopback only. [Log](integration.log). |
| `node node_modules/typescript/bin/tsc --noEmit` | Pass, exit 0. [Result](validation.json). |
| `npm run lint` | Pass, **0 errors / 2 warnings** described above. [Final log](lint.log), [initial new-plugin finding](lint-before-compatibility.log). |
| `npm run build` | Pass, **Next 16.4.5 / Turbopack**, all routes generated. Local font CSS fixture replaces Google Fonts fetching; actual font downloading/rendering untested. [Log](build.log), [fixture](font-responses.cjs). |
| Built `/_next/image` over private `127.0.0.1` HTTP | **13 scenarios / 14 Node tests including parent passed**. PNG/JPEG/WebP/AVIF decode and resize to 32×16 WebP; MISS→HIT and ETag 304; ordinary/mislabelled/XML/comment-disguised SVG denial; padded SVG and invalid-image denial; unapproved remote host denial. [Harness](image-optimizer-smoke.mjs), [log](image-optimizer.log). |
| Scope/integrity | `git diff --check` passed; no diff in native sources, app/suggestions sources, existing tests, shared plan, image configuration or null release manifest. Synthetic public directory removed and server closed. Hashes in [validation.json](validation.json). |

The first optimizer harness run had three assertion failures: Node fetch adds `no-cache` to conditional requests, and two error-text assertions expected “not” rather than “isn't”. The test now sets explicit `Cache-Control: max-age=0` for the 304 check and matches the observed rejection text. These were harness corrections; neither production behavior nor expected 400 rejection was relaxed. [Initial log](image-optimizer-initial.log) is retained.

Logs normalize the checkout prefix and trailing whitespace only; results and errors are retained.

Validation subprocesses received an allowlisted environment (`PATH`/`TMPDIR` plus the documented test flags), not inherited service configuration. The optimizer and build used the existing Node network guard; the integration harness supplies its own synthetic credentials/provider and guard. The guard is defense in depth, **not an OS firewall**. No browser/profile, real library, live app window, login, YouTube/Supabase/production API request, remote configuration mutation, migration, deployment or release was used. Public advisory/registry reads and the authorized Git/PR operations are separate from app validation.

Reproduce the bounded build and optimizer checks from the repository root after `npm ci`:

```sh
evidence="$PWD/docs/evidence/pre-merge-dependencies-2026-11-07"
guard="$PWD/tests/integration/network-guard.cjs"
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  NEXT_TELEMETRY_DISABLED=1 \
  NODE_OPTIONS="--no-experimental-webstorage --require=$guard" \
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$evidence/font-responses.cjs" \
  npm run build
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  NODE_OPTIONS="--no-experimental-webstorage --require=$guard" \
  node --test "$evidence/image-optimizer-smoke.mjs"
```

Residual acceptance: no deployed-platform/native-code exploit reproduction, remote CDN fetch/redirect/DNS integration, real OAuth/library/playback behavior, actual browser rendering, Linux/glibc native-binary execution or production deployment verification. The font fixture is build-only. Existing native acceptance, YouTube policy, signing/notarization and publication gates remain open; merge authorization supplies none of those approvals.
