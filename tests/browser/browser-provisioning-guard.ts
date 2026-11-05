// TEST-ONLY native IndexedDB guard for the inert browser provisioning
// coordinator. Run with:
//   JOURNAL_GUARD_MODE=provisioning CHROMIUM_PATH=/path/to/chrome \
//     node tests/browser/run-completion-journal-guard.mjs
//
// This module runs only on the runner's fresh loopback origin and ephemeral
// Chrome profile. The runner generates forty-five runtime-unique fixture
// database names with crypto.randomUUID and installs the native boot guard at
// `window.__journalGuard` before this bundle executes. In provisioning mode the
// guard rejects any open outside that exact allowlist, rejects every
// deleteDatabase call (the whole ephemeral profile is the only cleanup), and
// blocks fetch/XHR/WebSocket/EventSource/beacon traffic. The report is sent
// through the pre-block native fetch captured by the boot guard.
//
// The coordinator under test is the real `createBrowserProvisioning`, bound to
// a fixed `{ name, version }` target and injected with a factory that calls the
// guarded native indexedDB.open. The module itself never opens
// `tubeshuffle_local` or any legacy application database, never writes
// application data, and never changes the application DB_VERSION. The synthetic
// schema and rows below are a model of the current stores, not the production
// schema, migration, or wire-up path.
//
// Independent fixture guard: every request created by this module goes through
// `trackedOpen`, which attaches its own `upgradeneeded` listener before any
// fixture seed or coordinator listener. That listener verifies the exact
// allowlisted fixture name, requested version, `newVersion`, resulting handle
// name/version, and the expected `oldVersion`. On a mismatch it calls
// `stopImmediatePropagation()` and aborts the versionchange transaction before
// any later listener can create a store or add a row. A distinct
// `freshWriteVerified` flag starts false and is set only after the exact
// `oldVersion === 0`, target/version, and live transaction have all been
// checked; both schema creation and row seeding require it. The intentionally
// pre-seeded v1->v2 blocked-drain scenario is explicitly labelled and is not a
// fresh write. A negative self-test deliberately supplies a wrong upgrade
// expectation and proves later schema/row callbacks do not run.
//
// All waits are transaction/request outcome event barriers or bounded
// watchdogs. The only timer used as a behavior checkpoint is a zero-delay task
// turn after a contained thenable, to let an unhandledrejection event surface.
// Injected abort/listener/result/close failures are labelled simulations. This
// is local Linux Chrome evidence only; it is not proof of first-use detection,
// data preservation against other tabs or external deletion, durability, crash
// recovery, production schema validity, or real user data.

import {
  BrowserProvisioningError,
  createBrowserProvisioning,
  type BrowserProvisioning,
  type BrowserProvisioningErrorCategory,
  type ProvisioningStatus,
} from "@/lib/storage/browser-provisioning";

const TEST_DB_PREFIX = "tubeshuffle-provisioning-test-";
const PRODUCTION_DB_NAME = "tubeshuffle_local";
const V1_VERSION = 1;
const V2_VERSION = 2;
const PROBE_VERSION = 3;
const WATCHDOG_MS = 10_000;
const EXPECTED_DB_NAME_COUNT = 45;

const STORE_PLAYLISTS = "playlists";
const STORE_VIDEOS = "videos";
const STORE_PLAY_HISTORY = "playHistory";
const STORE_META = "meta";
const JOURNAL_STORE = "completionJournal";
const EXTRA_STORE = "harmlessExtraStore";
const EXTRA_INDEX = "harmlessExtraIndex";
const PARTIAL_WRITE_STORE = "partialWriteStore";

const V1_STORE_NAMES = [
  STORE_PLAYLISTS,
  STORE_VIDEOS,
  STORE_PLAY_HISTORY,
  STORE_META,
] as const;
type V1StoreName = (typeof V1_STORE_NAMES)[number];
type SeedRows = Record<string, Record<string, unknown>[]>;

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

interface ProvisioningGuardState {
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
  window as unknown as { readonly __journalGuard?: ProvisioningGuardState }
).__journalGuard;
// The boot guard replaces window.fetch with a rejecting blocker. The report is
// the only request this module makes, and it uses the pre-block native fetch.
const reportFetch = guardState?.nativeFetch ?? window.fetch.bind(window);
const outcomes: string[] = [];
const firstUpgradeOldVersions = new Map<string, number>();
const fixtureGuardViolations: string[] = [];
const harnessViolations: string[] = [];

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

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
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

// Locate the native `result` accessor so fault-injected unreadable-result tests
// can still retrieve the real handle for cleanup.
const NATIVE_RESULT_GETTER:
  | ((this: IDBRequest) => unknown)
  | null = (() => {
  let proto: object | null = IDBRequest.prototype;
  while (proto !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "result");
    const getter = descriptor?.get;
    if (getter) return getter as (this: IDBRequest) => unknown;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
})();

function readNativeResult(request: IDBOpenDBRequest): IDBDatabase {
  assert(NATIVE_RESULT_GETTER, "the native IDBRequest result getter was unavailable");
  return NATIVE_RESULT_GETTER.call(request) as IDBDatabase;
}

function defineOwn(
  target: object,
  key: string,
  descriptor: PropertyDescriptor,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    ...descriptor,
  });
}

// ---------------------------------------------------------------------------
// Fixture expectations and the independent early upgrade guard.
// ---------------------------------------------------------------------------

type OldVersionExpectation = number | "none" | "any" | "none-or-0";

interface OpenPlan {
  readonly name: string;
  readonly version: number;
  readonly oldVersion: OldVersionExpectation;
  readonly label: string;
}

interface UpgradeObservation {
  readonly oldVersion: number;
  readonly newVersion: number | null;
}

interface RequestHooks {
  /** Runs after the early guard is attached but before the coordinator gets the
   * request. */
  readonly onTracked?: (request: IDBOpenDBRequest, tracked: TrackedRequest) => void;
  /** Runs inside the early guard, before the coordinator's own listener. */
  readonly onUpgrade?: (
    request: IDBOpenDBRequest,
    event: IDBVersionChangeEvent,
    tracked: TrackedRequest,
  ) => void;
  /** Runs before the coordinator's success listener. */
  readonly onSuccess?: (
    request: IDBOpenDBRequest,
    db: IDBDatabase | null,
    tracked: TrackedRequest,
  ) => void;
  readonly onError?: (request: IDBOpenDBRequest, tracked: TrackedRequest) => void;
}

interface TrackedRequest {
  readonly request: IDBOpenDBRequest;
  readonly plan: OpenPlan;
  readonly upgrades: UpgradeObservation[];
  readonly events: string[];
  readonly settled: Promise<"success" | "error">;
  readonly errorName: () => string | null;
  readonly transactionAborted: () => boolean;
  readonly guardPassed: () => boolean;
  readonly freshWriteVerified: () => boolean;
}

function requireGuard(): ProvisioningGuardState {
  assert(
    guardState,
    "the native boot guard did not install window.__journalGuard before the test bundle ran",
  );
  const guard = guardState;
  equal(guard.mode, "provisioning", "boot guard mode");
  assert(
    guard.allowed instanceof Set,
    "the boot guard did not expose its exact allowlist",
  );
  equal(
    guard.allowed.size,
    EXPECTED_DB_NAME_COUNT,
    "boot guard allowlist size",
  );
  equal(
    guard.dbNames.length,
    EXPECTED_DB_NAME_COUNT,
    "boot guard fixture name count",
  );
  assert(
    new Set(guard.dbNames).size === EXPECTED_DB_NAME_COUNT,
    "the runner generated colliding provisioning fixture names",
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
      `${name}: fixture name does not use the provisioning test prefix`,
    );
  }
  return guard;
}

function trackedOpen(
  guard: ProvisioningGuardState,
  plan: OpenPlan,
  hooks?: RequestHooks,
): TrackedRequest {
  assert(guard.allowed.has(plan.name), `${plan.label}: non-allowlisted open`);
  assert(
    plan.name !== PRODUCTION_DB_NAME,
    `${plan.label}: attempted the production open`,
  );

  const upgrades: UpgradeObservation[] = [];
  const events: string[] = [];
  const settled = deferred<"success" | "error">();
  let terminalErrorName: string | null = null;
  let transactionAborted = false;
  let guardPassed = true;
  let freshWriteVerified = false;

  const request = indexedDB.open(plan.name, plan.version);
  const tracked: TrackedRequest = {
    request,
    plan,
    upgrades,
    events,
    settled: settled.promise,
    errorName: () => terminalErrorName,
    transactionAborted: () => transactionAborted,
    guardPassed: () => guardPassed,
    freshWriteVerified: () => freshWriteVerified,
  };

  // This listener is registered first, before any fixture seed property handler
  // or coordinator listener. It is the independent pre-write guard.
  request.addEventListener("upgradeneeded", (event) => {
    const versionEvent = event as IDBVersionChangeEvent;
    upgrades.push({
      oldVersion: versionEvent.oldVersion,
      newVersion: versionEvent.newVersion,
    });
    events.push("upgradeneeded");
    if (!firstUpgradeOldVersions.has(plan.name)) {
      firstUpgradeOldVersions.set(plan.name, versionEvent.oldVersion);
    }

    const violation = (reason: string): void => {
      guardPassed = false;
      fixtureGuardViolations.push(`${plan.label}: ${reason}`);
      try {
        versionEvent.stopImmediatePropagation();
      } catch {
        // The event may already be dispatching in a hostile context.
      }
      try {
        request.transaction?.abort();
      } catch {
        // The upgrade transaction may already be inactive.
      }
    };

    try {
      const transaction = request.transaction;
      if (transaction === null) {
        violation("upgrade had no live transaction");
        return;
      }
      transaction.addEventListener("abort", () => {
        transactionAborted = true;
        events.push("transaction-abort");
      });
    } catch {
      violation("upgrade transaction was unavailable for an abort observer");
      return;
    }

    if (!guard.allowed.has(plan.name)) {
      violation("open target is not allowlisted");
      return;
    }
    if (versionEvent.newVersion !== plan.version) {
      violation(
        `upgrade newVersion ${String(versionEvent.newVersion)} != expected ${plan.version}`,
      );
      return;
    }
    if (plan.oldVersion === "none") {
      violation("unexpected upgrade on a no-upgrade request");
      return;
    }
    if (
      typeof plan.oldVersion === "number" &&
      versionEvent.oldVersion !== plan.oldVersion
    ) {
      violation(
        `upgrade oldVersion ${versionEvent.oldVersion} != expected ${plan.oldVersion}`,
      );
      return;
    }
    if (
      plan.oldVersion === "none-or-0" &&
      versionEvent.oldVersion !== 0
    ) {
      violation(
        `upgrade oldVersion ${versionEvent.oldVersion} is neither absent nor a fresh 0`,
      );
      return;
    }

    let db: IDBDatabase;
    try {
      db = request.result;
    } catch {
      violation("upgrade result was unreadable");
      return;
    }
    if (db.name !== plan.name) {
      violation(`upgrade handle name ${db.name} != expected ${plan.name}`);
      return;
    }
    if (db.version !== plan.version) {
      violation(
        `upgrade handle version ${db.version} != expected ${plan.version}`,
      );
      return;
    }

    // Fresh-write verification is complete only after the exact fixture,
    // version, oldVersion, handle and live transaction were all checked.
    if (versionEvent.oldVersion === 0) freshWriteVerified = true;

    hooks?.onUpgrade?.(request, versionEvent, tracked);
  });

  request.addEventListener("success", () => {
    events.push("success");
    let db: IDBDatabase | null = null;
    try {
      db = request.result;
    } catch {
      db = null;
    }
    hooks?.onSuccess?.(request, db, tracked);
    settled.resolve("success");
  });

  request.addEventListener("error", () => {
    events.push("error");
    try {
      terminalErrorName = request.error?.name ?? null;
    } catch {
      terminalErrorName = null;
    }
    hooks?.onError?.(request, tracked);
    settled.resolve("error");
  });

  hooks?.onTracked?.(request, tracked);

  return tracked;
}

// ---------------------------------------------------------------------------
// Schema helpers and a required-subset validator.
// ---------------------------------------------------------------------------

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
  if (names.length === 0) return [];
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

// Accepts the required v1 stores/indexes and ignores harmless extra stores or
// indexes. It deliberately does not require exact equality.
function validateRequiredV1Schema(db: IDBDatabase): boolean {
  const actualStores = new Map<string, SchemaStore>();
  for (const store of readSchema(db)) actualStores.set(store.name, store);

  for (const expected of EXPECTED_V1_SCHEMA) {
    const actual = actualStores.get(expected.name);
    if (!actual) return false;
    if (
      !deepEqual(actual.keyPath, expected.keyPath) ||
      actual.autoIncrement !== expected.autoIncrement
    ) {
      return false;
    }
    const actualIndexes = new Map<string, SchemaIndex>();
    for (const index of actual.indexes) actualIndexes.set(index.name, index);
    for (const expectedIndex of expected.indexes) {
      const actualIndex = actualIndexes.get(expectedIndex.name);
      if (!actualIndex) return false;
      if (
        !deepEqual(actualIndex.keyPath, expectedIndex.keyPath) ||
        actualIndex.unique !== expectedIndex.unique ||
        actualIndex.multiEntry !== expectedIndex.multiEntry
      ) {
        return false;
      }
    }
  }
  return true;
}

interface FixtureOptions {
  readonly omitStore?: V1StoreName;
  readonly omitIndex?: { readonly store: V1StoreName; readonly index: string };
  readonly extraStore?: string;
  readonly extraIndex?: string;
}

