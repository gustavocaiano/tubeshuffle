import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";

// Never derive the public origin from forwarded headers. HTTP is restricted to
// explicit localhost development, and production never permits it.
export function appOrigin(): string | null {
  try {
    const value = process.env.APP_ORIGIN!;
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return null;
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
    return value;
  } catch { return null; }
}

export function sessionCookieOptions(): CookieOptions {
  const origin = appOrigin();
  return { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" || !origin || new URL(origin).protocol === "https:" };
}

export function secureCookieOptions(options: CookieOptions): CookieOptions {
  const rest = { ...options };
  delete rest.domain;
  return { ...rest, ...sessionCookieOptions() };
}

// Routes own their response so every SDK write (including multiple chunks and
// writes before failure) and its accompanying cache headers reaches the client.
export function routeSession(request: Request, response: NextResponse) {
  const incoming = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) incoming.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => Array.from(incoming, ([name, value]) => ({ name, value })),
      setAll: (values, headers) => {
        for (const { name, value, options } of values) {
          if (options.maxAge === 0) incoming.delete(name); else incoming.set(name, value);
          response.cookies.set(name, value, secureCookieOptions(options));
        }
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      },
    },
  });
}

export function authRedirect(location: string): NextResponse {
  const response = new NextResponse(null, { status: 303, headers: { Location: location, "Referrer-Policy": "no-referrer" } });
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}
