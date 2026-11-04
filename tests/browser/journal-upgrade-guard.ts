// TEST-ONLY native IndexedDB lifecycle rehearsal for a future completion-journal
// schema upgrade. Run with:
//   JOURNAL_GUARD_MODE=upgrade CHROMIUM_PATH=/path/to/chrome \
//     node tests/browser/run-completion-journal-guard.mjs
//
// This module runs only on the runner's fresh loopback origin and ephemeral
// Chrome profile. It never opens an application database name, never imports the
// production storage module, and is not part of the production schema or upgrade
// path. The synthetic v1 shape below is a test-only model of the current
// production stores; it is not the app's DB_VERSION and proves nothing about app
// behavior.
//
// The runner generates four runtime-unique database names for this mode and
// installs a native boot guard at `window.__journalGuard` with that exact
// allowlist. The guard rejects any other open, rejects every deleteDatabase
// call (profile cleanup only), and blocks fetch/XHR/WebSocket/EventSource/
// beacon traffic. Each scenario uses its own fresh name; every first creation
// is observed at onupgradeneeded oldVersion 0 before any store is created.
//
// Covered here:
//   1. A cooperative versionchange closes a v1 connection and a 1 -> 2 additive
//      upgrade preserves the exact v1 rows (including a synthetic orphan history
//      row and the `{key: "schemaVersion", value: 1}` marker), store/index
//      metadata, and meta rows. A lower-version open is then rejected with
//      VersionError without an upgrade, and a same-version retry succeeds.
//   2. A real blocker keeps a v2 open pending. One test-only opener rejects its
//      returned promise on native `blocked` and closes any result that arrives
//      after that rejection. A separate fresh retry is started while the blocker
//      is still held. After release, the opener's late result is observed
//      already closed and a transaction on it fails; the retry succeeds and
//      remains usable after the late close.
//   3. A deliberate upgrade abort leaves v1 unchanged on reopen, and a retried
//      v2 upgrade then succeeds.
//   4. A pending specialized opener is disposed before the blocker is released
//      (modeling a watchdog failure), its returned promise rejects with the
//      disposal reason, its later success is closed by the opener, exactly one
//      1 -> 2 upgrade runs, and an unexpectedly delivered success handle is
//      closed instead of leaking.
//
// The `openRejectingBlockedAndClosingLate` helper models only the behavior used
// here. A production open cache, cached rejections, and a general closed-handle
// manager are not implemented or claimed; they remain explicit gaps. Production
// upgrade, migration, repository, player, durability, and user-data behavior are
// also not covered.
//
// All waits are event barriers with bounded watchdogs, not sleeps. Every
// acquired handle is closed on normal and failure paths, abandoned opens close a
// late result, and transaction completion is bounded by an outer watchdog with
// cleanup. Treat platform behavior observed here as local Linux Chrome evidence
// only.
const TEST_DB_PREFIX = "tubeshuffle-journal-upgrade-test-";
const PRODUCTION_DB_NAME = "tubeshuffle_local";
const V1_VERSION = 1;
const V2_VERSION = 2;
const WATCHDOG_MS = 10_000;

const STORE_PLAYLISTS = "playlists";
const STORE_VIDEOS = "videos";
const STORE_PLAY_HISTORY = "playHistory";
const STORE_META = "meta";
const JOURNAL_STORE = "completionJournal";

const V1_STORE_NAMES = [
  STORE_PLAYLISTS,
  STORE_VIDEOS,
  STORE_PLAY_HISTORY,
  STORE_META,
] as const;
type V1StoreName = (typeof V1_STORE_NAMES)[number];
type SeedRows = Record<V1StoreName, Record<string, unknown>[]>;

interface SchemaIndex {
  readonly name: string;
  readonly keyPath: string | string[] | null;
  readonly unique: boolean;
  readonly multiEntry: boolean;
}

interface SchemaStore {
  readonly name: string;
  readonly keyPath: string | string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: SchemaIndex[];
}

// Test-only model of the production v1 stores. Do not import production code
// here: this rehearsal must not become the production upgrade path.
const EXPECTED_V1_SCHEMA: SchemaStore[] = [
  {
    name: STORE_META,
    keyPath: "key",
    autoIncrement: false,
    indexes: [],
  },
  {
    name: STORE_PLAY_HISTORY,
    keyPath: "id",
    autoIncrement: false,
    indexes: [
      { name: "playlistId", keyPath: "playlistId", unique: false, multiEntry: false },
      { name: "videoId", keyPath: "videoId", unique: false, multiEntry: false },
      { name: "watchedAt", keyPath: "watchedAt", unique: false, multiEntry: false },
    ],
  },
  {
    name: STORE_PLAYLISTS,
    keyPath: "id",
    autoIncrement: false,
    indexes: [
      { name: "updatedAt", keyPath: "updatedAt", unique: false, multiEntry: false },
      { name: "youtubeId", keyPath: "youtubeId", unique: true, multiEntry: false },
    ],
  },
  {
    name: STORE_VIDEOS,
    keyPath: "id",
    autoIncrement: false,
    indexes: [
      { name: "playlistId", keyPath: "playlistId", unique: false, multiEntry: false },
      {
        name: "playlistPosition",
        keyPath: ["playlistId", "position"],
        unique: false,
        multiEntry: false,
      },
      { name: "youtubeId", keyPath: "youtubeId", unique: false, multiEntry: false },
    ],
  },
];

