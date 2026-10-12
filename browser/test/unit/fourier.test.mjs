import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, testImage, psnr, pixel } from '../env.mjs';
load('filters/fourier.js');
const FR = AD.fourier;

const clean = AD.img.mapRGB(testImage(160, 120, 3), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.7));
const withWaves = (img, waves) => fromFn(img.width, img.height, (x, y) => {
  let s = 0; for (const [a, fx, fy] of waves) s += a * Math.sin(2 * Math.PI * (fx * x + fy * y));
  return pixel(img, x, y).map(c => c + s);
});

test('display <-> bin mapping round-trips for odd and even sizes', () => {
  for (const [w, h, W, H] of [[160, 120, 256, 128], [161, 99, 256, 128], [64, 64, 64, 64]]) {
    for (const [u, v] of [[0, 0], [5, -7], [-W / 2, H / 2 - 1], [17.25, 3.5]]) {
      const d = FR.toDisplay(u, v, w, h, W, H), b = FR.toBin(d.x, d.y, w, h, W, H);
      assert.ok(Math.abs(b.u - u) < 1e-9 && Math.abs(b.v - v) < 1e-9, `${w}x${h}: ${u},${v} -> ${b.u},${b.v}`);
    }
  }
});

test('a pure sinusoid peaks at the expected frequency', async () => {
  // (24, 14) cycles per 128 px: outside the detector's DC exclusion zone
  const img = fromFn(128, 128, (x, y) => 128 + 60 * Math.sin(2 * Math.PI * (x * 24 / 128 + y * 14 / 128)));
  const S = FR.spectra(img), peaks = FR.detectPeaks(S, { max: 1 });
  assert.equal(peaks.length, 1);
  // one of the conjugate pair (24, 14) / (-24, -14), stored in the v >= 0 half plane
  assert.deepEqual([Math.abs(peaks[0].u), Math.abs(peaks[0].v)], [24, 14]);
  const r = await run('fourier-spectrum', img, {});
  assert.match(r.readout['Peak 1'], /period/);
});

test('detect peaks + notch removes two interference patterns', async () => {
  const noisy = withWaves(clean, [[25, 0.12, 0.05], [18, -0.04, 0.17]]);
  const before = psnr(noisy, clean, { border: 4 });
  const def = AD.filters.get('periodic-noise');
  const patch = await def.actions[0].run(noisy, AD.defaultParams(def, noisy), {});
  assert.ok(patch.notches.length >= 2, `found ${patch.notches.length}`);
  const r = await run('periodic-noise', noisy, { notches: patch.notches, radius: 4 });
  const after = psnr(r.image, clean, { border: 4 });
  assert.ok(after > before + 8, `${before.toFixed(1)} -> ${after.toFixed(1)} dB`);
  const spec = await run('periodic-noise', noisy, { notches: patch.notches, view: 'spectrum' });
  assert.equal(spec.image.width, 160); assert.equal(spec.overlay.length, patch.notches.length * 2);
});

test('band notch removes horizontal scan lines', async () => {
  const lines = fromFn(160, 120, (x, y) => pixel(clean, x, y).map(c => c + (y % 4 < 2 ? 20 : -20)));
  const S = FR.spectra(lines), pk = FR.detectPeaks(S, { max: 1 })[0];
  assert.equal(Math.abs(pk.u), 0);
  const r = await run('periodic-noise', lines, { notches: [{ x: pk.x, y: pk.y }], shape: 'hband', radius: 3 });
  assert.ok(psnr(r.image, clean, { border: 4 }) > psnr(lines, clean, { border: 4 }) + 8);
});

test('low-pass removes a fine checkerboard, high-pass keeps only detail', async () => {
  const chk = fromFn(64, 64, (x, y) => 128 + ((x + y) % 2 ? 40 : -40));
  const lp = (await run('frequency-filter', chk, { type: 'lowpass', cutoff: 0.2 })).image;
  for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) assert.ok(Math.abs(pixel(lp, x, y)[0] - 128) <= 3);
  const flat = fromFn(64, 64, () => 90);
  const hp = (await run('frequency-filter', flat, { type: 'highpass', cutoff: 0.05 })).image;
  for (let i = 0; i < hp.data.length; i += 4) assert.ok(Math.abs(hp.data[i] - 128) <= 1, `${hp.data[i]}`);
});

test('homomorphic filter evens out a strong illumination gradient', async () => {
  const lit = fromFn(160, 120, (x, y) => pixel(clean, x, y).map(c => c * (0.15 + 0.85 * x / 160)));
  const r = (await run('homomorphic-filter', lit, { gammaL: 0.3 })).image;
  const mean = (d, x0) => { let s = 0, n = 0; for (let y = 10; y < 110; y++) for (let x = x0; x < x0 + 30; x++) { s += pixel(d, x, y)[1]; n++; } return s / n; };
  const ratio = d => mean(d, 120) / Math.max(1, mean(d, 10));
  assert.ok(ratio(r) < ratio(lit) * 0.6, `bright/dark ratio ${ratio(lit).toFixed(2)} -> ${ratio(r).toFixed(2)}`);
});

test('tiny images', async () => {
  for (const id of ['fourier-spectrum', 'periodic-noise', 'frequency-filter', 'homomorphic-filter']) for (const [w, h] of [[1, 1], [2, 3], [5, 33]]) await run(id, testImage(w, h));
});
