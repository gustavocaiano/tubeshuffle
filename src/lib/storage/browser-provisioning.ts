/**
 * Inert browser database provisioning coordinator.
 *
 * This module never references the global IndexedDB API, imports production
 * storage code, opens a named application database, changes the schema or
 * version, replays transactions, or presents UI. The caller supplies the native
 * open request factory, an existing-schema validator, and a creation callback.
 * The application adapter lives in browser-session.ts; this coordinator itself
 * remains independent of the target, UI and global browser APIs.
 *
 * Chosen policy:
 * - The coordinator binds one immutable target name and version at construction.
 *   Every native success handle and every `upgradeneeded` event must match that
 *   target before eligibility, validation, or schema code can run. A mismatch is
 *   aborted before caller code and latches indeterminate.
 * - Opening an existing database is the default. A missing database is never
 *   created automatically.
 * - An existing-only open that observes `upgradeneeded` is aborted before any
 *   caller creation callback can run. `missing` is reported only after both the
 *   native upgrade transaction abort and a terminal open error whose allowlisted
 *   name is `AbortError` are actually observed. Anything else latches an
 *   indeterminate state and blocks further automatic work.
 * - A confirmed missing check makes the caller eligible for exactly one explicit
 *   creation attempt. Eligibility is not user consent. `confirmCreateOnce`
 *   consumes it synchronously before the caller's request factory runs. A second
 *   creation attempt while one is active is refused as busy.
 * - Creation invokes `createSchema` exactly once, synchronously, only when the
 *   native `upgradeneeded` event reports `oldVersion === 0`, and only after the
 *   transaction abort observer was installed successfully. A first
 *   observer-install failure is final: no schema callback, no observer retry,
 *   and an indeterminate latch, with the native abort attempted only as
 *   best-effort cleanup. The callback receives the exact handle that was
 *   target-validated; `request.result` is not read again. Creation success
 *   validates the committed schema before reporting `"created"`, closes the
 *   handle without writing metadata, and requires a separate existing check.
 * - A blocked open rejects the current operation promptly, revokes creation
 *   eligibility, keeps the native attempt draining, aborts any late upgrade
 *   before creation, and closes any late success. Once the drain settles,
 *   ordinary opens are refused with `recheck-required` until
 *   `checkExistingAgain` starts one explicit check. The same barrier applies
 *   after a creation request finds an existing database.
 * - An existing same-version success validates the schema without writing,
 *   installs lifecycle listeners before publishing the handle, caches it, and
 *   invalidates/closes it on `versionchange`. An abnormal close or an abort the
 *   coordinator did not request latches indeterminate.
 * - `VersionError` and a validator returning `false` are reported as
 *   incompatible. An unexpected terminal error after `createSchema` ran, a
 *   factory throw that may have started an unsupervised open, an unreadable or
 *   null success result, a failed required close, a failed listener install, an
 *   unconfirmed abort, or success after an abort request latches indeterminate.
 *   A confirmed transaction abort after a callback throw or thenable return
 *   remains a safe retryable `transient` for the schema transaction because the
 *   transaction rolled back; that does not prove the callback had no side
 *   effects outside the transaction.
 *
 * Public failures are `BrowserProvisioningError` values with fixed categories
 * and fixed messages; native error names/messages and caller identifiers are
 * never forwarded. `validateExisting` and `createSchema` must be synchronous;
 * non-void returns are contained and reported unsafely only as described.
 *
 * This coordinator does not prove first use, preserve data against other tabs
 * or external deletion, guarantee physical durability, or report real user
 * data. It does not prevent another connection from upgrading or deleting the
 * database. The caller owns the native request factory and any real schema.
 */

export type ProvisioningPhase =
  | "unknown"
  | "checking"
  | "draining"
  | "recheck-required"
  | "existing"
  | "existing-unverified"
  | "missing"
  | "creating"
  | "created"
  | "incompatible"
  | "indeterminate";

export interface ProvisioningStatus {
  readonly phase: ProvisioningPhase;
  /** True after a native success, `oldVersion > 0`, or `VersionError`. */
  readonly observedExistingDatabase: boolean;
  /**
   * True only when a missing observation makes the caller eligible to offer an
   * explicit creation confirmation. This is not user consent and is consumed
   * by `confirmCreateOnce`.
   */
  readonly eligibleForConfirmation: boolean;
  /**
   * True after a blocked drain or an `existing-found` outcome. Ordinary opens
   * cannot issue a request until `checkExistingAgain` explicitly clears it.
   */
  readonly recheckRequired: boolean;
}

export type ProvisioningCreateOutcome = "created" | "existing-found";

export type BrowserProvisioningErrorCategory =
  | "missing"
  | "incompatible"
  | "blocked"
  | "busy"
  | "recheck-required"
  | "not-authorized"
  | "transient"
  | "indeterminate";

export class BrowserProvisioningError extends Error {
  readonly category: BrowserProvisioningErrorCategory;

