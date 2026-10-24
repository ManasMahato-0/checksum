import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The first PGlite test pays WASM startup cost; the default 5s is too tight on cold machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
