/**
 * Touch-first drag-and-snap for modular show assets.
 *
 * GESTURE CONTRACT (phone is the primary target, so this matters)
 *   one finger on an asset  -> drag that asset across the ground plane
 *   one finger on empty sky -> orbit the camera
 *   two fingers, always     -> pinch-zoom / pan the camera, never drag an asset
 *
 * A second finger landing mid-drag ABORTS the drag and returns the asset to
 * where it was grabbed, then hands the gesture to the camera. Without that, a
 * pinch started fractionally late would fling an asset across the site.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SnapCandidate, SocketSnappingEngine } from '../engine/SocketSnappingEngine.ts';

export interface DragSnapControllerOptions {
  domElement: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /**
   * Container the draggable assets live in. Assets are reparented into it when
   * a kinematic link is broken, and the snap marker is added to it. Any
   * Object3D will do -- it need not be the root Scene.
   */
  scene: THREE.Object3D;
  controls: OrbitControls;
  engine: SocketSnappingEngine;
  /** Fired when a drag commits to a snap. */
  onSnap?: (candidate: SnapCandidate) => void;
  /** Fired as a live candidate appears or clears, for HUD feedback. */
  onCandidateChange?: (candidate: SnapCandidate | null) => void;
  /** Fired when a drag starts or ends. */
  onDragStateChange?: (dragging: boolean) => void;
}

/** Emissive tint applied to an asset while a snap is live under it. */
const SNAP_HIGHLIGHT = new THREE.Color(0x1e6fff);

export class DragSnapController {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly scene: THREE.Object3D;
  private readonly controls: OrbitControls;
  private readonly engine: SocketSnappingEngine;
  private readonly options: DragSnapControllerOptions;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly dragPlane = new THREE.Plane();
  private readonly grabOffset = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();

  private readonly activePointers = new Set<number>();
  private dragging: THREE.Object3D | null = null;
  private dragPointerId: number | null = null;
  private dragOrigin = new THREE.Vector3();
  private dragOriginQuaternion = new THREE.Quaternion();
  private liveCandidate: SnapCandidate | null = null;

  /** Marker drawn at the target socket while a snap is live. */
  private readonly snapMarker: THREE.Mesh;
  private readonly highlighted = new Map<THREE.MeshStandardMaterial, THREE.Color>();

