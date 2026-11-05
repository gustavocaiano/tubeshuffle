// TEST-ONLY native IndexedDB lifecycle guard for the inert browser DB
// lifecycle manager. Run with:
//   JOURNAL_GUARD_MODE=lifecycle CHROMIUM_PATH=/path/to/chrome \
//     node tests/browser/run-completion-journal-guard.mjs
//
// This module runs only on the runner's fresh loopback origin and ephemeral
// Chrome profile. The runner generates twenty-eight runtime-unique fixture database
// names with crypto.randomUUID and installs the native boot guard at
// `window.__journalGuard` before this bundle executes. In lifecycle mode the
// guard rejects any open outside that exact allowlist, rejects every
// deleteDatabase call (the whole ephemeral profile is the only cleanup), and
// blocks fetch/XHR/WebSocket/EventSource/beacon traffic.
//
// The manager under test is the real `createBrowserDbLifecycle`, injected with
// a factory that calls the guarded native indexedDB.open. The module itself
// never opens `tubeshuffle_local` or any legacy application database, never
// writes application data, and never changes the application DB_VERSION. The
// v1 schema and rows below are a synthetic model of the current stores, not the
// production upgrade or migration path.
//
// Covered here:
//   1. Concurrent acquisitions share one native request and one handle.
//   2. A terminal native VersionError permits an explicit later retry.
//   3. A genuinely blocked upgrade rejects promptly, acquisitions during drain
//      create no extra request, the late upgrade is aborted before the upgrade
//      callback, and an explicit retry after the terminal event succeeds.
//   4. A synthetic `blocked` event, explicitly injected on a real request, is
//      handled like the native event; the later success is closed rather than
//      published, and a retry succeeds.
//   5. A real external versionchange closes the published handle; an explicitly
//      aborted pre-versionchange transaction emits its native abort event and
//      its queued write is never replayed (not a claim that versionchange
//      aborted the transaction); a native v1 reopen after v2 raises VersionError.
//   6. A real external fixture-driven versionchange is followed by a redirect
//      to a different fresh fixture that simulates oldVersion 0 on the same
//      manager, which aborts and latches storage loss instead of recreating the
//      database. This does not claim a real database was cleared.
//   7. A synthetic deletion-oriented versionchange (newVersion null) is
//      explicitly labelled and latches deletion without deleteDatabase; the
//      same fixture is read independently afterward.
//   8. A synthetic abnormal close event is explicitly labelled and latches
//      uncertainty without a new open; the still-live native handle is closed
//      explicitly and the same fixture is read independently.
//   9. A synchronous reentrant acquire from inside makeRequest joins the one
//      reserved attempt; both acquisitions settle with one native request.
//  10. A late native success after an injected abort failure keeps the handle
//      unpublished and latches indeterminate for later acquisitions.
//  11. An upgrade callback that throws, aborts its transaction, or returns a
//      fulfilled or rejected promise publishes no handle, leaks no raw native
//      message, produces no unhandled rejection, and waits for the native
//      terminal event.
//  12. An existing database observed through a real late success but never
//      published is remembered; a later simulated oldVersion 0 redirect fails
//      closed instead of recreating it.
//  13. Synthetic stale request and old-handle events cannot clear a newer
//      in-flight request or a newer published handle.
//  14. A real v2 fixture opened at v1 reports a fixed VersionError; redirecting
//      the same manager to a different fresh fixture simulates oldVersion 0 and
//      latches storage loss without recreating or opening again.
//  15. An observed existing database followed by a simulated oldVersion 0 with
//      an injected abort failure and a real late success latches indeterminate
//      with precedence over storage loss. No recreate guarantee is claimed.
//  16. A handler-registration failure after the native request was returned
//      latches permanent indeterminate, invokes no upgrade callback, and the
//      manager's emergency upgradeneeded handler aborts the untouched upgrade.
//      The native request then fails with a real AbortError and publishes no
//      handle or store. A later native open still sees oldVersion 0 and is
//      safely seeded with synthetic v1 rows, and the manager stays latched
//      without another request.
//  17. The same injected handler-registration failure on a request to an
//      existing same-version fixture, which has no upgradeneeded event, leaves
//      the late native success handle closed instead of published; an
//      independent read finds the rows unchanged and the manager stays latched.
//  18. A real native abort error event carrying an injected unknown or
//      unreadable error value (explicitly simulated) is reported as
//      indeterminate, not AbortError, and latches without another request.
//  19. A factory error or an injected native error whose private message
//      contains a synthetic absolute path is reported as a fixed transient
//      error; the public name, message, string/JSON serialization, and own
//      properties exclude the path and any production database name.
//
// Every handle published by the manager is explicitly closed by a scenario
// finally block after the manager is no longer used. That close only releases
// the handle; it is not evidence of, and does not synthesize, an abnormal
// close event.
//
// No deleteDatabase is called anywhere in this mode. Synthetic events are
// labelled as such in the outcomes; they are not evidence of a real browser
// deletion or close signal. Redirecting makeRequest to a different fresh
// fixture is a repeated oldVersion 0 simulation, not proof that a real database
// was cleared. Production integration, the production schema and DB_VERSION,
// migration, real tabs, Safari, and user data are not covered. Treat this as
// local Linux Chrome evidence only.
import {
  BrowserDbLifecycleError,
  createBrowserDbLifecycle,
  type BrowserDbLifecycleErrorCategory,
} from "@/lib/storage/browser-db-lifecycle";

// Adapt to the manager's callback return type, which may be refined from
// `void` to an explicit `undefined` contract. Hostile thenable-returning
// callbacks below intentionally cross that type boundary at runtime.
type UpgradeCallback = Parameters<typeof createBrowserDbLifecycle>[1];

const TEST_DB_PREFIX = "tubeshuffle-db-lifecycle-test-";
const PRODUCTION_DB_NAME = "tubeshuffle_local";
const V1_VERSION = 1;
const V2_VERSION = 2;
const WATCHDOG_MS = 10_000;
const EXPECTED_DB_NAME_COUNT = 28;

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

// Test-only model of the production v1 stores. Do not import production
// storage here: this guard must never become a production schema or upgrade
// path.
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

const EXPECTED_V2_SCHEMA: SchemaStore[] = [
  { name: JOURNAL_STORE, keyPath: "key", autoIncrement: false, indexes: [] },
  ...EXPECTED_V1_SCHEMA,
];

interface LifecycleGuardState {
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
  window as unknown as { readonly __journalGuard?: LifecycleGuardState }
).__journalGuard;
// The boot guard replaces window.fetch with a rejecting blocker. The report is
// the only request this module makes, and it uses the pre-block native fetch.
const reportFetch = guardState?.nativeFetch ?? window.fetch.bind(window);
const outcomes: string[] = [];
const firstUpgradeOldVersions = new Map<string, number>();

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

interface TrackedRequest {
  readonly request: IDBOpenDBRequest;
  readonly upgrades: UpgradeObservation[];
  readonly settled: Promise<"success" | "error">;
}

function requireGuard(): LifecycleGuardState {
  assert(
    guardState,
    "the native boot guard did not install window.__journalGuard before the test bundle ran",
  );
  const guard = guardState;
  equal(guard.mode, "lifecycle", "boot guard mode");
  assert(
    guard.allowed instanceof Set,
    "the boot guard did not expose its exact allowlist",
  );
  equal(guard.allowed.size, EXPECTED_DB_NAME_COUNT, "boot guard allowlist size");
  equal(
    guard.dbNames.length,
    EXPECTED_DB_NAME_COUNT,
    "boot guard fixture name count",
  );
  assert(
    new Set(guard.dbNames).size === EXPECTED_DB_NAME_COUNT,
    "the runner generated colliding lifecycle fixture names",
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
      `${name}: fixture name does not use the lifecycle test prefix`,
    );
  }
  return guard;
}

// Wraps one real native request and records its upgrade events plus a terminal
// event barrier. The listener is attached before the lifecycle installs its own
// handlers, so a late event is observed without overriding lifecycle behavior.
// Registers a listener after the lifecycle installed its own handler. Event
// listeners run in registration order, so awaiting this barrier means the
// lifecycle's terminal handling has also run. This is an event barrier, not a
// fixed sleep.
function afterLifecycleHandler(
  request: IDBOpenDBRequest,
  type: "success" | "error",
  label: string,
): Promise<void> {
  const barrier = deferred<void>();
  request.addEventListener(type, () => barrier.resolve(), { once: true });
  return withWatchdog(barrier.promise, label);
}

