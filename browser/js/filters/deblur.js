// Deblurring: deconvolution with a known or estimated point-spread function (PSF).
// Methods: Wiener, Tikhonov (Laplacian-regularised) and Richardson-Lucy. All work on mirror-padded FFT tiles so
// image borders do not ring.
(function (root) {
  const AD = root.AD;
  const F = AD.fft;
  const DB = AD.deblur = {};

  // ---------------------------------------------------------------- PSFs ({ k: Float64Array, size } , odd size, sums to 1)
  const blank = r => { const size = 2 * Math.ceil(r) + 3; return { k: new Float64Array(size * size), size }; };
  const normalise = psf => { let s = 0; for (const v of psf.k) s += v; if (s > 0) for (let i = 0; i < psf.k.length; i++) psf.k[i] /= s; else psf.k[(psf.size * psf.size) >> 1] = 1; return psf; };
  const splat = (psf, x, y, wgt) => {   // bilinear deposit at offset (x, y) from the centre
    const c = (psf.size - 1) / 2, fx = x + c, fy = y + c, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    for (const [xx, yy, ww] of [[x0, y0, (1 - ax) * (1 - ay)], [x0 + 1, y0, ax * (1 - ay)], [x0, y0 + 1, (1 - ax) * ay], [x0 + 1, y0 + 1, ax * ay]]) {
      if (xx >= 0 && yy >= 0 && xx < psf.size && yy < psf.size) psf.k[yy * psf.size + xx] += ww * wgt;
    }
  };

  DB.psfDisk = r => {
    r = Math.max(0, r);
    const psf = blank(r), c = (psf.size - 1) / 2, ss = 5;
    if (r < 0.5) { psf.k[c * psf.size + c] = 1; return psf; }
    for (let y = 0; y < psf.size; y++) for (let x = 0; x < psf.size; x++) {   // supersampled coverage
      let inside = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const dx = x - c + (sx + 0.5) / ss - 0.5, dy = y - c + (sy + 0.5) / ss - 0.5;
        if (dx * dx + dy * dy <= r * r) inside++;
      }
      psf.k[y * psf.size + x] = inside;
    }
    return normalise(psf);
  };

  DB.psfGauss = s => {
    s = Math.max(0.05, s);
    const psf = blank(3 * s), c = (psf.size - 1) / 2;
    for (let y = 0; y < psf.size; y++) for (let x = 0; x < psf.size; x++) psf.k[y * psf.size + x] = Math.exp(-((x - c) ** 2 + (y - c) ** 2) / (2 * s * s));
    return normalise(psf);
  };

  // Uniform motion along a line of the given length (px) and angle (degrees, image y axis pointing down).
  DB.psfLine = (len, angleDeg) => {
    len = Math.max(0, len);
    const psf = blank(len / 2 + 1), a = angleDeg * Math.PI / 180, n = Math.max(2, Math.ceil(len * 8));
    if (len < 1) { psf.k[((psf.size * psf.size) >> 1)] = 1; return psf; }
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n - 0.5; splat(psf, Math.cos(a) * t * len, Math.sin(a) * t * len, 1); }
    return normalise(psf);
  };

  // Motion along an arbitrary path (points in image px), centred on the path's centroid.
  DB.psfPath = pts => {
    if (!pts || pts.length < 2) return DB.psfLine(0, 0);
    let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (L < 1) return DB.psfLine(0, 0);
    // centroid by arc length
    let cx = 0, cy = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); cx += (pts[i].x + pts[i - 1].x) / 2 * l; cy += (pts[i].y + pts[i - 1].y) / 2 * l; }
    cx /= L; cy /= L;
    let r = 0; for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    const psf = blank(r + 1);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(2, Math.ceil(l * 8));
      for (let j = 0; j < n; j++) { const t = (j + 0.5) / n; splat(psf, a.x + (b.x - a.x) * t - cx, a.y + (b.y - a.y) * t - cy, l / n); }
    }
    return normalise(psf);
  };

  // ---------------------------------------------------------------- frequency-domain helpers
  const LAPLACE = { k: Float64Array.from([0, -1, 0, -1, 4, -1, 0, -1, 0]), size: 3 };

  // Circular convolution of a plane with a PSF on a mirror-padded tile (used for samples and tests).
  DB.convolve = (plane, w, h, psf) => {
    const spec = F.forward(plane, w, h, { pad: 'mirror', minPad: psf.size });
    const otf = F.psfToOTF(psf.k, psf.size, psf.size, spec.W, spec.H);
    for (let i = 0; i < spec.re.length; i++) {
      const a = spec.re[i], b = spec.im[i], c = otf.re[i], d = otf.im[i];
      spec.re[i] = a * c - b * d; spec.im[i] = a * d + b * c;
    }
    return F.inverse(spec);
  };

  // Wiener / Tikhonov in place on a spectrum: X = conj(H) G / (|H|^2 + K |R|^2), R = 1 (Wiener) or Laplacian.
  function regularisedInverse(spec, otf, K, reg) {
    for (let i = 0; i < spec.re.length; i++) {
      const c = otf.re[i], d = otf.im[i], h2 = c * c + d * d, r2 = reg ? reg.re[i] * reg.re[i] + reg.im[i] * reg.im[i] : 1;
      const den = h2 + K * r2, a = spec.re[i], b = spec.im[i];
      spec.re[i] = (a * c + b * d) / den; spec.im[i] = (b * c - a * d) / den;
    }
  }

  // Richardson-Lucy on the padded tile. Returns a w*h Float32Array.
  async function richardsonLucy(plane, w, h, psf, iterations, ctx, label) {
    const W = F.nextPow2(w + psf.size), H = F.nextPow2(h + psf.size);
    const g = F.pad(plane, w, h, W, H, 'mirror');
    for (let i = 0; i < g.length; i++) g[i] = Math.max(g[i], 0) + 1;   // RL needs positive data
    const otf = await ctx.memo(`otf:${W}x${H}`, () => F.psfToOTF(psf.k, psf.size, psf.size, W, H));
    let u = Float64Array.from(g);
    const re = new Float64Array(W * H), im = new Float64Array(W * H);
    const conv = (src, conj) => {
      re.set(src); im.fill(0);
      F.fft2d(re, im, W, H, false);
      for (let i = 0; i < re.length; i++) {
        const a = re[i], b = im[i], c = otf.re[i], d = conj ? -otf.im[i] : otf.im[i];
        re[i] = a * c - b * d; im[i] = a * d + b * c;
      }
      F.fft2d(re, im, W, H, true);
      return re;
    };
    const ratio = new Float64Array(W * H);
    for (let it = 0; it < iterations; it++) {
      const est = conv(u, false);
      for (let i = 0; i < ratio.length; i++) ratio[i] = g[i] / Math.max(est[i], 1e-3);
      const corr = conv(ratio, true);
      for (let i = 0; i < u.length; i++) u[i] *= Math.max(0, corr[i]);
      ctx.progress((it + 1) / iterations, label);
      await ctx.checkpoint();
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = u[y * W + x] - 1;
    return out;
  }

  // Deconvolve one plane with the chosen method.
  DB.deconvolvePlane = async (plane, w, h, psf, p, ctx, label) => {
    if (p.method === 'rl') return richardsonLucy(plane, w, h, psf, Math.round(p.iterations), ctx, label);
    const spec = F.forward(plane, w, h, { pad: 'mirror', minPad: psf.size });
    const otf = await ctx.memo(`otf:${spec.W}x${spec.H}`, () => F.psfToOTF(psf.k, psf.size, psf.size, spec.W, spec.H));
    const reg = p.method === 'tikhonov' ? await ctx.memo(`lap:${spec.W}x${spec.H}`, () => F.psfToOTF(LAPLACE.k, 3, 3, spec.W, spec.H)) : null;
    regularisedInverse(spec, otf, Math.pow(10, -p.snr / 10), reg);
    await ctx.checkpoint();
    return F.inverse(spec);
  };

  async function deconvolve(input, psf, p, ctx, label) {
    const { width: w, height: h } = input;
    if (p.channels === 'rgb') {
      const P = AD.img.toPlanes(input), out = { w, h };
      for (const c of ['r', 'g', 'b']) out[c] = await DB.deconvolvePlane(P[c], w, h, psf, p, ctx, `${label} (${c.toUpperCase()})`);
      return AD.img.fromPlanes(out);
    }
    const ycc = AD.img.toYCbCr(input);
    ycc.y = await DB.deconvolvePlane(ycc.y, w, h, psf, p, ctx, label);
    return AD.img.fromYCbCr(ycc);
  }

  // ---------------------------------------------------------------- blur estimation
  // Centre crop (power-of-two square), Hann-windowed, of the luma plane.
  function windowedCrop(input, maxN = 512) {
    const Y = AD.img.luma(input), { width: w, height: h } = input;
    let N = 1; while (N * 2 <= Math.min(w, h, maxN)) N *= 2;
    const x0 = (w - N) >> 1, y0 = (h - N) >> 1, re = new Float64Array(N * N), im = new Float64Array(N * N);
    let mean = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mean += Y[(y0 + y) * w + x0 + x];
    mean /= N * N;
    for (let y = 0; y < N; y++) {
      const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / N);
      for (let x = 0; x < N; x++) re[y * N + x] = (Y[(y0 + y) * w + x0 + x] - mean) * wy * (0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / N));
    }
    return { re, im, N };
  }

  // Real cepstrum of the windowed luma crop (IFFT of the log magnitude spectrum), as an N*N array.
  function cepstrum(input) {
    const { re, im, N } = windowedCrop(input);
    if (N < 32) return null;
    F.fft2d(re, im, N, N, false);
    for (let i = 0; i < re.length; i++) { re[i] = Math.log(1e-6 + Math.hypot(re[i], im[i])); im[i] = 0; }
    F.fft2d(re, im, N, N, true);
    const at = (x, y) => {   // bilinear, wrapped
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, g = (u, v) => re[(((v % N) + N) % N) * N + (((u % N) + N) % N)];
      return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
    };
    return { re, N, at };
  }

  // Motion blur: a uniform blur of length L along direction θ gives the cepstrum negative peaks at L, 2L, ...
  // along θ. The direction comes from the strongest peak; the length from the first strong peak on that ray.
  DB.estimateMotion = input => {
    const c = cepstrum(input);
    if (!c) return null;
    const { re, N, at } = c, maxR = N / 4;
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -maxR; dy <= maxR; dy++) for (let dx = 0; dx <= maxR; dx++) {
      const r = Math.hypot(dx, dy);
      if (r < 3 || r > maxR || (dx === 0 && dy < 0)) continue;
      const v = re[((dy + N) % N) * N + dx];
      if (v < best) { best = v; bx = dx; by = dy; }
    }
    const th = Math.atan2(by, bx), prof = [];
    for (let r = 0; r <= maxR; r += 0.5) prof.push(at(Math.cos(th) * r, Math.sin(th) * r));
    let len = Math.hypot(bx, by);
    for (let i = 6; i < prof.length - 1; i++) {   // r >= 3
      if (prof[i] < prof[i - 1] && prof[i] <= prof[i + 1] && prof[i] <= 0.5 * best) {
        // parabolic refinement of the minimum
        const a = prof[i - 1], b = prof[i], d = prof[i + 1], den = a - 2 * b + d;
        len = (i + (den > 0 ? 0.5 * (a - d) / den : 0)) * 0.5;
        break;
      }
    }
    let angle = th * 180 / Math.PI;
    if (angle > 90) angle -= 180; if (angle <= -90) angle += 180;
    return { length: len, angle };
  };

  // Defocus: the disk OTF's zeros repeat every 1/(2R) cycles/px, which shows up as a negative ring of radius 2R
  // in the cepstrum. Average the cepstrum around circles and take the deepest ring.
  DB.estimateDefocus = input => {
    const c = cepstrum(input);
    if (!c) return null;
    const { N, at } = c, maxR = N / 4, prof = [];
    for (let r = 0; r <= maxR; r += 0.5) {
      const n = Math.max(16, Math.round(2 * Math.PI * r));
      let s = 0; for (let k = 0; k < n; k++) { const a = Math.PI * 2 * k / n; s += at(Math.cos(a) * r, Math.sin(a) * r); }
      prof.push(s / n);
    }
    // deepest ring first, then the first ring (smallest radius) that is at least half as deep — repeated
    // structure in the scene can produce deeper rings further out
    let deepest = Infinity;
    for (let i = 8; i < prof.length - 1; i++) if (prof[i] < prof[i - 1] && prof[i] <= prof[i + 1]) deepest = Math.min(deepest, prof[i]);
    if (!(deepest < -1e-3)) return null;
    let bi = -1;
    for (let i = 8; i < prof.length - 1; i++) if (prof[i] < prof[i - 1] && prof[i] <= prof[i + 1] && prof[i] <= 0.5 * deepest) { bi = i; break; }
    const a = prof[bi - 1], b = prof[bi], d = prof[bi + 1], den = a - 2 * b + d;
    const r = (bi + (den > 0 ? 0.5 * (a - d) / den : 0)) * 0.5;
    return { radius: r / 2 };
  };

  // ---------------------------------------------------------------- shared parameters
  const METHOD = { id: 'method', label: 'Method', type: 'select', default: 'wiener', options: [
    { value: 'wiener', label: 'Wiener' }, { value: 'tikhonov', label: 'Regularised (smoothness)' }, { value: 'rl', label: 'Richardson–Lucy (iterative)' }] };
  const SNR = { id: 'snr', label: 'Signal-to-noise (dB)', type: 'range', min: 0, max: 50, step: 0.5, default: 20, when: p => p.method !== 'rl', hint: 'Lower = more noise suppression, less sharpening.' };
  const ITER = { id: 'iterations', label: 'Iterations', type: 'range', min: 1, max: 100, step: 1, default: 20, when: p => p.method === 'rl' };
  const CHANNELS = { id: 'channels', label: 'Apply to', type: 'select', default: 'luma', options: [{ value: 'luma', label: 'Luma only (faster, no colour fringes)' }, { value: 'rgb', label: 'Each channel' }] };
  const methodName = p => ({ wiener: 'Wiener', tikhonov: 'Regularised', rl: `Richardson–Lucy × ${Math.round(p.iterations)}` })[p.method];

  // ---------------------------------------------------------------- filters
  AD.registerFilter({
    id: 'optical-deblur', name: 'Optical Deblurring', category: 'Deblurring',
    description: 'Undo out-of-focus blur by deconvolution with a disk (defocus) or Gaussian point-spread function.',
    keywords: ['defocus', 'focus', 'deconvolution', 'wiener', 'sharpen', 'blurred photo'],
    testSample: 'defocus',
    params: [
      { id: 'psf', label: 'Blur shape', type: 'select', default: 'disk', options: [{ value: 'disk', label: 'Disk (defocus)' }, { value: 'gaussian', label: 'Gaussian' }] },
      { id: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 30, step: 0.1, default: 4, unit: 'px', when: p => p.psf === 'disk' },
      { id: 'sigma', label: 'Sigma', type: 'range', min: 0.3, max: 15, step: 0.1, default: 2, unit: 'px', when: p => p.psf === 'gaussian' },
      METHOD, SNR, ITER, CHANNELS,
    ],
    actions: [{ id: 'estimate', label: 'Estimate radius', run: async input => {
      const e = DB.estimateDefocus(input);
      if (!e) throw new Error('no clear defocus ring found in the spectrum (the blur may be Gaussian or too weak)');
      return { psf: 'disk', radius: Math.round(e.radius * 10) / 10 };
    } }],
    async apply(input, p, ctx) {
      const psf = p.psf === 'gaussian' ? DB.psfGauss(p.sigma) : DB.psfDisk(p.radius);
      const out = await deconvolve(input, psf, p, ctx, 'Deblurring');
      return { image: out, readout: { PSF: p.psf === 'gaussian' ? `Gaussian σ ${(p.sigma / ctx.scale).toFixed(1)} px` : `Disk r ${(p.radius / ctx.scale).toFixed(1)} px`, Method: methodName(p) } };
    },
  });

  AD.registerFilter({
    id: 'motion-deblur', name: 'Motion Deblurring', category: 'Deblurring',
    description: 'Undo straight-line motion blur (camera shake or a moving subject) by deconvolution. Set the blur length and direction, or estimate them.',
    keywords: ['motion', 'shake', 'streak', 'deconvolution', 'moving car'],
    testSample: 'motion-blur',
    params: [
      { id: 'length', label: 'Blur length', type: 'range', min: 1, max: 120, step: 0.5, default: 21, unit: 'px' },
      { id: 'angle', label: 'Direction', type: 'range', min: -90, max: 90, step: 0.5, default: 8, unit: '°', hint: '0° = horizontal, positive = clockwise (image y points down).' },
      METHOD, SNR, ITER, CHANNELS,
    ],
    actions: [{ id: 'estimate', label: 'Estimate blur', run: async input => {
      const e = DB.estimateMotion(input);
      if (!e) throw new Error('image too small to estimate');
      return { length: Math.round(e.length * 2) / 2, angle: Math.round(e.angle * 2) / 2 };
    } }],
    async apply(input, p, ctx) {
      const psf = DB.psfLine(p.length, p.angle);
      const out = await deconvolve(input, psf, p, ctx, 'Deblurring');
      return { image: out, readout: { PSF: `Line ${(p.length / ctx.scale).toFixed(1)} px at ${p.angle}°`, Method: methodName(p) } };
    },
  });

  AD.registerFilter({
    id: 'nonlinear-deblur', name: 'Path Deblurring', category: 'Deblurring',
    description: 'Undo blur along a curved or uneven path: trace the streak left by a small bright point (lamp, reflection) on the image, and that path is used as the blur shape.',
    keywords: ['nonlinear', 'variable motion', 'curved', 'streak', 'trace'],
    testSample: 'motion-blur',
    params: [
      { id: 'path', label: 'Blur path', type: 'points', min: 2, max: 32, shape: 'polyline',
        default: inp => [{ x: inp.width / 2 - 10, y: inp.height / 2 - 1.5 }, { x: inp.width / 2 + 10, y: inp.height / 2 + 1.5 }],
        hint: 'Click along the streak from one end to the other; double-click a point to remove it.' },
      METHOD, SNR, ITER, CHANNELS,
    ],
    async apply(input, p, ctx) {
      const psf = DB.psfPath(p.path);
      const out = await deconvolve(input, psf, p, ctx, 'Deblurring');
      const overlay = [];
      if (p.path && p.path.length > 1) overlay.push({ type: 'poly', points: p.path, color: 'warn', dash: true, label: 'blur path' });
      let L = 0; for (let i = 1; i < (p.path || []).length; i++) L += Math.hypot(p.path[i].x - p.path[i - 1].x, p.path[i].y - p.path[i - 1].y);
      return { image: out, overlay, readout: { 'Path length': `${(L / ctx.scale).toFixed(1)} px`, 'PSF size': `${psf.size}×${psf.size}`, Method: methodName(p) } };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
