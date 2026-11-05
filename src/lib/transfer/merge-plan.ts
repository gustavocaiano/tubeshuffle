import type { LocalPlaylist, LocalVideo, LocalPlayEvent } from "@/types/playlist";

/** Caller guarantees complete transfer-v1 validation; this type does not enforce it. */
export type ValidatedTransferSnapshot = {
  readonly playlists: readonly LocalPlaylist[];
  readonly videos: readonly LocalVideo[];
  readonly history: readonly LocalPlayEvent[];
};
export type ConfirmedPair = { sourceVideoId: string; destinationVideoId: string; externalEvidence: string; confirmed: true };
export type Confirmation = { sourceSnapshot: string; destinationSnapshot: string; revision: string; pairs: readonly ConfirmedPair[] };
type Counts = { playlists: number; videos: number; history: number };
type Conflict = { kind: "playlist" | "video" | "history"; id: string; reason: string };
export type MergePlan =
  | { ok: false; code: "invalid_source" | "invalid_destination" | "playlist_id_collision" | "invalid_confirmation" | "stale_confirmation" }
  | { ok: true; previewOnly: true; revision: string; creates: { playlists: LocalPlaylist[]; videos: LocalVideo[]; history: LocalPlayEvent[] }; report: { created: Counts; identical: Counts; conflicts: Conflict[]; omittedOrphans: { id: string; reason: string }[] } };

// JSON object key order is immaterial; array order and absent properties are significant.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Process-local seals detect changes to issued objects when the checks are called.
// Any caller can issue new objects; seals do not establish authorization or evidence.
const confirmationSeals = new WeakMap<Confirmation, string>();
const previewSeals = new WeakMap<object, string>();

/**
 * Bind caller-supplied assertions to snapshots and a caller-supplied revision.
 * Neither `confirmed` nor `externalEvidence` proves user authorization or evidence.
 * Snapshot validation and revision freshness are caller responsibilities.
 */
export function bindConfirmations(source: ValidatedTransferSnapshot, destination: ValidatedTransferSnapshot, revision: string, pairs: readonly ConfirmedPair[]): Confirmation {
  const confirmation = { sourceSnapshot: canonical(source), destinationSnapshot: canonical(destination), revision, pairs: pairs.map(pair => ({ ...pair })) };
  confirmationSeals.set(confirmation, canonical(confirmation));
  return confirmation;
}

// Complete field/schema validation remains a prerequisite. Enforce the identity and
// reference invariants on which this planner relies even if a caller breaks it.
function validIdentities(snapshot: ValidatedTransferSnapshot, destination: boolean): boolean {
  const unique = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;
  if (!unique(snapshot.playlists, p => p.id) || !unique(snapshot.playlists, p => p.youtubeId) ||
      !unique(snapshot.videos, v => v.id) || !unique(snapshot.videos, v => JSON.stringify([v.playlistId, v.position])) ||
      !unique(snapshot.history, h => h.id)) return false;
  const playlists = new Set(snapshot.playlists.map(p => p.id));
  const videos = new Map(snapshot.videos.map(v => [v.id, v]));
  if (snapshot.videos.some(v => !playlists.has(v.playlistId))) return false;
  return !destination || snapshot.history.every(h => playlists.has(h.playlistId) && videos.get(h.videoId)?.playlistId === h.playlistId);
}

/**
 * Isolated prototype: computes data only, with no transaction writer or integration.
 * `previewOnly` is a marker, not a barrier to using the returned data for writes.
 * The caller must supply validated snapshots and a trustworthy, current revision.
 * Full snapshots are repeatedly serialized; performance and resource use are unverified.
 */
