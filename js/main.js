// Glue: fetch shader presets from the libretro/glsl-shaders GitHub repo and
// render uploaded photos/videos through them with WebGL2.
// Everything runs locally in the browser; uploaded media never leaves the page.

import { parsePreset } from './slangp.js';
import { SourceLoader, buildStageSource, parseParameterPragmas, resolveUrl } from './source.js';
import { CrtRuntime } from './runtime.js';

const RAW_BASE = 'https://raw.githubusercontent.com/libretro/glsl-shaders/master/';
const API_LIST = 'https://api.github.com/repos/libretro/glsl-shaders/contents/crt';
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

const ui = {
  status: document.getElementById('status'),
  file: document.getElementById('file'),
  preset: document.getElementById('preset'),
  resolution: document.getElementById('resolution'),
  inputRes: document.getElementById('inputRes'),
  inputCustom: document.getElementById('inputCustom'),
  fit: document.getElementById('fit'),
  aspect: document.getElementById('aspect'),
  reload: document.getElementById('reload'),
  resetParams: document.getElementById('resetParams'),
  flipY: document.getElementById('flipY'),
  actualSize: document.getElementById('actualSize'),
  download: document.getElementById('download'),
  view: document.getElementById('view'),
  paramList: document.getElementById('paramList'),
  canvas: document.getElementById('canvas'),
  fps: document.getElementById('fps'),
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
    const r = await fetch(API_LIST);
    if (!r.ok) throw new Error('rate limited');
    const entries = await r.json();
    const presets = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.glslp'))
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
};

let loadGeneration = 0;

async function loadPreset(presetPath) {
  const gen = ++loadGeneration;
  const stale = () => gen !== loadGeneration;
  const presetUrl = RAW_BASE + presetPath;
  status(`Fetching preset ${presetPath}…`);
  const preset = parsePreset(await fetchText(presetUrl));

  const compiledPasses = [];
  const allParams = new Map();
  for (const pass of preset.passes) {
    const shaderUrl = resolveUrl(presetUrl, pass.path);
    status(`Preparing pass ${pass.index + 1}/${preset.passes.length}: ${pass.path.split('/').pop()}…`);
    const src = await state.loader.load(shaderUrl);
    for (const p of parseParameterPragmas(src)) {
      if (!allParams.has(p.name)) allParams.set(p.name, p);
    }
    compiledPasses.push({
      meta: pass,
      rawSrc: src,
      vertexSrc: buildStageSource(src, 'VERTEX'),
      fragmentSrc: buildStageSource(src, 'FRAGMENT'),
    });
  }

  status('Fetching LUT textures…');
  const lutBitmaps = new Map();
  for (const t of preset.textures) {
    if (!t.path) continue;
    const url = resolveUrl(presetUrl, t.path);
    const blob = await (await fetch(url)).blob();
    lutBitmaps.set(t.name, await createImageBitmap(blob, { imageOrientation: 'flipY' }));
  }

  if (stale()) return;
  state.parameters = [...allParams.values()];
  state.presetOverrides = preset.parameterOverrides;
  resetParamValues();
  buildParamUI();

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
  state.runtime.setParams(state.paramValues);
  if (state.media) applyFeed();
  applyActualSize();
  status(`Ready: ${presetPath} (${preset.passes.length} pass${preset.passes.length > 1 ? 'es' : ''}). ${state.media ? '' : 'Upload a photo or video to start.'}`);
}

function feedSize() {
  const v = ui.inputRes.value;
  const native = state.media ? [state.media.width, state.media.height] : [320, 240];
  const byFactor = (f) => (f > 0
    ? [Math.max(1, Math.round(native[0] / f)), Math.max(1, Math.round(native[1] / f))]
    : native);
  if (v === 'native' || !state.media) return native;
  if (v.startsWith('/')) return byFactor(parseFloat(v.slice(1)));
  if (v === 'custom-scale') return byFactor(parseFloat(ui.inputCustom.value));
  if (v === 'custom-res') {
    const m = ui.inputCustom.value.match(/^\s*(\d+)\s*[xX*,]\s*(\d+)\s*$/);
    return m ? [Math.max(1, +m[1]), Math.max(1, +m[2])] : native;
  }
  const [w, h] = v.split('x').map(Number);
  return [w, h];
}

