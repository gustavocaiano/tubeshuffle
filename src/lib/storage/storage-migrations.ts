import { DB_VERSION, STORE_META } from "@/lib/storage/browser-db";

const META_KEY_SCHEMA_VERSION = "schemaVersion";
const META_KEY_MIGRATED_FROM_LEGACY = "migratedFromLegacy";
const LEGACY_MIGRATION_MARKER = "tubeshuffler:legacy-migrated";

const LEGACY_STORAGE_KEYS = [
  "playlist-store",
  "tubeshuffle-playlists",
  "tubeshuffler-playlists",
  "tubeshuffler:playlists",
];

interface MetaRecord<T = unknown> {
  key: string;
  value: T;
}

export interface StorageMigrationMeta {
  schemaVersion: number;
  migratedFromLegacy: boolean;
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
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function readLegacyMigrationSignal(): boolean {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return false;
  }

  if (window.localStorage.getItem(LEGACY_MIGRATION_MARKER) === "1") {
    return true;
  }

  return LEGACY_STORAGE_KEYS.some((key) => window.localStorage.getItem(key) !== null);
}

function persistLegacyMigrationSignal(): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }

  window.localStorage.setItem(LEGACY_MIGRATION_MARKER, "1");
}

export async function getStorageMigrationMeta(db: IDBDatabase): Promise<StorageMigrationMeta> {
  const transaction = db.transaction(STORE_META, "readonly");
  const store = transaction.objectStore(STORE_META);

  const schemaRecord = (await completeRequest(
    store.get(META_KEY_SCHEMA_VERSION),
  )) as MetaRecord<number> | undefined;
  const migratedRecord = (await completeRequest(
    store.get(META_KEY_MIGRATED_FROM_LEGACY),
  )) as MetaRecord<boolean> | undefined;

  await completeTransaction(transaction);

  return {
    schemaVersion: schemaRecord?.value ?? DB_VERSION,
    migratedFromLegacy: migratedRecord?.value ?? false,
  };
}

export async function ensureStorageMigrationMeta(db: IDBDatabase): Promise<StorageMigrationMeta> {
  const legacyDetected = readLegacyMigrationSignal();

  const transaction = db.transaction(STORE_META, "readwrite");
  const store = transaction.objectStore(STORE_META);

  const schemaRecord = (await completeRequest(
    store.get(META_KEY_SCHEMA_VERSION),
  )) as MetaRecord<number> | undefined;
  const migratedRecord = (await completeRequest(
    store.get(META_KEY_MIGRATED_FROM_LEGACY),
  )) as MetaRecord<boolean> | undefined;

  const schemaVersion = schemaRecord?.value ?? DB_VERSION;
  const migratedFromLegacy = migratedRecord?.value ?? legacyDetected;

  if (schemaRecord === undefined) {
    store.put({ key: META_KEY_SCHEMA_VERSION, value: schemaVersion });
  }

  if (migratedRecord === undefined || migratedRecord.value !== migratedFromLegacy) {
    store.put({ key: META_KEY_MIGRATED_FROM_LEGACY, value: migratedFromLegacy });
  }

  await completeTransaction(transaction);

  if (migratedFromLegacy) {
    persistLegacyMigrationSignal();
  }

  return { schemaVersion, migratedFromLegacy };
}

export async function markMigratedFromLegacy(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction(STORE_META, "readwrite");
  const store = transaction.objectStore(STORE_META);

  store.put({ key: META_KEY_MIGRATED_FROM_LEGACY, value: true });
  await completeTransaction(transaction);
  persistLegacyMigrationSignal();
}
