/**
 * CesiumJS globe layered beneath the Three.js viewport.
 *
 * ARCHITECTURE
 * ------------
 * Two stacked canvases. Cesium draws the georeferenced world (Google
 * Photorealistic 3D Tiles where a key is available) on the lower canvas; Three
 * draws the show build on an upper, transparent canvas. Every frame the Cesium
 * camera is driven FROM the Three camera, converted local ENU -> ECEF, so the
 * two images register exactly.
 *
 * KNOWN LIMIT: the two canvases do not share a depth buffer, so show geometry
 * always draws in front of the globe -- a truss behind a building will not be
 * occluded by it. That is the accepted cost of the dual-canvas approach; the
 * UE5 build does not share this limitation, so treat occlusion checks as
 * desktop-authoritative.
 */

import './cesiumBaseUrl.ts';
import * as Cesium from 'cesium';
import * as THREE from 'three';
import { SITE_FRAME, POINT_STATE_PARK, sceneToEnu } from './GeoAnchor.ts';

/** Which basemap actually loaded. Tiers degrade gracefully, never hard-fail. */
export type BasemapTier = 'google-photorealistic' | 'cesium-ion-terrain' | 'osm-imagery';

export interface BasemapStatus {
  tier: BasemapTier;
  label: string;
  detail: string;
}

export class CesiumGlobe {
  readonly widget: Cesium.CesiumWidget;
  readonly creditContainer: HTMLElement;

  /**
   * Metres subtracted from the camera's local Up before converting to ECEF.
   *
   * The scene origin sits at the site's GROUND level (186 m ellipsoidal). Tiers
   * that carry real elevation -- Google tiles, ion terrain -- put their ground
   * at that same height, so no compensation is needed. The keyless OSM tier has
   * no elevation at all and drapes its imagery on the bare ellipsoid at height
   * 0, which would leave the site floating 186 m above the map. Lowering the
   * camera by the anchor height puts that imagery back under the build.
   */
  private verticalOffsetMeters = 0;

  // Reused per frame; allocating Cartesians in the render loop churns the GC.
  private readonly scratchPosition = new Cesium.Cartesian3();
  private readonly scratchDirection = new Cesium.Cartesian3();
  private readonly scratchUp = new Cesium.Cartesian3();
  private readonly threeWorldPosition = new THREE.Vector3();
  private readonly threeWorldDirection = new THREE.Vector3();
  private readonly threeWorldUp = new THREE.Vector3();
  private readonly threeWorldQuaternion = new THREE.Quaternion();

  /**
   * @param container      element the Cesium canvas is mounted into
   * @param creditContainer element attribution is rendered into. Attribution is
   *   a licensing requirement for Google and OSM tiles alike, and the Cesium
   *   canvas sits beneath the Three canvas, so credits must live in the HUD
   *   rather than in the widget's own (buried) default container.
   */
  constructor(container: HTMLElement, creditContainer?: HTMLElement) {
    if (creditContainer !== undefined) {
      this.creditContainer = creditContainer;
    } else {
      const owned = document.createElement('div');
      owned.className = 'cesium-credits';
      container.appendChild(owned);
      this.creditContainer = owned;
    }

    this.widget = new Cesium.CesiumWidget(container, {
      // Three owns the frame clock; this widget is rendered by hand each tick.
      useDefaultRenderLoop: false,
      // Keyless by default: Cesium's stock base layer needs an ion token, which
      // the $0 budget does not assume. loadBasemap() upgrades this if a key exists.
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(
        Promise.resolve(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
        ),
        {},
      ),
      skyBox: false,
      skyAtmosphere: false,
      creditContainer: this.creditContainer,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });

    const scene = this.widget.scene;
    // OrbitControls is the single source of camera truth; Cesium must not fight it.
    scene.screenSpaceCameraController.enableInputs = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString('#0c1014');
    scene.globe.depthTestAgainstTerrain = true;
  }

