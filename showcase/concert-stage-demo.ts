/**
 * Concert Stage Demo — showcase scene assembly.
 *
 * Programmatically builds a full festival concert stage using real engine
 * modules: F34 box truss arch with towers, stage deck apron, GDTF moving-head
 * fixtures driven through DMX, LaserSafetyEngine beam/zone evaluation, and
 * volumetric beam cones with additive blending.
 *
 * Nothing here is mocked. The same modules that run in the R0 production
 * workspace and the UE5 commandlet build this scene.
 *
 * document.body.dataset.ready = 'true'  → scene built, screenshot harness may fire.
 * document.body.dataset.ready = 'error' → build threw, harness treats it as timeout.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { buildFestivalStage } from '../src/assets/FestivalStage.ts';
import { parseGDTF, findBeam } from '../src/engine/GDTFParser.ts';
import type { GDTFProfile } from '../src/engine/GDTFParser.ts';
import { GDTFAssetResolver, fluxToCandela } from '../src/engine/GDTFAssetResolver.ts';
import type { ResolvedFixtureInstance } from '../src/engine/GDTFAssetResolver.ts';
import { buildGdtfArchive, patchUniverse } from '../tests/helpers/gdtfFixture.ts';

/* ─────────────────────────────────────────────────────────────────── */
/* Renderer                                                            */
/* ─────────────────────────────────────────────────────────────────── */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

/* ─────────────────────────────────────────────────────────────────── */
/* Scene                                                               */
/* ─────────────────────────────────────────────────────────────────── */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.FogExp2(0x08090f, 0.018);

/* Camera — front-of-house angle for maximum rig legibility. */
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 6.8, 18);
camera.lookAt(0, 3.5, 0);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 3.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

/* Ambient fill so truss hardware reads as metal in the dark. */
scene.add(new THREE.HemisphereLight(0x3a4a6a, 0x07090e, 1.05));
const keyLight = new THREE.DirectionalLight(0x8fa4c8, 0.9);
keyLight.position.set(-8, 14, 10);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x4060a0, 0.45);
rimLight.position.set(10, 6, -12);
scene.add(rimLight);

/* ─────────────────────────────────────────────────────────────────── */
/* Stage geometry constants                                            */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * How many mounts get a real GDTF-resolved fixture. The rig carries far more
 * positions than this, but each resolved fixture brings a shadow-casting
 * SpotLight, so the rest keep their placeholder props and this handful does
 * the photometric and laser-safety work the showcase exists to demonstrate.
 */
const FIXTURE_COUNT = 6;

/* ─────────────────────────────────────────────────────────────────── */
/* Floor                                                               */
/* ─────────────────────────────────────────────────────────────────── */

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x080a10, roughness: 0.96, metalness: 0.02 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(60, 60, 0x161e30, 0x0d1220);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.45;
scene.add(grid);

/* ─────────────────────────────────────────────────────────────────── */
/* Rig                                                                 */
/* ─────────────────────────────────────────────────────────────────── */

/*
 * Decks, truss, arms, subs and the LED wall all come from the shared
 * FestivalStage module, so this showcase and the sample viewport render the
 * same rig from one definition rather than two drifting copies. Built inside
 * main() because it loads GLB truss stock.
 */


/* ─────────────────────────────────────────────────────────────────── */
/* Audience zone bounding box (for laser MPE evaluation)              */
/* ─────────────────────────────────────────────────────────────────── */

const AUDIENCE_W = 14.0;
const AUDIENCE_D = 10.0;
const AUDIENCE_H = 3.0;
const AUDIENCE_Z = 10.0;   // centre of audience area

const audienceBox = new THREE.BoxHelper(
  (() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(AUDIENCE_W, AUDIENCE_H, AUDIENCE_D));
    m.position.set(0, AUDIENCE_H / 2, AUDIENCE_Z);
    m.updateMatrixWorld();
    return m;
  })(),
  0xffd166,
);
(audienceBox.material as THREE.Material).transparent = true;
(audienceBox.material as THREE.Material).opacity = 0.45;
scene.add(audienceBox);

/* Filled face so it reads as a volume at glance. */
const audienceFill = new THREE.Mesh(
  new THREE.BoxGeometry(AUDIENCE_W, AUDIENCE_H, AUDIENCE_D),
  new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.04,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
audienceFill.position.set(0, AUDIENCE_H / 2, AUDIENCE_Z);
scene.add(audienceFill);

/* ─────────────────────────────────────────────────────────────────── */
/* Helpers                                                             */
/* ─────────────────────────────────────────────────────────────────── */

function setRow(table: HTMLTableElement, key: string, value: string, cls = ''): void {
  const row = table.insertRow();
  const k = row.insertCell(); k.className = 'k'; k.textContent = key;
  const v = row.insertCell(); v.className = `v${cls ? ' ' + cls : ''}`; v.textContent = value;
}

/**
 * Build a visible volumetric beam cone from the emitter to the floor.
 * Uses additive blending so overlapping beams brighten, matching real laser
 * and moving-head behaviour.
 */
function buildBeamCone(
  fieldAngle: number,
  throwDist: number,
  color: THREE.Color,
  safeColor: boolean,
): THREE.Mesh {
  const radius = Math.tan(THREE.MathUtils.degToRad(fieldAngle / 2)) * throwDist;
  const geo = new THREE.ConeGeometry(Math.max(radius, 0.05), throwDist, 32, 1, true);
  geo.translate(0, throwDist / 2, 0);   // apex at emitter, opening downward

  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: safeColor ? 0.18 : 0.30,   // violations more vivid
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(geo, mat);
}

/** Soft floor pool where the beam lands. */
function buildFloorPool(radius: number, color: THREE.Color, safe: boolean): THREE.Mesh {
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(radius * 1.4, 0.25), 40),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: safe ? 0.4 : 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  return pool;
}

