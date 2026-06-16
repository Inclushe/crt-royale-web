// Smoke + orientation/letterbox test on crt-royale.
// Uploads a corner-marker pattern and asserts the four corners come through the
// full 12-pass chain with the right colors, inside the letterboxed content rect.
import { withApp, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const code = await withApp(async ({ browser, url }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const png = await makePatternPng(ctx);
  const { page, logs } = await openApp(ctx, url);

  let st = await page.locator('#status').textContent();
  console.log('STATUS after load:', st);
  if (/error/i.test(st)) { console.log(logs.slice(-20).join('\n')); return false; }

  await uploadPng(page, png);
  await page.waitForTimeout(3000);
  console.log('STATUS after upload:', await page.locator('#status').textContent());

  const stats = await page.evaluate(() => {
    const src = document.getElementById('canvas');
    window.__crt.runtime.render(); // sync render so readback works without preserveDrawingBuffer
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, max = 0; const n = d.length / 4; const colors = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] + d[i + 1] + d[i + 2];
      sum += lum; if (lum > max) max = lum;
      if (i % 4000 === 0) colors.add(`${d[i] >> 5},${d[i + 1] >> 5},${d[i + 2] >> 5}`);
    }
    return { avg: sum / n / 3, max: max / 3, distinctColors: colors.size, w: c.width, h: c.height };
  });
  console.log('CANVAS:', JSON.stringify(stats));

  const corners = await page.evaluate(() => {
    const src = document.getElementById('canvas');
    window.__crt.runtime.render(); // sync render so readback works without preserveDrawingBuffer
    const vp = window.__crt.runtime.vpRect; // content rect (GL coords, y up)
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const x = c.getContext('2d');
    x.drawImage(src, 0, 0);
    const top = c.height - vp.y - vp.height; // -> canvas2d y (down)
    const get = (fx, fy) => {
      const px = Math.round(vp.x + fx * vp.width), py = Math.round(top + fy * vp.height);
      const d = x.getImageData(px - 5, py - 5, 11, 11).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };
    return { canvas: [c.width, c.height], rect: vp,
      TL: get(0.08, 0.08), TR: get(0.92, 0.08), BL: get(0.08, 0.92), BR: get(0.92, 0.92) };
  });
  console.log('RECT:', JSON.stringify({ canvas: corners.canvas, rect: corners.rect }));
  console.log('CORNERS (expect TL red, TR green, BL blue, BR white):',
    JSON.stringify({ TL: corners.TL, TR: corners.TR, BL: corners.BL, BR: corners.BR }));

  // Each corner should be dominated by its expected channel.
  const dom = (c, i) => c[i] > 150 && c[i] > c[(i + 1) % 3] + 60 && c[i] > c[(i + 2) % 3] + 60;
  const white = (c) => c[0] > 150 && c[1] > 150 && c[2] > 150;
  const cornersOk = dom(corners.TL, 0) && dom(corners.TR, 1) && dom(corners.BL, 2) && white(corners.BR);

  return stats.max > 30 && stats.distinctColors > 3 && cornersOk;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
