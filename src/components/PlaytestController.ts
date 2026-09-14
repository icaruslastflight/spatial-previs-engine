/**
 * Cross-platform playtest rig: desktop WASD/RMB-orbit camera controls plus a
 * live diagnostics HUD (FPS, active input mode, WGS84 readout under the
 * orbit target).
 *
 * This sits ALONGSIDE the production touch contract in `DragSnapController.ts`
 * and `OrbitControls`, not in place of it. Touch is the primary target per
 * CLAUDE.md §1.3 and its gesture contract is untouched here:
 *
 *   one finger on an asset  -> drag (DragSnapController)
 *   one finger on empty sky -> orbit (OrbitControls, left/primary button)
 *   two fingers             -> pinch-zoom / pan (OrbitControls)
 *
 * Desktop gets a second, additive scheme on top of that:
 *
 *   WASD            -> camera-relative horizontal movement
 *   Space / Shift    -> vertical elevation (up / down)
 *   RMB drag         -> 360° orbit, independent of what is under the cursor
 *
 * RMB-drag-to-orbit needs one companion fix in `DragSnapController`: that
 * controller reacts to ANY pointer, not just the primary button, so a right
 * click on an asset would otherwise also start a drag. See the `event.button`
 * guard added there -- this file does not touch DragSnapController's own
 * pointer contract beyond relying on that guard existing.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { localToWgs84 } from '../geospatial/PointStateParkAnchor.ts';
import { TICK_PRIORITY } from '../core/EngineLoop.ts';
import type { EngineLoop, FrameTiming, Unregister } from '../core/EngineLoop.ts';

/* -------------------------------------------------------------------------- */
/* Pure movement math -- no DOM, unit-testable in isolation                    */
/* -------------------------------------------------------------------------- */

/** Held-key state for one frame's worth of movement. */
export interface MovementInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** A camera at rest, i.e. no movement keys held. */
export const NO_MOVEMENT: Readonly<MovementInput> = Object.freeze({
  forward: false,
  backward: false,
  left: false,
  right: false,
  up: false,
  down: false,
});

/** Ground speed, metres/second. Matches a brisk walking pace at site scale. */
export const PLAYTEST_SPEED_MPS = 6.0;

// Three.js cameras look down local -Z; "right" is local +X. Module-level scratch:
// applyQuaternion mutates its receiver, and these are cloned before every use,
// never mutated in place across calls.
const FORWARD_AXIS: Readonly<THREE.Vector3> = Object.freeze(new THREE.Vector3(0, 0, -1));
const RIGHT_AXIS: Readonly<THREE.Vector3> = Object.freeze(new THREE.Vector3(1, 0, 0));

/**
 * Camera-relative ground movement for one frame, in local scene metres.
 *
 * Forward/right are flattened to the horizontal plane before use: without
 * that, looking down at the build turns "walk forward" into "dive toward the
 * ground," which is the single most disorienting bug a fly-camera can have.
 * Horizontal input is normalized so diagonal movement (e.g. W+D) is not
 * faster than a single axis; vertical (Space/Shift) is independent of the
 * horizontal speed, matching how a noclip/fly camera is expected to feel --
 * ascending should not slow down your walk speed.
 *
 * Pure function: no DOM, no engine state, safe to unit test directly.
 */
export function computeGroundRelativeMovement(
  cameraQuaternion: THREE.Quaternion,
  input: MovementInput,
  deltaSeconds: number,
  speedMetersPerSecond: number = PLAYTEST_SPEED_MPS,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const forward = FORWARD_AXIS.clone().applyQuaternion(cameraQuaternion);
  forward.y = 0;
  if (forward.lengthSq() > 1e-9) forward.normalize();

  const right = RIGHT_AXIS.clone().applyQuaternion(cameraQuaternion);
  right.y = 0;
  if (right.lengthSq() > 1e-9) right.normalize();

  target.set(0, 0, 0);
  if (input.forward) target.add(forward);
  if (input.backward) target.sub(forward);
  if (input.right) target.add(right);
  if (input.left) target.sub(right);
  if (target.lengthSq() > 1e-9) target.normalize();

  if (input.up) target.y += 1;
  if (input.down) target.y -= 1;

  return target.multiplyScalar(speedMetersPerSecond * deltaSeconds);
}

