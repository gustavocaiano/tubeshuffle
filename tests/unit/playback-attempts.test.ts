import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlaybackCompletionFact,
  PlaybackCompletionProvenance,
  PlaybackContext,
  PlaybackSubject,
} from "@/lib/media/playback-completion";

const factoryControl = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/media/playback-completion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/media/playback-completion")>();

  return {
    ...actual,
    createPlaybackCompletionFact: (
      input: Parameters<typeof actual.createPlaybackCompletionFact>[0],
    ) => {
      if (factoryControl.fail) {
        factoryControl.fail = false;
        throw new TypeError("synthetic completion factory failure");
      }
      return actual.createPlaybackCompletionFact(input);
    },
  };
});

import {
  createPlaybackAttempts,
  type PlaybackAttemptInput,
  type PlaybackAttemptSnapshot,
  type PlaybackAssociation,
  type PlaybackAttempts,
  type PlaybackEndInput,
  type PlaybackEndOutcome,
  type PlaybackObservation,
  type PlaybackSignal,
} from "@/lib/media/playback-attempts";

const at = "2026-11-04T12:34:56.789Z";
const later = "2026-11-04T13:00:00.000Z";

function input(
  overrides: Partial<PlaybackAttemptInput> = {},
): PlaybackAttemptInput {
  return {
    playbackAttemptId: "attempt-1",
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

function ended(
  playbackAttemptId = "attempt-1",
  observedAt = at,
): PlaybackEndInput {
  return {
    signal: "ended",
    association: { kind: "asserted", playbackAttemptId },
    observedAt,
  };
}

function unassociated(
  signal: PlaybackSignal = "ended",
  observedAt = at,
): PlaybackEndInput {
  return { signal, association: { kind: "unassociated" }, observedAt };
}

function inferred(
  playbackAttemptId: string | null,
  observedAt = at,
): PlaybackEndInput {
  return playbackAttemptId === null
    ? unassociated("inferred-transition", observedAt)
    : {
        signal: "inferred-transition",
        association: { kind: "asserted", playbackAttemptId },
        observedAt,
      };
}

function factOf(outcome: PlaybackEndOutcome): PlaybackCompletionFact {
  if (outcome.status === "unresolved") {
    throw new Error("expected a completion fact, received unresolved");
  }
  return outcome.fact;
}

function observationOf(outcome: PlaybackEndOutcome): PlaybackObservation {
  if (outcome.status !== "unresolved") {
    throw new Error("expected an unresolved observation");
  }
  return outcome.observation;
}

function retire(
  tracker: PlaybackAttempts,
  playbackAttemptId: string,
): PlaybackAttemptSnapshot {
  const outcome = tracker.retire(playbackAttemptId);
  if (outcome.status !== "retired") {
    throw new Error(`expected attempt ${playbackAttemptId} to be retired`);
  }
  return outcome.attempt;
}

afterEach(() => {
  factoryControl.fail = false;
});

describe("createPlaybackAttempts", () => {
  it("captures and deeply freezes explicit provenance, subject, and context at begin", () => {
    const tracker = createPlaybackAttempts();
    const source = input();

    const snapshot = tracker.begin(source);

    expect(snapshot.playbackAttemptId).toBe("attempt-1");
    expect(snapshot.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-1",
      occurrenceId: "occurrence-1",
    });
    expect(snapshot.subject).toEqual({
      youtubeId: "dQw4w9WgXcQ",
      queueItemId: "queue-item-1",
    });
    expect(snapshot.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-1",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.provenance)).toBe(true);
    expect(Object.isFrozen(snapshot.subject)).toBe(true);
    expect(Object.isFrozen(snapshot.playbackContext)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.provenance)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.subject)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.playbackContext)).toBeNull();
    expect(Object.isFrozen(source)).toBe(false);
    expect(tracker.current()).toBe(snapshot);
  });

  it("produces one immutable completion fact only for an explicitly asserted ended event", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    const outcome = tracker.end(ended("attempt-1", at));

    expect(outcome.status).toBe("completed");
    const fact = factOf(outcome);
    expect(fact.playbackAttemptId).toBe("attempt-1");
    expect(fact.observedAt).toBe(at);
    expect(fact.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-1",
      occurrenceId: "occurrence-1",
    });
    expect(fact.subject).toEqual({
      youtubeId: "dQw4w9WgXcQ",
      queueItemId: "queue-item-1",
    });
    expect(fact.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-1",
    });
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.provenance)).toBe(true);
    expect(Object.isFrozen(fact.subject)).toBe(true);
    expect(Object.isFrozen(fact.playbackContext)).toBe(true);
    expect(tracker.current()).toBeNull();
  });

  it("returns the exact same fact object and original timestamp on a duplicate ended notification", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());
    const first = factOf(tracker.end(ended("attempt-1", at)));

    const duplicate = tracker.end(ended("attempt-1", later));

    expect(duplicate.status).toBe("duplicate");
    expect(factOf(duplicate)).toBe(first);
    expect(factOf(duplicate).observedAt).toBe(at);
  });

  it("treats an unassociated ended event as unresolved even while an attempt is active", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    const outcome = tracker.end(unassociated("ended", later));

    expect(outcome.status).toBe("unresolved");
    expect(observationOf(outcome)).toEqual({
      signal: "ended",
      association: { kind: "unassociated" },
      observedAt: later,
    });
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("treats an inferred-transition as unresolved even when its asserted ID matches the active attempt", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    const outcome = tracker.end(inferred("attempt-1", later));

    expect(outcome.status).toBe("unresolved");
    expect(observationOf(outcome)).toEqual({
      signal: "inferred-transition",
      association: { kind: "asserted", playbackAttemptId: "attempt-1" },
      observedAt: later,
    });
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("returns the original observation for an asserted but unmatched ended event", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    const outcome = tracker.end(ended("attempt-unknown", later));

    expect(outcome.status).toBe("unresolved");
    expect(observationOf(outcome)).toEqual({
      signal: "ended",
      association: {
        kind: "asserted",
        playbackAttemptId: "attempt-unknown",
      },
      observedAt: later,
    });
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("refuses a second begin while any attempt is active, including the same ID, and requires explicit retire", () => {
    const tracker = createPlaybackAttempts();
    const first = tracker.begin(input({ playbackAttemptId: "attempt-a" }));

    expect(() =>
      tracker.begin(input({ playbackAttemptId: "attempt-a" })),
    ).toThrow(TypeError);
    expect(() =>
      tracker.begin(input({ playbackAttemptId: "attempt-b" })),
    ).toThrow(TypeError);
    expect(tracker.current()).toBe(first);

    const displaced = retire(tracker, "attempt-a");
    expect(displaced).toBe(first);
    expect(tracker.current()).toBeNull();

    tracker.begin(input({ playbackAttemptId: "attempt-b" }));
    expect(tracker.end(ended("attempt-a"))).toMatchObject({
      status: "unresolved",
    });
    expect(tracker.end(ended("attempt-b")).status).toBe("completed");
  });

  it("retire returns the displaced snapshot and prevents that attempt from completing", () => {
    const tracker = createPlaybackAttempts();
    const snapshot = tracker.begin(input({ playbackAttemptId: "attempt-a" }));

    const outcome = tracker.retire("attempt-a");

    expect(outcome).toEqual({ status: "retired", attempt: snapshot });
    if (outcome.status !== "retired") throw new Error("unreachable");
    expect(outcome.attempt).toBe(snapshot);
    expect(tracker.current()).toBeNull();
    expect(tracker.end(ended("attempt-a"))).toMatchObject({
      status: "unresolved",
    });
  });

  it("returns not-active for a retire with a non-matching ID and preserves the active attempt", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    expect(tracker.retire("attempt-other")).toEqual({
      status: "not-active",
    });
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("clear returns the displaced snapshot and then null", () => {
    const tracker = createPlaybackAttempts();
    const snapshot = tracker.begin(input());

    expect(tracker.clear()).toBe(snapshot);
    expect(tracker.clear()).toBeNull();
    expect(tracker.current()).toBeNull();
    expect(tracker.end(ended("attempt-1"))).toMatchObject({
      status: "unresolved",
    });
  });

  it("clear keeps the most recent completed fact for duplicate tolerance", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-completed" }));
    const fact = factOf(tracker.end(ended("attempt-completed")));

    const active = tracker.begin(input({ playbackAttemptId: "attempt-active" }));
    expect(tracker.clear()).toBe(active);

    expect(tracker.end(ended("attempt-active"))).toMatchObject({
      status: "unresolved",
    });

    const duplicate = tracker.end(ended("attempt-completed", later));
    expect(duplicate.status).toBe("duplicate");
    expect(factOf(duplicate)).toBe(fact);
    expect(factOf(duplicate).observedAt).toBe(at);
  });

  it("treats same queue identities as separate replay attempts and never merges their facts", () => {
    const tracker = createPlaybackAttempts();

    tracker.begin(input({ playbackAttemptId: "attempt-repeat-1" }));
    const first = factOf(
      tracker.end(ended("attempt-repeat-1", "2026-11-04T10:00:00.000Z")),
    );

    // Same playlist occurrence, YouTube ID, queue item, and queue, but an
    // explicitly different attempt ID after the first completed.
    tracker.begin(input({ playbackAttemptId: "attempt-repeat-2" }));
    const second = factOf(
      tracker.end(ended("attempt-repeat-2", "2026-11-04T10:05:00.000Z")),
    );

    expect(second).not.toBe(first);
    expect(second.playbackAttemptId).not.toBe(first.playbackAttemptId);
    expect(second.observedAt).not.toBe(first.observedAt);
    expect(second.provenance).toEqual(first.provenance);
    expect(second.subject).toEqual(first.subject);
    expect(second.playbackContext).toEqual(first.playbackContext);
  });

  it("retains only the most recently completed fact and resolves older duplicates as unresolved", () => {
    const tracker = createPlaybackAttempts();

    tracker.begin(input({ playbackAttemptId: "attempt-old" }));
    const oldFact = factOf(tracker.end(ended("attempt-old")));

    tracker.begin(input({ playbackAttemptId: "attempt-new" }));
    const newFact = factOf(tracker.end(ended("attempt-new")));

    const duplicate = tracker.end(ended("attempt-new", later));
    expect(duplicate.status).toBe("duplicate");
    expect(factOf(duplicate)).toBe(newFact);

    // The bounded cache holds one completed fact; the older fact is lost.
    expect(tracker.end(ended("attempt-old"))).toMatchObject({
      status: "unresolved",
    });
    expect(oldFact).not.toBe(newFact);
  });

  it("keeps synthetic repeated YouTube IDs as separate attempts", () => {
    const tracker = createPlaybackAttempts();
    const sharedSubject = { youtubeId: "same-youtube-id" };

    tracker.begin(
      input({ playbackAttemptId: "attempt-yt-1", subject: sharedSubject }),
    );
    const first = factOf(tracker.end(ended("attempt-yt-1")));

    tracker.begin(
      input({ playbackAttemptId: "attempt-yt-2", subject: sharedSubject }),
    );
    const second = factOf(tracker.end(ended("attempt-yt-2")));

    expect(first.playbackAttemptId).not.toBe(second.playbackAttemptId);
    expect(first.subject).toEqual({ youtubeId: "same-youtube-id" });
    expect(second.subject).toEqual({ youtubeId: "same-youtube-id" });
    expect(first).not.toBe(second);
  });

  it("returns a late ended event tagged A as unresolved while B is active", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-a" }));
    const displaced = retire(tracker, "attempt-a");
    tracker.begin(input({ playbackAttemptId: "attempt-b" }));

    const outcome = tracker.end(ended("attempt-a"));

    expect(outcome.status).toBe("unresolved");
    expect(observationOf(outcome)).toEqual({
      signal: "ended",
      association: { kind: "asserted", playbackAttemptId: "attempt-a" },
      observedAt: at,
    });
    expect(displaced.playbackAttemptId).toBe("attempt-a");
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-b");
    expect(tracker.end(ended("attempt-b")).status).toBe("completed");
  });

  it("reuses a retained A fact for a late duplicate while B is active without touching B", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-a" }));
    const factA = factOf(tracker.end(ended("attempt-a")));

    tracker.begin(input({ playbackAttemptId: "attempt-b" }));

    const late = tracker.end(ended("attempt-a", later));
    expect(late.status).toBe("duplicate");
    expect(factOf(late)).toBe(factA);
    expect(factOf(late).observedAt).toBe(at);
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-b");
    expect(tracker.end(ended("attempt-b")).status).toBe("completed");
  });

  it("accepts an explicitly asserted B ended event even if it may have originated from stale A, because correlation cannot be proven", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-a" }));
    retire(tracker, "attempt-a");
    tracker.begin(input({ playbackAttemptId: "attempt-b" }));

    // The caller honestly tags the event as B. The tracker cannot prove that
    // the underlying iframe event was not stale A, so it must not invent a
    // correlation check.
    const outcome = tracker.end(ended("attempt-b"));

    expect(outcome.status).toBe("completed");
    expect(factOf(outcome).playbackAttemptId).toBe("attempt-b");
    expect(tracker.current()).toBeNull();
  });

  it("does not bind a queue move or a same-video event to the active attempt by inference", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-original" }));

    // The caller moved the same YouTube video to a different queue item. That
    // event is not the original explicit attempt unless the caller asserts it.
    expect(tracker.end(ended("queue-item-moved"))).toMatchObject({
      status: "unresolved",
    });
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-original");

    const completed = tracker.end(ended("attempt-original"));
    expect(completed.status).toBe("completed");
    expect(factOf(completed).subject).toEqual({
      youtubeId: "dQw4w9WgXcQ",
      queueItemId: "queue-item-1",
    });
  });

  it("copies caller input so later source mutation cannot alter the captured attempt or its fact", () => {
    const tracker = createPlaybackAttempts();
    const provenance = {
      kind: "local-occurrence" as const,
      playlistId: "playlist-before",
      occurrenceId: "occurrence-before",
    };
    const subject = {
      youtubeId: "yt-before",
      queueItemId: "queue-item-before",
    };
    const playbackContext = {
      kind: "queue" as const,
      queueId: "queue-before",
    };
    const source = {
      playbackAttemptId: "attempt-before",
      provenance,
      subject,
      playbackContext,
    };

    const snapshot = tracker.begin(source);

    source.playbackAttemptId = "attempt-after";
    provenance.playlistId = "playlist-after";
    provenance.occurrenceId = "occurrence-after";
    subject.youtubeId = "yt-after";
    subject.queueItemId = "queue-item-after";
    playbackContext.queueId = "queue-after";

    expect(snapshot.playbackAttemptId).toBe("attempt-before");
    expect(snapshot.provenance).toEqual({
      kind: "local-occurrence",
      playlistId: "playlist-before",
      occurrenceId: "occurrence-before",
    });
    expect(snapshot.subject).toEqual({
      youtubeId: "yt-before",
      queueItemId: "queue-item-before",
    });
    expect(snapshot.playbackContext).toEqual({
      kind: "queue",
      queueId: "queue-before",
    });

    const fact = factOf(tracker.end(ended("attempt-before")));
    expect(fact.provenance).toEqual({
      kind: "local-occurrence",
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
  });

  it("preserves empty optional strings while keeping absent optionals absent", () => {
    const tracker = createPlaybackAttempts();

    tracker.begin({
      playbackAttemptId: "attempt-empty",
      provenance: {
        kind: "local-occurrence",
        libraryEpoch: "",
        playlistId: "playlist-empty",
        occurrenceId: "occurrence-empty",
      },
      subject: { youtubeId: "", queueItemId: "" },
      playbackContext: { kind: "queue", queueId: "" },
    });
    const empty = factOf(tracker.end(ended("attempt-empty")));

    expect(empty.provenance).toHaveProperty("libraryEpoch", "");
    expect(empty.subject).toEqual({ youtubeId: "", queueItemId: "" });
    expect(empty.playbackContext).toEqual({ kind: "queue", queueId: "" });

    tracker.begin({
      playbackAttemptId: "attempt-absent",
      provenance: { kind: "suggestion" },
      subject: {},
    });
    const absent = factOf(
      tracker.end(ended("attempt-absent", "2026-11-04T14:00:00.000Z")),
    );

    expect(absent.provenance).toEqual({ kind: "suggestion" });
    expect(absent.provenance).not.toHaveProperty("libraryEpoch");
    expect(absent.subject).toEqual({});
    expect(absent.subject).not.toHaveProperty("youtubeId");
    expect(absent.subject).not.toHaveProperty("queueItemId");
    expect(absent).not.toHaveProperty("playbackContext");
  });

  it("does not pick up Object.prototype optionals introduced after begin", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin({
      playbackAttemptId: "attempt-polluted",
      provenance: { kind: "suggestion" },
    });

    const nested = createPlaybackAttempts();
    nested.begin({
      playbackAttemptId: "attempt-nested-polluted",
      provenance: { kind: "local-occurrence", playlistId: "p", occurrenceId: "o" },
      subject: { youtubeId: "own-youtube-id" },
    });

    let fact: PlaybackCompletionFact;
    let nestedFact: PlaybackCompletionFact;
    try {
      Object.defineProperty(Object.prototype, "subject", {
        value: { youtubeId: "polluted-youtube-id" },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Object.prototype, "playbackContext", {
        value: { kind: "queue", queueId: "polluted-queue-id" },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Object.prototype, "libraryEpoch", {
        value: "polluted-epoch",
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Object.prototype, "queueItemId", {
        value: "polluted-queue-item-id",
        configurable: true,
        writable: true,
      });

      fact = factOf(tracker.end(ended("attempt-polluted")));
      nestedFact = factOf(nested.end(ended("attempt-nested-polluted")));
    } finally {
      delete (Object.prototype as Record<string, unknown>).subject;
      delete (Object.prototype as Record<string, unknown>).playbackContext;
      delete (Object.prototype as Record<string, unknown>).libraryEpoch;
      delete (Object.prototype as Record<string, unknown>).queueItemId;
    }

    expect(Object.prototype.hasOwnProperty.call(fact, "subject")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fact, "playbackContext")).toBe(
      false,
    );
    expect(fact.provenance).toEqual({ kind: "suggestion" });
    expect(
      Object.prototype.hasOwnProperty.call(fact.provenance, "libraryEpoch"),
    ).toBe(false);

    expect(nestedFact.subject).toEqual({ youtubeId: "own-youtube-id" });
    expect(
      Object.prototype.hasOwnProperty.call(nestedFact.subject, "queueItemId"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(nestedFact.provenance, "libraryEpoch"),
    ).toBe(false);
  });

  it("rejects inherited declared subject fields instead of silently omitting them", () => {
    const tracker = createPlaybackAttempts();
    const inheritedYoutubeId = Object.create({
      youtubeId: "inherited-youtube-id",
    }) as Record<string, unknown>;

    expect(() =>
      tracker.begin(
        input({
          subject: inheritedYoutubeId as unknown as PlaybackSubject,
        }),
      ),
    ).toThrow(TypeError);

    const inheritedQueueItemId = Object.create({
      queueItemId: "inherited-queue-item-id",
    }) as Record<string, unknown>;
    inheritedQueueItemId.youtubeId = "own-youtube-id";

    expect(() =>
      tracker.begin(
        input({
          subject: inheritedQueueItemId as unknown as PlaybackSubject,
        }),
      ),
    ).toThrow(TypeError);

    expect(tracker.current()).toBeNull();
    tracker.begin(input());
    expect(tracker.end(ended()).status).toBe("completed");
  });

  it("rejects inherited declared optional provenance and context fields", () => {
    const tracker = createPlaybackAttempts();

    const inheritedEpoch = Object.create({
      libraryEpoch: "inherited-epoch",
    }) as Record<string, unknown>;
    inheritedEpoch.kind = "local-occurrence";
    inheritedEpoch.playlistId = "playlist-1";
    inheritedEpoch.occurrenceId = "occurrence-1";

    expect(() =>
      tracker.begin(
        input({
          provenance:
            inheritedEpoch as unknown as PlaybackCompletionProvenance,
        }),
      ),
    ).toThrow(TypeError);

    const inheritedDiscovery = Object.create({
      discoveryContextId: "inherited-discovery",
    }) as Record<string, unknown>;
    inheritedDiscovery.kind = "suggestion";

    expect(() =>
      tracker.begin(
        input({
          provenance:
            inheritedDiscovery as unknown as PlaybackCompletionProvenance,
        }),
      ),
    ).toThrow(TypeError);

    const inheritedQueueId = Object.create({
      queueId: "inherited-queue",
    }) as Record<string, unknown>;
    inheritedQueueId.kind = "queue";

    expect(() =>
      tracker.begin(
        input({
          playbackContext: inheritedQueueId as unknown as PlaybackContext,
        }),
      ),
    ).toThrow(TypeError);

    const inheritedContextKind = Object.create({
      kind: "unknown",
    }) as Record<string, unknown>;

    expect(() =>
      tracker.begin(
        input({
          playbackContext:
            inheritedContextKind as unknown as PlaybackContext,
        }),
      ),
    ).toThrow(TypeError);

    expect(tracker.current()).toBeNull();
    tracker.begin(input());
    expect(tracker.end(ended()).status).toBe("completed");
  });

  it("rejects inherited declared top-level begin and end fields before state change", () => {
    const tracker = createPlaybackAttempts();

    const inheritedAttemptId = Object.create({
      playbackAttemptId: "inherited-attempt",
    }) as Record<string, unknown>;
    inheritedAttemptId.provenance = { kind: "unknown" };

    expect(() =>
      tracker.begin(inheritedAttemptId as unknown as PlaybackAttemptInput),
    ).toThrow(TypeError);
    expect(tracker.current()).toBeNull();

    const active = tracker.begin(input());
    const inheritedAssociationId = Object.create({
      playbackAttemptId: "attempt-1",
    }) as Record<string, unknown>;
    inheritedAssociationId.kind = "asserted";

    expect(() =>
      tracker.end({
        signal: "ended",
        association:
          inheritedAssociationId as unknown as PlaybackAssociation,
        observedAt: at,
      }),
    ).toThrow(TypeError);

    expect(tracker.current()).toBe(active);
    expect(tracker.end(ended()).status).toBe("completed");
  });

  it("rejects inherited declared fields without invoking inherited getters", () => {
    let reads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "youtubeId", {
      configurable: true,
      get() {
        reads += 1;
        throw new Error("inherited getter must not run");
      },
    });
    const subject = Object.create(prototype);
    const tracker = createPlaybackAttempts();

    expect(() =>
      tracker.begin(
        input({ subject: subject as unknown as PlaybackSubject }),
      ),
    ).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(tracker.current()).toBeNull();
  });

  it("returns the exact mutable raw observation alongside a frozen normalized observation when unresolved", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());
    const raw = {
      signal: "inferred-transition",
      association: { kind: "unassociated" },
      observedAt: at,
      extra: { note: "caller-owned", count: 1 },
    };

    const outcome = tracker.end(raw as unknown as PlaybackEndInput);
    if (outcome.status !== "unresolved") {
      throw new Error("expected unresolved");
    }

    expect(outcome.rawObservation).toBe(raw);
    expect(outcome.observation).toEqual({
      signal: "inferred-transition",
      association: { kind: "unassociated" },
      observedAt: at,
    });
    expect(Object.isFrozen(outcome.observation)).toBe(true);
    expect(Object.isFrozen(outcome.rawObservation)).toBe(false);

    const mutableRaw = outcome.rawObservation as unknown as {
      observedAt: string;
      extra: { note: string; count: number };
    };
    expect(mutableRaw.extra).toEqual({ note: "caller-owned", count: 1 });

    mutableRaw.observedAt = later;
    mutableRaw.extra.note = "changed-by-caller";
    expect(outcome.rawObservation).toBe(raw);
    expect(mutableRaw.observedAt).toBe(later);
    expect(mutableRaw.extra.note).toBe("changed-by-caller");
    expect(outcome.observation.observedAt).toBe(at);

    // The module retained no copy of the raw observation; the active attempt
    // is still the one begun above.
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("rejects an ID still cached as the most recent completion", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-cached" }));
    const fact = factOf(tracker.end(ended("attempt-cached")));

    expect(() =>
      tracker.begin(input({ playbackAttemptId: "attempt-cached" })),
    ).toThrow(TypeError);
    expect(tracker.current()).toBeNull();

    const duplicate = tracker.end(ended("attempt-cached"));
    expect(duplicate.status).toBe("duplicate");
    expect(factOf(duplicate)).toBe(fact);
  });

  it.each<[string, unknown]>([
    ["missing input", null],
    ["array input", []],
    ["missing attempt ID", { ...input(), playbackAttemptId: undefined }],
    ["empty attempt ID", { ...input(), playbackAttemptId: "" }],
    ["non-string attempt ID", { ...input(), playbackAttemptId: 42 }],
    ["missing provenance", { ...input(), provenance: undefined }],
    ["null provenance", { ...input(), provenance: null }],
    ["unknown provenance kind", { ...input(), provenance: { kind: "mystery" } }],
    [
      "empty local playlist ID",
      {
        ...input(),
        provenance: {
          kind: "local-occurrence",
          playlistId: "",
          occurrenceId: "occurrence-1",
        },
      },
    ],
    [
      "empty local occurrence ID",
      {
        ...input(),
        provenance: {
          kind: "local-occurrence",
          playlistId: "playlist-1",
          occurrenceId: "",
        },
      },
    ],
    [
      "null local library epoch",
      {
        ...input(),
        provenance: {
          kind: "local-occurrence",
          libraryEpoch: null,
          playlistId: "playlist-1",
          occurrenceId: "occurrence-1",
        },
      },
    ],
    [
      "non-string suggestion discovery context",
      {
        ...input(),
        provenance: { kind: "suggestion", discoveryContextId: 7 },
      },
    ],
    ["null subject", { ...input(), subject: null }],
    ["non-object subject", { ...input(), subject: "subject" }],
    [
      "null subject YouTube ID",
      { ...input(), subject: { youtubeId: null } },
    ],
    [
      "non-string subject queue item ID",
      { ...input(), subject: { queueItemId: 7 } },
    ],
    ["null playback context", { ...input(), playbackContext: null }],
    [
      "unknown playback context kind",
      { ...input(), playbackContext: { kind: "mystery" } },
    ],
    [
      "null queue ID",
      { ...input(), playbackContext: { kind: "queue", queueId: null } },
    ],
  ])("rejects invalid begin input (%s) without changing state", (_name, candidate) => {
    const tracker = createPlaybackAttempts();

    expect(() =>
      tracker.begin(candidate as unknown as PlaybackAttemptInput),
    ).toThrow(TypeError);

    expect(tracker.current()).toBeNull();

    tracker.begin(input({ playbackAttemptId: "attempt-valid" }));
    expect(tracker.end(ended("attempt-valid")).status).toBe("completed");
  });

  it.each<[string, unknown]>([
    ["missing input", null],
    ["array input", []],
    ["missing signal", { association: { kind: "unassociated" }, observedAt: at }],
    [
      "unknown signal",
      {
        signal: "inferred",
        association: { kind: "unassociated" },
        observedAt: at,
      },
    ],
    ["missing association", { signal: "ended", observedAt: at }],
    [
      "null association",
      { signal: "ended", association: null, observedAt: at },
    ],
    [
      "non-object association",
      { signal: "ended", association: "asserted", observedAt: at },
    ],
    [
      "missing association kind",
      { signal: "ended", association: {}, observedAt: at },
    ],
    [
      "unknown association kind",
      {
        signal: "ended",
        association: { kind: "inferred" },
        observedAt: at,
      },
    ],
    [
      "asserted association without ID",
      {
        signal: "ended",
        association: { kind: "asserted" },
        observedAt: at,
      },
    ],
    [
      "asserted association with empty ID",
      {
        signal: "ended",
        association: { kind: "asserted", playbackAttemptId: "" },
        observedAt: at,
      },
    ],
    [
      "asserted association with non-string ID",
      {
        signal: "ended",
        association: { kind: "asserted", playbackAttemptId: 42 },
        observedAt: at,
      },
    ],
    [
      "missing observation timestamp",
      {
        signal: "ended",
        association: {
          kind: "asserted",
          playbackAttemptId: "attempt-1",
        },
      },
    ],
    [
      "empty observation timestamp",
      {
        signal: "ended",
        association: {
          kind: "asserted",
          playbackAttemptId: "attempt-1",
        },
        observedAt: "",
      },
    ],
    [
      "non-string observation timestamp",
      {
        signal: "ended",
        association: {
          kind: "asserted",
          playbackAttemptId: "attempt-1",
        },
        observedAt: 42,
      },
    ],
  ])("rejects invalid end input (%s) without changing state", (_name, candidate) => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    expect(() =>
      tracker.end(candidate as unknown as PlaybackEndInput),
    ).toThrow(TypeError);

    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it.each<[string, unknown]>([
    ["empty ID", ""],
    ["non-string ID", 42],
    ["null ID", null],
  ])("rejects invalid retire input (%s) without changing state", (_name, candidate) => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input());

    expect(() =>
      tracker.retire(candidate as unknown as string),
    ).toThrow(TypeError);

    expect(tracker.current()?.playbackAttemptId).toBe("attempt-1");
    expect(tracker.end(ended("attempt-1")).status).toBe("completed");
  });

  it("leaves active and completed state unchanged when the completion factory rejects", () => {
    const tracker = createPlaybackAttempts();
    tracker.begin(input({ playbackAttemptId: "attempt-completed" }));
    const completed = factOf(tracker.end(ended("attempt-completed")));

    tracker.begin(input({ playbackAttemptId: "attempt-active" }));

    factoryControl.fail = true;
    expect(() => tracker.end(ended("attempt-active"))).toThrow(TypeError);

    // Neither the active attempt nor the retained fact was consumed.
    expect(tracker.current()?.playbackAttemptId).toBe("attempt-active");
    const duplicate = tracker.end(ended("attempt-completed"));
    expect(duplicate.status).toBe("duplicate");
    expect(factOf(duplicate)).toBe(completed);

    const retried = tracker.end(ended("attempt-active", later));
    expect(retried.status).toBe("completed");
    expect(factOf(retried).playbackAttemptId).toBe("attempt-active");
  });
});
