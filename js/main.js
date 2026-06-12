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
  reload: document.getElementById('reload'),
  resetParams: document.getElementById('resetParams'),
  flipY: document.getElementById('flipY'),
  paramList: document.getElementById('paramList'),
  canvas: document.getElementById('canvas'),
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
  loader: new SourceLoader(fetchText),
  parameters: [],
  paramValues: {},
  presetOverrides: {},
  media: null, // { source, width, height, isVideo }
  running: false,
};

async function loadPreset(presetPath) {
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
    lutBitmaps.set(t.name, await createImageBitmap(blob));
  }

  state.parameters = [...allParams.values()];
  state.presetOverrides = preset.parameterOverrides;
  resetParamValues();
  buildParamUI();

  const [w, h] = ui.resolution.value.split('x').map(Number);
  ui.canvas.width = w;
  ui.canvas.height = h;
  state.runtime.viewport = { width: w, height: h };
  status('Compiling shaders (WebGL)…');
  await new Promise(r => setTimeout(r)); // let the status paint
  state.runtime.build(compiledPasses, preset.textures, lutBitmaps, { width: w, height: h });
  state.runtime.setParams(state.paramValues);
  if (state.media) {
    state.runtime.setOriginal(state.media.source, state.media.width, state.media.height, state.media.isVideo);
  }
  status(`Ready: ${presetPath} (${preset.passes.length} pass${preset.passes.length > 1 ? 'es' : ''}). ${state.media ? '' : 'Upload a photo or video to start.'}`);
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
    state.runtime.setOriginal(state.media.source, state.media.width, state.media.height, state.media.isVideo);
    status(`Rendering ${file.name} (${state.media.width}x${state.media.height})`);
  }
}

function frame() {
  if (state.runtime && state.media) {
    try {
      state.runtime.render();
    } catch (e) {
      status('Render error: ' + e.message);
      state.running = false;
      throw e;
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
    ui.resolution.addEventListener('change', () => {
      const [w, h] = ui.resolution.value.split('x').map(Number);
      if (state.runtime) state.runtime.setViewport(w, h);
    });
    ui.flipY.addEventListener('change', () => {
      if (state.runtime) state.runtime.setFlipY(ui.flipY.checked);
    });
    ui.resetParams.addEventListener('click', () => {
      resetParamValues();
      buildParamUI();
      if (state.runtime) state.runtime.setParams(state.paramValues);
    });

    state.running = true;
    requestAnimationFrame(frame);
  } catch (e) {
    status('Error: ' + e.message);
    console.error(e);
  }
}

init();
