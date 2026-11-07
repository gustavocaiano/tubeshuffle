# Repository Atlas: TubeShuffle

## Project Responsibility

TubeShuffle is a local-first YouTube playlist shuffler built with Next.js App Router, React, Zustand, TanStack Query, Tailwind, and shadcn/Radix primitives. Users import public YouTube playlists, store them in browser IndexedDB, shuffle videos with multiple presets, and play them through the YouTube IFrame API with local contents/history and owner-authenticated server APIs for playlist links.

## System Entry Points

| Entry point | Responsibility |
| --- | --- |
| `src/app/page.tsx` | Landing page with marketing copy, feature cards, FAQ, and dashboard CTA. |
| `src/app/dashboard/page.tsx` | Playlist library: confirm/open local storage, list playlists, fresh import, export, delete. |
| `src/app/playlist/[id]/page.tsx` | Core shuffle/player experience for a stored local playlist UUID. |
| `src/app/api/youtube/playlist/route.ts` | Server-side YouTube Data API proxy using `YOUTUBE_API_KEY`. |
| `src/components/providers.tsx` | Client provider boundary for TanStack Query and Sonner toasts. |
| `src/stores/playlist-store.ts` | Repository facade for playlist import/sync/delete/history. |
| `src/stores/player-store.ts` | Persisted playback queue and transport state. |
| `macos/TubeShuffle/App/TubeShuffleApp.swift` | Native library entry; explicit `--playback-lab` or `--ui-fixture`. |
| `src/lib/storage/index.ts` | IndexedDB persistence API over playlists, videos, play history, and meta. |
| `src/lib/shuffle/shuffle-service.ts` | Pure shuffle algorithms and preset dispatcher. |
| `package.json` | Next.js scripts: `dev`, `build`, `start`, `lint`, `test`. |

## User-Visible Surfaces

| Surface | Current functionality |
| --- | --- |
| `/` | Dark ambient landing page with hero player mock, anti-SaaS value props, bento features, shuffle explanation, and FAQ. |
| `/macos` | Native app preview, release-gated ZIP download, requirements, installation and explicit browser-to-Mac transfer guidance. |
| `/dashboard` | Dark ambient playlist library for saved IndexedDB playlists; supports fresh import, delete and open; destructive refresh/re-import is blocked. |
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

- Web owner-authentication and playlist-link APIs now exist under `src/lib/server/` and `src/app/api/`, with SQL/RLS definitions in `supabase/`. Cloud scope is playlist IDs only; production validation/deployment is not implied.
- The macOS website entry reads a reviewed `src/config/macos-release.json` manifest through `src/lib/macos-release.ts`. Its default `null` keeps downloads unavailable; no local ad-hoc candidate is published or selected automatically. Distribution authorization and signed/notarized artifact checks remain separate.
- `macos/` contains the integrated SwiftUI local library, account/API services, transfer preview, SwiftData persistence, local queue sidecar and official-iframe WKWebView player. `App/NativeLibraryView.swift` owns the web-style listening screen and native sheets; `NativePlayerComponents.swift` owns the bounded player/thumbnail queue. Focus shows only a small thumbnail and genuinely hides the retained WKWebView. `NativeUIStyle.swift` holds shared layout/artwork, 80–125% interface zoom commands and window-scoped keyboard handling; the window supports 480-point width. Demo mode uses synthetic data and bundled thumbnails; `NativeUIRenderingTests` captures actual native layouts and checks keyboard/lifecycle behavior with static media fixtures. The old Playback Lab is explicit. Owner/live-service/release acceptance remains open; see `docs/plans/native-macos-app.md`.
- Browser provisioning is integrated through `browser-session.ts`: schema preflight, existing-only startup, explicit one-shot creation, generation-owned transactions and UI subscription. `tests/browser/storage-startup/` exercises shared startup code with build-only fixture targets and guarded disposable contexts; see `docs/plans/browser-storage-phase2.md`.
- Shuffle UI/types expose `RANDOM`/Normal and `SMART`; Smart is now a metadata-inferred energy-flow shuffle rather than artist/channel spacing.
- Playlist pages include daily YouTube suggestion discovery: five cached suggestions per playlist/browser/day via the server-side YouTube API proxy, with one local refresh per day.
- Player UI now includes persisted Focus Mode, No Artwork, and Stage preferences for simplified playback presentation.
- `BatchImportModal` exists but is not currently mounted by dashboard routes.
- Deleting a playlist cascades playlists/videos but does not currently remove matching play-history rows.
