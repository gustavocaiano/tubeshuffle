import type { Fixture } from './realm';
import type { Guard } from './types';
const guard = (window as unknown as { __storageGuard: Guard }).__storageGuard;
const marker = 'tubeshuffle:legacy-migrated';
const schemaMeta = { key: 'schemaVersion', value: 1 };
const migrated = (value: boolean) => ({ key: 'migratedFromLegacy', value });
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}
async function rejected(action: Promise<unknown>, category?: string): Promise<void> {
  const error = await action.then(() => null, error => error);
  assert(error, 'Expected a rejection');
  if (category) equal(error.category ?? error.name, category, 'Unexpected failure category');
}
async function settled(fixture: Fixture): Promise<void> {
  const deadline = Date.now() + 3000;
  while (fixture.guard.pending()) {
    assert(Date.now() < deadline, 'Native request failed to drain');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Let the coordinator terminal handlers finish in that realm.
  await new Promise(resolve => setTimeout(resolve, 0));
}
async function realm(key: string): Promise<{ api: Fixture; frame: HTMLIFrameElement }> {
  const frame = document.createElement('iframe');
  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve(); frame.onerror = () => reject(new Error('Realm load failed'));
  });
  frame.src = `${guard.config.prefix}/realm/${key}/index.html`;
  document.body.append(frame);
  try {
    await loaded;
    const api = (frame.contentWindow as unknown as { fixture: Fixture }).fixture;
    assert(api?.guard, 'Guard must precede app code in every realm');
    return { api, frame };
  } catch (error) {
    frame.remove();
    throw error;
  }
}
function preserved(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const key of ['playlists', 'videos', 'playHistory', '__schema']) equal(after[key], before[key], `Changed ${key}`);
}
const scenarios: Record<string, (a: Fixture, b: Fixture) => Promise<string>> = {
  async guard(a, b) {
    for (const api of [a, b]) {
      // Exercise each REALM's guarded APIs, not the parent realm's prototypes.
      const checks = api.checkGuards();
      equal(checks, 8, 'Every forbidden operation must throw');
      equal(api.guard.trace.opens, [], 'Negative controls must not reach native open');
      equal([api.guard.trace.denied, api.guard.trace.deletes, api.guard.trace.network], [7, 1, 1], 'Guard controls');
    }
    return 'Both realm guards block production/legacy names, database deletion, unknown storage keys, property writes, clear and fetch before native access.';
  },
  async absent(a, b) {
    await Promise.all([rejected(a.storage.listLocalPlaylists(), 'missing'), rejected(b.storage.listLocalPlaylists(), 'missing')]);
    for (const api of [a, b]) {
      equal(api.storage.getBrowserStorageState().phase, 'missing', 'Real startup reports missing');
      equal(api.guard.trace.transactions, [], 'Missing check must not write meta or expose records');
    }
    await rejected(a.snapshot(), 'AbortError');
    equal(guard.snapshotLocal()[marker], null, 'No legacy marker on missing library');
    return 'Real facade startup in two contexts aborts absent-database creation, reports missing and writes neither metadata nor localStorage. An independent existing-only probe confirms absence.';
  },
  async preserved(a, b) {
    await a.seed([schemaMeta, migrated(true), { key: 'fixture-custom', value: { retained: true } }]);
    const before = await a.snapshot();
    await Promise.all([a.storage.listLocalPlaylists(), b.storage.listLocalPlaylists()]);
    equal(await a.snapshot(), before, 'Existing records and custom meta preserved');
    equal(guard.snapshotLocal()[marker], '1', 'Separate localStorage marker effect');
    assert([a, b].every(api => api.guard.trace.transactions.some(tx => tx.mode === 'readwrite' && tx.stores[0] === 'meta')), 'Both initializers opened readwrite meta');
    return 'Two real initializers preserve seeded v1 records incl. orphan history; each opens meta readwrite; localStorage marker written.';
  },
  async legacy(a) {
    await a.seed([]);
    const before = await a.snapshot();
    localStorage.setItem('playlist-store', 'synthetic-legacy-signal');
    await a.storage.listLocalPlaylists();
    const after = await a.snapshot();
    preserved(before, after);
    equal(after.meta, [migrated(true), schemaMeta], 'Legacy detection metadata');
    equal(guard.snapshotLocal()['playlist-store'], 'synthetic-legacy-signal', 'Legacy source preserved');
    equal(guard.snapshotLocal()[marker], '1', 'Marker written');
    return 'Missing meta initialized from synthetic legacy signal; library/history unchanged; legacy value retained.';
  },
  async 'read-failure'(a) {
    await a.seed([]);
    const before = await a.snapshot();
    a.guard.faults.read = true;
    await rejected(a.storage.listLocalPlaylists(), 'metadata-error');
    a.guard.faults.read = false;
    equal(await a.snapshot(), before, 'Read fault must precede metadata write');
    equal(guard.snapshotLocal()[marker], null, 'No marker');
    return 'INJECTED localStorage read denial rejects real initialization before any metadata write.';
  },
  async 'write-failure'(a) {
    await a.seed([]);
    const before = await a.snapshot();
    localStorage.setItem('playlist-store', 'synthetic-legacy-signal');
    a.guard.faults.write = true;
    await rejected(a.storage.listLocalPlaylists(), 'marker-failed');
    const after = await a.snapshot();
    preserved(before, after);
    equal(after.meta, [migrated(true), schemaMeta], 'IDB commits BEFORE localStorage fails');
    equal(guard.snapshotLocal()[marker], null, 'Marker failed separately');
    a.guard.faults.write = false;
    await rejected(a.storage.listLocalPlaylists(), 'marker-failed');
    await a.storage.recheckBrowserStorage();
    equal(await a.snapshot(), after, 'Explicit retry leaves records unchanged');
    equal(guard.snapshotLocal()[marker], '1', 'Explicit retry writes marker');
    return 'INJECTED localStorage write denial occurs AFTER IDB metadata commit; explicit retry succeeds. Not atomic across stores.';
  },
  async incompatible(a) {
    await a.seed([], true);
    const before = await a.snapshot();
    await rejected(a.storage.listLocalPlaylists(), 'incompatible');
    equal(await a.snapshot(), before, 'Incomplete same-version fixture not repaired');
    return 'Incomplete same-version schema rejected by structural preflight before metadata; no repair.';
  },
  async stale(a, b) {
    await a.seed([schemaMeta, migrated(false)]);
    await a.storage.listLocalPlaylists();
    const generation = a.storage.getBrowserStorageState().generation;
    await b.upgradeWithBlocker(() => { throw new Error('Session should close cooperatively'); });
    equal(b.guard.trace.blocked, 0, 'Application handle closes on versionchange');
    equal(a.storage.getBrowserStorageState().phase, 'recheck-required', 'Old session invalidated');
    await rejected(a.storage.listLocalPlaylists(), 'recheck-required');
    await rejected(a.storage.saveLocalPlaylist({ playlist: a.rows.playlists[0], videos: a.rows.videos }, generation), 'stale');
    await rejected(a.storage.recheckBrowserStorage(), 'incompatible');
    return 'Real session closes on cross-context versionchange, advances generation, blocks old async writes and requires an explicit existing check; synthetic v2 is rejected without migration.';
  },
  async confirm(a, b) {
    await Promise.all([rejected(a.storage.listLocalPlaylists(), 'missing'), rejected(b.storage.listLocalPlaylists(), 'missing')]);
    const first = a.storage.confirmBrowserStorageCreation();
    await rejected(a.storage.confirmBrowserStorageCreation(), 'not-authorized');
    await rejected(a.storage.listLocalPlaylists());
    await Promise.all([first, b.storage.confirmBrowserStorageCreation()]);
    const phases = [a, b].map(api => api.storage.getBrowserStorageState().phase).sort();
    equal(phases, ['ready', 'recheck-required'], 'Concurrent confirmations do not share consent');
    const other = [a, b].find(api => api.storage.getBrowserStorageState().phase === 'recheck-required')!;
    await other.storage.recheckBrowserStorage();
    equal(await Promise.all([a.storage.listLocalPlaylists(), b.storage.listLocalPlaylists()]), [[], []], 'Confirmed empty library');
    equal((await a.snapshot()).meta, [migrated(false), schemaMeta], 'Metadata initialized only after confirmed creation');
    return 'Integrated confirmation in two contexts creates one empty v1 library, rejects double submission, makes the losing context explicitly recheck and initializes metadata only after confirmation.';
  },
  async drain(a, b) {
    await a.seed([schemaMeta, migrated(false)]);
    const before = await a.snapshot();
    const blocker = await a.rawBlocker();
    const cb = b.coordinator(2);
    await rejected(cb.openExisting(), 'blocked');
    equal(cb.getStatus().phase, 'draining', 'Blocked request drains');
    await rejected(cb.confirmCreateOnce(), 'busy');
    blocker.close();
    await settled(b);
    equal(cb.getStatus().recheckRequired, true, 'Explicit recheck required');
    equal(await a.snapshot(), before, 'Late upgrade aborted; original v1 and rows unchanged');
    equal(b.guard.trace.schemaCalls, 0, 'No schema callback during drain');
    return 'INERT coordinator: native blocked/draining across realms, late upgrade aborted after blocker closes; synthetic v1 unchanged.';
  },
  async export(a) {
    await a.seed([]);
    const before = await a.snapshot();
    const result = await a.exportBrowserLibrary();
    assert(result.ok, 'Real export failed');
    equal(result.omittedOrphans, [{ id: 'orphan', reason: 'missing_playlist' }], 'Orphan disclosure result');
    equal(JSON.parse(result.json).history, a.rows.playHistory.slice(0, 1), 'No inferred orphan mapping');
    const after = await a.snapshot();
    preserved(before, after);
    equal(after.meta, [migrated(false), schemaMeta], 'Real export calls metadata initializer');
    return 'Real exporter omits/reports synthetic orphan without rewriting history, initializes meta after schema confirmation; no provenance guarantee.';
  },
  async history(a, b) {
    await a.seed([schemaMeta, migrated(false)], false, [
      ...a.rows.playHistory,
      { ...a.rows.playHistory[0], id: 'repeat' },
      { ...a.rows.playHistory[0], id: 'partial', videoId: 'partial-only', completed: false },
      { ...a.rows.playHistory[0], id: 'unmapped', videoId: 'unmapped-legacy-id' },
      { ...a.rows.playHistory[0], id: 'other-playlist', playlistId: 'p2', videoId: 'other-video' },
    ]);
    const before = await a.snapshot();
    const [first, second] = await Promise.all([
      a.playlistRepository.getCompletedVideoIds('p1'),
      b.playlistRepository.getCompletedVideoIds('p1'),
    ]);
    for (const result of [first, second]) equal([...result].sort(), ['unmapped-legacy-id', 'v1'], 'Existing history lookup semantics');
    equal([...await a.playlistRepository.getCompletedVideoIds('absent')], [], 'No events for absent playlist');
    equal(await a.snapshot(), before, 'History lookup must preserve all rows and schema');
    assert(!('initialize' in a.storage.browserStorage), 'Application facade must not expose initialization handle');
    for (const api of [a, b]) {
      assert(api.guard.trace.transactions.filter(tx => tx.stores.includes('playHistory')).every(tx => tx.mode === 'readonly'), 'History only read');
    }
    return 'Real repository delegates history lookup to facade in two realms; duplicates collapse by stored ID, partial/other-playlist rows excluded, unmapped legacy IDs preserved without continuity inference.';
  },
  async 'history-abort'(a) {
    await a.seed([schemaMeta, migrated(false)]);
    const before = await a.snapshot();
    const fault = a.abortCompletedReadOnce();
    try {
      await rejected(a.playlistRepository.getCompletedVideoIds('p1'));
      assert(fault.observed(), 'Native request succeeded before injected transaction abort');
    } finally { fault.restore(); }
    equal(await a.snapshot(), before, 'Aborted readonly lookup leaves all rows unchanged');
    // User-explicit next read, not an automatic retry of the failed operation.
    equal([...await a.playlistRepository.getCompletedVideoIds('p1')], ['v1'], 'Explicit read after aborted transaction');
    return 'INJECTED native abort after history request success rejects the repository read; no partial success or automatic retry; all rows preserved.';
  },
};
let started = false;
async function run() {
  assert(!started, 'Use a new server run and fresh disposable profile for a repeat');
  started = true;
  const outcomes: { key: string; observation: string; traces: unknown[] }[] = [];
  for (const key of guard.config.cases!) {
    guard.resetLocal();
    localStorage.setItem('fixture-sentinel', 'unchanged');
    const realms: Awaited<ReturnType<typeof realm>>[] = [];
    try {
      // Register each frame immediately so failure loading the second cannot
      // strand the first frame and its handles outside the cleanup list.
      realms.push(await realm(key));
      realms.push(await realm(key));
      const [a, b] = realms.map(realm => realm.api);
      const observation = await scenarios[key](a, b);
      const expectedLocal: Record<string, string | null> = Object.fromEntries(guard.keys.map(key => [key, null]));
      expectedLocal['fixture-sentinel'] = 'unchanged';
      if (['preserved', 'legacy', 'write-failure'].includes(key)) expectedLocal[marker] = '1';
      if (['legacy', 'write-failure'].includes(key)) expectedLocal['playlist-store'] = 'synthetic-legacy-signal';
      equal(guard.snapshotLocal(), expectedLocal, 'Unexpected localStorage effect');
      for (const api of [a, b]) {
        await settled(api);
        equal([api.guard.trace.denied, api.guard.trace.deletes, api.guard.trace.network], key === 'guard' ? [7, 1, 1] : [0, 0, 0], 'Unexpected access');
      }
      outcomes.push({ key, observation, traces: [a.guard.trace, b.guard.trace] });
    } catch (error) {
      return { ok: false, key, error: error instanceof Error ? error.message : 'Unknown failure', outcomes };
    } finally {
      for (const { api, frame } of realms) { api.guard.close(); frame.remove(); }
    }
  }
  equal([guard.trace.denied, guard.trace.deletes, guard.trace.network], [0, 0, 0], 'Root guard');
  return { ok: true, outcomes, build: guard.config.evidence,
    environment: navigator.userAgent, contexts: 'Two guarded same-origin iframes per scenario; not independent processes or Safari',
    limits: 'Disposable synthetic data only. Exercises the integrated production source graph with a test-only target substitution. No real-library, durability, Safari, or release claim. No OS network firewall.' };
}
(window as unknown as { runStorageIntegration: typeof run }).runStorageIntegration = run;
