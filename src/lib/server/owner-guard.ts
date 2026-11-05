import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { appOrigin, secureCookieOptions, sessionCookieOptions } from "@/lib/server/session";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function ownerError(status: 401 | 403 | 503): Response {
  const code = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "auth_unavailable";
  return noStore(Response.json({ error: { code, message: code } }, { status }));
}

export function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configured = appOrigin();
  if (!origin || !configured || origin === "null") return false;
  try {
    const a = new URL(origin), b = new URL(configured);
    return a.origin === origin && b.origin === configured && a.origin === b.origin;
  } catch { return false; }
}

type Intent = "read" | "link-read" | "mutation" | "csrf" | "logout";
type Verified = { error: Response; token?: never; sessionId?: never; userId?: never; cookieClient?: never } | { error?: never; token: string; userId?: string; sessionId?: string; cookieClient?: ReturnType<typeof createServerClient> };

function authFailure(error: { status?: number; code?: string } | null): Response {
  const invalid = new Set(["bad_jwt", "session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "user_not_found", "invalid_jwt"]);
  return ownerError(error && (error.status === 401 || (error.code && invalid.has(error.code))) ? 401 : 503);
}

export async function verifyOwner(request: Request, intent: Intent): Promise<Verified> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const owner = process.env.OWNER_USER_ID;
  const sessionOnly = intent === "csrf" || intent === "logout";
  if (!url || !key || (!sessionOnly && (!owner || !uuid.test(owner)))) return { error: ownerError(503) };
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer +([A-Za-z0-9._~+/-]+=*)$/i);
  if (header !== null && !match) return { error: ownerError(401) };
  try {
    if (sessionOnly && match) return { error: ownerError(403) };
    if (intent === "csrf" && (request.headers.get("sec-fetch-site") === "cross-site" || (request.headers.has("origin") && !validOrigin(request)))) return { error: ownerError(403) };
    let cookieClient: ReturnType<typeof createServerClient> | undefined;
    let token = match?.[1];
    if (!token) {
      if (!appOrigin()) return { error: ownerError(503) };
      const jar = await cookies();
      const client = cookieClient = createServerClient(url, key, { cookieOptions: sessionCookieOptions(), cookies: {
        getAll: () => jar.getAll(),
        setAll: (values) => { for (const { name, value, options } of values) jar.set(name, value, secureCookieOptions(options)); },
      } });
      const session = await client.auth.getSession();
      if (session.error) return { error: authFailure(session.error) };
      token = session.data.session?.access_token;
      if (!token) return { error: ownerError(401) };
    }
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data, error } = await client.auth.getUser(token);
    if (error) return { error: authFailure(error) };
    if (!data.user) return { error: ownerError(503) };
    const userId = data.user.id;
    if (!uuid.test(userId)) return { error: ownerError(403) };
    if (!sessionOnly) {
      if (userId !== owner) return { error: ownerError(403) };
      const pin = await client.rpc("is_approved_owner");
      if (pin.error || pin.data !== true) return { error: ownerError(503) };
    }
    if (!match) {
      if (intent === "read") {
        if (request.headers.get("x-tubeshuffle-intent") !== "playlist" || request.headers.get("sec-fetch-site") === "cross-site" || (request.headers.has("origin") && !validOrigin(request))) return { error: ownerError(403) };
      } else if (intent !== "link-read") {
        if ((intent === "mutation" || intent === "logout") && !validOrigin(request)) return { error: ownerError(403) };
        const secret = process.env.CSRF_HMAC_SECRET;
        if (!secret || !/^[0-9a-f]{64,}$/i.test(secret)) return { error: ownerError(503) };
        const claims = await client.auth.getClaims(token);
        if (claims.error) return { error: authFailure(claims.error) };
        const payload = claims.data?.claims;
        if (!payload || payload.sub !== userId || payload.iss !== `${url.replace(/\/$/, "")}/auth/v1` || payload.aud !== "authenticated" || typeof payload.session_id !== "string" || !uuid.test(payload.session_id)) return { error: ownerError(403) };
        const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(`tubeshuffle-csrf-v1\0${userId}\0${payload.session_id}`).digest();
        if (intent === "csrf") return { token, userId, sessionId: payload.session_id, cookieClient };
        const supplied = request.headers.get("x-csrf-token") ?? "";
        if (!/^v1\.[A-Za-z0-9_-]{43}$/.test(supplied)) return { error: ownerError(403) };
        const bytes = Buffer.from(supplied.slice(3), "base64url");
        if (bytes.length !== 32 || bytes.toString("base64url") !== supplied.slice(3) || !timingSafeEqual(bytes, expected)) return { error: ownerError(403) };
      }
    }
    return { token, cookieClient };
  } catch { return { error: ownerError(503) }; }
}

export async function guardOwner(request: Request, intent: "read" | "mutation"): Promise<Response | null> {
  return (await verifyOwner(request, intent)).error ?? null;
}

export function csrfToken(userId: string, sessionId: string): string {
  const secret = process.env.CSRF_HMAC_SECRET!;
  return "v1." + createHmac("sha256", Buffer.from(secret, "hex")).update(`tubeshuffle-csrf-v1\0${userId}\0${sessionId}`).digest("base64url");
}
