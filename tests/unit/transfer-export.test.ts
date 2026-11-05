import { describe, expect, it, vi } from "vitest";
import fixture from "../../shared/fixtures/transfer-v1.json";
import { encodeTransferSnapshot, exportTransferFromTestDatabase } from "@/lib/transfer/export";
import type { LocalPlaylist, LocalVideo, LocalPlayEvent } from "@/types/playlist";

const at = "2026-10-28T00:00:00.000Z";
const source = () => structuredClone(fixture.vectors.merge[0].source) as { playlists: LocalPlaylist[]; videos: LocalVideo[]; history: LocalPlayEvent[] };

describe("transfer exporter", () => {
  it("preserves fixture occurrences and references, omitting source orphans", () => {
    const input = source();
    input.history.push({ ...input.history[0], id: "orphan", playlistId: "missing" });
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.json);
    expect(parsed.videos).toEqual(input.videos);
    expect(parsed.history).toEqual(input.history.slice(0, 1));
    expect(result.omittedOrphans).toEqual([{ id: "orphan", reason: "missing_playlist" }]);
    expect(result.warnings.join()).toContain("occurrences_unrecoverable");
  });
  it("normalizes legacy dates and undefined optionals without mutating input", () => {
    const input = source();
    const video = input.videos[0] as typeof input.videos[0] & { publishedAt?: string; viewCount?: number };
    video.publishedAt = "2026-10-28T01:00:00+01:00";
    video.viewCount = undefined;
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = JSON.parse(result.json).videos[0];
    expect(v.publishedAt).toBe(at);
    expect(v).not.toHaveProperty("viewCount");
    expect(Object.prototype.hasOwnProperty.call(video, "viewCount")).toBe(true);
  });
  it("rejects invalid data instead of silently dropping values or secrets", () => {
    const input = source();
    Object.assign(input.videos[0], { token: "SECRET", viewCount: null });
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(d => d.reason)).toEqual(expect.arrayContaining(["unknown_field:token", "invalid_field:viewCount"]));
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("reports independently valid duplicate keys alongside unrelated errors", () => {
    const input = source();
    input.playlists.push({ ...input.playlists[0], extra: "secret" } as LocalPlaylist);
    input.videos[1].position = input.videos[0].position;
    Object.assign(input.videos[1], { extra: true, title: null });
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(d => d.reason)).toEqual(expect.arrayContaining([
      "duplicate:id", "duplicate:youtubeId", "duplicate:position", "unknown_field:extra", "invalid_field:title",
    ]));
    expect(result.omittedDiagnostics).toBe(0);
    expect(result).not.toHaveProperty("json");
  });
  it("bounds and orders many diagnostics, counts omissions, and respects precedence", () => {
    const input = source();
    const unknowns = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`unknown${String(i).padStart(2, "0")}`, true]));
    input.history = Array.from({ length: 5000 }, (_, i) => ({ ...input.history[0], id: `e${String(4999 - i).padStart(4, "0")}`, ...unknowns }));
    input.videos[0].playlistId = "missing";
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toHaveLength(100);
    expect(result.omittedDiagnostics).toBe(200000 - 100);
    expect(result.diagnostics[0]).toEqual({ kind: "history", id: "e0000", reason: "unknown_field:unknown00" });
    expect(result.diagnostics[99]).toEqual({ kind: "history", id: "e0002", reason: "unknown_field:unknown19" });
    expect(result.diagnostics.every(d => d.reason.startsWith("unknown_field:"))).toBe(true);
    expect(result).not.toHaveProperty("json");
  });
  it("reports only envelope errors when the timestamp and many record fields are invalid", () => {
    const input = source();
    Object.assign(input.playlists[0], Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`unknown${i}`, true])));
    const schema = encodeTransferSnapshot(input, at);
    expect(schema.ok).toBe(false);
    if (!schema.ok) {
      expect(schema.diagnostics).toHaveLength(100);
      expect(schema.omittedDiagnostics).toBe(50);
    }
    expect(encodeTransferSnapshot(input, "invalid")).toEqual({
      ok: false,
      diagnostics: [{ kind: "envelope", id: "", reason: "unrepresentable_timestamp:exportedAt" }],
      omittedDiagnostics: 0,
    });
  });
  it("redacts oversized and malformed unknown keys without retaining their values", () => {
    const input = source();
    Object.assign(input.playlists[0], { ["x".repeat(201)]: "SECRET", ["\ud800"]: "SECRET" });
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.filter(d => d.reason === "unknown_field:<redacted>")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("rejects duplicate positions and invalid precise timestamps", () => {
    const input = source();
    input.videos[1].position = input.videos[0].position;
    input.playlists[0].createdAt = "2026-02-29T00:00:00.0001Z";
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(d => d.reason)).toEqual(expect.arrayContaining(["duplicate:position", "unrepresentable_timestamp:createdAt"]));
  });
  it("rejects excessive count and encoded bytes without partial output", () => {
    const input = source();
    const count = encodeTransferSnapshot({ ...input, playlists: Array(5001).fill(input.playlists[0]) }, at);
    expect(count.ok).toBe(false);
    const large = source();
    large.videos = Array.from({ length: 1100 }, (_, i) => ({ ...large.videos[0], id: `v${i}`, position: i, title: "x".repeat(10000) }));
    const bytes = encodeTransferSnapshot(large, at);
    expect(bytes.ok).toBe(false);
    if (!bytes.ok) {
      expect(bytes.diagnostics[0].reason).toBe("file_too_large");
      expect(bytes.requiredBytes).toBe(new TextEncoder().encode(JSON.stringify({ format: "tubeshuffle-transfer", version: 1, exportedAt: at, ...large })).length);
      expect(bytes).not.toHaveProperty("json");
    }
  });
  it("counts escaped Unicode bytes exactly over the limit", () => {
    const input = source();
    input.videos = Array.from({ length: 1000 }, (_, i) => ({ ...input.videos[0], id: `v${i}`, position: i, title: ('😀\n"\\é').repeat(1500) }));
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requiredBytes).toBe(new TextEncoder().encode(JSON.stringify({ format: "tubeshuffle-transfer", version: 1, exportedAt: at, ...input })).length);
  });
  it("returns diagnostics for sparse arrays and invalid scalar strings", () => {
    const input = source();
    const result = encodeTransferSnapshot({ ...input, videos: new Array(1) }, at);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual({ kind: "video", id: "", reason: "invalid_record" });
    input.videos[0].title = "\ud800";
    expect(encodeTransferSnapshot(input, at).ok).toBe(false);
  });
  it("handles legacy timestamp precision and all orphan reasons", () => {
    const input = source();
    input.playlists[0].createdAt = "2024-02-29T01:00:00.123000+01:00";
    input.history.push({ ...input.history[0], id: "missing-playlist", playlistId: "missing" }, { ...input.history[0], id: "missing-video", videoId: "missing" });
    const other = { ...input.playlists[0], id: "other", youtubeId: "otherplaylist" };
    input.playlists.push(other);
    input.history.push({ ...input.history[0], id: "cross", playlistId: other.id });
    const result = encodeTransferSnapshot(input, at);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.json).playlists[0].createdAt).toBe("2024-02-29T00:00:00.123Z");
      expect(result.omittedOrphans.map(x => x.reason)).toEqual(["missing_playlist", "missing_video", "cross_playlist"]);
    }
  });
});

