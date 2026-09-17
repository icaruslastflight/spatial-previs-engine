import { describe, expect, it } from 'vitest';
import fixture from '../../tests/fixtures/r0/production-project.v1.json';
import { parseProject } from './ProjectCodec.ts';
import { ProjectStore } from './ProjectStore.ts';
import type { Principal } from './ProjectStore.ts';
import { parseWorkspace, serializeWorkspace } from './WorkspaceState.ts';
import { WorkspaceRepository } from './WorkspaceRepository.ts';
import { createDiagnosticBundle, replayDiagnosticBundle } from './DiagnosticBundle.ts';
import { readSceneTool } from '../assistant/SceneTools.ts';
import { technicalDataCheck } from './ProjectChecks.ts';

const human: Principal = { id: 'operator@example.test', kind: 'human' };
const makeStore = () => new ProjectStore(parseProject(JSON.stringify(fixture)), { can: () => true });
const check = { id: 'check:boundary', scope: ['inst_0002'], model: 'fixture-only', modelVersion: '1',
  status: 'pass' as const, summary: 'Synthetic fixture', assumptions: [], uncertainty: [], evidence: ['Local fixture'] };
const repository = () => new WorkspaceRepository({ read: async () => null, compareAndSwap: async () => 1 });

describe('R0 evidence boundaries', () => {
  it('freezes job inputs before awaiting hashing', async () => {
    const store = makeStore(), result = structuredClone(check);
    const pending = store.recordCheck(result, 0);
    result.scope = ['zone:audience']; result.summary = 'Mutated';
    const recorded = await pending;
    expect(recorded.scope).toEqual(['inst_0002']);
    expect(recorded.summary).toBe('Synthetic fixture');
  });
  it('imported approval metadata cannot authorize a fresh issue', async () => {
    const store = makeStore(); await store.recordCheck(check, 0);
    store.review(check.id, 'review:original', ['Manual fixture review'], human);
    const issued = store.issue('issue:original', [check.id], human);
    const imported = await repository().import(serializeWorkspace(store.state));
    expect(imported.reviews[0]?.status).toBe('stale');
    expect(imported.issued[0]?.content).toBe(issued.content);
    expect(() => new ProjectStore(imported, { can: () => true }).issue('issue:new', [check.id], human)).toThrow('review');
  });
  it('checks permission on relationship endpoints as well as the new edge', () => {
    const store = new ProjectStore(parseProject(JSON.stringify(fixture)), {
      can: (_principal, _action, scope) => !scope.includes('port:receive'),
    });
    expect(() => store.execute({ key: 'connection', label: 'Connect', baseRevision: 0, operations: [{ type: 'put', record: {
      id: 'edge:new', kind: 'connection', label: 'Video', locked: false, domain: 'video',
      sourcePortId: 'port:send', targetPortId: 'port:receive',
    } }] }, human)).toThrow('authorized');
    expect(store.project.revision).toBe(0);
  });
  it('treats placeholder surface measurements as missing technical data', () => {
    const store = makeStore();
    const surface = store.project.records.find(r => r.kind === 'surface')!;
    if (surface.kind !== 'surface') throw new Error('Missing test surface');
    surface.width = { status: 'known', value: 2, unit: 'm', provenance: 'placeholder', source: 'Generic' };
    expect(technicalDataCheck(store.project, surface, 'test').status).toBe('needs_data');
  });
  it('rejects a valid-looking but disconnected undo journal', () => {
    const store = makeStore(), record = store.project.records.find(r => r.id === 'inst_0002')!;
    store.execute({ key: 'rename', label: 'Rename', baseRevision: 0, operations: [{ type: 'put', record: { ...record, label: 'Changed' } }] }, human);
    const state = store.state;
    state.undo[0]!.after = state.undo[0]!.before;
    expect(() => parseWorkspace(JSON.stringify(state))).toThrow('history does not match');
  });
});

describe('read-only scene tools and diagnostics', () => {
  it('returns actual IDs, revision, missing values and unavailable domain checks without mutation', async () => {
    const store = makeStore(), before = store.state;
    const answer = await readSceneTool(store.state, { name: 'scene.inspect', recordId: 'inst_0002' });
    expect(answer.record?.id).toBe('inst_0002'); expect(answer.revision).toBe(0);
    expect(answer.quantities.some(q => q.status === 'unknown')).toBe(true);
    expect(answer.unsupportedChecks.every(c => c.status === 'not_evaluated')).toBe(true);
    answer.records[0]!.label = 'Caller mutation';
    expect(store.state).toEqual(before);
  });
  it('rejects writes, missing records and injected extra arguments', async () => {
    const state = makeStore().state;
    for (const request of [null, { name: 'scene.execute' }, { name: 'scene.inspect', recordId: 'missing' },
      { name: 'scene.summary', code: 'alert(1)' }]) {
      await expect(readSceneTool(state, request)).rejects.toThrow();
    }
  });
  it('rechecks freshness when evidence is exported', async () => {
    const store = makeStore(); await store.recordCheck(check, 0);
    const state = store.state;
    const record = state.project.records.find(r => r.id === 'inst_0002')!; record.label = 'Changed outside a store';
    const answer = await readSceneTool(state, { name: 'scene.summary' });
    expect(answer.checks[0]?.status).toBe('stale');
  });
  it('redacts free text while retaining geometry, undo/redo and immutable original issued bytes', async () => {
    const store = makeStore(); await store.recordCheck(check, 0);
    store.review(check.id, 'review:private', ['https://private.test/?token=secret'], human);
    store.issue('issued:private', [check.id], human);
    const record = store.project.records.find(r => r.id === 'inst_0002')!;
    store.execute({ key: 'private-key', label: 'private-label', baseRevision: 0, operations: [{ type: 'put', record: {
      ...record, label: 'password=private-secret',
    } }] }, human);
    const before = store.state;
    const json = JSON.stringify(createDiagnosticBundle(before));
    for (const sensitive of ['operator@example.test', 'private.test', 'secret', 'private-key', 'private-label', 'inst_0002']) {
      expect(json).not.toContain(sensitive);
    }
    const replayed = replayDiagnosticBundle(json);
    expect(replayed.project.records.filter(r => r.kind === 'asset_instance').map(r => r.transform))
      .toEqual(before.project.records.filter(r => r.kind === 'asset_instance').map(r => r.transform));
    expect(replayed.checks[0]?.status).toBe('stale');
    expect(store.state).toEqual(before);
    const reopened = new ProjectStore(replayed, { can: () => true });
    reopened.undo('diagnostic:undo', 1, human);
    reopened.redo('diagnostic:redo', 2, human);
    expect(reopened.project.records).toEqual(replayed.project.records);
  });
});
