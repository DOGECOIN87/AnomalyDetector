// Node test environment: loads the shared libraries, registry, engine and any filter files into this process
// with an ImageData polyfill, so filters can be unit-tested with `node --test test/unit/`.
//
//   import { AD, load, run, makeCtx, makeEngine, solid, psnr } from '../env.mjs';
//   load('filters/adjust.js');
//   const out = await run('levels', input, { black: 10 });
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else {
        if (!(a instanceof Uint8ClampedArray)) throw new TypeError('ImageData data must be a Uint8ClampedArray');
        this.data = a; this.width = b; this.height = c !== undefined ? c : a.length / 4 / b;
        if (this.width * this.height * 4 !== a.length) throw new RangeError('ImageData size mismatch');
      }
    }
  };
}

const loaded = new Set();
export function load(rel) {
  if (loaded.has(rel)) return;
  loaded.add(rel);
  vm.runInThisContext(fs.readFileSync(path.join(JS, rel), 'utf8'), { filename: path.join(JS, rel) });
}

for (const f of ['lib/img.js', 'lib/fft.js', 'lib/geom.js', 'lib/gpu.js', 'registry.js', 'engine.js']) load(f);
export const AD = globalThis.AD;

// A ctx like the engine's, backed by an array of frames (the step's input frames).
export function makeCtx({ frames = [], frameIndex = 0, scale = 1, fps = 25, originals = frames } = {}) {
  const memo = new Map(), n = Math.max(1, frames.length);
  const pick = (arr, i) => arr[Math.max(0, Math.min(arr.length - 1, i | 0))];
  return {
    frameIndex, frameCount: n, inputFrameCount: n, fps, scale, stepIndex: 0,
    input: async i => pick(frames, i),
    original: async i => pick(originals, i),
    memo: (key, fn) => { if (!memo.has(key)) memo.set(key, Promise.resolve().then(fn)); return memo.get(key); },
    checkpoint: async () => {},
    progress: () => {},
    log: () => {},
  };
}

// Run filter `id` with its default parameters overridden by `params`. Returns { image, overlay, readout }.
// `frames` (optional) are all input frames for temporal filters; `input` is frame `frameIndex`.
export async function run(id, input, params = {}, { frames, frameIndex = 0, scale = 1, fps = 25, gpu = false } = {}) {
  const def = AD.filters.get(id);
  if (!def) throw new Error(`filter ${id} is not registered (did you load() its file?)`);
  frames = frames || [input];
  const info = { frameCount: frames.length, fps };
  const p = AD.scaleParams(def, { ...AD.defaultParams(def, { width: input.width, height: input.height }, info), ...params }, scale);
  const ctx = makeCtx({ frames, frameIndex, scale, fps });
  if (def.frameCount) ctx.frameCount = def.frameCount(frames.length, p);
  const before = input.data.slice();
  const out = await (gpu && def.gpu ? def.gpu(input, p, ctx) : def.apply(def.frameCount ? null : input, p, ctx));
  const r = out instanceof ImageData ? { image: out } : out;
  if (!r || !(r.image instanceof ImageData)) throw new Error(`${id} returned no image`);
  if (r.image === input) throw new Error(`${id} returned its input object`);
  for (let i = 0; i < before.length; i++) if (before[i] !== input.data[i]) throw new Error(`${id} mutated its input`);
  for (let i = 3; i < r.image.data.length; i += 4) if (r.image.data[i] !== 255) throw new Error(`${id} output alpha is not 255 at pixel ${(i - 3) / 4}`);
  return r;
}

// The real engine over in-memory frames.
export function makeEngine(frames, { fps = 25 } = {}) {
  const e = new AD.Engine({ fetchFrame: async (i, s) => {
    const f = frames[i];
    return s === 1 ? f : AD.img.resize(f, Math.max(1, Math.round(f.width * s)), Math.max(1, Math.round(f.height * s)));
  } });
  e.setSource({ id: 'test', frameCount: frames.length, fps, width: frames[0].width, height: frames[0].height });
  return e;
}

// ---------- helpers for building inputs and comparing outputs ----------
export function solid(w, h, [r, g, b] = [128, 128, 128]) {
  const d = new ImageData(w, h);
  for (let i = 0; i < d.data.length; i += 4) { d.data[i] = r; d.data[i + 1] = g; d.data[i + 2] = b; d.data[i + 3] = 255; }
  return d;
}

// Build from a function (x, y) -> [r, g, b] or a single grey number.
export function fromFn(w, h, fn) {
  const d = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y), i = (y * w + x) * 4;
    if (typeof v === 'number') { d.data[i] = d.data[i + 1] = d.data[i + 2] = v; }
    else { d.data[i] = v[0]; d.data[i + 1] = v[1]; d.data[i + 2] = v[2]; }
    d.data[i + 3] = 255;
  }
  return d;
}

// A deterministic textured test image (gradients, edges, text-like strokes).
export function testImage(w = 128, h = 96, seed = 1) {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const blobs = Array.from({ length: 6 }, () => [r() * w, r() * h, 6 + r() * 18, [r() * 255, r() * 255, r() * 255]]);
  return fromFn(w, h, (x, y) => {
    let c = [60 + 120 * x / w, 80 + 100 * y / h, 140 - 60 * x / w];
    if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0 && y > h * 0.6) c = c.map(v => v * 0.6);
    for (const [bx, by, br, col] of blobs) if ((x - bx) ** 2 + (y - by) ** 2 < br * br) c = col;
    if (x % 23 === 5 && y < h * 0.5) c = [20, 20, 20];
    return c;
  });
}

export function addNoise(d, sigma, seed = 3) {
  let s = seed;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const out = new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] += n() * sigma; out.data[i + 1] += n() * sigma; out.data[i + 2] += n() * sigma; }
  return out;
}

export function mse(a, b, { border = 0 } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let s = 0, n = 0;
  for (let y = border; y < a.height - border; y++) for (let x = border; x < a.width - border; x++) {
    const i = (y * a.width + x) * 4;
    for (let c = 0; c < 3; c++) { const d = a.data[i + c] - b.data[i + c]; s += d * d; n++; }
  }
  return s / n;
}
export const psnr = (a, b, o) => { const m = mse(a, b, o); return m === 0 ? Infinity : 10 * Math.log10(255 * 255 / m); };
export const pixel = (d, x, y) => { const i = (y * d.width + x) * 4; return [d.data[i], d.data[i + 1], d.data[i + 2]]; };
