import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, solid, testImage, addNoise, psnr, pixel } from '../env.mjs';
load('filters/denoise.js');

// A smooth-ish natural-like image: gradients, blobs and a few edges.
const clean = AD.img.mapRGB(testImage(96, 72, 4), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.8));
const noisy = addNoise(clean, 20, 11);

test('every smoothing filter improves PSNR on Gaussian noise', async () => {
  const base = psnr(noisy, clean, { border: 2 });
  const res = {};
  for (const [id, params] of [['gaussian-blur', { sigma: 1.2 }], ['mean-filter', { radius: 1 }], ['median', { radius: 1 }], ['bilateral', { sigmaS: 2.5, sigmaR: 45 }],
    ['nl-means', { h: 16, patch: 2, search: 6 }], ['wavelet-denoise', { strength: 2, chroma: 3 }], ['anisotropic-diffusion', { iterations: 12, kappa: 30 }], ['rational-filter', {}]]) {
    res[id] = psnr((await run(id, noisy, params)).image, clean, { border: 2 });
    assert.ok(res[id] > base + 1.5, `${id}: ${base.toFixed(2)} -> ${res[id].toFixed(2)} dB`);
  }
});

test('edge-preserving filters beat Gaussian blur on sharp-edged content', async () => {
  const cartoon = fromFn(160, 120, (x, y) => {
    let c = [90 + x * 0.3, 110 + y * 0.2, 150 - x * 0.2];
    if (x > 50 && x < 110 && y > 30 && y < 90) c = [200, 180 - y * 0.3, 60];
    for (const [cx, cy] of [[25, 25], [135, 25], [25, 95], [135, 95]]) if ((x - cx) ** 2 + (y - cy) ** 2 < 144) c = [40, 60, 180];
    return c;
  });
  const n = addNoise(cartoon, 20, 11);
  const g = psnr((await run('gaussian-blur', n, { sigma: 0.8 })).image, cartoon, { border: 2 });
  for (const [id, params, margin] of [['nl-means', {}, 4], ['bilateral', { sigmaS: 2.5, sigmaR: 45 }, 3], ['wavelet-denoise', {}, 0.8], ['anisotropic-diffusion', { iterations: 12, kappa: 30 }, 2]]) {
    const v = psnr((await run(id, n, params)).image, cartoon, { border: 2 });
    assert.ok(v > g + margin, `${id} ${v.toFixed(2)} dB vs Gaussian ${g.toFixed(2)} dB`);
  }
});

test('median and adaptive median remove salt-and-pepper noise', async () => {
  const smooth = fromFn(80, 60, (x, y) => [60 + x, 90 + y, 140 - x * 0.5]);
  let s = 3; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const sp = new ImageData(new Uint8ClampedArray(smooth.data), 80, 60);
  for (let i = 0; i < sp.data.length; i += 4) { const u = r(); if (u < 0.025) sp.data[i] = sp.data[i + 1] = sp.data[i + 2] = 0; else if (u < 0.05) sp.data[i] = sp.data[i + 1] = sp.data[i + 2] = 255; }
  assert.ok(psnr(sp, smooth) < 20);
  const m = psnr((await run('median', sp, { radius: 1 })).image, smooth, { border: 1 });
  const am = psnr((await run('adaptive-median', sp, { maxRadius: 3 })).image, smooth, { border: 1 });
  assert.ok(m > 30, `median ${m.toFixed(1)}`);
  assert.ok(am > 30 && am >= m - 0.5, `adaptive ${am.toFixed(1)} vs median ${m.toFixed(1)}`);
});

test('Huang median matches a brute-force median', () => {
  const pl = Float32Array.from({ length: 23 * 17 }, (_, i) => (i * 37) % 251);
  const out = AD.denoise.median(pl, 23, 17, 2);
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  for (let y = 0; y < 17; y++) for (let x = 0; x < 23; x++) {
    const win = []; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) win.push(pl[cl(y + dy, 17) * 23 + cl(x + dx, 23)]);
    win.sort((a, b) => a - b);
    assert.equal(out[y * 23 + x], win[12], `at ${x},${y}`);
  }
});

// Simulate 8x8 JPEG-style quantisation: replace each block by its mean plus a weak gradient.
function blocky(img, B = 8) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let by = 0; by < img.height; by += B) for (let bx = 0; bx < img.width; bx += B) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0;
    for (let y = by; y < Math.min(img.height, by + B); y++) for (let x = bx; x < Math.min(img.width, bx + B); x++) { s += img.data[(y * img.width + x) * 4 + c]; n++; }
    // keep the block mean plus a third of the detail (coarse quantisation of the AC terms)
    for (let y = by; y < Math.min(img.height, by + B); y++) for (let x = bx; x < Math.min(img.width, bx + B); x++) { const i = (y * img.width + x) * 4 + c; out.data[i] = s / n + (img.data[i] - s / n) / 3; }
  }
  return out;
}

