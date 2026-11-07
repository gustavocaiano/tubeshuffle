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
} from "@/lib/storage/browser-db";
import { type StorageMigrationMeta } from "@/lib/storage/storage-migrations";
import { acquireBrowserStorage, beginStorageTransaction, getBrowserStorageState, finishLegacyMigrationMarker } from "./browser-session";
export { getBrowserStorageState, subscribeBrowserStorage, getServerStorageState, recheckBrowserStorage, confirmBrowserStorageCreation } from "./browser-session";

export interface LocalPlaylistBundle {
  playlist: LocalPlaylist;
  videos: LocalVideo[];
}

interface MetaRecord<T = unknown> {
  key: string;
  value: T;
}

function completeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
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

/** Low-level fixture hook; application consumers use operations, never handles. */
export async function initializeStorage(): Promise<IDBDatabase> {
  return (await acquireBrowserStorage()).db;
}

export async function getStorageMeta(): Promise<StorageMigrationMeta> {
  const { transaction, done } = await beginStorageTransaction(STORE_META);
  const store = transaction.objectStore(STORE_META);
  const [schema, migrated] = await Promise.all([
    completeRequest(store.get("schemaVersion")), completeRequest(store.get("migratedFromLegacy")),
  ]);
  await done;
  return { schemaVersion: schema?.value ?? 1, migratedFromLegacy: migrated?.value ?? false };
}

export async function setMigratedFromLegacy(): Promise<void> {
  // Metadata changes are not a data migration and do not copy legacy rows.
  const generation = getBrowserStorageState().generation;
  const { transaction, done } = await beginStorageTransaction(STORE_META, "readwrite", generation);
  transaction.objectStore(STORE_META).put({ key: "migratedFromLegacy", value: true });
  await done;
  finishLegacyMigrationMarker(generation);
}

export async function getMetaValue<T>(key: string, expectedGeneration = getBrowserStorageState().generation): Promise<T | null> {
  const { transaction, done } = await beginStorageTransaction(STORE_META, "readonly", expectedGeneration);
  const store = transaction.objectStore(STORE_META);
  const record = (await completeRequest(store.get(key))) as MetaRecord<T> | undefined;
  await done;
  return record?.value ?? null;
}

export async function setMetaValue<T>(key: string, value: T, expectedGeneration = getBrowserStorageState().generation): Promise<void> {
  const { transaction, done } = await beginStorageTransaction(STORE_META, "readwrite", expectedGeneration);
  const store = transaction.objectStore(STORE_META);
  store.put({ key, value } satisfies MetaRecord<T>);
  await done;
}

export async function listLocalPlaylists(): Promise<LocalPlaylist[]> {
  const { transaction, done } = await beginStorageTransaction(STORE_PLAYLISTS, "readonly");
  const playlists = await readAll<LocalPlaylist>(transaction.objectStore(STORE_PLAYLISTS));
  await done;
  return playlists;
}

/** Process all transfer stores in one readonly transaction; meta is never read.
 * IndexedDB clones each cursor value before delivery: one pathological stored
 * record can still exhaust memory before application validation sees it. */
export async function readTransferSnapshot(
  accept: (kind: "playlist" | "video" | "history", value: unknown) => boolean,
  next: (kind: "video" | "history") => void,
  testDatabase?: IDBDatabase,
): Promise<void> {
  const transferStores = [STORE_PLAYLISTS, STORE_VIDEOS, STORE_PLAY_HISTORY];
  const operation = testDatabase
    ? (() => { const transaction = testDatabase.transaction(transferStores, "readonly"); return { transaction, done: completeTransaction(transaction) }; })()
    : await beginStorageTransaction(transferStores);
  const { transaction: tx, done } = operation;
  const names = [STORE_PLAYLISTS, STORE_VIDEOS, STORE_PLAY_HISTORY];
  const kinds = ["playlist", "video", "history"] as const;
  let callbackError: unknown;
  function scan(index: number) {
    const request = tx.objectStore(names[index]).openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (cursor && accept(kinds[index], cursor.value)) { cursor.continue(); }
        else if (index < 2) { next(kinds[index + 1] as "video" | "history"); scan(index + 1); }
      } catch (error) { callbackError = error; tx.abort(); }
    };
  }
  try { scan(0); await done; } catch (error) { throw callbackError ?? error; }
}

export async function getLocalPlaylist(id: string): Promise<LocalPlaylistBundle | null> {
  const { transaction, done } = await beginStorageTransaction([STORE_PLAYLISTS, STORE_VIDEOS], "readonly");
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);

  const playlist = (await completeRequest(playlistStore.get(id))) as LocalPlaylist | undefined;

  if (!playlist) {
    await done;
    return null;
  }

  const index = videosStore.index("playlistId");
  const videos = (await completeRequest(index.getAll(id))) as LocalVideo[];
  videos.sort((a, b) => a.position - b.position);

  await done;
  return { playlist, videos };
}

