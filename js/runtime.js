// WebGPU runtime for libretro slang shader presets compiled to WGSL.
// Implements the multi-pass semantics of .slangp presets: pass scaling,
// sRGB/float framebuffers, alias/PassOutput/LUT texture bindings, per-pass
// samplers, mipmapped inputs and the builtin uniform semantics
// (MVP, SourceSize, OriginalSize, OutputSize, FrameCount, parameters, ...).

const WRAP_MODE = {
  clamp_to_border: 'clamp-to-edge', // WebGPU has no border addressing
  clamp_to_edge: 'clamp-to-edge',
  repeat: 'repeat',
  mirrored_repeat: 'mirror-repeat',
};

const PRAGMA_FORMAT = {
  R8G8B8A8_UNORM: 'rgba8unorm',
  R8G8B8A8_SRGB: 'rgba8unorm-srgb',
  A2B10G10R10_UNORM_PACK32: 'rgb10a2unorm',
  R16G16B16A16_SFLOAT: 'rgba16float',
  R32G32B32A32_SFLOAT: 'rgba16float', // float32 is not filterable without a feature
};

function passFormat(pass, pragmaFormat) {
  if (pass.srgbFramebuffer) return 'rgba8unorm-srgb';
  if (pass.floatFramebuffer) return 'rgba16float';
  if (pragmaFormat && PRAGMA_FORMAT[pragmaFormat]) return PRAGMA_FORMAT[pragmaFormat];
  return 'rgba8unorm';
}

// ---------------------------------------------------------------------------
// WGSL introspection: Slang emits flat resource declarations; we read binding
// slots and resource kinds straight out of the generated code, and take
// uniform-buffer member offsets from Slang's reflection JSON.
// ---------------------------------------------------------------------------

export function parseWgslBindings(wgsl) {
  const bindings = [];
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(<uniform>|<storage[^>]*>)?\s+(\w+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(wgsl))) {
    const [, group, binding, space, name, type] = m;
    let kind;
    if (space === '<uniform>') kind = 'buffer';
    else if (/texture_2d/.test(type)) kind = 'texture';
    else if (/sampler/.test(type)) kind = 'sampler';
    else kind = 'other';
    bindings.push({
      group: +group,
      binding: +binding,
      name,
      type: type.trim(),
      kind,
    });
  }
  return bindings;
}

// Walk Slang reflection JSON and collect uniform buffer layouts:
//   name -> { size, fields: [{name, offset}] }
export function parseBufferLayouts(reflection) {
  const buffers = new Map();
  if (!reflection || !reflection.parameters) return buffers;
  for (const p of reflection.parameters) {
    const t = p.type;
    if (!t) continue;
    if (t.kind === 'constantBuffer' || t.kind === 'parameterBlock') {
      const elem = t.elementType;
      const fields = [];
      let size = 0;
      if (elem && elem.fields) {
        for (const f of elem.fields) {
          const off = f.binding && f.binding.kind === 'uniform' ? f.binding.offset : 0;
          const fsize = f.binding && f.binding.kind === 'uniform' ? (f.binding.size ?? 0) : 0;
          fields.push({ name: f.name, offset: off, size: fsize });
          size = Math.max(size, off + fsize);
        }
      }
      buffers.set(p.name, { size: Math.max(16, Math.ceil(size / 16) * 16), fields });
    }
  }
  return buffers;
}

// ---------------------------------------------------------------------------

