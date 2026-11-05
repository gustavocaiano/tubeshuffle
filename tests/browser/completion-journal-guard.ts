// Native IndexedDB integration guard for the inert disposable completion
// journal. Run with:
//   CHROMIUM_PATH=/path/to/chrome node tests/browser/run-completion-journal-guard.mjs
//
// This module runs only on the runner's fresh loopback origin and ephemeral
// Chrome profile. The runner generates three fixture database names with
// crypto.randomUUID and installs the native boot guard at
// `window.__journalGuard` before this bundle executes. The guard rejects any
// other IndexedDB open/delete name and blocks fetch/XHR/WebSocket/EventSource/
// beacon traffic. The test does not treat a name prefix as proof of
// disposability: it deletes only databases whose fresh creation at
// onupgradeneeded oldVersion 0 it observed in this profile.
//
// Only `issueDisposableCompletion` snapshots are passed to the writer. Direct
// facts, factory-only facts, and structured clones are not issued tokens and
// must be rejected before a transaction starts. The issued snapshot is the
// canonical input; raw extra fields and optional `undefined` are intentionally
// normalized by the shared factory. Callers that need the original raw shape
// must retain it themselves. The stored row is asserted as
// {key, version, payload}; the private payload encoding is not inspected.
// Snapshots cover exactly the fixture's `completionJournal` and `playHistory`
// object stores, not the whole database.
//
// Coverage gap: production repository/controller/player integration,
// library-epoch/owner/local-tag/observed-YouTube-ID verification, durability,
// exactly-once delivery and lineage are not covered. Arbitrary raw-input
// losslessness and raw-input getter rejection are out of scope because the
// issue step intentionally canonicalizes through the shared factory; the issued
// snapshot is the input. This test makes no user-data-security or
// production-readiness claim.
import {
  issueDisposableCompletion,
  writeDisposableCompletion,
  type IssuedDisposableCompletion,
} from "../../src/lib/storage/disposable-completion-journal";
import {
  createPlaybackCompletionFact,
  type PlaybackCompletionFact,
} from "../../src/lib/media/playback-completion";

const TEST_DB_PREFIX = "tubeshuffle-journal-test-";
const PRODUCTION_DB_NAME = "tubeshuffle_local";
const JOURNAL_STORE = "completionJournal";
const HISTORY_STORE = "playHistory";
const historySeed = {
  id: "seed-history-synthetic",
  playlistId: "synthetic-local-playlist",
  videoId: "synthetic-youtube-video",
  watchedAt: "2026-11-04T00:00:00.000Z",
  watchedSeconds: 42,
  completed: true,
};

interface JournalGuardState {
  readonly journalDbName: string;
  readonly wrongDbName: string;
  readonly iframeDbName: string;
  readonly allowed: ReadonlySet<string>;
  readonly openedNames: string[];
  readonly deleteNames: string[];
  readonly unexpectedOpenAttempts: string[];
  readonly unexpectedDeleteAttempts: string[];
  readonly productionOpenAttempts: number;
  readonly networkAttempts: number;
  readonly nativeFetch: typeof window.fetch;
}

const guardState = (
  window as unknown as { readonly __journalGuard?: JournalGuardState }
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

async function rejectsWithTypeError(
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    assert(
      error instanceof TypeError,
      `${label}: expected TypeError, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

function throwsWithTypeError(operation: () => unknown, label: string): void {
  try {
    operation();
  } catch (error) {
    assert(
      error instanceof TypeError,
      `${label}: expected TypeError, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
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

// Preserve the writer's terminal handlers while recording which terminal event
// actually occurred. This observes the same property handlers that settle the
// writer rather than relying on a separately captured transaction wrapper.
function observeTransactionTerminal(transaction: IDBTransaction): {
  readonly abortObserved: () => boolean;
  readonly completeObserved: () => boolean;
} {
  let aborted = false;
  let completed = false;
  const previousAbort = transaction.onabort;
  const previousComplete = transaction.oncomplete;
  transaction.onabort = function (this: IDBTransaction, event: Event) {
    aborted = true;
    previousAbort?.call(this, event);
  };
  transaction.oncomplete = function (this: IDBTransaction, event: Event) {
    completed = true;
    previousComplete?.call(this, event);
  };
  return {
    abortObserved: () => aborted,
    completeObserved: () => completed,
  };
}

interface FixtureDatabase {
  readonly db: IDBDatabase;
  readonly upgradeOldVersions: number[];
}

function requireGuard(): JournalGuardState {
  assert(
    guardState,
    "the native boot guard did not install window.__journalGuard before the test bundle ran",
  );
  const guard = guardState;
  assert(
    guard.allowed instanceof Set,
    "the boot guard did not expose its exact allowlist",
  );
  assert(
    guard.allowed.size === 3,
    `the boot guard allowlist must contain exactly three fixture names, got ${guard.allowed.size}`,
  );
  assert(
    new Set([guard.journalDbName, guard.wrongDbName, guard.iframeDbName]).size ===
      3,
    "the runner generated colliding fixture names",
  );
  assert(
    guard.journalDbName !== PRODUCTION_DB_NAME &&
      guard.wrongDbName !== PRODUCTION_DB_NAME &&
      guard.iframeDbName !== PRODUCTION_DB_NAME,
    "the runner generated the production database name",
  );
  assert(
    guard.allowed.has(guard.journalDbName) &&
      guard.allowed.has(guard.wrongDbName) &&
      guard.allowed.has(guard.iframeDbName),
    "the boot guard allowlist does not contain all runner-generated fixture names",
  );
  assert(
    !guard.allowed.has(PRODUCTION_DB_NAME),
    "the boot guard allowlist contains the production database name",
  );
  // Name shape only satisfies the writer's own guard. It is not proof that the
  // database is disposable; deletion below requires an observed oldVersion 0.
  assert(
    guard.journalDbName.startsWith(TEST_DB_PREFIX),
    "the accepted fixture name does not satisfy the writer's test-name guard",
  );
  assert(
    guard.iframeDbName.startsWith(TEST_DB_PREFIX),
    "the iframe fixture name does not satisfy the writer's test-name guard",
  );
  assert(
    !guard.wrongDbName.startsWith(TEST_DB_PREFIX),
    "the wrong-prefix fixture does not violate the writer's test-name guard",
  );
  return guard;
}

function openFixtureDatabase(
  name: string,
  confirmed: Set<string>,
  guard: JournalGuardState,
): Promise<FixtureDatabase> {
  assert(
    guard.allowed.has(name),
    `${name}: test attempted to open a non-allowlisted database`,
  );
  assert(
    name !== PRODUCTION_DB_NAME,
    `${name}: test attempted to open the production database`,
  );

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    const upgradeOldVersions: number[] = [];
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    request.onupgradeneeded = (event) => {
      upgradeOldVersions.push(event.oldVersion);
      try {
        // The fresh fixture must be created from scratch. Assert this before
        // creating any test store so an existing database can never be adopted.
        assert(
          event.oldVersion === 0,
          `${name}: expected onupgradeneeded oldVersion 0, got ${event.oldVersion}`,
        );
        assert(
          event.newVersion === 1,
          `${name}: expected newVersion 1, got ${event.newVersion}`,
        );
        const db = request.result;
        assert(
          !db.objectStoreNames.contains(JOURNAL_STORE),
          `${name}: fixture already contains ${JOURNAL_STORE}`,
        );
        db.createObjectStore(JOURNAL_STORE, { keyPath: "key" });
        assert(
          !db.objectStoreNames.contains(HISTORY_STORE),
          `${name}: fixture already contains ${HISTORY_STORE}`,
        );
        db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The upgrade transaction may already be inactive.
        }
        fail(error);
      }
    };

    request.onerror = () =>
      fail(request.error ?? new Error(`${name}: database open failed`));
    request.onblocked = () => fail(new Error(`${name}: database open blocked`));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      const db = request.result;
      try {
        assert(db.name === name, `${name}: opened unexpected database`);
        equal(
          upgradeOldVersions,
          [0],
          `${name}: expected exactly one oldVersion 0 upgrade`,
        );
        equal(
          Array.from(db.objectStoreNames).sort(),
          [JOURNAL_STORE, HISTORY_STORE].sort(),
          `${name}: unexpected fixture stores`,
        );
        const transaction = db.transaction(JOURNAL_STORE, "readonly");
        assert(
          transaction.objectStore(JOURNAL_STORE).keyPath === "key",
          `${name}: ${JOURNAL_STORE} must use keyPath "key"`,
        );
        // Confirmation is recorded only after the fresh oldVersion 0 upgrade
        // and the expected fixture shape have both been observed.
        confirmed.add(name);
        settled = true;
        resolve({ db, upgradeOldVersions });
      } catch (error) {
        db.close();
        fail(error);
      }
    };
  });
}

function loadIframeFixtureFrame(): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "journal cross-realm fixture";
    frame.src = "/frame.html";
    frame.addEventListener("load", () => resolve(frame), { once: true });
    frame.addEventListener(
      "error",
      () => reject(new Error("the cross-realm fixture iframe failed to load")),
      { once: true },
    );
    document.body.append(frame);
  });
}

// Opens a fresh fixture database from the iframe's realm and returns its
// IDBDatabase handle to the parent realm. Creation is confirmed only after the
// same oldVersion 0 upgrade and fixture-shape checks used for the parent
// fixture. The iframe's own indexedDB is not patched by the parent boot guard,
// so this test only ever passes the runner-generated allowlisted name.
function openIframeFixtureDatabase(
  name: string,
  frame: HTMLIFrameElement,
  confirmed: Set<string>,
  guard: JournalGuardState,
): Promise<FixtureDatabase> {
  assert(
    guard.allowed.has(name),
    `${name}: test attempted to open a non-allowlisted iframe database`,
  );
  assert(
    name !== PRODUCTION_DB_NAME,
    `${name}: test attempted to open the production database`,
  );
  const frameWindow = frame.contentWindow;
  assert(frameWindow, `${name}: the cross-realm iframe has no contentWindow`);
  const frameIndexedDb = frameWindow.indexedDB;
  assert(frameIndexedDb, `${name}: the cross-realm iframe has no indexedDB`);

  return new Promise((resolve, reject) => {
    const request = frameIndexedDb.open(name, 1);
    const upgradeOldVersions: number[] = [];
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    request.onupgradeneeded = (event) => {
      upgradeOldVersions.push(event.oldVersion);
      try {
        assert(
          event.oldVersion === 0,
          `${name}: expected iframe onupgradeneeded oldVersion 0, got ${event.oldVersion}`,
        );
        assert(
          event.newVersion === 1,
          `${name}: expected iframe newVersion 1, got ${event.newVersion}`,
        );
        const db = request.result;
        assert(
          !db.objectStoreNames.contains(JOURNAL_STORE),
          `${name}: iframe fixture already contains ${JOURNAL_STORE}`,
        );
        db.createObjectStore(JOURNAL_STORE, { keyPath: "key" });
        assert(
          !db.objectStoreNames.contains(HISTORY_STORE),
          `${name}: iframe fixture already contains ${HISTORY_STORE}`,
        );
        db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The upgrade transaction may already be inactive.
        }
        fail(error);
      }
    };

    request.onerror = () =>
      fail(request.error ?? new Error(`${name}: iframe database open failed`));
    request.onblocked = () =>
      fail(new Error(`${name}: iframe database open blocked`));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      const db = request.result;
      try {
        assert(db.name === name, `${name}: iframe opened unexpected database`);
        equal(
          upgradeOldVersions,
          [0],
          `${name}: expected exactly one iframe oldVersion 0 upgrade`,
        );
        equal(
          Array.from(db.objectStoreNames).sort(),
          [JOURNAL_STORE, HISTORY_STORE].sort(),
          `${name}: unexpected iframe fixture stores`,
        );
        const transaction = db.transaction(JOURNAL_STORE, "readonly");
        assert(
          transaction.objectStore(JOURNAL_STORE).keyPath === "key",
          `${name}: iframe ${JOURNAL_STORE} must use keyPath "key"`,
        );
        confirmed.add(name);
        settled = true;
        resolve({ db, upgradeOldVersions });
      } catch (error) {
        db.close();
        fail(error);
      }
    };
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`Could not delete ${name}`));
    request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
  });
}

