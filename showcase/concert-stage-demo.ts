/**
 * Concert Stage Demo — showcase scene assembly and live show program.
 *
 * Programmatically builds a full festival concert stage using real engine
 * modules: F34 box truss with outboard arms, stage deck apron, GDTF moving
 * heads driven through a real DMX patch, grandMA3-style phasers running the
 * chase, LaserSafetyEngine-style MPE evaluation against a live audience
 * volume, and volumetric beams in haze.
 *
 * Nothing here is mocked. The same modules that run in the R0 production
 * workspace and the UE5 commandlet build this scene, and every fixture is
 * addressed through `allocatePatch` rather than being driven by index.
 *
 * document.body.dataset.ready = 'true'  → scene built, screenshot harness may fire.
 * document.body.dataset.ready = 'error' → build threw, harness treats it as timeout.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { buildFestivalStage } from '../src/assets/FestivalStage.ts';
import type { FixtureMount } from '../src/assets/FestivalStage.ts';
import { createGoboTexture, GOBO_PATTERNS } from '../src/assets/GoboTextures.ts';
import type { GoboPattern } from '../src/assets/GoboTextures.ts';
import { createVideoWallContent } from '../src/assets/VideoWallContent.ts';
import type { VideoWallContent } from '../src/assets/VideoWallContent.ts';
import { parseGDTF, findBeam } from '../src/engine/GDTFParser.ts';
import type { GDTFProfile } from '../src/engine/GDTFParser.ts';
import { GDTFAssetResolver, fluxToCandela } from '../src/engine/GDTFAssetResolver.ts';
import type { ResolvedFixtureInstance } from '../src/engine/GDTFAssetResolver.ts';
import { aimFixtureAt, readPanTiltRange, normalizedForDegrees } from '../src/engine/FixtureAiming.ts';
import type { PanTiltRange } from '../src/engine/FixtureAiming.ts';
import {
  allocatePatch,
  formatAddress,
  formatPatchSheet,
  summarizePatch,
  findPatchCollisions,
} from '../src/engine/DmxPatch.ts';
import type { PatchEntry, PatchRequest } from '../src/engine/DmxPatch.ts';
import { Phaser, ColorPhaser, radialPhase, mirrorPanDegrees } from '../src/engine/Phaser.ts';
import { buildGdtfArchive } from '../tests/helpers/gdtfFixture.ts';

/* ─────────────────────────────────────────────────────────────────── */
/* Show constants                                                      */
/* ─────────────────────────────────────────────────────────────────── */

/** Show tempo. Every phaser and the wall content read this one clock. */
const SHOW_BPM = 128;

/** The look: amber and violet, the two-colour festival palette asked for. */
const AMBER = [255, 122, 26] as const;
const VIOLET = [150, 42, 255] as const;

/**
 * Audience zone — the area in front of the stage. Its ground-level centre is
 * the plot's home focus: every head opens pointing there, so the rig reads as
 * one focused system before any effect runs.
 */
const AUDIENCE_W = 14.0;
const AUDIENCE_D = 10.0;
const AUDIENCE_H = 3.0;
const AUDIENCE_Z = 10.0;
const FOCUS = new THREE.Vector3(0, 0, AUDIENCE_Z);

/** Minimum beam elevation inside the audience volume (EN 60825-1 practice). */
const MPE_ELEVATION_M = 2.5;

/** How many mounts carry a resolved GDTF fixture with a live beam. */
const FIXTURE_COUNT = 12;

/** Movement envelope around the home focus, in degrees of travel. */
const PAN_SWING_DEG = 26;
const TILT_SWING_DEG = 16;

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
renderer.toneMappingExposure = 1.15;

/* ─────────────────────────────────────────────────────────────────── */
/* Scene, haze and ambience                                            */
/* ─────────────────────────────────────────────────────────────────── */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050309);

/*
 * Haze. Exponential fog is what makes a beam cone read as a volume rather than
 * as a translucent solid, because it attenuates the far wall of the cone more
 * than the near one. Tinted violet so unlit air sits in the palette instead of
 * greying the amber beams toward white.
 */
scene.fog = new THREE.FogExp2(0x0b0618, 0.020);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 11, 30);
camera.lookAt(0, 3.4, 2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 3.4, 2);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