  constructor(options: DragSnapControllerOptions) {
    this.options = options;
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.scene = options.scene;
    this.controls = options.controls;
    this.engine = options.engine;

    this.snapMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 16, 12),
      new THREE.MeshBasicMaterial({ color: SNAP_HIGHLIGHT, transparent: true, opacity: 0.85 }),
    );
    this.snapMarker.visible = false;
    this.snapMarker.renderOrder = 999;
    this.scene.add(this.snapMarker);

    // touch-action:none is what lets a one-finger drag reach us at all; without
    // it the browser claims the gesture for scrolling.
    this.domElement.style.touchAction = 'none';
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerUp);
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.scene.remove(this.snapMarker);
    this.snapMarker.geometry.dispose();
    (this.snapMarker.material as THREE.Material).dispose();
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }

  /* ---------------------------------------------------------------- picking */

  private updateNdc(event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Walk up from a hit mesh to the nearest registered asset. Assets are
   * reparented into kinematic chains on snap, so the nearest registered
   * ancestor -- not the chain root -- is the thing the operator grabbed.
   */
  private findRegisteredRoot(object: THREE.Object3D): THREE.Object3D | null {
    let node: THREE.Object3D | null = object;
    while (node !== null) {
      if (this.engine.isRegistered(node)) return node;
      node = node.parent;
    }
    return null;
  }

  private pickAsset(event: PointerEvent): THREE.Object3D | null {
    this.updateNdc(event);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const targets = this.engine.registeredObjects as THREE.Object3D[];
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      const root = this.findRegisteredRoot(hit.object);
      if (root !== null) return root;
    }
    return null;
  }

  /* ------------------------------------------------------------- highlights */

  private setHighlight(object: THREE.Object3D | null): void {
    for (const [material, original] of this.highlighted) {
      material.emissive.copy(original);
    }
    this.highlighted.clear();
    if (object === null) return;

    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial) {
          this.highlighted.set(material, material.emissive.clone());
          material.emissive.copy(SNAP_HIGHLIGHT).multiplyScalar(0.35);
        }
      }
    });
  }

  private setCandidate(candidate: SnapCandidate | null): void {
    const changed =
      (candidate === null) !== (this.liveCandidate === null) ||
      (candidate !== null &&
        this.liveCandidate !== null &&
        (candidate.target.definition.socket_id !== this.liveCandidate.target.definition.socket_id ||
          candidate.moving.definition.socket_id !== this.liveCandidate.moving.definition.socket_id));

    this.liveCandidate = candidate;

    if (candidate === null) {
      this.snapMarker.visible = false;
      this.setHighlight(null);
    } else {
      this.snapMarker.visible = true;
      this.snapMarker.position.copy(candidate.target.position);
      this.setHighlight(this.dragging);
    }

    if (changed) this.options.onCandidateChange?.(candidate);
  }

  /* ------------------------------------------------------------------ drags */

  private cancelDrag(restore: boolean): void {
    if (this.dragging === null) return;
    if (restore) {
      this.dragging.position.copy(this.dragOrigin);
      this.dragging.quaternion.copy(this.dragOriginQuaternion);
      this.dragging.updateMatrixWorld(true);
    }
    this.setCandidate(null);
    this.setHighlight(null);
    if (this.dragPointerId !== null && this.domElement.hasPointerCapture(this.dragPointerId)) {
      this.domElement.releasePointerCapture(this.dragPointerId);
    }
    this.dragging = null;
    this.dragPointerId = null;
    this.controls.enabled = true;
    this.options.onDragStateChange?.(false);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.activePointers.add(event.pointerId);

    // Second finger down: this is a camera gesture, not an asset drag.
    if (this.activePointers.size > 1) {
      this.cancelDrag(true);
      return;
    }

    const asset = this.pickAsset(event);
    if (asset === null) return; // empty space -> let OrbitControls orbit

    this.dragging = asset;
    this.dragPointerId = event.pointerId;
    this.dragOrigin.copy(asset.position);
    this.dragOriginQuaternion.copy(asset.quaternion);

    // An asset already mated into a chain must be freed before it can move.
    this.engine.unlink(asset, this.scene);

    const worldPosition = asset.getWorldPosition(new THREE.Vector3());
    // Drag across the horizontal plane through the grab point: the operator
    // slides assets around the site and lets snapping resolve height.
    this.dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), worldPosition);

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hitPoint) !== null) {
      this.grabOffset.copy(worldPosition).sub(this.hitPoint);
    } else {
      this.grabOffset.set(0, 0, 0);
    }

    this.controls.enabled = false;
    this.domElement.setPointerCapture(event.pointerId);
    this.options.onDragStateChange?.(true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.dragging === null || event.pointerId !== this.dragPointerId) return;

    this.updateNdc(event);
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hitPoint) === null) return;

    this.hitPoint.add(this.grabOffset);
    // The asset sits at the scene root while dragging, so world == local here.
    this.dragging.position.copy(this.hitPoint);
    this.dragging.updateMatrixWorld(true);

    this.setCandidate(this.engine.findSnapCandidate(this.dragging));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.dragging === null || event.pointerId !== this.dragPointerId) return;

    const candidate = this.liveCandidate;
    const dragged = this.dragging;

    // Clear drag state first so applySnap's reparenting is not fighting it.
    this.setCandidate(null);
    this.setHighlight(null);
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
    this.dragging = null;
    this.dragPointerId = null;
    this.controls.enabled = true;
    this.options.onDragStateChange?.(false);

    if (candidate !== null) {
      // Re-resolve against the final pointer position: the candidate cached on
      // the last move may be one frame stale.
      const fresh = this.engine.findSnapCandidate(dragged);
      if (fresh !== null) {
        this.engine.applySnap(fresh);
        this.options.onSnap?.(fresh);
      }
    }
  };
}
