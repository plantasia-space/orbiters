import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import restart from 'vite-plugin-restart'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve the main worktree root via git so .certs resolve from the primary
// checkout at any worktree depth (.certs is gitignored → absent in a worktree).
function mainWorktreeDir() {
  try {
    const raw = execSync('git rev-parse --git-common-dir', { cwd: __dirname, encoding: 'utf8' }).trim()
    const abs = path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw)
    return path.dirname(abs)
  } catch {
    return __dirname
  }
}
// Walk upward until we find a dir containing the sub-path (handles any nesting).
function findAncestor(...parts) {
  let dir = __dirname
  while (true) {
    const candidate = path.join(dir, ...parts)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const certsDir = path.join(mainWorktreeDir(), '.certs')
// Shared env directory when working inside the ps-all workspace; standard
// repo-root env files (.env, .env.development, …) otherwise (public clones).
const ENV_DIR = findAncestor('env', 'orbiters') || __dirname;

// HTTPS at local.plantasia.space is the fully-supported dev origin (WebRTC,
// auth callbacks, and embed flows expect it — see README). Without the local
// certs the server still boots on plain-HTTP localhost so the app is
// explorable out of the box; auth/WebRTC-dependent flows won't work.
const certKey = path.join(certsDir, 'local.plantasia.space-key.pem')
const certPem = path.join(certsDir, 'local.plantasia.space.pem')
const hasCerts = fs.existsSync(certKey) && fs.existsSync(certPem)

export default defineConfig(({ command, mode }) => {
    const isDev = command === 'serve';
    if (isDev && !hasCerts) {
        console.warn(
            '[orbiters] no local TLS certs found in .certs/ — serving plain HTTP on localhost:5173.\n' +
            '[orbiters] For the full HTTPS dev origin (required for auth/WebRTC), see README "Local HTTPS".'
        );
    }

    // Fail loud on a missing herbarium base. Vite's %VITE_HERBARIUM_BASE% HTML-token
    // substitution fails SILENTLY when the var is undefined, leaking the literal
    // "%VITE_HERBARIUM_BASE%" into icon and audio URLs. Refuse to build or
    // serve without it instead of shipping broken cross-environment URLs.
    const env = loadEnv(mode, ENV_DIR, 'VITE_');
    const herbariumBase = env.VITE_HERBARIUM_BASE || env.VITE_PUBLIC_HERBARIUM_BASE;
    if (!herbariumBase) {
        throw new Error(
            `[orbiters] VITE_HERBARIUM_BASE is not defined for mode "${mode}" in ${ENV_DIR}. ` +
            `Set it (e.g. https://dev-herbarium.plantasia.space for dev, ` +
            `https://herbarium.plantasia.space for prod) so %VITE_HERBARIUM_BASE% substitutes at build time.`,
        );
    }
    if (herbariumBase.includes('%')) {
        throw new Error(
            `[orbiters] VITE_HERBARIUM_BASE contains an unsubstituted token: "${herbariumBase}".`,
        );
    }

    return {
        base: '/',
        root: '.',
        publicDir: 'public',
        envDir: ENV_DIR,
        // When a shared package is live-linked (ps-pkg.sh on) it resolves to its own
        // checkout, which carries its own copies of peer libs in node_modules — two
        // Reacts → "invalid hook call", two Three.js → broken instanceof/rendering.
        // Dedupe forces a single instance of each. No effect in npm mode (the
        // published copies keep these as peers, never bundled).
        resolve: { dedupe: ['react', 'react-dom', 'three', 'three-stdlib'] },
        server: {
            // Worktree slots symlink node_modules to the primary checkout, so
            // raw-asset (?url) imports resolve to real paths OUTSIDE this root
            // and Vite's fs guard denies them (dev server and vitest alike).
            // Allow the shared parent that contains both checkouts.
            fs: { allow: [__dirname, path.resolve(__dirname, '../..'), mainWorktreeDir()] },
            ...(isDev
                ? (hasCerts ? {
                    host: 'local.plantasia.space',
                    port: 5173,
                    https: {
                        key: fs.readFileSync(certKey),
                        cert: fs.readFileSync(certPem),
                    },
                    open: 'http://local.plantasia.space:5173',
                    hmr: {
                      host: 'local.plantasia.space',
                    },
                    allowedHosts: ['local.plantasia.space'],
                } : {
                    port: 5173,
                })
                : {}),
        },
        // (dist/clock rebuilt in the linked worktree — re-run optimizeDeps, 2026-06-27)
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            sourcemap: true,
            target: 'esnext',
            // Split the big stable vendors out of the app chunk. Cuts no bytes, but a
            // src change no longer re-downloads the whole ~580 kB-gzip monolith (three/tone/react
            // stay cached), and the initial fetch parallelizes.
            rollupOptions: {
                // Ship the effect-visuals rig as a second page so it can be
                // exercised on real phones against the deployed dev env (audio
                // and visual budgets are tuned there, not on desktop). The old
                // granular-harness URL stays as a redirect stub.
                input: {
                    main: path.resolve(__dirname, 'index.html'),
                    fxHarness: path.resolve(__dirname, 'fx-harness.html'),
                    granularHarness: path.resolve(__dirname, 'granular-harness.html'),
                },
                output: {
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return undefined;
                        if (id.includes('/three/') || id.includes('three-stdlib')) return 'vendor-three';
                        if (id.includes('/tone/') || id.includes('standardized-audio-context')) return 'vendor-tone';
                        if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
                        return undefined;
                    },
                },
            },
        },
        plugins: [
            // React (JSX/TSX) support for the incremental vanilla→React migration.
            // Vanilla DOM and React islands coexist; React only owns the surfaces it has migrated.
            react(),
            // Vite's built-in %VITE_*% index.html replacement does not fire in this
            // project (envDir lives outside the root), so it silently leaves the
            // literal "%VITE_HERBARIUM_BASE%" in icon/audio URLs. Do the
            // substitution explicitly with the already-validated base.
            {
                name: 'orbiters-herbarium-html-env',
                transformIndexHtml(html) {
                    return html.split('%VITE_HERBARIUM_BASE%').join(herbariumBase);
                },
            },
            restart({
                restart: ['public/**'],
            }),
        ],
    }
})
