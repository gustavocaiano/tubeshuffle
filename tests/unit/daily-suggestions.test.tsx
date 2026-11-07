import React from "react";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DailySuggestionsResult, LocalVideo } from "@/types/playlist";
import { SuggestionsIdbFixture } from "../support/suggestions-idb";

const target = vi.hoisted(() => ({ name: `suggestions-test-${Date.now()}` }));
vi.mock("@/lib/storage/browser-db-target", () => ({ DB_NAME: target.name, DB_VERSION: 1 }));
vi.mock("@/stores/player-store", () => ({ usePlayerStore: () => ({ playNowItem: vi.fn(), playNextItem: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));

let DailySuggestions: typeof import("@/components/playlist/DailySuggestions").DailySuggestions;
let session: typeof import("@/lib/storage/browser-session");
let storage: typeof import("@/lib/storage");
let fixture: SuggestionsIdbFixture;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let pending: { resolve: (response: Response) => void; signal: AbortSignal; input: { playlistId: string; dateKey: string }; body: string }[];
const videos: LocalVideo[] = [{ id: "local-occurrence", playlistId: "local-playlist", youtubeId: "aaaaaaaaaaa", position: 0, title: "Artist - Track", channelTitle: "Artist", thumbnail: "", duration: 180 }];
function payload(request: (typeof pending)[number], label: string): DailySuggestionsResult {
  return { playlistId: request.input.playlistId, dateKey: request.input.dateKey, generatedAt: new Date().toISOString(), query: "synthetic", quotaCost: 0,
    suggestions: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, youtubeId: `s${String(i).padStart(10, "0")}`, title: `${label} ${i}`, channelTitle: "Fixture", thumbnail: "", duration: 180, url: "https://example.test/watch", reason: "synthetic", query: "synthetic" })) };
}
function show(title = "Synthetic playlist", items = videos) {
  return render(<QueryClientProvider client={client}><DailySuggestions playlistId="local-playlist" playlistTitle={title} videos={items} /></QueryClientProvider>);
}
async function ready() {
  await storage.browserStorage.getMetaValue("synthetic-read");
  expect(session.getBrowserStorageState().phase).toBe("ready");
}
async function startLoad() {
  fireEvent.click(await screen.findByRole("button", { name: "Show" }));
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
}
async function respond(index: number, label: string) {
  await act(async () => { pending[index].resolve(Response.json(payload(pending[index], label))); });
}

beforeEach(async () => {
  vi.resetModules();
  fixture = new SuggestionsIdbFixture(target.name);
  vi.stubGlobal("indexedDB", { open: fixture.open });
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  window.localStorage.clear(); // This window belongs to jsdom, never a browser profile.
  pending = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/auth/csrf") return Promise.resolve(Response.json({ csrfToken: "synthetic" }));
    if (url !== "/api/youtube/suggestions") throw new Error("External network denied");
    return new Promise<Response>(resolve => { pending.push({ resolve, signal: init!.signal!, input: JSON.parse(String(init!.body)), body: String(init!.body) }); });
  });
  vi.stubGlobal("fetch", fetchMock);
  session = await import("@/lib/storage/browser-session");
  storage = await import("@/lib/storage");
  ({ DailySuggestions } = await import("@/components/playlist/DailySuggestions"));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

