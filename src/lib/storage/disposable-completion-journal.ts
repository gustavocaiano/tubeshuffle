/**
 * Inert completion-journal experiment over a caller-owned IndexedDB handle.
 *
 * This module does not open, create, upgrade, or migrate a database. It does
 * not import or call production storage, app code, or network APIs. The caller
 * must pass an already opened database whose name starts with
 * `tubeshuffle-journal-test-` and that already contains a `completionJournal`
 * object store with keyPath `key`. The name prefix is only a safety guard; it
 * is not proof that the database is disposable or isolated.
 *
 * Each completion fact is stored as an unresolved assertion. This module does
 * not project history, inspect play history, infer ownership, epoch,
 * occurrence, or playback identity, link facts, or promote an assertion. It
 * never overwrites an existing row. It makes no durability, exactly-once,
 * lineage, or user-data-security claim.
 *
 * Issuance scope: `issueDisposableCompletion` calls the shared fact factory
 * exactly once. That factory intentionally ignores extra input fields and
 * normalizes explicit `undefined` optionals to absent. Callers that care about
 * the raw input must inspect the issued snapshot and retain the original
 * themselves. Issuance is module-instance identity kept in a private WeakMap,
 * not a security, provenance, or hostile-Proxy proof. Clones and values from
 * another module instance or realm must be explicitly reissued.
 */

import {
  createPlaybackCompletionFact,
  type PlaybackCompletionFact,
} from "@/lib/media/playback-completion";

const JOURNAL_STORE_NAME = "completionJournal";
const JOURNAL_KEY_PATH = "key";
const JOURNAL_KEY_DISCRIMINATOR = "completion";
const JOURNAL_RECORD_VERSION = 1;
const PAYLOAD_FORMAT = "tubeshuffle-disposable-completion";
const TEST_DB_PREFIX = "tubeshuffle-journal-test-";
const PRODUCTION_DB_NAME = "tubeshuffle_local";

type DisposableCompletionJournalResult =
  | "journaled"
  | "already-recorded"
  | "conflict";

// Mutable only because IndexedDB key arrays are `IDBValidKey[]`; this module
// never mutates the array after creating the record.
type JournalKey = [typeof JOURNAL_KEY_DISCRIMINATOR, string];

interface JournalRecord {
  readonly key: JournalKey;
  readonly version: typeof JOURNAL_RECORD_VERSION;
  readonly payload: string;
}

interface IssuedCompletionData {
  readonly attemptId: string;
  readonly payload: string;
}

declare const ISSUED_COMPLETION_BRAND: unique symbol;

/**
 * A frozen completion snapshot returned by `issueDisposableCompletion` in this
 * module instance. The brand is compile-time only; runtime authority is the
 * module-private WeakMap entry, so copies and separately loaded module
 * instances must be reissued rather than cast.
 */
export type IssuedDisposableCompletion = PlaybackCompletionFact & {
  readonly [ISSUED_COMPLETION_BRAND]: "issued";
};

const issuedCompletions = new WeakMap<
  IssuedDisposableCompletion,
  IssuedCompletionData
>();

type CanonicalOptionalString =
  | readonly ["absent"]
  | readonly ["present", string];

// Fixed-shape tuples with explicit absent/present markers keep omitted
// optionals, present-empty strings, and inapplicable fields distinct.
type CanonicalProvenance = readonly [
  "local-occurrence" | "suggestion" | "unknown",
  CanonicalOptionalString,
  CanonicalOptionalString,
  CanonicalOptionalString,
  CanonicalOptionalString,
];

type CanonicalSubject = readonly [
  "absent" | "present",
  CanonicalOptionalString,
  CanonicalOptionalString,
];

type CanonicalPlaybackContext = readonly [
  "absent" | "present",
  "absent" | "queue" | "discovery" | "unknown",
  CanonicalOptionalString,
  CanonicalOptionalString,
];

type CanonicalCompletionTuple = readonly [
  typeof PAYLOAD_FORMAT,
  typeof JOURNAL_RECORD_VERSION,
  string,
  string,
  CanonicalProvenance,
  CanonicalSubject,
  CanonicalPlaybackContext,
];

