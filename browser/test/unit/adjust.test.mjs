import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, solid, testImage, addNoise, pixel } from '../env.mjs';
load('filters/adjust.js');

const ramp = () => fromFn(256, 4, x => x);

test('levels maps black and white points exactly, gamma at the midpoint', async () => {
  const r = (await run('levels', ramp(), { black: 50, white: 200, gamma: 1, channel: 'rgb' })).image;
  assert.equal(pixel(r, 50, 0)[0], 0); assert.equal(pixel(r, 49, 0)[0], 0);
  assert.equal(pixel(r, 200, 0)[0], 255); assert.equal(pixel(r, 230, 0)[0], 255);
  assert.equal(pixel(r, 125, 0)[0], 128);   // (125-50)/150*255 = 127.5 -> 128
  const g = (await run('levels', ramp(), { black: 0, white: 255, gamma: 2, channel: 'rgb' })).image;
  assert.equal(pixel(g, 128, 0)[0], Math.round(255 * Math.pow(128 / 255, 0.5)));
});

test('levels auto action finds percentiles', async () => {
  const def = AD.filters.get('levels');
  const img = fromFn(100, 100, (x, y) => 40 + Math.floor((y * 100 + x) / 10000 * 120));
  const patch = await def.actions[0].run(img, AD.defaultParams(def, img), {});
  assert.ok(patch.black >= 40 && patch.black <= 42, `black ${patch.black}`);
  assert.ok(patch.white >= 157 && patch.white <= 160, `white ${patch.white}`);
});

test('curves identity and monotone spline', async () => {
  const img = testImage(32, 16);
  const id = await run('curves', img, { channel: 'rgb', p0: 0, p1: 64, p2: 128, p3: 192, p4: 255 });
  assert.deepEqual(id.image.data, img.data);
  const f = AD.adjust.monotoneSpline([0, 64, 128, 192, 255], [0, 200, 200, 210, 255]);
  let prev = -1; for (let x = 0; x <= 255; x++) { const v = f(x); assert.ok(v >= prev - 1e-9, `not monotone at ${x}`); prev = v; }
});

test('histogram equalisation flattens the histogram', async () => {
  const img = fromFn(256, 64, x => 100 + Math.floor(x / 8));   // tones squeezed into 100..131
  const r = (await run('histogram-equalization', img, { mode: 'rgb' })).image;
  let mn = 255, mx = 0; for (let i = 0; i < r.data.length; i += 4) { mn = Math.min(mn, r.data[i]); mx = Math.max(mx, r.data[i]); }
  assert.equal(mn, 0); assert.equal(mx, 255);
});

