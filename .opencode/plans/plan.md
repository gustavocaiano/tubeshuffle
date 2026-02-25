# Open/Free Frontend Migration Plan (Next.js on Vercel)

## 1) Problem framing — what and why
- The current app is SaaS-shaped (NextAuth + Prisma/Postgres + Redis + Stripe + tRPC), which conflicts with the new goal: fully open/free, no accounts, no paid backend dependencies, and deployable on Vercel free tier.
- The product scope is now core-only: import YouTube playlist, shuffle, play. Login, billing, premium gates, analytics, and server-heavy persistence must be removed.
- The migration should preserve core UX while shifting state and data ownership to the browser, with minimal optional serverless surface only for YouTube key protection.
- Deployment target is a Next.js client app on Vercel (not strict static export), so a tiny Route Handler is acceptable if it materially improves key security.

## 2) Assumptions
- No user accounts remain; playlists are device-local by design.
- Multi-device sync is intentionally dropped.
- End state contains no Prisma, no database URL requirement, no Redis, no Stripe, no NextAuth.
- Core shuffle modes can remain, but premium gating is removed.
- Done criteria:
  - App builds and runs without DB/Redis/Auth/Billing env vars.
  - User can import a playlist URL, persist locally, open playlist page, shuffle, and play via YouTube iframe.
  - No login, pricing, premium banners, analytics routes, or Stripe webhooks remain.
  - Vercel deployment needs only frontend-safe env vars plus optional server-only YouTube key for proxy path.

## 3) Codebase context — relevant files, patterns, conventions
- App routes currently tied to auth and paid model: `src/app/page.tsx`, `src/app/dashboard/page.tsx`, `src/app/playlist/[id]/page.tsx`, `src/app/(auth)/login/page.tsx`, `src/app/pricing/page.tsx`, `src/app/dashboard/analytics/page.tsx`.
- Global providers couple UI to tRPC and session: `src/components/providers.tsx`.
- Navigation/footer currently expose pricing/login/account UX: `src/components/layouts/Navbar.tsx`, `src/components/layouts/Footer.tsx`.
- Backend stack currently centralized in `src/server/**`, `src/app/api/trpc/[trpc]/route.ts`, `src/lib/auth.ts`, `src/lib/db.ts`, `src/lib/redis.ts`, `src/lib/stripe.ts`, plus Prisma schema at `prisma/schema.prisma`.
- Core shuffle/player behavior is reusable with light refactor: `src/server/services/shuffle-service.ts`, `src/components/playlist/VideoPlayer.tsx`, `src/components/playlist/ShuffleControls.tsx`, `src/stores/player-store.ts`.
- YouTube import currently server-side via googleapis + Redis cache: `src/server/services/youtube-service.ts`.
- Env/config/docs reflect old infra: `src/lib/env.ts`, `.env.example`, `next.config.ts`, `README.md`, `DEPLOYMENT.md`, `API.md`, Docker files.
- Existing tests: `tests/unit/shuffle-service.test.ts` (currently imports server service).
- Skills check: `.agents/skills/` directory is absent in this repo (no reusable local skill files to reference).

## 4) Proposed design — architecture, components, data flow

### A. Data layer replacement (browser-first, versioned)
- Introduce a browser data module (IndexedDB preferred over localStorage for playlist/video volume and better quota behavior).
- Keep lightweight UI/session settings in localStorage (e.g., last-selected playlist ID, UI toggles); keep playlist/video records in IndexedDB.
- Add schema versioning and migration guard:
  - `DB_NAME=tubeshuffler_local`, `DB_VERSION=1` initially.
  - Object stores: `playlists`, `playHistory` (optional but useful for discovery/exclude watched), and `meta`.
  - `meta` contains `schemaVersion`, `migratedFromLegacy` boolean.
- Add one-time migration step from any legacy local state keys if present (non-blocking; if migration fails, app still starts with empty library).

