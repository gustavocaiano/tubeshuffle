# UI Polish, Shuffle Simplification, Queue Upgrades, and Focus Audio UI Plan

## Request

Plan improvements for TubeShuffler covering:

- Better UI prettiness and usability across the app.
- Simplify shuffle methods because some current modes are not useful.
- Add prior suggestions **6, 8, 12**:
  - 6: queue upgrades.
  - 8: keyboard shortcut help.
  - 12: ambient player polish.
- Add a **no thumbnail + no video mode**, interpreted as a YouTube-compliant **Focus Audio UI** rather than true audio-only playback.

This document is planning only. No implementation has been performed.

## Resolved Assumptions

Questions were surfaced before writing this plan. Resolved answers:

- “Suggestions 6, 8, 12” means queue upgrades, shortcut help, and ambient player polish.
- Shuffle UI should simplify to **Normal + Smart**.
- “No thumbnail + no video mode” should become a **Focus Audio UI**: hide/minimize visual clutter as much as YouTube allows, but still use the YouTube iframe/player.
- UI priority is broad: dashboard, player, and overall polish all matter.
- Small focused dependencies are acceptable when justified.

## Council / Review Direction

Council review recommended one important guardrail: **do not promise true audio-only YouTube playback**. The YouTube IFrame API is a video embed API, and official docs require embedded players to have a viewport of at least **200px × 200px**. Therefore this plan uses:

- **Focus Audio UI / Minimal Visuals Mode**, not “audio-only mode”.
- A rendered, visible YouTube iframe/player remains available.
- No `display: none`, detached iframe, zero-size iframe, or fully hidden playback assumptions.
- No misleading shuffle labels like “Energy” or “Discovery” unless behavior is real and useful.

Context7 confirmed relevant YouTube IFrame constraints:

- IFrame API provides playback/playlist control through the player object.
- `origin` should be used with `enablejsapi` as a security measure.
- Embedded players must have at least a 200×200 viewport; 16:9 players are recommended at 480×270+.
- The API supports playlists/video queues, but not true audio-only playback.

## Current Relevant App State

- App is local-first: IndexedDB for playlists/videos/history, Zustand for player queue.
- Player route: `src/app/playlist/[id]/page.tsx`.
- YouTube player: `src/components/playlist/VideoPlayer.tsx`.
- Queue: `src/components/playlist/PlaylistQueue.tsx`.
- Controls: `src/components/playlist/ShuffleControls.tsx`.
- Shuffle service: `src/lib/shuffle/shuffle-service.ts`.
- Current exposed presets: `RANDOM`, `SMART`, `DISCOVERY`, `ENERGY`.
- Known issues:
  - `ENERGY` aliases `SMART`.
  - `DISCOVERY` algorithm exists but is not wired to real play history in the player page.
  - Queue can become expensive for very large playlists.
  - Keyboard/media controls exist but are not discoverable.

## Product Direction

Position the app as a polished local-first music shuffler:

- Calm, music-app-like player experience.
- Stronger visual hierarchy and spacing.
- Fewer confusing shuffle choices.
- More usable queue for long playlists.
- Optional minimal visual mode for users who want music-first playback.
- Honest YouTube constraints: video remains available/rendered.

## Non-Goals

- No real audio-only YouTube extraction.
- No background playback guarantees beyond browser capabilities.
- No native macOS media key guarantee beyond existing Media Session best effort.
- No account system or cloud sync.
- No implementation in this planning step.

## Proposed Milestones

### Milestone 1 — Visual Foundation and App-Wide Polish

Goal: make the app feel more intentional and premium before deeper feature work.

Scope:

- Landing page:
  - Strengthen hero visual hierarchy.
  - Make feature cards more distinctive and less generic.
  - Clarify local-first privacy benefits.
  - Avoid claims that suggest true audio-only/background/native integration.
- Dashboard:
  - Improve playlist cards: better thumbnail fallback, hover states, stronger metadata hierarchy.
  - Better empty state with “Import playlist” and optional “Try sample playlist” CTA.
  - Add clearer import/sync/delete loading states.
