import { appOrigin, authRedirect, routeSession } from "@/lib/server/session";
import { noStore } from "@/lib/server/owner-guard";

export async function GET(request: Request): Promise<Response> {
  const origin = appOrigin();
  const response = authRedirect("/dashboard?auth_result=failed");
  try {
    if (!origin || new URL(request.url).origin !== origin || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return response;
    const query = new URL(request.url).searchParams;
    const codes = query.getAll("code");
    if (query.has("error") || codes.length !== 1 || !codes[0]) return response;
    const { error } = await routeSession(request, response).auth.exchangeCodeForSession(codes[0]);
    if (!error) response.headers.set("Location", `${origin}/dashboard`);
  } catch { /* Always remove callback parameters from the browser URL. */ }
  return response;
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "GET" } }));
export { unsupported as POST, unsupported as PUT, unsupported as PATCH, unsupported as DELETE, unsupported as OPTIONS, unsupported as HEAD };
