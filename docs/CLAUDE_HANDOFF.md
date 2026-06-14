# Claude Handoff — CRT libretro shaders on the web

A handoff doc for whoever (Claude or human) picks this up next. Written to be
read cold. Last updated at commit `2f5ea15`.

- **Repo:** `inclushe/crt-test`
- **Working branch:** `claude/mini-tv-mode` (everything committed + pushed here; `main` is not used)
- **Type:** static client-side web app, no build step, no dependencies. Plain ES modules + WebGL2.

> **Recent session (Mini-TV + perf + input split)** — see §5A for the engine details, §8 for the controls.
> Headlines: a **Mini-TV mode** (small canvas showing a 1:1 crop of a high-reference-resolution
> render, so the phosphor mask keeps its native pitch), a **Region "fast" render** that scissors the
> heavy passes to the visible window, **on-demand rendering** (idle static images cost ~0 GPU),
> **CPU + GPU frame-time meters**, the **GitHub API list replaced by a committed snapshot**
> (`data/crt-presets.json`), and the **Input control split into independent Lines (scanlines) and
> Horizontal (detail) axes**.

---

## 1. What it does / product goal

A browser app that runs **libretro CRT shaders** on a user-uploaded **photo or
video**, entirely client-side. Nothing is uploaded anywhere. Shader presets and
sources are fetched live from GitHub at runtime. Primary target: `crt/crt-royale`
(a 12-pass shader), but ~all of the `crt/` folder works.

Run it: `python3 -m http.server 8000` in repo root, open `http://localhost:8000`.
Needs a WebGL2 browser (any current one).

---

## 2. CRITICAL history — the approach pivot (read before touching the pipeline)

This is the single most important piece of context, because a lot of effort went
into a path that was **abandoned**, and the abandoned artifacts still exist in `/tmp`.

1. The task originally said use `libretro/slang-shaders` and compile client-side.
   First attempt compiled Slang→WGSL using `slang-wasm` (the shader-slang/slang
   WebAssembly build, same as slang-playground).
2. **Blocker:** upstream Slang does not ship a working **GLSL-input → WGSL-output**
   path in *any* binary (wasm or native). The wasm build creates its global session
   with GLSL disabled (`error[E38201]: 'glsl' module not available`), and even after
   building from source with `enableGLSL`, the GLSL builtin library declares its
   functions only for `cpp/cuda/glsl/hlsl/spirv` capability targets — **WGSL is
   excluded**, so `mat*vec`, `texture`, `textureLod`, etc. all fail with
   `error[E36107]`. Patching the capability tables got it from 132→19 conflicts but
   never to zero without deep, fragile edits.
3. **User pivoted us** to `libretro/glsl-shaders` — the hand-converted **GLSL**
   ports of the same shaders. Browsers run GLSL directly. **Final approach: fetch
   `.glslp` + `.glsl`, prepare them for GLSL ES, run in WebGL2. No compiler
   toolchain at all.**

**Implication:** Do NOT reintroduce slang-wasm / WGSL. The `/tmp/slang/*` build
trees (slang-build, emsdk, wasm, native, glsl-repo) are scratch and **not part of
the repo**. `/tmp/slang/glsl-repo` is a handy sparse clone of `libretro/glsl-shaders`
used by the offline validator (see §7). The Playwright **e2e harness is now committed** at
`test/e2e/` (was previously a scratch `/tmp/e2e/`). `/tmp/slang/glsl-repo` is ephemeral
(`/tmp` is wiped when the container recycles) — re-clone `libretro/glsl-shaders` if gone.

---

## 3. Data flow

```
.glslp preset (GitHub raw)
   │  parsePreset()                     js/slangp.js
   ▼
for each pass: fetch .glsl
   │  hot-patch (interlace_detect)      js/main.js  (see §6)
   │  buildStageSource(VERTEX/FRAGMENT) js/source.js
   │     ├ flattenConditionals()        js/flatten.js  (resolve #if/#ifdef)
   │     ├ hoistGlobalInitializers()    js/flatten.js
   │     └ applyEsCompatShims()         js/flatten.js  (int→float, textureLod)
   ▼
WebGL2 multi-pass render               js/runtime.js  (CrtRuntime)
   │  feed canvas (cropped/scaled upload) → pass0 → … → final pass → canvas
   ▼
<canvas> (output res, content letterboxed into centered viewport rect)
```