- Playlist page:
  - Merge current “Now Playing” information into a cohesive media deck.
  - Reduce border/card clutter.
  - Improve mobile layout: player first, controls second, collapsible queue third.

Likely files:

- `src/app/page.tsx`
- `src/app/dashboard/page.tsx`
- `src/app/playlist/[id]/page.tsx`
- `src/components/playlist/PlaylistCard.tsx`
- `src/components/playlist/VideoPlayer.tsx`
- `src/components/playlist/ShuffleControls.tsx`
- `src/components/playlist/PlaylistQueue.tsx`
- `src/app/globals.css`

Success criteria:

- App feels cohesive across landing/dashboard/player.
- Empty, loading, error, and active playback states are visually polished.
- No misleading feature claims.

---

### Milestone 2 — Simplify Shuffle to Normal + Smart

Goal: reduce cognitive load and make shuffle behavior honest.

Chosen direction:

- Expose two primary options:
  - **Normal Shuffle**: current random/Fisher-Yates behavior.
  - **Smart Shuffle**: improved spacing/balancing behavior.
- Remove or hide UI for:
  - `DISCOVERY`
  - `ENERGY`
- Internally either:
  - reduce `ShufflePreset` to `"RANDOM" | "SMART"`, or
  - keep legacy values temporarily only for migration/backward compatibility, but do not expose them.

Smart Shuffle should be explainable:

- Avoid adjacent same-channel or same-artist videos where possible.
- Optionally factor local play history later, but do not call it “Discovery” unless it is actually history-aware.
- If play history is added, keep the label simple: “Smart uses your local play history and spacing rules.”

UI changes:

- Replace the current dropdown with a simple two-option segmented control.
- Use labels like:
  - `Normal`
  - `Smart`
- Add small helper text or tooltip:
  - Normal: “Pure random order.”
  - Smart: “Reduces repeated channels/artists.”

Likely files:

- `src/components/playlist/ShuffleControls.tsx`
- `src/app/playlist/[id]/page.tsx`
- `src/lib/shuffle/shuffle-service.ts`
- `src/types/playlist.ts`
- `tests/unit/shuffle-service.test.ts`

Success criteria:

- Only two shuffle choices are visible.
- No exposed duplicate/fake modes.
- Existing normal shuffle behavior remains available.
- Smart behavior remains testable and explainable.

---

### Milestone 3 — Queue Upgrades

Goal: make long shuffled queues easier to understand and manipulate.

MVP queue improvements:

1. **Auto-scroll current track into view**
   - Watch `currentIndex`.
   - Scroll active item into center view on track changes.
   - Avoid scroll fights by suppressing auto-scroll while user recently scrolled manually.

2. **Stronger active track state**
   - Add a left accent bar or animated equalizer icon.
   - Improve contrast for active title/channel.
   - Dim non-active rows slightly.

3. **Queue count and position**
   - Show `currentIndex + 1 / queue.length` near queue heading.
   - Make it obvious where the listener is in the queue.

4. **Useful row actions**
   - “Play next”.
   - “Remove from queue”.
   - “Move up/down” as an accessible first pass.
   - Optional drag-and-drop later.

5. **Virtualization for large playlists**
   - Recommended dependency: `@tanstack/react-virtual`.
   - Use if queue rendering becomes costly for 500–5,000 item playlists.

Optional later enhancement:

- Drag-and-drop reordering with `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities`.
- Do this after simpler accessible move up/down actions unless drag-and-drop is explicitly prioritized.

Likely files:

- `src/components/playlist/PlaylistQueue.tsx`
- `src/stores/player-store.ts`
- `src/app/playlist/[id]/page.tsx`

Store changes likely needed:

- `removeFromQueue(index)`
- `moveQueueItem(fromIndex, toIndex)`
- `playNextFromQueue(index)` or equivalent insert/reorder helper

Success criteria:

- Current track is always easy to find.
- Users can adjust an imperfect shuffle without reshuffling everything.
- Large queues remain responsive.

