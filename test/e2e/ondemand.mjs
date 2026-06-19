// On-demand rendering test.
// With on-demand ON (default), a static image renders once then idles (frameCount
// stops climbing, fps reads 0); a state change marks it dirty and renders one more
// frame. With on-demand OFF, rendering is continuous (frameCount keeps climbing).
import { withApp, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const code = await withApp(async ({ browser, url }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const png = await makePatternPng(ctx);
  const { page, logs } = await openApp(ctx, url);

  let st = await page.locator('#status').textContent();
  if (/error/i.test(st)) { console.log(logs.slice(-20).join('\n')); return false; }

  await uploadPng(page, png);
  await page.waitForTimeout(800);

  // Meters now default off; the fps readout only updates when they're on. Enable them so
  // the idle-fps assertion below can read #fps.
  await page.evaluate(() => { const c = document.getElementById('showMeters'); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); } });

  const fc = () => page.evaluate(() => window.__crt.runtime.frameCount);

  // On-demand ON (default): should go idle.
  await page.evaluate(() => { const c = document.getElementById('onDemand'); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); } });
  await page.waitForTimeout(400);
  const idleA = await fc();
  await page.waitForTimeout(600);
  const idleB = await fc();
  // fps drops to 0 once idle (allow a few slow-rAF intervals to settle).
  let fpsIdleOk = false;
  try {
    await page.waitForFunction(() => /^0 fps$/.test(document.getElementById('fps').textContent), null, { timeout: 4000 });
    fpsIdleOk = true;
  } catch { fpsIdleOk = false; }
  const fpsText = await page.locator('#fps').textContent();
  console.log('IDLE:', JSON.stringify({ idleA, idleB, fpsText, fpsIdleOk }));

  // A state change (flip vertical) marks dirty -> exactly one more render.
  await page.evaluate(() => { const c = document.getElementById('flipY'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(400);
  const afterChange = await fc();
  console.log('AFTER CHANGE:', JSON.stringify({ afterChange }));

  // On-demand OFF: continuous rendering (keeps climbing even in slow headless).
  await page.evaluate(() => { const c = document.getElementById('onDemand'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(200);
  const contA = await fc();
  await page.waitForTimeout(800);
  const contB = await fc();
  console.log('CONTINUOUS:', JSON.stringify({ contA, contB }));

  const idleOk = idleB === idleA;                 // no renders while idle
  const changeOk = afterChange >= idleB + 1;      // a render happened on change
  const continuousOk = contB - contA >= 2;        // keeps rendering when on-demand off
  const ok = idleOk && fpsIdleOk && changeOk && continuousOk;
  if (!ok) console.log('FAIL detail:', JSON.stringify({ idleOk, fpsIdleOk, changeOk, continuousOk }));
  return ok;
});

console.log(code ? 'E2E PASS' : 'E2E FAIL');
process.exit(code ? 0 : 1);