/* -------------------------------------------------------------------------- */
/* Input mode                                                                  */
/* -------------------------------------------------------------------------- */

export type InputMode = 'MOBILE_TOUCH' | 'PC_DESKTOP';

/* -------------------------------------------------------------------------- */
/* Controller                                                                  */
/* -------------------------------------------------------------------------- */

const KEY_BINDINGS: Record<string, keyof MovementInput> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'up',
  ShiftLeft: 'down',
  ShiftRight: 'down',
};

/** How often the diagnostics HUD text is rewritten, seconds. Not every frame:
 * a debug overlay does not need 60 Hz DOM churn to be readable, and the
 * codebase's whole memory-pool/allocation discipline is exactly the instinct
 * that says "don't pay a per-frame cost a human eye cannot perceive." */
const HUD_UPDATE_INTERVAL_SECONDS = 0.2;

export interface PlaytestControllerOptions {
  domElement: HTMLElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** The controller registers its own per-frame tick on this clock. */
  engineLoop: EngineLoop;
  /** Ground speed override, metres/second. Defaults to `PLAYTEST_SPEED_MPS`. */
  speedMetersPerSecond?: number;
}

export class PlaytestController {
  private readonly domElement: HTMLElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly speed: number;

  private readonly held: MovementInput = { ...NO_MOVEMENT };
  private inputMode: InputMode = 'MOBILE_TOUCH';

  private readonly hudRoot: HTMLDivElement;
  private readonly hudFps: HTMLSpanElement;
  private readonly hudMode: HTMLSpanElement;
  private readonly hudWgs84: HTMLSpanElement;
  private readonly hudHint: HTMLDivElement;
  private hudAccumulatorSeconds = 0;

  private readonly unregisterTick: Unregister;

  private readonly moveScratch = new THREE.Vector3();
  private readonly wgs84Scratch = new THREE.Vector3();

  constructor(options: PlaytestControllerOptions) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.controls = options.controls;
    this.speed = options.speedMetersPerSecond ?? PLAYTEST_SPEED_MPS;

    // Additive: RMB now orbits too, independent of what the cursor is over.
    // LEFT stays OrbitControls' default (ROTATE) -- DragSnapController relies
    // on that default to hand empty-space drags to the camera, and touching it
    // here would fight that contract. MIDDLE stays DOLLY (zoom), unchanged.
    this.controls.mouseButtons = {
      ...this.controls.mouseButtons,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    const hud = this.buildHud();
    this.hudRoot = hud.root;
    this.hudFps = hud.fps;
    this.hudMode = hud.mode;
    this.hudWgs84 = hud.wgs84;
    this.hudHint = hud.hint;
    document.body.appendChild(this.hudRoot);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    // A pointer tells us which input family is actually driving right now;
    // touch and mouse pointerdown events both arrive here.
    this.domElement.addEventListener('pointerdown', this.onPointerDown);

    this.unregisterTick = options.engineLoop.register(TICK_PRIORITY.AUTOMATION, this.tick);
  }

  dispose(): void {
    this.unregisterTick();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.hudRoot.remove();
  }

  /* --------------------------------------------------------------- input mode */

  private setInputMode(mode: InputMode): void {
    if (this.inputMode === mode) return;
    this.inputMode = mode;
    this.hudMode.textContent = mode;
    this.hudHint.hidden = mode !== 'PC_DESKTOP';
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.setInputMode(event.pointerType === 'touch' ? 'MOBILE_TOUCH' : 'PC_DESKTOP');
  };

