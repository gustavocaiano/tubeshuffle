import { NextResponse } from "next/server";
import { classifyEnergyTrack, type EnergyBucket } from "@/lib/shuffle/energy-classifier";
import { parseIsoDuration } from "@/lib/utils";
import type { DailySuggestionsResult, SuggestedVideo } from "@/types/playlist";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_SEEDS = 40;
const MAX_EXCLUDED_IDS = 5_000;
const MAX_REQUEST_BYTES = 128_000;
const TARGET_SUGGESTIONS = 5;
const SEARCH_RESULTS_PER_QUERY = 25;
const MAX_SEARCH_QUERIES = 4;
const SUGGESTION_ALGORITHM_VERSION = 2;
const MEMORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;

type SuggestionSeed = {
  title: string;
  channelTitle: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  duration?: number;
};

type SuggestionsRequest = {
  playlistId?: string;
  playlistTitle?: string;
  dateKey?: string;
  seeds?: SuggestionSeed[];
  excludeVideoIds?: string[];
  refreshToken?: string;
};

type ValidatedSuggestionsRequest = {
  playlistId: string;
  playlistTitle?: string;
  dateKey: string;
  seeds: SuggestionSeed[];
  excludeVideoIds: string[];
  refreshToken?: string;
};

type ApiError = {
  status: number;
  message: string;
};

type SearchItem = {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: { high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } };
    publishedAt?: string;
  };
};

type SearchCandidate = SearchItem & {
  query: string;
  rank: number;
};

type VideoDetails = {
  duration: number;
  viewCount?: number;
  publishedAt?: string;
};

const memoryCache = new Map<string, { expiresAt: number; result: DailySuggestionsResult }>();
const rateLimits = new Map<string, { windowStart: number; count: number }>();

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