function trackedOpen(
  guard: LifecycleGuardState,
  name: string,
  version: number | undefined,
): TrackedRequest {
  assert(guard.allowed.has(name), `${name}: test attempted a non-allowlisted open`);
  assert(name !== PRODUCTION_DB_NAME, `${name}: test attempted the production open`);
  const upgrades: UpgradeObservation[] = [];
  const settled = deferred<"success" | "error">();
  const request =
    version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  request.addEventListener("upgradeneeded", (event) => {
    const versionEvent = event as IDBVersionChangeEvent;
    upgrades.push({
      oldVersion: versionEvent.oldVersion,
      newVersion: versionEvent.newVersion,
    });
    if (!firstUpgradeOldVersions.has(name)) {
      firstUpgradeOldVersions.set(name, versionEvent.oldVersion);
    }
  });
  request.addEventListener("success", () => settled.resolve("success"));
  request.addEventListener("error", () => settled.resolve("error"));
  return { request, upgrades, settled: settled.promise };
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

function createJournalStore(db: IDBDatabase): void {
  assert(
    !db.objectStoreNames.contains(JOURNAL_STORE),
    `${db.name}: ${JOURNAL_STORE} already existed before the additive upgrade`,
  );
  db.createObjectStore(JOURNAL_STORE, { keyPath: "key" });
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
        description: "Synthetic lifecycle fixture row",
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

// Seeds rows through the active upgrade transaction, before the manager can
// publish the handle. Every database in this guard is asserted to be fresh at
// oldVersion 0 before this is reached.
function seedRowsInUpgrade(
  request: IDBOpenDBRequest,
  rows: SeedRows,
  label: string,
): void {
  const transaction = request.transaction;
  assert(transaction, `${label}: upgrade has no active transaction`);
  for (const name of V1_STORE_NAMES) {
    const store = transaction.objectStore(name);
    for (const row of rows[name]) {
      store.add(row);
    }
  }
}

function installV1Fixture(
  request: IDBOpenDBRequest,
  event: IDBVersionChangeEvent,
  rows: SeedRows,
  label: string,
): void {
  if (event.oldVersion !== 0 || event.newVersion !== V1_VERSION) {
    throw new Error(
      `${label}: expected fresh v1 creation, got oldVersion ${event.oldVersion} newVersion ${String(
        event.newVersion,
      )}`,
    );
  }
  const db = request.result;
  assert(
    db.objectStoreNames.length === 0,
    `${label}: fresh creation found pre-existing stores`,
  );
  createV1Stores(db);
  seedRowsInUpgrade(request, rows, label);
}

function installV2AdditiveUpgrade(
  request: IDBOpenDBRequest,
  event: IDBVersionChangeEvent,
  label: string,
): void {
  if (event.oldVersion !== V1_VERSION || event.newVersion !== V2_VERSION) {
    throw new Error(
      `${label}: expected 1 -> 2 upgrade, got oldVersion ${event.oldVersion} newVersion ${String(
        event.newVersion,
      )}`,
    );
  }
  createJournalStore(request.result);
}

async function readStores(
  db: IDBDatabase,
  names: readonly string[],
  label: string,
): Promise<Record<string, unknown[]>> {
  const transaction = db.transaction([...names], "readonly");
  const completed = transactionComplete(transaction);
  void completed.catch(() => undefined);
  const requests = names.map(
    (name) => [name, transaction.objectStore(name).getAll()] as const,
  );
  try {
    const values = await withWatchdog(
      Promise.all(requests.map(([, request]) => requestResult(request))),
      `${label}: read request`,
    );
    await withWatchdog(completed, `${label}: transaction`);
    const rows: Record<string, unknown[]> = {};
    names.forEach((name, index) => {
      rows[name] = values[index];
    });
    return rows;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be finished.
    }
    throw error;
  }
}

async function assertV1Rows(
  db: IDBDatabase,
  expected: SeedRows,
  label: string,
): Promise<void> {
  equal(
    await readStores(db, V1_STORE_NAMES, label),
    expected,
    `${label}: v1 rows changed`,
  );
}

function assertClosedHandle(db: IDBDatabase, label: string): void {
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

async function expectRejected(
  operation: Promise<unknown>,
  pattern: RegExp,
  label: string,
): Promise<Error> {
  let failure: unknown;
  let resolved = false;
  try {
    await withWatchdog(operation, label);
    resolved = true;
  } catch (error) {
    failure = error;
  }
  if (resolved) {
    throw new Error(`${label}: expected rejection, but the operation succeeded`);
  }
  assert(
    failure instanceof Error,
    `${label}: expected an Error rejection, got ${String(failure)}`,
  );
  assert(
    pattern.test(failure.message),
    `${label}: unexpected rejection message: ${failure.message}`,
  );
  return failure;
}

function assertSanitized(error: Error, name: string, label: string): void {
  assert(
    !error.message.includes(name),
    `${label}: rejection leaked the fixture database name`,
  );
  assert(
    !error.message.includes(PRODUCTION_DB_NAME),
    `${label}: rejection leaked the production database name`,
  );
}

const LIFECYCLE_CATEGORIES: readonly BrowserDbLifecycleErrorCategory[] = [
  "blocked",
  "VersionError",
  "AbortError",
  "storage-loss",
  "indeterminate",
  "transient",
];

// Public failures must use the lifecycle's own category type and fixed message
// strings. Raw DOMException category names and common native message fragments
// must never appear in the public message.
function assertSafeLifecycleFailure(
  error: unknown,
  allowedCategories: readonly BrowserDbLifecycleErrorCategory[],
  label: string,
  fixtureName: string,
): BrowserDbLifecycleError {
  assert(
    error instanceof BrowserDbLifecycleError,
    `${label}: expected a BrowserDbLifecycleError, got ${String(error)}`,
  );
  assert(
    error.name === "BrowserDbLifecycleError",
    `${label}: unexpected public error name ${error.name}`,
  );
  assert(
    allowedCategories.includes(error.category),
    `${label}: unexpected lifecycle error category ${error.category}`,
  );
  assert(
    LIFECYCLE_CATEGORIES.includes(error.category),
    `${label}: category is outside the fixed lifecycle categories`,
  );
  for (const raw of [
    "VersionError",
    "AbortError",
    "ConstraintError",
    "DataError",
    "InvalidStateError",
    "NotFoundError",
    "QuotaExceededError",
    "TransactionInactiveError",
    "UnknownError",
    "The operation failed",
    "A mutation operation was attempted",
  ]) {
    assert(
      !error.message.includes(raw),
      `${label}: rejection message leaked raw native text: ${raw}`,
    );
  }
  assertSanitized(error, fixtureName, label);
  return error;
}

// Public failures must not carry a caller-supplied identifier or path through
// any commonly inspected surface: name, message, String(error), JSON output,
// or the object's own enumerable/inspectable properties. The synthetic path
// itself is deliberately absolute and clearly fake; no real user path or
// production database name is used.
function assertPublicSurfaceExcludes(
  error: BrowserDbLifecycleError,
  needle: string,
  label: string,
): void {
  const ownProperties = Object.getOwnPropertyNames(error).map((key) => {
    try {
      const value = (error as unknown as Record<string, unknown>)[key];
      return `${key}=${String(value)}`;
    } catch {
      return key;
    }
  });
  const surfaces = [
    error.name,
    error.message,
    String(error),
    JSON.stringify(error),
    JSON.stringify({
      name: error.name,
      category: error.category,
      message: error.message,
    }),
    ownProperties.join("\n"),
  ];
  for (const [index, surface] of surfaces.entries()) {
    assert(
      !surface.includes(needle),
      `${label}: public error surface ${index} leaked the synthetic absolute path`,
    );
    assert(
      !surface.includes(PRODUCTION_DB_NAME),
      `${label}: public error surface ${index} leaked the production database name`,
    );
  }
}

// A failed or aborted native request must not expose a live handle. Accessing
// request.result may itself throw InvalidStateError, which is acceptable; if it
// returns a handle, that handle must be closed.
function assertNoPublishedOpenResult(
  request: IDBOpenDBRequest,
  label: string,
): void {
  let result: IDBDatabase | null = null;
  let failure: unknown;
  try {
    result = request.result ?? null;
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    assert(
      failure instanceof DOMException && failure.name === "InvalidStateError",
      `${label}: unexpected request.result failure: ${String(failure)}`,
    );
    return;
  }
  if (result === null) return;
  assertClosedHandle(result, label);
}

// Flush one task turn so a browser-generated unhandledrejection event, if any,
// has a chance to fire before it is asserted absent. This is a checkpoint, not
// a wait for the behavior under test.
function flushTaskTurn(label: string): Promise<void> {
  return withWatchdog(
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    }),
    label,
  );
}

async function expectOpenError(
  tracked: TrackedRequest,
  label: string,
): Promise<unknown> {
  const outcome = await withWatchdog(tracked.settled, label);
  if (outcome === "success") {
    try {
      tracked.request.result.close();
    } catch {
      // The result may already be closed.
    }
    throw new Error(`${label}: expected an open error, got success`);
  }
  return tracked.request.error ?? new Error(`${label}: open failed without an error`);
}

interface NativeFixture {
  readonly db: IDBDatabase;
  readonly rows: SeedRows;
  readonly schema: SchemaStore[];
}

// Creates one fresh synthetic fixture through a tracked native request. The
// onupgradeneeded handler rejects any non-zero oldVersion before creating a
// store or adding a row.
function createNativeFixture(
  guard: LifecycleGuardState,
  name: string,
  version: number,
  rows: SeedRows,
): Promise<NativeFixture> {
  const tracked = trackedOpen(guard, name, version);
  let settled = false;
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    tracked.request.onupgradeneeded = (event) => {
      try {
        const versionEvent = event as IDBVersionChangeEvent;
        if (versionEvent.oldVersion !== 0) {
          throw new Error(
            `${name}: expected fresh oldVersion 0, got ${versionEvent.oldVersion}`,
          );
        }
        if (versionEvent.newVersion !== version) {
          throw new Error(
            `${name}: expected newVersion ${version}, got ${String(
              versionEvent.newVersion,
            )}`,
          );
        }
        const db = tracked.request.result;
        assert(
          db.objectStoreNames.length === 0,
          `${name}: fresh creation found pre-existing stores`,
        );
        createV1Stores(db);
        if (version === V2_VERSION) createJournalStore(db);
        seedRowsInUpgrade(tracked.request, rows, `${name}: fresh v${version}`);
      } catch (error) {
        try {
          tracked.request.transaction?.abort();
        } catch {
          // The upgrade transaction may already be inactive.
        }
        fail(error);
      }
    };
    tracked.request.onblocked = () => fail(new Error(`${name}: fixture open blocked`));
    tracked.request.onerror = () =>
      fail(
        tracked.request.error ?? new Error(`${name}: fixture open request failed`),
      );
    tracked.request.onsuccess = () => {
      if (settled) {
        tracked.request.result.close();
        return;
      }
      const db = tracked.request.result;
      try {
        equal(
          tracked.upgrades,
          [{ oldVersion: 0, newVersion: version }],
          `${name}: fresh upgrade events`,
        );
        equal(db.version, version, `${name}: fixture version`);
        equal(
          readSchema(db),
          version === V2_VERSION ? EXPECTED_V2_SCHEMA : EXPECTED_V1_SCHEMA,
          `${name}: fixture schema`,
        );
        settled = true;
        resolve({ db, rows, schema: readSchema(db) });
      } catch (error) {
        db.close();
        fail(error);
      }
    };
  });
}

// Opens an existing fixture at the given version without allowing an upgrade.
async function openExisting(
  guard: LifecycleGuardState,
  name: string,
  version: number,
): Promise<IDBDatabase> {
  const tracked = trackedOpen(guard, name, version);
  let settled = false;
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    tracked.request.onupgradeneeded = () => {
      try {
        tracked.request.transaction?.abort();
      } catch {
        // The upgrade transaction may already be inactive.
      }
      fail(new Error(`${name}: expected an existing v${version} database, got an upgrade`));
    };
    tracked.request.onblocked = () => fail(new Error(`${name}: existing open blocked`));
    tracked.request.onerror = () =>
      fail(
        tracked.request.error ?? new Error(`${name}: existing open request failed`),
      );
    tracked.request.onsuccess = () => {
      if (settled) {
        tracked.request.result.close();
        return;
      }
      try {
        equal(tracked.upgrades, [], `${name}: existing open upgraded`);
        settled = true;
        resolve(tracked.request.result);
      } catch (error) {
        tracked.request.result.close();
        fail(error);
      }
    };
  });
}

// Real external 1 -> 2 upgrade used for versionchange scenarios. This is a test
// fixture connection, not the manager and not an application upgrade path.
async function upgradeExistingToV2(
  guard: LifecycleGuardState,
  name: string,
): Promise<IDBDatabase> {
  const tracked = trackedOpen(guard, name, V2_VERSION);
  let settled = false;
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    tracked.request.onupgradeneeded = (event) => {
      try {
        const versionEvent = event as IDBVersionChangeEvent;
        equal(
          {
            oldVersion: versionEvent.oldVersion,
            newVersion: versionEvent.newVersion,
          },
          { oldVersion: V1_VERSION, newVersion: V2_VERSION },
          `${name}: external upgrade event`,
        );
        createJournalStore(tracked.request.result);
      } catch (error) {
        try {
          tracked.request.transaction?.abort();
        } catch {
          // The upgrade transaction may already be inactive.
        }
        fail(error);
      }
    };
    tracked.request.onblocked = () =>
      fail(new Error(`${name}: external v2 open blocked`));
    tracked.request.onerror = () =>
      fail(
        tracked.request.error ?? new Error(`${name}: external v2 open failed`),
      );
    tracked.request.onsuccess = () => {
      if (settled) {
        tracked.request.result.close();
        return;
      }
      settled = true;
      resolve(tracked.request.result);
    };
  });
}

interface ManagerHarness {
  readonly manager: ReturnType<typeof createBrowserDbLifecycle>;
  readonly requestCount: () => number;
  readonly lastRequest: () => TrackedRequest;
}

