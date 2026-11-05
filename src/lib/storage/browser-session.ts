import { DB_NAME, DB_VERSION, createBrowserSchema, isIndexedDbAvailable, validateBrowserSchema } from './browser-db';
import { BrowserProvisioningError, createBrowserProvisioning, type ProvisioningPhase } from './browser-provisioning';
import { ensureStorageMigrationMeta, persistLegacyMigrationSignal, StorageMetadataError } from './storage-migrations';

export type StoragePhase = ProvisioningPhase | 'ready' | 'initializing' | 'metadata-error' | 'marker-failed' | 'unavailable';
export interface BrowserStorageState {
  readonly phase: StoragePhase;
  readonly generation: number;
  readonly eligibleForConfirmation: boolean;
}
const initial: BrowserStorageState = Object.freeze({ phase: 'unknown', generation: 0, eligibleForConfirmation: false });
let state = initial;
const listeners = new Set<() => void>();
const active = new Set<IDBTransaction>();
interface StorageLease { db: IDBDatabase; generation: number }
let lease: StorageLease | null = null;
let pending: Promise<StorageLease> | null = null;
let blockedUntilRecheck = false;
let controlBusy = false;

export class BrowserStorageError extends Error {
  constructor(readonly category: string) {
    super(category === 'stale'
      ? 'Storage changed while this operation was running. No automatic retry was made; a write may already have finished.'
      : 'Local storage could not be confirmed. Keep this browser profile and its site data.');
    this.name = 'BrowserStorageError';
  }
}
function publish(phase: StoragePhase, eligibleForConfirmation = false): void {
  if (state.phase === phase && state.eligibleForConfirmation === eligibleForConfirmation) return;
  state = Object.freeze({ phase, generation: state.generation, eligibleForConfirmation });
  for (const listener of listeners) listener();
}
function invalidate(phase: StoragePhase): void {
  blockedUntilRecheck = true;
  lease = null; pending = null;
  state = Object.freeze({ phase, generation: state.generation + 1, eligibleForConfirmation: false });
  for (const tx of active) { try { tx.abort(); } catch { /* May already have committed. Never replay. */ } }
  for (const listener of listeners) listener();
}
function reflectCoordinator(): void {
  if (lease || pending || controlBusy || ['metadata-error', 'marker-failed', 'recheck-required'].includes(state.phase)) return;
  const status = coordinator.getStatus();
  publish(status.phase, status.eligibleForConfirmation);
}
const coordinator = createBrowserProvisioning({ name: DB_NAME, version: DB_VERSION }, () => {
  const request = window.indexedDB.open(DB_NAME, DB_VERSION);
  // Read status after the coordinator's handlers have processed each native event.
  for (const name of ['blocked', 'error', 'success', 'upgradeneeded']) {
    request.addEventListener(name, () => queueMicrotask(reflectCoordinator));
  }
  return request;
}, validateBrowserSchema, createBrowserSchema);

export const getBrowserStorageState = (): BrowserStorageState => state;
export const getServerStorageState = (): BrowserStorageState => initial;
export function subscribeBrowserStorage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function initialize(existing: Promise<IDBDatabase>, generation: number): Promise<StorageLease> {
  try {
    const db = await existing;
    if (generation !== state.generation) throw new BrowserStorageError('stale');
    const invalidateHandle = (phase: StoragePhase) => {
      if (generation === state.generation) invalidate(phase);
    };
    db.addEventListener('versionchange', () => invalidateHandle('recheck-required'));
    db.addEventListener('close', () => invalidateHandle('indeterminate'));
    publish('initializing');
    await ensureStorageMigrationMeta(db, {
      transaction(tx) {
        active.add(tx);
        for (const event of ['complete', 'abort']) tx.addEventListener(event, () => active.delete(tx), { once: true });
      },
      beforeMarker() { if (generation !== state.generation) throw new BrowserStorageError('stale'); },
    });
    if (generation !== state.generation) throw new BrowserStorageError('stale');
    lease = { db, generation };
    publish('ready');
    return lease;
  } catch (error) {
    if (generation === state.generation) {
      if (error instanceof StorageMetadataError) {
        blockedUntilRecheck = true;
        publish(error.stage === 'marker' ? 'marker-failed' : 'metadata-error');
      } else if (error instanceof BrowserProvisioningError) {
        const status = coordinator.getStatus();
        blockedUntilRecheck = true;
        publish(status.phase === 'unknown' ? 'recheck-required' : status.phase, status.eligibleForConfirmation);
      } else {
        blockedUntilRecheck = true;
        publish('indeterminate');
      }
    }
    throw error instanceof BrowserProvisioningError || error instanceof BrowserStorageError
      ? error : new BrowserStorageError(state.phase);
  } finally {
    if (generation === state.generation) pending = null;
  }
}

