export const DB_NAME = "tubeshuffle_local";
export const DB_VERSION = 1;

export const STORE_PLAYLISTS = "playlists";
export const STORE_VIDEOS = "videos";
export const STORE_PLAY_HISTORY = "playHistory";
export const STORE_META = "meta";

export type StoreName =
  | typeof STORE_PLAYLISTS
  | typeof STORE_VIDEOS
  | typeof STORE_PLAY_HISTORY
  | typeof STORE_META;

function createStores(db: IDBDatabase): void {
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

export function openBrowserDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      createStores(db);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB database."));
    };

    request.onblocked = () => {
      reject(new Error("Database open request blocked by another connection."));
    };
  });
}
