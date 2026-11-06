# Native UI rework — 2026-11-05

The owner's native screenshot showed an overflowing player, missing thumbnails and an unintuitive layout. Their web screenshot is the visual reference. This work replaces the first native layout with a SwiftUI listening screen following that reference. It does not wrap the website.

## Independent reviews

Each pass used a new read-only **gpt-6.1-sol** reviewer with the reference images, actual native captures and source. The requested threshold is at least 9/10 for visual similarity; it is not a release or live-playback score.

| Pass | Score | Findings and response |
| --- | --- | --- |
| [1](review-1.json) | 8.2/10 | Preserve 16:9 in short windows; expose compact Queue/Shuffle navigation; make Play follow the displayed track; visibly label Stop & close. All four addressed. |
| [2](review-2.json) | 8.8/10 | Reduce vertical chrome to enlarge short-window media; snapshot measured bounds before additional scrolled captures. Both addressed for the next pass. |
| [3](review-3.json) | **9.0/10** | No remaining visual blocker at the requested threshold. Minor differences remain in desktop media inset, queue density and shortcut-button width. This is visual signoff from source/captures, not interactive or release acceptance. |

The first captures had a white media region because the static test fixture used a nil base URL, which the production navigation policy rejected. The fixture now uses the genuine allowed app base URL and waits for its bundled image to load. The production navigation policy was not weakened. The second measurement artifact accidentally recorded updated scrolled bounds for two initial cases; the assertions ran before scrolling and passed, but that exported artifact was ambiguous. The test now preserves initial bounds explicitly. Earlier reviews/artifacts remain historical evidence, not overwritten results.

## Retained evidence

[Validation manifest](validation.json) contains source, log and image SHA-256 hashes. The full hosted arm64 suite passed **237 cases**, with **2 existing skips** and **0 failures**. After the final layout-only adjustments, all **4 UI tests passed again**, including a fresh build. Counts are not added together.

[Measurements](measurements.json) distinguish seven initial cases from two additional scrolled captures. `initialViewportAssertionsPassed` is true for the initial cases; false on a `lower-` case means those initial-viewport assertions are not applicable to that extra scrolled image. Negative upper-content coordinates after scrolling are expected.

These are unmodified PNG copies of the actual native render output:

- [Desktop, 1280 × 860](captures/paused-1280x860.png)
- [Short desktop, 1100 × 720](captures/paused-1100x720.png)
- [Compact, 760 × 680](captures/paused-760x680.png)
- [Stage, 1100 × 720](captures/stage-1100x720.png)
- [Shuffle and suggestions after scrolling](captures/lower-paused-1280x860.png)

The manifest retains the temporary directory containing all nine captures, including idle and Focus. It also identifies the full and targeted test logs; both report `TEST SUCCEEDED`. No screenshot of live YouTube playback is claimed.

The agent then ran `./macos/scripts/run-ui-fixture.sh` for the reworked checkout. The build succeeded, `open` returned successfully and the new fixture process was observed. [Launch evidence](demo-launch.json) records the binary/log hashes. Its disposable rehearsal directory is `/var/folders/wc/klrm9xnd0fn17xqp95c5dxnr0000gn/T/tubeshuffle-ui.xCiSUvPbBU`. Account access is disabled; the agent did not start audio or choose a library. Owner interaction/transfer results remain pending.

## What was measured

- Actual `NSHostingView`/SwiftUI pixel captures at 1280 × 860, 1100 × 720, 760 × 680 and 1600 × 1000 points, including idle, paused, Focus, Stage and scrolled states.
- A real retained `WKWebView` with static bundled-thumbnail HTML and synthetic readiness/paused callbacks. No YouTube or live audio was used in these tests.
- Exact 16:9 media geometry, minimum media height, horizontal containment and player/transport placement within the initial content viewport.
- The identical WKWebView, occurrence generation and selection survive actual resizing and Focus changes without a load request.
- Bundled demo thumbnails decode, fallback URLs are validated, and volume commands require an accepted generation without inventing playback state.

All libraries were in memory or fresh disposable test directories. Preferences used unique suites. Captures contain only the test-owned app view, not the desktop or other applications. No login, production profile, real library, migration, deployment or rollout occurred.

## Limits

The owner reported that playback seemed good in the previous UI. That qualitative observation remains attributed to that run. Render fixtures and source review do not prove live embed rendering/audio, minimized or hidden-window transitions, keyboard/media-key delivery, VoiceOver, OS file panels, signed Keychain behavior or account/RLS acceptance. The library/transfer model has separate synthetic coverage; manual export/import/reopen through the redesigned UI remains pending. YouTube policy and release authorization remain open.

Use [the grouped rehearsal](../../../macos/README.md#one-grouped-ui-rehearsal) for owner observations. Do not choose a real library.
