# Deployment Guide

## Vercel (recommended)

This app is designed for low-cost/free deployment on Vercel.

### Required environment variables

- `NEXT_PUBLIC_APP_URL` = your deployed URL
- `NEXT_PUBLIC_YOUTUBE_API_MODE` = `proxy` (recommended)
- `YOUTUBE_API_KEY` = server-side YouTube Data API key

### Optional browser mode

If you do not want to use the proxy route:

- `NEXT_PUBLIC_YOUTUBE_API_MODE` = `browser`
- `NEXT_PUBLIC_YOUTUBE_API_KEY` = browser key (must be HTTP-referrer restricted)

### Deploy steps

1. Import repository into Vercel.
2. Configure env vars in Project Settings.
3. Deploy.

No database, Redis, Stripe, or OAuth setup is needed.

## Verification checklist

- Open home page and dashboard
- Import a YouTube playlist URL
- Shuffle and play videos
- Refresh page and confirm playlists are still present (same browser)
