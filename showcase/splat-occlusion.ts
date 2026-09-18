/**
 * Splat depth-pass spike — Phase 0 of `docs/research/GAUSSIAN_SPLAT_LIGHTING.md`.
 *
 * The question this page answers on screen: can the splat renderer be made to
 * leave a depth buffer behind, so beams and meshes drawn afterwards occlude
 * against the scanned surface?
 *
 * Three modes, chosen by `?mode=`:
 *
 *   before  The library's own `Viewer.render()`: Three scene first, then splats
 *           with `depthWrite: false`. Beam cones live in the Three scene, as
 *           they do in `SplatViewport`. Expect Beam 1 to vanish wherever the
 *           near wall overlaps it on screen, even though the beam is in front.
 *   after   Our sequence: splat mesh depth-only → opaque scene → splat colour →
 *           beams. Same material, toggled between passes by one uniform.
 *   depth   The depth-only pass alone, linearized to greyscale, so the buffer
 *           the "after" mode relies on is visible rather than inferred.
 *
 * Nothing is mocked: the capture is the pipeline's synthesized park
 * (`python scripts/cleanup_splat.py --synthesize ...`), loaded through the real
 * viewer, and the cones come from `SplatViewport.createBeamMesh`.
 *
 * KNOWN RESULT (Phase 0 finding, see docs/research/GAUSSIAN_SPLAT_LIGHTING.md):
 * "after" and "depth" currently render beams and truss but NO splats. Traced
 * to `SplatMesh.material.uniforms.viewport/basisViewport/focal` staying
 * `[0, 0]` in this custom render sequence, even after explicitly calling
 * `Viewer.update()`, `Viewer.render()` and `Viewer.updateForRendererSizeChanges()`
 * -- all three are supposed to populate them via `SplatMesh.updateUniforms()`
 * (confirmed by reading the 0.4.7 source), but do not here. Since
 * `ndcOffset` in the vertex shader is scaled by `basisViewport`, a zeroed
 * uniform collapses every splat quad to a point. "before" mode (the
 * library's own `Viewer.render()`, untouched) is unaffected and renders
 * correctly -- this is specific to compositing splat draws by hand. Left
 * unresolved pending Phase 1: the likely fix is patching
 * `Viewer.prototype.render` itself to inject the depth pre-pass where these
 * uniforms are already known-valid, rather than driving
 * `renderer.render(mesh, camera)` externally.
 */

import * as THREE from 'three';
import { Viewer } from '@mkkellogg/gaussian-splats-3d';

import { createBeamMesh } from '../src/components/SplatViewport.ts';
import type { BeamVolume } from '../src/components/SplatViewport.ts';

type Mode = 'before' | 'after' | 'depth';

const SPLAT_URL = '/assets/scans/point_state_park/synthetic_raw.splat';

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const status = document.getElementById('status') as HTMLDivElement;
const modeLabel = document.getElementById('mode-label') as HTMLElement;

function readMode(): Mode {
  const raw = new URLSearchParams(location.search).get('mode');
  return raw === 'before' || raw === 'depth' ? raw : 'after';
}

const mode = readMode();
for (const link of document.querySelectorAll<HTMLAnchorElement>('#modes a')) {
  link.classList.toggle('active', link.dataset.mode === mode);
}
modeLabel.textContent = {
  before: 'Mode: BEFORE — library render order, splats write no depth.',
  after: 'Mode: AFTER — splat depth-only pre-pass, then scene, splat colour, beams.',
  depth: 'Mode: DEPTH — the depth-only pass alone, linearized.',
}[mode];

/* -------------------------------------------------------------------------- */
/* Renderer and camera                                                        */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
// Beam cones clip against their throw planes.
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);

// Transparent beams are kept out of `scene` in the "after" modes so they can be
// drawn last, once splat depth exists. In "before" they sit in the scene, which
// is how `SplatViewport.setBeam` places them today.
const beamLayer = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(15, 5.5, -31);
camera.lookAt(25, 2, -10);

