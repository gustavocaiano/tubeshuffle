# src/app/

## Responsibility

Next.js App Router layer. Owns global layout/metadata/CSS, public pages, authenticated-feeling local dashboard, playlist player route, SEO helpers, and server-side API route handlers.

## Design

- **App Router convention**: `layout.tsx`, route `page.tsx` files, dynamic segment `[id]`, metadata helpers `robots.ts` and `sitemap.ts`.
- **Client-page boundaries**: interactive routes use `"use client"` and delegate data reads/writes to React Query, Zustand, and IndexedDB wrappers.
- **Server metadata/layout**: root layout sets metadata, OpenGraph/Twitter, canonical URL, JSON-LD, and global providers.
- **Local-first product model**: no auth route group and no database-backed user identity.

## Flow

```text
HTTP route match
  -> root layout + Providers
    -> page component
      -> React Query query/mutation
        -> playlistRepository / API route / IndexedDB
```

Routes:

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `page.tsx` | Dark ambient marketing page with hero player mock, local-first positioning, feature bento, and FAQ. |
| `/dashboard` | `dashboard/page.tsx` | Dark ambient local playlist manager. |
| `/playlist/:id` | `playlist/[id]/page.tsx` | Dark ambient playlist player for local playlist UUID. |
| `GET /api/youtube/playlist` | `api/youtube/playlist/route.ts` | YouTube Data API proxy. |

## Integration

- Consumes `components/providers.tsx` for QueryClient/Sonner.
- Consumes playlist components, stores, and shuffle service in interactive pages.
- API routes integrate with YouTube Data API and return `YouTubePlaylistData`.
- Uses `NEXT_PUBLIC_APP_URL` for canonical/sitemap metadata and `YOUTUBE_API_KEY` for server proxy mode.
