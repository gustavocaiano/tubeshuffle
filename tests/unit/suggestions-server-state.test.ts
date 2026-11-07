import { afterEach, expect, it, vi } from "vitest";
import type { DailySuggestionsResult } from "@/types/playlist";
import { SuggestionsServerState, SUGGESTION_CACHE_CAPACITY, SUGGESTION_RATE_CAPACITY, SUGGESTION_RATE_MAX_REQUESTS, SUGGESTION_CACHE_TTL_MS, SUGGESTION_RATE_WINDOW_MS } from "@/lib/suggestions/server-state";

const result: DailySuggestionsResult = { playlistId: "synthetic", dateKey: "2026-11-07", generatedAt: "2026-11-07T00:00:00Z", query: "fixture", quotaCost: 0, suggestions: [] };
afterEach(() => vi.useRealTimers());

it("bounds cache cardinality, evicts the oldest result, and prunes expired entries", () => {
  vi.useFakeTimers();
  const state = new SuggestionsServerState();
  for (let i = 0; i < SUGGESTION_CACHE_CAPACITY * 3; i++) state.cacheResult(String(i), result);
  expect(state.sizes.cache).toBe(SUGGESTION_CACHE_CAPACITY);
  expect(state.getCached("0")).toBeUndefined();
  expect(state.getCached(String(SUGGESTION_CACHE_CAPACITY * 3 - 1))).toEqual(result);
  vi.advanceTimersByTime(SUGGESTION_CACHE_TTL_MS);
  expect(state.getCached("unrelated-key")).toBeUndefined();
  expect(state.sizes.cache).toBe(0);
});

it("bounds rate cardinality without evicting live quotas, then admits after expiry", () => {
  vi.useFakeTimers();
  const state = new SuggestionsServerState();
  for (let i = 0; i < SUGGESTION_RATE_MAX_REQUESTS; i++) expect(state.admitRequest("first")).toBe(true);
  for (let i = 1; i < SUGGESTION_RATE_CAPACITY; i++) expect(state.admitRequest(String(i))).toBe(true);
  for (let i = 0; i < 100; i++) expect(state.admitRequest(`overflow-${i}`)).toBe(false);
  expect(state.sizes.rates).toBe(SUGGESTION_RATE_CAPACITY);
  expect(state.admitRequest("first")).toBe(false);
  vi.advanceTimersByTime(SUGGESTION_RATE_WINDOW_MS - 1);
  expect(state.admitRequest("first")).toBe(false);
  vi.advanceTimersByTime(1);
  expect(state.admitRequest("new-client")).toBe(true);
  expect(state.sizes.rates).toBe(1);
  expect(state.admitRequest("first")).toBe(true);
});

it("evicts expired rate entries even when only cache hits arrive", () => {
  vi.useFakeTimers();
  const state = new SuggestionsServerState();
  state.admitRequest("first"); state.cacheResult("cached", result);
  vi.advanceTimersByTime(SUGGESTION_RATE_WINDOW_MS);
  expect(state.getCached("cached")).toEqual(result);
  expect(state.sizes).toEqual({ cache: 1, rates: 0 });
});
