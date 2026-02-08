# TubeShuffler

A production-grade YouTube playlist shuffler that fixes YouTube's broken shuffle algorithm. Import your playlists, get truly random playback with smart shuffle algorithms, and never hear the same songs first again.

## Features

### Free Tier
- Import up to 3 YouTube playlists
- True random shuffle (Fisher-Yates algorithm)
- Cloud sync across devices
- Unlimited playlist size support
- Basic playback controls

### Premium (from 4.99/month or 49.99/year — price in your local currency)
- Up to 50 saved playlists
- Smart Shuffle — avoids same artist/channel back-to-back
- Discovery Mode — prioritizes less-played videos
- Watch history tracking
- Exclude watched videos from shuffle
- Playlist analytics (most played, completion rate)
- Batch import (multiple playlists at once)
- Custom filters (duration, channel)
- Auto-cleanup of deleted/unavailable videos

## Tech Stack

- **Frontend:** Next.js 14+ (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **API:** tRPC (type-safe client-server communication)
- **Database:** PostgreSQL + Prisma ORM
- **Auth:** NextAuth.js v5 (Google OAuth)
- **Payments:** Stripe (subscriptions)
- **Cache:** Redis (via Docker container)
- **State:** Zustand (player state), TanStack Query (server state)
- **Testing:** Vitest

## Quick Start

### Prerequisites
- Docker and Docker Compose ([install guide](https://docs.docker.com/engine/install/))
- Google Cloud Console project (for OAuth + YouTube API)

### 1. Clone and install

```bash
git clone <your-repo-url>
cd youtube-randomizer
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Fill in your `.env` file with:
- `AUTH_SECRET` — Generate with `openssl rand -base64 32`
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — From Google Cloud Console
- `YOUTUBE_API_KEY` — From Google Cloud Console (YouTube Data API v3)
- Stripe keys (optional, for payments)

Database and Redis are provided by Docker Compose automatically.

### 3. Start with Docker Compose

```bash
docker compose up -d --build
```

### 4. Run database migrations

```bash
docker compose exec app npx prisma migrate deploy
```

### 5. Open the app

Visit [http://localhost:3000](http://localhost:3000)

### Local development (without Docker)

You can also run only the infrastructure containers and the app locally:

```bash
# Start only postgres and redis
docker compose up -d postgres redis

# Install dependencies and run the dev server
npm install
npx prisma migrate dev
npm run dev
```

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # Landing page
│   ├── dashboard/          # User dashboard
│   ├── playlist/[id]/      # Playlist view + player
│   ├── pricing/            # Pricing page
│   ├── (auth)/login/       # Login page
│   └── api/                # API routes (auth, tRPC, webhooks)
├── components/
│   ├── ui/                 # shadcn/ui components
│   ├── playlist/           # Playlist-specific components
│   ├── layouts/            # Navbar, Footer
│   └── providers.tsx       # App providers (session, tRPC, query)
├── lib/                    # Shared utilities
│   ├── auth.ts             # NextAuth configuration
│   ├── db.ts               # Prisma client
│   ├── redis.ts            # Redis client + cache helper
│   ├── stripe.ts           # Stripe client
│   ├── trpc.ts             # tRPC React client
│   ├── env.ts              # Validated environment variables
│   └── utils.ts            # Helper functions
├── server/
│   ├── trpc/               # tRPC server setup
│   │   ├── routers/        # API routers (playlist, user, subscription)
│   │   ├── trpc.ts         # tRPC initialization + middleware
│   │   ├── context.ts      # Request context
│   │   └── router.ts       # Root router
│   └── services/           # Business logic
│       ├── youtube-service.ts
│       ├── shuffle-service.ts
│       ├── playlist-service.ts
│       └── rate-limiter.ts
├── stores/                 # Zustand stores
│   ├── player-store.ts
│   └── playlist-store.ts
└── types/                  # TypeScript types
```

## Scripts

```bash
npm run dev         # Start development server
npm run build       # Production build
npm run start       # Start production server
npm run lint        # Run ESLint
npm run test        # Run tests (Vitest)
npm run test:watch  # Run tests in watch mode
```

## API Documentation

See [API.md](./API.md) for full tRPC API documentation.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment instructions.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
