# src/components/playlist/

## Responsibility

Feature UI for TubeShuffle's core playlist experience: importing playlists, displaying saved playlist cards, controlling shuffle/playback, rendering the queue, embedding the YouTube player, and surfacing daily playlist suggestions.

## Design

- **Mutation-driven imports**: `ImportPlaylistModal` and `BatchImportModal` call `playlistRepository.importPlaylistFromUrl()` and report progress with Sonner/to local state.
- **Store-driven player UI**: `VideoPlayer`, `PlaylistQueue`, and `ShuffleControls` read/write `usePlayerStore`.
- **Dark ambient media UI**: playlist cards, import dialogs, shuffle controls, keyboard shortcuts, and queue actions use glassy dark surfaces matching the landing page.
- **YouTube IFrame bridge**: `VideoPlayer` dynamically loads `https://www.youtube.com/iframe_api`, creates `YT.Player`, and syncs state to Zustand.
- **UI preference store**: player-facing components consume `useUiPreferencesStore` for Focus Mode and No Artwork behavior.
- **Stage player mode**: playlist page can switch to a fixed full-window player overlay with hover-only left/center/right transport zones while keeping the embedded YouTube player mounted underneath.
- **Queue management**: `PlaylistQueue` supports active-track auto-scroll, optional fill-height layout, play-next, move up/down, and remove actions through `usePlayerStore` queue helpers.
- **Daily suggestions**: `DailySuggestions` lazily fetches/caches five YouTube suggestions per playlist/browser/day and can play or queue them locally.
- **Media Session integration**: playback metadata and play/pause/previous/next handlers map to OS/media keys; skip actions force playback on the selected track.
- **Keyboard shortcuts**: `K`/space toggles playback, `J` restarts/previous, `L` goes next, `Esc` exits Stage player; input/textarea targets are ignored.

## Flow

```text
Import modal submit
  -> playlistRepository.importPlaylistFromUrl(url)
  -> YouTube provider -> IndexedDB save -> success/error toast

Playlist card action
  -> open `/playlist/{localId}` or call sync/delete callbacks from dashboard

Player route shuffles videos
  -> usePlayerStore.setQueue(...)
  -> VideoPlayer loads currentVideo.youtubeId
  -> YouTube state changes update play state and advance queue

Queue click
  -> usePlayerStore.playVideo(index)
  -> VideoPlayer loadVideoById(new youtubeId)
```

## Integration

- `PlaylistCard` is consumed by `/dashboard`.
- `VideoPlayer`, `ShuffleControls`, `KeyboardShortcutsDialog`, `PlaylistQueue`, and `DailySuggestions` are consumed by `/playlist/[id]`.
- Uses `playlistRepository`, `usePlayerStore`, Sonner, Next Link/Image, lucide icons, and UI primitives.
- `BatchImportModal` is implemented but currently unused by the active dashboard page.