---

### Milestone 4 — Keyboard Shortcut Help

Goal: make existing power-user controls discoverable.

Current shortcuts:

- `K` / `Space`: play-pause.
- `J`: previous/restart depending on elapsed time.
- `L`: next.

Plan:

- Add a visible “Keyboard shortcuts” button near the player controls, likely with a keyboard or `?` icon.
- Add `?` / `Shift + /` shortcut to open a dialog.
- Use existing shadcn `Dialog` component.
- Show shortcut rows with keycaps and descriptions.
- Mention that native macOS media keys are browser/iframe-dependent and not guaranteed.

Potential shortcut additions:

- `S`: re-shuffle current mode.
- `M`: toggle Focus Audio UI.
- `Q`: focus/open queue panel on mobile.

Accessibility:

- Dialog must be reachable by mouse/touch and keyboard.
- Do not trap global shortcuts when input/textarea/dialog fields are focused.

Likely files:

- New `src/components/playlist/KeyboardShortcutsDialog.tsx`
- `src/components/playlist/VideoPlayer.tsx`
- `src/app/playlist/[id]/page.tsx`
- `src/components/playlist/ShuffleControls.tsx`

Success criteria:

- Users can discover all shortcuts without documentation.
- Shortcut behavior is consistent and does not interfere with typing.

---

### Milestone 5 — No Thumbnail Mode

Goal: let users reduce visual noise and remote image loading in app UI.

Behavior:

- Add a preference: `hideThumbnails`.
- When enabled:
  - Playlist cards use gradient/icon placeholders instead of thumbnails.
  - Queue rows use compact icons or initials instead of thumbnails.
  - Now-playing card uses typography, iconography, and ambient gradients instead of thumbnail art.
- This does **not** prevent the YouTube iframe from loading its own video/player UI.

Persistence:

- Persist preference in a small UI preferences store, e.g. `useUiPreferencesStore`, or extend player store if scope is kept small.
- Prefer a separate UI/preferences store if more preferences are expected.

Likely files:

- New `src/stores/ui-preferences-store.ts` or equivalent.
- `src/components/playlist/PlaylistCard.tsx`
- `src/components/playlist/PlaylistQueue.tsx`
- `src/app/playlist/[id]/page.tsx`

Success criteria:

- Users can browse/play with no app-rendered thumbnails.
- UI remains attractive through placeholders and gradients.
- Preference survives reload.

---

### Milestone 6 — Focus Audio UI / Minimal Visuals Mode

Goal: provide a music-first player mode while staying YouTube-compliant.

Important constraint:

- This is **not** true audio-only playback.
- Keep the YouTube iframe/player rendered and visible enough to satisfy YouTube/player requirements.
- Avoid `display: none`, `visibility: hidden`, zero-size, offscreen-only playback, or fully opaque overlays that make the player inaccessible.

Behavior:

- Add `focusMode` preference.
- In Focus Mode:
  - Show a calm now-playing layout with title, channel, progress-like metadata if available, and controls.
  - Collapse the queue into a compact side/bottom panel.
  - Reduce thumbnails if `hideThumbnails` is also enabled.
  - Keep a smaller but visible YouTube player area, ideally at or above 200×200.
  - Use copy like “Minimal visuals” or “Focus mode,” not “audio only.”

Possible layouts:

1. **Desktop**
   - Left: now-playing/info/control deck.
   - Right: compact queue.
   - Small visible YouTube player tile tucked into the deck.

2. **Mobile**
   - Top: compact visible YouTube player.
   - Middle: now-playing controls.
   - Bottom: collapsible queue drawer.

Likely files:

- `src/app/playlist/[id]/page.tsx`
- `src/components/playlist/VideoPlayer.tsx`
- `src/components/playlist/ShuffleControls.tsx`
- `src/components/playlist/PlaylistQueue.tsx`
- UI preferences store.

Success criteria:

- Users can switch into a calmer music-first view.
- The YouTube player remains available and compliant.
- No user-facing claims imply true audio-only YouTube playback.

