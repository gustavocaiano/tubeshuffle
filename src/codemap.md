# src/

## Responsibility

Application source root. Organizes TubeShuffler into Next.js route handlers/pages (`app/`), UI components (`components/`), domain utilities/services/storage/shuffle logic (`lib/`), reactive stores (`stores/`), and shared type contracts (`types/`).

## Design

- **Layered client-first architecture**: route/page components orchestrate UI, stores, and services; storage remains in browser IndexedDB.
- **Repository facade**: `playlistRepository` hides fetch/storage details from pages and components.
- **Pure domain functions**: shuffle and utility helpers have no React or browser side effects.
- **Primitive UI library**: shadcn/Radix wrappers in `components/ui` keep visual semantics centralized.
- **Client provider boundary**: `components/providers.tsx` creates a single QueryClient and toast container.

## Flow

```text
Route/page -> feature component -> React Query/Zustand -> repository/service/storage -> UI refresh
```

Playlist import flow: URL input -> `extractPlaylistId` -> YouTube provider -> IndexedDB save -> React Query invalidation -> dashboard grid update.

Playback flow: playlist route -> IndexedDB bundle -> shuffle service -> `player-store` queue -> `VideoPlayer` YouTube IFrame -> play-history event on end.

## Integration

- `app/` consumes `components/`, `stores/`, `lib/shuffle`, and metadata helpers.
- `components/playlist/` consumes `stores`, `lib/services`, and `types`.
- `stores/` consumes `lib/storage`, `lib/services`, and `lib/utils`.
- `lib/services/` integrates with YouTube Data API directly or through `/api/youtube/playlist`.
- `types/playlist.ts` is the shared schema across services, storage, stores, and UI.
