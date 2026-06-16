// Glue: fetch shader presets from the libretro/glsl-shaders GitHub repo and
// render uploaded photos/videos through them with WebGL2.
// Everything runs locally in the browser; uploaded media never leaves the page.

import { parsePreset } from './slangp.js';
import { SourceLoader, buildStageSource, parseParameterPragmas, resolveUrl } from './source.js';
import { CrtRuntime } from './runtime.js';

const RAW_BASE = 'https://raw.githubusercontent.com/libretro/glsl-shaders/master/';
// Snapshot of the libretro/glsl-shaders `crt` directory listing, stored in the
// repo (data/crt-presets.json) so the app doesn't hit the GitHub API (rate
// limited) on every load. Regenerate with scripts/update-crt-presets.mjs.
const PRESET_LIST = new URL('../data/crt-presets.json', import.meta.url).href;
const FALLBACK_PRESETS = [
  'crt/crt-royale.glslp',
  'crt/crt-royale-fake-bloom.glslp',
  'crt/crt-geom.glslp',
  'crt/crt-easymode.glslp',
  'crt/crt-aperture.glslp',
  'crt/crt-lottes.glslp',
  'crt/crt-hyllian.glslp',
  'crt/fakelottes.glslp',
  'crt/zfast-crt.glslp',
];

// The crt-royale family shares almost all dependencies (the 12-pass chain + the
// 6 mask LUTs are identical; only the NTSC/PAL pre-pass shaders and the .glslp
// differ). When any of these is loaded we prewarm the whole set into memory so
// switching between them runs loadPreset without any network fetch.
const CRT_ROYALE_PRESETS = [
  'crt/crt-royale.glslp',
  'crt/crt-royale-ntsc-256px-composite.glslp',
  'crt/crt-royale-ntsc-320px-composite.glslp',
  'crt/crt-royale-ntsc-256px-svideo.glslp',
  'crt/crt-royale-ntsc-320px-svideo.glslp',
  'crt/crt-royale-pal-r57shell.glslp',
];
const isCrtRoyale = (path) => /crt-royale/.test(path);

const ui = {
  status: document.getElementById('statusText'),
  file: document.getElementById('file'),
  preset: document.getElementById('preset'),
  resolution: document.getElementById('resolution'),
  miniMode: document.getElementById('miniMode'),
  miniControls: document.getElementById('miniControls'),
  refRes: document.getElementById('refRes'),
  refCustom: document.getElementById('refCustom'),
  windowSize: document.getElementById('windowSize'),
  windowCustom: document.getElementById('windowCustom'),
  winCenterX: document.getElementById('winCenterX'),
  winCenterY: document.getElementById('winCenterY'),
  renderMode: document.getElementById('renderMode'),
  regionMargin: document.getElementById('regionMargin'),
  regionMarginLabel: document.getElementById('regionMarginLabel'),
  inputLines: document.getElementById('inputLines'),
  inputLinesCustom: document.getElementById('inputLinesCustom'),
  inputWidth: document.getElementById('inputWidth'),
  inputWidthCustom: document.getElementById('inputWidthCustom'),
  crop: document.getElementById('crop'),
  cropCustom: document.getElementById('cropCustom'),
  fit: document.getElementById('fit'),
  aspect: document.getElementById('aspect'),
  reload: document.getElementById('reload'),
  resetParams: document.getElementById('resetParams'),
  flipY: document.getElementById('flipY'),
  onDemand: document.getElementById('onDemand'),
  halation: document.getElementById('halation'),
  actualSize: document.getElementById('actualSize'),
  download: document.getElementById('download'),
  fullscreen: document.getElementById('fullscreen'),
  showControls: document.getElementById('showControls'),
  view: document.getElementById('view'),
  canvasWrap: document.getElementById('canvasWrap'),
  vid: document.getElementById('vid'),
  vidPlay: document.getElementById('vidPlay'),
  vidSeek: document.getElementById('vidSeek'),
  vidTime: document.getElementById('vidTime'),
  vidMute: document.getElementById('vidMute'),
  vidVol: document.getElementById('vidVol'),
  paramList: document.getElementById('paramList'),
  advanced: document.getElementById('advanced'),
  canvas: document.getElementById('canvas'),
  fps: document.getElementById('fps'),
  frameTime: document.getElementById('frameTime'),
  gpuTime: document.getElementById('gpuTime'),
  gpuGraph: document.getElementById('gpuGraph'),
  fpsGraph: document.getElementById('fpsGraph'),
};

