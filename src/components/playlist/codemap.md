# src/components/playlist/

## Responsibility

Feature UI for TubeShuffle's core playlist experience: importing playlists, displaying saved playlist cards, controlling shuffle/playback, rendering the queue, embedding the YouTube player, and surfacing daily playlist suggestions.

## Design

- **Mutation-driven imports**: `ImportPlaylistModal` and `BatchImportModal` call `playlistRepository.importPlaylistFromUrl()` and report progress with Sonner/to local state.
- **Store-driven player UI**: `VideoPlayer`, `PlaylistQueue`, and `ShuffleControls` read/write `usePlayerStore`.
- **Dark ambient media UI**: playlist cards, import dialogs, shuffle controls, keyboard shortcuts, and queue actions use glassy dark surfaces matching the landing page.
- **YouTube IFrame bridge**: `VideoPlayer` dynamically loads `https://www.youtube.com/iframe_api` and creates `YT.Player`. `YouTubeQueueController` mirrors a moving 100-track window through `loadPlaylist`/`cuePlaylist`, maps native indexes to the complete app queue, defers edits that retain the active occurrence until the next track change without reloading its media, and resolves native previous/next against the latest Zustand order. Natural ends are recorded once; native advancement has a guarded recovery timer.
- **UI preference store**: player-facing components consume `useUiPreferencesStore` for Focus Mode and No Artwork behavior.
- **Responsive layout**: the page stacks player, queue, then shuffle settings below 1280px; wider viewports use a sticky queue beside the player. View controls adapt to their container width, and suggestions use an auto-fitting card grid.
- **Player views**: `PlayerViewControls` offers Video/Focus choices, an Artwork preference, and a Stage action. `StagePlayer` is a focus-trapped full-window dialog with a fixed header/footer and a separately scrollable track region, keeping transport, seeking, and volume visible even in short viewports. Escape returns focus to the Stage trigger. View switches keep the YouTube instance mounted.
- **Queue management**: `PlaylistQueue` uses a native, keyboard-focusable vertical scroll region, marks the active row with `aria-current`, and scrolls only that region when playback changes. Grid rows reserve a 44px actions column; titles shrink/wrap within the remaining width. Play-next, move up/down, and remove actions use `usePlayerStore` queue helpers.
- **Daily suggestions**: `DailySuggestions` lazily fetches/caches five YouTube suggestions per playlist/browser/day and can play or queue them locally.
- **Shared playback controls**: `PlaybackControls` reads transient `playback-store` progress and seek callbacks; the same progress, transport, and volume controls appear in the page and Stage. Container queries move volume below transport in narrow panels; it remains available on mobile.
- **Media Session integration**: metadata, play/pause, previous/next, absolute seeking, and position state map to browser/OS controls. `KeyboardShortcutsDialog` offers an opt-in silent top-level media connection for iframe routing; see `docs/media-controls.md` for limitations.
- **Iframe lifecycle**: a React-owned host creates a fresh YouTube mount node on initialization; API calls wait for readiness, and blocked autoplay restores a paused UI.
- **Keyboard shortcuts**: `K`/space toggles playback, `J` restarts/previous, `L` goes next, `Esc` exits Stage player; form fields, editable targets, and non-player dialogs are ignored; Space preserves native button activation.

## Flow

```text
Import modal submit
  -> playlistRepository.importPlaylistFromUrl(url)
  -> YouTube provider -> IndexedDB save -> success/error toast

Playlist card action
  -> open `/playlist/{localId}` or call sync/delete callbacks from dashboard

Player route shuffles videos
  -> usePlayerStore.setQueue(...)
  -> VideoPlayer mirrors queue IDs and current index into YouTube
  -> YouTube native selection/state updates the app without issuing a second skip

Queue click
  -> usePlayerStore.playVideo(index)
  -> YouTube playVideoAt(index), or cuePlaylist while paused
```

## Integration

- `PlaylistCard` is consumed by `/dashboard`.
- `VideoPlayer`, `ShuffleControls`, `KeyboardShortcutsDialog`, `PlaylistQueue`, and `DailySuggestions` are consumed by `/playlist/[id]`.
- Uses `playlistRepository`, `usePlayerStore`, Sonner, Next Link/Image, lucide icons, and UI primitives.
- `BatchImportModal` is implemented but currently unused by the active dashboard page.
