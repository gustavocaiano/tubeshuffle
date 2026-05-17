<p align="center">
  <img src="public/favicon.svg" alt="TubeShuffle icon" width="92" height="92" />
</p>

<h1 align="center">TubeShuffle</h1>

<p align="center">
  A better shuffle for your public YouTube playlists.
</p>

<p align="center">
  <strong>Live app:</strong>
  <a href="https://tubeshuffle.online">tubeshuffle.online</a>
</p>

<p align="center">
  <a href="https://tubeshuffle.online">Open TubeShuffle</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#self-hosting--development">Self-hosting</a>
</p>

---

## What is TubeShuffle?

TubeShuffle is a simple web app for people who are tired of YouTube playlist shuffle feeling repetitive.

Paste a public YouTube playlist, import it into your browser, and listen with a queue you can actually control.

## Why use it?

- **Better shuffle** — use pure random shuffle or Smart energy-flow shuffle.
- **No account needed** — no TubeShuffle login, subscription, or cloud library.
- **Local-first** — imported playlists are saved in your own browser.
- **Queue control** — move songs, play something next, or remove items anytime.
- **Focus modes** — reduce visual noise with Focus, No Artwork, and Stage views.
- **Daily suggestions** — get five fresh YouTube finds for each playlist per day.

## How it works

1. Open [tubeshuffle.online](https://tubeshuffle.online).
2. Paste a public YouTube playlist URL.
3. Import the playlist.
4. Choose Normal or Smart shuffle.
5. Listen, reorder, skip, or refresh the queue whenever you want.

Your playlists stay on your device. Clearing browser storage will remove them.

## This repository

This is the source code for the live TubeShuffle app at [tubeshuffle.online](https://tubeshuffle.online).

It is built with Next.js and uses a server-side YouTube API proxy so the public app does not expose the API key in the browser.

---

## Self-hosting & development

If you want to run your own copy or work on the app locally, follow these steps.

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

```bash
cp .env.example .env
```

### 3. Add your YouTube API key

Use proxy mode to keep the key server-side:

```env
NEXT_PUBLIC_YOUTUBE_API_MODE="proxy"
YOUTUBE_API_KEY="your-youtube-api-key"
```

### 4. Start the app

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000).

### Deploying your own copy

For Vercel or another hosted deployment, set:

```env
NEXT_PUBLIC_APP_URL="https://your-domain.com"
NEXT_PUBLIC_YOUTUBE_API_MODE="proxy"
YOUTUBE_API_KEY="your-youtube-api-key"
```

## Tech stack

Next.js App Router · React · TypeScript · Tailwind CSS · shadcn/ui · Zustand · TanStack Query · IndexedDB

## Notes

- TubeShuffle works with public YouTube playlists.
- Private playlists and Liked Videos are not imported because TubeShuffle does not use Google login.
- Playlist data is local to the browser unless you self-host and change that behavior.
