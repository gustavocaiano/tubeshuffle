# src/app/playlist/[id]/

## Responsibility

Core player route at `/playlist/:id`, where `:id` is the local playlist UUID stored in IndexedDB. Loads a playlist bundle, auto-shuffles it when entering a new playlist, renders the YouTube player and queue, and records completed videos.

## Design

- Client route using `useParams`, React Query, mutations, local UI state, and Zustand player state.
- Auto-shuffle guard avoids replacing an existing queue for the same playlist.
- `shuffleVideos()` provides `RANDOM`/Normal and `SMART` energy-flow presets.
- Persists Focus Mode, No Artwork, and Stage full-window player preferences through `useUiPreferencesStore` for simplified playback presentation.
- Renders an ambient player deck with explicit Video/Focus choices, an Artwork preference, shared seeking/transport controls, shortcut/media-key help, and a viewport-height queue. Stage uses a full-window accessible dialog with visible controls and a progress bar; no-art views omit artwork placeholders.
- Renders daily playlist suggestions below the player/queue grid; suggestions are cached per browser day, can be refreshed once per day, and can be played/queued locally.
- `excludeWatched` uses persisted completed play events to filter videos before shuffling.
- YouTube playback is delegated to `VideoPlayer`; queue rendering to `PlaylistQueue`; controls to `ShuffleControls`.

## Flow

```text
/playlist/{localPlaylistId}
  -> useQuery(["playlist", id]) -> playlistRepository.getPlaylist(id)
    -> IndexedDB playlist + ordered videos
  -> first/new playlist effect -> handleShuffle("RANDOM")
    -> optional completed-video filter
    -> shuffleVideos(videos, preset, [])
    -> usePlayerStore.setQueue(...)
  -> VideoPlayer mirrors the queue into the YouTube IFrame playlist
  -> native selection updates currentVideo/currentIndex in the app
  -> YouTube ENDED event -> recordPlay(endedVideo, completed=true)
  -> YouTube advances itself; guarded recovery only if it remains ended
```

## Integration

- Consumes `playlistRepository` for playlist reads and play-history writes.
- Consumes `usePlayerStore` for queue/current video state.
- Consumes `shuffle-service.ts` for queue ordering.
- Renders `Navbar`, `VideoPlayer`, `ShuffleControls`, `PlaylistQueue`, `Button`, `Skeleton`, and `Badge`.
- Links back to `/dashboard` and out to `https://youtube.com/playlist?list={youtubeId}`.
