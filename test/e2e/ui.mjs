// Mobile layout + actual-size (1:1 device pixel) behavior, at devicePixelRatio 2.
import { launchBrowser, startServer, makePatternPng, openApp, uploadPng } from './helpers.mjs';

const server = process.env.APP_URL ? null : await startServer();
const url = process.env.APP_URL || server.url;
const browser = await launchBrowser();
let ok = true;
try {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const png = await makePatternPng(ctx,
    '<div style="width:320px;height:240px;background:repeating-linear-gradient(red 0 30px,white 30px 60px)"></div>');
  const { page } = await openApp(ctx, url);
  await uploadPng(page, png);
  await page.waitForTimeout(800);

  const mobile = await page.evaluate(() => {
    const content = document.getElementById('content');
    const view = document.getElementById('view');
    const params = document.getElementById('params');
    return {
      dpr: window.devicePixelRatio,
      flexDirection: getComputedStyle(content).flexDirection,
      paramsBelowCanvas: params.getBoundingClientRect().top >= view.getBoundingClientRect().bottom - 1,
    };
  });
  console.log('MOBILE LAYOUT:', JSON.stringify(mobile));
  ok = ok && mobile.flexDirection === 'column' && mobile.paramsBelowCanvas;

  // enable actual size; the inner #canvasWrap is the scroller
  await page.evaluate(() => {
    const cb = document.getElementById('actualSize');
    if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
  });
  await page.waitForTimeout(600);
  const actual = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const w = document.getElementById('canvasWrap');
    return {
      canvasBuffer: [c.width, c.height],
      cssSize: [c.clientWidth, c.clientHeight],
      expectedCss: [Math.round(c.width / window.devicePixelRatio), Math.round(c.height / window.devicePixelRatio)],
      scroll: [w.scrollLeft, w.scrollTop],
      scrollCenter: [
        Math.round((w.scrollWidth - w.clientWidth) / 2),
        Math.round((w.scrollHeight - w.clientHeight) / 2),
      ],
      scrollable: w.scrollWidth > w.clientWidth || w.scrollHeight > w.clientHeight,
    };
  });
  console.log('ACTUAL SIZE:', JSON.stringify(actual));
  const near = (a, b) => Math.abs(a - b) <= 1;
  ok = ok
    && near(actual.cssSize[0], actual.expectedCss[0])
    && near(actual.cssSize[1], actual.expectedCss[1])
    && (!actual.scrollable || (near(actual.scroll[0], actual.scrollCenter[0]) && near(actual.scroll[1], actual.scrollCenter[1])));

  // disable actual size -> fits the view again
  await page.evaluate(() => {
    const cb = document.getElementById('actualSize');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);
  const fit = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const v = document.getElementById('view');
    return { fitsAgain: c.clientWidth <= v.clientWidth + 1 };
  });
  console.log('FIT MODE:', JSON.stringify(fit));
  ok = ok && fit.fitsAgain;
} finally {
  await browser.close();
  if (server) await server.close();
}

console.log(ok ? 'E2E PASS' : 'E2E FAIL');
process.exit(ok ? 0 : 1);
