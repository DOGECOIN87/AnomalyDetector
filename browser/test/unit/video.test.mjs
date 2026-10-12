import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, testImage, addNoise, psnr, pixel } from '../env.mjs';
load('filters/video.js');

// A textured world larger than the frame; frames are crops of it (camera pan) with an optional moving square.
const world = AD.img.mapRGB(testImage(260, 200, 9), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.7));
function clip({ pan = [2, 1], obj = null, frames = 7, noise = 14 } = {}) {
  const clean = [], noisy = [];
  for (let f = 0; f < frames; f++) {
    const c = AD.img.crop(world, 30 + pan[0] * f, 30 + pan[1] * f, 160, 120);
    if (obj) for (let y = 40; y < 70; y++) for (let x = obj.x0 + obj.v * f; x < obj.x0 + obj.v * f + 30; x++) {
      if (x < 0 || x >= 160) continue;
      const i = (y * 160 + x) * 4; c.data[i] = 230 - (x * 7) % 40; c.data[i + 1] = 40 + (y * 5) % 50; c.data[i + 2] = 60;
    }
    clean.push(c); noisy.push(addNoise(c, noise, 50 + f));
  }
  return { clean, noisy };
}
const mid = 3;
const regionPsnr = (a, b, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = pixel(a, x, y), q = pixel(b, x, y); for (let c = 0; c < 3; c++) { s += (p[c] - q[c]) ** 2; n++; } } return 10 * Math.log10(65025 / (s / n)); };

test('block motion recovers a known global shift (including sub-pixel)', () => {
  const A = AD.img.luma(AD.img.crop(world, 40, 40, 160, 120));
  for (const [sx, sy] of [[7, -4], [0, 0], [-12, 9]]) {
    const B = AD.img.luma(AD.img.crop(world, 40 + sx, 40 + sy, 160, 120));
    const F = AD.video.estimateMotion(A, B, 160, 120, { block: 16, search: 24 });
    // A(p) = B(p + v) when B is the world shifted by (sx, sy): v = (-sx, -sy)
    const med = arr => Float32Array.from(arr).sort()[arr.length >> 1];
    assert.ok(Math.abs(med(F.vx) + sx) <= 0.5 && Math.abs(med(F.vy) + sy) <= 0.5, `shift ${sx},${sy}: got ${med(F.vx)},${med(F.vy)}`);
  }
  // half-pixel: average of two neighbouring crops
  const B0 = AD.img.crop(world, 45, 40, 160, 120), B1 = AD.img.crop(world, 46, 40, 160, 120);
  const half = new ImageData(160, 120); for (let i = 0; i < half.data.length; i++) half.data[i] = (B0.data[i] + B1.data[i]) / 2;
  const F = AD.video.estimateMotion(A, AD.img.luma(half), 160, 120, { block: 16, search: 24 });
  const mx = Float32Array.from(F.vx).sort()[F.vx.length >> 1];
  assert.ok(Math.abs(mx + 5.5) <= 0.3, `half-pixel shift: got ${mx}`);
});

test('camera pan: motion smoothing denoises, plain averaging ghosts', async () => {
  const { clean, noisy } = clip({ pan: [3, 2] });
  const base = psnr(noisy[mid], clean[mid], { border: 8 });
  const ms = (await run('motion-smoothing', noisy[mid], { radius: 2, tolerance: 14 }, { frames: noisy, frameIndex: mid })).image;
  const fa = (await run('frame-average', noisy[mid], { radius: 2 }, { frames: noisy, frameIndex: mid })).image;
  const pMs = psnr(ms, clean[mid], { border: 8 }), pFa = psnr(fa, clean[mid], { border: 8 });
  assert.ok(pMs > base + 3, `motion smoothing ${base.toFixed(1)} -> ${pMs.toFixed(1)} dB`);
  assert.ok(pMs > pFa + 3, `motion smoothing ${pMs.toFixed(1)} vs plain average ${pFa.toFixed(1)} dB`);
});

test('moving object on a static camera stays sharp', async () => {
  const { clean, noisy } = clip({ pan: [0, 0], obj: { x0: 20, v: 9 } });
  const ms = (await run('motion-smoothing', noisy[mid], { radius: 2, tolerance: 14 }, { frames: noisy, frameIndex: mid })).image;
  const fa = (await run('frame-average', noisy[mid], { radius: 2 }, { frames: noisy, frameIndex: mid })).image;
  const x0 = 20 + 9 * mid, box = [x0 - 2, 38, x0 + 32, 72];
  const pMs = regionPsnr(ms, clean[mid], ...box), pFa = regionPsnr(fa, clean[mid], ...box), pN = regionPsnr(noisy[mid], clean[mid], ...box);
  assert.ok(pMs > pFa + 4, `object: smoothing ${pMs.toFixed(1)} vs averaging ${pFa.toFixed(1)} dB`);
  assert.ok(pMs > pN - 0.5, `object: smoothing ${pMs.toFixed(1)} must not be worse than noisy ${pN.toFixed(1)} dB`);
  // static background gets the full benefit of averaging
  assert.ok(regionPsnr(ms, clean[mid], 5, 85, 155, 115) > regionPsnr(noisy[mid], clean[mid], 5, 85, 155, 115) + 4);
});

test('frame averaging: mean reduces noise by about sqrt(N); median removes a passing object', async () => {
  const flat = fromFn(64, 48, () => [120, 120, 120]);
  const frames = Array.from({ length: 9 }, (_, i) => addNoise(flat, 16, 10 + i));
  const r = (await run('frame-average', frames[0], { mode: 'range', from: 0, to: 8, op: 'mean' }, { frames })).image;
  let s = 0; for (let i = 0; i < r.data.length; i += 4) s += (r.data[i] - 120) ** 2;
  const sd = Math.sqrt(s / (64 * 48));
  assert.ok(sd > 16 / 3 * 0.8 && sd < 16 / 3 * 1.25, `σ after 9 frames ${sd.toFixed(2)} (expected ~5.3)`);
  const withCar = Array.from({ length: 5 }, (_, i) => fromFn(64, 48, (x) => (x >= i * 12 && x < i * 12 + 10 ? [255, 0, 0] : [90, 90, 90])));
  const med = (await run('frame-average', withCar[0], { mode: 'range', from: 0, to: 4, op: 'median' }, { frames: withCar })).image;
  for (let x = 0; x < 64; x++) assert.deepEqual(pixel(med, x, 20), [90, 90, 90]);
});

test('single frame and tiny inputs', async () => {
  const one = testImage(40, 30);
  const r = await run('motion-smoothing', one, {}, { frames: [one] });
  assert.deepEqual(r.image.data, one.data);
  for (const [w, h] of [[1, 1], [2, 3], [17, 9]]) {
    const fr = [testImage(w, h, 1), testImage(w, h, 2), testImage(w, h, 3)];
    await run('motion-smoothing', fr[1], {}, { frames: fr, frameIndex: 1 });
    await run('frame-average', fr[1], {}, { frames: fr, frameIndex: 1 });
  }
});
