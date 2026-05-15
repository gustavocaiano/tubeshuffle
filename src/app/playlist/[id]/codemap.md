# src/app/playlist/[id]/

## Responsibility

Core player route at `/playlist/:id`, where `:id` is the local playlist UUID stored in IndexedDB. Loads a playlist bundle, auto-shuffles it when entering a new playlist, renders the YouTube player and queue, and records completed videos.

## Design

- Client route using `useParams`, React Query, mutations, local UI state, and Zustand player state.
- Auto-shuffle guard avoids replacing an existing queue for the same playlist.
- `shuffleVideos()` provides the simplified `RANDOM`/Normal and `SMART` presets.
- Persists Focus Mode and No Artwork UI preferences through `useUiPreferencesStore`; Focus Mode overlays the rendered video with an audio-style screen while the YouTube iframe remains present/rendered underneath.
- Renders an ambient now-playing deck, shortcut help, and enhanced queue controls in a queue card that fills the available player column height.
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
  -> VideoPlayer loads current queue item into YouTube IFrame
  -> YouTube ENDED event -> recordPlay(completed=true) + playNext()
```

## Integration

- Consumes `playlistRepository` for playlist reads and play-history writes.
- Consumes `usePlayerStore` for queue/current video state.
- Consumes `shuffle-service.ts` for queue ordering.
- Renders `Navbar`, `VideoPlayer`, `ShuffleControls`, `PlaylistQueue`, `Button`, `Skeleton`, and `Badge`.
- Links back to `/dashboard` and out to `https://youtube.com/playlist?list={youtubeId}`.
