# Post-merge acceptance preparation — 2026-11-06

**Production deployment is now confirmed. Native owner acceptance is still pending.** This checkpoint supersedes the earlier statements that the merge/deployment and production account configuration were pending; it does not turn previous manual gaps into passes.

## Verified without changing production

| Area | Evidence | Limit |
| --- | --- | --- |
| GitHub | Owner `gustavocaiano` merged [PR #10](https://github.com/gustavocaiano/tubeshuffle/pull/10) at 15:54:23 UTC; merge `2bc341c0cfdb5ad593df9ed9fed17be039e2d5cc` | The agent did not merge, push or deploy |
| Code identity | Merge tree equals the clean checkout tree at `0b72b84`; all **88** candidate source inputs match | Documentation changes made after this observation are local |
| Production | Vercel deployment `dpl_2TzTbFWPc4GXB9A7C9RNDX5iLUQA`, **READY**, target production, merge commit, canonical aliases; GitHub Vercel status success | Build/deployment status is not live account or browser-library acceptance |
| Configuration | All five previously missing account environment keys are present in this deployment | Values were not printed or retained |
| Anonymous HTTP | Homepage **200**, dashboard **200**, playlist-links API **401** | Server requests only, no browser profile/IndexedDB opened; 401 establishes the unauthenticated guard, not OAuth/RLS success |
| Supabase | GET Auth configuration **200**: canonical Site URL, native callback allowed, Google enabled | No login, user records, SQL or configuration mutation |
| Local package | ZIP integrity/hash, public setup hash and copied app signature verified | Existing ad-hoc candidate; no notarization or distribution approval |

The previous **241 passed / 2 skipped / 0 failures** native suite remains attributable to the exact matching source manifest. It was not rerun because implementation and packaging inputs were unchanged. The two skips remain skips. Web/backend files also have no changes between the earlier reviewed integration and this native refinement. The production source includes the integrated browser storage protection; no production browser-profile test was performed.

GitHub returned no inline review findings or formal reviews on PR #10. Its earlier automated code review covers `051bb26`; it is not a security review or approval of the latest native commit. The separate Sol 6.1 visual review remains scoped to its recorded UI source/captures.

## Actual GUI attempt

A copy of the verified app was opened with `--ui-fixture` in a new private rehearsal directory. The precise app path/PID was checked before each accessibility operation. Account access was disabled; no playback was started. Existing app instances were preserved.

The **Export library** menu action opened the real macOS save panel. Its notice correctly stated zero orphan events and exclusion of queue, preferences, suggestions, credentials and media. The owner's screenshot showed this same panel, still targeting Documents.

Synthetic Cmd+Shift+G events reported successful posting but did **not** open Go to Folder. Posting directly to the fixture PID and expanding the panel did not establish navigation either. The agent cancelled before saving. **No export, import, new library, queue persistence or GUI reopening pass is claimed from this attempt.** This is a limitation of the observed automation; it does not establish that the physical shortcut or app is broken. No real library was selected or opened.

[Status and hashes](status.json), [bounded GUI actions](gui-actions.jsonl), [relevant save-panel controls](export-panel-controls.json). Unrelated filesystem row labels are not retained in this evidence.

## Owner handoff

The synthetic demo is left open. Use **`/tmp/tubeshuffle-final-kqdl_21i`** for all export/create/import files; it contains only a rehearsal instruction file initially. In the save panel use **Cmd+Shift+G** to navigate there and enter only `demo.json` in Save As. Create a **new child folder** for the disposable library, rather than choosing this already-existing parent as a new library.

Return one block using the [prepared result template](owner-results-template.txt): UI/physical shortcuts; audible playback/advancement/Focus/window restoration; GUI transfer and saved queue reopening. Mark anything not performed **por validar**. Create the queue after import: JSON does not transfer it. Resume must preserve order/selection and wait for Play. Do not select a real library or sign in during this demo rehearsal.

The [verified public setup file](../../../build/tubeshuffle-delivery-szvj8h5e/TubeShuffle-account-setup.json) is ready for the later, separately authorized account test in the ordinary app. Live Google/PKCE/API/Keychain and access-control behavior remain unvalidated. No credentials belong in the results block. YouTube policy, real-data access and distribution remain separate gates.

No application code or remote configuration was changed in this continuation. The agent made no migration, repair, paid-resource change, login, real-library/profile access, playback action or deployment.
