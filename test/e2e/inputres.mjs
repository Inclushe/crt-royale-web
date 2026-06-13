// Verifies the Input resolution selector produces the expected feed dimensions
// for each mode (native, downscale factors, custom scale, custom WxH, presets).
import { withApp, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const code = await withApp(async ({ browser, url }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const png = await makePatternPng(ctx,
    '<div style="width:320px;height:240px;background:repeating-linear-gradient(red 0 30px,white 30px 60px)"></div>');
  const { page } = await openApp(ctx, url);
  await uploadPng(page, png);
  await page.waitForTimeout(800);

  const setInput = async (sel, custom) => {
    await page.evaluate(([sel, custom]) => {
      const s = document.getElementById('inputRes');
      s.value = sel; s.dispatchEvent(new Event('change'));
      if (custom !== null) {
        const c = document.getElementById('inputCustom');
        c.value = custom; c.dispatchEvent(new Event('change'));
      }
    }, [sel, custom]);
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const f = window.__crt.feed;
      return [f.width, f.height];
    });
  };

  // Upload native is 320x240 (the test pattern). Crop defaults to None.
  const cases = [
    ['native', null, [320, 240]],
    ['/2', null, [160, 120]],
    ['/4', null, [80, 60]],
    ['custom-scale', '2.5', [128, 96]],
    ['custom-res', '200x150', [200, 150]],
    ['256x240', null, [256, 240]],
  ];
  let ok = true;
  for (const [sel, custom, expect] of cases) {
    const got = await setInput(sel, custom);
    const pass = got[0] === expect[0] && got[1] === expect[1];
    ok = ok && pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${sel}${custom ? ' ' + custom : ''}: feed=${got[0]}x${got[1]} (expect ${expect[0]}x${expect[1]})`);
  }
  return ok;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
