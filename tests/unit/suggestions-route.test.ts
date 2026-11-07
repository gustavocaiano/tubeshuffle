import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUGGESTION_REQUEST_BYTES, serializeSuggestionsInput } from "@/lib/suggestions/input-policy";

const auth = vi.hoisted(() => ({ guardOwner: vi.fn() }));
vi.mock("@/lib/server/owner-guard", () => ({
  guardOwner: auth.guardOwner,
  noStore: (response: Response) => { response.headers.set("Cache-Control", "private, no-store"); return response; },
}));
let POST: typeof import("@/app/api/youtube/suggestions/route").POST;
const upstream = vi.fn();
const input = () => ({
  playlistId: "synthetic-playlist", playlistTitle: "Synthetic mix", dateKey: "2026-11-07",
  seeds: [{ title: "Artist - Track", channelTitle: "Artist", description: "calm", tags: ["music"], categoryId: "10", duration: 180 }],
  excludeVideoIds: ["aaaaaaaaaaa", "bbbbbbbbbbb", "zzzzzzzzzzz"],
});
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/youtube/suggestions", { method: "POST", headers, body: JSON.stringify(body) });
}
function streamRequest(bytes: Uint8Array, headers: Record<string, string> = {}) {
  let offset = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + 4093));
    offset = Math.min(offset + 4093, bytes.length);
  });
  const cancel = vi.fn();
  const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  return { pull, cancel, request: new Request("https://example.test/api/youtube/suggestions", {
    method: "POST", headers, body, duplex: "half",
  } as RequestInit) };
}

