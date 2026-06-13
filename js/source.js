// Loading and preparation of libretro .glsl shaders (libretro/glsl-shaders).
// Each .glsl file contains both stages behind #if defined(VERTEX) /
// defined(FRAGMENT); the runtime selects a stage by defining one of them —
// that is the format's contract (RetroArch does the same). On top of that,
// two strictness fixes for GLSL ES are applied mechanically to every shader
// (see js/flatten.js); the shader logic itself is never edited.

import { flattenConditionals, hoistGlobalInitializers, applyEsCompatShims } from './flatten.js';

export function resolveUrl(base, rel) {
  return new URL(rel, base).href;
}

export class SourceLoader {
  constructor(fetchText) {
    this.fetchText = fetchText; // async (url) => string
    this.cache = new Map();
  }

  async load(url) {
    if (!this.cache.has(url)) {
      this.cache.set(url, this.fetchText(url));
    }
    return this.cache.get(url);
  }
}

// #pragma parameter ident "Description" default min max [step]
export function parseParameterPragmas(source) {
  const parameters = [];
  for (const line of source.split('\n')) {
    const m = line.match(/^\s*#pragma\s+parameter\s+(\w+)\s+"([^"]*)"\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/);
    if (m) {
      parameters.push({
        name: m[1],
        description: m[2],
        initial: parseFloat(m[3]),
        min: parseFloat(m[4]),
        max: parseFloat(m[5]),
        step: m[6] !== undefined ? parseFloat(m[6]) : 0.0,
      });
    }
  }
  return parameters;
}

// Builds the GLSL ES source for one stage, targeting WebGL2.
// `es3compat` compiles a legacy (no #version) ESSL 1.00 shader as ES 3.00
// behind a small keyword-mapping prelude; used when ESSL 1.00 restrictions
// (non-constant loop bounds, derivatives, ...) reject the shader.
export function buildStageSource(source, stage /* 'VERTEX' | 'FRAGMENT' */, { es3compat = false } = {}) {
  const lines = source.split('\n');
  const versionIdx = lines.findIndex(l => l.trim().startsWith('#version'));
  const hasVersion = versionIdx >= 0;
  if (hasVersion) lines.splice(versionIdx, 1);

  // derivatives don't exist in WebGL2's ESSL 1.00; force the ES3 path
  if (!hasVersion && /\b(fwidth|dFdx|dFdy)\s*\(/.test(source)) es3compat = true;
  const asEs3 = hasVersion || es3compat;

  // The WebGL2 preprocessor has no `##` token pasting. Some shaders use it only
  // inside a `#ifdef GL_ES` branch as a hand-unrolled alternative to an
  // equivalent array/loop path guarded by the non-GL_ES branch (valid ES 3.00).
  // Compiling with GL_ES undefined selects that path and avoids `##` entirely.
  const avoidGlEs = asEs3 && /##/.test(source);

  const flattened = flattenConditionals(lines.join('\n'), {
    [stage]: 1,
    PARAMETER_UNIFORM: 1,
    ...(avoidGlEs ? {} : { GL_ES: 1 }),
    GL_FRAGMENT_PRECISION_HIGH: 1,
    __VERSION__: asEs3 ? 300 : 100,
  });

  const hoisted = applyEsCompatShims(hoistGlobalInitializers(flattened));

  const header = [];
  if (asEs3) header.push('#version 300 es');
  if (!hasVersion && es3compat) {
    // ESSL1 -> ESSL3 keyword mapping, only for what the shader actually uses
    // (shaders with their own __VERSION__ >= 130 branches need none of it)
    if (/\battribute\b/.test(hoisted)) header.push('#define attribute in');
    if (/\bvarying\b/.test(hoisted)) {
      header.push(stage === 'VERTEX' ? '#define varying out' : '#define varying in');
    }
    if (/\btexture2D\s*\(/.test(hoisted)) header.push('#define texture2D texture');
    if (/\btexture2DLod\s*\(/.test(hoisted)) header.push('#define texture2DLod textureLod');
    const code = hoisted.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (stage === 'FRAGMENT' && /\bgl_FragColor\b/.test(code)) {
      const ownOut = code.match(/\bout\s+(?:highp\s+|mediump\s+|lowp\s+|COMPAT_PRECISION\s+)?vec4\s+(\w*FragColor)\b/);
      if (ownOut) {
        // hybrid shader: declares its own output but still writes gl_FragColor
        header.push(`#define gl_FragColor ${ownOut[1]}`);
      } else {
        header.push('out highp vec4 _crt_FragColor;', '#define gl_FragColor _crt_FragColor');
      }
    }
  }
  if (stage === 'FRAGMENT') header.push('precision highp float;', 'precision highp int;');

  const body = hoisted
    .split('\n')
    .filter(l => !/^\s*#pragma\s+parameter\b/.test(l))
    // Same-name uniforms must agree in precision across stages; the COMPAT
    // boilerplate often gives them different default precisions per stage.
    // floats -> highp; ints -> mediump (highp int fragment support is not
    // guaranteed in ESSL 1.00).
    .map(l => l
      .replace(
        /^(\s*uniform\s+)(?:COMPAT_PRECISION\s+|lowp\s+|mediump\s+|highp\s+)?((?:float|vec[234]|mat[234])\b)/,
        '$1highp $2')
      .replace(
        /^(\s*uniform\s+)(?:COMPAT_PRECISION\s+|lowp\s+|mediump\s+|highp\s+)?((?:int|ivec[234])\b)/,
        '$1mediump $2'));

  return [...header, ...body].join('\n');
}
