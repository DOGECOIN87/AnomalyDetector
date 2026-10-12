import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, testImage, addNoise, psnr } from '../env.mjs';
load('filters/deblur.js');
const DB = AD.deblur;

const sum = psf => psf.k.reduce((a, b) => a + b, 0);
const blurWith = (img, psf, noise = 1) => addNoise(AD.img.mapRGB(img, (pl, w, h) => DB.convolve(pl, w, h, psf)), noise, 9);
// natural-ish test image: soft gradients, blobs, edges
const sharp = AD.img.mapRGB(testImage(192, 144, 6), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.6));

test('PSFs are normalised and have the right extent', () => {
  for (const psf of [DB.psfDisk(3.5), DB.psfGauss(2), DB.psfLine(15, 30), DB.psfPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }])]) assert.ok(Math.abs(sum(psf) - 1) < 1e-9);
  const line = DB.psfLine(20, 0), c = (line.size - 1) / 2;
  let x0 = Infinity, x1 = -Infinity;
  for (let x = 0; x < line.size; x++) if (line.k[c * line.size + x] > 1e-6) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  assert.ok(x1 - x0 >= 19 && x1 - x0 <= 21, `extent ${x1 - x0}`);
  assert.equal(DB.psfLine(0.5, 0).k[(DB.psfLine(0.5, 0).size ** 2) >> 1], 1);
});

// 8-bit images always carry ±0.5 level rounding noise, plus σ 1 here, so the defaults (Wiener 20 dB, RL 20-30
// iterations) are what restores detail; the Laplacian-regularised method needs per-blur tuning.
for (const [name, psf, params, tikSnr] of [
  ['disk r4', DB.psfDisk(4), { id: 'optical-deblur', p: { psf: 'disk', radius: 4 } }, 25],
  ['motion 15 px at 25°', DB.psfLine(15, 25), { id: 'motion-deblur', p: { length: 15, angle: 25 } }, 5],
]) {
  test(`deconvolution with the true PSF restores detail: ${name}`, async () => {
    const blurred = blurWith(sharp, psf), base = psnr(blurred, sharp, { border: 4 });
    for (const [method, extra, gain] of [['wiener', {}, 2.5], ['rl', { iterations: 30 }, 2.5], ['tikhonov', { snr: tikSnr }, 1.5]]) {
      const r = await run(params.id, blurred, { ...params.p, method, channels: 'rgb', ...extra });
      const v = psnr(r.image, sharp, { border: 4 });
      assert.ok(v > base + gain, `${method}: ${base.toFixed(2)} -> ${v.toFixed(2)} dB`);
    }
  });
}

test('path deblurring with a straight path matches motion deblurring', async () => {
  const psf = DB.psfLine(12, 0), blurred = blurWith(sharp, psf), base = psnr(blurred, sharp, { border: 4 });
  const r = await run('nonlinear-deblur', blurred, { path: [{ x: 50, y: 50 }, { x: 62, y: 50 }], channels: 'rgb' });
  assert.ok(psnr(r.image, sharp, { border: 4 }) > base + 3);
  assert.equal(r.overlay.length, 1);
});

test('a point PSF leaves the image (almost) unchanged', async () => {
  const r = await run('optical-deblur', sharp, { psf: 'disk', radius: 0.5 });
  assert.ok(psnr(r.image, sharp, { border: 2 }) > 38, psnr(r.image, sharp, { border: 2 }).toFixed(2));
});

test('motion estimate recovers angle and length', () => {
  const big = AD.img.mapRGB(testImage(320, 320, 8), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.5));
  for (const [len, ang] of [[18, 0], [24, 30], [16, -45], [30, 70]]) {
    const e = DB.estimateMotion(blurWith(big, DB.psfLine(len, ang), 0.5));
    const dAng = Math.min(Math.abs(e.angle - ang), 180 - Math.abs(e.angle - ang));
    assert.ok(dAng <= 5, `angle ${ang} -> ${e.angle.toFixed(1)}`);
    assert.ok(Math.abs(e.length - len) / len <= 0.2, `length ${len} -> ${e.length.toFixed(1)}`);
  }
});

test('defocus estimate recovers the disk radius', () => {
  const big = AD.img.mapRGB(testImage(320, 320, 8), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.5));
  for (const r of [3, 5, 8]) {
    const e = DB.estimateDefocus(blurWith(big, DB.psfDisk(r), 0.5));
    assert.ok(e && Math.abs(e.radius - r) / r <= 0.2, `radius ${r} -> ${e && e.radius.toFixed(2)}`);
  }
});

test('preview scale: PSF params are in px and scale with the image', async () => {
  const blurred = blurWith(sharp, DB.psfDisk(4));
  const half = AD.img.resize(blurred, 96, 72), sharpHalf = AD.img.resize(sharp, 96, 72);
  const r = await run('optical-deblur', half, { radius: 4, psf: 'disk', channels: 'rgb' }, { scale: 0.5 });
  assert.ok(psnr(r.image, sharpHalf, { border: 3 }) > psnr(half, sharpHalf, { border: 3 }));
  assert.match(r.readout.PSF, /r 4\.0 px/);
});

test('tiny and odd sizes', async () => {
  for (const id of ['optical-deblur', 'motion-deblur', 'nonlinear-deblur']) for (const [w, h] of [[1, 1], [2, 3], [33, 17]]) {
    for (const method of ['wiener', 'rl']) { const r = await run(id, testImage(w, h), { method, iterations: 3 }); assert.equal(r.image.width, w); }
  }
});