  constructor(category: BrowserProvisioningErrorCategory, message: string) {
    super(message);
    this.name = "BrowserProvisioningError";
    this.category = category;
  }
}

export interface BrowserProvisioning {
  /**
   * Open and validate the existing database for the bound target. Shares one
   * reserved in-flight attempt. A cached missing/incompatible observation or a
   * required re-check blocks automatic repeated opens; use `checkExistingAgain`
   * for an explicit new check.
   */
  openExisting(): Promise<IDBDatabase>;
  /**
   * Explicitly start a new existing-only check for the bound target, clearing a
   * required re-check and cached missing/incompatible observations. Does not
   * start a second request while one is already active or draining.
   */
  checkExistingAgain(): Promise<IDBDatabase>;
  /**
   * Consume the one-shot creation eligibility obtained from a confirmed missing
   * check and perform exactly one creation attempt for the bound target.
   */
  confirmCreateOnce(): Promise<ProvisioningCreateOutcome>;
  /** Current pull-based status. There are no subscriptions yet. */
  getStatus(): ProvisioningStatus;
}

interface AttemptFailure {
  readonly category: BrowserProvisioningErrorCategory;
  readonly message: string;
}

const MISSING_MESSAGE =
  "The local database was not found when last checked. Creation requires explicit confirmation.";
const INCOMPATIBLE_MESSAGE =
  "The existing local database schema is not compatible with this version.";
const BLOCKED_MESSAGE =
  "The database open request was blocked by another connection.";
const DRAINING_MESSAGE =
  "A database request is still draining after a blocked open; retry only after the native request settles.";
const ABORT_PENDING_MESSAGE =
  "A database open is awaiting a terminal outcome after an upgrade abort; retry only after it settles.";
const BUSY_MESSAGE =
  "Another database provisioning operation is already in progress.";
const RECHECK_REQUIRED_MESSAGE =
  "An explicit existing check is required before another database open.";
const NOT_AUTHORIZED_MESSAGE =
  "Database creation is not permitted; observe a missing database first.";
const TRANSIENT_MESSAGE =
  "The database open request failed for an unknown reason.";
const ABORT_UNCONFIRMED_MESSAGE =
  "An upgrade abort could not be confirmed; the database outcome is indeterminate.";
const SUCCESS_AFTER_ABORT_MESSAGE =
  "The database opened after an upgrade abort was requested; the outcome is indeterminate.";
const UNSUPERVISED_MESSAGE =
  "The database open could not be safely supervised; the outcome is indeterminate.";
const VALIDATION_FAILED_MESSAGE =
  "The existing database schema could not be validated; the outcome is indeterminate.";
const VALIDATION_UNCERTAIN_MESSAGE =
  "The existing database validator returned an unexpected result; the outcome is indeterminate.";
const HANDLE_FAILED_MESSAGE =
  "The opened database connection could not be supervised; the outcome is indeterminate.";
const UNEXPECTED_CLOSE_MESSAGE =
  "The local database connection closed unexpectedly; storage state is uncertain.";
const TARGET_MISMATCH_MESSAGE =
  "The native request did not match the bound database target; the outcome is indeterminate.";
const CLOSE_FAILED_MESSAGE =
  "The database handle could not be closed safely; the outcome is indeterminate.";
const UNREADABLE_RESULT_MESSAGE =
  "The opened database handle could not be read or supervised; the outcome is indeterminate.";
const CREATED_INVALID_MESSAGE =
  "The newly created database schema could not be validated; no rollback is claimed and the outcome is indeterminate.";
const FACTORY_FAILED_MESSAGE =
  "The database request factory failed after it may have started an unsupervised open; the outcome is indeterminate.";

const DEFAULT_MESSAGES: Record<BrowserProvisioningErrorCategory, string> = {
  missing: MISSING_MESSAGE,
  incompatible: INCOMPATIBLE_MESSAGE,
  blocked: BLOCKED_MESSAGE,
  busy: BUSY_MESSAGE,
  "recheck-required": RECHECK_REQUIRED_MESSAGE,
  "not-authorized": NOT_AUTHORIZED_MESSAGE,
  transient: TRANSIENT_MESSAGE,
  indeterminate: ABORT_UNCONFIRMED_MESSAGE,
};

function failure(
  category: BrowserProvisioningErrorCategory,
  message: string = DEFAULT_MESSAGES[category],
): AttemptFailure {
  return { category, message };
}

function provisioningError(value: AttemptFailure): BrowserProvisioningError {
  return new BrowserProvisioningError(value.category, value.message);
}

type AttemptKind = "existing" | "create";
type AttemptPhase = "opening" | "draining";
type AbortReason =
  | "missing"
  | "incompatible"
  | "existing-found"
  | "create-failed"
  | "drain";

type AllowlistedRequestErrorName = "VersionError" | "AbortError";