test('deblocking reduces blockiness and keeps a strong real edge', async () => {
  const smooth = fromFn(96, 64, (x, y) => [70 + x * 0.9, 80 + y * 1.1, 120]);
  const b = blocky(smooth);
  const r = await run('deblocking', b, { strength: 20 });
  assert.ok(parseFloat(r.readout['Blockiness after']) < parseFloat(r.readout['Blockiness before']) * 0.7, JSON.stringify(r.readout));
  // error at the pixels either side of each block border (where deblocking acts) must drop
  const borderErr = d => { let s = 0, n = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) if (x % 8 === 0 || x % 8 === 7 || y % 8 === 0 || y % 8 === 7) { const a = pixel(d, x, y), c = pixel(smooth, x, y); s += Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]); n += 2; } return s / n; };
  assert.ok(borderErr(r.image) < borderErr(b) * 0.8, `border error ${borderErr(b).toFixed(2)} -> ${borderErr(r.image).toFixed(2)}`);
  // a 120-level step on a block border must survive
  const edge = fromFn(64, 32, x => (x < 32 ? 40 : 160));
  const e = (await run('deblocking', edge, { strength: 20 })).image;
  assert.equal(pixel(e, 31, 10)[0], 40); assert.equal(pixel(e, 32, 10)[0], 160);
});

test('deblocking grid detection finds the block phase', () => {
  const smooth = fromFn(99, 70, (x, y) => [70 + x * 0.9, 80 + y * 1.1, 120]);
  const b = blocky(smooth);
  // shift by (3, 5): crop off the first 3 columns and 5 rows
  const shifted = new ImageData(96, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) for (let c = 0; c < 4; c++) shifted.data[(y * 96 + x) * 4 + c] = b.data[((y + 5) * 99 + x + 3) * 4 + c];
  const g = AD.denoise.detectGrid(AD.img.luma(shifted), 96, 64, 8);
  assert.deepEqual(g, { ox: 5, oy: 3 });
});

test('wavelet noise estimate is close to the true sigma', async () => {
  const flat = addNoise(fromFn(128, 128, (x, y) => 100 + x * 0.3 + y * 0.2), 12, 7);
  const r = await run('wavelet-denoise', flat, {});
  const est = parseFloat(r.readout['Estimated luma noise σ']);
  // RGB noise of 12 per channel gives luma noise of 12 * sqrt(0.299²+0.587²+0.114²) ≈ 8.0
  assert.ok(est > 6.5 && est < 9.5, `estimated ${est}`);
});

test('margin filters give identical results striped and whole', async () => {
  const img = addNoise(testImage(48, 64, 2), 15, 5);
  const ids = [['gaussian-blur', {}], ['mean-filter', { radius: 2 }], ['median', { radius: 2 }], ['adaptive-median', {}], ['bilateral', { sigmaS: 2 }],
    ['nl-means', { search: 3, patch: 1 }], ['rational-filter', {}], ['anisotropic-diffusion', { iterations: 4 }]];
  for (const [id, params] of ids) {
    const def = AD.filters.get(id), p = { ...AD.defaultParams(def, img), ...params }, m = Math.ceil(def.margin(p, {}));
    const whole = (await run(id, img, params)).image, a = 18, b = 40, y0 = Math.max(0, a - m), y1 = Math.min(64, b + m);
    const strip = new ImageData(img.data.slice(y0 * 48 * 4, y1 * 48 * 4), 48, y1 - y0);
    const def2 = AD.filters.get(id), ctx = { scale: 1, frameIndex: 0, strip: { top: y0, fullHeight: 64 }, checkpoint: async () => {}, progress: () => {} };
    let part = await def2.apply(strip, AD.scaleParams(def2, p, 1), ctx); part = part.image || part;
    for (let y = a; y < b; y++) for (let x = 0; x < 48; x++) {
      const q = pixel(part, x, y - y0), w = pixel(whole, x, y);
      assert.ok(Math.abs(q[0] - w[0]) <= 0 && Math.abs(q[1] - w[1]) <= 0 && Math.abs(q[2] - w[2]) <= 0, `${id} differs at ${x},${y}: ${q} vs ${w}`);
    }
  }
});

test('every denoise filter survives tiny and flat images', async () => {
  for (const id of ['gaussian-blur', 'mean-filter', 'median', 'adaptive-median', 'bilateral', 'nl-means', 'rational-filter', 'anisotropic-diffusion', 'deblocking', 'wavelet-denoise']) {
    for (const img of [testImage(1, 1), testImage(2, 3), solid(9, 7, [0, 0, 0]), solid(17, 11, [255, 255, 255])]) {
      const r = await run(id, img);
      assert.equal(r.image.width, img.width);
    }
  }
});
