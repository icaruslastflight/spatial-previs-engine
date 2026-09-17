import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createF34BoxTruss2M } from '../assets/ModularPrimitives.ts';
import { createProject } from '../domain/ProductionProject.ts';
import type { AssetInstance } from '../domain/ProductionProject.ts';
import { ProjectStore } from '../domain/ProjectStore.ts';
import { translateInstanceOperations } from '../domain/ProjectTransforms.ts';
import { parseWorkspace, serializeWorkspace } from '../domain/WorkspaceState.ts';
import { SocketSnappingEngine } from '../engine/SocketSnappingEngine.ts';
import { liftSockets, prepareSceneMove } from './ProductionScene.ts';

const human = { id: 'test-operator', kind: 'human' as const };
function setup() {
  const project = createProject('socket-fixture');
  project.records.push({ kind: 'asset_definition', id: 'definition', label: 'F34 fixture', locked: false,
    catalogId: 'truss_f34_box_2m', category: 'trussing', specifications: { mass: { status: 'unknown', unit: 'kg' } } });
  const objects = new Map<string, THREE.Object3D>();
  for (const [id, x] of [['a', 0], ['b', 2.05]] as const) {
    project.records.push({ kind: 'asset_instance', id, label: id, locked: false, definitionId: 'definition', inventoryItemId: null,
      transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1] } });
    const object = createF34BoxTruss2M(); object.position.x = x; objects.set(id, object);
  }
  return { store: new ProjectStore(project, { can: () => true }), objects };
}

describe('command-backed socket scene', () => {
  it('previews a real socket snap on clones, then persists and undoes the exact mechanical graph', () => {
    const { store, objects } = setup(), original = store.state;
    const move = prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]);
    expect(move.snapped).toBe(true); expect(objects.get('a')!.position.x).toBe(0);
    const preview = store.preview({ key: 'snap', label: 'Snap', baseRevision: 0, operations: move.operations }, human);
    expect(store.state).toEqual(original);
    expect(preview.project.records.some(r => r.kind === 'mechanical_attachment')).toBe(true);
    expect(preview.project.records.some(r => r.kind === 'connection')).toBe(false);
    store.accept(preview.id, human);
    const reopened = new ProjectStore(parseWorkspace(serializeWorkspace(store.state)), { can: () => true });
    reopened.undo('undo-snap', 1, human);
    expect(reopened.project.records).toEqual(original.project.records);
    reopened.redo('redo-snap', 2, human);
    expect(reopened.project.records).toEqual(store.project.records);
  });
  it('cancel leaves original positions, sockets, relationships and revision intact', () => {
    const { store, objects } = setup(), original = store.state;
    const move = prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]);
    const preview = store.preview({ key: 'cancel', label: 'Snap', baseRevision: 0, operations: move.operations }, human);
    store.cancel(preview.id);
    expect(store.state).toEqual(original); expect(objects.get('a')!.parent).toBeNull();
    expect(prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]).snapped).toBe(true);
  });
  it('moves attached descendants, while unsnapped child motion unlinks atomically', () => {
    const { store, objects } = setup();
    const snap = prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]);
    store.execute({ key: 'snap', label: 'Snap', baseRevision: 0, operations: snap.operations }, human);
    const move = prepareSceneMove(store.project, objects, 'b', [3.05, 0, 0], false);
    expect(move.transforms.get('a')!.position[0]).toBeCloseTo(1.05);
    store.execute({ key: 'move-parent', label: 'Move parent', baseRevision: 1, operations: move.operations }, human);
    const before = store.project.records;
    const unlink = translateInstanceOperations(store.project, 'a', [8, 1, 0]);
    store.execute({ key: 'move-child', label: 'Move child', baseRevision: 2, operations: unlink }, human);
    expect(store.project.records.some(r => r.kind === 'mechanical_attachment')).toBe(false);
    store.undo('undo-unlink', 3, human);
    expect(store.project.records).toEqual(before);
  });
  it('rejects snapping to locked equipment and restores state after a stale preview', () => {
    const { store, objects } = setup();
    const move = prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]);
    const preview = store.preview({ key: 'snap', label: 'Snap', baseRevision: 0, operations: move.operations }, human);
    store.execute({ key: 'lock', label: 'Lock', baseRevision: 0, operations: [{ type: 'lock', id: 'b', locked: true }] }, human);
    const before = store.state;
    expect(() => store.accept(preview.id, human)).toThrow('Stale');
    expect(() => store.execute({ key: 'snap-locked', label: 'Snap', baseRevision: 1, operations: move.operations }, human)).toThrow('Locked');
    expect(store.state).toEqual(before);
  });
  it('refreshes affected check inputs for real snaps, free movement and unlink', async () => {
    const { store, objects } = setup();
    const result = { id: 'snap-check', scope: ['a'], model: 'fixture', modelVersion: '1', status: 'needs_data' as const,
      summary: 'No structural specification', assumptions: [], uncertainty: [], evidence: [] };
    await store.recordCheck(result, 0);
    store.execute({ key: 'snap', label: 'Snap', baseRevision: 0,
      operations: prepareSceneMove(store.project, objects, 'a', [0.05, 0, 0]).operations }, human);
    expect(store.state.checks[0]!.status).toBe('stale');
    await store.recordCheck({ ...result, id: 'unlink-check' }, 1);
    const child = store.project.records.find(r => r.id === 'a') as AssetInstance;
    store.execute({ key: 'unsnap', label: 'Unsnapped movement', baseRevision: 1,
      operations: prepareSceneMove(store.project, objects, 'a', [child.transform.position[0], 2, 0], false).operations }, human);
    expect(store.state.checks[1]!.status).toBe('stale');
  });
  it('lifts glTF sockets through nested poses without changing their world-space contract', () => {
    const wrapper = new THREE.Group(), node = createF34BoxTruss2M();
    wrapper.position.set(3, 2, 1); node.position.set(0, 2, 0); node.rotation.z = Math.PI / 2; wrapper.add(node);
    wrapper.updateMatrixWorld(true);
    const native = new SocketSnappingEngine(); native.register(node);
    const before = native.getWorldSockets(node);
    liftSockets(wrapper);
    const lifted = new SocketSnappingEngine(); lifted.register(wrapper);
    const after = lifted.getWorldSockets(wrapper);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.position.distanceTo(before[i]!.position)).toBeLessThan(1e-8);
      expect(after[i]!.normal.distanceTo(before[i]!.normal)).toBeLessThan(1e-8);
      expect(after[i]!.definition.detentStepRadians).toBe(before[i]!.definition.detentStepRadians);
    }
  });
});
