// Headless-browser smoke test: loads the real page, runs every registered filter (or --only=a,b) on a matching
// sample through the worker engine, and reports errors, timings and page errors.
//   node test/smoke.mjs [--only=id,id] [--shots=dir] [--frames=2] [--local]
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { start } from '../serve.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const only = args.only ? String(args.only).split(',') : null;
const shots = args.shots ? path.resolve(String(args.shots)) : null;
const framesToTry = Number(args.frames || 2);
if (shots) fs.mkdirSync(shots, { recursive: true });

const CATEGORY_SAMPLE = {
  'Select Frames': 'shaky', Interlace: 'interlaced', Edit: 'barrel', Channels: 'plate', Adjust: 'plate', Sharpen: 'defocus',
  Denoise: 'noisy', Deblurring: 'motion-blur', Stabilization: 'shaky', Integrate: 'shaky', Extract: 'saturation-patches',
  Verify: 'jpeg', Measure: 'plate', Presentation: 'plate',
};

const server = await start(0);
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push('console: ' + m.text()); });
if (args.local) await page.addInitScript(() => { window.Worker = undefined; });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.AD && window.AD.backend && window.AD.state.source, null, { timeout: 60000 });
const env = await page.evaluate(() => ({
  log: [...document.querySelectorAll('#log p')].map(p => p.textContent),
  filters: [...AD.filters.values()].map(d => ({ id: d.id, name: d.name, category: d.category, testSample: d.testSample || null, actions: d.actions.map(a => a.id) })),
  samples: AD.samples.map(s => s.id),
}));
console.log(env.log.join('\n'));
const todo = env.filters.filter(f => !only || only.includes(f.id));
console.log(`\n${todo.length} filter(s) to test, ${env.samples.length} samples\n`);

const results = [];
let currentSample = null;
for (const f of todo) {
  const sample = f.testSample || CATEGORY_SAMPLE[f.category] || 'plate';
  const row = { id: f.id, category: f.category, sample, ok: true, notes: [] };
  const errsBefore = pageErrors.length;
  try {
    if (sample !== currentSample) {
      if (!env.samples.includes(sample)) throw new Error(`sample ${sample} not registered`);
      await page.evaluate(id => AD.loadSample(id), sample);
      currentSample = sample;
    }
    const r = await page.evaluate(async ({ id, frames }) => {
      AD.debug.clearChain();
      await AD.addFilter(id);
      AD.debug.setShow('result');
      const out = [];
      const count = AD.debug.frameCountAt(AD.state.chain.length - 1);
      for (let i = 0; i < Math.min(frames, count); i++) {
        AD.state.frame = i;
        const t0 = performance.now();
        const res = await AD.renderNow();
        const ms = Math.round(performance.now() - t0);
        const step = AD.state.stepStats.get(AD.state.chain[0].uid) || {};
        const img = res && res.image;
        let mean = null;
        if (img) { let s = 0; for (let j = 0; j < img.data.length; j += 4 * 97) s += img.data[j]; mean = s / Math.ceil(img.data.length / (4 * 97)); }
        out.push({ frame: i, ms, error: step.error || (res ? res.error : 'no result'), w: img && img.width, h: img && img.height, mean, readout: res && res.readout, overlay: res && res.overlay ? res.overlay.length : 0 });
      }
      return { out, count };
    }, { id: f.id, frames: framesToTry });
    for (const fr of r.out) {
      if (fr.error) { row.ok = false; row.notes.push(`frame ${fr.frame}: ${fr.error}`); }
      if (!fr.w || !fr.h) { row.ok = false; row.notes.push(`frame ${fr.frame}: empty output`); }
    }
    row.ms = r.out.map(x => x.ms).join('/');
    row.size = r.out[0] ? `${r.out[0].w}x${r.out[0].h}` : '';
    row.frames = r.count;
    if (r.out[0] && r.out[0].readout) row.notes.push('readout: ' + Object.entries(r.out[0].readout).map(([k, v]) => `${k}=${v}`).join(', '));
    if (r.out[0] && r.out[0].overlay) row.notes.push(`overlay shapes: ${r.out[0].overlay}`);
    if (shots) await page.locator('.viewport').screenshot({ path: path.join(shots, `${f.id}.png`) });
  } catch (e) {
    row.ok = false; row.notes.push(e.message.split('\n')[0]);
  }
  const newErrs = pageErrors.slice(errsBefore);
  if (newErrs.length) { row.ok = false; row.notes.push(...newErrs.map(e => 'page: ' + e)); }
  results.push(row);
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${f.id.padEnd(26)} ${String(row.ms || '').padStart(12)} ms  ${(row.size || '').padEnd(10)} ${row.notes.join(' | ')}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${pageErrors.length ? `; ${pageErrors.length} page error(s)` : ''}`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