function status(msg) {
  ui.status.textContent = msg;
  console.log('[crt]', msg);
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.text();
}

async function listPresets() {
  try {
    const r = await fetch(PRESET_LIST);
    if (!r.ok) throw new Error('preset list unavailable');
    const entries = await r.json();
    const presets = entries
      .filter(e => e.name.endsWith('.glslp'))
      .map(e => `crt/${e.name}`);
    return presets.length ? presets : FALLBACK_PRESETS;
  } catch {
    return FALLBACK_PRESETS;
  }
}

const state = {
  runtime: null,
  feed: document.createElement('canvas'),
  loader: new SourceLoader(fetchText),
  parameters: [],
  paramValues: {},
  presetOverrides: {},
  media: null, // { source, width, height, isVideo }
  running: false,
  needsRender: true, // on-demand: render the next frame (start dirty)
  advanced: { interlaceDetect: true },
  lutCache: new Map(),     // resolved URL -> Promise<ImageBitmap> (decoded LUT/mask)
  crtRoyaleWarmed: false,  // whether the crt-royale family has been prewarmed
};

// Decode a LUT/mask texture once and reuse the ImageBitmap across preset builds
// (build() uploads it to a fresh GL texture each time; it does not consume the
// bitmap). Keyed by resolved URL so shared masks are fetched/decoded once.
function cachedLut(url) {
  let p = state.lutCache.get(url);
  if (!p) {
    p = (async () => createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'flipY' }))();
    state.lutCache.set(url, p);
  }
  return p;
}

// Apply the crt-royale interlace-detect hot patch to a pass source. Shared by
// loadPreset and the prewarm so both produce byte-identical stage sources (hence
// identical program-cache keys).
function patchPassSource(rawSrc, passPath) {
  if (/crt-royale-scanlines-vertical-interlacing\.glsl$/.test(passPath) && !state.advanced.interlaceDetect) {
    return rawSrc.replace(/(\binterlace_detect\s*=\s*)true(\s*;)/, '$1false$2');
  }
  return rawSrc;
}

// Eagerly pull every crt-royale preset (glslp + pass shaders + LUTs) into the
// in-memory caches AND precompile each pass program, so subsequent switches hit
// cache instead of the network and skip GL compilation. Fire-and-forget and
// best-effort; everything is keyed by URL/source so shared chain passes, mask
// LUTs, and programs are fetched/compiled once total. Yields between passes so
// the compile burst doesn't jank the render loop.
function prewarmCrtRoyale() {
  if (state.crtRoyaleWarmed) return;
  state.crtRoyaleWarmed = true;
  for (const path of CRT_ROYALE_PRESETS) {
    const url = RAW_BASE + path;
    state.loader.load(url).then(async text => {
      const preset = parsePreset(text);
      for (const t of preset.textures) if (t.path) cachedLut(resolveUrl(url, t.path));
      for (const pass of preset.passes) {
        const raw = await state.loader.load(resolveUrl(url, pass.path));
        const src = patchPassSource(raw, pass.path);
        // Warm the program build() will use; fall back to the ES3 source loadPreset
        // would retry with if the legacy path fails to compile.
        const ok = state.runtime.warmProgram(buildStageSource(src, 'VERTEX'), buildStageSource(src, 'FRAGMENT'));
        if (!ok) {
          state.runtime.warmProgram(
            buildStageSource(src, 'VERTEX', { es3compat: true }),
            buildStageSource(src, 'FRAGMENT', { es3compat: true }));
        }
        await new Promise(r => setTimeout(r)); // spread compiles across tasks
      }
    }).catch(() => {}); // best-effort warm; real loads surface their own errors
  }
}

// On-demand rendering: mark the scene dirty so the loop renders one frame. Video
// always renders; for a static image we render only when something changes.
function requestRender() { state.needsRender = true; }
function onDemandEnabled() { return ui.onDemand ? ui.onDemand.checked : true; }
function glowEnabled() { return ui.halation ? ui.halation.checked : true; }

// Push parameters to the runtime, applying the glow (halation/diffusion) toggle,
// and request a render.
function applyParams() {
  if (!state.runtime) return;
  const values = { ...state.paramValues };
  if (!glowEnabled()) { values.halation_weight = 0; values.diffusion_weight = 0; }
  state.runtime.setParams(values);
  requestRender();
}

let loadGeneration = 0;

