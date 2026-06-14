// WebGL2 runtime for libretro .glslp shader presets.
// Implements the multi-pass semantics of the GLSL preset format: per-pass
// scaling (source/viewport/absolute), sRGB/float framebuffers, LUT textures,
// alias / PassN / PassPrevN bindings, and the builtin uniforms
// (MVPMatrix, Texture, InputSize, TextureSize, OutputSize, FrameCount, ...).
// Reference: https://docs.libretro.com/development/shader/glsl-shaders/

const WRAP_MODE = {
  clamp_to_border: 'CLAMP_TO_EDGE', // WebGL has no border addressing
  clamp_to_edge: 'CLAMP_TO_EDGE',
  repeat: 'REPEAT',
  mirrored_repeat: 'MIRRORED_REPEAT',
};

// Region mode: extra per-side margin (virtual px) added to every scissored pass's
// ROI, covering cumulative cross-pass sampling reach (curvature/AA + blur kernels +
// scanline/misconvergence) so the visible window matches the full render exactly.
const REGION_PASS_MARGIN = 32;

function compileShader(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const lines = source.split('\n');
    const ctx = (log.match(/0:(\d+)/) || [])[1];
    const around = ctx
      ? lines.slice(Math.max(0, ctx - 3), +ctx + 2).join('\n')
      : '';
    throw new Error(`${label} shader compile failed:\n${log}\n${around}`);
  }
  return sh;
}

export class CrtRuntime {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.floatExt = gl.getExtension('EXT_color_buffer_float');
    this.passes = [];
    this.luts = new Map();
    this.frameCount = 0;
    this.paramValues = {};
    this.original = null; // { source, width, height, isVideo, texture }
    this.flipY = false;
    // Mini-TV mode: render the viewport-scaled passes at a high "virtual"
    // resolution (so the phosphor mask keeps its native pitch) while the actual
    // canvas shows only a small window/crop of that virtual render. null = off.
    this.virtual = null; // { width, height } of the virtual viewport, or null
    this.crop = null;    // { x, y } bottom-left of the window in virtual-canvas GL coords
    // Region-only ("fast") rendering: scissor the heavy full-virtual passes to the
    // window's footprint + a margin, so only the visible pixels are shaded.
    this.regionMode = false;
    this.regionMargin = 0; // fraction of the virtual content rect, per side

