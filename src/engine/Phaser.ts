/**
 * grandMA3-style phaser (effect engine).
 *
 * A phaser drives one attribute through a repeating list of steps. Three
 * console concepts carry over verbatim, because they are what make a chase
 * readable on a real rig:
 *
 * - **Speed is in BPM, and one beat advances one step.** A four-step phaser at
 *   120 BPM therefore cycles every two seconds. Expressing speed as a cycle
 *   period instead would make two phasers with different step counts drift out
 *   of time with each other and with the music.
 * - **Phase is in degrees, 0-360, spread across a group.** Each fixture reads
 *   the same phaser at its own offset into the cycle, which is what turns one
 *   effect into a chase. 0 and 360 are the same point on the cycle -- see
 *   `distributePhase`.
 * - **Transition is the fraction of a step spent moving.** 0 snaps at the step
 *   boundary (a bump chase); 1 fades across the whole step (a smooth sweep).
 *
 * Evaluation is pure: time and phase in, value out. Nothing here holds frame
 * state, so the same phaser can be read by the render loop, by a test at an
 * arbitrary timestamp, and by the desktop dispatcher without the three
 * disagreeing.
 */

/** A full turn of phase. Phase is expressed in degrees, as consoles do. */
export const DEGREES_PER_TURN = 360;

export const PHASER_EASINGS = ['linear', 'sine', 'accel', 'decel'] as const;
export type PhaserEasing = (typeof PHASER_EASINGS)[number];

export class PhaserError extends Error {}

export interface PhaserStep {
  /** Attribute value held at this step. Units are the caller's. */
  value: number;
  /**
   * Fraction of this step spent fading to the *next* step's value, 0..1.
   * Defaults to 1 (fade the whole step). 0 holds and snaps at the boundary.
   */
  transition?: number;
}

export interface PhaserConfig {
  steps: readonly PhaserStep[];
  /** Beats per minute. One beat advances one step. */
  speedBpm: number;
  /** Shape of the fade within a step. Defaults to `sine`, the console default. */
  easing?: PhaserEasing;
}

/** Positive modulo — negative times and phases must still land in the cycle. */
function wrap(value: number, span: number): number {
  const remainder = value % span;
  return remainder < 0 ? remainder + span : remainder;
}

function ease(k: number, easing: PhaserEasing): number {
  switch (easing) {
    case 'linear':
      return k;
    case 'accel':
      return k * k;
    case 'decel':
      return 1 - (1 - k) * (1 - k);
    case 'sine':
      return 0.5 - 0.5 * Math.cos(Math.PI * k);
  }
}

export class Phaser {
  readonly steps: readonly PhaserStep[];
  readonly speedBpm: number;
  readonly easing: PhaserEasing;

  constructor(config: PhaserConfig) {
    if (config.steps.length === 0) {
      throw new PhaserError('A phaser needs at least one step');
    }
    if (!(config.speedBpm > 0)) {
      throw new PhaserError(`speedBpm must be positive, got ${config.speedBpm}`);
    }
    for (const step of config.steps) {
      const transition = step.transition ?? 1;
      if (transition < 0 || transition > 1) {
        throw new PhaserError(`transition must be within 0..1, got ${transition}`);
      }
    }
    this.steps = config.steps;
    this.speedBpm = config.speedBpm;
    this.easing = config.easing ?? 'sine';
  }

  /** Seconds for one full pass through every step. */
  get cycleSeconds(): number {
    return (this.steps.length * 60) / this.speedBpm;
  }

  /**
   * Value at `timeSeconds`, read at `phaseDegrees` into the cycle.
   *
   * Phase is converted to beats against *this* phaser's step count, so a
   * 180-degree offset means half a cycle whether the phaser has two steps or
   * seven.
   */
  valueAt(timeSeconds: number, phaseDegrees = 0): number {
    const count = this.steps.length;
    if (count === 1) return this.steps[0].value;

    const beats = (timeSeconds * this.speedBpm) / 60;
    const phaseBeats = (phaseDegrees / DEGREES_PER_TURN) * count;
    const position = wrap(beats + phaseBeats, count);

    const index = Math.floor(position);
    const within = position - index;
    const current = this.steps[index];
    const next = this.steps[(index + 1) % count];
    const transition = current.transition ?? 1;

    // The fade occupies the TAIL of the step, so the value dwells at this
    // step and arrives at the next one exactly on the boundary. Putting the
    // fade at the head instead means a 0% transition still shows the next
    // step's value for the whole step, which reads as an off-by-one chase.
    if (transition <= 0) return current.value;
    const fadeStart = 1 - transition;
    if (within <= fadeStart) return current.value;

    const k = (within - fadeStart) / transition;
    return current.value + (next.value - current.value) * ease(k, this.easing);
  }
}

export interface ColorPhaserStep {
  value: readonly [number, number, number];
  transition?: number;
}

