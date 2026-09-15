/**
 * GDTF resolver showcase.
 *
 * Renders fixtures that came the whole way through the real pipeline: a `.gdtf`
 * ZIP is built, `parseGDTF` reads its `description.xml`, and
 * `GDTFAssetResolver` assembles the kinematic chain and photometric light. Pan
 * and tilt are then driven by writing DMX bytes into a universe buffer, exactly
 * as the FOH bridge will.
 *
 * Nothing here is mocked. If the parser mis-reads a matrix or the resolver
 * rotates the wrong joint, it is visible on screen.
 */

import * as THREE from 'three';

import { parseGDTF, findBeam } from '../src/engine/GDTFParser.ts';
import type { GDTFProfile } from '../src/engine/GDTFParser.ts';
import { GDTFAssetResolver, fluxToCandela } from '../src/engine/GDTFAssetResolver.ts';
import type { ResolvedFixtureInstance } from '../src/engine/GDTFAssetResolver.ts';
import { buildGdtfArchive, patchUniverse } from '../tests/helpers/gdtfFixture.ts';

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.FogExp2(0x05060a, 0.022);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(7.4, 4.1, 9.6);
camera.lookAt(0, 2.4, 0);

/** Deck, so the beams land on something and read as a stage rather than a void. */
const deck = new THREE.Mesh(
  new THREE.PlaneGeometry(46, 46),
  new THREE.MeshStandardMaterial({ color: 0x0a0c12, roughness: 0.94, metalness: 0.04 }),
);
deck.rotation.x = -Math.PI / 2;
deck.receiveShadow = true;
scene.add(deck);

const grid = new THREE.GridHelper(46, 46, 0x1b2740, 0x111826);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.34;
scene.add(grid);

// Enough fill that the truss and fixture housings read as hardware; the show
// light itself comes from the GDTF-configured spots.
scene.add(new THREE.HemisphereLight(0x4a5a7a, 0x0a0c12, 1.15));
const key = new THREE.DirectionalLight(0x8fa4c8, 1.1);
key.position.set(-7, 11, 8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x5f7ba8, 0.55);
rim.position.set(6, 5, -9);
scene.add(rim);

/* -------------------------------------------------------------------------- */
/* Truss                                                                      */
/* -------------------------------------------------------------------------- */

const TRUSS_HEIGHT = 5.2;
const TRUSS_SPAN = 9.4;
const CHORD_OFFSET = 0.145; // F34 chord radius

/** An F34-proportioned box truss for the fixtures to hang from. */
function buildTruss(): THREE.Group {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa3b4, roughness: 0.42, metalness: 0.82 });

  for (const y of [CHORD_OFFSET, -CHORD_OFFSET]) {
    for (const z of [CHORD_OFFSET, -CHORD_OFFSET]) {
      const chord = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, TRUSS_SPAN, 10), metal);
      chord.rotation.z = Math.PI / 2;
      chord.position.set(0, y, z);
      chord.castShadow = true;
      group.add(chord);
    }
  }

  // Diagonal lacing, which is what makes a box truss read as truss.
  const braceCount = Math.floor(TRUSS_SPAN / 0.42);
  for (let i = 0; i <= braceCount; i++) {
    const x = -TRUSS_SPAN / 2 + (i * TRUSS_SPAN) / braceCount;
    for (const z of [CHORD_OFFSET, -CHORD_OFFSET]) {
      const brace = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, CHORD_OFFSET * 2 * Math.SQRT2, 6),
        metal,
      );
      brace.position.set(x, 0, z);
      brace.rotation.x = i % 2 === 0 ? Math.PI / 4 : -Math.PI / 4;
      group.add(brace);
    }
  }

  group.position.y = TRUSS_HEIGHT;
  return group;
}

scene.add(buildTruss());

/* -------------------------------------------------------------------------- */
/* Beam cones                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A visible cone at the GDTF field angle, cut to where the beam meets the deck.
 *
 * Purely a visualisation of photometry the resolver already configured on the
 * SpotLight -- it reads the light's own `angle`, so a cone that looks wrong
 * means the parsed `FieldAngle` is wrong. `throwDistance` comes from the
 * resolved world geometry rather than a constant, so a fixture whose kinematics
 * are wrong produces a beam that visibly misses the floor.
 */
