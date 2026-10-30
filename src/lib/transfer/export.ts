import { readTransferSnapshot } from "@/lib/storage";

export type TransferSnapshot = { playlists: unknown[]; videos: unknown[]; history: unknown[] };
export type Diagnostic = { kind: string; id: string; reason: string };
export type ExportResult =
  | { ok: false; diagnostics: Diagnostic[]; omittedDiagnostics: number; requiredBytes?: number }
  | { ok: true; json: string; omittedOrphans: { id: string; reason: string }[]; warnings: string[] };

const MAX_BYTES = 10_485_760;
const MAX_DIAGNOSTICS = 100;
const optional = new Set(["viewCount", "likeCount", "description", "categoryId", "tags", "publishedAt"]);
const keys = {
  playlist: ["id", "youtubeId", "title", "description", "thumbnail", "channelTitle", "videoCount", "createdAt", "updatedAt"],
  video: ["id", "playlistId", "youtubeId", "title", "channelTitle", "thumbnail", "duration", "position", ...optional],
  history: ["id", "playlistId", "videoId", "watchedAt", "watchedSeconds", "completed"],
} as const;
type Kind = keyof typeof keys;
type Row = Record<string, unknown>;

// Stop as soon as the scalar limit is exceeded; do not allocate a scalar array.
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length > max * 2) return false;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (++count > max) return false;
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function id(value: unknown): boolean {
  return text(value, 200) && value.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function seconds(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 864000;
}

/** Strict RFC3339 legacy instant, with lossless millisecond UTC conversion. */
function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Fractional zeros beyond milliseconds are legal; scan without copying them.
  const zoneStart = value.endsWith("Z") ? value.length - 1 : value.length - 6;
  if (zoneStart < 19) return null;
  let fraction = "";
  if (zoneStart > 19) {
    if (value[19] !== "." || zoneStart === 20) return null;
    for (let i = 20; i < zoneStart; i++) {
      const c = value.charCodeAt(i);
      if (c < 48 || c > 57 || (i >= 23 && c !== 48)) return null;
      if (i < 23) fraction += value[i];
    }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(value.slice(0, 19) + value.slice(zoneStart));
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, zone] = m;
  const y = +ys, mo = +mos, d = +ds, h = +hs, mi = +mis, s = +ss;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!y || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || mi > 59 || s > 59 || /[1-9]/.test(fraction.slice(3))) return null;
  let offset = 0;
  if (zone !== "Z") {
    const oh = +zone.slice(1, 3), om = +zone.slice(4, 6);
    if (oh > 23 || om > 59) return null;
    offset = (oh * 60 + om) * (zone[0] === "+" ? 1 : -1);
  }
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, +(fraction.slice(0, 3).padEnd(3, "0")));
  date.setTime(date.getTime() - offset * 60000);
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? date.toISOString() : null;
}

function order(a: Diagnostic, b: Diagnostic): number {
  // Code point comparison, not locale or UTF-16 code-unit ordering.
  const cmp = (x: string, y: string) => {
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      const a = x.codePointAt(i)!, b = y.codePointAt(j)!;
      if (a !== b) return a - b;
      i += a > 0xffff ? 2 : 1; j += b > 0xffff ? 2 : 1;
    }
    return (x.length - i) - (y.length - j);
  };
  return cmp(a.kind, b.kind) || cmp(a.id, b.id) || cmp(a.reason, b.reason);
}

/** Retain the smallest diagnostics regardless of cursor order, with bounded memory. */
function diagnosticBuffer() {
  const items: Diagnostic[] = [];
  let total = 0;
  function add(item: Diagnostic) {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
    let lo = 0, hi = items.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (order(items[mid], item) <= 0) lo = mid + 1; else hi = mid; }
    if (lo < MAX_DIAGNOSTICS) {
      items.splice(lo, 0, item);
      if (items.length > MAX_DIAGNOSTICS) items.pop();
    }
  }
  return { add, get total() { return total; }, result: () => ({ diagnostics: items, omittedDiagnostics: total - items.length }) };
}

