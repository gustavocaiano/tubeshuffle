// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as start } from "@/app/api/auth/start/route";
import { GET as callback } from "@/app/auth/callback/route";
import { appOrigin, sessionCookieOptions } from "@/lib/server/session";

const base = "https://app.example";
const request = (path: string, headers?: HeadersInit) => new Request(base + path, { headers });
const cookies = (response: Response) => response.headers.getSetCookie();
const jar = (response: Response) => cookies(response).map((s) => s.split(";")[0]).join("; ");
const attributes = (cookie: string) => {
  expect(cookie).toMatch(/; Path=\//i);
  expect(cookie).toMatch(/; HttpOnly/i);
  expect(cookie).toMatch(/; Secure/i);
  expect(cookie).toMatch(/; SameSite=Lax/i);
  expect(cookie).not.toMatch(/; Domain=/i);
};

describe("real SSR SDK PKCE cookies", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ORIGIN", base);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("starts PKCE on the server and exchanges the actual verifier cookie", async () => {
    const first = await start(request("/api/auth/start?next=https://evil.example", { "sec-fetch-site": "same-origin" }));
    expect(first.status).toBe(303);
    const provider = new URL(first.headers.get("location")!);
    expect(provider.origin).toBe("https://project.supabase.co");
    expect(provider.searchParams.get("redirect_to")).toBe(base + "/auth/callback");
    expect(provider.searchParams.get("code_challenge_method")).toBe("s256");
    expect(provider.searchParams.get("code_challenge")).toBeTruthy();
    expect(cookies(first).length).toBeGreaterThan(0);
    cookies(first).forEach(attributes);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.auth_code).toBe("code");
      expect(body.code_verifier).toBeTruthy();
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: 3600, user: { id: "user", extra: "x".repeat(10000) } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await callback(request("/auth/callback?code=code&next=https://evil.example", { cookie: jar(first) }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.headers.get("location")).toBe(base + "/dashboard");
    expect(result.headers.get("cache-control")).toContain("no-store");
    const writes = cookies(result);
    expect(writes.length).toBeGreaterThan(2);
    writes.forEach(attributes);
    expect(writes.some((s) => /Max-Age=0/i.test(s))).toBe(true);
    expect(writes.some((s) => /-auth-token\.0=/.test(s))).toBe(true);
  });

  it("returns a fixed internal failure marker on cancellation and invalid callbacks", async () => {
    for (const path of ["/auth/callback?error=denied&secret=hidden", "/auth/callback", "/auth/callback?code=a&code=b", "/auth/callback?code=bad"]) {
      const result = await callback(request(path));
      expect(result.status).toBe(303);
      expect(result.headers.get("location")).toBe("/dashboard?auth_result=failed");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(result.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("fails closed on a provider exchange error and can start again", async () => {
    const first = await start(request("/api/auth/start"));
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "private detail" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await callback(request("/auth/callback?code=bad", { cookie: jar(first) }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.headers.get("location")).toBe("/dashboard?auth_result=failed");
    expect(await result.text()).toBe("");
    cookies(result).forEach(attributes);
    const retry = await start(request("/api/auth/start", { cookie: jar(first) }));
    expect(new URL(retry.headers.get("location")!).searchParams.get("code_challenge")).toBeTruthy();
    cookies(retry).forEach(attributes);
  });

  it("blocks cross-site starts and limits HTTP cookies to explicit local development", async () => {
    const response = await start(request("/api/auth/start", { "sec-fetch-site": "cross-site" }));
    expect(response.headers.get("location")).toBe("/dashboard?auth_result=failed");
    expect(cookies(response)).toHaveLength(0);
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieOptions().secure).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(appOrigin()).toBeNull();
    expect(sessionCookieOptions().secure).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ORIGIN", "http://example.com");
    expect(appOrigin()).toBeNull();
  });

  it("shows a fixed failure when start configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const response = await start(request("/api/auth/start?secret=private"));
    expect(response.headers.get("location")).toBe("/dashboard?auth_result=failed");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
