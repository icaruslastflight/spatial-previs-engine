/**
 * Upstage LED wall content.
 *
 * §11's binary rule is about captures and fixture archives that run to tens
 * or hundreds of MB and are regenerable from a pipeline; it was never a
 * blanket ban, and a 250 KB, purpose-built, git-friendly loop is the kind of
 * asset the rest of the web tree already ships (icons, the manifest, GDTF
 * placeholder GLBs). `public/assets/video/edm_wall_loop.mp4` is committed as
 * the default: two bars at the show's own 128 BPM, rendered by capturing
 * `createEdmLoop` itself (`scripts/render_wall_loop.mjs`) so the file and the
 * procedural fallback below are the same art, not two designs that can drift
 * apart.
 *
 * The procedural loop still exists and is still the fallback, for the two
 * reasons that hold regardless of the file above:
 *
 * - It can read the show's own BPM clock live, so a caller running the rig at
 *   a tempo other than 128 gets a wall that stays locked to it. A rendered
 *   file is baked at one tempo.
 * - Keyless and file-less environments (a fork with the asset stripped, a
 *   build that only fetches `src/`) still get a lit wall instead of a dead
 *   black one -- the same degrade-gracefully rule the basemap follows.
 *
 * Precedence: an explicit `sourceUrl` or `VITE_VIDEO_WALL_URL` (for swapping
 * in real show content) beats the committed default, which beats the drawn
 * loop if the file 404s.
 */

import * as THREE from 'three';

export interface VideoWallPalette {
  /** Warm accent. Defaults to the show's amber. */
  hot: string;
  /** Cool accent. Defaults to the show's violet. */
  cool: string;
  /** Darkest value in the gradient. */
  deep: string;
}

export const DEFAULT_WALL_PALETTE: VideoWallPalette = {
  hot: '#ff7a1a',
  cool: '#9b2aff',
  deep: '#0a0413',
};

export interface VideoWallContent {
  texture: THREE.Texture;
  /** Human label for the HUD — says which path actually ran. */
  readonly source: string;
  /** Advance the content to show time. A video texture ignores this. */
  update(timeSeconds: number): void;
  dispose(): void;
}

export interface EdmLoopOptions {
  /** Beats per minute the visuals lock to. */
  bpm?: number;
  palette?: Partial<VideoWallPalette>;
  /** Pixel width; height follows the wall's aspect. */
  width?: number;
  aspect?: number;
}

/** Mix two hex colours without allocating a Color per call. */
const mixA = new THREE.Color();
const mixB = new THREE.Color();
function mix(a: string, b: string, t: number): string {
  mixA.set(a);
  mixB.set(b);
  mixA.lerp(mixB, THREE.MathUtils.clamp(t, 0, 1));
  return `#${mixA.getHexString()}`;
}

/**
 * Draw an orange-and-violet EDM loop locked to `bpm`.
 *
 * Everything animated is a function of the beat, not of elapsed frames, so the
 * loop stays in time regardless of frame rate and matches a phaser running at
 * the same BPM.
 */