const JOURNAL_SCHEMA: SchemaStore = {
  name: JOURNAL_STORE,
  keyPath: "key",
  autoIncrement: false,
  indexes: [],
};

const EXPECTED_V2_SCHEMA: SchemaStore[] = [JOURNAL_SCHEMA, ...EXPECTED_V1_SCHEMA];

interface UpgradeGuardState {
  readonly mode: string;
  readonly dbNames: readonly string[];
  readonly allowed: ReadonlySet<string>;
  readonly openedNames: string[];
  readonly deleteNames: string[];
  readonly unexpectedOpenAttempts: string[];
  readonly productionOpenAttempts: number;
  readonly networkAttempts: number;
  readonly nativeFetch: typeof window.fetch;
}

const guardState = (
  window as unknown as { readonly __journalGuard?: UpgradeGuardState }
).__journalGuard;
// The boot guard replaces window.fetch with a rejecting blocker. The report is
// the only request this module makes, and it uses the pre-block native fetch.
const reportFetch = guardState?.nativeFetch ?? window.fetch.bind(window);
const outcomes: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    return (
      actual.length === expected.length &&
      actual.every((value, index) => deepEqual(value, expected[index]))
    );
  }
  if (isRecord(actual) && isRecord(expected)) {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(expected, key) &&
          deepEqual(actual[key], expected[key]),
      )
    );
  }
  return false;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  // A signal may intentionally be observed after it fired or not awaited on a
  // failing branch; keep that from surfacing as an unhandled rejection.
  void promise.catch(() => undefined);
  return { promise, resolve: resolveValue, reject: rejectValue };
}

