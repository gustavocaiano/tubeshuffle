import { redis } from "@/lib/redis";

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetInSeconds: number;
}

/**
 * Redis-based sliding window rate limiter.
 * Falls back to allowing all requests if Redis is not configured.
 */
export async function rateLimit(
  identifier: string,
  maxRequests: number = 30,
  windowSeconds: number = 60
): Promise<RateLimitResult> {
  if (!redis) {
    return { success: true, remaining: maxRequests, resetInSeconds: 0 };
  }

  const key = `ratelimit:${identifier}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  try {
    // Use a sorted set with timestamp as score
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, now - windowMs);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.expire(key, windowSeconds);

    const results = await pipeline.exec();
    // ioredis pipeline results are [error, value] tuples
    const requestCount = (results?.[2]?.[1] as number) ?? 0;

    const remaining = Math.max(0, maxRequests - requestCount);
    const success = requestCount <= maxRequests;

    return {
      success,
      remaining,
      resetInSeconds: windowSeconds,
    };
  } catch {
    // On error, allow the request
    return { success: true, remaining: maxRequests, resetInSeconds: 0 };
  }
}

/**
 * Pre-configured rate limits for different endpoints.
 */
export const rateLimits = {
  /** YouTube API calls: 20 per minute per user */
  youtubeApi: (userId: string) =>
    rateLimit(`youtube:${userId}`, 20, 60),

  /** Playlist import: 5 per minute per user */
  playlistImport: (userId: string) =>
    rateLimit(`import:${userId}`, 5, 60),

  /** General API: 60 per minute per user */
  general: (userId: string) =>
    rateLimit(`general:${userId}`, 60, 60),
};