export async function saveLocalPlaylist(bundle: LocalPlaylistBundle, expectedGeneration = getBrowserStorageState().generation): Promise<void> {
  const { transaction, done } = await beginStorageTransaction([STORE_PLAYLISTS, STORE_VIDEOS, STORE_PLAY_HISTORY], "readwrite", expectedGeneration);
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);
  const historyStore = transaction.objectStore(STORE_PLAY_HISTORY);
  const playlistIndex = videosStore.index("playlistId");
  void done.catch(() => {});

  try {
    // Check both identities inside the write transaction, so another tab cannot
    // insert a matching playlist between this check and the subsequent writes.
    const ids = new Set<string>();
    for (const video of bundle.videos) {
      if (video.playlistId !== bundle.playlist.id || ids.has(video.id)) {
        throw new Error("Cannot import playlist: invalid or duplicate video identity. No data was changed.");
      }
      ids.add(video.id);
    }
    const [existingId, existingYouTubeId, orphanVideo, orphanHistory, ...existingVideoIds] = await Promise.all([
      completeRequest(playlistStore.getKey(bundle.playlist.id)),
      completeRequest(playlistStore.index("youtubeId").getKey(bundle.playlist.youtubeId)),
      completeRequest(playlistIndex.getKey(bundle.playlist.id)),
      completeRequest(historyStore.index("playlistId").getKey(bundle.playlist.id)),
      ...bundle.videos.map((video) => completeRequest(videosStore.getKey(video.id))),
      ...bundle.videos.map((video) => completeRequest(historyStore.index("videoId").getKey(video.id))),
    ]);
    if (existingId !== undefined || existingYouTubeId !== undefined) {
      throw new Error(
        "Syncing or reimporting an existing playlist is temporarily blocked to protect your watch history. Keep your library unchanged and retry when safe sync is available."
      );
    }

    if (orphanVideo !== undefined || orphanHistory !== undefined || existingVideoIds.some((id) => id !== undefined)) {
      throw new Error("Cannot import playlist: existing video data collides with this import. No data was changed.");
    }

    playlistStore.add(bundle.playlist);
    for (const video of bundle.videos) {
      videosStore.add(video);
    }

    await done;
  } catch (error) {
    try { transaction.abort(); } catch { /* Already completed or aborted. */ }
    await done.catch(() => {});
    throw error;
  }
}

export async function deleteLocalPlaylist(id: string): Promise<void> {
  const { transaction, done } = await beginStorageTransaction([STORE_PLAYLISTS, STORE_VIDEOS], "readwrite");
  const playlistStore = transaction.objectStore(STORE_PLAYLISTS);
  const videosStore = transaction.objectStore(STORE_VIDEOS);
  const playlistIndex = videosStore.index("playlistId");

  const videos = (await completeRequest(playlistIndex.getAll(id))) as LocalVideo[];
  for (const video of videos) {
    videosStore.delete(video.id);
  }

  playlistStore.delete(id);
  await done;
}

export async function recordLocalPlayEvent(input: LocalPlayEventInput, expectedGeneration = getBrowserStorageState().generation): Promise<void> {
  const { transaction, done } = await beginStorageTransaction(STORE_PLAY_HISTORY, "readwrite", expectedGeneration);
  const store = transaction.objectStore(STORE_PLAY_HISTORY);

  store.put(normalizePlayEvent(input));
  await done;
}

export async function getCompletedLocalVideoIds(playlistId: string): Promise<Set<string>> {
  const { transaction, done } = await beginStorageTransaction(STORE_PLAY_HISTORY, "readonly");
  // Observe aborts even if index/request creation throws synchronously.
  void done.catch(() => {});
  const request = transaction.objectStore(STORE_PLAY_HISTORY).index("playlistId").getAll(playlistId);
  const [events] = await Promise.all([
    completeRequest<LocalPlayEvent[]>(request),
    done,
  ]);
  // Preserve the existing lookup semantics, including unmapped legacy rows.
  // Matching IDs are not evidence of occurrence continuity.
  return new Set(events.filter((event) => event.completed).map((event) => event.videoId));
}

export const browserStorage = {
  getMeta: getStorageMeta,
  getMetaValue,
  setMetaValue,
  markLegacyMigrated: setMigratedFromLegacy,
  listPlaylists: listLocalPlaylists,
  getPlaylist: getLocalPlaylist,
  savePlaylist: saveLocalPlaylist,
  deletePlaylist: deleteLocalPlaylist,
  recordPlayEvent: recordLocalPlayEvent,
  getCompletedVideoIds: getCompletedLocalVideoIds,
};