### B. API layer replacement (remove tRPC/backend domain services)
- Remove domain dependence on tRPC entirely; replace with client-side service abstraction:
  - `playlistRepository` interface implemented by local IndexedDB adapter.
  - `youtubeProvider` abstraction with two concrete fetch pathways (Path A/Path B below).
- Keep only a tiny optional serverless Route Handler for YouTube proxy in Path B.
- Shuffle algorithms become pure frontend utility module consumed directly by pages/components.

### C. Auth/account removal and route simplification
- Remove NextAuth session checks and redirects from dashboard/playlist pages.
- Remove login/pricing/analytics routes and all premium/subscription UI/state.
- Simplify app navigation to core routes:
  - Keep: `/` (core landing/dashboard), `/playlist/[id]`.
  - Remove: `/login`, `/pricing`, `/dashboard/analytics`, `/api/auth/*`, `/api/webhooks/stripe`, `/api/trpc/*`.

### D. Deployment changes for Vercel free
- Remove Docker/VPS assumptions from code/docs.
- Keep Next.js app router deployment on Vercel; no external services required.
- If Path B chosen, use server-only env var on Vercel for YouTube key and a single route handler.
- Remove `output: "standalone"` if no longer needed for Docker-centric deploy.

### E. Docs/env/dependency cleanup
- Remove Prisma/Stripe/Auth/Redis env schema entries and docs.
- Trim `package.json` dependencies to frontend + minimal serverless proxy needs.
- Update README/DEPLOYMENT/API docs to reflect local-first architecture.

### F. YouTube API key strategy options + recommendation
- Path A (pure frontend key): browser calls YouTube Data API directly with `NEXT_PUBLIC_YOUTUBE_API_KEY` and strict HTTP referrer restrictions.
  - Pros: simplest, lowest latency, zero backend logic.
  - Cons: key is always extractable from client; referrer restrictions reduce abuse but do not make key secret.
- Path B (tiny Vercel proxy): browser calls `/api/youtube/*`; route handler injects server-only `YOUTUBE_API_KEY`.
  - Pros: key not exposed in client bundle; better request shaping, input validation, optional lightweight anti-abuse controls.
  - Cons: small backend surface and Vercel function limits apply.
- Recommendation: **Path B** as default because user explicitly wants YouTube working without exposed key and is open to Vercel secrets.
- Security tradeoff note on IP restriction:
  - IP restriction is for server-origin traffic with stable source IPs; it does **not** protect browser-distributed keys in practical frontend usage.
  - For browser keys, Google documents HTTP referrer restrictions + API restrictions.

## 5) Contracts and interfaces — types, APIs, schemas
- Local data contracts (new):
  - `LocalPlaylist`: `{ id, youtubeId, title, description?, thumbnail?, channelTitle?, videoCount, createdAt, updatedAt }`
  - `LocalVideo`: `{ id, playlistId, youtubeId, title, channelTitle, thumbnail, duration, position, viewCount?, likeCount? }`
  - `LocalPlayEvent`: `{ id, playlistId, videoId, watchedAt, watchedSeconds, completed }`
- Repository interface (new, client-side):
  - `listPlaylists(): Promise<LocalPlaylist[]>`
  - `getPlaylist(id: string): Promise<{ playlist: LocalPlaylist; videos: LocalVideo[] } | null>`
  - `importPlaylistFromUrl(url: string): Promise<{ playlist: LocalPlaylist; videos: LocalVideo[] }>`
  - `syncPlaylist(id: string): Promise<void>`
  - `deletePlaylist(id: string): Promise<void>`
  - `recordPlay(event: LocalPlayEventInput): Promise<void>`
- YouTube provider contract:
  - `fetchPlaylistData(playlistId: string): Promise<YouTubePlaylistData>` (existing type reusable from `src/types/playlist.ts`)
  - Implementations:
    - `youtubeProviderBrowser` (Path A)
    - `youtubeProviderProxy` (Path B via `/api/youtube/playlist`)
