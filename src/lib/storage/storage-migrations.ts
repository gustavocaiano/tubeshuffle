import {
  DB_VERSION,
  STORE_META,
  STORE_PLAYLISTS,
  STORE_PLAY_HISTORY,
  STORE_VIDEOS,
} from "@/lib/storage/browser-db";

const META_KEY_SCHEMA_VERSION = "schemaVersion";
const META_KEY_MIGRATED_FROM_LEGACY = "migratedFromLegacy";
const LEGACY_MIGRATION_MARKER = "tubeshuffle:legacy-migrated";
const LEGACY_APP_KEY_PREFIX = "tube" + "shuffler";
const LEGACY_INDEXED_DB_NAME = `${LEGACY_APP_KEY_PREFIX}_local`;

const LEGACY_STORAGE_KEYS = [
  "playlist-store",
  "tubeshuffle-playlists",
  `${LEGACY_APP_KEY_PREFIX}-playlists`,
  `${LEGACY_APP_KEY_PREFIX}:playlists`,
  "tubeshuffle:playlists",
];

const MIGRATABLE_STORE_NAMES = [
  STORE_PLAYLISTS,
  STORE_VIDEOS,
  STORE_PLAY_HISTORY,
] as const;

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

  if (
    window.localStorage.getItem(LEGACY_MIGRATION_MARKER) === "1" ||
    window.localStorage.getItem(`${LEGACY_APP_KEY_PREFIX}:legacy-migrated`) === "1"
  ) {
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

async function legacyIndexedDbExists(): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
    return false;
  }

  const indexedDb = window.indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };

  if (!indexedDb.databases) {
    return false;
  }

  const databases = await indexedDb.databases();
  return databases.some((database) => database.name === LEGACY_INDEXED_DB_NAME);
}

function openLegacyIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LEGACY_INDEXED_DB_NAME);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open legacy IndexedDB database."));
    request.onblocked = () => reject(new Error("Legacy database open request blocked by another connection."));
  });
}

async function targetDatabaseHasPlaylists(db: IDBDatabase): Promise<boolean> {
  const transaction = db.transaction(STORE_PLAYLISTS, "readonly");
  const count = await completeRequest(transaction.objectStore(STORE_PLAYLISTS).count());
  await completeTransaction(transaction);
  return count > 0;
}

export async function migrateLegacyIndexedDb(db: IDBDatabase): Promise<void> {
  if (!(await legacyIndexedDbExists())) {
    return;
  }

  if (await targetDatabaseHasPlaylists(db)) {
    return;
  }

  const legacyDb = await openLegacyIndexedDb();

  try {
    const storeNames = MIGRATABLE_STORE_NAMES.filter(
      (storeName) =>
        db.objectStoreNames.contains(storeName) &&
        legacyDb.objectStoreNames.contains(storeName)
    );

    if (storeNames.length === 0) {
      return;
    }

    const readTransaction = legacyDb.transaction(storeNames, "readonly");
    const recordsByStore = await Promise.all(
      storeNames.map(async (storeName) => ({
        storeName,
        records: await completeRequest<unknown[]>(
          readTransaction.objectStore(storeName).getAll()
        ),
      }))
    );
    await completeTransaction(readTransaction);

    if (recordsByStore.every(({ records }) => records.length === 0)) {
      return;
    }

    const writeTransaction = db.transaction(storeNames, "readwrite");
    for (const { storeName, records } of recordsByStore) {
      const store = writeTransaction.objectStore(storeName);
      for (const record of records) {
        store.put(record);
      }
    }
    await completeTransaction(writeTransaction);

    persistLegacyMigrationSignal();
  } finally {
    legacyDb.close();
  }
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
