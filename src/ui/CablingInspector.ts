import * as THREE from 'three';
import { DragControls } from 'three/examples/jsm/controls/DragControls.js';
import { TrussCableRouter } from '../engine/TrussCableRouter.ts';
import type { CableRoute } from '../engine/TrussCableRouter.ts';
import type { ProductionProject } from '../domain/ProductionProject.ts';


export class CablingInspector {
  #scene: THREE.Scene;
  #camera: THREE.Camera;
  #canvas: HTMLCanvasElement;
  #cableGroup = new THREE.Group();
  #handleGroup = new THREE.Group();
  #dragControls: DragControls;
  #routes: CableRoute[] = [];
  #project: ProductionProject;

  constructor(scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement, project: ProductionProject) {
    this.#scene = scene;
    this.#camera = camera;
    this.#canvas = canvas;
    this.#project = project;

    this.#scene.add(this.#cableGroup);
    this.#scene.add(this.#handleGroup);

    this.#dragControls = new DragControls(this.#handleGroup.children, this.#camera, this.#canvas);
    
    this.#dragControls.addEventListener('dragstart', () => {
      // Disable orbit controls while dragging
      this.#canvas.dispatchEvent(new CustomEvent('disable-orbit'));
    });
    
    this.#dragControls.addEventListener('drag', (event) => {
      // Rebuild specific cable on handle drag
      this.rebuildCableFromHandles(event.object.userData.cableIndex);
    });

    this.#dragControls.addEventListener('dragend', () => {
      // Enable orbit controls
      this.#canvas.dispatchEvent(new CustomEvent('enable-orbit'));
    });
  }

  public renderRoutes() {
    // Clear previous
    this.#cableGroup.clear();
    this.#handleGroup.clear();

    this.#routes = TrussCableRouter.routeCables(this.#project);
    
    this.#routes.forEach((route, index) => {
      this.buildCableMesh(route, index);
    });

    // Update drag controls with new handles
    this.#dragControls.dispose();
    this.#dragControls = new DragControls(this.#handleGroup.children, this.#camera, this.#canvas);
  }

  private buildCableMesh(route: CableRoute, index: number) {
    // Material based on domain
    let color = 0x222222; // power
    if (route.domain === 'dmx') color = 0x8822ff;
    if (route.domain === 'network') color = 0x2288ff;
    if (route.domain === 'audio') color = 0x22ff22;

    const material = new THREE.MeshPhysicalMaterial({ color, roughness: 0.8, clearcoat: 0.1 });
    const curve = new THREE.CatmullRomCurve3(route.points);
    const geometry = new THREE.TubeGeometry(curve, 64, 0.02, 8, false);
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `cable_${route.connectionId}`;
    this.#cableGroup.add(mesh);

    // Create drag handles for intermediate points
    for (let i = 1; i < route.points.length - 1; i++) {
      const handleGeo = new THREE.SphereGeometry(0.05, 16, 16);
      const handleMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
      const handle = new THREE.Mesh(handleGeo, handleMat);
      handle.position.copy(route.points[i]);
      handle.userData = { cableIndex: index, pointIndex: i };
      this.#handleGroup.add(handle);
    }
  }

  private rebuildCableFromHandles(cableIndex: number) {
    const route = this.#routes[cableIndex];
    if (!route) return;

    // Update route points from handles
    this.#handleGroup.children.forEach(child => {
      if (child.userData.cableIndex === cableIndex) {
        route.points[child.userData.pointIndex].copy(child.position);
      }
    });

    // Find and replace the mesh
    const oldMesh = this.#cableGroup.getObjectByName(`cable_${route.connectionId}`);
    if (oldMesh) {
      this.#cableGroup.remove(oldMesh);
      (oldMesh as THREE.Mesh).geometry.dispose();
    }

    // Recalculate length
    let length = 0;
    for (let i = 0; i < route.points.length - 1; i++) {
      length += route.points[i].distanceTo(route.points[i+1]);
    }
    route.length = length;

    const material = new THREE.MeshPhysicalMaterial({ color: route.domain === 'dmx' ? 0x8822ff : 0x222222 });
    const curve = new THREE.CatmullRomCurve3(route.points);
    const geometry = new THREE.TubeGeometry(curve, 64, 0.02, 8, false);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `cable_${route.connectionId}`;
    this.#cableGroup.add(mesh);
  }

  public exportCableSchedule() {
    let csv = 'Connection ID,Source Instance ID,Target Instance ID,Domain,Length (m)\n';
    this.#routes.forEach(r => {
      csv += `${r.connectionId},${r.sourceInstanceId},${r.targetInstanceId},${r.domain},${r.length.toFixed(2)}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cable-schedule-${this.#project.revision}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  public destroy() {
    this.#dragControls.dispose();
    this.#cableGroup.clear();
    this.#handleGroup.clear();
  }
}
