/**
 * Inert, in-memory state machine for caller-recognized playback attempts.
 *
 * This module has no controller, store, player, journal, storage, or network
 * integration. It does not read a clock or use randomness. Observation times,
 * attempt IDs, provenance, subjects, and contexts are always supplied by the
 * caller.
 *
 * What this module does:
 * - `begin` validates and deeply captures one explicit attempt snapshot. It
 *   refuses to begin while another attempt is active; the caller must retire
 *   the active attempt explicitly.
 * - `end` creates exactly one immutable `PlaybackCompletionFact` (through the
 *   existing factory) when, and only when, the caller reports an `ended`
 *   signal explicitly associated with the active attempt ID.
 * - A repeated `ended` notification for the most recently completed attempt
 *   returns that exact same fact object and its original `observedAt`; it never
 *   creates a new fact or a new observation time.
 * - `retire` and `clear` return the displaced active snapshot so the caller can
 *   retain it. They never silently discard it and never produce a completion.
 *
 * What this module does not do:
 * - It does not prove that playback happened, that a completion notification
 *   belongs to the caller's attempt, or that a late iframe/player event is
 *   attributable to that attempt. The caller asserts recognition. Because
 *   correlation cannot be proven, an `ended` event the caller explicitly tags
 *   as B while B is active is accepted as B even if it may have originated from
 *   stale A.
 * - It does not match by YouTube video ID, queue item ID, local occurrence,
 *   route, index, or time. Matching is exact string equality on an explicitly
 *   asserted `playbackAttemptId` only.
 * - It does not turn inferred transitions or unassociated events into facts.
 *   Both are always unresolved, even when an asserted attempt ID happens to
 *   equal the active ID. The original observation is returned to the caller.
 * - It does not deduplicate or protect history. Retention is bounded to one
 *   active attempt and the single most recently completed fact. Once another
 *   attempt completes, the older fact is lost and later duplicate events for it
 *   become unresolved. Attempt-ID uniqueness beyond this bounded cache is the
 *   caller's responsibility.
 * - It does not provide exactly-once or lineage guarantees. A fact is a caller
 *   assertion, not proof. This module does not persist anything, so reloading
 *   it loses both the active attempt and the retained fact.
 *
 * Input normalization:
 * - Capture follows the existing completion factory's declared-field and
 *   undefined/extra-field conventions: only declared fields are considered,
 *   explicit `undefined` optionals become absent, and extra fields are ignored.
 *   Unlike the factory, a declared field found only on the prototype chain is
 *   rejected. Raw caller input is NOT retained losslessly. A caller that needs
 *   the original object, including extra or explicitly undefined fields, must
 *   retain it itself.
 * - This module uses the existing factory to create facts and does not modify
 *   it. The factory has no observation-free snapshot helper, so capture rules
 *   are mirrored locally; adding a shared helper would require coordinated
 *   changes to that module. If the factory's validation contract changes, this
 *   module's capture rules must be coordinated with that change.
 * - Captured snapshots and the final factory input are own-field-only
 *   null-prototype records. Optional properties inherited from
 *   `Object.prototype` after `begin` therefore cannot leak into a fact.
 * - Declared fields must be own properties. A declared field found only on the
 *   prototype chain is rejected with `TypeError` before state changes rather
 *   than being silently omitted. The check uses `in` and does not invoke
 *   inherited getters. This is not a hostile-`Proxy` security guarantee.
 *
 * Invalid inputs throw before any state mutation; the caller's input object is
 * only read and is left untouched. If the completion factory throws while
 * producing a fact, the active attempt and retained fact are also unchanged.
 */

import {
  createPlaybackCompletionFact,
  type PlaybackCompletionFact,
  type PlaybackCompletionProvenance,
  type PlaybackContext,
  type PlaybackSubject,
} from "@/lib/media/playback-completion";

/** The caller's explicit observation kind. */
export type PlaybackSignal = "ended" | "inferred-transition";

/**
 * Explicit association. `asserted` is the only path that can complete an
 * attempt. `unassociated` means the caller cannot attribute the event to an
 * attempt; it is never resolved by inference.
 */
export type PlaybackAssociation =
  | { readonly kind: "asserted"; readonly playbackAttemptId: string }
  | { readonly kind: "unassociated" };

/** Frozen copy of one caller observation. */
export interface PlaybackObservation {
  readonly signal: PlaybackSignal;
  readonly association: PlaybackAssociation;
  readonly observedAt: string;
}

