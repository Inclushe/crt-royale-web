// Regenerate data/crt-presets.json — a trimmed snapshot of the libretro/
// glsl-shaders `crt` directory listing, so the app doesn't hit the GitHub API
// (rate limited) on every load. We keep only the `name` field of each .glslp
// entry, which is all js/main.js listPresets() consumes.
//
// Usage: node scripts/update-crt-presets.mjs
// Optional: set GITHUB_TOKEN to raise the API rate limit.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API = 'https://api.github.com/repos/libretro/glsl-shaders/contents/crt';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'crt-presets.json');

const headers = { Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(API, { headers });
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const data = await res.json();
if (!Array.isArray(data)) throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 200)}`);

const entries = data
  .filter(e => e.type === 'file' && e.name.endsWith('.glslp'))
  .map(e => ({ name: e.name }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

writeFileSync(OUT, JSON.stringify(entries, null, 2) + '\n');
console.log(`Wrote ${entries.length} presets to ${OUT}`);