---

### Milestone 7 — Ambient Player Polish

Goal: make the player feel alive and tied to the current track.

Preferred approach:

- Start with CSS-based ambient background using the thumbnail image as a blurred, low-opacity background layer.
- This avoids canvas/CORS failures that can happen when extracting colors from cross-origin thumbnail images.

Fallbacks:

- If thumbnails are hidden or unavailable, use deterministic gradients from title/channel hash.
- If later validated, optional dependency `fast-average-color` can extract color from thumbnails, but only if CORS behavior is reliable for YouTube thumbnail URLs.

Visual treatment:

- Soft blurred radial gradient behind media deck.
- Respect dark/light theme.
- Reduce opacity in Focus Mode.
- Disable or simplify under `prefers-reduced-motion` if animation is added.

Likely files:

- `src/app/playlist/[id]/page.tsx`
- `src/components/playlist/VideoPlayer.tsx`
- `src/app/globals.css`
- Optional utility: `src/lib/ambient.ts`

Success criteria:

- Current track changes create a subtle visual change.
- No layout shift or performance degradation.
- Works with no-thumbnail mode.

## Dependency Recommendations

Allowed, but keep focused:

- Recommended if queue is large: `@tanstack/react-virtual` for queue virtualization.
- Optional later: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` for drag-and-drop queue reordering.
- Optional only after CORS validation: `fast-average-color` for thumbnail color extraction.

Avoid adding dependencies for:

- Basic shortcut dialog.
- Basic segmented shuffle control.
- Basic no-thumbnail placeholders.
- Basic ambient CSS background.

## Implementation Order

Recommended order for implementation after this plan is approved:

1. Visual foundation and truthful copy.
2. Shuffle simplification to Normal + Smart.
3. Queue active state + auto-scroll + position count.
4. Shortcut help dialog.
5. No-thumbnail preference.
6. Focus Audio UI.
7. Ambient polish.
8. Queue virtualization / drag-and-drop if needed.

## Testing and Validation Plan

Automated checks:

- `npm run lint`
- `npm test`
- Add/update unit tests for shuffle changes.
- Add store tests if queue mutation helpers are added.

Manual validation:

- Import a playlist and open `/playlist/:id`.
- Switch Normal/Smart and confirm only two modes appear.
- Verify queue auto-scroll and active state.
- Open shortcut dialog by button and `?`.
- Toggle no-thumbnail mode and reload.
- Toggle Focus Mode on desktop/mobile widths.
- Confirm YouTube iframe remains visible/rendered and playback still works.
- Confirm ambient polish works with thumbnails, without thumbnails, and with missing thumbnails.

Accessibility validation:

- Keyboard-only navigation through player controls, queue actions, and shortcut dialog.
- Screen-reader labels for icon buttons.
- Focus states visible.
- Respect `prefers-reduced-motion` for animated ambient/equalizer effects.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| YouTube iframe cannot be true audio-only | Use “Focus Audio UI” wording and keep iframe visible/rendered. |
| Hidden/minimized iframe may break playback or violate player expectations | Keep iframe at a compliant visible size; avoid zero-size/offscreen playback. |
| Smart shuffle becomes vague | Define Smart rules clearly and test them. |
| Queue auto-scroll fights user scrolling | Suppress auto-scroll briefly after manual queue scroll. |
| Large queues cause render jank | Add virtualization when queue size exceeds a practical threshold. |
| Ambient color extraction fails due to CORS | Use CSS blurred image or deterministic gradients first. |
| Removing modes breaks persisted/legacy state | Add a migration/default fallback from removed presets to `RANDOM` or `SMART`. |

## Open Follow-Ups Before Implementation

- Decide exact labels: “Normal” vs “Random” for the existing random shuffle behavior.
- Decide whether Smart should initially remain channel/artist spacing only or also use local play history.
- Decide whether queue drag-and-drop belongs in first implementation or a later pass.
- Confirm if “Try sample playlist” is desired for the empty dashboard state.