function createHarness(
  guard: LifecycleGuardState,
  makeSpec: () => { name: string; version: number },
  onUpgrade: (
    request: IDBOpenDBRequest,
    event: IDBVersionChangeEvent,
  ) => unknown,
): ManagerHarness {
  let requests = 0;
  let last: TrackedRequest | undefined;
  const manager = createBrowserDbLifecycle(
    () => {
      requests += 1;
      const spec = makeSpec();
      last = trackedOpen(guard, spec.name, spec.version);
      return last.request;
    },
    onUpgrade as unknown as UpgradeCallback,
  );
  return {
    manager,
    requestCount: () => requests,
    lastRequest: () => {
      assert(last, "the lifecycle did not create a native open request");
      return last;
    },
  };
}

// Every handle published by the manager under test is registered here and
// explicitly closed in the scenario's finally block once the manager is no
// longer used, including when an assertion fails mid-scenario. Calling close()
// here only releases the handle; it is not treated as evidence of, and does not
// synthesize, an abnormal close event. The abnormal-close scenario still uses
// its separately labelled synthetic event.
const managerPublishedHandles = new Set<IDBDatabase>();

function registerPublishedHandle(db: IDBDatabase): IDBDatabase {
  managerPublishedHandles.add(db);
  return db;
}

function closeManagerPublishedHandles(label: string): void {
  const handles = [...managerPublishedHandles];
  managerPublishedHandles.clear();
  for (const db of handles) {
    try {
      db.close();
    } catch {
      // close() is best effort, but the handle was still explicitly released.
    }
    assertClosedHandle(db, `${label}: manager-published handle cleanup`);
  }
}

async function runScenario(
  outcomes: string[],
  label: string,
  operation: () => Promise<string>,
): Promise<void> {
  try {
    outcomes.push(await operation());
  } finally {
    closeManagerPublishedHandles(label);
  }
}

async function concurrentAcquisition(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(name);
  const harness = createHarness(
    guard,
    () => ({ name, version: V1_VERSION }),
    (request, event) => installV1Fixture(request, event, rows, `${name}: v1 creation`),
  );
  const first = harness.manager.acquire();
  const second = harness.manager.acquire();
  equal(
    harness.requestCount(),
    1,
    `${name}: concurrent acquisitions created more than one native request`,
  );
  const [dbA, dbB] = await withWatchdog(
    Promise.all([first, second]),
    `${name}: concurrent acquisitions`,
  );
  registerPublishedHandle(dbA);
  assert(dbA === dbB, `${name}: concurrent acquisitions returned different handles`);
  assert(harness.manager.isCurrent(dbA), `${name}: acquired handle is not current`);
  equal(harness.requestCount(), 1, `${name}: request count after concurrent settle`);
  const cached = await harness.manager.acquire();
  assert(cached === dbA, `${name}: cached acquisition returned a different handle`);
  equal(harness.requestCount(), 1, `${name}: cached acquisition created a request`);
  equal(
    harness.lastRequest().upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${name}: concurrent creation upgrades`,
  );
  equal(readSchema(dbA), EXPECTED_V1_SCHEMA, `${name}: concurrent fixture schema`);
  await assertV1Rows(dbA, rows, `${name}: concurrent fixture`);
  return "two concurrent acquisitions shared one native request and one handle; the cached acquisition created no further request";
}

async function terminalFailureThenRetry(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V2_VERSION,
    syntheticRows(name),
  );
  fixture.db.close();
  let version = V1_VERSION;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name, version }),
    () => {
      upgradeCalls += 1;
      throw new Error("the existing v2 fixture must not upgrade");
    },
  );

  const failure = await expectRejected(
    harness.manager.acquire(),
    /outdated/i,
    `${name}: terminal native failure`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["VersionError"],
    `${name}: terminal native failure`,
    name,
  );
  equal(harness.requestCount(), 1, `${name}: terminal failure request count`);
  const failedRequest = harness.lastRequest();
  const requestError = await expectOpenError(failedRequest, `${name}: failed request`);
  assert(
    requestError instanceof DOMException && requestError.name === "VersionError",
    `${name}: expected native VersionError, got ${String(requestError)}`,
  );
  equal(upgradeCalls, 0, `${name}: failed v1 request ran the upgrade callback`);

  const inspection = await openExisting(guard, name, V2_VERSION);
  equal(readSchema(inspection), EXPECTED_V2_SCHEMA, `${name}: fixture schema after failure`);
  await assertV1Rows(inspection, fixture.rows, `${name}: fixture after failure`);
  equal(
    (await readStores(inspection, [JOURNAL_STORE], `${name}: failed retry journal`))[
      JOURNAL_STORE
    ],
    [],
    `${name}: failed retry seeded journal rows`,
  );
  inspection.close();

  version = V2_VERSION;
  const retried = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(retried), `${name}: retried handle is not current`);
  equal(harness.requestCount(), 2, `${name}: retry request count`);
  equal(upgradeCalls, 0, `${name}: retry ran an unexpected upgrade callback`);
  equal(readSchema(retried), EXPECTED_V2_SCHEMA, `${name}: retry schema`);
  await assertV1Rows(retried, fixture.rows, `${name}: retry fixture`);
  return "a native VersionError was a terminal failure; the same manager accepted an explicit later retry without upgrading or changing rows";
}

async function blockedDrainLateAbortThenRetry(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  let blockerVersionChanges = 0;
  // Actual blocker: the v1 connection stays open and the versionchange handler
  // deliberately does not close it.
  fixture.db.onversionchange = () => {
    blockerVersionChanges += 1;
  };
  let allowUpgrade = false;
  let upgradeCalls = 0;
  const upgradeEvents: UpgradeObservation[] = [];
  const harness = createHarness(
    guard,
    () => ({ name, version: V2_VERSION }),
    (request, event) => {
      upgradeCalls += 1;
      upgradeEvents.push({
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
      });
      if (!allowUpgrade) {
        throw new Error(`${name}: a drained late upgrade reached the callback`);
      }
      installV2AdditiveUpgrade(request, event, `${name}: retried upgrade`);
    },
  );

  const blockedAcquisition = harness.manager.acquire();
  const lateHandled = afterLifecycleHandler(
    harness.lastRequest().request,
    "error",
    `${name}: late lifecycle error handling`,
  );
  const blockedFailure = await expectRejected(
    blockedAcquisition,
    /blocked by another connection/i,
    `${name}: native blocked rejection`,
  );
  assertSafeLifecycleFailure(
    blockedFailure,
    ["blocked"],
    `${name}: native blocked rejection`,
    name,
  );
  equal(harness.requestCount(), 1, `${name}: blocked request count`);
  equal(
    harness.lastRequest().request.readyState,
    "pending",
    `${name}: blocked native request must remain pending`,
  );
  equal(blockerVersionChanges, 1, `${name}: blocker versionchange count`);

  const drainFailure = await expectRejected(
    harness.manager.acquire(),
    /draining after a blocked request/i,
    `${name}: acquisition while draining`,
  );
  assertSafeLifecycleFailure(
    drainFailure,
    ["blocked"],
    `${name}: acquisition while draining`,
    name,
  );

  // Start several acquisitions while the real request is draining. They must
  // all reject without starting an open storm.
  const drainStorm = await withWatchdog(
    Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        expectRejected(
          harness.manager.acquire(),
          /draining after a blocked request/i,
          `${name}: drain acquisition ${index}`,
        ),
      ),
    ),
    `${name}: drain acquisition storm`,
  );
  equal(drainStorm.length, 8, `${name}: drain acquisition storm did not settle`);
  for (const [index, error] of drainStorm.entries()) {
    assertSafeLifecycleFailure(
      error,
      ["blocked"],
      `${name}: drain acquisition ${index}`,
      name,
    );
  }
  equal(
    harness.requestCount(),
    1,
    `${name}: acquisitions while draining created another request`,
  );

  // Release the real blocker. The late upgrade must be aborted before the
  // manager invokes the upgrade callback.
  fixture.db.close();
  const lateOutcome = await withWatchdog(
    harness.lastRequest().settled,
    `${name}: late request settlement`,
  );
  await lateHandled;
  equal(lateOutcome, "error", `${name}: late request outcome`);
  equal(upgradeCalls, 0, `${name}: late upgrade reached the callback`);
  equal(
    harness.lastRequest().upgrades,
    [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
    `${name}: late upgrade events`,
  );
  const lateError = harness.lastRequest().request.error;
  assert(
    lateError instanceof DOMException && lateError.name === "AbortError",
    `${name}: late upgrade was not aborted: ${String(lateError)}`,
  );

  const reopenedV1 = await openExisting(guard, name, V1_VERSION);
  equal(reopenedV1.version, V1_VERSION, `${name}: late abort version`);
  equal(readSchema(reopenedV1), EXPECTED_V1_SCHEMA, `${name}: late abort schema`);
  await assertV1Rows(reopenedV1, fixture.rows, `${name}: late abort fixture`);
  reopenedV1.close();

  // Only an explicit acquisition after the terminal event starts a new request.
  allowUpgrade = true;
  const retried = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(retried), `${name}: retried handle is not current`);
  equal(harness.requestCount(), 2, `${name}: retry request count`);
  equal(upgradeCalls, 1, `${name}: retry upgrade callback count`);
  equal(
    upgradeEvents,
    [{ oldVersion: V1_VERSION, newVersion: V2_VERSION }],
    `${name}: retry upgrade events`,
  );
  equal(readSchema(retried), EXPECTED_V2_SCHEMA, `${name}: retry schema`);
  await assertV1Rows(retried, fixture.rows, `${name}: retry fixture`);
  equal(
    (await readStores(retried, [JOURNAL_STORE], `${name}: retry journal`))[
      JOURNAL_STORE
    ],
    [],
    `${name}: retry seeded journal rows`,
  );
  return "a genuinely blocked v2 open rejected promptly; eight concurrent acquisitions during drain also rejected and created no additional request; the late 1 -> 2 upgrade was aborted before the callback; an explicit retry after the terminal event succeeded with unchanged rows";
}

async function syntheticBlockedLateSuccess(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  fixture.db.close();
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name, version: V1_VERSION }),
    () => {
      upgradeCalls += 1;
      throw new Error("the same-version fixture must not upgrade");
    },
  );

  const acquisition = harness.manager.acquire();
  const blockedRequest = harness.lastRequest();
  const lateHandled = afterLifecycleHandler(
    blockedRequest.request,
    "success",
    `${name}: late lifecycle success handling`,
  );
  equal(
    blockedRequest.request.readyState,
    "pending",
    `${name}: request must still be pending for synthetic blocked`,
  );
  // The event is synthetic and explicitly labelled as such. It is dispatched on
  // the real native request so the lifecycle's real handler observes it.
  const dispatched = blockedRequest.request.dispatchEvent(new Event("blocked"));
  assert(dispatched, `${name}: synthetic blocked event was canceled`);
  const blockedFailure = await expectRejected(
    acquisition,
    /blocked by another connection/i,
    `${name}: synthetic blocked rejection`,
  );
  assertSafeLifecycleFailure(
    blockedFailure,
    ["blocked"],
    `${name}: synthetic blocked rejection`,
    name,
  );
  equal(harness.requestCount(), 1, `${name}: synthetic blocked request count`);

  const lateOutcome = await withWatchdog(
    blockedRequest.settled,
    `${name}: late success settlement`,
  );
  await lateHandled;
  equal(lateOutcome, "success", `${name}: synthetic blocked late outcome`);
  const lateHandle = blockedRequest.request.result;
  assertClosedHandle(lateHandle, `${name}: late success handle`);
  equal(upgradeCalls, 0, `${name}: synthetic blocked late success ran an upgrade`);

  const retried = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(retried), `${name}: retried handle is not current`);
  equal(harness.requestCount(), 2, `${name}: retry after synthetic blocked`);
  await assertV1Rows(retried, fixture.rows, `${name}: synthetic blocked retry fixture`);
  return "a synthetic blocked event, explicitly injected on a real request, rejected the acquisition; the late success was closed instead of published; the same manager retried successfully";
}

async function versionChangeAndVersionError(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  let version = V1_VERSION;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name, version }),
    () => {
      upgradeCalls += 1;
      throw new Error("the versionchange scenario must not run a manager upgrade");
    },
  );

  const db = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(db), `${name}: handle is not current before versionchange`);
  await assertV1Rows(db, fixture.rows, `${name}: pre-versionchange fixture`);
  // The native fixture connection must not remain as a second blocker; only
  // the manager's published handle should be open when the external upgrade
  // requests versionchange.
  fixture.db.close();

  // This transaction is explicitly aborted before the external versionchange
  // request. The narrow claim is that an already-aborted queued write is never
  // replayed by the lifecycle; this test does not claim versionchange aborted
  // the transaction. Require the real native abort event, not any rejection.
  const markerKey = `aborted-marker-${crypto.randomUUID()}`;
  const transaction = db.transaction(STORE_META, "readwrite");
  const abortEvent = deferred<Event>();
  transaction.addEventListener(
    "abort",
    (event) => abortEvent.resolve(event),
    { once: true },
  );
  const markerRequest = transaction
    .objectStore(STORE_META)
    .put({ key: markerKey, value: "must-not-be-replayed" });
  void requestResult(markerRequest).catch(() => undefined);
  transaction.abort();
  const observedAbort = await withWatchdog(
    abortEvent.promise,
    `${name}: explicit transaction abort event`,
  );
  equal(observedAbort.type, "abort", `${name}: transaction abort event type`);
  await assertV1Rows(db, fixture.rows, `${name}: after aborted transaction`);

  // A real external fixture upgrade invalidates and closes the published
  // handle through the native versionchange event.
  const external = await upgradeExistingToV2(guard, name);
  assert(
    !harness.manager.isCurrent(db),
    `${name}: versionchange did not invalidate the old handle`,
  );
  assertClosedHandle(db, `${name}: versionchange handle`);
  equal(readSchema(external), EXPECTED_V2_SCHEMA, `${name}: external v2 schema`);
  await assertV1Rows(external, fixture.rows, `${name}: external v2 fixture`);
  external.close();

  // A native v1 reopen after v2 must raise VersionError without an upgrade.
  const v1Attempt = trackedOpen(guard, name, V1_VERSION);
  const v1Error = await expectOpenError(v1Attempt, `${name}: native v1 reopen`);
  assert(
    v1Error instanceof DOMException && v1Error.name === "VersionError",
    `${name}: native v1 reopen did not report VersionError: ${String(v1Error)}`,
  );
  equal(v1Attempt.upgrades, [], `${name}: native v1 reopen upgraded`);

  // The manager's own v1 retry is a terminal failure; it does not hide the
  // lower-version request behind the cache.
  const lowerFailure = await expectRejected(
    harness.manager.acquire(),
    /outdated/i,
    `${name}: manager v1 retry`,
  );
  assertSafeLifecycleFailure(
    lowerFailure,
    ["VersionError"],
    `${name}: manager v1 retry`,
    name,
  );
  equal(harness.requestCount(), 2, `${name}: manager v1 retry request count`);
  const lowerRequestError = await expectOpenError(
    harness.lastRequest(),
    `${name}: manager v1 retry request`,
  );
  assert(
    lowerRequestError instanceof DOMException &&
      lowerRequestError.name === "VersionError",
    `${name}: manager v1 retry did not report VersionError: ${String(
      lowerRequestError,
    )}`,
  );

  version = V2_VERSION;
  const retried = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(retried), `${name}: v2 retry handle is not current`);
  equal(harness.requestCount(), 3, `${name}: v2 retry request count`);
  equal(upgradeCalls, 0, `${name}: v2 retry ran an upgrade callback`);
  equal(readSchema(retried), EXPECTED_V2_SCHEMA, `${name}: v2 retry schema`);
  await assertV1Rows(retried, fixture.rows, `${name}: v2 retry fixture`);
  equal(
    (await readStores(retried, [STORE_META], `${name}: replayed marker check`))[
      STORE_META
    ],
    fixture.rows[STORE_META],
    `${name}: an aborted pre-versionchange write was replayed`,
  );
  equal(
    (await readStores(retried, [JOURNAL_STORE], `${name}: v2 retry journal`))[
      JOURNAL_STORE
    ],
    [],
    `${name}: v2 retry seeded journal rows`,
  );
  return "a real external versionchange invalidated and closed the old handle; an explicitly aborted pre-versionchange transaction emitted its native abort event and its queued write was not replayed (this is not a claim that versionchange aborted the transaction); a native v1 reopen after v2 raised VersionError; the same manager then retried at v2 successfully";
}

async function externalVersionChangeThenFreshZero(
  guard: LifecycleGuardState,
  firstName: string,
  freshName: string,
): Promise<string> {
  const rows = syntheticRows(firstName);
  let targetName = firstName;
  let upgradeCalls = 0;
  let freshUpgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name: targetName, version: V1_VERSION }),
    (request, event) => {
      if (targetName === freshName) {
        freshUpgradeCalls += 1;
        throw new Error(`${freshName}: fresh oldVersion 0 must not create fixtures`);
      }
      upgradeCalls += 1;
      installV1Fixture(request, event, rows, `${firstName}: v1 creation`);
    },
  );

  const db = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(db), `${firstName}: handle is not current`);
  await assertV1Rows(db, rows, `${firstName}: initial fixture`);

  const external = await upgradeExistingToV2(guard, firstName);
  assert(
    !harness.manager.isCurrent(db),
    `${firstName}: external versionchange did not invalidate the handle`,
  );
  assertClosedHandle(db, `${firstName}: external versionchange handle`);
  await assertV1Rows(external, rows, `${firstName}: external v2 fixture`);
  external.close();

  // Same manager, now redirected to a different runtime-unique fixture that is
  // genuinely fresh. This is a simulated oldVersion 0, not evidence of a real
  // external clear. The manager must still fail closed after its earlier
  // successful publish rather than recreate a schema.
  targetName = freshName;
  const lossFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: simulated oldVersion 0 after prior publish`,
  );
  assertSafeLifecycleFailure(
    lossFailure,
    ["storage-loss"],
    `${freshName}: simulated oldVersion 0 after prior publish`,
    freshName,
  );
  equal(upgradeCalls, 1, `${firstName}: initial upgrade callback count`);
  equal(freshUpgradeCalls, 0, `${freshName}: fresh oldVersion 0 reached the callback`);
  equal(harness.requestCount(), 2, `${freshName}: fresh zero request count`);
  const freshRequest = harness.lastRequest();
  equal(
    freshRequest.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${freshName}: fresh zero upgrade events`,
  );
  const freshRequestError = await expectOpenError(
    freshRequest,
    `${freshName}: fresh zero request`,
  );
  assert(
    freshRequestError instanceof DOMException &&
      freshRequestError.name === "AbortError",
    `${freshName}: fresh zero request was not aborted: ${String(freshRequestError)}`,
  );

  const requestCountAfterLoss = harness.requestCount();
  const latchedFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: latched storage loss`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["storage-loss"],
    `${freshName}: latched storage loss`,
    freshName,
  );
  equal(
    harness.requestCount(),
    requestCountAfterLoss,
    `${freshName}: latched storage loss created another request`,
  );
  return "a real external fixture-driven versionchange closed the published handle; the same manager then aborted a simulated oldVersion 0 (a redirected fresh fixture, not a real external clearing) and latched storage loss without recreating it or making another request";
}

