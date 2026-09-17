import { inputHash, parseWorkspace, serializeWorkspace } from './WorkspaceState.ts';
import type { WorkspaceState } from './WorkspaceState.ts';

export interface StoredWorkspace { generation: number; json: string }
export interface AtomicStorage {
  read(key: string): Promise<StoredWorkspace | null>;
  compareAndSwap(key: string, expectedGeneration: number | null, json: string): Promise<number>;
  lastProjectId?(): Promise<string | null>;
}
export class StorageConflict extends Error { override name = 'StorageConflict'; }

/** Each save is one IndexedDB transaction, including the comparison with another tab's save. */
export class IndexedDbStorage implements AtomicStorage {
  #database: Promise<IDBDatabase>;
  constructor(name = 'spatial-previs-r0') {
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('workspaces'); };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error ?? new Error('Cannot open project storage'));
      request.onblocked = () => reject(new Error('Close another open editor tab to update storage'));
    });
  }
  async read(key: string): Promise<StoredWorkspace | null> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readonly');
      const request = tx.objectStore('workspaces').get(key);
      tx.oncomplete = () => resolve((request.result as StoredWorkspace | undefined) ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage read aborted'));
    });
  }
  async lastProjectId(): Promise<string | null> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readonly');
      const request = tx.objectStore('workspaces').get(['active-project']);
      tx.oncomplete = () => resolve(typeof request.result === 'string' ? request.result : null);
      tx.onabort = () => reject(tx.error ?? new Error('Cannot read the active project'));
      tx.onerror = () => { /* onabort reports the failed transaction */ };
    });
  }
  async compareAndSwap(key: string, expectedGeneration: number | null, json: string): Promise<number> {
    const db = await this.#database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite');
      const store = tx.objectStore('workspaces');
      let nextGeneration = 0;
      let conflict = false;
      const request = store.get(key);
      request.onsuccess = () => {
        const previous = request.result as StoredWorkspace | undefined;
        if ((previous?.generation ?? null) !== expectedGeneration) { conflict = true; tx.abort(); return; }
        nextGeneration = (previous?.generation ?? 0) + 1;
        store.put({ generation: nextGeneration, json }, key);
        // An array key cannot collide with a project ID string. Updating this in
        // the same transaction means failed saves never change the startup project.
        store.put(key, ['active-project']);
      };
      tx.oncomplete = () => resolve(nextGeneration);
      tx.onabort = () => reject(conflict ? new StorageConflict('Another tab saved this project; export your changes before reopening')
        : tx.error ?? new Error('Save aborted; previous saved project is intact'));
      tx.onerror = () => { /* onabort is the single failure path */ };
    });
  }
}

export class WorkspaceRepository {
  #storage: AtomicStorage;
  constructor(storage: AtomicStorage) { this.#storage = storage; }
  async lastProjectId(): Promise<string | null> { return this.#storage.lastProjectId?.() ?? null; }
  async load(projectId: string): Promise<{ state: WorkspaceState; generation: number } | null> {
    const stored = await this.#storage.read(projectId);
    if (!stored) return null;
    const state = await this.import(stored.json);
    if (state.project.projectId !== projectId) throw new Error('Stored project identity mismatch');
    return { state, generation: stored.generation };
  }
  async import(json: string): Promise<WorkspaceState> {
    const state = parseWorkspace(json);
    for (const check of state.checks) {
      if (check.status !== 'stale' && check.inputHash !== await inputHash(state.project, check.scope, check.model, check.modelVersion)) {
        check.status = 'stale';
      }
    }
    for (const review of state.reviews) {
      // A file is evidence, not an authenticated review authority. Keep historical
      // issued bytes intact, but require a fresh authorized review before reissue.
      review.status = 'stale';
    }
    return state;
  }
  async save(state: WorkspaceState, expectedGeneration: number | null): Promise<number> {
    const json = serializeWorkspace(state);
    return this.#storage.compareAndSwap(state.project.projectId, expectedGeneration, json);
  }
}
