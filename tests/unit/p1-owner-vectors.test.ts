import { describe, expect, it } from "vitest";
import vectors from "../../shared/fixtures/owner-api-proposed.json";

// Contract reference only: these tests do not exercise an API or its concurrency.
const id = /^[A-Za-z0-9_-]{10,80}$/;
function normalize(input: string): string | null {
  const value = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (id.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) ||
        !["/playlist", "/watch"].includes(url.pathname)) return null;
    const lists = url.searchParams.getAll("list");
    return lists.length === 1 && id.test(lists[0]) ? lists[0] : null;
  } catch { return null; }
}

describe("proposed owner vectors (not an implementation)", () => {
  it.each(vectors.normalization)("normalizes $input", ({ input, expected }) => {
    expect(normalize(input)).toBe(expected);
  });

  it.each(vectors.cases)("checks wire example $name", ({ request, response }) => {
    expect(request.path).toMatch(/^\/api\/playlist-links(?:\/[A-Za-z0-9_-]+)?$/);
    const expectedCodes: Record<number, string> = { 400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 409: "link_limit", 413: "payload_too_large", 415: "unsupported_media_type", 429: "rate_limited", 503: "auth_unavailable" };
    if (response.status in expectedCodes) {
      expect(response.body).toEqual({ error: { code: expectedCodes[response.status], message: expect.any(String) } });
    }
    if (response.status === 405) expect(response.allow).toBe("GET, POST");
    if (response.status === 429) expect(response.retryAfter).toMatch(/^\d+$/);
    if (response.status === 204) expect(response.body).toBeNull();
    if (response.body && "link" in response.body && response.body.link) {
      expect(Object.keys(response.body.link).sort()).toEqual(["createdAt", "youtubePlaylistId"]);
      expect(response.body.link.youtubePlaylistId).toMatch(id);
      expect(response.body.link.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(normalize(request.body!.playlistId)).toBe(response.body.link.youtubePlaylistId);
    }
    if (response.body && "links" in response.body && response.body.links) {
      expect(response.body.links.length).toBeLessThanOrEqual(5000);
      expect(response.body.links).toEqual([...response.body.links].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.youtubePlaylistId < b.youtubePlaylistId ? -1 : a.youtubePlaylistId > b.youtubePlaylistId ? 1 : 0));
    }
  });

  it.each(vectors.concurrency)("checks serialized outcome $name", ({ initialCount, ids, statusesSorted, finalCount }) => {
    const inserted = new Set<string>();
    let count = initialCount;
    const statuses = ids.map((value) => {
      if (inserted.has(value)) return 200;
      if (count === 5000) return 409;
      inserted.add(value); count++; return 201;
    });
    expect(statuses.sort((a, b) => a - b)).toEqual(statusesSorted);
    expect(count).toBe(finalCount);
  });
});