function createV1Stores(db: IDBDatabase, options?: FixtureOptions): void {
  if (options?.omitStore !== STORE_PLAYLISTS) {
    const playlists = db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
    if (!(options?.omitIndex?.store === STORE_PLAYLISTS && options.omitIndex.index === "youtubeId")) {
      playlists.createIndex("youtubeId", "youtubeId", { unique: true });
    }
    if (!(options?.omitIndex?.store === STORE_PLAYLISTS && options.omitIndex.index === "updatedAt")) {
      playlists.createIndex("updatedAt", "updatedAt", { unique: false });
    }
  }

  if (options?.omitStore !== STORE_VIDEOS) {
    const videos = db.createObjectStore(STORE_VIDEOS, { keyPath: "id" });
    if (!(options?.omitIndex?.store === STORE_VIDEOS && options.omitIndex.index === "playlistId")) {
      videos.createIndex("playlistId", "playlistId", { unique: false });
    }
    if (!(options?.omitIndex?.store === STORE_VIDEOS && options.omitIndex.index === "playlistPosition")) {
      videos.createIndex("playlistPosition", ["playlistId", "position"], {
        unique: false,
      });
    }
    if (!(options?.omitIndex?.store === STORE_VIDEOS && options.omitIndex.index === "youtubeId")) {
      videos.createIndex("youtubeId", "youtubeId", { unique: false });
    }
  }

  if (options?.omitStore !== STORE_PLAY_HISTORY) {
    const playHistory = db.createObjectStore(STORE_PLAY_HISTORY, {
      keyPath: "id",
    });
    for (const index of ["playlistId", "videoId", "watchedAt"]) {
      if (
        !(
          options?.omitIndex?.store === STORE_PLAY_HISTORY &&
          options.omitIndex.index === index
        )
      ) {
        playHistory.createIndex(index, index, { unique: false });
      }
    }
  }

  if (options?.omitStore !== STORE_META) {
    const meta = db.createObjectStore(STORE_META, { keyPath: "key" });
    if (options?.extraIndex) {
      meta.createIndex(options.extraIndex, "key", { unique: false });
    }
  }

  if (options?.extraStore) {
    db.createObjectStore(options.extraStore, { keyPath: "id" });
  }
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
        description: "Synthetic provisioning fixture row",
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

function seedRowsInUpgrade(
  tracked: TrackedRequest,
  rows: SeedRows,
  label: string,
  options?: FixtureOptions,
): void {
  assert(
    tracked.freshWriteVerified(),
    `${label}: seed attempted before fresh-write verification (exact fixture/version/oldVersion 0/live transaction)`,
  );
  const transaction = tracked.request.transaction;
  assert(transaction, `${label}: upgrade has no active transaction`);
  for (const name of V1_STORE_NAMES) {
    if (options?.omitStore === name) continue;
    const store = transaction.objectStore(name);
    for (const row of rows[name] ?? []) {
      store.add(row);
    }
  }
  if (options?.extraStore) {
    const store = transaction.objectStore(options.extraStore);
    for (const row of rows[options.extraStore] ?? []) store.add(row);
  }
}

// The negative self-test deliberately causes one expected guard violation.
// Consume only that labelled entry so the final assertion still fails on any
// other fixture-guard mismatch.
function consumeFixtureGuardViolation(fragment: string): void {
  const index = fixtureGuardViolations.findIndex((entry) =>
    entry.includes(fragment),
  );
  assert(
    index >= 0,
    `expected a recorded fixture guard violation containing ${JSON.stringify(fragment)}`,
  );
  fixtureGuardViolations.splice(index, 1);
}

async function installFixture(
  guard: ProvisioningGuardState,
  name: string,
  version: number,
  rows: SeedRows,
  options?: FixtureOptions,
): Promise<IDBDatabase> {
  const plan: OpenPlan = {
    name,
    version,
    oldVersion: 0,
    label: `${name}: fixture creation`,
  };
  const tracked = trackedOpen(guard, plan);
  return withWatchdog(
    new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      tracked.request.onupgradeneeded = (event) => {
        try {
          const versionEvent = event as IDBVersionChangeEvent;
          equal(
            versionEvent.oldVersion,
            0,
            `${name}: fixture creation oldVersion`,
          );
          equal(
            versionEvent.newVersion,
            version,
            `${name}: fixture creation newVersion`,
          );
          const db = tracked.request.result;
          equal(
            db.objectStoreNames.length,
            0,
            `${name}: fresh fixture found pre-existing stores`,
          );
          assert(
            tracked.freshWriteVerified(),
            `${name}: fixture schema write attempted before fresh-write verification`,
          );
          createV1Stores(db, options);
          if (version === V2_VERSION) createJournalStore(db);
          seedRowsInUpgrade(tracked, rows, `${name}: fixture seed`, options);
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
        fail(new Error(`${name}: fixture open blocked`));
      tracked.request.onerror = () =>
        fail(
          tracked.request.error ??
            new Error(`${name}: fixture open request failed`),
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
          settled = true;
          resolve(db);
        } catch (error) {
          db.close();
          fail(error);
        }
      };
    }),
    `${name}: create fixture`,
  );
}

async function openRaw(
  guard: ProvisioningGuardState,
  name: string,
  version: number,
): Promise<IDBDatabase> {
  const tracked = trackedOpen(guard, {
    name,
    version,
    oldVersion: "none",
    label: `${name}: raw existing open`,
  });
  return withWatchdog(
    new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
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
        fail(new Error(`${name}: expected an existing database, got an upgrade`));
      };
      tracked.request.onblocked = () =>
        fail(new Error(`${name}: existing open blocked`));
      tracked.request.onerror = () =>
        fail(
          tracked.request.error ??
            new Error(`${name}: existing open request failed`),
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
    }),
    `${name}: open existing`,
  );
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

async function readFixture(
  guard: ProvisioningGuardState,
  name: string,
  version: number,
  stores: readonly string[] = V1_STORE_NAMES,
): Promise<Record<string, unknown[]>> {
  const db = await openRaw(guard, name, version);
  try {
    return await readStores(db, stores, `${name}: read fixture`);
  } finally {
    db.close();
  }
}

// Proves a fixture name is still absent without creating it: the early guard
// sees oldVersion 0, then this handler aborts before any store is created.
async function assertDatabaseAbsent(
  guard: ProvisioningGuardState,
  name: string,
): Promise<void> {
  const tracked = trackedOpen(guard, {
    name,
    version: V1_VERSION,
    oldVersion: 0,
    label: `${name}: absence check`,
  });
  await withWatchdog(
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      tracked.request.onupgradeneeded = (event) => {
        try {
          equal(
            (event as IDBVersionChangeEvent).oldVersion,
            0,
            `${name}: absence check did not see oldVersion 0`,
          );
          tracked.request.transaction?.abort();
        } catch (error) {
          fail(error);
        }
      };
      tracked.request.onblocked = () =>
        fail(new Error(`${name}: absence check was blocked`));
      tracked.request.onerror = () => {
        try {
          const error = tracked.request.error;
          assert(
            error?.name === "AbortError",
            `${name}: absence check error was ${String(error?.name)}`,
          );
          settled = true;
          resolve();
        } catch (caught) {
          fail(caught);
        }
      };
      tracked.request.onsuccess = () => {
        tracked.request.result.close();
        fail(new Error(`${name}: expected absence, but the database opened`));
      };
    }),
    `${name}: absence check`,
  );
}

// A live-connection probe: open a higher version. A versionchange event on the
// suspect handle proves it is still open; an upgradeneeded event proves no
// connection intercepted the probe. The probe aborts its own upgrade.
async function probeLiveConnection(
  guard: ProvisioningGuardState,
  name: string,
  handle: IDBDatabase,
): Promise<"closed" | "leaked"> {
  const tracked = trackedOpen(guard, {
    name,
    version: PROBE_VERSION,
    oldVersion: "any",
    label: `${name}: live connection probe`,
  });
  const outcome = deferred<"closed" | "leaked">();
  let versionChanged = false;
  const onVersionChange = (): void => {
    versionChanged = true;
    try {
      handle.close();
    } catch {
      // Closing the leaked handle is best effort; the outcome is recorded.
    }
    outcome.resolve("leaked");
  };
  handle.addEventListener("versionchange", onVersionChange, { once: true });
  tracked.request.onupgradeneeded = () => {
    try {
      tracked.request.transaction?.abort();
    } catch {
      // The probe upgrade transaction may already be inactive.
    }
    if (!versionChanged) outcome.resolve("closed");
  };
  tracked.request.onblocked = () => {
    // A blocked probe implies a live connection that did not intercept the
    // versionchange event. Record it rather than hiding it.
    outcome.resolve("leaked");
  };
  tracked.request.onerror = () => {
    if (!versionChanged) outcome.resolve("closed");
  };
  tracked.request.onsuccess = () => {
    try {
      tracked.request.result.close();
    } catch {
      // The result may be unavailable.
    }
    if (!versionChanged) outcome.resolve("closed");
  };
  try {
    return await withWatchdog(
      outcome.promise,
      `${name}: live connection probe`,
    );
  } finally {
    handle.removeEventListener("versionchange", onVersionChange);
    try {
      if (tracked.request.readyState === "done") {
        tracked.request.result?.close();
      }
    } catch {
      // The probe result may be unreadable.
    }
    try {
      handle.close();
    } catch {
      // The handle may already be closed or have an injected close failure.
    }
  }
}

function assertClosedHandle(db: IDBDatabase, label: string): void {
  let failure: unknown;
  try {
    // An empty scope: a closed handle raises InvalidStateError before the
    // empty-scope check, while an open handle raises InvalidAccessError.
    db.transaction([], "readonly");
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

const PROVISIONING_CATEGORIES: readonly BrowserProvisioningErrorCategory[] = [
  "missing",
  "incompatible",
  "blocked",
  "busy",
  "recheck-required",
  "not-authorized",
  "transient",
  "indeterminate",
];

async function expectProvisioningError(
  operation: Promise<unknown>,
  label: string,
): Promise<BrowserProvisioningError> {
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
    failure instanceof BrowserProvisioningError,
    `${label}: expected a BrowserProvisioningError, got ${String(failure)}`,
  );
  return failure;
}

function assertProvisioningCategory(
  error: BrowserProvisioningError,
  expected: BrowserProvisioningErrorCategory,
  fixtureName: string,
  label: string,
): void {
  equal(error.category, expected, `${label}: provisioning error category`);
  assert(
    PROVISIONING_CATEGORIES.includes(error.category),
    `${label}: category is outside the fixed provisioning categories`,
  );
  assert(
    error.name === "BrowserProvisioningError",
    `${label}: unexpected public error name ${error.name}`,
  );
  assert(
    typeof error.message === "string" && error.message.length > 0,
    `${label}: rejection had no public message`,
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
  assert(
    !error.message.includes(fixtureName),
    `${label}: rejection leaked the fixture database name`,
  );
  assert(
    !error.message.includes(PRODUCTION_DB_NAME),
    `${label}: rejection leaked the production database name`,
  );
}

function assertStatus(
  status: ProvisioningStatus,
  expected: Partial<ProvisioningStatus>,
  label: string,
): void {
  if (expected.phase !== undefined) {
    equal(status.phase, expected.phase, `${label}: status phase`);
  }
  if (expected.observedExistingDatabase !== undefined) {
    equal(
      status.observedExistingDatabase,
      expected.observedExistingDatabase,
      `${label}: observedExistingDatabase`,
    );
  }
  if (expected.eligibleForConfirmation !== undefined) {
    equal(
      status.eligibleForConfirmation,
      expected.eligibleForConfirmation,
      `${label}: eligibleForConfirmation`,
    );
  }
  if (expected.recheckRequired !== undefined) {
    equal(
      status.recheckRequired,
      expected.recheckRequired,
      `${label}: recheckRequired`,
    );
  }
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

// ---------------------------------------------------------------------------
// Coordinator harness.
// ---------------------------------------------------------------------------

interface Harness {
  readonly manager: BrowserProvisioning;
  readonly name: string;
  readonly targetName: string;
  readonly targetVersion: number;
  readonly requests: TrackedRequest[];
  readonly requestCount: () => number;
  readonly lastRequest: () => TrackedRequest;
  readonly enqueue: (plan: OpenPlan) => void;
  readonly expectFresh: (name?: string, version?: number) => void;
  readonly expectExisting: (name?: string, version?: number) => void;
  readonly expectNoUpgrade: (name?: string, version?: number) => void;
  readonly expectNoneOrFresh: (name?: string, version?: number) => void;
  readonly setFactoryImpl: (
    impl: ((plan: OpenPlan, open: () => TrackedRequest) => IDBOpenDBRequest) | null,
  ) => void;
  readonly setCreateSchema: (
    callback: (db: IDBDatabase) => unknown,
  ) => void;
  readonly setValidator: (callback: (db: IDBDatabase) => unknown) => void;
  readonly createCalls: () => number;
  readonly validateCalls: () => number;
}

interface HarnessOptions {
  readonly name: string;
  readonly targetName?: string;
  readonly targetVersion?: number;
}

function createHarness(
  guard: ProvisioningGuardState,
  options: HarnessOptions,
): Harness {
  const targetName = options.targetName ?? options.name;
  const targetVersion = options.targetVersion ?? V1_VERSION;
  const subscribedHooks: RequestHooks[] = [];
  const plans: OpenPlan[] = [];
  const requests: TrackedRequest[] = [];
  let createSchemaImpl: (db: IDBDatabase) => unknown = () => undefined;
  let validateImpl: (db: IDBDatabase) => unknown = validateRequiredV1Schema;
  let factoryImpl:
    | ((plan: OpenPlan, open: () => TrackedRequest) => IDBOpenDBRequest)
    | null = null;
  let createCalls = 0;
  let validateCalls = 0;

  function openPlanned(plan: OpenPlan): TrackedRequest {
    const hooks = subscribedHooks.shift();
    const tracked = trackedOpen(guard, plan, hooks);
    requests.push(tracked);
    return tracked;
  }

  const manager = createBrowserProvisioning(
    { name: targetName, version: targetVersion },
    () => {
      const plan = plans.shift();
      assert(plan, `${options.name}: coordinator issued an unplanned request`);
      if (factoryImpl) {
        return factoryImpl(plan, () => openPlanned(plan));
      }
      return openPlanned(plan).request;
    },
    (db) => {
      validateCalls += 1;
      return validateImpl(db) as boolean;
    },
    (db) => {
      const tracked = requests[requests.length - 1];
      if (!tracked || !tracked.freshWriteVerified()) {
        const message = `${options.name}: createSchema ran before fresh-write verification (exact fixture/version/oldVersion 0/live transaction)`;
        harnessViolations.push(message);
        throw new Error(message);
      }
      createCalls += 1;
      return createSchemaImpl(db) as void;
    },
  );

  function plan(
    oldVersion: OldVersionExpectation,
    name: string = targetName,
    version: number = targetVersion,
    label: string = `${options.name}: planned request`,
  ): OpenPlan {
    return { name, version, oldVersion, label };
  }

  return {
    manager,
    name: options.name,
    targetName,
    targetVersion,
    requests,
    requestCount: () => requests.length,
    lastRequest: () => {
      assert(
        requests.length > 0,
        `${options.name}: the coordinator created no request`,
      );
      return requests[requests.length - 1];
    },
    enqueue: (value) => plans.push(value),
    expectFresh: (name = targetName, version = targetVersion) =>
      plans.push(plan(0, name, version, `${options.name}: fresh open`)),
    expectExisting: (name = targetName, version = targetVersion) =>
      plans.push(plan("none", name, version, `${options.name}: existing open`)),
    expectNoUpgrade: (name = targetName, version = targetVersion) =>
      plans.push(plan("none", name, version, `${options.name}: no-upgrade open`)),
    expectNoneOrFresh: (name = targetName, version = targetVersion) =>
      plans.push(
        plan("none-or-0", name, version, `${options.name}: concurrent create`),
      ),
    setFactoryImpl: (impl) => {
      factoryImpl = impl;
    },
    setCreateSchema: (callback) => {
      createSchemaImpl = callback;
    },
    setValidator: (callback) => {
      validateImpl = callback;
    },
    createCalls: () => createCalls,
    validateCalls: () => validateCalls,
  };
}

// Every handle published by the coordinator under test is registered here and
// explicitly closed in the scenario's finally block once the coordinator is no
// longer used, including when an assertion fails mid-scenario.
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
  label: string,
  operation: () => Promise<string>,
): Promise<void> {
  try {
    outcomes.push(await operation());
  } finally {
    closeManagerPublishedHandles(label);
  }
}

function currentRequestForCreate(harness: Harness): TrackedRequest {
  return harness.lastRequest();
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

async function absentDefault(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran during an existing-only open`);
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: absent open`,
  );
  assertProvisioningCategory(missing, "missing", name, `${name}: absent open`);
  equal(harness.requestCount(), 1, `${name}: absent open request count`);
  equal(harness.createCalls(), 0, `${name}: createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "missing",
      observedExistingDatabase: false,
      eligibleForConfirmation: true,
      recheckRequired: false,
    },
    `${name}: status after missing`,
  );

  const request = harness.lastRequest();
  equal(
    request.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${name}: absent open upgrade event`,
  );
  equal(
    await withWatchdog(request.settled, `${name}: absent request terminal`),
    "error",
    `${name}: absent open terminal outcome`,
  );
  equal(
    request.errorName(),
    "AbortError",
    `${name}: absent open terminal error name`,
  );
  assert(request.transactionAborted(), `${name}: absent open saw no tx abort`);
  assert(
    request.events.indexOf("transaction-abort") >= 0 &&
      request.events.indexOf("transaction-abort") <
        request.events.indexOf("error"),
    `${name}: transaction abort was not observed before the terminal error: ${request.events.join(",")}`,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: repeated absent open ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "missing",
      name,
      `${name}: repeated absent open ${attempt + 1}`,
    );
  }
  equal(
    harness.requestCount(),
    1,
    `${name}: repeated openExisting calls enqueued another request`,
  );
  equal(harness.createCalls(), 0, `${name}: repeated opens ran createSchema`);

  await assertDatabaseAbsent(guard, name);

  return "an absent default open observed oldVersion 0, aborted the versionchange transaction before any creation callback, reported missing only after the transaction abort and terminal AbortError (abort observed before error), and repeated openExisting calls rejected from cache without enqueuing another request";
}

async function explicitCheckAgain(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.expectFresh();
  const first = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: initial check`,
  );
  assertProvisioningCategory(first, "missing", name, `${name}: initial check`);
  equal(harness.requestCount(), 1, `${name}: initial request count`);

  const cached = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: cached check`,
  );
  assertProvisioningCategory(cached, "missing", name, `${name}: cached check`);
  equal(harness.requestCount(), 1, `${name}: cached check request count`);

  harness.expectFresh();
  const explicitMissing = await expectProvisioningError(
    harness.manager.checkExistingAgain(),
    `${name}: explicit missing check`,
  );
  assertProvisioningCategory(
    explicitMissing,
    "missing",
    name,
    `${name}: explicit missing check`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: explicit check did not start exactly one new request`,
  );

  const rows = syntheticRows(`${name}-check-again`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: fixture rows before explicit check`,
  );

  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.checkExistingAgain(),
      `${name}: explicit existing check`,
    ),
  );
  equal(
    harness.requestCount(),
    3,
    `${name}: explicit existing check request count`,
  );
  equal(harness.validateCalls(), 1, `${name}: validation calls`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "existing",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: status after explicit existing check`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after explicit existing check`,
  );

  const shared = await harness.manager.openExisting();
  assert(shared === handle, `${name}: cached open did not share the handle`);
  equal(harness.requestCount(), 3, `${name}: cached existing open request count`);
  equal(harness.validateCalls(), 1, `${name}: cached open revalidated`);

  return "an explicit checkExistingAgain bypassed the cached missing result, started exactly one new check, discovered a database that appeared afterwards, and the cached existing open shared the published handle without revalidating";
}

