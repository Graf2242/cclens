/**
 * Crisp dashboard screenshots via the Chrome DevTools Protocol.
 *
 * Headless Chrome on its own profile and port, deviceScaleFactor 2, and
 * Page.captureScreenshot with captureBeyondViewport — so the image is the
 * page at retina density, not a downscaled grab of the screen.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4319';
const OUT = process.argv[3];
const SESSION = process.argv[4];
const PORT = 9333;
const PROFILE = path.join(path.dirname(OUT), 'chrome-cdp-profile');
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDTH = 1840;
const DSF = 2;

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--hide-scrollbars',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-color-profile=srgb',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging endpoint');
}

/** Minimal CDP client: id-matched request/response over one socket. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(e));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ready, send, close: () => ws.close() };
}

const ws = await browserWs();
const cdp = connect(ws);
await cdp.ready;

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => cdp.send(m, p, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: 1000, deviceScaleFactor: DSF, mobile: false,
});

const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value;
};

/**
 * Two URLs differing only in their fragment are a same-document navigation —
 * the page never reloads and the app, which reads the hash at boot, keeps
 * rendering the previous screen. Blank the tab first to force a real load.
 */
async function goto(url, settle = 2600) {
  await call('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await call('Page.navigate', { url });
  await sleep(settle);
}

/**
 * Capture a region. `selector` clips to one element (the drawer, say);
 * otherwise the whole document, however far past the viewport it runs.
 */
async function shot(name, selector, maxH) {
  let clip;
  if (selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    })()`);
    if (!box) throw new Error(`no element for ${name}: ${selector}`);
    clip = { ...box, scale: 1 };
  } else {
    // contentSize runs to the bottom of the layout box, which leaves a band of
    // empty page under the last panel. Measure the real ink instead: the
    // furthest bottom edge among the visible panels.
    const h = await evaluate(`(() => {
      const vis = [...document.querySelectorAll('main .stack:not([hidden]) > *, .topbar')]
        .filter((e) => e.getBoundingClientRect().height > 0);
      const bottom = Math.max(...vis.map((e) => e.getBoundingClientRect().bottom + scrollY));
      return Math.ceil(bottom + 14);
    })()`);
    clip = { x: 0, y: 0, width: WIDTH, height: h, scale: 1 };
  }
  clip.width = Math.round(clip.width);
  clip.height = Math.round(maxH ? Math.min(clip.height, maxH) : clip.height);
  const { data } = await call('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip,
  });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`${name}.png  ${clip.width}x${clip.height} css → ${clip.width * DSF}x${clip.height * DSF} px`);
}

// The drawer scrolls inside itself; a taller viewport keeps its content in one
// frame instead of clipping it at the fold.
const tall = (h) => call('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: h, deviceScaleFactor: DSF, mobile: false,
});

await goto(`${BASE}/`, 3500);
await shot('1-spend');

await goto(`${BASE}/#view=cache`, 3000);
await shot('2-cache', null, 1500);

await goto(`${BASE}/#view=diag`, 3000);
await shot('3-diag', null, 1460);

await goto(`${BASE}/#view=probes`, 3000);
await evaluate(`(() => {
  const card = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && e.textContent.trim() === 'AGENT_ERRORS returns'
  );
  card?.closest('div')?.click();
  return !!card;
})()`);
await sleep(2500);
await shot('4-probes', null, 1500);

await tall(1500);
await goto(`${BASE}/#session=${SESSION}`, 4500);
await shot('5-session', '.drawer', 880);

await goto(`${BASE}/#session=${SESSION}&agent=test-writer`, 4500);
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'expand');
  btn?.click();
  return !!btn;
})()`);
await sleep(7000);
await tall(2100);
await sleep(1200);
await shot('6-cohort', '.drawer', 1160);

cdp.close();
chrome.kill();
console.log('done');
