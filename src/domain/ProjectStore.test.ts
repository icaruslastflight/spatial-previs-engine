import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/r0/production-project.v1.json';
import { parseProject } from './ProjectCodec.ts';
import { deleteInstanceOperations, ProjectStore } from './ProjectStore.ts';
import type { Authorizer, Operation, Principal } from './ProjectStore.ts';
import { canonical, createWorkspace, parseWorkspace, serializeWorkspace } from './WorkspaceState.ts';
import type { CheckResult } from './WorkspaceState.ts';
import { StorageConflict, WorkspaceRepository } from './WorkspaceRepository.ts';
import { translateInstanceOperations } from './ProjectTransforms.ts';
import type { AtomicStorage, StoredWorkspace } from './WorkspaceRepository.ts';

const human: Principal = { id: 'operator:1', kind: 'human' };
const ai: Principal = { id: 'model:1', kind: 'automation' };
const authorizer: Authorizer = { can: () => true };
const initial = () => parseProject(JSON.stringify(fixture));
const store = () => new ProjectStore(initial(), authorizer);
function move(s: ProjectStore, id = 'inst_0002', x = 4): Operation {
  const record = s.project.records.find(r => r.id === id)!;
  if (record.kind !== 'asset_instance') throw new Error('Not an instance');
  record.transform.position[0] = x;
  return { type: 'put', record };
}
function edit(s: ProjectStore, operations: Operation[], key: string = crypto.randomUUID()) {
  return s.execute({ key, label: 'Edit', baseRevision: s.project.revision, operations }, human);
}
function check(id = 'check:1', scope = ['inst_0002']): Omit<CheckResult, 'inputHash' | 'inputRevision'> {
  return { id, scope, model: 'fixture-test', modelVersion: '1', status: 'pass', summary: 'Synthetic test only',
    assumptions: ['Synthetic'], uncertainty: [], evidence: ['Fixture'] };
}