async function reloadNewCoordinator(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const first = createHarness(guard, { name });
  first.expectFresh();
  const missing = await expectProvisioningError(
    first.manager.openExisting(),
    `${name}: first coordinator check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: first coordinator check`,
  );
  assertStatus(
    first.manager.getStatus(),
    { eligibleForConfirmation: true },
    `${name}: first coordinator eligibility`,
  );

  const reloaded = createHarness(guard, { name });
  reloaded.expectFresh();
  const reloadedMissing = await expectProvisioningError(
    reloaded.manager.openExisting(),
    `${name}: reloaded coordinator check`,
  );
  assertProvisioningCategory(
    reloadedMissing,
    "missing",
    name,
    `${name}: reloaded coordinator check`,
  );
  equal(
    reloaded.requestCount(),
    1,
    `${name}: reloaded coordinator request count`,
  );
  equal(
    reloaded.createCalls(),
    0,
    `${name}: reloaded coordinator ran createSchema`,
  );
  assertStatus(
    reloaded.manager.getStatus(),
    {
      phase: "missing",
      eligibleForConfirmation: true,
      recheckRequired: false,
    },
    `${name}: reloaded coordinator status`,
  );

  await assertDatabaseAbsent(guard, name);

  return "a new coordinator performed its own existing-only check, reported missing, started exactly one check request, and created nothing; no cached missing observation or creation attempt carried across the coordinator instance";
}

async function noConfirmNoRequest(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran without confirmation`);
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: missing check`,
  );
  assertProvisioningCategory(missing, "missing", name, `${name}: missing check`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "missing", eligibleForConfirmation: true },
    `${name}: eligible status`,
  );
  equal(harness.requestCount(), 1, `${name}: missing request count`);

  // The caller cancels by never calling confirmCreateOnce.
  await flushTaskTurn(`${name}: no-confirm checkpoint`);
  equal(
    harness.requestCount(),
    1,
    `${name}: a request was started without confirmation`,
  );
  equal(harness.createCalls(), 0, `${name}: createSchema ran without confirmation`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: repeated open after cancel ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "missing",
      name,
      `${name}: repeated open after cancel ${attempt + 1}`,
    );
  }
  equal(
    harness.requestCount(),
    1,
    `${name}: repeated opens after cancel started a request`,
  );

  await assertDatabaseAbsent(guard, name);

  return "a confirmed missing check alone started no creation request, ran no creation callback, and left the database absent; without confirmCreateOnce the one-shot eligibility is never consumed";
}

async function confirmCreateOnce(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-created`);
  const harness = createHarness(guard, { name });
  harness.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      rows,
      `${name}: create`,
    );
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );
  equal(harness.requestCount(), 1, `${name}: pre-create request count`);

  harness.expectFresh();
  const outcome = await withWatchdog(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm create`,
  );
  equal(outcome, "created", `${name}: create outcome`);
  equal(harness.requestCount(), 2, `${name}: create request count`);
  equal(harness.createCalls(), 1, `${name}: createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "created",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: status after create`,
  );

  const createRequest = harness.lastRequest();
  equal(
    createRequest.upgrades,
    [{ oldVersion: 0, newVersion: V1_VERSION }],
    `${name}: create upgrade event`,
  );
  equal(
    await withWatchdog(createRequest.settled, `${name}: create terminal`),
    "success",
    `${name}: create terminal outcome`,
  );
  assertClosedHandle(
    createRequest.request.result,
    `${name}: created handle was not closed`,
  );

  const second = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: second confirm`,
  );
  assertProvisioningCategory(
    second,
    "not-authorized",
    name,
    `${name}: second confirm`,
  );
  equal(harness.requestCount(), 2, `${name}: second confirm started a request`);
  equal(harness.createCalls(), 1, `${name}: second confirm ran createSchema`);

  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing check after create`,
    ),
  );
  assert(handle.name === name, `${name}: published handle belongs to another database`);
  equal(
    harness.requestCount(),
    3,
    `${name}: existing check after create request count`,
  );
  equal(harness.validateCalls(), 2, `${name}: validation after create`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "existing",
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: status after create existing check`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: created rows`,
  );

  return "confirmCreateOnce consumed its one-shot eligibility, started exactly one unique request, invoked createSchema exactly once only on a real oldVersion 0 event with the bound target, validated the created schema before reporting created, closed the created handle instead of publishing it, refused a second confirmation, and a separate existing check then published a validated handle with the expected rows";
}

async function doubleConfirmBusy(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-double`);
  const harness = createHarness(guard, { name });
  harness.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      rows,
      `${name}: create`,
    );
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const first = harness.manager.confirmCreateOnce();
  const second = harness.manager.confirmCreateOnce();
  const read = harness.manager.openExisting();
  const explicitRead = harness.manager.checkExistingAgain();
  // Attach rejection observers immediately so a busy rejection is not reported
  // as unhandled before the sequential awaits below. The original promises stay
  // rejected and are asserted individually.
  void second.catch(() => undefined);
  void read.catch(() => undefined);
  void explicitRead.catch(() => undefined);

  const secondError = await expectProvisioningError(
    second,
    `${name}: double confirm`,
  );
  assertProvisioningCategory(
    secondError,
    "busy",
    name,
    `${name}: double confirm`,
  );
  const readError = await expectProvisioningError(
    read,
    `${name}: read during create`,
  );
  assertProvisioningCategory(readError, "busy", name, `${name}: read during create`);
  const explicitReadError = await expectProvisioningError(
    explicitRead,
    `${name}: explicit read during create`,
  );
  assertProvisioningCategory(
    explicitReadError,
    "busy",
    name,
    `${name}: explicit read during create`,
  );

  const outcome = await withWatchdog(first, `${name}: first confirm`);
  equal(outcome, "created", `${name}: first confirm outcome`);
  equal(harness.requestCount(), 2, `${name}: request count after double confirm`);
  equal(harness.createCalls(), 1, `${name}: createSchema calls after double confirm`);

  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing check after double`,
    ),
  );
  assert(handle.name === name, `${name}: published handle belongs to another database`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after double confirm`,
  );

  return "a synchronous double confirm was rejected as busy, and ordinary openExisting/checkExistingAgain calls during the creation attempt were also rejected as busy without joining or extending the one-shot eligibility; exactly one schema creation occurred";
}

async function existingAppearsBeforeCreate(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const unexpectedRows = syntheticRows(`${name}-unexpected-create`);
  const harness = createHarness(guard, { name });
  harness.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      unexpectedRows,
      `${name}: unexpected create`,
    );
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: missing check`,
  );
  assertProvisioningCategory(missing, "missing", name, `${name}: missing check`);

  const rows = syntheticRows(`${name}-appeared`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows before create attempt`,
  );

  harness.expectNoUpgrade();
  const outcome = await withWatchdog(
    harness.manager.confirmCreateOnce(),
    `${name}: create after appearance`,
  );
  equal(outcome, "existing-found", `${name}: create outcome`);
  equal(harness.requestCount(), 2, `${name}: create request count`);
  equal(
    harness.createCalls(),
    0,
    `${name}: createSchema ran for an existing database`,
  );
  equal(harness.validateCalls(), 0, `${name}: existing-found validation calls`);

  const createRequest = harness.lastRequest();
  equal(createRequest.upgrades, [], `${name}: existing database was upgraded`);
  equal(
    await withWatchdog(createRequest.settled, `${name}: create terminal`),
    "success",
    `${name}: create terminal outcome`,
  );
  assertClosedHandle(
    createRequest.request.result,
    `${name}: create attempt published or leaked a handle`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "existing-unverified",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: true,
    },
    `${name}: status after existing-found`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after existing-found`,
  );

  // Ordinary opens, including simulated query retries, must not reopen.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after existing-found ${attempt + 1}`,
    );
    assertProvisioningCategory(
      retry,
      "recheck-required",
      name,
      `${name}: retry after existing-found ${attempt + 1}`,
    );
  }
  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after existing-found`,
  );
  assertProvisioningCategory(
    confirm,
    "recheck-required",
    name,
    `${name}: confirm after existing-found`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: ordinary retries after existing-found started a request`,
  );

  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.checkExistingAgain(),
      `${name}: explicit check after existing-found`,
    ),
  );
  assert(handle.name === name, `${name}: published handle belongs to another database`);
  equal(
    harness.requestCount(),
    3,
    `${name}: explicit check after existing-found request count`,
  );
  equal(harness.validateCalls(), 1, `${name}: validation after existing-found`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "existing", recheckRequired: false },
    `${name}: status after explicit check`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after post-create existing check`,
  );

  return "a database that appeared between the missing check and confirmCreateOnce was reported as existing-found, closed without publishing a handle, never passed to createSchema, left its rows unchanged, and blocked repeated ordinary openExisting/confirm calls as recheck-required until exactly one explicit checkExistingAgain";
}

async function twoCoordinatorRace(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const first = createHarness(guard, { name });
  const second = createHarness(guard, { name });

  first.expectFresh();
  second.expectFresh();
  const [firstResult, secondResult] = await Promise.allSettled([
    first.manager.openExisting(),
    second.manager.openExisting(),
  ]);
  assert(
    firstResult.status === "rejected",
    `${name}: first racing open unexpectedly resolved`,
  );
  assert(
    secondResult.status === "rejected",
    `${name}: second racing open unexpectedly resolved`,
  );
  assert(
    firstResult.reason instanceof BrowserProvisioningError,
    `${name}: first racing open returned a non-provisioning error`,
  );
  assert(
    secondResult.reason instanceof BrowserProvisioningError,
    `${name}: second racing open returned a non-provisioning error`,
  );
  assertProvisioningCategory(
    firstResult.reason,
    "missing",
    name,
    `${name}: first racing open`,
  );
  assertProvisioningCategory(
    secondResult.reason,
    "missing",
    name,
    `${name}: second racing open`,
  );
  equal(first.requestCount(), 1, `${name}: first racing request count`);
  equal(second.requestCount(), 1, `${name}: second racing request count`);
  equal(first.createCalls(), 0, `${name}: first racing createSchema`);
  equal(second.createCalls(), 0, `${name}: second racing createSchema`);
  assertStatus(
    first.manager.getStatus(),
    { phase: "missing", eligibleForConfirmation: true },
    `${name}: first racing status`,
  );
  assertStatus(
    second.manager.getStatus(),
    { phase: "missing", eligibleForConfirmation: true },
    `${name}: second racing status`,
  );
  await assertDatabaseAbsent(guard, name);

  const rows = syntheticRows(`${name}-race`);
  first.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(first.lastRequest(), rows, `${name}: race create`);
  });
  first.expectFresh();
  const created = await withWatchdog(
    first.manager.confirmCreateOnce(),
    `${name}: first racing create`,
  );
  equal(created, "created", `${name}: first racing create outcome`);

  second.expectNoUpgrade();
  const existing = await withWatchdog(
    second.manager.confirmCreateOnce(),
    `${name}: stale racing create`,
  );
  equal(existing, "existing-found", `${name}: stale racing create outcome`);
  equal(first.createCalls(), 1, `${name}: created schema count`);
  equal(second.createCalls(), 0, `${name}: stale coordinator ran createSchema`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after racing create`,
  );

  return "two coordinators racing the same absent fixture both reported missing without creating anything; a later create from one and a stale create from the other produced exactly one schema creation and one existing-found outcome, with no duplicate writes";
}

