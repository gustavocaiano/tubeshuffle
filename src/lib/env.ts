import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.string(),
  AUTH_SECRET: z.string().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLIC_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID_MONTHLY: z.string().optional(),
  STRIPE_PRICE_ID_YEARLY: z.string().optional(),
  REDIS_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  MAX_FREE_PLAYLISTS: z.coerce.number().default(3),
  MAX_PREMIUM_PLAYLISTS: z.coerce.number().default(50),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Lazily parse environment variables. This avoids build-time errors
 * when env vars are not yet set (e.g. during `next build` in CI).
 */
export function getEnv(): Env {
  if (_env) return _env;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // During build time, provide sensible defaults
    if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
      console.warn(
        "Environment variables not fully configured. Using defaults for build."
      );
      _env = {
        DATABASE_URL: "",
        MAX_FREE_PLAYLISTS: 3,
        MAX_PREMIUM_PLAYLISTS: 50,
      } as Env;
      return _env;
    }
    console.error("Invalid environment variables:", parsed.error.format());
    throw new Error("Invalid environment variables");
  }

  _env = parsed.data;
  return _env;
}

// For convenience — most files can still do `import { env } from '@/lib/env'`
// This is a getter-backed proxy approach to keep it lazy.
export const env = new Proxy({} as Env, {
  get(_, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
