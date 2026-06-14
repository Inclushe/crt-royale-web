// Verifies the split input-resolution controls (Horizontal + Lines) produce the
// expected feed dimensions: each axis is 'source' (match media), a fixed value,
// or a custom number, and the two are independent.
import { withApp, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const code = await withApp(async ({ browser, url }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const png = await makePatternPng(ctx,
    '<div style="width:320px;height:240px;background:repeating-linear-gradient(red 0 30px,white 30px 60px)"></div>');
  const { page } = await openApp(ctx, url);
  await uploadPng(page, png);
  await page.waitForTimeout(800);

  const setInput = async (width, lines) => {
    await page.evaluate(([width, lines]) => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
      const axis = (selId, customId, presets, v) => {
        if (presets.includes(v)) set(selId, v);
        else { set(selId, 'custom'); set(customId, v); }
      };
      axis('inputWidth', 'inputWidthCustom', ['source', '256', '320', '640'], width);
      axis('inputLines', 'inputLinesCustom', ['source', '224', '240', '480'], lines);
    }, [width, lines]);
    await page.waitForTimeout(400);
    return page.evaluate(() => { const f = window.__crt.feed; return [f.width, f.height]; });
  };

  // Upload native is 320x240 (the test pattern). Crop defaults to None.
  const cases = [
    ['source', 'source', [320, 240]], // both match the source
    ['source', '240', [320, 240]],    // default-style: full width, 240 lines
    ['256', '240', [256, 240]],
    ['320', '224', [320, 224]],
    ['640', '480', [640, 480]],       // 480 = interlaced
    ['200', '150', [200, 150]],       // custom on both axes
  ];
  let ok = true;
  for (const [width, lines, expect] of cases) {
    const got = await setInput(width, lines);
    const pass = got[0] === expect[0] && got[1] === expect[1];
    ok = ok && pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} w=${width} lines=${lines}: feed=${got[0]}x${got[1]} (expect ${expect[0]}x${expect[1]})`);
  }
  return ok;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
