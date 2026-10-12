// Runs each filter that has a gpu() path both ways in headless Chromium (WebGL2 via SwiftShader) on a sample
// and reports how closely they match.  node test/gpu-parity.mjs [--only=id,id] [--sample=plate] [--params='{"id":{...}}']
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import { start } from '../serve.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const only = args.only ? String(args.only).split(',') : null;
const overrides = args.params ? JSON.parse(args.params) : {};

const server = await start(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.AD && AD.state.source);
const rows = await page.evaluate(async ({ only, sample, overrides }) => {
  if (sample) await AD.loadSample(sample);
  const img = await AD.state.source.getFrame(0);
  const out = [];
  for (const def of AD.filters.values()) {
    if (!def.gpu || (only && !only.includes(def.id))) continue;
    const p = { ...AD.defaultParams(def, img, { frameCount: 1, fps: 25 }), ...(overrides[def.id] || {}) };
    const ctx = { frameIndex: 0, frameCount: 1, inputFrameCount: 1, fps: 25, scale: 1, input: async () => img, original: async () => img,
      memo: (k, fn) => Promise.resolve().then(fn), checkpoint: async () => {}, progress: () => {}, log: () => {} };
    try {
      const t0 = performance.now(); let a = await def.apply(img, p, ctx); const tc = performance.now() - t0;
      const t1 = performance.now(); let b = await def.gpu(img, p, ctx); const tg = performance.now() - t1;
      a = a.image || a; b = b.image || b;
      if (a.width !== b.width || a.height !== b.height) { out.push({ id: def.id, error: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` }); continue; }
      let max = 0, se = 0, over2 = 0;
      for (let i = 0; i < a.data.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(a.data[i] - b.data[i]); se += d * d; if (d > max) max = d; if (d > 2) over2++; }
      const n = a.data.length * 3 / 4, mse = se / n;
      out.push({ id: def.id, maxDiff: max, psnr: mse ? +(10 * Math.log10(65025 / mse)).toFixed(1) : Infinity, pctOver2: +(over2 / n * 100).toFixed(3), cpuMs: Math.round(tc), gpuMs: Math.round(tg) });
    } catch (e) { out.push({ id: def.id, error: e.message }); }
  }
  return out;
}, { only, sample: args.sample || null, overrides });
for (const r of rows) console.log(r.error ? `ERROR ${r.id}: ${r.error}` : `${r.id.padEnd(26)} max |Δ| ${String(r.maxDiff).padStart(3)}  PSNR ${String(r.psnr).padStart(6)} dB  >2 levels: ${r.pctOver2}%  cpu ${r.cpuMs} ms  gpu ${r.gpuMs} ms`);
if (!rows.length) console.log('No filters with a gpu() path matched.');
await browser.close(); server.close();