export function planTransferMerge(source: ValidatedTransferSnapshot, destination: ValidatedTransferSnapshot, revision: string, confirmation?: Confirmation): MergePlan {
  if (!validIdentities(source, false)) return { ok: false, code: "invalid_source" };
  if (!validIdentities(destination, true)) return { ok: false, code: "invalid_destination" };
  const dstPlaylistIds = new Map(destination.playlists.map(p => [p.id, p]));
  const dstPlaylistYoutube = new Map(destination.playlists.map(p => [p.youtubeId, p]));
  const srcVideos = new Map(source.videos.map(v => [v.id, v]));
  const srcPlaylistIds = new Set(source.playlists.map(p => p.id));
  const dstVideos = new Map(destination.videos.map(v => [v.id, v]));
  const dstHistory = new Map(destination.history.map(h => [h.id, h]));
  const playlistMap = new Map<string, string>();
  for (const p of source.playlists) {
    const occupied = dstPlaylistIds.get(p.id);
    if (occupied && occupied.youtubeId !== p.youtubeId) return { ok: false, code: "playlist_id_collision" };
    playlistMap.set(p.id, dstPlaylistYoutube.get(p.youtubeId)?.id ?? p.id);
  }
  if (confirmation && confirmationSeals.get(confirmation) !== canonical(confirmation)) return { ok: false, code: "invalid_confirmation" };
  if (confirmation && (confirmation.revision !== revision || confirmation.sourceSnapshot !== canonical(source) || confirmation.destinationSnapshot !== canonical(destination))) return { ok: false, code: "stale_confirmation" };
  const pairs = new Map<string, LocalVideo>();
  const reserved = new Set<string>();
  for (const pair of confirmation?.pairs ?? []) {
    const s = srcVideos.get(pair.sourceVideoId), d = dstVideos.get(pair.destinationVideoId);
    const occupied = s && dstVideos.get(s.id);
    if (!s || !d || pair.confirmed !== true || typeof pair.externalEvidence !== "string" || !pair.externalEvidence.trim() || pairs.has(s.id) || reserved.has(d.id) || d.playlistId !== playlistMap.get(s.playlistId) || d.youtubeId !== s.youtubeId || (occupied && (occupied.playlistId !== d.playlistId || occupied.youtubeId !== s.youtubeId || occupied.id !== d.id))) return { ok: false, code: "invalid_confirmation" };
    pairs.set(s.id, d); reserved.add(d.id);
  }
  const counts = (): Counts => ({ playlists: 0, videos: 0, history: 0 });
  const report = { created: counts(), identical: counts(), conflicts: [] as Conflict[], omittedOrphans: [] as { id: string; reason: string }[] };
  const creates = { playlists: [] as LocalPlaylist[], videos: [] as LocalVideo[], history: [] as LocalPlayEvent[] };
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const p of source.playlists) {
    const match = dstPlaylistYoutube.get(p.youtubeId);
    if (!match) { creates.playlists.push({ ...p }); report.created.playlists++; }
    else if (equal({ ...p, id: match.id }, match)) report.identical.playlists++;
    else report.conflicts.push({ kind: "playlist", id: p.id, reason: "fields" });
  }
  const positions = new Map<string, Set<number>>();
  const unreserved = new Map<string, Map<string, number>>();
  for (const d of destination.videos) {
    if (!positions.has(d.playlistId)) positions.set(d.playlistId, new Set());
    positions.get(d.playlistId)!.add(d.position);
    if (!reserved.has(d.id)) {
      if (!unreserved.has(d.playlistId)) unreserved.set(d.playlistId, new Map());
      const byYoutube = unreserved.get(d.playlistId)!;
      byYoutube.set(d.youtubeId, (byYoutube.get(d.youtubeId) ?? 0) + 1);
    }
  }
  const videoMap = new Map<string, string>();
  for (const v of source.videos) {
    const playlistId = playlistMap.get(v.playlistId)!;
    const mapped = pairs.get(v.id);
    const existing = dstVideos.get(v.id);
    if (mapped) {
      videoMap.set(v.id, mapped.id);
      if (equal({ ...v, id: mapped.id, playlistId }, mapped)) report.identical.videos++;
      else report.conflicts.push({ kind: "video", id: v.id, reason: "fields" });
    } else if (existing) {
      report.conflicts.push({ kind: "video", id: v.id, reason: existing.playlistId !== playlistId || existing.youtubeId !== v.youtubeId ? "identity" : "ambiguous_occurrence" });
    } else if (positions.get(playlistId)?.has(v.position)) {
      report.conflicts.push({ kind: "video", id: v.id, reason: "position" });
    } else if (unreserved.get(playlistId)?.has(v.youtubeId)) {
      report.conflicts.push({ kind: "video", id: v.id, reason: "ambiguous_occurrence" });
    } else {
      const copy = { ...v, playlistId, ...(v.tags ? { tags: [...v.tags] } : {}) };
      creates.videos.push(copy); report.created.videos++; videoMap.set(v.id, v.id);
      if (!positions.has(playlistId)) positions.set(playlistId, new Set());
      positions.get(playlistId)!.add(v.position);
    }
  }
  for (const h of source.history) {
    const v = srcVideos.get(h.videoId);
    const orphan = !srcPlaylistIds.has(h.playlistId) ? "missing_playlist" : !v ? "missing_video" : v.playlistId !== h.playlistId ? "cross_playlist" : null;
    if (orphan) { report.omittedOrphans.push({ id: h.id, reason: orphan }); continue; }
    const videoId = videoMap.get(h.videoId);
    if (!videoId) { report.conflicts.push({ kind: "history", id: h.id, reason: "unmapped_video" }); continue; }
    const event = { ...h, playlistId: playlistMap.get(h.playlistId)!, videoId };
    const existing = dstHistory.get(h.id);
    if (!existing) { creates.history.push(event); report.created.history++; }
    else if (equal(event, existing)) report.identical.history++;
    else report.conflicts.push({ kind: "history", id: h.id, reason: "fields" });
  }
  const result = { ok: true as const, previewOnly: true as const, revision, creates, report };
  previewSeals.set(result, canonical([result, source, destination, revision, confirmation ?? null]));
  return result;
}

/**
 * Optional, process-local consistency check, not authorization or a commit API.
 * It cannot establish snapshot validity or revision freshness. A future integration
 * needs independent validation and transactional revalidation before writing.
 */
export function validateMergePreview(plan: MergePlan, source: ValidatedTransferSnapshot, destination: ValidatedTransferSnapshot, revision: string, confirmation?: Confirmation): boolean {
  if (!plan.ok || previewSeals.get(plan) !== canonical([plan, source, destination, revision, confirmation ?? null])) return false;
  const fresh = planTransferMerge(source, destination, revision, confirmation);
  return fresh.ok && canonical(fresh) === canonical(plan);
}