async function simulatedDeletionVersionChange(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(name);
  const harness = createHarness(
    guard,
    () => ({ name, version: V1_VERSION }),
    (request, event) => installV1Fixture(request, event, rows, `${name}: v1 creation`),
  );
  const db = registerPublishedHandle(await harness.manager.acquire());
  await assertV1Rows(db, rows, `${name}: pre-deletion fixture`);

  // No deleteDatabase is allowed in lifecycle mode. This synthetic event is
  // explicitly labelled; it models the signal a real deletion would deliver.
  const deletion = new IDBVersionChangeEvent("versionchange", {
    oldVersion: V1_VERSION,
    newVersion: null,
  });
  assert(
    db.dispatchEvent(deletion),
    `${name}: synthetic deletion versionchange was canceled`,
  );
  assert(
    !harness.manager.isCurrent(db),
    `${name}: synthetic deletion did not invalidate the handle`,
  );
  assertClosedHandle(db, `${name}: synthetic deletion handle`);

  const requestCountAfterDeletion = harness.requestCount();
  const failure = await expectRejected(
    harness.manager.acquire(),
    /deleted by another connection|requested deletion/i,
    `${name}: deletion latch`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["storage-loss"],
    `${name}: deletion latch`,
    name,
  );
  equal(
    harness.requestCount(),
    requestCountAfterDeletion,
    `${name}: deletion latch created another request`,
  );

  // No deleteDatabase was called, so the fixture should still hold its rows.
  // Read it through an independent connection and close that connection.
  const inspection = await openExisting(guard, name, V1_VERSION);
  equal(readSchema(inspection), EXPECTED_V1_SCHEMA, `${name}: post-deletion schema`);
  await assertV1Rows(inspection, rows, `${name}: independent post-deletion read`);
  inspection.close();
  return "a synthetic delete-like versionchange event (newVersion null, explicitly labelled synthetic) invalidated and closed the handle and latched deletion; no deleteDatabase was called, no request was recreated, and an independent connection read the same fixture rows back and closed";
}

async function simulatedAbnormalClose(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(name);
  const harness = createHarness(
    guard,
    () => ({ name, version: V1_VERSION }),
    (request, event) => installV1Fixture(request, event, rows, `${name}: v1 creation`),
  );
  const db = registerPublishedHandle(await harness.manager.acquire());
  await assertV1Rows(db, rows, `${name}: pre-close fixture`);

  // A synthetic close event is explicitly labelled. It does not actually close
  // the native connection; only the lifecycle's conservative latch is tested.
  assert(
    db.dispatchEvent(new Event("close")),
    `${name}: synthetic close event was canceled`,
  );
  assert(
    !harness.manager.isCurrent(db),
    `${name}: synthetic abnormal close did not invalidate the handle`,
  );

  const requestCountAfterClose = harness.requestCount();
  const failure = await expectRejected(
    harness.manager.acquire(),
    /closed unexpectedly/i,
    `${name}: abnormal close latch`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["indeterminate"],
    `${name}: abnormal close latch`,
    name,
  );
  equal(
    harness.requestCount(),
    requestCountAfterClose,
    `${name}: abnormal close latch created another request`,
  );

  // The synthetic close event did not actually close the native connection.
  // Read the same fixture through an independent connection, then close both
  // that connection and the still-live manager handle explicitly.
  const inspection = await openExisting(guard, name, V1_VERSION);
  equal(readSchema(inspection), EXPECTED_V1_SCHEMA, `${name}: post-close schema`);
  await assertV1Rows(inspection, rows, `${name}: independent post-close read`);
  inspection.close();
  db.close();
  assertClosedHandle(db, `${name}: explicitly closed still-live handle`);
  return "a synthetic abnormal close event (explicitly labelled synthetic) latched uncertainty without a new open and was not evidence of a real browser close signal; an independent connection read the same fixture rows, and the still-live native handle was closed explicitly";
}

