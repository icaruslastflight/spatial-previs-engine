/**
 * Procedural gobo patterns.
 *
 * A gobo is a patterned mask at the fixture's gate; the beam carries the
 * pattern to whatever it lands on. Three models exactly that through
 * `SpotLight.map`, which multiplies the projected light, so the texture is
 * authored white-where-light-passes on black -- the same polarity as a real
 * steel or glass gobo held up to the light.
 *
 * Generated rather than shipped as image files: §11 keeps binaries out of git,
 * and a gobo that is drawn from a seed can be re-rolled per fixture so a rig
 * does not project twenty identical breakups.
 *
 * Every pattern is vignetted to a circle. The gate is round, so a pattern that
 * runs to the corners of its texture projects a square beam -- which is the
 * giveaway that a previz rig is faking its gobos.
 */

import * as THREE from 'three';

export const GOBO_PATTERNS = ['breakup', 'dots', 'spokes', 'rings', 'open'] as const;
export type GoboPattern = (typeof GOBO_PATTERNS)[number];

const SIZE = 256;

/** Deterministic PRNG so a given seed always draws the same gobo. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fade the pattern out at the gate edge so the beam stays round and soft. */
function applyGateVignette(ctx: CanvasRenderingContext2D): void {
  const centre = SIZE / 2;
  const mask = ctx.createRadialGradient(centre, centre, centre * 0.62, centre, centre, centre * 0.5 + centre * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,0)');
  mask.addColorStop(0.82, 'rgba(0,0,0,0.35)');
  mask.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

function drawBreakup(ctx: CanvasRenderingContext2D, rand: () => number): void {
  // Foliage breakup: overlapping soft blobs, the most common house gobo.
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 70; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * SIZE * 0.46;
    const x = SIZE / 2 + Math.cos(angle) * radius;
    const y = SIZE / 2 + Math.sin(angle) * radius;
    const r = 6 + rand() * 20;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.55 + rand() * 0.8), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Punch holes back out so the pattern reads as gaps in leaves, not a blob.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 45; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * SIZE * 0.46;
    ctx.beginPath();
    ctx.arc(SIZE / 2 + Math.cos(angle) * radius, SIZE / 2 + Math.sin(angle) * radius, 4 + rand() * 14, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawDots(ctx: CanvasRenderingContext2D): void {
  // Hex-packed dot array — the "beam splitter" look, sharp edges on purpose.
  const pitch = SIZE / 11;
  ctx.fillStyle = '#fff';
  for (let row = -1; row <= 12; row++) {
    for (let col = -1; col <= 12; col++) {
      const x = col * pitch + (row % 2 === 0 ? 0 : pitch / 2);
      const y = row * pitch * 0.87;
      ctx.beginPath();
      ctx.arc(x, y, pitch * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSpokes(ctx: CanvasRenderingContext2D): void {
  const centre = SIZE / 2;
  const count = 12;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < count; i++) {
    const from = (i / count) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(centre, centre);
    ctx.arc(centre, centre, centre, from, from + Math.PI / count);
    ctx.closePath();
    ctx.fill();
  }
  // Open centre, so the beam still has a hot core rather than a pinwheel hub.
  ctx.beginPath();
  ctx.arc(centre, centre, centre * 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function drawRings(ctx: CanvasRenderingContext2D): void {
  const centre = SIZE / 2;
  ctx.strokeStyle = '#fff';
  for (let i = 1; i <= 6; i++) {
    const r = (i / 6.4) * centre;
    ctx.lineWidth = centre * 0.055;
    ctx.beginPath();
    ctx.arc(centre, centre, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Draw one gobo. `open` is the no-gobo position every real wheel carries, and
 * is returned as a plain soft circle rather than as null so a caller can put it
 * in a wheel alongside the others without branching.
 */
export function createGoboTexture(pattern: GoboPattern, seed = 1): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('[GoboTextures] 2D canvas context unavailable');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const rand = mulberry32(seed * 2654435761);
  switch (pattern) {
    case 'breakup': drawBreakup(ctx, rand); break;
    case 'dots':    drawDots(ctx); break;
    case 'spokes':  drawSpokes(ctx); break;
    case 'rings':   drawRings(ctx); break;
    case 'open':    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE); break;
  }

  applyGateVignette(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // The gate is sampled well outside 0..1 by the projection matrix at grazing
  // angles; clamping stops the pattern tiling out across the floor.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A small wheel of distinct gobos, as a fixture would carry. */
export function createGoboWheel(patterns: readonly GoboPattern[] = GOBO_PATTERNS): THREE.CanvasTexture[] {
  return patterns.map((pattern, index) => createGoboTexture(pattern, index + 1));
}