// Presence markers come from own properties only. An absent own property is
// "absent" even when the prototype chain would supply a same-named value, so
// inherited data can never be encoded as part of an issued assertion.
function canonicalOwnOptionalString(
  source: object,
  key: string,
  path: string,
): CanonicalOptionalString {
  if (!hasOwn(source, key)) return ["absent"];

  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    throw new TypeError(`${path}.${key} must be a string when present`);
  }
  return ["present", value];
}

function assertUnreachable(value: never): never {
  void value;
  throw new TypeError("Unsupported completion fact shape.");
}

function canonicalProvenance(
  provenance: PlaybackCompletionFact["provenance"],
): CanonicalProvenance {
  switch (provenance.kind) {
    case "local-occurrence":
      return [
        "local-occurrence",
        ["present", provenance.playlistId],
        ["present", provenance.occurrenceId],
        canonicalOwnOptionalString(provenance, "libraryEpoch", "provenance"),
        ["absent"],
      ];

    case "suggestion":
      return [
        "suggestion",
        ["absent"],
        ["absent"],
        ["absent"],
        canonicalOwnOptionalString(
          provenance,
          "discoveryContextId",
          "provenance",
        ),
      ];

    case "unknown":
      return ["unknown", ["absent"], ["absent"], ["absent"], ["absent"]];

    default:
      return assertUnreachable(provenance);
  }
}

function canonicalSubject(fact: PlaybackCompletionFact): CanonicalSubject {
  if (!hasOwn(fact, "subject")) {
    return ["absent", ["absent"], ["absent"]];
  }

  const subject: unknown = fact.subject;
  if (typeof subject !== "object" || subject === null) {
    throw new TypeError("subject must be an object when present");
  }

  return [
    "present",
    canonicalOwnOptionalString(subject, "youtubeId", "subject"),
    canonicalOwnOptionalString(subject, "queueItemId", "subject"),
  ];
}

function canonicalPlaybackContext(
  fact: PlaybackCompletionFact,
): CanonicalPlaybackContext {
  if (!hasOwn(fact, "playbackContext")) {
    return ["absent", "absent", ["absent"], ["absent"]];
  }

  const context: unknown = fact.playbackContext;
  if (typeof context !== "object" || context === null) {
    throw new TypeError("playbackContext must be an object when present");
  }

  switch ((context as Record<string, unknown>).kind) {
    case "queue":
      return [
        "present",
        "queue",
        canonicalOwnOptionalString(context, "queueId", "playbackContext"),
        ["absent"],
      ];

    case "discovery":
      return [
        "present",
        "discovery",
        ["absent"],
        canonicalOwnOptionalString(
          context,
          "discoveryContextId",
          "playbackContext",
        ),
      ];

    case "unknown":
      return ["present", "unknown", ["absent"], ["absent"]];

    default:
      throw new TypeError(
        "playbackContext.kind must be queue, discovery, or unknown",
      );
  }
}

// Only factory-produced strings and this module's own tags/markers enter the
// tuple, so JSON.stringify never serializes caller-owned objects.
function canonicalPayload(fact: PlaybackCompletionFact): string {
  const tuple: CanonicalCompletionTuple = [
    PAYLOAD_FORMAT,
    JOURNAL_RECORD_VERSION,
    fact.playbackAttemptId,
    fact.observedAt,
    canonicalProvenance(fact.provenance),
    canonicalSubject(fact),
    canonicalPlaybackContext(fact),
  ];

  const payload = JSON.stringify(tuple);
  if (payload === undefined) {
    throw new TypeError("Could not serialize the issued completion fact.");
  }
  return payload;
}

/**
 * Validate and snapshot one completion assertion for later journaling.
 *
 * The shared factory is called exactly once. It intentionally ignores extra
 * input fields and treats explicit `undefined` optionals as absent; this
 * function does not preserve raw input beyond the returned snapshot. Callers
 * that need the original must retain it and inspect the issued snapshot before
 * depending on it. No security, provenance, or hostile-Proxy guarantee is
 * made. The returned object is frozen; clones and separately loaded modules or
 * realms must call this function again.
 */
