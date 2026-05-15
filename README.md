# TubeShuffle

TubeShuffle is a free, open YouTube playlist shuffler.

It runs as a Next.js app and stores imported playlists in your browser (IndexedDB), so there is no database, account system, or Redis required.

## What it does

- Import a YouTube playlist URL
- Shuffle with Normal and Smart modes
- Play videos with a persistent queue
- Save playlists locally in the browser

## Stack

- Next.js (App Router) + TypeScript
- React Query + Zustand
- Tailwind + shadcn/ui
- Browser IndexedDB for persistence
- Optional Vercel API route for YouTube key proxying

## Local development

1. Install dependencies:

```bash
npm install
```

2. Copy environment template:

```bash
cp .env.example .env
```

3. Set `YOUTUBE_API_KEY` (recommended proxy mode).

4. Start dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## YouTube API key modes

### Proxy mode (recommended)

- Set `NEXT_PUBLIC_YOUTUBE_API_MODE=proxy`
- Set server-only `YOUTUBE_API_KEY`
- Client calls `/api/youtube/playlist`, key is not exposed in browser bundle

### Browser mode

- Set `NEXT_PUBLIC_YOUTUBE_API_MODE=browser`
- Set `NEXT_PUBLIC_YOUTUBE_API_KEY`
- Restrict the key by HTTP referrer and API scope in Google Cloud Console

## Deploy to Vercel (free tier)

Set env vars in Vercel:

- `NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app`
- `NEXT_PUBLIC_YOUTUBE_API_MODE=proxy`
- `YOUTUBE_API_KEY=...`

Then deploy normally from your Git provider.

## Notes

- Data is local-only; clearing browser storage removes imported playlists.
- There is no cross-device sync by design.