async function loadPreset(presetPath) {
  const gen = ++loadGeneration;
  const stale = () => gen !== loadGeneration;
  const presetUrl = RAW_BASE + presetPath;
  status(`Fetching preset ${presetPath}…`);
  // loader.load memoizes by URL, so a prewarmed glslp comes from memory (no fetch).
  const preset = parsePreset(await state.loader.load(presetUrl));

  // Kick off every dependency download at once (GitHub rate-limits per hour, so
  // parallel is fine) — pass shaders and LUT textures — then process results.
  // SourceLoader.load caches the in-flight promise, so this is safe / dedups URLs.
  status(`Fetching ${preset.passes.length} shader passes…`);
  const shaderSrcs = preset.passes.map(pass => state.loader.load(resolveUrl(presetUrl, pass.path)));
  const lutPromises = preset.textures.filter(t => t.path).map(async t => {
    return { name: t.name, bitmap: await cachedLut(resolveUrl(presetUrl, t.path)) };
  });

  // Process shaders in pass order (keeps the param list and first-wins dedup
  // deterministic); the downloads above already run concurrently.
  const compiledPasses = [];
  const allParams = new Map();
  let hasInterlacePass = false;
  for (let i = 0; i < preset.passes.length; i++) {
    const pass = preset.passes[i];
    let src = await shaderSrcs[i];
    status(`Preparing pass ${pass.index + 1}/${preset.passes.length}: ${pass.path.split('/').pop()}…`);
    for (const p of parseParameterPragmas(src)) {
      if (!allParams.has(p.name)) allParams.set(p.name, p);
    }
    // Hot patch: crt-royale's vertical-interlacing pass forces interlace_detect
    // on; expose it as an advanced toggle (default off).
    if (/crt-royale-scanlines-vertical-interlacing\.glsl$/.test(pass.path)) hasInterlacePass = true;
    src = patchPassSource(src, pass.path);
    compiledPasses.push({
      meta: pass,
      rawSrc: src,
      vertexSrc: buildStageSource(src, 'VERTEX'),
      fragmentSrc: buildStageSource(src, 'FRAGMENT'),
    });
  }

  status('Fetching LUT textures…');
  const lutBitmaps = new Map();
  for (const { name, bitmap } of await Promise.all(lutPromises)) lutBitmaps.set(name, bitmap);

  if (stale()) return;
  state.parameters = [...allParams.values()];
  state.presetOverrides = preset.parameterOverrides;
  resetParamValues();
  buildParamUI();
  buildAdvancedUI(hasInterlacePass);

  const [w, h] = outputSize();
  ui.canvas.width = w;
  ui.canvas.height = h;
  state.runtime.viewport = { width: w, height: h, aspect: contentAspect() };
  status('Compiling shaders (WebGL)…');
  await new Promise(r => setTimeout(r)); // let the status paint
  if (stale()) return;
  // Legacy ESSL 1.00 shaders can hit restrictions WebGL2 keeps (non-constant
  // loop bounds, no derivatives, ...). Retry the failing pass as ES 3.00
  // behind a keyword-mapping prelude.
  const retried = new Set();
  for (;;) {
    try {
      state.runtime.build(compiledPasses, preset.textures, lutBitmaps, { width: w, height: h, aspect: contentAspect() });
      break;
    } catch (e) {
      const m = String(e.message).match(/^pass(\d+) /);
      const k = m ? +m[1] : -1;
      if (k < 0 || retried.has(k)) throw e;
      retried.add(k);
      console.warn(`[crt] pass${k}: retrying as ES 3.00 (${String(e.message).split('\n').slice(0, 2).join(' | ')})`);
      compiledPasses[k].vertexSrc = buildStageSource(compiledPasses[k].rawSrc, 'VERTEX', { es3compat: true });
      compiledPasses[k].fragmentSrc = buildStageSource(compiledPasses[k].rawSrc, 'FRAGMENT', { es3compat: true });
    }
  }
  applyParams();
  if (state.media) applyFeed();
  // Re-apply the full output config (mini-TV window, region mode, actual-size)
  // so those settings persist across a shader rebuild — not just actual-size.
  applyOutputSize();
  status(`Ready: ${presetPath} (${preset.passes.length} pass${preset.passes.length > 1 ? 'es' : ''}). ${state.media ? '' : 'Upload a photo or video to start.'}`);
  // Warm the rest of the crt-royale family into memory so switching is instant.
  if (isCrtRoyale(presetPath)) prewarmCrtRoyale();
}

