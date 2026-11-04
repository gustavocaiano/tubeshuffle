import { describe, expect, it } from "vitest";
import {
  createPlaybackCompletionFact,
  type PlaybackCompletionFact,
  type PlaybackCompletionProvenance,
} from "@/lib/media/playback-completion";

const at = "2026-11-04T12:34:56.789Z";

function validFact(
  overrides: Partial<PlaybackCompletionFact> = {},
): PlaybackCompletionFact {
  return {
    playbackAttemptId: "attempt-1",
    observedAt: at,
    provenance: {
      kind: "local-occurrence",
      playlistId: "playlist-1",
      occurrenceId: "occurrence-1",
    },
    subject: {
      youtubeId: "dQw4w9WgXcQ",
      queueItemId: "queue-item-1",
    },
    playbackContext: { kind: "queue", queueId: "queue-1" },
    ...overrides,
  };
}

describe("createPlaybackCompletionFact", () => {
  it("preserves exact local provenance, observed subject, and observation text without truncation", () => {
    const observedAt = "2026-11-04T12:34:56.789123456+05:30";
    const fact = createPlaybackCompletionFact({
      playbackAttemptId: "attempt/Ω",
      observedAt,
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "epoch-α",
        playlistId: "local-playlist-1",
        occurrenceId: "local-occurrence-9",
      },
      subject: {
        youtubeId: "dQw4w9WgXcQ",
        queueItemId: "raw-queue-item-9",
      },
      playbackContext: { kind: "queue", queueId: "queue-A" },
    });

    expect(fact.playbackAttemptId).toBe("attempt/Ω");
    expect(fact.observedAt).toBe(observedAt);
    expect(fact.provenance).toEqual({
      kind: "local-occurrence",
      libraryEpoch: "epoch-α",
      playlistId: "local-playlist-1",
      occurrenceId: "local-occurrence-9",
    });
    expect(fact.subject).toEqual({
      youtubeId: "dQw4w9WgXcQ",
      queueItemId: "raw-queue-item-9",
    });
    expect(fact.playbackContext).toEqual({ kind: "queue", queueId: "queue-A" });
    expect(fact.provenance).not.toHaveProperty("youtubeId");
    expect(fact.subject).not.toHaveProperty("playlistId");
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.provenance)).toBe(true);
    expect(Object.isFrozen(fact.subject)).toBe(true);
    expect(Object.isFrozen(fact.playbackContext)).toBe(true);
  });

  it("does not invent a subject for local facts when observation data is missing", () => {
    const fact = createPlaybackCompletionFact(
      validFact({ subject: undefined }),
    );

    expect(fact).not.toHaveProperty("subject");
    expect(fact.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-1",
      occurrenceId: "occurrence-1",
    });
  });

  it("keeps the observed YouTube ID canonical instead of duplicating it in suggestion provenance", () => {
    const source = {
      ...validFact(),
      provenance: {
        kind: "suggestion",
        discoveryContextId: "discovery-source-7",
        youtubeId: "yt-from-extra-provenance-field",
      } as unknown as PlaybackCompletionProvenance,
      subject: { youtubeId: "dQw4w9WgXcQ" },
      playbackContext: {
        kind: "discovery",
        discoveryContextId: "discovery-context-1",
      },
    };

    const fact = createPlaybackCompletionFact(
      source as unknown as PlaybackCompletionFact,
    );

    expect(fact.provenance).toEqual({
      kind: "suggestion",
      discoveryContextId: "discovery-source-7",
    });
    expect(fact.provenance).not.toHaveProperty("youtubeId");
    expect(fact.provenance).not.toHaveProperty("playlistId");
    expect(fact.subject).toEqual({ youtubeId: "dQw4w9WgXcQ" });

    const withoutSubject = createPlaybackCompletionFact(
      validFact({
        provenance: { kind: "suggestion" },
        subject: undefined,
      }),
    );

    expect(withoutSubject).not.toHaveProperty("subject");
    expect(withoutSubject.provenance).toEqual({ kind: "suggestion" });
  });

  it("keeps unknown provenance ownerless while preserving an observed subject", () => {
    const source = {
      ...validFact(),
      provenance: {
        kind: "unknown",
        playlistId: "PLdQw4w9WgXcQ",
        occurrenceId: "550e8400-e29b-41d4-a716-446655440000",
        youtubeId: "dQw4w9WgXcQ",
      } as unknown as PlaybackCompletionProvenance,
      subject: {
        youtubeId: "PLdQw4w9WgXcQ",
        queueItemId: "raw-queue-item-unknown",
      },
    };

    const fact = createPlaybackCompletionFact(
      source as unknown as PlaybackCompletionFact,
    );

    expect(fact.provenance).toEqual({ kind: "unknown" });
    expect(Object.keys(fact.provenance)).toEqual(["kind"]);
    expect(fact.provenance).not.toHaveProperty("playlistId");
    expect(fact.provenance).not.toHaveProperty("occurrenceId");
    expect(fact.provenance).not.toHaveProperty("youtubeId");
    expect(fact.subject).toEqual({
      youtubeId: "PLdQw4w9WgXcQ",
      queueItemId: "raw-queue-item-unknown",
    });
    expect(fact.subject).not.toHaveProperty("playlistId");
    expect(fact.subject).not.toHaveProperty("occurrenceId");
  });

  it("copies only known subject fields without inventing missing IDs", () => {
    const youtubeOnly = createPlaybackCompletionFact(
      validFact({ subject: { youtubeId: "yt-only" } }),
    );
    const queueOnly = createPlaybackCompletionFact(
      validFact({ subject: { queueItemId: "queue-only" } }),
    );
    const noSubjectFields = createPlaybackCompletionFact(
      validFact({ subject: {} }),
    );

    expect(youtubeOnly.subject).toEqual({ youtubeId: "yt-only" });
    expect(youtubeOnly.subject).not.toHaveProperty("queueItemId");
    expect(queueOnly.subject).toEqual({ queueItemId: "queue-only" });
    expect(queueOnly.subject).not.toHaveProperty("youtubeId");
    expect(noSubjectFields.subject).toEqual({});
    expect(noSubjectFields.subject).not.toHaveProperty("youtubeId");
    expect(noSubjectFields.subject).not.toHaveProperty("queueItemId");
  });

  it("preserves empty optional strings exactly instead of treating them as absent", () => {
    const local = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-empty",
      observedAt: at,
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "",
        playlistId: "playlist-1",
        occurrenceId: "occurrence-1",
      },
      subject: { youtubeId: "", queueItemId: "" },
      playbackContext: { kind: "queue", queueId: "" },
    });
    const suggestion = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-empty-suggestion",
      observedAt: at,
      provenance: { kind: "suggestion", discoveryContextId: "" },
      subject: { youtubeId: "yt-suggestion" },
      playbackContext: { kind: "discovery", discoveryContextId: "" },
    });

    expect(local.provenance).toEqual({
      kind: "local-occurrence",
      libraryEpoch: "",
      playlistId: "playlist-1",
      occurrenceId: "occurrence-1",
    });
    expect(local.provenance).toHaveProperty("libraryEpoch", "");
    expect(local.subject).toEqual({ youtubeId: "", queueItemId: "" });
    expect(local.playbackContext).toEqual({ kind: "queue", queueId: "" });
    expect(suggestion.provenance).toEqual({
      kind: "suggestion",
      discoveryContextId: "",
    });
    expect(suggestion.provenance).toHaveProperty("discoveryContextId", "");
    expect(suggestion.playbackContext).toEqual({
      kind: "discovery",
      discoveryContextId: "",
    });
    expect(suggestion.playbackContext).toHaveProperty(
      "discoveryContextId",
      "",
    );
  });

  it("allows absent, id-less, and explicitly unknown playback contexts", () => {
    const absent = createPlaybackCompletionFact(
      validFact({ playbackContext: undefined }),
    );
    const explicitUnknown = createPlaybackCompletionFact(
      validFact({ playbackContext: { kind: "unknown" } }),
    );
    const queueWithoutId = createPlaybackCompletionFact(
      validFact({ playbackContext: { kind: "queue" } }),
    );
    const discoveryWithoutId = createPlaybackCompletionFact(
      validFact({ playbackContext: { kind: "discovery" } }),
    );

    expect(absent).not.toHaveProperty("playbackContext");
    expect(explicitUnknown.playbackContext).toEqual({ kind: "unknown" });
    expect(queueWithoutId.playbackContext).toEqual({ kind: "queue" });
    expect(queueWithoutId.playbackContext).not.toHaveProperty("queueId");
    expect(discoveryWithoutId.playbackContext).toEqual({
      kind: "discovery",
    });
    expect(discoveryWithoutId.playbackContext).not.toHaveProperty(
      "discoveryContextId",
    );
  });

  it("keeps queue and discovery contexts separate when IDs are present", () => {
    const queueFact = createPlaybackCompletionFact(
      validFact({
        provenance: { kind: "suggestion" },
        subject: { youtubeId: "yt-context-1" },
        playbackContext: { kind: "queue", queueId: "queue-context-1" },
      }),
    );
    const discoveryFact = createPlaybackCompletionFact(
      validFact({
        provenance: { kind: "suggestion" },
        subject: { youtubeId: "yt-context-1" },
        playbackContext: {
          kind: "discovery",
          discoveryContextId: "discovery-context-1",
        },
      }),
    );

    expect(queueFact.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-context-1",
    });
    expect(queueFact.playbackContext).not.toHaveProperty("discoveryContextId");
    expect(discoveryFact.playbackContext).toEqual({
      kind: "discovery",
      discoveryContextId: "discovery-context-1",
    });
    expect(discoveryFact.playbackContext).not.toHaveProperty("queueId");
  });

  it("does not merge repeated videos that have distinct attempt IDs", () => {
    const sharedProvenance = {
      kind: "local-occurrence" as const,
      playlistId: "playlist-repeat",
      occurrenceId: "occurrence-repeat",
    };
    const sharedSubject = {
      youtubeId: "same-video",
      queueItemId: "same-queue-item",
    };
    const first = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-1",
      observedAt: at,
      provenance: sharedProvenance,
      subject: sharedSubject,
      playbackContext: { kind: "queue", queueId: "queue-repeat" },
    });
    const second = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-2",
      observedAt: at,
      provenance: sharedProvenance,
      subject: sharedSubject,
      playbackContext: { kind: "queue", queueId: "queue-repeat" },
    });

    const facts = [first, second];

    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.playbackAttemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(first.provenance).toEqual(second.provenance);
    expect(first.subject).toEqual(second.subject);
    expect(first.observedAt).toBe(second.observedAt);
    expect(first).not.toEqual(second);
  });

  it("reuses one immutable fact and observation timestamp for duplicate notifications and retries", () => {
    // The contract is to reuse the returned object. Creating a second fact for
    // the same attempt would violate it, so this test intentionally creates one.
    const fact = createPlaybackCompletionFact(validFact());
    const duplicateNotification = fact;
    const retry = duplicateNotification;

    expect(retry).toBe(fact);
    expect(retry.playbackAttemptId).toBe("attempt-1");
    expect(retry.observedAt).toBe(at);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(fact.provenance).toBe(retry.provenance);
    expect(fact.subject).toBe(retry.subject);
    expect(fact.playbackContext).toBe(retry.playbackContext);
  });

  it("treats a legitimate replay as a new attempt with a new observation", () => {
    const first = createPlaybackCompletionFact(
      validFact({
        playbackAttemptId: "attempt-replay-1",
        observedAt: "2026-11-04T10:00:00.000Z",
      }),
    );
    const replay = createPlaybackCompletionFact(
      validFact({
        playbackAttemptId: "attempt-replay-2",
        observedAt: "2026-11-04T10:05:00.000Z",
      }),
    );

    expect(replay.playbackAttemptId).not.toBe(first.playbackAttemptId);
    expect(replay.observedAt).not.toBe(first.observedAt);
    expect(replay.provenance).toEqual(first.provenance);
    expect(replay.subject).toEqual(first.subject);
    expect(replay).not.toEqual(first);
  });

  it("copies mutable input so later source changes cannot alter a snapshot", () => {
    const source = {
      playbackAttemptId: "attempt-before",
      observedAt: "2026-11-04T11:00:00.000Z",
      provenance: {
        kind: "local-occurrence" as const,
        libraryEpoch: "epoch-before",
        playlistId: "playlist-before",
        occurrenceId: "occurrence-before",
      },
      subject: {
        youtubeId: "yt-before",
        queueItemId: "queue-item-before",
      },
      playbackContext: { kind: "queue" as const, queueId: "queue-before" },
    };

    const fact = createPlaybackCompletionFact(source);

    source.playbackAttemptId = "attempt-after";
    source.observedAt = "2026-11-04T11:01:00.000Z";
    source.provenance.libraryEpoch = "epoch-after";
    source.provenance.playlistId = "playlist-after";
    source.provenance.occurrenceId = "occurrence-after";
    source.subject.youtubeId = "yt-after";
    source.subject.queueItemId = "queue-item-after";
    source.playbackContext.queueId = "queue-after";

    expect(fact.playbackAttemptId).toBe("attempt-before");
    expect(fact.observedAt).toBe("2026-11-04T11:00:00.000Z");
    expect(fact.provenance).toEqual({
      kind: "local-occurrence",
      libraryEpoch: "epoch-before",
      playlistId: "playlist-before",
      occurrenceId: "occurrence-before",
    });
    expect(fact.subject).toEqual({
      youtubeId: "yt-before",
      queueItemId: "queue-item-before",
    });
    expect(fact.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-before",
    });
    expect(Object.isFrozen(source)).toBe(false);
    expect(source.provenance.playlistId).toBe("playlist-after");
    expect(source.subject.youtubeId).toBe("yt-after");
  });

  it("preserves arbitrary legacy-looking ID collisions without inference", () => {
    const local = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-legacy-local",
      observedAt: at,
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "epoch/legacy",
        playlistId: "PLdQw4w9WgXcQ",
        occurrenceId: "dQw4w9WgXcQ",
      },
      subject: { youtubeId: "dQw4w9WgXcQ" },
      playbackContext: { kind: "queue", queueId: "queue-legacy" },
    });
    const suggestion = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-legacy-suggestion",
      observedAt: at,
      provenance: { kind: "suggestion" },
      subject: { youtubeId: "550e8400-e29b-41d4-a716-446655440000" },
      playbackContext: {
        kind: "discovery",
        discoveryContextId: "discovery-legacy",
      },
    });
    const sameOccurrenceIdElsewhere = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-legacy-other",
      observedAt: at,
      provenance: {
        kind: "local-occurrence",
        playlistId: "playlist-other",
        occurrenceId: "dQw4w9WgXcQ",
      },
      subject: { youtubeId: "dQw4w9WgXcQ" },
      playbackContext: { kind: "queue", queueId: "queue-legacy" },
    });
    const compositeOccurrence = createPlaybackCompletionFact({
      playbackAttemptId: "attempt-legacy-composite",
      observedAt: at,
      provenance: {
        kind: "local-occurrence",
        playlistId: "playlist-composite",
        occurrenceId: "playlist-1:occurrence-1|legacy",
      },
      subject: { youtubeId: "dQw4w9WgXcQ" },
      playbackContext: { kind: "queue", queueId: "queue-legacy" },
    });

    expect(local.provenance).toEqual({
      kind: "local-occurrence",
      libraryEpoch: "epoch/legacy",
      playlistId: "PLdQw4w9WgXcQ",
      occurrenceId: "dQw4w9WgXcQ",
    });
    expect(local.subject).toEqual({ youtubeId: "dQw4w9WgXcQ" });
    expect(suggestion.provenance).toEqual({ kind: "suggestion" });
    expect(suggestion.provenance).not.toHaveProperty("youtubeId");
    expect(suggestion.provenance).not.toHaveProperty("playlistId");
    expect(suggestion.subject).toEqual({
      youtubeId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(sameOccurrenceIdElsewhere.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-other",
      occurrenceId: "dQw4w9WgXcQ",
    });
    expect(local.provenance).not.toEqual(sameOccurrenceIdElsewhere.provenance);
    expect(compositeOccurrence.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-composite",
      occurrenceId: "playlist-1:occurrence-1|legacy",
    });
  });

  it("preserves Unicode scalar sequences exactly without normalization", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const composedFact = createPlaybackCompletionFact({
      playbackAttemptId: `attempt-${composed}-🎵`,
      observedAt: "2026-11-04T13:00:00.000Z",
      provenance: {
        kind: "suggestion",
        discoveryContextId: `déjà-${composed}`,
      },
      subject: {
        youtubeId: `${composed}-video`,
        queueItemId: `queue-${composed}`,
      },
      playbackContext: {
        kind: "discovery",
        discoveryContextId: `ctx-${composed}`,
      },
    });
    const decomposedFact = createPlaybackCompletionFact({
      playbackAttemptId: `attempt-${decomposed}-🎵`,
      observedAt: "2026-11-04T13:00:00.000Z",
      provenance: {
        kind: "suggestion",
        discoveryContextId: `déjà-${decomposed}`,
      },
      subject: {
        youtubeId: `${decomposed}-video`,
        queueItemId: `queue-${decomposed}`,
      },
      playbackContext: {
        kind: "discovery",
        discoveryContextId: `ctx-${decomposed}`,
      },
    });

    expect(composedFact.playbackAttemptId).toBe(`attempt-${composed}-🎵`);
    expect(composedFact.provenance).toMatchObject({
      discoveryContextId: `déjà-${composed}`,
    });
    expect(composedFact.subject).toEqual({
      youtubeId: `${composed}-video`,
      queueItemId: `queue-${composed}`,
    });
    expect(composedFact.playbackContext).toEqual({
      kind: "discovery",
      discoveryContextId: `ctx-${composed}`,
    });
    expect(composedFact.playbackAttemptId).not.toBe(
      decomposedFact.playbackAttemptId,
    );
    expect(composedFact.provenance).not.toEqual(decomposedFact.provenance);
    expect(composedFact.subject).not.toEqual(decomposedFact.subject);
    expect(composedFact.playbackContext).not.toEqual(
      decomposedFact.playbackContext,
    );
  });

  it("reads optional properties and getters only once", () => {
    let subjectReads = 0;
    let youtubeIdReads = 0;
    let queueItemIdReads = 0;
    let libraryEpochReads = 0;
    let playbackContextReads = 0;
    let queueIdReads = 0;

    const localInput = {
      playbackAttemptId: "attempt-getters-local",
      observedAt: at,
      get subject() {
        subjectReads += 1;
        return {
          get youtubeId() {
            youtubeIdReads += 1;
            return "yt-getter";
          },
          get queueItemId() {
            queueItemIdReads += 1;
            return "queue-item-getter";
          },
        };
      },
      provenance: {
        kind: "local-occurrence" as const,
        playlistId: "playlist-getter",
        occurrenceId: "occurrence-getter",
        get libraryEpoch() {
          libraryEpochReads += 1;
          return "epoch-getter";
        },
      },
      get playbackContext() {
        playbackContextReads += 1;
        return {
          kind: "queue" as const,
          get queueId() {
            queueIdReads += 1;
            return "queue-getter";
          },
        };
      },
    };

    const local = createPlaybackCompletionFact(
      localInput as unknown as PlaybackCompletionFact,
    );

    expect(local.provenance).toMatchObject({ libraryEpoch: "epoch-getter" });
    expect(local.subject).toEqual({
      youtubeId: "yt-getter",
      queueItemId: "queue-item-getter",
    });
    expect(local.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-getter",
    });
    expect(subjectReads).toBe(1);
    expect(youtubeIdReads).toBe(1);
    expect(queueItemIdReads).toBe(1);
    expect(libraryEpochReads).toBe(1);
    expect(playbackContextReads).toBe(1);
    expect(queueIdReads).toBe(1);

    let suggestionDiscoveryReads = 0;
    let contextDiscoveryReads = 0;

    const suggestionInput = {
      playbackAttemptId: "attempt-getters-suggestion",
      observedAt: at,
      provenance: {
        kind: "suggestion" as const,
        get discoveryContextId() {
          suggestionDiscoveryReads += 1;
          return "source-getter";
        },
      },
      subject: { youtubeId: "yt-suggestion" },
      playbackContext: {
        kind: "discovery" as const,
        get discoveryContextId() {
          contextDiscoveryReads += 1;
          return "context-getter";
        },
      },
    };

    const suggestion = createPlaybackCompletionFact(
      suggestionInput as unknown as PlaybackCompletionFact,
    );

    expect(suggestion.provenance).toEqual({
      kind: "suggestion",
      discoveryContextId: "source-getter",
    });
    expect(suggestion.playbackContext).toEqual({
      kind: "discovery",
      discoveryContextId: "context-getter",
    });
    expect(suggestionDiscoveryReads).toBe(1);
    expect(contextDiscoveryReads).toBe(1);
  });

  it.each([
    ["missing input", null],
    ["array input", []],
    ["missing attempt ID", { ...validFact(), playbackAttemptId: undefined }],
    ["empty attempt ID", { ...validFact(), playbackAttemptId: "" }],
    ["missing observation timestamp", { ...validFact(), observedAt: undefined }],
    ["empty observation timestamp", { ...validFact(), observedAt: "" }],
    ["non-string observation timestamp", { ...validFact(), observedAt: 42 }],
    ["missing provenance", { ...validFact(), provenance: undefined }],
    ["null provenance", { ...validFact(), provenance: null }],
    [
      "missing local occurrence ID",
      {
        ...validFact(),
        provenance: { kind: "local-occurrence", playlistId: "playlist-1" },
      },
    ],
    [
      "empty local playlist ID",
      {
        ...validFact(),
        provenance: {
          kind: "local-occurrence",
          playlistId: "",
          occurrenceId: "occurrence-1",
        },
      },
    ],
    [
      "non-string local epoch",
      {
        ...validFact(),
        provenance: {
          kind: "local-occurrence",
          libraryEpoch: 7,
          playlistId: "playlist-1",
          occurrenceId: "occurrence-1",
        },
      },
    ],
    [
      "null local epoch",
      {
        ...validFact(),
        provenance: {
          kind: "local-occurrence",
          libraryEpoch: null,
          playlistId: "playlist-1",
          occurrenceId: "occurrence-1",
        },
      },
    ],
    [
      "unknown provenance kind",
      { ...validFact(), provenance: { kind: "mystery" } },
    ],
    [
      "non-string suggestion discovery context",
      {
        ...validFact(),
        provenance: { kind: "suggestion", discoveryContextId: 7 },
      },
    ],
    [
      "null suggestion discovery context",
      {
        ...validFact(),
        provenance: { kind: "suggestion", discoveryContextId: null },
      },
    ],
    [
      "non-object subject",
      { ...validFact(), subject: "yt-subject" },
    ],
    [
      "null subject",
      { ...validFact(), subject: null },
    ],
    [
      "non-string subject YouTube ID",
      { ...validFact(), subject: { youtubeId: 42 } },
    ],
    [
      "null subject YouTube ID",
      { ...validFact(), subject: { youtubeId: null } },
    ],
    [
      "non-string subject queue item ID",
      { ...validFact(), subject: { queueItemId: 42 } },
    ],
    [
      "null subject queue item ID",
      { ...validFact(), subject: { queueItemId: null } },
    ],
    [
      "non-object playback context",
      { ...validFact(), playbackContext: "queue" },
    ],
    [
      "null playback context",
      { ...validFact(), playbackContext: null },
    ],
    [
      "unknown playback context kind",
      { ...validFact(), playbackContext: { kind: "mystery" } },
    ],
    [
      "non-string queue ID",
      { ...validFact(), playbackContext: { kind: "queue", queueId: 42 } },
    ],
    [
      "null queue ID",
      { ...validFact(), playbackContext: { kind: "queue", queueId: null } },
    ],
    [
      "non-string discovery context ID",
      {
        ...validFact(),
        playbackContext: { kind: "discovery", discoveryContextId: 42 },
      },
    ],
    [
      "null discovery context ID",
      {
        ...validFact(),
        playbackContext: { kind: "discovery", discoveryContextId: null },
      },
    ],
  ])("rejects %s", (_name, candidate) => {
    expect(() =>
      createPlaybackCompletionFact(
        candidate as unknown as PlaybackCompletionFact,
      ),
    ).toThrow(TypeError);
  });
});
