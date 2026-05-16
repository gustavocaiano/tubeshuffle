# Dynamic Energy Smart Shuffle + Daily Suggestions Plan

## Scope

Planning and discovery only. Do not implement from this document until explicitly asked.

This plan covers two product changes:

1. Replace the current Smart Shuffle behavior with a dynamic energy/mood flow shuffle.
2. Add a daily suggestion surface: 5 suggested YouTube videos per playlist per browser/day, loaded when the user scrolls to that section.

## User decisions captured

- Smart Shuffle should **replace** the old artist/channel spacing behavior, not keep it as a secondary rule.
- Energy classification may be approximate if copy is honest: metadata-inferred, not BPM-perfect audio analysis.
- The energy cycle should infer its starting point from the playlist/current context rather than always starting from the same mood.
- Suggestions should **not** interrupt playback or be inserted every 5 queue items.
- Suggestions should be **5 daily suggestions per playlist per browser/device**, shown lower down the playlist page.
- “Per user” for MVP means per browser/device via IndexedDB/local storage, with no account/backend.
- Use the approach that works well in the first implementation, even if it uses YouTube Search API quota.

## Current code findings

- `src/lib/shuffle/shuffle-service.ts:24-86` contains all shuffle behavior:
  - `RANDOM`: Fisher-Yates.
  - `SMART`: Fisher-Yates plus greedy artist/channel de-clustering.
- `src/types/playlist.ts:61` defines `ShufflePreset = "RANDOM" | "SMART"`.
- `src/components/playlist/ShuffleControls.tsx:30-45` hardcodes two UI modes:
  - Normal: “Pure random order”.
  - Smart: “Spaces out repeat artists”.
- `src/app/playlist/[id]/page.tsx:311-342` stores selected shuffle preset and calls `shuffleVideos`.
- `src/app/page.tsx` copy currently contradicts the requested direction:
  - `45-47`: Smart is “not an AI mood classifier”.
  - `77-79`: “Two shuffle modes… No vague energy modes.”
  - `417-438`: “No fake mood labels… de-clustering pass.”
- `src/app/api/youtube/playlist/route.ts` already uses a server-side YouTube API key and `fetch(..., { cache: "no-store" })`.
- `src/lib/storage/browser-db.ts` has IndexedDB stores for playlists/videos/playHistory/meta. Suggestion cache can use `meta` without schema changes, unless later indexes/cleanup are needed.

## Research summary

### YouTube Data API

- `videos.list` returns video metadata and costs 1 quota unit per request.
- `search.list` returns video search results and costs 100 quota units per request.
- Default project quota is 10,000 units/day, reset daily.
- `playlistItems.insert` can add to a real YouTube playlist but requires OAuth and costs 50 units.
- YouTube Premium does not increase API quota, expose recommendation APIs, or remove OAuth requirements.

For daily suggestions:

- Recommended MVP: 1 search request returning multiple candidates + 1 details request.
- Cost: about 101 units per playlist/day.
- If one fallback/diversity search is needed: about 201 units per playlist/day.
- At 10,000 units/day, this supports roughly 49-99 playlist suggestion refreshes/day per API project, before other app usage.

### Other services

- Spotify is not suitable for new apps here: new Web API apps cannot access Recommendations, Audio Features, or Audio Analysis endpoints.
- MusicBrainz is useful for canonical artist/recording IDs and tags, but rate limiting is around 1 request/sec/IP and it requires a meaningful User-Agent.
- Last.fm can return similar tracks with an API key and no user auth, but would still need YouTube search to obtain playable YouTube video IDs.
- ListenBrainz recommendations are user/collaborative-filtering oriented and partly experimental.
- AcousticBrainz has useful historical acoustic/mood data by MusicBrainz recording ID, but stopped collecting data in 2022.
- Deezer/GetSongBPM may help with BPM in later enrichment, but coverage/matching/cost are less reliable for an MVP.

## Council review direction

The council recommended a local-first, explainable energy flow rather than fake AI/audio analysis; avoid Spotify and quota-heavy automatic search loops; keep external APIs optional or carefully cached.

Chosen direction:

- Follow the local-first/transparent approach for Smart Shuffle.
- Use YouTube Search API only for the daily suggestion feature because the user wants real suggestions that work well immediately.
- Keep suggestions quota-bounded and cached daily.

## Product direction

### Mode 1: Normal

Keep unchanged: mathematically fair Fisher-Yates randomization.

### Mode 2: Smart / Energy Flow

Replace old Smart Shuffle with an energy/mood flow algorithm:

- Classify each video into approximate energy/mood buckets using available metadata.
- Infer a starting energy from the playlist/current context.
- Build a wave/cycle that moves gradually between nearby moods, e.g. upbeat → steady → calm → melancholy → calm → steady → upbeat.
- Prefer grouped runs with transition tracks rather than hard alternating moods.
- Do **not** use artist/channel spacing as a goal in this mode.
- Preserve shuffle invariants: no dropped videos, no duplicated videos.

