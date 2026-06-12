// Headless validation: build each stage of every pass of a .glslp preset the
// same way the web app does, then validate with glslang (GLSL ES rules,
// approximating what ANGLE/WebGL2 will accept).
// Usage: node test/validate-passes.mjs [glslRepoDir] [presetRelPath...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { parsePreset } from '../js/slangp.js';
import { SourceLoader, buildStageSource, parseParameterPragmas, resolveUrl } from '../js/source.js';

const exec = promisify(execFile);
const repoDir = process.argv[2] ?? '/tmp/slang/glsl-repo';
const presets = process.argv.length > 3 ? process.argv.slice(3) : ['crt/crt-royale.glslp'];
const outDir = fileURLToPath(new URL('./out', import.meta.url));
await mkdir(outDir, { recursive: true });

const fetchText = async (url) => readFile(fileURLToPath(url), 'utf8');
const loader = new SourceLoader(fetchText);

let failures = 0;
for (const presetRel of presets) {
  const presetUrl = pathToFileURL(path.join(repoDir, presetRel)).href;
  const preset = parsePreset(await fetchText(presetUrl));
  console.log(`== ${presetRel}: ${preset.passes.length} passes, ${preset.textures.length} textures`);

  for (const pass of preset.passes) {
    const url = resolveUrl(presetUrl, pass.path);
    const src = await loader.load(url);
    const params = parseParameterPragmas(src);
    const results = [];
    for (const [stage, ext] of [['VERTEX', 'vert'], ['FRAGMENT', 'frag']]) {
      const code = buildStageSource(src, stage);
      const file = path.join(outDir, `p${pass.index}.${ext}`);
      await writeFile(file, code);
      try {
        await exec('glslang', ['-S', ext, file]);
        results.push(`${ext} OK`);
      } catch (e) {
        results.push(`${ext} FAIL`);
        failures++;
        console.log(`---- pass${pass.index} ${path.basename(pass.path)} [${stage}]:`);
        console.log(String(e.stdout ?? e.message).split('\n').slice(0, 12).join('\n'));
      }
    }
    console.log(`pass${pass.index} ${path.basename(pass.path)}: ${results.join(', ')} (${params.length} params)`);
  }
}
console.log(failures ? `${failures} stage(s) failed` : 'all stages validated');
process.exit(failures ? 1 : 0);
