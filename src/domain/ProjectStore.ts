import { validateProject } from './ProjectCodec.ts';
import type { ProductionProject, ProductionRecord } from './ProductionProject.ts';
import { canonical, createWorkspace, inputHash, references, scopedInputs, validateWorkspace } from './WorkspaceState.ts';
import type { CheckResult, HistoryEntry, IssuedArtifact, ReviewRecord, WorkspaceState } from './WorkspaceState.ts';

export type Operation = { type: 'put'; record: ProductionRecord } | { type: 'remove'; id: string }
  | { type: 'lock'; id: string; locked: boolean };
export interface Transaction { key: string; label: string; baseRevision: number; operations: Operation[] }
/** Supplied by the host authorization boundary, never read from transaction JSON. */
export interface Principal { id: string; kind: 'human' | 'automation' }
export interface Authorizer {
  can(principal: Principal, action: 'edit' | 'unlock' | 'review' | 'issue', scope: readonly string[]): boolean;
}
export interface Change { revision: number; changedIds: string[]; label: string }
export interface Preview { id: string; baseRevision: number; project: ProductionProject; changedIds: string[] }

export class CommandError extends Error { override name = 'CommandError'; }
function reject(message: string): never { throw new CommandError(message); }
function changedIds(before: ProductionRecord[], after: ProductionRecord[]): string[] {
  const old = new Map(before.map(r => [r.id, canonical(r)]));
  const next = new Map(after.map(r => [r.id, canonical(r)]));
  return [...new Set([...old.keys(), ...next.keys()])].filter(id => old.get(id) !== next.get(id));
}
function uniqueId(state: WorkspaceState, id: string): void {
  if (!id.trim() || [...state.project.records, ...state.checks, ...state.reviews, ...state.issued].some(r => r.id === id)) reject('ID must be new and nonempty');
}

/** One authoritative graph. Returned state and preview objects are detached copies. */
export class ProjectStore {
  #state: WorkspaceState;
  #authorizer: Authorizer;
  #listeners = new Set<(change: Change) => void>();
  #previews = new Map<string, Transaction>();
  #previewCounter = 0;