export function acquireBrowserStorage(expectedGeneration = state.generation): Promise<StorageLease> {
  if (expectedGeneration !== state.generation) return Promise.reject(new BrowserStorageError('stale'));
  if (!isIndexedDbAvailable()) { publish('unavailable'); return Promise.reject(new BrowserStorageError('unavailable')); }
  if (controlBusy || blockedUntilRecheck) return Promise.reject(new BrowserStorageError(state.phase));
  if (lease) return Promise.resolve(lease);
  if (pending) return pending;
  const existing = coordinator.openExisting();
  pending = initialize(existing, state.generation);
  publish(coordinator.getStatus().phase);
  return pending;
}

export async function recheckBrowserStorage(): Promise<void> {
  if (controlBusy || pending || state.phase === 'draining' || state.phase === 'indeterminate') throw new BrowserStorageError('busy');
  controlBusy = true;
  invalidate('checking');
  blockedUntilRecheck = false;
  try {
    pending = initialize(coordinator.checkExistingAgain(), state.generation);
    await pending;
  } finally { controlBusy = false; reflectCoordinator(); }
}

export async function confirmBrowserStorageCreation(): Promise<void> {
  if (controlBusy || pending || !state.eligibleForConfirmation) throw new BrowserStorageError('not-authorized');
  controlBusy = true;
  invalidate('creating');
  try {
    const outcome = await coordinator.confirmCreateOnce();
    blockedUntilRecheck = false;
    if (outcome === 'existing-found') { publish('recheck-required'); blockedUntilRecheck = true; return; }
    // Creation itself is validated by the coordinator; now use a separate existing check.
    pending = initialize(coordinator.checkExistingAgain(), state.generation);
    await pending;
  } catch (error) {
    reflectAfterControlError(error);
    throw error;
  } finally { controlBusy = false; reflectCoordinator(); }
}
function reflectAfterControlError(error: unknown): void {
  if (error instanceof BrowserProvisioningError) {
    const status = coordinator.getStatus();
    publish(status.phase === 'unknown' ? 'recheck-required' : status.phase, status.eligibleForConfirmation);
  }
}

/** IndexedDB and localStorage cannot commit atomically. Preserve committed metadata on marker failure. */
export function finishLegacyMigrationMarker(expectedGeneration: number): void {
  if (expectedGeneration !== state.generation || state.phase !== 'ready') throw new BrowserStorageError('stale');
  try { persistLegacyMigrationSignal(); }
  catch { invalidate('marker-failed'); throw new BrowserStorageError('marker-failed'); }
}

/** Internal facade transaction boundary. Capture epoch at invocation, before any await. */
export async function beginStorageTransaction(stores: string | string[], mode: IDBTransactionMode = 'readonly', expectedGeneration = state.generation) {
  const current = await acquireBrowserStorage(expectedGeneration);
  if (current.generation !== state.generation || state.phase !== 'ready') throw new BrowserStorageError('stale');
  let transaction: IDBTransaction;
  try { transaction = current.db.transaction(stores, mode); }
  catch { invalidate('indeterminate'); throw new BrowserStorageError('indeterminate'); }
  active.add(transaction);
  const done = new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      active.delete(transaction);
      if (current.generation !== state.generation) reject(new BrowserStorageError('stale'));
      else resolve();
    });
    transaction.addEventListener('abort', () => {
      active.delete(transaction);
      reject(new BrowserStorageError(current.generation !== state.generation ? 'stale' : 'aborted'));
    });
  });
  void done.catch(() => {});
  return { transaction, done };
}