Suggested initial buckets:

- `hype`
- `upbeat`
- `steady`
- `chill`
- `melancholy`
- `unknown`

Use `unknown` as a fallback and blend it into nearest available slots rather than isolating it.

### Daily Suggestions

Add a daily suggestion section on the playlist page:

- 5 suggestions per playlist per browser/day.
- Loaded lazily when the user scrolls near the suggestions section or clicks “Load today’s suggestions”.
- Cached locally with date + playlist ID.
- Cards should include title, channel, thumbnail, duration if available, reason/context, and a YouTube link.
- Since results have YouTube video IDs, cards can also support “Play in TubeShuffle” or “Add to local queue” later, but the first planned behavior is opening YouTube.
- This should be implemented as a separate discovery surface, not as a `ShufflePreset`, because it does not reorder the playlist queue.

## Technical plan

### 1. Improve stored video metadata

Purpose: give the energy classifier and suggestions better signals.

Files likely involved:

- `src/types/playlist.ts`
- `src/app/api/youtube/playlist/route.ts`
- `src/stores/playlist-store.ts`
- `src/lib/storage/index.ts`

Planned changes:

- Extend video types with optional fields such as:
  - `description?: string`
  - `tags?: string[]`
  - `categoryId?: string`
  - `publishedAt?: string`
- Update `videos.list` import to request `snippet` in addition to existing `contentDetails,statistics`.
- Store optional fields in IndexedDB video records.
- Existing IndexedDB rows can safely miss these fields if no new indexes are required.

Notes:

- This does not give real BPM or audio energy.
- It improves text-based inference and YouTube search seed quality.

### 2. Add energy classification utilities

New files likely:

- `src/lib/shuffle/energy-classifier.ts`
- `src/lib/shuffle/energy-flow.ts`

Core types:

```ts
type EnergyBucket = "hype" | "upbeat" | "steady" | "chill" | "melancholy" | "unknown";

interface TrackEnergyProfile {
  bucket: EnergyBucket;
  score: number; // 0-100 approximate intensity
  confidence: number; // 0-1
  signals: string[];
}
```

Classifier signals:

- Title keywords: happy/upbeat/party/dance/hype/drill/trap/phonk/sad/slow/chill/lofi/acoustic/ambient/etc.
- Portuguese and common playlist terms where practical: triste, calma, feliz, animada, lenta, rápida, etc.
- Tags/description keywords when imported.
- Channel/title patterns, e.g. “lofi”, “nightcore”, “sped up”, “slowed”, “remix”, “live”, “acoustic”.
- Duration as a weak signal only.

Design constraints:

- Deterministic and testable.
- No external API required for Smart Shuffle.
- Return confidence so UI/debug/test cases can distinguish strong vs weak classification.

### 3. Replace Smart Shuffle algorithm

Files likely:

- `src/lib/shuffle/shuffle-service.ts`
- `tests/unit/shuffle-service.test.ts`
- New unit tests for classifier/flow helpers.

Algorithm outline:

1. Classify all videos.
2. Count bucket distribution.
3. Infer start bucket from current/first playlist context or dominant confident bucket.
4. Generate a target energy wave across queue length.
5. Select videos matching the target bucket, falling back to nearest available bucket.
6. Randomize within buckets so repeated shuffles still vary.
7. Ensure every original video appears exactly once.

Important behavior:

- Sparse buckets should not create awkward gaps or fail.
- Unknown tracks should be blended into low-confidence transition points.
- Old artist/channel de-clustering is removed from Smart.

### 4. Add daily suggestions API

New file likely:

- `src/app/api/youtube/suggestions/route.ts`

Recommended request shape:

```ts
POST /api/youtube/suggestions
{
  "playlistId": "local-playlist-id",
  "seeds": [
    { "title": "...", "channelTitle": "...", "bucket": "upbeat", "tags": ["..."] }
  ],
  "excludeVideoIds": ["..."]
}
```

Server behavior:

- Validate request size and fields.
- Build 1 high-quality search query from playlist fingerprint, e.g. genre/energy + seed artist/title.
- Call `search.list` with:
  - `type=video`
  - `maxResults` > 5 to allow filtering duplicates
  - `videoEmbeddable=true`
  - `videoCategoryId=10` if it improves music targeting in testing
  - optionally `safeSearch=moderate`
- Filter existing playlist video IDs and duplicate result IDs.
- Call `videos.list` for details/duration/embeddability metadata where useful.
- Return up to 5 `SuggestedVideo` records.
- If fewer than 5 high-quality results are found, optionally perform one fallback search query.

Quota target:

- Normal path: ~101 units per playlist/day.
- Fallback path: ~201 units per playlist/day.

Failure behavior:

- If quota/API fails, return a structured error that lets the client show fallback YouTube search links rather than a broken section.
- Do not expose the API key to the client.

