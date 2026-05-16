import { browserStorage } from "@/lib/storage";
import type { DailySuggestionsResult } from "@/types/playlist";

const CACHE_VERSION = 2;

export type DailySuggestionsCacheRecord = DailySuggestionsResult & {
  version: typeof CACHE_VERSION;
};

export function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCacheKey(playlistId: string, dateKey = getLocalDateKey()): string {
  return `dailySuggestions:${playlistId}:${dateKey}`;
}

function getResuggestKey(playlistId: string, dateKey = getLocalDateKey()): string {
  return `dailySuggestionsResuggest:${playlistId}:${dateKey}`;
}

export async function getDailySuggestionsCache(
  playlistId: string,
  dateKey = getLocalDateKey()
): Promise<DailySuggestionsCacheRecord | null> {
  const record = await browserStorage.getMetaValue<DailySuggestionsCacheRecord>(
    getCacheKey(playlistId, dateKey)
  );

  if (!record || record.version !== CACHE_VERSION || record.dateKey !== dateKey) {
    return null;
  }

  return record;
}

export async function setDailySuggestionsCache(
  result: DailySuggestionsResult
): Promise<DailySuggestionsCacheRecord> {
  const record: DailySuggestionsCacheRecord = {
    ...result,
    version: CACHE_VERSION,
  };

  await browserStorage.setMetaValue(getCacheKey(result.playlistId, result.dateKey), record);
  return record;
}

export async function getDailySuggestionsResuggestUsed(
  playlistId: string,
  dateKey = getLocalDateKey()
): Promise<boolean> {
  return Boolean(await browserStorage.getMetaValue<boolean>(getResuggestKey(playlistId, dateKey)));
}

export async function setDailySuggestionsResuggestUsed(
  playlistId: string,
  dateKey = getLocalDateKey()
): Promise<void> {
  await browserStorage.setMetaValue(getResuggestKey(playlistId, dateKey), true);
}