/** Incremental accumulator shared by the pure encoder and the IndexedDB cursor. */
function accumulator(exportedAt: string) {
  const diagnostics = diagnosticBuffer();
  const references = diagnosticBuffer();
  const add = (kind: string, recordId: string, reason: string) => diagnostics.add({ kind, id: recordId, reason });
  const limits = { playlist: 5000, video: 50000, history: 100000 };
  const counts = { playlist: 0, video: 0, history: 0 };
  const emitted = { playlist: 0, video: 0, history: 0 };
  const playlistIds = new Set<unknown>(), youtubeIds = new Set<unknown>(), videoIds = new Set<unknown>(), historyIds = new Set<unknown>();
  const videoById = new Map<unknown, unknown>();
  const positions = new Map<unknown, Set<unknown>>();
  const omittedOrphans: { id: string; reason: string }[] = [];
  let bytes = 0;
  let chunks: string[] = [];
  const append = (chunk: string) => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (c < 0x80) bytes++;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < chunk.length && chunk.charCodeAt(i + 1) >= 0xdc00 && chunk.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    }
    if (bytes <= MAX_BYTES) chunks.push(chunk); else chunks = [];
  };
  const normalizedAt = timestamp(exportedAt);
  append(`{"format":"tubeshuffle-transfer","version":1,"exportedAt":${JSON.stringify(normalizedAt)},"playlists":[`);
  function convert(kind: Kind, input: unknown): Row {
    const row: Row = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      add(kind, "", "invalid_record"); return row;
    }
    const source = input as Row;
    const recordId = id(source.id) ? source.id as string : "";
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      if (kind === "video" && optional.has(key) && source[key] === undefined) continue;
      if (!(keys[kind] as readonly string[]).includes(key)) {
        add(kind, recordId, `unknown_field:${text(key, 200) ? key : "<redacted>"}`);
      } else row[key] = source[key];
    }
    const check = (key: string, valid: boolean) => { if (!valid) add(kind, recordId, `invalid_field:${key}`); };
    for (const key of keys[kind]) {
      if (kind === "video" && optional.has(key) && !Object.hasOwn(row, key)) continue;
      const v = row[key];
      if (["createdAt", "updatedAt", "publishedAt", "watchedAt"].includes(key)) {
        const normalized = timestamp(v);
        if (normalized === null) add(kind, recordId, `unrepresentable_timestamp:${key}`); else row[key] = normalized;
      } else if (["id", "playlistId", "videoId"].includes(key)) check(key, id(v));
      else if (key === "youtubeId") check(key, typeof v === "string" && v.length <= 80 && (kind === "playlist" ? /^[A-Za-z0-9_-]{10,80}$/ : /^[A-Za-z0-9_-]{1,80}$/).test(v));
      else if (key === "videoCount") check(key, integer(v, 1000000));
      else if (["position", "viewCount", "likeCount"].includes(key)) check(key, integer(v));
      else if (["duration", "watchedSeconds"].includes(key)) check(key, seconds(v));
      else if (key === "completed") check(key, typeof v === "boolean");
      else if (key === "tags") check(key, Array.isArray(v) && v.length <= 100 && Array.from(v).every(t => text(t, 200)));
      else if (kind === "playlist" && ["description", "thumbnail", "channelTitle"].includes(key)) check(key, v === null || text(v, 10000));
      else check(key, text(v, kind === "playlist" && key === "title" ? 1000 : 10000));
    }
    return row;
  }

  function accept(kind: Kind, input: unknown) {
    if (++counts[kind] > limits[kind]) {
      if (counts[kind] === limits[kind] + 1) add(kind, "", `count_limit_${limits[kind]}`);
      return false;
    }
    const before = diagnostics.total;
    const row = convert(kind, input);
    const recordId = id(row.id) ? row.id as string : "";
    const unique = (set: Set<unknown>, value: unknown, key: string) => {
      if (set.has(value)) add(kind, recordId, `duplicate:${key}`);
      set.add(value);
    };
    // Index each individually valid identity even when another field is invalid.
    if (kind === "playlist") {
      if (id(row.id)) unique(playlistIds, row.id, "id");
      if (typeof row.youtubeId === "string" && /^[A-Za-z0-9_-]{10,80}$/.test(row.youtubeId)) unique(youtubeIds, row.youtubeId, "youtubeId");
    } else if (kind === "video") {
      if (id(row.id)) unique(videoIds, row.id, "id");
      if (id(row.playlistId) && integer(row.position)) {
        const set = positions.get(row.playlistId) ?? new Set();
        unique(set, row.position, "position"); positions.set(row.playlistId, set);
      }
      if (id(row.id) && id(row.playlistId)) videoById.set(row.id, row.playlistId);
    } else {
      if (id(row.id)) unique(historyIds, row.id, "id");
    }
    if (diagnostics.total !== before) return true;
    if (kind === "video") {
      if (!playlistIds.has(row.playlistId)) references.add({ kind, id: recordId, reason: "missing_playlist" });
    } else if (kind === "history") {
      const reason = !playlistIds.has(row.playlistId) ? "missing_playlist" : !videoById.has(row.videoId) ? "missing_video" : videoById.get(row.videoId) !== row.playlistId ? "cross_playlist" : null;
      if (reason) { omittedOrphans.push({ id: recordId, reason }); return true; }
    }
    if (emitted[kind]++) append(",");
    append(JSON.stringify(row));
    return true;
  }
  function next(kind: Kind) { append(kind === "video" ? '],"videos":[' : '],"history":['); }
  function finish(): ExportResult {
    append("]}");
    if (!normalizedAt) return { ok: false, diagnostics: [{ kind: "envelope", id: "", reason: "unrepresentable_timestamp:exportedAt" }], omittedDiagnostics: 0 };
    if (diagnostics.total) return { ok: false, ...diagnostics.result() };
    if (references.total) return { ok: false, ...references.result() };
    if (bytes > MAX_BYTES) return { ok: false, diagnostics: [{ kind: "file", id: "", reason: "file_too_large" }], omittedDiagnostics: 0, requiredBytes: bytes };
    return { ok: true, json: chunks.join(""), omittedOrphans, warnings: ["occurrences_unrecoverable: Earlier duplicate occurrences may have been overwritten in browser storage and cannot be recovered or reliably detected."] };
  }
  return { accept, next, finish };
}