- Serverless proxy API (Path B):
  - `GET /api/youtube/playlist?list=<playlistId>` returns normalized `YouTubePlaylistData` JSON only.
  - Validation: reject missing/invalid `list`, cap pagination bounds, return sanitized errors.

## 6) Risks and tradeoffs
- Local-only persistence means users lose data on browser storage clear/device switch; acceptable under open/free scope but should be clearly documented.
- IndexedDB adds async complexity; mitigated with thin repository abstraction and migration fallback to empty state.
- YouTube quota/abuse risk remains in both paths; Path B improves control via server-side validation and optional rate limiting.
- Removing tRPC/server stack in one pass can create broad breakage; mitigate through staged batches where UI is migrated before deleting backend files.
- Vercel free function/runtime limits may impact very large playlist imports; mitigate by chunked YouTube fetch and explicit timeout/error UX.

External references used for design decisions:
- Google API key restrictions and best practices: https://cloud.google.com/api-keys/docs/add-restrictions-api-keys
- Google API key security best practices: https://cloud.google.com/docs/authentication/api-keys-best-practices
- YouTube quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- YouTube quota/compliance audits: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- Next.js env var behavior: https://nextjs.org/docs/app/guides/environment-variables
- Vercel env vars: https://vercel.com/docs/environment-variables

## 7) Dev checklist — scope-locked implementation steps (small batches)
1. **Create local data foundation (no UI wiring yet).**
   - File scope: `src/types/playlist.ts` (extend or split local types), `src/lib/storage/browser-db.ts` (new), `src/lib/storage/storage-migrations.ts` (new), `src/lib/storage/index.ts` (new).
   - Implement IndexedDB schema v1 (`playlists`, `videos`, `playHistory`, `meta`) and migration metadata.
   - Rollback/risk note: keep all existing server/tRPC code untouched in this batch so fallback path remains available.
   - Verification command: `npm run lint`

2. **Move shuffle/business logic to frontend-safe module and repoint tests.**
   - File scope: `src/lib/shuffle/shuffle-service.ts` (new, copied/adapted from server service), `tests/unit/shuffle-service.test.ts` (import path + local types), `src/types/playlist.ts` (if needed for shared types).
   - Remove Prisma type dependency from shuffle utilities.
   - Rollback/risk note: retain old `src/server/services/shuffle-service.ts` until Batch 6; easy restore if test parity fails.
   - Verification command: `npm run test -- tests/unit/shuffle-service.test.ts`

3. **Implement YouTube provider abstraction with both key pathways.**
   - File scope: `src/lib/services/youtube-provider.ts` (new), `src/lib/services/youtube-browser.ts` (new, Path A), `src/lib/services/youtube-proxy.ts` (new, Path B client), `src/lib/env.ts` (simplify + new key vars), `src/lib/utils.ts` (shared parsing helpers as needed).
   - Add runtime switch (`NEXT_PUBLIC_YOUTUBE_API_MODE=browser|proxy`, default `proxy`).
   - Include integration reference in code comments/ADR note: Context7 library ID `/websites/developers_google_youtube_v3`.
   - Rollback/risk note: feature flag allows immediate fallback from proxy to browser mode without data model rollback.
   - Verification command: `npm run lint`

4. **Add tiny serverless proxy route for recommended Path B.**
   - File scope: `src/app/api/youtube/playlist/route.ts` (new) and optionally `src/app/api/youtube/videos/route.ts` (new only if needed for duration batching).
   - Implement request validation, minimal parameter allowlist, normalized response shape, and safe error mapping.
   - Use server-only `YOUTUBE_API_KEY` (no `NEXT_PUBLIC_` prefix).
   - Rollback/risk note: if function limits/regressions appear, switch to Path A mode while keeping route dormant.
   - Verification command: `npm run build`

