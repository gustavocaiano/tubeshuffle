import { noStore, ownerError, verifyOwner } from "@/lib/server/owner-guard";

export async function POST(request: Request): Promise<Response> {
  const verified = await verifyOwner(request, "logout");
  if (verified.error) return verified.error;
  if (!verified.cookieClient) return ownerError(403);
  try {
    const { error } = await verified.cookieClient.auth.signOut({ scope: "local" });
    if (error) return ownerError(503);
    return noStore(new Response(null, { status: 204 }));
  } catch {
    return ownerError(503);
  }
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "POST" } }));
export { unsupported as GET, unsupported as PUT, unsupported as PATCH, unsupported as DELETE, unsupported as OPTIONS, unsupported as HEAD };
