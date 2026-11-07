export const MAX_SUGGESTION_SEEDS = 40;
// A full 5,000-video playlist plus the five suggestions excluded by Again.
export const MAX_SUGGESTION_EXCLUSIONS = 5_005;
export const MAX_SUGGESTION_REQUEST_BYTES = 128_000;
export const CLIENT_SUGGESTION_REQUEST_BYTES = 100 * 1024;
export const SUGGESTION_ALGORITHM_VERSION = 3;

export interface SuggestionSeed {
  title: string;
  channelTitle: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  duration?: number;
}

export interface SuggestionsInput {
  playlistId: string;
  playlistTitle?: string;
  dateKey: string;
  seeds: SuggestionSeed[];
  excludeVideoIds: string[];
  refreshToken?: string;
}

export class SuggestionsInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, length: number): string {
  // Preserve surrogate pairs at a field boundary.
  return value.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
}

export function normalizeSuggestionsInput(body: unknown): SuggestionsInput {
  if (!isRecord(body)) throw new SuggestionsInputError("Invalid suggestions request body");
  const playlistId = typeof body.playlistId === "string" ? body.playlistId.trim() : "";
  if (!playlistId || playlistId.length > 120) {
    throw new SuggestionsInputError("Missing or invalid playlist id");
  }
  const dateKey = body.dateKey === undefined ? new Date().toISOString().slice(0, 10) : body.dateKey;
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
      dateKey.startsWith("0000") || !Number.isFinite(Date.parse(dateKey)) ||
      new Date(dateKey).toISOString().slice(0, 10) !== dateKey) {
    throw new SuggestionsInputError("Invalid suggestions date key");
  }
  const seeds: SuggestionSeed[] = [];
  if (Array.isArray(body.seeds)) {
    for (const seed of body.seeds) {
      if (!isRecord(seed) || typeof seed.title !== "string" || typeof seed.channelTitle !== "string") continue;
      seeds.push({
        title: truncate(seed.title, 180),
        channelTitle: truncate(seed.channelTitle, 120),
        description: typeof seed.description === "string" ? truncate(seed.description, 600) : undefined,
        tags: Array.isArray(seed.tags) ? seed.tags.filter((tag): tag is string => typeof tag === "string")
          .slice(0, 12).map(tag => truncate(tag, 60)) : undefined,
        categoryId: typeof seed.categoryId === "string" ? truncate(seed.categoryId, 20) : undefined,
        duration: typeof seed.duration === "number" && Number.isFinite(seed.duration) && seed.duration >= 0
          ? seed.duration : undefined,
      });
      if (seeds.length === MAX_SUGGESTION_SEEDS) break;
    }
  }
  if (!seeds.length) throw new SuggestionsInputError("At least one suggestion seed is required");
  const ids = body.excludeVideoIds === undefined ? [] : body.excludeVideoIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id))) {
    throw new SuggestionsInputError("Invalid excluded video id");
  }
  const excludeVideoIds = [...new Set<string>(ids)].sort();
  if (excludeVideoIds.length > MAX_SUGGESTION_EXCLUSIONS) {
    throw new SuggestionsInputError("Too many excluded video ids");
  }
  return {
    playlistId,
    playlistTitle: typeof body.playlistTitle === "string" ? truncate(body.playlistTitle, 160) : undefined,
    dateKey,
    seeds,
    excludeVideoIds,
    refreshToken: typeof body.refreshToken === "string" ? truncate(body.refreshToken, 80) : undefined,
  };
}

/** Serialize only bounded fields; retain all exclusions even when metadata must shrink. */
export function serializeSuggestionsInput(body: unknown): string {
  const input = normalizeSuggestionsInput(body);
  let json = JSON.stringify(input);
  const fits = () => new TextEncoder().encode(json).byteLength <= CLIENT_SUGGESTION_REQUEST_BYTES;
  if (!fits()) {
    for (const seed of input.seeds) delete seed.description;
    json = JSON.stringify(input);
  }
  if (!fits()) {
    for (const seed of input.seeds) delete seed.tags;
    json = JSON.stringify(input);
  }
  while (!fits() && input.seeds.length > 1) {
    input.seeds.pop();
    json = JSON.stringify(input);
  }
  if (!fits()) throw new SuggestionsInputError("Suggestions request is too large");
  return json;
}