GitHub endpoints (in `main.js`):
- `RAW_BASE = https://raw.githubusercontent.com/libretro/glsl-shaders/master/` — shader/LUT fetches.
- **Preset dropdown is now a committed snapshot**, `PRESET_LIST = data/crt-presets.json` (fetched via
  `import.meta.url`), NOT the live GitHub API — the API's 60/hr unauthenticated limit was exhausting
  on shared/CI IPs. `listPresets()` reads the JSON (array of `{name}` for each `.glslp`), still falls
  back to the hardcoded `FALLBACK_PRESETS` on error. Regenerate the snapshot with
  `node scripts/update-crt-presets.mjs` (honors `GITHUB_TOKEN`).
- **Dependency fetches are parallel:** `loadPreset()` kicks off all pass `.glsl` + LUT `.png`
  downloads at once (then processes shaders in pass order for deterministic param dedup). The
  `SourceLoader` cache stores the in-flight promise, so concurrent loads are safe and dedup URLs.

---

## 4. Files (all under repo root)

| File | Lines | Responsibility |
|------|-------|----------------|
| `index.html` | ~154 | DOM + all CSS. Header controls (incl. Mini-TV + Lines/Horizontal), `#status` (with `#frameTime`/`#gpuTime`/`#fps` in `#meters`), `#view`>`#canvasWrap`>`#canvas` + floating `#vid`/`#showControls`, `#params`>`#advanced`+`#paramList`. |
| `js/slangp.js` | ~100 | `parsePreset(text)` → `{passes, textures, parameterOverrides}`. **Named slangp but parses `.glslp`** (identical key/value format). Handles `scale_type[_x/_y]`, `scale[_x/_y]`, `filter_linear`, `wrap_mode`, `srgb_framebuffer`, `float_framebuffer`, `mipmap_input`, `alias`, `frame_count_mod`, `textures` + per-LUT `_linear/_wrap_mode/_mipmap`. Leftover numeric keys → `parameterOverrides`. |
| `js/source.js` | ~117 | `buildStageSource(src, stage, {es3compat})`, `parseParameterPragmas(src)`, `SourceLoader` (URL fetch+**promise**-cache), `resolveUrl`. |
| `js/flatten.js` | ~436 | Preprocessor + ES-compat transforms (see §5). |
| `js/runtime.js` | ~526 | `CrtRuntime` WebGL2 engine (see §5 + §5A: Mini-TV window, region scissor, GPU timer). |
| `js/main.js` | ~754 | UI wiring, preset orchestration, hot patch, video controls, fullscreen, meters, Mini-TV/input/aspect logic, on-demand render loop. |
| `data/crt-presets.json` | ~233 | Committed snapshot of the `crt/` dir listing (`[{name}]`); feeds the preset dropdown (see §3). |
| `scripts/update-crt-presets.mjs` | ~29 | Regenerates `data/crt-presets.json` from the GitHub API. |
| `test/validate-passes.mjs` | — | Offline glslang validator (see §7). |
| `README.md` | ~98 | User-facing docs. |

`.gitignore` ignores `test/out/`.

---

## 5. The shader-preparation pipeline (the hard part)

libretro `.glsl` files are **desktop GLSL** (`#version 130`) with both stages in one
file behind `#if defined(VERTEX)` / `defined(FRAGMENT)`, plus Cg-conversion idioms.
WebGL2 wants strict **GLSL ES 3.00**. The transforms are all **mechanical and
shader-agnostic** — no per-shader hacks except the one explicit hot patch (§6).

### `js/source.js :: buildStageSource`
- Strips the desktop `#version`, re-emits `#version 300 es`.
- Sets `__VERSION__`, `GL_ES`, `GL_FRAGMENT_PRECISION_HIGH`, `PARAMETER_UNIFORM`,
  and the stage macro for the flattener.
- `es3compat` (retry path, §“ES3 retry”): for legacy ESSL-1.00 shaders without a
  `#version`, adds keyword-mapping prelude (`attribute`→`in`, `varying`→in/out,
  `texture2D`→`texture`, `gl_FragColor`→declared out). Auto-forced when the source
  uses derivatives (`fwidth`/`dFdx`/`dFdy`), which ESSL 1.00 lacks.