interface Attempt {
  readonly kind: AttemptKind;
  readonly promise: Promise<IDBDatabase | ProvisioningCreateOutcome>;
  readonly resolve: (value: IDBDatabase | ProvisioningCreateOutcome) => void;
  readonly reject: (error: BrowserProvisioningError) => void;
  request: IDBOpenDBRequest | null;
  phase: AttemptPhase;
  settled: boolean;
  terminal: boolean;
  blocked: boolean;
  abortRequested: boolean;
  abortReason: AbortReason | null;
  txAbortListenerAttached: boolean;
  txAbortObserved: boolean;
  terminalErrorName: AllowlistedRequestErrorName | null;
  createInvoked: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

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
    // An unreadable request error is treated as unknown by the caller.
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

function closeDatabase(db: IDBDatabase): boolean {
  try {
    db.close();
    return true;
  } catch {
    // A failed close is reported to the caller so it can latch indeterminate.
    return false;
  }
}

type ListenerTarget = object & { addEventListener?: unknown };

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

function containCallbackReturn(value: unknown): void {
  if (value === undefined) return;

  try {
    // A rejected returned promise must not become an unhandled rejection. The
    // value is never awaited or interpreted as success.
    void Promise.resolve(value).catch(() => {});
  } catch {
    // A hostile thenable getter must not escape the event handler.
  }
}

export function createBrowserProvisioning(
  target: { name: string; version: number },
  makeRequest: () => IDBOpenDBRequest,
  validateExisting: (db: IDBDatabase) => boolean,
  createSchema: (db: IDBDatabase) => void,
): BrowserProvisioning {
  // Bind immutable primitives once. The caller cannot retarget this coordinator
  // after construction, and every native result/upgrade is checked against it.
  const targetName = target.name;
  const targetVersion = target.version;

  let activeAttempt: Attempt | null = null;
  let currentDb: IDBDatabase | null = null;
  let fatal: AttemptFailure | null = null;
  let phase: ProvisioningPhase = "unknown";
  let observedExistingDatabase = false;
  let cachedMissing = false;
  let cachedIncompatible = false;
  let eligibleForConfirmation = false;
  let recheckRequired = false;

  function latchIndeterminate(
    message: string = ABORT_UNCONFIRMED_MESSAGE,
  ): AttemptFailure {
    if (fatal === null) fatal = failure("indeterminate", message);
    phase = "indeterminate";
    // No further confirmation or explicit re-check may be offered from an
    // uncertain state.
    eligibleForConfirmation = false;
    recheckRequired = false;
    return fatal;
  }

  function finishAttempt(attempt: Attempt): void {
    if (attempt.abortTimer !== null) {
      clearTimeout(attempt.abortTimer);
      attempt.abortTimer = null;
    }
    attempt.terminal = true;
    if (activeAttempt === attempt) activeAttempt = null;
  }

  function rejectAttempt(attempt: Attempt, value: AttemptFailure): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.reject(provisioningError(value));
  }

