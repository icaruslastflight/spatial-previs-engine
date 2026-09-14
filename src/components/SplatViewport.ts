/**
 * Gaussian splat viewport for the WebGPU/WebGL runtime.
 *
 * Wraps the splat renderer with the four things a previz viewport needs beyond
 * "draw the points":
 *
 *   1. progressive asynchronous loading, so a multi-hundred-megabyte capture
 *      starts showing geometry in seconds instead of blocking the tab;
 *   2. frustum culling over the capture's chunk bounds, because a phone GPU
 *      cannot afford to sort splats it will never draw;
 *   3. volumetric beam clipping, so a lighting beam volume terminates on the
 *      scanned surface instead of passing through the ground; and
 *   4. screen-space surface normals, so virtual fixtures actually shade the
 *      capture -- a splat carries no normal of its own, so without this a beam
 *      lands as a flat stencil with no sense of the surface it hits.
 *
 * BACKEND: @mkkellogg/gaussian-splats-3d renders through WebGL. The class is
 * written against a narrow internal interface so a WebGPU compute-shader
 * rasterizer can replace it without touching callers -- see `SplatBackend`.
 */

import * as THREE from 'three';
import { SITE_FRAME } from '../geo/GeoAnchor.ts';
import { createScanAlignmentMatrix } from '../geospatial/PointStateParkAnchor.ts';
import type { ScanAlignmentOptions } from '../geospatial/PointStateParkAnchor.ts';

/* -------------------------------------------------------------------------- */
/* Screen-space normals                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reconstruct view-space normals from a depth buffer.
 *
 * Gaussian splats have no surface normal: each splat is an oriented ellipsoid,
 * and its covariance says nothing reliable about which way the underlying
 * surface faces. The usable signal is the depth buffer -- the gradient of
 * reconstructed view-space position across neighbouring pixels IS the surface
 * tangent plane.
 *
 * Uses the smaller of the forward and backward difference on each axis, which
 * is what keeps depth discontinuities (a truss edge against distant ground)
 * from smearing a bogus normal across the silhouette.
 */
