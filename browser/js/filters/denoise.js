// Denoise: spatial noise reduction and compression-artefact removal.
// Every local filter declares `margin` so the engine can split it across CPU workers (results are identical).
(function (root) {
  const AD = root.AD;
  const DN = AD.denoise = {};
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---------------------------------------------------------------- median (Huang sliding histogram)
  DN.median = (plane, w, h, r) => {
    const out = new Float32Array(w * h), q = new Uint8Array(w * h), hist = new Int32Array(256);
    for (let i = 0; i < q.length; i++) q[i] = clamp(Math.round(plane[i]), 0, 255);
    const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const row = clamp(y + dy, 0, h - 1) * w;
        for (let dx = -r; dx <= r; dx++) hist[q[row + clamp(dx, 0, w - 1)]]++;
      }
      let m = 0, lt = 0;
      while (lt + hist[m] <= half) { lt += hist[m]; m++; }
      out[y * w] = m;
      for (let x = 1; x < w; x++) {
        const xo = clamp(x - r - 1, 0, w - 1), xi = clamp(x + r, 0, w - 1);
        for (let dy = -r; dy <= r; dy++) {
          const row = clamp(y + dy, 0, h - 1) * w, vo = q[row + xo], vi = q[row + xi];
          hist[vo]--; if (vo < m) lt--;
          hist[vi]++; if (vi < m) lt++;
        }
        while (lt > half) { m--; lt -= hist[m]; }
        while (lt + hist[m] <= half) { lt += hist[m]; m++; }
        out[y * w + x] = m;
      }
    }
    return out;
  };

  // ---------------------------------------------------------------- filters
  AD.registerFilter({
    id: 'gaussian-blur', name: 'Gaussian Blur', category: 'Denoise',
    description: 'Smooth with a Gaussian kernel. Removes fine noise but also softens edges.',
    keywords: ['blur', 'smooth', 'low pass'],
    testSample: 'noisy',
    params: [{ id: 'sigma', label: 'Sigma', type: 'range', min: 0.3, max: 25, step: 0.1, default: 1.5, unit: 'px' }],
    margin: p => Math.ceil(p.sigma * 3) + 1,
    apply(input, p) { return AD.img.mapRGB(input, (pl, w, h) => AD.img.gaussianBlur(pl, w, h, p.sigma)); },
  });

  AD.registerFilter({
    id: 'mean-filter', name: 'Mean Filter', category: 'Denoise',
    description: 'Average each pixel with its square neighbourhood.',
    keywords: ['average', 'box blur'],
    testSample: 'noisy',
    params: [{ id: 'radius', label: 'Radius', type: 'range', min: 1, max: 20, step: 1, default: 1, unit: 'px' }],
    margin: p => Math.ceil(p.radius) + 1,
    apply(input, p) { const r = Math.max(1, Math.round(p.radius)); return AD.img.mapRGB(input, (pl, w, h) => AD.img.boxBlur(pl, w, h, r)); },
  });

  AD.registerFilter({
    id: 'median', name: 'Median Filter', category: 'Denoise',
    description: 'Replace each pixel by the median of its neighbourhood. Removes specks and impulse noise while keeping edges sharper than averaging.',
    keywords: ['salt and pepper', 'impulse', 'speckle'],
    testSample: 'noisy',
    params: [{ id: 'radius', label: 'Radius', type: 'range', min: 1, max: 15, step: 1, default: 2, unit: 'px' }],
    margin: p => Math.ceil(p.radius) + 1,
    apply(input, p) { const r = Math.max(1, Math.round(p.radius)); return AD.img.mapRGB(input, (pl, w, h) => DN.median(pl, w, h, r)); },
  });

  AD.registerFilter({
    id: 'adaptive-median', name: 'Adaptive Median', category: 'Denoise',
    description: 'For salt-and-pepper noise: only pixels detected as impulses (window minimum or maximum) are replaced; the window grows until a reliable median is found.',
    keywords: ['salt and pepper', 'impulse', 'dead pixels'],
    testSample: 'salt-pepper',
    params: [{ id: 'maxRadius', label: 'Largest window radius', type: 'range', min: 1, max: 5, step: 1, default: 3 }],
    margin: p => Math.round(p.maxRadius) + 1,
    apply(input, p) {
      const R = Math.max(1, Math.round(p.maxRadius)), buf = new Float32Array((2 * R + 1) ** 2);
      return AD.img.mapRGB(input, (pl, w, h) => {
        const out = new Float32Array(pl.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const z = pl[y * w + x];
          let res = z;
          for (let r = 1; r <= R; r++) {
            let n = 0;
            for (let dy = -r; dy <= r; dy++) {
              const row = clamp(y + dy, 0, h - 1) * w;
              for (let dx = -r; dx <= r; dx++) {   // insertion sort as we go: windows are at most 11x11
                const v = pl[row + clamp(x + dx, 0, w - 1)];
                let k = n++;
                while (k > 0 && buf[k - 1] > v) { buf[k] = buf[k - 1]; k--; }
                buf[k] = v;
              }
            }
            const mn = buf[0], mx = buf[n - 1], med = buf[n >> 1];
            if (mn < med && med < mx) { res = mn < z && z < mx ? z : med; break; }
            res = med;
          }
          out[y * w + x] = res;
        }
        return out;
      });
    },
  });

  // Separable bilateral (Pham & van Vliet 2005): a horizontal then a vertical 1-D bilateral pass with a joint
  // colour range kernel. Much faster than the full 2-D filter and visually very close.
  AD.registerFilter({
    id: 'bilateral', name: 'Bilateral Filter', category: 'Denoise',
    description: 'Edge-preserving smoothing: neighbours are averaged only if they are close in both position and colour. Separable approximation (horizontal then vertical pass).',
    keywords: ['edge preserving', 'smooth', 'skin'],
    testSample: 'noisy',
    params: [
      { id: 'sigmaS', label: 'Spatial sigma', type: 'range', min: 0.5, max: 12, step: 0.1, default: 3, unit: 'px' },
      { id: 'sigmaR', label: 'Range sigma (colour difference)', type: 'range', min: 2, max: 100, step: 1, default: 30 },
    ],
    margin: p => 2 * Math.ceil(p.sigmaS * 2.5) + 1,
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, r = Math.max(1, Math.ceil(p.sigmaS * 2.5));
      const ws = new Float32Array(2 * r + 1); for (let k = -r; k <= r; k++) ws[k + r] = Math.exp(-(k * k) / (2 * p.sigmaS * p.sigmaS));
      const wr = new Float32Array(3 * 256 * 256 + 1), inv = 1 / (2 * p.sigmaR * p.sigmaR);
      for (let d = 0; d < wr.length; d++) wr[d] = Math.exp(-d / 3 * inv);   // d = squared RGB distance summed over 3 channels
      const pass = (src, horizontal) => {
        const dst = new Float32Array(src.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3, r0 = src[i], g0 = src[i + 1], b0 = src[i + 2];
          let sr = 0, sg = 0, sb = 0, sw = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horizontal ? clamp(x + k, 0, w - 1) : x, yy = horizontal ? y : clamp(y + k, 0, h - 1), j = (yy * w + xx) * 3;
            const dr = src[j] - r0, dg = src[j + 1] - g0, db = src[j + 2] - b0;
            const wgt = ws[k + r] * wr[Math.min(wr.length - 1, Math.round(dr * dr + dg * dg + db * db))];
            sr += src[j] * wgt; sg += src[j + 1] * wgt; sb += src[j + 2] * wgt; sw += wgt;
          }
          dst[i] = sr / sw; dst[i + 1] = sg / sw; dst[i + 2] = sb / sw;
        }
        return dst;
      };
      const src = new Float32Array(w * h * 3), d = input.data;
      for (let j = 0, i = 0; j < w * h; j++, i += 4) { src[j * 3] = d[i]; src[j * 3 + 1] = d[i + 1]; src[j * 3 + 2] = d[i + 2]; }
      const a = pass(src, true); await ctx.checkpoint();
      const b = pass(a, false);
      const out = new ImageData(w, h);
      for (let j = 0, i = 0; j < w * h; j++, i += 4) { out.data[i] = b[j * 3]; out.data[i + 1] = b[j * 3 + 1]; out.data[i + 2] = b[j * 3 + 2]; out.data[i + 3] = 255; }
      return out;
    },
  });

  // Non-local means with integral images over each search offset (Darbon et al. 2008). Patch distances are
  // computed on luma; the colour channels are averaged with the resulting weights.
  AD.registerFilter({
    id: 'nl-means', name: 'Non-local Means', category: 'Denoise',
    description: 'Averages pixels whose surrounding patches look alike, wherever they are in the search window. Removes noise while keeping texture and edges; slower than the other filters.',
    keywords: ['nlm', 'patch', 'denoise', 'noise reduction'],
    testSample: 'noisy',
    params: [
      { id: 'h', label: 'Strength (h)', type: 'range', min: 1, max: 60, step: 0.5, default: 14, hint: 'Roughly the noise standard deviation in 0–255 levels.' },
      { id: 'patch', label: 'Patch radius', type: 'range', min: 1, max: 4, step: 1, default: 2 },
      { id: 'search', label: 'Search radius', type: 'range', min: 2, max: 12, step: 1, default: 5 },
    ],
    margin: p => Math.round(p.search) + Math.round(p.patch) + 1,
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, n = w * h, d = input.data, P = Math.round(p.patch), S = Math.round(p.search);
      const Y = AD.img.luma(input), R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
      for (let j = 0, i = 0; j < n; j++, i += 4) { R[j] = d[i]; G[j] = d[i + 1]; B[j] = d[i + 2]; }
      const acc = new Float64Array(n * 3), wsum = new Float64Array(n), wmax = new Float32Array(n);
      const W = w + 1, I = new Float64Array(W * (h + 1)), D = new Float32Array(n);
      const h2 = p.h * p.h, sig2 = 2 * (p.h * 0.6) ** 2;   // subtract the expected distance from noise (Buades)
      let done = 0;
      for (let dy = -S; dy <= S; dy++) {
        for (let dx = -S; dx <= S; dx++) {
          if (dx === 0 && dy === 0) continue;
          for (let y = 0; y < h; y++) {
            const yy = clamp(y + dy, 0, h - 1);
            for (let x = 0; x < w; x++) { const t = Y[y * w + x] - Y[yy * w + clamp(x + dx, 0, w - 1)]; D[y * w + x] = t * t; }
          }
          for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += D[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs; } }
          for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - P), y1 = Math.min(h, y + P + 1), yy = clamp(y + dy, 0, h - 1);
            for (let x = 0; x < w; x++) {
              const x0 = Math.max(0, x - P), x1 = Math.min(w, x + P + 1);
              const dist = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
              const wgt = Math.exp(-Math.max(0, dist - sig2) / h2);
              const j = y * w + x, k = yy * w + clamp(x + dx, 0, w - 1);
              acc[j * 3] += wgt * R[k]; acc[j * 3 + 1] += wgt * G[k]; acc[j * 3 + 2] += wgt * B[k];
              wsum[j] += wgt; if (wgt > wmax[j]) wmax[j] = wgt;
            }
          }
          done++;
          ctx.progress(done / ((2 * S + 1) ** 2 - 1));
          await ctx.checkpoint();
        }
      }
      const out = new ImageData(w, h), o = out.data;
      for (let j = 0, i = 0; j < n; j++, i += 4) {
        const self = wmax[j] || 1, ws = wsum[j] + self;   // the centre pixel gets the largest weight seen
        o[i] = (acc[j * 3] + self * R[j]) / ws; o[i + 1] = (acc[j * 3 + 1] + self * G[j]) / ws; o[i + 2] = (acc[j * 3 + 2] + self * B[j]) / ws; o[i + 3] = 255;
      }
      return out;
    },
  });

  // Ramponi's rational filter: in each of four directions, smooth with a weight that falls off with the
  // difference across the centre, so edges (large differences) are left alone.
  AD.registerFilter({
    id: 'rational-filter', name: 'Rational Filter', category: 'Denoise',
    description: 'Edge-preserving rational smoothing (Ramponi): smooths along directions where the neighbours agree and leaves edges intact.',
    keywords: ['ramponi', 'edge preserving', 'smoothing'],
    testSample: 'noisy',
    params: [
      { id: 'amount', label: 'Smoothing per pass', type: 'range', min: 0.02, max: 0.25, step: 0.01, default: 0.2 },
      { id: 'edge', label: 'Edge sensitivity', type: 'range', min: 0.1, max: 20, step: 0.1, default: 3, hint: 'Higher keeps weaker edges.' },
      { id: 'iterations', label: 'Passes', type: 'range', min: 1, max: 10, step: 1, default: 3 },
    ],
    margin: p => Math.round(p.iterations) + 1,
    apply(input, p) {
      const k = p.edge / 1000, lam = p.amount;
      return AD.img.mapRGB(input, (pl, w, h) => {
        let cur = Float32Array.from(pl);
        for (let it = 0; it < Math.round(p.iterations); it++) {
          const nxt = new Float32Array(cur.length);
          for (let y = 0; y < h; y++) {
            const yu = clamp(y - 1, 0, h - 1) * w, yd = clamp(y + 1, 0, h - 1) * w, yc = y * w;
            for (let x = 0; x < w; x++) {
              const xl = clamp(x - 1, 0, w - 1), xr = clamp(x + 1, 0, w - 1), c = cur[yc + x];
              let s = 0;
              for (const [a, b] of [[cur[yc + xl], cur[yc + xr]], [cur[yu + x], cur[yd + x]], [cur[yu + xl], cur[yd + xr]], [cur[yu + xr], cur[yd + xl]]]) {
                const diff = a - b;
                s += (a + b - 2 * c) / (k * diff * diff + 1);
              }
              nxt[yc + x] = c + lam * s;
            }
          }
          cur = nxt;
        }
        return cur;
      });
    },
  });

  AD.registerFilter({
    id: 'anisotropic-diffusion', name: 'Anisotropic Diffusion', category: 'Denoise',
    description: 'Perona–Malik diffusion: repeatedly smooths, but conduction stops across strong edges. Conduction is computed from luma so colours stay aligned.',
    keywords: ['perona malik', 'edge preserving', 'diffusion'],
    testSample: 'noisy',
    params: [
      { id: 'iterations', label: 'Iterations', type: 'range', min: 1, max: 40, step: 1, default: 10 },
      { id: 'kappa', label: 'Edge threshold (κ)', type: 'range', min: 2, max: 80, step: 1, default: 20 },
      { id: 'func', label: 'Conduction', type: 'select', default: 'exp', options: [{ value: 'exp', label: 'exp(−(∇/κ)²) — favours high-contrast edges' }, { value: 'rational', label: '1/(1+(∇/κ)²) — favours wide regions' }] },
    ],
    margin: p => Math.round(p.iterations) + 1,
    apply(input, p) {
      const { width: w, height: h } = input, P = AD.img.toPlanes(input), ch = [P.r, P.g, P.b].map(a => Float32Array.from(a));
      const k2 = p.kappa * p.kappa, lam = 0.2, g = p.func === 'exp' ? s => Math.exp(-s / k2) : s => 1 / (1 + s / k2);
      for (let it = 0; it < Math.round(p.iterations); it++) {
        const Y = new Float32Array(w * h);
        for (let i = 0; i < Y.length; i++) Y[i] = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
        const nxt = ch.map(a => new Float32Array(a.length));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x, nb = [y > 0 ? i - w : i, y < h - 1 ? i + w : i, x > 0 ? i - 1 : i, x < w - 1 ? i + 1 : i];
          const cs = nb.map(j => { const t = Y[j] - Y[i]; return g(t * t); });
          for (let c = 0; c < 3; c++) {
            const a = ch[c]; let s = 0;
            for (let q = 0; q < 4; q++) s += cs[q] * (a[nb[q]] - a[i]);
            nxt[c][i] = a[i] + lam * s;
          }
        }
        for (let c = 0; c < 3; c++) ch[c] = nxt[c];
      }
      return AD.img.fromPlanes({ w, h, r: ch[0], g: ch[1], b: ch[2] });
    },
  });

  // ---------------------------------------------------------------- deblocking
  // Mean |step| across block boundaries divided by mean |step| inside blocks (1 = no blocking).
  DN.blockiness = (Y, w, h, B, ox, oy) => {
    let sb = 0, nb = 0, si = 0, ni = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x + 1 < w; x++) {
      const dlt = Math.abs(Y[y * w + x + 1] - Y[y * w + x]);
      if (((x + 1 - ox) % B + B) % B === 0) { sb += dlt; nb++; } else { si += dlt; ni++; }
    }
    for (let y = 0; y + 1 < h; y++) for (let x = 0; x < w; x++) {
      const dlt = Math.abs(Y[(y + 1) * w + x] - Y[y * w + x]);
      if (((y + 1 - oy) % B + B) % B === 0) { sb += dlt; nb++; } else { si += dlt; ni++; }
    }
    return nb && ni ? (sb / nb) / Math.max(si / ni, 0.25) : 1;   // floor avoids dividing by perfectly flat block interiors
  };

  DN.detectGrid = (Y, w, h, B) => {
    const best = (horizontal) => {
      const score = new Float64Array(B), cnt = new Float64Array(B);
      if (horizontal) { for (let y = 0; y < h; y++) for (let x = 0; x + 1 < w; x++) { const k = (x + 1) % B; score[k] += Math.abs(Y[y * w + x + 1] - Y[y * w + x]); cnt[k]++; } }
      else { for (let y = 0; y + 1 < h; y++) for (let x = 0; x < w; x++) { const k = (y + 1) % B; score[k] += Math.abs(Y[(y + 1) * w + x] - Y[y * w + x]); cnt[k]++; } }
      let bi = 0; for (let k = 0; k < B; k++) if (score[k] / (cnt[k] || 1) > score[bi] / (cnt[bi] || 1)) bi = k;
      return bi;
    };
    return { ox: best(true), oy: best(false) };
  };

  AD.registerFilter({
    id: 'deblocking', name: 'Deblocking', category: 'Denoise',
    description: 'Removes the 8×8 (or 16×16) block pattern of heavily compressed JPEG/MPEG images by smoothing across block borders where the step is small compared to real image edges.',
    keywords: ['jpeg', 'mpeg', 'compression', 'artefacts', 'blocks', 'macroblock'],
    testSample: 'jpeg',
    params: [
      { id: 'strength', label: 'Strength', type: 'range', min: 1, max: 60, step: 1, default: 20, hint: 'Largest border step treated as a compression artefact rather than an edge.' },
      { id: 'block', label: 'Block size', type: 'select', default: 8, options: [{ value: 8, label: '8 × 8' }, { value: 16, label: '16 × 16' }] },
      { id: 'ox', label: 'Grid offset X', type: 'range', min: 0, max: 15, step: 1, default: 0 },
      { id: 'oy', label: 'Grid offset Y', type: 'range', min: 0, max: 15, step: 1, default: 0 },
      { id: 'passes', label: 'Passes', type: 'range', min: 1, max: 3, step: 1, default: 1 },
    ],
    actions: [{ id: 'detect', label: 'Detect grid', run: async (input, p) => DN.detectGrid(AD.img.luma(input), input.width, input.height, +p.block) }],
    // No margin: the blockiness readout needs the whole image, and the filter is fast single-threaded.
    apply(input, p, ctx) {
      const { width: w, height: h } = input, B = +p.block, ox = ((p.ox % B) + B) % B, top = ctx && ctx.strip ? ctx.strip.top : 0;
      const oy = ((((p.oy - top) % B) + B) % B);   // grid phase in this strip's own row coordinates
      const ycc = AD.img.toYCbCr(input), planes = [ycc.y, ycc.cb, ycc.cr], Y0 = Float32Array.from(ycc.y);
      const alpha = p.strength, beta = p.strength * 0.35;
      // filter one boundary given the 6 sample indices p2 p1 p0 | q0 q1 q2 (decisions on luma)
      const Yp = planes[0];
      // Filter one border sample: p2 p1 p0 | q0 q1 q2 at base + k*step (k = 0..5); decisions on luma.
      const edge = (base, step) => {
        const ip1 = base + step, ip0 = base + 2 * step, iq0 = base + 3 * step, iq1 = base + 4 * step, iq2 = base + 5 * step;
        const P0 = Yp[ip0], Q0 = Yp[iq0];
        if (Math.abs(Q0 - P0) >= alpha || Math.abs(Yp[ip1] - P0) >= beta || Math.abs(Yp[iq1] - Q0) >= beta) return;
        for (let c = 0; c < 3; c++) {
          const pl = planes[c], p2 = pl[base], p1 = pl[ip1], p0 = pl[ip0], q0 = pl[iq0], q1 = pl[iq1], q2 = pl[iq2];
          pl[ip0] = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) / 8;
          pl[iq0] = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) / 8;
          pl[ip1] = (p2 + p1 + p0 + q0 + 2) / 4;
          pl[iq1] = (p0 + q0 + q1 + q2 + 2) / 4;
        }
      };
      for (let pass = 0; pass < Math.round(p.passes); pass++) {
        for (let x = ox === 0 ? B : ox; x + 2 < w; x += B) {      // vertical borders between columns x-1 | x
          if (x < 3) continue;
          for (let y = 0; y < h; y++) edge(y * w + x - 3, 1);
        }
        for (let y = oy === 0 ? B : oy; y + 2 < h; y += B) {     // horizontal borders between rows y-1 | y
          if (y < 3) continue;
          for (let x = 0; x < w; x++) edge((y - 3) * w + x, w);
        }
      }
      const out = AD.img.fromYCbCr(ycc);
      if (ctx && ctx.strip) return out;
      return { image: out, readout: { 'Blockiness before': DN.blockiness(Y0, w, h, B, ox, oy).toFixed(2), 'Blockiness after': DN.blockiness(ycc.y, w, h, B, ox, oy).toFixed(2), Grid: `${B}×${B} at (${ox}, ${oy})` } };
    },
  });

  // ---------------------------------------------------------------- wavelet (à trous) denoising
  const B3 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  // Noise standard deviation of each à trous detail level for unit white noise (B3 spline).
  const LEVEL_SIGMA = [0.889, 0.2, 0.086, 0.041, 0.02, 0.01];
  function atrousSmooth(pl, w, h, step) {
    const tmp = new Float32Array(pl.length), out = new Float32Array(pl.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -2; k <= 2; k++) s += B3[k + 2] * pl[y * w + clamp(x + k * step, 0, w - 1)];
      tmp[y * w + x] = s;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -2; k <= 2; k++) s += B3[k + 2] * tmp[clamp(y + k * step, 0, h - 1) * w + x];
      out[y * w + x] = s;
    }
    return out;
  }
  DN.waveletDenoise = (pl, w, h, levels, k, sigma) => {
    let c = Float32Array.from(pl);
    const details = [];
    for (let j = 0; j < levels; j++) {
      const s = atrousSmooth(c, w, h, 1 << j), d = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) d[i] = c[i] - s[i];
      details.push(d); c = s;
    }
    if (sigma == null) {   // MAD of the finest detail level
      const step = Math.max(1, Math.floor(details[0].length / 50000)), a = [];
      for (let i = 0; i < details[0].length; i += step) a.push(Math.abs(details[0][i]));
      a.sort((x, y) => x - y);
      sigma = a[a.length >> 1] / 0.6745 / LEVEL_SIGMA[0];
    }
    // BayesShrink threshold per scale (T = σn² / σx, where σx is the signal spread left after removing noise),
    // applied with the non-negative garrote (d − T²/d), which shrinks large (edge) coefficients far less than
    // soft thresholding does.
    for (let j = 0; j < levels; j++) {
      const d = details[j], sn = sigma * LEVEL_SIGMA[j];
      let v2 = 0; for (let i = 0; i < d.length; i++) v2 += d[i] * d[i];
      const sx = Math.sqrt(Math.max(v2 / d.length - sn * sn, 1e-6)), t = k * sn * sn / sx, t2 = t * t;
      for (let i = 0; i < c.length; i++) { const v = d[i]; if (v > t || v < -t) c[i] += v - t2 / v; }
    }
    return { plane: c, sigma };
  };

  AD.registerFilter({
    id: 'wavelet-denoise', name: 'Wavelet Denoise', category: 'Denoise',
    description: 'Splits the image into detail scales (à trous wavelets), estimates the noise level automatically and shrinks small coefficients at each scale. Chroma is denoised more strongly than luma.',
    keywords: ['wavelet', 'bayes', 'noise reduction', 'chroma noise'],
    testSample: 'noisy',
    params: [
      { id: 'strength', label: 'Luma strength', type: 'range', min: 0, max: 4, step: 0.1, default: 1 },
      { id: 'chroma', label: 'Chroma strength', type: 'range', min: 0, max: 6, step: 0.1, default: 1.5 },
      { id: 'levels', label: 'Scales', type: 'range', min: 1, max: 6, step: 1, default: 4 },
    ],
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, ycc = AD.img.toYCbCr(input), L = Math.round(p.levels);
      const y = DN.waveletDenoise(ycc.y, w, h, L, p.strength, null); await ctx.checkpoint();
      ycc.y = y.plane;
      ycc.cb = DN.waveletDenoise(ycc.cb, w, h, L, p.chroma, null).plane; await ctx.checkpoint();
      ycc.cr = DN.waveletDenoise(ycc.cr, w, h, L, p.chroma, null).plane;
      return { image: AD.img.fromYCbCr(ycc), readout: { 'Estimated luma noise σ': y.sigma.toFixed(2) } };
    },
  });

  if (typeof document !== 'undefined') {
    AD.registerSample({ id: 'salt-pepper', name: 'Salt-and-pepper noise', category: 'Denoise', description: '6 % impulse noise',
      make: async () => {
        const d = AD.sampleTools.scene(800, 500, { plate: 'SP 404 ZQ' });
        let s = 17; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < d.data.length; i += 4) { const u = r(); if (u < 0.03) d.data[i] = d.data[i + 1] = d.data[i + 2] = 0; else if (u < 0.06) d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; }
        return d;
      } });
  }
})(typeof window !== 'undefined' ? window : globalThis);
