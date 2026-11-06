// This module is bundled with only browser-db-target replaced at build time.
// The real opener, initializer, facade, exporter and coordinator are retained.
import { DB_NAME, DB_VERSION } from '../../../src/lib/storage/browser-db';
import * as storage from '../../../src/lib/storage';
import { exportBrowserLibrary } from '../../../src/lib/transfer/export';
import { playlistRepository } from '../../../src/stores/playlist-store';
import { createBrowserProvisioning } from '../../../src/lib/storage/browser-provisioning';
import type { BrowserProvisioning } from '../../../src/lib/storage/browser-provisioning';
import type { Guard } from './types';

const guard = (window as unknown as { __storageGuard: Guard }).__storageGuard;
if (!guard || guard.names.length !== 1 || guard.names[0] !== DB_NAME || DB_VERSION !== 1) {
  throw new Error('Fixture target was not substituted');
}
const stores = ['playlists', 'videos', 'playHistory', 'meta'];
const at = '2026-01-01T00:00:00.000Z';
export const rows = {
  playlists: [{ id: 'p1', youtubeId: 'PL_SYNTHETIC_01', title: 'Synthetic library', description: null,
    thumbnail: null, channelTitle: null, videoCount: 1, createdAt: at, updatedAt: at }],
  videos: [{ id: 'v1', playlistId: 'p1', youtubeId: 'SYNTHETIC01', title: 'Synthetic item',
    channelTitle: 'Fixture', thumbnail: '', duration: 60, position: 0 }],
  playHistory: [
    { id: 'normal', playlistId: 'p1', videoId: 'v1', watchedAt: at, watchedSeconds: 60, completed: true },
    { id: 'orphan', playlistId: 'missing', videoId: 'missing', watchedAt: at, watchedSeconds: 2, completed: true },
  ],
};
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('abort', () => reject(new Error('Fixture transaction aborted')));
  });
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener('success', () => resolve(req.result));
    req.addEventListener('error', () => reject(req.error));
  });
}
// Independent representative v1 schema. This is NOT a production schema validator.
function schema(db: IDBDatabase): void {
  guard.trace.schemaCalls++;
  const playlist = db.createObjectStore('playlists', { keyPath: 'id' });
  playlist.createIndex('youtubeId', 'youtubeId', { unique: true });
  playlist.createIndex('updatedAt', 'updatedAt');
  const video = db.createObjectStore('videos', { keyPath: 'id' });
  video.createIndex('playlistId', 'playlistId'); video.createIndex('youtubeId', 'youtubeId');
  video.createIndex('playlistPosition', ['playlistId', 'position']);
  const history = db.createObjectStore('playHistory', { keyPath: 'id' });
  for (const name of ['playlistId', 'videoId', 'watchedAt']) history.createIndex(name, name);
  db.createObjectStore('meta', { keyPath: 'key' });
}
async function seed(meta: unknown[], incomplete = false, history: unknown[] = rows.playHistory): Promise<void> {
  let fresh = false;
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.addEventListener('upgradeneeded', event => {
    if (req.result.name !== DB_NAME || req.result.version !== 1 || event.oldVersion !== 0 || !req.transaction) {
      req.transaction?.abort(); return;
    }
    fresh = true;
    if (incomplete) req.result.createObjectStore('playlists', { keyPath: 'id' });
    else {
      schema(req.result);
      for (const [name, records] of Object.entries({ ...rows, playHistory: history, meta })) {
        for (const row of records) req.transaction.objectStore(name).put(row);
      }
    }
  });
  const db = await request(req);
  db.close();
  if (!fresh) throw new Error('Fixture was not freshly created; no seed writes allowed');
}
async function snapshot() {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => req.transaction!.abort();
  const db = await request(req);
  try {
    const present = Array.from(db.objectStoreNames);
    const tx = db.transaction(present, 'readonly');
    const done = completed(tx);
    const shape = present.map(name => {
      const store = tx.objectStore(name);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map(name => {
          const index = store.index(name);
          return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }) };
    });
    const records = await Promise.all(present.map(async name => [name, await request(tx.objectStore(name).getAll())]));
    await done;
    return { ...Object.fromEntries(records), __schema: shape };
  } finally { db.close(); }
}
function coordinator(version = 1): BrowserProvisioning {
  return createBrowserProvisioning({ name: DB_NAME, version }, () => indexedDB.open(DB_NAME, version),
    db => stores.every(name => db.objectStoreNames.contains(name)), schema);
}
async function upgradeWithBlocker(closeBlocker: () => void): Promise<void> {
  const req = indexedDB.open(DB_NAME, 2);
  req.onblocked = () => closeBlocker();
  // Synthetic VERSION change only; no object store or row mutation.
  const db = await request(req);
  db.close();
}
function checkGuards(): number {
  let blocked = 0;
  // Name strings come from the test bootstrap, not the application graph.
  for (const check of guard.negativeControls) {
    try { check(); } catch { blocked++; }
  }
  return blocked;
}
// Fault injection limited to the next history-index read in this fixture realm.
// Request success alone must not publish rows if the transaction then aborts.
function abortCompletedReadOnce() {
  const nativeGetAll = IDBIndex.prototype.getAll;
  let observed = false;
  IDBIndex.prototype.getAll = function(...args) {
    const request = nativeGetAll.apply(this, args);
    const tx = this.objectStore.transaction;
    if (tx.db.name === DB_NAME && this.objectStore.name === 'playHistory' && this.name === 'playlistId') {
      IDBIndex.prototype.getAll = nativeGetAll;
      request.addEventListener('success', () => { observed = true; tx.abort(); });
    }
    return request;
  };
  return { observed: () => observed, restore: () => { IDBIndex.prototype.getAll = nativeGetAll; } };
}
async function rawBlocker(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.transaction!.abort();
  return request(req);
}
const api = { rawBlocker, checkGuards, storage, playlistRepository, abortCompletedReadOnce, exportBrowserLibrary, seed, snapshot, coordinator, upgradeWithBlocker, guard, rows };
(window as unknown as { fixture: typeof api }).fixture = api;
export type Fixture = typeof api;