5. **Refactor core UI flows to local repository + provider, remove auth gates.**
   - File scope: `src/components/providers.tsx`, `src/app/dashboard/page.tsx`, `src/app/playlist/[id]/page.tsx`, `src/components/playlist/ImportPlaylistModal.tsx`, `src/components/playlist/BatchImportModal.tsx`, `src/components/playlist/PlaylistCard.tsx`, `src/components/playlist/ShuffleControls.tsx`, `src/stores/playlist-store.ts`.
   - Replace `trpc.*` + `useSession` usage with local hooks/services; remove premium checks from controls.
   - Rollback/risk note: keep deleted-route cleanup for next batch so broken imports can be fixed before hard removals.
   - Verification command: `npm run lint`

6. **Simplify routes/navigation and remove non-core pages.**
   - File scope: `src/app/page.tsx`, `src/components/layouts/Navbar.tsx`, `src/components/layouts/Footer.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`; remove `src/app/(auth)/login/page.tsx`, `src/app/(auth)/login/layout.tsx`, `src/app/pricing/page.tsx`, `src/app/pricing/layout.tsx`, `src/app/dashboard/analytics/page.tsx`.
   - Update metadata/canonical links to remove login/pricing assumptions.
   - Rollback/risk note: preserve temporary redirects or placeholder links in this batch commit for quick UX recovery.
   - Verification command: `npm run build`

7. **Delete backend monetization stack and database/auth infrastructure.**
   - File scope: remove `src/server/**`, `src/app/api/trpc/[trpc]/route.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/lib/auth.ts`, `src/lib/auth-types.ts`, `src/lib/trpc.ts`, `src/lib/db.ts`, `src/lib/redis.ts`, `src/lib/stripe.ts`, `prisma/**`, `prisma.config.ts`.
   - Ensure no remaining imports reference deleted modules.
   - Rollback/risk note: perform as isolated commit after Batches 1–6 pass; if compile breaks, revert this commit only.
   - Verification command: `npm run build`

8. **Dependency/config/docs cleanup for Vercel-free deployment.**
   - File scope: `package.json`, `package-lock.json`, `.env.example`, `next.config.ts`, `README.md`, `DEPLOYMENT.md`, `API.md`; optionally remove `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh` if no longer intended.
   - Remove Prisma/NextAuth/Stripe/Redis/tRPC deps and stale env vars; document Path A and Path B key setup with recommendation for Path B.
   - Include note that repo skill path check returned none: `.agents/skills/` missing.
   - Rollback/risk note: dependency pruning can remove indirectly used packages; keep a pre-cleanup lockfile tag and re-add only proven missing deps.
   - Verification command: `npm run lint`

## 8) QA checklist — read-only validation criteria for release gate
1. Confirm Dev reported PASS outputs for each batch command; if any batch command is FAIL/N/A without rationale, gate fails.
2. Inspect `src/app/dashboard/page.tsx`, `src/app/playlist/[id]/page.tsx`, and `src/components/playlist/ImportPlaylistModal.tsx` to verify no `next-auth`, `trpc`, premium gating, or server-session assumptions remain.
3. Inspect `src/app/api/` to verify only intended lightweight YouTube proxy route(s) remain and no auth/stripe/trpc routes exist.
4. Inspect `src/lib/env.ts` and `.env.example` to verify DB/Redis/Auth/Stripe vars are removed; verify Path B uses server-only `YOUTUBE_API_KEY` and Path A uses explicit `NEXT_PUBLIC_*` var only when enabled.
5. Inspect `package.json` to confirm removal of Prisma/NextAuth/Stripe/Redis/tRPC dependencies and scripts no longer imply database migration.
6. Inspect `README.md` and `DEPLOYMENT.md` to confirm Vercel free-tier deployment instructions, local-storage behavior disclosure, and YouTube key strategy tradeoffs are documented.
7. Verify route inventory by file review: no `/login`, `/pricing`, `/dashboard/analytics` pages; navigation links and sitemap/robots match remaining routes.
8. Verify final behavior claims in Dev summary match changed files: import/shuffle/play preserved; no accounts/billing/analytics/db/redis dependencies left.