async function reentrantMakeRequest(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(name);
  let requestCount = 0;
  let reentryIssued = false;
  let reentrantAcquisition: Promise<IDBDatabase> | undefined;
  let lastRequest: TrackedRequest | undefined;
  const manager = createBrowserDbLifecycle(
    () => {
      requestCount += 1;
      if (!reentryIssued) {
        reentryIssued = true;
        // Runs while the outer attempt has reserved its promise but has not yet
        // received this native request.
        reentrantAcquisition = manager.acquire();
      }
      lastRequest = trackedOpen(guard, name, V1_VERSION);
      return lastRequest.request;
    },
    ((
      request: IDBOpenDBRequest,
      event: IDBVersionChangeEvent,
    ) =>
      installV1Fixture(
        request,
        event,
        rows,
        `${name}: reentrant creation`,
      )) as unknown as UpgradeCallback,
  );

  const outer = manager.acquire();
  assert(
    reentrantAcquisition,
    `${name}: synchronous makeRequest reentry did not call acquire`,
  );
  equal(requestCount, 1, `${name}: reentrant makeRequest created extra requests`);
  const inner = reentrantAcquisition;
  const [outerDb, innerDb] = await withWatchdog(
    Promise.all([outer, inner]),
    `${name}: reentrant acquisitions`,
  );
  registerPublishedHandle(outerDb);
  assert(
    outerDb === innerDb,
    `${name}: reentrant acquisitions returned different handles`,
  );
  assert(manager.isCurrent(outerDb), `${name}: reentrant handle is not current`);
  equal(requestCount, 1, `${name}: reentrant request count after settlement`);
  assert(lastRequest, `${name}: reentrant attempt did not create a tracked request`);
  equal(
    lastRequest.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${name}: reentrant creation upgrades`,
  );
  equal(readSchema(outerDb), EXPECTED_V1_SCHEMA, `${name}: reentrant schema`);
  await assertV1Rows(outerDb, rows, `${name}: reentrant fixture`);
  return "a synchronous acquire called from inside makeRequest joined the reserved attempt; one native request settled both acquisitions with the same current handle";
}

async function indeterminateAbortFailure(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name, version: V1_VERSION }),
    () => {
      upgradeCalls += 1;
      throw new Error(`${name}: a drained late upgrade reached the callback`);
    },
  );

  const acquisition = harness.manager.acquire();
  const tracked = harness.lastRequest();
  try {
    // Fault injection on a real request: abortUpgrade() reads this accessor and
    // fails, so the native upgrade transaction is never aborted.
    Object.defineProperty(tracked.request, "transaction", {
      configurable: true,
      get() {
        throw new Error(`${name}: injected transaction abort fault`);
      },
    });
  } catch (error) {
    throw new Error(
      `${name}: could not inject the transaction abort fault: ${String(error)}`,
    );
  }

  const successHandled = afterLifecycleHandler(
    tracked.request,
    "success",
    `${name}: late success handling`,
  );
  // This blocked event is synthetic and explicitly labelled. It is dispatched
  // on the real native request, whose later success is also real.
  assert(
    tracked.request.dispatchEvent(new Event("blocked")),
    `${name}: synthetic blocked event was canceled`,
  );
  const blockedFailure = await expectRejected(
    acquisition,
    /blocked by another connection/i,
    `${name}: blocked before abort fault`,
  );
  assertSafeLifecycleFailure(
    blockedFailure,
    ["blocked"],
    `${name}: blocked before abort fault`,
    name,
  );
  equal(harness.requestCount(), 1, `${name}: abort-fault request count`);

  const lateOutcome = await withWatchdog(
    tracked.settled,
    `${name}: late success after abort fault`,
  );
  await successHandled;
  equal(lateOutcome, "success", `${name}: abort-fault late outcome`);
  equal(upgradeCalls, 0, `${name}: abort-fault late upgrade callback`);
  assertClosedHandle(
    tracked.request.result,
    `${name}: late success after failed abort`,
  );

  const requestCountAfterLate = harness.requestCount();
  const latchedFailure = await expectRejected(
    harness.manager.acquire(),
    /abort could not be confirmed|indeterminate/i,
    `${name}: indeterminate latch`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["indeterminate"],
    `${name}: indeterminate latch`,
    name,
  );
  equal(
    harness.requestCount(),
    requestCountAfterLate,
    `${name}: indeterminate latch created another request`,
  );
  return "an injected abort-accessor fault on a real request was followed by a real late success; the handle stayed unpublished and the manager latched indeterminate, rejecting later acquisitions without another request";
}

type UpgradeCallbackFault = "throw" | "abort" | "fulfilled" | "rejected";

async function upgradeCallbackFailure(
  guard: LifecycleGuardState,
  name: string,
  fault: UpgradeCallbackFault,
): Promise<string> {
  const rows = syntheticRows(name);
  const marker = `synthetic-upgrade-callback-${fault}-${crypto.randomUUID()}`;
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent): void => {
    if (String(event.reason).includes(marker)) unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  try {
    let upgradeCalls = 0;
    const harness = createHarness(
      guard,
      () => ({ name, version: V1_VERSION }),
      (request, event) => {
        upgradeCalls += 1;
        installV1Fixture(request, event, rows, `${name}: ${fault} upgrade`);
        switch (fault) {
          case "throw":
            throw new Error(`${marker}: upgrade callback threw`);
          case "abort":
            request.transaction?.abort();
            return;
          case "fulfilled":
            return Promise.resolve();
          case "rejected":
            return Promise.reject(new Error(`${marker}: upgrade callback rejected`));
        }
      },
    );

    const acquisition = harness.manager.acquire();
    const tracked = harness.lastRequest();
    const failure = await expectRejected(
      acquisition,
      /failed or was aborted|abort could not be confirmed/i,
      `${name}: ${fault} upgrade callback`,
    );
    assertSafeLifecycleFailure(
      failure,
      ["AbortError"],
      `${name}: ${fault} upgrade callback`,
      name,
    );
    assert(
      !failure.message.includes(marker),
      `${name}: ${fault} upgrade callback leaked the synthetic marker`,
    );
    equal(upgradeCalls, 1, `${name}: ${fault} upgrade callback count`);
    equal(harness.requestCount(), 1, `${name}: ${fault} request count`);
    equal(
      await withWatchdog(
        tracked.settled,
        `${name}: ${fault} native terminal event`,
      ),
      "error",
      `${name}: ${fault} native terminal outcome`,
    );
    const requestError = tracked.request.error;
    assert(
      requestError instanceof DOMException && requestError.name === "AbortError",
      `${name}: ${fault} request was not natively aborted: ${String(requestError)}`,
    );
    assertNoPublishedOpenResult(
      tracked.request,
      `${name}: ${fault} published result`,
    );
    await flushTaskTurn(`${name}: ${fault} unhandled rejection checkpoint`);
    equal(
      unhandled,
      [],
      `${name}: ${fault} upgrade callback produced an unhandled rejection`,
    );
    const behavior: Record<UpgradeCallbackFault, string> = {
      throw: "threw",
      abort: "aborted its transaction",
      fulfilled: "returned a fulfilled promise",
      rejected: "returned a rejected promise",
    };
    return `an upgrade callback that ${behavior[fault]} published no handle, reported only the fixed AbortError category, and left no unhandled rejection after the native terminal event`;
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
  }
}

async function observedExistingNotPublishedThenFreshZero(
  guard: LifecycleGuardState,
  observedName: string,
  freshName: string,
): Promise<string> {
  const rows = syntheticRows(observedName);
  const fixture = await createNativeFixture(
    guard,
    observedName,
    V1_VERSION,
    rows,
  );
  fixture.db.close();

  let targetName = observedName;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name: targetName, version: V1_VERSION }),
    () => {
      upgradeCalls += 1;
      throw new Error(
        `${targetName}: an observed existing database must not run an upgrade`,
      );
    },
  );

  const acquisition = harness.manager.acquire();
  const observedRequest = harness.lastRequest();
  const lateHandled = afterLifecycleHandler(
    observedRequest.request,
    "success",
    `${observedName}: observed late success handling`,
  );
  // The blocked event is synthetic; the later success of the real request to
  // the existing v1 fixture is native. It records the existing database even
  // though the drain path closes the handle instead of publishing it.
  assert(
    observedRequest.request.dispatchEvent(new Event("blocked")),
    `${observedName}: synthetic blocked event was canceled`,
  );
  const blockedFailure = await expectRejected(
    acquisition,
    /blocked by another connection/i,
    `${observedName}: blocked existing open`,
  );
  assertSafeLifecycleFailure(
    blockedFailure,
    ["blocked"],
    `${observedName}: blocked existing open`,
    observedName,
  );
  const observedOutcome = await withWatchdog(
    observedRequest.settled,
    `${observedName}: observed late success`,
  );
  await lateHandled;
  equal(observedOutcome, "success", `${observedName}: observed late outcome`);
  assertClosedHandle(
    observedRequest.request.result,
    `${observedName}: unpublished observed handle`,
  );

  // Redirect to a different fresh fixture. This is a simulated oldVersion 0,
  // not proof of a real external clearing.
  targetName = freshName;
  const lossFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: simulated oldVersion 0 after observation`,
  );
  assertSafeLifecycleFailure(
    lossFailure,
    ["storage-loss"],
    `${freshName}: simulated oldVersion 0 after observation`,
    freshName,
  );
  equal(upgradeCalls, 0, `${freshName}: simulated zero reached the upgrade callback`);
  equal(harness.requestCount(), 2, `${freshName}: simulated zero request count`);
  const freshRequest = harness.lastRequest();
  equal(
    freshRequest.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${freshName}: simulated zero upgrade events`,
  );
  const freshRequestError = await expectOpenError(
    freshRequest,
    `${freshName}: simulated zero request`,
  );
  assert(
    freshRequestError instanceof DOMException &&
      freshRequestError.name === "AbortError",
    `${freshName}: simulated zero request was not aborted: ${String(
      freshRequestError,
    )}`,
  );

  const requestCountAfterLoss = harness.requestCount();
  const latchedFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: latched observed storage loss`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["storage-loss"],
    `${freshName}: latched observed storage loss`,
    freshName,
  );
  equal(
    harness.requestCount(),
    requestCountAfterLoss,
    `${freshName}: latched observed storage loss created another request`,
  );
  return "an existing v1 fixture observed through a real late success was remembered even though its handle was never published; after makeRequest was redirected to a different fresh fixture (a simulated oldVersion 0, not a real external clearing), the manager failed closed with storage loss and created no replacement";
}