async function deleteFixtureDatabase(
  name: string,
  confirmed: ReadonlySet<string>,
  guard: JournalGuardState,
): Promise<void> {
  assert(
    confirmed.has(name),
    `${name}: refusing to delete a database whose fresh oldVersion 0 creation was not confirmed`,
  );
  assert(
    guard.allowed.has(name),
    `${name}: refusing to delete a non-allowlisted database`,
  );
  assert(
    name !== PRODUCTION_DB_NAME,
    `${name}: refusing to delete the production database`,
  );
  await deleteDatabase(name);
}

interface Snapshot {
  journal: unknown[];
  history: unknown[];
}

// Reads exactly the two fixture stores. It is intentionally not a whole-
// database snapshot and makes no claim about any other store.
async function snapshot(db: IDBDatabase): Promise<Snapshot> {
  const transaction = db.transaction(
    [JOURNAL_STORE, HISTORY_STORE],
    "readonly",
  );
  const completed = transactionComplete(transaction);
  const journalRequest = transaction.objectStore(JOURNAL_STORE).getAll();
  const historyRequest = transaction.objectStore(HISTORY_STORE).getAll();
  const [journal, history] = await Promise.all([
    requestResult(journalRequest),
    requestResult(historyRequest),
  ]);
  await completed;
  return { journal, history };
}

