# src/app/dashboard/

## Responsibility

Playlist library route at `/dashboard`. Lists playlists saved in the browser, opens the import dialog, triggers playlist sync, and deletes playlists.

## Design

- Client component using React Query for playlist list reads and mutations.
- `playlistRepository` abstracts IndexedDB and YouTube fetches from the route.
- Dynamic import of `Navbar` with SSR disabled to avoid hydration mismatches in browser-oriented chrome.
- Dark ambient media-library styling with loading skeleton grid, empty state card, populated playlist grid, and glass import/action surfaces.

## Flow

```text
/dashboard mounts
  -> useQuery(["playlists"]) -> playlistRepository.listPlaylists()
    -> browserStorage.listPlaylists() -> IndexedDB

Import button
  -> ImportPlaylistModal
    -> playlistRepository.importPlaylistFromUrl(url)
      -> YouTube provider -> browserStorage.savePlaylist()
      -> invalidate ["playlists"]

Card actions
  -> Sync: playlistRepository.syncPlaylist(id) -> refetch YouTube -> save -> invalidate
  -> Delete: playlistRepository.deletePlaylist(id) -> IndexedDB delete -> invalidate
```

## Integration

- Renders `PlaylistCard` and `ImportPlaylistModal` from `components/playlist`.
- Uses `Button`, `Card`, and `Skeleton` UI primitives.
- Uses `sonner` for mutation feedback.
- Dashboard metadata/layout disables indexing via `dashboard/layout.tsx`.