// Bounded watchdog for event barriers. It never waits a fixed time before an
// assertion; it only fails a hang.
function withWatchdog<T>(
  promise: Promise<T>,
  label: string,
  milliseconds: number = WATCHDOG_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: watchdog expired after ${milliseconds}ms`));
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

interface UpgradeObservation {
  readonly oldVersion: number;
  readonly newVersion: number | null;
}

type OpenOutcome =
  | { readonly kind: "success"; readonly db: IDBDatabase }
  | { readonly kind: "error"; readonly error: unknown };

interface OpenStats {
  blocked: number;
  blockedWhilePending: number;
  success: number;
  error: number;
}

interface OpenAttempt {
  readonly request: IDBOpenDBRequest;
  readonly upgrades: UpgradeObservation[];
  readonly stats: OpenStats;
  readonly waitBlocked: () => Promise<void>;
  readonly settle: () => Promise<OpenOutcome>;
  // Marks the attempt abandoned. A result arriving later is closed instead of
  // being handed to the caller. There is no open-request cancellation API.
  readonly abandon: (reason?: unknown) => void;
}

// Wraps one open request in explicit event signals. The caller decides how to
// model a blocked caller; the underlying request is left alive so a later
// success can be observed and closed.
function openDatabase(
  name: string,
  version: number | undefined,
  onUpgrade?: (
    event: IDBVersionChangeEvent,
    db: IDBDatabase,
    request: IDBOpenDBRequest,
  ) => void,
): OpenAttempt {
  const upgrades: UpgradeObservation[] = [];
  const stats: OpenStats = {
    blocked: 0,
    blockedWhilePending: 0,
    success: 0,
    error: 0,
  };
  const blocked = deferred<void>();
  const outcome = deferred<OpenOutcome>();
  let state: "pending" | "success" | "error" = "pending";
  const request =
    version === undefined
      ? indexedDB.open(name)
      : indexedDB.open(name, version);

  const settleError = (error: unknown): void => {
    if (state !== "pending") return;
    state = "error";
    stats.error += 1;
    outcome.resolve({ kind: "error", error });
  };
  const settleSuccess = (db: IDBDatabase): void => {
    if (state !== "pending") {
      // The attempt was abandoned before this late result arrived.
      db.close();
      return;
    }
    state = "success";
    stats.success += 1;
    outcome.resolve({ kind: "success", db });
  };

  request.onupgradeneeded = (event) => {
    const db = request.result;
    upgrades.push({
      oldVersion: event.oldVersion,
      newVersion: event.newVersion,
    });
    if (state !== "pending") {
      // Abandoned before the upgrade ran: do not create test stores.
      try {
        request.transaction?.abort();
      } catch {
        // The upgrade transaction may already be inactive.
      }
      return;
    }
    try {
      onUpgrade?.(event, db, request);
    } catch (error) {
      try {
        request.transaction?.abort();
      } catch {
        // The upgrade transaction may already be inactive.
      }
      settleError(error);
    }
  };
  request.onblocked = () => {
    stats.blocked += 1;
    if (state === "pending") {
      stats.blockedWhilePending += 1;
    }
    blocked.resolve();
  };
  request.onsuccess = () => settleSuccess(request.result);
  request.onerror = () =>
    settleError(
      request.error ?? new Error(`${name}: IndexedDB open request failed`),
    );

  return {
    request,
    upgrades,
    stats,
    waitBlocked: () => blocked.promise,
    settle: () => outcome.promise,
    abandon: (reason?: unknown) =>
      settleError(reason ?? new Error(`${name}: open attempt abandoned`)),
  };
}

async function awaitOpen(attempt: OpenAttempt, label: string): Promise<IDBDatabase> {
  let openOutcome: OpenOutcome;
  try {
    openOutcome = await withWatchdog(attempt.settle(), label);
  } catch (error) {
    attempt.abandon(error);
    throw error;
  }
  if (openOutcome.kind === "error") {
    throw new Error(`${label}: ${describeError(openOutcome.error)}`);
  }
  return openOutcome.db;
}

async function requireOpenError(
  attempt: OpenAttempt,
  label: string,
): Promise<unknown> {
  let openOutcome: OpenOutcome;
  try {
    openOutcome = await withWatchdog(attempt.settle(), label);
  } catch (error) {
    attempt.abandon(error);
    throw error;
  }
  if (openOutcome.kind === "success") {
    openOutcome.db.close();
    throw new Error(`${label}: expected an open error, got success`);
  }
  return openOutcome.error;
}

interface LateCleaningOpen {
  readonly request: IDBOpenDBRequest;
  readonly result: Promise<IDBDatabase>;
  readonly upgrades: UpgradeObservation[];
  readonly lateHandles: readonly IDBDatabase[];
  readonly waitLateSuccess: () => Promise<void>;
  readonly blockedCount: () => number;
  // Abandons a still-pending request (or closes an already-resolved handle) so a
  // late result is owned and closed instead of escaping on a failure path.
  readonly dispose: (reason?: unknown) => void;
}

// Single test-only opener: its returned promise rejects on native `blocked`,
// and its own onsuccess closes any result that arrives after that rejection.
// The closed handle is still retained in `lateHandles` so a caller can observe
// it independently without closing it. This is not a production open cache or
// a general handle manager.
function openRejectingBlockedAndClosingLate(
  name: string,
  version: number,
  onUpgrade?: (
    event: IDBVersionChangeEvent,
    db: IDBDatabase,
    request: IDBOpenDBRequest,
  ) => void,
): LateCleaningOpen {
  const upgrades: UpgradeObservation[] = [];
  const lateHandles: IDBDatabase[] = [];
  const lateSuccess = deferred<void>();
  let blocked = 0;
  let state: "pending" | "resolved" | "rejected" = "pending";
  let disposed = false;
  let resolvedHandle: IDBDatabase | undefined;
  let resolveResult!: (db: IDBDatabase) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<IDBDatabase>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);
  const request = indexedDB.open(name, version);

  request.onupgradeneeded = (event) => {
    const db = request.result;
    upgrades.push({
      oldVersion: event.oldVersion,
      newVersion: event.newVersion,
    });
    // Let the abandoned request finish its upgrade. Its onsuccess must be able
    // to close the late result; aborting here would prevent that observation.
    try {
      onUpgrade?.(event, db, request);
    } catch (error) {
      try {
        request.transaction?.abort();
      } catch {
        // The upgrade transaction may already be inactive.
      }
      if (state === "pending") {
        state = "rejected";
        rejectResult(error);
      }
    }
  };
  request.onblocked = () => {
    blocked += 1;
    if (state !== "pending") return;
    state = "rejected";
    rejectResult(
      new DOMException(`${name}: native open blocked`, "TimeoutError"),
    );
  };
  request.onsuccess = () => {
    const db = request.result;
    if (state === "rejected") {
      // This opener owns cleanup of any result arriving after rejection.
      lateHandles.push(db);
      db.close();
      lateSuccess.resolve();
      return;
    }
    if (state === "resolved") {
      db.close();
      return;
    }
    state = "resolved";
    resolvedHandle = db;
    resolveResult(db);
  };
  request.onerror = () => {
    if (state !== "pending") return;
    state = "rejected";
    rejectResult(
      request.error ?? new Error(`${name}: IndexedDB open request failed`),
    );
  };
  const dispose = (reason?: unknown): void => {
    if (disposed) return;
    disposed = true;
    if (state === "resolved") {
      // The caller may also close it; close is idempotent.
      resolvedHandle?.close();
      return;
    }
    if (state === "rejected") return;
    // No open-request cancellation API exists. Mark the attempt abandoned so
    // any later onsuccess closes its result instead of handing it out.
    state = "rejected";
    rejectResult(reason ?? new Error(`${name}: open attempt disposed`));
  };

  return {
    request,
    result,
    upgrades,
    lateHandles,
    waitLateSuccess: () => lateSuccess.promise,
    blockedCount: () => blocked,
    dispose,
  };
}

function isDatabaseHandle(value: unknown): value is IDBDatabase {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IDBDatabase).close === "function" &&
    typeof (value as IDBDatabase).transaction === "function"
  );
}

async function rejectsWithName(
  operation: Promise<unknown>,
  name: string,
  label: string,
): Promise<void> {
  let failure: unknown;
  let resolved: unknown;
  let didResolve = false;
  try {
    resolved = await withWatchdog(operation, label);
    didResolve = true;
  } catch (error) {
    failure = error;
  }
  if (didResolve) {
    // An unexpected success must not leak its handle just because this helper
    // expected a rejection.
    if (isDatabaseHandle(resolved)) {
      resolved.close();
      throw new Error(
        `${label}: unexpectedly resolved with a database handle; the test closed it`,
      );
    }
    throw new Error(
      `${label}: expected ${name}, but the operation resolved to ${String(
        resolved,
      )}`,
    );
  }
  assert(
    failure instanceof DOMException && failure.name === name,
    `${label}: expected ${name}, got ${String(failure)}`,
  );
}

function normalizeKeyPath(
  keyPath: string | string[] | null,
): string | string[] | null {
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readSchema(db: IDBDatabase): SchemaStore[] {
  const names = Array.from(db.objectStoreNames).sort(compareNames);
  const transaction = db.transaction(names, "readonly");
  try {
    return names.map((name) => {
      const store = transaction.objectStore(name);
      const indexes = Array.from(store.indexNames)
        .sort(compareNames)
        .map((indexName) => {
          const index = store.index(indexName);
          return {
            name: index.name,
            keyPath: normalizeKeyPath(index.keyPath),
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        });
      return {
        name,
        keyPath: normalizeKeyPath(store.keyPath),
        autoIncrement: store.autoIncrement,
        indexes,
      };
    });
  } finally {
    try {
      transaction.abort();
    } catch {
      // The metadata transaction may already have finished.
    }
  }
}

// Every transaction wait is bounded by an outer watchdog. On timeout or error
// the transaction is aborted where possible and the owning handle is closed so
// failure does not leak an open connection.
async function boundedTransaction<T>(
  db: IDBDatabase,
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  label: string,
  run: (transaction: IDBTransaction, completed: Promise<void>) => Promise<T>,
): Promise<T> {
  const transaction = db.transaction([...storeNames], mode);
  const completed = transactionComplete(transaction);
  // `run` may throw before `completed` is awaited; keep that later rejection
  // from surfacing as unhandled while still awaiting it on the normal path.
  void completed.catch(() => undefined);
  const work = (async () => {
    const value = await run(transaction, completed);
    await completed;
    return value;
  })();
  try {
    return await withWatchdog(work, label);
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be finished.
    }
    try {
      db.close();
    } catch {
      // The handle may already be closed.
    }
    throw error;
  }
}

function readStores(
  db: IDBDatabase,
  names: readonly string[],
): Promise<Record<string, unknown[]>> {
  return boundedTransaction(
    db,
    names,
    "readonly",
    `read stores ${names.join(", ")}`,
    async (transaction) => {
      const requests = names.map(
        (name) => [name, transaction.objectStore(name).getAll()] as const,
      );
      const rows: Record<string, unknown[]> = {};
      for (const [name, request] of requests) {
        rows[name] = await requestResult(request);
      }
      return rows;
    },
  );
}

function createV1Stores(db: IDBDatabase): void {
  const playlists = db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
  playlists.createIndex("youtubeId", "youtubeId", { unique: true });
  playlists.createIndex("updatedAt", "updatedAt", { unique: false });

  const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: "id" });
  videos.createIndex("playlistId", "playlistId", { unique: false });
  videos.createIndex("youtubeId", "youtubeId", { unique: false });
  videos.createIndex("playlistPosition", ["playlistId", "position"], {
    unique: false,
  });

  const playHistory = db.createObjectStore(STORE_PLAY_HISTORY, {
    keyPath: "id",
  });
  playHistory.createIndex("playlistId", "playlistId", { unique: false });
  playHistory.createIndex("videoId", "videoId", { unique: false });
  playHistory.createIndex("watchedAt", "watchedAt", { unique: false });

  db.createObjectStore(STORE_META, { keyPath: "key" });
}

function syntheticRows(tag: string): SeedRows {
  const id = `${tag}-${crypto.randomUUID()}`;
  const playlistId = `synthetic-playlist-${id}`;
  const videoId = `synthetic-video-${id}`;
  return {
    [STORE_PLAYLISTS]: [
      {
        id: playlistId,
        youtubeId: `synthetic-youtube-playlist-${id}`,
        title: "Synthetic Playlist",
        description: "Synthetic fixture row",
        thumbnail: null,
        videoCount: 1,
        createdAt: "2026-11-04T00:00:00.000Z",
        updatedAt: "2026-11-04T00:01:00.000Z",
      },
    ],
    [STORE_VIDEOS]: [
      {
        id: videoId,
        playlistId,
        youtubeId: `synthetic-youtube-video-${id}`,
        title: "Synthetic Video",
        position: 0,
        durationSeconds: 128,
        thumbnail: null,
        channelTitle: "Synthetic Channel",
      },
    ],
    [STORE_PLAY_HISTORY]: [
      {
        id: `synthetic-history-${id}`,
        playlistId,
        videoId,
        watchedAt: "2026-11-04T00:02:00.000Z",
        watchedSeconds: 42,
        completed: true,
      },
      {
        // Deliberate orphan: no playlist or video with these ids exists.
        id: `synthetic-orphan-history-${id}`,
        playlistId: `missing-playlist-${id}`,
        videoId: `missing-video-${id}`,
        watchedAt: "2026-11-04T00:03:00.000Z",
        watchedSeconds: 7,
        completed: false,
      },
    ],
    [STORE_META]: [
      { key: "schemaVersion", value: 1 },
      {
        key: `synthetic-meta-${id}`,
        value: { schemaVersion: 1, marker: "synthetic-v1", id },
      },
    ],
  };
}

async function seedV1Rows(db: IDBDatabase, rows: SeedRows): Promise<void> {
  await boundedTransaction(
    db,
    V1_STORE_NAMES,
    "readwrite",
    "seed v1 rows",
    async (transaction) => {
      const requests: Promise<unknown>[] = [];
      for (const name of V1_STORE_NAMES) {
        const store = transaction.objectStore(name);
        for (const row of rows[name]) {
          requests.push(requestResult(store.add(row)));
        }
      }
      await Promise.all(requests);
    },
  );
}

async function addJournalRow(
  db: IDBDatabase,
  record: Record<string, unknown>,
): Promise<void> {
  await boundedTransaction(
    db,
    [JOURNAL_STORE],
    "readwrite",
    "add completionJournal row",
    async (transaction) => {
      await requestResult(
        transaction.objectStore(JOURNAL_STORE).add(record),
      );
    },
  );
}

interface SeededFixture {
  readonly db: IDBDatabase;
  readonly rows: Record<string, unknown[]>;
  readonly schema: SchemaStore[];
}

async function createSeededV1(name: string): Promise<SeededFixture> {
  const creation = openDatabase(name, undefined, (event, db) => {
    // Require a genuinely fresh database before any store is created. This is
    // the only place scenario fixtures come from.
    equal(event.oldVersion, 0, `${name}: fresh creation oldVersion`);
    equal(event.newVersion, V1_VERSION, `${name}: fresh creation newVersion`);
    assert(
      db.objectStoreNames.length === 0,
      `${name}: fresh creation found pre-existing stores`,
    );
    createV1Stores(db);
  });
  let created: IDBDatabase | undefined;
  try {
    created = await awaitOpen(creation, `${name}: v1 creation`);
    equal(
      creation.upgrades,
      [{ oldVersion: 0, newVersion: V1_VERSION }],
      `${name}: fresh creation upgrade events`,
    );
    equal(created.version, V1_VERSION, `${name}: v1 version`);
    equal(
      Array.from(created.objectStoreNames).sort(compareNames),
      [...V1_STORE_NAMES].sort(compareNames),
      `${name}: v1 store names`,
    );
    equal(readSchema(created), EXPECTED_V1_SCHEMA, `${name}: v1 schema model`);

    const seed = syntheticRows(name);
    equal(
      seed[STORE_META].filter((row) => row.key === "schemaVersion"),
      [{ key: "schemaVersion", value: 1 }],
      `${name}: schemaVersion marker seed`,
    );
    assert(
      seed[STORE_PLAY_HISTORY].some(
        (row) =>
          typeof row.playlistId === "string" &&
          row.playlistId.startsWith("missing-playlist-"),
      ),
      `${name}: seed is missing the synthetic orphan history row`,
    );

    await seedV1Rows(created, seed);
    const rows = await readStores(created, V1_STORE_NAMES);
    equal(rows, seed, `${name}: seeded v1 rows`);
    return { db: created, rows, schema: readSchema(created) };
  } catch (error) {
    try {
      created?.close();
    } catch {
      // The handle may already be closed.
    }
    throw error;
  }
}

function assertTransactionFails(db: IDBDatabase, label: string): void {
  let failure: unknown;
  try {
    db.transaction(STORE_META, "readonly");
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof DOMException && failure.name === "InvalidStateError",
    `${label}: expected InvalidStateError from a closed handle, got ${String(
      failure,
    )}`,
  );
}

function upgradeToV2(
  event: IDBVersionChangeEvent,
  db: IDBDatabase,
  label: string,
): void {
  equal(event.oldVersion, V1_VERSION, `${label}: upgrade oldVersion`);
  equal(event.newVersion, V2_VERSION, `${label}: upgrade newVersion`);
  assert(
    !db.objectStoreNames.contains(JOURNAL_STORE),
    `${label}: ${JOURNAL_STORE} already existed before the upgrade`,
  );
  equal(
    Array.from(db.objectStoreNames).sort(compareNames),
    [...V1_STORE_NAMES].sort(compareNames),
    `${label}: upgrade must start from the v1 stores only`,
  );
  db.createObjectStore(JOURNAL_STORE, { keyPath: "key" });
}

async function cooperativeUpgrade(name: string): Promise<string> {
  const fixture = await createSeededV1(name);
  let upgraded: IDBDatabase | undefined;
  let retriedAfterVersionError: IDBDatabase | undefined;
  try {
    const versionChange = deferred<void>();
    let versionChanges = 0;
    let closedByHandler = false;
    fixture.db.onversionchange = (event) => {
      versionChanges += 1;
      equal(event.oldVersion, V1_VERSION, `${name}: versionchange oldVersion`);
      equal(event.newVersion, V2_VERSION, `${name}: versionchange newVersion`);
      fixture.db.close();
      closedByHandler = true;
      versionChange.resolve();
    };

    const attempt = openDatabase(name, V2_VERSION, (event, db) =>
      upgradeToV2(event, db, name),
    );
    upgraded = await awaitOpen(attempt, `${name}: cooperative v2 open`);
    await withWatchdog(
      versionChange.promise,
      `${name}: cooperative versionchange`,
    );
    equal(
      attempt.upgrades,
      [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
      `${name}: cooperative upgrade events`,
    );
    equal(versionChanges, 1, `${name}: cooperative versionchange count`);
    assert(closedByHandler, `${name}: v1 handle was not closed cooperatively`);
    // The v1 handle must already be unusable after the cooperative close.
    assertTransactionFails(fixture.db, `${name}: cooperative v1 handle`);

    equal(upgraded.version, V2_VERSION, `${name}: upgraded version`);
    equal(readSchema(upgraded), EXPECTED_V2_SCHEMA, `${name}: upgraded schema`);
    equal(
      await readStores(upgraded, V1_STORE_NAMES),
      fixture.rows,
      `${name}: upgrade changed v1 rows`,
    );
    const journalRows = await readStores(upgraded, [JOURNAL_STORE]);
    equal(
      journalRows[JOURNAL_STORE],
      [],
      `${name}: additive upgrade seeded journal rows`,
    );

    // A lower-version request must fail with VersionError without firing
    // onupgradeneeded; a same-version retry must then succeed.
    const lowerAttempt = openDatabase(name, V1_VERSION);
    const lowerError = await requireOpenError(
      lowerAttempt,
      `${name}: lower-version open`,
    );
    assert(
      lowerError instanceof DOMException && lowerError.name === "VersionError",
      `${name}: lower-version open did not report VersionError: ${String(
        lowerError,
      )}`,
    );
    equal(
      lowerAttempt.upgrades,
      [],
      `${name}: lower-version open fired onupgradeneeded`,
    );

    const retryAttempt = openDatabase(name, V2_VERSION);
    retriedAfterVersionError = await awaitOpen(
      retryAttempt,
      `${name}: retry after VersionError`,
    );
    equal(retryAttempt.upgrades, [], `${name}: same-version retry upgraded`);
    equal(
      readSchema(retriedAfterVersionError),
      EXPECTED_V2_SCHEMA,
      `${name}: same-version retry schema`,
    );
    equal(
      await readStores(retriedAfterVersionError, V1_STORE_NAMES),
      fixture.rows,
      `${name}: same-version retry changed v1 rows`,
    );
    retriedAfterVersionError.close();
    retriedAfterVersionError = undefined;

    return "a cooperative versionchange closed v1; a 1 -> 2 additive upgrade preserved exact rows (including the synthetic orphan history row and schemaVersion marker), indexes, and meta; a lower-version open raised VersionError without upgrade and a same-version retry succeeded";
  } finally {
    retriedAfterVersionError?.close();
    upgraded?.close();
    fixture.db.close();
  }
}

async function blockedUpgrade(name: string): Promise<string> {
  const fixture = await createSeededV1(name);
  let retried: IDBDatabase | undefined;
  let opener: LateCleaningOpen | undefined;
  let retryAttempt: OpenAttempt | undefined;
  try {
    const blockerVersionChange = deferred<void>();
    let blockerVersionChanges = 0;
    // Actual blocker: the v1 connection is kept open and the versionchange
    // handler deliberately does not close it.
    fixture.db.onversionchange = (event) => {
      blockerVersionChanges += 1;
      equal(event.oldVersion, V1_VERSION, `${name}: blocker oldVersion`);
      equal(event.newVersion, V2_VERSION, `${name}: blocker newVersion`);
      blockerVersionChange.resolve();
    };

    // One opener owns the blocked rejection and any late success cleanup.
    opener = openRejectingBlockedAndClosingLate(
      name,
      V2_VERSION,
      (event, db) => upgradeToV2(event, db, `${name}: late upgrade`),
    );
    await rejectsWithName(
      opener.result,
      "TimeoutError",
      `${name}: single opener rejects on blocked`,
    );
    await withWatchdog(
      blockerVersionChange.promise,
      `${name}: blocker versionchange`,
    );
    equal(opener.blockedCount(), 1, `${name}: native blocked count`);
    equal(opener.upgrades, [], `${name}: upgrade before unblock`);
    equal(
      opener.request.readyState,
      "pending",
      `${name}: blocked request must remain pending`,
    );
    equal(blockerVersionChanges, 1, `${name}: blocker versionchange count`);

    // Start a separate fresh retry while the blocker is still held. Both
    // requests are pending; only one can perform the 1 -> 2 upgrade.
    retryAttempt = openDatabase(name, V2_VERSION, (event, db) =>
      upgradeToV2(event, db, `${name}: retry upgrade`),
    );

    // Release the real blocker.
    fixture.db.close();
    retried = await awaitOpen(retryAttempt, `${name}: retry before release`);
    await withWatchdog(
      opener.waitLateSuccess(),
      `${name}: late success cleanup`,
    );

    equal(opener.lateHandles.length, 1, `${name}: late result count`);
    const lateHandle: IDBDatabase | undefined = opener.lateHandles[0];
    assert(lateHandle, `${name}: late opener did not retain its late result`);
    assert(
      lateHandle !== retried,
      `${name}: late handle and retry handle must be distinct connections`,
    );
    // The opener, not this assertion, closed the late handle. Observing that a
    // transaction fails proves it is already closed; do not close it here.
    assertTransactionFails(lateHandle, `${name}: late handle`);
    equal(
      [...opener.upgrades, ...retryAttempt.upgrades],
      [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
      `${name}: exactly one 1 -> 2 upgrade across the late opener and retry`,
    );

    // The late event must not invalidate the retry connection.
    equal(retried.version, V2_VERSION, `${name}: retry version`);
    equal(readSchema(retried), EXPECTED_V2_SCHEMA, `${name}: retry schema`);
    equal(
      await readStores(retried, V1_STORE_NAMES),
      fixture.rows,
      `${name}: retry changed v1 rows`,
    );
    const journalKey = `blocked-retry-${crypto.randomUUID()}`;
    const journalRecord = {
      key: ["completion", journalKey],
      version: 1,
      payload: "synthetic-test-payload",
    };
    await addJournalRow(retried, journalRecord);
    equal(
      (await readStores(retried, [JOURNAL_STORE]))[JOURNAL_STORE],
      [journalRecord],
      `${name}: retry journal row`,
    );

    return "one test-only opener rejected on native blocked and itself closed the late success result; a fresh retry started before release succeeded, exactly one 1 -> 2 upgrade ran, the late handle was observed closed without closing it, and the retry remained usable";
  } finally {
    // Abandon/dispose any still-pending opens before the blocker is released.
    // Otherwise a late success could outlive the failure and go unobserved.
    opener?.dispose(new Error(`${name}: blocked opener disposed during cleanup`));
    retryAttempt?.abandon(
      new Error(`${name}: retry attempt abandoned during cleanup`),
    );
    retried?.close();
    fixture.db.close();
  }
}

async function disposedPendingOpenerUpgrade(name: string): Promise<string> {
  const fixture = await createSeededV1(name);
  let opener: LateCleaningOpen | undefined;
  let reopened: IDBDatabase | undefined;
  try {
    opener = openRejectingBlockedAndClosingLate(name, V2_VERSION, (event, db) =>
      upgradeToV2(event, db, `${name}: disposed late upgrade`),
    );
    equal(
      opener.request.readyState,
      "pending",
      `${name}: opener must be pending before disposal`,
    );
    // Model a watchdog failure before the specialized opener settles: dispose
    // while the request is still pending and the v1 blocker is held. The native
    // blocked event may not have been dispatched yet.
    opener.dispose(new Error(`${name}: simulated watchdog abandonment`));

    let disposeError: unknown;
    try {
      await withWatchdog(opener.result, `${name}: disposed opener result`);
    } catch (error) {
      disposeError = error;
    }
    assert(
      disposeError instanceof Error &&
        /simulated watchdog abandonment/.test(disposeError.message),
      `${name}: disposed opener did not reject with its reason: ${String(
        disposeError,
      )}`,
    );

    // Release the blocker after disposal. The abandoned upgrade is allowed to
    // finish so its onsuccess can close the late result.
    fixture.db.close();
    await withWatchdog(
      opener.waitLateSuccess(),
      `${name}: disposed late success cleanup`,
    );
    equal(
      opener.lateHandles.length,
      1,
      `${name}: disposed late result count`,
    );
    const lateHandle: IDBDatabase | undefined = opener.lateHandles[0];
    assert(
      lateHandle,
      `${name}: disposed opener did not retain its late result`,
    );
    // The opener closed it; this only observes the closed state.
    assertTransactionFails(lateHandle, `${name}: disposed late handle`);

    const inspection = openDatabase(name, V2_VERSION, (event) => {
      throw new Error(
        `${name}: v2 reopen must not upgrade (old ${event.oldVersion})`,
      );
    });
    reopened = await awaitOpen(inspection, `${name}: v2 reopen`);
    equal(inspection.upgrades, [], `${name}: v2 reopen upgrades`);
    equal(
      opener.upgrades,
      [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
      `${name}: exactly one disposed 1 -> 2 upgrade`,
    );
    equal(reopened.version, V2_VERSION, `${name}: disposed upgrade version`);
    equal(
      readSchema(reopened),
      EXPECTED_V2_SCHEMA,
      `${name}: disposed upgrade schema`,
    );
    equal(
      await readStores(reopened, V1_STORE_NAMES),
      fixture.rows,
      `${name}: disposed upgrade changed v1 rows`,
    );

    // rejectsWithName must close an unexpectedly delivered success handle
    // instead of leaking it.
    let unexpectedError: unknown;
    try {
      await rejectsWithName(
        Promise.resolve(reopened),
        "TimeoutError",
        `${name}: unexpected success`,
      );
    } catch (error) {
      unexpectedError = error;
    }
    assert(
      unexpectedError instanceof Error &&
        /unexpectedly resolved with a database handle/.test(
          unexpectedError.message,
        ),
      `${name}: unexpected success was not reported and closed: ${String(
        unexpectedError,
      )}`,
    );
    assertTransactionFails(reopened, `${name}: unexpected success handle`);

    return "a pending specialized opener was disposed before the blocker was released; its returned promise rejected, the later success was closed by the opener, exactly one 1 -> 2 upgrade ran, and rejectsWithName closed an unexpectedly delivered success handle";
  } finally {
    opener?.dispose(new Error(`${name}: disposed opener cleaned up`));
    reopened?.close();
    fixture.db.close();
  }
}

async function abortedUpgrade(name: string): Promise<string> {
  const fixture = await createSeededV1(name);
  const before = {
    rows: fixture.rows,
    schema: fixture.schema,
  };
  let reopened: IDBDatabase | undefined;
  let retried: IDBDatabase | undefined;
  try {
    fixture.db.close();

    const abortAttempt = openDatabase(name, V2_VERSION, (event, db, request) => {
      upgradeToV2(event, db, `${name}: aborted upgrade`);
      assert(
        request.transaction,
        `${name}: aborted upgrade has no upgrade transaction`,
      );
      request.transaction.abort();
    });
    const abortError = await requireOpenError(
      abortAttempt,
      `${name}: deliberate abort`,
    );
    assert(
      abortError instanceof DOMException && abortError.name === "AbortError",
      `${name}: deliberate abort did not report AbortError: ${String(
        abortError,
      )}`,
    );
    equal(
      abortAttempt.upgrades,
      [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
      `${name}: abort upgrade events`,
    );

    // Reopen v1 and compare the fixture exactly: the aborted upgrade must not
    // leave the journal store or modify any v1 row/index/meta.
    const reopenAttempt = openDatabase(name, V1_VERSION);
    reopened = await awaitOpen(reopenAttempt, `${name}: v1 reopen`);
    equal(reopenAttempt.upgrades, [], `${name}: v1 reopen must not upgrade`);
    equal(reopened.version, V1_VERSION, `${name}: v1 reopen version`);
    assert(
      !reopened.objectStoreNames.contains(JOURNAL_STORE),
      `${name}: aborted upgrade left ${JOURNAL_STORE}`,
    );
    equal(readSchema(reopened), before.schema, `${name}: abort changed schema`);
    equal(
      await readStores(reopened, V1_STORE_NAMES),
      before.rows,
      `${name}: abort changed v1 rows`,
    );
    reopened.close();
    reopened = undefined;

    // Retry the same upgrade; it must now succeed additively.
    const retryAttempt = openDatabase(name, V2_VERSION, (event, db) =>
      upgradeToV2(event, db, `${name}: retry upgrade`),
    );
    retried = await awaitOpen(retryAttempt, `${name}: retry after abort`);
    equal(
      retryAttempt.upgrades,
      [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
      `${name}: retry upgrade events`,
    );
    equal(retried.version, V2_VERSION, `${name}: retry version after abort`);
    equal(readSchema(retried), EXPECTED_V2_SCHEMA, `${name}: retry schema`);
    equal(
      await readStores(retried, V1_STORE_NAMES),
      before.rows,
      `${name}: retry changed v1 rows`,
    );
    equal(
      (await readStores(retried, [JOURNAL_STORE]))[JOURNAL_STORE],
      [],
      `${name}: retry seeded journal rows`,
    );

    return "a deliberate upgrade abort left v1 rows and schema unchanged on reopen, and a retried v2 additive upgrade then succeeded";
  } finally {
    reopened?.close();
    retried?.close();
    fixture.db.close();
  }
}

function requireGuard(): UpgradeGuardState {
  assert(
    guardState,
    "the native boot guard did not install window.__journalGuard before the test bundle ran",
  );
  const guard = guardState;
  equal(guard.mode, "upgrade", "boot guard mode");
  assert(
    guard.allowed instanceof Set,
    "the boot guard did not expose its exact allowlist",
  );
  equal(guard.allowed.size, 4, "boot guard allowlist size");
  equal(guard.dbNames.length, 4, "boot guard fixture name count");
  assert(
    new Set(guard.dbNames).size === 4,
    "the runner generated colliding upgrade fixture names",
  );
  assert(
    !guard.allowed.has(PRODUCTION_DB_NAME),
    "the boot guard allowlist contains the production database name",
  );
  for (const name of guard.dbNames) {
    assert(
      guard.allowed.has(name),
      `${name}: runner fixture name is not allowlisted`,
    );
    assert(
      name !== PRODUCTION_DB_NAME,
      `${name}: runner generated the production database name`,
    );
    assert(
      name.startsWith(TEST_DB_PREFIX),
      `${name}: fixture name does not use the upgrade test prefix`,
    );
  }
  return guard;
}

async function run(): Promise<string[]> {
  const guard = requireGuard();
  equal(guard.openedNames, [], "a database was opened before the test began");
  equal(
    guard.deleteNames,
    [],
    "a database delete was attempted before the test began",
  );
  equal(
    guard.unexpectedOpenAttempts,
    [],
    "an unexpected database open was attempted before the test began",
  );
  assert(
    guard.productionOpenAttempts === 0,
    "the production database was opened before the test began",
  );
  assert(
    guard.networkAttempts === 0,
    "network access was attempted before the test began",
  );

  const [cooperativeName, blockedName, disposedName, abortName] =
    guard.dbNames;
  outcomes.push(await cooperativeUpgrade(cooperativeName));
  outcomes.push(await blockedUpgrade(blockedName));
  outcomes.push(await disposedPendingOpenerUpgrade(disposedName));
  outcomes.push(await abortedUpgrade(abortName));

  equal(
    guard.deleteNames,
    [],
    "the upgrade guard observed a deleteDatabase attempt",
  );
  equal(
    guard.unexpectedOpenAttempts,
    [],
    "an unexpected database open was attempted",
  );
  assert(
    guard.productionOpenAttempts === 0,
    "the production database open was attempted",
  );
  assert(
    guard.networkAttempts === 0,
    `network access was attempted ${guard.networkAttempts} time(s)`,
  );
  assert(
    guard.openedNames.every((name) => guard.allowed.has(name)),
    "a non-allowlisted database open was attempted",
  );
  equal(
    [...new Set(guard.openedNames)].sort(compareNames),
    [...guard.dbNames].sort(compareNames),
    "the guard did not observe exactly the four scenario fixtures",
  );
  outcomes.push(
    "the boot guard observed only the four runtime-unique fixture opens, no deleteDatabase attempt, no production open, and no network attempt",
  );
  return outcomes;
}

run().then(
  (completedOutcomes) => {
    void reportFetch("/result", {
      method: "POST",
      body: JSON.stringify({ ok: true, outcomes: completedOutcomes }),
    });
  },
  (error) => {
    void reportFetch("/result", {
      method: "POST",
      body: JSON.stringify({
        ok: false,
        outcomes,
        error: describeError(error),
      }),
    });
  },
);
