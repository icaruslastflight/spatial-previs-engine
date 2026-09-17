/**
 * Festival stage — the reference rig.
 *
 * A 4 m × 4.29 m main box on four 6 m totems, rear spans at 4 m and 6 m, and
 * two arms that splay 30 degrees off the downstage corners before turning 90
 * degrees inward, each carrying its own ground-support totems. Subs sit flush
 * with the downstage edge; three decks run upstage of them.
 *
 * Authored as a plot in the live viewport and lifted here verbatim, so the
 * numbers below are a design, not a derivation — do not "tidy" them. Chord
 * offsets land on 0.145 m because that is the F34 chord radius, and the
 * 3.29 / 4.29 arm runs are stick length plus the 6-way corner's shoulder.
 *
 * Structure only. Fixtures are reported as mount points rather than placed,
 * because the two callers want different things hanging there: the sample
 * viewport wants cheap GLB props, the showcase wants real GDTF-resolved
 * fixtures driven over DMX. Whoever builds the rig decides what it carries.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { createStageDeck4x8 } from './ModularPrimitives.ts';

/** Where a fixture can hang, and which way it points. */
export interface FixtureMount {
  position: THREE.Vector3;
  /** `down` hangs under the chord; `up` sits on top of it. */
  facing: 'down' | 'up';
  /** Which run this mount belongs to — lets a caller chase per-truss. */
  run: 'rear-top' | 'arm-left' | 'arm-right';
  /**
   * The placeholder prop hanging here, when props were placed. A caller
   * resolving a real GDTF fixture onto this mount hides the prop rather than
   * leaving two bodies in the same 145 mm of air.
   */
  prop?: THREE.Object3D;
}

export interface FestivalStage {
  /** Everything built, parented under one group. */
  group: THREE.Group;
  /** Truss pieces and decks, for callers that register snap sockets. */
  registerable: THREE.Object3D[];
  mounts: FixtureMount[];
  subs: THREE.Mesh[];
  decks: THREE.Object3D[];
  /** Upstage LED wall, so a caller can drive content onto it. */
  ledWall: THREE.Mesh;
  /** COLORstrip bars along the arm legs, each with four addressable zones. */
  ledBars: THREE.Group[];
}

export interface FestivalStageOptions {
  /** Vite base path. Defaults to the app's own, which is what both callers want. */
  baseUrl?: string;
  /**
   * Place the low-cost beam/wash GLB props at every mount. The showcase turns
   * this off because it resolves real GDTF fixtures onto the same points.
   */
  placeFixtureProps?: boolean;
}

/* Plot constants — see the file header before changing any of these. */
const Z_FRONT = 0;
const Z_BACK = -4.29;
const X_L = -2.145;
const X_R = 2.145;
const Y_3M = 3.145;
const Y_4M = 4.435;
const Y_6M = 6.725;

/** F34 chord radius. Fixtures clear the chord by exactly this much. */
const CHORD = 0.145;

/**
 * Chauvet DJ COLORstrip — a 38 in RGB LED bar, four independently addressable
 * zones along its length. Housing is near enough square in section at ~70 mm.
 */
const COLORSTRIP_LENGTH = 38 * 0.0254;
const COLORSTRIP_SECTION = 0.07;
const COLORSTRIP_ZONES = 4;

/** How far off the truss centreline the bars hang, on the audience side. */
const COLORSTRIP_STANDOFF = 0.2;

