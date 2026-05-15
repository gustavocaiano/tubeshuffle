# src/app/api/

## Responsibility

Next.js Route Handler namespace for server-side API calls. Currently exposes only the YouTube playlist proxy used by playlist import/sync in proxy mode.

## Design

- App Router `route.ts` functions returning `NextResponse`.
- Per-route validation and error mapping; no shared middleware layer yet.
- Server-only secret access through `process.env.YOUTUBE_API_KEY`.
- Upstream fetches use `cache: "no-store"` for fresh playlist imports.

## Flow

```text
Client service fetches /api/youtube/playlist?playlistId=...
  -> route validates params and env
  -> fetches YouTube playlist metadata/items/video details
  -> maps upstream errors to JSON error responses
  -> returns YouTubePlaylistData
```

## Integration

- Consumed by `src/lib/services/youtube-proxy.ts`.
- Calls `https://www.googleapis.com/youtube/v3`.
- Shares DTO shape from `src/types/playlist.ts` and duration parser from `src/lib/utils.ts`.