// Center-crop rectangle of the source media for the selected crop aspect.
// Returns { sx, sy, sw, sh } in media pixels; full frame when crop is None.
function sourceRect() {
  const mw = state.media ? state.media.width : 320;
  const mh = state.media ? state.media.height : 240;
  const v = ui.crop.value;
  let ar = null;
  if (v === 'custom') {
    const m = ui.cropCustom.value.match(/^\s*(\d*\.?\d+)\s*[:/xX]\s*(\d*\.?\d+)\s*$/);
    if (m && +m[1] > 0 && +m[2] > 0) ar = +m[1] / +m[2];
  } else if (v !== 'none') {
    const [a, b] = v.split(':').map(Number);
    ar = a / b;
  }
  if (!ar) return { sx: 0, sy: 0, sw: mw, sh: mh };
  let sw = mw, sh = Math.round(mw / ar);
  if (sh > mh) { sh = mh; sw = Math.round(mh * ar); }
  return { sx: Math.floor((mw - sw) / 2), sy: Math.floor((mh - sh) / 2), sw, sh };
}

// The input resolution is split into two independent axes: horizontal
// resolution (source detail) and lines (vertical resolution = CRT scanline
// count). Each axis is 'source' (match the media), a fixed value, or custom.
function axisSize(sel, customEl, nativeVal) {
  const v = sel.value;
  if (v === 'source') return nativeVal;
  const n = parseInt(v === 'custom' ? customEl.value : v, 10);
  return n > 0 ? n : nativeVal;
}

function feedSize() {
  const rect = sourceRect();
  const native = [rect.sw, rect.sh];
  if (!state.media) return native;
  return [
    Math.max(1, axisSize(ui.inputWidth, ui.inputWidthCustom, native[0])),
    Math.max(1, axisSize(ui.inputLines, ui.inputLinesCustom, native[1])),
  ];
}

function updateInputCustomBox() {
  for (const [sel, custom] of [[ui.inputWidth, ui.inputWidthCustom], [ui.inputLines, ui.inputLinesCustom]]) {
    const on = sel.value === 'custom';
    custom.style.display = on ? '' : 'none';
    if (on) custom.focus();
  }
}

// How the media is mapped onto the feed canvas when their aspect ratios
// differ: 'stretch' fills (distorting), 'fit' letterboxes the source before
// it enters the shader chain. 'auto' letterboxes only when a fixed console
// resolution is selected with "Match input" aspect (an explicit 4:3/16:9
// display aspect compensates the stretch like real non-square-pixel consoles
// did, so stretch is the authentic choice there).
function fitMode() {
  const v = ui.fit.value;
  if (v !== 'auto') return v;
  const isPresetRes = ui.inputWidth.value !== 'source' || ui.inputLines.value !== 'source';
  return (isPresetRes && ui.aspect.value === 'source') ? 'fit' : 'stretch';
}

function drawFeed() {
  if (!state.media) return;
  const ctx = state.feed.getContext('2d');
  if (state.media.isVideo && state.media.source.readyState < 2) return;
  const fw = state.feed.width, fh = state.feed.height;
  const { sx, sy, sw, sh } = sourceRect();
  // The feed grid (fw x fh) is anamorphic — its rows are scanlines and its
  // columns are detail, so its aspect is not a display aspect. "Scale to fit"
  // letterboxes the source (aspect S) inside the OUTPUT display aspect (D), then
  // maps that to feed pixels; when D == S there are no bars (just fill).
  const S = sw / sh;
  const D = contentAspect() || S;
  if (fitMode() === 'fit' && Math.abs(S - D) > 0.01) {
    let dw, dh;
    if (S >= D) { dw = fw; dh = Math.max(1, Math.round(fh * D / S)); }
    else { dh = fh; dw = Math.max(1, Math.round(fw * S / D)); }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, fw, fh);
    ctx.drawImage(state.media.source, sx, sy, sw, sh, Math.floor((fw - dw) / 2), Math.floor((fh - dh) / 2), dw, dh);
  } else {
    ctx.drawImage(state.media.source, sx, sy, sw, sh, 0, 0, fw, fh);
  }
}

// (Re)size the feed canvas and hand it to the runtime as the input frame.
function applyFeed() {
  const [w, h] = feedSize();
  state.feed.width = w;
  state.feed.height = h;
  drawFeed();
  state.runtime.setOriginal(state.feed, w, h, state.media.isVideo);
  requestRender();
}

function outputSize() {
  return ui.resolution.value.split('x').map(Number);
}

function contentAspect() {
  const a = ui.aspect.value;
  if (a === 'source') {
    // Match the source media's own aspect, NOT the (possibly anamorphic) feed
    // grid — Lines/Horizontal are independent, so the feed aspect is meaningless.
    const { sw, sh } = sourceRect();
    return sw / sh;
  }
  const [an, ad] = a.split(':').map(Number);
  return an / ad;
}