- **`avoidGlEs`**: if the source contains `##` token pasting, compiles with `GL_ES`
  *undefined*. Rationale: some shaders (ntsc 2-phase) use `##` only inside an
  `#ifdef GL_ES` hand-unrolled branch whose `#else` is an equivalent ES3-valid
  array/loop. WebGL2's preprocessor has no `##`, so we select the `#else` path.
- Injects `precision highp float/int` for fragment.
- **Cross-stage uniform precision normalization:** rewrites `uniform … float/vecN/matN`
  → `highp`, `int/ivecN` → `mediump`. Without this, the COMPAT boilerplate gives the
  same uniform different default precisions per stage → link error
  ("Precisions of uniform 'TextureSize' differ").
- `gl_FragColor`: if the shader declares its own `out vec4 …FragColor` it aliases to
  that (hybrid shaders); else declares `_crt_FragColor`. (ANGLE rejects `__`-prefixed
  identifiers — that's why an earlier `__crt_init_globals` had to be renamed.)

### `js/flatten.js`
- **`flattenConditionals(src, predefined)`** — a real C-preprocessor `#if/#ifdef/
  #ifndef/#elif/#else/#endif` evaluator (tokenizer + full precedence climb incl.
  `defined()`, ternary, bitwise). Keeps `#define` lines for the GLSL compiler;
  evaluates only the conditionals. Strips trailing comments from `#if` expressions
  (a shader had `#if __VERSION__ < 130 // comment` that broke tokenizing).
- **`hoistGlobalInitializers(src)`** — GLSL ES forbids non-constant global
  initializers. Cg-converted shaders blank `const` via `#define const` and init
  globals from other globals. Only when that `#define const` blanking is present, we
  move initializers into a generated `crt_init_globals_()` called at top of `main()`.
  Real `const` globals are left alone.
- **`applyEsCompatShims(src)`** — `wrapArgInFloat(textureLod, lodArg)` and
  `coerceIntFloatUsage()`: declaration-driven insertion of explicit `float(...)` casts
  where desktop GLSL's implicit int→float is relied on (loop counters, `const int`s,
  int uniforms vs float/vector identifiers, single-signature function params). It is
  deliberately conservative — ambiguous identifiers are skipped.

### `js/runtime.js :: CrtRuntime`
- WebGL2 context with `preserveDrawingBuffer: true` (needed for PNG download).
- `build(compiledPasses, presetTextures, lutBitmaps, viewport)` compiles/links each
  pass program, uploads LUT textures (mipmapped if requested; **ImageBitmaps ignore
  `UNPACK_FLIP_Y_WEBGL`** so they're decoded with `imageOrientation:'flipY'` in
  main.js).
- `layout()` computes per-pass sizes (`source`/`viewport`/`absolute` scale types;
  viewport-scaled passes use the **content rect**, not the full canvas), allocates
  FBO textures (RGBA8 / `SRGB8_ALPHA8` / `RGBA16F`), wires sampler params from the
  *consumer* pass (RetroArch semantics).
- Uniform resolver handles `MVPMatrix`, `Texture`, `InputSize`, `TextureSize`,
  `OutputSize`, `FrameCount`, `FrameDirection`, `Orig*`, `Pass#*`, `PassPrev#*`,
  `<alias>texture`/`<alias>texture_size`/`<alias>video_size`, LUT names + `_size`,
  and `#pragma parameter` values.
  - **Subtle multi-pass bug fixed here:** `Pass#`/`PassPrev#` `InputSize` must report
    that pass's **output framebuffer** size, not its input. Getting this wrong made
    crt-royale's mask/halation passes sample a sliver of the wrong texture → the
    "scrambled" look the user reported. (`InputSize` vs `TextureSize` only differ via
    POT padding, which we never do.)
- **Orientation:** every pass is orientation-preserving (texture row v=0 → render row
  v=0). The upload enters via a **feed canvas** in main.js (a 2D `<canvas>` we draw
  the image/video into at the chosen input resolution + crop), uploaded with
  `UNPACK_FLIP_Y_WEBGL=true`. There's a `flipY` quad escape hatch + "Flip vertical"
  toggle.
- **Letterboxing (decoupled output res vs content aspect):** the `<canvas>` is exactly
  the chosen output resolution. `viewportRect()` computes the largest rect of the
  content aspect centered in it; the final pass clears the whole canvas black then
  sets `gl.viewport` to that rect. Bars are produced by the shader, nothing is cropped.
  This matches how RetroArch hands its viewport to the last pass.

