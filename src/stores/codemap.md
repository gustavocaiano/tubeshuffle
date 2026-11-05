# src/stores/

## Responsibility

Reactive state and repository layer. Provides the playlist repository facade used by routes/components and the persisted playback queue store used by the player experience.

## Design

### `playlist-store.ts`

- Exports `playlistRepository` object rather than requiring components to call services/storage directly.
- `importPlaylistFromUrl()` captures the storage generation, validates the URL/ID, fetches metadata and adds only a new playlist. Sync and re-import/refresh of existing playlists are blocked to avoid ambiguous occurrence/history remapping.
- New local video occurrences get independent UUIDs; repeated YouTube IDs retain separate occurrences. Existing stored IDs/history are preserved without inferred continuity.
- `getCompletedVideoIds()` delegates to `browserStorage.getCompletedVideoIds()` for exclude-watched filtering; the repository does not own an IndexedDB handle or transaction. The storage operation waits for transaction completion and preserves existing history semantics.
- Also exports a small UI store for import-modal/selected-playlist flags; current dashboard uses local `useState` instead.

### `player-store.ts`

- Zustand store with `persist` middleware under localStorage key `player-state`.
- Holds queue, current index/video, `isPlaying`, volume, local playlist context, and playback actions; next/previous/explicit track actions set playback active for the target track.
- `partialize` persists queue/current video/playlist context/volume, but not transient `isPlaying`.
- Clamps volume between 0 and 100.

### `playback-store.ts`

- Runtime-only position/duration and seek/previous callbacks published by `VideoPlayer`.
- Shares the clock and controls across page/Stage without persisting progress.
- Holds optional media-key connect/disconnect actions and connection status; cleaned up on player unmount.

## Flow

```text
Import URL
  -> playlistRepository.importPlaylistFromUrl(url)
    -> extractPlaylistId(url)
    -> fetchPlaylistData(youtubeId)
    -> browserStorage.savePlaylist({ playlist, videos })

Sync
  -> get existing local bundle
  -> refetch by stored youtubeId
  -> replace videos and update updatedAt

Playback
  -> setQueue(videos, playlistId, title)
  -> playVideo/playNext/playPrevious/togglePlay/setPlaying
  -> persisted queue restored on reload
```

## Integration

- `playlistRepository` is consumed by dashboard, playlist page, import modals, and playlist cards.
- `player-store` is consumed by `VideoPlayer`, `ShuffleControls`, `PlaylistQueue`, and playlist page.
- `ui-preferences-store` persists Focus Mode, No Artwork, and Stage full-window player preferences.
- Depends on `browserStorage`, YouTube service provider, `extractPlaylistId`, and playlist domain types.
