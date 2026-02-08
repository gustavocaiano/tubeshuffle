import Redis from "ioredis";

function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) {
    console.warn("Redis not configured — caching disabled");
    return null;
  }

  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  client.connect().catch(() => {
    // Connection errors are handled by the "error" event
  });

  return client;
}

// Singleton: reuse the same client across hot-reloads in development
const globalForRedis = globalThis as unknown as {
  redis: Redis | null | undefined;
};

export const redis: Redis | null =
  globalForRedis.redis ?? getRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

/**
 * Cache wrapper: check Redis first, fall back to fetcher.
 * If Redis is not configured, always calls the fetcher.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (!redis) {
    return fetcher();
  }

  try {
    const raw = await redis.get(key);
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  } catch {
    // Cache miss or error — fall through to fetcher
  }

  const data = await fetcher();

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data));
  } catch {
    // Ignore cache write failures
  }

  return data;
}

/**
 * Invalidate a cache key.
 */
export async function invalidateCache(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // Ignore errors
  }
}