export function issueDisposableCompletion(
  input: PlaybackCompletionFact,
): IssuedDisposableCompletion {
  const fact = createPlaybackCompletionFact(input);
  const issued = fact as IssuedDisposableCompletion;
  const data: IssuedCompletionData = {
    attemptId: fact.playbackAttemptId,
    payload: canonicalPayload(fact),
  };

  issuedCompletions.set(issued, data);
  return issued;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Accept null-prototype objects and ordinary Object.prototype-like prototypes
// from any realm. A deserialized IndexedDB row can come from another realm, so
// object identity with this realm's Object.prototype is not a valid test.
function hasPlainDataRecordPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  return Object.getPrototypeOf(prototype) === null;
}

// Read an exact set of own data properties from a plain object. Exotic values
// (Date, Map, arrays, class instances), symbols, accessors, and extra own
// properties fail closed. This recognizes cross-realm plain records but makes
// no hostile custom-prototype guarantee.
function readStrictOwnDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  if (!hasPlainDataRecordPrototype(value)) {
    return undefined;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.length) {
    return undefined;
  }

  const properties = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key === "symbol" || !expectedKeys.includes(key)) {
      return undefined;
    }

    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      hasOwn(descriptor, "get") ||
      hasOwn(descriptor, "set") ||
      !hasOwn(descriptor, "value")
    ) {
      return undefined;
    }

    properties.set(key, descriptor.value);
  }

  return properties;
}

// The key must be a dense two-element array with only own enumerable indices.
// Extra own enumerable properties and holes fail closed; inherited array
// properties are not part of the stored key and are ignored.
function hasExactJournalKey(value: unknown, attemptId: string): boolean {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  if (!hasOwn(value, "0") || !hasOwn(value, "1")) {
    return false;
  }
  if (value[0] !== JOURNAL_KEY_DISCRIMINATOR || value[1] !== attemptId) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === 2 && keys.every((key) => key === "0" || key === "1")
  );
}

function isSameStoredRecord(
  existing: unknown,
  attemptId: string,
  expectedPayload: string,
): boolean {
  const properties = readStrictOwnDataProperties(existing, [
    "key",
    "version",
    "payload",
  ]);
  if (properties === undefined) {
    return false;
  }

  if (!hasExactJournalKey(properties.get("key"), attemptId)) {
    return false;
  }
  if (properties.get("version") !== JOURNAL_RECORD_VERSION) {
    return false;
  }

  const payload = properties.get("payload");
  return typeof payload === "string" && payload === expectedPayload;
}

function assertDisposableDatabase(db: IDBDatabase): void {
  if (typeof db !== "object" || db === null) {
    throw new TypeError("db must be a caller-opened IDBDatabase");
  }

  const name: unknown = db.name;
  if (name === PRODUCTION_DB_NAME) {
    throw new TypeError(
      `Refusing production database "${PRODUCTION_DB_NAME}" in the disposal journal experiment.`,
    );
  }
  if (typeof name !== "string" || !name.startsWith(TEST_DB_PREFIX)) {
    throw new TypeError(
      `Refusing database name; it must start with "${TEST_DB_PREFIX}".`,
    );
  }
}

function assertJournalStoreExists(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(JOURNAL_STORE_NAME)) {
    throw new Error(
      `The caller database must already contain a "${JOURNAL_STORE_NAME}" object store.`,
    );
  }
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}

/**
 * Journal one issued completion assertion, or report that the same attempt key
 * already holds an equivalent canonical payload.
 *
 * A non-issued value is refused before any transaction starts. The one
 * readwrite transaction reads the attempt key, then uses `add` only when the
 * key is missing; `put` is never used. Concurrent readwrite transactions on
 * the same store are serialized by IndexedDB, so two calls cannot both
 * interleave a read and an append for the same key. An unknown, corrupt, or
 * different existing row is a conflict and is never overwritten or promoted.
 *
 * Transaction terminal handlers are registered before any request. Errors are
 * latched and an abort is requested when possible, but the promise waits for
 * the terminal abort/completion event. A completion after a latched error is
 * rejected as indeterminate; this module never claims a rollback occurred.
 */
