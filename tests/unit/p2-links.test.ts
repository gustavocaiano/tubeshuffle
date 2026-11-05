import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), client: vi.fn(), rpc: vi.fn(), from: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/server/owner-guard", () => ({
  verifyOwner: mocks.verify,
  noStore: (response: Response) => { response.headers.set("Cache-Control", "private, no-store"); return response; },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.client }));
import { GET, POST, PUT } from "@/app/api/playlist-links/route";
import { DELETE } from "@/app/api/playlist-links/[playlistId]/route";

const base = "https://example.test/api/playlist-links";
const id = "PLabcdefghij";
const row = { youtube_playlist_id: id, created_at: "2025-01-01T00:00:00.123999+00:00" };
function req(url = base, init: RequestInit = {}) { return new Request(url, init); }
function post(body: string, contentType = "application/json") { return req(base, { method: "POST", headers: { "content-type": contentType }, body }); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ token: "verified-token" });
  mocks.client.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("owner playlist links", () => {
  it.each([401, 403, 503])("denies %s before validation or CRUD", async (status) => {
    mocks.verify.mockResolvedValue({ error: new Response(null, { status, headers: { "Cache-Control": "no-store" } }) });
    for (const run of [() => GET(req(base + "?bad")), () => POST(post("broken")), () => DELETE(req(base + "/bad", { method: "DELETE" }))]) {
      expect((await run()).status).toBe(status);
    }
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects unsupported methods before auth", async () => {
    const response = PUT();
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, POST");
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each([
    ["{\"playlistId\":\"PLabcdefghij\",\"playlistId\":\"PLabcdefghij\"}", 400],
    ["{\"playlistId\":\"PLabcdefghij\",\"\\u0070laylistId\":\"PLabcdefghij\"}", 400],
    ["{}", 400], ["[]", 400], ["x".repeat(4097), 413],
  ])("rejects malformed or oversized input", async (body, status) => {
    const res = await POST(post(body)); expect(res.status).toBe(status); expect(res.headers.get("cache-control")).toContain("no-store");
    expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("checks query and media precedence before parsing", async () => {
    expect((await POST(req(base + "?", { method: "POST", body: "x".repeat(5000) }))).status).toBe(400);
    expect((await POST(post("", "text/plain"))).status).toBe(415);
    expect((await POST(post("x".repeat(4097), "text/plain"))).status).toBe(413);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("normalizes URLs and maps new, existing, and cap RPC responses", async () => {
    for (const [created, status] of [[true, 201], [false, 200]] as const) {
      mocks.rpc.mockResolvedValueOnce({ data: [{ ...row, created, limit_reached: false }], error: null });
      const res = await POST(post(JSON.stringify({ playlistId: ` https://www.youtube.com/watch?v=x&list=${id} ` })));
      expect(res.status).toBe(status); expect(await res.json()).toEqual({ link: { youtubePlaylistId: id, createdAt: "2025-01-01T00:00:00.123Z" } });
      expect(mocks.rpc).toHaveBeenLastCalledWith("save_playlist_link", { id });
    }
    mocks.rpc.mockResolvedValueOnce({ data: [{ created: false, limit_reached: true }], error: null });
    expect((await POST(post(JSON.stringify({ playlistId: id })))).status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("returns safe errors and validates paths before deletion", async () => {
    expect((await DELETE(req(base + "/bad%2Fid", { method: "DELETE" }))).status).toBe(400);
    expect(mocks.client).not.toHaveBeenCalled();
    const eq = vi.fn().mockResolvedValue({ error: null }); mocks.from.mockReturnValue({ delete: () => ({ eq }) });
    const res = await DELETE(req(base + "/" + id, { method: "DELETE" }));
    expect(res.status).toBe(204); expect(await res.text()).toBe(""); expect(eq).toHaveBeenCalledWith("youtube_playlist_id", id);
    mocks.rpc.mockResolvedValueOnce({ error: { message: "secret" }, data: null });
    const fail = await POST(post(JSON.stringify({ playlistId: id })));
    expect(fail.status).toBe(500); expect(await fail.text()).not.toContain("secret"); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("lists and sorts without leaking additional columns", async () => {
    const rows = [{ ...row, youtube_playlist_id: "PLABCDEFGHIJ" }, row];
    let calls = 0;
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query, or: () => query,
        then: (resolve: (value: unknown) => void) => resolve({ data: calls++ === 0 ? rows : [], error: null }) };
      return query;
    });
    const res = await GET(req());
    expect(res.status).toBe(200); expect((await res.json()).links.map((x: { youtubePlaylistId: string }) => x.youtubePlaylistId)).toEqual(["PLABCDEFGHIJ", id]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("paginates all 5000 rows with a stable keyset and a final empty page", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ youtube_playlist_id: `PL${String(i).padStart(10, "0")}`, created_at: "2025-01-01T00:00:00.000000+00:00" }));
    let calls = 0;
    const filters: string[] = [];
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query,
        or: (filter: string) => { filters.push(filter); return query; },
        then: (resolve: (value: unknown) => void) => resolve({ data: rows.slice(calls++ * 1000, calls * 1000), error: null }) };
      return query;
    });
    const response = await GET(req());
    expect(response.status).toBe(200); expect((await response.json()).links).toHaveLength(5000);
    expect(calls).toBe(6); expect(filters).toHaveLength(5); expect(filters[0]).toContain("PL0000000999");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("continues through short pages under a server cap of 100", async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => ({ youtube_playlist_id: `PL${String(i).padStart(10, "0")}`, created_at: "2025-01-01T00:00:00.000000+00:00" }));
    let calls = 0;
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query, or: () => query,
        then: (resolve: (value: unknown) => void) => resolve({ data: rows.slice(calls++ * 100, calls * 100), error: null }) };
      return query;
    });
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect((await response.json()).links.map((link: { youtubePlaylistId: string }) => link.youtubePlaylistId)).toEqual(rows.map((r) => r.youtube_playlist_id));
    expect(calls).toBe(14);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["repeated", [row, row]],
    ["backward", [row, { ...row, created_at: "2024-01-01T00:00:00Z" }]],
    ["invalid timestamp", [row, { ...row, created_at: "2025-01-01T00:00:00Z),injected" }]],
    ["invalid ID", [row, { ...row, youtube_playlist_id: "bad),filter" }]],
  ])("fails safely on %s cursor", async (_name, rows) => {
    let calls = 0;
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query, or: () => query,
        then: (resolve: (value: unknown) => void) => resolve({ data: [rows[Math.min(calls++, rows.length - 1)]], error: null }) };
      return query;
    });
    expect((await GET(req())).status).toBe(500);
    expect(calls).toBe(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects a 5001st row rather than returning a truncated result", async () => {
    let index = 0;
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query, or: () => query,
        then: (resolve: (value: unknown) => void) => resolve({ data: Array.from({ length: 100 }, () => ({ youtube_playlist_id: `PL${String(index++).padStart(10, "0")}`, created_at: "2025-01-01T00:00:00Z" })), error: null }) };
      return query;
    });
    expect((await GET(req())).status).toBe(500);
    expect(index).toBe(5100);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not promise a snapshot when an insertion occurs before the cursor", async () => {
    const early = { ...row, youtube_playlist_id: "PL0000000000" };
    const later = { ...row, youtube_playlist_id: "PL0000000002" };
    const insertedBeforeCursor = { ...row, youtube_playlist_id: "PL0000000001" };
    let calls = 0;
    const database = [early, later];
    mocks.from.mockImplementation(() => {
      let filter = "";
      const query = { select: () => query, order: () => query, limit: () => query, or: (value: string) => { filter = value.split("youtube_playlist_id.gt.")[1].replace(/\)$/, ""); return query; },
        then: (resolve: (value: unknown) => void) => {
          if (calls++ === 0) { const page = [...database]; database.push(insertedBeforeCursor); resolve({ data: page, error: null }); }
          else resolve({ data: database.filter((item) => item.youtube_playlist_id > filter), error: null });
        } };
      return query;
    });
    const response = await GET(req());
    const links = (await response.json()).links;
    expect(links.map((link: { youtubePlaylistId: string }) => link.youtubePlaylistId)).toEqual([early.youtube_playlist_id, later.youtube_playlist_id]);
    expect(links.some((link: { youtubePlaylistId: string }) => link.youtubePlaylistId === insertedBeforeCursor.youtube_playlist_id)).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves microsecond ordering even when DTO timestamps round to the same millisecond", async () => {
    const rows = [{ ...row, youtube_playlist_id: "PLzzzzzzzzzz", created_at: "2025-01-01T00:00:00.123001Z" },
      { ...row, youtube_playlist_id: "PLAAAAAAAAAA", created_at: "2025-01-01T00:00:00.123002Z" }];
    let calls = 0;
    mocks.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, limit: () => query, or: () => query,
        then: (resolve: (value: unknown) => void) => resolve({ data: calls < rows.length ? [rows[calls++]] : [], error: null }) };
      return query;
    });
    const response = await GET(req());
    expect(response.status).toBe(200);
    expect((await response.json()).links.map((link: { youtubePlaylistId: string }) => link.youtubePlaylistId)).toEqual(["PLAAAAAAAAAA", "PLzzzzzzzzzz"]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
