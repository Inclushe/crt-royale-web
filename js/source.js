// Loading and preprocessing of libretro .slang shader sources:
//  - recursive #include resolution (URL-relative, like RetroArch does on disk)
//  - extraction of #pragma parameter / name / format metadata
//  - splitting the single-file source into vertex and fragment stages
// The shader code itself is never modified; this implements the slang-shader
// *container format* (https://github.com/libretro/slang-shaders#slang-shader-format).

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

  // Returns the source with all #include directives recursively inlined.
  async loadWithIncludes(url, stack = []) {
    if (stack.includes(url)) {
      throw new Error(`Circular #include: ${[...stack, url].join(' -> ')}`);
    }
    const text = await this.load(url);
    const out = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*#include\s+"([^"]+)"/);
      if (m) {
        const sub = await this.loadWithIncludes(resolveUrl(url, m[1]), [...stack, url]);
        out.push(sub);
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }
}

// Parses pragmas and splits stages from a fully include-resolved source.
// Returns { vertex, fragment, parameters, name, format }
export function processShaderSource(source) {
  const parameters = [];
  let name = null;
  let format = null;

  const common = [];
  const vertex = [];
  const fragment = [];
  let target = 'common';

  for (const line of source.split('\n')) {
    const pragma = line.match(/^\s*#pragma\s+(\w+)\s*(.*)$/);
    if (pragma) {
      const [, kind, rest] = pragma;
      if (kind === 'stage') {
        const stage = rest.trim();
        if (stage !== 'vertex' && stage !== 'fragment') {
          throw new Error(`Unknown #pragma stage: ${stage}`);
        }
        target = stage;
        continue;
      }
      if (kind === 'name') { name = rest.trim(); continue; }
      if (kind === 'format') { format = rest.trim(); continue; }
      if (kind === 'parameter') {
        // #pragma parameter ident "Description" default min max [step]
        const m = rest.match(/^(\w+)\s+"([^"]*)"\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/);
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
        continue;
      }
      // other pragmas fall through verbatim
    }
    if (target === 'common') common.push(line);
    else if (target === 'vertex') vertex.push(line);
    else fragment.push(line);
  }

  const commonStr = common.join('\n');
  return {
    vertex: commonStr + '\n' + vertex.join('\n'),
    fragment: commonStr + '\n' + fragment.join('\n'),
    parameters,
    name,
    format,
  };
}
