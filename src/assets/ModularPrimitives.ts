/**
 * Procedural modular show assets with embedded `extras.sockets` metadata.
 *
 * These stand in for the authored glTF library until real scanned/CAD assets
 * land. They are built to true rental-stock dimensions so that a plot laid out
 * against them stays valid when the real geometry is swapped in, and so that
 * socket positions match the UE5 asset definitions one-for-one.
 *
 * Units are METERS throughout (imperial stock is converted at the constant).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SocketDefinition, Vec3Tuple } from '../engine/SocketSnappingEngine.ts';
import { writeSockets } from '../engine/SocketSnappingEngine.ts';

const FEET_TO_METERS = 0.3048;

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A capped cylinder spanning two points. Three's CylinderGeometry is built
 * along +Y centred on the origin, so it is swung onto the segment direction and
 * translated to the segment midpoint.
 */
function tubeBetween(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  radialSegments = 8,
): THREE.BufferGeometry {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, false);

  const swing = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.clone().normalize(),
  );
  geometry.applyQuaternion(swing);

  const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  geometry.translate(midpoint.x, midpoint.y, midpoint.z);
  return geometry;
}

/**
 * Zig-zag lacing between two parallel chords, the standard W-brace pattern on
 * a box truss face. Alternating bay boundaries are tied to alternating chords.
 */
function laceFace(
  chordA: (x: number) => THREE.Vector3,
  chordB: (x: number) => THREE.Vector3,
  halfLength: number,
  bays: number,
  radius: number,
): THREE.BufferGeometry[] {
  const segments: THREE.BufferGeometry[] = [];
  const step = (halfLength * 2) / bays;

  let previous = chordA(-halfLength);
  for (let i = 1; i <= bays; i++) {
    const x = -halfLength + step * i;
    const current = i % 2 === 1 ? chordB(x) : chordA(x);
    segments.push(tubeBetween(previous, current, radius, 6));
    previous = current;
  }
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                   */
/* -------------------------------------------------------------------------- */

/** Mill-finish aluminium, as used for truss chords and deck frames. */
export function createAluminiumMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xb9bec4,
    metalness: 0.85,
    roughness: 0.38,
  });
}

/** Non-slip plywood deck surface. */
export function createDeckSurfaceMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x2b2b2f,
    metalness: 0.05,
    roughness: 0.92,
  });
}

/* -------------------------------------------------------------------------- */
/* F34 box truss -- 2 m stick                                                  */
/* -------------------------------------------------------------------------- */

/** F34-series square box truss: 290 mm centres, 50 mm main chords. */
export const F34 = {
  /** Chord centre-to-centre across the square section, meters. */
  SECTION: 0.29,
  /** Main chord outer diameter, meters. */
  CHORD_DIAMETER: 0.05,
  /** Lacing/brace diameter, meters. */
  BRACE_DIAMETER: 0.02,
  /** Stick length, meters. */
  LENGTH: 2.0,
  /** Lacing bays per face over the stick length. */
  BAYS: 4,
  /** Working load limit per chord interface, kilograms. */
  CHORD_LOAD_RATING_KG: 750,
} as const;

/**
 * The four chord positions in the YZ cross-section, keyed for socket naming.
 * The truss runs along X; End A is +X (male), End B is -X (female).
 */
const F34_CHORDS = [
  { key: 'top_near', y: +1, z: +1 },
  { key: 'top_far', y: +1, z: -1 },
  { key: 'bottom_near', y: -1, z: +1 },
  { key: 'bottom_far', y: -1, z: -1 },
] as const;

function buildF34Sockets(): SocketDefinition[] {
  const half = F34.SECTION / 2;
  const halfLength = F34.LENGTH / 2;
  const sockets: SocketDefinition[] = [];

  // Both ends carry the same four chord interfaces; only the polarity and the
  // outward normal differ. Square symmetry means any 90 degree detent yields a
  // physically valid joint, which is exactly what the detent snapping relies on.
  const ends = [
    { prefix: 'end_a', x: +halfLength, normal: [1, 0, 0] as Vec3Tuple, gender: 'male' },
    { prefix: 'end_b', x: -halfLength, normal: [-1, 0, 0] as Vec3Tuple, gender: 'female' },
  ] as const;

  for (const end of ends) {
    for (const chord of F34_CHORDS) {
      sockets.push({
        socket_id: `${end.prefix}_${chord.key}`,
        socket_type: 'truss_f34_chord',
        gender: end.gender,
        position: [end.x, chord.y * half, chord.z * half],
        normal: end.normal,
        // The roll reference points RADIALLY OUTWARD from the truss centreline
        // toward this chord. That is what encodes the chord's angular position
        // around the axis, so aligning two sockets' up-vectors also puts the
        // remaining three chord pairs in correspondence. A shared up of (0,1,0)
        // would align one chord and leave the other three crossed.
        up: [0, chord.y, chord.z],
        tags: [end.prefix, chord.key],
        load_rating_kg: F34.CHORD_LOAD_RATING_KG,
      });
    }
  }

  return sockets;
}

