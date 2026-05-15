# src/stores/

## Responsibility

Reactive state and repository layer. Provides the playlist repository facade used by routes/components and the persisted playback queue store used by the player experience.

## Design

### `playlist-store.ts`

- Exports `playlistRepository` object rather than requiring components to call services/storage directly.
- `importPlaylistFromUrl()` validates/extracts playlist ID, fetches YouTube data, upserts local entities, and preserves `createdAt` on sync/import of an existing YouTube playlist.
- Local video IDs are composite: `${playlistId}:${youtubeVideoId}`.
- `getCompletedVideoIds()` reads play-history rows for exclude-watched filtering.
- Also exports a small UI store for import-modal/selected-playlist flags; current dashboard uses local `useState` instead.

### `player-store.ts`

- Zustand store with `persist` middleware under localStorage key `player-state`.
- Holds queue, current index/video, `isPlaying`, volume, local playlist context, and playback actions; next/previous/explicit track actions set playback active for the target track.
- `partialize` persists queue/current video/playlist context/volume, but not transient `isPlaying`.
- Clamps volume between 0 and 100.

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
- Depends on `browserStorage`, YouTube service provider, `extractPlaylistId`, and playlist domain types.
