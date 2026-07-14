// Tombstone — the ConnectRelay tests live in `connectRelay.test.js`. The orbiters vitest config only
// includes `*.{test,spec}.{js,mjs}`, so tests are authored in JS (they import the .ts source, which
// Vite transpiles). This file is intentionally empty; it could not be removed in-session (rm blocked).
export {};
