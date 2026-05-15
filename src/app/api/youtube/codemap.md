# src/app/api/youtube/

## Responsibility

Namespace for YouTube-related server route handlers. Currently contains `playlist/route.ts` only.

## Design

- Filesystem route grouping for future YouTube endpoints.
- Keeps third-party API concerns separate from other possible internal APIs.

## Flow

No handler exists at this segment; request handling starts in `playlist/route.ts`.

## Integration

- Parent namespace for [`playlist/codemap.md`](playlist/codemap.md).