/** Pure encoder using the same bounded incremental processing as the cursor. */
export function encodeTransferSnapshot(snapshot: TransferSnapshot, exportedAt = new Date().toISOString()): ExportResult {
  const acc = accumulator(exportedAt);
  const arrays = [snapshot.playlists, snapshot.videos, snapshot.history];
  const names: Kind[] = ["playlist", "video", "history"];
  for (let i = 0; i < arrays.length; i++) {
    if (i) acc.next(names[i]);
    if (!Array.isArray(arrays[i])) { acc.accept(names[i], undefined); continue; }
    const limit = [5000, 50000, 100000][i];
    for (let j = 0; j < Math.min(arrays[i].length, limit + 1); j++) acc.accept(names[i], arrays[i][j]);
  }
  return acc.finish();
}

/** Does not enable transfer UI; the destructive refresh integration gate remains open. */
export async function exportBrowserLibrary(): Promise<ExportResult> {
  const acc = accumulator(new Date().toISOString());
  await readTransferSnapshot((kind, value) => acc.accept(kind, value), kind => acc.next(kind));
  return acc.finish();
}

/** Test-only entry point: caller supplies a disposable database, never production storage. */
export async function exportTransferFromTestDatabase(db: IDBDatabase, exportedAt = new Date().toISOString()): Promise<ExportResult> {
  const acc = accumulator(exportedAt);
  await readTransferSnapshot((kind, value) => acc.accept(kind, value), kind => acc.next(kind), db);
  return acc.finish();
}
