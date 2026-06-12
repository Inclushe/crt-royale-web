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

      const wgsl = linked.getTargetCode(0);
      if (!wgsl) throw new Error(`${passName}: codegen: ` + this.lastError());

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

// Loads the slang-wasm emscripten module. `wasmBinary` may be supplied for
// environments where the .wasm is shipped gzipped next to the JS glue.
export async function createSlangModule(createModuleFn, wasmBinary) {
  const opts = {};
  if (wasmBinary) opts.wasmBinary = wasmBinary;
  return createModuleFn(opts);
}
