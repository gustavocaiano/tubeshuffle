import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyEnergyTrack } from "@/lib/shuffle/energy-classifier";
import { smartShuffle } from "@/lib/shuffle/shuffle-service";
import { GET } from "@/app/api/youtube/playlist/route";
import { POST } from "@/app/api/youtube/suggestions/route";
import smart from "../../shared/fixtures/smart.json";
import existing from "../../shared/fixtures/existing-api.json";
import transfer from "../../shared/fixtures/transfer-v1.json";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("portable Smart fixtures", () => {
  it.each(smart.classifier)("classifies $input.title", ({ input, expected }) => {
    const actual = classifyEnergyTrack(input);
    expect(actual.bucket).toBe(expected.bucket);
    expect(actual.score).toBe(expected.score);
    expect(actual.signals).toEqual(expected.signals);
    expect(actual.confidence).toBeCloseTo(expected.confidence, 12);
  });

  it.each(smart.orders)("orders $length occurrences and consumes exactly the vector", ({ length, random, expectedOccurrences }) => {
    let cursor = 0;
    const spy = vi.spyOn(Math, "random").mockImplementation(() => {
      if (cursor >= random.length) throw new Error("random vector exhausted");
      return random[cursor++];
    });
    const input = Array.from({ length }, (_, occurrence) => ({ ...smart.tracks[occurrence % smart.tracks.length], occurrence }));
    expect(smartShuffle(input).map((item) => item.occurrence)).toEqual(expectedOccurrences);
    expect(spy).toHaveBeenCalledTimes(random.length);
    expect(input.map((item) => item.occurrence)).toEqual(Array.from({ length }, (_, i) => i));
    expect(input[0].id).toBe(input[1].id);
  });
});

describe("existing wire examples without upstream calls", () => {
  it("returns the actual invalid playlist response", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "synthetic-test-value");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await GET(new Request("http://localhost/api/youtube/playlist?playlistId=short"));
    const fixture = existing.errors.find((e) => e.endpoint === "playlist" && e.status === 400)!;
    expect(response.status).toBe(fixture.status);
    expect(await response.json()).toEqual(fixture.body);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("maps a mocked upstream playlist including repeated occurrences to the existing DTO", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "synthetic-test-value");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const payload = path.endsWith("/playlists")
        ? { items: [{ snippet: { title: "Sample" }, contentDetails: { itemCount: 2 } }] }
        : path.endsWith("/playlistItems")
          ? { items: [0, 1].map(() => ({ snippet: { title: "Track", videoOwnerChannelTitle: "Artist" }, contentDetails: { videoId: "abcdefghijk" } })) }
          : { items: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const response = await GET(new Request(`http://localhost${existing.playlist.request.path}`));
    expect(response.status).toBe(existing.playlist.response.status);
    expect(await response.json()).toEqual(existing.playlist.response.body);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  it("returns the actual empty-seeds response", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "synthetic-test-value");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(new Request("http://localhost/api/youtube/suggestions", { method: "POST", body: JSON.stringify({ playlistId: "local-id", seeds: [] }) }));
    const fixture = existing.errors.find((e) => e.endpoint === "suggestions" && e.status === 400)!;
    expect(response.status).toBe(fixture.status);
    expect(await response.json()).toEqual(fixture.body);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("identifies the legacy orphan and specifies omission rather than attachment", () => {
    expect(transfer.version).toBe(1);
    expect(transfer.videos[0].id).toBe(`${transfer.playlists[0].id}:${transfer.videos[0].youtubeId}`);
    expect(transfer.playlists.some((p) => p.id === transfer.history[0].playlistId)).toBe(false);
    const orphan = transfer.vectors.merge.find((vector) => vector.name === "source orphans cannot attach to destination")!;
    expect(orphan.expected).toMatchObject({ report: { omittedOrphans: [
      { id: "missing-playlist", reason: "missing_playlist" },
      { id: "missing-video", reason: "missing_video" },
      { id: "cross", reason: "missing_video" },
    ] } });
    expect(orphan.expected.destination.history).toEqual(orphan.destination.history);
  });
});
