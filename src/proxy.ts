import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { secureCookieOptions, sessionCookieOptions } from "@/lib/server/session";

// Session maintenance only. Each protected handler performs its own verification.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const excluded = ["/api/auth/start", "/api/auth/logout", "/auth/callback"].includes(request.nextUrl.pathname);
  if (url && key && !excluded && !request.headers.has("authorization")) {
    const client = createServerClient(url, key, { cookieOptions: sessionCookieOptions(), cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values, headers) => {
        for (const { name, value } of values) request.cookies.set(name, value);
        const previousCookies = response.cookies.getAll();
        const previousHeaders = new Headers(response.headers);
        response = NextResponse.next({ request });
        for (const cookie of previousCookies) response.cookies.set(cookie);
        for (const name of ["cache-control", "expires", "pragma"]) {
          const value = previousHeaders.get(name);
          if (value) response.headers.set(name, value);
        }
        for (const { name, value, options } of values) response.cookies.set(name, value, secureCookieOptions(options));
        for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      },
    } });
    try { await client.auth.getSession(); } catch { /* The handler fails closed. */ }
  }
  response.headers.set("Cache-Control", "private, no-cache, no-store, must-revalidate, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export const config = { matcher: ["/api/youtube/:path*", "/api/playlist-links/:path*", "/api/auth/:path*"] };