/**
 * Explicit end notification.
 *
 * Only `signal: "ended"` with `association.kind: "asserted"` may produce or
 * reuse a fact. `inferred-transition` and `unassociated` observations are
 * always unresolved.
 */
export interface PlaybackEndInput {
  readonly signal: PlaybackSignal;
  readonly association: PlaybackAssociation;
  readonly observedAt: string;
}

/**
 * Explicit attempt input. The caller asserts that this attempt is recognized
 * and that `playbackAttemptId` uniquely identifies it. `observedAt` is not part
 * of `begin`: a fact is only created when an explicit `ended` observation
 * arrives.
 */
export interface PlaybackAttemptInput {
  readonly playbackAttemptId: string;
  readonly provenance: PlaybackCompletionProvenance;
  readonly subject?: PlaybackSubject;
  readonly playbackContext?: PlaybackContext;
}

/**
 * Own-field-only frozen copy of one active attempt. Optionals absent from the
 * caller input stay absent; supplied optional strings are preserved exactly,
 * including empty strings.
 */
export interface PlaybackAttemptSnapshot {
  readonly playbackAttemptId: string;
  readonly provenance: PlaybackCompletionProvenance;
  readonly subject?: PlaybackSubject;
  readonly playbackContext?: PlaybackContext;
}

/**
 * Outcome of `end`.
 *
 * - `completed`: the active attempt matched an explicit `ended` assertion and
 *   this call created its one fact.
 * - `duplicate`: the retained completed fact matched; `fact` is the original
 *   object, including its original `observedAt`. A later `observedAt` argument
 *   is ignored.
 * - `unresolved`: the observation cannot produce or reuse a fact. This
 *   includes inferred transitions, unassociated events, unasserted IDs, retired
 *   or replaced attempts, and facts evicted from the bounded cache.
 *   `observation` is a frozen normalized copy of the recognized fields.
 *   `rawObservation` is the exact caller input reference: it is not copied or
 *   frozen, may be mutable, and is owned by the caller for mutability and
 *   retention. This module does not persist it.
 */
export type PlaybackEndOutcome =
  | { readonly status: "completed"; readonly fact: PlaybackCompletionFact }
  | { readonly status: "duplicate"; readonly fact: PlaybackCompletionFact }
  | {
      readonly status: "unresolved";
      readonly observation: PlaybackObservation;
      readonly rawObservation: PlaybackEndInput;
    };

/**
 * Outcome of `retire`. The displaced snapshot is returned so the caller can
 * retain it. `not-active` covers an unknown, already-retired, or
 * already-completed ID; a retained completed fact is not removed by `retire`.
 */
export type PlaybackRetireOutcome =
  | { readonly status: "retired"; readonly attempt: PlaybackAttemptSnapshot }
  | { readonly status: "not-active" };

export interface PlaybackAttempts {
  /**
   * Capture one explicit attempt. Throws if any attempt is already active,
   * including one with the same ID; call `retire` first. Throws `TypeError` for
   * invalid input, before state changes. Also throws if the ID equals the
   * retained most-recently-completed ID: that ID must not be reused while its
   * fact is still cached, because a later `end` for it could not distinguish a
   * duplicate notification from a new attempt.
   */
  begin(input: PlaybackAttemptInput): PlaybackAttemptSnapshot;
  /** Produce, reuse, or decline a completion fact as described above. */
  end(input: PlaybackEndInput): PlaybackEndOutcome;
  /** Retire the active attempt only if the explicit ID matches. */
  retire(playbackAttemptId: string): PlaybackRetireOutcome;
  /**
   * Retire the active attempt without a completion and return its snapshot (or
   * `null`). The retained most-recently completed fact is kept so a duplicate
   * notification can still reuse it.
   */
  clear(): PlaybackAttemptSnapshot | null;
  /** Current frozen active-attempt snapshot, or `null`. */
  current(): PlaybackAttemptSnapshot | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

// Read one declared own field. Missing stays absent. A field found only on the
// prototype chain is rejected rather than silently omitted; `in` does not invoke
// inherited getters. No hostile-Proxy guarantee is made.
function readDeclared(
  source: Record<string, unknown>,
  key: string,
  field: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return source[key];
  }
  if (key in source) {
    throw new TypeError(`${field} must be an own property, not inherited`);
  }
  return undefined;
}

