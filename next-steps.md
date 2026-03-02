# Next Steps

1. Copy env file:

```bash
cp .env.example .env
```

2. Set YouTube API key:

- Recommended: `NEXT_PUBLIC_YOUTUBE_API_MODE=proxy` + `YOUTUBE_API_KEY=...`
- Alternative: `NEXT_PUBLIC_YOUTUBE_API_MODE=browser` + `NEXT_PUBLIC_YOUTUBE_API_KEY=...`

3. Run locally:

```bash
npm install
npm run dev
```

4. Deploy to Vercel and add the same env vars.