scene.add(new THREE.HemisphereLight(0x8fa4c8, 0x1a1c24, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(-10, 14, -20);
scene.add(key);

/* -------------------------------------------------------------------------- */
/* Stage hardware                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ground height of the synthesized capture (`cleanup_splat.py`,
 * `synthesize_capture.ground_height`), used only to aim beams at the turf.
 */
function groundHeight(x: number, z: number): number {
  return -0.018 * x - 0.012 * z + 0.35 * Math.exp(-((x + 18) ** 2) / 260);
}

/** A 3 m F34-proportioned stick, laid along X. */
function trussStick(x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(3, 0.29, 0.29),
    new THREE.MeshStandardMaterial({ color: 0xb8c0d0, roughness: 0.4, metalness: 0.8 }),
  );
  mesh.position.set(x, y, z);
  return mesh;
}

// In front of the near pavilion wall (z = -12) and between the two walls.
scene.add(trussStick(24, 1.5, -17));
scene.add(trussStick(24, 1.5, -8));

interface BeamSpec {
  name: string;
  fixture: THREE.Vector3;
  target: THREE.Vector3;
  color: number;
  /** Extra throw past the target, metres. Beam 3 uses it to pierce the ground. */
  overshoot: number;
}

const BEAMS: BeamSpec[] = [
  {
    name: 'beam 1 (in front of wall)',
    fixture: new THREE.Vector3(21, 6.5, -19),
    target: new THREE.Vector3(21, groundHeight(21, -14), -14),
    color: 0x6ee7ff,
    overshoot: 0.2,
  },
  {
    name: 'beam 2 (behind wall)',
    fixture: new THREE.Vector3(27, 7.5, -8),
    target: new THREE.Vector3(27, groundHeight(27, -6), -6),
    color: 0xffb454,
    overshoot: 0.2,
  },
  {
    name: 'beam 3 (through ground)',
    fixture: new THREE.Vector3(15, 5, -24),
    target: new THREE.Vector3(15, groundHeight(15, -20), -20),
    color: 0xff5fd2,
    overshoot: 5,
  },
];

function buildBeams(): THREE.Mesh[] {
  return BEAMS.map((spec) => {
    const direction = spec.target.clone().sub(spec.fixture);
    const volume: BeamVolume = {
      origin: spec.fixture,
      direction: direction.clone().normalize(),
      coneAngleDegrees: 22,
      throwDistance: direction.length() + spec.overshoot,
      color: new THREE.Color(spec.color),
      intensity: 4,
    };
    const mesh = createBeamMesh(volume);
    mesh.name = spec.name;
    return mesh;
  });
}

for (const beam of buildBeams()) {
  (mode === 'before' ? scene : beamLayer).add(beam);
}

/* -------------------------------------------------------------------------- */
/* Depth-only toggle                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Patch the viewer's splat material with a depth-only switch.
 *
 * The library's vertex shader already places every quad fragment at the
 * splat centre's NDC depth, so all the depth pass needs is `depthWrite` on and
 * a discard for fragments too faint to count as surface. The 0.5 threshold is
 * a first guess; the "depth" mode exists to judge it.
 */
function patchDepthToggle(material: THREE.ShaderMaterial): void {
  const declaration = 'uniform vec3 debugColor;';
  const output = 'gl_FragColor = vec4(color.rgb, opacity);';
  if (!material.fragmentShader.includes(declaration) || !material.fragmentShader.includes(output)) {
    throw new Error('splat fragment shader no longer matches the expected 0.4.7 source; patch points not found');
  }
  material.uniforms['uDepthOnly'] = { value: 0 };
  material.fragmentShader = material.fragmentShader
    .replace(declaration, `${declaration}\n            uniform int uDepthOnly;`)
    .replace(output, `if (uDepthOnly == 1 && opacity < 0.5) discard;\n                ${output}`);
  material.needsUpdate = true;
}

function setDepthOnly(material: THREE.ShaderMaterial, on: boolean): void {
  material.uniforms['uDepthOnly'].value = on ? 1 : 0;
  material.colorWrite = !on;
  material.depthWrite = on;
  material.transparent = !on;
}

/* -------------------------------------------------------------------------- */
/* Depth visualisation                                                        */
/* -------------------------------------------------------------------------- */

const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
});

const depthView = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: depthTarget.depthTexture },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
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
      uniform float uNear;
      uniform float uFar;
      varying vec2 vUv;
      void main() {
        float d = texture2D(tDepth, vUv).x;
        // Perspective depth -> view distance, then compress 0..80 m to greyscale.
        float ndc = d * 2.0 - 1.0;
        float viewZ = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
        float shade = 1.0 - clamp(viewZ / 80.0, 0.0, 1.0);
        gl_FragColor = vec4(vec3(shade), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  }),
);
const depthScene = new THREE.Scene();
depthScene.add(depthView);

function resizeDepthTarget(): void {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  if (depthTarget.width !== size.x || depthTarget.height !== size.y) {
    depthTarget.setSize(size.x, size.y);
  }
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                      */
/* -------------------------------------------------------------------------- */

let viewer: Viewer | null = null;
let splatMaterial: THREE.ShaderMaterial | null = null;
let frames = 0;
let frameMsAccum = 0;

function renderBefore(v: Viewer): void {
  v.update();
  v.render();
}

function renderAfter(v: Viewer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
  const mesh = v.getSplatMesh();
  v.update();

  renderer.setRenderTarget(target);
  renderer.autoClear = false;
  renderer.clear();

  setDepthOnly(material, true);
  renderer.render(mesh, camera);

  renderer.render(scene, camera);

  if (target === null) {
    setDepthOnly(material, false);
    renderer.render(mesh, camera);
    renderer.render(beamLayer, camera);
  }
  renderer.setRenderTarget(null);
}

function frame(): void {
  const started = performance.now();
  if (viewer !== null && splatMaterial !== null) {
    if (mode === 'before') {
      renderBefore(viewer);
    } else if (mode === 'after') {
      renderAfter(viewer, splatMaterial, null);
    } else {
      resizeDepthTarget();
      renderAfter(viewer, splatMaterial, depthTarget);
      renderer.autoClear = false;
      renderer.clear();
      renderer.render(depthScene, camera);
    }
  }
  const elapsed = performance.now() - started;
  frames += 1;
  frameMsAccum += elapsed;
  if (frames % 30 === 0) {
    status.innerHTML = `<b>ready</b> · ${mode} · ${(frameMsAccum / 30).toFixed(1)} ms/frame (CPU submit)`;
    frameMsAccum = 0;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function boot(): Promise<void> {
  status.textContent = 'loading synthesized capture…';
  const v = new Viewer({
    selfDrivenMode: false,
    renderer,
    camera,
    threeScene: scene,
    useBuiltInControls: false,
    // Free static hosts cannot set COOP/COEP; same setting as the product.
    sharedMemoryForWorkers: false,
  });
  // Not progressive: the mesh must be final before its material is patched.
  await v.addSplatScene(SPLAT_URL, { showLoadingUI: false, progressiveLoad: false });

  status.textContent = 'patching splat material…';
  const material = v.getSplatMesh().material as THREE.ShaderMaterial;
  patchDepthToggle(material);

  viewer = v;
  splatMaterial = material;
  status.innerHTML = '<b>ready</b>';
  document.body.dataset.ready = 'true';
}

requestAnimationFrame(frame);
boot().catch((error: unknown) => {
  status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.ready = 'error';
  console.error(error);
});