function parseWH(s) {
  const m = String(s).split(/[x×]/i).map(t => parseInt(t.trim(), 10));
  return (m.length === 2 && m[0] > 0 && m[1] > 0) ? [m[0], m[1]] : null;
}

// Mini-TV mode: a small canvas shows a 1:1 crop of a high "reference" render so
// the phosphor mask keeps its native pitch. null when the toggle is off.
function miniEnabled() { return !!ui.miniMode.checked; }

function refResolution() {
  if (!miniEnabled()) return null;
  const v = ui.refRes.value === 'custom-ref' ? ui.refCustom.value : ui.refRes.value;
  return parseWH(v) || [2560, 1440];
}

// Backing-store size (device pixels) that exactly fills the visible #view area
// at actual-size (1:1) scale, so the mini-TV window has no scrollbars.
function viewportWindowSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(16, Math.round((ui.view.clientWidth || 480) * dpr));
  const h = Math.max(16, Math.round((ui.view.clientHeight || 360) * dpr));
  return [w, h];
}

function windowSize() {
  const sel = ui.windowSize.value;
  if (sel === 'viewport') return viewportWindowSize();
  const v = sel === 'custom-window' ? ui.windowCustom.value : sel;
  return parseWH(v) || [480, 360];
}

function windowCenter() {
  return [parseFloat(ui.winCenterX.value) || 0.5, parseFloat(ui.winCenterY.value) || 0.5];
}

function regionMode() { return ui.renderMode.value === 'region'; }
function regionMargin() { const v = parseFloat(ui.regionMargin.value); return isNaN(v) ? 0 : v; }

function applyOutputSize() {
  if (!state.runtime) return;
  const ref = refResolution();
  if (!ref) {
    const [w, h] = outputSize();
    state.runtime.setViewport(w, h, contentAspect());
    state.runtime.setWindow(null);
    state.runtime.setRegionMode(false);
  } else {
    const aspect = contentAspect();
    const [Vw, Vh] = ref;
    const [W, H] = windowSize();
    state.runtime.setViewport(W, H, aspect);
    // Letterboxed content rect within the reference resolution.
    const vr = state.runtime.letterbox(Vw, Vh, aspect);
    const [cu, cv] = windowCenter();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Crop origin (bottom-left) in virtual-canvas GL coords. Clamp to the content
    // rect so panning can't reveal the black letterbox bars; if the window is
    // larger than the content on an axis, center it (letterboxed result).
    let cropX = Math.round(vr.x + cu * vr.width - W / 2);
    let cropY = Math.round(vr.y + cv * vr.height - H / 2);
    cropX = W <= vr.width ? clamp(cropX, vr.x, vr.x + vr.width - W) : Math.round(vr.x + (vr.width - W) / 2);
    cropY = H <= vr.height ? clamp(cropY, vr.y, vr.y + vr.height - H) : Math.round(vr.y + (vr.height - H) / 2);
    state.runtime.setWindow({ virtualW: Vw, virtualH: Vh, cropX, cropY });
    state.runtime.setRegionMode(regionMode(), regionMargin());
  }
  applyActualSize();
  requestRender();
}

// 1 canvas pixel == 1 device pixel (accounts for devicePixelRatio); overflow
// scrolls and starts centered.
function applyActualSize() {
  const wrap = ui.canvasWrap;
  if (ui.actualSize.checked) {
    ui.view.classList.add('actual');
    const dpr = window.devicePixelRatio || 1;
    ui.canvas.style.width = (ui.canvas.width / dpr) + 'px';
    ui.canvas.style.height = (ui.canvas.height / dpr) + 'px';
    const center = (tries) => {
      const tx = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
      const ty = Math.max(0, (wrap.scrollHeight - wrap.clientHeight) / 2);
      wrap.scrollLeft = tx;
      wrap.scrollTop = ty;
      if (tries > 0 && (Math.abs(wrap.scrollLeft - tx) > 1 || Math.abs(wrap.scrollTop - ty) > 1)) {
        setTimeout(() => center(tries - 1), 50);
      }
    };
    setTimeout(() => center(8), 0);
  } else {
    ui.view.classList.remove('actual');
    ui.canvas.style.width = '';
    ui.canvas.style.height = '';
  }
}

function paramDefault(p) {
  return (p.name in state.presetOverrides) ? state.presetOverrides[p.name] : p.initial;
}