export const SCREEN_SPACE_NORMAL_SHADER = {
  uniforms: {
    tDepth: { value: null as THREE.Texture | null },
    uProjectionInverse: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 1000.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform vec2 uResolution;
    uniform float uCameraNear;
    uniform float uCameraFar;

    varying vec2 vUv;

    // Depth buffer sample -> view-space position.
    vec3 viewPositionAt(vec2 uv) {
      float depth = texture2D(tDepth, uv).x;
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uProjectionInverse * clip;
      return view.xyz / view.w;
    }

    void main() {
      vec2 texel = 1.0 / uResolution;
      vec3 centre = viewPositionAt(vUv);

      vec3 ddxPos = viewPositionAt(vUv + vec2(texel.x, 0.0)) - centre;
      vec3 ddxNeg = centre - viewPositionAt(vUv - vec2(texel.x, 0.0));
      vec3 ddyPos = viewPositionAt(vUv + vec2(0.0, texel.y)) - centre;
      vec3 ddyNeg = centre - viewPositionAt(vUv - vec2(0.0, texel.y));

      // Take the shorter difference on each axis: across a silhouette the far
      // side jumps, and averaging the two would tilt the normal into the gap.
      vec3 ddx = abs(ddxPos.z) < abs(ddxNeg.z) ? ddxPos : ddxNeg;
      vec3 ddy = abs(ddyPos.z) < abs(ddyNeg.z) ? ddyPos : ddyNeg;

      vec3 normal = normalize(cross(ddx, ddy));
      // Pack [-1,1] into [0,1] so this survives a standard RGBA8 target.
      gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
    }
  `,
};

/* -------------------------------------------------------------------------- */
/* Volumetric beam clipping                                                    */
/* -------------------------------------------------------------------------- */

export interface BeamVolume {
  /** Fixture position in local scene metres. */
  origin: THREE.Vector3;
  /** Unit direction the beam points. */
  direction: THREE.Vector3;
  /** Full cone angle, degrees. */
  coneAngleDegrees: number;
  /** Throw distance before the beam is cut, metres. */
  throwDistance: number;
  color: THREE.Color;
  intensity: number;
}

/**
 * Clipping planes that terminate a beam volume at its throw distance.
 *
 * Without this a beam cone is drawn as unbounded geometry and passes straight
 * through scanned terrain, which reads as a light shining through the ground.
 * The far plane cuts the cone where the operator said the throw ends; the
 * capture's own depth then occludes whatever remains.
 */
export function createBeamClippingPlanes(beam: BeamVolume): THREE.Plane[] {
  const direction = beam.direction.clone().normalize();
  const far = beam.origin.clone().addScaledVector(direction, beam.throwDistance);
  return [
    // Keep everything in front of the fixture...
    new THREE.Plane().setFromNormalAndCoplanarPoint(direction, beam.origin),
    // ...and behind the throw limit.
    new THREE.Plane().setFromNormalAndCoplanarPoint(direction.clone().negate(), far),
  ];
}

/** Cone geometry matching a beam volume, for additive volumetric rendering. */
export function createBeamMesh(beam: BeamVolume): THREE.Mesh {
  const radius = Math.tan(THREE.MathUtils.degToRad(beam.coneAngleDegrees) / 2) * beam.throwDistance;
  const geometry = new THREE.ConeGeometry(radius, beam.throwDistance, 24, 1, true);
  // ConeGeometry is built along +Y centred on the origin; shift so the apex is
  // at the fixture, then aim it.
  geometry.translate(0, -beam.throwDistance / 2, 0);

  const material = new THREE.MeshBasicMaterial({
    color: beam.color,
    transparent: true,
    opacity: 0.12 * beam.intensity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    clippingPlanes: createBeamClippingPlanes(beam),
    clipIntersection: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(beam.origin);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), beam.direction.clone().normalize());
  mesh.renderOrder = 10;
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Backend abstraction                                                         */
/* -------------------------------------------------------------------------- */

/** The narrow surface SplatViewport needs from a splat renderer. */
export interface SplatBackend {
  addSplatScene(url: string, options: Record<string, unknown>): Promise<void>;
  update(): void;
  render(): void;
  dispose(): Promise<void>;
}

export interface SplatSceneEntry {
  id: string;
  url: string;
  /** Georeference for this capture; defaults to the CP-1 fountain apex. */
  alignment?: ScanAlignmentOptions;
  /** Conservative world-space bounds, used for frustum culling. */
  boundsRadius?: number;
}

export interface SplatViewportOptions {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  /** Called as each capture finishes loading. */
  onSceneLoaded?: (entry: SplatSceneEntry, index: number, total: number) => void;
  /** Called when a capture fails; loading continues with the rest. */
  onSceneError?: (entry: SplatSceneEntry, error: unknown) => void;
}

/* -------------------------------------------------------------------------- */
/* Viewport                                                                    */
/* -------------------------------------------------------------------------- */

export class SplatViewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly scene: THREE.Scene;
  private readonly options: SplatViewportOptions;

  private backend: SplatBackend | null = null;
  private readonly loaded: SplatSceneEntry[] = [];
  private readonly beams = new Map<string, THREE.Mesh>();

  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();

  /** Frames whose splat scenes were entirely outside the frustum. */
  private culledFrames = 0;
  private lastCullTest = true;

  constructor(options: SplatViewportOptions) {
    this.options = options;
    this.renderer = options.renderer;
    this.camera = options.camera;
    this.scene = options.scene;

    // Beam clipping needs the global clipping stage enabled.
    this.renderer.localClippingEnabled = true;
  }

  get isLoaded(): boolean {
    return this.backend !== null && this.loaded.length > 0;
  }

  get loadedScenes(): readonly SplatSceneEntry[] {
    return this.loaded;
  }

  /**
   * Load captures progressively.
   *
   * Scenes are loaded one at a time rather than in parallel: the splat sorter
   * is single-threaded per scene, and two captures decompressing at once on a
   * phone drops frames badly enough to make the viewport feel broken. A failed
   * capture is reported and skipped, never fatal -- one bad scan should not
   * cost the operator the whole site.
   */
  async load(entries: SplatSceneEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const { Viewer } = await import('@mkkellogg/gaussian-splats-3d');
    this.backend = new Viewer({
      selfDrivenMode: false,
      renderer: this.renderer,
      camera: this.camera,
      threeScene: this.scene,
      useBuiltInControls: false,
      // Shared memory needs COOP/COEP cross-origin-isolation headers, which
      // free static hosts cannot set. Keep this off so $0 hosting works.
      sharedMemoryForWorkers: false,
    }) as SplatBackend;

    for (const [index, entry] of entries.entries()) {
      try {
        const matrix = createScanAlignmentMatrix(entry.alignment ?? {});
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        matrix.decompose(position, quaternion, scale);

        await this.backend.addSplatScene(entry.url, {
          position: [position.x, position.y, position.z],
          rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
          scale: [scale.x, scale.y, scale.z],
          showLoadingUI: false,
          // Stream geometry in as it arrives instead of waiting for the file.
          progressiveLoad: true,
        });

        this.loaded.push(entry);
        this.options.onSceneLoaded?.(entry, index + 1, entries.length);
      } catch (error) {
        console.error(`[SplatViewport] capture "${entry.id}" failed to load.`, error);
        this.options.onSceneError?.(entry, error);
      }
    }
  }

  /* ------------------------------------------------------------- lighting */

  /** Add or replace a lighting beam. */
  setBeam(id: string, beam: BeamVolume): void {
    this.removeBeam(id);
    const mesh = createBeamMesh(beam);
    mesh.name = `beam_${id}`;
    this.scene.add(mesh);
    this.beams.set(id, mesh);
  }

  removeBeam(id: string): void {
    const existing = this.beams.get(id);
    if (existing === undefined) return;
    this.scene.remove(existing);
    existing.geometry.dispose();
    (existing.material as THREE.Material).dispose();
    this.beams.delete(id);
  }

  get beamCount(): number {
    return this.beams.size;
  }

  /* -------------------------------------------------------------- culling */

  /**
   * Is any loaded capture inside the view frustum?
   *
   * The splat sorter is the expensive part of a splat frame and it runs over
   * the whole scene, so the win is skipping `update()` entirely when the camera
   * is looking away from the capture -- common on a site plan, where the
   * operator spends most of their time inside the build looking outward.
   */
  updateCulling(): boolean {
    if (this.loaded.length === 0) return false;

    this.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.viewProjection);

    for (const entry of this.loaded) {
      const matrix = createScanAlignmentMatrix(entry.alignment ?? {});
      this.cullSphere.center.setFromMatrixPosition(matrix);
      // Default radius is generous: a walked park capture is hundreds of metres
      // across, and wrongly culling a visible capture is far worse than
      // occasionally sorting one that is off screen.
      this.cullSphere.radius = entry.boundsRadius ?? 400;
      if (this.frustum.intersectsSphere(this.cullSphere)) {
        this.lastCullTest = true;
        return true;
      }
    }

    this.culledFrames++;
    this.lastCullTest = false;
    return false;
  }

  get stats(): { loadedScenes: number; culledFrames: number; visible: boolean; beams: number } {
    return {
      loadedScenes: this.loaded.length,
      culledFrames: this.culledFrames,
      visible: this.lastCullTest,
      beams: this.beams.size,
    };
  }

  /* ---------------------------------------------------------------- frame */

  /**
   * Draw one frame.
   *
   * Returns true when the splat backend owned the draw call. When it did, the
   * caller must NOT also call renderer.render(): the backend composites splats
   * and ordinary meshes together in a single pass, and a second render would
   * draw the scene twice.
   */
  render(): boolean {
    if (this.backend === null || this.loaded.length === 0) return false;
    if (!this.updateCulling()) {
      // Nothing on screen: skip the sort, draw the ordinary scene only.
      return false;
    }
    this.backend.update();
    this.backend.render();
    return true;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.beams.keys()]) this.removeBeam(id);
    if (this.backend !== null) {
      await this.backend.dispose().catch(() => undefined);
      this.backend = null;
    }
    this.loaded.length = 0;
  }
}

/** Re-exported so a caller needs one import to place a capture geographically. */
export { SITE_FRAME };
