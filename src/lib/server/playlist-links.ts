import { createClient } from "@supabase/supabase-js";
import { noStore } from "@/lib/server/owner-guard";

export const idPattern = /^[A-Za-z0-9_-]{10,80}$/;
const limit = 4096;
export const errorResponse = (status: number, code: string) => noStore(Response.json({ error: { code, message: code } }, { status }));
export const invalid = () => errorResponse(400, "invalid_request");
export const internal = () => errorResponse(500, "internal_error");

export function normalizeId(input: string): string | null {
  const value = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (idPattern.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) || !["/playlist", "/watch"].includes(url.pathname)) return null;
    const list = url.searchParams.getAll("list");
    return list.length === 1 && idPattern.test(list[0]) ? list[0] : null;
  } catch { return null; }
}

export function hasQuery(request: Request): boolean {
  return request.url.split("#", 1)[0].includes("?");
}

export async function bodyBytes(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { reader.releaseLock(); }
}

export function jsonMediaType(value: string | null): boolean {
  if (!value) return false;
  const parts = value.split(";");
  if (parts.shift()?.trim().toLowerCase() !== "application/json") return false;
  let charset = false;
  for (const part of parts) {
    const match = /^\s*([!#$%&'*+.^_`|~\w-]+)\s*=\s*("[^"\r\n]*"|[!#$%&'*+.^_`|~\w-]+)\s*$/.exec(part);
    if (!match) return false;
    if (match[1].toLowerCase() === "charset") {
      if (charset || match[2].replace(/^"|"$/g, "").toLowerCase() !== "utf-8") return false;
      charset = true;
    }
  }
  return true;
}

export function parsePost(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // The only valid shape has exactly one JSON string key and value. This
    // rejects duplicates (including escaped key spellings) before JSON.parse.
    const string = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
    const match = new RegExp(`^[\\x20\\t\\r\\n]*\\{[\\x20\\t\\r\\n]*(${string})[\\x20\\t\\r\\n]*:[\\x20\\t\\r\\n]*(${string})[\\x20\\t\\r\\n]*\\}[\\x20\\t\\r\\n]*$`).exec(text);
    if (!match || JSON.parse(match[1]) !== "playlistId") return null;
    return normalizeId(JSON.parse(match[2]));
  } catch { return null; }
}

export function dbClient(token: string) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
}

export function dto(row: { youtube_playlist_id: unknown; created_at: unknown }) {
  if (typeof row.youtube_playlist_id !== "string" || !idPattern.test(row.youtube_playlist_id) || typeof row.created_at !== "string") throw new Error("invalid database row");
  const date = new Date(row.created_at);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid timestamp");
  const createdAt = date.toISOString();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) || createdAt.startsWith("0000")) throw new Error("invalid timestamp");
  return { youtubePlaylistId: row.youtube_playlist_id, createdAt };
}
