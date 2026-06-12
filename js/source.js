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
export function buildStageSource(source, stage /* 'VERTEX' | 'FRAGMENT' */) {
  const lines = source.split('\n');
  const versionIdx = lines.findIndex(l => l.trim().startsWith('#version'));
  const hasVersion = versionIdx >= 0;
  if (hasVersion) lines.splice(versionIdx, 1);

  const flattened = flattenConditionals(lines.join('\n'), {
    [stage]: 1,
    PARAMETER_UNIFORM: 1,
    GL_ES: 1,
    GL_FRAGMENT_PRECISION_HIGH: 1,
    __VERSION__: hasVersion ? 300 : 100,
  });

  const hoisted = applyEsCompatShims(hoistGlobalInitializers(flattened));

  const header = [];
  if (hasVersion) header.push('#version 300 es');
  if (stage === 'FRAGMENT') header.push('precision highp float;', 'precision highp int;');

  const body = hoisted
    .split('\n')
    .filter(l => !/^\s*#pragma\s+parameter\b/.test(l));

  return [...header, ...body].join('\n');
}
