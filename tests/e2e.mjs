// End-to-end test: loads the extension into Chromium and checks the overlay.
// Run: PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 node tests/e2e.mjs
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import assert from 'assert';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ext = path.join(root, 'extension');
const fixtures = path.join(root, 'tests', 'fixtures');
const shots = process.env.SHOTS || path.join(root, 'tests', 'screenshots');
fs.mkdirSync(shots, { recursive: true });

const ctx = await pw.chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 900, height: 560 },
});

const translated = [];
// Fake translator (Google is not reachable from CI machines).
await ctx.route(/translate\.googleapis\.com/, (route) => {
  const q = new URL(route.request().url()).searchParams.get('q');
  const tl = new URL(route.request().url()).searchParams.get('tl');
  translated.push(q);
  route.fulfill({ contentType: 'application/json', body: JSON.stringify([[[`[${tl.toUpperCase()}] ${q}`, q]]]) });
});
await ctx.route(/test\.gumroad\.com/, (route) => {
  const file = path.join(fixtures, new URL(route.request().url()).pathname.slice(1));
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
  const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.vtt') ? 'text/vtt' : 'audio/wav';
  const body = fs.readFileSync(file);
  const headers = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] || '');
  if (range) {
    // Media needs HTTP range support to be seekable.
    const start = +range[1];
    const end = range[2] ? +range[2] : body.length - 1;
    headers['content-range'] = `bytes ${start}-${end}/${body.length}`;
    return route.fulfill({ status: 206, contentType: type, body: body.subarray(start, end + 1), headers });
  }
  route.fulfill({ contentType: type, body, headers });
});

let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');

async function overlayText(page) {
  return page.evaluate(() => {
    const h = document.getElementById('gt-subtitle-overlay');
    if (!h || h.style.display === 'none') return '';
    return h.shadowRoot.querySelector('.lines').innerText.trim();
  });
}
async function seek(page, t) {
  await page.evaluate((t) => { const v = document.querySelector('video'); v.pause(); v.currentTime = t; }, t);
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

const S1 = "well, it makes sense to talk about brightnesses or light ratios when there's more than one light in the scene.";
const S2 = "So let's add a second light.";

// ---------- 1. native <track> ----------
{
  const page = await ctx.newPage();
  await page.goto('https://test.gumroad.com/track.html');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await seek(page, 4);
  const t = await waitFor(async () => { const x = await overlayText(page); return x.includes('[AZ]') ? x : ''; });
  assert.strictEqual(t, '[AZ] ' + S1, 'track: full first sentence at t=4, got: ' + t);
  await seek(page, 8.3);
  const t2 = await waitFor(async () => { const x = await overlayText(page); return x.includes(S2) ? x : ''; });
  assert.ok(t2.endsWith('[AZ] ' + S2), 'track: second sentence, got: ' + t2);
  assert.ok(!translated.some((q) => q === 'well, it makes sense to talk about brightnesses or'), 'never translated a half sentence');
  await page.screenshot({ path: path.join(shots, 'track.png') });

  // Settings: bigger font, Turkish, show original.
  await sw.evaluate(() => chrome.storage.local.set({ fontSize: 40, targetLang: 'tr', showOriginal: true, historyCount: 0 }));
  const t3 = await waitFor(async () => { const x = await overlayText(page); return x.includes('[TR]') ? x : ''; });
  assert.ok(t3.startsWith('[TR] ' + S2) && t3.includes('\n' + S2), 'turkish + original, got: ' + JSON.stringify(t3));
  const fs1 = await page.evaluate(() => document.getElementById('gt-subtitle-overlay').shadowRoot.querySelector('.box').style.fontSize);
  assert.strictEqual(fs1, '32px', 'font 40px scaled by 800/1000 → 32px, got ' + fs1);

  // Full screen on the player container: overlay must move inside it.
  await page.evaluate(() => document.getElementById('player').requestFullscreen());
  await page.waitForTimeout(600);
  const inFs = await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.contains(document.getElementById('gt-subtitle-overlay')));
  assert.ok(inFs, 'overlay is inside the fullscreen element');
  const fsText = await overlayText(page);
  assert.ok(fsText.includes('[TR]'), 'still visible in fullscreen');
  await page.screenshot({ path: path.join(shots, 'fullscreen.png') });
  await page.evaluate(() => document.exitFullscreen());
  await sw.evaluate(() => chrome.storage.local.set({ fontSize: 28, targetLang: 'az', showOriginal: false, historyCount: 1 }));
  await page.close();
  console.log('✓ track mode, settings, fullscreen');
}

// ---------- 2. JW-style player (downloads the VTT itself) ----------
{
  const page = await ctx.newPage();
  await page.goto('https://test.gumroad.com/jw.html');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await seek(page, 2);
  const t = await waitFor(async () => { const x = await overlayText(page); return x.includes('[AZ]') ? x : ''; });
  assert.strictEqual(t, '[AZ] ' + S1, 'jw: full sentence from captured file, got: ' + t);
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('.jw-captions')).opacity);
  assert.strictEqual(hidden, '0', 'site captions hidden');
  await page.close();
  console.log('✓ JW-style captured subtitle file');
}

// ---------- 3. Captions only drawn in the DOM (live mode) ----------
{
  const page = await ctx.newPage();
  await page.goto('https://test.gumroad.com/dom.html');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await page.waitForTimeout(5000); // allow fallback to kick in
  const set = (t) => page.evaluate((t) => { document.querySelector('.my-caption-text').textContent = t; }, t);
  await set('well, it makes sense to talk about brightnesses or');
  await page.waitForTimeout(400);
  assert.strictEqual(await overlayText(page), '', 'nothing shown for half a sentence');
  await set("light ratios when there's more than one light in");
  await page.waitForTimeout(400);
  await set("the scene. So let's add a second");
  const t = await waitFor(async () => { const x = await overlayText(page); return x.includes('[AZ]') ? x : ''; });
  assert.strictEqual(t, '[AZ] ' + S1, 'dom: full sentence, got: ' + t);
  await set('light. Now we render it.');
  const t2 = await waitFor(async () => { const x = await overlayText(page); return x.includes(S2) ? x : ''; });
  assert.ok(t2.includes('[AZ] ' + S2), 'dom: second sentence, got: ' + t2);
  await page.screenshot({ path: path.join(shots, 'dom.png') });
  await page.close();
  console.log('✓ DOM caption live mode');
}

// ---------- 4. Popup renders ----------
{
  const id = sw.url().split('/')[2];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await page.waitForTimeout(500);
  await page.click('[data-radio="mode"] button[data-value="audio"]');
  await page.waitForTimeout(300);
  const visible = await page.isVisible('#audioStart');
  assert.ok(visible, 'audio section visible in audio mode');
  await page.setViewportSize({ width: 340, height: 900 });
  await page.screenshot({ path: path.join(shots, 'popup.png'), fullPage: true });
  await page.click('[data-radio="mode"] button[data-value="subtitle"]');
  await page.close();
  console.log('✓ popup');
}

await ctx.close();
console.log('All e2e tests passed');