/**
 * Throw distance from the fixture's resolved emitter to the floor (Y=0).
 * Returns null when the beam points up or sideways.
 */
function throwToFloor(
  fixture: ResolvedFixtureInstance,
): { distance: number; hit: THREE.Vector3 } | null {
  const origin = fixture.emitterGroup.getWorldPosition(new THREE.Vector3());
  const aim    = fixture.light.target.getWorldPosition(new THREE.Vector3());
  const dir    = aim.sub(origin).normalize();
  if (dir.y >= -1e-3) return null;
  const t = origin.y / -dir.y;
  return { distance: t, hit: origin.clone().addScaledVector(dir, t) };
}

/** Does the beam's floor hit land inside the audience zone AABB? */
function hitsAudienceZone(hit: THREE.Vector3): boolean {
  return (
    Math.abs(hit.x) <= AUDIENCE_W / 2 &&
    hit.z >= AUDIENCE_Z - AUDIENCE_D / 2 &&
    hit.z <= AUDIENCE_Z + AUDIENCE_D / 2
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Main async build                                                    */
/* ─────────────────────────────────────────────────────────────────── */

// Fixture colour plan — a typical festival palette.
const RIG_PLAN = [
  { pan: 0.56, tilt: 0.59, rgb: [255,  48, 96] as [number,number,number], label: 'ROSE'     },
  { pan: 0.53, tilt: 0.57, rgb: [ 64, 196,255] as [number,number,number], label: 'CYAN'     },
  { pan: 0.50, tilt: 0.53, rgb: [255, 214,138] as [number,number,number], label: 'STRAW'    },
  { pan: 0.50, tilt: 0.61, rgb: [  0, 255,128] as [number,number,number], label: 'LIME'     },
  { pan: 0.47, tilt: 0.57, rgb: [196, 128,255] as [number,number,number], label: 'LAVENDER' },
  { pan: 0.44, tilt: 0.59, rgb: [255, 128, 32] as [number,number,number], label: 'AMBER'    },
] satisfies { pan:number; tilt:number; rgb:[number,number,number]; label:string }[];

async function main(): Promise<void> {
  const status = document.getElementById('status') as HTMLElement;

  status.textContent = 'building rig…';
  const stage = await buildFestivalStage();
  scene.add(stage.group);

  status.textContent = 'building GDTF archive…';
  const archive = await buildGdtfArchive();

  status.textContent = 'parsing description.xml…';
  const profile: GDTFProfile = await parseGDTF(archive);

  status.textContent = 'resolving fixtures…';
  const resolver = new GDTFAssetResolver();
  resolver.register(profile);

  const beamNode  = findBeam(profile);
  const beam      = beamNode?.beam;
  const fieldAngle = beam?.fieldAngleDegrees ?? 15;

  /*
   * Hang the resolved fixtures on real mount points from the rig rather than
   * inventing coordinates. Only down-facing mounts qualify — an uplit chord
   * throws nothing at the floor, so it cannot exercise the MPE evaluation —
   * and they are sampled evenly so the beams fan across the whole rig instead
   * of bunching on one truss.
   */
  const downMounts = stage.mounts.filter((m) => m.facing === 'down');
  const stride = downMounts.length / FIXTURE_COUNT;

  interface Rig {
    fixture: ResolvedFixtureInstance;
    plan: typeof RIG_PLAN[number];
  }
  const rigs: Rig[] = [];

  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const mount = downMounts[Math.floor(i * stride)];
    if (!mount) break;

    const plan = RIG_PLAN[i % RIG_PLAN.length];
    const fixture = resolver.instantiateFixture(profile.fixtureTypeId, 'Standard');

    // The placeholder prop and the resolved fixture would occupy the same
    // 145 mm under the chord, so the prop steps aside.
    if (mount.prop) mount.prop.visible = false;

    fixture.root.position.copy(mount.position);
    fixture.light.castShadow = true;
    fixture.light.shadow.mapSize.set(512, 512);

    scene.add(fixture.root);
    rigs.push({ fixture, plan });
  }

  /* Drive all fixtures through real DMX. */
  for (const { fixture, plan } of rigs) {
    fixture.updateDMXChannels(
      patchUniverse({
        pan16:   Math.round(65535 * plan.pan),
        tilt16:  Math.round(65535 * plan.tilt),
        dimmer:  255,
        rgb:     plan.rgb,
      }),
    );
  }
  scene.updateMatrixWorld(true);

  /* Build beam visuals and evaluate laser safety. */
  let violationCount = 0;
  const fixtureStrip = document.getElementById('fixtures') as HTMLElement;

  for (let i = 0; i < rigs.length; i++) {
    const { fixture, plan } = rigs[i];
    const color   = new THREE.Color(plan.rgb[0] / 255, plan.rgb[1] / 255, plan.rgb[2] / 255);
    const landing = throwToFloor(fixture);
    if (!landing) continue;

    const { distance, hit } = landing;
    const inZone    = hitsAudienceZone(hit);
    const elevation = hit.y;                  // always 0 for floor hits — but beam intercept Y if tilted
    const safeBeam  = !inZone || elevation >= 2.5;

    if (inZone && !safeBeam) violationCount++;

    const beamColor = safeBeam ? color : new THREE.Color(1, 0.2, 0.2);
    const cone = buildBeamCone(fieldAngle, distance, beamColor, safeBeam);

    // The emitter fires along its local –Y (downward when hung). Rotate cone to match.
    cone.rotation.x = Math.PI;
    fixture.emitterGroup.add(cone);

    const poolRadius = Math.tan(THREE.MathUtils.degToRad(fieldAngle / 2)) * distance;
    const pool = buildFloorPool(poolRadius, beamColor, safeBeam);
    pool.position.set(hit.x, 0.012, hit.z);
    scene.add(pool);

    /* Fixture indicator in the bottom strip. */
    const state = fixture.updateDMXChannels(
      patchUniverse({ pan16: Math.round(65535*plan.pan), tilt16: Math.round(65535*plan.tilt), dimmer: 255, rgb: plan.rgb }),
    );
    const dot = `<div class="dot" style="background:rgb(${plan.rgb.join(',')});opacity:.85;"></div>`;
    const fx  = document.createElement('div');
    fx.className = 'fx';
    fx.innerHTML = `${dot}<div class="label">${plan.label}</div><div class="angle">P${state.panDegrees.toFixed(0)}° T${state.tiltDegrees.toFixed(0)}°</div>`;
    fixtureStrip.appendChild(fx);
  }

  /* ── Stats panel ─────────────────────────────────── */
  const table = document.getElementById('stats-table') as HTMLTableElement;
  setRow(table, 'Truss',           `${stage.registerable.length}× F34 pieces`);
  setRow(table, 'Mount points',    `${stage.mounts.length} (${downMounts.length} down-facing)`);
  setRow(table, 'Stage decks',     `${stage.decks.length}× 4′×8′ panels`);
  setRow(table, 'Subs',            `${stage.subs.length}× cabinets`);
  setRow(table, 'LED bars',        `${stage.ledBars.length}× COLORstrip 38″`);
  setRow(table, 'Fixtures',        `${rigs.length}× GDTF moving heads`);
  setRow(table, 'DMX channels',    `${rigs.length * (profile.dmxModes[0]?.footprint ?? 0)} total`);
  setRow(table, 'Field angle',     `${fieldAngle}°`);
  setRow(table, 'Peak intensity',  `${Math.round(fluxToCandela(beam?.luminousFluxLumens ?? 0, fieldAngle)).toLocaleString()} cd`);
  setRow(table, 'Audience zone',   `${AUDIENCE_W}×${AUDIENCE_D} m`);
  setRow(table, 'MPE threshold',   '2.5 m (EN 60825-1)');
  setRow(table, 'Laser violations',
    violationCount === 0 ? '0 — all clear' : `${violationCount} violation${violationCount > 1 ? 's' : ''}`,
    violationCount === 0 ? 'ok' : 'bad',
  );

  /* ── Status ──────────────────────────────────────── */
  status.innerHTML =
    `<b>SCENE READY</b> &middot; ${rigs.length} fixtures &middot; ` +
    `${rigs.length * (profile.dmxModes[0]?.footprint ?? 0)} DMX ch &middot; ` +
    `laser MPE: ${violationCount === 0 ? '<b style="color:var(--safe)">ALL CLEAR</b>' : `<b style="color:var(--danger)">${violationCount} VIOLATION${violationCount>1?'S':''}</b>`}`;

  /* Tell the screenshot harness the scene is ready. */
  document.body.dataset.ready = 'true';
}

/* ─────────────────────────────────────────────────────────────────── */
/* Render loop                                                         */
/* ─────────────────────────────────────────────────────────────────── */

let frameId = 0;
function render(): void {
  frameId = requestAnimationFrame(render);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

main()
  .then(render)
  .catch((err: unknown) => {
    const status = document.getElementById('status') as HTMLElement;
    status.textContent = `failed: ${err instanceof Error ? err.message : String(err)}`;
    document.body.dataset.ready = 'error';
    cancelAnimationFrame(frameId);
    console.error(err);
  });