async function existingV1ValidateOnly(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-existing`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();
  const before = await readFixture(guard, name, V1_VERSION);
  equal(before, rows, `${name}: seeded rows before validation`);

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing open`,
    ),
  );
  assert(handle.name === name, `${name}: published handle belongs to another database`);
  equal(harness.requestCount(), 1, `${name}: existing request count`);
  equal(harness.validateCalls(), 1, `${name}: validation calls`);
  equal(harness.createCalls(), 0, `${name}: createSchema calls`);
  equal(harness.lastRequest().upgrades, [], `${name}: existing open upgraded`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "existing",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: existing status`,
  );
  equal(
    validateRequiredV1Schema(handle),
    true,
    `${name}: published schema`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after validation`,
  );

  const cached = await harness.manager.openExisting();
  assert(cached === handle, `${name}: cached open did not share the handle`);
  equal(harness.requestCount(), 1, `${name}: cached open request count`);
  equal(harness.validateCalls(), 1, `${name}: cached open revalidated`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after cached open`,
  );

  return "an existing synthetic v1 database with an orphan history row and schema marker was validated by reading its schema only and published; the exact rows, indexes, stores, and metadata were unchanged, and a cached second open shared the same handle without revalidating or writing";
}

async function schemaMismatchMissingStore(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const fullRows = syntheticRows(`${name}-mismatch`);
  const rows = { ...fullRows };
  delete rows[STORE_META];
  const options: FixtureOptions = {
    omitStore: STORE_META,
    omitIndex: { store: STORE_VIDEOS, index: "youtubeId" },
  };
  const fixture = await installFixture(guard, name, V1_VERSION, rows, options);
  fixture.close();
  const before = await readFixture(guard, name, V1_VERSION, [
    STORE_PLAYLISTS,
    STORE_VIDEOS,
    STORE_PLAY_HISTORY,
  ]);
  equal(before, rows, `${name}: seeded rows before mismatch validation`);

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const incompatible = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: mismatch open`,
  );
  assertProvisioningCategory(
    incompatible,
    "incompatible",
    name,
    `${name}: mismatch open`,
  );
  equal(harness.requestCount(), 1, `${name}: mismatch request count`);
  equal(harness.validateCalls(), 1, `${name}: mismatch validation calls`);
  equal(harness.createCalls(), 0, `${name}: mismatch createSchema calls`);
  assertClosedHandle(
    harness.lastRequest().request.result,
    `${name}: incompatible handle was not closed`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "incompatible",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: mismatch status`,
  );

  const cached = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: cached mismatch open`,
  );
  assertProvisioningCategory(
    cached,
    "incompatible",
    name,
    `${name}: cached mismatch open`,
  );
  equal(harness.requestCount(), 1, `${name}: cached mismatch request count`);

  harness.expectExisting();
  const explicit = await expectProvisioningError(
    harness.manager.checkExistingAgain(),
    `${name}: explicit mismatch check`,
  );
  assertProvisioningCategory(
    explicit,
    "incompatible",
    name,
    `${name}: explicit mismatch check`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: explicit mismatch check request count`,
  );
  equal(harness.validateCalls(), 2, `${name}: explicit mismatch validation calls`);
  equal(
    await readFixture(guard, name, V1_VERSION, [
      STORE_PLAYLISTS,
      STORE_VIDEOS,
      STORE_PLAY_HISTORY,
    ]),
    rows,
    `${name}: rows after explicit mismatch check`,
  );

  return "a fixture that actually omitted the required meta store and the videos.youtubeId index was reported incompatible, the unpublished handle was closed, rows were unchanged, the cached incompatibility served without a new request, and only an explicit check retried";
}

async function schemaExtraAccepted(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-extra`);
  rows[EXTRA_STORE] = [
    { id: `extra-${crypto.randomUUID()}`, marker: "harmless-extra-row" },
  ];
  const options: FixtureOptions = {
    extraStore: EXTRA_STORE,
    extraIndex: EXTRA_INDEX,
  };
  const fixture = await installFixture(guard, name, V1_VERSION, rows, options);
  fixture.close();
  const stores = [...V1_STORE_NAMES, EXTRA_STORE];
  const before = await readFixture(guard, name, V1_VERSION, stores);
  equal(before, rows, `${name}: seeded rows before extra-schema validation`);

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: extra-schema open`,
    ),
  );
  equal(harness.requestCount(), 1, `${name}: extra-schema request count`);
  equal(harness.validateCalls(), 1, `${name}: extra-schema validation calls`);
  equal(harness.createCalls(), 0, `${name}: extra-schema createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "existing", eligibleForConfirmation: false },
    `${name}: extra-schema status`,
  );
  const schema = readSchema(handle);
  assert(
    schema.some((store) => store.name === EXTRA_STORE),
    `${name}: extra store was not present on the published handle`,
  );
  assert(
    schema.some((store) =>
      store.indexes.some((index) => index.name === EXTRA_INDEX),
    ),
    `${name}: extra index was not present on the published handle`,
  );
  equal(
    await readFixture(guard, name, V1_VERSION, stores),
    rows,
    `${name}: rows after extra-schema validation`,
  );

  return "the required-subset validator accepted a v1 database with an extra harmless store and index, published the existing handle, and preserved the extra row and the required schema unchanged";
}

async function versionError(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-version`);
  const fixture = await installFixture(guard, name, V2_VERSION, rows);
  fixture.close();
  const before = await readFixture(guard, name, V2_VERSION);
  equal(before, rows, `${name}: seeded rows before VersionError`);

  const harness = createHarness(guard, { name });
  harness.expectNoUpgrade(name, V1_VERSION);
  const incompatible = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: lower-version open`,
  );
  assertProvisioningCategory(
    incompatible,
    "incompatible",
    name,
    `${name}: lower-version open`,
  );
  equal(harness.requestCount(), 1, `${name}: VersionError request count`);
  equal(harness.createCalls(), 0, `${name}: VersionError createSchema calls`);
  equal(
    harness.lastRequest().errorName(),
    "VersionError",
    `${name}: terminal error name`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "incompatible",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: VersionError status`,
  );
  equal(
    await readFixture(guard, name, V2_VERSION),
    rows,
    `${name}: rows after VersionError`,
  );

  const cached = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: cached VersionError open`,
  );
  assertProvisioningCategory(
    cached,
    "incompatible",
    name,
    `${name}: cached VersionError open`,
  );
  equal(harness.requestCount(), 1, `${name}: cached VersionError request count`);

  harness.expectNoUpgrade(name, V1_VERSION);
  const explicit = await expectProvisioningError(
    harness.manager.checkExistingAgain(),
    `${name}: explicit VersionError check`,
  );
  assertProvisioningCategory(
    explicit,
    "incompatible",
    name,
    `${name}: explicit VersionError check`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: explicit VersionError request count`,
  );
  equal(
    await readFixture(guard, name, V2_VERSION),
    rows,
    `${name}: rows after explicit VersionError`,
  );

  return "a native VersionError from opening an existing v2 fixture at v1 reported incompatible, recorded that an existing database was observed, started no upgrade or creation callback, left the v2 fixture rows unchanged, and cached the incompatibility until an explicit check";
}

async function blockedDrainRevokesCreate(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran after a blocked upgrade`);
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-block missing check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-block missing check`,
  );
  assertStatus(
    harness.manager.getStatus(),
    { phase: "missing", eligibleForConfirmation: true },
    `${name}: eligibility before block`,
  );

  const rows = syntheticRows(`${name}-blocked`);
  // INTENTIONALLY PRE-SEEDED v1 FIXTURE: this is not a fresh fixture. The
  // coordinator's blocked create request is at v2 on this existing v1 database.
  const blocker = await installFixture(guard, name, V1_VERSION, rows);
  try {
    equal(
      await readFixture(guard, name, V1_VERSION),
      rows,
      `${name}: rows before blocked create`,
    );

    // The blocked create is requested at v2 on the intentionally pre-seeded v1
    // fixture, so its eventual late upgrade must report oldVersion 1.
    harness.enqueue({
      name,
      version: V2_VERSION,
      oldVersion: V1_VERSION,
      label: `${name}: blocked v1->v2 create`,
    });
    const blocked = await expectProvisioningError(
      harness.manager.confirmCreateOnce(),
      `${name}: blocked confirm`,
    );
    assertProvisioningCategory(
      blocked,
      "blocked",
      name,
      `${name}: blocked confirm`,
    );
    equal(harness.requestCount(), 2, `${name}: blocked request count`);
    equal(harness.createCalls(), 0, `${name}: blocked createSchema calls`);
    assertStatus(
      harness.manager.getStatus(),
      { phase: "draining", eligibleForConfirmation: false },
      `${name}: status after blocked`,
    );

    const duringOpen = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: open during drain`,
    );
    assertProvisioningCategory(
      duringOpen,
      "busy",
      name,
      `${name}: open during drain`,
    );
    const duringCheck = await expectProvisioningError(
      harness.manager.checkExistingAgain(),
      `${name}: explicit check during drain`,
    );
    assertProvisioningCategory(
      duringCheck,
      "busy",
      name,
      `${name}: explicit check during drain`,
    );
    const duringConfirm = await expectProvisioningError(
      harness.manager.confirmCreateOnce(),
      `${name}: confirm during drain`,
    );
    assertProvisioningCategory(
      duringConfirm,
      "busy",
      name,
      `${name}: confirm during drain`,
    );
    equal(
      harness.requestCount(),
      2,
      `${name}: acquisitions during drain started a request`,
    );

    // Releasing the blocker lets the late v1->v2 upgrade run; the coordinator
    // must abort it before createSchema and leave the v1 fixture intact.
    blocker.close();
    const blockedRequest = harness.requests[1];
    equal(
      await withWatchdog(blockedRequest.settled, `${name}: drain terminal`),
      "error",
      `${name}: drain terminal outcome`,
    );
    equal(
      blockedRequest.errorName(),
      "AbortError",
      `${name}: drain terminal error name`,
    );
    assert(
      blockedRequest.transactionAborted(),
      `${name}: drained upgrade did not abort its transaction`,
    );
    equal(
      harness.createCalls(),
      0,
      `${name}: createSchema ran for the drained upgrade`,
    );
    await flushTaskTurn(`${name}: post-drain checkpoint`);

    const revoked = await expectProvisioningError(
      harness.manager.confirmCreateOnce(),
      `${name}: confirm after revoked eligibility`,
    );
    assertProvisioningCategory(
      revoked,
      "recheck-required",
      name,
      `${name}: confirm after revoked eligibility`,
    );
    equal(
      harness.requestCount(),
      2,
      `${name}: post-drain confirm started a request`,
    );

    // Ordinary opens, including simulated query retries, must not reopen.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await expectProvisioningError(
        harness.manager.openExisting(),
        `${name}: retry after drain ${attempt + 1}`,
      );
      assertProvisioningCategory(
        retry,
        "recheck-required",
        name,
        `${name}: retry after drain ${attempt + 1}`,
      );
    }
    equal(
      harness.requestCount(),
      2,
      `${name}: ordinary retries after drain started a request`,
    );
    assertStatus(
      harness.manager.getStatus(),
      {
        phase: "recheck-required",
        eligibleForConfirmation: false,
        recheckRequired: true,
      },
      `${name}: status after drain`,
    );
    equal(
      await readFixture(guard, name, V1_VERSION),
      rows,
      `${name}: rows after drained upgrade`,
    );

    harness.expectExisting();
    const recovered = registerPublishedHandle(
      await withWatchdog(
        harness.manager.checkExistingAgain(),
        `${name}: existing check after drain`,
      ),
    );
    assert(
      recovered.name === name,
      `${name}: published handle belongs to another database`,
    );
    equal(
      harness.requestCount(),
      3,
      `${name}: existing check after drain request count`,
    );
    equal(harness.validateCalls(), 1, `${name}: validation after drain`);
    assertStatus(
      harness.manager.getStatus(),
      { phase: "existing", recheckRequired: false },
      `${name}: status after drain recovery`,
    );
    equal(
      await readFixture(guard, name, V1_VERSION),
      rows,
      `${name}: rows after drain recovery`,
    );
  } finally {
    try {
      blocker.close();
    } catch {
      // The blocker may already be closed.
    }
  }

  return "a real blocked event during an authorized v2 creation on an intentionally pre-seeded v1 fixture rejected promptly and revoked creation eligibility; acquisitions during the drain were rejected busy without a request, the late v1->v2 upgrade was aborted before createSchema, repeated ordinary openExisting calls after the drain rejected recheck-required without a request, and only an explicit checkExistingAgain recovered a validated v1 handle with unchanged rows";
}

