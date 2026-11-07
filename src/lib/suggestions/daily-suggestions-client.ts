import { isStorageGenerationCurrent } from "@/hooks/use-browser-storage";
import { BrowserStorageError, subscribeBrowserStorage } from "@/lib/storage/browser-session";
import { getCsrf, responseError } from "@/lib/services/account-client";
import type { DailySuggestionsResult, SuggestedVideo } from "@/types/playlist";
import { getDailySuggestionsCache, getDailySuggestionsResuggestUsed, setDailySuggestionsCache, setDailySuggestionsResuggestUsed } from "./daily-suggestions-cache";
import { serializeSuggestionsInput, SUGGESTION_ALGORITHM_VERSION, type SuggestionsInput } from "./input-policy";

export type DailySuggestionsQueryResult = DailySuggestionsResult & { source: "cache" | "network"; resuggestUsed: boolean };

export interface SuggestionsOperation {
  body: string;
  generation: number;
  signal: AbortSignal;
  previousSuggestions?: SuggestedVideo[];
}

export function assertSuggestionsOperation(operation: Pick<SuggestionsOperation, "generation" | "signal">): void {
  operation.signal.throwIfAborted();
  if (!isStorageGenerationCurrent(operation.generation)) throw new BrowserStorageError("stale");
}

export async function fetchDailySuggestions(operation: SuggestionsOperation): Promise<DailySuggestionsQueryResult> {
  assertSuggestionsOperation(operation);
  const controller = new AbortController();
  const abort = () => controller.abort();
  operation.signal.addEventListener("abort", abort, { once: true });
  const unsubscribe = subscribeBrowserStorage(() => {
    if (!isStorageGenerationCurrent(operation.generation)) abort();
  });
  const current = { ...operation, signal: controller.signal };
  const assertCurrent = () => assertSuggestionsOperation(current);
  try {
    // Use the same complete canonical input as the query key; refresh results
    // replace today's cache for this input, while the once/day marker stays separate.
    const input: SuggestionsInput = JSON.parse(operation.body);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify([SUGGESTION_ALGORITHM_VERSION, input]),
    ));
    assertCurrent();
    const scope = {
      playlistId: input.playlistId, dateKey: input.dateKey, generation: operation.generation,
      inputFingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
    };
    const resuggestUsed = await getDailySuggestionsResuggestUsed(scope.playlistId, scope.dateKey, scope.generation);
    assertCurrent();
    const refresh = operation.previousSuggestions !== undefined;
    const cached = refresh ? null : await getDailySuggestionsCache(scope);
    assertCurrent();
    if (cached && cached.suggestions.length >= 5) return { ...cached, source: "cache", resuggestUsed };

    const body = refresh ? serializeSuggestionsInput({
      ...input,
      excludeVideoIds: [...input.excludeVideoIds, ...operation.previousSuggestions!.map(item => item.youtubeId)],
      refreshToken: `${input.dateKey}:${Date.now()}`,
    }) : operation.body;
    const csrfToken = await getCsrf(current.signal);
    assertCurrent();
    const response = await fetch("/api/youtube/suggestions", {
      method: "POST", signal: current.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-csrf-token": csrfToken },
      body,
    });
    assertCurrent();
    if (!response.ok) throw await responseError(response);
    const result = await response.json() as DailySuggestionsResult;
    assertCurrent();
    if (result.playlistId !== scope.playlistId || result.dateKey !== scope.dateKey) {
      throw new Error("Suggestions returned for a different playlist or day.");
    }
    await setDailySuggestionsCache(result, scope);
    assertCurrent();
    if (refresh) {
      await setDailySuggestionsResuggestUsed(scope.playlistId, scope.dateKey, scope.generation);
      assertCurrent();
    }
    return { ...result, source: "network", resuggestUsed: refresh || resuggestUsed };
  } finally {
    unsubscribe();
    operation.signal.removeEventListener("abort", abort);
  }
}