async function fetchYouTubeJson<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<T> {
  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const response = await fetch(`${YOUTUBE_API_BASE}/${endpoint}?${searchParams.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    error?: { code?: number; message?: string };
  };

  if (!response.ok) {
    const upstreamCode = payload.error?.code ?? response.status;

    if (upstreamCode === 403) {
      throw { status: 502, message: "YouTube API request rejected or quota exceeded" } satisfies ApiError;
    }

    if (upstreamCode === 429) {
      throw { status: 429, message: "YouTube API rate limit exceeded" } satisfies ApiError;
    }

    throw { status: 502, message: payload.error?.message ?? "YouTube API request failed" } satisfies ApiError;
  }

  return payload as T;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()[\]{}|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIdentity(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(official|music|channel|records|recordings|vevo|topic)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueUsefulTerms(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const value of values) {
    const normalized = normalizeIdentity(value);
    if (normalized.length < 3 || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= limit) break;
  }

  return terms;
}

function getLocalDateFallback(): string {
  return new Date().toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactHash(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getCacheKey(body: ValidatedSuggestionsRequest): string {
  const seedFingerprint = body.seeds.map((seed) => [seed.title, seed.channelTitle, seed.tags]);
  const excludeFingerprint = [body.excludeVideoIds.length, body.excludeVideoIds[0], body.excludeVideoIds.at(-1)];
  return `${SUGGESTION_ALGORITHM_VERSION}:${body.playlistId}:${body.dateKey}:${compactHash([
    seedFingerprint,
    excludeFingerprint,
    body.refreshToken,
  ])}`;
}

function getClientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "unknown";
}

function assertRateLimit(clientKey: string): void {
  const now = Date.now();
  const current = rateLimits.get(clientKey);

  if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(clientKey, { windowStart: now, count: 1 });
    return;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    throw { status: 429, message: "Daily suggestions are temporarily rate limited" } satisfies ApiError;
  }

  current.count += 1;
}

function validateBody(body: unknown): ValidatedSuggestionsRequest {
  if (!isRecord(body)) {
    throw { status: 400, message: "Invalid suggestions request body" } satisfies ApiError;
  }

  const input = body as SuggestionsRequest;
  const playlistId = typeof input.playlistId === "string" ? input.playlistId.trim() : "";
  if (!playlistId || playlistId.length > 120) {
    throw { status: 400, message: "Missing or invalid playlist id" } satisfies ApiError;
  }

  const seeds = Array.isArray(input.seeds)
    ? input.seeds
        .filter(
          (seed) =>
            isRecord(seed) &&
            typeof seed.title === "string" &&
            typeof seed.channelTitle === "string"
        )
        .slice(0, MAX_SEEDS)
    : [];
  if (seeds.length === 0) {
    throw { status: 400, message: "At least one suggestion seed is required" } satisfies ApiError;
  }

  return {
    playlistId,
    dateKey:
      typeof input.dateKey === "string" && input.dateKey.trim()
        ? input.dateKey.trim()
        : getLocalDateFallback(),
    playlistTitle:
      typeof input.playlistTitle === "string" ? input.playlistTitle.slice(0, 160) : undefined,
    seeds: seeds.map((seed) => ({
      title: seed.title.slice(0, 180),
      channelTitle: seed.channelTitle.slice(0, 120),
      description: typeof seed.description === "string" ? seed.description.slice(0, 600) : undefined,
      tags: Array.isArray(seed.tags)
        ? seed.tags
            .filter((tag): tag is string => typeof tag === "string")
            .slice(0, 12)
            .map((tag) => tag.slice(0, 60))
        : undefined,
      categoryId: typeof seed.categoryId === "string" ? seed.categoryId.slice(0, 20) : undefined,
      duration: typeof seed.duration === "number" ? seed.duration : undefined,
    })),
    excludeVideoIds: Array.isArray(input.excludeVideoIds)
      ? input.excludeVideoIds
          .filter((id): id is string => typeof id === "string")
          .slice(0, MAX_EXCLUDED_IDS)
      : [],
    refreshToken:
      typeof input.refreshToken === "string" ? input.refreshToken.slice(0, 80) : undefined,
  };
}

function energyLabel(bucket: EnergyBucket): string {
  switch (bucket) {
    case "hype":
      return "high energy";
    case "upbeat":
      return "upbeat";
    case "steady":
      return "steady groove";
    case "chill":
      return "chill";
    case "melancholy":
      return "melancholic";
    default:
      return "similar";
  }
}

function getArtistLikeTerm(seed: SuggestionSeed): string {
  const dashSplit = seed.title.split(/\s[-–—]\s/);
  if (dashSplit.length >= 2 && dashSplit[0].length <= 80) {
    return dashSplit[0];
  }

  return seed.channelTitle.replace(/\s-\sTopic$/i, "");
}

function chooseSearchSeeds(seeds: SuggestionSeed[]): SuggestionSeed[] {
  return [...seeds]
    .map((seed, index) => ({
      seed,
      index,
      profile: classifyEnergyTrack(seed),
    }))
    .sort(
      (a, b) =>
        b.profile.confidence - a.profile.confidence ||
        b.profile.score - a.profile.score ||
        a.index - b.index
    )
    .slice(0, 4)
    .map((entry) => entry.seed);
}

function buildSearchQueries(playlistTitle: string | undefined, seeds: SuggestionSeed[]): string[] {
  const chosenSeeds = chooseSearchSeeds(seeds);
  const topProfile = classifyEnergyTrack(chosenSeeds[0] ?? seeds[0]);
  const energy = energyLabel(topProfile.bucket);
  const artistTerms = uniqueUsefulTerms(chosenSeeds.map(getArtistLikeTerm), 4);
  const artists = artistTerms.slice(0, 3).join(" ");
  const tagTerms = chosenSeeds
    .flatMap((seed) => seed.tags ?? [])
    .map(normalizeText)
    .filter((tag) => tag.length > 2 && tag.length < 28)
    .slice(0, 4)
    .join(" ");
  const playlistTerm = playlistTitle ? normalizeText(playlistTitle) : "";

  const primaryArtist = normalizeText(`${artistTerms[0] ?? playlistTerm} similar songs music`);
  const secondaryArtist = normalizeText(`${artistTerms[1] ?? ""} similar songs music`);
  const primary = normalizeText(
    `${artists || playlistTerm} ${tagTerms} ${energy} similar songs music`
  );
  const fallback = normalizeText(
    `${playlistTerm || artists} ${energy} music playlist recommendations`
  );
  const artistFallback = normalizeText(`${artists} similar artists songs music`);
  const playlistFallback = normalizeText(`${playlistTerm} songs like this playlist`);

  return Array.from(
    new Set(
      [primaryArtist, secondaryArtist, primary, fallback, artistFallback, playlistFallback].filter(
        (query) => query.length > 8
      )
    )
  ).slice(0, MAX_SEARCH_QUERIES);
}

function getSeedSignals(seeds: SuggestionSeed[]) {
  return {
    artists: uniqueUsefulTerms(seeds.map(getArtistLikeTerm), 10),
    channels: uniqueUsefulTerms(seeds.map((seed) => seed.channelTitle), 10),
    topBucket: classifyEnergyTrack(seeds[0] ?? { title: "", channelTitle: "" }).bucket,
  };
}

function includesTerm(haystack: string, term: string): boolean {
  if (!term || term.length < 3 || haystack.length < 3) return false;
  return haystack.includes(term) || term.includes(haystack);
}

function scoreCandidate(
  item: SearchCandidate,
  body: ValidatedSuggestionsRequest,
  details: Map<string, VideoDetails>
): number {
  const signals = getSeedSignals(body.seeds);
  const videoId = item.id?.videoId;
  const detail = videoId ? details.get(videoId) : undefined;
  const title = normalizeIdentity(item.snippet?.title ?? "");
  const channel = normalizeIdentity(item.snippet?.channelTitle ?? "");
  const query = normalizeIdentity(item.query);
  const combined = `${title} ${channel}`;

  let score = 0;

  for (const channelTerm of signals.channels) {
    if (channel === channelTerm) score += 14;
    else if (includesTerm(channel, channelTerm)) score += 9;
    if (includesTerm(title, channelTerm)) score += 5;
  }

  for (const artistTerm of signals.artists) {
    if (includesTerm(channel, artistTerm)) score += 11;
    if (includesTerm(title, artistTerm)) score += 9;
    if (includesTerm(query, artistTerm)) score += 2;
  }

  const candidateProfile = classifyEnergyTrack({
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    duration: detail?.duration,
  });
  if (candidateProfile.bucket === signals.topBucket) score += 2;

  if (/\b(playlist|mix|hour|reaction|karaoke|tutorial|album)\b/.test(title)) {
    score -= 5;
  }

  if (detail?.duration && detail.duration > 10 * 60) score -= 4;
  if (detail?.duration && detail.duration > 15 * 60) score -= 5;

  if (combined.length === 0) score -= 10;

  return score;
}

function rankCandidates(
  items: SearchCandidate[],
  body: ValidatedSuggestionsRequest,
  details: Map<string, VideoDetails>
): SearchCandidate[] {
  return [...items].sort((a, b) => {
    const scoreDiff = scoreCandidate(b, body, details) - scoreCandidate(a, body, details);
    return scoreDiff || a.rank - b.rank;
  });
}

async function searchVideos(query: string, apiKey: string): Promise<SearchItem[]> {
  const response = await fetchYouTubeJson<{ items?: SearchItem[] }>(
    "search",
    {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: String(SEARCH_RESULTS_PER_QUERY),
      videoEmbeddable: "true",
      videoCategoryId: "10",
      safeSearch: "moderate",
      order: "relevance",
    },
    apiKey
  );

  return response.items ?? [];
}

async function fetchVideoDetails(
  videoIds: string[],
  apiKey: string
): Promise<Map<string, VideoDetails>> {
  if (videoIds.length === 0) return new Map();

  const response = await fetchYouTubeJson<{
    items?: Array<{
      id?: string;
      snippet?: { publishedAt?: string };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string };
    }>;
  }>(
    "videos",
    {
      part: "snippet,contentDetails,statistics",
      id: videoIds.join(","),
    },
    apiKey
  );

  const details = new Map<string, VideoDetails>();
  for (const item of response.items ?? []) {
    if (!item.id) continue;
    details.set(item.id, {
      duration: item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : 0,
      viewCount: item.statistics?.viewCount
        ? Number.parseInt(item.statistics.viewCount, 10)
        : undefined,
      publishedAt: item.snippet?.publishedAt,
    });
  }

  return details;
}

function isReasonableMusicDuration(duration: number): boolean {
  if (!duration) return true;
  return duration >= 45 && duration <= 20 * 60;
}

function toSuggestedVideo(
  item: SearchCandidate,
  videoId: string,
  duration: number,
  body: ValidatedSuggestionsRequest,
  detail?: VideoDetails
): SuggestedVideo {
  return {
    id: videoId,
    youtubeId: videoId,
    title: item.snippet?.title ?? "Untitled suggestion",
    channelTitle: item.snippet?.channelTitle ?? "YouTube",
    thumbnail:
      item.snippet?.thumbnails?.high?.url ??
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url ??
      "",
    duration,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    reason: `Weighted toward this playlist's artists, channels, and ${energyLabel(
      classifyEnergyTrack(body.seeds[0] ?? { title: "", channelTitle: "" }).bucket
    )} signals`,
    query: item.query,
    publishedAt: detail?.publishedAt ?? item.snippet?.publishedAt,
    viewCount: detail?.viewCount,
  };
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return jsonError(500, "Server configuration error");
    }

    const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      return jsonError(413, "Suggestions request is too large");
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError(400, "Invalid JSON request body");
    }

    const body = validateBody(rawBody);
    const cacheKey = getCacheKey(body);
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.result, { status: 200 });
    }

    assertRateLimit(getClientKey(request));

    const excludedIds = new Set(body.excludeVideoIds ?? []);
    const queries = buildSearchQueries(body.playlistTitle, body.seeds ?? []);
    const searchItems: SearchCandidate[] = [];
    let searchCalls = 0;

    for (const query of queries) {
      const items = await searchVideos(query, apiKey);
      searchCalls += 1;
      const rankStart = searchItems.length;
      searchItems.push(
        ...items.map((item, index) => ({ ...item, query, rank: rankStart + index }))
      );

      const uniqueCandidates = new Set(
        searchItems
          .map((item) => item.id?.videoId)
          .filter((id): id is string => typeof id === "string" && !excludedIds.has(id))
      );
      if (searchCalls >= 2 && uniqueCandidates.size >= TARGET_SUGGESTIONS + 4) break;
    }

    const candidateIds = Array.from(
      new Set(
        searchItems
          .map((item) => item.id?.videoId)
          .filter((id): id is string => typeof id === "string" && !excludedIds.has(id))
      )
    );
    const details = await fetchVideoDetails(candidateIds.slice(0, 50), apiKey);
    const detailCalls = candidateIds.length > 0 ? 1 : 0;

    const suggestions: SuggestedVideo[] = [];
    const usedIds = new Set<string>();
    const rankedSearchItems = rankCandidates(searchItems, body, details);

    for (const item of rankedSearchItems) {
      const videoId = item.id?.videoId;
      if (!videoId || usedIds.has(videoId) || excludedIds.has(videoId)) continue;

      const detail = details.get(videoId);
      const duration = detail?.duration ?? 0;
      if (!isReasonableMusicDuration(duration)) continue;

      suggestions.push(toSuggestedVideo(item, videoId, duration, body, detail));
      usedIds.add(videoId);

      if (suggestions.length >= TARGET_SUGGESTIONS) break;
    }

    if (suggestions.length < TARGET_SUGGESTIONS) {
      for (const item of rankedSearchItems) {
        const videoId = item.id?.videoId;
        if (!videoId || usedIds.has(videoId) || excludedIds.has(videoId)) continue;

        const detail = details.get(videoId);
        suggestions.push(toSuggestedVideo(item, videoId, detail?.duration ?? 0, body, detail));
        usedIds.add(videoId);

        if (suggestions.length >= TARGET_SUGGESTIONS) break;
      }
    }

    const result: DailySuggestionsResult = {
      playlistId: body.playlistId,
      generatedAt: new Date().toISOString(),
      dateKey: body.dateKey,
      query: queries[0] ?? "similar music",
      quotaCost: searchCalls * 100 + detailCalls,
      suggestions,
    };

    memoryCache.set(cacheKey, {
      expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
      result,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      "message" in error
    ) {
      const { status, message } = error as ApiError;
      return jsonError(status, message);
    }

    return jsonError(500, "Unexpected server error");
  }
}