function updateInputCustomBox() {
  const v = ui.inputRes.value;
  const custom = v === 'custom-scale' || v === 'custom-res';
  ui.inputCustom.style.display = custom ? '' : 'none';
  if (custom) {
    ui.inputCustom.placeholder = v === 'custom-scale' ? 'e.g. 2.5' : 'e.g. 320x240';
    ui.inputCustom.focus();
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
  const isPresetRes = /^\d+x\d+$/.test(ui.inputRes.value);
  return (isPresetRes && ui.aspect.value === 'source') ? 'fit' : 'stretch';
}

function drawFeed() {
  if (!state.media) return;
  const ctx = state.feed.getContext('2d');
  if (state.media.isVideo && state.media.source.readyState < 2) return;
  const fw = state.feed.width, fh = state.feed.height;
  const mw = state.media.width, mh = state.media.height;
  if (fitMode() === 'fit' && Math.abs(fw / fh - mw / mh) > 0.01) {
    const scale = Math.min(fw / mw, fh / mh);
    const dw = Math.max(1, Math.round(mw * scale));
    const dh = Math.max(1, Math.round(mh * scale));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, fw, fh);
    ctx.drawImage(state.media.source, Math.floor((fw - dw) / 2), Math.floor((fh - dh) / 2), dw, dh);
  } else {
    ctx.drawImage(state.media.source, 0, 0, fw, fh);
  }
}

// (Re)size the feed canvas and hand it to the runtime as the input frame.
function applyFeed() {
  const [w, h] = feedSize();
  state.feed.width = w;
  state.feed.height = h;
  drawFeed();
  state.runtime.setOriginal(state.feed, w, h, state.media.isVideo);
}

function outputSize() {
  return ui.resolution.value.split('x').map(Number);
}

function contentAspect() {
  const a = ui.aspect.value;
  if (a === 'source') return null; // runtime matches the input's ratio
  const [an, ad] = a.split(':').map(Number);
  return an / ad;
}

function applyOutputSize() {
  const [w, h] = outputSize();
  if (state.runtime) state.runtime.setViewport(w, h, contentAspect());
  applyActualSize();
}

// 1 canvas pixel == 1 device pixel (accounts for devicePixelRatio); overflow
// scrolls and starts centered.
function applyActualSize() {
  if (ui.actualSize.checked) {
    ui.view.classList.add('actual');
    const dpr = window.devicePixelRatio || 1;
    ui.canvas.style.width = (ui.canvas.width / dpr) + 'px';
    ui.canvas.style.height = (ui.canvas.height / dpr) + 'px';
    const center = (tries) => {
      const tx = Math.max(0, (ui.view.scrollWidth - ui.view.clientWidth) / 2);
      const ty = Math.max(0, (ui.view.scrollHeight - ui.view.clientHeight) / 2);
      ui.view.scrollLeft = tx;
      ui.view.scrollTop = ty;
      if (tries > 0 && (Math.abs(ui.view.scrollLeft - tx) > 1 || Math.abs(ui.view.scrollTop - ty) > 1)) {
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

function resetParamValues() {
  state.paramValues = {};
  for (const p of state.parameters) {
    state.paramValues[p.name] = (p.name in state.presetOverrides)
      ? state.presetOverrides[p.name] : p.initial;
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
    range.addEventListener('input', () => {
      state.paramValues[p.name] = parseFloat(range.value);
      val.textContent = fmt(range.value);
      if (state.runtime) state.runtime.setParams(state.paramValues);
    });
    div.append(label, range, val);
    ui.paramList.append(div);
  }
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
  } else {
    const bmp = await createImageBitmap(file);
    state.media = { source: bmp, width: bmp.width, height: bmp.height, isVideo: false };
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

let fpsFrames = 0;
let fpsLast = performance.now();

function frame() {
  if (state.runtime && state.media) {
    try {
      if (state.media.isVideo) drawFeed();
      state.runtime.render();
    } catch (e) {
      status('Render error: ' + e.message);
      state.running = false;
      throw e;
    }
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 500) {
      ui.fps.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsLast))} fps`;
      fpsFrames = 0;
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
      loadPreset(ui.preset.value).catch(e => status('Shader error: ' + e.message));
    });
    ui.resolution.addEventListener('change', applyOutputSize);
    ui.aspect.addEventListener('change', () => {
      applyOutputSize();
      if (state.media) applyFeed(); // 'auto' fit mode depends on the aspect choice
    });
    ui.fit.addEventListener('change', () => {
      if (state.media) applyFeed();
    });
    ui.inputRes.addEventListener('change', () => {
      updateInputCustomBox();
      if (state.media) { applyFeed(); applyOutputSize(); }
    });
    ui.inputCustom.addEventListener('change', () => {
      if (state.media) { applyFeed(); applyOutputSize(); }
    });
    ui.flipY.addEventListener('change', () => {
      if (state.runtime) state.runtime.setFlipY(ui.flipY.checked);
    });
    ui.actualSize.addEventListener('change', applyActualSize);
    window.addEventListener('resize', () => {
      if (ui.actualSize.checked) applyActualSize();
    });
    ui.resetParams.addEventListener('click', () => {
      resetParamValues();
      buildParamUI();
      if (state.runtime) state.runtime.setParams(state.paramValues);
    });
    ui.download.addEventListener('click', downloadImage);

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
