/**
 * Inert IndexedDB open lifecycle manager.
 *
 * This module does not reference the global IndexedDB API, import production
 * storage code, open a named application database, replay transactions, run
 * migrations on its own, or present UI. The caller supplies the native open
 * request factory and the upgrade callback. It is not wired into the app.
 *
 * Behavior:
 * - The attempt and its deferred are reserved before `makeRequest` runs, so a
 *   synchronous reentrant `acquire` shares exactly one native request.
 * - Concurrent acquisitions share one native open request.
 * - A terminal request failure clears the active attempt and permits a later
 *   explicit retry, except for latched storage-loss/indeterminate states.
 * - `blocked` rejects the current acquisition promptly, but the native request
 *   remains in a drain state. Acquisitions during drain reject without creating
 *   another request. A late upgrade is aborted before `onUpgrade` is called.
 *   An ordinary late success is closed; a success after an abort was attempted
 *   latches indeterminate uncertainty.
 * - The lifecycle installs `versionchange` and abnormal-close listeners before
 *   publishing a handle. A matching handle is invalidated and closed on
 *   `versionchange`. Observing a deletion request (`newVersion === null`)
 *   latches that the database must not be recreated.
 * - Once an existing database is observed (an upgrade with `oldVersion > 0`, a
 *   native `VersionError`, or any native success, even one that cannot be
 *   published), a later unexpected `oldVersion === 0` aborts and latches
 *   storage loss instead of recreating. A native `VersionError` is recorded
 *   before its public category is assigned, including on stale terminal paths,
 *   because it proves a higher-version database already exists. A fresh process
 *   cannot detect an earlier clear through this mechanism.
 * - A storage-loss upgrade is aborted before the caller is settled and the
 *   rejection waits for the terminal request outcome. A failed or unconfirmed
 *   abort, or a late success, upgrades the latch to indeterminate, which takes
 *   precedence over storage loss and is what the caller receives. Storage-loss
 *   wording never asserts whether the database was recreated; the public
 *   message stays conservative regardless of the terminal outcome.
 * - An abnormal handle close latches an uncertain state.
 * - A terminal request error is classified as `AbortError` only when the
 *   native request actually reports that name. After an abort was requested, a
 *   missing or unreadable native error does not confirm the abort; it latches
 *   indeterminate instead of being assumed to be an abort. A readable
 *   `VersionError` remains a `VersionError` and records prior existence.
 * - If lifecycle listener registration fails after the native request exists,
 *   the outcome is latched indeterminate, the caller receives a conservative
 *   error, and no new request is started. Best-effort emergency `upgradeneeded`
 *   and `success` handlers, with listener/property fallbacks, abort a later
 *   upgrade and close a late handle. Because an open may not have started
 *   upgrading yet, neither mutation prevention nor native cancellation is
 *   guaranteed; if the emergency registration or abort fails, the
 *   indeterminate latch remains.
 * - `onUpgrade` must be synchronous and must not return a value. At runtime an
 *   async/thenable result, or any other non-undefined return, is treated as an
 *   upgrade failure and is contained without awaiting it. The signature stays
 *   `void` because `=> undefined` is not assignable from ordinary
 *   void-returning callbacks used by callers.
 * - Debug/error categories are fixed strings. Raw request errors, messages, and
 *   caller identifiers are never included.
 *
 * The lifecycle owns handles it publishes: callers must not replace its
 * `versionchange`/`close` listeners or close the handle themselves. Public
 * rejections are `BrowserDbLifecycleError` values with a fixed `category`.
 *
 * This module does not prevent another connection from deleting or upgrading
 * the database, does not detect a database that was cleared before this module
 * instance observed it, and does not guarantee data preservation, durability,
 * rollback, schema success, or transaction replay.
 */

export type BrowserDbLifecycleErrorCategory =
  | "blocked"
  | "VersionError"
  | "AbortError"
  | "storage-loss"
  | "indeterminate"
  | "transient";

export class BrowserDbLifecycleError extends Error {
  readonly category: BrowserDbLifecycleErrorCategory;

