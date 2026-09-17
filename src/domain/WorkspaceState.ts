import { parseProject, validateProject } from './ProjectCodec.ts';
import type { ProductionProject, ProductionRecord } from './ProductionProject.ts';

export type CheckStatus = 'pass' | 'fail' | 'needs_data' | 'not_evaluated' | 'stale';
export interface CheckResult {
  id: string;
  scope: string[];
  model: string;
  modelVersion: string;
  inputRevision: number;
  inputHash: string;
  status: CheckStatus;
  summary: string;
  assumptions: string[];
  uncertainty: string[];
  evidence: string[];
}
export interface ReviewRecord {
  id: string;
  checkId: string;
  reviewerId: string;
  reviewedAt: string;
  inputHash: string;
  inputRevision: number;
  status: 'current' | 'stale';
  evidence: string[];
}
export interface IssuedArtifact {
  id: string;
  projectRevision: number;
  issuerId: string;
  issuedAt: string;
  mediaType: 'application/json';
  /** Exact issued UTF-8 content, never regenerated when the current scene changes. */
  content: string;
  reviewIds: string[];
}
export interface HistoryEntry {
  key: string;
  label: string;
  before: ProductionRecord[];
  after: ProductionRecord[];
}
export interface WorkspaceState {
  format: 'spatial-previs-workspace';
  version: 1;
  project: ProductionProject;
  acceptedKeys: string[];
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  checks: CheckResult[];
  reviews: ReviewRecord[];
  issued: IssuedArtifact[];
}

export function createWorkspace(project: ProductionProject): WorkspaceState {
  validateProject(project);
  return { format: 'spatial-previs-workspace', version: 1, project: structuredClone(project),
    acceptedKeys: [], undo: [], redo: [], checks: [], reviews: [], issued: [] };
}

/** Sorted object keys; array order is preserved (assembly membership is ordered). */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function references(record: ProductionRecord): string[] {
  switch (record.kind) {
    case 'asset_instance': return [record.definitionId, ...(record.inventoryItemId ? [record.inventoryItemId] : [])];
    case 'stock_pool': case 'inventory_item': return [record.definitionId];
    case 'assembly': return record.instanceIds;
    case 'port': return [record.instanceId];
    case 'connection': return [record.sourcePortId, record.targetPortId];
    case 'mechanical_attachment': return [record.parentInstanceId, record.childInstanceId];
    // A snapshot references a historical graph, not the current dependency graph.
    default: return [];
  }
}

