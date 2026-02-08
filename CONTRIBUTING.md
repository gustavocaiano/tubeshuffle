# Contributing

Thank you for your interest in contributing to TubeShuffler!

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in the values
4. Set up a local PostgreSQL database
5. Run migrations: `npx prisma migrate dev`
6. Start the dev server: `npm run dev`

## Code Style

- TypeScript strict mode enabled
- No `any` types (use `unknown` + type narrowing when needed)
- Use Zod for runtime validation of all inputs
- Functional components with hooks (no class components)
- Use `shadcn/ui` components for UI consistency

## Testing

Run tests with:
```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

Write tests for:
- Utility functions (`tests/unit/`)
- Service layer logic (`tests/unit/`)
- tRPC router integration (`tests/integration/`)

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass: `npm run test`
4. Ensure no TypeScript errors: `npx tsc --noEmit`
5. Ensure no lint errors: `npm run lint`
6. Write a clear PR description

## Project Architecture

```
Frontend (Next.js App Router)
    ↓
tRPC Client (type-safe)
    ↓
tRPC Server (routers + middleware)
    ↓
Service Layer (business logic)
    ↓
Data Layer (Prisma + Redis)
```

- **Pages** call tRPC procedures via React Query hooks
- **tRPC routers** handle auth, validation, and feature gates
- **Services** contain business logic (YouTube API, shuffle algorithms)
- **Prisma** handles database operations
- **Redis** caches YouTube API responses

## Feature Gates

Premium features must be gated in BOTH:
1. **Frontend** — show upgrade prompts, disable controls
2. **Backend** — tRPC middleware checks `user.subscription`

## Environment Variables

Never commit secrets. Use `.env.example` as the template and `.env` (gitignored) for local development.
