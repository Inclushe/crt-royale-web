# CRT libretro shaders on the web

Runs [libretro GLSL shaders](https://github.com/libretro/glsl-shaders) (focus:
the `crt/` folder, including the 12-pass **crt-royale**) on photos and videos,
entirely in the browser with WebGL2.

- Upload a photo or video; nothing is uploaded anywhere — all processing is local.
- Shader presets (`.glslp`) and shader sources (`.glsl`) are fetched on the fly
  from the libretro/glsl-shaders GitHub repository (raw.githubusercontent.com).
- The shader files are used as-is. Stage selection (`#define VERTEX` /
  `#define FRAGMENT`) is part of the format's contract — RetroArch does the
  same — and a small set of mechanical, shader-agnostic GLSL-ES strictness
  fixes is applied client-side at load time (see below).

## Running

Serve the directory with any static file server and open it in a browser with
WebGL2 (any current browser):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Pick a shader (default `crt-royale`), choose an **input resolution** — retro
console presets (NES/SNES 256px, Genesis 320×224, PS1 320×240), a downscale
factor (2×/3×/4×/custom) relative to the upload's native size, or a fully
custom WxH; the upload is resampled to it — plus a content aspect ratio and
an output resolution (720p–4K), then upload a photo or video. The canvas is
always exactly the chosen output resolution; the shader chain renders into
the largest aspect-correct rectangle centered in it (letter/pillarboxed
with black bars, like RetroArch's viewport).
Shader parameters declared via `#pragma parameter` (e.g. crt-royale's
geometry/AA settings) appear as sliders.

## How it works

1. `js/slangp.js` parses the `.glslp` preset: passes, scaling rules
   (`source`/`viewport`/`absolute`), filtering, wrap modes, sRGB/float
   framebuffers, LUT textures, parameter overrides.
2. `js/source.js` + `js/flatten.js` prepare each `.glsl` file for WebGL2:
   - select the stage and resolve the preprocessor conditionals
     (`#if defined(VERTEX)` …) with `VERTEX`/`FRAGMENT`, `GL_ES`,
     `__VERSION__` etc. defined — keeping all macros and code untouched;
   - map desktop `#version 130` to `#version 300 es`;
   - **hoist global initializers** into an init function called at the top of
     `main()`: the Cg-converted shaders blank out `const` with a macro, and
     GLSL ES forbids non-constant global initializers (desktop GL allows them);
   - **insert explicit `float(...)` casts** where the shader relies on desktop
     GLSL's implicit int→float conversions, driven by the file's own
     declarations (loop counters, `const int`s, int uniforms vs. float/vector
     identifiers and single-signature function parameters).
   These transforms are generic — the same code runs for every shader; nothing
   is patched per-shader.
3. `js/runtime.js` is a WebGL2 multi-pass engine implementing the libretro
   GLSL preset semantics: per-pass framebuffers and scaling, sRGB
   (`SRGB8_ALPHA8`) and float (`RGBA16F`) framebuffers, LUTs (with mipmaps),
   `Orig*`/`Pass*`/`PassPrev*`/`<alias>texture` bindings, and the builtin
   uniforms (`MVPMatrix`, `Texture`, `InputSize`, `TextureSize`, `OutputSize`,
   `FrameCount`, `FrameDirection`, parameters).
4. `js/main.js` wires up the UI: media upload, preset picker (listed from the
   GitHub API with a fallback list), output resolution, parameter sliders.

## Testing

`test/validate-passes.mjs` builds every stage of a preset exactly like the web
app does and validates it with `glslang` (GLSL ES rules, approximating ANGLE):

```sh
apt install glslang-tools
git clone --depth 1 --filter=blob:none --sparse https://github.com/libretro/glsl-shaders /tmp/glsl-repo
git -C /tmp/glsl-repo sparse-checkout set crt blurs
node test/validate-passes.mjs /tmp/glsl-repo crt/crt-royale.glslp
```

All 12 crt-royale passes (24 stages) validate, as do the other crt presets
(crt-geom, crt-easymode, crt-lottes, crt-aperture, zfast-crt, fakelottes,
crt-royale-fake-bloom, …).

## Notes / limitations

- `wrap_mode = clamp_to_border` maps to clamp-to-edge (WebGL has no border
  addressing).
- `mipmap_input` on an sRGB framebuffer is unsupported in WebGL2 (samples
  level 0 instead). crt-royale's GLSL preset does not use it.
- History (`Prev*Texture`) and feedback bindings are not implemented (unused
  by the crt presets).
- CRT shaders are designed for low-resolution video-game frames; the input
  resolution selector resamples uploads accordingly (240p default).
- 73 of the 77 `crt/` presets validate; the remaining four
  (crt-royale-ntsc-*, crt-royale-pal-r57shell, mame_hlsl) use preprocessor
  token pasting (`##`) or other constructs GLSL ES forbids outright.
- Legacy ESSL 1.00 shaders that hit WebGL2 restrictions (non-constant loop
  bounds, derivatives) are automatically retried as ES 3.00 behind a small
  keyword-mapping prelude.
