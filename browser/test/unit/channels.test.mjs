import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, solid, testImage, pixel } from '../env.mjs';
load('filters/channels.js');

const conv = (space, rgb) => { const o = [0, 0, 0, 0]; AD.channels.SPACES[space].f(...rgb, o); return o; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('reference colour values', () => {
  const hsv = conv('hsv', [255, 0, 0]); near(hsv[0], 0, 1e-9, 'H'); near(hsv[1], 1, 1e-9, 'S'); near(hsv[2], 1, 1e-9, 'V');
  near(conv('hsv', [0, 255, 0])[0], 120, 1e-9, 'green hue');
  near(conv('hsv', [0, 0, 255])[0], 240, 1e-9, 'blue hue');
  const white = conv('lab', [255, 255, 255]); near(white[0], 100, 0.01, 'L white'); near(white[1], 0, 0.01, 'a white'); near(white[2], 0, 0.01, 'b white');
  const red = conv('lab', [255, 0, 0]); near(red[0], 53.24, 0.02, 'L red'); near(red[1], 80.09, 0.05, 'a red'); near(red[2], 67.20, 0.05, 'b red');
  const lch = conv('lch', [255, 0, 0]); near(lch[1], Math.hypot(80.09, 67.20), 0.1, 'C red'); near(lch[2], 39.99, 0.1, 'h red');
  const y = conv('ycbcr601', [255, 255, 255]); near(y[0], 255, 1e-6, 'Y'); near(y[1], 128, 1e-6, 'Cb'); near(y[2], 128, 1e-6, 'Cr');
  const k = conv('cmyk', [0, 0, 0]); near(k[3], 1, 0, 'K black');
  const hsi = conv('hsi', [255, 0, 0]); near(hsi[0], 0, 1e-6, 'HSI H'); near(hsi[1], 1, 1e-9, 'HSI S');
  near(conv('hsi', [0, 0, 255])[0], 240, 1e-6, 'HSI blue');
  const luv = conv('luv', [255, 0, 0]); near(luv[0], 53.24, 0.02, 'Luv L'); near(luv[1], 175.0, 0.2, 'u red'); near(luv[2], 37.76, 0.2, 'v red');
  const ohta = conv('ohta', [200, 100, 50]); near(ohta[1], 75, 1e-9, 'I2'); near(ohta[2], -12.5, 1e-9, 'I3');
});

test('Lab round trip within one level over a colour grid', () => {
  const o = [0, 0, 0], back = [0, 0, 0];
  let worst = 0;
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    AD.channels.SPACES.lab.f(r, g, b, o); AD.channels.lab2rgb(o[0], o[1], o[2], back);
    worst = Math.max(worst, Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
  }
  assert.ok(worst < 0.5, `worst ${worst}`);
});

test('colour-space: all spaces and components run and stay finite', async () => {
  const img = testImage(37, 23);
  for (const space of Object.keys(AD.channels.SPACES)) {
    for (const component of ['all', '0', '1', '2', '3']) {
      for (const normalize of [false, true]) {
        const r = await run('color-space', img, { space, component, normalize });
        assert.equal(r.image.width, 37);
        for (const v of Object.values(r.readout)) assert.ok(!/NaN|Infinity/.test(String(v)), `${space}/${component}: ${v}`);
      }
    }
  }
});

test('colour-space: V channel of HSV equals max(R,G,B)', async () => {
  const img = testImage(20, 10);
  const r = await run('color-space', img, { space: 'hsv', component: '2' });
  for (let i = 0; i < img.data.length; i += 4) assert.ok(Math.abs(r.image.data[i] - Math.max(img.data[i], img.data[i + 1], img.data[i + 2])) <= 1);
});

test('channel mixer identity and swap', async () => {
  const img = testImage(16, 9);
  assert.deepEqual((await run('channel-mixer', img, { preset: 'identity' })).image.data, img.data);
  const sw = (await run('channel-mixer', img, { preset: 'swaprb' })).image;
  assert.deepEqual(pixel(sw, 3, 4), [pixel(img, 3, 4)[2], pixel(img, 3, 4)[1], pixel(img, 3, 4)[0]]);
  const sw2 = (await run('swap-channels', img, { r: 'b', g: 'g', b: 'r' })).image;
  assert.deepEqual(sw2.data, sw.data);
});

test('split channels tiles', async () => {
  const img = testImage(10, 6);
  const r = await run('split-channels', img, { space: 'rgb' });
  assert.equal(r.image.width, 20); assert.equal(r.image.height, 12);
  assert.deepEqual(pixel(r.image, 2, 3), pixel(img, 2, 3));                    // original top-left
  assert.equal(pixel(r.image, 10 + 2, 3)[0], pixel(img, 2, 3)[0]);             // R tile
  assert.equal(pixel(r.image, 2, 6 + 3)[0], pixel(img, 2, 3)[1]);              // G tile
  assert.equal(pixel(r.image, 10 + 2, 6 + 3)[0], pixel(img, 2, 3)[2]);         // B tile
  assert.equal(r.overlay.length, 4);
});

test('false colour maps range ends to LUT ends', async () => {
  const img = fromFn(64, 64, x => x * 4);
  const r = await run('false-color', img, { lut: 'gray', legend: false });
  assert.deepEqual(pixel(r.image, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(r.image, 63, 0), [252, 252, 252]);
  const inf = await run('false-color', img, { lut: 'inferno', legend: true });
  assert.ok(inf.overlay.length >= 1);
});

test('decorrelation stretch separates faint colour differences', async () => {
  // two regions differing by a tiny hue shift on a grey-brown base, plus mild noise
  let s = 5; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const img = fromFn(80, 40, (x) => { const n = (rnd() - 0.5) * 6; return x < 40 ? [150 + n, 135 + n, 120 + n] : [156 + n, 133 + n, 118 + n]; });
  const sep = d => { let a = [0, 0, 0], b = [0, 0, 0]; for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) { const p = pixel(d, x, y), t = x < 40 ? a : b; for (let c = 0; c < 3; c++) t[c] += p[c]; } return Math.hypot(...a.map((v, c) => (v - b[c]) / 1600)); };
  const before = sep(img), r = await run('decorrelation-stretch', img, { sigma: 50 });
  assert.ok(sep(r.image) > before * 3, `separation ${before.toFixed(2)} -> ${sep(r.image).toFixed(2)}`);
  for (const k of ['PC1 variance', 'PC2 variance', 'PC3 variance']) assert.ok(r.readout[k]);
  const lab = await run('decorrelation-stretch', img, { space: 'lab' });
  assert.ok(sep(lab.image) > before * 2);
  const pc = await run('decorrelation-stretch', img, { output: 'pc1' });
  assert.equal(pc.image.width, 80);
});

test('eig3 on a known symmetric matrix', () => {
  const { values, vectors } = AD.channels.eig3([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
  near(values[0], 5, 1e-9, 'l1'); near(values[1], 3, 1e-9, 'l2'); near(values[2], 1, 1e-9, 'l3');
  near(Math.abs(vectors[1][0]), Math.SQRT1_2, 1e-9, 'v2');
});

test('greyscale methods and channel difference', async () => {
  const img = solid(4, 4, [200, 100, 50]);
  near(pixel((await run('grayscale', img, { method: 'bt601' })).image, 0, 0)[0], Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50), 0.5, 'bt601');
  near(pixel((await run('grayscale', img, { method: 'max' })).image, 0, 0)[0], 200, 0, 'max');
  const d = await run('channel-difference', img, { a: 'rgb.0', b: 'rgb.1', gain: 1, offset: 0, abs: true });
  near(pixel(d.image, 1, 1)[0], 100, 0.5, 'R-G');
  const z = await run('channel-difference', img, { a: 'rgb.0', b: 'rgb.0', gain: 5, offset: 128 });
  near(pixel(z.image, 1, 1)[0], 128, 0, 'same channel gives offset');
});

test('tiny images', async () => {
  for (const id of ['color-space', 'channel-mixer', 'swap-channels', 'split-channels', 'false-color', 'decorrelation-stretch', 'grayscale', 'channel-difference']) {
    for (const [w, h] of [[1, 1], [2, 3]]) await run(id, testImage(w, h));
  }
});