/** Transitive inputs plus incident relationships, including newly added edges. */
export function scopedInputs(project: ProductionProject, scope: string[]): ProductionRecord[] {
  const ids = new Set(scope);
  for (let changed = true; changed;) {
    changed = false;
    for (const record of project.records) {
      const refs = references(record);
      if (ids.has(record.id)) {
        for (const id of refs) if (!ids.has(id)) { ids.add(id); changed = true; }
      } else if ((record.kind === 'port' || record.kind === 'connection' || record.kind === 'mechanical_attachment')
        && refs.some(id => ids.has(id))) {
        ids.add(record.id); changed = true;
      }
    }
  }
  return project.records.filter(r => ids.has(r.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function inputHash(project: ProductionProject, scope: string[], model: string, modelVersion: string): Promise<string> {
  const payload = canonical({ projectId: project.projectId, coordinateFrame: project.coordinateFrame,
    scope: [...scope].sort(), model, modelVersion, records: scopedInputs(project, scope) });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Workspace: ${message}`);
}
function obj(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
function fields(value: Record<string, unknown>, names: string[]): void {
  assert(Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n)), 'missing or unsupported fields');
}
function str(value: unknown): asserts value is string { assert(typeof value === 'string' && value.trim(), 'expected nonempty string'); }
function list(value: unknown): asserts value is unknown[] { assert(Array.isArray(value), 'expected array'); }
function strings(value: unknown): asserts value is string[] { list(value); value.forEach(str); }
function revision(value: unknown, maximum: number): void {
  assert(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum, 'invalid revision');
}
function identity(value: Record<string, unknown>, ids: Set<string>): void {
  str(value.id); assert(!ids.has(value.id), 'duplicate metadata ID'); ids.add(value.id);
}

export function validateWorkspace(value: unknown): asserts value is WorkspaceState {
  obj(value);
  fields(value, ['format', 'version', 'project', 'acceptedKeys', 'undo', 'redo', 'checks', 'reviews', 'issued']);
  assert(value.format === 'spatial-previs-workspace' && value.version === 1, 'unsupported workspace version');
  validateProject(value.project);
  const project = value.project;
  strings(value.acceptedKeys);
  assert(new Set(value.acceptedKeys).size === value.acceptedKeys.length, 'duplicate idempotency key');
  for (const field of ['undo', 'redo'] as const) {
    list(value[field]);
    for (const entry of value[field]) {
      obj(entry); fields(entry, ['key', 'label', 'before', 'after']); str(entry.key); str(entry.label);
      assert(value.acceptedKeys.includes(entry.key), 'history key is not in journal');
      for (const side of ['before', 'after']) validateProject({ ...project, records: entry[side] });
    }
  }
  // Every history step must connect to its neighbour and to the current graph.
  // Valid individual snapshots alone do not make an imported journal replayable.
  const historyKeys = new Set<string>();
  for (const direction of ['undo', 'redo'] as const) {
    let expected = canonical(project.records);
    for (const entry of [...value[direction] as HistoryEntry[]].reverse()) {
      assert(!historyKeys.has(entry.key), 'duplicate history entry');
      historyKeys.add(entry.key);
      const from = direction === 'undo' ? entry.after : entry.before;
      const to = direction === 'undo' ? entry.before : entry.after;
      assert(canonical(from) === expected, 'history does not match project');
      for (const record of from) {
        if (record.kind === 'document_snapshot' && record.status === 'issued') {
          assert(canonical(to.find(r => r.id === record.id) ?? null) === canonical(record), 'history changes issued snapshot');
        }
      }
      expected = canonical(to);
    }
  }
  const ids = new Set(project.records.map(r => r.id));
  list(value.checks);
  for (const check of value.checks) {
    obj(check); fields(check, ['id', 'scope', 'model', 'modelVersion', 'inputRevision', 'inputHash', 'status', 'summary', 'assumptions', 'uncertainty', 'evidence']);
    identity(check, ids);
    for (const field of ['model', 'modelVersion', 'inputHash', 'summary']) str(check[field]);
    assert(/^[a-f0-9]{64}$/.test(String(check.inputHash)), 'invalid input hash');
    for (const field of ['scope', 'assumptions', 'uncertainty', 'evidence']) strings(check[field]);
    assert((check.scope as string[]).length > 0 && new Set(check.scope as string[]).size === (check.scope as string[]).length, 'invalid scope');
    revision(check.inputRevision, project.revision);
    assert(['pass', 'fail', 'needs_data', 'not_evaluated', 'stale'].includes(String(check.status)), 'invalid check status');
  }
  list(value.reviews);
  for (const review of value.reviews) {
    obj(review); fields(review, ['id', 'checkId', 'reviewerId', 'reviewedAt', 'inputHash', 'inputRevision', 'status', 'evidence']);
    identity(review, ids);
    for (const field of ['checkId', 'reviewerId', 'reviewedAt', 'inputHash']) str(review[field]);
    assert(Number.isFinite(Date.parse(String(review.reviewedAt))), 'invalid review date');
    strings(review.evidence); revision(review.inputRevision, project.revision);
    assert(['current', 'stale'].includes(String(review.status)), 'invalid review status');
    const check = (value.checks as unknown as CheckResult[]).find(c => c.id === review.checkId);
    assert(check, 'review references missing check');
    if (review.status === 'current') assert(check.status === 'pass' && review.inputHash === check.inputHash
      && review.inputRevision === check.inputRevision, 'review does not match passing check');
  }
  list(value.issued);
  for (const artifact of value.issued) {
    obj(artifact); fields(artifact, ['id', 'projectRevision', 'issuerId', 'issuedAt', 'mediaType', 'content', 'reviewIds']);
    identity(artifact, ids);
    for (const field of ['issuerId', 'issuedAt', 'content']) str(artifact[field]);
    assert(Number.isFinite(Date.parse(String(artifact.issuedAt))), 'invalid issue date');
    assert(artifact.mediaType === 'application/json', 'unsupported artifact type');
    strings(artifact.reviewIds); revision(artifact.projectRevision, project.revision);
    assert(artifact.reviewIds.every(id => (value.reviews as unknown as ReviewRecord[]).some(r => r.id === id)), 'missing artifact review');
    const frozen = parseProject(String(artifact.content));
    assert(frozen.projectId === project.projectId && frozen.revision === artifact.projectRevision, 'artifact project/revision mismatch');
  }
}

/** Explicit migration from the original CORE-01 JSON boundary. Never guess unknown schemas. */
export function parseWorkspace(json: string): WorkspaceState {
  const value: unknown = JSON.parse(json);
  if (value !== null && typeof value === 'object' && !('format' in value) && 'schemaVersion' in value) {
    validateProject(value);
    return createWorkspace(value);
  }
  validateWorkspace(value);
  return value;
}

export function serializeWorkspace(state: WorkspaceState): string {
  validateWorkspace(state);
  return JSON.stringify(state, null, 2);
}
