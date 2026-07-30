# Orbiters

Regenerative music playground for [Plantasia Space](https://plantasia.space) worlds. An orbiter is a playable audio scene: track playback with an effects rack, parameter routing driven by touch, sensors, LFOs, keyboard, or MIDI, a Three.js world render, and multiplayer transport sync over WebRTC.

Built with [Three.js](https://threejs.org/), [Tone.js](https://tonejs.github.io/), [Vite](https://vite.dev/), and the [`entangled-worlds-orbiters-shared`](https://www.npmjs.com/package/entangled-worlds-orbiters-shared) npm package.

<p align="center">
  <img src="docs/orbiter-world-cards.gif" alt="An orbiter session — a world render with the cards drawer open to switch what plays" />
</p>

[DEMO PLAY MODE](https://orbiter.plantasia.space/) & [DEMO EDIT MODE](https://orbiter.plantasia.space/?mode=edit)

## Requirements

- Node.js `>=20.19`

## Getting started

```bash
npm install

# Required env — create a .env in the repo root before running anything:
cat > .env <<'EOF'
VITE_HERBARIUM_BASE=https://herbarium.plantasia.space
VITE_API_BASE=https://api.plantasia.space
EOF

npm run dev            # Vite dev server on port 5173
npm run build          # production build into dist/
npm test               # Vitest, single run
npm run test:coverage  # Vitest with coverage
npm run lint           # ESLint
npm run docs           # JSDoc API docs
```

Both variables are substituted into `index.html` at build time and have no in-code defaults. `VITE_HERBARIUM_BASE` (base URL for icon/audio assets) fails the build loudly when missing — that's deliberate (an unset var would otherwise silently leak `%VITE_HERBARIUM_BASE%` into asset URLs). `VITE_API_BASE` (Plantasia Space API base) does not fail loudly: when unset, API calls resolve against the literal `%VITE_API_BASE%` token and 404.

### Other environment variables (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_PUBLIC_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` | — | Firebase web auth (sign-in); unset disables Firebase auth |

Without the Firebase variables the app simply runs with sign-in disabled — browsing and playing orbiters works anonymously, which is the expected setup outside Plantasia Space.

### Local HTTPS (optional, required for auth and multiplayer)

Out of the box the dev server runs on plain HTTP at `http://localhost:5173` — enough to explore the app. Sign-in, WebRTC multiplayer, and embed flows expect the HTTPS dev origin `https://local.plantasia.space:5173`. To enable it:

1. **Map `local.plantasia.space` to localhost:**

   ```bash
   # macOS / Linux
   echo "127.0.0.1 local.plantasia.space" | sudo tee -a /etc/hosts

   # Windows PowerShell (run as Administrator)
   Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "127.0.0.1 local.plantasia.space"
   ```

2. **Generate and trust a certificate pair with [mkcert](https://github.com/FiloSottile/mkcert):**

   ```bash
   # Install mkcert (macOS)
   brew install mkcert nss    # drop nss if you do not use Firefox

   # Install mkcert (Windows)
   choco install mkcert

   # Install mkcert (Linux)
   sudo apt-get install libnss3-tools && \
   wget -O mkcert https://dl.filippo.io/mkcert/latest?for=linux/amd64 && \
   chmod +x mkcert && sudo mv mkcert /usr/local/bin/

   # Create and trust the local CA (one time)
   mkcert -install

   # Generate the cert/key inside the project
   mkdir -p .certs
   mkcert -key-file .certs/local.plantasia.space-key.pem \
          -cert-file .certs/local.plantasia.space.pem \
          local.plantasia.space
   ```

With both in place, `npm run dev` serves `https://local.plantasia.space:5173` automatically.

## Developing the shared package locally

Orbiters consumes the [`entangled-worlds-orbiters-shared`](https://www.npmjs.com/package/entangled-worlds-orbiters-shared) package from npm. Day-to-day you can rely on the published version; to work on the shared package itself, clone [its repository](https://github.com/plantasia-space-org/entangled-worlds-orbiters-shared) next to this one and link it into this workspace:

```bash
# In a sibling checkout of the shared library
cd entangled-worlds-orbiters-shared
npm install && npm run build
npm link

# Back in the Orbiters repo consume the local build
cd ../orbiters
npm link entangled-worlds-orbiters-shared
```

Once linked, `npm run dev` will hot-reload changes from the shared package. Run `npm unlink entangled-worlds-orbiters-shared && npm install` to return to the published dependency.

## Repository layout

- `src/audio/` — audio engine, effects rack, playback (prebuffer vs stream)
- `src/world/` — Three.js scene and render loop
- `src/core/` — parameter routing (`ParameterManager`), orbiter modes, stack utils
- `src/sync/` — multiplayer transport sync (`SyncCoordinator`, WebRTC)
- `src/input/` — sensors, cosmic LFO, keyboard, camera, MIDI learn
- `src/api/`, `src/auth/` — API client and Firebase/session auth
- `src/ui/react/` — the React UI (sole UI surface; regions + studio edit panel)
- `tests/` — Vitest suite

<p align="center">
  <img src="docs/multi-orbiter.gif" alt="Four orbiters playing together in one session, transports in sync" />
</p>

## License

[AGPL-3.0](LICENSE) © Plantasia Space.

Bundled third-party work: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (Basis Universal transcoder under Apache-2.0; Inter, Space Mono, and Orbit fonts under the SIL OFL 1.1).
