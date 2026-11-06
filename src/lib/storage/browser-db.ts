import { DB_NAME, DB_VERSION } from "./browser-db-target";
export { DB_NAME, DB_VERSION } from "./browser-db-target";

export const STORE_PLAYLISTS = "playlists";
export const STORE_VIDEOS = "videos";
export const STORE_PLAY_HISTORY = "playHistory";
export const STORE_META = "meta";

export type StoreName =
  | typeof STORE_PLAYLISTS
  | typeof STORE_VIDEOS
  | typeof STORE_PLAY_HISTORY
  | typeof STORE_META;

export function createBrowserSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
    const playlists = db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
    playlists.createIndex("youtubeId", "youtubeId", { unique: true });
    playlists.createIndex("updatedAt", "updatedAt", { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
    const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: "id" });
    videos.createIndex("playlistId", "playlistId", { unique: false });
    videos.createIndex("youtubeId", "youtubeId", { unique: false });
    videos.createIndex("playlistPosition", ["playlistId", "position"], { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_PLAY_HISTORY)) {
    const playHistory = db.createObjectStore(STORE_PLAY_HISTORY, { keyPath: "id" });
    playHistory.createIndex("playlistId", "playlistId", { unique: false });
    playHistory.createIndex("videoId", "videoId", { unique: false });
    playHistory.createIndex("watchedAt", "watchedAt", { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: "key" });
  }
}

export function isIndexedDbAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

/** Validate structure only; never repair or read/rewrite library records. */
export function validateBrowserSchema(db: IDBDatabase): boolean {
  if (db.name !== DB_NAME || db.version !== DB_VERSION) return false;
  const expected = [STORE_PLAYLISTS, STORE_VIDEOS, STORE_PLAY_HISTORY, STORE_META].sort();
  if (JSON.stringify(Array.from(db.objectStoreNames).sort()) !== JSON.stringify(expected)) return false;
  const tx = db.transaction(expected, "readonly");
  const shape: Record<string, { key: string; indexes: [string, string | string[], boolean][] }> = {
    playlists: { key: "id", indexes: [["youtubeId", "youtubeId", true], ["updatedAt", "updatedAt", false]] },
    videos: { key: "id", indexes: [["playlistId", "playlistId", false], ["youtubeId", "youtubeId", false], ["playlistPosition", ["playlistId", "position"], false]] },
    playHistory: { key: "id", indexes: [["playlistId", "playlistId", false], ["videoId", "videoId", false], ["watchedAt", "watchedAt", false]] },
    meta: { key: "key", indexes: [] },
  };
  return expected.every(name => {
    const store = tx.objectStore(name), spec = shape[name];
    return store.keyPath === spec.key && !store.autoIncrement && store.indexNames.length === spec.indexes.length &&
      spec.indexes.every(([name, key, unique]) => {
        if (!store.indexNames.contains(name)) return false;
        const index = store.index(name);
        return JSON.stringify(index.keyPath) === JSON.stringify(key) && index.unique === unique && !index.multiEntry;
      });
  });
}