// These tests require native IndexedDB. They are explicitly skipped in jsdom;
// a browser-backed runner must execute them to establish real transaction behavior.
describe.skipIf(typeof globalThis.indexedDB === "undefined")("disposable IndexedDB transfer snapshot", () => {
  async function database() {
    const name = `transfer-test-${crypto.randomUUID()}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ["playlists", "videos", "playHistory"]) request.result.createObjectStore(store, { keyPath: "id" });
        request.result.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { db, cleanup: async () => {
      db.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Disposable database deletion blocked"));
      });
    } };
  }
  function complete(tx: IDBTransaction) {
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("transaction aborted"));
    });
  }
  it("holds one snapshot against an overlapping multi-store writer and excludes meta", async () => {
    const { db, cleanup } = await database();
    try {
      const input = source();
      const seed = db.transaction(["playlists", "videos", "playHistory", "meta"], "readwrite");
      for (const p of input.playlists) seed.objectStore("playlists").put(p);
      for (const v of input.videos) seed.objectStore("videos").put(v);
      for (const h of input.history) seed.objectStore("playHistory").put(h);
      seed.objectStore("meta").put({ key: "secret", value: "DO_NOT_EXPORT" });
      await complete(seed);
      const exporting = exportTransferFromTestDatabase(db, at);
      const writer = db.transaction(["playlists", "videos", "playHistory"], "readwrite");
      writer.objectStore("playlists").put({ ...input.playlists[0], title: "after" });
      writer.objectStore("videos").put({ ...input.videos[0], title: "after" });
      writer.objectStore("playHistory").put({ ...input.history[0], completed: !input.history[0].completed });
      const written = complete(writer);
      const result = await exporting;
      await written;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.json).playlists[0].title).toBe(input.playlists[0].title);
        expect(JSON.parse(result.json).videos[0].title).toBe(input.videos[0].title);
        expect(JSON.parse(result.json).history[0].completed).toBe(input.history[0].completed);
        expect(result.json).not.toContain("DO_NOT_EXPORT");
      }
    } finally { await cleanup(); }
  });
  it("rejects an aborted transaction without returning an export", async () => {
    const { db, cleanup } = await database();
    try {
      const original = db.transaction.bind(db);
      const spy = vi.spyOn(db, "transaction").mockImplementation((...args: Parameters<IDBDatabase["transaction"]>) => {
        const tx = original(...args);
        queueMicrotask(() => tx.abort());
        return tx;
      });
      await expect(exportTransferFromTestDatabase(db, at)).rejects.toThrow();
      spy.mockRestore();
    } finally { await cleanup(); }
  });
});