export interface ColorPhaserConfig {
  steps: readonly ColorPhaserStep[];
  speedBpm: number;
  easing?: PhaserEasing;
}

/**
 * Three phasers on one clock, so a colour chase crossfades component-wise the
 * way a console's colour mixing does. Driving R, G and B from independent
 * phasers would let them fall out of step and produce colours that are in
 * neither the outgoing nor the incoming step.
 */
export class ColorPhaser {
  private readonly channels: readonly [Phaser, Phaser, Phaser];

  constructor(config: ColorPhaserConfig) {
    if (config.steps.length === 0) {
      throw new PhaserError('A colour phaser needs at least one step');
    }
    const forChannel = (component: 0 | 1 | 2): Phaser =>
      new Phaser({
        steps: config.steps.map((step) => ({
          value: step.value[component],
          transition: step.transition,
        })),
        speedBpm: config.speedBpm,
        easing: config.easing,
      });
    this.channels = [forChannel(0), forChannel(1), forChannel(2)];
  }

  get cycleSeconds(): number {
    return this.channels[0].cycleSeconds;
  }

  colorAt(timeSeconds: number, phaseDegrees = 0): [number, number, number] {
    return [
      this.channels[0].valueAt(timeSeconds, phaseDegrees),
      this.channels[1].valueAt(timeSeconds, phaseDegrees),
      this.channels[2].valueAt(timeSeconds, phaseDegrees),
    ];
  }
}

export interface PhaseSpreadOptions {
  /** Total spread in degrees. Defaults to a full turn. */
  spreadDegrees?: number;
  /**
   * Land the last item exactly on `spreadDegrees`. Defaults to false.
   *
   * A full turn wraps onto itself, so including the endpoint puts the last
   * fixture back on top of the first: two fixtures do the same thing and the
   * chase visibly stalls for one step at the seam. Console operators hit this
   * typing `Phase 0 thru 360` and fix it by typing 355 instead; excluding the
   * endpoint fixes it exactly, for any count.
   */
  endpoint?: boolean;
}

/** Phase offsets for `count` fixtures spread across the cycle, in degrees. */
export function distributePhase(count: number, options: PhaseSpreadOptions = {}): number[] {
  if (count <= 0) return [];
  const spreadDegrees = options.spreadDegrees ?? DEGREES_PER_TURN;
  const endpoint = options.endpoint ?? false;
  const divisor = endpoint ? Math.max(count - 1, 1) : count;
  const step = count === 1 ? 0 : spreadDegrees / divisor;
  return Array.from({ length: count }, (_, i) => i * step);
}

export interface RadialPhaseOptions extends PhaseSpreadOptions {
  /**
   * Distances within this much of each other share a rank. Defaults to 50 mm.
   *
   * A symmetric rig puts a matched pair the same distance either side of
   * centre; floating-point noise alone would otherwise rank them one after the
   * other and the two halves of a centre-out chase would limp a step apart.
   */
  tolerance?: number;
}

export interface RankedPhase<T> {
  item: T;
  /** 0 for the item(s) nearest the origin, rising outward. */
  rank: number;
  phaseDegrees: number;
}

/**
 * Rank items by distance from an origin and give each a phase offset, so the
 * effect radiates outward from the centre rather than sweeping across the rig.
 */
export function radialPhase<T>(
  items: readonly T[],
  distanceOf: (item: T) => number,
  options: RadialPhaseOptions = {},
): RankedPhase<T>[] {
  if (items.length === 0) return [];
  const tolerance = options.tolerance ?? 0.05;

  const distances = items.map(distanceOf);
  // Sort indices, not items: items may repeat or be primitives, and ranking by
  // index keeps the result aligned with the caller's array order.
  const order = distances.map((_, index) => index).sort((a, b) => distances[a] - distances[b]);

  const rankOf = new Array<number>(items.length);
  let rank = 0;
  let groupStart = distances[order[0]];
  for (let i = 0; i < order.length; i++) {
    const distance = distances[order[i]];
    if (i > 0 && distance - groupStart > tolerance) {
      rank += 1;
      groupStart = distance;
    }
    rankOf[order[i]] = rank;
  }

  const rankCount = rank + 1;
  const spread = distributePhase(rankCount, options);
  return items.map((item, index) => ({
    item,
    rank: rankOf[index],
    phaseDegrees: spread[rankOf[index]],
  }));
}

/**
 * grandMA3 `Attribute "Pan" At % -100` — mirror a pan value about centre.
 *
 * Normalized DMX pan puts centre at 0.5, so the mirror is `1 - value`. This is
 * what makes stage left and stage right sweep toward and away from each other
 * instead of tracking in parallel: apply it to one side of the rig only.
 */
export function mirrorPanNormalized(value: number): number {
  return 1 - value;
}

/** Same mirror in degrees, where centre is 0. */
export function mirrorPanDegrees(degrees: number): number {
  return -degrees;
}