async function addHistoryRow(
  db: IDBDatabase,
  row: typeof historySeed,
): Promise<void> {
  const transaction = db.transaction(HISTORY_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  await requestResult(transaction.objectStore(HISTORY_STORE).add(row));
  await completed;
}

async function putJournalRecord(
  db: IDBDatabase,
  record: unknown,
): Promise<void> {
  const transaction = db.transaction(JOURNAL_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  await requestResult(transaction.objectStore(JOURNAL_STORE).put(record));
  await completed;
}

function findJournalRow(
  rows: unknown[],
  attemptId: string,
): Record<string, unknown> | undefined {
  return rows.find(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      Array.isArray(row.key) &&
      row.key.length === 2 &&
      row.key[0] === "completion" &&
      row.key[1] === attemptId,
  );
}

function journalRow(
  rows: unknown[],
  attemptId: string,
  label: string,
): Record<string, unknown> {
  const row = findJournalRow(rows, attemptId);
  assert(row, `${label}: missing journal row for ${attemptId}`);
  return row;
}

function assertJournalRecord(
  row: Record<string, unknown>,
  attemptId: string,
  label: string,
): void {
  equal(
    Object.keys(row).sort(),
    ["key", "payload", "version"],
    `${label}: record fields`,
  );
  equal(row.key, ["completion", attemptId], `${label}: journal key`);
  equal(row.version, 1, `${label}: record version`);
  assert(
    typeof row.payload === "string" && row.payload.length > 0,
    `${label}: payload must be a non-empty string`,
  );
}

async function journalIssued(
  db: IDBDatabase,
  issued: IssuedDisposableCompletion,
  attemptId: string,
  label: string,
): Promise<Snapshot> {
  const before = await snapshot(db);
  equal(
    await writeDisposableCompletion(db, issued),
    "journaled",
    `${label}: result`,
  );
  const after = await snapshot(db);
  equal(after.history, before.history, `${label}: playHistory changed`);
  equal(
    after.journal.length,
    before.journal.length + 1,
    `${label}: journal row count`,
  );
  assertJournalRecord(journalRow(after.journal, attemptId, label), attemptId, label);
  return after;
}

async function assertConflictLeaves(
  db: IDBDatabase,
  issued: IssuedDisposableCompletion,
  label: string,
): Promise<void> {
  const before = await snapshot(db);
  equal(await writeDisposableCompletion(db, issued), "conflict", label);
  equal(
    await snapshot(db),
    before,
    `${label}: conflict changed the fixture stores`,
  );
}

function withAttempt(
  input: PlaybackCompletionFact,
  attemptId: string,
): PlaybackCompletionFact {
  return { ...input, playbackAttemptId: attemptId };
}

async function assertOptionalDistinction(
  db: IDBDatabase,
  label: string,
  emptyInput: PlaybackCompletionFact,
  missingInput: PlaybackCompletionFact,
): Promise<void> {
  assert(
    emptyInput.playbackAttemptId === missingInput.playbackAttemptId,
    `${label}: empty and missing fixtures must share an attempt id`,
  );
  const attemptA = emptyInput.playbackAttemptId;
  const attemptB = `${attemptA}-reverse-${crypto.randomUUID()}`;
  const emptyAIssued = issueDisposableCompletion(emptyInput);
  const missingAIssued = issueDisposableCompletion(missingInput);
  const emptyBIssued = issueDisposableCompletion(withAttempt(emptyInput, attemptB));
  const missingBIssued = issueDisposableCompletion(
    withAttempt(missingInput, attemptB),
  );

  // Empty value first, then the missing value for the same attempt.
  await journalIssued(db, emptyAIssued, attemptA, `${label}: empty`);
  await assertConflictLeaves(db, missingAIssued, `${label}: missing after empty`);
  equal(
    await writeDisposableCompletion(db, emptyAIssued),
    "already-recorded",
    `${label}: empty retry`,
  );

  // Missing value first, then the empty value for the same attempt.
  await journalIssued(db, missingBIssued, attemptB, `${label}: missing`);
  await assertConflictLeaves(db, emptyBIssued, `${label}: empty after missing`);
  equal(
    await writeDisposableCompletion(db, missingBIssued),
    "already-recorded",
    `${label}: missing retry`,
  );
}

async function assertContextConflictPair(
  db: IDBDatabase,
  label: string,
  seedContext: NonNullable<PlaybackCompletionFact["playbackContext"]>,
  conflictContext: NonNullable<PlaybackCompletionFact["playbackContext"]>,
): Promise<void> {
  const attemptId = `context-${crypto.randomUUID()}`;
  const seedInput: PlaybackCompletionFact = {
    playbackAttemptId: attemptId,
    observedAt: "2026-11-04T03:30:00.000Z",
    provenance: { kind: "unknown" },
    playbackContext: seedContext,
  };
  const seedIssued = issueDisposableCompletion(seedInput);
  await journalIssued(db, seedIssued, attemptId, `${label}: seed`);
  await assertConflictLeaves(
    db,
    issueDisposableCompletion({ ...seedInput, playbackContext: conflictContext }),
    label,
  );
  equal(
    await writeDisposableCompletion(db, seedIssued),
    "already-recorded",
    `${label}: seed retry`,
  );
}

async function assertUnissuedRejected(
  db: IDBDatabase,
  value: IssuedDisposableCompletion,
  label: string,
): Promise<void> {
  const before = await snapshot(db);
  let writerTransactions = 0;
  const nativeTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const [storeNames] = args;
    const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
    if (this === db && stores.includes(JOURNAL_STORE)) {
      writerTransactions++;
    }
    return Reflect.apply(nativeTransaction, this, args) as IDBTransaction;
  } as IDBDatabase["transaction"];
  try {
    await rejectsWithTypeError(
      Promise.resolve().then(() => writeDisposableCompletion(db, value)),
      label,
    );
  } finally {
    IDBDatabase.prototype.transaction = nativeTransaction;
  }
  equal(
    writerTransactions,
    0,
    `${label}: unissued value started a transaction`,
  );
  equal(
    await snapshot(db),
    before,
    `${label}: unissued value changed the fixture stores`,
  );
}

type MutableCompletionInput = {
  playbackAttemptId: string;
  observedAt: string;
  provenance: {
    kind: "local-occurrence";
    libraryEpoch?: string;
    playlistId: string;
    occurrenceId: string;
  };
  subject?: { youtubeId?: string; queueItemId?: string };
  playbackContext?: { kind: "queue"; queueId?: string };
};

function unknownFact(
  attemptId: string,
  observedAt = "2026-11-04T00:00:00.000Z",
): PlaybackCompletionFact {
  return {
    playbackAttemptId: attemptId,
    observedAt,
    provenance: { kind: "unknown" },
  };
}

// Seed a valid row through the writer, then return the exact stored row. The
// payload is reused as an opaque value; corruption cases mutate only one other
// property so the payload cannot be the reason for the conflict.
async function seedValidJournalRow(
  db: IDBDatabase,
  attemptId: string,
  label: string,
): Promise<{ issued: IssuedDisposableCompletion; row: Record<string, unknown> }> {
  const issued = issueDisposableCompletion(unknownFact(attemptId));
  const after = await journalIssued(db, issued, attemptId, label);
  return { issued, row: journalRow(after.journal, attemptId, label) };
}

async function run(): Promise<string[]> {
  const guard = requireGuard();
  const dbName = guard.journalDbName;
  const wrongDbName = guard.wrongDbName;

  assert(
    dbName !== wrongDbName,
    "the accepted and wrong-prefix fixture names must differ",
  );
  equal(
    guard.unexpectedOpenAttempts,
    [],
    "an unexpected database open was attempted before the test began",
  );
  equal(
    guard.unexpectedDeleteAttempts,
    [],
    "an unexpected database delete was attempted before the test began",
  );
  assert(
    guard.productionOpenAttempts === 0,
    "the production database was opened before the test began",
  );
  assert(
    guard.networkAttempts === 0,
    "network access was attempted before the test began",
  );
  assert(
    guard.openedNames.length === 0,
    "the subject opened a database before the test provided a fixture",
  );
  assert(
    guard.deleteNames.length === 0,
    "the subject deleted a database before the test provided a fixture",
  );

  const confirmedFixtureNames = new Set<string>();
  const deleteAttempted = new Set<string>();
  let main: FixtureDatabase | undefined;
  let wrong: FixtureDatabase | undefined;

  try {
    main = await openFixtureDatabase(dbName, confirmedFixtureNames, guard);
    await addHistoryRow(main.db, historySeed);
    const seeded = await snapshot(main.db);
    equal(seeded.journal, [], "fresh fixture journal must be empty");
    equal(seeded.history, [historySeed], "fresh fixture history seed");
    outcomes.push(
      "the accepted fixture database was created only after an observed oldVersion 0 upgrade",
    );

    // Issued snapshots are frozen canonical values. Extra raw fields and
    // optional undefined are intentionally normalized by the shared factory;
    // callers that need the raw shape must retain it themselves.
    const normalizationAttempt = `normalization-${crypto.randomUUID()}`;
    const canonicalInput: PlaybackCompletionFact = {
      playbackAttemptId: normalizationAttempt,
      observedAt: "2026-11-04T00:10:00.000Z",
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "epoch-normalization",
        playlistId: "playlist-normalization",
        occurrenceId: "occurrence-normalization",
      },
      subject: {
        youtubeId: "youtube-normalization",
        queueItemId: "queue-item-normalization",
      },
      playbackContext: {
        kind: "queue",
        queueId: "queue-normalization",
      },
    };
    const rawWithExtras = {
      ...canonicalInput,
      ignoredTopLevel: "ignored",
      subject: {
        ...canonicalInput.subject,
        ignoredSubject: "ignored",
      },
      provenance: {
        ...canonicalInput.provenance,
        ignoredProvenance: "ignored",
      },
      playbackContext: {
        ...canonicalInput.playbackContext,
        ignoredContext: "ignored",
      },
    } as unknown as PlaybackCompletionFact;
    const issuedRaw = issueDisposableCompletion(rawWithExtras);
    const issuedCanonical = issueDisposableCompletion(canonicalInput);
    assert(
      Object.isFrozen(issuedRaw) && Object.isFrozen(issuedCanonical),
      "issued snapshots must be frozen",
    );
    const afterNormalization = await journalIssued(
      main.db,
      issuedRaw,
      normalizationAttempt,
      "canonical normalization extras",
    );
    equal(
      await writeDisposableCompletion(main.db, issuedCanonical),
      "already-recorded",
      "canonical raw extras normalized to the same issued fact",
    );
    equal(
      await snapshot(main.db),
      afterNormalization,
      "canonical normalization retry changed the fixture stores",
    );

    const optionalUndefinedAttempt = `optional-undefined-${crypto.randomUUID()}`;
    const optionalUndefinedInput = {
      playbackAttemptId: optionalUndefinedAttempt,
      observedAt: "2026-11-04T00:11:00.000Z",
      provenance: { kind: "unknown" },
      subject: undefined,
      playbackContext: undefined,
    } as unknown as PlaybackCompletionFact;
    const optionalUndefinedCanonical: PlaybackCompletionFact = {
      playbackAttemptId: optionalUndefinedAttempt,
      observedAt: "2026-11-04T00:11:00.000Z",
      provenance: { kind: "unknown" },
    };
    const afterOptionalUndefined = await journalIssued(
      main.db,
      issueDisposableCompletion(optionalUndefinedInput),
      optionalUndefinedAttempt,
      "optional undefined normalization",
    );
    equal(
      await writeDisposableCompletion(
        main.db,
        issueDisposableCompletion(optionalUndefinedCanonical),
      ),
      "already-recorded",
      "optional undefined normalized to the absent form",
    );
    equal(
      await snapshot(main.db),
      afterOptionalUndefined,
      "optional undefined retry changed the fixture stores",
    );

    const nestedUndefinedAttempt = `nested-undefined-${crypto.randomUUID()}`;
    const nestedUndefinedInput = {
      playbackAttemptId: nestedUndefinedAttempt,
      observedAt: "2026-11-04T00:12:00.000Z",
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: undefined,
        playlistId: "nested-playlist",
        occurrenceId: "nested-occurrence",
      },
      playbackContext: { kind: "queue", queueId: undefined },
    } as unknown as PlaybackCompletionFact;
    const nestedUndefinedCanonical: PlaybackCompletionFact = {
      playbackAttemptId: nestedUndefinedAttempt,
      observedAt: "2026-11-04T00:12:00.000Z",
      provenance: {
        kind: "local-occurrence",
        playlistId: "nested-playlist",
        occurrenceId: "nested-occurrence",
      },
      playbackContext: { kind: "queue" },
    };
    const afterNestedUndefined = await journalIssued(
      main.db,
      issueDisposableCompletion(nestedUndefinedInput),
      nestedUndefinedAttempt,
      "nested optional undefined normalization",
    );
    equal(
      await writeDisposableCompletion(
        main.db,
        issueDisposableCompletion(nestedUndefinedCanonical),
      ),
      "already-recorded",
      "nested optional undefined normalized to the absent form",
    );
    equal(
      await snapshot(main.db),
      afterNestedUndefined,
      "nested optional undefined retry changed the fixture stores",
    );
    outcomes.push(
      "issued snapshots normalize extra raw fields and optional undefined through the factory, and equivalent canonical issues compare equal",
    );

    // Reissuing the same canonical input produces an independently issued
    // snapshot that the writer accepts as the same fact.
    const reissueAttempt = `reissue-${crypto.randomUUID()}`;
    const reissueInput = unknownFact(reissueAttempt, "2026-11-04T00:20:00.000Z");
    const reissueFirst = issueDisposableCompletion(reissueInput);
    const reissueSecond = issueDisposableCompletion(reissueInput);
    const afterReissue = await journalIssued(
      main.db,
      reissueFirst,
      reissueAttempt,
      "reissue first",
    );
    equal(
      await writeDisposableCompletion(main.db, reissueSecond),
      "already-recorded",
      "reissued snapshot",
    );
    equal(
      await writeDisposableCompletion(main.db, reissueFirst),
      "already-recorded",
      "first issued snapshot retry",
    );
    equal(
      await snapshot(main.db),
      afterReissue,
      "reissue retries changed the fixture stores",
    );
    outcomes.push(
      "reissuing the same canonical input is accepted and resolves to already-recorded",
    );

    // Direct facts, factory-only facts, spread clones, and structured clones
    // are not issued tokens and must reject before starting a transaction.
    const unissuedAttempt = `unissued-${crypto.randomUUID()}`;
    const unissuedInput = unknownFact(unissuedAttempt, "2026-11-04T00:30:00.000Z");
    const issuedUnissued = issueDisposableCompletion(unissuedInput);
    const factoryOnly = createPlaybackCompletionFact(unissuedInput);
    await assertUnissuedRejected(
      main.db,
      unissuedInput as unknown as IssuedDisposableCompletion,
      "direct unissued fact",
    );
    await assertUnissuedRejected(
      main.db,
      factoryOnly as unknown as IssuedDisposableCompletion,
      "factory-only fact",
    );
    await assertUnissuedRejected(
      main.db,
      { ...issuedUnissued } as IssuedDisposableCompletion,
      "spread clone of issued snapshot",
    );
    await assertUnissuedRejected(
      main.db,
      null as unknown as IssuedDisposableCompletion,
      "null issued value",
    );
    await assertUnissuedRejected(
      main.db,
      undefined as unknown as IssuedDisposableCompletion,
      "undefined issued value",
    );
    let structuredCloneValue: IssuedDisposableCompletion | undefined;
    let structuredCloneError: unknown;
    try {
      structuredCloneValue = structuredClone(issuedUnissued);
    } catch (error) {
      structuredCloneError = error;
    }
    if (structuredCloneValue !== undefined) {
      await assertUnissuedRejected(
        main.db,
        structuredCloneValue,
        "structured clone of issued snapshot",
      );
    } else {
      assert(
        structuredCloneError !== undefined,
        "structuredClone neither cloned nor rejected the issued snapshot",
      );
    }
    outcomes.push(
      "direct, factory-only, spread-cloned, and structured-cloned values are rejected before any transaction starts",
    );

    // Empty optional strings and missing optional keys remain distinct in the
    // canonical tuple serialization.
    const emptySubjectAttempt = `empty-subject-${crypto.randomUUID()}`;
    const emptySubjectBase = unknownFact(
      emptySubjectAttempt,
      "2026-11-04T00:40:00.000Z",
    );
    await assertOptionalDistinction(
      main.db,
      "empty subject string",
      { ...emptySubjectBase, subject: { youtubeId: "" } },
      { ...emptySubjectBase, subject: {} },
    );

    const emptyEpochAttempt = `empty-epoch-${crypto.randomUUID()}`;
    const emptyEpochBase = unknownFact(
      emptyEpochAttempt,
      "2026-11-04T00:41:00.000Z",
    );
    const localBase: PlaybackCompletionFact = {
      ...emptyEpochBase,
      provenance: {
        kind: "local-occurrence",
        playlistId: "empty-playlist",
        occurrenceId: "empty-occurrence",
      },
    };
    await assertOptionalDistinction(
      main.db,
      "empty library epoch",
      {
        ...localBase,
        provenance: {
          kind: "local-occurrence",
          libraryEpoch: "",
          playlistId: "empty-playlist",
          occurrenceId: "empty-occurrence",
        },
      },
      localBase,
    );

    const emptyQueueAttempt = `empty-queue-${crypto.randomUUID()}`;
    const emptyQueueBase = unknownFact(
      emptyQueueAttempt,
      "2026-11-04T00:42:00.000Z",
    );
    await assertOptionalDistinction(
      main.db,
      "empty queue id",
      { ...emptyQueueBase, playbackContext: { kind: "queue", queueId: "" } },
      { ...emptyQueueBase, playbackContext: { kind: "queue" } },
    );

    const emptyDiscoveryAttempt = `empty-discovery-${crypto.randomUUID()}`;
    const emptyDiscoveryBase = unknownFact(
      emptyDiscoveryAttempt,
      "2026-11-04T00:43:00.000Z",
    );
    await assertOptionalDistinction(
      main.db,
      "empty discovery context",
      {
        ...emptyDiscoveryBase,
        playbackContext: { kind: "discovery", discoveryContextId: "" },
      },
      { ...emptyDiscoveryBase, playbackContext: { kind: "discovery" } },
    );

    const emptySuggestionAttempt = `empty-suggestion-${crypto.randomUUID()}`;
    const emptySuggestionBase: PlaybackCompletionFact = {
      ...unknownFact(emptySuggestionAttempt, "2026-11-04T00:44:00.000Z"),
      provenance: { kind: "suggestion" },
    };
    await assertOptionalDistinction(
      main.db,
      "empty suggestion discovery context",
      {
        ...emptySuggestionBase,
        provenance: { kind: "suggestion", discoveryContextId: "" },
      },
      emptySuggestionBase,
    );
    outcomes.push(
      "empty optional strings remain distinct from absent keys in both write orders",
    );

    // Kind-only queue/discovery/unknown contexts must conflict with identified
    // variants in both directions and must not be interchangeable.
    await assertContextConflictPair(
      main.db,
      "queue kind-only vs empty queue id",
      { kind: "queue" },
      { kind: "queue", queueId: "" },
    );
    await assertContextConflictPair(
      main.db,
      "empty queue id vs queue kind-only",
      { kind: "queue", queueId: "" },
      { kind: "queue" },
    );
    await assertContextConflictPair(
      main.db,
      "discovery kind-only vs empty discovery context",
      { kind: "discovery" },
      { kind: "discovery", discoveryContextId: "" },
    );
    await assertContextConflictPair(
      main.db,
      "empty discovery context vs discovery kind-only",
      { kind: "discovery", discoveryContextId: "" },
      { kind: "discovery" },
    );
    await assertContextConflictPair(
      main.db,
      "queue vs discovery context",
      { kind: "queue" },
      { kind: "discovery" },
    );
    await assertContextConflictPair(
      main.db,
      "discovery vs queue context",
      { kind: "discovery" },
      { kind: "queue" },
    );
    await assertContextConflictPair(
      main.db,
      "queue vs unknown context",
      { kind: "queue" },
      { kind: "unknown" },
    );
    await assertContextConflictPair(
      main.db,
      "unknown vs queue context",
      { kind: "unknown" },
      { kind: "queue" },
    );
    await assertContextConflictPair(
      main.db,
      "discovery vs unknown context",
      { kind: "discovery" },
      { kind: "unknown" },
    );
    await assertContextConflictPair(
      main.db,
      "unknown vs discovery context",
      { kind: "unknown" },
      { kind: "discovery" },
    );
    outcomes.push(
      "kind-only queue/discovery/unknown contexts conflict in both directions, including cross-kind pairs, without overwriting",
    );

    // Composed and decomposed Unicode, and distinct lone surrogates, remain
    // exact in the canonical tuple serialization.
    const composedSuffix: string = "caf\u00e9";
    const decomposedSuffix: string = "cafe\u0301";
    assert(
      composedSuffix !== decomposedSuffix,
      "unicode fixtures must use different scalar sequences",
    );
    const unicodeAttempt = `unicode-${crypto.randomUUID()}`;
    const composedInput: PlaybackCompletionFact = {
      ...unknownFact(unicodeAttempt, `2026-11-04T04:00:00.000Z ${composedSuffix}`),
      subject: { youtubeId: `video-${composedSuffix}` },
    };
    const decomposedInput: PlaybackCompletionFact = {
      ...unknownFact(unicodeAttempt, `2026-11-04T04:00:00.000Z ${decomposedSuffix}`),
      subject: { youtubeId: `video-${decomposedSuffix}` },
    };
    const composedIssued = issueDisposableCompletion(composedInput);
    const afterComposed = await journalIssued(
      main.db,
      composedIssued,
      unicodeAttempt,
      "composed unicode",
    );
    await assertConflictLeaves(
      main.db,
      issueDisposableCompletion(decomposedInput),
      "decomposed unicode for the same attempt",
    );
    equal(
      await writeDisposableCompletion(main.db, composedIssued),
      "already-recorded",
      "composed unicode retry",
    );
    equal(
      await snapshot(main.db),
      afterComposed,
      "decomposed unicode conflict changed the row",
    );
    const decomposedReplayAttempt = `unicode-replay-${crypto.randomUUID()}`;
    await journalIssued(
      main.db,
      issueDisposableCompletion(
        withAttempt(decomposedInput, decomposedReplayAttempt),
      ),
      decomposedReplayAttempt,
      "decomposed unicode replay",
    );

    const loneA: string = "lone-\ud800-surrogate";
    const loneB: string = "lone-\ud801-surrogate";
    assert(loneA !== loneB, "lone surrogate fixtures must differ");
    const loneAttempt = `lone-${crypto.randomUUID()}`;
    const loneAInput: PlaybackCompletionFact = {
      ...unknownFact(loneAttempt, loneA),
      subject: { youtubeId: loneA },
    };
    const loneBInput: PlaybackCompletionFact = {
      ...unknownFact(loneAttempt, loneB),
      subject: { youtubeId: loneB },
    };
    const loneAIssued = issueDisposableCompletion(loneAInput);
    const afterLoneA = await journalIssued(
      main.db,
      loneAIssued,
      loneAttempt,
      "lone surrogate A",
    );
    equal(
      await writeDisposableCompletion(
        main.db,
        issueDisposableCompletion(loneAInput),
      ),
      "already-recorded",
      "lone surrogate A reissue",
    );
    await assertConflictLeaves(
      main.db,
      issueDisposableCompletion(loneBInput),
      "lone surrogate B for the same attempt",
    );
    equal(
      await snapshot(main.db),
      afterLoneA,
      "lone surrogate conflict changed the row",
    );
    const loneBReplayAttempt = `lone-replay-${crypto.randomUUID()}`;
    await journalIssued(
      main.db,
      issueDisposableCompletion(withAttempt(loneBInput, loneBReplayAttempt)),
      loneBReplayAttempt,
      "lone surrogate B replay",
    );
    outcomes.push(
      "composed/decomposed Unicode and distinct lone surrogates remain exact and distinct",
    );

    // A lone-surrogate attempt id must round-trip through the IndexedDB key
    // unchanged: keyPath "key" stores ["completion", attemptId] exactly, and
    // the same issued snapshot retries as already-recorded. \ud800 and \ud801
    // are distinct code units and must not collapse into each other.
    const surrogateAttempt = `lone-attempt-\ud800-${crypto.randomUUID()}`;
    const surrogateIssued = issueDisposableCompletion(
      unknownFact(surrogateAttempt, "2026-11-04T04:10:00.000Z"),
    );
    const afterSurrogate = await journalIssued(
      main.db,
      surrogateIssued,
      surrogateAttempt,
      "lone-surrogate attempt id",
    );
    const surrogateRow = journalRow(
      afterSurrogate.journal,
      surrogateAttempt,
      "lone-surrogate attempt id",
    );
    equal(
      surrogateRow.key,
      ["completion", surrogateAttempt],
      "lone-surrogate attempt id must round-trip exactly in the stored key",
    );
    equal(
      await writeDisposableCompletion(main.db, surrogateIssued),
      "already-recorded",
      "lone-surrogate attempt id retry",
    );
    equal(
      await snapshot(main.db),
      afterSurrogate,
      "lone-surrogate attempt id retry changed the fixture stores",
    );
    const otherSurrogateAttempt = `lone-attempt-\ud801-${crypto.randomUUID()}`;
    const otherSurrogateIssued = issueDisposableCompletion(
      unknownFact(otherSurrogateAttempt, "2026-11-04T04:11:00.000Z"),
    );
    await journalIssued(
      main.db,
      otherSurrogateIssued,
      otherSurrogateAttempt,
      "distinct lone-surrogate attempt id",
    );
    equal(
      journalRow(
        (await snapshot(main.db)).journal,
        surrogateAttempt,
        "lone-surrogate attempt id after distinct code unit",
      ).key,
      ["completion", surrogateAttempt],
      "a distinct lone-surrogate attempt id replaced the original key",
    );
    outcomes.push(
      "a lone-surrogate playback attempt id round-trips exactly as the stored key and retries as already-recorded",
    );

    // The issued snapshot is independent of later caller mutation of the raw
    // input. Raw input state is intentionally the caller's responsibility.
    const mutationAttempt = `mutation-${crypto.randomUUID()}`;
    const mutationInput: MutableCompletionInput = {
      playbackAttemptId: mutationAttempt,
      observedAt: "2026-11-04T05:00:00.000Z",
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "epoch-before-mutation",
        playlistId: "playlist-before-mutation",
        occurrenceId: "occurrence-before-mutation",
      },
      subject: {
        youtubeId: "youtube-before-mutation",
        queueItemId: "queue-item-before-mutation",
      },
      playbackContext: { kind: "queue", queueId: "queue-before-mutation" },
    };
    const mutationIssued = issueDisposableCompletion(mutationInput);
    mutationInput.observedAt = "observed-after-mutation";
    mutationInput.provenance.libraryEpoch = "epoch-after-mutation";
    mutationInput.provenance.playlistId = "playlist-after-mutation";
    mutationInput.provenance.occurrenceId = "occurrence-after-mutation";
    const mutationSubject = mutationInput.subject;
    assert(mutationSubject, "mutation fixture must include a subject");
    mutationSubject.youtubeId = "youtube-after-mutation";
    mutationSubject.queueItemId = "queue-item-after-mutation";
    const mutationContext = mutationInput.playbackContext;
    assert(mutationContext, "mutation fixture must include a playback context");
    mutationContext.queueId = "queue-after-mutation";
    const afterMutation = await journalIssued(
      main.db,
      mutationIssued,
      mutationAttempt,
      "issued mutation snapshot",
    );
    await assertConflictLeaves(
      main.db,
      issueDisposableCompletion(mutationInput),
      "mutated raw input for the same attempt",
    );
    equal(
      await writeDisposableCompletion(
        main.db,
        issueDisposableCompletion({
          playbackAttemptId: mutationAttempt,
          observedAt: "2026-11-04T05:00:00.000Z",
          provenance: {
            kind: "local-occurrence",
            libraryEpoch: "epoch-before-mutation",
            playlistId: "playlist-before-mutation",
            occurrenceId: "occurrence-before-mutation",
          },
          subject: {
            youtubeId: "youtube-before-mutation",
            queueItemId: "queue-item-before-mutation",
          },
          playbackContext: {
            kind: "queue",
            queueId: "queue-before-mutation",
          },
        }),
      ),
      "already-recorded",
      "original canonical input after raw mutation",
    );
    equal(
      await snapshot(main.db),
      afterMutation,
      "mutation replays changed the fixture stores",
    );
    outcomes.push(
      "an issued snapshot is independent of later raw-input mutation and still canonicalizes to the original fact",
    );

    // Concurrent reads/writes for one attempt serialize to one append. Two
    // independent issues of the same input are both accepted tokens.
    const concurrentAttempt = `concurrent-${crypto.randomUUID()}`;
    const concurrentInput = unknownFact(
      concurrentAttempt,
      "2026-11-04T06:00:00.000Z",
    );
    const concurrentIssuedA = issueDisposableCompletion(concurrentInput);
    const concurrentIssuedB = issueDisposableCompletion(concurrentInput);
    const beforeConcurrent = await snapshot(main.db);
    const concurrentResults = await Promise.all([
      writeDisposableCompletion(main.db, concurrentIssuedA),
      writeDisposableCompletion(main.db, concurrentIssuedB),
    ]);
    equal(
      [...concurrentResults].sort(),
      ["already-recorded", "journaled"],
      "concurrent same-attempt results",
    );
    const afterConcurrent = await snapshot(main.db);
    equal(
      afterConcurrent.history,
      beforeConcurrent.history,
      "concurrent same-attempt calls changed playHistory",
    );
    equal(
      afterConcurrent.journal.length,
      beforeConcurrent.journal.length + 1,
      "concurrent same-attempt journal count",
    );
    assertJournalRecord(
      journalRow(
        afterConcurrent.journal,
        concurrentAttempt,
        "concurrent same-attempt",
      ),
      concurrentAttempt,
      "concurrent same-attempt",
    );
    outcomes.push(
      "concurrent calls for one attempt produce exactly one journaled result and one already-recorded result",
    );

    // Corrupt rows and keys fail closed without being overwritten. Payload-only
    // cases use an invalid payload; record-shape cases first journal a valid
    // row, then reuse its exact opaque payload and mutate exactly one other
    // property. This makes each shape conflict non-vacuous.
    const corruptPayloadAttempt = `corrupt-payload-${crypto.randomUUID()}`;
    const corruptPayloadIssued = issueDisposableCompletion(
      unknownFact(corruptPayloadAttempt, "2026-11-04T07:00:00.000Z"),
    );
    await putJournalRecord(main.db, {
      key: ["completion", corruptPayloadAttempt],
      version: 1,
      payload: "not-a-canonical-payload",
    });
    let beforeCorrupt = await snapshot(main.db);
    equal(
      await writeDisposableCompletion(main.db, corruptPayloadIssued),
      "conflict",
      "corrupt payload string",
    );
    equal(
      await snapshot(main.db),
      beforeCorrupt,
      "corrupt payload string changed the fixture stores",
    );

    const corruptPayloadTypeAttempt = `corrupt-payload-type-${crypto.randomUUID()}`;
    const corruptPayloadTypeIssued = issueDisposableCompletion(
      unknownFact(corruptPayloadTypeAttempt, "2026-11-04T07:01:00.000Z"),
    );
    await putJournalRecord(main.db, {
      key: ["completion", corruptPayloadTypeAttempt],
      version: 1,
      payload: 123,
    });
    beforeCorrupt = await snapshot(main.db);
    equal(
      await writeDisposableCompletion(main.db, corruptPayloadTypeIssued),
      "conflict",
      "non-string corrupt payload",
    );
    equal(
      await snapshot(main.db),
      beforeCorrupt,
      "non-string corrupt payload changed the fixture stores",
    );

    const corruptRecordAttempt = `corrupt-record-${crypto.randomUUID()}`;
    const corruptRecordSeed = await seedValidJournalRow(
      main.db,
      corruptRecordAttempt,
      "corrupt extra-field seed",
    );
    assert(
      typeof corruptRecordSeed.row.payload === "string" &&
        corruptRecordSeed.row.payload.length > 0,
      "corrupt extra-field seed did not contain an opaque payload",
    );
    await putJournalRecord(main.db, {
      ...corruptRecordSeed.row,
      extra: true,
    });
    beforeCorrupt = await snapshot(main.db);
    equal(
      journalRow(beforeCorrupt.journal, corruptRecordAttempt, "extra field")
        .extra,
      true,
      "the seeded extra field did not survive the stored row",
    );
    equal(
      await writeDisposableCompletion(main.db, corruptRecordSeed.issued),
      "conflict",
      "corrupt record extra field with valid payload",
    );
    equal(
      await snapshot(main.db),
      beforeCorrupt,
      "corrupt record extra field changed the fixture stores",
    );

    const corruptVersionAttempt = `corrupt-version-${crypto.randomUUID()}`;
    const corruptVersionSeed = await seedValidJournalRow(
      main.db,
      corruptVersionAttempt,
      "corrupt version seed",
    );
    assert(
      typeof corruptVersionSeed.row.payload === "string" &&
        corruptVersionSeed.row.payload.length > 0,
      "corrupt version seed did not contain an opaque payload",
    );
    await putJournalRecord(main.db, {
      ...corruptVersionSeed.row,
      version: 2,
    });
    beforeCorrupt = await snapshot(main.db);
    equal(
      journalRow(beforeCorrupt.journal, corruptVersionAttempt, "version")
        .version,
      2,
      "the seeded corrupt version did not survive the stored row",
    );
    equal(
      await writeDisposableCompletion(main.db, corruptVersionSeed.issued),
      "conflict",
      "corrupt record version with valid payload",
    );
    equal(
      await snapshot(main.db),
      beforeCorrupt,
      "corrupt record version changed the fixture stores",
    );

    const corruptKeyAttempt = `corrupt-key-${crypto.randomUUID()}`;
    const corruptKeySeed = await seedValidJournalRow(
      main.db,
      corruptKeyAttempt,
      "corrupt key seed",
    );
    assert(
      typeof corruptKeySeed.row.payload === "string" &&
        corruptKeySeed.row.payload.length > 0,
      "corrupt key seed did not contain an opaque payload",
    );
    const corruptKey: [string, string] = ["completion", corruptKeyAttempt];
    Object.defineProperty(corruptKey, "extra", {
      value: "corrupt",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    await putJournalRecord(main.db, {
      ...corruptKeySeed.row,
      key: corruptKey,
    });
    beforeCorrupt = await snapshot(main.db);
    const storedCorruptKey = journalRow(
      beforeCorrupt.journal,
      corruptKeyAttempt,
      "corrupt key extra",
    ).key;
    assert(
      Array.isArray(storedCorruptKey),
      "corrupt key extra was not stored as an array",
    );
    equal(storedCorruptKey.length, 2, "corrupt key extra length");
    assert(
      Object.prototype.hasOwnProperty.call(storedCorruptKey, "extra"),
      "the extra key property did not survive the stored row",
    );
    equal(
      (storedCorruptKey as unknown as Record<string, unknown>).extra,
      "corrupt",
      "the extra key property value did not survive the stored row",
    );
    equal(
      Object.keys(storedCorruptKey).sort(),
      ["0", "1", "extra"],
      "the extra key property was not enumerable after storage",
    );
    equal(
      await writeDisposableCompletion(main.db, corruptKeySeed.issued),
      "conflict",
      "corrupt key extra enumerable property with valid payload",
    );
    const afterCorruptKey = await snapshot(main.db);
    equal(
      afterCorruptKey,
      beforeCorrupt,
      "corrupt key conflict changed the fixture stores",
    );
    const afterCorruptKeyRow = journalRow(
      afterCorruptKey.journal,
      corruptKeyAttempt,
      "corrupt key extra after conflict",
    );
    const afterStoredCorruptKey = afterCorruptKeyRow.key;
    assert(
      Array.isArray(afterStoredCorruptKey),
      "corrupt key extra was not an array after conflict",
    );
    assert(
      Object.prototype.hasOwnProperty.call(afterStoredCorruptKey, "extra"),
      "the extra key property did not survive the conflict snapshot",
    );
    equal(
      (afterStoredCorruptKey as unknown as Record<string, unknown>).extra,
      "corrupt",
      "the extra key property value did not survive the conflict snapshot",
    );
    equal(
      Object.keys(afterStoredCorruptKey).sort(),
      ["0", "1", "extra"],
      "the extra key property was not enumerable in the conflict snapshot",
    );
    outcomes.push(
      "corrupt payloads, record fields, versions, and extra key properties fail closed and are never overwritten; record-shape cases reuse a valid opaque payload and the key extra property survives structured clone before and after the conflict",
    );

    // An enumerable Array.prototype property must not pollute exact key or
    // tuple comparison and turn an identical retry into a conflict.
    const pollutionAttempt = `prototype-${crypto.randomUUID()}`;
    const pollutionIssued = issueDisposableCompletion(
      unknownFact(pollutionAttempt, "2026-11-04T07:10:00.000Z"),
    );
    const afterPollutionSeed = await journalIssued(
      main.db,
      pollutionIssued,
      pollutionAttempt,
      "prototype-pollution seed",
    );
    const pollutionKey = "__journal_guard_enumerable_array_property__";
    assert(
      !Object.prototype.hasOwnProperty.call(Array.prototype, pollutionKey),
      "Array.prototype pollution key was already present",
    );
    Object.defineProperty(Array.prototype, pollutionKey, {
      value: "inherited",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      equal(
        await writeDisposableCompletion(main.db, pollutionIssued),
        "already-recorded",
        "exact retry under an enumerable Array.prototype property",
      );
      equal(
        await snapshot(main.db),
        afterPollutionSeed,
        "Array.prototype pollution retry changed the fixture stores",
      );
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)[
        pollutionKey
      ];
    }
    assert(
      !Object.prototype.hasOwnProperty.call(Array.prototype, pollutionKey),
      "Array.prototype pollution key was not removed",
    );
    outcomes.push(
      "an enumerable Array.prototype property does not turn an exact retry into a conflict",
    );

    // Object.prototype pollution must not make a factory-issued absent subject
    // field look like an own value. A null-prototype subject has no inherited
    // youtubeId when it is read, so its issued snapshot is the absent form.
    // The own value is deliberately identical to the inherited polluter; only
    // own-property canonicalization keeps the two facts distinct.
    const inheritedVideo = `inherited-video-${crypto.randomUUID()}`;
    const absentFirstAttempt = `prototype-absent-first-${crypto.randomUUID()}`;
    const presentFirstAttempt = `prototype-present-first-${crypto.randomUUID()}`;
    const nullPrototypeSubject = Object.create(
      null,
    ) as NonNullable<PlaybackCompletionFact["subject"]>;
    const ownInheritedValueSubject: NonNullable<
      PlaybackCompletionFact["subject"]
    > = { youtubeId: inheritedVideo };
    assert(
      !Object.prototype.hasOwnProperty.call(Object.prototype, "youtubeId"),
      "Object.prototype.youtubeId was already present",
    );
    Object.defineProperty(Object.prototype, "youtubeId", {
      value: inheritedVideo,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      const absentFirst = issueDisposableCompletion({
        ...unknownFact(absentFirstAttempt, "2026-11-04T07:20:00.000Z"),
        subject: nullPrototypeSubject,
      });
      const presentConflictForAbsentFirst = issueDisposableCompletion({
        ...unknownFact(absentFirstAttempt, "2026-11-04T07:20:00.000Z"),
        subject: ownInheritedValueSubject,
      });
      const afterAbsentSubject = await journalIssued(
        main.db,
        absentFirst,
        absentFirstAttempt,
        "inherited youtubeId: absent first",
      );
      await assertConflictLeaves(
        main.db,
        presentConflictForAbsentFirst,
        "own youtubeId identical to the inherited value",
      );
      equal(
        await writeDisposableCompletion(main.db, absentFirst),
        "already-recorded",
        "absent youtubeId retry under Object.prototype pollution",
      );
      equal(
        await snapshot(main.db),
        afterAbsentSubject,
        "absent youtubeId retry under pollution changed the fixture stores",
      );

      const presentFirst = issueDisposableCompletion({
        ...unknownFact(presentFirstAttempt, "2026-11-04T07:21:00.000Z"),
        subject: ownInheritedValueSubject,
      });
      const absentConflictForPresentFirst = issueDisposableCompletion({
        ...unknownFact(presentFirstAttempt, "2026-11-04T07:21:00.000Z"),
        subject: nullPrototypeSubject,
      });
      const afterPresentSubject = await journalIssued(
        main.db,
        presentFirst,
        presentFirstAttempt,
        "own youtubeId identical to inherited value",
      );
      await assertConflictLeaves(
        main.db,
        absentConflictForPresentFirst,
        "absent youtubeId after own identical value",
      );
      equal(
        await writeDisposableCompletion(main.db, presentFirst),
        "already-recorded",
        "own youtubeId retry under Object.prototype pollution",
      );
      equal(
        await snapshot(main.db),
        afterPresentSubject,
        "own youtubeId retry under pollution changed the fixture stores",
      );
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).youtubeId;
    }
    assert(
      !Object.prototype.hasOwnProperty.call(Object.prototype, "youtubeId"),
      "Object.prototype.youtubeId was not removed",
    );
    outcomes.push(
      "Object.prototype.youtubeId pollution cannot make a factory-issued absent subject field equal an own identical value; the facts conflict in both write orders",
    );

    // An inherited get/set descriptor for youtubeId must not be read by the
    // writer when comparing an exact retry. The own value stays authoritative
    // and the accessor is never invoked.
    const descriptorVideo = `descriptor-video-${crypto.randomUUID()}`;
    const descriptorAttempt = `descriptor-${crypto.randomUUID()}`;
    const descriptorInput: PlaybackCompletionFact = {
      ...unknownFact(descriptorAttempt, "2026-11-04T07:30:00.000Z"),
      subject: { youtubeId: descriptorVideo },
    };
    const descriptorIssued = issueDisposableCompletion(descriptorInput);
    const afterDescriptor = await journalIssued(
      main.db,
      descriptorIssued,
      descriptorAttempt,
      "descriptor prototype youtubeId seed",
    );
    assert(
      !Object.prototype.hasOwnProperty.call(Object.prototype, "youtubeId"),
      "Object.prototype.youtubeId accessor was already present",
    );
    let descriptorGets = 0;
    let descriptorSets = 0;
    Object.defineProperty(Object.prototype, "youtubeId", {
      get() {
        descriptorGets += 1;
        return "prototype-descriptor-video";
      },
      set(value: unknown) {
        void value;
        descriptorSets += 1;
      },
      enumerable: true,
      configurable: true,
    });
    try {
      equal(
        await writeDisposableCompletion(main.db, descriptorIssued),
        "already-recorded",
        "exact retry under an inherited youtubeId accessor",
      );
      equal(
        await snapshot(main.db),
        afterDescriptor,
        "inherited accessor retry changed the fixture stores",
      );
      assert(
        descriptorGets === 0,
        `the writer invoked the inherited youtubeId getter ${descriptorGets} time(s)`,
      );
      assert(
        descriptorSets === 0,
        `the writer invoked the inherited youtubeId setter ${descriptorSets} time(s)`,
      );
      const descriptorReissued = issueDisposableCompletion(descriptorInput);
      equal(
        await writeDisposableCompletion(main.db, descriptorReissued),
        "already-recorded",
        "canonical reissue under an inherited youtubeId accessor",
      );
      equal(
        await snapshot(main.db),
        afterDescriptor,
        "inherited accessor reissue changed the fixture stores",
      );
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).youtubeId;
    }
    assert(
      !Object.prototype.hasOwnProperty.call(Object.prototype, "youtubeId"),
      "Object.prototype.youtubeId accessor was not removed",
    );
    outcomes.push(
      "an inherited get/set descriptor for youtubeId does not cause a false conflict and its accessors are never invoked",
    );

    // Stored-record shape checks must inspect descriptor objects with own
    // properties only. Real prototype pollution can add inherited properties
    // named "get" and "set"; those must not make every own data descriptor look
    // like an accessor. The sentinels are inert, non-enumerable, and restored in
    // a finally block so unrelated global behavior is not left polluted.
    const descriptorNameAttempt = `descriptor-name-${crypto.randomUUID()}`;
    const descriptorNameIssued = issueDisposableCompletion(
      unknownFact(descriptorNameAttempt, "2026-11-04T07:40:00.000Z"),
    );
    const afterDescriptorName = await journalIssued(
      main.db,
      descriptorNameIssued,
      descriptorNameAttempt,
      "descriptor-name pollution seed",
    );
    const inheritedDescriptorKey = function inheritedDescriptorKey(): void {
      // Inert sentinel; the writer must never invoke it.
    };
    const descriptorNames = ["get", "set"] as const;
    for (const name of descriptorNames) {
      assert(
        !Object.prototype.hasOwnProperty.call(Object.prototype, name),
        `Object.prototype.${name} was already present`,
      );
    }
    // Use a null-prototype descriptor: once Object.prototype has a property
    // named "get", an ordinary descriptor literal would inherit it and
    // Object.defineProperty would reject the mixed accessor/value descriptor.
    const inheritedDescriptor = Object.create(null) as {
      value: unknown;
      enumerable: boolean;
      configurable: boolean;
      writable: boolean;
    };
    inheritedDescriptor.value = inheritedDescriptorKey;
    inheritedDescriptor.enumerable = false;
    inheritedDescriptor.configurable = true;
    inheritedDescriptor.writable = false;
    for (const name of descriptorNames) {
      Object.defineProperty(Object.prototype, name, inheritedDescriptor);
    }
    try {
      equal(
        await writeDisposableCompletion(main.db, descriptorNameIssued),
        "already-recorded",
        "exact retry under inherited get/set descriptor-name pollution",
      );
      equal(
        await snapshot(main.db),
        afterDescriptorName,
        "descriptor-name pollution retry changed the fixture stores",
      );
    } finally {
      for (const name of descriptorNames) {
        delete (Object.prototype as unknown as Record<string, unknown>)[name];
      }
    }
    for (const name of descriptorNames) {
      assert(
        !Object.prototype.hasOwnProperty.call(Object.prototype, name),
        `Object.prototype.${name} was not removed`,
      );
    }
    outcomes.push(
      "inherited Object.prototype get/set descriptor-name pollution does not turn an exact retry into a conflict and is restored",
    );

    // Production and non-test names are rejected from the injected handle.
    const productionProbe = issueDisposableCompletion(
      unknownFact(`production-probe-${crypto.randomUUID()}`, "2026-11-04T08:00:00.000Z"),
    );
    await rejectsWithTypeError(
      Promise.resolve().then(() =>
        writeDisposableCompletion(
          { name: PRODUCTION_DB_NAME } as unknown as IDBDatabase,
          productionProbe,
        ),
      ),
      "fake production database handle",
    );
    assert(
      guard.productionOpenAttempts === 0,
      "the production database open was attempted",
    );

    wrong = await openFixtureDatabase(wrongDbName, confirmedFixtureNames, guard);
    const wrongDb = wrong.db;
    const beforeWrong = await snapshot(wrongDb);
    await rejectsWithTypeError(
      Promise.resolve().then(() =>
        writeDisposableCompletion(wrongDb, productionProbe),
      ),
      "real database with a non-test prefix",
    );
    equal(
      await snapshot(wrongDb),
      beforeWrong,
      "wrong-prefix rejection changed the wrong-prefix fixture stores",
    );
    outcomes.push(
      "production name is rejected without opening it and a real database with the wrong prefix is rejected without writes",
    );

    // A fresh fixture database opened from a same-origin iframe realm is handed
    // to the parent-realm writer. Chrome shares IndexedDB per origin, but the
    // handle and retrieved records are cross-realm objects; the writer is
    // required to recognize cross-realm plain records for exact retries.
    // Changed payloads and corrupt rows must stay conflicts with no mutation.
    const iframeAttempt = `cross-realm-${crypto.randomUUID()}`;
    const iframeIssued = issueDisposableCompletion(
      unknownFact(iframeAttempt, "2026-11-04T08:30:00.000Z"),
    );
    const frame = await loadIframeFixtureFrame();
    let iframeFixture: FixtureDatabase | undefined;
    try {
      iframeFixture = await openIframeFixtureDatabase(
        guard.iframeDbName,
        frame,
        confirmedFixtureNames,
        guard,
      );
      const iframeDb = iframeFixture.db;
      const beforeIframe = await snapshot(iframeDb);
      equal(
        await writeDisposableCompletion(iframeDb, iframeIssued),
        "journaled",
        "cross-realm iframe first write result",
      );
      const afterIframe = await snapshot(iframeDb);
      equal(
        afterIframe.history,
        beforeIframe.history,
        "cross-realm iframe write changed playHistory",
      );
      equal(
        afterIframe.journal.length,
        beforeIframe.journal.length + 1,
        "cross-realm iframe journal row count",
      );
      assertJournalRecord(
        journalRow(afterIframe.journal, iframeAttempt, "cross-realm iframe"),
        iframeAttempt,
        "cross-realm iframe",
      );
      equal(
        await writeDisposableCompletion(iframeDb, iframeIssued),
        "already-recorded",
        "cross-realm iframe identical retry",
      );
      equal(
        await snapshot(iframeDb),
        afterIframe,
        "cross-realm iframe identical retry changed the fixture stores",
      );

      const changedIframeIssued = issueDisposableCompletion({
        ...unknownFact(iframeAttempt, "2026-11-04T08:31:00.000Z"),
        subject: { youtubeId: "cross-realm-changed-payload" },
      });
      equal(
        await writeDisposableCompletion(iframeDb, changedIframeIssued),
        "conflict",
        "cross-realm changed payload",
      );
      equal(
        await snapshot(iframeDb),
        afterIframe,
        "cross-realm changed payload changed the fixture stores",
      );

      const corruptIframeAttempt = `cross-realm-corrupt-${crypto.randomUUID()}`;
      const corruptIframeIssued = issueDisposableCompletion(
        unknownFact(corruptIframeAttempt, "2026-11-04T08:32:00.000Z"),
      );
      equal(
        await writeDisposableCompletion(iframeDb, corruptIframeIssued),
        "journaled",
        "cross-realm corrupt-row seed",
      );
      const seededIframe = await snapshot(iframeDb);
      const validIframeRow = journalRow(
        seededIframe.journal,
        corruptIframeAttempt,
        "cross-realm corrupt-row seed",
      );
      assert(
        typeof validIframeRow.payload === "string" &&
          validIframeRow.payload.length > 0,
        "cross-realm corrupt-row seed did not contain an opaque payload",
      );
      await putJournalRecord(iframeDb, {
        ...validIframeRow,
        version: 2,
      });
      const beforeCorruptIframe = await snapshot(iframeDb);
      const corruptIframeRow = journalRow(
        beforeCorruptIframe.journal,
        corruptIframeAttempt,
        "cross-realm corrupt row",
      );
      equal(
        corruptIframeRow.version,
        2,
        "the cross-realm corrupt version did not survive the stored row",
      );
      equal(
        corruptIframeRow.payload,
        validIframeRow.payload,
        "the cross-realm corrupt row did not reuse the valid opaque payload",
      );
      equal(
        await writeDisposableCompletion(iframeDb, corruptIframeIssued),
        "conflict",
        "cross-realm corrupt row with valid payload",
      );
      equal(
        await snapshot(iframeDb),
        beforeCorruptIframe,
        "cross-realm corrupt row changed the fixture stores",
      );
      outcomes.push(
        "a same-origin iframe-created fixture database accepts a parent-realm issued snapshot: first write is journaled, an identical retry is already-recorded, a changed payload is a conflict, and a corrupt row is a conflict without mutation",
      );
    } finally {
      iframeFixture?.db.close();
      frame.remove();
    }

    // A queued journal write is rolled back when the add call fails after
    // enqueueing. Assert the request was actually pending and the transaction
    // abort was observed, not just that the promise rejected.
    const abortAttempt = `abort-${crypto.randomUUID()}`;
    const abortIssued = issueDisposableCompletion(
      unknownFact(abortAttempt, "2026-11-04T09:00:00.000Z"),
    );
    const nativeAdd = IDBObjectStore.prototype.add;
    const nativeAbortForInjection = IDBTransaction.prototype.abort;
    let injectAddFailure = false;
    let injected = false;
    let injectedRequest: IDBRequest | undefined;
    let injectedReadyState: IDBRequestReadyState | undefined;
    let injectedTransaction: IDBTransaction | undefined;
    let injectedTerminal:
      | ReturnType<typeof observeTransactionTerminal>
      | undefined;
    let injectedAbortAttempted = false;
    let injectedAbortThrew: unknown;
    let injectedError: DOMException | undefined;
    const patchedAdd = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (injectAddFailure && this.name === JOURNAL_STORE) {
        injectAddFailure = false;
        injected = true;
        const request = nativeAdd.call(this, value, key);
        injectedRequest = request;
        injectedReadyState = request.readyState;
        injectedTransaction = this.transaction;
        injectedTerminal = observeTransactionTerminal(this.transaction);
        injectedError = new DOMException(
          "Injected completionJournal add failure",
          "AbortError",
        );
        throw injectedError;
      }
      return nativeAdd.call(this, value, key);
    };
    const patchedAbortForInjection = function (this: IDBTransaction) {
      if (this === injectedTransaction) {
        injectedAbortAttempted = true;
        try {
          return nativeAbortForInjection.call(this);
        } catch (error) {
          injectedAbortThrew = error;
          throw error;
        }
      }
      return nativeAbortForInjection.call(this);
    };
    IDBObjectStore.prototype.add =
      patchedAdd as typeof IDBObjectStore.prototype.add;
    IDBTransaction.prototype.abort =
      patchedAbortForInjection as typeof IDBTransaction.prototype.abort;
    try {
      const beforeAbort = await snapshot(main.db);
      injectAddFailure = true;
      let abortRejection: unknown;
      try {
        await writeDisposableCompletion(main.db, abortIssued);
      } catch (error) {
        abortRejection = error;
      }
      assert(injected, "request-failure injector did not run");
      assert(
        injectedRequest,
        "request-failure injector did not enqueue a request",
      );
      equal(
        injectedReadyState,
        "pending",
        "injected add request must be pending when the injected failure is thrown",
      );
      assert(
        injectedTransaction,
        "injected add request did not expose its transaction",
      );
      assert(
        injectedError !== undefined && abortRejection === injectedError,
        "writer did not reject with the intended injected failure",
      );
      assert(
        injectedTerminal?.abortObserved(),
        `injected failure did not abort the transaction (attempted=${injectedAbortAttempted}, threw=${String(
          injectedAbortThrew,
        )}, completed=${String(
          injectedTerminal?.completeObserved(),
        )}, txError=${String(injectedTransaction?.error)})`,
      );
      assert(
        injectedAbortAttempted && injectedAbortThrew === undefined,
        `injected failure abort() did not complete normally (attempted=${injectedAbortAttempted}, threw=${String(
          injectedAbortThrew,
        )})`,
      );
      equal(
        injectedRequest.readyState,
        "done",
        "injected add request must be done after abort",
      );
      equal(
        injectedRequest.error?.name,
        "AbortError",
        "injected add request did not receive AbortError",
      );
      equal(
        await snapshot(main.db),
        beforeAbort,
        "request failure left a partial journal write",
      );
    } finally {
      injectAddFailure = false;
      IDBObjectStore.prototype.add = nativeAdd;
      IDBTransaction.prototype.abort = nativeAbortForInjection;
    }
    outcomes.push(
      "an injected journal-store add failure enqueues a pending request, is observed as the intended error, aborts the transaction, and rolls back the queued write",
    );

    // A native request error: force the writer's read to miss an existing key,
    // then let IndexedDB reject the duplicate add with ConstraintError. The
    // writer must reject with the native ConstraintError and abort the
    // transaction without changing the existing assertion.
    const requestFailureAttempt = `request-failure-${crypto.randomUUID()}`;
    const requestFailureIssued = issueDisposableCompletion(
      unknownFact(requestFailureAttempt, "2026-11-04T10:00:00.000Z"),
    );
    equal(
      await writeDisposableCompletion(main.db, requestFailureIssued),
      "journaled",
      "request-failure seed",
    );
    const beforeRequestFailure = await snapshot(main.db);
    const nativeGet = IDBObjectStore.prototype.get;
    const nativeAddForConstraint = IDBObjectStore.prototype.add;
    let injectMissingRead = false;
    let injectedMissingRead = false;
    let captureConstraintAdd = false;
    let constraintRequest: IDBRequest | undefined;
    let constraintReadyState: IDBRequestReadyState | undefined;
    let constraintTransaction: IDBTransaction | undefined;
    let constraintTerminal:
      | ReturnType<typeof observeTransactionTerminal>
      | undefined;
    const patchedGet = function (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ) {
      if (injectMissingRead && this.name === JOURNAL_STORE) {
        injectMissingRead = false;
        injectedMissingRead = true;
        return nativeGet.call(this, [
          "completion",
          `forced-miss-${crypto.randomUUID()}`,
        ]);
      }
      return nativeGet.call(this, query);
    };
    const patchedAddForConstraint = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = nativeAddForConstraint.call(this, value, key);
      if (captureConstraintAdd && this.name === JOURNAL_STORE) {
        captureConstraintAdd = false;
        constraintRequest = request;
        constraintReadyState = request.readyState;
        constraintTransaction = this.transaction;
        constraintTerminal = observeTransactionTerminal(this.transaction);
      }
      return request;
    };
    IDBObjectStore.prototype.get =
      patchedGet as typeof IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.add =
      patchedAddForConstraint as typeof IDBObjectStore.prototype.add;
    try {
      injectMissingRead = true;
      captureConstraintAdd = true;
      let requestFailure: unknown;
      try {
        await writeDisposableCompletion(main.db, requestFailureIssued);
      } catch (error) {
        requestFailure = error;
      }
      assert(injectedMissingRead, "missing-read injector did not run");
      assert(
        constraintRequest,
        "duplicate-key injector did not capture the add request",
      );
      equal(
        constraintReadyState,
        "pending",
        "duplicate-key add request must be pending at enqueue",
      );
      assert(
        constraintTransaction,
        "duplicate-key add request did not expose its transaction",
      );
      assert(
        requestFailure instanceof DOMException &&
          requestFailure.name === "ConstraintError",
        `duplicate-key writer rejection was ${String(requestFailure)}`,
      );
      equal(
        constraintRequest.error?.name,
        "ConstraintError",
        "duplicate-key add request did not issue ConstraintError",
      );
      assert(
        constraintTerminal?.abortObserved(),
        "duplicate-key failure did not abort the transaction",
      );
      equal(
        constraintRequest.readyState,
        "done",
        "duplicate-key add request must be done after abort",
      );
      equal(
        await snapshot(main.db),
        beforeRequestFailure,
        "native request failure changed the existing journal or history fixture stores",
      );
    } finally {
      injectMissingRead = false;
      captureConstraintAdd = false;
      IDBObjectStore.prototype.get = nativeGet;
      IDBObjectStore.prototype.add = nativeAddForConstraint;
    }
    outcomes.push(
      "a native duplicate-key request failure issues ConstraintError, rejects with it, aborts the transaction, and leaves the existing assertion and history unchanged",
    );

    // The writer may observe a transaction already aborted by someone else.
    // Its own abort() attempt then throws InvalidStateError; settlement must
    // wait for the terminal abort/complete event rather than rejecting early.
    const externalAbortAttempt = `external-abort-${crypto.randomUUID()}`;
    const externalAbortIssued = issueDisposableCompletion(
      unknownFact(externalAbortAttempt, "2026-11-04T11:00:00.000Z"),
    );
    const beforeExternalAbort = await snapshot(main.db);
    const nativeAddForExternalAbort = IDBObjectStore.prototype.add;
    const nativeAbortForExternalAbort = IDBTransaction.prototype.abort;
    let externalAbortRequest: IDBRequest | undefined;
    let externalAbortReadyState: IDBRequestReadyState | undefined;
    let externalAbortTransaction: IDBTransaction | undefined;
    let externalAbortTerminal:
      | ReturnType<typeof observeTransactionTerminal>
      | undefined;
    let externalAbortIssuedFlag = false;
    let externalAbortAttempts = 0;
    let externalAbortThrew = false;
    let terminalAtSettlement = false;
    const patchedExternalAbortAdd = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = nativeAddForExternalAbort.call(this, value, key);
      if (this.name === JOURNAL_STORE) {
        externalAbortRequest = request;
        externalAbortReadyState = request.readyState;
        externalAbortTransaction = this.transaction;
        externalAbortTerminal = observeTransactionTerminal(this.transaction);
        // Abort externally while the add request is still pending.
        nativeAbortForExternalAbort.call(this.transaction);
        externalAbortIssuedFlag = true;
        throw new DOMException(
          "Injected add failure after external abort",
          "AbortError",
        );
      }
      return request;
    };
    const patchedExternalAbortAbort = function (this: IDBTransaction) {
      if (this === externalAbortTransaction) {
        externalAbortAttempts++;
        externalAbortThrew = true;
        throw new DOMException(
          "Injected InvalidStateError for an already-aborted transaction",
          "InvalidStateError",
        );
      }
      return nativeAbortForExternalAbort.call(this);
    };
    IDBObjectStore.prototype.add =
      patchedExternalAbortAdd as typeof IDBObjectStore.prototype.add;
    IDBTransaction.prototype.abort =
      patchedExternalAbortAbort as typeof IDBTransaction.prototype.abort;
    try {
      let externalAbortRejection: unknown;
      try {
        await writeDisposableCompletion(main.db, externalAbortIssued);
      } catch (error) {
        externalAbortRejection = error;
      }
      terminalAtSettlement =
        externalAbortTerminal?.abortObserved() === true ||
        externalAbortTerminal?.completeObserved() === true;
      assert(
        externalAbortRequest,
        "external-abort case did not enqueue an add request",
      );
      equal(
        externalAbortReadyState,
        "pending",
        "external-abort add request must be pending when aborted",
      );
      assert(
        externalAbortIssuedFlag,
        "external-abort case did not abort natively",
      );
      assert(
        externalAbortRejection !== undefined,
        "external-abort case unexpectedly resolved",
      );
      assert(
        externalAbortAttempts >= 1,
        "writer did not attempt to abort its already-aborted transaction",
      );
      assert(
        externalAbortThrew,
        "the mocked abort() did not throw InvalidStateError",
      );
      assert(
        externalAbortTerminal?.abortObserved() ||
          externalAbortTerminal?.completeObserved(),
        "no terminal transaction event was observed",
      );
      assert(
        terminalAtSettlement,
        "writer settled before the terminal transaction event",
      );
      equal(
        externalAbortRequest.readyState,
        "done",
        "external-abort add request must be done after abort",
      );
      equal(
        await snapshot(main.db),
        beforeExternalAbort,
        "external abort changed the fixture stores",
      );
    } finally {
      IDBObjectStore.prototype.add = nativeAddForExternalAbort;
      IDBTransaction.prototype.abort = nativeAbortForExternalAbort;
    }
    outcomes.push(
      "an external abort while an add is pending, with abort() throwing InvalidStateError, settles only at the terminal transaction event",
    );

    // A synchronous injected add failure after the request is queued, while the
    // writer's abort() throws and does not abort, leaves the transaction to
    // complete. The writer must reject as indeterminate at the terminal event;
    // the queued add commits, and a retry finds the committed row.
    const indeterminateAttempt = `indeterminate-${crypto.randomUUID()}`;
    const indeterminateIssued = issueDisposableCompletion(
      unknownFact(indeterminateAttempt, "2026-11-04T11:30:00.000Z"),
    );
    const beforeIndeterminate = await snapshot(main.db);
    const nativeAddForIndeterminate = IDBObjectStore.prototype.add;
    const nativeAbortForIndeterminate = IDBTransaction.prototype.abort;
    let injectIndeterminate = false;
    let indeterminateRequest: IDBRequest | undefined;
    let indeterminateReadyState: IDBRequestReadyState | undefined;
    let indeterminateTransaction: IDBTransaction | undefined;
    let indeterminateTerminal:
      | ReturnType<typeof observeTransactionTerminal>
      | undefined;
    let indeterminateAbortAttempts = 0;
    let indeterminateAbortThrew = false;
    let indeterminateTerminalAtSettlement = false;
    const patchedAddForIndeterminate = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (injectIndeterminate && this.name === JOURNAL_STORE) {
        injectIndeterminate = false;
        const request = nativeAddForIndeterminate.call(this, value, key);
        indeterminateRequest = request;
        indeterminateReadyState = request.readyState;
        indeterminateTransaction = this.transaction;
        indeterminateTerminal = observeTransactionTerminal(this.transaction);
        throw new DOMException(
          "Injected add failure with an ineffective abort",
          "AbortError",
        );
      }
      return nativeAddForIndeterminate.call(this, value, key);
    };
    const patchedAbortForIndeterminate = function (this: IDBTransaction) {
      if (this === indeterminateTransaction) {
        indeterminateAbortAttempts += 1;
        indeterminateAbortThrew = true;
        throw new DOMException(
          "Injected abort() failure for a completing transaction",
          "InvalidStateError",
        );
      }
      return nativeAbortForIndeterminate.call(this);
    };
    IDBObjectStore.prototype.add =
      patchedAddForIndeterminate as typeof IDBObjectStore.prototype.add;
    IDBTransaction.prototype.abort =
      patchedAbortForIndeterminate as typeof IDBTransaction.prototype.abort;
    try {
      injectIndeterminate = true;
      let indeterminateRejection: unknown;
      try {
        await writeDisposableCompletion(main.db, indeterminateIssued);
      } catch (error) {
        indeterminateRejection = error;
      }
      indeterminateTerminalAtSettlement =
        indeterminateTerminal?.abortObserved() === true ||
        indeterminateTerminal?.completeObserved() === true;
      assert(
        indeterminateRequest,
        "indeterminate case did not enqueue an add request",
      );
      equal(
        indeterminateReadyState,
        "pending",
        "indeterminate add request must be pending when the injected failure is thrown",
      );
      assert(
        indeterminateTransaction,
        "indeterminate add request did not expose its transaction",
      );
      assert(
        indeterminateRejection !== undefined,
        "indeterminate case unexpectedly resolved",
      );
      assert(
        /indeterminate/i.test(String(indeterminateRejection)),
        `indeterminate rejection did not report an indeterminate outcome: ${String(
          indeterminateRejection,
        )}`,
      );
      assert(
        indeterminateAbortAttempts >= 1,
        "writer did not attempt to abort after the injected failure",
      );
      assert(
        indeterminateAbortThrew,
        "the mocked abort() did not throw",
      );
      assert(
        indeterminateTerminal?.completeObserved(),
        "the transaction did not complete after the ineffective abort",
      );
      assert(
        !indeterminateTerminal?.abortObserved(),
        "the transaction aborted despite the ineffective abort",
      );
      assert(
        indeterminateTerminalAtSettlement,
        "writer settled before the terminal transaction event",
      );
      equal(
        indeterminateRequest.readyState,
        "done",
        "indeterminate add request must be done after completion",
      );
      const afterIndeterminate = await snapshot(main.db);
      equal(
        afterIndeterminate.history,
        beforeIndeterminate.history,
        "indeterminate completion changed playHistory",
      );
      equal(
        afterIndeterminate.journal.length,
        beforeIndeterminate.journal.length + 1,
        "indeterminate completion did not commit the queued journal row",
      );
      assertJournalRecord(
        journalRow(
          afterIndeterminate.journal,
          indeterminateAttempt,
          "indeterminate completion",
        ),
        indeterminateAttempt,
        "indeterminate completion",
      );
      equal(
        await writeDisposableCompletion(main.db, indeterminateIssued),
        "already-recorded",
        "retry after indeterminate completion",
      );
      equal(
        await snapshot(main.db),
        afterIndeterminate,
        "retry after indeterminate completion changed the fixture stores",
      );
    } finally {
      injectIndeterminate = false;
      IDBObjectStore.prototype.add = nativeAddForIndeterminate;
      IDBTransaction.prototype.abort = nativeAbortForIndeterminate;
    }
    outcomes.push(
      "an injected error with a throwing abort() that leaves the transaction to complete rejects as indeterminate, commits the queued row, and a retry finds it as already-recorded",
    );

    // Invalid factory input still rejects at issue time, before any database is
    // involved. Extra raw fields and optional undefined are normalized, not
    // rejected, and are covered above.
    const invalidIssueInputs: Array<[string, unknown]> = [
      ["null issue input", null],
      ["array issue input", []],
      [
        "missing playbackAttemptId",
        { observedAt: "2026-11-04T12:00:00.000Z", provenance: { kind: "unknown" } },
      ],
      [
        "empty playbackAttemptId",
        { playbackAttemptId: "", observedAt: "2026-11-04T12:00:00.000Z", provenance: { kind: "unknown" } },
      ],
      [
        "null observedAt",
        { playbackAttemptId: `invalid-${crypto.randomUUID()}`, observedAt: null, provenance: { kind: "unknown" } },
      ],
      [
        "null subject",
        {
          playbackAttemptId: `invalid-${crypto.randomUUID()}`,
          observedAt: "2026-11-04T12:00:00.000Z",
          provenance: { kind: "unknown" },
          subject: null,
        },
      ],
      [
        "invalid provenance kind",
        {
          playbackAttemptId: `invalid-${crypto.randomUUID()}`,
          observedAt: "2026-11-04T12:00:00.000Z",
          provenance: { kind: "video" },
        },
      ],
      [
        "missing occurrenceId",
        {
          playbackAttemptId: `invalid-${crypto.randomUUID()}`,
          observedAt: "2026-11-04T12:00:00.000Z",
          provenance: { kind: "local-occurrence", playlistId: "invalid" },
        },
      ],
      [
        "null queueId",
        {
          playbackAttemptId: `invalid-${crypto.randomUUID()}`,
          observedAt: "2026-11-04T12:00:00.000Z",
          provenance: { kind: "unknown" },
          playbackContext: { kind: "queue", queueId: null },
        },
      ],
      [
        "invalid context kind",
        {
          playbackAttemptId: `invalid-${crypto.randomUUID()}`,
          observedAt: "2026-11-04T12:00:00.000Z",
          provenance: { kind: "unknown" },
          playbackContext: { kind: "video" },
        },
      ],
    ];
    for (const [label, value] of invalidIssueInputs) {
      throwsWithTypeError(
        () => issueDisposableCompletion(value as PlaybackCompletionFact),
        label,
      );
    }
    outcomes.push(
      "invalid factory input rejects at issue time before any database is involved",
    );

    // Final fixture state: the seeded history row is unchanged and the writer
    // has not changed the two-store fixture schema.
    const finalSnapshot = await snapshot(main.db);
    equal(
      finalSnapshot.history,
      [historySeed],
      "pre-existing playHistory row changed",
    );
    equal(
      Array.from(main.db.objectStoreNames).sort(),
      [JOURNAL_STORE, HISTORY_STORE].sort(),
      "the writer changed the fixture schema",
    );
    outcomes.push(
      "the seeded pre-existing playHistory row is unchanged and no history projection was written; committed writes store payload rows only",
    );

    assert(
      guard.openedNames.every(
        (name) =>
          name === dbName ||
          name === wrongDbName ||
          name === guard.iframeDbName,
      ),
      "the boot guard observed an unexpected database open",
    );
    assert(
      guard.openedNames.includes(dbName) &&
        guard.openedNames.includes(wrongDbName),
      "the boot guard did not observe both parent-realm fixture opens",
    );
    equal(
      guard.unexpectedOpenAttempts,
      [],
      "an unexpected database open was attempted",
    );
    equal(
      guard.unexpectedDeleteAttempts,
      [],
      "an unexpected database delete was attempted",
    );
    assert(
      guard.productionOpenAttempts === 0,
      "the production database open was attempted",
    );
    assert(
      guard.networkAttempts === 0,
      `network access was attempted ${guard.networkAttempts} time(s)`,
    );
    outcomes.push(
      "the boot guard observed only runner-generated fixture opens and no unexpected open, production open, delete, or network attempt",
    );

    main.db.close();
    if (wrong) {
      wrong.db.close();
      wrong = undefined;
    }
    for (const name of confirmedFixtureNames) {
      if (deleteAttempted.has(name)) continue;
      deleteAttempted.add(name);
      try {
        await deleteFixtureDatabase(name, confirmedFixtureNames, guard);
      } catch {
        // The runner removes the entire ephemeral profile after Chrome exits,
        // so a blocked delete is only a tidy-up failure.
      }
    }
    equal(
      [...guard.deleteNames].sort(),
      [...deleteAttempted].sort(),
      "the boot guard observed deletes for unexpected databases",
    );
    assert(
      guard.deleteNames.every((name) => confirmedFixtureNames.has(name)),
      "a database whose fresh oldVersion 0 creation was not confirmed was deleted",
    );
    assert(
      guard.deleteNames.every(
        (name) =>
          name === dbName ||
          name === wrongDbName ||
          name === guard.iframeDbName,
      ),
      "a non-fixture database delete was attempted",
    );
    outcomes.push(
      "only databases whose fresh oldVersion 0 creation was confirmed in this profile were deleted",
    );
    return outcomes;
  } finally {
    main?.db.close();
    wrong?.db.close();
    for (const name of confirmedFixtureNames) {
      if (deleteAttempted.has(name)) continue;
      deleteAttempted.add(name);
      try {
        await deleteFixtureDatabase(name, confirmedFixtureNames, guard);
      } catch {
        // The runner's profile removal is the outer cleanup barrier.
      }
    }
  }
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
        error: error instanceof Error ? error.stack : String(error),
      }),
    });
  },
);
