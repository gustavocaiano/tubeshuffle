# Production restrictions — native macOS TubeShuffle

Status: engineering risk register for the native prototype.
Scope: `docs/plans/native-macos-app.md` (P0 and later phases), the existing web client, and any shared API surface.
Sources checked: 2026-10-28. Policy text can change; re-read the [revision history](https://developers.google.com/youtube/terms/revision-history) before implementation and before any release.

> **This document is not legal advice and is not YouTube approval.** It records published requirements and unresolved technical behavior so release decisions are made with eyes open. Classification below separates contractual restrictions from uncertain runtime behavior from obligations whose applicability to this design has not been settled. Where a question is unresolved, it is a risk requiring review by the owner, counsel, or YouTube — not a definitive legal ruling in either direction.

## How to read this document

| Class | Meaning | Release effect |
| --- | --- | --- |
| **POLICY** | Published requirement in the YouTube API Services Terms, [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), or the integral [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) policy. The [compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide) explains enforcement and examples but does not replace those documents. | Blocking unless the design changes or YouTube gives written guidance covering the exact design. |
| **TECH** | Behavior not documented or not guaranteed by official sources. Must be measured on the owner's Mac. | Blocking for any feature promise that depends on it. A passing test is **not** policy permission. |
| **REVIEW** | An identified obligation or exposure whose applicability to this client is not settled by the sources read. | Risk requiring explicit review. Do not describe as cleared, and do not describe as a violation. |

Two rules apply throughout:

1. **Owner acceptance is not clearance.** A personal proof-of-concept, a single-user account, no distribution, an explicit "I accept the risk" decision, prior manual playback, or technical success do not create an exemption from the API terms. Those decisions belong in a separate product/go-no-go record and must not be restated as compliance. The owner has explicitly authorized the isolated P0 personal-use POC despite the disclosed conflict; that is recorded risk acceptance for a diagnostic experiment, not YouTube permission, not release approval, and it does not change the release effect of any item below.
2. **Technical success is not permission; a failure is not proof of breach.** Audio continuing while a window is hidden does not establish that background play is allowed. Error 153 or a blocked autoplay does not establish which policy was implicated.

## Release-blocking policy restrictions

### PR-1 — Background player prohibition (highest-severity blocker)

**POLICY.** Developer Policies III.I.9 prohibits API clients from creating, including, or promoting features that play content — audio or video — from a background player, defined as "a player that is not displayed in the page, tab, or screen that the user is viewing." The compliance guide strengthens this beyond a hypothetical: its "Do not" list includes "Allow for background play of the YouTube video player," with the example "Using YouTube's API to allow videos to play even when your API service window is closed or minimized." ([III.I](https://developers.google.com/youtube/terms/developer-policies#i.-additional-prohibitions), [guide](https://developers.google.com/youtube/terms/developer-policies-guide))

Consequences for this product:

- **Minimized window, Cmd+H (app hidden), a fully occluded window, the player covered by another app window, and a closed player window with audio continuing** all fall inside the named example or the policy's definition, or are close enough that they must be treated as prohibited until YouTube says otherwise.
- Screen lock and system sleep are not enumerated in the example, but they are worse cases for a "displayed player" argument and must not be promised.
- Earlier framing described this only as a general "no explicit exemption for ordinary minimization" contractual risk; that understated the text. The guide names a minimized or closed API service window directly, so minimization is inside the published example, not a novel interpretation.
- There is no personal-use, single-user, non-distributed, or "user pressed play" exemption in the cited sources.

**Design implication:** the native prototype's core background-listening requirement is the single largest release blocker. Do not implement window-hiding keepalives, forced-pause workarounds presented as compliance, or silent substitution of an audio-only path.

### PR-2 — Automatic/scripted playback must start visible

**POLICY.** RMF's autoplay and scripted-playback section applies to the `autoplay` parameter and to programmatically initiated playback through the IFrame API or another YouTube API. A client "must not initiate an automatic playback until the player is visible and more than half of the player is visible on the page or screen." Initiation should occur immediately on page load or as soon as the player is fully visible. It also prohibits more than one simultaneously autoplaying YouTube player per page/screen and requires a playback-initiating thumbnail of at least 120 × 70 px. ([RMF](https://developers.google.com/youtube/terms/required-minimum-functionality#autoplay-and-scripted-playbacks))

Application notes:

- The threshold is *more than* half visible, not half-or-more.
- This is an **initiation** rule. It is not a quoted rule requiring an already-playing video to pause the instant it drops below 50% visibility; III.I.9 separately governs the no-displayed-player case.
- Programmatic automatic next-track loading is at least a strong case for applying the rule. The sources do not explicitly classify every natural, player-managed playlist transition; treat that as unresolved (see TR-2) rather than automatically exempt.
- An initial user gesture does not clearly exempt every later automatic initiation.
- A DOM intersection check alone does not prove real screen visibility (occlusion, Spaces, other apps, offscreen placement).
- III.C.2 additionally requires features that initiate YouTube actions to be clearly identifiable, distinct, and clearly initiated by the user.

### PR-3 — Embedded client identity (Referer) and error 153

**POLICY.** RMF requires embedded clients to identify themselves via `HTTP Referer`; where a webview provides none, identity must be supplied by the documented methods. For macOS, follow the iOS WebView instructions. An explicitly supplied WebView referrer must be an HTTPS URL whose domain is the app's actual registered bundle ID, stable across versions. Misrepresenting identity is prohibited. The `origin` iframe parameter is a documented API security parameter, not a general substitute for the required Referer in WKWebView; RMF identifies a special `SFSafariViewController` exception. ([RMF identity](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity), [III.D](https://developers.google.com/youtube/terms/developer-policies#d.-accessing-youtube-api-services))

The local-HTML `baseURL` approach and a direct request-header approach are different documented integration configurations; choose one deliberately with the pinned wrapper and verify the actual outgoing request. Never fabricate a domain or copy another app's identity. Error 153 indicates missing Referer or equivalent identification ([IFrame API](https://developers.google.com/youtube/iframe_api_reference#Events)); absence of 153 in one environment is not proof that identity is correct in another.

### PR-4 — WebView type

**POLICY.** Use an OS-provided WebView where available; RMF lists `WKWebView` for macOS. A native SwiftUI shell does not exempt its embedded player from the same requirements. ([RMF](https://developers.google.com/youtube/terms/required-minimum-functionality#webview-type)) This rules out bundling an arbitrary Chromium runtime as an assumed-compliant shortcut.

### PR-5 — Player integrity, size, and no covering overlays

**POLICY.** RMF requires an embedded player viewport of at least **200 × 200 px**, with any displayed controls fitting without reducing it below that minimum; 480 × 270 is a recommendation for 16:9, not a floor. Visual elements must not overlay or obscure **any** part of the embedded player, including its controls. Do not modify or block player functionality, links, ads, captions, settings, or separate audio from video. ([RMF size](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-size), [III.I](https://developers.google.com/youtube/terms/developer-policies#i.-additional-prohibitions), [guide](https://developers.google.com/youtube/terms/developer-policies-guide))

Practical notes:

- A 320 × 180 mini-player fails the minimum height even though it looks usable.
- Native points, backing pixels, and WebView CSS pixels are not interchangeable; measure actual CSS pixels on the Mac.
- The guide allows certain consent/playback-control overlays that do not conflict with player UI, while RMF states no visual element in front of any part of the embed. The guide does not replace RMF; do not read its examples as blanket permission to overlay the player. Prefer native controls placed outside the player.
- The plan's "No Artwork" / "Stage" concepts must not obscure the video; thumbnails may be hidden, the embed may not.
- A small floating **video image** extracted or re-rendered outside the embed is not established to qualify as the embedded player.

### PR-6 — No stream extraction, downloads, or AV separation

**POLICY.** Prohibited directions include extracting or downloading audiovisual streams, separating audio from video, suppressing or modifying ads/player features, spoofing identity or visibility, and keepalive tricks that defeat restrictions. ([III.I](https://developers.google.com/youtube/terms/developer-policies#i.-additional-prohibitions), [guide](https://developers.google.com/youtube/terms/developer-policies-guide))

These are release-blocking regardless of technical feasibility and regardless of how brittle or undetectable a technique appears. Offline downloads, audio-only modes, and "downloads/offline media" were already excluded by the product decisions; that exclusion is now a compliance requirement, not only a scope choice.

### PR-7 — API data retention and derived data (material risk, requires review)

**REVIEW.** These are published obligations; whether the planned design satisfies them is what needs review. They are not settled by this document.

- **III.E.4.d** limits storage of non-authorized API data to 30 days before refresh or deletion. The planned indefinite local SwiftData library, IndexedDB library, and portable JSON export of playlist/video metadata may exceed this for API-sourced fields. Distinguish user-provided identifiers from API-returned metadata, and design refresh/deletion paths before shipping.
- **III.E.4.h** restricts derived data and derived metrics. The metadata-inferred "Smart" shuffle and energy classification consume API metadata; do not assume local derivation escapes the restriction.
- **III.E.4.j** requires looking up Made for Kids status for each embedded video and applying tracking safeguards. The current proxy does not obviously perform this; treat as an open gap for any client that embeds third-party videos.
- **III.E.4.i** describes player-load and autoplay data-sharing obligations; disclosures/consent may be required.
- **III.A / III.E** also implicate user-facing terms and a privacy policy for an API client.

**Risk, not ruling:** a reviewer could reasonably conclude that a personal, local-only, non-distributed client changes the practical exposure, or could conclude the storage/derived-data clauses still apply as written. Neither conclusion is established by the sources read. Get this reviewed before P2/P3 (accounts, cloud links, persistence) rather than after.

### PR-8 — API key handling and quota

**POLICY / operational.** API access must not circumvent quota or expose credentials. The existing `/api/youtube/playlist` and `/api/youtube/suggestions` handlers are currently unauthenticated; shipping a native client against them as-is would leave public quota-consuming endpoints. Keep `YOUTUBE_API_KEY` server-side only (never in Swift, shipped config, `NEXT_PUBLIC_*`, transfer files, logs, or the player bridge), and treat owner authentication as a quota-control measure only after it is enforced before every upstream fetch. Authentication does not itself prevent accidental quota exhaustion.

## Technical uncertainty (not policy permission)

### TR-1 — Minimized/hidden WKWebView continuation

**TECH.** No official Apple or YouTube source guarantees that an embedded YouTube iframe continues playing, or advances, when its WKWebView window is minimized, the app is hidden, the window is occluded, or the screen locks. YouTubePlayerKit 2.0.5's README explicitly says **audio background playback is not supported** — a maintainer limitation, not proof that audio necessarily stops in every lifecycle state, and not permission if it happens to continue. ([README](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/README.md))

Also unverified: event/JavaScript delivery while occluded, natural ended-to-next transitions, player state recovery on restore, network-loss behavior, and behavior across sleep/wake. Existing wrapper projects and issue reports ([#146](https://github.com/SvenTiigi/YouTubePlayerKit/issues/146), [#162](https://github.com/SvenTiigi/YouTubePlayerKit/issues/162)) are anecdotes, not evidence for this Mac, OS, or queue design.

### TR-2 — Whether player-managed natural advance counts as "automatic playback"

**TECH/REVIEW.** PR-2 unambiguously covers the `autoplay` parameter and programmatic calls. It does not explicitly state whether a natural end-of-video transition inside a player-managed playlist is an "automatic playback" for the visibility rule. Do not resolve this by assumption in either direction. The owner's narrowly scoped personal-POC diagnostic decision below accepts the risk of testing despite this uncertainty; it is not YouTube permission or release approval.

### TR-3 — Visible mini-player is a different case, not an approved one

**REVIEW.** A genuinely visible, unobscured, appropriately sized independent window containing the real embed is materially different from hidden audio and may avoid the literal background-player definition. It is **not** affirmative permission. Unresolved questions that require YouTube's written view on the exact design:

- Whether a separate visible player window remains acceptable when the app's primary window is minimized or the app is hidden.
- What counts as "the screen the user is viewing" for a floating window partially behind another app, or on another Space/display.
- Whether automatic next-track initiation is permissible in that window under PR-2, and how "more than half visible" is measured for a floating panel.
- Whether such a window needs its own playback-initiating affordance.

Always-on-top, a technically visible window, or success in a prototype do not by themselves prove compliance. Treat a visible mini-player as the best bounded **experiment**, not a promised release feature.

### TR-4 — Picture-in-Picture

**TECH/REVIEW.** macOS PiP for this specific cross-origin YouTube iframe is unproven, and the relevant APIs have platform-scope mismatches:

- Apple's [`WKWebViewConfiguration.allowsPictureInPictureMediaPlayback`](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/allowspictureinpicturemediaplayback) is documented for iOS, iPadOS, Mac Catalyst, and visionOS — **not** native macOS. Mac Catalyst is not a native macOS target.
- The 2.0.5 wrapper exposes a similarly named property defaulting to **false**, and its documentation says PiP playback is supported only on iOS and visionOS, with availability depending on the underlying iframe and video. ([configuration](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/Sources/Models/YouTubePlayer%2BConfiguration.swift))
- The [IFrame API reference](https://developers.google.com/youtube/iframe_api_reference) and [player parameters](https://developers.google.com/youtube/player_parameters) do not document a supported PiP initiation method.
- Apple's [Safari web-video PiP guidance](https://developer.apple.com/documentation/webkitjs/adding_picture_in_picture_to_your_safari_media_controls) concerns first-party video controlled by the page that owns it; it does not establish control over YouTube's video element in a third-party embed.

Policy mapping is also unresolved: whether a PiP window counts as the displayed player, whether it must satisfy the 200 × 200 viewport and unobscured-controls requirements, and whether ads/branding/links/attribution survive. Lack of documentation is not proof that PiP is impossible or banned — it means it cannot be promised, marketed, or engineered around. PiP is optional research at most.

### TR-5 — Error taxonomy and what an error does not tell you

**TECH.** Documented iframe errors are distinguishable and should be logged separately ([IFrame API events/errors](https://developers.google.com/youtube/iframe_api_reference#Events)):

| Signal | Documented meaning |
| --- | --- |
| 101 / 150 | Embedding disallowed by the video owner |
| 100 | Video missing or private |
| 153 | Missing Referer or equivalent client identification |
| `onAutoplayBlocked` | Browser blocked scripted/autoplay playback, including `playVideo`, `loadVideoById`, `loadPlaylist` |

Browser permission and user-gesture restrictions are distinct from YouTube's visibility and background rules. A blocked autoplay does not identify which policy or browser rule was violated; a successful autoplay does not prove the visibility rule was satisfied.

### TR-6 — Library and build metadata are not compatibility guarantees

**TECH.** YouTubePlayerKit 2.0.5's [manifest](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/Package.swift) declares Swift tools 6.0 and macOS 12 minimum; that is package metadata, not proof of compatibility with the owner's installed Xcode, target OS, signing configuration, or YouTube runtime. The README also notes outgoing network access requirements for sandboxed macOS targets. Pin a tagged release, commit resolved versions, and verify on the actual Mac. A dependency's own compliance marketing statement is not an independent determination for this app's features.

## Gate status for the native prototype

| Gate | Requirement | Status |
| --- | --- | --- |
| G1 | P0 collects real Mac evidence **with the actual player genuinely visible**, covering identity/153, playback, overlay/size constraints, and event ordering. | Open — not run |
| G2 | Hidden/minimized/Cmd+H observation runs only as a diagnostic experiment under the owner's recorded personal-POC risk acceptance (see decision below). It creates no permission and must not be framed as a supported feature; release remains blocked under PR-1. | Open — owner authorized diagnostic run; not permission |
| G3 | Written clarification or [API compliance audit](https://support.google.com/youtube/contact/yt_api_form) submitted for the exact mini-player/PiP design (windows, visibility, controls, ads, autoplay, primary-window state) before any such feature ships. | Open |
| G4 | Explicit owner go/no-go recorded **separately** from any policy conclusion; no claim of compliance, approval, or "policy cleared" attached to it. | Open |
| G5 | API-data review (30-day storage, derived-data limits, Made for Kids lookup, privacy policy/terms, data-sharing disclosures) completed before P2/P3 persistence and account work. | Open |
| G6 | Server-side key handling, owner guard before upstream calls, and removal of anonymous client-direct key paths verified before exposing the native client to production APIs. | Open |
| G7 | Re-check policy revision history and the pinned library at implementation and again before release. | Recurring |

### Owner decision on the plan conflict

`docs/plans/native-macos-app.md` P0 asks for "at least two natural ended-to-next transitions while minimized and two while hidden." PR-1 concludes that the compliance guide names minimized/closed API service windows as a forbidden background-play example, and that knowingly triggering automatic advancement while the player is not sufficiently visible conflicts with that text. Those statements are in tension.

**Recorded decision:** the owner explicitly authorized proceeding with the isolated personal-use POC despite the known conflict, including the documented minimized and Cmd+H diagnostic observations. This is recorded in the P0 progress log and `macos/README.md` and was acknowledged in the P0 review. It is **risk acceptance for a diagnostic experiment** — not YouTube guidance or authorization, not a legal opinion, not compliance, and not release approval. It is not the "documented external decision authorizing the hidden test" that would require YouTube's view.

**Consequences:**

- P0 may run the documented minimized/hidden observations as diagnostics, without spoofing, keepalives, extraction, ad suppression, or any other bypass.
- Results must be recorded as observations of a knowingly conflicted experiment, never as evidence that hidden playback is supported or permitted.
- G2's release intent is unchanged: hidden/minimized playback remains a release blocker under PR-1. G3 (written clarification or compliance audit) and G4 (separate owner go/no-go) remain open.
- This authorization covers P0 diagnostics only. It does not extend to shipping, marketing, or expanding hidden behavior into a product feature, and it does not unblock P1.

## Candidate fallbacks (product-level, not compliance shortcuts)

- **Visible-only playback**: keep the real embed on screen at compliant size; accept loss of background listening.
- **External official YouTube experience**: let the user open a video/playlist in YouTube's own app or browser, where background behavior is governed by YouTube's product terms and account eligibility. This does not transfer TubeShuffle's shuffled queue or native continuity, and Premium/mobile background playback is product-, device-, account-, and region-dependent — never imply Premium authorizes a third-party iframe background feature.
- **Different licensed source**: a provider that explicitly permits a native audio/background player, or media the user owns/licenses. This changes the product and may need licensing and new integrations; it is not a way to reuse YouTube streams.

Each fallback changes the product promise. None should be selected silently in place of the owner's recorded background-listening requirement.

## Limits of this document

- Written from published documentation and repository source on 2026-10-28 with no Mac, Xcode, live OAuth, or live player run. No playback or lifecycle behavior has been observed.
- Repository state at this revision: P0 prototype files exist under `macos/` (uncommitted working-tree files). YouTubePlayerKit is pinned to 2.0.5 at revision `1ae827573024ab13dd6adea33b25d3eef6ff667c` in `Package.resolved`; the bundle ID is `com.tubeshuffle.playbacklab`; the fixed six-ID sample queue is `M7lc1UVf-VE`, `aqz-KE-bpKQ`, `ScMzIvxBSi4`, `ysz5S6PUM-U`, `jNQXAC9IVRw`, `dQw4w9WgXcQ`, with availability and embed eligibility unverified. No build, playback, Referer/153, or lifecycle evidence exists, and no prototype PR or commit SHA is recorded.
- Policy interpretation here is engineering interpretation for planning. It is not legal advice, not a YouTube decision, and not a compliance certification.
- Where sources are silent (PiP mapping, natural-transition classification, Mac-specific lifecycle), this document records uncertainty. Silence is not permission and not prohibition.
- Enforcement outcomes, account/API access consequences, and contractual remedies are outside the scope of what was researched.

## Sources

1. [YouTube API Services — Developer Policies](https://developers.google.com/youtube/terms/developer-policies) — III.C.2, III.D, III.E.4.d/h/i/j, III.I.9 background player.
2. [YouTube Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) — client identity, macOS WKWebView, player size, autoplay/scripted playback visibility, overlays.
3. [Developer Policies compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide) — enforcement examples, including minimized/closed API service windows.
4. [YouTube API Services Terms revision history](https://developers.google.com/youtube/terms/revision-history).
5. [YouTube IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference) — events, errors 100/101/150/153, `onAutoplayBlocked`, playlist calls.
6. [YouTube player parameters](https://developers.google.com/youtube/player_parameters) — `origin`, `autoplay`; no documented PiP control.
7. [YouTube API compliance audit form](https://support.google.com/youtube/contact/yt_api_form).
8. [YouTube Help: background play](https://support.google.com/youtube/answer/6308116) — official product feature eligibility, not a third-party iframe exemption.
9. YouTubePlayerKit 2.0.5: [README](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/README.md), [configuration](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/Sources/Models/YouTubePlayer%2BConfiguration.swift), [manifest](https://github.com/SvenTiigi/YouTubePlayerKit/blob/2.0.5/Package.swift).
10. [Apple: `allowsPictureInPictureMediaPlayback`](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/allowspictureinpicturemediaplayback); [Safari media PiP guidance](https://developer.apple.com/documentation/webkitjs/adding_picture_in_picture_to_your_safari_media_controls).
11. Repo planning inputs: `docs/plans/native-macos-app.md`, `.slim/deepwork/native-macos-p0/policy-research.md`, `.slim/deepwork/native-macos-p0/miniplayer-research.md`.
