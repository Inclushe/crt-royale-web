// GLSL (Vulkan dialect, libretro flavor) -> WGSL compilation using the Slang
// compiler's WebAssembly build (the same toolchain as shader-slang/slang-playground),
// built with GLSL compatibility mode enabled.

const SLANG_STAGE_VERTEX = 1;
const SLANG_STAGE_FRAGMENT = 5;

export class SlangCompiler {
  constructor(module) {
    this.m = module;
    this.globalSession = module.createGlobalSession();
    if (!this.globalSession) {
      throw new Error('Failed to create Slang global session: ' + this.lastError());
    }
    this.targetWGSL = null;
    for (const t of module.getCompileTargets()) {
      if (t.name === 'WGSL') this.targetWGSL = t.value;
    }
    if (this.targetWGSL === null) throw new Error('slang-wasm build lacks WGSL target');
  }

  lastError() {
    try {
      const e = this.m.getLastError();
      return e ? `${e.type}: ${e.message}` : 'unknown error';
    } catch {
      return 'unknown error';
    }
  }

  // Compiles one libretro shader pass (already include-resolved and stage-split).
  // Returns { wgsl, reflection } where reflection is Slang's layout JSON.
  compilePass(vertexGLSL, fragmentGLSL, passName = 'pass') {
    const session = this.globalSession.createSession(this.targetWGSL);
    if (!session) throw new Error('createSession failed: ' + this.lastError());

    const handles = [];
    try {
      const load = (src, name, stage) => {
        // The ".glsl" path suffix routes the module through Slang's GLSL
        // compatibility front end, so the shader source needs no edits.
        const mod = session.loadModuleFromSource(src, name, `/${name}.glsl`);
        if (!mod) throw new Error(`${passName}/${name}: ` + this.lastError());
        handles.push(mod);
        const ep = mod.findAndCheckEntryPoint('main', stage);
        if (!ep) throw new Error(`${passName}/${name}: entry point: ` + this.lastError());
        handles.push(ep);
        return [mod, ep];
      };

      const [vmod, vep] = load(vertexGLSL, `${passName}_vs`, SLANG_STAGE_VERTEX);
      const [fmod, fep] = load(fragmentGLSL, `${passName}_fs`, SLANG_STAGE_FRAGMENT);

      const composite = session.createCompositeComponentType([vmod, vep, fmod, fep]);
      if (!composite) throw new Error(`${passName}: composite: ` + this.lastError());
      handles.push(composite);

      const linked = composite.link();
      if (!linked) throw new Error(`${passName}: link: ` + this.lastError());
      handles.push(linked);

      let wgsl = linked.getTargetCode(0);
      if (!wgsl) throw new Error(`${passName}: codegen: ` + this.lastError());
      wgsl = postprocessWgsl(wgsl);

      const layout = linked.getLayout(0);
      const reflection = layout ? layout.toJsonObject() : null;

      return { wgsl, reflection };
    } finally {
      for (const h of handles.reverse()) {
        try { h.delete(); } catch { /* embind handle already gone */ }
      }
      try { session.delete(); } catch { /* ignore */ }
    }
  }
}

// Post-processing of Slang's *generated* WGSL (never the shader sources):
//  1. Vertex and fragment GLSL entry points are both called "main"; Slang keeps
//     the names, but WGSL forbids two functions with the same name.
//  2. GLSL combined sampler2Ds are split into texture+sampler; the two halves
//     (or unrelated resources) can land on the same @group/@binding slot,
//     which WebGPU rejects. Reassign collisions to free slots.
export function postprocessWgsl(wgsl) {
  // -- unique entry point names --
  const eps = [...wgsl.matchAll(/@(vertex|fragment)\s+fn\s+(\w+)\s*\(/g)];
  const seen = new Map();
  // process from the end so match indices stay valid while splicing
  for (const m of eps.reverse()) {
    const stage = m[1], name = m[2];
    for (const other of eps) {
      if (other !== m && other[2] === name) {
        const newName = `${name}_${stage}`;
        const defStart = m.index;
        const def = m[0].replace(new RegExp(`fn\\s+${name}\\b`), `fn ${newName}`);
        wgsl = wgsl.slice(0, defStart) + def + wgsl.slice(defStart + m[0].length);
        break;
      }
    }
    seen.set(stage, true);
  }

  // -- de-duplicate binding slots --
  const declRe = /@binding\((\d+)\)\s*@group\((\d+)\)|@group\((\d+)\)\s*@binding\((\d+)\)/g;
  const used = new Map(); // group -> Set(binding)
  let result = '';
  let last = 0;
  let m2;
  while ((m2 = declRe.exec(wgsl))) {
    const group = +(m2[2] ?? m2[3]);
    let binding = +(m2[1] ?? m2[4]);
    if (!used.has(group)) used.set(group, new Set());
    const set = used.get(group);
    if (set.has(binding)) {
      let free = 0;
      while (set.has(free)) free++;
      binding = free;
    }
    set.add(binding);
    result += wgsl.slice(last, m2.index) + `@group(${group}) @binding(${binding})`;
    last = m2.index + m2[0].length;
  }
  result += wgsl.slice(last);
  return result;
}

// Loads the slang-wasm emscripten module. `wasmBinary` may be supplied for
// environments where the .wasm is shipped gzipped next to the JS glue.
export async function createSlangModule(createModuleFn, wasmBinary) {
  const opts = {};
  if (wasmBinary) opts.wasmBinary = wasmBinary;
  return createModuleFn(opts);
}