function createColorstrip(): THREE.Group {
  const bar = new THREE.Group();
  bar.name = 'colorstrip-38';

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(COLORSTRIP_LENGTH, COLORSTRIP_SECTION, COLORSTRIP_SECTION),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.85, metalness: 0.1 }),
  );
  bar.add(housing);

  // Four emissive zones on the front face, matching the fixture's real
  // addressing — a caller driving DMX can recolour each one independently.
  const zoneWidth = (COLORSTRIP_LENGTH / COLORSTRIP_ZONES) * 0.88;
  for (let i = 0; i < COLORSTRIP_ZONES; i++) {
    const zone = new THREE.Mesh(
      new THREE.PlaneGeometry(zoneWidth, COLORSTRIP_SECTION * 0.62),
      new THREE.MeshStandardMaterial({
        color: 0x101014,
        emissive: 0x2050c0,
        emissiveIntensity: 0.9,
        roughness: 0.4,
      }),
    );
    const centre = -COLORSTRIP_LENGTH / 2 + (COLORSTRIP_LENGTH / COLORSTRIP_ZONES) * (i + 0.5);
    zone.position.set(centre, 0, COLORSTRIP_SECTION / 2 + 0.002);
    zone.name = `zone-${i + 1}`;
    bar.add(zone);
  }

  return bar;
}

const MODELS = {
  t3m: 'assets/models/trussing/truss_f34_box_3m.glb',
  t2m: 'assets/models/trussing/truss_f34_box_2m.glb',
  t1m: 'assets/models/trussing/truss_f34_box_1m.glb',
  corner: 'assets/models/trussing/truss_f34_corner_6way.glb',
  beam: 'assets/models/lighting/moving_head_beam.glb',
  wash: 'assets/models/lighting/moving_head_wash.glb',
} as const;

type ModelKey = keyof typeof MODELS;

