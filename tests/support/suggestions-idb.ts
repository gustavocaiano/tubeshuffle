import { vi } from "vitest";

// An in-memory native-API seam only. The component tests import the production
// facade, metadata initializer, session and provisioning coordinator unchanged.
// This does not model native IDB durability, scheduling or cross-tab behavior.
const shapes: Record<string, [string, [string, string | string[], boolean][]]> = {
  playlists: ["id", [["youtubeId", "youtubeId", true], ["updatedAt", "updatedAt", false]]],
  videos: ["id", [["playlistId", "playlistId", false], ["youtubeId", "youtubeId", false], ["playlistPosition", ["playlistId", "position"], false]]],
  playHistory: ["id", [["playlistId", "playlistId", false], ["videoId", "videoId", false], ["watchedAt", "watchedAt", false]]],
  meta: ["key", []],
};
const names = (values: string[]) => Object.assign(values, { contains: (value: string) => values.includes(value) });

class SyntheticRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;
  transaction: SyntheticTransaction | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  emit(event: Event) {
    this.dispatchEvent(event);
    if (event.type === "success") this.onsuccess?.();
    if (event.type === "error") this.onerror?.();
  }
}

class SyntheticTransaction extends EventTarget {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private stopped = false;
  private writes: { key: string; value: unknown }[] = [];
  private timer: ReturnType<typeof setTimeout>;
  constructor(private fixture: SuggestionsIdbFixture) {
    super();
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.stopped = true;
      for (const row of this.writes) {
        fixture.meta.set(row.key, structuredClone(row));
        fixture.committedWrites.push(structuredClone(row));
      }
      this.dispatchEvent(new Event("complete")); this.oncomplete?.();
    }, 0);
  }
  abort = () => {
    if (this.stopped) throw new Error("Transaction finished");
    this.stopped = true;
    clearTimeout(this.timer);
    queueMicrotask(() => { this.dispatchEvent(new Event("abort")); this.onabort?.(); });
  };
  objectStore(name: string) {
    const [keyPath, indexes] = shapes[name];
    return {
      keyPath, autoIncrement: false, indexNames: names(indexes.map(([name]) => name)),
      index: (name: string) => {
        const spec = indexes.find(([key]) => key === name)!;
        return { keyPath: spec[1], unique: spec[2], multiEntry: false };
      },
      get: (key: string) => {
        if (name !== "meta") throw new Error("Only synthetic metadata reads are allowed");
        this.fixture.reads.push(key);
        const request = new SyntheticRequest();
        queueMicrotask(() => { request.result = structuredClone(this.fixture.meta.get(key)); request.emit(new Event("success")); });
        return request;
      },
      put: (row: { key: string; value: unknown }) => {
        if (name !== "meta") throw new Error("Only synthetic metadata writes are allowed");
        this.writes.push(structuredClone(row));
      },
    };
  }
}

class SyntheticDatabase extends EventTarget {
  readonly version = 1;
  readonly objectStoreNames = names(Object.keys(shapes));
  readonly close = vi.fn();
  readonly createObjectStore = vi.fn(() => { throw new Error("Suggestions must not create storage"); });
  readonly transaction: ReturnType<typeof vi.fn>;
  constructor(readonly name: string, fixture: SuggestionsIdbFixture) {
    super();
    this.transaction = vi.fn(() => new SyntheticTransaction(fixture));
  }
}

export class SuggestionsIdbFixture {
  readonly meta = new Map<string, { key: string; value: unknown }>([
    ["schemaVersion", { key: "schemaVersion", value: 1 }],
    ["migratedFromLegacy", { key: "migratedFromLegacy", value: false }],
  ]);
  readonly reads: string[] = [];
  readonly committedWrites: { key: string; value: unknown }[] = [];
  readonly connections: SyntheticDatabase[] = [];
  readonly open = vi.fn((name: string, version: number) => {
    if (name !== this.name || version !== 1) throw new Error("Non-fixture IDB target denied");
    const request = new SyntheticRequest();
    const db = new SyntheticDatabase(name, this);
    this.connections.push(db);
    request.result = db;
    queueMicrotask(() => {
      if (this.exists) { request.emit(new Event("success")); return; }
      const tx = new SyntheticTransaction(this);
      request.transaction = tx;
      tx.addEventListener("abort", () => {
        request.error = new DOMException("Synthetic missing database", "AbortError");
        request.emit(new Event("error"));
      });
      request.emit(Object.assign(new Event("upgradeneeded"), { oldVersion: 0, newVersion: 1 }));
    });
    return request;
  });
  constructor(readonly name: string, readonly exists = true) {}
  invalidate() {
    this.connections.at(-1)!.dispatchEvent(new Event("versionchange"));
  }
}
