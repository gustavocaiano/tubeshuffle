# Native YouTube playlist import — 2026-11-07

The latest local package is the [simplified Library UI candidate](../native-library-menu-2026-11-07/README.md). It moves management controls into Library and removes the Try demo entries; the evidence below remains attributed to its earlier candidate.

The owner's link-import request is implemented locally on `0b72b84` with uncommitted changes. The browser/backend, existing user changes, previous candidates and real libraries were preserved. The normal app is open at the import sheet; no library or account session was selected automatically. The public TubeShuffle configuration was explicitly selected during the GUI smoke check, without invoking login or resume.

## Result and verification

- **Import playlist / Cmd+L** is available in navigation, the welcome screen and Library. The link stays filled through local-library selection and account setup; failures leave the dialog open. Fixture mode explains its account restriction and offers **Open TubeShuffle** for a separate ordinary instance.
- **Use TubeShuffle** selects the bundled public origins/publishable key. Google sign-in or saved-session resume is separate. Custom setup remains in Advanced settings. No private token, owner pin, credential or library data is in the resource.
- Playlist IDs and supported YouTube URLs with `list=` are accepted. Single-video/channel URLs, foreign hosts, credentials/ports, duplicate query IDs and encoded trailing newlines are rejected. The app sends the extracted ID to its configured authenticated API, not to an arbitrary input URL.
- Imports require an explicit local library and signed-in account. Duplicate playlists are blocked before a fetch; repeated video IDs retain distinct occurrence IDs; existing history/content is preserved. Failed, mismatched and stale-generation responses do not write. Partial-count warnings remain explicit. Cloud ID saves remain separate actions.
- **249 tests executed: 247 passed, two pre-existing skips, zero failures.** Added tests exercise URL formats/rejection, missing-library/demo/account gates, duplicate/history preservation, failed/stale responses, partial counts, explicit public setup loading and five actual 448-point dialog renders. The full run also covers the existing 15 initial player layouts, two scrolled captures and retained-player/zoom checks. [Validation](validation.json), [dialog measurements](import-measurements.json), [player measurements](layout-measurements.json), [captures](captures).
- Release arm64 build, ad-hoc signature/entitlements, ZIP integrity/checksum and **89 source hashes** verified. Packaged public setup matches the source bytes and contains only the five permitted fields. [Build manifest](build-info.json).
- Independent **Sol 6.1 review: 9.0/10, no blocking finding**. Minor suggestions remain for the narrow plus button, account maintenance controls and error emphasis. Review used source/static native captures and the test log; it did not run live OAuth/API/audio or establish release approval. [Full review](review-1.json).
- Native accessibility smoke checks on the packaged app confirmed navigation/Library entry into import, retention of a synthetic URL after cancellation/reopening, missing-library gates and the separate Google sign-in button after explicit public setup. [GUI result](gui-smoke.json), [actions](gui-actions.jsonl).

The initial rendering fixture used default directory permissions, and the store correctly rejected it. The test fixture was corrected to `0700` without changing the store gate. A first account capture exposed inconsistent default button rendering; the account screen now shares the native dark background/button style. The GUI helper initially found duplicate import labels under a modal and stopped; scoping helper actions to the active AXSheet resolved the ambiguity. Neither helper issue is presented as a product pass.

## Local candidate

- [TubeShuffle.app](../../../build/tubeshuffle-delivery-3qmmbdsx/TubeShuffle%20Local/TubeShuffle.app)
- [Open TubeShuffle.command](../../../build/tubeshuffle-delivery-3qmmbdsx/TubeShuffle%20Local/Open%20TubeShuffle.command)
- [ZIP](../../../build/tubeshuffle-delivery-3qmmbdsx/TubeShuffle-local-arm64.zip)
- ZIP SHA-256: `a3e87a8de6954a27af7c10c9706a4e7ee1ba3d57fbd96aab8f59948bd0460ad7`

The app is a local Apple Silicon/macOS 14+ candidate, ad-hoc signed, not Developer ID signed or notarized. Previous candidates remain available. No push, merge, deploy, schema change, migration or remote configuration change occurred.

## Owner handoff and remaining limits

In the ordinary app, use **Import playlist**, paste a public playlist link, create a **new disposable library**, then **Connect → Sign in with Google → Done → Import playlist**. In a new app run, choose **Use TubeShuffle** first. The demo's **Open TubeShuffle** action is the way out of account-disabled fixture mode. Do not select an existing real library for acceptance checks.

Still **por validar**: file-panel create/open and return into the guided importer, account-sheet return within that flow, actual Google/PKCE callback and Keychain behavior, authenticated playlist API import, physical Cmd+L, and the earlier grouped audio/transfer/reopen checks. The synthetic import tests do not prove these external steps. The owner's overall positive UI feedback is qualitative, not a detailed acceptance block. Browser data is separate and unchanged. YouTube hidden/minimized playback policy and release/distribution gates remain open.