export async function buildFestivalStage(
  options: FestivalStageOptions = {},
): Promise<FestivalStage> {
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  const placeProps = options.placeFixtureProps ?? true;

  const loader = new GLTFLoader();
  const keys = Object.keys(MODELS) as ModelKey[];
  const loaded = await Promise.all(
    keys.map((key) => loader.loadAsync(`${baseUrl}${MODELS[key]}`)),
  );
  const proto = {} as Record<ModelKey, THREE.Object3D>;
  keys.forEach((key, index) => {
    proto[key] = loaded[index].scene;
  });

  const group = new THREE.Group();
  group.name = 'festival-stage';
  const registerable: THREE.Object3D[] = [];
  const mounts: FixtureMount[] = [];
  const subs: THREE.Mesh[] = [];
  const decks: THREE.Object3D[] = [];
  const ledBars: THREE.Group[] = [];

  const qVert = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const qSide = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  function place(key: ModelKey, pos: THREE.Vector3, quat?: THREE.Quaternion): THREE.Object3D {
    const object = proto[key].clone();
    object.position.copy(pos);
    if (quat) object.quaternion.copy(quat);
    group.add(object);
    object.updateMatrixWorld(true);
    registerable.push(object);
    return object;
  }

  /** Record a mount, and optionally hang the placeholder prop on it. */
  function mount(position: THREE.Vector3, facing: 'down' | 'up', run: FixtureMount['run']): void {
    const entry: FixtureMount = { position: position.clone(), facing, run };
    if (placeProps) {
      entry.prop =
        facing === 'up' ? place('beam', position) : place('wash', position, qFlip);
    }
    mounts.push(entry);
  }

  /* ---- Main box verticals ------------------------------------------------ */

  for (const x of [X_L, X_R]) {
    // Downstage totems: two 3 m sticks with a corner at each junction.
    place('t3m', new THREE.Vector3(x, 1.5, Z_FRONT), qVert);
    place('corner', new THREE.Vector3(x, Y_3M, Z_FRONT));
    place('t3m', new THREE.Vector3(x, 4.79, Z_FRONT), qVert);
    place('corner', new THREE.Vector3(x, 6.435, Z_FRONT));

    // Upstage totems break at 4 m so the rear span has something to land on.
    place('t3m', new THREE.Vector3(x, 1.5, Z_BACK), qVert);
    place('corner', new THREE.Vector3(x, Y_3M, Z_BACK));
    place('t1m', new THREE.Vector3(x, 3.79, Z_BACK), qVert);
    place('corner', new THREE.Vector3(x, Y_4M, Z_BACK));
    place('t2m', new THREE.Vector3(x, 5.58, Z_BACK), qVert);
    place('corner', new THREE.Vector3(x, Y_6M, Z_BACK));
  }

  /* ---- Main box horizontals ---------------------------------------------- */

  for (const x of [-1.0, 1.0]) {
    place('t2m', new THREE.Vector3(x, Y_4M, Z_BACK)); // rear span, 4 m
    place('t2m', new THREE.Vector3(x, Y_6M, Z_BACK)); // rear top span, 6 m
  }

  // Side spans sit at 3 m so they meet the arms at the same junction.
  for (const x of [X_L, X_R]) {
    for (const z of [-1.145, -3.145]) {
      place('t2m', new THREE.Vector3(x, Y_3M, z), qSide);
    }
  }

  // Four gobo units hang off the rear top span.
  for (let i = 0; i < 4; i++) {
    mount(new THREE.Vector3(-1.5 + i * 1.0, Y_6M - CHORD, Z_BACK), 'down', 'rear-top');
  }

  /* ---- Arms -------------------------------------------------------------- */

  function buildArm(isLeft: boolean): void {
    const sign = isLeft ? -1 : 1;
    const run: FixtureMount['run'] = isLeft ? 'arm-left' : 'arm-right';
    const P0 = new THREE.Vector3(sign * X_R, Y_3M, Z_FRONT);

    // Out 30 degrees from the downstage corner, toward the audience.
    const angle1 = (30 * Math.PI) / 180;
    const dir1 = new THREE.Vector3(sign * Math.sin(angle1), 0, Math.cos(angle1)).normalize();

    const P1 = P0.clone().add(dir1.clone().multiplyScalar(3.29));
    const P2 = P1.clone().add(dir1.clone().multiplyScalar(4.29));

    // Then 90 degrees inward, so the two arms close toward each other.
    const dir2 = dir1
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), isLeft ? Math.PI / 2 : -Math.PI / 2)
      .normalize();
    const P3 = P2.clone().add(dir2.clone().multiplyScalar(3.29));

    const q1 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir1);
    const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir2);

    // Each corner gets a totem to the deck — the arms are not cantilevered.
    place('t3m', P0.clone().add(dir1.clone().multiplyScalar(1.645)), q1);
    place('corner', P1);
    place('t3m', new THREE.Vector3(P1.x, 1.5, P1.z), qVert);

    place('t3m', P1.clone().add(dir1.clone().multiplyScalar(1.645)), q1);
    place('t1m', P1.clone().add(dir1.clone().multiplyScalar(3.645)), q1);
    place('corner', P2);
    place('t3m', new THREE.Vector3(P2.x, 1.5, P2.z), qVert);

    place('t3m', P2.clone().add(dir2.clone().multiplyScalar(1.645)), q2);
    place('corner', P3);
    place('t3m', new THREE.Vector3(P3.x, 1.5, P3.z), qVert);

    // The arms deliberately stop at the 3 m fixture line. An earlier revision
    // carried a second storey up to 6 m at P1 and P2; it closed the sightline
    // from the audience into the box, so the outboard corners stay single-height.

    // Fixture runs: 3 along the first stick, 4 along the second pair, 3 inward.
    const runs: Array<{ origin: THREE.Vector3; dir: THREE.Vector3; count: number; span: number }> = [
      { origin: P0, dir: dir1, count: 3, span: 3.29 },
      { origin: P1, dir: dir1, count: 4, span: 4.29 },
      { origin: P2, dir: dir2, count: 3, span: 3.29 },
    ];
    for (const leg of runs) {
      for (let i = 0; i < leg.count; i++) {
        const p = leg.origin.clone().add(leg.dir.clone().multiplyScalar(0.645 + i * 1.0));
        mount(new THREE.Vector3(p.x, Y_3M + CHORD, p.z), 'up', run);
        mount(new THREE.Vector3(p.x, Y_3M - CHORD, p.z), 'down', run);
      }

      // COLORstrips run the length of each leg on the audience-facing side.
      // The perpendicular is taken in the horizontal plane and flipped toward
      // +Z so every bar faces front regardless of which way the leg runs.
      const perp = new THREE.Vector3()
        .crossVectors(leg.dir, new THREE.Vector3(0, 1, 0))
        .normalize();
      if (perp.z < 0) perp.negate();

      const barCount = Math.floor(leg.span / COLORSTRIP_LENGTH);
      const barQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(1, 0, 0),
        leg.dir,
      );
      for (let i = 0; i < barCount; i++) {
        const along = COLORSTRIP_LENGTH * (i + 0.5);
        const p = leg.origin
          .clone()
          .add(leg.dir.clone().multiplyScalar(along))
          .add(perp.clone().multiplyScalar(COLORSTRIP_STANDOFF));
        const bar = createColorstrip();
        bar.position.set(p.x, Y_3M, p.z);
        bar.quaternion.copy(barQuat);
        group.add(bar);
        ledBars.push(bar);
      }
    }
  }

  buildArm(true);
  buildArm(false);

  /* ---- LED video wall ---------------------------------------------------- */

  // Fills the upstage opening: as wide as the clear span between the two
  // upstage totems, bottom clear of the deck surface, top landing on the 4 m
  // rear span. Sits on the downstage face of the upstage truss so the chords
  // read in front of it rather than z-fighting through it.
  const wallWidth = X_R - X_L - CHORD * 2;
  const wallBottom = 1.0;
  const wallTop = Y_4M - CHORD;
  const wallHeight = wallTop - wallBottom;
  const wallZ = Z_BACK + CHORD;

  const ledWall = new THREE.Mesh(
    new THREE.PlaneGeometry(wallWidth, wallHeight),
    new THREE.MeshStandardMaterial({
      color: 0x1a2a4a,
      emissive: 0x1a3a7a,
      emissiveIntensity: 0.6,
      roughness: 0.5,
      metalness: 0.2,
    }),
  );
  ledWall.position.set(0, wallBottom + wallHeight / 2, wallZ);
  group.add(ledWall);

  // Pixel grid at roughly 160 mm pitch, so the panel still reads as LED close up.
  const ledGrid = new THREE.GridHelper(
    wallWidth,
    Math.max(1, Math.round(wallWidth / 0.16)),
    0x2a5080,
    0x1a3060,
  );
  const gridMaterial = ledGrid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.3;
  ledGrid.rotation.x = Math.PI / 2;
  ledGrid.position.set(0, wallBottom + wallHeight / 2, wallZ + 0.02);
  group.add(ledGrid);

  /* ---- Subs -------------------------------------------------------------- */

  // Front face flush with the downstage edge, so centre sits back by half depth.
  const subGeometry = new THREE.BoxGeometry(1.2, 0.8, 0.8);
  const subMaterial = new THREE.MeshStandardMaterial({ color: 0x1e578c, roughness: 0.7 });
  for (const x of [-1.25, 0, 1.25]) {
    for (let tier = 0; tier < 2; tier++) {
      const sub = new THREE.Mesh(subGeometry, subMaterial);
      sub.position.set(x, 0.4 + tier * 0.8, -0.4);
      sub.castShadow = true;
      sub.receiveShadow = true;
      group.add(sub);
      subs.push(sub);
    }
  }

  /* ---- Decks ------------------------------------------------------------- */

  // Turned so the long edge runs upstage, three across, immediately behind the subs.
  for (const x of [-1.219, 0, 1.219]) {
    const deck = createStageDeck4x8();
    deck.rotation.y = Math.PI / 2;
    deck.position.set(x, 0.91, -2.019);
    group.add(deck);
    deck.updateMatrixWorld(true);
    registerable.push(deck);
    decks.push(deck);
  }

  return { group, registerable, mounts, subs, decks, ledWall, ledBars };
}
