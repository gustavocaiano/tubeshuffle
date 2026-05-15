# src/lib/services/

## Responsibility

YouTube playlist data service layer. Provides a single `fetchPlaylistData(playlistId)` entry point that selects between direct browser calls and the internal proxy route.

## Design

- `youtube-provider.ts` reads `NEXT_PUBLIC_YOUTUBE_API_MODE`; anything other than `browser` defaults to `proxy`.
- `youtube-proxy.ts` calls `/api/youtube/playlist?playlistId=...` and supports both raw `YouTubePlaylistData` responses and legacy `{ data, error }` envelopes.
- `youtube-browser.ts` performs direct YouTube Data API v3 calls from the client using `NEXT_PUBLIC_YOUTUBE_API_KEY`.
- Both modes produce the shared `YouTubePlaylistData` DTO.

## Flow

```text
playlistRepository.import/sync
  -> fetchPlaylistData(youtubePlaylistId)
    -> mode=proxy: GET /api/youtube/playlist?playlistId=...
    -> mode=browser: fetch YouTube REST API directly
  -> YouTubePlaylistData
```

## Integration

- Consumed by `src/stores/playlist-store.ts`.
- Proxy mode depends on `src/app/api/youtube/playlist/route.ts` and server `YOUTUBE_API_KEY`.
- Browser mode depends on public `NEXT_PUBLIC_YOUTUBE_API_KEY` and referrer restrictions.
- Shares response types from `src/types/playlist.ts`.
