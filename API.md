# API Notes

The previous tRPC SaaS API was removed.

Current app behavior is local-first with one optional backend endpoint for YouTube proxying.

## Route: `GET /api/youtube/playlist`

Fetches normalized playlist + video data from YouTube Data API using server-side `YOUTUBE_API_KEY`.

### Query params

- `list` (preferred) or `playlistId`

### Success response

Returns `YouTubePlaylistData` shape used by the frontend importer.

### Errors

- `400` invalid/missing parameters
- `404` playlist not found
- `422` playlist too large for configured limits
- `429` quota/rate-limit style upstream failures
- `500` internal error
