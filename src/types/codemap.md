# src/types/

## Responsibility

Shared TypeScript contracts for remote YouTube DTOs, local IndexedDB entities, shuffle presets, API wrappers, and generic pagination.

## Design

- `YouTubePlaylistData` / `YouTubeVideoData` describe service/API responses.
- `LocalPlaylist`, `LocalVideo`, `LocalPlayEvent`, and `LocalPlayEventInput` describe durable browser storage records.
- `ShufflePreset` is a closed union: `"RANDOM" | "SMART"`.
- `ShuffledVideo` captures the reduced queue-friendly video shape, though player-store currently defines its own local `VideoItem` interface.
- `ApiResponse<T>` and `PaginatedResponse<T>` are generic API shapes available for future endpoints.

## Flow

```text
YouTube API/raw service data
  -> YouTubePlaylistData / YouTubeVideoData
  -> playlistRepository maps into LocalPlaylist / LocalVideo
  -> storage persists local entities
  -> player route maps videos into queue items
  -> play completion writes LocalPlayEvent
```

## Integration

- Imported by YouTube services and API route handlers.
- Imported by storage and playlist repository modules.
- Imported by shuffle service and player route for preset typing.

## Business Rules Encoded

- Separate local IDs from upstream YouTube IDs.
- Optional metadata fields account for unavailable YouTube data.
- Play-event input can omit `id` and `watchedAt`; storage normalizes them.
- Playlist/video timestamps are ISO strings.
