// Mini-TV windowing test.
// Asserts that the small windowed canvas is a pixel-exact 1:1 crop of the full
// high-reference-resolution render (same phosphor mask, same curvature) — not a
// downscaled whole image. Renders the corner pattern twice:
//   1. full 1440p render (mini off): canvas == virtual viewport
//   2. windowed 480x360 (mini on, ref 1440p, centered): canvas == a crop window
// and compares the window against the matching sub-rectangle of the full render.
import { withApp, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const code = await withApp(async ({ browser, url }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const png = await makePatternPng(ctx);
  const { page, logs } = await openApp(ctx, url);

  let st = await page.locator('#status').textContent();
  console.log('STATUS after load:', st);
  if (/error/i.test(st)) { console.log(logs.slice(-20).join('\n')); return false; }

  await uploadPng(page, png);
  await page.waitForTimeout(2000);

  // --- 1. Full reference render (mini off, 1440p, 4:3) ---
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
    const cb = document.getElementById('miniMode');
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    set('aspect', '4:3');
    set('resolution', '2560x1440');
  });
  await page.waitForTimeout(2500);
  const full = await page.evaluate(() => {
    const src = document.getElementById('canvas');
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const x = c.getContext('2d'); x.drawImage(src, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height);
    window.__full = { data: img.data, w: c.width, h: c.height, vp: { ...window.__crt.runtime.vpRect } };
    return { w: c.width, h: c.height, vp: window.__crt.runtime.vpRect };
  });
  console.log('FULL:', JSON.stringify(full));

  // --- 2. Windowed render (mini on, ref 1440p, window 480x360, centered) ---
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
    set('refRes', '2560x1440');
    set('windowSize', '480x360');
    const cb = document.getElementById('miniMode');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    const cx = document.getElementById('winCenterX'); cx.value = '0.5'; cx.dispatchEvent(new Event('input'));
    const cy = document.getElementById('winCenterY'); cy.value = '0.5'; cy.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(2500);

  const cmp = await page.evaluate(() => {
    const src = document.getElementById('canvas');
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const x = c.getContext('2d'); x.drawImage(src, 0, 0);
    const small = x.getImageData(0, 0, c.width, c.height);
    const rt = window.__crt.runtime;
    const drawVp = rt.drawVpRect, vr = rt.virtualVpRect, full = window.__full;
    // The full render's canvas IS the virtual viewport, so its content rect
    // (full.vp) shares the virtual coordinate system. Crop offsets in GL coords:
    const cropX = full.vp.x - drawVp.x;
    const cropY = full.vp.y - drawVp.y;
    // Map small-canvas 2d pixel (x,y) -> full 2d pixel (x+offX, y+offY).
    // (GL is y-up; both images were drawImage'd identically, so only a constant
    // vertical offset remains after accounting for the height difference.)
    const offX = cropX;
    const offY = full.h - small.height - cropY;

    let sum = 0, maxd = 0, n = 0, oob = 0;
    const fd = full.data, sd = small.data, fw = full.w;
    for (let y = 0; y < small.height; y += 2) {
      for (let xx = 0; xx < small.width; xx += 2) {
        const fx = xx + offX, fy = y + offY;
        if (fx < 0 || fy < 0 || fx >= full.w || fy >= full.h) { oob++; continue; }
        const si = (y * small.width + xx) * 4, fi = (fy * fw + fx) * 4;
        for (let ch = 0; ch < 3; ch++) { const d = Math.abs(sd[si + ch] - fd[fi + ch]); sum += d; if (d > maxd) maxd = d; }
        n++;
      }
    }
    // Negative control: a centered crop must NOT show all four corner colors of
    // the pattern (that would mean the whole image was downscaled in).
    const corner = (fx, fy) => {
      const d = x.getImageData(fx - 5, fy - 5, 11, 11).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const k = d.length / 4; return [r / k, g / k, b / k];
    };
    const dom = (cc, i) => cc[i] > 150 && cc[i] > cc[(i + 1) % 3] + 60 && cc[i] > cc[(i + 2) % 3] + 60;
    const white = (cc) => cc[0] > 150 && cc[1] > 150 && cc[2] > 150;
    const TL = corner(8, 8), TR = corner(small.width - 8, 8), BL = corner(8, small.height - 8), BR = corner(small.width - 8, small.height - 8);
    const looksLikeWholePattern = dom(TL, 0) && dom(TR, 1) && dom(BL, 2) && white(BR);

    return {
      smallSize: [small.width, small.height], drawVp, vr, cropX, cropY, offX, offY,
      meanDiff: sum / (n * 3), maxDiff: maxd, samples: n, oob, looksLikeWholePattern,
    };
  });
  console.log('WINDOW:', JSON.stringify(cmp));

  const sizeOk = cmp.smallSize[0] === 480 && cmp.smallSize[1] === 360;
  // Matched pixels share identical NDC -> identical tex_uv -> identical shader
  // output; differences are only sRGB rounding under SwiftShader.
  const exactCropOk = cmp.samples > 1000 && cmp.oob === 0 && cmp.meanDiff < 2 && cmp.maxDiff <= 16;
  const notDownscaleOk = !cmp.looksLikeWholePattern;
  const ok = sizeOk && exactCropOk && notDownscaleOk;
  if (!ok) console.log('FAIL detail:', JSON.stringify({ sizeOk, exactCropOk, notDownscaleOk }));
  return ok;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
