import type {
  LocalPlayEvent,
  LocalPlayEventInput,
  LocalPlaylist,
  LocalVideo,
} from "@/types/playlist";
import {
  STORE_PLAYLISTS,
  STORE_PLAY_HISTORY,
  STORE_META,
  STORE_VIDEOS,
  openBrowserDb,
} from "@/lib/storage/browser-db";
import {
  ensureStorageMigrationMeta,
  getStorageMigrationMeta,
  markMigratedFromLegacy,
  migrateLegacyIndexedDb,
  type StorageMigrationMeta,
} from "@/lib/storage/storage-migrations";

export interface LocalPlaylistBundle {
  playlist: LocalPlaylist;
  videos: LocalVideo[];
}

interface MetaRecord<T = unknown> {
  key: string;
  value: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function completeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function readAll<T>(store: IDBObjectStore): Promise<T[]> {
  return completeRequest<T[]>(store.getAll());
}

function normalizePlayEvent(input: LocalPlayEventInput): LocalPlayEvent {
  return {
    id: input.id ?? crypto.randomUUID(),
    playlistId: input.playlistId,
    videoId: input.videoId,
    watchedAt: input.watchedAt ?? new Date().toISOString(),
    watchedSeconds: input.watchedSeconds,
    completed: input.completed,
  };
}

export async function initializeStorage(): Promise<IDBDatabase> {
  if (dbPromise === null) {
    dbPromise = openBrowserDb();
  }

  const db = await dbPromise;
  try {
    await migrateLegacyIndexedDb(db);
  } catch (error) {
    console.warn("Legacy IndexedDB migration skipped:", error);
  }
  await ensureStorageMigrationMeta(db);
  return db;
}

export async function getStorageMeta(): Promise<StorageMigrationMeta> {
  const db = await initializeStorage();
  return getStorageMigrationMeta(db);
}

export async function setMigratedFromLegacy(): Promise<void> {
  const db = await initializeStorage();
  await markMigratedFromLegacy(db);
}

export async function getMetaValue<T>(key: string): Promise<T | null> {
  const db = await initializeStorage();
  const transaction = db.transaction(STORE_META, "readonly");
  const store = transaction.objectStore(STORE_META);
  const record = (await completeRequest(store.get(key))) as MetaRecord<T> | undefined;
  await completeTransaction(transaction);
  return record?.value ?? null;
}

export async function setMetaValue<T>(key: string, value: T): Promise<void> {
  const db = await initializeStorage();
  const transaction = db.transaction(STORE_META, "readwrite");
  const store = transaction.objectStore(STORE_META);
  store.put({ key, value } satisfies MetaRecord<T>);
  await completeTransaction(transaction);
}

export async function listLocalPlaylists(): Promise<LocalPlaylist[]> {
  const db = await initializeStorage();
  const transaction = db.transaction(STORE_PLAYLISTS, "readonly");
  const playlists = await readAll<LocalPlaylist>(transaction.objectStore(STORE_PLAYLISTS));
  await completeTransaction(transaction);
  return playlists;
}

export async function getLocalPlaylist(id: string): Promise<LocalPlaylistBundle | null> {
  const db = await initializeStorage();
  const transaction = db.transaction([STORE_PLAYLISTS, STORE_VIDEOS], "readonly");
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);

  const playlist = (await completeRequest(playlistStore.get(id))) as LocalPlaylist | undefined;

  if (!playlist) {
    await completeTransaction(transaction);
    return null;
  }

  const index = videosStore.index("playlistId");
  const videos = (await completeRequest(index.getAll(id))) as LocalVideo[];
  videos.sort((a, b) => a.position - b.position);

  await completeTransaction(transaction);
  return { playlist, videos };
}

export async function saveLocalPlaylist(bundle: LocalPlaylistBundle): Promise<void> {
  const db = await initializeStorage();
  const transaction = db.transaction([STORE_PLAYLISTS, STORE_VIDEOS], "readwrite");
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);
  const playlistIndex = videosStore.index("playlistId");

  playlistStore.put(bundle.playlist);

  const existingVideos = (await completeRequest(playlistIndex.getAll(bundle.playlist.id))) as LocalVideo[];
  for (const video of existingVideos) {
    videosStore.delete(video.id);
  }

  for (const video of bundle.videos) {
    videosStore.put(video);
  }

  await completeTransaction(transaction);
}

export async function deleteLocalPlaylist(id: string): Promise<void> {
  const db = await initializeStorage();
  const transaction = db.transaction([STORE_PLAYLISTS, STORE_VIDEOS], "readwrite");
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);
  const playlistIndex = videosStore.index("playlistId");

  const videos = (await completeRequest(playlistIndex.getAll(id))) as LocalVideo[];
  for (const video of videos) {
    videosStore.delete(video.id);
  }

  playlistStore.delete(id);
  await completeTransaction(transaction);
}

export async function recordLocalPlayEvent(input: LocalPlayEventInput): Promise<void> {
  const db = await initializeStorage();
  const transaction = db.transaction(STORE_PLAY_HISTORY, "readwrite");
  const store = transaction.objectStore(STORE_PLAY_HISTORY);

  store.put(normalizePlayEvent(input));
  await completeTransaction(transaction);
}

export const browserStorage = {
  initialize: initializeStorage,
  getMeta: getStorageMeta,
  getMetaValue,
  setMetaValue,
  markLegacyMigrated: setMigratedFromLegacy,
  listPlaylists: listLocalPlaylists,
  getPlaylist: getLocalPlaylist,
  savePlaylist: saveLocalPlaylist,
  deletePlaylist: deleteLocalPlaylist,
  recordPlayEvent: recordLocalPlayEvent,
};
