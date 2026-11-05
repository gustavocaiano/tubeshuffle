// Runs on a fresh origin and disposable Chrome profile: node tests/browser/run-playlist-guard.mjs migration
import { initializeStorage } from "../../src/lib/storage";
import fixture from "../../shared/fixtures/transfer-v1.json";

const source = fixture.vectors.merge[0].source;
const report = window.fetch.bind(window);
const stores = ["playlists", "videos", "playHistory"] as const;
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
}
function openLegacy(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tubeshuffler_local", 1);
    request.onupgradeneeded = () => { for (const name of stores) request.result.createObjectStore(name, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function rows(db: IDBDatabase, names: readonly string[] = stores): Promise<unknown[][]> {
  const tx = db.transaction([...names], "readonly"); const finished = done(tx);
  const values = await Promise.all(names.map(name => new Promise<unknown[]>((resolve, reject) => {
    const request = tx.objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  })));
  await finished; return values;
}
function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
}
async function run() {
  const legacy = await openLegacy();
  const seed = legacy.transaction([...stores], "readwrite"); const seeded = done(seed);
  for (const [name, values] of [["playlists", source.playlists], ["videos", source.videos], ["playHistory", source.history]] as const) {
    for (const value of values) seed.objectStore(name).add(value);
  }
  await seeded;
  const legacyBefore = await rows(legacy);
  legacy.close();

  // Observe calls during initialization only; setup and verification deliberately
  // open the legacy database outside this interval.
  const originalOpen = indexedDB.open;
  const originalDelete = indexedDB.deleteDatabase;
  const legacyAccesses: string[] = [];
  indexedDB.open = function(name, version) {
    if (name === "tubeshuffler_local") legacyAccesses.push("open");
    return originalOpen.call(this, name, version);
  };
  indexedDB.deleteDatabase = function(name) {
    if (name === "tubeshuffler_local") legacyAccesses.push("delete");
    return originalDelete.call(this, name);
  };
  let db: IDBDatabase;
  try {
    // Empty current DB must stay empty even when the legacy DB contains data.
    const initialized = await Promise.all(Array.from({ length: 8 }, () => initializeStorage()));
    db = initialized[0];
    equal(await rows(db), [[], [], []], "initialization copied legacy rows into an empty current database");
    equal(legacyAccesses, [], "concurrent initialization accessed the legacy database");

    // Preserve an existing library and unrelated orphan records in every store.
    const tx = db.transaction([...stores], "readwrite"); const written = done(tx);
    tx.objectStore("playlists").add({ ...source.playlists[0], id: "current-playlist", youtubeId: "current-youtube" });
    tx.objectStore("videos").add({ ...source.videos[0], id: "orphan-video", playlistId: "missing-playlist" });
    tx.objectStore("playHistory").add({ ...source.history[0], id: "orphan-history", playlistId: "missing-playlist", videoId: "missing-video" });
    await written;
    const before = await rows(db, [...stores, "meta"]);
    await initializeStorage();
    await Promise.all(Array.from({ length: 8 }, () => initializeStorage()));
    await initializeStorage();
    equal(await rows(db, [...stores, "meta"]), before, "repeated initialization changed current or orphan data");
    equal(legacyAccesses, [], "repeated initialization accessed the legacy database");
    if (localStorage.getItem("tubeshuffle:legacy-migrated")) throw new Error("initialization set a legacy copy marker");
  } finally {
    indexedDB.open = originalOpen;
    indexedDB.deleteDatabase = originalDelete;
  }
  const legacyAfter = await openLegacy();
  try { equal(await rows(legacyAfter), legacyBefore, "legacy database contents changed"); } finally { legacyAfter.close(); }
  db.close();
  return ["empty current database receives no legacy rows", "concurrent and repeated initialization never opens or deletes the legacy database", "current library, orphan records and initialized metadata remain unchanged", "legacy records and copy marker remain unchanged"];
}
run().then(outcomes => report("/result", { method: "POST", body: JSON.stringify({ ok: true, outcomes }) }), error => report("/result", { method: "POST", body: JSON.stringify({ ok: false, error: error instanceof Error ? error.stack : String(error) }) }));
