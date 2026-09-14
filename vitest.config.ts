/**
 * Test runner configuration.
 *
 * Deliberately separate from `vite.config.ts`. That config builds the browser
 * client: it pulls in the CesiumJS runtime asset middleware and the PWA service
 * worker generator, neither of which has any meaning under a test run, and both
 * of which cost seconds of startup. Vitest prefers this file when it exists, so
 * the suite loads neither.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Node, not jsdom.
     *
     * The suite exercises geodesy, socket kinematics, the asset library on disk
     * and the core engine primitives -- all of which are pure computation over
     * Three.js math types and `node:fs`. Nothing here touches the DOM, and the
     * engine loop takes an injected scheduler precisely so its timing can be
     * driven without a browser.
     */
    environment: 'node',
    /**
     * Unit tests sit beside the code they cover; `tests/` holds the cross-module
     * contract suite, which asserts the public API the specification names
     * rather than any one module's internals.
     */
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tests/**/*.test.js'],
    /**
     * The asset library check reads every GLB the build script emitted and
     * snaps real library assets together, which is slower than a unit test but
     * is the only check that crosses the generator/engine boundary.
     */
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