async function lateAbortSuccess(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  // The abort call throws, so the versionchange transaction is not aborted and
  // a real late success follows. The coordinator must close that late handle and
  // latch indeterminate.
  let lateHandle: IDBDatabase | null = null;
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran during an existing-only open`);
  });

  const hooks: RequestHooks = {
    onSuccess: (_request, db) => {
      lateHandle = db;
    },
    onUpgrade: (request) => {
      const transaction = request.transaction;
      if (transaction !== null) {
        defineOwn(transaction, "abort", {
          value: () => {
            throw new Error(`${name}: injected abort failure`);
          },
        });
      }
    },
  };
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, hooks);
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: abort-failure open`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: abort-failure open`,
  );
  assert(
    indeterminate.category !== "missing",
    `${name}: an unconfirmed abort was reported as a false missing result`,
  );
  equal(harness.requestCount(), 1, `${name}: abort-failure request count`);
  equal(harness.createCalls(), 0, `${name}: abort-failure createSchema calls`);

  const request = harness.lastRequest();
  equal(
    await withWatchdog(request.settled, `${name}: late success terminal`),
    "success",
    `${name}: late success terminal outcome`,
  );
  assert(lateHandle !== null, `${name}: late success produced no handle`);
  equal(
    await probeLiveConnection(guard, name, lateHandle),
    "closed",
    `${name}: late success left a live connection`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "indeterminate",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: indeterminate status`,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after indeterminate ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "indeterminate",
      name,
      `${name}: retry after indeterminate ${attempt + 1}`,
    );
  }
  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after indeterminate`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after indeterminate`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: retries after indeterminate started an open storm`,
  );

  // The un-aborted versionchange created an empty database. Read it
  // independently to record that no schema was written and no handle leaked.
  const empty = await openRaw(guard, name, V1_VERSION);
  try {
    equal(
      empty.objectStoreNames.length,
      0,
      `${name}: failed abort unexpectedly wrote stores`,
    );
  } finally {
    empty.close();
  }

  return "an injected versionchange abort failure produced an indeterminate result before a real late success; the late handle was closed instead of published, the coordinator never reported a false missing result, and repeated reads plus a confirmation all rejected the same latched indeterminate state without any retry or open storm (the failed abort did allow an empty database to be created, which is recorded rather than hidden)";
}

async function listenerRegistrationFailure(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran after a listener failure`);
  });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onTracked: (request) => {
        defineOwn(request, "addEventListener", {
          value: () => {
            throw new Error(`${name}: injected listener registration failure`);
          },
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: listener-failure open`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: listener-failure open`,
  );
  equal(harness.requestCount(), 1, `${name}: listener-failure request count`);
  equal(harness.createCalls(), 0, `${name}: listener-failure createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: listener-failure status`,
  );

  await withWatchdog(
    harness.lastRequest().settled,
    `${name}: listener-failure terminal`,
  );
  await assertDatabaseAbsent(guard, name);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after listener failure ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "indeterminate",
      name,
      `${name}: retry after listener failure ${attempt + 1}`,
    );
  }
  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after listener failure`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after listener failure`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: retries after listener failure started a new request`,
  );

  return "an injected request addEventListener registration failure latched indeterminate, started no new request, ran no creation callback, aborted its abandoned request, and left the fixture absent; repeated reads and a confirmation did not retry";
}

async function targetNameMismatch(
  guard: ProvisioningGuardState,
  targetName: string,
  otherName: string,
): Promise<string> {
  const harness = createHarness(guard, {
    name: targetName,
    targetName,
    targetVersion: V1_VERSION,
  });
  harness.setCreateSchema(() => {
    throw new Error(`${otherName}: createSchema ran for a different target`);
  });

  harness.expectFresh(targetName, V1_VERSION);
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${targetName}: check A`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    targetName,
    `${targetName}: check A`,
  );

  // The factory is asked for fixture B on the confirmation call. The bound
  // coordinator target is A, so the mismatch must be caught before schema code.
  harness.expectFresh(otherName, V1_VERSION);
  const mismatch = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${targetName}: create B`,
  );
  assertProvisioningCategory(
    mismatch,
    "indeterminate",
    targetName,
    `${targetName}: create B`,
  );
  equal(harness.requestCount(), 2, `${targetName}: target-mismatch request count`);
  equal(harness.createCalls(), 0, `${targetName}: target-mismatch createSchema`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "indeterminate",
      eligibleForConfirmation: false,
    },
    `${targetName}: target-mismatch status`,
  );
  await withWatchdog(
    harness.lastRequest().settled,
    `${targetName}: target-mismatch terminal`,
  );
  await assertDatabaseAbsent(guard, targetName);
  await assertDatabaseAbsent(guard, otherName);

  return "a missing check bound to target A followed by a confirmation request for fixture B was rejected indeterminate before createSchema, published no handle, and left both fixtures absent";
}

async function targetVersionMismatch(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, {
    name,
    targetName: name,
    targetVersion: V1_VERSION,
  });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran for a mismatched version`);
  });

  harness.expectFresh(name, V1_VERSION);
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: v1 check`,
  );
  assertProvisioningCategory(missing, "missing", name, `${name}: v1 check`);

  harness.expectFresh(name, V2_VERSION);
  const mismatch = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: v2 create`,
  );
  assertProvisioningCategory(
    mismatch,
    "indeterminate",
    name,
    `${name}: v2 create`,
  );
  equal(harness.requestCount(), 2, `${name}: version-mismatch request count`);
  equal(harness.createCalls(), 0, `${name}: version-mismatch createSchema`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: version-mismatch status`,
  );
  await withWatchdog(
    harness.lastRequest().settled,
    `${name}: version-mismatch terminal`,
  );
  await assertDatabaseAbsent(guard, name);

  return "a v1 missing check followed by a confirmation request for a fresh v2 database was rejected indeterminate before createSchema, published no handle, and left the fixture absent";
}

async function wrongExistingName(
  guard: ProvisioningGuardState,
  targetName: string,
  otherName: string,
): Promise<string> {
  const rows = syntheticRows(`${otherName}-wrong-name`);
  const fixture = await installFixture(guard, otherName, V1_VERSION, rows);
  fixture.close();

  const harness = createHarness(guard, {
    name: targetName,
    targetName,
    targetVersion: V1_VERSION,
  });
  // First check the bound target is absent, then explicitly check again and
  // receive an existing handle for a different fixture name.
  harness.expectFresh(targetName, V1_VERSION);
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${targetName}: check before wrong existing name`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    targetName,
    `${targetName}: check before wrong existing name`,
  );

  harness.expectExisting(otherName, V1_VERSION);
  const mismatch = await expectProvisioningError(
    harness.manager.checkExistingAgain(),
    `${targetName}: wrong existing name`,
  );
  assertProvisioningCategory(
    mismatch,
    "indeterminate",
    targetName,
    `${targetName}: wrong existing name`,
  );
  equal(harness.requestCount(), 2, `${targetName}: wrong-name request count`);
  equal(harness.createCalls(), 0, `${targetName}: wrong-name createSchema`);
  equal(harness.validateCalls(), 0, `${targetName}: wrong-name validation calls`);
  assertStatus(
    harness.manager.getStatus(),
    { observedExistingDatabase: true, eligibleForConfirmation: false },
    `${targetName}: wrong-name status`,
  );
  assertClosedHandle(
    harness.lastRequest().request.result,
    `${targetName}: wrong-name handle was not closed`,
  );
  equal(
    await readFixture(guard, otherName, V1_VERSION),
    rows,
    `${targetName}: wrong-name rows changed`,
  );

  return "after a missing check on the bound target, an explicit re-check returned an existing handle whose database name differed; the coordinator rejected it indeterminate, closed it without validation or publication, and left the other fixture's rows unchanged";
}

async function wrongExistingVersion(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-wrong-version`);
  const fixture = await installFixture(guard, name, V2_VERSION, rows);
  fixture.close();

  const harness = createHarness(guard, {
    name,
    targetName: name,
    targetVersion: V1_VERSION,
  });
  harness.expectNoUpgrade(name, V2_VERSION);
  const mismatch = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: wrong existing version`,
  );
  assertProvisioningCategory(
    mismatch,
    "indeterminate",
    name,
    `${name}: wrong existing version`,
  );
  equal(harness.requestCount(), 1, `${name}: wrong-version request count`);
  equal(harness.createCalls(), 0, `${name}: wrong-version createSchema`);
  equal(harness.validateCalls(), 0, `${name}: wrong-version validation calls`);
  assertStatus(
    harness.manager.getStatus(),
    { observedExistingDatabase: true, eligibleForConfirmation: false },
    `${name}: wrong-version status`,
  );
  assertClosedHandle(
    harness.lastRequest().request.result,
    `${name}: wrong-version handle was not closed`,
  );
  equal(
    await readFixture(guard, name, V2_VERSION),
    rows,
    `${name}: wrong-version rows changed`,
  );

  return "an existing v2 handle opened through a v1-bound coordinator was rejected indeterminate, closed without validation or publication, and left the v2 fixture rows unchanged";
}

async function createTransactionAbortSetupFailure(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema((db) => {
    createV1Stores(db);
    throw new Error(`${name}: createSchema ran without abort supervision`);
  });
  let injectAbortFailure = false;
  harness.setFactoryImpl((plan) => {
    const hooks: RequestHooks | undefined = injectAbortFailure
      ? {
          onUpgrade: (request) => {
            const transaction = request.transaction;
            assert(transaction, `${name}: creation upgrade had no transaction`);
            defineOwn(transaction, "addEventListener", {
              value: () => {
                throw new Error(
                  `${name}: injected transaction abort listener failure`,
                );
              },
            });
          },
        }
      : undefined;
    const tracked = trackedOpen(guard, plan, hooks);
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  injectAbortFailure = true;
  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: creation abort setup failure`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: creation abort setup failure`,
  );
  equal(harness.requestCount(), 2, `${name}: abort-setup request count`);
  equal(harness.createCalls(), 0, `${name}: abort-setup createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: abort-setup status`,
  );

  const createRequest = harness.lastRequest();
  await withWatchdog(createRequest.settled, `${name}: abort-setup terminal`);
  await assertDatabaseAbsent(guard, name);

  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after abort-setup failure`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after abort-setup failure`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: abort-setup retries started a request`,
  );

  return "an injected transaction abort-listener registration failure during creation latched indeterminate before createSchema, attempted to abort the upgrade, started no replacement request, and left the fixture absent";
}

async function factoryThrowsAfterStart(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran after a factory throw`);
  });
  let throwOnCreate = false;
  harness.setFactoryImpl((plan, openRequest) => {
    if (!throwOnCreate) return openRequest().request;
    openRequest();
    throw new Error(`${name}: injected factory throw after starting an open`);
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  throwOnCreate = true;
  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: factory throw`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: factory throw`,
  );
  equal(harness.requestCount(), 2, `${name}: factory-throw request count`);
  equal(harness.createCalls(), 0, `${name}: factory-throw createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: factory-throw status`,
  );

  const unsupervised = harness.lastRequest();
  equal(
    await withWatchdog(unsupervised.settled, `${name}: unsupervised terminal`),
    "success",
    `${name}: unsupervised terminal outcome`,
  );
  const empty = unsupervised.request.result;
  try {
    equal(
      empty.objectStoreNames.length,
      0,
      `${name}: unsupervised open unexpectedly wrote a schema`,
    );
  } finally {
    empty.close();
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after factory throw ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "indeterminate",
      name,
      `${name}: retry after factory throw ${attempt + 1}`,
    );
  }
  equal(
    harness.requestCount(),
    2,
    `${name}: retries after factory throw started an open storm`,
  );

  return "an injected factory throw after starting an open latched indeterminate before createSchema; the unsupervised request was awaited, observed to commit only an empty database, closed explicitly, and repeated reads did not start a request storm";
}

