import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { engineLoop, TICK_PRIORITY } from '../core/EngineLoop.ts';
import type { ProductionProject } from '../domain/ProductionProject.ts';
import { liftSockets, prepareSceneMove } from './ProductionScene.ts';
import type { SceneMove } from './ProductionScene.ts';

export interface CatalogAsset { id: string; name: string; category: string; url: string }

/** A read-only projection of committed records; domain state never comes from mesh UUIDs. */
export class ProductionViewport {
  #renderer: THREE.WebGLRenderer;
  #scene = new THREE.Scene();
  #camera = new THREE.PerspectiveCamera(48, 1, 0.05, 2000);
  #controls: OrbitControls;
  get scene() { return this.#scene; }
  get camera() { return this.#camera; }
  #layer = new THREE.Group();
  #highlight = new THREE.BoxHelper(new THREE.Object3D(), 0xe4bf79);
  #templates = new Map<string, Promise<THREE.Object3D>>();
  #objects = new Map<string, THREE.Object3D>();
  #generation = 0;
  #selected: string | null = null;
  #catalog: CatalogAsset[];
  #canvas: HTMLCanvasElement;
  #plan = false;
  #project: ProductionProject | null = null;
  #interactionReady = false;
  #cancelDrag = () => {};

  constructor(canvas: HTMLCanvasElement, catalog: CatalogAsset[], select: (id: string) => void,
    commit: (move: SceneMove, baseRevision: number) => void, notify: (message: string) => void) {
    this.#canvas = canvas; this.#catalog = catalog;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#renderer.setClearColor(0x232827);
    this.#scene.add(this.#layer, this.#highlight, new THREE.HemisphereLight(0xe3e9e8, 0x444843, 2.8));
    const sun = new THREE.DirectionalLight(0xfff1d7, 3); sun.position.set(8, 12, 6); this.#scene.add(sun);
    const grid = new THREE.GridHelper(40, 40, 0x68716b, 0x414843); grid.position.y = -0.01; this.#scene.add(grid);
    this.#camera.position.set(7, 6, 9);
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.target.set(0, 1, 0); this.#controls.enableDamping = true;
    this.#controls.maxPolarAngle = Math.PI * 0.495;
    this.#controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.#controls.update(); this.#highlight.visible = false;
    new ResizeObserver(() => this.#resize()).observe(canvas.parentElement!);
    this.#resize();
    let start: [number, number] = [0, 0], multiple = false;
    let drag: { id: string; pointerId: number; project: ProductionProject; plane: THREE.Plane;
      offset: THREE.Vector3; move: SceneMove | null } | null = null;
    const pointers = new Set<number>();
    const ray = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect(), caster = new THREE.Raycaster();
      caster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1,
        -(e.clientY - rect.top) / rect.height * 2 + 1), this.#camera);
      return caster;
    };
    const pick = (e: PointerEvent) => {
      let object: THREE.Object3D | null = ray(e).intersectObjects(this.#layer.children, true)[0]?.object ?? null;
      while (object && typeof object.userData['instance_id'] !== 'string') object = object.parent;
      return object;
    };
    const restore = () => {
      if (!drag) return;
      for (const r of drag.project.records) if (r.kind === 'asset_instance') {
        const object = this.#objects.get(r.id);
        object?.position.fromArray(r.transform.position); object?.quaternion.fromArray(r.transform.rotation);
      }
      this.#layer.updateMatrixWorld(true); this.select(this.#selected);
    };
    this.#cancelDrag = () => { restore(); drag = null; this.#controls.enabled = true; };
    canvas.addEventListener('pointerdown', e => {
      if (pointers.size === 0) { start = [e.clientX, e.clientY]; multiple = false; }
      pointers.add(e.pointerId); if (pointers.size > 1) multiple = true;
      if (multiple) { this.#cancelDrag(); return; }
      if (e.button !== 0 || !this.#interactionReady || !this.#project) return;
      const object = pick(e), id = object?.userData['instance_id'] as string | undefined;
      if (!id || !object || this.#project.records.find(r => r.id === id)?.locked) return;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), object.position);
      const hit = ray(e).ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return;
      drag = { id, pointerId: e.pointerId, project: structuredClone(this.#project), plane,
        offset: object.position.clone().sub(hit), move: null };
      canvas.setPointerCapture(e.pointerId);
    }, true);
    canvas.addEventListener('pointermove', e => {
      if (!drag || drag.pointerId !== e.pointerId || multiple || Math.hypot(e.clientX - start[0], e.clientY - start[1]) <= 6) return;
      this.#controls.enabled = false;
      const hit = ray(e).ray.intersectPlane(drag.plane, new THREE.Vector3());
      if (!hit) return;
      try {
        const position = hit.add(drag.offset).toArray() as [number, number, number];
        const move = prepareSceneMove(drag.project, this.#objects, drag.id, position);
        // Do not preview a move that visibly displaces a locked object or edge.
        if (move.operations.some(op => drag!.project.records.find(r => r.id === (op.type === 'put' ? op.record.id : op.id))?.locked)) {
          throw new Error('Move blocked by a locked record');
        }
        restore(); drag.move = move;
        for (const [id, transform] of move.transforms) {
          this.#objects.get(id)!.position.fromArray(transform.position);
          this.#objects.get(id)!.quaternion.fromArray(transform.rotation);
        }
        this.#layer.updateMatrixWorld(true); this.select(drag.id);
        notify(move.snapped ? 'Socket candidate · release to commit, Escape to cancel' : 'Moving · release to commit, Escape to cancel');
      } catch (e) { this.#cancelDrag(); notify(e instanceof Error ? e.message : String(e)); }
    }, true);
    canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); multiple = true; this.#cancelDrag(); }, true);
    canvas.addEventListener('pointerup', e => {
      pointers.delete(e.pointerId);
      const pending = drag; this.#cancelDrag();
      if (pending?.move && !multiple) {
        if (pending.move.operations.length) commit(pending.move, pending.project.revision);
        select(pending.id); return;
      }
      if (!this.#interactionReady || e.button !== 0 || multiple || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 6) return;
      const object = pick(e);
      if (object) select(object.userData['instance_id'] as string);
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this.#cancelDrag(); notify('Gesture canceled; project unchanged'); } });
    engineLoop.register(TICK_PRIORITY.RENDER, () => { this.#controls.update(); this.#renderer.render(this.#scene, this.#camera); });
    engineLoop.start();
  }
  #resize(): void {
    const { clientWidth: width, clientHeight: height } = this.#canvas.parentElement!;
    if (!width || !height) return;
    this.#camera.aspect = width / height; this.#camera.updateProjectionMatrix();
    this.#renderer.setSize(width, height, false);
  }
  async #asset(id: string): Promise<THREE.Object3D> {
    let pending = this.#templates.get(id);
    if (!pending) {
      const asset = this.#catalog.find(a => a.id === id);
      if (!asset) throw new Error(`Catalog asset unavailable: ${id}`);
      pending = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}${asset.url}`).then(gltf => { liftSockets(gltf.scene); return gltf.scene; });
      this.#templates.set(id, pending);
      pending.catch(() => this.#templates.delete(id));
    }
    return (await pending).clone(true);
  }
  async sync(project: ProductionProject): Promise<boolean> {
    this.#cancelDrag(); this.#interactionReady = false;
    const generation = ++this.#generation;
    const layer = new THREE.Group(), objects = new Map<string, THREE.Object3D>();
    const instances = project.records.filter(r => r.kind === 'asset_instance');
    const loaded = await Promise.all(instances.map(async instance => {
      const definition = project.records.find(r => r.id === instance.definitionId);
      if (definition?.kind !== 'asset_definition') throw new Error('Missing asset definition');
      const object = await this.#asset(definition.catalogId);
      object.userData['instance_id'] = instance.id;
      object.userData['asset_id'] = definition.catalogId;
      object.position.fromArray(instance.transform.position); object.quaternion.fromArray(instance.transform.rotation);
      return { object, id: instance.id };
    }));
    if (generation !== this.#generation) return false;
    for (const { object, id } of loaded) { layer.add(object); objects.set(id, object); }
    // Replacement happens only once all assets exist. A failed or obsolete load keeps the previous scene.
    this.#scene.remove(this.#layer); this.#layer = layer; this.#objects = objects; this.#scene.add(layer);
    layer.updateMatrixWorld(true); this.select(this.#selected);
    this.#project = structuredClone(project); this.#interactionReady = true;
    return true;
  }
  snap(id: string): SceneMove {
    if (!this.#interactionReady || !this.#project) throw new Error('Wait for the scene before snapping');
    const record = this.#project.records.find(r => r.id === id);
    if (record?.kind !== 'asset_instance') throw new Error('Select equipment first');
    const move = prepareSceneMove(this.#project, this.#objects, id, record.transform.position);
    if (!move.snapped || !move.operations.length) throw new Error('No new compatible socket is within the capture radius');
    return move;
  }
  select(id: string | null): void {
    this.#selected = id;
    const object = id ? this.#objects.get(id) : undefined;
    this.#highlight.visible = !!object;
    if (object) this.#highlight.setFromObject(object);
  }
  frame(): void {
    if (!this.#layer.children.length) return;
    const box = new THREE.Box3().setFromObject(this.#layer), center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length(), 3);
    this.#controls.target.copy(center); this.#camera.position.copy(center).add(this.#plan
      ? new THREE.Vector3(0, radius * 1.8, 0.001) : new THREE.Vector3(radius, radius * 0.7, radius));
    this.#controls.update();
  }
  plan(enabled: boolean): void {
    if (enabled === this.#plan) return;
    this.#plan = enabled;
    this.#controls.enableRotate = !enabled;
    if (enabled) this.#camera.position.copy(this.#controls.target).add(new THREE.Vector3(0, 18, 0.001));
    else this.#camera.position.copy(this.#controls.target).add(new THREE.Vector3(7, 6, 9));
    this.#controls.update();
  }
}
