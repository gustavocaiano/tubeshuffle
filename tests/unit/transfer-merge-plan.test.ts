import { describe, expect, it } from "vitest";
import fixture from "../../shared/fixtures/transfer-v1.json";
import { bindConfirmations, planTransferMerge, validateMergePreview, type ConfirmedPair, type ValidatedTransferSnapshot } from "@/lib/transfer/merge-plan";

type Vector = { name: string; source: ValidatedTransferSnapshot; destination: ValidatedTransferSnapshot; confirmedPairs?: Omit<ConfirmedPair, "confirmed">[]; injection?: string; expected: { status?: string; code?: string; report?: unknown; destination?: ValidatedTransferSnapshot; conflicts?: unknown } };
const merge = fixture.vectors.merge as Vector[];
const legacy = fixture.vectors.equalLegacyOccurrences as Vector[];
const revision = "revision-1";
const confirm = (v: Vector) => bindConfirmations(v.source, v.destination, revision, (v.confirmedPairs ?? []).map(p => ({ ...p, confirmed: true })));

describe("transfer merge preview", () => {
  for (const v of merge.filter(v => !v.injection)) {
    it(`shared vector: ${v.name}`, () => {
      const before = structuredClone(v);
      const result = planTransferMerge(v.source, v.destination, revision, confirm(v));
      if (v.expected.status === "rejected") expect(result).toEqual({ ok: false, code: v.expected.code });
      else {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.report).toEqual(v.expected.report);
        expect({ playlists: [...v.destination.playlists, ...result.creates.playlists], videos: [...v.destination.videos, ...result.creates.videos], history: [...v.destination.history, ...result.creates.history] }).toEqual(v.expected.destination);
      }
      expect(v).toEqual(before);
    });
  }
  for (const v of legacy) {
    it(`legacy vector: ${v.name}`, () => {
      const result = planTransferMerge(v.source, v.destination, revision, confirm(v));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.conflicts).toEqual(v.expected.conflicts);
        expect(result.report.omittedOrphans).toEqual([]);
        expect(result.report.created).toEqual({ playlists: 0, videos: 0, history: v.confirmedPairs!.length ? 1 : 0 });
        expect(result.report.identical).toEqual({ playlists: 1, videos: v.confirmedPairs!.length ? 1 : 0, history: 0 });
        expect({ playlists: [...v.destination.playlists, ...result.creates.playlists], videos: [...v.destination.videos, ...result.creates.videos], history: [...v.destination.history, ...result.creates.history] }).toEqual(v.expected.destination);
      }
    });
  }
  it("rejects duplicate targets and stale or empty assertions", () => {
    const v = merge.find(v => v.name === "repeat identical import")!;
    const pairs = v.confirmedPairs!.map(p => ({ ...p, confirmed: true as const }));
    expect(planTransferMerge(v.source, v.destination, revision, bindConfirmations(v.source, v.destination, revision, [pairs[0], { ...pairs[1], destinationVideoId: pairs[0].destinationVideoId }]))).toEqual({ ok: false, code: "invalid_confirmation" });
    expect(planTransferMerge(v.source, v.destination, revision, bindConfirmations(v.source, v.destination, revision, [{ ...pairs[0], externalEvidence: " " }]))).toEqual({ ok: false, code: "invalid_confirmation" });
    expect(planTransferMerge(v.source, v.destination, "changed", confirm(v))).toEqual({ ok: false, code: "stale_confirmation" });
    const changed = structuredClone(v.source);
    changed.videos[0].title = "changed";
    expect(planTransferMerge(changed, v.destination, revision, confirm(v))).toEqual({ ok: false, code: "stale_confirmation" });
  });
  it("never aliases created tag arrays", () => {
    const v = structuredClone(merge[0]);
    v.source.videos[0].tags = ["original"];
    const result = planTransferMerge(v.source, v.destination, revision);
    if (!result.ok) throw new Error(result.code);
    result.creates.videos[0].tags!.push("changed");
    expect(v.source.videos[0].tags).toEqual(["original"]);
  });
  it("seals copied assertions and rejects altered pairs or evidence", () => {
    const v = merge.find(v => v.name === "repeat identical import")!;
    const pairs = v.confirmedPairs!.map(p => ({ ...p, confirmed: true as const }));
    const confirmation = bindConfirmations(v.source, v.destination, revision, pairs);
    pairs[0].externalEvidence = "changed outside";
    expect(planTransferMerge(v.source, v.destination, revision, confirmation).ok).toBe(true);
    confirmation.pairs[0].externalEvidence = "changed inside";
    expect(planTransferMerge(v.source, v.destination, revision, confirmation)).toEqual({ ok: false, code: "invalid_confirmation" });
    const other = confirm(v);
    other.pairs[0].destinationVideoId = other.pairs[1].destinationVideoId;
    expect(planTransferMerge(v.source, v.destination, revision, other)).toEqual({ ok: false, code: "invalid_confirmation" });
    expect(planTransferMerge(v.source, v.destination, revision, { ...confirm(v) })).toEqual({ ok: false, code: "invalid_confirmation" });
  });
  it("revalidates preview data and exact snapshots, revision and assertions", () => {
    const v = structuredClone(merge[0]);
    const confirmation = confirm(v);
    const plan = planTransferMerge(v.source, v.destination, revision, confirmation);
    if (!plan.ok) throw new Error(plan.code);
    expect(validateMergePreview(plan, v.source, v.destination, revision, confirmation)).toBe(true);
    expect(validateMergePreview(plan, v.source, v.destination, "new", confirmation)).toBe(false);
    const changed = structuredClone(v.source);
    changed.playlists[0].title += " changed";
    expect(validateMergePreview(plan, changed, v.destination, revision, confirmation)).toBe(false);
    const dest = structuredClone(v.destination);
    (dest.playlists as typeof v.source.playlists[number][]).push({ ...v.source.playlists[0], id: "other" });
    expect(validateMergePreview(plan, v.source, dest, revision, confirmation)).toBe(false);
    plan.creates.videos[0].title = "tampered";
    expect(validateMergePreview(plan, v.source, v.destination, revision, confirmation)).toBe(false);
  });
  it.each([
    ["playlist create", (plan: Extract<ReturnType<typeof planTransferMerge>, { ok: true }>) => { plan.creates.playlists[0].title += " changed"; }],
    ["history create", (plan: Extract<ReturnType<typeof planTransferMerge>, { ok: true }>) => { plan.creates.history[0].watchedSeconds++; }],
    ["report count", (plan: Extract<ReturnType<typeof planTransferMerge>, { ok: true }>) => { plan.report.created.history++; }],
    ["report conflict", (plan: Extract<ReturnType<typeof planTransferMerge>, { ok: true }>) => { plan.report.conflicts.push({ kind: "history", id: "fake", reason: "fields" }); }],
    ["preview revision", (plan: Extract<ReturnType<typeof planTransferMerge>, { ok: true }>) => { plan.revision = "changed"; }],
  ])("detects mutation of %s", (_name, mutate) => {
    const v = structuredClone(merge[0]);
    const plan = planTransferMerge(v.source, v.destination, revision);
    if (!plan.ok) throw new Error(plan.code);
    expect(plan.creates.playlists).not.toHaveLength(0);
    expect(plan.creates.history).not.toHaveLength(0);
    expect(validateMergePreview(plan, v.source, v.destination, revision)).toBe(true);
    mutate(plan);
    expect(validateMergePreview(plan, v.source, v.destination, revision)).toBe(false);
  });
  it.each(["sourceSnapshot", "destinationSnapshot", "revision"] as const)("rejects mutation of confirmation %s", field => {
    const v = merge.find(v => v.name === "repeat identical import")!;
    const confirmation = confirm(v);
    confirmation[field] += " changed";
    expect(planTransferMerge(v.source, v.destination, revision, confirmation)).toEqual({ ok: false, code: "invalid_confirmation" });
  });
  it("invalidates an issued preview when its confirmation changes", () => {
    const v = merge.find(v => v.name === "repeat identical import")!;
    const confirmation = confirm(v);
    const plan = planTransferMerge(v.source, v.destination, revision, confirmation);
    expect(validateMergePreview(plan, v.source, v.destination, revision, confirmation)).toBe(true);
    confirmation.pairs[0].externalEvidence = "changed after preview";
    expect(validateMergePreview(plan, v.source, v.destination, revision, confirmation)).toBe(false);
  });
  it.each(["missing playlist", "missing video", "cross-playlist"])("rejects destination history with %s", kind => {
    const v = structuredClone(merge[0]);
    const destination = structuredClone(v.source);
    const event = destination.history[0];
    if (kind === "missing playlist") event.playlistId = "missing";
    else if (kind === "missing video") event.videoId = "missing";
    else {
      (destination.playlists as typeof v.source.playlists[number][]).push({ ...destination.playlists[0], id: "other", youtubeId: "other" });
      event.playlistId = "other";
    }
    expect(planTransferMerge(v.source, destination, revision)).toEqual({ ok: false, code: "invalid_destination" });
  });
  it("rejects duplicate identities and dangling video references without output", () => {
    const v = structuredClone(merge[0]);
    const duplicateSource = structuredClone(v.source);
    (duplicateSource.videos as typeof v.source.videos[number][]).push({ ...duplicateSource.videos[0], position: 99 });
    expect(planTransferMerge(duplicateSource, v.destination, revision)).toEqual({ ok: false, code: "invalid_source" });
    const missing = structuredClone(v.source);
    missing.videos[0].playlistId = "missing";
    expect(planTransferMerge(missing, v.destination, revision)).toEqual({ ok: false, code: "invalid_source" });
    const dest = structuredClone(v.destination);
    (dest.playlists as typeof v.source.playlists[number][]).push({ ...v.source.playlists[0], id: "one" }, { ...v.source.playlists[0], id: "two" });
    expect(planTransferMerge(v.source, dest, revision)).toEqual({ ok: false, code: "invalid_destination" });
  });
});
