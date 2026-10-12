// Adjust (tone and colour) and Sharpen filters.
(function (root) {
  const AD = root.AD;
  const A = AD.adjust = {};
  const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

  // ---------------------------------------------------------------- helpers
  // Apply one LUT (Uint8ClampedArray(256)) per channel; null = unchanged.
  A.applyLut = (input, lr, lg, lb) => {
    const out = new ImageData(input.width, input.height), p = input.data, o = out.data;
    for (let i = 0; i < p.length; i += 4) {
      o[i] = lr ? lr[p[i]] : p[i]; o[i + 1] = lg ? lg[p[i + 1]] : p[i + 1]; o[i + 2] = lb ? lb[p[i + 2]] : p[i + 2]; o[i + 3] = 255;
    }
    return out;
  };
  const makeLut = fn => { const l = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) l[v] = Math.round(fn(v)); return l; };

  // Replace luma, keeping Cb/Cr (BT.601 full range). `mapY(yPlane) -> yPlane'`.
  A.onLuma = (input, mapY) => {
    const ycc = AD.img.toYCbCr(input);
    ycc.y = mapY(ycc.y, input.width, input.height);
    return AD.img.fromYCbCr(ycc);
  };

  const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const histOf = (input, channel) => {
    const h = new Float64Array(256), p = input.data;
    for (let i = 0; i < p.length; i += 4) {
      const v = channel === 'r' ? p[i] : channel === 'g' ? p[i + 1] : channel === 'b' ? p[i + 2] : Math.round(lumaOf(p[i], p[i + 1], p[i + 2]));
      h[v]++;
    }
    return h;
  };
  A.percentile = (hist, q) => {
    let total = 0; for (const v of hist) total += v;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * total) return v; }
    return 255;
  };
  A.otsu = hist => {
    let total = 0, sum = 0;
    for (let v = 0; v < 256; v++) { total += hist[v]; sum += v * hist[v]; }
    // Between-class variance is flat across any empty gap between classes; return the middle of the plateau.
    let wB = 0, sumB = 0, best = -1, first = 127, last = 127;
    for (let v = 0; v < 256; v++) {
      wB += hist[v]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best * (1 + 1e-9)) { best = between; first = last = v; }
      else if (between >= best * (1 - 1e-9)) last = v;
    }
    return Math.round((first + last) / 2);
  };

  // Fritsch-Carlson monotone cubic through (xs, ys); returns f(x).
  A.monotoneSpline = (xs, ys) => {
    const n = xs.length, d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return x => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0; while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  };

  const CHANNEL_OPTS = [{ value: 'rgb', label: 'All channels' }, { value: 'luma', label: 'Luma only (keep colour)' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }];
  // Apply an 8-bit tone curve to the chosen channel(s).
  function toneApply(input, lut, channel) {
    if (channel === 'luma') return A.onLuma(input, y => { for (let i = 0; i < y.length; i++) { const v = y[i]; const f = v - Math.floor(v), a = lut[clamp8(Math.floor(v))], b = lut[clamp8(Math.ceil(v))]; y[i] = a + (b - a) * f; } return y; });
    return A.applyLut(input, channel === 'rgb' || channel === 'r' ? lut : null, channel === 'rgb' || channel === 'g' ? lut : null, channel === 'rgb' || channel === 'b' ? lut : null);
  }

  // ---------------------------------------------------------------- Adjust
  const levelsLut = p => {
    const lo = Math.min(p.black, p.white - 1), hi = Math.max(p.white, lo + 1), g = 1 / Math.max(0.01, p.gamma);
    return makeLut(v => { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return p.outBlack + (p.outWhite - p.outBlack) * Math.pow(t, g); });
  };
  AD.registerFilter({
    id: 'levels', name: 'Levels', category: 'Adjust',
    description: 'Set the input black and white points and the midtone gamma; everything between is stretched to the output range.',
    keywords: ['contrast', 'stretch', 'black point', 'white point', 'gamma', 'auto levels'],
    testSample: 'plate',
    params: [
      { id: 'channel', label: 'Apply to', type: 'select', default: 'rgb', options: CHANNEL_OPTS },
      { id: 'black', label: 'Input black', type: 'range', min: 0, max: 254, step: 1, default: 0 },
      { id: 'white', label: 'Input white', type: 'range', min: 1, max: 255, step: 1, default: 140 },
      { id: 'gamma', label: 'Gamma (midtones)', type: 'range', min: 0.1, max: 5, step: 0.01, default: 1.4 },
      { id: 'outBlack', label: 'Output black', type: 'range', min: 0, max: 255, step: 1, default: 0 },
      { id: 'outWhite', label: 'Output white', type: 'range', min: 0, max: 255, step: 1, default: 255 },
    ],
    actions: [{ id: 'auto', label: 'Auto (0.5 % / 99.5 %)', run: async (input, p) => {
      const h = histOf(input, p.channel === 'rgb' || p.channel === 'luma' ? 'y' : p.channel);
      const black = A.percentile(h, 0.005), white = Math.max(black + 1, A.percentile(h, 0.995));
      return { black, white, gamma: 1 };
    } }],
    apply(input, p) { return toneApply(input, levelsLut(p), p.channel); },
  });

  AD.registerFilter({
    id: 'curves', name: 'Curves', category: 'Adjust',
    description: 'Reshape the tone curve with five control points (smooth and monotone between them).',
    keywords: ['tone curve', 'contrast', 'shadows', 'highlights'],
    testSample: 'plate',
    params: [
      { id: 'channel', label: 'Apply to', type: 'select', default: 'luma', options: CHANNEL_OPTS },
      { id: 'p0', label: 'Output at 0', type: 'range', min: 0, max: 255, step: 1, default: 0 },
      { id: 'p1', label: 'Output at 64', type: 'range', min: 0, max: 255, step: 1, default: 110 },
      { id: 'p2', label: 'Output at 128', type: 'range', min: 0, max: 255, step: 1, default: 180 },
      { id: 'p3', label: 'Output at 192', type: 'range', min: 0, max: 255, step: 1, default: 225 },
      { id: 'p4', label: 'Output at 255', type: 'range', min: 0, max: 255, step: 1, default: 255 },
    ],
    apply(input, p) {
      const f = A.monotoneSpline([0, 64, 128, 192, 255], [p.p0, p.p1, p.p2, p.p3, p.p4]);
      return toneApply(input, makeLut(f), p.channel);
    },
  });

  AD.registerFilter({
    id: 'brightness-contrast', name: 'Brightness / Contrast', category: 'Adjust',
    description: 'Shift brightness and scale contrast around mid-grey.',
    testSample: 'plate',
    params: [
      { id: 'brightness', label: 'Brightness', type: 'range', min: -100, max: 100, step: 1, default: 25 },
      { id: 'contrast', label: 'Contrast', type: 'range', min: -100, max: 100, step: 1, default: 20 },
      { id: 'channel', label: 'Apply to', type: 'select', default: 'rgb', options: CHANNEL_OPTS },
    ],
    apply(input, p) {
      const c = p.contrast * 2.55, f = (259 * (c + 255)) / (255 * (259 - c));
      return toneApply(input, makeLut(v => f * (v + p.brightness * 2.55 - 128) + 128), p.channel);
    },
  });

  // sRGB linearisation LUT for exposure in linear light
  const LIN = new Float64Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const toSrgb = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.min(1, c), 1 / 2.4) - 0.055);
  AD.registerFilter({
    id: 'exposure-gamma', name: 'Exposure / Gamma', category: 'Adjust',
    description: 'Exposure in photographic stops (applied in linear light, like more light on the sensor), then a gamma correction.',
    keywords: ['stops', 'ev', 'brighten', 'dark'],
    testSample: 'plate',
    params: [
      { id: 'exposure', label: 'Exposure', type: 'range', min: -4, max: 6, step: 0.05, default: 1.5, unit: 'EV' },
      { id: 'gamma', label: 'Gamma', type: 'range', min: 0.2, max: 5, step: 0.01, default: 1 },
      { id: 'channel', label: 'Apply to', type: 'select', default: 'rgb', options: CHANNEL_OPTS },
    ],
    apply(input, p) {
      const k = Math.pow(2, p.exposure), g = 1 / p.gamma;
      return toneApply(input, makeLut(v => { const e = toSrgb(LIN[v] * k) / 255; return 255 * Math.pow(Math.max(0, e), g); }), p.channel);
    },
  });

  AD.registerFilter({
    id: 'invert', name: 'Invert', category: 'Adjust',
    description: 'Negative image (255 − value).',
    keywords: ['negative'],
    params: [{ id: 'channel', label: 'Apply to', type: 'select', default: 'rgb', options: CHANNEL_OPTS }],
    apply(input, p) { return toneApply(input, makeLut(v => 255 - v), p.channel); },
  });

  AD.registerFilter({
    id: 'threshold', name: 'Threshold', category: 'Adjust',
    description: 'Black-and-white image: luma above the threshold becomes white. Otsu picks the threshold that best separates two tone classes.',
    keywords: ['binarize', 'binary', 'otsu'],
    testSample: 'plate',
    params: [
      { id: 'method', label: 'Method', type: 'select', default: 'otsu', options: [{ value: 'otsu', label: 'Otsu (automatic)' }, { value: 'manual', label: 'Manual' }] },
      { id: 'level', label: 'Threshold', type: 'range', min: 0, max: 255, step: 1, default: 128, when: p => p.method === 'manual' },
      { id: 'invert', label: 'Invert result', type: 'bool', default: false },
    ],
    apply(input, p) {
      const t = p.method === 'otsu' ? A.otsu(histOf(input, 'y')) : p.level;
      const out = new ImageData(input.width, input.height), d = input.data, o = out.data;
      for (let i = 0; i < d.length; i += 4) { const on = lumaOf(d[i], d[i + 1], d[i + 2]) > t; o[i] = o[i + 1] = o[i + 2] = on !== !!p.invert ? 255 : 0; o[i + 3] = 255; }
      return { image: out, readout: { Threshold: t } };
    },
  });

  const equalizeLut = hist => {
    let n = 0; for (const v of hist) n += v;
    let acc = 0, min = -1; const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (min < 0 && acc > 0) min = acc; lut[v] = Math.round(Math.max(0, acc - min) / Math.max(1, n - min) * 255); }
    return lut;
  };
  AD.registerFilter({
    id: 'histogram-equalization', name: 'Histogram Equalisation', category: 'Adjust',
    description: 'Spread the tones so every brightness level is used about equally. Global: one mapping for the whole image (see CLAHE for a local version).',
    keywords: ['equalize', 'equalise', 'contrast'],
    testSample: 'plate',
    params: [{ id: 'mode', label: 'Apply to', type: 'select', default: 'luma', options: [{ value: 'luma', label: 'Luma (keep colour)' }, { value: 'rgb', label: 'Each channel separately' }] }],
    apply(input, p) {
      if (p.mode === 'rgb') return A.applyLut(input, equalizeLut(histOf(input, 'r')), equalizeLut(histOf(input, 'g')), equalizeLut(histOf(input, 'b')));
      return toneApply(input, equalizeLut(histOf(input, 'y')), 'luma');
    },
  });

  // CLAHE on an 8-bit plane (Zuiderveld): per-tile clipped histograms, bilinear interpolation between tile mappings.
  A.clahe = (plane, w, h, tilesX, tilesY, clip) => {
    tilesX = Math.max(1, Math.min(tilesX, w)); tilesY = Math.max(1, Math.min(tilesY, h));
    const maps = [], tw = w / tilesX, th = h / tilesY;
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor(tx * tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * tw)), y0 = Math.floor(ty * th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * th));
      const hist = new Float64Array(256);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[clamp8(Math.round(plane[y * w + x]))]++;
      const count = (x1 - x0) * (y1 - y0), limit = Math.max(1, clip * count / 256);
      // clip and redistribute (repeat a few times since redistribution can push bins over the limit again)
      for (let it = 0; it < 4; it++) {
        let excess = 0;
        for (let v = 0; v < 256; v++) if (hist[v] > limit) { excess += hist[v] - limit; hist[v] = limit; }
        if (excess < 1e-6) break;
        for (let v = 0; v < 256; v++) hist[v] += excess / 256;
      }
      const map = new Float32Array(256); let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; map[v] = acc / count * 255; }
      maps.push(map);
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / th - 0.5, ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(fy))), ty1 = Math.min(tilesY - 1, ty0 + 1);
      const wy = Math.max(0, Math.min(1, fy - ty0));
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / tw - 0.5, tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(fx))), tx1 = Math.min(tilesX - 1, tx0 + 1);
        const wx = Math.max(0, Math.min(1, fx - tx0)), v = clamp8(Math.round(plane[y * w + x]));
        const a = maps[ty0 * tilesX + tx0][v], b = maps[ty0 * tilesX + tx1][v], c = maps[ty1 * tilesX + tx0][v], d = maps[ty1 * tilesX + tx1][v];
        out[y * w + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      }
    }
    return out;
  };

  AD.registerFilter({
    id: 'clahe', name: 'Local Contrast (CLAHE)', category: 'Adjust',
    description: 'Contrast-limited adaptive histogram equalisation: equalises each region separately, so detail in both dark and bright areas becomes visible without boosting noise too much.',
    keywords: ['adaptive', 'local contrast', 'equalization', 'licence plate', 'dark'],
    testSample: 'plate',
    params: [
      { id: 'tiles', label: 'Tiles across', type: 'range', min: 1, max: 32, step: 1, default: 8 },
      { id: 'clip', label: 'Clip limit', type: 'range', min: 1, max: 12, step: 0.1, default: 3, hint: 'Higher = stronger contrast and more noise. 1 = no change.' },
      { id: 'strength', label: 'Blend with original', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
    ],
    apply(input, p) {
      const { width: w, height: h } = input;
      const tx = Math.round(p.tiles), ty = Math.max(1, Math.round(p.tiles * h / w));
      return A.onLuma(input, y => {
        const eq = A.clahe(y, w, h, tx, ty, p.clip);
        for (let i = 0; i < y.length; i++) y[i] = y[i] + (eq[i] - y[i]) * p.strength;
        return y;
      });
    },
  });

  // Fast large Gaussian approximation: three box blurs (radius from sigma).
  A.fastGauss = (plane, w, h, sigma) => {
    if (sigma < 2.5) return AD.img.gaussianBlur(plane, w, h, sigma);
    const r = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1) / 2 - 0.5));
    return AD.img.boxBlur(AD.img.boxBlur(AD.img.boxBlur(plane, w, h, r), w, h, r), w, h, r);
  };

  AD.registerFilter({
    id: 'retinex', name: 'Retinex (MSR)', category: 'Adjust',
    description: 'Multi-scale retinex: removes uneven illumination by dividing out blurred versions of the image at three scales, then stretches the result. Strong for very dark or backlit scenes.',
    keywords: ['msrcr', 'illumination', 'dark', 'shadow', 'night'],
    testSample: 'plate',
    params: [
      { id: 'mode', label: 'Apply to', type: 'select', default: 'luma', options: [{ value: 'luma', label: 'Luma (keep colour)' }, { value: 'rgb', label: 'Each channel (MSRCR-style)' }] },
      { id: 'scale', label: 'Largest scale (% of image size)', type: 'range', min: 2, max: 50, step: 1, default: 20 },
      { id: 'clip', label: 'Clip (% each end)', type: 'range', min: 0, max: 5, step: 0.1, default: 1 },
      { id: 'strength', label: 'Blend with original', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
    ],
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, big = Math.max(w, h) * p.scale / 100, sigmas = [big / 16, big / 4, big];
      const msr = async plane => {
        const logI = new Float32Array(plane.length); for (let i = 0; i < plane.length; i++) logI[i] = Math.log(plane[i] + 1);
        const r = new Float32Array(plane.length);
        for (const s of sigmas) {
          const b = A.fastGauss(plane, w, h, Math.max(0.8, s));
          for (let i = 0; i < r.length; i++) r[i] += (logI[i] - Math.log(b[i] + 1)) / 3;
          await ctx.checkpoint();
        }
        // stretch with percentile clipping
        const sorted = Float32Array.from(r.filter((_, i) => i % 7 === 0)).sort();
        const lo = sorted[Math.floor(sorted.length * p.clip / 100)], hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - p.clip / 100)))];
        const out = new Float32Array(plane.length), k = hi > lo ? 255 / (hi - lo) : 0;
        for (let i = 0; i < r.length; i++) out[i] = plane[i] + (clamp8((r[i] - lo) * k) - plane[i]) * p.strength;
        return out;
      };
      if (p.mode === 'luma') { const ycc = AD.img.toYCbCr(input); ycc.y = await msr(ycc.y); return AD.img.fromYCbCr(ycc); }
      const P = AD.img.toPlanes(input);
      return AD.img.fromPlanes({ w, h, r: await msr(P.r), g: await msr(P.g), b: await msr(P.b) });
    },
  });

  AD.registerFilter({
    id: 'shadows-highlights', name: 'Shadows / Highlights', category: 'Adjust',
    description: 'Lift dark regions and/or pull down bright regions, using a blurred brightness mask so local contrast is kept.',
    keywords: ['shadow', 'highlight', 'tone mapping', 'backlight'],
    testSample: 'plate',
    params: [
      { id: 'shadows', label: 'Lift shadows', type: 'range', min: 0, max: 100, step: 1, default: 60 },
      { id: 'highlights', label: 'Recover highlights', type: 'range', min: 0, max: 100, step: 1, default: 0 },
      { id: 'radius', label: 'Mask radius (% of image size)', type: 'range', min: 0.5, max: 20, step: 0.5, default: 3 },
    ],
    apply(input, p) {
      const { width: w, height: h } = input, sigma = Math.max(w, h) * p.radius / 100;
      return A.onLuma(input, y => {
        const m = A.fastGauss(y, w, h, sigma), s = p.shadows / 100, hl = p.highlights / 100;
        for (let i = 0; i < y.length; i++) {
          const mk = m[i] / 255, v = y[i] / 255;
          let out = v + s * (1 - mk) * (1 - mk) * (1 - v) * 0.9 * Math.min(1, v * 6 + 0.2);
          out = out - hl * mk * mk * out * 0.6;
          y[i] = out * 255;
        }
        return y;
      });
    },
  });

  AD.registerFilter({
    id: 'white-balance', name: 'White Balance', category: 'Adjust',
    description: 'Remove a colour cast by scaling R, G and B: assume the scene averages to grey, that its brightest pixels are white, or pick a region you know is neutral.',
    keywords: ['colour cast', 'neutral', 'gray world', 'white patch', 'temperature'],
    testSample: 'plate',
    params: [
      { id: 'method', label: 'Method', type: 'select', default: 'grayworld', options: [
        { value: 'grayworld', label: 'Grey world (average is grey)' }, { value: 'whitepatch', label: 'White patch (brightest are white)' }, { value: 'manual', label: 'Neutral region (pick on image)' }] },
      { id: 'percent', label: 'Brightest pixels used (%)', type: 'range', min: 0.1, max: 10, step: 0.1, default: 1, when: p => p.method === 'whitepatch' },
      { id: 'rect', label: 'Neutral region', type: 'rect', default: inp => ({ x: Math.round(inp.width * 0.45), y: Math.round(inp.height * 0.45), w: Math.round(inp.width * 0.1), h: Math.round(inp.height * 0.1) }), when: p => p.method === 'manual' },
      { id: 'strength', label: 'Strength', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
    ],
    apply(input, p) {
      const { width: w, height: h } = input, d = input.data, s = [0, 0, 0];
      let n = 0;
      if (p.method === 'manual' && p.rect) {
        const x0 = Math.max(0, Math.floor(p.rect.x)), y0 = Math.max(0, Math.floor(p.rect.y)), x1 = Math.min(w, Math.ceil(p.rect.x + p.rect.w)), y1 = Math.min(h, Math.ceil(p.rect.y + p.rect.h));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
      } else if (p.method === 'whitepatch') {
        const hy = histOf(input, 'y'), t = A.percentile(hy, 1 - p.percent / 100);
        for (let i = 0; i < d.length; i += 4) if (Math.round(lumaOf(d[i], d[i + 1], d[i + 2])) >= t) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
      } else {
        for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
      }
      if (!n) return { image: AD.img.clone(input), readout: { Gains: 'no pixels in region' } };
      const mean = s.map(v => v / n), target = p.method === 'whitepatch' ? Math.max(...mean) : (mean[0] + mean[1] + mean[2]) / 3;
      const gains = mean.map(m => 1 + ((m > 0 ? target / m : 1) - 1) * p.strength);
      const lut = gains.map(g => makeLut(v => v * g));
      return { image: A.applyLut(input, ...lut), readout: { 'Gain R': gains[0].toFixed(3), 'Gain G': gains[1].toFixed(3), 'Gain B': gains[2].toFixed(3), 'Reference RGB': mean.map(v => v.toFixed(1)).join(', ') } };
    },
  });

  AD.registerFilter({
    id: 'color-balance', name: 'Temperature / Tint', category: 'Adjust',
    description: 'Warm or cool the image (blue–amber axis) and shift tint (green–magenta axis).',
    keywords: ['temperature', 'tint', 'warm', 'cool', 'colour balance'],
    testSample: 'plate',
    params: [
      { id: 'temperature', label: 'Temperature', type: 'range', min: -100, max: 100, step: 1, default: 0 },
      { id: 'tint', label: 'Tint', type: 'range', min: -100, max: 100, step: 1, default: 0 },
    ],
    apply(input, p) {
      const t = p.temperature / 100, n = p.tint / 100;
      const g = [1 + 0.25 * t + 0.1 * n, 1 - 0.2 * n, 1 - 0.25 * t + 0.1 * n];
      return A.applyLut(input, ...g.map(k => makeLut(v => v * k)));
    },
  });

  AD.registerFilter({
    id: 'saturation', name: 'Saturation / Vibrance', category: 'Adjust',
    description: 'Increase or decrease colour intensity. Vibrance boosts dull colours more than already-strong ones.',
    keywords: ['colour', 'chroma', 'vivid', 'desaturate'],
    testSample: 'plate',
    params: [
      { id: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 200, step: 1, default: 40 },
      { id: 'vibrance', label: 'Vibrance', type: 'range', min: 0, max: 200, step: 1, default: 0 },
    ],
    apply(input, p) {
      const s = p.saturation / 100, v = p.vibrance / 100;
      return AD.img.mapPixels(input, (r, g, b, o) => {
        const y = lumaOf(r, g, b), mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
        const k = 1 + s + v * (1 - sat);
        o[0] = y + (r - y) * k; o[1] = y + (g - y) * k; o[2] = y + (b - y) * k;
      });
    },
  });

  // ---------------------------------------------------------------- Sharpen
  const sharpenTarget = [{ value: 'luma', label: 'Luma (no colour fringes)' }, { value: 'rgb', label: 'Each channel' }];
  function onTarget(input, target, fn) {
    if (target === 'rgb') return AD.img.mapRGB(input, fn);
    return A.onLuma(input, (y, w, h) => fn(y, w, h));
  }

  AD.registerFilter({
    id: 'unsharp-mask', name: 'Unsharp Mask', category: 'Sharpen',
    description: 'Sharpen by adding back the difference between the image and a blurred copy. Threshold leaves small differences (noise) alone.',
    keywords: ['sharpen', 'usm', 'detail'],
    testSample: 'defocus',
    params: [
      { id: 'radius', label: 'Radius', type: 'range', min: 0.3, max: 20, step: 0.1, default: 2, unit: 'px' },
      { id: 'amount', label: 'Amount', type: 'range', min: 0, max: 5, step: 0.05, default: 1.2 },
      { id: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 50, step: 1, default: 2 },
      { id: 'target', label: 'Apply to', type: 'select', default: 'luma', options: sharpenTarget },
    ],
    margin: p => Math.ceil(p.radius * 3) + 1,
    apply(input, p) {
      return onTarget(input, p.target, (pl, w, h) => {
        const b = AD.img.gaussianBlur(pl, w, h, p.radius), out = new Float32Array(pl.length);
        for (let i = 0; i < pl.length; i++) { const d = pl[i] - b[i]; out[i] = Math.abs(d) > p.threshold ? pl[i] + p.amount * d : pl[i]; }
        return out;
      });
    },
  });

  AD.registerFilter({
    id: 'laplacian-sharpen', name: 'Laplacian Sharpen', category: 'Sharpen',
    description: 'Classic 3×3 Laplacian sharpening: subtracts the second derivative to steepen edges.',
    keywords: ['sharpen', 'edge'],
    testSample: 'defocus',
    params: [
      { id: 'kernel', label: 'Neighbours', type: 'select', default: '4', options: [{ value: '4', label: '4 (cross)' }, { value: '8', label: '8 (full 3×3)' }] },
      { id: 'amount', label: 'Amount', type: 'range', min: 0, max: 3, step: 0.05, default: 0.8 },
      { id: 'target', label: 'Apply to', type: 'select', default: 'luma', options: sharpenTarget },
    ],
    margin: () => 1,
    apply(input, p) {
      const k = p.kernel === '8' ? [-1, -1, -1, -1, 8, -1, -1, -1, -1] : [0, -1, 0, -1, 4, -1, 0, -1, 0];
      const kern = Float32Array.from(k);
      return onTarget(input, p.target, (pl, w, h) => {
        const lap = AD.img.convolve2D(pl, w, h, kern, 3, 3), out = new Float32Array(pl.length);
        for (let i = 0; i < pl.length; i++) out[i] = pl[i] + p.amount * lap[i];
        return out;
      });
    },
  });

  AD.registerFilter({
    id: 'high-pass', name: 'High-pass', category: 'Sharpen',
    description: 'Show only fine detail: the image minus a blurred copy, centred on mid-grey. Useful for spotting edges, text and retouching.',
    keywords: ['detail', 'edges', 'inspection'],
    testSample: 'plate',
    params: [
      { id: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 40, step: 0.5, default: 4, unit: 'px' },
      { id: 'gain', label: 'Gain', type: 'range', min: 0.5, max: 10, step: 0.1, default: 2 },
    ],
    margin: p => Math.ceil(p.radius * 3) + 1,
    apply(input, p) {
      return AD.img.mapRGB(input, (pl, w, h) => {
        const b = AD.img.gaussianBlur(pl, w, h, p.radius), out = new Float32Array(pl.length);
        for (let i = 0; i < pl.length; i++) out[i] = 128 + (pl[i] - b[i]) * p.gain;
        return out;
      });
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