describe('R0 commands', () => {
  it('rejects stale revisions and duplicate committed keys, including after reopening', () => {
    const s = store(); edit(s, [move(s)], 'same');
    const reopened = new ProjectStore(parseWorkspace(serializeWorkspace(s.state)), authorizer);
    expect(() => edit(reopened, [move(reopened, 'inst_0002', 8)], 'same')).toThrow('Duplicate');
    expect(() => reopened.execute({ key: 'new', label: 'Move', baseRevision: 0, operations: [move(reopened)] }, human)).toThrow('Stale');
  });
  it('stages whole graphs atomically and leaves state unchanged on any invalid operation', () => {
    const s = store(), before = s.state;
    expect(() => edit(s, [move(s), { type: 'remove', id: 'def:panel' }])).toThrow();
    expect(s.state).toEqual(before);
  });
  it('cancel leaves positions, relationships, allocations, revisions and history unchanged', () => {
    const s = store(), before = s.state;
    const preview = s.preview({ key: 'cancel', label: 'Delete', baseRevision: 0,
      operations: deleteInstanceOperations(s.project, 'inst_0002') }, ai);
    expect(preview.project.records.some(r => r.id === 'inst_0002')).toBe(false);
    preview.project.records = [];
    s.cancel(preview.id);
    expect(s.state).toEqual(before);
    expect(() => s.accept(preview.id, human)).toThrow('canceled');
  });
  it('revalidates a preview at acceptance and prevents automation from applying it', () => {
    const s = store();
    const proposal = { key: 'p', label: 'Move', baseRevision: 0, operations: [move(s)] };
    expect(() => s.execute(proposal, ai)).toThrow('preview');
    const p = s.preview(proposal, ai);
    expect(() => s.accept(p.id, ai)).toThrow('human');
    edit(s, [{ type: 'lock', id: 'inst_0002', locked: true }]);
    expect(() => s.accept(p.id, human)).toThrow('Stale');
  });
  it('does not trust a caller mutation to the original proposal or preview', () => {
    const s = store();
    const p = { key: 'immutable', label: 'Move', baseRevision: 0, operations: [move(s)] };
    const preview = s.preview(p, ai);
    p.operations = deleteInstanceOperations(s.project, 'inst_0002');
    preview.project.records = [];
    s.accept(preview.id, human);
    expect(s.project.records.some(r => r.id === 'inst_0002')).toBe(true);
  });
  it('undo/redo restores full graphs and stock allocations while revisions only increase', () => {
    const s = store(), records = s.project.records;
    edit(s, deleteInstanceOperations(s.project, 'inst_0002'));
    expect(s.project.records.some(r => r.id === 'attach:1')).toBe(false);
    s.undo('undo:1', 1, human);
    expect(s.project.records).toEqual(records);
    expect(s.project.revision).toBe(2);
    s.redo('redo:1', 2, human);
    expect(s.project.records.some(r => r.id === 'inst_0002')).toBe(false);
    expect(s.project.revision).toBe(3);
  });
  it('enforces record locks, endpoint locks, allocation locks and authorization separately', () => {
    const s = store();
    edit(s, [{ type: 'lock', id: 'inst_0002', locked: true }]);
    expect(() => edit(s, [move(s)])).toThrow('Locked');
    expect(() => edit(s, [{ type: 'remove', id: 'attach:1' }])).toThrow('Locked');
    const denied = new ProjectStore(s.state, { can: () => false });
    expect(() => edit(denied, [{ type: 'lock', id: 'inst_0002', locked: false }])).toThrow('authorized');
    const stock = store(); edit(stock, [{ type: 'lock', id: 'stock:panel1', locked: true }]);
    expect(() => edit(stock, deleteInstanceOperations(stock.project, 'inst_0002'))).toThrow('Locked');
  });
  it('rejects bypassing lock changes inside put and repeated targets inside a transaction', () => {
    const s = store(), op = move(s);
    if (op.type !== 'put') throw new Error();
    op.record.locked = true;
    expect(() => edit(s, [op])).toThrow('explicit');
    expect(() => edit(s, [move(s), move(s)])).toThrow('once');
  });
  it('publishes changed IDs for unsnapped moves, unlink, delete, undo and redo', () => {
    const s = store(); const events: string[][] = [];
    s.subscribe(e => events.push(e.changedIds));
    edit(s, [move(s)]);
    edit(s, [{ type: 'remove', id: 'attach:1' }]);
    edit(s, deleteInstanceOperations(s.project, 'inst_0002'));
    s.undo('u', 3, human); s.redo('r', 4, human);
    expect(events).toHaveLength(5);
    expect(events[0]).toContain('inst_0002'); expect(events[1]).toContain('attach:1');
    expect(events[2]).toContain('port:receive');
  });
  it('carries attached descendants on translation and rejects moving a locked child atomically', () => {
    const s = store();
    edit(s, translateInstanceOperations(s.project, 'inst_0001', [2, 1, 3]));
    const child = s.project.records.find(r => r.id === 'inst_0002');
    expect(child?.kind === 'asset_instance' && child.transform.position).toEqual([2, 3.4, 3]);
    edit(s, [{ type: 'lock', id: 'inst_0002', locked: true }]);
    const before = s.state;
    expect(() => edit(s, translateInstanceOperations(s.project, 'inst_0001', [8, 1, 3]))).toThrow('Locked');
    expect(s.state).toEqual(before);
  });
  it('does not allow adding ports to locked equipment or an automation-authored unlock', () => {
    const s = store(); edit(s, [{ type: 'lock', id: 'inst_0002', locked: true }]);
    expect(() => edit(s, [{ type: 'put', record: { kind: 'port', id: 'new-port', label: 'New port',
      locked: false, instanceId: 'inst_0002', domain: 'video', direction: 'input', protocol: null, connector: null } }])).toThrow('Locked');
    expect(() => s.preview({ key: 'auto-unlock', label: 'Unlock', baseRevision: 1,
      operations: [{ type: 'lock', id: 'inst_0002', locked: false }] }, ai)).toThrow('Human');
  });
});