async function unreadableResult(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-unreadable`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();

  let captured: IDBDatabase | null = null;
  const harness = createHarness(guard, { name });
  harness.setValidator(() => {
    throw new Error(`${name}: validator ran for an unreadable result`);
  });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onTracked: (request) => {
        defineOwn(request, "result", {
          get: () => {
            throw new Error(`${name}: injected unreadable result`);
          },
        });
      },
      onSuccess: (request) => {
        captured = readNativeResult(request);
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectExisting();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: unreadable result`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: unreadable result`,
  );
  equal(harness.requestCount(), 1, `${name}: unreadable request count`);
  equal(harness.createCalls(), 0, `${name}: unreadable createSchema calls`);
  equal(harness.validateCalls(), 0, `${name}: unreadable validation calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: unreadable status`,
  );

  await withWatchdog(harness.lastRequest().settled, `${name}: unreadable terminal`);
  assert(captured !== null, `${name}: no native handle was captured for cleanup`);
  const handle = captured as IDBDatabase;
  handle.close();
  assertClosedHandle(handle, `${name}: unreadable handle cleanup`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after unreadable result`,
  );

  const repeated = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: retry after unreadable result`,
  );
  assertProvisioningCategory(
    repeated,
    "indeterminate",
    name,
    `${name}: retry after unreadable result`,
  );
  equal(harness.requestCount(), 1, `${name}: unreadable retry started a request`);

  return "a native success whose result getter threw was rejected indeterminate without validation, the real handle was recovered through the native accessor and closed explicitly, the fixture rows were unchanged, and a later ordinary open did not retry";
}

async function failedClose(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-close`);
  let closeInjected = false;
  let captured: IDBDatabase | null = null;
  const harness = createHarness(guard, { name });
  harness.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      rows,
      `${name}: create`,
    );
  });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onSuccess: (request, db) => {
        assert(db, `${name}: close-fault request produced no handle`);
        captured = db;
        const nativeClose = db.close.bind(db);
        let failed = false;
        defineOwn(db, "close", {
          value: () => {
            if (!failed) {
              failed = true;
              closeInjected = true;
              throw new Error(`${name}: injected close failure`);
            }
            nativeClose();
          },
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: close failure`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: close failure`,
  );
  assert(closeInjected, `${name}: the close fault was never exercised`);
  equal(harness.requestCount(), 2, `${name}: close-failure request count`);
  equal(harness.createCalls(), 1, `${name}: close-failure createSchema calls`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: close-failure status`,
  );

  assert(captured !== null, `${name}: no handle was captured for close cleanup`);
  const handle = captured as IDBDatabase;
  equal(
    await probeLiveConnection(guard, name, handle),
    "leaked",
    `${name}: the failed close was expected to leave the handle live`,
  );
  handle.close();
  assertClosedHandle(handle, `${name}: close-failure cleanup`);

  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after close failure`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after close failure`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: close-failure retries started a request`,
  );

  return "an injected created-handle close failure latched indeterminate instead of reporting created; the committed schema remained (no rollback is claimed), the handle was proven still live, then explicitly closed, and a later confirmation did not retry";
}

async function abortUnconfirmedVersionError(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onUpgrade: (request) => {
        defineOwn(request, "error", {
          get: () => ({ name: "VersionError" }),
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: VersionError after abort request`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: VersionError after abort request`,
  );
  assert(
    indeterminate.category !== "incompatible",
    `${name}: a post-abort VersionError overrode the abort correlation`,
  );
  equal(harness.requestCount(), 1, `${name}: abort-error request count`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", observedExistingDatabase: true },
    `${name}: abort-error status`,
  );
  await assertDatabaseAbsent(guard, name);

  const repeated = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: retry after abort-error`,
  );
  assertProvisioningCategory(
    repeated,
    "indeterminate",
    name,
    `${name}: retry after abort-error`,
  );
  equal(harness.requestCount(), 1, `${name}: abort-error retry started a request`);

  return "an injected VersionError observed after an abort request was rejected indeterminate rather than incompatible or missing, the real transaction aborted, the fixture stayed absent, and no retry started";
}

async function abortUnconfirmedTransaction(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onUpgrade: (request) => {
        const transaction = request.transaction;
        assert(transaction, `${name}: absent upgrade had no transaction`);
        // Registering succeeds but never installs a listener, so the
        // coordinator cannot confirm the transaction abort.
        defineOwn(transaction, "addEventListener", {
          value: () => undefined,
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: unconfirmed transaction abort`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: unconfirmed transaction abort`,
  );
  equal(harness.requestCount(), 1, `${name}: unconfirmed request count`);
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: unconfirmed status`,
  );
  await assertDatabaseAbsent(guard, name);

  const repeat = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: retry after unconfirmed abort`,
  );
  assertProvisioningCategory(
    repeat,
    "indeterminate",
    name,
    `${name}: retry after unconfirmed abort`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: unconfirmed retry started a request`,
  );

  return "a terminal AbortError without an observed transaction abort latched indeterminate, never reported missing, kept the fixture absent, and did not retry automatically";
}

interface PartialWriteEvidence {
  readonly markers: string[];
  readonly expected: string[];
  readonly intendedFailure: "thenable return" | "throw";
}

async function callbackAsyncResolved(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const markers: string[] = [];
  return callbackReturnScenario(
    guard,
    name,
    "async-resolved after a partial store write",
    (db) => {
      db.createObjectStore(PARTIAL_WRITE_STORE, { keyPath: "id" });
      markers.push("store-created");
      markers.push(
        db.objectStoreNames.contains(PARTIAL_WRITE_STORE)
          ? "store-visible"
          : "store-missing",
      );
      markers.push("before-thenable-return");
      return Promise.resolve("ignored-async-result");
    },
    "transient",
    undefined,
    {
      markers,
      expected: ["store-created", "store-visible", "before-thenable-return"],
      intendedFailure: "thenable return",
    },
  );
}

async function callbackAsyncRejected(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const marker = `${name}-async-rejection-marker`;
  return callbackReturnScenario(
    guard,
    name,
    "async-rejected",
    () => Promise.reject(new Error(marker)),
    "transient",
    marker,
  );
}

async function callbackNonUndefined(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  return callbackReturnScenario(
    guard,
    name,
    "non-undefined",
    () => 42,
    "transient",
  );
}

async function callbackThrows(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const markers: string[] = [];
  return callbackReturnScenario(
    guard,
    name,
    "throws after a partial store write",
    (db) => {
      db.createObjectStore(PARTIAL_WRITE_STORE, { keyPath: "id" });
      markers.push("store-created");
      markers.push(
        db.objectStoreNames.contains(PARTIAL_WRITE_STORE)
          ? "store-visible"
          : "store-missing",
      );
      markers.push("before-throw");
      throw new Error(`${name}: injected createSchema throw`);
    },
    "transient",
    undefined,
    {
      markers,
      expected: ["store-created", "store-visible", "before-throw"],
      intendedFailure: "throw",
    },
  );
}

async function callbackReturnScenario(
  guard: ProvisioningGuardState,
  name: string,
  label: string,
  callback: (db: IDBDatabase) => unknown,
  expectedCategory: BrowserProvisioningErrorCategory,
  unhandledMarker?: string,
  partialWrite?: PartialWriteEvidence,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(callback);

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const failure = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: ${label} callback`,
  );
  assertProvisioningCategory(failure, expectedCategory, name, `${name}: ${label}`);
  equal(harness.requestCount(), 2, `${name}: ${label} request count`);
  equal(harness.createCalls(), 1, `${name}: ${label} createSchema calls`);

  await flushTaskTurn(`${name}: ${label} unhandled checkpoint`);
  if (unhandledMarker !== undefined) {
    assert(
      !unhandledRejections.some((reason) =>
        String(reason).includes(unhandledMarker),
      ),
      `${name}: ${label} produced an unhandled rejection`,
    );
  }

  // A confirmed rollback abort after a callback throw or thenable return is a
  // safe retryable `transient` failure in the implementation's documented
  // contract. Assert the measured category honestly; this is not a claim that
  // an arbitrary callback had no side effects outside the schema transaction.
  assertStatus(
    harness.manager.getStatus(),
    { phase: "unknown", eligibleForConfirmation: false },
    `${name}: ${label} status`,
  );

  const createRequest = harness.lastRequest();
  equal(
    await withWatchdog(createRequest.settled, `${name}: ${label} terminal`),
    "error",
    `${name}: ${label} terminal outcome`,
  );
  equal(
    createRequest.errorName(),
    "AbortError",
    `${name}: ${label} terminal error name`,
  );
  assert(
    createRequest.transactionAborted(),
    `${name}: ${label} did not abort its versionchange transaction`,
  );
  assert(
    createRequest.events.indexOf("transaction-abort") >= 0 &&
      createRequest.events.indexOf("transaction-abort") <
        createRequest.events.indexOf("error"),
    `${name}: ${label} transaction abort was not observed before the terminal error: ${createRequest.events.join(",")}`,
  );
  await assertDatabaseAbsent(guard, name);

  if (partialWrite !== undefined) {
    // Assert outside the coordinator callback: a store was actually created and
    // visible while the transaction was active, and the callback reached the
    // point immediately before its intended thenable return or throw. A failure
    // inside createObjectStore or a missing store would leave different markers.
    equal(
      partialWrite.markers,
      partialWrite.expected,
      `${name}: ${label} partial schema write markers`,
    );
  }

  return partialWrite !== undefined
    ? `a createSchema callback that created a store (observed in objectStoreNames while the versionchange transaction was active) and then reached the marker immediately before its intended ${partialWrite.intendedFailure}; the same request's transaction aborted and terminated with AbortError, a later absence check confirmed the rollback of that schema transaction, the observed category was ${expectedCategory}, and no unhandled rejection escaped (no claim is made about effects outside that transaction)`
    : `a createSchema callback that ${label} did not write a store, but the same request's transaction aborted and terminated with AbortError; the fixture stayed absent, the observed category was ${expectedCategory}, and no unhandled rejection escaped`;
}

async function concurrentConfirmedCreates(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const first = createHarness(guard, { name });
  const second = createHarness(guard, { name });
  const rows = syntheticRows(`${name}-concurrent`);
  const firstUpgrade = deferred<void>();

  first.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(first.lastRequest(), rows, `${name}: concurrent create`);
    firstUpgrade.resolve();
  });
  second.setCreateSchema(() => {
    throw new Error(`${name}: the second concurrent create ran createSchema`);
  });

  first.expectFresh();
  second.expectFresh();
  const [firstCheck, secondCheck] = await Promise.allSettled([
    first.manager.openExisting(),
    second.manager.openExisting(),
  ]);
  assert(firstCheck.status === "rejected", `${name}: first check resolved`);
  assert(secondCheck.status === "rejected", `${name}: second check resolved`);
  assert(
    firstCheck.reason instanceof BrowserProvisioningError,
    `${name}: first check was not a provisioning error`,
  );
  assert(
    secondCheck.reason instanceof BrowserProvisioningError,
    `${name}: second check was not a provisioning error`,
  );
  assertProvisioningCategory(
    firstCheck.reason,
    "missing",
    name,
    `${name}: first check`,
  );
  assertProvisioningCategory(
    secondCheck.reason,
    "missing",
    name,
    `${name}: second check`,
  );

  first.expectFresh();
  const firstCreate = first.manager.confirmCreateOnce();
  // The second confirmed create starts while the first creation's versionchange
  // transaction is active, so this is a real concurrent creation attempt in the
  // same realm/origin (not separate tabs or browser realms).
  await withWatchdog(firstUpgrade.promise, `${name}: first upgrade started`);
  second.expectNoneOrFresh();
  const secondCreate = second.manager.confirmCreateOnce();

  const [firstOutcome, secondOutcome] = await Promise.all([
    withWatchdog(firstCreate, `${name}: first create`),
    withWatchdog(secondCreate, `${name}: second create`),
  ]);
  equal(firstOutcome, "created", `${name}: first create outcome`);
  equal(secondOutcome, "existing-found", `${name}: second create outcome`);
  equal(first.createCalls(), 1, `${name}: first createSchema calls`);
  equal(second.createCalls(), 0, `${name}: second createSchema calls`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after concurrent creates`,
  );
  assertStatus(
    first.manager.getStatus(),
    { phase: "created", recheckRequired: false },
    `${name}: first concurrent status`,
  );
  assertStatus(
    second.manager.getStatus(),
    {
      phase: "existing-unverified",
      eligibleForConfirmation: false,
      recheckRequired: true,
    },
    `${name}: second concurrent status`,
  );

  return "two coordinators performed real concurrent confirmed creates in the same realm and origin (not separate tabs): exactly one created the schema, the other observed existing-found, no duplicate schema callback ran, and the rows were unchanged";
}

async function reentrantFactory(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-reentrant`);
  const harness = createHarness(guard, { name });
  let reentrantConfirm: Promise<unknown> | null = null;
  let reentrantOpen: Promise<unknown> | null = null;
  let reentrantCheck: Promise<unknown> | null = null;
  let reentered = false;

  harness.setCreateSchema((db) => {
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      rows,
      `${name}: reentrant create`,
    );
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.setFactoryImpl((plan, openRequest) => {
    if (!reentered) {
      reentered = true;
      const confirmPromise = harness.manager.confirmCreateOnce();
      const openPromise = harness.manager.openExisting();
      const checkPromise = harness.manager.checkExistingAgain();
      // Observe the expected busy rejections immediately; they are still
      // asserted individually after the outer creation completes.
      void confirmPromise.catch(() => undefined);
      void openPromise.catch(() => undefined);
      void checkPromise.catch(() => undefined);
      reentrantConfirm = confirmPromise;
      reentrantOpen = openPromise;
      reentrantCheck = checkPromise;
    }
    return openRequest().request;
  });

  harness.expectFresh();
  const outcome = await withWatchdog(
    harness.manager.confirmCreateOnce(),
    `${name}: reentrant create`,
  );
  equal(outcome, "created", `${name}: reentrant create outcome`);
  assert(reentrantConfirm !== null, `${name}: the factory did not reenter`);
  assert(reentrantOpen !== null, `${name}: the factory did not reenter openExisting`);
  assert(
    reentrantCheck !== null,
    `${name}: the factory did not reenter checkExistingAgain`,
  );

  const [confirmError, openError, checkError] = await Promise.all([
    expectProvisioningError(
      reentrantConfirm as Promise<unknown>,
      `${name}: reentrant confirm`,
    ),
    expectProvisioningError(
      reentrantOpen as Promise<unknown>,
      `${name}: reentrant open`,
    ),
    expectProvisioningError(
      reentrantCheck as Promise<unknown>,
      `${name}: reentrant check`,
    ),
  ]);
  assertProvisioningCategory(
    confirmError,
    "busy",
    name,
    `${name}: reentrant confirm`,
  );
  assertProvisioningCategory(openError, "busy", name, `${name}: reentrant open`);
  assertProvisioningCategory(checkError, "busy", name, `${name}: reentrant check`);
  equal(harness.requestCount(), 2, `${name}: reentrant factory started a request`);
  equal(harness.createCalls(), 1, `${name}: reentrant createSchema calls`);

  return "a factory that synchronously reentered confirmCreateOnce, openExisting, and checkExistingAgain was rejected busy each time without starting another request; exactly one creation completed";
}

async function versionchangeUpgrade(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-versionchange`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing open before versionchange`,
    ),
  );

  const observed = deferred<number | null>();
  handle.addEventListener("versionchange", (event) => {
    observed.resolve((event as IDBVersionChangeEvent).newVersion);
  });

  // A second native connection requests v2. The published handle must receive a
  // real versionchange event; the probe aborts its own upgrade, leaving the
  // fixture at v1.
  const probe = trackedOpen(guard, {
    name,
    version: V2_VERSION,
    oldVersion: V1_VERSION,
    label: `${name}: versionchange probe`,
  });
  probe.request.onupgradeneeded = () => {
    try {
      probe.request.transaction?.abort();
    } catch {
      // The probe upgrade transaction may already be inactive.
    }
  };
  probe.request.onerror = () => undefined;
  probe.request.onsuccess = () => probe.request.result.close();
  await withWatchdog(probe.settled, `${name}: versionchange probe terminal`);
  equal(
    await withWatchdog(observed.promise, `${name}: versionchange event`),
    V2_VERSION,
    `${name}: versionchange newVersion`,
  );

  assertClosedHandle(handle, `${name}: versionchange handle was not closed`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "unknown",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: versionchange status`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: versionchange started an automatic reopen`,
  );

  return "a real second-connection v2 request delivered a versionchange event to the published handle; the coordinator closed it, cleared the current handle, kept creation ineligible, and started no automatic reopen";
}

function dispatchVersionChangeSignal(
  db: IDBDatabase,
  oldVersion: number,
  newVersion: number | null,
): void {
  const event = new Event("versionchange");
  Object.defineProperties(event, {
    oldVersion: { value: oldVersion, enumerable: true },
    newVersion: { value: newVersion, enumerable: true },
  });
  db.dispatchEvent(event);
}

