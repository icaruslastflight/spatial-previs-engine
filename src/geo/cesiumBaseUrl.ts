/**
 * Publishes the Cesium asset root before Cesium first resolves a module URL.
 *
 * Cesium fetches its Workers, Assets, Widgets and ThirdParty trees at runtime
 * from `window.CESIUM_BASE_URL`. vite.config.ts copies those trees into the
 * build output and injects the matching (base-path aware) URL as the compile
 * time constant CESIUM_BASE_URL.
 *
 * Import this module BEFORE 'cesium' anywhere Cesium is used.
 */
window.CESIUM_BASE_URL = CESIUM_BASE_URL;
export {};
