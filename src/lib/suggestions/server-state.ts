import { createHash } from "node:crypto";
import type { DailySuggestionsResult } from "@/types/playlist";
import { SUGGESTION_ALGORITHM_VERSION, type SuggestionsInput } from "./input-policy";

export const SUGGESTION_CACHE_CAPACITY = 256;
export const SUGGESTION_RATE_CAPACITY = 1024;
export const SUGGESTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SUGGESTION_RATE_WINDOW_MS = 60 * 60 * 1000;
export const SUGGESTION_RATE_MAX_REQUESTS = 30;

export function suggestionFingerprint(input: SuggestionsInput): string {
  // The policy constructs fields in a fixed order, sorts/deduplicates exclusions,
  // and retains seed order because ranking uses it as a tie breaker.
  return createHash("sha256").update(JSON.stringify([SUGGESTION_ALGORITHM_VERSION, input])).digest("hex");
}

/** Opportunistically evicted, process-local state; never a deployment-wide quota. */
export class SuggestionsServerState {
  private readonly cache = new Map<string, { expiresAt: number; result: DailySuggestionsResult }>();
  private readonly rates = new Map<string, { expiresAt: number; count: number }>();

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
    for (const [key, entry] of this.rates) if (entry.expiresAt <= now) this.rates.delete(key);
  }

  getCached(key: string): DailySuggestionsResult | undefined {
    this.prune();
    return this.cache.get(key)?.result;
  }

  cacheResult(key: string, result: DailySuggestionsResult): void {
    this.prune();
    this.cache.delete(key);
    if (this.cache.size >= SUGGESTION_CACHE_CAPACITY) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expiresAt: Date.now() + SUGGESTION_CACHE_TTL_MS, result });
  }

  admitRequest(client: string): boolean {
    this.prune();
    // Bound retained header bytes as well as entry count.
    const key = createHash("sha256").update(client).digest("hex");
    const current = this.rates.get(key);
    if (current) {
      if (current.count >= SUGGESTION_RATE_MAX_REQUESTS) return false;
      current.count += 1;
    } else {
      // Do not evict a live counter: rotating client keys must not reset limits.
      if (this.rates.size >= SUGGESTION_RATE_CAPACITY) return false;
      this.rates.set(key, { expiresAt: Date.now() + SUGGESTION_RATE_WINDOW_MS, count: 1 });
    }
    return true;
  }

  get sizes(): { cache: number; rates: number } {
    this.prune();
    return { cache: this.cache.size, rates: this.rates.size };
  }
}