export async function writeDisposableCompletion(
  db: IDBDatabase,
  issued: IssuedDisposableCompletion,
): Promise<DisposableCompletionJournalResult> {
  const issuedData = issuedCompletions.get(issued);
  if (issuedData === undefined) {
    throw new TypeError(
      "writeDisposableCompletion requires a value returned by issueDisposableCompletion in this module instance; reissue clones or values from another module instance or realm.",
    );
  }

  assertDisposableDatabase(db);
  assertJournalStoreExists(db);

  const key: JournalKey = [JOURNAL_KEY_DISCRIMINATOR, issuedData.attemptId];

  return new Promise<DisposableCompletionJournalResult>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(JOURNAL_STORE_NAME, "readwrite");
    } catch (error) {
      reject(
        asError(error, "Could not start the completion journal transaction."),
      );
      return;
    }

    let settled = false;
    let hasFailure = false;
    let failure: unknown;
    let outcome: DisposableCompletionJournalResult | undefined;

    const latchFailure = (error: unknown, fallbackMessage: string): void => {
      if (settled || hasFailure) return;
      failure =
        error === null || error === undefined
          ? new Error(fallbackMessage)
          : error;
      hasFailure = true;
    };

    // Abort after an error, but settle only on a terminal event. An abort()
    // InvalidStateError is not terminal; the transaction is already committing,
    // aborting, or finished, and onabort/oncomplete still arrives.
    const failAndAbort = (error: unknown, fallbackMessage: string): void => {
      latchFailure(error, fallbackMessage);
      try {
        transaction.abort();
      } catch {
        // Wait for the registered terminal handler instead of settling early.
      }
    };

    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      if (!hasFailure) {
        failure =
          transaction.error ??
          new Error("Completion journal transaction aborted.");
        hasFailure = true;
      }
      reject(failure);
    };

    transaction.onerror = () => {
      // Do not settle here. The default error action aborts the transaction and
      // onabort settles; if it completes instead, oncomplete rejects as
      // indeterminate because the failure is latched.
      latchFailure(transaction.error, "Completion journal transaction failed.");
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;

      if (hasFailure) {
        reject(
          new Error(
            "Completion journal transaction completed after an error; outcome is indeterminate.",
          ),
        );
        return;
      }

      if (outcome === undefined) {
        reject(
          new Error(
            "Completion journal transaction completed without an outcome.",
          ),
        );
        return;
      }

      resolve(outcome);
    };

    let store: IDBObjectStore;
    try {
      store = transaction.objectStore(JOURNAL_STORE_NAME);
    } catch (error) {
      failAndAbort(error, "Could not open the completionJournal object store.");
      return;
    }

    if (store.keyPath !== JOURNAL_KEY_PATH) {
      failAndAbort(
        new Error(
          `The "${JOURNAL_STORE_NAME}" store must use keyPath "${JOURNAL_KEY_PATH}".`,
        ),
        "Unsupported completionJournal keyPath.",
      );
      return;
    }

    let getRequest: IDBRequest<unknown>;
    try {
      getRequest = store.get(key);
    } catch (error) {
      failAndAbort(error, "Could not read the completion journal entry.");
      return;
    }

    getRequest.onsuccess = () => {
      if (settled || hasFailure) return;

      const existing = getRequest.result;

      try {
        if (existing === undefined) {
          const record: JournalRecord = {
            key,
            version: JOURNAL_RECORD_VERSION,
            payload: issuedData.payload,
          };
          const addRequest = store.add(record);

          addRequest.onsuccess = () => {
            if (settled || hasFailure) return;
            outcome = "journaled";
          };
          addRequest.onerror = () => {
            if (settled || hasFailure) return;
            failAndAbort(addRequest.error, "Could not append the journal entry.");
          };
          return;
        }

        outcome = isSameStoredRecord(
          existing,
          issuedData.attemptId,
          issuedData.payload,
        )
          ? "already-recorded"
          : "conflict";
      } catch (error) {
        failAndAbort(error, "Could not compare the completion journal entry.");
      }
    };

    getRequest.onerror = () => {
      if (settled || hasFailure) return;
      failAndAbort(
        getRequest.error,
        "Could not read the completion journal entry.",
      );
    };
  });
}