    // quad: VertexCoord.xy + TexCoord.xy (z, w default to 0, 1)
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
      +1, -1, 1, 0,
      -1, +1, 0, 1,
      +1, +1, 1, 1,
    ]), gl.STATIC_DRAW);
    this.quadFlip = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadFlip);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, +1, 0, 0,
      +1, +1, 1, 0,
      -1, -1, 0, 1,
      +1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    this.identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    // Optional GPU timing: measures wall-clock time the GPU spends on the pass
    // chain. Results arrive a few frames late (async), so we keep a small queue.
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.gpuQueries = [];
    this.lastGpuTimeMs = null; // most recent measured GPU frame time, or null
  }

  // Drain finished GPU timer queries into lastGpuTimeMs.
  pollGpuQueries() {
    const gl = this.gl, ext = this.timerExt;
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { // timings invalid this interval
      for (const q of this.gpuQueries) gl.deleteQuery(q);
      this.gpuQueries.length = 0;
      return;
    }
    while (this.gpuQueries.length) {
      const q = this.gpuQueries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.lastGpuTimeMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; // ns -> ms
      gl.deleteQuery(q);
      this.gpuQueries.shift();
    }
  }

  setFlipY(v) { this.flipY = v; }
  setParams(values) { this.paramValues = values; }

  passFormat(meta) {
    const gl = this.gl;
    if (meta.srgbFramebuffer) return { internal: gl.SRGB8_ALPHA8, srgb: true };
    if (meta.floatFramebuffer && this.floatExt) return { internal: gl.RGBA16F, float: true };
    return { internal: gl.RGBA8 };
  }

  applyTexParams(target, { linear, wrap, mipmap }) {
    const gl = this.gl;
    const w = gl[WRAP_MODE[wrap] ?? 'CLAMP_TO_EDGE'];
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mipmap ? (linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST)
             : (linear ? gl.LINEAR : gl.NEAREST));
  }

  // compiledPasses: [{ meta(preset pass entry), vertexSrc, fragmentSrc }]
  build(compiledPasses, presetTextures, lutBitmaps, viewport) {
    const gl = this.gl;
    this.viewport = viewport;
    this.destroyPasses();

    // LUTs
    for (const t of this.luts.values()) gl.deleteTexture(t.texture);
    this.luts.clear();
    for (const t of presetTextures) {
      const bmp = lutBitmaps.get(t.name);
      if (!bmp) continue;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // ImageBitmaps ignore UNPACK_FLIP_Y_WEBGL; they are flipped at decode time
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      if (t.mipmap) gl.generateMipmap(gl.TEXTURE_2D);
      this.applyTexParams(gl.TEXTURE_2D, { linear: t.linear, wrap: t.wrapMode, mipmap: t.mipmap });
      this.luts.set(t.name, { texture: tex, width: bmp.width, height: bmp.height, meta: t });
    }

    // programs
    this.passes = compiledPasses.map(({ meta, vertexSrc, fragmentSrc }, i) => {
      const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc, `pass${i} vertex`);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc, `pass${i} fragment`);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'VertexCoord');
      gl.bindAttribLocation(prog, 1, 'TexCoord');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`pass${i} link failed: ${gl.getProgramInfoLog(prog)}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      const uniforms = [];
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let u = 0; u < n; u++) {
        const info = gl.getActiveUniform(prog, u);
        const name = info.name.replace(/\[0\]$/, '');
        uniforms.push({ name, type: info.type, loc: gl.getUniformLocation(prog, info.name) });
      }
      return {
        index: i, meta, prog, uniforms, vertexSrc, fragmentSrc,
        isLast: i === compiledPasses.length - 1,
        texture: null, fbo: null, outW: 0, outH: 0, inW: 0, inH: 0,
      };
    });

    this.aliasToPass = new Map();
    for (const p of this.passes) if (p.meta.alias) this.aliasToPass.set(p.meta.alias, p.index);

    if (this.original) this.layout();
  }

  destroyPasses() {
    const gl = this.gl;
    for (const p of this.passes) {
      if (p.prog) gl.deleteProgram(p.prog);
      if (p.texture) gl.deleteTexture(p.texture);
      if (p.fbo) gl.deleteFramebuffer(p.fbo);
    }
    this.passes = [];
  }

  setOriginal(source, width, height, dynamic) {
    const gl = this.gl;
    if (this.original) gl.deleteTexture(this.original.texture);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const m0 = this.passes[0] ? this.passes[0].meta : { filterLinear: true, wrapMode: 'clamp_to_edge' };
    this.applyTexParams(gl.TEXTURE_2D, { linear: m0.filterLinear, wrap: m0.wrapMode, mipmap: false });
    this.original = { source, width, height, dynamic, texture };
    this.frameCount = 0;
    if (this.passes.length) this.layout();
  }

  // w, h: output (canvas) resolution. aspect: content aspect ratio as a
  // number, or null to match the input. The chain renders into the largest
  // aspect-correct rectangle centered in the canvas (letter/pillarboxed),
  // exactly like RetroArch's viewport.
  setViewport(w, h, aspect = this.viewport ? this.viewport.aspect : null) {
    this.viewport = { width: w, height: h, aspect };
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.passes.length && this.original) this.layout();
  }

  // Enable/disable mini-TV windowing. Pass null to disable (canvas is the full
  // render, current behavior). When enabled, the viewport-scaled passes size off
  // {virtualW, virtualH} and the final pass is clipped to the small canvas with
  // its origin at virtual-canvas pixel (cropX, cropY).
  setWindow(win) {
    if (!win) {
      this.virtual = null;
      this.crop = null;
    } else {
      let { virtualW, virtualH } = win;
      const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
      if (virtualW > max || virtualH > max) {
        console.warn(`[crt] mini-tv: virtual ${virtualW}x${virtualH} exceeds MAX_TEXTURE_SIZE ${max}; clamping`);
        const s = Math.min(max / virtualW, max / virtualH);
        virtualW = Math.floor(virtualW * s);
        virtualH = Math.floor(virtualH * s);
      }
      this.virtual = { width: virtualW, height: virtualH };
      this.crop = { x: Math.round(win.cropX) || 0, y: Math.round(win.cropY) || 0 };
    }
    if (this.passes.length && this.original) this.layout();
  }

  // Enable/disable region-only rendering (only meaningful while a window is set).
  // margin is the per-side ROI expansion as a fraction of the virtual content rect.
  setRegionMode(on, margin = this.regionMargin) {
    this.regionMode = !!on;
    this.regionMargin = margin;
    if (this.passes.length && this.original) this.layout();
  }

  // Largest aspect-correct rect centered in a cw x ch area (letter/pillarbox).
  letterbox(cw, ch, aspect) {
    const ar = aspect ?? (this.original ? this.original.width / this.original.height : cw / ch);
    let vw, vh;
    if (cw / ch > ar) { vh = ch; vw = Math.round(ch * ar); }
    else { vw = cw; vh = Math.round(cw / ar); }
    return { x: Math.floor((cw - vw) / 2), y: Math.floor((ch - vh) / 2), width: vw, height: vh };
  }

  // Content rect within the actual canvas (used when windowing is off).
  viewportRect() {
    return this.letterbox(this.viewport.width, this.viewport.height, this.viewport.aspect);
  }

  // Content rect within the virtual viewport (equals viewportRect() when off).
  // All viewport-scaled passes size off this so the mask is at virtual pitch.
  virtualRect() {
    const w = this.virtual ? this.virtual.width : this.viewport.width;
    const h = this.virtual ? this.virtual.height : this.viewport.height;
    return this.letterbox(w, h, this.viewport.aspect);
  }

  // Compute pass sizes, allocate intermediate framebuffers, set sampling
  // parameters (the output of pass k is sampled with the settings pass k+1
  // declares for its input — RetroArch semantics).
  layout() {
    const gl = this.gl;
    // Viewport-scaled passes + the forced last-pass size use the virtual content
    // rect (= the canvas content rect when windowing is off). vpRect stays the
    // content rect for back-compat; drawVpRect is what the final pass clips to.
    const vp = this.virtualVpRect = this.vpRect = this.virtualRect();
    this.drawVpRect = this.crop
      ? { x: vp.x - this.crop.x, y: vp.y - this.crop.y, width: vp.width, height: vp.height }
      : vp;
    let srcW = this.original.width, srcH = this.original.height;

    for (const p of this.passes) {
      const m = p.meta;
      const dim = (type, scale, srcDim, vpDim) => {
        switch (type) {
          case 'source': return Math.max(1, Math.round(srcDim * scale));
          case 'viewport': return Math.max(1, Math.round(vpDim * scale));
          case 'absolute': return Math.max(1, Math.round(scale));
          default: return p.isLast ? vpDim : Math.max(1, Math.round(srcDim * scale));
        }
      };
      p.inW = srcW; p.inH = srcH;
      p.outW = p.isLast ? vp.width : dim(m.scaleTypeX, m.scaleX, srcW, vp.width);
      p.outH = p.isLast ? vp.height : dim(m.scaleTypeY, m.scaleY, srcH, vp.height);
      p.roi = null;

      if (!p.isLast) {
        if (p.texture) gl.deleteTexture(p.texture);
        if (p.fbo) gl.deleteFramebuffer(p.fbo);
        const fmt = this.passFormat(m);
        p.srgb = !!fmt.srgb;
        const consumer = this.passes[p.index + 1].meta;
        const needsMips = !!consumer.mipmapInput && !fmt.srgb;
        if (consumer.mipmapInput && fmt.srgb) {
          console.warn(`[crt] pass${p.index}: mipmap_input on an sRGB framebuffer is not supported in WebGL2; sampling level 0 only`);
        }
        const levels = needsMips ? 1 + Math.floor(Math.log2(Math.max(p.outW, p.outH))) : 1;
        p.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, p.texture);
        gl.texStorage2D(gl.TEXTURE_2D, levels, fmt.internal, p.outW, p.outH);
        this.applyTexParams(gl.TEXTURE_2D, {
          linear: consumer.filterLinear, wrap: consumer.wrapMode, mipmap: needsMips,
        });
        p.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.texture, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`pass${p.index}: framebuffer incomplete (0x${status.toString(16)})`);
        }
        // Region-only: scissor this pass to the window footprint + margin. Per
        // axis, scissor iff that axis is content-rect-aligned (output dim equals
        // the virtual content rect dim) — selects the window-aligned passes (1 on
        // Y only; 7,8,9,10 on both) and skips the mask tiles / small source passes.
        // Skip if the output is mipmapped (generateMipmap averages stale texels).
        const sx = p.outW === vp.width;  // X axis aligned to the content rect
        const sy = p.outH === vp.height; // Y axis aligned to the content rect
        if (this.regionMode && this.crop && (sx || sy) && !needsMips) {
          const W = this.canvas.width, H = this.canvas.height;
          const mg = Math.round(this.regionMargin * Math.max(vp.width, vp.height)) + REGION_PASS_MARGIN;
          const cx = (v) => Math.max(0, Math.min(p.outW, v));
          const cy = (v) => Math.max(0, Math.min(p.outH, v));
          // crop is in virtual-canvas coords; aligned passes are sized to the
          // content rect, so shift by the content-rect origin (vp.x/vp.y).
          const ox = this.crop.x - vp.x, oy = this.crop.y - vp.y;
          const x = sx ? cx(ox - mg) : 0;
          const right = sx ? cx(ox + W + mg) : p.outW;
          const y = sy ? cy(oy - mg) : 0;
          const top = sy ? cy(oy + H + mg) : p.outH;
          p.roi = { x, y, w: right - x, h: top - y };
          // Clear the freshly-allocated FBO once so non-ROI texels never hold NaN
          // (float bloom buffers) that could leak through bilinear taps at the edge.
          gl.viewport(0, 0, p.outW, p.outH);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
      srcW = p.outW; srcH = p.outH;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.resolveUniforms();
  }

  // Resolve every active uniform of every pass to a value provider.
  resolveUniforms() {
    for (const p of this.passes) {
      let unit = 0;
      p.setters = [];
      p.textureBinds = [];
      for (const u of p.uniforms) {
        const r = this.resolveUniform(u, p);
        if (r === null) {
          console.warn(`[crt] pass${p.index}: unresolved uniform "${u.name}"`);
          continue;
        }
        if (r.texture !== undefined) {
          const myUnit = unit++;
          p.textureBinds.push({ unit: myUnit, get: r.texture });
          this.gl.useProgram(p.prog);
          this.gl.uniform1i(u.loc, myUnit);
        } else {
          p.setters.push({ loc: u.loc, kind: r.kind, get: r.get });
        }
      }
    }
  }

  resolveUniform(u, p) {
    const name = u.name;
    const passes = this.passes;
    const orig = () => this.original;
    const sizeOfPass = (k) => () => [passes[k].outW, passes[k].outH];
    const texOfPass = (k) => () => passes[k].texture;

    if (name === 'MVPMatrix') return { kind: 'mat4', get: () => this.identity };
    if (name === 'Texture') {
      return { texture: p.index === 0 ? () => orig().texture : texOfPass(p.index - 1) };
    }
    if (name === 'InputSize' || name === 'TextureSize') {
      return { kind: 'vec2', get: () => [p.inW, p.inH] };
    }
    if (name === 'OutputSize') return { kind: 'vec2', get: () => [p.outW, p.outH] };
    if (name === 'FrameCount') {
      return {
        kind: 'int',
        get: () => p.meta.frameCountMod ? this.frameCount % p.meta.frameCountMod : this.frameCount,
      };
    }
    if (name === 'FrameDirection') return { kind: 'int', get: () => 1 };

    let m;
    if ((m = name.match(/^Orig(Texture|TextureSize|InputSize)$/))) {
      if (m[1] === 'Texture') return { texture: () => orig().texture };
      return { kind: 'vec2', get: () => [orig().width, orig().height] };
    }
    if ((m = name.match(/^Pass(\d+)(Texture|TextureSize|InputSize)$/))) {
      const k = +m[1] - 1; // Pass1 = output of the first pass
      if (k < 0 || k >= passes.length) return null;
      if (m[2] === 'Texture') return { texture: texOfPass(k) };
      // InputSize = rendered size of that pass's output framebuffer; it only
      // differs from TextureSize through POT padding, which we don't use.
      return { kind: 'vec2', get: sizeOfPass(k) };
    }
    if ((m = name.match(/^PassPrev(\d*)(Texture|TextureSize|InputSize)$/))) {
      const back = m[1] === '' ? 1 : +m[1];
      const k = p.index - back; // k == -1 refers to the original input
      if (k < -1) return null;
      if (m[2] === 'Texture') {
        return { texture: k === -1 ? () => orig().texture : texOfPass(k) };
      }
      // InputSize/TextureSize both describe pass k's output framebuffer
      // (they only differ through POT padding, which we don't use)
      const size = () => k === -1
        ? [orig().width, orig().height]
        : [passes[k].outW, passes[k].outH];
      return { kind: 'vec2', get: size };
    }
    // alias-based: <ALIAS>texture / <ALIAS>texture_size / <ALIAS>video_size
    if ((m = name.match(/^(\w+?)(texture|texture_size|video_size|Texture|TextureSize|InputSize)$/))) {
      const base = m[1];
      if (this.aliasToPass.has(base)) {
        const k = this.aliasToPass.get(base);
        if (m[2] === 'texture' || m[2] === 'Texture') return { texture: texOfPass(k) };
        return { kind: 'vec2', get: sizeOfPass(k) };
      }
    }
    if (this.luts.has(name)) {
      const l = this.luts.get(name);
      return { texture: () => l.texture };
    }
    if ((m = name.match(/^(\w+?)_size$/)) && this.luts.has(m[1])) {
      const l = this.luts.get(m[1]);
      return { kind: 'vec2', get: () => [l.width, l.height] };
    }
    if (name in this.paramValues) {
      return { kind: 'float', get: () => this.paramValues[name] };
    }
    return null;
  }

  render() {
    const gl = this.gl;
    if (!this.original || !this.passes.length) return;

    if (this.original.dynamic) {
      gl.bindTexture(gl.TEXTURE_2D, this.original.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.original.source);
    }

    let timerQuery = null;
    if (this.timerExt && this.gpuQueries.length < 8) {
      timerQuery = gl.createQuery();
      gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, timerQuery);
    }

    for (const p of this.passes) {
      // mipmaps for this pass's input, if requested (and not sRGB-stored)
      if (p.meta.mipmapInput && p.index > 0) {
        const prev = this.passes[p.index - 1];
        if (!prev.srgb && prev.texture) {
          gl.bindTexture(gl.TEXTURE_2D, prev.texture);
          gl.generateMipmap(gl.TEXTURE_2D);
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, p.isLast ? null : p.fbo);
      if (p.isLast) {
        // letter/pillarbox: clear the whole canvas, draw into the viewport rect
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const dv = this.drawVpRect;
        gl.viewport(dv.x, dv.y, dv.width, dv.height);
      } else {
        gl.viewport(0, 0, p.outW, p.outH);
      }
      const useScissor = this.regionMode && p.roi && !p.isLast;
      if (useScissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(p.roi.x, p.roi.y, p.roi.w, p.roi.h);
      }
      gl.useProgram(p.prog);

      for (const t of p.textureBinds) {
        gl.activeTexture(gl.TEXTURE0 + t.unit);
        gl.bindTexture(gl.TEXTURE_2D, t.get());
      }
      for (const s of p.setters) {
        const v = s.get();
        if (s.kind === 'mat4') gl.uniformMatrix4fv(s.loc, false, v);
        else if (s.kind === 'vec2') gl.uniform2f(s.loc, v[0], v[1]);
        else if (s.kind === 'int') gl.uniform1i(s.loc, v);
        else gl.uniform1f(s.loc, v);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, p.isLast && this.flipY ? this.quadFlip : this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (useScissor) gl.disable(gl.SCISSOR_TEST);
    }

    if (timerQuery) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this.gpuQueries.push(timerQuery);
    }
    this.pollGpuQueries();
    this.frameCount++;
  }
}
