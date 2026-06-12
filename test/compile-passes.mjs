// Headless test: compile every pass of a .slangp preset to WGSL via slang-wasm.
// Usage: node test/compile-passes.mjs [wasmDir] [shaderRepoDir] [presetRelPath]
// Reads shaders from a local clone of libretro/slang-shaders so the test
// doesn't depend on network access.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { parsePreset } from '../js/slangp.js';
import { SourceLoader, processShaderSource, resolveUrl } from '../js/source.js';
import { SlangCompiler } from '../js/compile.js';

const wasmDir = process.argv[2] ?? '/tmp/slang/out';
const repoDir = process.argv[3] ?? '/tmp/slang/repo';
const presetRel = process.argv[4] ?? 'crt/crt-royale.slangp';
const outDir = fileURLToPath(new URL('./out', import.meta.url));
await mkdir(outDir, { recursive: true });

const createModule = (await import(pathToFileURL(path.join(wasmDir, 'slang-wasm.js')).href)).default;
const wasmBinary = await readFile(path.join(wasmDir, 'slang-wasm.wasm'));
const m = await createModule({ wasmBinary });
console.log('slang-wasm loaded');
const compiler = new SlangCompiler(m);
console.log('global session created (GLSL mode enabled)');

const fetchText = async (url) => readFile(fileURLToPath(url), 'utf8');
const loader = new SourceLoader(fetchText);

const presetUrl = pathToFileURL(path.join(repoDir, presetRel)).href;
const preset = parsePreset(await fetchText(presetUrl));
console.log(`preset: ${presetRel}: ${preset.passes.length} passes, ${preset.textures.length} textures`);

let failures = 0;
for (const pass of preset.passes) {
  const url = resolveUrl(presetUrl, pass.path);
  const label = `pass${pass.index} (${path.basename(pass.path)})`;
  try {
    const src = await loader.loadWithIncludes(url);
    const stages = processShaderSource(src);
    const t0 = Date.now();
    const { wgsl, reflection } = compiler.compilePass(stages.vertex, stages.fragment, `p${pass.index}`);
    console.log(`OK   ${label}  wgsl=${wgsl.length}B  params=${stages.parameters.length}  ${Date.now() - t0}ms`);
    await writeFile(path.join(outDir, `pass${pass.index}.wgsl`), wgsl);
    await writeFile(path.join(outDir, `pass${pass.index}.reflect.json`), JSON.stringify(reflection, null, 2));
    await writeFile(path.join(outDir, `pass${pass.index}.vert.glsl`), stages.vertex);
    await writeFile(path.join(outDir, `pass${pass.index}.frag.glsl`), stages.fragment);
  } catch (e) {
    failures++;
    console.log(`FAIL ${label}\n${String(e.message ?? e).slice(0, 4000)}`);
  }
}
console.log(failures ? `${failures} pass(es) failed` : 'all passes compiled');
process.exit(failures ? 1 : 0);
