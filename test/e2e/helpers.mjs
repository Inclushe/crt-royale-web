// Shared helpers for the browser e2e tests.
//
// These tests drive the app in headless Chromium via Playwright, using
// SwiftShader for software WebGL2 (so they run on machines with no GPU).
//
// Config via env:
//   APP_URL   — if set, tests use this URL and do NOT start a server.
//   PORT      — port for the built-in static server (default: ephemeral).
//   HEADED=1  — run with a visible browser window.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo root

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Minimal static file server rooted at the repo, so the tests are self-contained
// (no separate `python3 -m http.server` needed).
export function startServer(port = process.env.PORT ? +process.env.PORT : 0) {
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(ROOT, path.normalize(rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      resolve({ url, close: () => new Promise(r => server.close(r)) });
    });
  });
}

export function launchBrowser() {
  return chromium.launch({
    headless: !process.env.HEADED,
    // SwiftShader software rendering: no GPU required.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
}

// A 4:3 test pattern with distinct corner colors and centered "TEST" text:
// top-left red, top-right green, bottom-left blue, bottom-right white.
export const CORNER_PATTERN_HTML = `<style>body{margin:0}</style>
<div style="width:320px;height:240px;background:#808080;position:relative;font:bold 40px sans-serif">
  <div style="position:absolute;left:0;top:0;width:80px;height:60px;background:red"></div>
  <div style="position:absolute;right:0;top:0;width:80px;height:60px;background:lime"></div>
  <div style="position:absolute;left:0;bottom:0;width:80px;height:60px;background:blue"></div>
  <div style="position:absolute;right:0;bottom:0;width:80px;height:60px;background:white"></div>
  <div style="position:absolute;left:100px;top:90px;color:black">TEST</div>
</div>`;

// Renders an HTML snippet to a PNG buffer (used to synthesize a test upload).
export async function makePatternPng(ctx, html = CORNER_PATTERN_HTML, w = 320, h = 240) {
  const gen = await ctx.newPage();
  await gen.setViewportSize({ width: w, height: h });
  await gen.setContent(html);
  const png = await gen.screenshot({ type: 'png' });
  await gen.close();
  return png;
}

// Opens the app and waits until the status line settles (Ready or error).
export async function openApp(ctx, url) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(
    () => /Ready|error/i.test(document.getElementById('status').textContent),
    null, { timeout: 180000 });
  return { page, logs };
}

export async function uploadPng(page, png, name = 'test.png') {
  await page.setInputFiles('#file', { name, mimeType: 'image/png', buffer: png });
}

// Wraps a test body with server + browser lifecycle. Honors APP_URL to target an
// already-running server. Resolves to the body's return value (used as exit code:
// truthy/undefined => pass(0), false => fail(1)).
export async function withApp(body) {
  const server = process.env.APP_URL ? null : await startServer();
  const url = process.env.APP_URL || server.url;
  const browser = await launchBrowser();
  try {
    return await body({ browser, url });
  } finally {
    await browser.close();
    if (server) await server.close();
  }
}