async function staleCallbacksCannotClearNewer(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  fixture.db.close();
  let version = V1_VERSION;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name, version }),
    () => {
      upgradeCalls += 1;
      throw new Error(`${name}: the stale-callback scenario must not upgrade`);
    },
  );

  const firstDb = registerPublishedHandle(await harness.manager.acquire());
  assert(harness.manager.isCurrent(firstDb), `${name}: first handle is not current`);
  const firstRequest = harness.lastRequest();

  const external = await upgradeExistingToV2(guard, name);
  assert(
    !harness.manager.isCurrent(firstDb),
    `${name}: external versionchange did not invalidate the first handle`,
  );
  assertClosedHandle(firstDb, `${name}: first handle after versionchange`);
  external.close();

  version = V2_VERSION;
  const newerAcquisition = harness.manager.acquire();
  const newerRequest = harness.lastRequest();
  equal(harness.requestCount(), 2, `${name}: newer request count`);
  equal(
    newerRequest.request.readyState,
    "pending",
    `${name}: newer request must still be pending before stale callbacks`,
  );

  // These are synthetic stale callbacks on the older terminal request. They are
  // explicitly injected after the newer request is already active.
  const staleBlocked = firstRequest.request.dispatchEvent(new Event("blocked"));
  const staleError = firstRequest.request.dispatchEvent(new Event("error"));
  const staleSuccess = firstRequest.request.dispatchEvent(new Event("success"));
  const staleUpgrade = firstRequest.request.dispatchEvent(
    new IDBVersionChangeEvent("upgradeneeded", {
      oldVersion: 0,
      newVersion: V2_VERSION,
    }),
  );
  assert(
    staleBlocked && staleError && staleSuccess && staleUpgrade,
    `${name}: a synthetic stale request event was canceled`,
  );
  const staleDeletion = firstDb.dispatchEvent(
    new IDBVersionChangeEvent("versionchange", {
      oldVersion: V2_VERSION,
      newVersion: null,
    }),
  );
  const staleClose = firstDb.dispatchEvent(new Event("close"));
  assert(
    staleDeletion && staleClose,
    `${name}: a synthetic stale handle event was canceled`,
  );
  equal(harness.requestCount(), 2, `${name}: stale callbacks created a request`);

  const newerDb = registerPublishedHandle(
    await withWatchdog(
      newerAcquisition,
      `${name}: newer acquisition after stale callbacks`,
    ),
  );
  assert(
    harness.manager.isCurrent(newerDb),
    `${name}: stale callbacks cleared the newer handle`,
  );
  equal(upgradeCalls, 0, `${name}: newer acquisition ran an upgrade callback`);
  equal(harness.requestCount(), 2, `${name}: newer acquisition request count`);
  equal(readSchema(newerDb), EXPECTED_V2_SCHEMA, `${name}: newer schema`);
  await assertV1Rows(newerDb, fixture.rows, `${name}: newer fixture`);

  // Repeat the stale callbacks after the newer handle is published. They still
  // must not clear it or latch a terminal state.
  assert(
    firstRequest.request.dispatchEvent(new Event("error")),
    `${name}: post-publish synthetic stale error was canceled`,
  );
  assert(
    firstRequest.request.dispatchEvent(new Event("success")),
    `${name}: post-publish synthetic stale success was canceled`,
  );
  assert(
    firstDb.dispatchEvent(new Event("close")),
    `${name}: post-publish synthetic stale close was canceled`,
  );
  assert(
    firstDb.dispatchEvent(
      new IDBVersionChangeEvent("versionchange", {
        oldVersion: V2_VERSION,
        newVersion: null,
      }),
    ),
    `${name}: post-publish synthetic stale deletion was canceled`,
  );
  assert(
    harness.manager.isCurrent(newerDb),
    `${name}: post-publish stale callbacks cleared the newer handle`,
  );
  const cached = await harness.manager.acquire();
  assert(cached === newerDb, `${name}: cached handle changed after stale callbacks`);
  equal(harness.requestCount(), 2, `${name}: stale callbacks created a cached request`);
  return "synthetic stale events on an older terminal request and an older invalidated handle did not settle the newer in-flight request, did not clear the newer published handle, and did not create another request";
}

async function versionErrorThenFreshZero(
  guard: LifecycleGuardState,
  existingName: string,
  freshName: string,
): Promise<string> {
  // A real v2 fixture exists. The manager asks for v1 and receives a native
  // VersionError, which still proves an existing database was observed.
  const fixture = await createNativeFixture(
    guard,
    existingName,
    V2_VERSION,
    syntheticRows(existingName),
  );
  fixture.db.close();

  let targetName = existingName;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name: targetName, version: V1_VERSION }),
    () => {
      upgradeCalls += 1;
      throw new Error(`${targetName}: the redirect scenario must not upgrade`);
    },
  );

  const versionFailure = await expectRejected(
    harness.manager.acquire(),
    /outdated/i,
    `${existingName}: v1 open of v2 fixture`,
  );
  assertSafeLifecycleFailure(
    versionFailure,
    ["VersionError"],
    `${existingName}: v1 open of v2 fixture`,
    existingName,
  );
  equal(upgradeCalls, 0, `${existingName}: VersionError ran an upgrade callback`);
  equal(harness.requestCount(), 1, `${existingName}: VersionError request count`);
  const versionRequestError = await expectOpenError(
    harness.lastRequest(),
    `${existingName}: VersionError request`,
  );
  assert(
    versionRequestError instanceof DOMException &&
      versionRequestError.name === "VersionError",
    `${existingName}: expected a native VersionError: ${String(
      versionRequestError,
    )}`,
  );

  // Redirect the same manager to a different fresh fixture. This is a
  // simulated oldVersion 0, not a real external clearing.
  targetName = freshName;
  const lossFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: simulated oldVersion 0 after VersionError`,
  );
  assertSafeLifecycleFailure(
    lossFailure,
    ["storage-loss"],
    `${freshName}: simulated oldVersion 0 after VersionError`,
    freshName,
  );
  equal(upgradeCalls, 0, `${freshName}: simulated zero reached the upgrade callback`);
  equal(harness.requestCount(), 2, `${freshName}: simulated zero request count`);
  const freshRequest = harness.lastRequest();
  equal(
    freshRequest.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${freshName}: simulated zero upgrade events`,
  );
  const freshRequestError = await expectOpenError(
    freshRequest,
    `${freshName}: simulated zero request`,
  );
  assert(
    freshRequestError instanceof DOMException &&
      freshRequestError.name === "AbortError",
    `${freshName}: simulated zero request was not aborted: ${String(
      freshRequestError,
    )}`,
  );

  const requestCountAfterLoss = harness.requestCount();
  const latchedFailure = await expectRejected(
    harness.manager.acquire(),
    /unexpectedly empty/i,
    `${freshName}: latched VersionError storage loss`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["storage-loss"],
    `${freshName}: latched VersionError storage loss`,
    freshName,
  );
  equal(
    harness.requestCount(),
    requestCountAfterLoss,
    `${freshName}: latched VersionError storage loss created another request`,
  );
  return "a v2 fixture opened at v1 produced a fixed VersionError; the same manager was then redirected to a different fresh fixture whose oldVersion 0 is a simulated clearing, latched storage-loss, and created no replacement or further request";
}

async function observedStorageLossAbortFailsThenLateSuccess(
  guard: LifecycleGuardState,
  existingName: string,
  freshName: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    existingName,
    V2_VERSION,
    syntheticRows(existingName),
  );
  fixture.db.close();

  let targetName = existingName;
  let upgradeCalls = 0;
  const harness = createHarness(
    guard,
    () => ({ name: targetName, version: V1_VERSION }),
    () => {
      upgradeCalls += 1;
      throw new Error(`${targetName}: the abort-failure scenario must not upgrade`);
    },
  );

  // VersionError observes the existing v2 database without publishing a handle.
  const observedFailure = await expectRejected(
    harness.manager.acquire(),
    /outdated/i,
    `${existingName}: observed existing fixture`,
  );
  assertSafeLifecycleFailure(
    observedFailure,
    ["VersionError"],
    `${existingName}: observed existing fixture`,
    existingName,
  );

  targetName = freshName;
  const acquisition = harness.manager.acquire();
  const tracked = harness.lastRequest();
  try {
    // Fault injection on the real fresh-fixture request: abortUpgrade() reads
    // this accessor and fails, so the upgrade transaction is never aborted.
    Object.defineProperty(tracked.request, "transaction", {
      configurable: true,
      get() {
        throw new Error(`${freshName}: injected transaction abort fault`);
      },
    });
  } catch (error) {
    throw new Error(
      `${freshName}: could not inject the transaction abort fault: ${String(
        error,
      )}`,
    );
  }

  const successHandled = afterLifecycleHandler(
    tracked.request,
    "success",
    `${freshName}: late success after storage-loss abort fault`,
  );
  const failure = await expectRejected(
    acquisition,
    /abort could not be confirmed|opened after an upgrade abort|indeterminate/i,
    `${freshName}: storage-loss abort failure`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["indeterminate"],
    `${freshName}: storage-loss abort failure`,
    freshName,
  );
  equal(upgradeCalls, 0, `${freshName}: storage-loss abort ran an upgrade callback`);
  equal(harness.requestCount(), 2, `${freshName}: storage-loss abort request count`);
  equal(
    tracked.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${freshName}: storage-loss abort upgrade events`,
  );

  const lateOutcome = await withWatchdog(
    tracked.settled,
    `${freshName}: late success after storage-loss abort fault`,
  );
  await successHandled;
  equal(lateOutcome, "success", `${freshName}: storage-loss abort late outcome`);
  assertClosedHandle(
    tracked.request.result,
    `${freshName}: late success after storage-loss abort fault`,
  );

  const requestCountAfterLate = harness.requestCount();
  const latchedFailure = await expectRejected(
    harness.manager.acquire(),
    /abort could not be confirmed|opened after an upgrade abort|indeterminate/i,
    `${freshName}: latched indeterminate after storage-loss abort fault`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["indeterminate"],
    `${freshName}: latched indeterminate after storage-loss abort fault`,
    freshName,
  );
  equal(
    harness.requestCount(),
    requestCountAfterLate,
    `${freshName}: indeterminate latch created another request`,
  );
  return "an observed existing database followed by a simulated oldVersion 0 with an injected abort failure and a real late success latched indeterminate rather than storage-loss or a published handle; the failed abort may have allowed an empty database to be created, so this makes no recreate guarantee and only asserts no published handle or further request";
}

type AbortErrorInjection = "unknown" | "unreadable";

async function handlerRegistrationFailure(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(name);
  let requestCount = 0;
  let upgradeCalls = 0;
  let registrationAttempts = 0;
  let tracked: TrackedRequest | undefined;

  const manager = createBrowserDbLifecycle(
    () => {
      requestCount += 1;
      const request = trackedOpen(guard, name, V1_VERSION);
      tracked = request;
      const nativeAdd = request.request.addEventListener.bind(request.request);
      // The native request has already been returned to the lifecycle. Fail its
      // first listener registration; subsequent registrations remain available
      // so the manager's emergency supervision can still be installed.
      request.request.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        registrationAttempts += 1;
        if (registrationAttempts === 1) {
          throw new Error(`${name}: injected handler registration failure`);
        }
        nativeAdd(type, listener, options);
      }) as typeof request.request.addEventListener;
      return request.request;
    },
    (() => {
      upgradeCalls += 1;
      throw new Error(`${name}: the handler-failure path must not upgrade`);
    }) as unknown as UpgradeCallback,
  );

  const failure = await expectRejected(
    manager.acquire(),
    /indeterminate|uncertain|could not be secured|handler/i,
    `${name}: handler registration failure`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["indeterminate"],
    `${name}: handler registration failure`,
    name,
  );
  equal(requestCount, 1, `${name}: handler failure request count`);
  equal(upgradeCalls, 0, `${name}: handler failure ran an upgrade callback`);
  assert(tracked, `${name}: handler failure did not create a tracked request`);
  equal(
    registrationAttempts >= 2,
    true,
    `${name}: emergency supervision registration was not attempted`,
  );

  // The manager registered its emergency upgradeneeded abort handler while the
  // acquire rejection was produced. The real native upgrade event is tracked
  // above; the emergency abort must end the request with a real AbortError
  // before any upgrade callback or store creation.
  const terminalHandled = afterLifecycleHandler(
    tracked.request,
    "error",
    `${name}: emergency abort terminal handling`,
  );
  const outcome = await withWatchdog(
    tracked.settled,
    `${name}: native terminal after handler registration failure`,
  );
  await terminalHandled;
  equal(outcome, "error", `${name}: native terminal after handler failure`);
  equal(
    tracked.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${name}: actual upgradeneeded events before emergency abort`,
  );
  const nativeError = tracked.request.error;
  assert(
    nativeError instanceof DOMException && nativeError.name === "AbortError",
    `${name}: emergency abort did not produce a native AbortError: ${String(
      nativeError,
    )}`,
  );
  assertNoPublishedOpenResult(
    tracked.request,
    `${name}: emergency abort published result`,
  );
  equal(upgradeCalls, 0, `${name}: emergency abort reached the upgrade callback`);

  const requestCountAfterFailure = requestCount;
  const latchedFailure = await expectRejected(
    manager.acquire(),
    /indeterminate|uncertain|could not be secured|handler/i,
    `${name}: latched handler registration failure`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["indeterminate"],
    `${name}: latched handler registration failure`,
    name,
  );
  equal(
    requestCount,
    requestCountAfterFailure,
    `${name}: handler registration failure started another native open`,
  );

  // The emergency abort must have rolled back the untouched upgrade. A later
  // fresh native open of the same fixture must still see oldVersion 0; only
  // then are synthetic v1 schema and rows seeded, verified, and closed.
  const seeded = await createNativeFixture(guard, name, V1_VERSION, rows);
  equal(
    seeded.schema,
    EXPECTED_V1_SCHEMA,
    `${name}: seeded-after-abort schema`,
  );
  await assertV1Rows(seeded.db, rows, `${name}: seeded-after-abort rows`);
  seeded.db.close();
  assertClosedHandle(seeded.db, `${name}: seeded-after-abort handle`);
  assert(
    guard.productionOpenAttempts === 0,
    `${name}: the production database was opened`,
  );
  return "an injected handler-registration failure on a real fresh request latched permanent indeterminate and invoked no upgrade callback; the manager's emergency upgradeneeded abort produced a real native AbortError with no published handle or store, a later native open still saw oldVersion 0 and was safely seeded with synthetic v1 rows, no production database was opened, and the manager stayed latched without another request";
}