### 5. Add local daily suggestion cache

Files likely:

- `src/lib/storage/index.ts`
- `src/lib/storage/browser-db.ts` only if a new store becomes necessary.
- New helper: `src/lib/suggestions/daily-suggestions-cache.ts`

Preferred MVP storage:

- Use existing `STORE_META` keys to avoid a DB version bump:
  - `dailySuggestions:${playlistId}:${YYYY-MM-DD}`
  - value contains suggestions, generatedAt, query, quotaPath, and version.

Cache behavior:

- One suggestion set per playlist per local date.
- Reuse cache on repeat visits/scrolls that day.
- Allow manual “refresh” only if explicitly added later, because refresh consumes quota.
- Include a schema/version field so future enrichment can invalidate old suggestions.

### 6. Add suggestion UI

Files likely:

- `src/app/playlist/[id]/page.tsx`
- New `src/components/playlist/DailySuggestions.tsx`
- New `src/components/playlist/SuggestionCard.tsx`

UI behavior:

- Section appears below the main queue/player area or lower on the playlist page.
- Use IntersectionObserver or a user action to trigger loading.
- Show:
  - “Today’s suggestions”
  - quota/cache-aware status, e.g. “Generated today from this playlist’s vibe.”
  - 5 cards with thumbnail/title/channel/duration.
  - “Open on YouTube” link.
- Optional first implementation if easy: “Play now” in TubeShuffle using the returned videoId, without adding to the original playlist.

Do not claim the app added the video to the user’s real YouTube playlist unless OAuth is implemented.

### 7. Update copy

Files likely:

- `src/app/page.tsx`
- `src/components/playlist/ShuffleControls.tsx`
- Any FAQ/metadata strings if added.

Required copy changes:

- Replace “Two shuffle modes” framing.
- Remove “No vague energy modes” and “not an AI mood classifier” claims.
- Introduce honest language:
  - Smart Energy Flow groups and transitions by inferred energy/mood.
  - Inference uses YouTube metadata and playlist context, not direct audio/BPM analysis.
  - Daily suggestions are generated from playlist signals and cached per browser/day.
- Keep the local-first promise accurate:
  - imported playlists stay local;
  - daily suggestions require a server-side YouTube API search call unless served from local cache.

Suggested copy direction:

- Hero: “Shuffle by flow, not just chance.”
- Smart: “Builds a queue that moves through similar energies with smoother transitions.”
- Daily suggestions: “Five fresh finds for this playlist each day.”
- FAQ: “Does Smart use real BPM?” → “No. It infers energy from metadata and playlist context unless future enrichment is added.”

## Testing plan

Add/adjust unit tests for:

- Random shuffle unchanged.
- Smart shuffle preserves all videos exactly once.
- Smart shuffle removes old artist/channel-spacing guarantees.
- Energy classifier buckets obvious titles correctly.
- Energy flow avoids abrupt jumps when enough bucket diversity exists.
- Sparse/unknown bucket fallback.
- Daily suggestion cache returns same set for same playlist/day.
- Suggestion API response normalization/filtering excludes existing video IDs.

Manual validation:

- Import/open a large playlist.
- Smart queue should feel grouped and cyclic, not alternating randomly.
- Scroll to daily suggestions; first load triggers API, second load same day uses cache.
- Quota/API failure shows a fallback, not a blank/broken section.

Commands for implementation phase:

```bash
npm test
npm run lint
npm run build
```

## Risks and mitigations

- **Weak metadata can misclassify energy.** Mitigate with honest copy, confidence scores, and fallback buckets.
- **YouTube search quota is shared by all users of one API project.** Mitigate with daily cache, lazy loading, max one fallback search, and clear failure fallback.
- **Suggestions may include non-music or poor matches.** Mitigate with music-focused query terms, category filters where effective, duplicate filtering, and details checks.
- **Public app scale could exhaust quota.** Mitigate with per-browser daily caching now; consider per-deployment quota controls later.
- **Adding to a real YouTube playlist is out of scope.** Requires Google OAuth and playlist write scopes.
- **YouTube Premium does not solve API limits.** Do not frame Premium as a way to increase suggestions.

## Out of scope for first implementation

- Real BPM/audio analysis.
- Spotify Audio Features/Recommendations.
- YouTube Music unofficial APIs.
- Cross-device users/accounts.
- Adding suggestions directly to the user’s YouTube playlist.
- Last.fm/MusicBrainz/ListenBrainz enrichment, unless a later phase is requested.

## Future enhancements

- Last.fm similar tracks for better named recommendations, followed by YouTube video resolution.
- MusicBrainz matching for canonical artist/recording IDs.
- User feedback: hide suggestion, more like this, less like this.
- “Play suggestions in TubeShuffle” or “append to local queue”.
- Server-side quota budgeting/rate limiting if deployed publicly.
- Optional richer classifier using embeddings/LLM if cost/privacy tradeoff is accepted.