  constructor(category: BrowserDbLifecycleErrorCategory, message: string) {
    super(message);
    this.name = "BrowserDbLifecycleError";
    this.category = category;
  }
}

export interface BrowserDbLifecycle {
  /**
   * Acquire the current handle, share the in-flight native request, or start
   * one explicit retry when no request is active and no terminal latch blocks
   * opening.
   */
  acquire(): Promise<IDBDatabase>;
  /** True only for the handle currently published by this lifecycle instance. */
  isCurrent(db: IDBDatabase): boolean;
}

type AttemptPhase = "opening" | "draining";

interface AttemptFailure {
  readonly category: BrowserDbLifecycleErrorCategory;
  readonly message: string;
}

interface OpenAttempt {
  request: IDBOpenDBRequest | null;
  readonly promise: Promise<IDBDatabase>;
  readonly resolve: (db: IDBDatabase) => void;
  readonly reject: (error: BrowserDbLifecycleError) => void;
  phase: AttemptPhase;
  settled: boolean;
  abortRequested: boolean;
  terminal: boolean;
  drainFailure: AttemptFailure | null;
  /** Failure to surface once an accepted abort reaches its terminal outcome. */
  rejectionAfterTerminal: AttemptFailure | null;
}

const BLOCKED_MESSAGE =
  "The database open request was blocked by another connection.";
const DRAINING_MESSAGE =
  "The database open is draining after a blocked request; retry only after the native request settles.";
const ABORT_PENDING_MESSAGE =
  "The database open is awaiting a terminal outcome after an upgrade abort; retry only after it settles.";
const ABORT_UNCONFIRMED_MESSAGE =
  "An upgrade abort could not be confirmed; the database outcome is indeterminate and whether data remains is unknown.";
const SUCCESS_AFTER_ABORT_MESSAGE =
  "The database opened after an upgrade abort was requested; the outcome is indeterminate and whether data remains is unknown.";
const DELETION_REQUESTED_MESSAGE =
  "The local database may have been deleted by another connection following a requested deletion; whether data was preserved is unknown. This lifecycle will not recreate the database.";
const UNEXPECTED_EMPTY_MESSAGE =
  "The local database was unexpectedly empty after a prior successful open or after it had otherwise been observed; whether earlier data was preserved, and whether the database was recreated, are unknown.";
const UNSUPERVISED_OPEN_MESSAGE =
  "The database open could not be safely supervised; the outcome is indeterminate and whether data remains is unknown.";
const UNEXPECTED_CLOSE_MESSAGE =
  "The local database connection closed unexpectedly; storage state is uncertain.";
const OPEN_FAILED_MESSAGE =
  "The database open request failed or was aborted for an unknown reason.";
const HANDLE_FAILED_MESSAGE =
  "The opened database connection could not be secured.";
const VERSION_ERROR_MESSAGE =
  "The database open request failed or was aborted because the requested version is outdated.";
const ABORT_ERROR_MESSAGE =
  "The database open request failed or was aborted.";

const DEFAULT_MESSAGES: Record<BrowserDbLifecycleErrorCategory, string> = {
  blocked: BLOCKED_MESSAGE,
  VersionError: VERSION_ERROR_MESSAGE,
  AbortError: ABORT_ERROR_MESSAGE,
  "storage-loss": UNEXPECTED_EMPTY_MESSAGE,
  indeterminate: ABORT_UNCONFIRMED_MESSAGE,
  transient: OPEN_FAILED_MESSAGE,
};

function failure(
  category: BrowserDbLifecycleErrorCategory,
  message: string = DEFAULT_MESSAGES[category],
): AttemptFailure {
  return { category, message };
}

function lifecycleError(value: AttemptFailure): BrowserDbLifecycleError {
  return new BrowserDbLifecycleError(value.category, value.message);
}

/**
 * Read only an allowlisted DOMException name. The raw message is never read or
 * forwarded, so caller/database strings cannot leak through a rejection.
 *
 * `VersionError` also proves that a higher-version database already exists, so
 * callers record that observation before assigning any public category.
 */