---

## 5A. Mini-TV mode, region rendering, on-demand & frame-time meters

All added this session; all live in `CrtRuntime` (`js/runtime.js`) + `main.js`. The unifying idea:
crt-royale sizes the **phosphor mask from `OutputSize`** (fixed 3 output px/triad — confirmed: the
mask passes read `mask_*_static` **compile-time consts**; the `#pragma parameter mask_*` only exist
in the geometry pass and merely tune its bloom estimate). So the *only* knob for grille fineness is
the viewport/output resolution. Mini-TV exploits this.

### Mini-TV window (`setWindow`, `virtualRect`, `drawVpRect`)
Goal: a small canvas (e.g. 480×360) showing a **pixel-exact 1:1 crop** of what crt-royale would
render at a high **virtual reference resolution** `V` (e.g. 1440p/4K), so the mask keeps its native
pitch — just fewer triads visible.
- `setWindow({virtualW, virtualH, cropX, cropY})` stores `this.virtual` + `this.crop` (clamped to
  `MAX_TEXTURE_SIZE`). `layout()` sizes all viewport-scaled passes off `virtualRect()` (the
  letterboxed content rect at `V`), so the mask is at `V` pitch. The canvas stays the small window.
- The **final pass** is clipped to the window via a negatively-offset `gl.viewport(vp.x - crop.x,
  vp.y - crop.y, V.w, V.h)` into the small canvas (`drawVpRect`). This is valid **because crt-royale
  uses no `gl_FragCoord`** — every fragment derives mask/curvature from interpolated `tex_uv` ×
  size uniforms, so a window is a literal sub-rectangle of the full render. `vpRect` stays the
  content rect (back-compat for the corner test); `virtualVpRect`/`drawVpRect` are exposed too.

### Region ("fast") render — scissor the heavy passes
Mini-TV's exact mode still renders the full `V` frame in the intermediate passes (cost = a full
1440p/4K render). Region mode (`setRegionMode(on, margin)`, default ON, margin 0) keeps the FBOs at
full `V` (so all UV/size math is byte-identical) but **`gl.scissor`s each pass to the window
footprint** so only visible fragments are shaded. Per-axis rule in `layout()`: scissor an axis iff
that pass's output dim equals the virtual content-rect dim — selects the window-aligned heavy passes
(pass1 on Y; 7/8/9/10 on both) and skips the mask tiles / small source passes. Guards: skip if the
consumer mipmaps the output; a fixed `REGION_PASS_MARGIN` (32px, on top of the user margin) covers
cross-pass blur/curvature reach; scissored FBOs are cleared once to avoid stale-NaN edge leakage.
Verified pixel-exact (meanDiff/maxDiff 0) vs the full render — see `region.mjs`.

### On-demand rendering (dirty flag)
`frame()` only renders when `!onDemandEnabled() || state.needsRender || media.isVideo`. Static images
render once then idle (fps reads `0`, GPU ~0); `requestRender()` marks dirty and is called from the
high-level apply functions (`applyFeed`, `applyOutputSize`, `applyParams`, `loadPreset`, flipY).
Video always renders. `pollGpuQueries()` is still drained every tick while idle.

