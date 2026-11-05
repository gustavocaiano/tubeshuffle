/**
 * Immutable completion facts with caller-supplied provenance, subject, and
 * observation context.
 *
 * This module only validates, copies, and freezes caller input. It performs no
 * history writes and has no queue, player, controller, storage, or network
 * integration. It does not infer provenance from an identifier's shape, merge
 * facts by video ID or time, generate attempt IDs or timestamps, link facts
 * automatically, or prove that playback happened, happened exactly once, or has
 * any lineage.
 *
 * Attempt contract:
 * - Create exactly one fact per recognized playback attempt, once.
 * - Duplicate completion notifications and retries must reuse that exact
 *   returned fact, including its `observedAt` value. Do not create a new attempt
 *   ID, a second fact, or a new observation timestamp for a duplicate
 *   notification.
 * - A legitimate replay is a new attempt with a new `playbackAttemptId` and a
 *   new observation.
 * - This is a caller convention. The factory neither enforces nor deduplicates
 *   it, and no controller-side dedup is implemented or claimed here. It is not
 *   an exactly-once or lineage guarantee.
 *
 * `observedAt` is the caller's observation time, not necessarily the media end
 * time. Its text is preserved verbatim: this module does not parse, normalize,
 * truncate, or otherwise reduce its precision, and it makes no promise about
 * future transfer or storage representability.
 *
 * Optional fields are copied exactly when supplied, including empty strings.
 * `null` is rejected because the public types do not include it; it is not
 * silently treated as absent. A future untrusted integration must retain a
 * rejected observation as unknown under its own policy rather than treating
 * validation failure as absence. This module performs no such retention and
 * makes no data-loss claim beyond its own boundary.
 *
 * No future writer is implemented here. A future writer must verify the
 * library epoch, exact local row and owner, local tag, and observed YouTube ID,
 * and must preserve date precision rather than truncating it. Those matches are
 * necessary for later verification but are not proof of lineage.
 *
 * A fact is a caller assertion captured at a point in time. It is not proof of
 * playback or lineage. Callers own attempt identity and any future retention
 * policy.
 */

/**
 * The item the player observed or queued, when known. This is observation data
 * independent of provenance. Missing fields are not inferred from IDs, and the
 * subject never implies local playlist membership.
 */
export interface PlaybackSubject {
  /**
   * Observed YouTube video ID, when known. This is the single canonical YouTube
   * ID for the fact; provenance variants do not carry a competing copy.
   */
  readonly youtubeId?: string;
  /**
   * Raw opaque queue item ID, when known. This is not a local occurrence or
   * playlist ID and must not be used to infer one.
   */
  readonly queueItemId?: string;
}

/** An exact local playlist occurrence. All identifiers are opaque strings. */
export type LocalOccurrenceProvenance = {
  readonly kind: "local-occurrence";
  /**
   * Optional caller-supplied scope for the local library that owns the IDs.
   * It is separate from the playlist and occurrence IDs and is never derived
   * from them. A matching epoch and exact local row/tag are necessary for later
   * verification but are not proof of lineage; no automatic linking is done.
   */
  readonly libraryEpoch?: string;
  /** Local playlist ID. Do not compare this with a YouTube playlist ID. */
  readonly playlistId: string;
  /**
   * Local video-occurrence ID (for example, `LocalVideo.id`). This is not a
   * YouTube video ID and may be shared by occurrences in different playlists.
   * The observed YouTube ID, when known, belongs to `subject.youtubeId`.
   */
  readonly occurrenceId: string;
};

/**
 * A YouTube suggestion. It carries no claimed playlist membership and no
 * YouTube ID of its own: when known, the observed ID belongs only to
 * `subject.youtubeId`, preventing competing authorities.
 */
export type SuggestionProvenance = {
  readonly kind: "suggestion";
  /**
   * Optional caller-supplied discovery context. This identifies where the
   * suggestion came from, not a local playlist that contains it.
   */
  readonly discoveryContextId?: string;
};

/**
 * Provenance that the caller could not attribute. It deliberately has no
 * identifier fields. A subject may still be present because observation data is
 * not ownership; do not infer an owner from it or from a value that merely
 * resembles a local or YouTube ID.
 */
export type UnknownProvenance = {
  readonly kind: "unknown";
};

export type PlaybackCompletionProvenance =
  | LocalOccurrenceProvenance
  | SuggestionProvenance
  | UnknownProvenance;

/**
 * Where the playback attempt happened, when known. Context is independent of
 * provenance. A queue or discovery kind may omit its ID when the player does
 * not have one; use `unknown` for an explicit unknown context, or omit the
 * context entirely when nothing is known. Supplied IDs are preserved exactly,
 * including empty strings; `null` is rejected rather than treated as absent.
 */