// Build a frozen null-prototype record with only own fields. `undefined`
// values are omitted, matching the factory's optional-field convention.
function freezeNullRecord<T>(entries: ReadonlyArray<readonly [string, unknown]>): T {
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, value] of entries) {
    if (value !== undefined) record[key] = value;
  }
  return Object.freeze(record) as T;
}

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

// Read an optional own property once. Missing stays absent. Supplied strings
// are preserved exactly, including empty strings; null is rejected rather than
// treated as absent, matching the completion-fact factory's contract.
function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = readDeclared(source, key, field);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string when present`);
  }
  return value;
}

function copySubject(value: unknown): PlaybackSubject | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("subject must be an object when present");
  }

  const youtubeId = readOptionalString(value, "youtubeId", "subject.youtubeId");
  const queueItemId = readOptionalString(
    value,
    "queueItemId",
    "subject.queueItemId",
  );

  return freezeNullRecord<PlaybackSubject>([
    ["youtubeId", youtubeId],
    ["queueItemId", queueItemId],
  ]);
}

function copyProvenance(value: unknown): PlaybackCompletionProvenance {
  if (!isRecord(value)) {
    throw new TypeError("provenance must be an object");
  }

  switch (readDeclared(value, "kind", "provenance.kind")) {
    case "local-occurrence": {
      const playlistId = readDeclared(
        value,
        "playlistId",
        "provenance.playlistId",
      );
      assertNonEmptyString(playlistId, "provenance.playlistId");
      const occurrenceId = readDeclared(
        value,
        "occurrenceId",
        "provenance.occurrenceId",
      );
      assertNonEmptyString(occurrenceId, "provenance.occurrenceId");
      const libraryEpoch = readOptionalString(
        value,
        "libraryEpoch",
        "provenance.libraryEpoch",
      );

      return freezeNullRecord<PlaybackCompletionProvenance>([
        ["kind", "local-occurrence"],
        ["playlistId", playlistId],
        ["occurrenceId", occurrenceId],
        ["libraryEpoch", libraryEpoch],
      ]);
    }

    case "suggestion": {
      const discoveryContextId = readOptionalString(
        value,
        "discoveryContextId",
        "provenance.discoveryContextId",
      );

      return freezeNullRecord<PlaybackCompletionProvenance>([
        ["kind", "suggestion"],
        ["discoveryContextId", discoveryContextId],
      ]);
    }

    case "unknown":
      // Only the discriminant is copied. Extra properties cannot become an
      // owner or an inferred identifier here.
      return freezeNullRecord<PlaybackCompletionProvenance>([
        ["kind", "unknown"],
      ]);

    default:
      throw new TypeError(
        "provenance.kind must be local-occurrence, suggestion, or unknown",
      );
  }
}

function copyPlaybackContext(value: unknown): PlaybackContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("playbackContext must be an object when present");
  }

  switch (readDeclared(value, "kind", "playbackContext.kind")) {
    case "queue": {
      const queueId = readOptionalString(
        value,
        "queueId",
        "playbackContext.queueId",
      );
      return freezeNullRecord<PlaybackContext>([
        ["kind", "queue"],
        ["queueId", queueId],
      ]);
    }

    case "discovery": {
      const discoveryContextId = readOptionalString(
        value,
        "discoveryContextId",
        "playbackContext.discoveryContextId",
      );
      return freezeNullRecord<PlaybackContext>([
        ["kind", "discovery"],
        ["discoveryContextId", discoveryContextId],
      ]);
    }

    case "unknown":
      return freezeNullRecord<PlaybackContext>([["kind", "unknown"]]);

    default:
      throw new TypeError(
        "playbackContext.kind must be queue, discovery, or unknown",
      );
  }
}

function copyAssociation(value: unknown): PlaybackAssociation {
  if (!isRecord(value)) {
    throw new TypeError("association must be an object");
  }

  switch (readDeclared(value, "kind", "association.kind")) {
    case "asserted": {
      const playbackAttemptId = readDeclared(
        value,
        "playbackAttemptId",
        "association.playbackAttemptId",
      );
      assertNonEmptyString(
        playbackAttemptId,
        "association.playbackAttemptId",
      );
      return freezeNullRecord<PlaybackAssociation>([
        ["kind", "asserted"],
        ["playbackAttemptId", playbackAttemptId],
      ]);
    }

    case "unassociated":
      return freezeNullRecord<PlaybackAssociation>([["kind", "unassociated"]]);

    default:
      throw new TypeError(
        "association.kind must be asserted or unassociated",
      );
  }
}

// Validate and snapshot the attempt before mutating state. All nested objects
// are copied and frozen so later caller mutation (or a queue move) cannot alter
// the captured identity or the fact produced from it.
function copyAttempt(input: unknown): PlaybackAttemptSnapshot {
  if (!isRecord(input)) {
    throw new TypeError("attempt input must be an object");
  }

  const playbackAttemptId = readDeclared(
    input,
    "playbackAttemptId",
    "playbackAttemptId",
  );
  assertNonEmptyString(playbackAttemptId, "playbackAttemptId");
  const provenance = copyProvenance(
    readDeclared(input, "provenance", "provenance"),
  );
  const subject = copySubject(readDeclared(input, "subject", "subject"));
  const playbackContext = copyPlaybackContext(
    readDeclared(input, "playbackContext", "playbackContext"),
  );

  return freezeNullRecord<PlaybackAttemptSnapshot>([
    ["playbackAttemptId", playbackAttemptId],
    ["provenance", provenance],
    ["subject", subject],
    ["playbackContext", playbackContext],
  ]);
}

function copyObservation(input: unknown): PlaybackObservation {
  if (!isRecord(input)) {
    throw new TypeError("end input must be an object");
  }

  const signal = readDeclared(input, "signal", "signal");
  if (signal !== "ended" && signal !== "inferred-transition") {
    throw new TypeError(
      "end input.signal must be ended or inferred-transition",
    );
  }

  const observedAt = readDeclared(input, "observedAt", "observedAt");
  assertNonEmptyString(observedAt, "observedAt");
  const association = copyAssociation(
    readDeclared(input, "association", "association"),
  );

  return freezeNullRecord<PlaybackObservation>([
    ["signal", signal],
    ["association", association],
    ["observedAt", observedAt],
  ]);
}

interface RetainedCompletion {
  readonly playbackAttemptId: string;
  readonly fact: PlaybackCompletionFact;
}

/**
 * Create one independent attempt machine. Multiple instances share no state.
 */
export function createPlaybackAttempts(): PlaybackAttempts {
  let active: PlaybackAttemptSnapshot | null = null;
  let completed: RetainedCompletion | null = null;

  return {
    begin(input) {
      const snapshot = copyAttempt(input);

      if (active !== null) {
        throw new TypeError(
          "an attempt is already active; retire it before beginning another",
        );
      }

      if (
        completed !== null &&
        completed.playbackAttemptId === snapshot.playbackAttemptId
      ) {
        throw new TypeError(
          "playbackAttemptId is still cached as the most recent completion; begin requires a different ID",
        );
      }

      active = snapshot;
      return snapshot;
    },

    end(input) {
      const observation = copyObservation(input);

      // Inferred and unassociated observations are never facts, even when the
      // asserted ID happens to equal the active attempt ID.
      if (
        observation.signal !== "ended" ||
        observation.association.kind !== "asserted"
      ) {
        return { status: "unresolved", observation, rawObservation: input };
      }

      const playbackAttemptId = observation.association.playbackAttemptId;

      if (
        active !== null &&
        active.playbackAttemptId === playbackAttemptId
      ) {
        // Build the fact before mutating state, so a factory rejection leaves
        // the active attempt and any retained fact untouched.
        const factInput = freezeNullRecord<PlaybackCompletionFact>([
          ["playbackAttemptId", active.playbackAttemptId],
          ["observedAt", observation.observedAt],
          ["provenance", active.provenance],
          ["subject", active.subject],
          ["playbackContext", active.playbackContext],
        ]);
        const fact = createPlaybackCompletionFact(factInput);

        active = null;
        completed = { playbackAttemptId, fact };
        return { status: "completed", fact };
      }

      if (
        completed !== null &&
        completed.playbackAttemptId === playbackAttemptId
      ) {
        return { status: "duplicate", fact: completed.fact };
      }

      // No explicit match. Never attach to the active attempt by video, queue
      // item, context, route, or timing.
      return { status: "unresolved", observation, rawObservation: input };
    },

    retire(playbackAttemptId) {
      assertNonEmptyString(playbackAttemptId, "playbackAttemptId");
      if (
        active === null ||
        active.playbackAttemptId !== playbackAttemptId
      ) {
        return { status: "not-active" };
      }

      const attempt = active;
      active = null;
      return { status: "retired", attempt };
    },

    clear() {
      const attempt = active;
      active = null;
      return attempt;
    },

    current() {
      return active;
    },
  };
}
