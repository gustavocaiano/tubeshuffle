# Library navigation simplification — 2026-11-07

The owner requested fewer permanently visible options, all management actions inside **Library**, and removal of **Try the demo**. The top bar now contains the TubeShuffle brand and one Library menu. It groups Your playlists, YouTube import, create/open, JSON transfer, close and Account. The welcome screen has one Open Library entry. Inside the playlist grid, Import and Options keep management actions within Library. Both ordinary demo-entry controls are removed; the explicit `--ui-fixture` testing path remains available without exposing a Try demo button.

The same menu implementation serves both locations. Actions chosen inside the grid dismiss it before presenting the importer, account sheet or file panel. Playback controls, account guards and data semantics are unchanged. Earlier uncommitted changes and existing data/candidates were preserved.

## Verification

- Full hosted arm64 suite: **249 executed, 247 passed, two pre-existing skips, zero failures**. Existing 15 initial player layouts and two scrolled captures cover desktop, 480-point width, zoom and Focus. This change adds no tests that merely mirror button markup.
- Release build, ad-hoc signature/entitlements, ZIP integrity/checksum and **89 native source hashes** verified. [Validation](validation.json), [build manifest](build-info.json), [layout measurements](layout-measurements.json).
- Actual packaged-app accessibility checks confirmed the single top-level Library entry, absence of Try demo, grouped menu actions, grid-to-import transition and Account access from both the root Library menu and grid Options. The latter has exactly one active sheet after transition. Resize requests were accepted and the new welcome/grid were captured at narrow width. [Actions](gui-actions.jsonl), [GUI result](gui-smoke.json), [captures](captures).
- Fresh independent **Sol 6.1 UI review: 9.0/10, no blocking finding**. Minor naming/discoverability tradeoffs remain: Open Library opens the grid while Open library… chooses a file, and Options groups several kinds of management action. The score covers source and visual consistency, not a claim of exact web pixel parity or live-service acceptance. [Full review](review-1.json).
- The [inline preview HTML](preview.html) uses actual app-window captures; it does not reconstruct the UI in HTML. Preview inspection reported no console messages. Only this newly launched app's windows were captured, never the desktop or another application.

## Candidate and handoff

The new ordinary app is open at its empty entry screen, with no library selected and no account configured or signed in. Earlier app instances were left alone.

- [TubeShuffle.app](../../../build/tubeshuffle-delivery-018phs9g/TubeShuffle%20Local/TubeShuffle.app)
- [Open TubeShuffle.command](../../../build/tubeshuffle-delivery-018phs9g/TubeShuffle%20Local/Open%20TubeShuffle.command)
- [ZIP](../../../build/tubeshuffle-delivery-018phs9g/TubeShuffle-local-arm64.zip)
- ZIP SHA-256: `b0b2a86b68d8189b433740a53243e0e488cfc313597e03d4d0ba3e5da0ccdb86`

This is an Apple Silicon/macOS 14+ local candidate, ad-hoc signed, not Developer ID signed or notarized. No real library, browser profile, login, playback, file-panel data selection, migration, remote configuration change, push, merge or deployment was performed. Physical shortcut behavior, live account/API/audio and the earlier grouped transfer/reopen acceptance remain unvalidated by this UI change. YouTube policy and distribution gates remain open.