### Frame-time meters
`#frameTime` = **CPU** submit time via `performance.now()` (matches DevTools' main track);
`#gpuTime` = **GPU** execution time via `EXT_disjoint_timer_query_webgl2` (async; `render()` wraps
the pass loop in a query, `pollGpuQueries()` drains a small queue, `lastGpuTimeMs`). Both refresh
every 200ms. Note: GPU time is the real cost for "will it hold 60fps"; CPU submit time is much lower
because GPU work is async.

### Bloom-disable — attempted & reverted
Pruning crt-royale's bloom sub-chain (passes 8/9/10, repointing the geometry pass to MASKED_SCANLINES)
worked structurally but **darkened the image**: the geometry pass linearizes its input expecting the
reconstitute pass's encoding, so reading pass7 double-applies gamma. Reverted; region scissoring
already makes bloom cheap. A **Halation** toggle survives — it just zeroes `halation_weight` +
`diffusion_weight` via `applyParams()` (clean, param-only).

---

## 6. The hot patch (only per-shader special-case)

`crt-royale-scanlines-vertical-interlacing.glsl` line ~296 has
`static const bool interlace_detect = true;`. When that file is part of the loaded
preset, main.js shows an **Advanced** section (top of `#params`) with an
**Interlace detect** checkbox. It text-rewrites `interlace_detect = true` →
`false` when unchecked. **Default: ON** (checkbox checked, original `true` kept).
Toggling rebuilds the preset (cached sources → fast). State in
`state.advanced.interlaceDetect`. If you add more hot patches, mirror this pattern
(`buildAdvancedUI`, `hasInterlacePass` flag, rebuild on change).

---

## 7. Testing

### Offline validator — `test/validate-passes.mjs`
Builds every stage of a preset exactly like the app (`buildStageSource`) and validates
with **`glslang`** (Khronos `glslang-tools`, install via apt). This is the fast inner
loop — use it before browser testing.
```sh
# repo dir of libretro/glsl-shaders (sparse: crt blurs ntsc windowed)
node test/validate-passes.mjs /tmp/slang/glsl-repo crt/crt-royale.glslp
```
Caveat: glslang ≈ ANGLE but not identical. Some things compile in glslang yet fail in
real ANGLE (e.g. `__`-identifiers, multiple-fragment-output errors, uniform-precision
mismatches) — always confirm changes in a real browser too.

### Status: **75/77 `crt/` presets validate.** Failing:
- `crt-royale-pal-r57shell` and `mame_hlsl` — use `##` token pasting *outside* a
  guarded ES3 alternative, so the `avoidGlEs` trick can't save them.

### E2E — Playwright + headless Chromium (committed at `test/e2e/`)
SwiftShader software GL (runs without a GPU). Each test starts its own static
server rooted at the repo (no separate `http.server` needed) and exits non-zero
on failure. See `test/e2e/README.md`.
```sh
cd test/e2e && npm install && npx playwright install chromium
npm test   # all; or test:render / test:presets / test:ui / test:input / test:window / test:region / test:ondemand
# APP_URL=http://localhost:8000 npm test   # target an already-running server
```
- `helpers.mjs` — shared: built-in static server, browser launch (SwiftShader
  args), corner-pattern PNG generator, `openApp`, `withApp` lifecycle wrapper.
- `run.mjs` — uploads a corner-marker pattern (TL red / TR green / BL blue /
  BR white), asserts corner colors through all 12 crt-royale passes + letterbox
  rect; also asserts each corner's dominant channel.
- `multi.mjs` — loops ~13 presets, polls for a non-blank frame each.
  **crt-hyllian is currently skipped** (see §“open ideas”).
- `ui.mjs` — mobile layout + actual-size (dpr=2) + centered scroll on `#canvasWrap`.
- `inputres.mjs` — asserts feed dimensions for the **split Lines × Horizontal** axes
  (source/fixed/custom on each).
- `window.mjs` — Mini-TV in **exact** mode: asserts the windowed canvas equals the
  matching sub-rectangle of a full 1440p render (meanDiff/maxDiff 0) + a negative
  control that it's a crop, not a downscale.
- `region.mjs` — Mini-TV in **region** mode: same sub-rect equality (centered AND
  edge crops) and asserts ≥4 passes were scissored (margins cover the footprints).
- `ondemand.mjs` — static image freezes `frameCount` when idle (fps `0`), a state
  change renders one frame, on-demand-off renders continuously.
- `window.__crt` (set in main.js) exposes `{runtime, feed, …}`; runtime now also
  exposes `vpRect`/`virtualVpRect`/`drawVpRect`, `frameCount`, `lastGpuTimeMs`,
  per-pass `roi`, `paramValues` — tests read these directly.
- The earlier one-off diagnostics (`errs*`, `debug-*`, `scroll*`, `dump-uniforms`)
  were throwaway and not committed. (`/tmp/e2e/smoke.mjs` is an obsolete
  external-server smoke test, superseded by `run.mjs`; not worth moving.)

**Verified rendering in real (SwiftShader) browser:** crt-royale (correct
scanlines/mask/bloom/letterbox), crt-geom, lottes, easymode, aperture,
guest-dr-venom, hyllian, phosphorlut, crtsim, zfast variants, gizmo-crt,
interlaced-halation.

**Not yet browser-verified:** video transport controls (logic written, only
unit-reasoned); the most recent "Advanced at top + interlace default ON" change
(syntax-checked only).

---

## 8. UI feature inventory (`index.html` + `main.js`)

- **Media** upload (image/video). Video → `<video>` muted+loop+playsinline (autoplay
  needs muted); image → `ImageBitmap`.
- **Shader** dropdown (from `data/crt-presets.json` snapshot + fallback; see §3).
- **Input resolution — split into two independent axes** (`feedSize()` resolves each via
  `axisSize()`):
  - **Lines** (`#inputLines`, vertical = CRT scanline count): Source / 224 (SNES/Genesis) /
    240 (NES/PS1, default) / 480 (interlaced) / Custom. crt-royale auto-interlaces past ~288 lines.
  - **Horizontal** (`#inputWidth`, source detail; does **not** change triad count): Source (default) /
    256 (NES/SNES) / 320 (Genesis/PS1) / 640 (480p) / Custom. Higher = less blockiness.
  - Each axis: `source` matches the media on that axis, a fixed value, or a `custom` number box.
    (Replaces the old single Input dropdown + downscale factors.)
- **Crop** (center-crop source to aspect *before* shader; default **None**):
  4:3/16:9/1:1/3:2/Custom (`W:H`). Implemented in `sourceRect()` → drawImage src rect.
- **Fit** (Auto / Scale to fit / Stretch, default **Auto**): with the anamorphic feed grid, "Scale to
  fit" now letterboxes the source against the **output display aspect** (not the feed aspect) and maps
  that to feed pixels — no bars when display aspect == source aspect. `drawFeed()`.
- **Aspect** (display aspect for output letterboxing): 4:3 default / 16:9 / **Match input**. "Match
  input" = the **source media's** own aspect (`sourceRect` sw/sh) — *not* the anamorphic feed aspect
  (that was the bug fixed when the input axes were split). `contentAspect()`.
- **Output** resolution: 1080p default / 1440p / 4K / 720p (drives the mask pitch in normal mode).
- **Mini-TV** (`#miniMode`, default off — see §5A): reveals **Reference** res (`#refRes`: 720p–5K,
  drives the grille pitch), **Window** size (`#windowSize`: 192×144–800×600, the small output canvas),
  **Pan X/Y** sliders, **Render** mode (`#renderMode`: Region default / Exact), and a **Margin** slider
  (region only). `applyOutputSize()` branches on `refResolution()`.
- **Actual size** (default **ON**): 1:1 device pixels via `devicePixelRatio`. Scrolls
  on overflow. Scroll happens on inner `#canvasWrap` (not `#view`) so floating
  controls stay put; auto-centered via a retry loop (a one-shot scroll raced layout).
- **Flip vertical**, **On-demand** (default **ON**; static images render only on change — §5A),
  **Halation** (default ON; off zeroes `halation_weight`+`diffusion_weight`), **Reload shader**
  (clears source cache), **Reset params**, **Download image** (PNG `<preset>-<w>x<h>.png`, current
  buffer — in Mini-TV this is the small windowed crop), **Fullscreen**.
- **Fullscreen:** hides header/status/params (`body.fs`), requests native fullscreen;
  "Show controls" button fades after 2.5s idle, reappears on pointer move.
- **Per-parameter sliders** from `#pragma parameter` (name/desc/min/max/step/default),
  each with a borderless **↺ reset** to default (preset override value if any, else
  pragma initial).
- **Meters** (`#meters`, right of `#status`, refresh 200ms): `#frameTime` CPU submit ms
  (`performance.now()`), `#gpuTime` GPU ms (`EXT_disjoint_timer_query`), `#fps`. fps reads `0` when
  idle in on-demand mode. See §5A. Two **live sparklines** (`#gpuGraph`/`#fpsGraph`, `drawSparkline()`
  in main.js) plot **unsmoothed per-frame** GPU time and instantaneous fps (1000/frame-interval) so
  jitter the 200ms averages hide is visible. GPU samples come from a new `runtime.gpuTimeHistory` ring
  buffer (filled in `pollGpuQueries`); fps samples from a `fpsHistory` ring in main.js (reset on idle
  resume). fps graph draws a faint 60-fps baseline. Empty on SwiftShader (GPU queries never resolve).
- **Video transport** (`#vid`, only for videos): play/pause, seek + `m:ss / m:ss`,
  mute, volume. Rounded translucent panel floating over `#view`, inset 12px sides /
  18px bottom (clear of the scrollbar). Fades after 2.5s idle; stays while hovered.
- **Mobile (<800px):** `#content` column, params below canvas.
- **Advanced** section (top of params, conditional) — see §6.

---

## 9. Gotchas / things learned the hard way

- ImageBitmap ignores `UNPACK_FLIP_Y_WEBGL` → flip at decode (`imageOrientation`).
- ANGLE forbids identifiers containing `__`.
- Cross-stage uniform precision must match or linking fails.
- `preserveDrawingBuffer:true` is required for the PNG download to capture a frame.
- Scroll-centering after toggling actual-size needs a retry loop (layout race with
  the active render loop).
- Preset loads are serialized via `loadGeneration` (`stale()` guard) so rapid preset
  switches don't interleave.
- The ES3 retry: `build()` throws `pass{N} …`; main.js catches, recompiles that pass
  with `{es3compat:true}` once, rebuilds. Stored `rawSrc` on each pass for this.
- **crt-royale uses no `gl_FragCoord`** — it derives everything from `tex_uv` × size uniforms. This
  is what makes the Mini-TV `gl.viewport`-offset windowing and the region `gl.scissor` decoupling
  pixel-exact (a window is a literal sub-rectangle of the full render). Verify this holds before
  applying the same trick to another shader family.
- **Mask/grille pitch is `OutputSize`-driven and otherwise fixed**: the mask passes read
  `mask_*_static` compile-time consts (3 px/triad); the `#pragma parameter mask_*` exist only in the
  geometry pass (bloom estimate). To change grille fineness you change the render resolution, not a
  param. Input resolution only changes *triads-per-source-pixel* (relative coarseness).
- **NTSC presets are resolution-coupled by design**: `crt-royale-ntsc-256px-*` = 3-phase signal at
  1024px (256×4); `320px-*` = 2-phase at 1280px (320×4). Feeding a mismatched source width gives
  wrong artifact colors — that's intended, not a bug.
- **GPU timer query**: SwiftShader (CI) exposes `EXT_disjoint_timer_query_webgl2` but its queries
  never resolve → we cap the in-flight queue (<8) and fall back to CPU time. `performance.now()`
  around `render()` measures **CPU submit only** (GPU work is async); don't `gl.finish()` to "fix" it.
- **Anamorphic feed**: with independent Lines/Horizontal, the feed canvas aspect is meaningless for
  display. Anything that needs a display aspect (Match-input, Scale-to-fit letterbox) must use the
  **source media** aspect, never `feed.width/feed.height`.

---

## 10. Known limitations (also in README)

- `wrap_mode = clamp_to_border` → clamp-to-edge (WebGL has no border addressing).
- `mipmap_input` on an sRGB framebuffer unsupported in WebGL2 (samples level 0).
- History (`Prev*Texture`) and feedback bindings not implemented (unused by crt presets).
- The 2 failing presets in §7.

---

## 11. Suggested next steps / open ideas

- **crt-hyllian black-render bug:** renders fine standalone, but goes black when
  loaded immediately after `crt-guest-dr-venom` (frames still advance,
  `gl.isContextLost()` false, no shader error). Suspected leftover GL state not
  reset between presets. Currently skipped in `multi.mjs`. Investigate
  `CrtRuntime.build`/`layout` teardown (e.g. leftover bound state, attrib arrays,
  or an FBO/texture from the previous preset).
- Browser-verify the video transport + the latest Advanced-default change.
- Consider PassFeedback/history if a target preset needs it.
- The 2 `##` presets would need a real macro-expansion pass (expand function-like
  macros + token paste in our preprocessor) to support.
- Possibly persist UI choices (localStorage) — now that there are many controls.
- Drag-and-drop upload; URL param to deep-link a preset.
- **Bloom disable (proper):** the reverted pass-pruning darkened the image (gamma double-apply at
  the geometry pass). A correct no-bloom path needs a small shader-level tweak (encode pass7's output
  to match, or skip the geometry pass's `tex2D_linearize`). Region scissoring already makes bloom
  cheap, so this is look-only — low priority.
- **Regenerate `data/crt-presets.json`** when upstream adds presets (`node scripts/update-crt-presets.mjs`,
  needs API budget / `GITHUB_TOKEN`); the snapshot is a point-in-time copy of the `crt/` dir.
