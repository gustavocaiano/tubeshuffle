import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/youtube/playlist/route";
import { POST } from "@/app/api/youtube/suggestions/route";
import { fetchPlaylistDataFromBrowser } from "@/lib/services/youtube-browser";

describe("P2 incomplete fail-closed quota boundary", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("never contacts upstream when owner configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("YOUTUBE_API_KEY", "test-only");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const playlist = await GET(new Request("https://example.com/api/youtube/playlist?playlistId=abcdefghij"));
    const suggestions = await POST(new Request("https://example.com/api/youtube/suggestions", { method: "POST", body: "{}" }));
    expect(playlist.status).toBe(503);
    expect(suggestions.status).toBe(503);
    expect(playlist.headers.get("cache-control")).toContain("no-store");
    expect(suggestions.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables even a direct import of the former browser provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_YOUTUBE_API_KEY", "test-only");
    await expect(fetchPlaylistDataFromBrowser("abcdefghij")).rejects.toThrow("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed bearer credentials without cookie fallback or network", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-only");
    vi.stubEnv("OWNER_USER_ID", "11111111-1111-1111-1111-111111111111");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("https://example.com/api/youtube/playlist", { headers: { authorization: "Basic invalid", cookie: "session=present" } }));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