  constructor(state: WorkspaceState | ProductionProject, authorizer: Authorizer) {
    this.#state = 'format' in state ? structuredClone(state) : createWorkspace(state);
    validateWorkspace(this.#state);
    this.#authorizer = authorizer;
  }
  get state(): WorkspaceState { return structuredClone(this.#state); }
  get project(): ProductionProject { return structuredClone(this.#state.project); }
  subscribe(listener: (change: Change) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #permit(principal: Principal, action: 'edit' | 'unlock' | 'review' | 'issue', scope: string[]): void {
    if (!principal.id.trim() || !this.#authorizer.can(principal, action, scope)) reject(`Not authorized to ${action}`);
    if (action !== 'edit' && principal.kind !== 'human') reject(`Human authority required to ${action}`);
  }
  #request(transaction: Transaction): void {
    if (!transaction.key?.trim() || !transaction.label?.trim() || !Array.isArray(transaction.operations)
      || !transaction.operations.length) reject('Transaction requires a key, label and operations');
    if (this.#state.acceptedKeys.includes(transaction.key)) reject('Duplicate idempotency key');
    if (transaction.baseRevision !== this.#state.project.revision) reject('Stale base revision; reopen the proposal');
  }
  #stage(transaction: Transaction, principal: Principal): ProductionProject {
    this.#request(transaction);
    const before = this.#state.project;
    const map = new Map(before.records.map(r => [r.id, structuredClone(r)]));
    const touched = new Set<string>();
    for (const op of transaction.operations) {
      if (!op || !['put', 'remove', 'lock'].includes(op.type)) reject('Unsupported operation');
      const id = op.type === 'put' ? op.record?.id : op.id;
      if (!id || touched.has(id)) reject('Each record may be targeted once per transaction');
      touched.add(id);
      const old = map.get(id);
      this.#permit(principal, 'edit', [id]);
      if (old?.kind === 'document_snapshot' && old.status === 'issued') reject('Issued snapshots are immutable');
      if (op.type === 'lock') {
        if (!old || typeof op.locked !== 'boolean') reject('Invalid lock target');
        this.#permit(principal, 'unlock', [id]);
        old.locked = op.locked;
      } else {
        if (old?.locked) reject(`Locked record: ${id}`);
        if (old?.kind === 'document_snapshot' && old.status === 'issued') reject('Issued snapshots are immutable');
        if (op.type === 'remove') {
          if (!old) reject(`Missing record: ${id}`);
          map.delete(id);
        } else {
          if (old && (old.kind !== op.record.kind || old.locked !== op.record.locked)) reject('Kind/lock changes need an explicit operation');
          if (!old && op.record.locked) reject('Create an unlocked record, then lock it explicitly');
          if (op.record.kind === 'document_snapshot' && op.record.status === 'issued') reject('Use the authorized issuance path');
          map.set(id, structuredClone(op.record));
        }
      }
    }
    const next = { ...before, records: [...map.values()] };
    validateProject(next);
    // Changing edges or an allocation affects both endpoints. Locked endpoints cannot be bypassed
    // by creating/deleting an unlocked edge, or by clearing the allocation on another record.
    const lockMap = new Map(before.records.map(r => [r.id, r]));
    for (const id of changedIds(before.records, next.records)) {
      const old = lockMap.get(id), current = map.get(id);
      for (const record of [old, current]) {
        if (!record) continue;
        let affected: string[] = [];
        if (record.kind === 'connection' || record.kind === 'mechanical_attachment' || record.kind === 'assembly') affected = references(record);
        if (record.kind === 'port') affected = [record.instanceId];
        if (record.kind === 'asset_instance' && (old?.kind !== 'asset_instance' || current?.kind !== 'asset_instance'
          || old.inventoryItemId !== current.inventoryItemId)) affected = record.inventoryItemId ? [record.inventoryItemId] : [];
        for (const endpoint of affected) {
          this.#permit(principal, 'edit', [endpoint]);
          if (lockMap.get(endpoint)?.locked) reject(`Locked relationship endpoint: ${endpoint}`);
          const port = lockMap.get(endpoint);
          if (port?.kind === 'port') {
            this.#permit(principal, 'edit', [port.instanceId]);
            if (lockMap.get(port.instanceId)?.locked) reject(`Locked instance: ${port.instanceId}`);
          }
        }
      }
    }
    return next;
  }
  preview(transaction: Transaction, principal: Principal): Preview {
    const project = this.#stage(transaction, principal);
    const id = `preview:${++this.#previewCounter}`;
    this.#previews.set(id, structuredClone(transaction));
    return { id, baseRevision: transaction.baseRevision, project,
      changedIds: changedIds(this.#state.project.records, project.records) };
  }
  cancel(previewId: string): void { this.#previews.delete(previewId); }
  accept(previewId: string, principal: Principal): Change {
    if (principal.kind !== 'human') reject('A human must accept a preview');
    const transaction = this.#previews.get(previewId);
    if (!transaction) reject('Preview is missing or canceled');
    const result = this.#apply(transaction, principal);
    this.#previews.delete(previewId);
    return result;
  }
  execute(transaction: Transaction, principal: Principal): Change {
    if (principal.kind !== 'human') reject('Automatic proposals require preview and human acceptance');
    return this.#apply(transaction, principal);
  }
  #apply(transaction: Transaction, principal: Principal): Change {
    const next = this.#stage(transaction, principal);
    const before = this.#state.project.records;
    const ids = changedIds(before, next.records);
    if (!ids.length) reject('Transaction has no changes');
    const history: HistoryEntry = { key: transaction.key, label: transaction.label,
      before: structuredClone(before), after: structuredClone(next.records) };
    const state = this.state;
    state.acceptedKeys.push(transaction.key);
    state.undo.push(history);
    state.redo = [];
    return this.#commit(state, next.records, transaction.label);
  }
  undo(key: string, baseRevision: number, principal: Principal): Change { return this.#travel('undo', key, baseRevision, principal); }
  redo(key: string, baseRevision: number, principal: Principal): Change { return this.#travel('redo', key, baseRevision, principal); }
  #travel(direction: 'undo' | 'redo', key: string, baseRevision: number, principal: Principal): Change {
    this.#request({ key, label: direction, baseRevision, operations: [{ type: 'remove', id: 'history' }] });
    if (principal.kind !== 'human') reject('Human action required for history');
    const state = this.state;
    const entry = state[direction].pop();
    if (!entry) reject(`Nothing to ${direction}`);
    const expected = direction === 'undo' ? entry.after : entry.before;
    if (canonical(expected) !== canonical(state.project.records)) reject('History conflicts with current state');
    const target = direction === 'undo' ? entry.before : entry.after;
    const ids = changedIds(state.project.records, target);
    this.#permit(principal, 'edit', ids);
    if (ids.some(id => state.project.records.find(r => r.id === id)?.locked)) this.#permit(principal, 'unlock', ids);
    state[direction === 'undo' ? 'redo' : 'undo'].push(entry);
    state.acceptedKeys.push(key);
    return this.#commit(state, target, `${direction}: ${entry.label}`);
  }
  #commit(state: WorkspaceState, records: ProductionRecord[], label: string): Change {
    const before = this.#state.project;
    const next = { ...before, records: structuredClone(records), revision: before.revision + 1 };
    validateProject(next);
    for (const check of state.checks) {
      if (canonical(scopedInputs(before, check.scope)) !== canonical(scopedInputs(next, check.scope))) check.status = 'stale';
    }
    for (const review of state.reviews) {
      if (state.checks.find(c => c.id === review.checkId)?.status === 'stale') review.status = 'stale';
    }
    state.project = next;
    validateWorkspace(state);
    this.#state = state;
    const change = { revision: next.revision, changedIds: changedIds(before.records, records), label };
    // An observer/render failure must never make an already committed edit look rolled back.
    for (const listener of this.#listeners) { try { listener(structuredClone(change)); } catch (error) { console.error('Project observer failed', error); } }
    return change;
  }
  async recordCheck(result: Omit<CheckResult, 'inputHash' | 'inputRevision'>, baseRevision: number): Promise<CheckResult> {
    // The caller may reuse or mutate a job result while hashing is in flight.
    result = structuredClone(result);
    const project = this.project;
    if (baseRevision !== project.revision) reject('Stale calculation result');
    if (!result.scope.length || result.scope.some(id => !project.records.some(r => r.id === id))) reject('Unknown check scope');
    uniqueId(this.#state, result.id);
    const hash = await inputHash(project, result.scope, result.model, result.modelVersion);
    if (this.#state.project.revision !== baseRevision) reject('Calculation inputs changed while running');
    uniqueId(this.#state, result.id);
    const check = { ...structuredClone(result), inputHash: hash, inputRevision: baseRevision };
    const state = this.state;
    state.checks.push(check);
    validateWorkspace(state);
    this.#state = state;
    return structuredClone(check);
  }
  review(checkId: string, reviewId: string, evidence: string[], principal: Principal, now = new Date().toISOString()): ReviewRecord {
    const check = this.#state.checks.find(c => c.id === checkId);
    if (!check || check.status !== 'pass') reject('Only a current passing scoped check can be reviewed');
    this.#permit(principal, 'review', check.scope);
    if (!evidence.length) reject('Review evidence is required');
    uniqueId(this.#state, reviewId);
    const review: ReviewRecord = { id: reviewId, checkId, reviewerId: principal.id, reviewedAt: now,
      inputHash: check.inputHash, inputRevision: check.inputRevision, status: 'current', evidence: [...evidence] };
    const state = this.state; state.reviews.push(review); validateWorkspace(state); this.#state = state;
    return structuredClone(review);
  }
  issue(id: string, requiredCheckIds: string[], principal: Principal, now = new Date().toISOString()): IssuedArtifact {
    this.#permit(principal, 'issue', requiredCheckIds);
    uniqueId(this.#state, id);
    if (!requiredCheckIds.length) reject('An explicit reviewed check scope is required to issue');
    const reviews = requiredCheckIds.map(checkId => {
      const check = this.#state.checks.find(c => c.id === checkId);
      const review = this.#state.reviews.find(r => r.checkId === checkId && r.status === 'current' && r.inputHash === check?.inputHash);
      if (check?.status !== 'pass' || !review) reject(`Missing current review: ${checkId}`);
      return review.id;
    });
    const artifact: IssuedArtifact = { id, projectRevision: this.#state.project.revision, issuerId: principal.id, issuedAt: now,
      mediaType: 'application/json', content: JSON.stringify(this.#state.project, null, 2), reviewIds: reviews };
    const state = this.state; state.issued.push(artifact); validateWorkspace(state); this.#state = state;
    return structuredClone(artifact);
  }
}

/** Deletion is one graph transaction, with inventory allocation released by instance removal. */
export function deleteInstanceOperations(project: ProductionProject, instanceId: string): Operation[] {
  if (!project.records.some(r => r.kind === 'asset_instance' && r.id === instanceId)) reject('Unknown instance');
  const removed = new Set([instanceId]);
  for (const record of project.records) if (record.kind === 'port' && record.instanceId === instanceId) removed.add(record.id);
  for (const record of project.records) if ((record.kind === 'connection' || record.kind === 'mechanical_attachment')
    && references(record).some(id => removed.has(id))) removed.add(record.id);
  const operations: Operation[] = [...removed].map(id => ({ type: 'remove', id }));
  for (const record of project.records) if (record.kind === 'assembly' && record.instanceIds.includes(instanceId)) {
    operations.push({ type: 'put', record: { ...record, instanceIds: record.instanceIds.filter(id => id !== instanceId) } });
  }
  return operations;
}