async function versionchangeDeleteSignal(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-delete-signal`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing open before delete signal`,
    ),
  );

  // deleteDatabase is forbidden by the runner's boot guard. This dispatches the
  // exact delete-shaped versionchange signal (newVersion === null) at the
  // published handle; it is explicitly a synthetic signal, not a native delete.
  dispatchVersionChangeSignal(handle, V1_VERSION, null);
  assertClosedHandle(handle, `${name}: delete-signal handle was not closed`);
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "unknown",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
    },
    `${name}: delete-signal status`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: delete signal started an automatic reopen`,
  );

  return "a synthetic delete-shaped versionchange signal (newVersion === null, because deleteDatabase is forbidden) caused the published handle to be closed and marked unknown without an automatic reopen; this is not a native delete test";
}

async function abnormalClose(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-abnormal-close`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();

  const harness = createHarness(guard, { name });
  harness.expectExisting();
  const handle = registerPublishedHandle(
    await withWatchdog(
      harness.manager.openExisting(),
      `${name}: existing open before abnormal close`,
    ),
  );

  // Synthetic close event: an explicit db.close() does not emit it.
  handle.dispatchEvent(new Event("close"));
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "indeterminate",
      observedExistingDatabase: true,
      eligibleForConfirmation: false,
    },
    `${name}: abnormal-close status`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: abnormal close started an automatic reopen`,
  );
  equal(
    await probeLiveConnection(guard, name, handle),
    "leaked",
    `${name}: a synthetic abnormal close was expected to leave the raw handle live`,
  );

  return "a synthetic abnormal close event latched indeterminate and cleared the current handle without an automatic reopen; because the event was synthetic, the raw handle remained live until probe cleanup, which is recorded rather than hidden";
}

async function abortEventOrdering(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: ordering check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: ordering check`,
  );
  const request = harness.lastRequest();
  await withWatchdog(request.settled, `${name}: ordering terminal`);
  const abortIndex = request.events.indexOf("transaction-abort");
  const errorIndex = request.events.indexOf("error");
  assert(
    abortIndex >= 0,
    `${name}: the transaction abort event was never observed: ${request.events.join(",")}`,
  );
  assert(
    errorIndex >= 0,
    `${name}: the terminal error event was never observed: ${request.events.join(",")}`,
  );
  assert(
    abortIndex < errorIndex,
    `${name}: transaction abort was not observed before the terminal error: ${request.events.join(",")}`,
  );
  equal(request.errorName(), "AbortError", `${name}: ordering terminal error`);
  await assertDatabaseAbsent(guard, name);

  return "the native versionchange transaction abort event was observed before the terminal AbortError on the same request, and the absence check confirmed no database was written";
}

