import { csrfToken, noStore, verifyOwner } from "@/lib/server/owner-guard";

export async function GET(request: Request): Promise<Response> {
  const verified = await verifyOwner(request, "csrf");
  if (verified.error) return verified.error;
  return noStore(Response.json({ csrfToken: csrfToken(verified.userId!, verified.sessionId!) }));
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "GET" } }));
export { unsupported as POST, unsupported as PUT, unsupported as PATCH, unsupported as DELETE, unsupported as OPTIONS, unsupported as HEAD };
