import path from 'path';
import { defineConfig } from 'vitest/config';

// Dedicated test config so the suite never loads the dev server's TLS/proxy
// setup (vite.config.js reads .certs/* at load time). Keeps `npm test`
// runnable in CI and on machines without local certs.
export default defineConfig({
  // Dedupe React so a LIVE-LINKED shared package (ps-pkg.sh on → a design worktree with
  // its own node_modules) doesn't drag in a second React copy when a test renders one of
  // its components (e.g. the keypad's arrow.Slider) — that would null the hook dispatcher.
  // `three` is here for the same reason, and one more: the shared package's viewportCompositor
  // imports it, so a second copy also resolves to a module id `vi.mock('three')` never intercepts —
  // the mock misses and the compositor tries to open a real WebGL context under jsdom.
  // Mirrors the live-link dedupe in vite.config; a no-op once the package is npm-resolved.
  resolve: {
    dedupe: ['react', 'react-dom', 'three', 'three-stdlib'],
  },
  // Worktree slots symlink node_modules to the primary checkout, so inlined
  // dependencies resolve to real paths OUTSIDE this root and the fs guard
  // denies them. Allow the shared parent that contains both checkouts.
  server: {
    fs: { allow: [process.cwd(), path.resolve(process.cwd(), '../..')] },
  },
  test: {
    // The shared package ships raw ESM source, so vitest must TRANSFORM it rather than treat it as an
    // external dependency. Inlining also puts its `import 'three'` inside the module graph a test's
    // `vi.mock('three')` can intercept — externalised, the compositor would open a real WebGL context
    // under jsdom. (When live-linked it resolves outside node_modules and is inlined anyway; this
    // keeps npm-resolved and linked runs identical.)
    server: { deps: { inline: ['entangled-worlds-orbiters-shared'] } },
    // Pure logic runs in node; opt individual files into the DOM with a
    // `// @vitest-environment jsdom` comment at the top of the file.
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.js'],
      reporter: ['text', 'html'],
    },
  },
});
