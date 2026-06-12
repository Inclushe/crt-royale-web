// Parser for libretro .slangp shader preset files.
// Spec: https://github.com/libretro/slang-shaders#preset-format

function stripComment(line) {
  // '#' starts a comment unless it is the first char of a directive we care about
  const idx = line.indexOf('#');
  if (idx === -1) return line;
  return line.slice(0, idx);
}

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function toBool(v) {
  return v === 'true' || v === '1';
}

// Returns { passes, textures, parameterOverrides }
export function parsePreset(text) {
  const kv = new Map();
  for (let rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));
    if (key) kv.set(key, value);
  }

  const get = (k, dflt = undefined) => (kv.has(k) ? kv.get(k) : dflt);
  const numShaders = parseInt(get('shaders', '0'), 10);
  if (!numShaders) throw new Error('Preset declares no shader passes');

  const passes = [];
  const structuralKeys = new Set(['shaders', 'textures', 'parameters']);

  for (let i = 0; i < numShaders; i++) {
    const path = get(`shader${i}`);
    if (!path) throw new Error(`Missing shader${i} in preset`);

    const scaleType = get(`scale_type${i}`);
    const scaleTypeX = get(`scale_type_x${i}`, scaleType);
    const scaleTypeY = get(`scale_type_y${i}`, scaleType);
    const scale = get(`scale${i}`);
    const scaleX = parseFloat(get(`scale_x${i}`, scale ?? '1.0'));
    const scaleY = parseFloat(get(`scale_y${i}`, scale ?? '1.0'));

    passes.push({
      index: i,
      path,
      alias: get(`alias${i}`, null),
      filterLinear: toBool(get(`filter_linear${i}`, 'false')),
      wrapMode: get(`wrap_mode${i}`, 'clamp_to_border'),
      scaleTypeX: scaleTypeX ?? null, // null => default (source 1.0, or viewport for last pass)
      scaleTypeY: scaleTypeY ?? null,
      scaleX,
      scaleY,
      srgbFramebuffer: toBool(get(`srgb_framebuffer${i}`, 'false')),
      floatFramebuffer: toBool(get(`float_framebuffer${i}`, 'false')),
      mipmapInput: toBool(get(`mipmap_input${i}`, 'false')),
      frameCountMod: parseInt(get(`frame_count_mod${i}`, '0'), 10),
    });
    for (const k of [
      `shader${i}`, `alias${i}`, `filter_linear${i}`, `wrap_mode${i}`,
      `scale_type${i}`, `scale_type_x${i}`, `scale_type_y${i}`,
      `scale${i}`, `scale_x${i}`, `scale_y${i}`,
      `srgb_framebuffer${i}`, `float_framebuffer${i}`, `mipmap_input${i}`,
      `frame_count_mod${i}`,
    ]) structuralKeys.add(k);
  }

  const textures = [];
  const texturesList = get('textures', '');
  for (const name of texturesList.split(';').map(s => s.trim()).filter(Boolean)) {
    textures.push({
      name,
      path: get(name),
      linear: toBool(get(`${name}_linear`, 'false')),
      wrapMode: get(`${name}_wrap_mode`, 'clamp_to_border'),
      mipmap: toBool(get(`${name}_mipmap`, 'false')),
    });
    for (const k of [name, `${name}_linear`, `${name}_wrap_mode`, `${name}_mipmap`]) {
      structuralKeys.add(k);
    }
  }

  // Anything left that parses as a number is treated as a shader parameter override.
  const parameterOverrides = {};
  for (const [k, v] of kv) {
    if (structuralKeys.has(k)) continue;
    const f = parseFloat(v);
    if (!Number.isNaN(f)) parameterOverrides[k] = f;
  }

  return { passes, textures, parameterOverrides };
}
