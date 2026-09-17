import * as THREE from 'three';
import { SocketSnappingEngine, readSockets, writeSockets } from '../engine/SocketSnappingEngine.ts';
import type { SocketDefinition } from '../engine/SocketSnappingEngine.ts';
import { createRecordId } from '../domain/ProductionProject.ts';
import type { ProductionProject, Transform } from '../domain/ProductionProject.ts';
import type { Operation } from '../domain/ProjectStore.ts';

/** Lift glTF-node sockets to the wrapper's local frame, preserving the shared socket contract. */
export function liftSockets(root: THREE.Object3D): void {
  if (readSockets(root).length) return;
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert(), sockets: SocketDefinition[] = [];
  root.traverse(node => {
    if (node === root) return;
    const matrix = inverse.clone().multiply(node.matrixWorld);
    for (const socket of readSockets(node)) {
      if (sockets.some(s => s.socket_id === socket.socket_id)) throw new Error('Duplicate asset socket ID');
      sockets.push({ socket_id: socket.socket_id, socket_type: socket.socket_type, gender: socket.gender,
        transform: {
          translation: new THREE.Vector3().fromArray(socket.position).applyMatrix4(matrix).toArray() as [number, number, number],
          normal: new THREE.Vector3().fromArray(socket.normal).transformDirection(matrix).toArray() as [number, number, number],
          up: new THREE.Vector3().fromArray(socket.up).transformDirection(matrix).toArray() as [number, number, number],
        },
        tolerances: { snap_radius: socket.snapRadius, snap_angle: THREE.MathUtils.radToDeg(socket.snapAngleRadians), detents_deg: [0, THREE.MathUtils.radToDeg(socket.detentStepRadians)] },
        kinematic_rules: { can_parent: socket.canParent, can_child: socket.canChild, load_bearing: socket.loadBearing,
          ...(socket.maxLoadKg === null ? {} : { max_load_kg: socket.maxLoadKg }) }, tags: [...socket.tags],
      });
    }
  });
  if (sockets.length) writeSockets(root, sockets);
}

export interface SceneMove { operations: Operation[]; transforms: Map<string, Transform>; snapped: boolean }

/** Resolve gestures on clones. Domain records and visible geometry are untouched until the caller previews/commits. */
export function prepareSceneMove(project: ProductionProject, source: ReadonlyMap<string, THREE.Object3D>, id: string,
  position: [number, number, number], useSnapping = true): SceneMove {
  const layer = new THREE.Group(), objects = new Map<string, THREE.Object3D>(), engine = new SocketSnappingEngine();
  for (const record of project.records) {
    if (record.kind !== 'asset_instance') continue;
    const original = source.get(record.id);
    if (!original) throw new Error('Wait for scene geometry before moving equipment');
    const object = original.clone(true);
    object.position.fromArray(record.transform.position); object.quaternion.fromArray(record.transform.rotation);
    layer.add(object); objects.set(record.id, object);
    if (readSockets(object).length) engine.register(object);
  }
  const moving = objects.get(id);
  if (!moving) throw new Error('Unknown equipment instance');
  layer.updateMatrixWorld(true);
  // Restore recorded hierarchy/reservations without recalculating or shifting an imported pose.
  for (const edge of project.records) {
    if (edge.kind !== 'mechanical_attachment') continue;
    const child = objects.get(edge.childInstanceId)!, parent = objects.get(edge.parentInstanceId)!;
    const childSocket = engine.getWorldSockets(child).find(s => s.definition.socket_id === edge.childSocketId);
    const parentSocket = engine.getWorldSockets(parent).find(s => s.definition.socket_id === edge.parentSocketId);
    if (!childSocket || !parentSocket) throw new Error('Recorded attachment socket is unavailable; inspect or unlink it before dragging');
    engine.applySnap({ moving: childSocket, target: parentSocket, distance: childSocket.position.distanceTo(parentSocket.position),
      resolvedPosition: child.getWorldPosition(new THREE.Vector3()), resolvedQuaternion: child.getWorldQuaternion(new THREE.Quaternion()), detentDegrees: 0 });
  }
  engine.unlink(moving, layer);
  moving.position.fromArray(position); layer.updateMatrixWorld(true);
  const snap = useSnapping ? engine.findSnapCandidate(moving) : null;
  if (snap) engine.applySnap(snap);
  layer.updateMatrixWorld(true);
  const operations: Operation[] = [], transforms = new Map<string, Transform>();
  for (const record of project.records) {
    if (record.kind !== 'asset_instance') continue;
    const object = objects.get(record.id)!;
    const transform: Transform = {
      position: object.getWorldPosition(new THREE.Vector3()).toArray() as Transform['position'],
      rotation: object.getWorldQuaternion(new THREE.Quaternion()).toArray() as Transform['rotation'],
    };
    // Matrix decomposition can introduce insignificant floating-point noise on unchanged objects.
    const delta = Math.max(...transform.position.map((n, i) => Math.abs(n - record.transform.position[i]!)),
      ...transform.rotation.map((n, i) => Math.abs(n - record.transform.rotation[i]!)));
    if (delta > 1e-9) { transforms.set(record.id, transform); operations.push({ type: 'put', record: { ...record, transform } }); }
  }
  const previous = project.records.find(r => r.kind === 'mechanical_attachment' && r.childInstanceId === id);
  const parentId = snap ? [...objects].find(([, object]) => object === snap.target.owner)![0] : null;
  const sameEdge = previous?.kind === 'mechanical_attachment' && snap && previous.parentInstanceId === parentId
    && previous.childSocketId === snap.moving.definition.socket_id && previous.parentSocketId === snap.target.definition.socket_id;
  if (previous && !sameEdge) operations.push({ type: 'remove', id: previous.id });
  if (snap && !sameEdge) operations.push({ type: 'put', record: {
    id: createRecordId('mechanical_attachment'), kind: 'mechanical_attachment', label: 'Socket attachment', locked: false,
    parentInstanceId: parentId!, childInstanceId: id,
    parentSocketId: snap.target.definition.socket_id, childSocketId: snap.moving.definition.socket_id,
  } });
  return { operations, transforms, snapped: !!snap };
}