  /* ----------------------------------------------------------------- keyboard */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const field = KEY_BINDINGS[event.code];
    if (field === undefined) return;
    // Space scrolls the page and can re-trigger a focused button; this is a
    // full-bleed 3D canvas, there is nothing under it that should scroll.
    if (event.code === 'Space') event.preventDefault();
    this.held[field] = true;
    this.setInputMode('PC_DESKTOP');
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const field = KEY_BINDINGS[event.code];
    if (field === undefined) return;
    this.held[field] = false;
  };

  /** Releasing focus (alt-tab, DevTools) must not leave a key stuck "held". */
  private readonly onWindowBlur = (): void => {
    for (const key of Object.keys(this.held) as (keyof MovementInput)[]) {
      this.held[key] = false;
    }
  };

  /* -------------------------------------------------------------------- tick */

  private readonly tick = (timing: FrameTiming): void => {
    const delta = computeGroundRelativeMovement(
      this.camera.quaternion,
      this.held,
      timing.deltaSeconds,
      this.speed,
      this.moveScratch,
    );
    if (delta.lengthSq() > 0) {
      // Translate the whole orbit rig -- camera AND target -- together.
      // OrbitControls re-derives camera.position from `target` plus its
      // internal spherical offset every update(); moving only the camera
      // would be silently overwritten on the next frame.
      this.camera.position.add(delta);
      this.controls.target.add(delta);
    }

    this.hudAccumulatorSeconds += timing.deltaSeconds;
    if (this.hudAccumulatorSeconds >= HUD_UPDATE_INTERVAL_SECONDS) {
      this.hudAccumulatorSeconds = 0;
      this.refreshHud(timing);
    }
  };

  private refreshHud(timing: FrameTiming): void {
    this.hudFps.textContent = timing.fps > 0 ? timing.fps.toFixed(0) : '—';

    this.wgs84Scratch.copy(this.controls.target);
    const geo = localToWgs84(this.wgs84Scratch);
    this.hudWgs84.textContent =
      `${geo.latitude.toFixed(6)}°, ${geo.longitude.toFixed(6)}°  ` +
      `${geo.height.toFixed(1)} m`;
  }

  /* --------------------------------------------------------------------- HUD */

  private buildHud(): {
    root: HTMLDivElement;
    fps: HTMLSpanElement;
    mode: HTMLSpanElement;
    wgs84: HTMLSpanElement;
    hint: HTMLDivElement;
  } {
    const root = document.createElement('div');
    root.id = 'playtest-diagnostics';
    root.setAttribute(
      'style',
      [
        'position:fixed', 'top:8px', 'right:8px', 'z-index:1000',
        'font:11px/1.5 ui-monospace, "SF Mono", Consolas, monospace',
        'color:#bcd4ff', 'background:rgba(12,16,20,0.72)',
        'border:1px solid rgba(255,255,255,0.12)', 'border-radius:6px',
        'padding:6px 8px', 'pointer-events:none', 'user-select:none',
        'white-space:nowrap',
      ].join(';'),
    );

    const row = (label: string): HTMLSpanElement => {
      const line = document.createElement('div');
      const tag = document.createElement('span');
      tag.textContent = `${label} `;
      tag.style.opacity = '0.6';
      const value = document.createElement('span');
      line.append(tag, value);
      root.appendChild(line);
      return value;
    };

    const fps = row('FPS');
    const mode = row('INPUT');
    mode.textContent = this.inputMode;
    const wgs84 = row('WGS84');
    wgs84.textContent = '—';

    const hint = document.createElement('div');
    hint.hidden = true;
    hint.style.marginTop = '4px';
    hint.style.opacity = '0.7';
    hint.textContent = 'WASD move · Space/Shift up-down · RMB orbit';
    root.appendChild(hint);

    return { root, fps, mode, wgs84, hint };
  }
}
