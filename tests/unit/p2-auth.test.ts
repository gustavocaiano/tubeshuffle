import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jar: { getAll: vi.fn(), set: vi.fn() }, session: vi.fn(), user: vi.fn(), claims: vi.fn(), rpc: vi.fn(), from: vi.fn(), signOut: vi.fn(), exchange: vi.fn(), start: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => mocks.jar }));
vi.mock("@supabase/ssr", () => ({ createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (v: unknown[], h: object) => void } }) => ({ auth: {
  getSession: async () => { const result = await mocks.session(); if (result.refresh) options.cookies.setAll([{ name: "session", value: "refreshed", options: { httpOnly: true } }], {}); return result; },
  signOut: mocks.signOut, exchangeCodeForSession: mocks.exchange, signInWithOAuth: mocks.start,
} }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.user, getClaims: mocks.claims }, rpc: mocks.rpc, from: mocks.from }) }));
import { guardOwner } from "@/lib/server/owner-guard";
import { GET as csrf } from "@/app/api/auth/csrf/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as callback } from "@/app/auth/callback/route";
import { GET as start } from "@/app/api/auth/start/route";
import { GET as links, POST as createLink } from "@/app/api/playlist-links/route";
import { DELETE as deleteLink } from "@/app/api/playlist-links/[playlistId]/route";
import { GET as youtube } from "@/app/api/youtube/playlist/route";
import { POST as suggestions } from "@/app/api/youtube/suggestions/route";

const owner = "11111111-1111-1111-1111-111111111111";
const session = "22222222-2222-2222-2222-222222222222";
const base = "https://app.example";
const cookieRequest = (path: string, init?: RequestInit) => new Request(base + path, init);

