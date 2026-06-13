// Region-only ("fast") rendering test.
// Region mode scissors the heavy passes to the window footprint + a margin. This
// asserts the windowed output STILL equals the matching sub-rectangle of the full
// 1440p render (proving the margins cover the passes' sampling footprints), for a
// centered crop and an edge crop (curvature reach is worst near the edges).
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

  // --- Full reference render (mini off, 1440p, 4:3) ---
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
    return { w: c.width, h: c.height };
  });
  console.log('FULL:', JSON.stringify(full));

  // Render a region-mode window at (cu,cv) and compare to the full sub-rectangle.
  const runCase = async (cu, cv) => {
    await page.evaluate(({ cu, cv }) => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
      set('refRes', '2560x1440');
      set('windowSize', '480x360');
      set('renderMode', 'region');
      const cb = document.getElementById('miniMode');
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      const cx = document.getElementById('winCenterX'); cx.value = String(cu); cx.dispatchEvent(new Event('input'));
      const cy = document.getElementById('winCenterY'); cy.value = String(cv); cy.dispatchEvent(new Event('input'));
    }, { cu, cv });
    await page.waitForTimeout(1800);
    return page.evaluate(() => {
      const src = document.getElementById('canvas');
      const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
      const x = c.getContext('2d'); x.drawImage(src, 0, 0);
      const small = x.getImageData(0, 0, c.width, c.height);
      const rt = window.__crt.runtime, drawVp = rt.drawVpRect, full = window.__full;
      const cropX = full.vp.x - drawVp.x, cropY = full.vp.y - drawVp.y;
      const offX = cropX, offY = full.h - small.height - cropY;
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
      const regionScissored = rt.passes.filter(p => p.roi).length;
      return { smallSize: [small.width, small.height], meanDiff: sum / (n * 3), maxDiff: maxd, samples: n, oob, regionScissored };
    });
  };

  const center = await runCase(0.5, 0.5);
  console.log('REGION center:', JSON.stringify(center));
  const edge = await runCase(0.92, 0.92);
  console.log('REGION edge:', JSON.stringify(edge));

  // Region mode must actually scissor passes, and match the exact crop everywhere
  // (margins cover the sampling footprints). Differences are only sRGB rounding.
  const caseOk = (r) => r.samples > 1000 && r.oob === 0 && r.regionScissored >= 2 && r.meanDiff < 2 && r.maxDiff <= 16;
  const ok = center.smallSize[0] === 480 && center.smallSize[1] === 360 && caseOk(center) && caseOk(edge);
  if (!ok) console.log('FAIL detail:', JSON.stringify({ center: caseOk(center), edge: caseOk(edge) }));
  return ok;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