export type PlaybackContext =
  | { readonly kind: "queue"; readonly queueId?: string }
  | {
      readonly kind: "discovery";
      readonly discoveryContextId?: string;
    }
  | { readonly kind: "unknown" };

/**
 * An immutable copy of one caller-captured completion assertion.
 *
 * `playbackAttemptId` and `observedAt` are supplied verbatim by the caller.
 * `observedAt` is an opaque observation-time string, not a media-end claim.
 */
export interface PlaybackCompletionFact {
  readonly playbackAttemptId: string;
  readonly observedAt: string;
  readonly provenance: PlaybackCompletionProvenance;
  /**
   * Omitted when absent from the caller input. A supplied subject object is
   * preserved, with only fields that are present copied.
   */
  readonly subject?: PlaybackSubject;
  /** Omitted when absent from the caller input. */
  readonly playbackContext?: PlaybackContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

// Read an optional property exactly once. Missing values stay absent. Supplied
// strings are preserved exactly, including empty strings; null is rejected
// because the public types exclude it.
function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = source[key];
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

  return Object.freeze({
    ...(youtubeId === undefined ? {} : { youtubeId }),
    ...(queueItemId === undefined ? {} : { queueItemId }),
  });
}

function copyProvenance(value: unknown): PlaybackCompletionProvenance {
  if (!isRecord(value)) {
    throw new TypeError("provenance must be an object");
  }

  switch (value.kind) {
    case "local-occurrence": {
      const playlistId = value.playlistId;
      assertNonEmptyString(playlistId, "provenance.playlistId");
      const occurrenceId = value.occurrenceId;
      assertNonEmptyString(occurrenceId, "provenance.occurrenceId");
      const libraryEpoch = readOptionalString(
        value,
        "libraryEpoch",
        "provenance.libraryEpoch",
      );

      return Object.freeze({
        kind: "local-occurrence",
        playlistId,
        occurrenceId,
        ...(libraryEpoch === undefined ? {} : { libraryEpoch }),
      });
    }

    case "suggestion": {
      const discoveryContextId = readOptionalString(
        value,
        "discoveryContextId",
        "provenance.discoveryContextId",
      );

      return Object.freeze({
        kind: "suggestion",
        ...(discoveryContextId === undefined ? {} : { discoveryContextId }),
      });
    }

    case "unknown":
      // Only the discriminant is copied. Extra properties, including values
      // that look like local or YouTube IDs, cannot become an owner here.
      return Object.freeze({ kind: "unknown" });

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

  switch (value.kind) {
    case "queue": {
      const queueId = readOptionalString(
        value,
        "queueId",
        "playbackContext.queueId",
      );
      return Object.freeze({
        kind: "queue",
        ...(queueId === undefined ? {} : { queueId }),
      });
    }

    case "discovery": {
      const discoveryContextId = readOptionalString(
        value,
        "discoveryContextId",
        "playbackContext.discoveryContextId",
      );
      return Object.freeze({
        kind: "discovery",
        ...(discoveryContextId === undefined ? {} : { discoveryContextId }),
      });
    }

    case "unknown":
      return Object.freeze({ kind: "unknown" });

    default:
      throw new TypeError(
        "playbackContext.kind must be queue, discovery, or unknown",
      );
  }
}

/**
 * Validate and snapshot caller input as a deeply frozen fact.
 *
 * The caller's object is copied, not frozen or otherwise mutated. Only declared
 * fields are copied; extra fields are ignored. Optional strings are copied
 * exactly, including empty strings. Null optionals are rejected rather than
 * silently omitted. The factory does not inspect identifier formats, timestamps,
 * provenance, or relationships between fields, and it never merges or rejects
 * facts based on duplicate values.
 */
export function createPlaybackCompletionFact(
  input: PlaybackCompletionFact,
): PlaybackCompletionFact {
  const source: unknown = input;
  if (!isRecord(source)) {
    throw new TypeError("completion fact input must be an object");
  }

  const playbackAttemptId = source.playbackAttemptId;
  assertNonEmptyString(playbackAttemptId, "playbackAttemptId");
  const observedAt = source.observedAt;
  assertNonEmptyString(observedAt, "observedAt");
  const subject = copySubject(source.subject);
  const playbackContext = copyPlaybackContext(source.playbackContext);

  return Object.freeze({
    playbackAttemptId,
    observedAt,
    provenance: copyProvenance(source.provenance),
    ...(subject === undefined ? {} : { subject }),
    ...(playbackContext === undefined ? {} : { playbackContext }),
  });
}
