/// <reference types="vite/client" />

/** Injected by vite.config.ts `define`; points at the copied Cesium asset tree. */
declare const CESIUM_BASE_URL: string;

interface Window {
  CESIUM_BASE_URL?: string;
}

interface ImportMetaEnv {
  /**
   * Google Maps Platform key for Photorealistic 3D Tiles. Optional: without it
   * the viewport degrades to a keyless basemap. Never commit a real key.
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
  /** Cesium ion access token, used only for the terrain fallback tier. */
  readonly VITE_CESIUM_ION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * @mkkellogg/gaussian-splats-3d ships no type declarations. Only the surface
 * this project actually calls is declared here; widen it as usage grows.
 */
declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Camera, Scene, WebGLRenderer, Vector3, Quaternion } from 'three';

  export class Viewer {
    constructor(options?: {
      selfDrivenMode?: boolean;
      renderer?: WebGLRenderer;
      camera?: Camera;
      threeScene?: Scene;
      useBuiltInControls?: boolean;
      ignoreDevicePixelRatio?: boolean;
      sharedMemoryForWorkers?: boolean;
    });
    addSplatScene(
      path: string,
      options?: {
        splatAlphaRemovalThreshold?: number;
        position?: Vector3 | number[];
        rotation?: Quaternion | number[];
        scale?: Vector3 | number[];
        showLoadingUI?: boolean;
        progressiveLoad?: boolean;
      },
    ): Promise<void>;
    update(): void;
    render(): void;
    dispose(): Promise<void>;
  }
}
