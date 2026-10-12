import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD, load, run, fromFn, testImage, psnr, pixel } from '../env.mjs';
load('filters/geometry.js');
const G = AD.geometry;

const checker = (w, h, sq = 10) => fromFn(w, h, (x, y) => ((Math.floor(x / sq) + Math.floor(y / sq)) % 2 ? [230, 230, 230] : [30, 30, 30]));

test('rotate by 90° steps is an exact transpose/flip', async () => {
  const img = testImage(13, 7);
  const r = (await run('rotate', img, { angle: 90 })).image;
  assert.equal(r.width, 7); assert.equal(r.height, 13);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 13; x++) assert.deepEqual(pixel(r, 6 - y, x), pixel(img, x, y));
  const back = (await run('rotate', r, { angle: -90 })).image;
  assert.deepEqual(back.data, img.data);
  assert.deepEqual((await run('rotate', img, { angle: 180 })).image.data, (await run('flip', img, { axis: 'both' })).image.data);
});

test('rotate by an arbitrary angle and back is close to identity', async () => {
  const img = AD.img.mapRGB(testImage(80, 60), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 1));
  const a = (await run('rotate', img, { angle: 17, expand: true, interp: 'bicubic' })).image;
  const b = (await run('rotate', a, { angle: -17, expand: true, interp: 'bicubic' })).image;
  const ox = (b.width - 80) >> 1, oy = (b.height - 60) >> 1, crop = AD.img.crop(b, ox, oy, 80, 60);
  assert.ok(psnr(crop, img, { border: 6 }) > 30, psnr(crop, img, { border: 6 }).toFixed(1));
});

test('resize up then down is near identity; downscaling averages', async () => {
  const img = AD.img.mapRGB(testImage(64, 48), (pl, w, h) => AD.img.gaussianBlur(pl, w, h, 0.8));
  for (const kernel of ['bicubic', 'lanczos3']) {
    const up = (await run('resize', img, { percent: 200, kernel })).image;
    assert.equal(up.width, 128);
    const down = (await run('resize', up, { percent: 50, kernel })).image;
    assert.ok(psnr(down, img, { border: 2 }) > 35, `${kernel} ${psnr(down, img, { border: 2 }).toFixed(1)}`);
  }
  // a 1-px checkerboard downscaled 2x must become uniform grey (no aliasing)
  const fine = fromFn(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0));
  const half = (await run('resize', fine, { percent: 50, kernel: 'bilinear' })).image;
  for (let y = 1; y < 31; y++) for (let x = 1; x < 31; x++) assert.ok(Math.abs(pixel(half, x, y)[0] - 128) <= 2, `got ${pixel(half, x, y)[0]} at ${x},${y}`);
});

test('perspective correction rectifies a known homography', async () => {
  const flat = checker(200, 100, 20);
  const quad = [{ x: 60, y: 40 }, { x: 250, y: 70 }, { x: 230, y: 190 }, { x: 40, y: 150 }];
  // render the flat checkerboard onto the quad in a 300x240 frame (pixel-centre coordinates)
  const rect = [{ x: -0.5, y: -0.5 }, { x: 199.5, y: -0.5 }, { x: 199.5, y: 99.5 }, { x: -0.5, y: 99.5 }];
  const toFlat = AD.geom.homography(quad.map(q => ({ x: q.x - 0.5, y: q.y - 0.5 })), rect);
  const scene = AD.geom.warpPerspective(flat, toFlat, 300, 240, 'bicubic', [90, 90, 90]);
  const r = await run('perspective-correction', scene, { quad, size: 'px', outW: 200, outH: 100, interp: 'bicubic' });
  assert.equal(r.image.width, 200); assert.equal(r.image.height, 100);
  const ref = flat;
  assert.ok(psnr(r.image, ref, { border: 4 }) > 24, `psnr ${psnr(r.image, ref, { border: 4 }).toFixed(1)}`);
  // checker squares land in the right place: sample the centres of a few squares
  for (const [cx, cy] of [[30, 30], [110, 50], [170, 70]]) {
    const want = pixel(flat, cx, cy)[0] > 128, got = pixel(r.image, cx, cy)[0] > 128;
    assert.equal(got, want, `square at ${cx},${cy}`);
  }
  // aspect mode: 2:1 real dimensions give a 2:1 output
  const a = await run('perspective-correction', scene, { quad, size: 'aspect', realW: 2, realH: 1 });
  assert.ok(Math.abs(a.image.width / a.image.height - 2) < 0.03);
  await assert.doesNotReject(run('perspective-correction', scene, { quad, whole: true }));
});