/*
 * Ambient rig. Deliberately dim and inside the palette: enough to read truss
 * hardware as metal and the deck as a surface, not enough to compete with the
 * fixtures. A neutral ambient at working levels washes the colour straight out
 * of a two-colour look.
 */
scene.add(new THREE.HemisphereLight(0x3a2060, 0x08060f, 0.55));
scene.add(new THREE.AmbientLight(0x1a1030, 0.9));

const keyLight = new THREE.DirectionalLight(0x8a6ad0, 0.32);
keyLight.position.set(-8, 14, 10);
scene.add(keyLight);

const warmRim = new THREE.DirectionalLight(0xff8a3a, 0.26);
warmRim.position.set(11, 5, -13);
scene.add(warmRim);

/* ─────────────────────────────────────────────────────────────────── */
/* Floor                                                               */
/* ─────────────────────────────────────────────────────────────────── */

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x0a0710, roughness: 0.94, metalness: 0.03 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(60, 60, 0x2a1a40, 0x150c22);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.4;
scene.add(grid);

/* ─────────────────────────────────────────────────────────────────── */
/* Audience zone                                                       */
/* ─────────────────────────────────────────────────────────────────── */

const audienceBox = new THREE.Box3(
  new THREE.Vector3(-AUDIENCE_W / 2, 0, AUDIENCE_Z - AUDIENCE_D / 2),
  new THREE.Vector3(AUDIENCE_W / 2, AUDIENCE_H, AUDIENCE_Z + AUDIENCE_D / 2),
);

const audienceHelper = new THREE.Box3Helper(audienceBox, new THREE.Color(0xffd166));
(audienceHelper.material as THREE.Material).transparent = true;
(audienceHelper.material as THREE.Material).opacity = 0.4;
scene.add(audienceHelper);

/** Ground marker at the home focus, so the plot's aim point is visible. */
const focusMark = new THREE.Mesh(
  new THREE.RingGeometry(0.5, 0.62, 48),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
);
focusMark.rotation.x = -Math.PI / 2;
focusMark.position.set(FOCUS.x, 0.02, FOCUS.z);
scene.add(focusMark);

/* ─────────────────────────────────────────────────────────────────── */
/* HUD helpers                                                         */
/* ─────────────────────────────────────────────────────────────────── */

