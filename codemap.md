# Repository Atlas: TubeShuffle

## Project Responsibility

TubeShuffle is a local-first YouTube playlist shuffler built with Next.js App Router, React, Zustand, TanStack Query, Tailwind, and shadcn/Radix primitives. Users import public YouTube playlists, store them in browser IndexedDB, shuffle videos with multiple presets, and play them through the YouTube IFrame API without accounts or a backend database.

## System Entry Points

| Entry point | Responsibility |
| --- | --- |
| `src/app/page.tsx` | Landing page with marketing copy, feature cards, FAQ, and dashboard CTA. |
| `src/app/dashboard/page.tsx` | Playlist library: list local playlists, import, sync, delete. |
| `src/app/playlist/[id]/page.tsx` | Core shuffle/player experience for a stored local playlist UUID. |
| `src/app/api/youtube/playlist/route.ts` | Server-side YouTube Data API proxy using `YOUTUBE_API_KEY`. |
| `src/components/providers.tsx` | Client provider boundary for TanStack Query and Sonner toasts. |
| `src/stores/playlist-store.ts` | Repository facade for playlist import/sync/delete/history. |
| `src/stores/player-store.ts` | Persisted playback queue and transport state. |
| `src/lib/storage/index.ts` | IndexedDB persistence API over playlists, videos, play history, and meta. |
| `src/lib/shuffle/shuffle-service.ts` | Pure shuffle algorithms and preset dispatcher. |
| `package.json` | Next.js scripts: `dev`, `build`, `start`, `lint`, `test`. |

## User-Visible Surfaces

| Surface | Current functionality |
| --- | --- |
| `/` | Dark ambient landing page with hero player mock, anti-SaaS value props, bento features, shuffle explanation, and FAQ. |
| `/dashboard` | Dark ambient playlist library for saved IndexedDB playlists; supports import, sync, delete, and open playlist. |
| `/playlist/:id` | Dark ambient player shell that loads one local playlist, auto-shuffles on first visit, plays embedded YouTube videos, shows a viewport-height queue, supports keyboard/media controls, Focus/No Artwork/Stage preferences, shuffle modes, and exclude-watched filtering. |
| `GET /api/youtube/playlist?playlistId=...` | Fetches playlist metadata/items/details from YouTube, filters unavailable videos, and returns `YouTubePlaylistData`. |

## Core Architecture

```text
User action
  -> Client route/page (`src/app/**`)
    -> Feature component (`src/components/**`)
      -> React Query mutation/query or Zustand action
        -> playlistRepository / playerStore
          -> YouTube provider or IndexedDB storage
            -> Browser state updates + toast/route/UI refresh
```

Primary state stores:

- **IndexedDB** (`tubeshuffle_local`): durable local playlists, videos, play history, migration metadata.
- **Zustand persisted state** (`player-state`): current queue, current index/video, playlist context, volume.
- **TanStack Query**: client cache for playlist lists and individual playlist bundles.

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
| --- | --- | --- |
| `src/` | Source root tying app routes, components, domain utilities, stores, and types together. | [src/codemap.md](src/codemap.md) |
| `src/app/` | Next.js App Router pages, layouts, metadata, SEO helpers, and API route handlers. | [src/app/codemap.md](src/app/codemap.md) |
| `src/app/dashboard/` | Playlist library dashboard. | [src/app/dashboard/codemap.md](src/app/dashboard/codemap.md) |
| `src/app/playlist/` | Playlist route namespace. | [src/app/playlist/codemap.md](src/app/playlist/codemap.md) |
| `src/app/playlist/[id]/` | Single-playlist player route. | [src/app/playlist/[id]/codemap.md](src/app/playlist/%5Bid%5D/codemap.md) |
| `src/app/api/` | Next.js server route handler namespace. | [src/app/api/codemap.md](src/app/api/codemap.md) |
| `src/app/api/youtube/` | YouTube API route grouping. | [src/app/api/youtube/codemap.md](src/app/api/youtube/codemap.md) |
| `src/app/api/youtube/playlist/` | YouTube playlist proxy endpoint. | [src/app/api/youtube/playlist/codemap.md](src/app/api/youtube/playlist/codemap.md) |
| `src/components/` | Presentation layer and reusable UI primitives. | [src/components/codemap.md](src/components/codemap.md) |
| `src/components/layouts/` | Navbar and footer app chrome. | [src/components/layouts/codemap.md](src/components/layouts/codemap.md) |
| `src/components/playlist/` | Playlist import, cards, shuffle controls, queue, and video player. | [src/components/playlist/codemap.md](src/components/playlist/codemap.md) |
| `src/components/ui/` | shadcn/Radix primitive component wrappers. | [src/components/ui/codemap.md](src/components/ui/codemap.md) |
| `src/lib/` | Shared utilities plus service/storage/shuffle subdomains. | [src/lib/codemap.md](src/lib/codemap.md) |
| `src/lib/services/` | YouTube data fetching provider abstraction. | [src/lib/services/codemap.md](src/lib/services/codemap.md) |
| `src/lib/storage/` | IndexedDB schema, access functions, migration metadata. | [src/lib/storage/codemap.md](src/lib/storage/codemap.md) |
| `src/lib/shuffle/` | Shuffle strategy algorithms. | [src/lib/shuffle/codemap.md](src/lib/shuffle/codemap.md) |
| `src/stores/` | Zustand stores and playlist repository facade. | [src/stores/codemap.md](src/stores/codemap.md) |
| `src/types/` | Shared domain and DTO TypeScript types. | [src/types/codemap.md](src/types/codemap.md) |

## Notable Current Constraints

- App has no auth, no server database, and no cross-device sync by design.
- Shuffle UI/types expose `RANDOM`/Normal and `SMART`; Smart is now a metadata-inferred energy-flow shuffle rather than artist/channel spacing.
- Playlist pages include daily YouTube suggestion discovery: five cached suggestions per playlist/browser/day via the server-side YouTube API proxy.
- Player UI now includes persisted Focus Mode, No Artwork, and Stage preferences; Focus/Stage overlays cover the rendered video area or app window while keeping the YouTube iframe present/rendered underneath.
- `BatchImportModal` exists but is not currently mounted by dashboard routes.
- Deleting a playlist cascades playlists/videos but does not currently remove matching play-history rows.