/**
 * Build a 2 m F34 quad box truss stick.
 *
 * Origin is the geometric centre of the stick. Length runs along X:
 * End A (+X) carries four MALE chord sockets, End B (-X) four FEMALE.
 */
export function createF34BoxTruss2M(): THREE.Mesh {
  const half = F34.SECTION / 2;
  const halfLength = F34.LENGTH / 2;
  const chordRadius = F34.CHORD_DIAMETER / 2;
  const braceRadius = F34.BRACE_DIAMETER / 2;

  const parts: THREE.BufferGeometry[] = [];

  // Four main chords running the full length.
  const chordLine = (yS: number, zS: number) => (x: number) =>
    new THREE.Vector3(x, yS * half, zS * half);

  for (const chord of F34_CHORDS) {
    const line = chordLine(chord.y, chord.z);
    parts.push(tubeBetween(line(-halfLength), line(+halfLength), chordRadius, 10));
  }

  // Lacing on all four faces of the box.
  const faces = [
    [F34_CHORDS[0], F34_CHORDS[1]], // top
    [F34_CHORDS[2], F34_CHORDS[3]], // bottom
    [F34_CHORDS[0], F34_CHORDS[2]], // near
    [F34_CHORDS[1], F34_CHORDS[3]], // far
  ] as const;

  for (const [a, b] of faces) {
    parts.push(
      ...laceFace(
        chordLine(a.y, a.z),
        chordLine(b.y, b.z),
        halfLength,
        F34.BAYS,
        braceRadius,
      ),
    );
  }

  const geometry = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, createAluminiumMaterial());
  mesh.name = 'F34_Box_Truss_2M';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  writeSockets(mesh, buildF34Sockets());
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* 4 x 8 stage deck                                                            */
/* -------------------------------------------------------------------------- */

/** Standard 4 ft x 8 ft modular stage deck. */
export const DECK_4X8 = {
  /** 8 ft along X, meters. */
  LENGTH: 8 * FEET_TO_METERS,
  /** 4 ft along Z, meters. */
  WIDTH: 4 * FEET_TO_METERS,
  /** Frame depth below the walking surface, meters. */
  THICKNESS: 0.075,
  /** How far the leg receivers sit in from the corners, meters. */
  LEG_INSET: 0.05,
  /** Working load limit per coffin lock, kilograms. */
  LOCK_LOAD_RATING_KG: 500,
} as const;

