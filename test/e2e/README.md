# Browser e2e tests

These drive the actual app in headless Chromium via Playwright, using
**SwiftShader** for software WebGL2 — so they run on machines without a GPU
(CI, containers). They complement `../validate-passes.mjs` (offline glslang
validation) by catching ANGLE-only issues and verifying real rendering/UI.

Each test starts its own static file server rooted at the repo (no separate
`http.server` needed), opens the app, and exits non-zero on failure.

## Setup

```sh
cd test/e2e
npm install
npx playwright install chromium    # one-time browser download
```

## Run

```sh
npm test                # all four
npm run test:render     # run.mjs    — crt-royale smoke + corner/letterbox check
npm run test:presets    # multi.mjs  — ~14 presets render non-blank
npm run test:ui         # ui.mjs     — mobile layout + actual-size 1:1 pixels
npm run test:input      # inputres.mjs — input-resolution feed sizing
```

## Env vars

- `APP_URL` — test an already-running server instead of the built-in one,
  e.g. `APP_URL=http://localhost:8000 npm test`.
- `PORT` — fixed port for the built-in server (default: ephemeral).
- `HEADED=1` — show the browser window (debugging).

## Notes

- Tests synthesize their upload by screenshotting an HTML pattern, so they need
  no binary fixtures.
- `window.__crt` (set in `js/main.js`) exposes `{ runtime, feed, ... }` so tests
  can read pass framebuffers, the feed canvas, `vpRect`, etc.
- SwiftShader is slow; the per-preset timeouts are generous on purpose.
- These were originally one-off scripts run from `/tmp`; the diagnostic
  throwaways (`errs*`, `debug-*`, `scroll*`) were intentionally not kept.
