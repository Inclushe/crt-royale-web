# CRT slang shaders on the web

Runs [libretro slang shaders](https://github.com/libretro/slang-shaders) (focus:
`crt/crt-royale`) on photos and videos, entirely in the browser.

- Upload a photo or video; nothing is uploaded anywhere — all processing is local.
- Shader sources are fetched on the fly from the libretro/slang-shaders GitHub
  repository (raw.githubusercontent.com) and are **not modified**.
- Compilation happens client-side with the [Slang](https://github.com/shader-slang/slang)
  compiler's WebAssembly build (the same toolchain as
  [slang-playground](https://github.com/shader-slang/slang-playground)), using its
  GLSL compatibility mode: libretro's Vulkan-GLSL passes are translated to WGSL
  and rendered with WebGPU.

## Running

Serve the directory with any static file server and open it in a WebGPU-capable
browser (Chrome/Edge 113+, Safari 18+, Firefox 141+):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

1. `js/slangp.js` parses the `.slangp` preset (passes, scaling, framebuffer
   formats, LUT textures, parameter overrides).
2. `js/source.js` fetches each `.slang` pass, resolves `#include`s relative to
   the GitHub URL, extracts `#pragma parameter/name/format` metadata, and splits
   the file into its vertex/fragment stages (this is part of the libretro
   container format, the GLSL bodies stay untouched).
3. `js/compile.js` compiles each stage with slang-wasm (GLSL in → WGSL out) and
   grabs Slang's reflection JSON for uniform layouts.
4. `js/runtime.js` is a WebGPU multi-pass engine implementing libretro preset
   semantics: per-pass scaling (`source`/`viewport`/`absolute`), sRGB and float
   framebuffers, alias / `PassOutput#` / LUT bindings, per-pass samplers,
   mipmapped inputs (`mipmap_input`), and builtin uniforms (`MVP`, `SourceSize`,
   `OriginalSize`, `OutputSize`, `FrameCount`, `<Alias>Size`, parameters, ...).
5. `js/main.js` wires up the UI: media upload, preset picker (listed from the
   GitHub API with a fallback list), output resolution (720p–4K), and parameter
   sliders generated from `#pragma parameter`.

`vendor/slang-wasm.{js,wasm.gz}` is a build of the Slang compiler
(v2026.10.2) with one patch: the global session is created with
`enableGLSL = true` so the GLSL compatibility front end is available (official
release wasm builds ship without the GLSL builtin module). See
`vendor/BUILDING.md`.

## Notes / limitations

- `wrap_mode = clamp_to_border` is mapped to clamp-to-edge (WebGPU has no
  border addressing).
- `PassFeedback#` / `OriginalHistory#` are not implemented (crt-royale does not
  use them).
- Pass outputs declared `srgb_framebuffer` use `rgba8unorm-srgb` textures;
  `float_framebuffer` uses `rgba16float`.
- CRT shaders are designed for low-resolution video-game frames; photos work,
  but the scanline structure follows the upload's pixel height. Output
  resolution (1080p/1440p/4K) is selectable in the header.