beforeEach(async () => {
  vi.resetModules();
  auth.guardOwner.mockReset().mockResolvedValue(null);
  vi.stubEnv("YOUTUBE_API_KEY", "synthetic-only");
  upstream.mockReset().mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://www.googleapis.com");
    return Response.json({ items: parsed.pathname.endsWith("/search") ? [{
      id: { videoId: "bbbbbbbbbbb" }, snippet: { title: "Synthetic result", channelTitle: "Artist" },
    }] : [{ id: "bbbbbbbbbbb", contentDetails: { duration: "PT3M" } }] });
  });
  vi.stubGlobal("fetch", upstream);
  ({ POST } = await import("@/app/api/youtube/suggestions/route"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("suggestions request admission (real route, synthetic upstream)", () => {
  it.each([undefined, "1", "300204", "invalid", "-1"])("rejects streamed 300204-byte bodies with Content-Length %s", async (length) => {
    const body = JSON.stringify({ ...input(), padding: "" });
    const bytes = new TextEncoder().encode(body.replace('"padding":""', `"padding":"${"x".repeat(300204 - body.length)}"`));
    expect(bytes.length).toBe(300204);
    const stream = streamRequest(bytes, length === undefined ? {} : { "content-length": length });
    const response = await POST(stream.request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(upstream).not.toHaveBeenCalled();
    if (length !== "300204") expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it("counts UTF-8 bytes, including characters split across stream chunks", async () => {
    const body = JSON.stringify({ ...input(), padding: "🎵".repeat(33000) });
    expect(body.length).toBeLessThan(MAX_SUGGESTION_REQUEST_BYTES);
    const stream = streamRequest(new TextEncoder().encode(body));
    expect((await POST(stream.request)).status).toBe(413);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("accepts exactly the byte limit and rejects the next byte before parsing", async () => {
    const raw = JSON.stringify(input());
    const exact = new TextEncoder().encode(raw + " ".repeat(MAX_SUGGESTION_REQUEST_BYTES - raw.length));
    expect((await POST(streamRequest(exact).request)).status).toBe(200);
    upstream.mockClear();
    const larger = new Uint8Array(exact.length + 1); larger.set(exact); larger[exact.length] = 32;
    expect((await POST(streamRequest(larger).request)).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("authorizes before body reads and quota for %s", async (status) => {
    auth.guardOwner.mockResolvedValue(new Response(null, { status }));
    const stream = streamRequest(new TextEncoder().encode("x".repeat(300204)));
    expect((await POST(stream.request)).status).toBe(status);
    expect(stream.pull).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    auth.guardOwner.mockResolvedValue(null);
    expect((await POST(request(input()))).status).toBe(200);
  });

  it.each(["2026-02-29", "2024-02-30", "2026-13-01", "2026-1-01", " 2026-11-07", "2026-11-07T00:00:00Z", "x".repeat(1000), "", null, "0000-01-01"])("rejects a noncanonical date %s", async (dateKey) => {
    expect((await POST(request({ ...input(), dateKey }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["2024-02-29", undefined])("accepts a leap day or omitted date %s", async (dateKey) => {
    expect((await POST(request({ ...input(), dateKey }))).status).toBe(200);
  });

  it.each([{ ids: ["short"] }, { ids: ["x".repeat(1000)] }, { ids: ["abcdefghij!"] }, { ids: [42] }, { ids: "abcdefghijk" }, { ids: null }])("rejects invalid exclusion IDs %j", async ({ ids: excludeVideoIds }) => {
    expect((await POST(request({ ...input(), excludeVideoIds }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects excess unique exclusions rather than silently dropping required IDs", async () => {
    const body = { ...input(), excludeVideoIds: Array.from({ length: 5006 }, (_, i) => `v${String(i).padStart(10, "0")}`) };
    expect((await POST(request(body))).status).toBe(400);
    expect(() => serializeSuggestionsInput(body)).toThrow("Too many excluded video ids");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 instead of accepting replacement characters", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(input())); bytes[15] = 255;
    expect((await POST(streamRequest(bytes).request)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["ascii", "unicode", "escaped"])("accepts a normalized 40-seed / 5000-ID %s payload within 100 KiB", async (kind) => {
    const text = kind === "ascii" ? "x" : kind === "unicode" ? "🎵界é" : '\u0000\n"\\';
    const excludeVideoIds = Array.from({ length: 5000 }, (_, i) => `v${String(i).padStart(10, "0")}`);
    const raw = { ...input(), playlistTitle: text.repeat(160), excludeVideoIds,
      seeds: Array.from({ length: 40 }, () => ({ title: text.repeat(180), channelTitle: text.repeat(120),
        description: text.repeat(5000), tags: Array(12).fill(text.repeat(60)), categoryId: "10", duration: 180 })) };
    expect(new TextEncoder().encode(JSON.stringify(raw)).length).toBeGreaterThan(128000);
    const body = serializeSuggestionsInput(raw);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(100 * 1024);
    expect(JSON.parse(body).excludeVideoIds).toEqual(excludeVideoIds);
    expect(JSON.parse(body).seeds.length).toBeGreaterThan(0);
    expect((await POST(streamRequest(new TextEncoder().encode(body)).request)).status).toBe(200);
    const refreshed = serializeSuggestionsInput({ ...JSON.parse(body), excludeVideoIds: [...excludeVideoIds, ...Array.from({ length: 5 }, (_, i) => `s${String(i).padStart(10, "0")}`)] });
    expect(JSON.parse(refreshed).excludeVideoIds).toHaveLength(5005);
    expect(new TextEncoder().encode(refreshed).length).toBeLessThanOrEqual(100 * 1024);
    expect((await POST(streamRequest(new TextEncoder().encode(refreshed)).request)).status).toBe(200);
  });
});

describe("suggestions cache and rate behavior", () => {
  it("distinguishes middle exclusions with equal counts/endpoints and honors the changed exclusion", async () => {
    const first = await POST(request(input()));
    expect((await first.json()).suggestions).toEqual([]);
    upstream.mockClear();
    const second = await POST(request({ ...input(), excludeVideoIds: ["aaaaaaaaaaa", "ccccccccccc", "zzzzzzzzzzz"] }));
    expect((await second.json()).suggestions[0].youtubeId).toBe("bbbbbbbbbbb");
    expect(upstream).toHaveBeenCalled();
  });

  it.each(["title", "channelTitle", "description", "tags", "categoryId", "duration", "playlistTitle", "refreshToken"])("misses cache when normalized %s changes", async (field) => {
    expect((await POST(request(input()))).status).toBe(200);
    upstream.mockClear();
    const body = input();
    const changed = field === "playlistTitle" || field === "refreshToken" ? { ...body, [field]: "new value" }
      : { ...body, seeds: [{ ...body.seeds[0], [field]: field === "duration" ? 400 : field === "tags" ? ["rock"] : "energetic" }] };
    expect((await POST(request(changed))).status).toBe(200);
    expect(upstream).toHaveBeenCalled();
  });

  it("hits for equivalent normalized inputs, including reordered/duplicate exclusions", async () => {
    expect((await POST(request(input()))).status).toBe(200);
    upstream.mockClear();
    expect((await POST(request({ ...input(), excludeVideoIds: [...input().excludeVideoIds].reverse().concat("bbbbbbbbbbb"), ignored: "field" }))).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("expires cached results at the TTL and resets quotas only at the window boundary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    for (let i = 0; i < 30; i++) expect((await POST(request({ ...input(), refreshToken: `${i}` }))).status).toBe(200);
    upstream.mockClear();
    expect((await POST(request(input()))).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect((await POST(request(input()))).status).toBe(200);
    upstream.mockClear();
    expect((await POST(request(input()))).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect((await POST(request(input()))).status).toBe(200);
    expect(upstream).toHaveBeenCalled();
  });
});