function buildBeamCone(
  fieldAngleDegrees: number,
  throwDistance: number,
  color: THREE.Color,
): THREE.Mesh {
  const radius = Math.tan(THREE.MathUtils.degToRad(fieldAngleDegrees / 2)) * throwDistance;

  const geometry = new THREE.ConeGeometry(Math.max(radius, 0.04), throwDistance, 32, 1, true);
  // Apex at the emitter, opening along the emitter frame's +Y.
  geometry.translate(0, throwDistance / 2, 0);

  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Mesh(geometry, material);
}

/** A soft pool where a beam lands, so the throw reads as hitting something. */
function buildFloorPool(radius: number, color: THREE.Color): THREE.Mesh {
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(radius * 1.5, 0.22), 40),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  return pool;
}

/**
 * Distance from the emitter to the deck along the beam's own axis.
 *
 * Read off the resolved scene graph: the emitter's world position and the
 * direction its light target sits in. Returns null when the beam points up or
 * level, which has no floor intersection.
 */
function throwToFloor(fixture: ResolvedFixtureInstance): { distance: number; hit: THREE.Vector3 } | null {
  const origin = fixture.emitterGroup.getWorldPosition(new THREE.Vector3());
  const aim = fixture.light.target.getWorldPosition(new THREE.Vector3());
  const direction = aim.sub(origin).normalize();

  if (direction.y >= -1e-3) return null;

  const distance = origin.y / -direction.y;
  const hit = origin.clone().addScaledVector(direction, distance);
  return { distance, hit };
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

interface Rig {
  readonly fixture: ResolvedFixtureInstance;
  readonly pan: number;
  readonly tilt: number;
  readonly rgb: readonly [number, number, number];
  readonly label: string;
}

/**
 * Pan and tilt as normalized 16-bit DMX, 0.5 being mid-scale.
 *
 * Tilt near 0.5 hangs the beam straight down; the small spread fans the five
 * fixtures across the deck. Pan is a gentle cross so the kinematics are legible
 * rather than every head pointing the same way.
 */
const RIG_PLAN: { pan: number; tilt: number; rgb: [number, number, number]; label: string }[] = [
  { pan: 0.545, tilt: 0.60, rgb: [255, 48, 96], label: 'ROSE' },
  { pan: 0.525, tilt: 0.565, rgb: [64, 196, 255], label: 'CYAN' },
  { pan: 0.5, tilt: 0.5, rgb: [255, 214, 138], label: 'STRAW' },
  { pan: 0.475, tilt: 0.565, rgb: [138, 255, 158], label: 'LIME' },
  { pan: 0.455, tilt: 0.60, rgb: [196, 128, 255], label: 'LAVENDER' },
];

function setRow(table: HTMLTableElement, key: string, value: string): void {
  const row = table.insertRow();
  const k = row.insertCell();
  k.className = 'k';
  k.textContent = key;
  const v = row.insertCell();
  v.className = 'v';
  v.textContent = value;
}

async function main(): Promise<void> {
  const status = document.getElementById('status') as HTMLElement;

  status.textContent = 'building .gdtf archive…';
  const archive = await buildGdtfArchive();

  status.textContent = 'parsing description.xml…';
  const profile: GDTFProfile = await parseGDTF(archive);

  status.textContent = 'resolving fixtures…';
  const resolver = new GDTFAssetResolver();
  resolver.register(profile);

  const beamNode = findBeam(profile);
  const beam = beamNode?.beam;
  const fieldAngle = beam?.fieldAngleDegrees ?? 15;

  const rigs: Rig[] = [];

  RIG_PLAN.forEach((plan, index) => {
    const fixture = resolver.instantiateFixture(profile.fixtureTypeId, 'Standard');

    const x = -TRUSS_SPAN / 2 + 0.9 + (index * (TRUSS_SPAN - 1.8)) / (RIG_PLAN.length - 1);
    // Hung under the truss, no extra flip needed: the resolver's own neutral
    // pose already has the clamp facing up (into the chord) and the beam
    // firing down, which is exactly how a fixture actually hangs.
    fixture.root.position.set(x, TRUSS_HEIGHT - CHORD_OFFSET - 0.1, 0);

    fixture.light.castShadow = true;
    fixture.light.shadow.mapSize.set(1024, 1024);

    scene.add(fixture.root);
    rigs.push({ fixture, pan: plan.pan, tilt: plan.tilt, rgb: plan.rgb, label: plan.label });
  });

  // Drive every fixture through the real DMX path, then let the scene graph
  // settle so the beam geometry can be measured off the resolved kinematics.
  for (const rig of rigs) {
    rig.fixture.updateDMXChannels(
      patchUniverse({
        pan16: Math.round(65535 * rig.pan),
        tilt16: Math.round(65535 * rig.tilt),
        dimmer: 255,
        rgb: rig.rgb,
      }),
    );
  }
  scene.updateMatrixWorld(true);

  for (const rig of rigs) {
    const color = new THREE.Color(rig.rgb[0] / 255, rig.rgb[1] / 255, rig.rgb[2] / 255);
    const landing = throwToFloor(rig.fixture);
    if (landing === null) continue;

    rig.fixture.emitterGroup.add(buildBeamCone(fieldAngle, landing.distance, color));
    // eslint-disable-next-line
    ((window as unknown as Record<string, unknown>).__probe ??= []) as unknown[];
    ((window as unknown as Record<string, unknown>).__probe as unknown[]).push({
      label: rig.label,
      distance: Number(landing.distance.toFixed(3)),
      hit: [Number(landing.hit.x.toFixed(2)), Number(landing.hit.y.toFixed(2)), Number(landing.hit.z.toFixed(2))],
      emitterY: Number(rig.fixture.emitterGroup.getWorldPosition(new THREE.Vector3()).y.toFixed(3)),
      coneRadius: Number((Math.tan(THREE.MathUtils.degToRad(fieldAngle/2))*landing.distance).toFixed(3)),
    });

    const poolRadius = Math.tan(THREE.MathUtils.degToRad(fieldAngle / 2)) * landing.distance;
    const pool = buildFloorPool(poolRadius, color);
    pool.position.set(landing.hit.x, 0.012, landing.hit.z);
    scene.add(pool);
  }

  /* --- HUD ------------------------------------------------------------- */

  const table = document.getElementById('profile-table') as HTMLTableElement;
  const mode = profile.dmxModes[0];

  setRow(table, 'Manufacturer', profile.manufacturer);
  setRow(table, 'Fixture', profile.name);
  setRow(table, 'FixtureTypeID', `${profile.fixtureTypeId.slice(0, 13)}…`);
  setRow(table, 'GDTF version', profile.dataVersion);
  setRow(table, 'DMX mode', `${mode.name} · ${mode.footprint} ch`);
  setRow(table, 'Channels parsed', String(mode.channels.length));
  setRow(table, 'Attributes', String(profile.attributes.length));
  setRow(table, 'Lamp', beam?.lampType ?? '—');
  setRow(table, 'Luminous flux', `${(beam?.luminousFluxLumens ?? 0).toLocaleString()} lm`);
  setRow(table, 'Colour temp', `${beam?.colorTemperatureKelvin ?? 0} K`);
  setRow(table, 'Beam / field', `${beam?.beamAngleDegrees ?? 0}° / ${fieldAngle}°`);
  setRow(
    table,
    'Peak intensity',
    `${Math.round(fluxToCandela(beam?.luminousFluxLumens ?? 0, fieldAngle)).toLocaleString()} cd`,
  );
  setRow(table, 'Sockets', String((rigs[0].fixture.root.userData.sockets as unknown[]).length));
  setRow(table, 'Kinematics', String((rigs[0].fixture.root.userData.kinematics as unknown[]).length));

  const legend = document.getElementById('legend') as HTMLElement;
  legend.innerHTML = rigs
    .map((rig) => {
      const state = rig.fixture.updateDMXChannels(
        patchUniverse({
          pan16: Math.round(65535 * rig.pan),
          tilt16: Math.round(65535 * rig.tilt),
          dimmer: 255,
          rgb: rig.rgb,
        }),
      );
      return `<div class="fx">
          <div class="name">${rig.label}</div>
          <div class="val">P ${state.panDegrees.toFixed(1)}°</div>
          <div class="val">T ${state.tiltDegrees.toFixed(1)}°</div>
        </div>`;
    })
    .join('');

  status.innerHTML =
    `<b>RESOLVED</b> · ${rigs.length} fixtures · ` +
    `${mode.footprint} ch each · parsed from description.xml`;

  // Signals to the screenshot harness that the scene is fully built.
  document.body.dataset.ready = 'true';
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                       */
/* -------------------------------------------------------------------------- */

function render(): void {
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

main()
  .then(render)
  .catch((error: unknown) => {
    const status = document.getElementById('status') as HTMLElement;
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
    document.body.dataset.ready = 'error';
    console.error(error);
  });
