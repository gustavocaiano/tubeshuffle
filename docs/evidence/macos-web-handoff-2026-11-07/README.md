# Website entry for the Mac app — 2026-11-07

The owner requested an installer link and instructions in the browser app. `/macos` now provides the native app preview, Apple Silicon/macOS 14+ requirements, download status, ZIP installation, Library setup and explicit browser-to-Mac JSON guidance. Navigation, the homepage and footer link to it. The browser remains an independent option.

There are **no public GitHub releases** at this checkpoint (`gh release list` returned none). The available local package is ad-hoc signed, not Developer ID signed/notarized or approved for public distribution. Accordingly, `src/config/macos-release.json` is `null`, the page disables Download for Mac, and there is no public binary URL or upload. The [release handoff](../../../macos/README.md#website-download-and-release-handoff) documents the separately authorized artifact publication and reviewed manifest change. A valid manifest's URLs are pinned to this repository and one versioned GitHub release; parsing metadata does not verify an artifact or establish authorization.

## Validation

- `NODE_OPTIONS=--no-experimental-webstorage npm test`: **23 files; 477 passed, 2 existing skips, 0 failed**. Sixteen new tests cover absent/incomplete metadata, versioned URL construction, mismatched versions, unsafe paths, mutable tags, unsupported packages and checksum shape. The available-release test uses synthetic metadata only, not a public download.
- `npx tsc --noEmit` and `NEXT_TELEMETRY_DISABLED=1 npm run build` passed. `/macos` is statically generated. The first typecheck/build failed because TypeScript traversed the ignored native `build/` directory and encountered vendored Deno examples; excluding that directory fixed the scope without weakening checking of application/tests.
- `npm run lint`: zero errors, one existing unused `_id` warning at `src/stores/playlist-store.ts:76`. `git diff --check` passed.
- Production build served on loopback port 3107, using a separate **Incognito** browser tab. Desktop 1280 × 800 and widths 768, 480 and 320 checked; no horizontal overflow. Navbar keeps a named Dashboard icon at small sizes. Keyboard Tab focused the brand, macOS, Dashboard and browser CTA visibly, skipping the disabled download. The setup anchor stayed below the sticky header. Transfer FAQ expanded and displayed exclusions.
- Homepage → macOS navigation and macOS → browser dashboard worked. No IndexedDB databases or localStorage keys were created during the page visit or the subsequent dashboard navigation. The fresh dashboard showed its missing-library confirmation, which was not accepted. The local account service was unconfigured; no login was attempted. The server and owned tab were closed.
- The local server reports the expected Vercel Analytics script 404 because that hosted endpoint is not present locally. No page application exception was observed.

[Validation/source hashes](validation.json), [browser measurements](browser-results.json), [desktop](desktop.png), [320 px layout](mobile-320.png), [setup section](installation.png). Final build/test/typecheck/lint logs are retained alongside this report with line endings/trailing whitespace normalized for Git; original local logs remain under ignored `build/macos-web-check-94iifN/`.

## Review and follow-up

Sol 6.1 reviewed the source and supplied captures: **8/10 for this website page**, no blocking code regression, two nonblocking usability findings. The parent fixed both directly: the YouTube-import step now starts with the owner-account restriction, and a visible **Bring your browser library** panel explains the JSON alternative without login. Detailed exclusions remain in the FAQ. The final production build/typecheck passed again; final loopback checks at 1280 and 320 px confirmed both changes, no overflow and no storage creation. [Original review and resolution](review-1.json), [pre-review setup capture](installation-before-review.png), [final setup capture](installation.png). No revised score or full accessibility certification is claimed; this is separate from the native app's earlier 9.0/10 review.

## Boundaries

No production configuration, database/schema, real library/profile, live account, native player or binary changed. All **89 native test/build inputs** were hash-compared and remain the same as the previously tested package; the native suite was not rerun for web/documentation changes. No binary upload, public install, Gatekeeper/notarization check, deployment, merge or rollout was performed. Live account, detailed native audio/transfer acceptance and YouTube policy/distribution gates remain open.