export function createEdmLoop(options: EdmLoopOptions = {}): VideoWallContent {
  const bpm = options.bpm ?? 128;
  const palette = { ...DEFAULT_WALL_PALETTE, ...options.palette };
  const width = options.width ?? 512;
  const height = Math.round(width / (options.aspect ?? 4.0 / 3.29));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('[VideoWallContent] 2D canvas context unavailable');
  // Re-bound as non-nullable: `update` is a hoisted declaration, so the narrowing
  // from the guard above does not reach into it.
  const ctx: CanvasRenderingContext2D = context;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  // Per-bar bar heights, fixed at build time: a drawn "spectrum" that re-rolls
  // every frame shimmers like noise instead of pumping like music.
  const BARS = 28;
  const barSeed = Array.from({ length: BARS }, (_, i) => ({
    // Two incommensurate rates per bar, so the array never repeats visibly
    // inside a four-bar phrase.
    slow: 0.6 + 0.9 * Math.sin(i * 1.37),
    fast: 0.4 + 0.6 * Math.sin(i * 2.71 + 1.1),
  }));

  function update(timeSeconds: number): void {
    const beat = (timeSeconds * bpm) / 60;
    const inBeat = beat - Math.floor(beat);
    const bar = beat / 4;
    // Sharp attack, exponential decay — a kick envelope, not a sine.
    const kick = Math.pow(1 - inBeat, 3);

    /* Background: violet-to-black gradient, breathing on the bar. */
    const backdrop = ctx.createLinearGradient(0, 0, 0, height);
    backdrop.addColorStop(0, mix(palette.deep, palette.cool, 0.28 + 0.14 * Math.sin(bar * Math.PI)));
    backdrop.addColorStop(0.62, palette.deep);
    backdrop.addColorStop(1, '#050208');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'lighter';

    /* Centre bloom on every kick. */
    const bloom = ctx.createRadialGradient(
      width / 2, height * 0.45, 0,
      width / 2, height * 0.45, width * (0.18 + 0.45 * kick),
    );
    bloom.addColorStop(0, `rgba(255,150,60,${0.5 * kick + 0.06})`);
    bloom.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    /* Four rings in flight, one launched per beat, fading as they expand. */
    for (let k = 0; k < 4; k++) {
      const age = inBeat + k;
      const life = age / 4;
      if (life >= 1) continue;
      const radius = life * width * 0.72;
      ctx.strokeStyle = mix(palette.hot, palette.cool, life);
      ctx.globalAlpha = (1 - life) * 0.55;
      ctx.lineWidth = Math.max(1, 7 * (1 - life));
      ctx.beginPath();
      ctx.arc(width / 2, height * 0.45, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* Spectrum along the bottom. */
    const barWidth = width / BARS;
    for (let i = 0; i < BARS; i++) {
      const seed = barSeed[i];
      // Edges track the kick harder than the middle, which is the shape a real
      // analyser shows on a four-on-the-floor track.
      const edge = Math.abs(i / (BARS - 1) - 0.5) * 2;
      const level =
        0.18 +
        0.42 * Math.abs(Math.sin(bar * Math.PI * seed.slow + i)) +
        0.34 * kick * (0.4 + 0.6 * edge) * seed.fast;
      const h = THREE.MathUtils.clamp(level, 0, 1) * height * 0.42;
      const column = ctx.createLinearGradient(0, height - h, 0, height);
      column.addColorStop(0, mix(palette.hot, palette.cool, edge));
      column.addColorStop(1, 'rgba(60,10,90,0.15)');
      ctx.fillStyle = column;
      ctx.fillRect(i * barWidth + barWidth * 0.14, height - h, barWidth * 0.72, h);
    }

    /* Chevrons scrolling upstage-to-downstage, one bar per pass. */
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = palette.hot;
    ctx.lineWidth = 3;
    const scroll = (bar % 1) * height * 0.5;
    for (let i = -2; i < 8; i++) {
      const y = height * 0.9 - i * height * 0.12 - scroll;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width / 2, y - height * 0.07);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* Scanlines — cheap, and what sells a panel as LED rather than as paint. */
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    for (let y = 0; y < height; y += 3) ctx.fillRect(0, y, width, 1);
    ctx.globalCompositeOperation = 'source-over';

    texture.needsUpdate = true;
  }

  update(0);

  return {
    texture,
    source: `procedural EDM loop @ ${bpm} BPM`,
    update,
    dispose: () => texture.dispose(),
  };
}

/** The committed loop, relative to the Vite base path (§5 — GitHub Pages serves under a subpath). */
export const DEFAULT_WALL_LOOP_PATH = 'assets/video/edm_wall_loop.mp4';

export interface VideoWallOptions extends EdmLoopOptions {
  /**
   * URL of a looping video. Falls back to `VITE_VIDEO_WALL_URL`, then to the
   * committed default, then to the drawn loop — see the module header for why
   * each tier exists.
   */
  sourceUrl?: string;
  /** Vite base path, for resolving the committed default. Defaults to the app's own. */
  baseUrl?: string;
  /**
   * Skip straight to the procedural loop. The showcase never sets this; it
   * exists for a caller that wants the tempo-locked behaviour on purpose.
   */
  forceProcedural?: boolean;
}

/**
 * Best available wall content: an explicitly configured video, then the
 * committed default file, then the drawn loop. Never rejects — a dead wall is
 * a worse outcome than a synthetic one, and the returned `source` says which
 * tier actually ran.
 */
export async function createVideoWallContent(
  options: VideoWallOptions = {},
): Promise<VideoWallContent> {
  if (options.forceProcedural) return createEdmLoop(options);

  const baseUrl = options.baseUrl ?? (import.meta.env.BASE_URL as string);
  const configuredUrl = options.sourceUrl ?? (import.meta.env.VITE_VIDEO_WALL_URL as string | undefined);
  const url = configuredUrl ?? `${baseUrl}${DEFAULT_WALL_LOOP_PATH}`;

  try {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;       // required for autoplay in every current browser
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      video.addEventListener('canplay', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error(`cannot load ${url}`)), { once: true });
    });
    await video.play();

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    return {
      texture,
      source: `video: ${url}`,
      update: () => {},
      dispose: () => {
        video.pause();
        texture.dispose();
      },
    };
  } catch (error) {
    console.warn('[VideoWallContent] falling back to the drawn loop:', error);
    return createEdmLoop(options);
  }
}