  function resolveAttempt(
    attempt: Attempt,
    value: IDBDatabase | ProvisioningCreateOutcome,
  ): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.resolve(value);
  }

  function setDraining(attempt: Attempt): void {
    attempt.phase = "draining";
  }

  function surfaceIndeterminate(attempt: Attempt, message: string): void {
    const value = latchIndeterminate(message);
    setDraining(attempt);
    rejectAttempt(attempt, value);
  }

  function closeUnpublishedResult(request: IDBOpenDBRequest): boolean {
    let db: IDBDatabase | null = null;
    try {
      db = request.result ?? null;
    } catch {
      return false;
    }
    // A successful open must produce a handle. A null result is unreadable, not
    // proof that nothing was opened.
    if (db === null) return false;
    if (db === currentDb) return true;
    return closeDatabase(db);
  }

  function closeUnpublishedOrLatch(attempt: Attempt): void {
    if (attempt.request === null) return;
    if (!closeUnpublishedResult(attempt.request)) {
      latchIndeterminate(UNREADABLE_RESULT_MESSAGE);
    }
  }

  function abandonRequest(request: IDBOpenDBRequest): void {
    addBestEffortListener(request, "success", () => {
      if (!closeUnpublishedResult(request)) {
        latchIndeterminate(UNREADABLE_RESULT_MESSAGE);
      }
    });

    addBestEffortListener(request, "upgradeneeded", () => {
      abortUpgrade(request);
    });

    try {
      if (request.readyState === "done") {
        if (!closeUnpublishedResult(request)) {
          latchIndeterminate(UNREADABLE_RESULT_MESSAGE);
        }
      }
    } catch {
      // The ready state could not be inspected; the caller already latched
      // indeterminate if supervision failed.
    }

    abortUpgrade(request);
  }

  function installHandleListeners(db: IDBDatabase): void {
    addLifecycleListener(db, "versionchange", () => {
      if (currentDb !== db) return;

      // A versionchange means this handle may no longer be used. The database
      // may have been upgraded or deleted by another connection; no automatic
      // creation or reopen is attempted.
      currentDb = null;
      eligibleForConfirmation = false;
      if (fatal === null) phase = "unknown";
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
    });

    addLifecycleListener(db, "close", () => {
      if (currentDb !== db) return;

      currentDb = null;
      latchIndeterminate(UNEXPECTED_CLOSE_MESSAGE);
    });
  }

  function reserveAttempt(kind: AttemptKind): Attempt {
    let resolvePromise!: (
      value: IDBDatabase | ProvisioningCreateOutcome,
    ) => void;
    let rejectPromise!: (error: BrowserProvisioningError) => void;
    const promise = new Promise<IDBDatabase | ProvisioningCreateOutcome>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );

    const attempt: Attempt = {
      kind,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      request: null,
      phase: "opening",
      settled: false,
      terminal: false,
      blocked: false,
      abortRequested: false,
      abortReason: null,
      txAbortListenerAttached: false,
      txAbortObserved: false,
      terminalErrorName: null,
      createInvoked: false,
      abortTimer: null,
    };

    activeAttempt = attempt;
    return attempt;
  }

  function watchTransactionAbort(attempt: Attempt): boolean {
    if (attempt.txAbortListenerAttached) return true;

    const request = attempt.request;
    if (request === null) return false;

    let transaction: IDBTransaction | null = null;
    try {
      transaction = request.transaction;
    } catch {
      return false;
    }
    if (!transaction) return false;

    try {
      addLifecycleListener(transaction, "abort", () => {
        attempt.txAbortObserved = true;
        if (!attempt.terminal) evaluateAbortOutcome(attempt);
      });
      attempt.txAbortListenerAttached = true;
      return true;
    } catch {
      return false;
    }
  }

  function requestAbort(attempt: Attempt, reason: AbortReason): boolean {
    if (!attempt.abortRequested) {
      attempt.abortRequested = true;
      attempt.abortReason = reason;
      setDraining(attempt);
      if (fatal === null) phase = "draining";
    } else if (attempt.abortReason === null) {
      attempt.abortReason = reason;
    }

    if (attempt.request === null) return false;

    const watching = watchTransactionAbort(attempt);
    const aborted = abortUpgrade(attempt.request);
    return watching && aborted;
  }

  function scheduleAbortUncertainty(attempt: Attempt): void {
    if (attempt.abortTimer !== null || attempt.terminal) return;

    attempt.abortTimer = setTimeout(() => {
      attempt.abortTimer = null;
      if (attempt.terminal) return;
      if (evaluateAbortOutcome(attempt)) return;

      const value = latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE);
      setDraining(attempt);
      rejectAttempt(attempt, value);
      finishAttempt(attempt);
    }, 0);
  }

  function evaluateAbortOutcome(attempt: Attempt): boolean {
    if (attempt.terminal) return false;
    // A previously latched indeterminate outcome is never downgraded by a later
    // observation.
    if (fatal !== null) return false;
    if (!attempt.abortRequested) return false;
    if (attempt.terminalErrorName !== "AbortError") return false;
    if (!attempt.txAbortObserved) return false;

    settleConfirmedAbort(attempt);
    return true;
  }

  function settleConfirmedAbort(attempt: Attempt): void {
    if (attempt.terminal) return;
    finishAttempt(attempt);

    switch (attempt.abortReason) {
      case "missing":
        cachedMissing = true;
        cachedIncompatible = false;
        eligibleForConfirmation = true;
        recheckRequired = false;
        phase = "missing";
        rejectAttempt(attempt, failure("missing"));
        return;
      case "incompatible":
        observedExistingDatabase = true;
        cachedIncompatible = true;
        cachedMissing = false;
        eligibleForConfirmation = false;
        recheckRequired = false;
        phase = "incompatible";
        rejectAttempt(attempt, failure("incompatible"));
        return;
      case "existing-found":
        observedExistingDatabase = true;
        cachedMissing = false;
        cachedIncompatible = false;
        eligibleForConfirmation = false;
        recheckRequired = true;
        phase = "existing-unverified";
        resolveAttempt(attempt, "existing-found");
        return;
      case "create-failed":
        eligibleForConfirmation = false;
        phase = "unknown";
        rejectAttempt(attempt, failure("transient"));
        return;
      case "drain":
        eligibleForConfirmation = false;
        recheckRequired = true;
        if (fatal === null) phase = "recheck-required";
        if (!attempt.settled) {
          rejectAttempt(attempt, failure("busy", DRAINING_MESSAGE));
        }
        return;
      default:
        // An unrecognized abort reason cannot prove a safe outcome.
        rejectAttempt(attempt, latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE));
    }
  }

  function failCreateSchema(attempt: Attempt): void {
    if (requestAbort(attempt, "create-failed")) return;

    const value = latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE);
    setDraining(attempt);
    rejectAttempt(attempt, value);
    finishAttempt(attempt);
  }

  /**
   * The transaction abort observer failed before any schema callback ran. Fail
   * closed immediately and do not retry observer installation: a retry would
   * narrow the documented contract and could later claim a confirmed rollback
   * that was not actually supervised. The abort itself remains best-effort.
   */
  function failCreateUnsupervised(attempt: Attempt): void {
    const value = latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE);
    setDraining(attempt);
    rejectAttempt(attempt, value);
    if (attempt.request !== null) abortUpgrade(attempt.request);
    finishAttempt(attempt);
  }

  /**
   * Read the native handle identity without forwarding its content. A failed
   * read is indistinguishable from a target mismatch for safety purposes.
   */
  function matchesTarget(db: IDBDatabase | null): db is IDBDatabase {
    if (db === null) return false;
    try {
      return db.name === targetName && db.version === targetVersion;
    } catch {
      return false;
    }
  }

  function failTargetMismatch(attempt: Attempt): void {
    // Latch before aborting so a synchronous terminal event cannot downgrade
    // this unsafe outcome to a retryable failure.
    const value = latchIndeterminate(TARGET_MISMATCH_MESSAGE);
    setDraining(attempt);
    rejectAttempt(attempt, value);
    requestAbort(attempt, "drain");
  }

  function handleUpgrade(attempt: Attempt, event: IDBVersionChangeEvent): void {
    const oldVersion = event.oldVersion;
    if (oldVersion > 0) observedExistingDatabase = true;

    if (attempt.terminal || activeAttempt !== attempt) {
      // A stale or already-settled request must still be contained without
      // changing the current status.
      if (attempt.request !== null) abortUpgrade(attempt.request);
      return;
    }

    if (attempt.phase === "draining" || attempt.abortRequested) {
      if (!attempt.abortRequested) {
        if (!requestAbort(attempt, "drain")) {
          const value = latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE);
          setDraining(attempt);
          if (!attempt.settled) rejectAttempt(attempt, value);
        }
      } else {
        // A late upgrade after an abort request must never reach creation. The
        // abort is idempotent at the transaction level.
        if (attempt.request !== null) abortUpgrade(attempt.request);
      }
      return;
    }

    let upgradeDb: IDBDatabase | null = null;
    try {
      upgradeDb = attempt.request?.result ?? null;
    } catch {
      failTargetMismatch(attempt);
      return;
    }

    // The exact bound name and version must be verified before missing
    // eligibility, incompatibility classification, or any caller schema code.
    if (!matchesTarget(upgradeDb) || event.newVersion !== targetVersion) {
      failTargetMismatch(attempt);
      return;
    }

    if (attempt.kind === "existing") {
      const reason: AbortReason = oldVersion === 0 ? "missing" : "incompatible";
      if (!requestAbort(attempt, reason)) {
        surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
      }
      return;
    }

    if (oldVersion === 0) {
      if (attempt.createInvoked) {
        if (!requestAbort(attempt, "create-failed")) {
          surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
        }
        return;
      }

      attempt.createInvoked = true;

      // A creation callback must not run unless the transaction abort can be
      // observed. A first failure is final: fail closed instead of retrying
      // observer installation inside requestAbort.
      if (!watchTransactionAbort(attempt)) {
        failCreateUnsupervised(attempt);
        return;
      }

      let returned: unknown = undefined;
      try {
        // Pass the exact handle that was target-validated above. Do not read
        // request.result again between validation and caller code.
        returned = (createSchema as (db: IDBDatabase) => unknown)(upgradeDb);
      } catch {
        failCreateSchema(attempt);
        return;
      }

      if (returned !== undefined) {
        // Abort synchronously before containing a hostile thenable so a late
        // success cannot publish a handle.
        failCreateSchema(attempt);
        containCallbackReturn(returned);
      }
      return;
    }

    // An existing database requiring an upgrade is not ours to mutate.
    if (!requestAbort(attempt, "existing-found")) {
      surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
    }
  }

  function handleExistingSuccess(attempt: Attempt): void {
    observedExistingDatabase = true;

    if (attempt.terminal) {
      closeUnpublishedOrLatch(attempt);
      return;
    }

    if (activeAttempt !== attempt) {
      attempt.terminal = true;
      closeUnpublishedOrLatch(attempt);
      rejectAttempt(attempt, fatal ?? failure("transient"));
      return;
    }

    if (attempt.abortRequested) {
      closeUnpublishedOrLatch(attempt);
      surfaceIndeterminate(attempt, SUCCESS_AFTER_ABORT_MESSAGE);
      finishAttempt(attempt);
      return;
    }

    if (attempt.phase === "draining") {
      closeUnpublishedOrLatch(attempt);
      finishAttempt(attempt);
      eligibleForConfirmation = false;
      if (fatal === null) {
        recheckRequired = true;
        phase = "recheck-required";
      } else {
        phase = "indeterminate";
      }
      return;
    }

    if (fatal !== null) {
      closeUnpublishedOrLatch(attempt);
      finishAttempt(attempt);
      rejectAttempt(attempt, fatal);
      return;
    }

    let db: IDBDatabase | null = null;
    let resultReadable = true;
    try {
      db = attempt.request?.result ?? null;
    } catch {
      resultReadable = false;
    }

    if (!resultReadable || db === null) {
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(UNREADABLE_RESULT_MESSAGE));
      return;
    }

    if (!matchesTarget(db)) {
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(TARGET_MISMATCH_MESSAGE));
      return;
    }

    let valid: unknown = false;
    try {
      valid = (validateExisting as (db: IDBDatabase) => unknown)(db);
    } catch {
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(VALIDATION_FAILED_MESSAGE));
      return;
    }

    if (valid !== true) {
      containCallbackReturn(valid);
      const closed = closeDatabase(db);
      finishAttempt(attempt);

      if (!closed) {
        rejectAttempt(attempt, latchIndeterminate(CLOSE_FAILED_MESSAGE));
        return;
      }

      if (valid === false) {
        cachedIncompatible = true;
        cachedMissing = false;
        eligibleForConfirmation = false;
        recheckRequired = false;
        phase = "incompatible";
        rejectAttempt(attempt, failure("incompatible"));
      } else {
        rejectAttempt(attempt, latchIndeterminate(VALIDATION_UNCERTAIN_MESSAGE));
      }
      return;
    }

    try {
      // Listeners must exist before the handle becomes visible to callers.
      installHandleListeners(db);
    } catch {
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(HANDLE_FAILED_MESSAGE));
      return;
    }

    if (attempt.settled) {
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
      finishAttempt(attempt);
      return;
    }

    currentDb = db;
    cachedMissing = false;
    cachedIncompatible = false;
    eligibleForConfirmation = false;
    recheckRequired = false;
    phase = "existing";
    finishAttempt(attempt);
    resolveAttempt(attempt, db);
  }

  function handleCreateSuccess(attempt: Attempt): void {
    observedExistingDatabase = true;

    if (attempt.terminal) {
      closeUnpublishedOrLatch(attempt);
      return;
    }

    if (activeAttempt !== attempt) {
      attempt.terminal = true;
      closeUnpublishedOrLatch(attempt);
      rejectAttempt(attempt, fatal ?? failure("transient"));
      return;
    }

    if (attempt.abortRequested) {
      closeUnpublishedOrLatch(attempt);
      surfaceIndeterminate(attempt, SUCCESS_AFTER_ABORT_MESSAGE);
      finishAttempt(attempt);
      return;
    }

    if (attempt.phase === "draining") {
      closeUnpublishedOrLatch(attempt);
      finishAttempt(attempt);
      eligibleForConfirmation = false;
      if (fatal === null) {
        recheckRequired = true;
        phase = "recheck-required";
      } else {
        phase = "indeterminate";
      }
      return;
    }

    if (fatal !== null) {
      closeUnpublishedOrLatch(attempt);
      finishAttempt(attempt);
      rejectAttempt(attempt, fatal);
      return;
    }

    let db: IDBDatabase | null = null;
    let resultReadable = true;
    try {
      db = attempt.request?.result ?? null;
    } catch {
      resultReadable = false;
    }

    if (!resultReadable || db === null) {
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(UNREADABLE_RESULT_MESSAGE));
      return;
    }

    if (!matchesTarget(db)) {
      if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(TARGET_MISMATCH_MESSAGE));
      return;
    }

    // Creation never publishes its handle and never initializes metadata. The
    // caller must run a separate existing check before using the database.
    cachedMissing = false;
    cachedIncompatible = false;
    eligibleForConfirmation = false;

    if (attempt.createInvoked) {
      // A committed creation must prove a usable schema before "created" is
      // reported. A committed but invalid schema is never rolled back or
      // silently recreated by this coordinator.
      let valid: unknown = false;
      try {
        valid = (validateExisting as (db: IDBDatabase) => unknown)(db);
      } catch {
        if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
        finishAttempt(attempt);
        rejectAttempt(attempt, latchIndeterminate(CREATED_INVALID_MESSAGE));
        return;
      }

      if (valid !== true) {
        containCallbackReturn(valid);
        if (!closeDatabase(db)) latchIndeterminate(CLOSE_FAILED_MESSAGE);
        finishAttempt(attempt);
        rejectAttempt(attempt, latchIndeterminate(CREATED_INVALID_MESSAGE));
        return;
      }

      if (!closeDatabase(db)) {
        finishAttempt(attempt);
        rejectAttempt(attempt, latchIndeterminate(CLOSE_FAILED_MESSAGE));
        return;
      }

      recheckRequired = false;
      phase = "created";
      finishAttempt(attempt);
      resolveAttempt(attempt, "created");
      return;
    }

    if (!closeDatabase(db)) {
      finishAttempt(attempt);
      rejectAttempt(attempt, latchIndeterminate(CLOSE_FAILED_MESSAGE));
      return;
    }

    // Finds an existing database without the coordinator's own upgrade. No
    // writes occur and a separate explicit existing check is required.
    recheckRequired = true;
    phase = "existing-unverified";
    finishAttempt(attempt);
    resolveAttempt(attempt, "existing-found");
  }

  function handleRequestError(attempt: Attempt): void {
    const errorName = readRequestErrorName(attempt.request);
    attempt.terminalErrorName = errorName;

    // A native VersionError proves an existing higher-version database even on
    // stale or already-settled paths, but it must never override an unconfirmed
    // abort correlation below.
    if (errorName === "VersionError") observedExistingDatabase = true;

    if (attempt.terminal) return;

    if (activeAttempt !== attempt) {
      attempt.terminal = true;
      rejectAttempt(
        attempt,
        fatal ??
          (attempt.createInvoked
            ? latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE)
            : failure("transient")),
      );
      return;
    }

    // Abort precedence: once an abort was requested, only the full transaction
    // abort + terminal AbortError correlation may produce a safe outcome.
    // VersionError or any other terminal error here is not an abort proof.
    if (attempt.abortRequested) {
      if (errorName === "AbortError") {
        if (evaluateAbortOutcome(attempt)) return;
        scheduleAbortUncertainty(attempt);
        return;
      }

      surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
      finishAttempt(attempt);
      return;
    }

    if (attempt.createInvoked) {
      // Schema code may have run and this terminal error is not the correlated
      // abort path. Do not let VersionError or any other name downgrade it to a
      // retryable classification or an explicit re-check.
      rejectAttempt(attempt, latchIndeterminate(ABORT_UNCONFIRMED_MESSAGE));
      finishAttempt(attempt);
      return;
    }

    if (errorName === "VersionError") {
      finishAttempt(attempt);
      if (fatal !== null) {
        rejectAttempt(attempt, fatal);
        return;
      }
      if (attempt.settled) {
        // The acquisition was already rejected (for example after a blocked
        // open); require an explicit follow-up check instead of another open.
        eligibleForConfirmation = false;
        recheckRequired = true;
        phase = "recheck-required";
        return;
      }
      cachedIncompatible = true;
      cachedMissing = false;
      eligibleForConfirmation = false;
      recheckRequired = false;
      phase = "incompatible";
      rejectAttempt(attempt, failure("incompatible"));
      return;
    }

    if (errorName === "AbortError") {
      // An abort this coordinator did not request is not proof of a safe state.
      surfaceIndeterminate(attempt, ABORT_UNCONFIRMED_MESSAGE);
      finishAttempt(attempt);
      return;
    }

    finishAttempt(attempt);
    if (fatal !== null) {
      rejectAttempt(attempt, fatal);
      return;
    }

    eligibleForConfirmation = false;
    if (attempt.blocked) {
      recheckRequired = true;
      phase = "recheck-required";
      return;
    }

    phase = "unknown";
    if (!attempt.settled) {
      rejectAttempt(attempt, failure("transient"));
    }
  }

  function handleBlocked(attempt: Attempt): void {
    if (attempt.terminal || activeAttempt !== attempt) return;

    attempt.phase = "draining";
    attempt.blocked = true;
    // A blocked open revokes any outstanding creation eligibility. The native
    // request stays active and drains; no new request may start.
    eligibleForConfirmation = false;
    if (fatal !== null) {
      rejectAttempt(attempt, fatal);
      return;
    }
    phase = "draining";
    rejectAttempt(attempt, failure("blocked"));
  }

  function attachAttemptListeners(attempt: Attempt): void {
    const request = attempt.request;
    if (request === null) return;

    addLifecycleListener(request, "blocked", () => {
      handleBlocked(attempt);
    });

    addLifecycleListener(request, "upgradeneeded", (event) => {
      handleUpgrade(attempt, event as IDBVersionChangeEvent);
    });

    addLifecycleListener(request, "success", () => {
      if (attempt.kind === "create") {
        handleCreateSuccess(attempt);
      } else {
        handleExistingSuccess(attempt);
      }
    });

    addLifecycleListener(request, "error", () => {
      handleRequestError(attempt);
    });
  }

  function startExistingAttempt(): Promise<IDBDatabase> {
    const attempt = reserveAttempt("existing");
    phase = "checking";

    let request: IDBOpenDBRequest;
    try {
      request = makeRequest();
    } catch {
      // The factory may have started an unsupervised native open before it
      // threw. No safe retry or transient classification is possible.
      const value = latchIndeterminate(FACTORY_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, value);
      return asDatabasePromise(attempt.promise);
    }

    attempt.request = request;

    try {
      attachAttemptListeners(attempt);
    } catch {
      const value = latchIndeterminate(UNSUPERVISED_MESSAGE);
      setDraining(attempt);
      rejectAttempt(attempt, value);
      abandonRequest(request);
      finishAttempt(attempt);
    }

    return asDatabasePromise(attempt.promise);
  }

  function startCreateAttempt(): Promise<ProvisioningCreateOutcome> {
    const attempt = reserveAttempt("create");
    phase = "creating";

    let request: IDBOpenDBRequest;
    try {
      request = makeRequest();
    } catch {
      // The factory may have started an unsupervised native open before it
      // threw. Creation eligibility is already consumed.
      const value = latchIndeterminate(FACTORY_FAILED_MESSAGE);
      finishAttempt(attempt);
      rejectAttempt(attempt, value);
      return asCreatePromise(attempt.promise);
    }

    attempt.request = request;

    try {
      attachAttemptListeners(attempt);
    } catch {
      const value = latchIndeterminate(UNSUPERVISED_MESSAGE);
      setDraining(attempt);
      rejectAttempt(attempt, value);
      abandonRequest(request);
      finishAttempt(attempt);
    }

    return asCreatePromise(attempt.promise);
  }

  function asDatabasePromise(
    promise: Promise<IDBDatabase | ProvisioningCreateOutcome>,
  ): Promise<IDBDatabase> {
    // The attempt kind determines the resolved union member internally.
    return promise.then((value) => value as IDBDatabase);
  }

  function asCreatePromise(
    promise: Promise<IDBDatabase | ProvisioningCreateOutcome>,
  ): Promise<ProvisioningCreateOutcome> {
    return promise.then((value) => value as ProvisioningCreateOutcome);
  }

  function activeBusyFailure(attempt: Attempt): AttemptFailure {
    if (attempt.phase === "draining") {
      return failure(
        "busy",
        attempt.abortRequested ? ABORT_PENDING_MESSAGE : DRAINING_MESSAGE,
      );
    }
    return failure("busy", BUSY_MESSAGE);
  }

  function openExisting(): Promise<IDBDatabase> {
    if (fatal !== null) return Promise.reject(provisioningError(fatal));

    if (activeAttempt !== null) {
      if (
        activeAttempt.kind === "existing" &&
        activeAttempt.phase === "opening"
      ) {
        return asDatabasePromise(activeAttempt.promise);
      }
      return Promise.reject(
        provisioningError(activeBusyFailure(activeAttempt)),
      );
    }

    if (recheckRequired) {
      return Promise.reject(provisioningError(failure("recheck-required")));
    }

    if (currentDb !== null) return Promise.resolve(currentDb);
    if (cachedMissing) return Promise.reject(provisioningError(failure("missing")));
    if (cachedIncompatible) {
      return Promise.reject(provisioningError(failure("incompatible")));
    }

    return startExistingAttempt();
  }

  function checkExistingAgain(): Promise<IDBDatabase> {
    if (fatal !== null) return Promise.reject(provisioningError(fatal));

    if (activeAttempt !== null) {
      if (
        activeAttempt.kind === "existing" &&
        activeAttempt.phase === "opening"
      ) {
        return asDatabasePromise(activeAttempt.promise);
      }
      return Promise.reject(
        provisioningError(activeBusyFailure(activeAttempt)),
      );
    }

    if (currentDb !== null) {
      const db = currentDb;
      currentDb = null;
      if (!closeDatabase(db)) {
        const value = latchIndeterminate(CLOSE_FAILED_MESSAGE);
        return Promise.reject(provisioningError(value));
      }
    }

    // An explicit check clears the re-check barrier, cached observations, and
    // any old creation eligibility. A fresh confirmed missing result is
    // required before creation can be offered again.
    recheckRequired = false;
    cachedMissing = false;
    cachedIncompatible = false;
    eligibleForConfirmation = false;

    return startExistingAttempt();
  }

  function confirmCreateOnce(): Promise<ProvisioningCreateOutcome> {
    if (fatal !== null) return Promise.reject(provisioningError(fatal));

    if (activeAttempt !== null) {
      return Promise.reject(
        provisioningError(activeBusyFailure(activeAttempt)),
      );
    }

    if (recheckRequired) {
      return Promise.reject(provisioningError(failure("recheck-required")));
    }

    if (currentDb !== null || !cachedMissing || !eligibleForConfirmation) {
      return Promise.reject(
        provisioningError(failure("not-authorized")),
      );
    }

    // Consume the one-shot eligibility synchronously and before the caller's
    // request factory can run. Concurrent/double calls observe the reservation.
    eligibleForConfirmation = false;
    cachedMissing = false;
    cachedIncompatible = false;

    return startCreateAttempt();
  }

  function getStatus(): ProvisioningStatus {
    return {
      phase,
      observedExistingDatabase,
      eligibleForConfirmation,
      recheckRequired,
    };
  }

  return {
    openExisting,
    checkExistingAgain,
    confirmCreateOnce,
    getStatus,
  };
}