// Retains the late-success cleanup covered by the earlier handler-failure test
// now that a fresh request is emergency-aborted at upgradeneeded. An existing
// same-version fixture never upgrades, so its native success arrives and the
// abandoned request's best-effort success listener must close it.
async function handlerRegistrationFailureLateSuccess(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const fixture = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  fixture.db.close();

  let requestCount = 0;
  let upgradeCalls = 0;
  let registrationAttempts = 0;
  let tracked: TrackedRequest | undefined;

  const manager = createBrowserDbLifecycle(
    () => {
      requestCount += 1;
      const request = trackedOpen(guard, name, V1_VERSION);
      tracked = request;
      const nativeAdd = request.request.addEventListener.bind(request.request);
      // Fail only the first lifecycle registration; the abandoned-request
      // success cleanup registration remains available.
      request.request.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        registrationAttempts += 1;
        if (registrationAttempts === 1) {
          throw new Error(`${name}: injected handler registration failure`);
        }
        nativeAdd(type, listener, options);
      }) as typeof request.request.addEventListener;
      return request.request;
    },
    (() => {
      upgradeCalls += 1;
      throw new Error(`${name}: an existing same-version open must not upgrade`);
    }) as unknown as UpgradeCallback,
  );

  const failure = await expectRejected(
    manager.acquire(),
    /indeterminate|uncertain|could not be secured|handler/i,
    `${name}: existing handler registration failure`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["indeterminate"],
    `${name}: existing handler registration failure`,
    name,
  );
  equal(requestCount, 1, `${name}: existing handler failure request count`);
  equal(upgradeCalls, 0, `${name}: existing handler failure upgrade callback`);
  assert(tracked, `${name}: existing handler failure created no tracked request`);
  equal(
    registrationAttempts >= 2,
    true,
    `${name}: existing handler failure skipped late-result registration`,
  );

  // The abandoned request's success listener was registered before this
  // barrier, so awaiting it proves the late handle was already handled.
  const successHandled = afterLifecycleHandler(
    tracked.request,
    "success",
    `${name}: existing late success handling`,
  );
  const outcome = await withWatchdog(
    tracked.settled,
    `${name}: existing native success`,
  );
  await successHandled;
  equal(outcome, "success", `${name}: existing native outcome`);
  equal(
    tracked.upgrades,
    [],
    `${name}: existing same-version open recorded an upgrade event`,
  );
  assertClosedHandle(
    tracked.request.result,
    `${name}: late success after existing handler failure`,
  );

  // The unpublished handle must not have changed the existing fixture.
  const inspection = await openExisting(guard, name, V1_VERSION);
  await assertV1Rows(
    inspection,
    fixture.rows,
    `${name}: existing fixture after late success`,
  );
  inspection.close();
  assertClosedHandle(inspection, `${name}: existing inspection handle`);

  const requestCountAfterFailure = requestCount;
  const latchedFailure = await expectRejected(
    manager.acquire(),
    /indeterminate|uncertain|could not be secured|handler/i,
    `${name}: latched existing handler registration failure`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["indeterminate"],
    `${name}: latched existing handler registration failure`,
    name,
  );
  equal(
    requestCount,
    requestCountAfterFailure,
    `${name}: existing handler failure started another native open`,
  );
  assert(
    guard.productionOpenAttempts === 0,
    `${name}: the production database was opened`,
  );
  return "an injected handler-registration failure on a real existing same-version request recorded no upgrade event; the late native success handle was closed instead of published, an independent read found the fixture rows unchanged, no production database was opened, and the manager stayed latched without another native open";
}

// Both variants inject the value returned by a real native abort error event.
// This is an explicitly simulated error value, not evidence about a real
// browser failure category. The manager must not guess AbortError when the
// terminal error cannot be safely read.
async function unknownAbortErrorIsIndeterminate(
  guard: LifecycleGuardState,
  name: string,
  injection: AbortErrorInjection,
): Promise<string> {
  let requestCount = 0;
  let upgradeCalls = 0;
  let tracked: TrackedRequest | undefined;

  const manager = createBrowserDbLifecycle(
    () => {
      requestCount += 1;
      tracked = trackedOpen(guard, name, V1_VERSION);
      return tracked.request;
    },
    (() => {
      upgradeCalls += 1;
      throw new Error(`${name}: simulated upgrade callback failure`);
    }) as unknown as UpgradeCallback,
  );

  const acquisition = manager.acquire();
  assert(tracked, `${name}: simulated error scenario created no tracked request`);
  const request = tracked.request;
  const injectedMarker = `synthetic-${injection}-abort-error-${crypto.randomUUID()}`;

  // The upgrade callback throws, so the manager requests an abort before the
  // terminal event. The injected value below is read only when the real native
  // abort error event arrives; it is synthetic and explicitly labelled.
  if (injection === "unknown") {
    Object.defineProperty(request, "error", {
      configurable: true,
      get: () => ({ name: injectedMarker }),
    });
  } else {
    Object.defineProperty(request, "error", {
      configurable: true,
      get() {
        throw new Error(`${injectedMarker}: simulated unreadable native error`);
      },
    });
  }

  const terminalHandled = afterLifecycleHandler(
    request,
    "error",
    `${name}: simulated ${injection} abort error handling`,
  );
  const failure = await expectRejected(
    acquisition,
    /indeterminate|abort could not be confirmed|unknown/i,
    `${name}: simulated ${injection} abort error`,
  );
  assertSafeLifecycleFailure(
    failure,
    ["indeterminate"],
    `${name}: simulated ${injection} abort error`,
    name,
  );
  assert(
    !failure.message.includes(injectedMarker),
    `${name}: simulated ${injection} abort error leaked the injected marker`,
  );
  equal(upgradeCalls, 1, `${name}: simulated ${injection} upgrade callback count`);
  equal(requestCount, 1, `${name}: simulated ${injection} request count`);

  const outcome = await withWatchdog(
    tracked.settled,
    `${name}: simulated ${injection} native terminal event`,
  );
  await terminalHandled;
  equal(outcome, "error", `${name}: simulated ${injection} native outcome`);

  // Remove the injected value so the real native terminal error is visible.
  Reflect.deleteProperty(request, "error");
  const nativeError = request.error;
  assert(
    nativeError instanceof DOMException && nativeError.name === "AbortError",
    `${name}: simulated ${injection} error obscured a non-abort terminal event: ${String(
      nativeError,
    )}`,
  );
  assertNoPublishedOpenResult(
    request,
    `${name}: simulated ${injection} published result`,
  );

  const requestCountAfterFailure = requestCount;
  const latchedFailure = await expectRejected(
    manager.acquire(),
    /indeterminate|abort could not be confirmed|unknown/i,
    `${name}: latched simulated ${injection} abort error`,
  );
  assertSafeLifecycleFailure(
    latchedFailure,
    ["indeterminate"],
    `${name}: latched simulated ${injection} abort error`,
    name,
  );
  equal(
    requestCount,
    requestCountAfterFailure,
    `${name}: simulated ${injection} abort error started another native open`,
  );
  return `a real native abort error event carried an explicitly simulated ${injection} error value after the manager requested an abort; the manager reported indeterminate rather than AbortError, published no handle, and stayed latched without another native open`;
}

function syntheticAbsolutePath(): string {
  const path = `/synthetic-absolute-path/${crypto.randomUUID()}/private.db`;
  assert(path.startsWith("/"), `${path}: synthetic path is not absolute`);
  assert(
    !path.includes(PRODUCTION_DB_NAME),
    `${path}: synthetic path contains the production database name`,
  );
  assert(
    !path.includes("/home/") && !path.includes("/Users/"),
    `${path}: synthetic path resembles a real user path`,
  );
  return path;
}