async function lateSuccessWithoutAbort(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  let lateHandle: IDBDatabase | null = null;
  const harness = createHarness(guard, { name });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onSuccess: (_request, db) => {
        lateHandle = db;
      },
      onUpgrade: (request) => {
        const transaction = request.transaction;
        if (transaction !== null) {
          // The abort call silently does nothing: the coordinator believes it
          // aborted, but the open later succeeds.
          defineOwn(transaction, "abort", { value: () => undefined });
        }
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const indeterminate = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: late success without abort`,
  );
  assertProvisioningCategory(
    indeterminate,
    "indeterminate",
    name,
    `${name}: late success without abort`,
  );
  equal(harness.requestCount(), 1, `${name}: late-success request count`);
  const request = harness.lastRequest();
  equal(
    await withWatchdog(request.settled, `${name}: late-success terminal`),
    "success",
    `${name}: late-success terminal outcome`,
  );
  assert(lateHandle !== null, `${name}: late success produced no handle`);
  equal(
    await probeLiveConnection(guard, name, lateHandle),
    "closed",
    `${name}: late success handle was left live`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "indeterminate",
      eligibleForConfirmation: false,
    },
    `${name}: late-success status`,
  );

  const empty = await openRaw(guard, name, V1_VERSION);
  try {
    equal(
      empty.objectStoreNames.length,
      0,
      `${name}: no-op abort unexpectedly wrote stores`,
    );
  } finally {
    empty.close();
  }

  // The un-aborted open created an empty database; the supervisor nevertheless
  // closed the late handle and latched indeterminate.
  return "a no-op injected abort let an existing-only open succeed late; the coordinator closed the late handle, reported indeterminate rather than missing or existing, and did not publish or retry it (the empty database created by the un-aborted upgrade is recorded)";
}

async function getterSwitchAfterTargetValidation(
  guard: ProvisioningGuardState,
  targetName: string,
  otherName: string,
): Promise<string> {
  const targetRows = syntheticRows(`${targetName}-getter-target`);
  const otherRows = syntheticRows(`${otherName}-getter-other`);
  const otherHandle = await installFixture(
    guard,
    otherName,
    V1_VERSION,
    otherRows,
  );

  let otherReturned = false;
  let schemaDbName: string | null = null;
  let sameTurnAfterValidation = false;

  const harness = createHarness(guard, { name: targetName });
  harness.setCreateSchema((db) => {
    schemaDbName = db.name;
    if (db.name !== targetName) {
      throw new Error(
        `${targetName}: createSchema received ${db.name}, not the validated target handle`,
      );
    }
    createV1Stores(db);
    seedRowsInUpgrade(
      currentRequestForCreate(harness),
      targetRows,
      `${targetName}: getter-switch create`,
    );
  });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onTracked: (request) => {
        const nativeGetter = NATIVE_RESULT_GETTER;
        assert(nativeGetter, `${targetName}: native result getter unavailable`);
        let reads = 0;
        defineOwn(request, "result", {
          get: () => {
            reads += 1;
            if (reads === 2) {
              // The coordinator's target-validation read. A buggy schema path
              // re-reads result synchronously before returning; a fixed path
              // passes the already validated handle. Later event-time reads
              // happen after the microtask below and receive the real handle.
              sameTurnAfterValidation = true;
              queueMicrotask(() => {
                sameTurnAfterValidation = false;
              });
              return nativeGetter.call(request);
            }
            if (reads > 2 && sameTurnAfterValidation) {
              otherReturned = true;
              return otherHandle;
            }
            return nativeGetter.call(request);
          },
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  try {
    harness.expectFresh(targetName, V1_VERSION);
    const missing = await expectProvisioningError(
      harness.manager.openExisting(),
      `${targetName}: pre-create check`,
    );
    assertProvisioningCategory(
      missing,
      "missing",
      targetName,
      `${targetName}: pre-create check`,
    );

    harness.expectFresh(targetName, V1_VERSION);
    const outcome = await withWatchdog(
      harness.manager.confirmCreateOnce(),
      `${targetName}: getter-switch create`,
    );
    equal(outcome, "created", `${targetName}: getter-switch outcome`);
    equal(
      schemaDbName,
      targetName,
      `${targetName}: createSchema received the wrong handle`,
    );
    equal(
      otherReturned,
      false,
      `${targetName}: createSchema re-read result and received the switched handle`,
    );
    equal(
      await readFixture(guard, targetName, V1_VERSION),
      targetRows,
      `${targetName}: target rows after getter-switch create`,
    );
    equal(
      await readFixture(guard, otherName, V1_VERSION),
      otherRows,
      `${targetName}: other fixture rows changed after getter-switch create`,
    );
  } finally {
    try {
      otherHandle.close();
    } catch {
      // The other fixture handle may already be closed.
    }
  }

  return "a request-result getter that would return a different database on a schema-path re-read was not re-read: createSchema received the exact target handle validated from the upgrade event, the created schema and rows landed only in the bound target, and the other fixture's rows were unchanged";
}

async function blockedNullLateSuccess(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-blocked-null`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();

  let nativeHandle: IDBDatabase | null = null;
  let nullExposed = false;
  let deliverBlocked: (() => void) | null = null;
  let deliverSuccess: (() => void) | null = null;
  const harness = createHarness(guard, { name });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onTracked: (request) => {
        // Capture the coordinator's own blocked and success listeners. A
        // synthetic dispatch on an IDBOpenDBRequest did not reliably reach
        // later-registered listeners in Chromium, so this fault-injection case
        // delivers the blocked and success callbacks by invoking exactly the
        // listeners the coordinator registered. The real native success event
        // still fires for the fixture listener afterwards.
        const nativeAdd = request.addEventListener.bind(request);
        defineOwn(request, "addEventListener", {
          value: (
            type: string,
            listener: (event: Event) => void,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (type === "blocked") {
              deliverBlocked = () => {
                (listener as () => void).call(request);
              };
              return;
            }
            if (type === "success") {
              deliverSuccess = () => {
                listener.call(request, new Event("success"));
              };
              return;
            }
            nativeAdd(type, listener, options);
          },
        });
        queueMicrotask(() => {
          assert(deliverBlocked, `${name}: no blocked listener was registered`);
          assert(deliverSuccess, `${name}: no success listener was registered`);
          // Hide the result before the delivered success so the coordinator
          // sees a successful open with an unreadable handle.
          defineOwn(request, "result", {
            get: () => {
              nullExposed = true;
              return null;
            },
          });
          deliverBlocked();
          deliverSuccess();
        });
      },
      onSuccess: (request) => {
        // The real native success event still fires for the fixture listener
        // after the explicit delivery above. The result is now the injected
        // null getter, so capture the retained native handle separately for
        // fixture cleanup.
        nativeHandle = readNativeResult(request);
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectExisting();
  const blocked = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: blocked existing open`,
  );
  assertProvisioningCategory(
    blocked,
    "blocked",
    name,
    `${name}: blocked existing open`,
  );

  const request = harness.lastRequest();
  equal(
    await withWatchdog(request.settled, `${name}: late success terminal`),
    "success",
    `${name}: late success terminal outcome`,
  );
  assert(
    nullExposed,
    `${name}: the null-result getter was never exercised (events=${request.events.join(",")} phase=${harness.manager.getStatus().phase})`,
  );
  assertStatus(
    harness.manager.getStatus(),
    {
      phase: "indeterminate",
      eligibleForConfirmation: false,
      recheckRequired: false,
    },
    `${name}: blocked-null status`,
  );
  equal(harness.requestCount(), 1, `${name}: blocked-null request count`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after null late success ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "indeterminate",
      name,
      `${name}: retry after null late success ${attempt + 1}`,
    );
  }
  const explicit = await expectProvisioningError(
    harness.manager.checkExistingAgain(),
    `${name}: explicit check after null late success`,
  );
  assertProvisioningCategory(
    explicit,
    "indeterminate",
    name,
    `${name}: explicit check after null late success`,
  );
  equal(
    harness.requestCount(),
    1,
    `${name}: a re-check started after a null late success`,
  );

  assert(nativeHandle !== null, `${name}: no native handle was captured`);
  const handle = nativeHandle as IDBDatabase;
  equal(
    await probeLiveConnection(guard, name, handle),
    "leaked",
    `${name}: the unclosed null-result handle was expected to be live`,
  );
  handle.close();
  assertClosedHandle(handle, `${name}: null-result handle cleanup`);
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows after null late success`,
  );

  return "the coordinator's own blocked listener then its own success listener were delivered in order while the request result getter returned null (the real native success still fired for the fixture listener) and latched indeterminate instead of offering recheck-required; no retry or explicit check started a request, and the actual native handle, which the coordinator could not inspect through the null result, was proven live and then closed explicitly";
}

async function postSchemaVersionError(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  let partialWriteAttempted = false;
  harness.setCreateSchema((db) => {
    db.createObjectStore(PARTIAL_WRITE_STORE, { keyPath: "id" });
    partialWriteAttempted = true;
    const transaction = currentRequestForCreate(harness).request.transaction;
    assert(transaction, `${name}: creation upgrade had no transaction`);
    transaction.abort();
  });
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onTracked: (request) => {
        // Only the second (creation) request gets the contradictory name. The
        // native terminal outcome there is still a real AbortError from the
        // schema transaction abort; the injected VersionError must not override
        // the post-schema uncertainty.
        if (harness.requests.length !== 1) return;
        defineOwn(request, "error", {
          get: () => ({ name: "VersionError" }),
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const failure = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: post-schema VersionError`,
  );
  assertProvisioningCategory(
    failure,
    "indeterminate",
    name,
    `${name}: post-schema VersionError`,
  );
  equal(
    harness.createCalls(),
    1,
    `${name}: post-schema createSchema calls`,
  );
  assert(partialWriteAttempted, `${name}: schema code never ran`);

  const request = harness.lastRequest();
  equal(
    await withWatchdog(request.settled, `${name}: post-schema terminal`),
    "error",
    `${name}: post-schema terminal outcome`,
  );
  equal(
    request.errorName(),
    "VersionError",
    `${name}: injected terminal error name`,
  );
  assert(
    request.transactionAborted(),
    `${name}: the schema transaction did not abort`,
  );
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: post-schema status`,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const repeated = await expectProvisioningError(
      harness.manager.openExisting(),
      `${name}: retry after post-schema VersionError ${attempt + 1}`,
    );
    assertProvisioningCategory(
      repeated,
      "indeterminate",
      name,
      `${name}: retry after post-schema VersionError ${attempt + 1}`,
    );
  }
  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after post-schema VersionError`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after post-schema VersionError`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: retries after post-schema VersionError started a request`,
  );
  await assertDatabaseAbsent(guard, name);

  return "schema code ran, created a store, and aborted its own versionchange transaction; an injected terminal VersionError was then reported indeterminate rather than incompatible, no retry or confirmation started another request, and the aborted fixture was absent on a later check";
}

async function committedInvalidEmptySchema(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  // Intentionally create no stores. The open commits an empty v1 database.
  harness.setCreateSchema(() => undefined);

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const failure = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: committed invalid schema`,
  );
  assertProvisioningCategory(
    failure,
    "indeterminate",
    name,
    `${name}: committed invalid schema`,
  );
  equal(harness.createCalls(), 1, `${name}: invalid-schema createSchema calls`);
  equal(harness.validateCalls(), 1, `${name}: invalid-schema validation calls`);

  const createRequest = harness.lastRequest();
  equal(
    await withWatchdog(createRequest.settled, `${name}: invalid-schema terminal`),
    "success",
    `${name}: invalid-schema terminal outcome`,
  );
  assertClosedHandle(
    createRequest.request.result,
    `${name}: committed invalid handle was not closed`,
  );

  // Inspect the actual committed contents: the open committed, the schema is
  // empty, and the coordinator did not claim "created" or recreate it.
  const committed = await openRaw(guard, name, V1_VERSION);
  try {
    equal(
      Array.from(committed.objectStoreNames),
      [],
      `${name}: committed invalid schema contains stores`,
    );
    equal(committed.version, V1_VERSION, `${name}: committed version`);
  } finally {
    committed.close();
  }
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: invalid-schema status`,
  );

  const confirm = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: confirm after invalid schema`,
  );
  assertProvisioningCategory(
    confirm,
    "indeterminate",
    name,
    `${name}: confirm after invalid schema`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: invalid-schema retry started a request`,
  );

  const stillEmpty = await openRaw(guard, name, V1_VERSION);
  try {
    equal(
      Array.from(stillEmpty.objectStoreNames),
      [],
      `${name}: an automatic recreation wrote a schema`,
    );
  } finally {
    stillEmpty.close();
  }

  return "a committed empty schema failed post-creation validation, was rejected indeterminate instead of created, its actual committed contents were read back as zero stores at v1, the created handle was closed, and a later confirmation neither retried nor automatically recreated the database";
}

async function negativeFixtureGuardSelfTest(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const rows = syntheticRows(`${name}-negative`);
  const fixture = await installFixture(guard, name, V1_VERSION, rows);
  fixture.close();
  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: rows before the negative fixture-guard self-test`,
  );

  let continuationUpgrade = 0;
  let continuationStoreWrite = 0;
  const mismatchLabel = `${name}: negative self-test (expected oldVersion mismatch)`;
  // Deliberately wrong: this is a real v1->v2 upgrade, but the plan claims 0.
  const tracked = trackedOpen(guard, {
    name,
    version: V2_VERSION,
    oldVersion: 0,
    label: mismatchLabel,
  });
  // This later listener must never run: the early guard stops immediate
  // propagation and aborts on the unexpected oldVersion.
  tracked.request.onupgradeneeded = () => {
    continuationUpgrade += 1;
    try {
      const db = tracked.request.result;
      db.createObjectStore("mustNotBeCreated", { keyPath: "id" });
    } finally {
      continuationStoreWrite += 1;
    }
  };

  equal(
    await withWatchdog(tracked.settled, `${name}: negative self-test terminal`),
    "error",
    `${name}: negative self-test terminal outcome`,
  );
  equal(
    tracked.errorName(),
    "AbortError",
    `${name}: negative self-test terminal error name`,
  );
  assert(
    tracked.transactionAborted(),
    `${name}: negative self-test did not abort its transaction`,
  );
  equal(
    tracked.freshWriteVerified(),
    false,
    `${name}: negative self-test incorrectly verified a fresh write`,
  );
  equal(
    continuationUpgrade,
    0,
    `${name}: a downstream upgrade callback ran after the guard failed`,
  );
  equal(
    continuationStoreWrite,
    0,
    `${name}: a downstream schema-write callback ran after the guard failed`,
  );
  consumeFixtureGuardViolation(mismatchLabel);

  equal(
    await readFixture(guard, name, V1_VERSION),
    rows,
    `${name}: existing rows changed after the negative self-test`,
  );
  const check = await openRaw(guard, name, V1_VERSION);
  try {
    assert(
      !Array.from(check.objectStoreNames).includes("mustNotBeCreated"),
      `${name}: the forbidden store was created despite the guard abort`,
    );
  } finally {
    check.close();
  }

  return "a deliberately wrong upgrade expectation was rejected by the independent early guard: it stopped immediate propagation and aborted the transaction, downstream schema/row callbacks did not run, fresh-write verification stayed false, and the existing fixture rows and schema were unchanged";
}

async function failOnceAbortObserver(
  guard: ProvisioningGuardState,
  name: string,
): Promise<string> {
  const harness = createHarness(guard, { name });
  harness.setCreateSchema(() => {
    throw new Error(`${name}: createSchema ran after observer installation failed`);
  });
  let firstInstallFailed = false;
  let upgradesSeen = 0;
  harness.setFactoryImpl((plan) => {
    const tracked = trackedOpen(guard, plan, {
      onUpgrade: (request) => {
        // The upgrade hooks run asynchronously, so the pre-create check is the
        // first upgrade and the creation attempt is the second. Only the
        // creation attempt gets the fail-once injection.
        upgradesSeen += 1;
        if (upgradesSeen !== 2) return;
        const transaction = request.transaction;
        assert(transaction, `${name}: creation upgrade had no transaction`);
        const nativeAdd = transaction.addEventListener.bind(transaction);
        let coordinatorInstalls = 0;
        // Fail the first coordinator abort-listener installation, then let any
        // retry succeed. The implementation is expected to fail closed instead
        // of retrying inside requestAbort.
        defineOwn(transaction, "addEventListener", {
          value: (
            type: string,
            listener: (event: Event) => void,
            options?: boolean | AddEventListenerOptions,
          ) => {
            coordinatorInstalls += 1;
            if (coordinatorInstalls === 1) {
              firstInstallFailed = true;
              throw new Error(
                `${name}: injected fail-once abort-observer install`,
              );
            }
            nativeAdd(type, listener, options);
          },
        });
      },
    });
    harness.requests.push(tracked);
    return tracked.request;
  });

  harness.expectFresh();
  const missing = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: pre-create check`,
  );
  assertProvisioningCategory(
    missing,
    "missing",
    name,
    `${name}: pre-create check`,
  );

  harness.expectFresh();
  const failure = await expectProvisioningError(
    harness.manager.confirmCreateOnce(),
    `${name}: fail-once abort observer`,
  );
  assertProvisioningCategory(
    failure,
    "indeterminate",
    name,
    `${name}: fail-once abort observer`,
  );
  assert(firstInstallFailed, `${name}: the fail-once injection never ran`);
  equal(harness.createCalls(), 0, `${name}: fail-once createSchema calls`);

  const request = harness.lastRequest();
  equal(
    await withWatchdog(request.settled, `${name}: fail-once terminal`),
    "error",
    `${name}: fail-once terminal outcome`,
  );
  equal(
    request.errorName(),
    "AbortError",
    `${name}: fail-once terminal error name`,
  );
  assert(
    request.transactionAborted(),
    `${name}: fail-once abort did not abort the transaction`,
  );
  assertStatus(
    harness.manager.getStatus(),
    { phase: "indeterminate", eligibleForConfirmation: false },
    `${name}: fail-once status`,
  );

  const repeated = await expectProvisioningError(
    harness.manager.openExisting(),
    `${name}: retry after fail-once observer`,
  );
  assertProvisioningCategory(
    repeated,
    "indeterminate",
    name,
    `${name}: retry after fail-once observer`,
  );
  equal(
    harness.requestCount(),
    2,
    `${name}: a retry after fail-once observer started a request`,
  );
  await assertDatabaseAbsent(guard, name);

  return "a fail-once abort-observer installation failure (first install throws, a later install would succeed) still latched indeterminate before createSchema ran; the implementation does not retry observer installation inside requestAbort, so no retry request or schema callback followed, the transaction aborted, and the fixture was absent";
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const unhandledRejections: unknown[] = [];

async function run(): Promise<string[]> {
  const guard = requireGuard();
  equal(
    guard.openedNames,
    [],
    "a database was opened before the provisioning test began",
  );
  equal(
    guard.deleteNames,
    [],
    "a database delete was attempted before the provisioning test began",
  );
  equal(
    guard.unexpectedOpenAttempts,
    [],
    "an unexpected database open was attempted before the provisioning test began",
  );
  assert(
    guard.productionOpenAttempts === 0,
    "the production database was opened before the provisioning test began",
  );
  assert(
    guard.networkAttempts === 0,
    "network access was attempted before the provisioning test began",
  );

  const onUnhandled = (event: PromiseRejectionEvent): void => {
    unhandledRejections.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);

  try {
    const names = guard.dbNames;
    const [
      absentName,
      checkAgainName,
      reloadName,
      cancelName,
      createName,
      doubleName,
      appearName,
      raceName,
      existingName,
      mismatchName,
      extraName,
      versionName,
      blockedName,
      lateAbortName,
      listenerFailureName,
      targetNameA,
      targetNameB,
      targetVersionName,
      wrongNameTarget,
      wrongNameExisting,
      wrongVersionName,
      createAbortSetupName,
      factoryThrowName,
      unreadableName,
      failedCloseName,
      abortVersionErrorName,
      abortNoTxName,
      asyncResolvedName,
      asyncRejectedName,
      nonUndefinedName,
      callbackThrowName,
      concurrentName,
      reentrantName,
      versionchangeName,
      versionchangeDeleteName,
      abnormalCloseName,
      abortOrderingName,
      lateSuccessName,
      getterTargetName,
      getterOtherName,
      blockedNullName,
      postSchemaVersionName,
      committedInvalidName,
      negativeGuardName,
      failOnceName,
    ] = names;
    assert(
      names.length === EXPECTED_DB_NAME_COUNT,
      `expected ${EXPECTED_DB_NAME_COUNT} fixture names, got ${names.length}`,
    );

    await runScenario("absent default open", () =>
      absentDefault(guard, absentName),
    );
    await runScenario("explicit check again", () =>
      explicitCheckAgain(guard, checkAgainName),
    );
    await runScenario("reload new coordinator", () =>
      reloadNewCoordinator(guard, reloadName),
    );
    await runScenario("no confirm no request", () =>
      noConfirmNoRequest(guard, cancelName),
    );
    await runScenario("confirm create once", () =>
      confirmCreateOnce(guard, createName),
    );
    await runScenario("double confirm busy", () =>
      doubleConfirmBusy(guard, doubleName),
    );
    await runScenario("existing appears before create", () =>
      existingAppearsBeforeCreate(guard, appearName),
    );
    await runScenario("two coordinator race", () =>
      twoCoordinatorRace(guard, raceName),
    );
    await runScenario("existing v1 validate only", () =>
      existingV1ValidateOnly(guard, existingName),
    );
    await runScenario("schema mismatch missing store/index", () =>
      schemaMismatchMissingStore(guard, mismatchName),
    );
    await runScenario("schema extra accepted", () =>
      schemaExtraAccepted(guard, extraName),
    );
    await runScenario("native VersionError", () =>
      versionError(guard, versionName),
    );
    await runScenario("blocked drain revokes create", () =>
      blockedDrainRevokesCreate(guard, blockedName),
    );
    await runScenario("late abort then success", () =>
      lateAbortSuccess(guard, lateAbortName),
    );
    await runScenario("request listener registration failure", () =>
      listenerRegistrationFailure(guard, listenerFailureName),
    );
    await runScenario("target name mismatch A to B", () =>
      targetNameMismatch(guard, targetNameA, targetNameB),
    );
    await runScenario("target version mismatch v1 to v2", () =>
      targetVersionMismatch(guard, targetVersionName),
    );
    await runScenario("wrong existing name", () =>
      wrongExistingName(guard, wrongNameTarget, wrongNameExisting),
    );
    await runScenario("wrong existing version", () =>
      wrongExistingVersion(guard, wrongVersionName),
    );
    await runScenario("creation transaction abort setup failure", () =>
      createTransactionAbortSetupFailure(guard, createAbortSetupName),
    );
    await runScenario("factory throws after starting", () =>
      factoryThrowsAfterStart(guard, factoryThrowName),
    );
    await runScenario("unreadable result", () =>
      unreadableResult(guard, unreadableName),
    );
    await runScenario("failed close", () =>
      failedClose(guard, failedCloseName),
    );
    await runScenario("VersionError after abort request", () =>
      abortUnconfirmedVersionError(guard, abortVersionErrorName),
    );
    await runScenario("unconfirmed transaction abort", () =>
      abortUnconfirmedTransaction(guard, abortNoTxName),
    );
    await runScenario("callback async resolved", () =>
      callbackAsyncResolved(guard, asyncResolvedName),
    );
    await runScenario("callback async rejected", () =>
      callbackAsyncRejected(guard, asyncRejectedName),
    );
    await runScenario("callback non-undefined", () =>
      callbackNonUndefined(guard, nonUndefinedName),
    );
    await runScenario("callback throws", () =>
      callbackThrows(guard, callbackThrowName),
    );
    await runScenario("concurrent confirmed creates", () =>
      concurrentConfirmedCreates(guard, concurrentName),
    );
    await runScenario("reentrant factory", () =>
      reentrantFactory(guard, reentrantName),
    );
    await runScenario("published handle versionchange", () =>
      versionchangeUpgrade(guard, versionchangeName),
    );
    await runScenario("synthetic versionchange delete signal", () =>
      versionchangeDeleteSignal(guard, versionchangeDeleteName),
    );
    await runScenario("synthetic abnormal close", () =>
      abnormalClose(guard, abnormalCloseName),
    );
    await runScenario("abort event ordering", () =>
      abortEventOrdering(guard, abortOrderingName),
    );
    await runScenario("late success without abort", () =>
      lateSuccessWithoutAbort(guard, lateSuccessName),
    );
    await runScenario("getter switch after target validation", () =>
      getterSwitchAfterTargetValidation(guard, getterTargetName, getterOtherName),
    );
    await runScenario("blocked then null late success", () =>
      blockedNullLateSuccess(guard, blockedNullName),
    );
    await runScenario("post-schema VersionError", () =>
      postSchemaVersionError(guard, postSchemaVersionName),
    );
    await runScenario("committed invalid empty schema", () =>
      committedInvalidEmptySchema(guard, committedInvalidName),
    );
    await runScenario("negative fixture-guard self-test", () =>
      negativeFixtureGuardSelfTest(guard, negativeGuardName),
    );
    await runScenario("fail-once abort observer", () =>
      failOnceAbortObserver(guard, failOnceName),
    );

    await flushTaskTurn("final unhandled rejection checkpoint");
    equal(
      unhandledRejections,
      [],
      "a provisioning scenario produced an unhandled promise rejection",
    );
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
    closeManagerPublishedHandles("final cleanup");
  }

  equal(
    fixtureGuardViolations,
    [],
    "the independent fixture guard observed an upgrade mismatch",
  );
  equal(
    harnessViolations,
    [],
    "a createSchema callback ran before fresh-write verification",
  );
  equal(
    guard.deleteNames,
    [],
    "the provisioning guard observed a deleteDatabase attempt",
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
    `the guard did not observe exactly the ${EXPECTED_DB_NAME_COUNT} provisioning fixtures`,
  );
  equal(
    firstUpgradeOldVersions.size,
    guard.dbNames.length,
    "not every provisioning fixture recorded a first upgrade",
  );
  for (const name of guard.dbNames) {
    equal(
      firstUpgradeOldVersions.get(name),
      0,
      `${name}: fixture was not first created/checked at oldVersion 0`,
    );
  }

  outcomes.push(
    `the boot guard observed only the ${EXPECTED_DB_NAME_COUNT} runtime-unique provisioning fixture opens, no deleteDatabase attempt, no production or legacy application database open, and no guard-observed fetch/XHR/WebSocket/EventSource/beacon attempt (this is not a whole-browser no-network claim); the independent per-request upgrade guard verified the exact fixture name, requested version, newVersion, expected oldVersion, and live transaction, required a fresh-write flag before schema creation and row seeding, and a deliberately wrong upgrade expectation proved later schema/row callbacks do not run while existing rows stay unchanged; the intentionally pre-seeded v1->v2 blocked-drain fixture is labelled; a getter-switch case proved createSchema receives the validated first handle and the other database is intact; a blocked-then-null-success case latched indeterminate with no re-check request and cleaned up the actual native handle; a post-schema VersionError latched indeterminate with no further request; a committed empty schema was rejected as indeterminate with its real committed contents and closed handle recorded and no recreation; synthetic versionchange/delete-signal/abnormal-close events are labelled; injected abort/listener/result/close/factory/observer failures are labelled simulations; the failed-abort, no-op-abort, factory-throw, and committed-invalid cases created empty databases, which are recorded and explicitly closed rather than presented as safe; this is not proof of first-use detection, data preservation against other tabs or external deletion, durability, crash recovery, production schema validity, or real user data, and it is local Linux Chrome evidence only`,
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