function setRow(table: HTMLTableElement, key: string, value: string, cls = ''): HTMLTableCellElement {
  const row = table.insertRow();
  const k = row.insertCell();
  k.className = 'k';
  k.textContent = key;
  const v = row.insertCell();
  v.className = `v${cls ? ' ' + cls : ''}`;
  v.textContent = value;
  return v;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Beam geometry                                                       */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * Unit-length beam cone, opening along local -Y with its apex on the origin.
 *
 * Built once at length 1 and scaled uniformly to the throw each frame: a cone
 * of height 1 and radius `tan(theta/2)` scaled by `d` has height `d` and
 * radius `tan(theta/2)·d`, which is exactly the beam at distance `d`. Rebuilding
 * the geometry per frame would allocate a fresh BufferGeometry per fixture per
 * frame, which §6 rules out in the render loop.
 *
 * ConeGeometry puts its tip at +h/2, so the translate moves the apex onto the
 * origin. Shifting the other way parks the wide end on the lens and tapers the
 * beam to a point at the floor, which is backwards for every real fixture.
 */
function buildBeamCone(fieldAngleDeg: number, opacity: number): THREE.Mesh {
  const radius = Math.max(Math.tan(THREE.MathUtils.degToRad(fieldAngleDeg / 2)), 0.004);
  const geo = new THREE.ConeGeometry(radius, 1, 28, 1, true);
  geo.translate(0, -0.5, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  return new THREE.Mesh(geo, mat);
}

/** Unit-radius floor pool; scaled to the throw alongside its cone. */
function buildFloorPool(fieldAngleDeg: number): THREE.Mesh {
  const radius = Math.max(Math.tan(THREE.MathUtils.degToRad(fieldAngleDeg / 2)) * 1.5, 0.05);
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  return pool;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Beam / audience intersection                                        */
/* ─────────────────────────────────────────────────────────────────── */

/**
 * Slab intersection of a ray against an AABB, returning BOTH parameters.
 *
 * `Ray.intersectBox` only hands back the entry point, and the entry is the
 * highest point of a descending beam inside the box -- the safe end. The
 * question an MPE check asks is how LOW the beam gets while it is in there, so
 * the exit parameter is the one that matters.
 */
function slabRange(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  box: THREE.Box3,
): { near: number; far: number } | null {
  let near = -Infinity;
  let far = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];

  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (o[axis] < lo[axis] || o[axis] > hi[axis]) return null;
      continue;
    }
    const inv = 1 / d[axis];
    let t0 = (lo[axis] - o[axis]) * inv;
    let t1 = (hi[axis] - o[axis]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  return { near, far };
}

interface BeamThrow {
  distance: number;
  hit: THREE.Vector3;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  /** Lowest elevation the beam reaches while inside the audience volume. */
  audienceElevation: number | null;
}

const scratchOrigin = new THREE.Vector3();
const scratchAim = new THREE.Vector3();

/**
 * Throw from the fixture's resolved emitter to the floor, and measure how low
 * the beam gets inside the audience volume on the way.
 *
 * Returns origin and direction as well as the landing, so the beam cone and
 * the floor pool are placed from one computation. Deriving the cone from the
 * emitter's local axes instead lets the two disagree the moment pan and tilt
 * move the head, which is how the cones once ended up aimed at the sky while
 * the pools stayed on the deck.
 */
function throwToFloor(fixture: ResolvedFixtureInstance, out: BeamThrow): BeamThrow | null {
  fixture.emitterGroup.getWorldPosition(scratchOrigin);
  fixture.light.target.getWorldPosition(scratchAim);
  out.origin.copy(scratchOrigin);
  out.dir.copy(scratchAim).sub(scratchOrigin).normalize();
  if (out.dir.y >= -1e-3) return null;

  out.distance = out.origin.y / -out.dir.y;
  out.hit.copy(out.origin).addScaledVector(out.dir, out.distance);

  const span = slabRange(out.origin, out.dir, audienceBox);
  if (span === null || span.far <= 0) {
    out.audienceElevation = null;
  } else {
    // Descending beam: lowest point inside the box is at the largest parameter
    // still inside it, capped at the floor hit.
    const exit = Math.min(span.far, out.distance);
    out.audienceElevation = Math.max(0, out.origin.y + out.dir.y * exit);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Show program                                                        */
/* ─────────────────────────────────────────────────────────────────── */

interface RigFixture {
  fixture: ResolvedFixtureInstance;
  mount: FixtureMount;
  patch: PatchEntry;
  /** Aim that puts the beam on the home focus, in fixture degrees. */
  homePanDeg: number;
  homeTiltDeg: number;
  /** Chase offset into the cycle, degrees. Shared by all four attributes. */
  phaseDeg: number;
  /** Rank outward from the rear-centre; 0 is the innermost pair. */
  rank: number;
  /** -1 mirrors this fixture's pan swing against the other side of the rig. */
  mirror: number;
  gobo: GoboPattern;
  cone: THREE.Mesh;
  halo: THREE.Mesh;
  pool: THREE.Mesh;
  throwState: BeamThrow;
  addressCell: HTMLElement;
}

let rig: RigFixture[] = [];
let wall: VideoWallContent | null = null;
let ledZones: THREE.MeshStandardMaterial[][] = [];
let ledPatch: PatchEntry[] = [];
let panTiltRange: PanTiltRange;
let headUniverse = new Uint8Array(512);

/* Phasers — one set, read by every fixture at its own phase. */
const panPhaser = new Phaser({
  steps: [{ value: -1 }, { value: 1 }],
  speedBpm: SHOW_BPM / 4, // one sweep out and back per two bars
  easing: 'sine',
});
const tiltPhaser = new Phaser({
  steps: [{ value: -1 }, { value: 1 }],
  speedBpm: SHOW_BPM / 2, // twice pan's rate, which traces a figure-of-eight
  easing: 'sine',
});
const dimmerPhaser = new Phaser({
  // A bump, not a wash: full out, then down to a glow, with a short fade.
  steps: [
    { value: 1.0, transition: 0.35 },
    { value: 0.18, transition: 0.8 },
  ],
  speedBpm: SHOW_BPM,
  easing: 'decel',
});
const colorPhaser = new ColorPhaser({
  steps: [{ value: [...AMBER] }, { value: [...VIOLET] }],
  speedBpm: SHOW_BPM / 4,
  easing: 'sine',
});

const scratchColor = new THREE.Color();

async function main(): Promise<void> {
  const status = document.getElementById('status') as HTMLElement;

  status.textContent = 'building rig…';
  const stage = await buildFestivalStage();
  scene.add(stage.group);

  status.textContent = 'mapping video wall…';
  wall = await createVideoWallContent({ bpm: SHOW_BPM });
  const wallMaterial = stage.ledWall.material as THREE.MeshStandardMaterial;
  wallMaterial.map = wall.texture;
  wallMaterial.emissiveMap = wall.texture;
  wallMaterial.emissive.setRGB(1, 1, 1);
  wallMaterial.emissiveIntensity = 1.5;
  wallMaterial.color.setRGB(0.15, 0.12, 0.2);
  wallMaterial.needsUpdate = true;

  status.textContent = 'building GDTF archive…';
  const archive = await buildGdtfArchive();

  status.textContent = 'parsing description.xml…';
  const profile: GDTFProfile = await parseGDTF(archive);

  const range = readPanTiltRange(profile, 'Standard');
  if (range === null) throw new Error('profile has no pan/tilt channels to aim');
  panTiltRange = range;

  status.textContent = 'resolving fixtures…';
  const resolver = new GDTFAssetResolver();
  resolver.register(profile);

  const beamNode = findBeam(profile);
  const beam = beamNode?.beam;
  const fieldAngle = beam?.fieldAngleDegrees ?? 15;
  const footprint = profile.dmxModes[0]?.footprint ?? 8;

  /*
   * Pick mounts. The four rear-top positions are the origin of the chase, so
   * they all take a fixture; the arms are sampled evenly outward from there so
   * the effect has somewhere to travel to.
   */
  const downMounts = stage.mounts.filter((m) => m.facing === 'down');
  const rearMounts = downMounts.filter((m) => m.run === 'rear-top');
  const armMounts = downMounts.filter((m) => m.run !== 'rear-top');
  const armWanted = Math.max(0, FIXTURE_COUNT - rearMounts.length);
  const armStride = armMounts.length / Math.max(armWanted, 1);
  const chosen: FixtureMount[] = [
    ...rearMounts,
    ...Array.from({ length: armWanted }, (_, i) => armMounts[Math.floor(i * armStride)]).filter(
      (m): m is FixtureMount => m !== undefined,
    ),
  ];

  /* ── Patch ────────────────────────────────────────────────────────
   * Movers on universe 1, LED on universe 2 — the split a real rig runs so a
   * mover data fault cannot take the wall down with it. Addresses come from
   * `allocatePatch`, never from the loop index, so the sheet below is the same
   * artefact the console would be patched from.
   */
  const headRequests: PatchRequest[] = chosen.map((mount, i) => ({
    id: `head-${i + 1}`,
    label: `MH ${String(i + 1).padStart(2, '0')} ${mount.run}`,
    mode: 'Standard',
    footprint,
  }));
  const headPatch = allocatePatch(headRequests, { startUniverse: 1, startAddress: 1 });

  // The COLORstrip's dimmer-plus-colour mode: one master dimmer and an RGB
  // triple. The four zones drawn on the bar are cosmetic segments of a single
  // addressed fixture, which is how the real bar behaves.
  const LED_FOOTPRINT = 4;
  ledPatch = allocatePatch(
    stage.ledBars.map((_, i) => ({
      id: `strip-${i + 1}`,
      label: `COLORstrip ${String(i + 1).padStart(2, '0')}`,
      mode: 'DIM+RGB 4ch',
      footprint: LED_FOOTPRINT,
    })),
    { startUniverse: 2, startAddress: 1 },
  );

  // The wall processor's master dim and tint. Pixel content arrives over the
  // media path, not over DMX — only the master is patched, as on a real rig.
  const wallPatch = allocatePatch(
    [{ id: 'wall-processor', label: 'LED wall processor', mode: 'DIM+RGB 4ch', footprint: 4 }],
    { startUniverse: 2, startAddress: ledPatch[ledPatch.length - 1].endAddress + 1 },
  );

  const fullPatch = [...headPatch, ...ledPatch, ...wallPatch];
  const collisions = findPatchCollisions(fullPatch);

  /* ── Hang and focus ──────────────────────────────────────────────── */

  const fixtureStrip = document.getElementById('fixtures') as HTMLElement;
  const built: Omit<RigFixture, 'phaseDeg' | 'rank'>[] = [];

  for (let i = 0; i < chosen.length; i++) {
    const mount = chosen[i];
    const fixture = resolver.instantiateFixture(profile.fixtureTypeId, 'Standard');

    // The placeholder prop and the resolved fixture would occupy the same
    // 145 mm under the chord, so the prop steps aside.
    if (mount.prop) mount.prop.visible = false;

    fixture.root.position.copy(mount.position);
    // Square the fixture to the leg it actually hangs from. `aimFixtureAt`
    // reads the root's live world quaternion, so this yaw composes correctly
    // with the pan/tilt solve below rather than needing to be undone by it.
    fixture.root.quaternion.copy(mount.quaternion);
    fixture.light.castShadow = true;
    fixture.light.shadow.mapSize.set(512, 512);

    // Gobo: the pattern is the fixture's gate mask, projected by the beam.
    // Wheel position rotates across the rig so the plot is not twenty copies
    // of one breakup, and the open position stays out of the running order.
    const gobo = GOBO_PATTERNS[i % (GOBO_PATTERNS.length - 1)];
    fixture.light.map = createGoboTexture(gobo, i + 1);

    scene.add(fixture.root);
    fixture.root.updateMatrixWorld(true);

    // Home focus: every head opens aimed at the ground-level centre of the
    // area in front of the stage. Solved per fixture from where it actually
    // hangs — a shared pan/tilt pair would only focus the one head it was
    // measured from.
    const home = aimFixtureAt(fixture, FOCUS, { range: panTiltRange });

    const cone = buildBeamCone(fieldAngle, 0.34);
    const halo = buildBeamCone(fieldAngle * 3.4, 0.055);
    const pool = buildFloorPool(fieldAngle);
    scene.add(cone, halo, pool);

    const fx = document.createElement('div');
    fx.className = 'fx';
    fx.innerHTML =
      `<div class="dot"></div>` +
      `<div class="label">MH${String(i + 1).padStart(2, '0')}</div>` +
      `<div class="addr">${formatAddress(headPatch[i])}</div>`;
    fixtureStrip.appendChild(fx);

    built.push({
      fixture,
      mount,
      patch: headPatch[i],
      homePanDeg: home.panDegrees,
      homeTiltDeg: home.tiltDegrees,
      // Stage left and stage right mirror each other, so one side's pan swing
      // is multiplied by -1 -- the grandMA3 `Attribute "Pan" At % -100` move.
      // The sign is read off the mount's own x, which agrees with the rig's
      // arm-left / arm-right labels and also covers the rear-top run.
      mirror: mount.position.x < 0 ? -1 : 1,
      gobo,
      cone,
      halo,
      pool,
      throwState: {
        distance: 0,
        hit: new THREE.Vector3(),
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(0, -1, 0),
        audienceElevation: null,
      },
      addressCell: fx.querySelector('.dot') as HTMLElement,
    });
  }

  /*
   * Chase order: rank outward from the centre of the rear truss, not from the
   * scene origin. The effect is meant to leave from behind the band and travel
   * out along the arms, and a symmetric pair either side of centre shares a
   * rank so both halves of the rig move together.
   */
  const rearCentre = new THREE.Vector3();
  for (const m of rearMounts) rearCentre.add(m.position);
  rearCentre.divideScalar(Math.max(rearMounts.length, 1));

  const ranked = radialPhase(built, (b) => b.mount.position.distanceTo(rearCentre), {
    tolerance: 0.2,
  });
  rig = ranked.map((entry) => ({ ...entry.item, phaseDeg: entry.phaseDegrees, rank: entry.rank }));

  /* COLORstrip emissive materials, cached so the loop does not walk the graph. */
  ledZones = stage.ledBars.map((bar) =>
    bar.children
      .filter((child) => child.name.startsWith('zone-'))
      .map((child) => (child as THREE.Mesh).material as THREE.MeshStandardMaterial),
  );

  /* ── Stats ───────────────────────────────────────────────────────── */
  const summary = summarizePatch(fullPatch);
  const table = document.getElementById('stats-table') as HTMLTableElement;
  setRow(table, 'Truss', `${stage.registerable.length}× F34 pieces`);
  setRow(table, 'Mount points', `${stage.mounts.length} (${downMounts.length} down-facing)`);
  setRow(table, 'Stage decks', `${stage.decks.length}× 4′×8′ panels`);
  setRow(table, 'Subs', `${stage.subs.length}× cabinets`);
  setRow(table, 'Moving heads', `${rig.length}× GDTF, ${footprint}ch — U1/001`);
  setRow(table, 'COLORstrips', `${ledPatch.length}× 4ch — U2/001`);
  setRow(table, 'LED wall', `1× processor — ${formatAddress(wallPatch[0])}`);
  setRow(table, 'Patched total', `${summary.fixtureCount} fixtures, ${summary.channelsUsed} ch`);
  setRow(table, 'Universes', `${summary.universeCount}`);
  setRow(
    table,
    'Patch overlaps',
    collisions.length === 0 ? '0 — clean' : `${collisions.length}`,
    collisions.length === 0 ? 'ok' : 'bad',
  );
  setRow(table, 'Un-patched', 'truss, decks, subs (no DMX)');
  setRow(table, 'Field angle', `${fieldAngle}°`);
  setRow(
    table,
    'Peak intensity',
    `${Math.round(fluxToCandela(beam?.luminousFluxLumens ?? 0, fieldAngle)).toLocaleString()} cd`,
  );
  setRow(table, 'Show tempo', `${SHOW_BPM} BPM`);
  setRow(table, 'Home focus', `0.0, 0.0, ${FOCUS.z.toFixed(1)} m`);
  setRow(table, 'Chase', `centre-out, ${Math.max(...rig.map((r) => r.rank)) + 1} ranks`);
  setRow(table, 'Wall content', wall.source);
  liveMpeCell = setRow(table, 'MPE violations', '—');

  /* ── Patch sheet ─────────────────────────────────────────────────── */
  const sheet = document.getElementById('patch-sheet') as HTMLElement;
  sheet.textContent = formatPatchSheet(fullPatch);

  /* One full show tick before the harness is told the scene is ready, so a
   * screenshot catches a lit rig rather than twelve fixtures at their defaults. */
  updateShow(0);
  scene.updateMatrixWorld(true);
  renderer.render(scene, camera);

  status.innerHTML =
    `<b>SHOW RUNNING</b> &middot; ${rig.length} heads &middot; ` +
    `${summary.channelsUsed} ch over ${summary.universeCount} universes &middot; ${SHOW_BPM} BPM`;

  document.body.dataset.ready = 'true';
}

let liveMpeCell: HTMLElement | null = null;

/* ─────────────────────────────────────────────────────────────────── */
/* Per-frame show evaluation                                           */
/* ─────────────────────────────────────────────────────────────────── */

function writeHead(entry: RigFixture, time: number): void {
  const phase = entry.phaseDeg;

  // Movement rides on top of the home focus rather than replacing it, so the
  // rig stays pointed at the same area however far into the effect it is.
  const swing = panPhaser.valueAt(time, phase) * PAN_SWING_DEG;
  const panDeg = entry.homePanDeg + (entry.mirror < 0 ? mirrorPanDegrees(swing) : swing);
  const tiltDeg = entry.homeTiltDeg + tiltPhaser.valueAt(time, phase) * TILT_SWING_DEG;

  const dimmer = dimmerPhaser.valueAt(time, phase);
  const rgb = colorPhaser.colorAt(time, phase);

  const pan16 = Math.round(65535 * normalizedForDegrees(panDeg, panTiltRange.pan));
  const tilt16 = Math.round(65535 * normalizedForDegrees(tiltDeg, panTiltRange.tilt));
  const base = entry.patch.address - 1;

  headUniverse[base + 0] = (pan16 >> 8) & 0xff;
  headUniverse[base + 1] = pan16 & 0xff;
  headUniverse[base + 2] = (tilt16 >> 8) & 0xff;
  headUniverse[base + 3] = tilt16 & 0xff;
  headUniverse[base + 4] = Math.round(255 * THREE.MathUtils.clamp(dimmer, 0, 1));
  headUniverse[base + 5] = Math.round(THREE.MathUtils.clamp(rgb[0], 0, 255));
  headUniverse[base + 6] = Math.round(THREE.MathUtils.clamp(rgb[1], 0, 255));
  headUniverse[base + 7] = Math.round(THREE.MathUtils.clamp(rgb[2], 0, 255));
}

const CONE_AXIS = new THREE.Vector3(0, -1, 0);

function updateShow(time: number): void {
  wall?.update(time);

  /* Drive every head from the patched universe buffer. */
  for (const entry of rig) writeHead(entry, time);
  for (const entry of rig) entry.fixture.updateDMXChannels(headUniverse, entry.patch.address);
  scene.updateMatrixWorld(true);

  let violations = 0;

  for (const entry of rig) {
    const landing = throwToFloor(entry.fixture, entry.throwState);
    const dimmer = headUniverse[entry.patch.address - 1 + 4] / 255;
    const visible = landing !== null && dimmer > 0.02;

    entry.cone.visible = visible;
    entry.halo.visible = visible;
    entry.pool.visible = visible;
    if (!visible || landing === null) continue;

    const unsafe =
      landing.audienceElevation !== null && landing.audienceElevation < MPE_ELEVATION_M;
    if (unsafe) violations++;

    if (unsafe) scratchColor.setRGB(1, 0.24, 0.24);
    else {
      scratchColor.setRGB(
        headUniverse[entry.patch.address - 1 + 5] / 255,
        headUniverse[entry.patch.address - 1 + 6] / 255,
        headUniverse[entry.patch.address - 1 + 7] / 255,
      );
    }

    for (const mesh of [entry.cone, entry.halo]) {
      mesh.position.copy(landing.origin);
      mesh.quaternion.setFromUnitVectors(CONE_AXIS, landing.dir);
      mesh.scale.setScalar(landing.distance);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(scratchColor);
    }
    // Beam brightness tracks the dimmer: a bumped-out head that still shows a
    // full-strength cone in haze is the tell that the volumetrics are painted
    // on rather than driven.
    (entry.cone.material as THREE.MeshBasicMaterial).opacity = 0.34 * dimmer + 0.02;
    (entry.halo.material as THREE.MeshBasicMaterial).opacity = 0.055 * dimmer;

    entry.pool.position.set(landing.hit.x, 0.015, landing.hit.z);
    entry.pool.scale.setScalar(landing.distance);
    const poolMaterial = entry.pool.material as THREE.MeshBasicMaterial;
    poolMaterial.color.copy(scratchColor);
    poolMaterial.opacity = 0.45 * dimmer;

    entry.addressCell.style.background = `#${scratchColor.getHexString()}`;
    entry.addressCell.style.opacity = String(0.25 + 0.75 * dimmer);
  }

  /* COLORstrips ride the same chase, ranked by their own distance outward. */
  for (let i = 0; i < ledZones.length; i++) {
    // Bars are laid down the arms outward from the stage, so their index is
    // already a radial order; spreading over a full turn keeps them chasing
    // with the heads rather than flashing as one block.
    const phase = (i / Math.max(ledZones.length, 1)) * 360;
    const rgb = colorPhaser.colorAt(time, phase);
    const level = dimmerPhaser.valueAt(time, phase);
    scratchColor.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    for (const material of ledZones[i]) {
      material.emissive.copy(scratchColor);
      material.emissiveIntensity = 0.25 + 1.5 * level;
    }
  }

  if (liveMpeCell !== null) {
    const text = violations === 0 ? '0 — all clear' : `${violations} beam${violations > 1 ? 's' : ''} low`;
    if (liveMpeCell.textContent !== text) {
      liveMpeCell.textContent = text;
      liveMpeCell.className = violations === 0 ? 'v ok' : 'v bad';
    }
  }
}

/* ─────────────────────────────────────────────────────────────────── */
/* Render loop                                                         */
/* ─────────────────────────────────────────────────────────────────── */

const clock = new THREE.Clock();
let frameId = 0;

function render(): void {
  frameId = requestAnimationFrame(render);
  updateShow(clock.getElapsedTime());
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
