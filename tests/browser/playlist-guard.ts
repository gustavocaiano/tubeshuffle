// Run with: node tests/browser/run-playlist-guard.mjs
// This module runs only on the runner's fresh, disposable localhost origin.
import { initializeStorage, saveLocalPlaylist, recordLocalPlayEvent } from "../../src/lib/storage";
import { exportTransferFromTestDatabase } from "../../src/lib/transfer/export";
import { playlistRepository } from "../../src/stores/playlist-store";
import fixture from "../../shared/fixtures/transfer-v1.json";

const at = "2026-10-28T00:00:00.000Z";
const input = structuredClone(fixture.vectors.merge[0].source);
const bundle = { playlist: input.playlists[0], videos: input.videos };
const originalFetch = window.fetch.bind(window);
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function rejects(operation: Promise<unknown>, label: string) {
  try { await operation; } catch (error) {
    assert(error instanceof Error && error.message.includes("temporarily blocked"), `${label}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}
async function rejectsWith(operation: Promise<unknown>, expected: string) {
  try { await operation; } catch (error) {
    assert(error instanceof Error && error.message.includes(expected), `expected ${expected}: ${String(error)}`);
    return;
  }
  throw new Error(`expected rejection: ${expected}`);
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("aborted"));
  });
}
function openSecond(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tubeshuffle_local", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function snapshot(db: IDBDatabase) {
  const tx = db.transaction(["playlists", "videos", "playHistory"], "readonly");
  const done = completed(tx);
  const requests = ["playlists", "videos", "playHistory"].map(name => tx.objectStore(name).getAll());
  const rows = await Promise.all(requests.map(request => new Promise<unknown[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  })));
  await done;
  return rows;
}

async function run() {
  const outcomes: string[] = [];
  const db = await initializeStorage();
  await saveLocalPlaylist(bundle);
  for (const event of input.history) await recordLocalPlayEvent(event);
  const before = await snapshot(db);
  const exported = await exportTransferFromTestDatabase(db, at);
  assert(exported.ok, "baseline export failed");
  await rejects(saveLocalPlaylist({ playlist: { ...bundle.playlist, youtubeId: "different-youtube", title: "changed" }, videos: [] }), "local ID");
  equal(await snapshot(db), before, "local ID preserved all records");
  await rejects(saveLocalPlaylist({ playlist: { ...bundle.playlist, id: "different-local", title: "changed" }, videos: [] }), "YouTube ID");
  equal(await snapshot(db), before, "YouTube ID preserved all records");
  equal(await exportTransferFromTestDatabase(db, at), exported, "export unchanged after both rejections");
  outcomes.push("local ID and YouTube ID rejection preserve all records and export");

  const newPlaylist = { ...bundle.playlist, id: "new-local", youtubeId: "new-youtube" };
  const newVideos = bundle.videos.map((v, i) => ({ ...v, id: `new-video-${i}`, playlistId: newPlaylist.id }));
  await saveLocalPlaylist({ playlist: newPlaylist, videos: newVideos });
  const afterNew = await snapshot(db);
  assert((afterNew[0] as { id: string }[]).some(p => p.id === newPlaylist.id), "new playlist not committed");
  equal((afterNew[1] as { playlistId: string }[]).filter(v => v.playlistId === newPlaylist.id), newVideos, "new videos committed");
  equal(afterNew[2], before[2], "new import preserves history");
  outcomes.push("new playlist and videos committed");

  const collisionBase = { ...bundle.playlist, id: "collision-playlist", youtubeId: "collision-youtube" };
  const collisionVideo = { ...bundle.videos[0], id: "collision-video", playlistId: collisionBase.id };
  const untouched = await snapshot(db);
  await rejectsWith(saveLocalPlaylist({ playlist: collisionBase, videos: [{ ...collisionVideo, id: bundle.videos[0].id }] }), "collides");
  await rejectsWith(saveLocalPlaylist({ playlist: collisionBase, videos: [collisionVideo, collisionVideo] }), "duplicate video identity");
  await rejectsWith(saveLocalPlaylist({ playlist: collisionBase, videos: [{ ...collisionVideo, playlistId: "wrong" }] }), "invalid or duplicate");
  equal(await snapshot(db), untouched, "collision and invalid input leave database untouched");
  for (const [store, record, candidate] of [
    ["videos", { ...collisionVideo, id: "orphan", playlistId: "orphan-playlist" }, { ...collisionBase, id: "orphan-playlist", youtubeId: "orphan-youtube" }],
    ["playHistory", { ...input.history[0], id: "orphan-event", playlistId: "history-orphan", videoId: "history-video" }, { ...collisionBase, id: "history-orphan", youtubeId: "history-youtube" }],
    ["playHistory", { ...input.history[0], id: "video-event", playlistId: "other-playlist", videoId: "history-video-collision" }, { ...collisionBase, id: "video-history", youtubeId: "video-history-youtube" }],
  ] as const) {
    const tx = db.transaction(store, "readwrite"); const done = completed(tx);
    tx.objectStore(store).add(record); await done;
    const prior = await snapshot(db);
    await rejectsWith(saveLocalPlaylist({ playlist: candidate, videos: [{ ...collisionVideo, id: store === "playHistory" && candidate.id === "video-history" ? "history-video-collision" : `candidate-${candidate.id}`, playlistId: candidate.id }] }), "collides");
    equal(await snapshot(db), prior, `orphan protection ${candidate.id}`);
  }
  outcomes.push("video ID collisions, duplicate IDs, wrong ownership and orphan video/history rejected without writes");

  const raceBundle = { playlist: { ...bundle.playlist, id: "concurrent-save", youtubeId: "concurrent-youtube" }, videos: [] };
  const concurrent = await Promise.allSettled([saveLocalPlaylist(raceBundle), saveLocalPlaylist(raceBundle)]);
  equal(concurrent.map(result => result.status).sort(), ["fulfilled", "rejected"], "concurrent saves one winner");
  outcomes.push("concurrent saves serialize to one winner");

  // A separate connection holds the competing write lock until it commits. The
  // guard must see its insert, rather than checking before that transaction.
  const second = await openSecond();
  try {
    const competing = { ...bundle.playlist, id: "race-winner", youtubeId: "race-youtube" };
    const writer = second.transaction(["playlists", "videos"], "readwrite");
    const writerDone = completed(writer);
    writer.objectStore("playlists").put(competing);
    const loser = saveLocalPlaylist({ playlist: { ...competing, id: "race-loser" }, videos: [] });
    await writerDone;
    await rejects(loser, "serialized race");
    const races = (await snapshot(db))[0] as { id: string; youtubeId: string }[];
    equal(races.filter(p => p.youtubeId === "race-youtube").map(p => p.id), ["race-winner"], "race winner only");
    outcomes.push("separate connection write serialized before guard");
  } finally { second.close(); }

  // An uncloneable video throws after playlist.put has been queued. This tests
  // rollback of an actual native transaction, not a simulated rejected call.
  const beforeAbort = await snapshot(db);
  const broken = { ...bundle.playlist, id: "abort-local", youtubeId: "abort-youtube" };
  let rejected = false;
  try {
    await saveLocalPlaylist({ playlist: broken, videos: [{ ...bundle.videos[0], id: "abort-video", playlistId: broken.id, title: (() => {}) as unknown as string }] });
  } catch { rejected = true; }
  assert(rejected, "uncloneable video did not reject");
  equal(await snapshot(db), beforeAbort, "aborted queued playlist write rolled back");
  outcomes.push("native transaction abort rolls back queued playlist write");

  let fetches = 0;
  window.fetch = async () => { fetches++; return new Response(JSON.stringify({ id: "PLrepeatedentries", title: "repeated", description: "", thumbnail: "", channelTitle: "channel", videos: [{ id: "same-video", title: "one", channelTitle: "channel", thumbnail: "", duration: 1 }, { id: "same-video", title: "two", channelTitle: "channel", thumbnail: "", duration: 1 }] }), { status: 200, headers: { "Content-Type": "application/json" } }); };
  try {
    const beforeRepo = await snapshot(db);
    await rejects(playlistRepository.importPlaylistFromUrl(`https://www.youtube.com/playlist?list=${bundle.playlist.youtubeId}`), "repository import");
    await rejects(playlistRepository.syncPlaylist(bundle.playlist.id), "repository sync");
    equal(fetches, 0, "known import and sync block before network");
    equal(await snapshot(db), beforeRepo, "repository failures preserve all records");
    const repeated = await playlistRepository.importPlaylistFromUrl("https://www.youtube.com/playlist?list=PLrepeatedentries");
    equal(fetches, 1, "new import fetches once");
    assert(repeated.videos.length === 2 && repeated.videos[0].id !== repeated.videos[1].id && repeated.videos.every(v => v.youtubeId === "same-video"), "repeated entries must have distinct local IDs");
    equal((await snapshot(db))[1].filter((v: unknown) => (v as { playlistId: string }).playlistId === repeated.playlist.id).length, 2, "repeated entries persisted");
    outcomes.push("known import and sync block before network; repeated YouTube entries persist with distinct IDs");
  } finally { window.fetch = originalFetch; }
  db.close();
  return outcomes;
}

run().then(
  outcomes => originalFetch("/result", { method: "POST", body: JSON.stringify({ ok: true, outcomes }) }),
  error => originalFetch("/result", { method: "POST", body: JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }) }),
);