describe('checks, review and issued evidence', () => {
  it('stores all scoped check outcomes and keeps missing data distinct', async () => {
    const s = store();
    for (const status of ['pass', 'fail', 'needs_data', 'not_evaluated', 'stale'] as const) {
      await s.recordCheck({ ...check(`check:${status}`), status }, 0);
    }
    expect(s.state.checks.map(c => c.status)).toEqual(['pass', 'fail', 'needs_data', 'not_evaluated', 'stale']);
  });
  it('invalidates affected results and human reviews; undo does not resurrect approval', async () => {
    const s = store(); await s.recordCheck(check(), 0);
    s.review('check:1', 'review:1', ['Reviewed fixture'], human);
    edit(s, [move(s)]);
    expect(s.state.checks[0]?.status).toBe('stale');
    expect(s.state.reviews[0]?.status).toBe('stale');
    s.undo('undo', 1, human);
    expect(s.state.reviews[0]?.status).toBe('stale');
  });
  it('leaves unrelated checks current and detects changed definitions and newly added edges', async () => {
    const s = store(); await s.recordCheck(check('zone', ['zone:audience']), 0);
    await s.recordCheck(check(), 0);
    edit(s, [move(s)]);
    expect(s.state.checks.find(c => c.id === 'zone')?.status).toBe('pass');
    const separate = store(); await separate.recordCheck(check(), 0);
    edit(separate, [{ type: 'put', record: { id: 'signal', kind: 'connection', label: 'Video', locked: false,
      domain: 'video', sourcePortId: 'port:send', targetPortId: 'port:receive' } }]);
    expect(separate.state.checks[0]?.status).toBe('stale');
  });
  it('rejects asynchronously completing calculations from an older revision', async () => {
    const s = store(); const pending = s.recordCheck(check(), 0);
    edit(s, [move(s)]);
    await expect(pending).rejects.toThrow('changed');
    expect(s.state.checks).toHaveLength(0);
  });
  it('keeps exact issued bytes unchanged after edits/undo, and cannot accept AI approval', async () => {
    const s = store(); await s.recordCheck(check(), 0);
    expect(() => s.review('check:1', 'review:ai', ['Model assertion'], ai)).toThrow('Human');
    s.review('check:1', 'review:1', ['Human review'], human);
    const artifact = s.issue('issued:1', ['check:1'], human);
    edit(s, [move(s)]); s.undo('u', 1, human);
    expect(s.state.issued[0]?.content).toBe(artifact.content);
    expect(JSON.parse(artifact.content).revision).toBe(0);
    expect(() => s.issue('issued:2', ['check:1'], human)).toThrow('review');
  });
});

class MemoryStorage implements AtomicStorage {
  saved = new Map<string, StoredWorkspace>(); fail = false;
  async read(key: string) { return this.saved.get(key) ?? null; }
  async compareAndSwap(key: string, expected: number | null, json: string) {
    if (this.fail) throw new Error('Disk full');
    const current = this.saved.get(key);
    if ((current?.generation ?? null) !== expected) throw new StorageConflict('Conflict');
    const generation = (current?.generation ?? 0) + 1;
    this.saved.set(key, { generation, json }); return generation;
  }
}
describe('durable workspace boundary', () => {
  it('migrates bare CORE-01 projects without changing IDs, unknowns, units, locks or graph order', () => {
    const parsed = parseWorkspace(JSON.stringify(fixture));
    expect(parsed.project).toEqual(initial());
    expect(parseWorkspace(serializeWorkspace(parsed))).toEqual(parsed);
    expect(() => parseWorkspace(JSON.stringify({ ...fixture, schemaVersion: 99 }))).toThrow('version');
    expect(() => parseWorkspace(JSON.stringify({ ...parsed, version: 99 }))).toThrow('version');
  });
  it('saves/reopens history and rejects conflicting offline/tab writes and failed saves', async () => {
    const storage = new MemoryStorage(), repo = new WorkspaceRepository(storage), s = store();
    const generation = await repo.save(s.state, null);
    edit(s, [move(s)]);
    const nextGeneration = await repo.save(s.state, generation);
    await expect(repo.save(s.state, generation)).rejects.toThrow('Conflict');
    const loaded = await repo.load(s.project.projectId);
    expect(loaded?.state).toEqual(s.state);
    storage.fail = true;
    await expect(repo.save(s.state, nextGeneration)).rejects.toThrow('Disk full');
    expect((await repo.load(s.project.projectId))?.state).toEqual(s.state);
    const reopened = new ProjectStore(loaded!.state, authorizer);
    reopened.undo('reopened-undo', 1, human);
    expect(reopened.project.records).toEqual(initial().records);
  });
  it('rejects malformed metadata and invalidates edited check inputs on import', async () => {
    const s = store(); await s.recordCheck(check(), 0);
    const state = s.state;
    const record = state.project.records.find(r => r.id === 'inst_0002');
    if (record?.kind === 'asset_instance') record.transform.position[0] = 999;
    const repo = new WorkspaceRepository(new MemoryStorage());
    expect((await repo.import(serializeWorkspace(state))).checks[0]?.status).toBe('stale');
    expect(() => parseWorkspace(JSON.stringify({ ...state, surprise: true }))).toThrow('fields');
    expect(() => parseWorkspace(JSON.stringify({ ...state, acceptedKeys: ['dup', 'dup'] }))).toThrow('Duplicate'.toLowerCase());
    expect(canonical(createWorkspace(initial()).project)).toBe(canonical(initial()));
  });
});