function resetParamValues() {
  state.paramValues = {};
  for (const p of state.parameters) {
    state.paramValues[p.name] = paramDefault(p);
  }
}

function fmt(v) {
  const s = (+v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

function buildParamUI() {
  ui.paramList.innerHTML = '';
  if (!state.parameters.length) {
    const div = document.createElement('div');
    div.textContent = 'This shader has no runtime parameters.';
    ui.paramList.append(div);
    return;
  }
  for (const p of state.parameters) {
    const div = document.createElement('div');
    div.className = 'param';
    const label = document.createElement('label');
    label.textContent = p.description || p.name;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = p.min; range.max = p.max;
    range.step = p.step || (p.max - p.min) / 100 || 0.01;
    range.value = state.paramValues[p.name];
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = fmt(range.value);
    const apply = (v) => {
      range.value = v;
      state.paramValues[p.name] = parseFloat(range.value);
      val.textContent = fmt(range.value);
      applyParams();
    };
    range.addEventListener('input', () => apply(range.value));
    const reset = document.createElement('button');
    reset.className = 'param-reset';
    reset.type = 'button';
    reset.title = 'Reset to default';
    reset.textContent = '↺';
    reset.addEventListener('click', () => apply(paramDefault(p)));
    div.append(label, range, val, reset);
    ui.paramList.append(div);
  }
}

// Advanced section: hot-patch toggles that aren't real #pragma parameters.
// Shown only when the relevant pass is part of the loaded preset.
function buildAdvancedUI(hasInterlacePass) {
  ui.advanced.innerHTML = '';
  if (!hasInterlacePass) return;
  const h = document.createElement('h3');
  h.textContent = 'Advanced';
  const div = document.createElement('div');
  div.className = 'param';
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.advanced.interlaceDetect;
  cb.addEventListener('change', () => {
    state.advanced.interlaceDetect = cb.checked;
    loadPreset(ui.preset.value).catch(e => status('Shader error: ' + e.message));
  });
  label.append(cb, document.createTextNode(' Interlace detect (crt-royale)'));
  div.append(label);
  ui.advanced.append(h, div);
}

function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let vidHideTimer = null;
function flashVidControls() {
  if (!ui.vid.classList.contains('active')) return;
  ui.vid.classList.add('visible');
  clearTimeout(vidHideTimer);
  vidHideTimer = setTimeout(() => ui.vid.classList.remove('visible'), 2500);
}

function setupVideoControls(video) {
  ui.vid.classList.add('active');
  flashVidControls();
  const syncPlay = () => { ui.vidPlay.textContent = video.paused ? '▶' : '⏸'; };
  const syncMute = () => { ui.vidMute.textContent = (video.muted || video.volume === 0) ? '🔇' : '🔊'; };
  syncPlay(); syncMute();
  ui.vidVol.value = video.muted ? 0 : video.volume;

  ui.vidPlay.onclick = () => { video.paused ? video.play() : video.pause(); };
  video.onplay = syncPlay;
  video.onpause = syncPlay;
  video.ontimeupdate = () => {
    if (video.duration) ui.vidSeek.value = (video.currentTime / video.duration) * 1000;
    ui.vidTime.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  };
  ui.vidSeek.oninput = () => {
    if (video.duration) video.currentTime = (ui.vidSeek.value / 1000) * video.duration;
  };
  ui.vidMute.onclick = () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    ui.vidVol.value = video.muted ? 0 : video.volume;
    syncMute();
  };
  ui.vidVol.oninput = () => {
    video.volume = parseFloat(ui.vidVol.value);
    video.muted = video.volume === 0;
    syncMute();
  };
}

async function onFile(file) {
  if (!file) return;
  if (state.media && state.media.isVideo) {
    state.media.source.pause();
    URL.revokeObjectURL(state.media.source.src);
  }
  if (file.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true; video.loop = true; video.playsInline = true;
    await video.play();
    await new Promise(res => {
      if (video.videoWidth) res();
      else video.addEventListener('loadedmetadata', res, { once: true });
    });
    state.media = { source: video, width: video.videoWidth, height: video.videoHeight, isVideo: true };
    setupVideoControls(video);
  } else {
    const bmp = await createImageBitmap(file);
    state.media = { source: bmp, width: bmp.width, height: bmp.height, isVideo: false };
    ui.vid.classList.remove('active', 'visible');
  }
  if (state.runtime && state.runtime.passes.length) {
    applyFeed();
    applyOutputSize();
    const [fw, fh] = feedSize();
    status(`Rendering ${file.name} (${state.media.width}x${state.media.height} -> ${fw}x${fh})`);
  }
}

function downloadImage() {
  if (!state.runtime || !state.media) {
    status('Upload a photo or video before downloading.');
    return;
  }
  ui.canvas.toBlob((blob) => {
    if (!blob) { status('Download failed: could not export canvas.'); return; }
    const preset = ui.preset.value.replace(/^crt\//, '').replace(/\.glslp$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${preset}-${ui.canvas.width}x${ui.canvas.height}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, 'image/png');
}

const METER_INTERVAL_MS = 200; // how often the fps / frame-time readouts refresh
let fpsFrames = 0;
let fpsLast = performance.now();
let cpuTimeSum = 0;
// Unsmoothed per-frame history for the live sparklines (GPU history lives on the runtime).
const GRAPH_CAP = 180;
const fpsHistory = [];
let lastFrameTs = null;

// Draw a min/max-autoscaled sparkline of `data` into a small canvas, plus a faint
// marker line at `target` (e.g. 60 fps / a budget) so spikes read against a baseline.
function drawSparkline(canvas, data, color, { target } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = Math.round(2 * dpr);
  ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (target != null) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  if (hi - lo < 1e-6) hi = lo + 1; // avoid div0 on a flat line
  const span = hi - lo;
  const y = (v) => h - pad - (v - lo) / span * (h - 2 * pad);
  const n = data.length;
  const x = (i) => (n > 1 ? (i / (n - 1)) * (w - 2 * pad) + pad : pad);
  if (target != null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(pad, y(target));
    ctx.lineTo(w - pad, y(target));
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i), py = y(data[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function frame() {
  if (state.runtime && state.media) {
    // On-demand: video always renders; a static image only when marked dirty.
    const isVideo = state.media.isVideo;
    const shouldRender = isVideo || !onDemandEnabled() || state.needsRender;
    if (shouldRender) {
      const t0 = performance.now();
      try {
        if (isVideo) drawFeed();
        state.runtime.render();
      } catch (e) {
        status('Render error: ' + e.message);
        state.running = false;
        throw e;
      }
      state.needsRender = false;
      // CPU main-thread time to submit the frame (matches DevTools' main track).
      const tEnd = performance.now();
      cpuTimeSum += tEnd - t0;
      fpsFrames++;
      // Unsmoothed instantaneous fps from the frame-to-frame interval.
      if (lastFrameTs != null) {
        const dt = tEnd - lastFrameTs;
        if (dt > 0) {
          fpsHistory.push(1000 / dt);
          if (fpsHistory.length > GRAPH_CAP) fpsHistory.shift();
        }
      }
      lastFrameTs = tEnd;
    } else {
      // Idle: still drain GPU timer queries so the queue never wedges.
      state.runtime.pollGpuQueries();
      lastFrameTs = null; // don't count the idle gap as one slow frame on resume
    }
    const now = performance.now();
    if (now - fpsLast >= METER_INTERVAL_MS) {
      ui.fps.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsLast))} fps`;
      if (fpsFrames > 0) {
        ui.frameTime.textContent = `${(cpuTimeSum / fpsFrames).toFixed(2)} ms`;
        const gpu = state.runtime.lastGpuTimeMs; // async GPU execution time
        ui.gpuTime.textContent = gpu != null ? `gpu ${gpu.toFixed(2)} ms` : '';
      }
      drawSparkline(ui.gpuGraph, state.runtime.gpuTimeHistory, '#c9f');
      drawSparkline(ui.fpsGraph, fpsHistory, '#9f9', { target: 60 });
      fpsFrames = 0;
      cpuTimeSum = 0;
      fpsLast = now;
    }
  }
  if (state.running) requestAnimationFrame(frame);
}

async function init() {
  try {
    state.runtime = new CrtRuntime(ui.canvas);

    const presets = await listPresets();
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.replace(/^crt\//, '').replace(/\.glslp$/, '');
      if (p === 'crt/crt-royale.glslp') opt.selected = true;
      ui.preset.append(opt);
    }

    await loadPreset(ui.preset.value);

    ui.file.addEventListener('change', () => onFile(ui.file.files[0]).catch(e => status('Media error: ' + e.message)));
    ui.preset.addEventListener('change', () => loadPreset(ui.preset.value).catch(e => status('Shader error: ' + e.message)));
    ui.reload.addEventListener('click', () => {
      state.loader.cache.clear();
      state.lutCache.clear();
      state.runtime.clearProgramCache();
      state.crtRoyaleWarmed = false;
      loadPreset(ui.preset.value).catch(e => status('Shader error: ' + e.message));
    });
    ui.resolution.addEventListener('change', applyOutputSize);
    const syncMiniControls = () => {
      ui.miniControls.style.display = ui.miniMode.checked ? '' : 'none';
      ui.refCustom.style.display = ui.refRes.value === 'custom-ref' ? '' : 'none';
      ui.windowCustom.style.display = ui.windowSize.value === 'custom-window' ? '' : 'none';
      ui.regionMarginLabel.style.display = ui.renderMode.value === 'region' ? '' : 'none';
    };
    ui.miniMode.addEventListener('change', () => { syncMiniControls(); applyOutputSize(); });
    ui.refRes.addEventListener('change', () => { syncMiniControls(); applyOutputSize(); });
    ui.refCustom.addEventListener('change', applyOutputSize);
    ui.windowSize.addEventListener('change', () => { syncMiniControls(); applyOutputSize(); });
    ui.windowCustom.addEventListener('change', applyOutputSize);
    ui.winCenterX.addEventListener('input', applyOutputSize);
    ui.winCenterY.addEventListener('input', applyOutputSize);
    ui.renderMode.addEventListener('change', () => { syncMiniControls(); applyOutputSize(); });
    ui.regionMargin.addEventListener('input', applyOutputSize);
    syncMiniControls();
    ui.aspect.addEventListener('change', () => {
      applyOutputSize();
      if (state.media) applyFeed(); // 'auto' fit mode depends on the aspect choice
    });
    ui.fit.addEventListener('change', () => {
      if (state.media) applyFeed();
    });
    const onCropChange = () => {
      ui.cropCustom.style.display = ui.crop.value === 'custom' ? '' : 'none';
      if (state.media) { applyFeed(); applyOutputSize(); }
    };
    ui.crop.addEventListener('change', onCropChange);
    ui.cropCustom.addEventListener('change', onCropChange);
    const onInputChange = () => {
      updateInputCustomBox();
      if (state.media) { applyFeed(); applyOutputSize(); }
    };
    ui.inputWidth.addEventListener('change', onInputChange);
    ui.inputLines.addEventListener('change', onInputChange);
    ui.inputWidthCustom.addEventListener('change', onInputChange);
    ui.inputLinesCustom.addEventListener('change', onInputChange);
    ui.flipY.addEventListener('change', () => {
      if (state.runtime) state.runtime.setFlipY(ui.flipY.checked);
      requestRender();
    });
    ui.onDemand.addEventListener('change', requestRender);
    ui.halation.addEventListener('change', applyParams);
    ui.actualSize.addEventListener('change', applyActualSize);
    window.addEventListener('resize', () => {
      // The viewport-fill window is sized from #view; re-derive it on resize.
      if (miniEnabled() && ui.windowSize.value === 'viewport') applyOutputSize();
      else if (ui.actualSize.checked) applyActualSize();
    });
    ui.resetParams.addEventListener('click', () => {
      resetParamValues();
      buildParamUI();
      applyParams();
    });
    ui.download.addEventListener('click', downloadImage);

    // Fullscreen: hide all controls, show just the canvas. A "Show controls"
    // button appears on pointer activity and fades after a few seconds idle.
    let hideTimer = null;
    const flashControls = () => {
      ui.showControls.classList.add('visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => ui.showControls.classList.remove('visible'), 2500);
    };
    const enterFs = () => {
      document.body.classList.add('fs');
      if (ui.actualSize.checked) applyActualSize();
      flashControls();
    };
    const exitFs = () => {
      document.body.classList.remove('fs');
      clearTimeout(hideTimer);
      if (ui.actualSize.checked) applyActualSize();
    };
    ui.fullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
      // Toggle the controls-hidden layout regardless of native fullscreen support.
      if (document.body.classList.contains('fs')) exitFs(); else enterFs();
    });
    ui.showControls.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      exitFs();
    });
    ui.view.addEventListener('mousemove', () => {
      if (document.body.classList.contains('fs')) flashControls();
      flashVidControls();
    });
    // Keep transport controls visible while the pointer is over them.
    ui.vid.addEventListener('mouseenter', () => {
      ui.vid.classList.add('visible');
      clearTimeout(vidHideTimer);
    });
    ui.vid.addEventListener('mouseleave', flashVidControls);
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && document.body.classList.contains('fs')) exitFs();
    });

    state.running = true;
    requestAnimationFrame(frame);
  } catch (e) {
    status('Error: ' + e.message);
    console.error(e);
  }
}

init();

// debug handle for tooling/tests
window.__crt = state;
