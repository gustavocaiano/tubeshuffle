# Local delivery — 2026-11-05

**Prepared for local evaluation; production delivery is not complete.** The checkout is based on `051bb26`, with the setup-document and packaging additions uncommitted. The browser and native app coexist. Five missing Vercel production variables are now saved for a future deployment; the running deployment is unchanged. No real library was accessed. Supabase Auth changes and live account acceptance remain pending.

## Candidate

- [Apple Silicon ZIP](../../../build/tubeshuffle-delivery-_fcy8y2w/TubeShuffle-local-arm64.zip)
- [SHA256SUMS](../../../build/tubeshuffle-delivery-_fcy8y2w/SHA256SUMS)
- [Build/source manifest](build-info.json) and [validation record](validation.json)
- [Preparation script](../../../macos/scripts/prepare-local-delivery.py) and [instructions](../../../macos/README.md#local-delivery-and-browser-coexistence)

ZIP SHA-256: `5ed4db807b059e46e13bfc134a09c9b8c57b816f25db9ca894fcabaa74c2d16d`.

Requires macOS 14+ and Apple Silicon. Extract and keep **TubeShuffle Local** together. **Open Demo.command** starts an in-memory demo with account access disabled; **Open TubeShuffle.command** starts the ordinary app without opening a library or signing in. For transfer checks use only a new disposable folder. The ZIP is an ignored local artifact, not a downloadable hosted release or a committed binary. The script creates a fresh package for another checkout; it never reuses or overwrites this candidate.

This copy is ad-hoc signed with the source sandbox/file-selection/network entitlements. Signature verification, architecture, ZIP integrity/checksum and 85 native source hashes passed. There is no Developer ID identity, notarization, installation or public release approval. Do not disable Gatekeeper globally.

## Evidence and limits

| Area | Observed result | Limit |
| --- | --- | --- |
| Native suite | 242 executed, **240 passed**, 2 existing skips, 0 failures | Synthetic transport, credentials, player callbacks and disposable stores; not live OAuth or audible audio |
| Native build | Debug suite and Release build passed; source hashes unchanged during build | Local arm64 candidate; real signed Keychain behavior unverified |
| Account setup | 3 new tests; 6 offline build/config checks passed | Load only fills the form; services remain unconfigured until explicit action |
| Browser startup | [13 outcomes passed](browser-storage.json), real IndexedDB/localStorage in disposable Incognito iframe realms | Earlier separate two-tab run remains historical; no real profile, Safari, durability or production rollout claim |
| Local library process probe | Standalone transactional import/no-overwrite, lock contention and reopen probe reported `ok` | A separate process/model result; raw log was not retained; no crash-durability claim |
| Public website | [Homepage 200, anonymous playlist-links API 503](public-web-probe.json) | Public reachability only; account service is not usable in this observation |
| Visual similarity | [Independent Sol 6.1 review: 9.0/10](../native-ui-rework/README.md) | Prior source/capture review of the retained listening UI, not release approval |

The two skipped tests remain `CooperativeFileLockTests.testProcessDeathReleasesLock` and `LocalLibraryStoreTests.testSuccessfulExistingStoreReopenRequiresSeparateProcess`. The separate probe does not turn a skip into a pass. Prior web regression evidence (461 passed, 2 skipped; six synthetic HTTP tests) remains tied to the unchanged web code and was not counted as a new run.

The first candidate's actual GUI accepted Library/Done, Focus/Stage/Exit Stage and resizing. **Shuffle & listen** reached a displayed `Playing` state and changing progress in the synthetic queue. Minimize/unminimize requests were accepted; the following view still showed `Playing`. **Stop & close** removed the player. [Raw own-window accessibility observation](player-ax.json), [control observations](player-controls.json). Neither player labels nor command acceptance proves audible output, natural queue advancement or hidden playback. The hide request returned false. Keyboard event delivery was not established; Escape did not leave Stage through this automation. These points require the owner's grouped check.

The export panel produced valid synthetic JSON: one playlist, six occurrences, zero history, with the omission notice shown. The automation put an absolute path in the filename field; macOS treated its separators as filename characters and wrote the new fixture under Documents. Only that exact newly created file was moved into the disposable rehearsal area, checking identical bytes and preserving all existing files. Full GUI new-library/import/reopen/queue validation was **not completed**. The model/process tests are not substituted for it.

The final candidate separately launched the demo and exposed six queue rows. Its precise smoke-test observations and any automation limitations are in `validation.json`. Test-owned application instances were closed; prior user application instances were left alone.

## Configuration and remaining gates

The browser retains IndexedDB/localStorage and the native app uses separate SwiftData/queue files. JSON transfer copies supported records into a fresh empty library; it does not synchronize content or transfer queue/preferences. Orphan history omissions are disclosed and source history is preserved. Suggestion events and inactive completion journals are also outside this export. No occurrence continuity is inferred.

The public API returned 503. The existing Vercel token was invalid and the first private replacement request was declined. The owner then requested another private card and provided a working token. The initial [GET-only audit](vercel-readonly-audit.json) confirmed the `tubeshuffle` project, its verified domains and the deployed `e168bd5` commit. At that checkpoint, both the project and deployed environment lacked all five account variables below. The deployed guard explicitly returns 503 for missing Supabase URL/key or owner pin. The initial audit logged no variable values and made no remote changes. The token is outside the repository, and the global CLI credential was not replaced.

The [subsequent configuration result](configuration-apply.json) records five successful creations (HTTP 201), with read-back of IDs/types/targets and preservation of existing variable metadata. Under the owner's configuration request, each variable was added only after confirming absence, with `upsert=false`. No existing value was overwritten. These are project settings for a **future production deployment**, not active configuration in the current deployment:

| Variable | Target/value source | Current state |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production; verified project `rkgbxjwmnlsmguhctguf` | Saved; encrypted |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Production; that same project's verified modern publishable key | Saved; encrypted; no service-role key |
| `OWNER_USER_ID` | Production; exact existing `private.approved_owner` pin, rechecked before creation | Saved; sensitive; pin unchanged |
| `APP_ORIGIN` | Production; `https://www.tubeshuffle.online` | Saved; encrypted; canonical domain verified |
| `CSRF_HMAC_SECRET` | Production; new server-only random secret, 32 bytes encoded as hex | Saved; sensitive |

`YOUTUBE_API_KEY` and `NEXT_PUBLIC_YOUTUBE_API_MODE` were preserved; their values were not read. Preview/development were unchanged. The production deployment ID and `e168bd5` commit remained unchanged after the additions. Existing deployments do not acquire newly saved variables; see [Vercel's environment-variable documentation](https://vercel.com/docs/environment-variables). No new runtime account pass is claimed. The browser storage protection is implemented/tested locally but **not deployed** in the observed production commit.

### Supabase read-only follow-up

The private token request succeeded when the agent kept the turn active while the owner supplied it. The [Supabase audit](supabase-readonly-audit.json) confirms project `TubeShuffle`, ref `rkgbxjwmnlsmguhctguf`, status `ACTIVE_HEALTHY`. Google is enabled. One modern publishable key and exactly one existing valid owner pin were read; neither was logged or committed. Five fixed SQL reads inspected only pin configuration and system catalog metadata through the read-only endpoint; no playlist rows or Auth user records were queried.

The Data API exposes `public` and `graphql_public`, not `private`. Catalog metadata shows RLS enabled on playlist links, anonymous DML denied, authenticated direct INSERT/UPDATE denied, and private owner-table access denied to those app roles. Both RPCs are security definers owned by the non-login/non-inheriting/non-bypass executor, with an empty search path and no anonymous execution. These are configuration observations, not live JWT/RLS, indirect-membership or concurrency acceptance.

Both installed RPC bodies exactly match the corrected migration. The four policies have the expected roles, commands and expression shape; stored dependencies resolve the owner predicates to `auth.uid` and `public.is_approved_owner`. The initial text comparison falsely expected an explicit `public.` prefix in PostgreSQL's displayed predicate. A follow-up checked the exact displayed form and stored dependencies; no policy/schema repair was made. The initial comparison and its correction remain separately recorded.

The web callback is already listed. The native callback is absent, and the fallback Site URL is still `http://localhost:3000`. After the read-only audit, the Vercel additions above were applied. A separate preflight re-read the existing owner pin and publishable key before creating them. The remaining prepared Supabase changes are:

- Set Supabase Site URL to `https://www.tubeshuffle.online`.
- Append `com.tubeshuffle.playbacklab://auth/callback` while preserving both existing redirect URLs. Do not change Google credentials, database records, schemas, roles, plans or resources.

The Supabase write requires **Project Settings** and **Auth Config**, both **Read-write**; the supplied token was requested for read-only inspection. See the [official endpoint permissions](https://supabase.com/docs/reference/api/v1-update-auth-service-config). The additional private write-access request timed out without a response. No Supabase mutation was attempted, and expiry was not treated as authorization. Deployment remains a separate step requiring the owner's explicit authorization.

The [public native setup JSON](../../../build/tubeshuffle-delivery-_fcy8y2w/TubeShuffle-account-setup.json) is prepared beside the ZIP, not inside it. It contains only the two HTTPS origins and publishable key, with SHA-256 `ac6813b24393c3628fe0134715dc03d7302aef439f115d8b71ae625788c2c472`. Load it explicitly through the ordinary app's Account form; demo mode disables Account. Loading it is not sign-in or operational acceptance: the native callback/server configuration and live owner test remain pending. Private owner/CSRF proposal values remain outside the repository and package.

Native account setup now supports explicit public JSON load/save, with strict format/version/field/origin/key and 8 KB validation. It carries only service origins and a publishable key; login/session/owner/server credentials have no fields. The [example format](../../../macos/README.md#local-delivery-and-browser-coexistence) contains placeholders and is not an operational configuration. Supabase Free remains the only plan; only playlist links/IDs belong in the cloud.

Before full acceptance:

1. Return one [grouped Mac result](../../../macos/README.md#one-grouped-ui-rehearsal) covering keyboard/layout, audible playback/advancement/window restoration and GUI export/create/import/reopen/queue. Use only synthetic data and mark untried steps as not tested.
2. Supply the scoped Auth configuration access through a private credential request to apply the two exact Supabase settings above, then review and separately authorize deployment. Project environment/catalog inspection is complete within the documented read scope; callback activation and live Google/PKCE/API/RLS acceptance remain pending. No production SQL or repair is proposed.
3. Complete live account/Keychain/security checks and the YouTube policy review, then separately authorize distribution/rollout. Successful playback does not resolve the policy gate.

No real library/profile, automatic repair, destructive schema change, migration, paid service, stream extraction, identity/visibility override, hidden keepalive or transcript feature was used or added.