test('lens distortion: correcting a known k1 restores straight lines, and the estimate finds k1', async () => {
  const w = 240, h = 180, flat = checker(w, h, 20), k1 = -0.25, p = { k1, k2: 0, k3: 0, p1: 0, p2: 0, cx: 0, cy: 0 };
  const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.hypot(w, h) / 2;
  // distorted photo: pixel d shows the flat point undistort(d)
  const photo = AD.img.warp(flat, w, h, (x, y, t) => { const [ux, uy] = G.undistort((x - cx) / R, (y - cy) / R, p); t[0] = cx + ux * R; t[1] = cy + uy * R; return true; }, 'bicubic', [128, 128, 128]);
  const fixed = (await run('lens-distortion', photo, { ...p, fit: 'none', interp: 'bicubic' })).image;
  assert.ok(psnr(fixed, flat, { border: 30 }) > psnr(photo, flat, { border: 30 }) + 6, `${psnr(photo, flat, { border: 30 }).toFixed(1)} -> ${psnr(fixed, flat, { border: 30 }).toFixed(1)}`);
  // points along straight lines in the flat image, as they appear in the photo
  const along = (pts) => pts.map(([x, y]) => { const [dx, dy] = G.distort((x - cx) / R, (y - cy) / R, p); return { x: cx + dx * R + 0.5, y: cy + dy * R + 0.5 }; });
  const line1 = along([[10, 15], [60, 15], [120, 15], [180, 15], [230, 15]]), line2 = along([[12, 20], [12, 90], [12, 160]]);
  const def = AD.filters.get('lens-distortion');
  const patch = await def.actions[0].run(photo, { ...AD.defaultParams(def, photo), line1, line2 }, {});
  assert.ok(Math.abs(patch.k1 - k1) / Math.abs(k1) < 0.15, `estimated ${patch.k1}`);
  for (const fit of ['fill', 'keep']) await run('lens-distortion', photo, { ...p, fit });
});

test('unroll restores evenly spaced stripes', async () => {
  const w = 300, h = 60, R = 120, cx = 150, period = 20;
  // stripes evenly spaced in arc length, projected orthographically
  const img = fromFn(w, h, x => { const s = (x + 0.5 - cx) / R; if (Math.abs(s) >= 1) return 128; const arc = Math.asin(s) * R; return Math.floor((arc + 1000) / period) % 2 ? 230 : 30; });
  const r = await run('unroll-cylinder', img, { rect: { x: cx - R, y: 0, w: 2 * R, h }, maxAngle: 70, interp: 'bilinear' });
  const row = [...Array(r.image.width)].map((_, x) => pixel(r.image, x, 30)[0] > 128 ? 1 : 0);
  const edges = []; for (let x = 1; x < row.length; x++) if (row[x] !== row[x - 1]) edges.push(x);
  const gaps = edges.slice(1).map((e, i) => e - edges[i]);
  for (const g of gaps) assert.ok(Math.abs(g - period) <= 1.5, `gaps ${gaps}`);
  // the raw image near the silhouette has much smaller gaps
});

test('pixel aspect, canvas size, flip, tiny images', async () => {
  const img = testImage(72, 40);
  assert.equal((await run('pixel-aspect', img, { preset: 'pal43' })).image.width, Math.round(72 * 16 / 15));
  assert.equal((await run('pixel-aspect', img, { preset: 'field' })).image.height, 80);
  const c = (await run('canvas-size', img, { width: 100, height: 50, anchor: 'centre', color: '#ff0000' })).image;
  assert.deepEqual(pixel(c, 0, 0), [255, 0, 0]); assert.deepEqual(pixel(c, 14 + 3, 5 + 3), pixel(img, 3, 3));
  const f = (await run('flip', img, { axis: 'h' })).image; assert.deepEqual(pixel(f, 0, 5), pixel(img, 71, 5));
  for (const id of ['resize', 'rotate', 'flip', 'pixel-aspect', 'perspective-correction', 'lens-distortion', 'unroll-cylinder', 'canvas-size']) {
    for (const [w, h] of [[1, 1], [2, 3]]) await run(id, testImage(w, h));
  }
});
