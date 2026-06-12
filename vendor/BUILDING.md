# Building vendor/slang-wasm.{js,wasm.gz}

These artifacts are a WebAssembly build of the Slang compiler
(https://github.com/shader-slang/slang, tag v2026.10.2), the same toolchain
used by https://github.com/shader-slang/slang-playground.

One patch is applied: official wasm release builds create their global session
without GLSL support, which makes Slang's GLSL compatibility front end fail
with `error[E38201]: 'glsl' module not available`. We enable it so that the
libretro shaders (Vulkan GLSL) can be consumed without modification.

In `source/slang-wasm/slang-wasm.cpp`, `createGlobalSession()`:

```cpp
// before
SlangResult result = slang::createGlobalSession(&globalSession);
// after
SlangGlobalSessionDesc gsDesc = {};
gsDesc.enableGLSL = true;
SlangResult result = slang_createGlobalSession2(&gsDesc, &globalSession);
```

Build steps (mirrors .github/workflows/release.yml in the slang repo):

```sh
git clone --depth 1 --branch v2026.10.2 --recurse-submodules \
    https://github.com/shader-slang/slang.git
cd slang
# apply the patch above
cmake --workflow --preset generators --fresh
mkdir build-platform-generators
cmake --install build --config Release --component generators --prefix build-platform-generators
git clone https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install 6.0.0 && ./emsdk activate 6.0.0)
source emsdk/emsdk_env.sh
emcmake cmake -DSLANG_GENERATORS_PATH=build-platform-generators/bin \
    --preset emscripten -DSLANG_SLANG_LLVM_FLAVOR=DISABLE
cmake --build --preset emscripten --config Release --target slang-wasm
gzip -9 -c build.em/Release/bin/slang-wasm.wasm > slang-wasm.wasm.gz
```