// A makeRequest failure carries a synthetic absolute path in its private error
// message. The public rejection must be a fixed transient error whose name,
// message, string form, JSON form, and own properties exclude that path.
async function factoryFailurePathSanitization(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const syntheticPath = syntheticAbsolutePath();
  let factoryCalls = 0;

  const manager = createBrowserDbLifecycle(
    () => {
      factoryCalls += 1;
      throw new Error(`synthetic factory failure at ${syntheticPath}`);
    },
    (() => {
      throw new Error(`${name}: a factory failure must not upgrade`);
    }) as unknown as UpgradeCallback,
  );

  const failure = await expectRejected(
    manager.acquire(),
    /failed or was aborted/i,
    `${name}: factory path failure`,
  );
  const safeFailure = assertSafeLifecycleFailure(
    failure,
    ["transient"],
    `${name}: factory path failure`,
    name,
  );
  equal(safeFailure.category, "transient", `${name}: factory path category`);
  assertPublicSurfaceExcludes(
    safeFailure,
    syntheticPath,
    `${name}: factory path failure`,
  );
  equal(factoryCalls, 1, `${name}: factory path failure call count`);
  assert(
    !guard.openedNames.includes(name),
    `${name}: the factory failure unexpectedly opened the fixture`,
  );

  // This fixture name is still part of the boot guard's exact set. Seed it
  // natively and verify the synthetic v1 rows so the fixture-open invariant is
  // satisfied without any database being created by the failed factory path.
  const seeded = await createNativeFixture(
    guard,
    name,
    V1_VERSION,
    syntheticRows(name),
  );
  equal(seeded.schema, EXPECTED_V1_SCHEMA, `${name}: factory path seeded schema`);
  await assertV1Rows(seeded.db, seeded.rows, `${name}: factory path seeded rows`);
  seeded.db.close();
  assertClosedHandle(seeded.db, `${name}: factory path seeded handle`);
  return "a synthetic factory failure whose private message contained a synthetic absolute path was reported as a fixed transient error; every inspected public surface excluded the path and no native open occurred before the fixture was seeded natively";
}

// A real native request is failed by an explicitly synthetic error event whose
// injected unknown error value carries a synthetic absolute path. The public
// rejection must be transient and must not expose that path.
async function nativeFailurePathSanitization(
  guard: LifecycleGuardState,
  name: string,
): Promise<string> {
  const syntheticPath = syntheticAbsolutePath();
  const rows = syntheticRows(name);
  let requestCount = 0;
  let upgradeCalls = 0;
  let tracked: TrackedRequest | undefined;

  const manager = createBrowserDbLifecycle(
    () => {
      requestCount += 1;
      tracked = trackedOpen(guard, name, V1_VERSION);
      return tracked.request;
    },
    (() => {
      upgradeCalls += 1;
      throw new Error(`${name}: a native error path must not upgrade`);
    }) as unknown as UpgradeCallback,
  );

  const acquisition = manager.acquire();
  assert(tracked, `${name}: native path failure created no tracked request`);
  const request = tracked.request;
  const injectedError = new Error(
    `synthetic native failure at ${syntheticPath}`,
  );
  injectedError.name = "SyntheticNativeErrorName";
  Object.defineProperty(request, "error", {
    configurable: true,
    get: () => injectedError,
  });

  // The error event is synthetic and explicitly labelled. It is dispatched on
  // the real pending request; the injected value is the only synthetic part.
  assert(
    request.dispatchEvent(new Event("error")),
    `${name}: synthetic native error event was canceled`,
  );
  const failure = await expectRejected(
    acquisition,
    /failed or was aborted/i,
    `${name}: native path failure`,
  );
  const safeFailure = assertSafeLifecycleFailure(
    failure,
    ["transient"],
    `${name}: native path failure`,
    name,
  );
  equal(safeFailure.category, "transient", `${name}: native path category`);
  assertPublicSurfaceExcludes(
    safeFailure,
    syntheticPath,
    `${name}: native path failure`,
  );
  equal(upgradeCalls, 0, `${name}: native path failure upgrade callback`);
  equal(requestCount, 1, `${name}: native path failure request count`);

  // Restore the real native accessor, then wait for the manager's terminal
  // listener to abort the late upgrade and for the real native terminal event.
  Reflect.deleteProperty(request, "error");
  const realTerminalHandled = afterLifecycleHandler(
    request,
    "error",
    `${name}: real terminal after injected native error`,
  );
  const trackedOutcome = await withWatchdog(
    tracked.settled,
    `${name}: injected native error settlement`,
  );
  await realTerminalHandled;
  equal(trackedOutcome, "error", `${name}: injected native error outcome`);
  const nativeError = request.error;
  assert(
    nativeError instanceof DOMException && nativeError.name === "AbortError",
    `${name}: an aborted late upgrade did not report AbortError: ${String(
      nativeError,
    )}`,
  );
  assertNoPublishedOpenResult(
    request,
    `${name}: native path failure published result`,
  );

  // The aborted late upgrade must have left the fixture fresh; seed and verify.
  const seeded = await createNativeFixture(guard, name, V1_VERSION, rows);
  equal(seeded.schema, EXPECTED_V1_SCHEMA, `${name}: native path seeded schema`);
  await assertV1Rows(seeded.db, rows, `${name}: native path seeded rows`);
  seeded.db.close();
  assertClosedHandle(seeded.db, `${name}: native path seeded handle`);
  return "an explicitly synthetic error event on a real request injected an unknown native error carrying a synthetic absolute path; the manager reported a fixed transient error whose public surfaces excluded the path, the late upgrade was aborted with a real AbortError, and the fixture was still fresh when safely seeded natively";
}

async function run(): Promise<string[]> {
  const guard = requireGuard();
  equal(
    guard.openedNames,
    [],
    "a database was opened before the lifecycle test began",
  );
  equal(
    guard.deleteNames,
    [],
    "a database delete was attempted before the lifecycle test began",
  );
  equal(
    guard.unexpectedOpenAttempts,
    [],
    "an unexpected database open was attempted before the lifecycle test began",
  );
  assert(
    guard.productionOpenAttempts === 0,
    "the production database was opened before the lifecycle test began",
  );
  assert(
    guard.networkAttempts === 0,
    "network access was attempted before the lifecycle test began",
  );

  const [
    concurrentName,
    terminalName,
    blockedName,
    syntheticBlockedName,
    versionChangeName,
    externalName,
    freshZeroName,
    deletionName,
    closeName,
    reentrantName,
    indeterminateName,
    callbackThrowName,
    callbackAbortName,
    callbackFulfilledName,
    callbackRejectedName,
    observedName,
    observedFreshZeroName,
    staleName,
    versionErrorName,
    versionErrorFreshName,
    observedAbortName,
    observedAbortFreshName,
    handlerFailureName,
    handlerLateSuccessName,
    unknownAbortErrorName,
    unreadableAbortErrorName,
    factoryPathName,
    nativePathName,
  ] = guard.dbNames;
  await runScenario(outcomes, "concurrent acquisition", () =>
    concurrentAcquisition(guard, concurrentName),
  );
  await runScenario(outcomes, "terminal failure then retry", () =>
    terminalFailureThenRetry(guard, terminalName),
  );
  await runScenario(outcomes, "blocked drain then retry", () =>
    blockedDrainLateAbortThenRetry(guard, blockedName),
  );
  await runScenario(outcomes, "synthetic blocked late success", () =>
    syntheticBlockedLateSuccess(guard, syntheticBlockedName),
  );
  await runScenario(outcomes, "versionchange then VersionError", () =>
    versionChangeAndVersionError(guard, versionChangeName),
  );
  await runScenario(outcomes, "external versionchange then fresh zero", () =>
    externalVersionChangeThenFreshZero(guard, externalName, freshZeroName),
  );
  await runScenario(outcomes, "simulated deletion versionchange", () =>
    simulatedDeletionVersionChange(guard, deletionName),
  );
  await runScenario(outcomes, "simulated abnormal close", () =>
    simulatedAbnormalClose(guard, closeName),
  );
  await runScenario(outcomes, "reentrant makeRequest", () =>
    reentrantMakeRequest(guard, reentrantName),
  );
  await runScenario(outcomes, "indeterminate abort failure", () =>
    indeterminateAbortFailure(guard, indeterminateName),
  );
  await runScenario(outcomes, "upgrade callback throw", () =>
    upgradeCallbackFailure(guard, callbackThrowName, "throw"),
  );
  await runScenario(outcomes, "upgrade callback abort", () =>
    upgradeCallbackFailure(guard, callbackAbortName, "abort"),
  );
  await runScenario(outcomes, "upgrade callback fulfilled", () =>
    upgradeCallbackFailure(guard, callbackFulfilledName, "fulfilled"),
  );
  await runScenario(outcomes, "upgrade callback rejected", () =>
    upgradeCallbackFailure(guard, callbackRejectedName, "rejected"),
  );
  await runScenario(outcomes, "observed existing then fresh zero", () =>
    observedExistingNotPublishedThenFreshZero(
      guard,
      observedName,
      observedFreshZeroName,
    ),
  );
  await runScenario(outcomes, "stale callbacks", () =>
    staleCallbacksCannotClearNewer(guard, staleName),
  );
  await runScenario(outcomes, "VersionError then fresh zero", () =>
    versionErrorThenFreshZero(guard, versionErrorName, versionErrorFreshName),
  );
  await runScenario(outcomes, "observed storage loss abort failure", () =>
    observedStorageLossAbortFailsThenLateSuccess(
      guard,
      observedAbortName,
      observedAbortFreshName,
    ),
  );
  await runScenario(outcomes, "handler failure emergency abort", () =>
    handlerRegistrationFailure(guard, handlerFailureName),
  );
  await runScenario(outcomes, "handler failure late success", () =>
    handlerRegistrationFailureLateSuccess(guard, handlerLateSuccessName),
  );
  await runScenario(outcomes, "unknown abort error", () =>
    unknownAbortErrorIsIndeterminate(
      guard,
      unknownAbortErrorName,
      "unknown",
    ),
  );
  await runScenario(outcomes, "unreadable abort error", () =>
    unknownAbortErrorIsIndeterminate(
      guard,
      unreadableAbortErrorName,
      "unreadable",
    ),
  );
  await runScenario(outcomes, "factory failure path sanitization", () =>
    factoryFailurePathSanitization(guard, factoryPathName),
  );
  await runScenario(outcomes, "native failure path sanitization", () =>
    nativeFailurePathSanitization(guard, nativePathName),
  );

  equal(
    guard.deleteNames,
    [],
    "the lifecycle guard observed a deleteDatabase attempt",
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
    "the guard did not observe exactly the twenty-eight lifecycle fixtures",
  );
  equal(
    firstUpgradeOldVersions.size,
    guard.dbNames.length,
    "not every lifecycle fixture recorded a first upgrade",
  );
  for (const name of guard.dbNames) {
    equal(
      firstUpgradeOldVersions.get(name),
      0,
      `${name}: fixture was not first created at oldVersion 0`,
    );
  }
  outcomes.push(
    "the boot guard observed only the twenty-eight runtime-unique lifecycle fixture opens, no deleteDatabase attempt, no production or legacy application database open, no production application database write, and no guard-observed fetch/XHR/WebSocket/EventSource/beacon attempt (this is not a whole-browser no-network claim); every fixture first appeared at oldVersion 0; seed-bearing fixtures used the synthetic v1 schema and representative rows including an orphan history row and schemaVersion marker, while aborted and simulated-zero attempts were intentionally not seeded until the handler-failure fixture was re-opened and safely seeded after its emergency abort; the existing-fixture handler-failure case only closed an unpublished late success; every manager-published handle was explicitly closed in a scenario finally block after the manager was no longer used; synthetic events and injected error values were explicitly labelled, synthetic absolute paths never appeared in a public error surface, and the redirected fresh-fixture oldVersion 0 is a simulation, not evidence of a real database clearing",
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