  /**
   * Load the best basemap available, degrading through three tiers:
   *   1. Google Photorealistic 3D Tiles -- full parity with the UE5 site model
   *   2. Cesium ion world terrain       -- shaped ground, no buildings
   *   3. OpenStreetMap imagery          -- keyless; street context only
   */
  async loadBasemap(): Promise<BasemapStatus> {
    const googleKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

    if (googleKey) {
      try {
        Cesium.GoogleMaps.defaultApiKey = googleKey;
        const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        this.widget.scene.primitives.add(tileset);
        // Google tiles carry their own ground; the ellipsoid would z-fight.
        this.widget.scene.globe.show = false;
        this.verticalOffsetMeters = 0; // real elevation; no compensation
        return {
          tier: 'google-photorealistic',
          label: 'Google Photorealistic 3D Tiles',
          detail: 'Full site model. Matches the UE5 desktop basemap.',
        };
      } catch (error) {
        console.warn('[CesiumGlobe] Google 3D Tiles failed; falling back.', error);
      }
    }

    if (ionToken) {
      try {
        Cesium.Ion.defaultAccessToken = ionToken;
        this.widget.scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
        this.verticalOffsetMeters = 0; // real elevation; no compensation
        return {
          tier: 'cesium-ion-terrain',
          label: 'Cesium World Terrain',
          detail: 'Shaped ground, no buildings. Set VITE_GOOGLE_MAPS_API_KEY for the full model.',
        };
      } catch (error) {
        console.warn('[CesiumGlobe] ion terrain failed; falling back.', error);
      }
    }

    // Flat ellipsoid, no elevation: drop the camera so the imagery lands under
    // the build rather than 186 m beneath it. See verticalOffsetMeters.
    this.verticalOffsetMeters = POINT_STATE_PARK.height;
    return {
      tier: 'osm-imagery',
      label: 'OpenStreetMap imagery (keyless)',
      detail:
        'Street context only, draped on the ellipsoid. Set VITE_GOOGLE_MAPS_API_KEY for photorealistic tiles.',
    };
  }

  /** Point the Cesium camera at the site, as a sane initial view. */
  flyHome(): void {
    this.widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        POINT_STATE_PARK.longitude,
        POINT_STATE_PARK.latitude,
        POINT_STATE_PARK.height - this.verticalOffsetMeters + 400,
      ),
    });
  }

  /**
   * Drive the Cesium camera from the Three camera.
   *
   * Position converts local ENU -> ECEF through the site frame. Direction and
   * up are rotated only -- they are orientations, not places, so they must not
   * pick up the frame origin.
   */
  syncFromCamera(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    camera.getWorldPosition(this.threeWorldPosition);
    camera.getWorldDirection(this.threeWorldDirection);
    camera.getWorldQuaternion(this.threeWorldQuaternion);
    this.threeWorldUp.set(0, 1, 0).applyQuaternion(this.threeWorldQuaternion);

    const cameraEnu = sceneToEnu([
      this.threeWorldPosition.x,
      this.threeWorldPosition.y,
      this.threeWorldPosition.z,
    ]);
    const p = SITE_FRAME.enuToEcef([
      cameraEnu[0],
      cameraEnu[1],
      cameraEnu[2] - this.verticalOffsetMeters,
    ]);
    const d = SITE_FRAME.enuDirectionToEcef(
      sceneToEnu([
        this.threeWorldDirection.x,
        this.threeWorldDirection.y,
        this.threeWorldDirection.z,
      ]),
    );
    const u = SITE_FRAME.enuDirectionToEcef(
      sceneToEnu([this.threeWorldUp.x, this.threeWorldUp.y, this.threeWorldUp.z]),
    );

    this.scratchPosition.x = p[0];
    this.scratchPosition.y = p[1];
    this.scratchPosition.z = p[2];
    this.scratchDirection.x = d[0];
    this.scratchDirection.y = d[1];
    this.scratchDirection.z = d[2];
    this.scratchUp.x = u[0];
    this.scratchUp.y = u[1];
    this.scratchUp.z = u[2];

    this.widget.camera.setView({
      destination: this.scratchPosition,
      orientation: { direction: this.scratchDirection, up: this.scratchUp },
    });

    const frustum = this.widget.camera.frustum;
    if (frustum instanceof Cesium.PerspectiveFrustum) {
      // Three's fov is always VERTICAL. Cesium treats fov as HORIZONTAL whenever
      // the canvas is wider than it is tall, so convert in that case or the two
      // images drift apart on landscape displays.
      const aspect = width / height;
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      frustum.fov =
        aspect >= 1 ? 2 * Math.atan(Math.tan(verticalFov / 2) * aspect) : verticalFov;
      frustum.near = camera.near;
      frustum.far = camera.far;
    }
  }

  render(): void {
    this.widget.render();
  }

  resize(): void {
    this.widget.resize();
  }

  dispose(): void {
    this.widget.destroy();
  }
}
