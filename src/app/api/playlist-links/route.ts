import { noStore, verifyOwner } from "@/lib/server/owner-guard";
import { bodyBytes, dbClient, dto, errorResponse, hasQuery, internal, invalid, jsonMediaType, parsePost } from "@/lib/server/playlist-links";

// Postgres timestamptz has microsecond precision; Date alone loses the last
// three digits needed to check keyset ordering within the same millisecond.
function cursorTime(value: unknown): bigint {
  if (typeof value !== "string") throw new Error("invalid cursor");
  const match = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(value);
  if (!match) throw new Error("invalid cursor");
  const zone = /^[+-]\d\d$/.test(match[4]) ? `${match[4]}:00` : match[4];
  const fraction = (match[3] ?? "").padEnd(6, "0");
  const millis = Date.parse(`${match[1]}T${match[2]}.${fraction.slice(0, 3)}${zone}`);
  if (!Number.isFinite(millis)) throw new Error("invalid cursor");
  return BigInt(millis) * BigInt(1000) + BigInt(fraction.slice(3));
}

export async function GET(request: Request): Promise<Response> {
  const verified = await verifyOwner(request, "link-read");
  if (verified.error) return verified.error;
  try {
    if (hasQuery(request)) return invalid();
    const bytes = await bodyBytes(request);
    if (!bytes || bytes.length) return invalid();
    const client = dbClient(verified.token);
    const links: ReturnType<typeof dto>[] = [];
    let cursor: { created_at: string; youtube_playlist_id: string } | undefined;
    let previousTime: bigint | undefined;
    let previousId = "";
    // Each page is a separate read, not a database snapshot: concurrent writes
    // before the cursor can be missed, and later writes can appear in the result.
    for (;;) {
      let query = client.from("playlist_links").select("youtube_playlist_id,created_at").order("created_at").order("youtube_playlist_id").limit(1000);
      if (cursor) query = query.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},youtube_playlist_id.gt.${cursor.youtube_playlist_id})`);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) return internal();
      if (data.length === 0) break;
      for (const row of data) {
        if (links.length === 5000) return internal();
        const link = dto(row);
        const time = cursorTime(row.created_at);
        if (previousTime !== undefined && (time < previousTime || (time === previousTime && link.youtubePlaylistId <= previousId))) return internal();
        links.push(link);
        previousTime = time;
        previousId = link.youtubePlaylistId;
        cursor = { created_at: row.created_at, youtube_playlist_id: row.youtube_playlist_id };
      }
    }
    links.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.youtubePlaylistId < b.youtubePlaylistId ? -1 : a.youtubePlaylistId > b.youtubePlaylistId ? 1 : 0);
    return noStore(Response.json({ links }));
  } catch { return internal(); }
}

export async function POST(request: Request): Promise<Response> {
  const verified = await verifyOwner(request, "mutation");
  if (verified.error) return verified.error;
  try {
    if (hasQuery(request)) return invalid();
    const bytes = await bodyBytes(request);
    if (!bytes) return errorResponse(413, "payload_too_large");
    if (!jsonMediaType(request.headers.get("content-type"))) return errorResponse(415, "unsupported_media_type");
    const id = parsePost(bytes);
    if (!id) return invalid();
    const { data, error } = await dbClient(verified.token).rpc("save_playlist_link", { id });
    if (error || !Array.isArray(data) || data.length !== 1) return internal();
    const row = data[0];
    if (row.limit_reached === true && row.created === false) return errorResponse(409, "link_limit");
    if (row.limit_reached !== false || typeof row.created !== "boolean" || row.youtube_playlist_id !== id) return internal();
    return noStore(Response.json({ link: dto(row) }, { status: row.created ? 201 : 200 }));
  } catch { return internal(); }
}

const unsupported = () => noStore(new Response(null, { status: 405, headers: { Allow: "GET, POST" } }));
export { unsupported as PUT, unsupported as PATCH, unsupported as DELETE, unsupported as OPTIONS, unsupported as HEAD };
