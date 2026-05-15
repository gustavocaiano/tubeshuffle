# src/app/api/youtube/playlist/

## Responsibility

Server-side YouTube playlist proxy at `GET /api/youtube/playlist`. Keeps the YouTube Data API key out of client bundles, validates playlist IDs, fetches full playlist data, enriches videos with duration/statistics, and returns `YouTubePlaylistData`.

## Design

- Accepts only `list` or `playlistId` query params; rejects unsupported params.
- Validates IDs with `/^[A-Za-z0-9_-]{10,80}$/`.
- `fetchYouTubeJson<T>()` centralizes upstream fetch/error mapping.
- Playlist items are paginated in 50-item pages with a cap of 100 pages (5,000 videos).
- Video details are batch-fetched from the `videos` endpoint in chunks of 50.
- Deleted/private videos are skipped.

## Flow

```text
GET /api/youtube/playlist?playlistId=...
  -> require YOUTUBE_API_KEY
  -> validate playlist id
  -> fetch playlists(part=snippet,contentDetails)
  -> paginate playlistItems(part=snippet,contentDetails)
  -> skip unavailable videos
  -> batch fetch videos(part=contentDetails,statistics)
  -> patch duration/viewCount/likeCount onto videos
  -> NextResponse.json(YouTubePlaylistData)
```

Error mapping:

- Missing env -> 500 `Server configuration error`.
- Invalid/missing/unsupported query -> 400.
- Upstream/not found -> 404 where applicable.
- YouTube 403 -> 502, 429 -> 429, other upstream failure -> 502.
- Playlist over cap -> 422.

## Integration

- Consumed by `src/lib/services/youtube-proxy.ts`.
- Uses `parseIsoDuration()` from `src/lib/utils.ts`.
- Returns types from `src/types/playlist.ts`.
- Requires `YOUTUBE_API_KEY` in proxy mode.