describe("owner session boundary", () => {
 beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test"); vi.stubEnv("OWNER_USER_ID", owner);
  vi.stubEnv("APP_ORIGIN", base); vi.stubEnv("CSRF_HMAC_SECRET", "ab".repeat(32));
  mocks.session.mockResolvedValue({ data: { session: { access_token: "verified-token" } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: owner } }, error: null });
  mocks.claims.mockResolvedValue({ data: { claims: { sub: owner, session_id: session, iss: "https://project.supabase.co/auth/v1", aud: "authenticated" } }, error: null });
  mocks.rpc.mockResolvedValue({ data: true, error: null }); mocks.signOut.mockResolvedValue({ error: null }); mocks.exchange.mockResolvedValue({ error: null });
 });
 afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
 it("does not fall back to cookies for malformed bearer and verifies valid bearer", async () => {
  expect((await guardOwner(cookieRequest("/", { headers: { authorization: "Basic bad" } }), "mutation"))?.status).toBe(401);
  expect(mocks.session).not.toHaveBeenCalled();
  expect(await guardOwner(cookieRequest("/", { headers: { authorization: "Bearer token" } }), "mutation")).toBeNull();
  expect(mocks.user).toHaveBeenCalledWith("token");
 });
 it("accepts b64token grammar and rejects malformed or combined credentials without fallback", async () => {
  for (const token of ["a+b/c==", "x._~-", "abc="]) {
   expect(await guardOwner(cookieRequest("/", { headers: { authorization: `Bearer  ${token}` } }), "mutation")).toBeNull();
   expect(mocks.user).toHaveBeenLastCalledWith(token);
  }
  for (const header of ["Bearer", "Bearer a=b", "Bearer =", "Bearer a b", "Bearer a, Bearer b", "Bearer a\tb", "Basic abc"]) {
   expect((await guardOwner(cookieRequest("/", { headers: { authorization: header } }), "mutation"))?.status).toBe(401);
  }
  expect(mocks.session).not.toHaveBeenCalled();
 });
 it("lets a verified non-owner or de-pinned session obtain CSRF and sign out without touching the pin", async () => {
  const other = "44444444-4444-4444-4444-444444444444";
  for (const id of [other, owner]) {
   mocks.user.mockResolvedValue({ data: { user: { id } }, error: null });
   mocks.claims.mockResolvedValue({ data: { claims: { sub: id, session_id: session, iss: "https://project.supabase.co/auth/v1", aud: "authenticated" } }, error: null });
   vi.stubEnv("OWNER_USER_ID", "");
   const response = await csrf(cookieRequest("/api/auth/csrf"));
   expect(response.status).toBe(200);
   const { csrfToken } = await response.json();
   expect((await logout(cookieRequest("/api/auth/logout", { method: "POST", headers: { origin: base, "x-csrf-token": csrfToken } }))).status).toBe(204);
  }
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.signOut).toHaveBeenCalledTimes(2);
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
 });
 it("denies logout on wrong origin, session, bearer, and provider failure", async () => {
  const token = (await (await csrf(cookieRequest("/api/auth/csrf"))).json()).csrfToken;
  const request = (headers: Record<string, string>) => cookieRequest("/api/auth/logout", { method: "POST", headers });
  expect((await csrf(cookieRequest("/api/auth/csrf", { headers: { origin: "https://evil.example" } }))).status).toBe(403);
  expect((await csrf(cookieRequest("/api/auth/csrf", { headers: { authorization: "Bearer token" } }))).status).toBe(403);
  expect((await logout(request({ origin: base }))).status).toBe(403);
  expect((await logout(request({ origin: base, "x-csrf-token": `${token}, ${token}` }))).status).toBe(403);
  for (const origin of ["", "null", "https://evil.example", `${base}, https://evil.example`]) {
   expect((await logout(request({ origin, "x-csrf-token": token }))).status).toBe(403);
  }
  expect((await logout(request({ origin: base, authorization: "Bearer token", "x-csrf-token": token }))).status).toBe(403);
  mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: owner, session_id: "33333333-3333-3333-3333-333333333333", iss: "https://project.supabase.co/auth/v1", aud: "authenticated" } }, error: null });
  expect((await logout(request({ origin: base, "x-csrf-token": token }))).status).toBe(403);
  vi.stubEnv("CSRF_HMAC_SECRET", "cd".repeat(32));
  expect((await logout(request({ origin: base, "x-csrf-token": token }))).status).toBe(403);
  vi.stubEnv("CSRF_HMAC_SECRET", "ab".repeat(32));
  mocks.user.mockResolvedValueOnce({ data: {}, error: { status: 500 } });
  expect((await logout(request({ origin: base, "x-csrf-token": token }))).status).toBe(503);
  expect(mocks.signOut).not.toHaveBeenCalled();
  mocks.signOut.mockResolvedValueOnce({ error: { status: 500 } });
  expect((await logout(request({ origin: base, "x-csrf-token": token }))).status).toBe(503);
 });
 it("distinguishes invalid credentials, outage and pin failure", async () => {
  mocks.user.mockResolvedValueOnce({ data: {}, error: { status: 401 } }).mockResolvedValueOnce({ data: {}, error: { status: 500 } });
  const req = cookieRequest("/", { headers: { authorization: "Bearer token" } });
  expect((await guardOwner(req, "read"))?.status).toBe(401);
  expect((await guardOwner(req, "read"))?.status).toBe(503);
  mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
  expect((await guardOwner(req, "read"))?.status).toBe(503);
 });
 it("does not contact YouTube on credential, identity, pin or provider denial", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  try {
   const cases = [
    { user: { data: {}, error: { status: 401, code: "invalid_jwt" } }, status: 401 },
    { user: { data: {}, error: { status: 401, code: "session_expired" } }, status: 401 },
    { user: { data: {}, error: { status: 401, code: "bad_jwt" } }, status: 401 },
    { user: { data: { user: { id: "44444444-4444-4444-4444-444444444444" } }, error: null }, status: 403 },
    { user: { data: { user: { id: owner } }, error: null }, pin: { data: false, error: null }, status: 503 },
    { user: { data: {}, error: { status: 500 } }, status: 503 },
   ];
   for (const item of cases) for (const endpoint of ["playlist", "suggestions"]) {
    mocks.user.mockResolvedValueOnce(item.user);
    if (item.pin) mocks.rpc.mockResolvedValueOnce(item.pin);
    const request = cookieRequest(`/api/youtube/${endpoint}?playlistId=abcdefghij`, { method: endpoint === "playlist" ? "GET" : "POST", headers: { authorization: "Bearer token" } });
    const result = endpoint === "playlist" ? await youtube(request) : await suggestions(request);
    expect(result.status).toBe(item.status);
   }
   expect(fetchMock).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
 });
 it("issues session bound CSRF and checks origin, token, and verified claims", async () => {
  const res = await csrf(cookieRequest("/api/auth/csrf"));
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toContain("no-store");
  const { csrfToken } = await res.json();
  expect(mocks.claims).toHaveBeenCalledWith("verified-token");
  const mutation = (origin: string, token: string) => cookieRequest("/", { method: "POST", headers: { origin, "x-csrf-token": token } });
  expect(await guardOwner(mutation(base, csrfToken), "mutation")).toBeNull();
  expect((await guardOwner(mutation("https://evil.example", csrfToken), "mutation"))?.status).toBe(403);
  mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: owner, session_id: "33333333-3333-3333-3333-333333333333", iss: "https://project.supabase.co/auth/v1", aud: "authenticated" } }, error: null });
  expect((await guardOwner(mutation(base, csrfToken), "mutation"))?.status).toBe(403);
  mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: "other", session_id: session } }, error: null });
  expect((await csrf(cookieRequest("/api/auth/csrf"))).status).toBe(403);
 });
 it("enforces the canonical origin policy for cookies while retaining bearer access", async () => {
  for (const [env, origin] of [["production", "http://localhost:3000"], ["development", "http://remote.example"]]) {
   vi.stubEnv("NODE_ENV", env); vi.stubEnv("APP_ORIGIN", origin);
   const req = new Request(origin + "/", { headers: { origin } });
   expect((await guardOwner(req, "mutation"))?.status).toBe(503);
   expect((await csrf(new Request(origin + "/api/auth/csrf"))).status).toBe(503);
   expect(await guardOwner(new Request(origin + "/", { headers: { authorization: "Bearer token" } }), "mutation")).toBeNull();
  }
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  expect((await csrf(new Request("http://localhost:3000/api/auth/csrf", { headers: { origin: "http://localhost:3000" } }))).status).toBe(200);
 });
 it("propagates refreshed cookies and signs out locally", async () => {
  mocks.session.mockResolvedValue({ data: { session: { access_token: "verified-token" } }, error: null, refresh: true });
  const token = (await (await csrf(cookieRequest("/api/auth/csrf"))).json()).csrfToken;
   expect(mocks.jar.set).toHaveBeenCalledWith("session", "refreshed", { httpOnly: true, path: "/", sameSite: "lax", secure: true });
  const response = await logout(cookieRequest("/api/auth/logout", { method: "POST", headers: { origin: base, "x-csrf-token": token } }));
  expect(response.status).toBe(204); expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
 });
 it("allows verified cookie link reads without quota intent while retaining strict YouTube policy", async () => {
  mocks.session.mockResolvedValue({ data: { session: { access_token: "verified-token" } }, error: null, refresh: true });
  const query = { select: () => query, order: () => query, limit: () => Promise.resolve({ data: [], error: null }) };
  mocks.from.mockReturnValue(query);
  const response = await links(cookieRequest("/api/playlist-links"));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ links: [] });
  expect(response.headers.get("cache-control")).toContain("no-store");
   expect(mocks.jar.set).toHaveBeenCalledWith("session", "refreshed", { httpOnly: true, path: "/", sameSite: "lax", secure: true });
  expect(mocks.user).toHaveBeenCalledWith("verified-token"); expect(mocks.rpc).toHaveBeenCalledWith("is_approved_owner");
  for (const headers of [{}, { "x-tubeshuffle-intent": "playlist", "sec-fetch-site": "cross-site" }, { "x-tubeshuffle-intent": "playlist", origin: "https://evil.example" }] as Record<string, string>[]) {
   const denied = await youtube(cookieRequest("/api/youtube/playlist?playlistId=abcdefghij", { headers }));
   expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toContain("no-store");
  }
 });
 it("fails closed before link operations for invalid credentials, non-owner, pin failure and cookie mutations", async () => {
  const noStore = (response: Response) => expect(response.headers.get("cache-control")).toContain("no-store");
  let response = await links(cookieRequest("/api/playlist-links?bad", { headers: { authorization: "Basic bad" } }));
  expect(response.status).toBe(401); noStore(response); expect(mocks.session).not.toHaveBeenCalled();
  mocks.user.mockResolvedValueOnce({ data: { user: { id: "other" } }, error: null });
  response = await links(cookieRequest("/api/playlist-links?bad")); expect(response.status).toBe(403); noStore(response);
  mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
  response = await links(cookieRequest("/api/playlist-links?bad")); expect(response.status).toBe(503); noStore(response);
  response = await createLink(cookieRequest("/api/playlist-links", { method: "POST", body: "bad" })); expect(response.status).toBe(403); noStore(response);
  response = await deleteLink(cookieRequest("/api/playlist-links/PLabcdefghij", { method: "DELETE", headers: { origin: base } })); expect(response.status).toBe(403); noStore(response);
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.rpc.mock.calls.every(([name]) => name === "is_approved_owner")).toBe(true);
 });
 it("uses fixed callback destination and ignores next parameter", async () => {
   const res = await callback(cookieRequest("/auth/callback?code=abc&next=https://evil.example", { headers: { cookie: "existing-session=present" } }));
  expect(res.status).toBe(303); expect(res.headers.get("location")).toBe(base + "/dashboard");
  expect(res.headers.get("cache-control")).toContain("no-store");
 });
 it("uses fixed failure on SDK start and exchange errors without reflecting details", async () => {
  mocks.start.mockResolvedValueOnce({ data: { url: null }, error: { message: "secret-start" } });
  mocks.exchange.mockResolvedValueOnce({ error: { message: "secret-exchange" } });
  for (const response of [await start(cookieRequest("/api/auth/start")), await callback(cookieRequest("/auth/callback?code=secret-code", { headers: { cookie: "existing-session=present" } }))]) {
   expect(response.headers.get("location")).toBe("/dashboard?auth_result=failed");
   expect(response.headers.get("cache-control")).toContain("no-store");
   expect(response.headers.get("referrer-policy")).toBe("no-referrer");
   expect(await response.text()).toBe("");
  }
 });
});