type AllowlistedRequestErrorName = "VersionError" | "AbortError";

function readRequestErrorName(
  request: IDBOpenDBRequest | null,
): AllowlistedRequestErrorName | null {
  if (request === null) return null;

  try {
    const error = request.error;
    if (error !== null && typeof error === "object") {
      const name = (error as { name?: unknown }).name;
      if (name === "VersionError") return "VersionError";
      if (name === "AbortError") return "AbortError";
    }
  } catch {
    // Unknown request errors are reported as transient by the caller.
  }
  return null;
}

function abortUpgrade(request: IDBOpenDBRequest): boolean {
  try {
    const transaction = request.transaction;
    if (!transaction) return false;
    transaction.abort();
    return true;
  } catch {
    return false;
  }
}

function closeDatabase(db: IDBDatabase): void {
  try {
    db.close();
  } catch {
    // Closing is best effort; the handle must never be published regardless.
  }
}

type ListenerTarget = object & { addEventListener?: unknown };

/**
 * Prefer immutable listener registration so caller-installed listeners are not
 * overwritten. Fall back to an event-handler property only for simple test
 * doubles that do not implement `addEventListener`.
 */
function addLifecycleListener(
  target: ListenerTarget,
  type: string,
  listener: (event: Event) => void,
): void {
  if (typeof target.addEventListener === "function") {
    const addEventListener = target.addEventListener as (
      type: string,
      listener: (event: Event) => void,
    ) => void;
    addEventListener.call(target, type, listener);
    return;
  }

  (target as unknown as Record<string, unknown>)[`on${type}`] = listener;
}

/**
 * Best-effort listener registration for the abandoned-request path. Try the
 * normal listener first, then an event-handler property if registration threw.
 * Returns false only when neither mechanism could attach the listener.
 */
function addBestEffortListener(
  target: ListenerTarget,
  type: string,
  listener: (event: Event) => void,
): boolean {
  try {
    addLifecycleListener(target, type, listener);
    return true;
  } catch {
    try {
      (target as unknown as Record<string, unknown>)[`on${type}`] = listener;
      return true;
    } catch {
      return false;
    }
  }
}

/** Attach a safe rejection handler to a thenable or any other return value. */
function containUpgradeReturn(value: unknown): void {
  if (value === undefined) return;

  try {
    // A rejected returned promise must not become an unhandled rejection. The
    // value itself is never inspected for a success path or awaited here.
    void Promise.resolve(value).catch(() => {});
  } catch {
    // A hostile thenable getter must not escape the upgrade handler.
  }
}