function mat4Identity() {
  // column-major
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function sizeVec(w, h) {
  return new Float32Array([w, h, 1 / w, 1 / h]);
}

class MipGenerator {
  constructor(device) {
    this.device = device;
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.pipelines = new Map();
    this.module = device.createShaderModule({
      code: `
        @group(0) @binding(0) var src: texture_2d<f32>;
        @group(0) @binding(1) var smp: sampler;
        struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
        @vertex fn vmain(@builtin(vertex_index) i: u32) -> VOut {
          var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
          var out: VOut;
          out.pos = vec4f(p[i], 0.0, 1.0);
          out.uv = p[i] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
          return out;
        }
        @fragment fn fmain(in: VOut) -> @location(0) vec4f {
          return textureSampleLevel(src, smp, in.uv, 0.0);
        }`,
    });
  }

  pipeline(format) {
    if (!this.pipelines.has(format)) {
      this.pipelines.set(format, this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vmain' },
        fragment: { module: this.module, entryPoint: 'fmain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }));
    }
    return this.pipelines.get(format);
  }

  generate(encoder, texture, format, mipLevelCount) {
    const pipeline = this.pipeline(format);
    for (let level = 1; level < mipLevelCount; level++) {
      const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.sampler },
        ],
      });
      const rp = encoder.beginRenderPass({
        colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      rp.setPipeline(pipeline);
      rp.setBindGroup(0, bg);
      rp.draw(3);
      rp.end();
    }
  }
}

function mipLevelsFor(w, h) {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}

export class CrtRuntime {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    return new CrtRuntime(canvas, device, context, canvasFormat);
  }

  constructor(canvas, device, context, canvasFormat) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.mipGen = new MipGenerator(device);
    this.samplerCache = new Map();
    this.frameCount = 0;
    this.paramValues = {};
    this.passes = [];
    this.luts = new Map();
    this.original = null; // { source, width, height, isVideo, texture }
    this.quad = this.makeQuad();
  }

  makeQuad() {
    // Position vec4 + TexCoord vec2, triangle strip.
    // Texture v=0 is the top image row (copyExternalImageToTexture convention),
    // NDC y=+1 is the top of the render target.
    const data = new Float32Array([
      -1, +1, 0, 1, 0, 0,
      +1, +1, 0, 1, 1, 0,
      -1, -1, 0, 1, 0, 1,
      +1, -1, 0, 1, 1, 1,
    ]);
    const buf = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  sampler(filterLinear, wrapMode, mipmap) {
    const key = `${filterLinear}|${wrapMode}|${mipmap}`;
    if (!this.samplerCache.has(key)) {
      const address = WRAP_MODE[wrapMode] ?? 'clamp-to-edge';
      const filter = filterLinear ? 'linear' : 'nearest';
      this.samplerCache.set(key, this.device.createSampler({
        minFilter: filter,
        magFilter: filter,
        mipmapFilter: mipmap ? 'linear' : 'nearest',
        addressModeU: address,
        addressModeV: address,
        lodMinClamp: 0,
        lodMaxClamp: mipmap ? 32 : 0,
      }));
    }
    return this.samplerCache.get(key);
  }

  // compiledPasses: [{ pass(preset entry), wgsl, reflection, pragmaFormat, parameters }]
  // lutBitmaps: Map name -> ImageBitmap, presetTextures: preset.textures
  async build(compiledPasses, presetTextures, lutBitmaps, viewport) {
    this.viewport = viewport;
    this.compiled = compiledPasses;
    this.presetTextures = presetTextures;

    // Upload LUT textures once.
    this.luts.clear();
    for (const t of presetTextures) {
      const bmp = lutBitmaps.get(t.name);
      if (!bmp) continue;
      const mips = t.mipmap ? mipLevelsFor(bmp.width, bmp.height) : 1;
      const tex = this.device.createTexture({
        size: [bmp.width, bmp.height],
        format: 'rgba8unorm',
        mipLevelCount: mips,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
      if (mips > 1) {
        const enc = this.device.createCommandEncoder();
        this.mipGen.generate(enc, tex, 'rgba8unorm', mips);
        this.device.queue.submit([enc.finish()]);
      }
      this.luts.set(t.name, { texture: tex, width: bmp.width, height: bmp.height, meta: t });
    }

    this.buildPipelines();
    if (this.original) this.layout();
  }

  buildPipelines() {
    this.passes = [];
    const n = this.compiled.length;
    for (let i = 0; i < n; i++) {
      const { pass, wgsl, reflection, pragmaFormat } = this.compiled[i];
      const isLast = i === n - 1;
      const format = isLast ? this.canvasFormat : passFormat(pass, pragmaFormat);
      const bindings = parseWgslBindings(wgsl);
      const bufferLayouts = parseBufferLayouts(reflection);
      const module = this.device.createShaderModule({ code: wgsl, label: `pass${i}` });
      const entryNames = this.findEntryPoints(wgsl);
      const pipeline = this.device.createRenderPipeline({
        label: `pass${i}`,
        layout: 'auto',
        vertex: {
          module,
          entryPoint: entryNames.vertex,
          buffers: [{
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x2' },
            ],
          }],
        },
        fragment: { module, entryPoint: entryNames.fragment, targets: [{ format }] },
        primitive: { topology: 'triangle-strip' },
      });

      // Create uniform buffers for each <uniform> binding.
      const buffers = [];
      for (const b of bindings) {
        if (b.kind !== 'buffer') continue;
        const layout = this.matchBufferLayout(bufferLayouts, b.name);
        const size = layout ? layout.size : 256;
        const gpuBuf = this.device.createBuffer({
          label: `pass${i}:${b.name}`,
          size,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        buffers.push({ binding: b, layout, gpuBuf, cpu: new ArrayBuffer(size) });
      }

      this.passes.push({
        meta: pass, index: i, isLast, format, wgsl, bindings, buffers, pipeline,
        outputTexture: null, outW: 0, outH: 0, bindGroups: null,
        needsMips: false, // set during layout if some consumer needs mipmaps
      });
    }

    // alias map: name -> producing pass index
    this.aliasToPass = new Map();
    this.passes.forEach(p => { if (p.meta.alias) this.aliasToPass.set(p.meta.alias, p.index); });

    // mark passes whose output needs a mip chain
    this.passes.forEach(p => {
      if (p.meta.mipmapInput && p.index > 0) this.passes[p.index - 1].needsMips = true;
    });
  }

  findEntryPoints(wgsl) {
    const v = wgsl.match(/@vertex\s+fn\s+(\w+)/);
    const f = wgsl.match(/@fragment\s+fn\s+(\w+)/);
    if (!v || !f) throw new Error('Could not find entry points in generated WGSL');
    return { vertex: v[1], fragment: f[1] };
  }

  matchBufferLayout(bufferLayouts, wgslName) {
    if (bufferLayouts.has(wgslName)) return bufferLayouts.get(wgslName);
    // Slang may suffix names (e.g. params_0); match on prefix.
    for (const [name, layout] of bufferLayouts) {
      if (wgslName === name || wgslName.startsWith(name + '_') || name.startsWith(wgslName)) return layout;
    }
    return null;
  }

  setOriginal(source, width, height, isVideo) {
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.original = { source, width, height, isVideo, texture };
    if (!isVideo) {
      this.device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
    }
    this.frameCount = 0;
    if (this.passes.length) this.layout();
  }

  setViewport(w, h) {
    this.viewport = { width: w, height: h };
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.passes.length && this.original) this.layout();
  }

  // Compute pass sizes and (re)create intermediate textures + bind groups.
  layout() {
    const vp = this.viewport;
    let srcW = this.original.width, srcH = this.original.height;
    for (const p of this.passes) {
      const m = p.meta;
      const dim = (type, scale, srcDim, vpDim) => {
        switch (type) {
          case 'source': return Math.max(1, Math.round(srcDim * scale));
          case 'viewport': return Math.max(1, Math.round(vpDim * scale));
          case 'absolute': return Math.max(1, Math.round(scale));
          default:
            return p.isLast ? vpDim : Math.max(1, Math.round(srcDim * scale));
        }
      };
      p.outW = dim(m.scaleTypeX, m.scaleX, srcW, vp.width);
      p.outH = dim(m.scaleTypeY, m.scaleY, srcH, vp.height);
      if (p.isLast) { p.outW = vp.width; p.outH = vp.height; }

      if (!p.isLast) {
        if (p.outputTexture) p.outputTexture.destroy();
        const mips = p.needsMips ? mipLevelsFor(p.outW, p.outH) : 1;
        p.mipLevelCount = mips;
        p.outputTexture = this.device.createTexture({
          label: `pass${p.index}-out`,
          size: [p.outW, p.outH],
          format: p.format,
          mipLevelCount: mips,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      }
      p.inW = srcW; p.inH = srcH;
      srcW = p.outW; srcH = p.outH;
    }
    this.buildBindGroups();
  }

  // Resolve a texture binding name to { texture(view info), w, h, samplerInfo }.
  resolveTextureName(name, passIndex) {
    const stripped = name.replace(/_\d+$/, '');
    const passMeta = (k) => this.passes[k] ? this.passes[k].meta : null;
    const samplerForOutput = (k) => {
      // Output of pass k is sampled with the settings the *next* pass declares
      // for its input (RetroArch attaches filtering to the framebuffer's consumer).
      const consumer = passMeta(k + 1);
      return {
        linear: consumer ? consumer.filterLinear : true,
        wrap: consumer ? consumer.wrapMode : 'clamp_to_edge',
      };
    };

    if (stripped === 'Source') {
      const m = this.passes[passIndex].meta;
      if (passIndex === 0) {
        return {
          tex: this.original.texture, w: this.original.width, h: this.original.height,
          sampler: { linear: m.filterLinear, wrap: m.wrapMode, mip: false },
        };
      }
      const prev = this.passes[passIndex - 1];
      return {
        tex: prev.outputTexture, w: prev.outW, h: prev.outH,
        sampler: { linear: m.filterLinear, wrap: m.wrapMode, mip: !!m.mipmapInput },
      };
    }
    if (stripped === 'Original' || stripped === 'OriginalHistory0') {
      const m0 = this.passes[0].meta;
      return {
        tex: this.original.texture, w: this.original.width, h: this.original.height,
        sampler: { linear: m0.filterLinear, wrap: m0.wrapMode, mip: false },
      };
    }
    const passOut = stripped.match(/^PassOutput(\d+)$/);
    if (passOut) {
      const k = +passOut[1];
      const p = this.passes[k];
      const s = samplerForOutput(k);
      return { tex: p.outputTexture, w: p.outW, h: p.outH, sampler: { ...s, mip: false } };
    }
    if (this.aliasToPass.has(stripped)) {
      const k = this.aliasToPass.get(stripped);
      const p = this.passes[k];
      const s = samplerForOutput(k);
      return { tex: p.outputTexture, w: p.outW, h: p.outH, sampler: { ...s, mip: false } };
    }
    if (this.luts.has(stripped)) {
      const l = this.luts.get(stripped);
      return {
        tex: l.texture, w: l.width, h: l.height,
        sampler: { linear: l.meta.linear, wrap: l.meta.wrapMode, mip: l.meta.mipmap },
      };
    }
    return null;
  }

  buildBindGroups() {
    for (const p of this.passes) {
      const groups = new Map(); // group index -> entries[]
      const texInfo = new Map(); // base name -> resolved
      const addEntry = (g, entry) => {
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(entry);
      };

      for (const b of p.bindings) {
        if (b.kind === 'buffer') {
          const rec = p.buffers.find(x => x.binding === b);
          addEntry(b.group, { binding: b.binding, resource: { buffer: rec.gpuBuf } });
        } else if (b.kind === 'texture') {
          const base = this.textureBaseName(b.name);
          const info = this.resolveTextureName(base, p.index);
          if (!info) throw new Error(`pass${p.index}: cannot resolve texture "${base}"`);
          texInfo.set(base, info);
          addEntry(b.group, { binding: b.binding, resource: info.tex.createView() });
        }
      }
      // samplers second: resolve against the texture they belong to
      for (const b of p.bindings) {
        if (b.kind !== 'sampler') continue;
        const base = this.samplerBaseName(b.name);
        let info = base ? texInfo.get(base) : null;
        if (!info && texInfo.size === 1) info = [...texInfo.values()][0];
        const s = info ? info.sampler : { linear: true, wrap: 'clamp_to_edge', mip: false };
        addEntry(b.group, { binding: b.binding, resource: this.sampler(s.linear, s.wrap, !!s.mip) });
      }

      p.bindGroups = [];
      for (const [g, entries] of groups) {
        p.bindGroups.push({
          index: g,
          group: this.device.createBindGroup({
            label: `pass${p.index}-g${g}`,
            layout: p.pipeline.getBindGroupLayout(g),
            entries,
          }),
        });
      }
      p.texInfo = texInfo;
    }
  }

  textureBaseName(wgslName) {
    return wgslName.replace(/(_texture)?(_\d+)?$/, '');
  }

  samplerBaseName(wgslName) {
    const m = wgslName.match(/^(.*?)(_sampler|Sampler)?(_\d+)?$/);
    return m ? m[1] : wgslName;
  }

  setParams(values) {
    this.paramValues = values;
  }

  // Fill uniform members by semantic name.
  uniformValue(name, pass) {
    if (name === 'MVP') return mat4Identity();
    if (name === 'SourceSize') {
      const src = pass.index === 0
        ? { w: this.original.width, h: this.original.height }
        : { w: this.passes[pass.index - 1].outW, h: this.passes[pass.index - 1].outH };
      return sizeVec(src.w, src.h);
    }
    if (name === 'OriginalSize' || name === 'OriginalHistorySize0') {
      return sizeVec(this.original.width, this.original.height);
    }
    if (name === 'OutputSize') return sizeVec(pass.outW, pass.outH);
    if (name === 'FinalViewportSize') return sizeVec(this.viewport.width, this.viewport.height);
    if (name === 'FrameCount') {
      let fc = this.frameCount;
      if (pass.meta.frameCountMod) fc %= pass.meta.frameCountMod;
      return new Uint32Array([fc]);
    }
    if (name === 'FrameDirection') return new Int32Array([1]);
    const sizeOf = name.match(/^(.*)Size$/);
    if (sizeOf) {
      const base = sizeOf[1];
      const po = base.match(/^PassOutput(\d+)$/);
      if (po) { const p = this.passes[+po[1]]; return sizeVec(p.outW, p.outH); }
      if (this.aliasToPass.has(base)) {
        const p = this.passes[this.aliasToPass.get(base)];
        return sizeVec(p.outW, p.outH);
      }
      if (this.luts.has(base)) {
        const l = this.luts.get(base);
        return sizeVec(l.width, l.height);
      }
    }
    if (name in this.paramValues) return new Float32Array([this.paramValues[name]]);
    return null;
  }

  updateUniforms(pass) {
    for (const rec of pass.buffers) {
      if (!rec.layout) continue;
      const view = new Uint8Array(rec.cpu);
      for (const f of rec.layout.fields) {
        const v = this.uniformValue(f.name, pass);
        if (v == null) continue;
        view.set(new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, rec.cpu.byteLength - f.offset)), f.offset);
      }
      this.device.queue.writeBuffer(rec.gpuBuf, 0, rec.cpu);
    }
  }

  render() {
    if (!this.original || !this.passes.length) return;
    if (this.original.isVideo) {
      const v = this.original.source;
      if (v.readyState >= 2) {
        this.device.queue.copyExternalImageToTexture(
          { source: v }, { texture: this.original.texture },
          [this.original.width, this.original.height]);
      }
    }

    const encoder = this.device.createCommandEncoder();
    for (const p of this.passes) {
      this.updateUniforms(p);
      const view = p.isLast
        ? this.context.getCurrentTexture().createView()
        : p.outputTexture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
      const rp = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      rp.setPipeline(p.pipeline);
      rp.setVertexBuffer(0, this.quad);
      for (const bg of p.bindGroups) rp.setBindGroup(bg.index, bg.group);
      rp.draw(4);
      rp.end();
      if (!p.isLast && p.needsMips && p.mipLevelCount > 1) {
        this.mipGen.generate(encoder, p.outputTexture, p.format, p.mipLevelCount);
      }
    }
    this.device.queue.submit([encoder.finish()]);
    this.frameCount++;
  }
}
