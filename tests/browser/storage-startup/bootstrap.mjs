// Executed by a blocking script before any application bundle in EVERY realm.
// CSP blocks workers and external traffic; these guards are not an OS firewall.
export function bootstrap(names, config) {
  return `(${install.toString()})(${JSON.stringify(names)}, ${JSON.stringify(config)});`;
}
function install(names, config) {
  const allowed = new Set(names);
  if (allowed.size !== names.length || names.some(name => !/^tubeshuffle-startup-test-[a-f0-9-]{36}$/.test(name))) {
    throw new Error('Invalid fixture allowlist');
  }
  const keys = ['tubeshuffle:legacy-migrated', 'tubeshuffler:legacy-migrated', 'playlist-store',
    'tubeshuffle-playlists', 'tubeshuffler-playlists', 'tubeshuffler:playlists', 'tubeshuffle:playlists',
    'fixture-sentinel'];
  const allowedKeys = new Set(keys);
  const trace = { opens: [], upgrades: [], transactions: [], local: [], blocked: 0,
    denied: 0, deletes: 0, network: 0, schemaCalls: 0 };
  const faults = { read: false, write: false };
  const handles = new Set();
  const requests = new Set();
  const storage = window.localStorage;
  const storageMethods = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'key', 'clear'].map(key => [key, Storage.prototype[key]]));
  // Refuse a previously occupied origin, without reading any stored values.
  if (config.root && storage.length !== 0) throw new Error('Origin is not empty; choose a fresh disposable profile');
  function deny() { trace.denied++; throw new Error('Fixture guard denied access'); }
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    Storage.prototype[method] = function(key, ...args) {
      if (this !== storage || !allowedKeys.has(key)) return deny();
      trace.local.push({ method, key });
      if ((method === 'getItem' && faults.read) || (method === 'setItem' && faults.write)) {
        throw new DOMException('Injected fixture storage failure', 'SecurityError');
      }
      return storageMethods[method].call(this, key, ...args);
    };
  }
  Storage.prototype.clear = deny;
  Storage.prototype.key = deny;
  // Also guard property-style access. Prototype methods above cover native calls.
  const wrapped = new Proxy(storage, {
    get(target, key) {
      if (['getItem', 'setItem', 'removeItem', 'key', 'clear'].includes(key)) return target[key].bind(target);
      if (key === 'length') return target.length;
      if (typeof key === 'string' && allowedKeys.has(key)) return target.getItem(key);
      return deny();
    },
    set(target, key, value) { target.setItem(key, value); return true; },
    deleteProperty(target, key) { target.removeItem(key); return true; },
    defineProperty: deny,
  });
  Object.defineProperty(window, 'localStorage', { value: wrapped, configurable: false });
  const nativeOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function(name, version) {
    if (!allowed.has(name) || ![1, 2].includes(version)) return deny();
    trace.opens.push({ name, version });
    const request = nativeOpen.call(this, name, version);
    requests.add(request);
    request.addEventListener('upgradeneeded', event => trace.upgrades.push({ old: event.oldVersion, next: event.newVersion }));
    request.addEventListener('blocked', () => trace.blocked++);
    request.addEventListener('success', () => { handles.add(request.result); requests.delete(request); });
    request.addEventListener('error', () => requests.delete(request));
    return request;
  };
  IDBFactory.prototype.deleteDatabase = function() { trace.deletes++; return deny(); };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(stores, mode, options) {
    if (!allowed.has(this.name)) return deny();
    trace.transactions.push({ stores: typeof stores === 'string' ? [stores] : [...stores], mode: mode ?? 'readonly' });
    return transaction.call(this, stores, mode, options);
  };
  function noNetwork() { trace.network++; throw new Error('Fixture network denied'); }
  window.fetch = noNetwork;
  XMLHttpRequest.prototype.open = noNetwork;
  for (const key of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    if (key in window) window[key] = noNetwork;
  }
  navigator.sendBeacon = noNetwork;
  if (navigator.serviceWorker) navigator.serviceWorker.register = noNetwork;
  window.open = deny;
  Object.defineProperty(window, '__storageGuard', { value: {
    config, names, keys, trace, faults,
    negativeControls: [
      () => indexedDB.open('tubeshuffle_local', 1),
      () => IDBFactory.prototype.open.call(indexedDB, 'tubeshuffler_local', 1),
      () => indexedDB.deleteDatabase(names[0]),
      () => localStorage.getItem('unapproved-key'),
      () => localStorage.setItem('unapproved-key', 'blocked'),
      () => { localStorage['unapproved-key'] = 'blocked'; },
      () => localStorage.clear(),
      () => fetch('https://example.invalid/blocked'),
    ],
    pending: () => requests.size,
    close: () => { for (const db of handles) db.close(); },
    snapshotLocal: () => Object.fromEntries(keys.map(key => [key, storageMethods.getItem.call(storage, key)])),
    resetLocal: () => { for (const key of keys) storage.removeItem(key); },
  } });
}