it("keeps missing storage absent and does not query, create schema or contact a service", async () => {
  fixture = new SuggestionsIdbFixture(target.name, false);
  vi.stubGlobal("indexedDB", { open: fixture.open });
  await expect(storage.browserStorage.getMetaValue("test")).rejects.toThrow();
  expect(session.getBrowserStorageState().phase).toBe("missing");
  show();
  expect(screen.queryByText("Daily Suggestions")).toBeNull();
  expect(fixture.open).toHaveBeenCalledTimes(1);
  expect(fixture.connections[0].createObjectStore).not.toHaveBeenCalled();
  expect(fixture.committedWrites).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("rejects stale facade metadata reads and writes after invalidation/recheck without opening a transaction", async () => {
  await ready();
  const old = session.getBrowserStorageState().generation;
  fixture.invalidate();
  await storage.recheckBrowserStorage();
  const db = fixture.connections.at(-1)!;
  db.transaction.mockClear();
  await expect(storage.browserStorage.getMetaValue("late", old)).rejects.toMatchObject({ category: "stale" });
  await expect(storage.browserStorage.setMetaValue("late", true, old)).rejects.toMatchObject({ category: "stale" });
  expect(db.transaction).not.toHaveBeenCalled();
  expect(fixture.meta.has("late")).toBe(false);
});

it("cancels a deferred query and rejects its late response after storage invalidation and recheck", async () => {
  await ready(); show(); await startLoad();
  const originalGeneration = session.getBrowserStorageState().generation;
  await act(async () => { fixture.invalidate(); await storage.recheckBrowserStorage(); });
  expect(pending[0].signal.aborted).toBe(true);
  await respond(0, "Stale query");
  expect(screen.queryByText("Stale query 0")).toBeNull();
  expect(fixture.committedWrites).toEqual([]);
  expect(client.getQueryCache().findAll({ queryKey: ["dailySuggestions"] }).filter(query => query.queryKey[3] === originalGeneration).every(query => query.state.data === undefined)).toBe(true);
  await startLoad();
  await waitFor(() => expect(pending).toHaveLength(2));
  await respond(1, "Current query");
  expect(await screen.findByText("Current query 0")).toBeTruthy();
  expect(fixture.committedWrites).toHaveLength(1);
});

it("does not persist or publish a deferred refresh, or mark it used, into a new generation", async () => {
  await ready(); show(); await startLoad(); await respond(0, "Original");
  await screen.findByText("Original 0");
  await waitFor(() => expect((screen.getByRole("button", { name: "Again" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Again" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  const before = structuredClone([...fixture.meta]);
  await act(async () => { fixture.invalidate(); await storage.recheckBrowserStorage(); });
  expect(pending[1].signal.aborted).toBe(true);
  await respond(1, "Stale refresh");
  expect([...fixture.meta]).toEqual(before);
  expect(fixture.committedWrites).toHaveLength(1);
  expect(screen.queryByText("Stale refresh 0")).toBeNull();
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  expect(JSON.stringify(client.getQueriesData({ queryKey: ["dailySuggestions"] }))).not.toContain("Stale refresh");
  await startLoad();
  await screen.findByText("Original 0");
  await waitFor(() => expect((screen.getByRole("button", { name: "Again" }) as HTMLButtonElement).disabled).toBe(false));
  expect(pending).toHaveLength(2); // A validated cache read in the new generation.
});

it("cancels on unmount even when the synthetic transport ignores abort", async () => {
  await ready(); const view = show(); await startLoad(); view.unmount();
  expect(pending[0].signal.aborted).toBe(true);
  await respond(0, "Unmounted");
  expect(fixture.committedWrites).toEqual([]);
});

it("writes a successful refresh once and preserves its used marker on remount", async () => {
  await ready(); const view = show(); await startLoad(); await respond(0, "Original");
  await screen.findByText("Original 0");
  fireEvent.click(screen.getByRole("button", { name: "Again" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(JSON.parse(pending[1].body).excludeVideoIds).toHaveLength(6);
  await respond(1, "Refreshed");
  await screen.findByText("Refreshed 0");
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.committedWrites.filter(row => row.key.startsWith("dailySuggestionsResuggest:"))).toHaveLength(1);
  view.unmount(); client.clear(); show(); await startLoad();
  await screen.findByText("Refreshed 0");
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  expect(pending).toHaveLength(2);
});

it.each(["title", "metadata", "middle exclusion"])("does not reuse a persisted or query cache after %s changes", async kind => {
  const items = [videos[0], { ...videos[0], id: "middle", youtubeId: "bbbbbbbbbbb" }, { ...videos[0], id: "last", youtubeId: "zzzzzzzzzzz" }];
  await ready(); const view = show("Synthetic playlist", items); await startLoad(); await respond(0, "Original");
  await screen.findByText("Original 0");
  const changed = items.map(item => ({ ...item }));
  if (kind === "metadata") changed[0].description = "high energy metal";
  if (kind === "middle exclusion") changed[1].youtubeId = "ccccccccccc";
  view.rerender(<QueryClientProvider client={client}><DailySuggestions playlistId="local-playlist" playlistTitle={kind === "title" ? "Changed" : "Synthetic playlist"} videos={changed} /></QueryClientProvider>);
  expect(screen.queryByText("Original 0")).toBeNull();
  await startLoad();
  await waitFor(() => expect(pending).toHaveLength(2));
  await respond(1, "Changed input");
  await screen.findByText("Changed input 0");
});

it("serializes the component's 5000 video IDs and large Unicode seed metadata within 100 KiB", async () => {
  await ready();
  const items = Array.from({ length: 5000 }, (_, i) => ({ ...videos[0], id: `occurrence-${i}`, youtubeId: `v${String(i).padStart(10, "0")}`,
    title: "🎵".repeat(90), description: "界".repeat(5000), tags: Array(12).fill("🎵".repeat(30)) }));
  show("🎵".repeat(80), items); await startLoad();
  expect(new TextEncoder().encode(pending[0].body).byteLength).toBeLessThanOrEqual(100 * 1024);
  expect(JSON.parse(pending[0].body).excludeVideoIds).toEqual(items.map(item => item.youtubeId));
  await respond(0, "Bounded"); await screen.findByText("Bounded 0");
});

it("aborts an in-flight metadata write when its generation is revoked", async () => {
  await ready();
  const write = storage.browserStorage.setMetaValue("synthetic-pending-write", true, session.getBrowserStorageState().generation);
  const rejected = expect(write).rejects.toMatchObject({ category: "stale" });
  await Promise.resolve(); // The facade has acquired the lease and started its transaction.
  fixture.invalidate();
  await rejected;
  await storage.recheckBrowserStorage();
  expect(fixture.meta.has("synthetic-pending-write")).toBe(false);
  expect(fixture.committedWrites).toEqual([]);
});

it("cancels an unmounted refresh without publishing its result to the old query", async () => {
  await ready(); const view = show(); await startLoad(); await respond(0, "Original");
  await screen.findByText("Original 0");
  fireEvent.click(screen.getByRole("button", { name: "Again" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  view.unmount();
  expect(pending[1].signal.aborted).toBe(true);
  await respond(1, "Unmounted refresh");
  expect(fixture.committedWrites).toHaveLength(1);
  expect(JSON.stringify(client.getQueriesData({ queryKey: ["dailySuggestions"] }))).not.toContain("Unmounted refresh");
});
