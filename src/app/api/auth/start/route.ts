import { appOrigin, authRedirect, routeSession } from "@/lib/server/session";
import { noStore } from "@/lib/server/owner-guard";

// Navigate here as a top-level same-origin GET; there is no redirect parameter.
export async function GET(request: Request): Promise<Response> {
  const origin = appOrigin();
  const response = authRedirect("/dashboard?auth_result=failed");
  try {
    const site = request.headers.get("sec-fetch-site");
    const source = request.headers.get("origin");
    if (!origin || new URL(request.url).origin !== origin || (site && site !== "same-origin" && site !== "none") || (source && source !== origin) || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return response;
    const client = routeSession(request, response);
    const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${origin}/auth/callback`, skipBrowserRedirect: true } });
    if (!error && data.url) response.headers.set("Location", data.url);
  } catch { /* Do not reveal provider details. */ }
  return response;
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "GET" } }));
export { unsupported as POST, unsupported as PUT, unsupported as PATCH, unsupported as DELETE, unsupported as OPTIONS, unsupported as HEAD };
