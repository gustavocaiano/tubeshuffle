# src/lib/

## Responsibility

Shared domain library. Contains general utilities (`utils.ts`) plus dedicated subdomains for YouTube services, IndexedDB storage, and shuffle algorithms.

## Design

- `utils.ts` provides pure helpers: `cn`, `extractPlaylistId`, `formatDuration`, `parseIsoDuration`, and truncation helpers.
- `services/` encapsulates YouTube data transport and mode selection.
- `storage/` encapsulates IndexedDB schema and CRUD operations.
- `shuffle/` contains pure strategy functions without React/browser dependencies.

## Flow

```text
Input URL -> extractPlaylistId -> playlistRepository -> YouTube provider
YouTube ISO duration -> parseIsoDuration -> numeric seconds
Video seconds -> formatDuration -> UI label
Tailwind classes -> cn -> merged class string
```

## Integration

- `utils.ts` is used by UI primitives, YouTube API routes/services, and playlist imports.
- Subdirectories are consumed primarily by `stores/` and `app/playlist/[id]`.
