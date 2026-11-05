# Native UI refinements — 2026-11-05

Implemented the owner's latest UI feedback on top of `413a226`, preserving the earlier candidate and existing changes. **Local evaluation is ready; integrated acceptance and release remain open.**

The owner said the interface was good overall, requested zoom/narrower windows/removal of Stop & close, then explicitly clarified: **“thumbnail só . o focus não deve ter vídeo . e a thumbnail deve ficar pequena”**. This feedback supersedes the earlier visible-video Focus design. It does not supply the missing detailed audio, keyboard or transfer results.

## Result

- **Focus:** one 80-point thumbnail with track information; no visible video. Artwork off also removes the image. AppKit genuinely hides the retained WKWebView; Video reveals the same instance. Switching presentation sends no player load/transport command and adds no visibility spoofing, extraction or keepalive.
- **Zoom:** Cmd+ / Cmd−, with Cmd0 to reset and Cmd= as another zoom-in shortcut; View-menu actions; bounded 80–125% local preference. A window-scoped monitor handles WebKit focus, excludes attached sheets and cleans up on teardown.
- **Narrow layout:** minimum 480 × 680 points, adapting navigation, headings, view/volume controls and sheets. Large zoom in a short window can require vertical scrolling; the tested layouts have no horizontal overflow.
- **Controls:** Stop & close removed. Closing the library/window or quitting still tears down playback. Error recovery offers Restart player, retains queue order/selection and waits for Play.

### Application icon follow-up

The owner then requested the web favicon in place of the generic Dock icon. The unchanged `public/favicon.svg` is now packaged as `AppIcon.icns` with ten standard/Retina representations from 16 to 1024 pixels, referenced by the app's Info.plist and copied by Xcode. The generator is `macos/scripts/generate-app-icon.mjs`; packaging verifies the resource and hashes its source SVG too.

The new candidate below includes that icon. The full suite again passed **241 tests with 2 skips and zero failures**; Release/signature/package verification passed and **88 recorded source files** matched. NSWorkspace's Finder icon and the running application's icon both returned the correct artwork, were visually inspected and were byte-identical. [Icon evidence](app-icon.json), [current build/source manifest](app-icon-build-info.json), [macOS icon appearance](app-icon-system.png). The new candidate was opened with `--ui-fixture`; no playback was initiated and existing instances were left alone. Swift application/player code was unchanged, and no new independent UI review is claimed for this asset addition.

## Verified

| Evidence | Result | Scope |
| --- | --- | --- |
| Targeted native UI tests | **5 passed**, 15 initial layouts plus 2 scrolled captures | Actual SwiftUI/WKWebView with bundled static images and synthetic events |
| Full hosted arm64 suite | **243 executed; 241 passed, 2 skipped, 0 failures** | Disposable stores, synthetic auth/player; no live account or audio proof |
| Focus and resize/zoom identity | Actual `isHidden`, restoration, 80-point artwork, unchanged WKWebView/generation/selected occurrence; no load call | Native rendering assertions; not audible playback |
| Keyboard and teardown | Synthetic Cmd+/Cmd=/Cmd+Shift+/Cmd−/Cmd0 with WKWebView focus, zoom bounds, modifier/sheet exclusion; actual hosted-window close clears player callbacks | Not a physical-keyboard or VoiceOver acceptance result |
| Release package | Build, ad-hoc signature, entitlements, arm64, ZIP integrity/checksum and **88 source hashes** verified after the icon addition | Local candidate; not Developer ID signed or notarized |
| Independent Sol 6.1 review | **9.0/10**, no blocking finding | Source/static captures, not independent live interaction or release approval |
| Updated demo | Fixture script build/launch succeeded; exact new bundle process observed | No autoplay, login or real library; existing app instances preserved |

The existing skips are `CooperativeFileLockTests.testProcessDeathReleasesLock` and `LocalLibraryStoreTests.testSuccessfulExistingStoreReopenRequiresSeparateProcess`; neither is counted as passed. The first targeted build hit a test-only async `beginSheet` overload. Adding its explicit completion handler fixed that test compilation; production behavior was not relaxed.

The review retains two minor visual differences: wider desktop media inset and a more prominent shortcut button. Its full-suite/package result was pending when the reviewer finished; the passing package result was subsequently verified and recorded separately. The earlier 9.0/10 review is not reused as evidence for these changes.

## Retained evidence and candidate

- [Original refinement validation](validation.json), [85-file manifest before the icon addition](build-info.json), [fresh Sol 6.1 review](review-1.json), [original demo launch](demo-launch.json). The icon follow-up and current 88-file manifest are linked above.
- [All final layout measurements](captures-measurements.json) and [reviewed-run measurements](review-captures-measurements.json). The nine retained representative images are byte-identical between the reviewed run and the final suite.
- [Desktop Video](captures/paused-1280x860.png), [desktop Focus](captures/focus-1100x720.png), [480-point Video](captures/paused-480x680.png), [480-point Focus](captures/focus-480x680.png), [Focus without artwork](captures/focus-no-artwork-480x680.png), [80% zoom](captures/zoom80-480x680.png), [125% zoom](captures/zoom125-480x800.png), [Focus at 125%](captures/focus-zoom125-480x680.png), [Stage Focus](captures/stage-focus-480x680.png).
- [Latest Apple Silicon ZIP](../../../build/tubeshuffle-delivery-szvj8h5e/TubeShuffle-local-arm64.zip), [SHA256SUMS](../../../build/tubeshuffle-delivery-szvj8h5e/SHA256SUMS), [public setup JSON](../../../build/tubeshuffle-delivery-szvj8h5e/TubeShuffle-account-setup.json). The setup file remains outside the ZIP; loading it is not login or live acceptance.

ZIP SHA-256: `d1d55d760058285e11f15c0dcc61c616fe67f665d33016992b6fba4f96f8bbd0`. Requires macOS 14+ and Apple Silicon. The ZIP is an ignored local artifact, not a hosted release. Extract and keep **TubeShuffle Local** together; **Open Demo.command** opens the isolated demo. Earlier packages remain under `build/tubeshuffle-delivery-_fcy8y2w/` and `build/tubeshuffle-delivery-mglb7arz/`.

The updated `run-ui-fixture.sh` demo was launched from `/var/folders/wc/klrm9xnd0fn17xqp95c5dxnr0000gn/T/tubeshuffle-ui.ZMUtZfk7BR`. Use only that disposable folder for its export/create/import/reopen exercise. The script isolates preferences and disables account access; audio starts only on an explicit playback action.

## Still unvalidated

Physical keyboard/VoiceOver and final owner layout acceptance; audible Focus/Video transitions, natural queue advancement and minimize/Cmd+H/restoration; the full GUI export/create/import/queue/reopen exercise. Use the [single grouped rehearsal](../../../macos/README.md#one-grouped-ui-rehearsal) and mark unperformed steps **por validar**. General positive feedback is not substituted for those results.

Live OAuth/API/Keychain acceptance, deployment, signing/notarization and YouTube policy remain separate gates. This refinement made no browser/backend change, account request, real-library/profile access, migration, remote configuration change or deployment. Previous web/configuration evidence is historical, not a new validation run. The current changes are local; PR checks at `413a226` do not cover them.
