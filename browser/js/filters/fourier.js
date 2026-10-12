// Frequency domain: spectrum view, periodic-noise notch filtering, frequency filters, homomorphic filtering.
// Spectra are computed on mirror-padded power-of-two tiles. The spectrum is DISPLAYED at the input's size, so a
// point clicked on the displayed spectrum maps to an exact frequency bin (see toBin / toDisplay).
(function (root) {
  const AD = root.AD;
  const F = AD.fft;
  const FR = AD.fourier = {};

  // Display coordinates (continuous, pixel edges at integers, size w*h) <-> centred frequency bins (u, v),
  // where bin 0 is DC and u in [-W/2, W/2).
  FR.toBin = (x, y, w, h, W, H) => ({ u: x * W / w - 0.5 - W / 2, v: y * H / h - 0.5 - H / 2 });
  FR.toDisplay = (u, v, w, h, W, H) => ({ x: (u + W / 2 + 0.5) * w / W, y: (v + H / 2 + 0.5) * h / H });
  const signed = (i, N) => (i < N / 2 ? i : i - N);

  // Per-channel spectra of an input image, cached by object identity (the engine hands the same ImageData
  // object back from its cache, so changing notch parameters does not recompute the forward transforms).
  const cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  FR.spectra = input => {
    const hit = cache && cache.get(input);
    if (hit) return hit;
    const { width: w, height: h } = input, ycc = AD.img.toYCbCr(input);
    const s = { w, h, planes: [ycc.y, ycc.cb, ycc.cr].map(pl => F.forward(pl, w, h, { pad: 'mirror' })) };
    s.W = s.planes[0].W; s.H = s.planes[0].H;
    if (cache) cache.set(input, s);
    return s;
  };
  const copySpec = sp => ({ re: Float64Array.from(sp.re), im: Float64Array.from(sp.im), W: sp.W, H: sp.H, w: sp.w, h: sp.h });

  // Apply a real mask (W*H, unshifted layout) to the chosen planes and transform back.
  function filtered(input, S, mask, planes = [0, 1, 2]) {
    const out = AD.img.toYCbCr(input);
    const keys = ['y', 'cb', 'cr'];
    for (const k of planes) {
      const sp = copySpec(S.planes[k]);
      for (let i = 0; i < mask.length; i++) { sp.re[i] *= mask[i]; sp.im[i] *= mask[i]; }
      out[keys[k]] = F.inverse(sp);
    }
    return AD.img.fromYCbCr(out);
  }

  // Centred log-magnitude of the luma spectrum, optionally multiplied by a mask, resampled to w*h.
  function spectrumImage(S, mask) {
    const { W, H, w, h } = S, sp = S.planes[0], L = new Float32Array(W * H);
    let mx = 0;
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const i = v * W + u, m = Math.log1p(Math.hypot(sp.re[i], sp.im[i]) * (mask ? mask[i] : 1));
      const X = (u + W / 2) % W, Y = (v + H / 2) % H;
      L[Y * W + X] = m; if (m > mx) mx = m;
    }
    const g = AD.img.fromGray(L.map(v => (mx ? v / mx * 255 : 0)), W, H);
    return W === w && H === h ? g : AD.img.resize(g, w, h, 'bilinear');
  }

  // Notch-reject mask for notches given in display coordinates (and their conjugates).
  FR.notchMask = (S, notches, p) => {
    const { W, H, w, h } = S, mask = new Float32Array(W * H).fill(1), sx = w / W, sy = h / H, r = Math.max(0.5, p.radius);
    const centres = [];
    for (const n of notches || []) { const b = FR.toBin(n.x, n.y, w, h, W, H); centres.push(b, { u: -b.u, v: -b.v }); }
    for (let vi = 0; vi < H; vi++) for (let ui = 0; ui < W; ui++) {
      const u = signed(ui, W), v = signed(vi, H);
      let m = 1;
      for (const c of centres) {
        const dx = (u - c.u) * sx, dy = (v - c.v) * sy;
        // spot: distance to the peak; bands: distance to the row (hband) or column (vband) through it
        const d2 = p.shape === 'hband' ? dy * dy : p.shape === 'vband' ? dx * dx : dx * dx + dy * dy;
        m *= p.profile === 'butterworth' ? 1 / (1 + Math.pow(r * r / Math.max(d2, 1e-9), 2)) : 1 - Math.exp(-d2 / (2 * r * r));
      }
      mask[vi * W + ui] = m;
    }
    return mask;
  };

  // Peaks of the log spectrum that stand out from their surroundings (display coords, one per conjugate pair).
  FR.detectPeaks = (S, { sensitivity = 2, dcRadius = 12, max = 8 } = {}) => {
    const { W, H, w, h } = S, sp = S.planes[0], L = new Float32Array(W * H);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) { const i = v * W + u; L[((v + H / 2) % H) * W + (u + W / 2) % W] = Math.log1p(Math.hypot(sp.re[i], sp.im[i])); }
    const r = Math.max(3, Math.round(Math.min(W, H) / 48)), bg = AD.img.boxBlur(AD.img.boxBlur(L, W, H, r), W, H, r);
    const peaks = [], dcU = dcRadius * W / w, dcV = dcRadius * H / h;
    for (let Y = 2; Y < H - 2; Y++) for (let X = 2; X < W - 2; X++) {
      const u = X - W / 2, v = Y - H / 2;
      if (v < 0 || (v === 0 && u <= 0)) continue;                  // one half-plane: conjugates are implied
      if ((u / dcU) ** 2 + (v / dcV) ** 2 < 1) continue;
      const val = L[Y * W + X], ex = val - bg[Y * W + X];
      if (ex < sensitivity) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && L[(Y + dy) * W + X + dx] > val) { isMax = false; break; }
      if (isMax) peaks.push({ u, v, ex });
    }
    peaks.sort((a, b) => b.ex - a.ex);
    return peaks.slice(0, max).map(pk => ({ ...FR.toDisplay(pk.u, pk.v, w, h, W, H), u: pk.u, v: pk.v, excess: pk.ex }));
  };

  const describe = (pk, S) => {
    const fu = pk.u / S.W, fv = pk.v / S.H, f = Math.hypot(fu, fv);
    return `${f.toFixed(4)} cyc/px (period ${(1 / f).toFixed(1)} px) at ${(Math.atan2(fv, fu) * 180 / Math.PI).toFixed(0)}°`;
  };

  // ---------------------------------------------------------------- filters
  AD.registerFilter({
    id: 'fourier-spectrum', name: 'Fourier Spectrum', category: 'Extract',
    description: 'Show the image\'s frequency content (centred log magnitude of luma). Repeating patterns — interference, screens, printing dots — appear as bright symmetric spots.',
    keywords: ['fft', 'frequency', 'periodic', 'spectrum', 'magnitude', 'phase'],
    testSample: 'periodic',
    params: [{ id: 'mode', label: 'Show', type: 'select', default: 'magnitude', options: [{ value: 'magnitude', label: 'Log magnitude' }, { value: 'phase', label: 'Phase' }] }],
    apply(input, p) {
      const S = FR.spectra(input);
      let image;
      if (p.mode === 'phase') {
        const { W, H, w, h } = S, sp = S.planes[0], P = new Float32Array(W * H);
        for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) { const i = v * W + u; P[((v + H / 2) % H) * W + (u + W / 2) % W] = (Math.atan2(sp.im[i], sp.re[i]) + Math.PI) / (2 * Math.PI) * 255; }
        image = AD.img.resize(AD.img.fromGray(P, W, H), w, h, 'nearest');
      } else image = spectrumImage(S, null);
      const peaks = FR.detectPeaks(S, { max: 3 });
      const readout = { 'Transform size': `${S.W} × ${S.H}` };
      peaks.forEach((pk, i) => { readout[`Peak ${i + 1}`] = describe(pk, S); });
      if (!peaks.length) readout.Peaks = 'none stand out';
      return { image, readout, overlay: peaks.map((pk, i) => ({ type: 'circle', x: pk.x, y: pk.y, r: 8, color: 'warn', label: String(i + 1) })) };
    },
  });

  AD.registerFilter({
    id: 'periodic-noise', name: 'Periodic Noise Removal', category: 'Denoise',
    description: 'Remove repeating interference (patterns, stripes, scan lines, screens) by cutting its spikes out of the frequency spectrum. Switch the view to Spectrum, then click the bright spots or press Detect peaks.',
    keywords: ['notch', 'fourier', 'interference', 'moire', 'pattern', 'stripes', 'scan lines', 'fft'],
    testSample: 'periodic',
    params: [
      { id: 'view', label: 'View', type: 'select', default: 'result', options: [{ value: 'result', label: 'Result' }, { value: 'spectrum', label: 'Spectrum (to place notches)' }] },
      { id: 'notches', label: 'Notches', type: 'points', min: 0, max: 24, shape: 'points', space: 'output', default: [],
        hint: 'Placed on the spectrum view. The mirror-image spot is removed automatically.' },
      { id: 'radius', label: 'Notch radius', type: 'range', min: 1, max: 40, step: 0.5, default: 6, hint: 'In spectrum-view pixels.' },
      { id: 'profile', label: 'Notch edge', type: 'select', default: 'gaussian', options: [{ value: 'gaussian', label: 'Gaussian (soft)' }, { value: 'butterworth', label: 'Butterworth (sharper)' }] },
      { id: 'shape', label: 'Notch shape', type: 'select', default: 'spot', options: [{ value: 'spot', label: 'Spot' }, { value: 'hband', label: 'Horizontal band through the spot' }, { value: 'vband', label: 'Vertical band through the spot' }] },
      { id: 'sensitivity', label: 'Detection threshold', type: 'range', min: 0.4, max: 6, step: 0.1, default: 2, hint: 'How far a peak must stand above its surroundings (log units). Lower finds fainter peaks, and more false ones.' },
      { id: 'chroma', label: 'Also filter colour', type: 'bool', default: true },
    ],
    actions: [{ id: 'detect', label: 'Detect peaks', run: async (input, p) => {
      const peaks = FR.detectPeaks(FR.spectra(input), { sensitivity: p.sensitivity, dcRadius: Math.max(8, p.radius * 2), max: 12 });
      if (!peaks.length) throw new Error('no peaks stand out; lower the sensitivity or place notches by hand');
      return { notches: peaks.map(pk => ({ x: pk.x, y: pk.y })) };
    } }],
    apply(input, p) {
      const S = FR.spectra(input), mask = FR.notchMask(S, p.notches, p);
      const overlay = (p.notches || []).flatMap(n => {
        const b = FR.toBin(n.x, n.y, S.w, S.h, S.W, S.H), c = FR.toDisplay(-b.u, -b.v, S.w, S.h, S.W, S.H);
        return [{ type: 'circle', x: n.x, y: n.y, r: p.radius, color: 'warn' }, { type: 'circle', x: c.x, y: c.y, r: p.radius, color: 'warn', dash: true }];
      });
      if (p.view === 'spectrum') return { image: spectrumImage(S, mask), overlay, readout: { Notches: `${(p.notches || []).length} (+ mirror images)` } };
      return { image: filtered(input, S, mask, p.chroma ? [0, 1, 2] : [0]), readout: { Notches: `${(p.notches || []).length} (+ mirror images)` } };
    },
  });

  AD.registerFilter({
    id: 'frequency-filter', name: 'Frequency Filter', category: 'Denoise',
    description: 'Keep or remove ranges of spatial frequency: low-pass (smooth), high-pass (edges only), band-pass or band-stop.',
    keywords: ['low pass', 'high pass', 'band pass', 'band stop', 'butterworth', 'fourier'],
    testSample: 'periodic',
    params: [
      { id: 'type', label: 'Type', type: 'select', default: 'lowpass', options: [
        { value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' }, { value: 'bandpass', label: 'Band-pass' }, { value: 'bandstop', label: 'Band-stop' }] },
      { id: 'shape', label: 'Shape', type: 'select', default: 'butterworth', options: [{ value: 'ideal', label: 'Ideal (sharp, rings)' }, { value: 'butterworth', label: 'Butterworth' }, { value: 'gaussian', label: 'Gaussian' }] },
      { id: 'cutoff', label: 'Cutoff', type: 'range', min: 0.005, max: 0.5, step: 0.005, default: 0.08, unit: 'cyc/px' },
      { id: 'cutoff2', label: 'Upper cutoff', type: 'range', min: 0.005, max: 0.5, step: 0.005, default: 0.2, unit: 'cyc/px', when: p => p.type === 'bandpass' || p.type === 'bandstop' },
      { id: 'order', label: 'Butterworth order', type: 'range', min: 1, max: 8, step: 1, default: 2, when: p => p.shape === 'butterworth' },
      { id: 'offset', label: 'Add grey (high-pass)', type: 'bool', default: true, when: p => p.type === 'highpass' },
    ],
    apply(input, p, ctx) {
      // cutoffs are in cycles/px of the image being processed; at preview scale the same image detail has a
      // proportionally higher frequency
      const s = ctx ? ctx.scale : 1, c1 = Math.min(0.5, p.cutoff / s), c2 = Math.min(0.5, p.cutoff2 / s);
      const S = FR.spectra(input), { W, H } = S, mask = new Float32Array(W * H);
      const lp = (f, c) => (p.shape === 'ideal' ? (f <= c ? 1 : 0) : p.shape === 'gaussian' ? Math.exp(-(f * f) / (2 * c * c)) : 1 / (1 + Math.pow(f / c, 2 * p.order)));
      for (let vi = 0; vi < H; vi++) for (let ui = 0; ui < W; ui++) {
        const f = Math.hypot(signed(ui, W) / W, signed(vi, H) / H);
        const lo = Math.min(c1, c2), hi = Math.max(c1, c2);
        mask[vi * W + ui] = p.type === 'lowpass' ? lp(f, c1) : p.type === 'highpass' ? 1 - lp(f, c1) : p.type === 'bandpass' ? lp(f, hi) * (1 - lp(f, lo)) : 1 - lp(f, hi) * (1 - lp(f, lo));
      }
      const out = filtered(input, S, mask, p.type === 'lowpass' || p.type === 'bandstop' ? [0, 1, 2] : [0]);
      if ((p.type === 'highpass' || p.type === 'bandpass')) {
        // luma only: show detail as grey, centred on mid-grey if asked
        // the zero frequency is gone, so luma is centred on 0: lift it to mid-grey to make negative detail visible
        const d = out.data, add = p.type === 'highpass' && !p.offset ? 0 : 128, sp = copySpec(S.planes[0]);
        for (let i = 0; i < mask.length; i++) { sp.re[i] *= mask[i]; sp.im[i] *= mask[i]; }
        const Y = F.inverse(sp);
        for (let j = 0, i = 0; j < Y.length; j++, i += 4) d[i] = d[i + 1] = d[i + 2] = Y[j] + add;
      }
      return out;
    },
  });

  AD.registerFilter({
    id: 'homomorphic-filter', name: 'Homomorphic Filter', category: 'Adjust',
    description: 'Even out lighting: works on the logarithm of brightness so slow illumination changes are reduced (γ low) while detail is kept or boosted (γ high).',
    keywords: ['illumination', 'uneven lighting', 'shadow', 'vignetting', 'fourier'],
    testSample: 'plate',
    params: [
      { id: 'gammaL', label: 'Illumination gain (γ low)', type: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5 },
      { id: 'gammaH', label: 'Detail gain (γ high)', type: 'range', min: 1, max: 3, step: 0.05, default: 1.5 },
      { id: 'cutoff', label: 'Cutoff', type: 'range', min: 0.002, max: 0.2, step: 0.002, default: 0.02, unit: 'cyc/px' },
    ],
    apply(input, p, ctx) {
      const { width: w, height: h } = input, ycc = AD.img.toYCbCr(input), c = Math.min(0.5, p.cutoff / (ctx ? ctx.scale : 1));
      const lg = new Float32Array(w * h); for (let i = 0; i < lg.length; i++) lg[i] = Math.log1p(ycc.y[i]);
      const sp = F.forward(lg, w, h, { pad: 'mirror' }), { W, H } = sp;
      for (let vi = 0; vi < H; vi++) for (let ui = 0; ui < W; ui++) {
        const f = Math.hypot(signed(ui, W) / W, signed(vi, H) / H), k = (p.gammaH - p.gammaL) * (1 - Math.exp(-(f * f) / (c * c))) + p.gammaL, i = vi * W + ui;
        sp.re[i] *= k; sp.im[i] *= k;
      }
      const back = F.inverse(sp);
      // map back to 0..255 with a robust stretch (log domain shifts the overall level)
      const e = back.map(v => Math.expm1(v)), sorted = Float32Array.from(e.filter((_, i) => i % 7 === 0)).sort();
      const lo = sorted[Math.floor(sorted.length * 0.002)], hi = sorted[Math.floor(sorted.length * 0.998)] || lo + 1, k = 255 / Math.max(1e-6, hi - lo);
      for (let i = 0; i < e.length; i++) ycc.y[i] = (e[i] - lo) * k;
      return AD.img.fromYCbCr(ycc);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