test('CLAHE boosts local contrast in a dark region without tile seams', async () => {
  // dark left half with faint texture, bright right half with faint texture
  // dark left half and bright right half, each with faint texture spread over 16 grey levels
  const img = fromFn(160, 80, (x, y) => (x < 80 ? 20 : 200) + ((x * 7 + y * 3) % 16));
  const r = (await run('clahe', img, { tiles: 4, clip: 4, strength: 1 })).image;
  const sd = (d, x0) => { let s = 0, s2 = 0, n = 0; for (let y = 10; y < 70; y++) for (let x = x0; x < x0 + 30; x++) { const v = pixel(d, x, y)[0]; s += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
  assert.ok(sd(r, 20) > sd(img, 20) * 2.5, `dark-region texture σ ${sd(img, 20).toFixed(1)} -> ${sd(r, 20).toFixed(1)}`);
  assert.ok(sd(r, 110) > sd(img, 110) * 2.5, `bright-region texture σ ${sd(img, 110).toFixed(1)} -> ${sd(r, 110).toFixed(1)}`);
  // seams: a smooth gradient should stay smooth (no jumps at tile borders)
  const grad = fromFn(200, 40, x => 30 + x * 0.5);
  const g = (await run('clahe', grad, { tiles: 5, clip: 2 })).image;
  let worst = 0; for (let x = 1; x < 200; x++) worst = Math.max(worst, Math.abs(pixel(g, x, 20)[0] - pixel(g, x - 1, 20)[0]));
  assert.ok(worst <= 6, `largest step ${worst}`);
});

test('white balance neutralises a tinted grey card', async () => {
  const img = solid(40, 30, [150, 120, 100]);
  for (const method of ['grayworld', 'manual']) {
    const r = (await run('white-balance', img, { method })).image, [R, G, B] = pixel(r, 20, 15);
    assert.ok(Math.max(R, G, B) - Math.min(R, G, B) <= 2, `${method}: ${R},${G},${B}`);
  }
  const wp = solid(10, 10, [240, 230, 200]);
  const r = (await run('white-balance', wp, { method: 'whitepatch' })).image;
  assert.deepEqual(pixel(r, 5, 5), [240, 240, 240]);
});

test('unsharp mask raises edge contrast and leaves flat areas alone', async () => {
  const edge = AD.img.mapRGB(fromFn(60, 20, x => (x < 30 ? 60 : 180)), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 1.5));
  const r = (await run('unsharp-mask', edge, { radius: 2, amount: 1.5, threshold: 0, target: 'rgb' })).image;
  const slope = d => pixel(d, 31, 10)[0] - pixel(d, 28, 10)[0];
  assert.ok(slope(r) > slope(edge) * 1.3, `edge slope ${slope(edge)} -> ${slope(r)}`);
  assert.equal(pixel(r, 5, 10)[0], pixel(edge, 5, 10)[0]);
  assert.equal(pixel(r, 55, 10)[0], pixel(edge, 55, 10)[0]);
});

test('threshold with Otsu separates two classes', async () => {
  const img = fromFn(40, 20, x => (x < 20 ? 40 : 190));
  const r = await run('threshold', addNoise(img, 5), { method: 'otsu' });
  assert.ok(r.readout.Threshold > 60 && r.readout.Threshold < 170);
  assert.equal(pixel(r.image, 5, 5)[0], 0); assert.equal(pixel(r.image, 35, 5)[0], 255);
});

test('exposure +1 EV doubles linear light', async () => {
  const r = (await run('exposure-gamma', solid(4, 4, [100, 100, 100]), { exposure: 1, gamma: 1 })).image;
  const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  assert.ok(Math.abs(lin(pixel(r, 0, 0)[0]) / lin(100) - 2) < 0.03);
});

test('margin filters are identical striped and whole', async () => {
  const img = addNoise(testImage(64, 48), 10);
  for (const [id, params] of [['unsharp-mask', { radius: 2 }], ['laplacian-sharpen', {}], ['high-pass', { radius: 3 }]]) {
    const def = AD.filters.get(id), p = { ...AD.defaultParams(def, img), ...params }, m = def.margin(p, {});
    const whole = (await run(id, img, params)).image, a = 10, b = 30;
    const y0 = Math.max(0, a - m), y1 = Math.min(48, b + m);
    const strip = new ImageData(img.data.slice(y0 * 64 * 4, y1 * 64 * 4), 64, y1 - y0);
    const part = (await run(id, strip, params)).image;
    for (let y = a; y < b; y++) for (let x = 0; x < 64; x++) assert.deepEqual(pixel(part, x, y - y0), pixel(whole, x, y), `${id} at ${x},${y}`);
  }
});

test('every adjust filter runs on tiny and flat images', async () => {
  for (const id of ['levels', 'curves', 'brightness-contrast', 'exposure-gamma', 'invert', 'threshold', 'histogram-equalization', 'clahe', 'retinex', 'shadows-highlights', 'white-balance', 'color-balance', 'saturation', 'unsharp-mask', 'laplacian-sharpen', 'high-pass']) {
    for (const img of [testImage(1, 1), testImage(2, 3), solid(9, 7, [0, 0, 0]), solid(9, 7, [255, 255, 255])]) {
      const r = await run(id, img);
      for (let i = 0; i < r.image.data.length; i++) assert.ok(Number.isFinite(r.image.data[i]));
    }
  }
});
