# src/lib/storage/

## Responsibility

Browser IndexedDB persistence layer. Stores playlists, videos, play history, and schema/migration metadata for the local-first app.

## Design

- Database: `tubeshuffler_local`, version `1`.
- Object stores: `playlists`, `videos`, `playHistory`, `meta`.
- Indexes: playlist `youtubeId`/`updatedAt`; video `playlistId`/`youtubeId`/`playlistPosition`; play-history `playlistId`/`videoId`/`watchedAt`.
- `index.ts` wraps IndexedDB request/transaction callbacks into promises.
- `browserStorage` exports an ORM-like facade for initialization, metadata, playlist CRUD, and play events.
- `storage-migrations.ts` records schema version and legacy-localStorage migration flags.

## Flow

```text
initializeStorage()
  -> openBrowserDb()
  -> onupgradeneeded create stores/indexes
  -> ensureStorageMigrationMeta()

savePlaylist(bundle)
  -> put playlist
  -> delete existing videos for playlistId
  -> put replacement videos

getPlaylist(id)
  -> get playlist
  -> getAll videos by playlistId
  -> sort by position

recordPlayEvent(input)
  -> normalize id/watchedAt
  -> put playHistory row
```

## Integration

- Consumed by `playlistRepository` in `src/stores/playlist-store.ts`.
- Stores `LocalPlaylist`, `LocalVideo`, and `LocalPlayEvent` from `src/types/playlist.ts`.
- Important current constraint: `deleteLocalPlaylist()` deletes playlist/videos but does not delete matching play-history records.
