// Glue: fetch shaders from the libretro/slang-shaders GitHub repo, compile them
// client-side with the Slang compiler (WASM), and render uploads with WebGPU.
// Everything runs locally in the browser; uploaded media never leaves the page.

import { parsePreset } from './slangp.js';
import { SourceLoader, processShaderSource, resolveUrl } from './source.js';
import { SlangCompiler } from './compile.js';
import { CrtRuntime } from './runtime.js';

const RAW_BASE = 'https://raw.githubusercontent.com/libretro/slang-shaders/master/';
const API_LIST = 'https://api.github.com/repos/libretro/slang-shaders/contents/crt';
const DEFAULT_PRESETS = [
  'crt/crt-royale.slangp',
  'crt/crt-royale-intel.slangp',
  'crt/crt-royale-fake-bloom.slangp',
  'crt/crt-geom.slangp',
  'crt/crt-easymode.slangp',
  'crt/crt-aperture.slangp',
  'crt/crt-lottes.slangp',
  'crt/fakelottes.slangp',
  'crt/zfast-crt.slangp',
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

async function loadSlangModule() {
  status('Loading Slang compiler (WASM)…');
  const createModule = (await import('../vendor/slang-wasm.js')).default;
  const resp = await fetch(new URL('../vendor/slang-wasm.wasm.gz', import.meta.url));
  if (!resp.ok) throw new Error('Failed to fetch slang-wasm.wasm.gz');
  const ds = new DecompressionStream('gzip');
  const wasmBinary = await new Response(resp.body.pipeThrough(ds)).arrayBuffer();
  return createModule({ wasmBinary });
}

async function listPresets() {
  try {
    const r = await fetch(API_LIST);
    if (!r.ok) throw new Error('rate limited');
    const entries = await r.json();
    const presets = entries
      .filter(e => e.type === 'file' && e.name.endsWith('.slangp'))
      .map(e => `crt/${e.name}`);
    return presets.length ? presets : DEFAULT_PRESETS;
  } catch {
    return DEFAULT_PRESETS;
  }
}

const state = {
  compiler: null,
  runtime: null,
  loader: new SourceLoader(fetchText),
  parameters: [],       // merged #pragma parameter definitions
  paramValues: {},
  presetOverrides: {},
  media: null,          // { source, width, height, isVideo }
  running: false,
};

async function compilePreset(presetPath) {
  const presetUrl = RAW_BASE + presetPath;
  status(`Fetching preset ${presetPath}…`);
  const preset = parsePreset(await fetchText(presetUrl));

  const compiledPasses = [];
  const allParams = new Map();
  for (const pass of preset.passes) {
    const shaderUrl = resolveUrl(presetUrl, pass.path);
    status(`Compiling pass ${pass.index + 1}/${preset.passes.length}: ${pass.path.split('/').pop()}…`);
    const src = await state.loader.loadWithIncludes(shaderUrl);
    const stages = processShaderSource(src);
    const { wgsl, reflection } = state.compiler.compilePass(
      stages.vertex, stages.fragment, `p${pass.index}`);
    for (const p of stages.parameters) if (!allParams.has(p.name)) allParams.set(p.name, p);
    compiledPasses.push({ pass, wgsl, reflection, pragmaFormat: stages.format, parameters: stages.parameters });
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
  ui.canvas.width = w; ui.canvas.height = h;
  await state.runtime.build(compiledPasses, preset.textures, lutBitmaps, { width: w, height: h });
  state.runtime.setParams(state.paramValues);
  if (state.media) {
    state.runtime.setOriginal(state.media.source, state.media.width, state.media.height, state.media.isVideo);
  }
  status(`Ready: ${presetPath} (${preset.passes.length} passes). ${state.media ? '' : 'Upload a photo or video to start.'}`);
}

function resetParamValues() {
  state.paramValues = {};
  for (const p of state.parameters) {
    state.paramValues[p.name] = (p.name in state.presetOverrides)
      ? state.presetOverrides[p.name] : p.initial;
  }
}

function buildParamUI() {
  ui.paramList.innerHTML = '';
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
    val.textContent = (+range.value).toFixed(4).replace(/\.?0+$/, '') || '0';
    range.addEventListener('input', () => {
      state.paramValues[p.name] = parseFloat(range.value);
      val.textContent = (+range.value).toFixed(4).replace(/\.?0+$/, '') || '0';
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
    if (!navigator.gpu) {
      status('This demo needs WebGPU (Chrome/Edge 113+, Safari 18+, Firefox 141+).');
      return;
    }
    const presets = await listPresets();
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.replace(/^crt\//, '').replace(/\.slangp$/, '');
      if (p === 'crt/crt-royale.slangp') opt.selected = true;
      ui.preset.append(opt);
    }

    state.runtime = await CrtRuntime.create(ui.canvas);
    const module = await loadSlangModule();
    status('Creating Slang session (compiles GLSL builtin module, one-time)…');
    await new Promise(r => setTimeout(r)); // let status paint before the long sync call
    state.compiler = new SlangCompiler(module);

    await compilePreset(ui.preset.value);

    ui.file.addEventListener('change', () => onFile(ui.file.files[0]).catch(e => status('Media error: ' + e.message)));
    ui.preset.addEventListener('change', () => compilePreset(ui.preset.value).catch(e => status('Compile error: ' + e.message)));
    ui.reload.addEventListener('click', () => compilePreset(ui.preset.value).catch(e => status('Compile error: ' + e.message)));
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