function buildDeck4x8Sockets(): SocketDefinition[] {
  const halfLength = DECK_4X8.LENGTH / 2;
  const halfWidth = DECK_4X8.WIDTH / 2;
  // Locks sit at mid-depth of the frame rail, below the walking surface.
  const lockY = -DECK_4X8.THICKNESS / 2;
  const quarterLength = DECK_4X8.LENGTH / 4;

  const sockets: SocketDefinition[] = [];

  // Six coffin locks: two per long side, one per short side.
  // Coffin locks are hermaphroditic -- a lock mates with an identical lock --
  // so they are `neutral`, and neutral mates only with neutral.
  const longSides = [
    { key: 'near', z: +halfWidth, normal: [0, 0, 1] as Vec3Tuple },
    { key: 'far', z: -halfWidth, normal: [0, 0, -1] as Vec3Tuple },
  ] as const;

  for (const side of longSides) {
    for (const [index, x] of [-quarterLength, +quarterLength].entries()) {
      sockets.push({
        socket_id: `lock_${side.key}_${index + 1}`,
        socket_type: 'deck_coffin_lock',
        gender: 'neutral',
        position: [x, lockY, side.z],
        normal: side.normal,
        up: [0, 1, 0],
        tags: ['perimeter', `side_${side.key}`],
        load_rating_kg: DECK_4X8.LOCK_LOAD_RATING_KG,
      });
    }
  }

  const shortSides = [
    { key: 'end_a', x: +halfLength, normal: [1, 0, 0] as Vec3Tuple },
    { key: 'end_b', x: -halfLength, normal: [-1, 0, 0] as Vec3Tuple },
  ] as const;

  for (const side of shortSides) {
    sockets.push({
      socket_id: `lock_${side.key}`,
      socket_type: 'deck_coffin_lock',
      gender: 'neutral',
      position: [side.x, lockY, 0],
      normal: side.normal,
      up: [0, 1, 0],
      tags: ['perimeter', `side_${side.key}`],
      load_rating_kg: DECK_4X8.LOCK_LOAD_RATING_KG,
    });
  }

  // Four corner leg receivers, facing down. They are FEMALE: a leg's male
  // spigot drops into them.
  const legX = halfLength - DECK_4X8.LEG_INSET;
  const legZ = halfWidth - DECK_4X8.LEG_INSET;
  const corners = [
    { key: 'a_near', x: +legX, z: +legZ },
    { key: 'a_far', x: +legX, z: -legZ },
    { key: 'b_near', x: -legX, z: +legZ },
    { key: 'b_far', x: -legX, z: -legZ },
  ] as const;

  for (const corner of corners) {
    sockets.push({
      socket_id: `leg_${corner.key}`,
      socket_type: 'deck_leg',
      gender: 'female',
      position: [corner.x, -DECK_4X8.THICKNESS, corner.z],
      normal: [0, -1, 0],
      // The mating axis is vertical, so the roll reference must be horizontal.
      up: [1, 0, 0],
      tags: ['leg_receiver', `corner_${corner.key}`],
    });
  }

  return sockets;
}

/**
 * Build a 4 ft x 8 ft modular stage deck.
 *
 * Origin is the centre of the WALKING SURFACE (y = 0), with the frame hanging
 * below to -THICKNESS. Anchoring at the walking surface means deck height is
 * set purely by leg length, matching how the crew actually builds.
 */
export function createStageDeck4x8(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Stage_Deck_4x8';

  const { LENGTH, WIDTH, THICKNESS } = DECK_4X8;

  // Walking surface: a thin plate whose top face sits exactly at y = 0.
  const surfaceThickness = 0.018;
  const surface = new THREE.Mesh(
    new THREE.BoxGeometry(LENGTH, surfaceThickness, WIDTH),
    createDeckSurfaceMaterial(),
  );
  surface.position.y = -surfaceThickness / 2;
  surface.castShadow = true;
  surface.receiveShadow = true;
  group.add(surface);

  // Perimeter frame rails, inset under the surface edge.
  const railThickness = 0.04;
  const railDepth = THICKNESS - surfaceThickness;
  const railY = -surfaceThickness - railDepth / 2;
  const frameMaterial = createAluminiumMaterial();

  const rails: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(LENGTH, railDepth, railThickness).translate(
      0,
      railY,
      WIDTH / 2 - railThickness / 2,
    ),
    new THREE.BoxGeometry(LENGTH, railDepth, railThickness).translate(
      0,
      railY,
      -WIDTH / 2 + railThickness / 2,
    ),
    new THREE.BoxGeometry(railThickness, railDepth, WIDTH - railThickness * 2).translate(
      LENGTH / 2 - railThickness / 2,
      railY,
      0,
    ),
    new THREE.BoxGeometry(railThickness, railDepth, WIDTH - railThickness * 2).translate(
      -LENGTH / 2 + railThickness / 2,
      railY,
      0,
    ),
  ];

  const frameGeometry = mergeGeometries(rails, false);
  rails.forEach((r) => r.dispose());
  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);

  writeSockets(group, buildDeck4x8Sockets());
  return group;
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export const MODULAR_ASSET_IDS = ['F34_Box_Truss_2M', 'Stage_Deck_4x8'] as const;
export type ModularAssetId = (typeof MODULAR_ASSET_IDS)[number];

/** Instantiate a catalogue asset by id. */
export function createModularAsset(id: ModularAssetId): THREE.Object3D {
  switch (id) {
    case 'F34_Box_Truss_2M':
      return createF34BoxTruss2M();
    case 'Stage_Deck_4x8':
      return createStageDeck4x8();
  }
}
