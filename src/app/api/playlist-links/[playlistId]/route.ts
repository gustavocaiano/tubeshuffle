import { noStore, verifyOwner } from "@/lib/server/owner-guard";
import { bodyBytes, dbClient, hasQuery, idPattern, internal, invalid } from "@/lib/server/playlist-links";

export async function DELETE(request: Request): Promise<Response> {
  const verified = await verifyOwner(request, "mutation");
  if (verified.error) return verified.error;
  try {
    if (hasQuery(request)) return invalid();
    const path = new URL(request.url).pathname;
    const prefix = "/api/playlist-links/";
    if (!path.startsWith(prefix)) return invalid();
    const raw = path.slice(prefix.length);
    if (!raw || raw.includes("/")) return invalid();
    let id: string;
    try { id = decodeURIComponent(raw); } catch { return invalid(); }
    if (!idPattern.test(id)) return invalid();
    const bytes = await bodyBytes(request);
    if (!bytes || bytes.length) return invalid();
    const { error } = await dbClient(verified.token).from("playlist_links").delete().eq("youtube_playlist_id", id);
    if (error) return internal();
    return noStore(new Response(null, { status: 204 }));
  } catch { return internal(); }
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "DELETE" } }));
export { unsupported as GET, unsupported as POST, unsupported as PUT, unsupported as PATCH, unsupported as OPTIONS, unsupported as HEAD };
