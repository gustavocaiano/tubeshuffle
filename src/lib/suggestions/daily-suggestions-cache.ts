import { browserStorage } from "@/lib/storage";
import type { DailySuggestionsResult } from "@/types/playlist";

const CACHE_VERSION = 3;

export type DailySuggestionsCacheRecord = DailySuggestionsResult & {
  version: typeof CACHE_VERSION;
  inputFingerprint: string;
};

export interface SuggestionsCacheScope {
  playlistId: string;
  dateKey: string;
  generation: number;
  inputFingerprint: string;
}

export function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCacheKey(scope: SuggestionsCacheScope): string {
  return `dailySuggestions:${scope.playlistId}:${scope.dateKey}`;
}

function getResuggestKey(playlistId: string, dateKey: string): string {
  return `dailySuggestionsResuggest:${playlistId}:${dateKey}`;
}

export async function getDailySuggestionsCache(scope: SuggestionsCacheScope): Promise<DailySuggestionsCacheRecord | null> {
  const record = await browserStorage.getMetaValue<DailySuggestionsCacheRecord>(getCacheKey(scope), scope.generation);
  if (!record || record.version !== CACHE_VERSION || record.dateKey !== scope.dateKey ||
      record.playlistId !== scope.playlistId || record.inputFingerprint !== scope.inputFingerprint) return null;
  return record;
}

export async function setDailySuggestionsCache(
  result: DailySuggestionsResult,
  scope: SuggestionsCacheScope,
): Promise<void> {
  const record: DailySuggestionsCacheRecord = { ...result, version: CACHE_VERSION, inputFingerprint: scope.inputFingerprint };
  await browserStorage.setMetaValue(getCacheKey(scope), record, scope.generation);
}

export async function getDailySuggestionsResuggestUsed(playlistId: string, dateKey: string, generation: number): Promise<boolean> {
  return Boolean(await browserStorage.getMetaValue<boolean>(getResuggestKey(playlistId, dateKey), generation));
}

export async function setDailySuggestionsResuggestUsed(playlistId: string, dateKey: string, generation: number): Promise<void> {
  await browserStorage.setMetaValue(getResuggestKey(playlistId, dateKey), true, generation);
}