export function createBrowserDbLifecycle(
  makeRequest: () => IDBOpenDBRequest,
  onUpgrade: (request: IDBOpenDBRequest, event: IDBVersionChangeEvent) => void,
): BrowserDbLifecycle {
  let activeAttempt: OpenAttempt | null = null;
  let currentDb: IDBDatabase | null = null;
  let fatalFailure: AttemptFailure | null = null;
  let hasObservedExistingDatabase = false;

  function latchFatal(value: AttemptFailure): void {
    // An indeterminate outcome is strictly more uncertain than a specific
    // storage-loss latch and must never be masked by first-wins ordering.
    if (fatalFailure?.category === "indeterminate") return;
    if (value.category === "indeterminate" || fatalFailure === null) {
      fatalFailure = value;
    }
  }

  function latchIndeterminate(message: string): void {
    latchFatal(failure("indeterminate", message));
  }

  function finishAttempt(attempt: OpenAttempt): void {
    attempt.terminal = true;
    attempt.rejectionAfterTerminal = null;
    if (activeAttempt === attempt) activeAttempt = null;
  }

  function rejectAttempt(
    attempt: OpenAttempt,
    value: AttemptFailure,
  ): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.reject(lifecycleError(value));
  }

  function resolveAttempt(attempt: OpenAttempt, db: IDBDatabase): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.resolve(db);
  }

  function setDraining(attempt: OpenAttempt, value: AttemptFailure): void {
    attempt.phase = "draining";
    attempt.drainFailure = value;
  }

  function surfaceIndeterminate(
    attempt: OpenAttempt,
    message: string,
  ): void {
    const value = failure("indeterminate", message);
    latchFatal(value);
    setDraining(attempt, value);
    rejectAttempt(attempt, value);
  }

  function closeUnpublishedResult(request: IDBOpenDBRequest): void {
    try {
      const db: IDBDatabase | null = request.result ?? null;
      if (db !== null && db !== currentDb) closeDatabase(db);
    } catch {
      // The result could not be inspected; there is nothing safe to publish.
    }
  }

  /**
   * Last-resort containment when lifecycle listeners could not be installed.
   * An open that has not started upgrading cannot be aborted through
   * `request.transaction` yet, so an emergency `upgradeneeded` listener aborts
   * the versionchange transaction when it appears, and a best-effort `success`
   * listener closes any late handle. Registration and the abort itself may
   * fail; the caller's indeterminate latch already fails closed. This path
   * never claims that a mutation was prevented or that the native request was
   * canceled.
   */
  function abandonRequest(request: IDBOpenDBRequest): void {
    const closeLateResult = () => closeUnpublishedResult(request);

    // Attach the late-result closer first so a hostile or unusual target that
    // settles during registration cannot leave a handle unsupervised.
    addBestEffortListener(request, "success", closeLateResult);

    addBestEffortListener(request, "upgradeneeded", () => {
      abortUpgrade(request);
    });

    try {
      if (request.readyState === "done") closeUnpublishedResult(request);
    } catch {
      // The ready state could not be inspected.
    }

    abortUpgrade(request);
  }

  function installHandleListeners(db: IDBDatabase): void {
    addLifecycleListener(db, "versionchange", (event) => {
      if (currentDb !== db) return;

      currentDb = null;
      if ((event as IDBVersionChangeEvent).newVersion === null) {
        latchFatal(failure("storage-loss", DELETION_REQUESTED_MESSAGE));
      }
      closeDatabase(db);
    });

    addLifecycleListener(db, "close", () => {
      if (currentDb !== db) return;

      currentDb = null;
      latchIndeterminate(UNEXPECTED_CLOSE_MESSAGE);
    });
  }

  function startAttempt(): Promise<IDBDatabase> {
    let resolvePromise!: (db: IDBDatabase) => void;
    let rejectPromise!: (error: BrowserDbLifecycleError) => void;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    // Reserve the attempt and deferred before creating the native request so a
    // synchronous reentrant acquire joins this attempt instead of opening a
    // second request.
    const attempt: OpenAttempt = {
      request: null,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      phase: "opening",
      settled: false,
      abortRequested: false,
      terminal: false,
      drainFailure: null,
      rejectionAfterTerminal: null,
    };

    activeAttempt = attempt;

    let request: IDBOpenDBRequest;
    try {
      request = makeRequest();
    } catch {
      finishAttempt(attempt);
      rejectAttempt(attempt, failure("transient", OPEN_FAILED_MESSAGE));
      return promise;
    }

    attempt.request = request;

    try {
      addLifecycleListener(request, "blocked", () => {
        if (activeAttempt !== attempt || attempt.terminal) return;

        setDraining(attempt, failure("blocked", DRAINING_MESSAGE));
        rejectAttempt(attempt, failure("blocked", BLOCKED_MESSAGE));
      });

      addLifecycleListener(request, "upgradeneeded", (event) => {
        const upgradeEvent = event as IDBVersionChangeEvent;

        // Recording an existing database is deliberately done before any
        // publish decision, including stale or exceptional paths.
        if (upgradeEvent.oldVersion > 0) {
          hasObservedExistingDatabase = true;
        }

        // A stale request must never invoke the caller's upgrade callback.
        if (activeAttempt !== attempt || attempt.terminal) {
          if (attempt.request) abortUpgrade(attempt.request);
          return;
        }

        // A database previously observed in this lifecycle cannot legitimately
        // reappear as version zero. Recreating it could hide data loss. Latch
        // the loss, abort before onUpgrade, and wait for the terminal outcome
        // so an unconfirmed abort or late success can surface as the more
        // conservative indeterminate state. This also applies while draining.
        if (hasObservedExistingDatabase && upgradeEvent.oldVersion === 0) {
          const storageLoss = failure(
            "storage-loss",
            UNEXPECTED_EMPTY_MESSAGE,
          );
          latchFatal(storageLoss);
          // An already-latched indeterminate outcome takes precedence.
          const effectiveFailure = fatalFailure ?? storageLoss;

          if (!attempt.abortRequested) {
            attempt.rejectionAfterTerminal = effectiveFailure;
            setDraining(
              attempt,
              failure("indeterminate", ABORT_PENDING_MESSAGE),
            );
            attempt.abortRequested = true;
          }

          if (!attempt.request || !abortUpgrade(attempt.request)) {
            attempt.rejectionAfterTerminal = null;
            surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
          }
          return;
        }

        // The request was blocked or an abort is already pending. Abort before
        // calling onUpgrade so a drained attempt can never publish a schema.
        if (attempt.phase === "draining" || attempt.abortRequested) {
          if (!attempt.abortRequested) {
            attempt.abortRequested = true;
            setDraining(
              attempt,
              failure("indeterminate", ABORT_PENDING_MESSAGE),
            );
          }

          if (!attempt.request || !abortUpgrade(attempt.request)) {
            attempt.rejectionAfterTerminal = null;
            surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
          }
          return;
        }

        if (fatalFailure !== null) {
          setDraining(attempt, fatalFailure);
          rejectAttempt(attempt, fatalFailure);
          attempt.abortRequested = true;
          if (attempt.request && !abortUpgrade(attempt.request)) {
            latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE);
          }
          return;
        }

        if (!attempt.request) {
          rejectAttempt(
            attempt,
            failure("transient", OPEN_FAILED_MESSAGE),
          );
          finishAttempt(attempt);
          return;
        }

        let upgradeReturn: unknown = undefined;
        try {
          upgradeReturn = (
            onUpgrade as unknown as (
              request: IDBOpenDBRequest,
              event: IDBVersionChangeEvent,
            ) => unknown
          )(attempt.request, upgradeEvent);
        } catch {
          failNonblockedUpgrade(attempt);
          return;
        }

        if (upgradeReturn !== undefined) {
          // Abort synchronously before assimilating an unexpected returned
          // thenable, so a hostile thenable cannot publish a handle.
          failNonblockedUpgrade(attempt);
          containUpgradeReturn(upgradeReturn);
        }
      });

      addLifecycleListener(request, "success", () => {
        // A native success observes an existing database even when the handle
        // cannot be published and must be closed instead.
        hasObservedExistingDatabase = true;

        if (attempt.terminal) {
          if (attempt.request) closeUnpublishedResult(attempt.request);
          return;
        }

        // A stale request that settles after a newer attempt exists must be
        // settled and closed without touching current lifecycle state.
        if (activeAttempt !== attempt) {
          attempt.terminal = true;
          rejectAttempt(attempt, failure("transient", OPEN_FAILED_MESSAGE));
          if (attempt.request) closeUnpublishedResult(attempt.request);
          return;
        }

        if (attempt.abortRequested) {
          if (attempt.request) closeUnpublishedResult(attempt.request);
          surfaceIndeterminate(attempt, SUCCESS_AFTER_ABORT_MESSAGE);
          finishAttempt(attempt);
          return;
        }

        if (attempt.phase === "draining") {
          // Ordinary blocked late success: close it, but no abort was attempted
          // and no uncertainty is latched. The next explicit acquire may retry
          // after this terminal request clears.
          if (attempt.request) closeUnpublishedResult(attempt.request);
          rejectAttempt(attempt, failure("indeterminate", ABORT_PENDING_MESSAGE));
          finishAttempt(attempt);
          return;
        }

        if (fatalFailure !== null) {
          if (attempt.request) closeUnpublishedResult(attempt.request);
          setDraining(attempt, fatalFailure);
          rejectAttempt(attempt, fatalFailure);
          finishAttempt(attempt);
          return;
        }

        let db: IDBDatabase | null = null;
        try {
          db = attempt.request?.result ?? null;
        } catch {
          // Fall through to the sanitized failure below.
        }

        if (db === null) {
          finishAttempt(attempt);
          rejectAttempt(attempt, failure("transient", OPEN_FAILED_MESSAGE));
          return;
        }

        try {
          // Listeners must exist before the handle becomes visible to callers.
          installHandleListeners(db);
        } catch {
          closeDatabase(db);
          finishAttempt(attempt);
          rejectAttempt(attempt, failure("transient", HANDLE_FAILED_MESSAGE));
          return;
        }

        if (attempt.settled) {
          // A racing terminal path already rejected this acquisition.
          closeDatabase(db);
          finishAttempt(attempt);
          return;
        }

        currentDb = db;
        finishAttempt(attempt);
        resolveAttempt(attempt, db);
      });

      addLifecycleListener(request, "error", () => {
        const errorName = readRequestErrorName(attempt.request);

        // A native VersionError proves that a higher-version database already
        // exists. Record that observation before any early return or public
        // categorization, including stale and unpublished terminal paths.
        if (errorName === "VersionError") {
          hasObservedExistingDatabase = true;
        }

        if (attempt.terminal) return;

        if (activeAttempt !== attempt) {
          attempt.terminal = true;
          attempt.rejectionAfterTerminal = null;
          rejectAttempt(attempt, failure("transient", OPEN_FAILED_MESSAGE));
          return;
        }

        // An abort is proven only when the native request actually reports a
        // terminal AbortError. A missing or unreadable native error after a
        // requested abort does not confirm it, so fail closed as indeterminate
        // instead of synthesizing an AbortError from abortRequested alone.
        if (attempt.abortRequested && errorName === null) {
          const value = failure("indeterminate", ABORT_UNCONFIRMED_MESSAGE);
          latchFatal(value);
          setDraining(attempt, value);
          finishAttempt(attempt);
          rejectAttempt(attempt, value);
          return;
        }

        // An accepted abort for a storage-loss upgrade waits for this terminal
        // outcome. A confirmed terminal error establishes that no upgrade
        // committed, so the conservative storage-loss diagnosis is safe to
        // surface.
        const terminalFailure = attempt.rejectionAfterTerminal;
        const category: BrowserDbLifecycleErrorCategory =
          errorName ?? "transient";
        finishAttempt(attempt);
        rejectAttempt(attempt, terminalFailure ?? failure(category));
      });
    } catch {
      const value = failure("indeterminate", UNSUPERVISED_OPEN_MESSAGE);
      latchFatal(value);
      setDraining(attempt, value);
      finishAttempt(attempt);
      rejectAttempt(attempt, value);
      abandonRequest(request);
    }

    return promise;
  }

  function failNonblockedUpgrade(attempt: OpenAttempt): void {
    if (attempt.terminal) return;

    setDraining(attempt, failure("indeterminate", ABORT_PENDING_MESSAGE));
    attempt.abortRequested = true;

    if (!attempt.request || !abortUpgrade(attempt.request)) {
      surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
      return;
    }

    // If the native request settled synchronously from abort(), that terminal
    // path already decided the outcome. Otherwise wait for the request's
    // terminal event so a true abort and an unknown success are distinguishable.
    if (attempt.terminal) return;
  }

  function acquire(): Promise<IDBDatabase> {
    if (fatalFailure !== null) {
      return Promise.reject(lifecycleError(fatalFailure));
    }

    if (activeAttempt !== null) {
      if (activeAttempt.phase === "opening") return activeAttempt.promise;
      return Promise.reject(
        lifecycleError(
          activeAttempt.drainFailure ??
            failure("blocked", DRAINING_MESSAGE),
        ),
      );
    }

    if (currentDb !== null) {
      return Promise.resolve(currentDb);
    }

    return startAttempt();
  }

  return {
    acquire,
    isCurrent(db) {
      return currentDb === db && fatalFailure === null;
    },
  };
}
