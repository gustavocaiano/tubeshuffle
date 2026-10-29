import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/youtube/playlist/route";
import { POST } from "@/app/api/youtube/suggestions/route";
import fixture from "../../shared/fixtures/existing-api.json";

// Exercise the existing handler responses independently of owner authorization.
vi.mock("@/lib/server/owner-guard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/owner-guard")>(),
  guardOwner: async () => null,
}));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const playlistRequest = () => new Request("http://localhost/api/youtube/playlist?playlistId=PL123456789");
const suggestionRequest = (body: unknown, headers: Record<string, string> = {}) => new Request(
  "http://localhost/api/youtube/suggestions", { method: "POST", headers, body: JSON.stringify(body) }
);

beforeEach(() => vi.stubEnv("YOUTUBE_API_KEY", "test-key"));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("existing YouTube wire contract", () => {
  it("matches the populated suggestion fixture with four searches and one details call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T00:00:00.000Z"));
    const calls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname.endsWith("/search")) return json({ items: calls.length === 1 ? [{
        id: { videoId: "candidate01" }, snippet: { title: "Artist Song", channelTitle: "Artist", thumbnails: { high: { url: "https://example.test/thumb.jpg" } } },
      }] : [] });
      expect(url.pathname).toBe("/youtube/v3/videos");
      return json({ items: [{ id: "candidate01", snippet: { publishedAt: "2020-01-02T00:00:00Z" }, contentDetails: { duration: "PT3M" }, statistics: { viewCount: "1234" } }] });
    });
    const response = await POST(suggestionRequest(fixture.suggestions.request.body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fixture.suggestions.response.body);
    expect(calls.map((url) => url.pathname.split("/").at(-1))).toEqual(["search", "search", "search", "search", "videos"]);
    expect(calls[0].searchParams.get("q")).toBe("artist similar songs music");
    expect(calls[4].searchParams.get("id")).toBe("candidate01");
  });

  it("paginates, filters unavailable items, preserves duplicates and includes optional details", async () => {
    const calls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname.endsWith("/playlists")) return json({ items: [{ snippet: { title: "List", description: "Desc", channelTitle: "Owner" }, contentDetails: { itemCount: 4 } }] });
      if (url.pathname.endsWith("/playlistItems")) return json(url.searchParams.has("pageToken")
        ? { items: [{ snippet: { title: "Track" }, contentDetails: { videoId: "abcdefghijk" } }] }
        : { nextPageToken: "next", items: [{ snippet: { title: "Private video" }, contentDetails: { videoId: "private" } }, { snippet: { title: "Track" }, contentDetails: { videoId: "abcdefghijk" } }] });
      return json({ items: [{ id: "abcdefghijk", snippet: { description: "About", tags: ["tag"], categoryId: "10", publishedAt: "2020-01-02T00:00:00Z" }, contentDetails: { duration: "PT3M" }, statistics: { viewCount: "1234", likeCount: "56" } }] });
    });
    const response = await GET(playlistRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "PL123456789", title: "List", description: "Desc", thumbnail: null, channelTitle: "Owner", videoCount: 4, videos: [0, 1].map((position) => ({ ...fixture.playlistPopulatedVideo, position })) });
    expect(calls[2].searchParams.get("pageToken")).toBe("next");
    expect(calls[3].searchParams.get("id")).toBe("abcdefghijk,abcdefghijk");
  });

  it("rejects a continuation after 100 playlist pages without fetching details", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new URL(String(input)).pathname.endsWith("/playlists")
      ? json({ items: [{}] }) : json({ items: [], nextPageToken: "next" }));
    const response = await GET(playlistRequest());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Playlist exceeds supported import size" });
    expect(fetch).toHaveBeenCalledTimes(101);
  });

  it.each([
    [403, 502, "YouTube API request rejected", "YouTube API request rejected or quota exceeded"],
    [429, 429, "YouTube API rate limit exceeded", "YouTube API rate limit exceeded"],
    [500, 502, "YouTube API request failed", "upstream failure"],
  ])("maps upstream %i separately for both handlers", async (upstream, status, playlistMessage, suggestionMessage) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: { code: upstream, message: "upstream failure" } }, upstream));
    const playlist = await GET(playlistRequest());
    expect(playlist.status).toBe(status); expect(await playlist.json()).toEqual({ error: playlistMessage });
    const suggestions = await POST(suggestionRequest({ playlistId: `error-${upstream}`, seeds: [{ title: "Track", channelTitle: "Artist" }] }));
    expect(suggestions.status).toBe(status); expect(await suggestions.json()).toEqual({ error: suggestionMessage });
  });

  it("distinguishes invalid request JSON, declared size and malformed upstream JSON", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 500 }));
    const invalid = await POST(new Request("http://localhost/api/youtube/suggestions", { method: "POST", body: "{" }));
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "Invalid JSON request body" });
    const tooLarge = await POST(suggestionRequest({}, { "content-length": "128001" }));
    expect(tooLarge.status).toBe(413); expect(fetch).not.toHaveBeenCalled();
    const response = await GET(playlistRequest());
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Unexpected server error" });
  });
});
