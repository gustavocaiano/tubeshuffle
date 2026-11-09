import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personalImportAuthorization } from "@/lib/server/personal-import-guard";
import { GET as playlist } from "@/app/api/youtube/playlist/route";
import { POST as suggestions } from "@/app/api/youtube/suggestions/route";
import { GET as links } from "@/app/api/playlist-links/route";

const token = Buffer.alloc(32, 7).toString("base64url");
const digest = createHash("sha256").update(token, "ascii").digest("hex");
const request = (authorization?: string) => new Request("https://app.example/api/youtube/playlist?playlistId=PLSyntheticImport0001", {
  headers: authorization ? { authorization } : {},
});

describe("personal playlist import credential", () => {
  beforeEach(() => {
    vi.stubEnv("TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256", digest);
    vi.stubEnv("YOUTUBE_API_KEY", "synthetic-server-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "synthetic-publishable");
    vi.stubEnv("OWNER_USER_ID", "11111111-1111-1111-1111-111111111111");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("accepts only the exact canonical 32-byte token with a configured digest", () => {
    expect(personalImportAuthorization(request(`TubeShuffleDevice ${token}`))).toBe("allowed");
    expect(personalImportAuthorization(request())).toBe("not-personal");
    expect(personalImportAuthorization(request("Bearer existing-owner-token"))).toBe("not-personal");
    for (const value of ["", "short", `${token}x`, `${token}, ${token}`, `${token.slice(0, -1)}_`]) {
      expect(personalImportAuthorization(request(`TubeShuffleDevice ${value}`))).toBe("invalid");
    }
    vi.stubEnv("TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256", "");
    expect(personalImportAuthorization(request(`TubeShuffleDevice ${token}`))).toBe("unavailable");
    vi.stubEnv("TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256", "A".repeat(64));
    expect(personalImportAuthorization(request(`TubeShuffleDevice ${token}`))).toBe("unavailable");
  });

  it("denies a wrong or unconfigured device credential before YouTube is called", async () => {
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const other = Buffer.alloc(32, 8).toString("base64url");
    const denied = await playlist(request(`TubeShuffleDevice ${other}`));
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(other);
    vi.stubEnv("TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256", "");
    const unavailable = await playlist(request(`TubeShuffleDevice ${token}`));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toContain("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("loads synthetic public playlist data without an owner session and never forwards the device credential", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.googleapis.com");
      expect(url.search).not.toContain(token);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (url.pathname.endsWith("/playlists")) return Response.json({ items: [{ snippet: { title: "Synthetic" }, contentDetails: { itemCount: 0 } }] });
      if (url.pathname.endsWith("/playlistItems")) return Response.json({ items: [] });
      throw new Error("Unexpected synthetic upstream request");
    });
    vi.stubGlobal("fetch", upstream);
    const response = await playlist(request(`TubeShuffleDevice ${token}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ id: "PLSyntheticImport0001", title: "Synthetic", videos: [] });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("allows bounded personal suggestions without retaining results on the server", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.googleapis.com");
      expect(url.search).not.toContain(token);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(url.pathname).toMatch(/\/search$/);
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", upstream);
    const body = JSON.stringify({ playlistId: "PLPersonalFixture0001", dateKey: "2026-01-01", seeds: [{ title: "Synthetic song", channelTitle: "Synthetic artist" }] });
    const makeRequest = (credential: string) => new Request("https://app.example/api/youtube/suggestions", {
      method: "POST", headers: { authorization: `TubeShuffleDevice ${credential}`, "content-type": "application/json" }, body,
    });
    const first = await suggestions(makeRequest(token));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect((await first.json()).suggestions).toEqual([]);
    const firstCalls = upstream.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    const second = await suggestions(makeRequest(token));
    expect(second.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(firstCalls * 2);
    const wrong = Buffer.alloc(32, 8).toString("base64url");
    expect((await suggestions(makeRequest(wrong))).status).toBe(401);
    vi.stubEnv("TUBESHUFFLE_PERSONAL_IMPORT_TOKEN_SHA256", "");
    expect((await suggestions(makeRequest(token))).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(firstCalls * 2);
  });

  it("does not authorize cloud links", async () => {
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const authorization = `TubeShuffleDevice ${token}`;
    const cloud = await links(new Request("https://app.example/api/playlist-links", { headers: { authorization } }));
    expect(cloud.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
