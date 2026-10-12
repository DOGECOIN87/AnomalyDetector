// Image helpers shared by every filter. Classic script: attaches to window.AD (or globalThis.AD in tests).
// Conventions: ImageData is RGBA 8-bit; "planes" are Float32Array per channel in 0..255, row-major, length w*h.
(function (root) {
  const AD = root.AD = root.AD || {};
  const img = AD.img = {};

  img.create = (w, h) => new ImageData(w, h);
  img.clone = d => new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
  img.clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

  // ---------- planes ----------
  img.toPlanes = d => {
    const n = d.width * d.height, p = d.data;
    const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) { r[j] = p[i]; g[j] = p[i + 1]; b[j] = p[i + 2]; a[j] = p[i + 3]; }
    return { w: d.width, h: d.height, r, g, b, a };
  };

  img.fromPlanes = ({ w, h, r, g, b, a }) => {
    const out = new ImageData(w, h), o = out.data, n = w * h;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      o[i] = r[j]; o[i + 1] = g[j]; o[i + 2] = b[j]; o[i + 3] = a ? a[j] : 255;
    }
    return out;
  };

  // Rec.601 luma, 0..255
  img.luma = d => {
    const n = d.width * d.height, p = d.data, y = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) y[j] = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
    return y;
  };

  img.fromGray = (plane, w, h) => {
    const out = new ImageData(w, h), o = out.data;
    for (let i = 0, j = 0; j < w * h; i += 4, j++) { o[i] = o[i + 1] = o[i + 2] = plane[j]; o[i + 3] = 255; }
    return out;
  };

  // Full-range BT.601 YCbCr, all 0..255 (Cb/Cr centred on 128)
  img.toYCbCr = d => {
    const n = d.width * d.height, p = d.data;
    const y = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      y[j] = 0.299 * r + 0.587 * g + 0.114 * b;
      cb[j] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[j] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    return { w: d.width, h: d.height, y, cb, cr };
  };

  img.fromYCbCr = ({ w, h, y, cb, cr }) => {
    const out = new ImageData(w, h), o = out.data;
    for (let i = 0, j = 0; j < w * h; i += 4, j++) {
      const Y = y[j], Cb = cb[j] - 128, Cr = cr[j] - 128;
      o[i] = Y + 1.402 * Cr; o[i + 1] = Y - 0.344136 * Cb - 0.714136 * Cr; o[i + 2] = Y + 1.772 * Cb; o[i + 3] = 255;
    }
    return out;
  };

  // Apply fn(plane, w, h, channelIndex) -> Float32Array to R, G and B (alpha kept).
  img.mapRGB = (d, fn) => {
    const P = img.toPlanes(d);
    return img.fromPlanes({ w: P.w, h: P.h, r: fn(P.r, P.w, P.h, 0), g: fn(P.g, P.w, P.h, 1), b: fn(P.b, P.w, P.h, 2), a: P.a });
  };

  // Per-pixel RGB map: fn(r, g, b, out3) writes out3[0..2]. Fast path for point operations.
  img.mapPixels = (d, fn) => {
    const out = new ImageData(d.width, d.height), p = d.data, o = out.data, t = [0, 0, 0];
    for (let i = 0; i < p.length; i += 4) {
      fn(p[i], p[i + 1], p[i + 2], t);
      o[i] = t[0]; o[i + 1] = t[1]; o[i + 2] = t[2]; o[i + 3] = p[i + 3];
    }
    return out;
  };

  // ---------- sampling ----------
  const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  img.clampIndex = cl;

  img.sampleNearest = (plane, w, h, x, y) => plane[cl(Math.round(y), 0, h - 1) * w + cl(Math.round(x), 0, w - 1)];

  img.sampleBilinear = (plane, w, h, x, y) => {
    x = cl(x, 0, w - 1); y = cl(y, 0, h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0;
    const a = plane[y0 * w + x0], b = plane[y0 * w + x1], c = plane[y1 * w + x0], d = plane[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  const cubic = (t, a = -0.5) => {
    t = Math.abs(t);
    if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1;
    if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a;
    return 0;
  };
  img.sampleBicubic = (plane, w, h, x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    let s = 0;
    for (let m = -1; m <= 2; m++) {
      const wy = cubic(y - (y0 + m)), row = cl(y0 + m, 0, h - 1) * w;
      for (let n = -1; n <= 2; n++) s += plane[row + cl(x0 + n, 0, w - 1)] * cubic(x - (x0 + n)) * wy;
    }
    return s;
  };

  const SAMPLERS = { nearest: img.sampleNearest, bilinear: img.sampleBilinear, bicubic: img.sampleBicubic };

  // Generic inverse-mapping warp. map(x, y, out2) must write the SOURCE coordinate for output pixel (x, y)
  // into out2[0], out2[1] and return true, or return false to paint `fill` there.
  img.warp = (d, outW, outH, map, interp = 'bilinear', fill = [0, 0, 0]) => {
    const P = img.toPlanes(d), S = SAMPLERS[interp] || img.sampleBilinear, w = P.w, h = P.h;
    const out = new ImageData(outW, outH), o = out.data, t = [0, 0];
    for (let y = 0, i = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++, i += 4) {
        if (map(x, y, t) && t[0] >= -0.5 && t[1] >= -0.5 && t[0] <= w - 0.5 && t[1] <= h - 0.5) {
          o[i] = S(P.r, w, h, t[0], t[1]); o[i + 1] = S(P.g, w, h, t[0], t[1]); o[i + 2] = S(P.b, w, h, t[0], t[1]);
        } else { o[i] = fill[0]; o[i + 1] = fill[1]; o[i + 2] = fill[2]; }
        o[i + 3] = 255;
      }
    }
    return out;
  };

  img.resize = (d, outW, outH, interp = 'bilinear') => {
    const sx = d.width / outW, sy = d.height / outH;
    return img.warp(d, outW, outH, (x, y, t) => { t[0] = (x + 0.5) * sx - 0.5; t[1] = (y + 0.5) * sy - 0.5; return true; }, interp);
  };

  img.crop = (d, x, y, w, h) => {
    x = Math.round(x); y = Math.round(y); w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const out = new ImageData(w, h), o = out.data, p = d.data;
    for (let yy = 0; yy < h; yy++) {
      const sy = cl(y + yy, 0, d.height - 1);
      for (let xx = 0; xx < w; xx++) {
        const sx = cl(x + xx, 0, d.width - 1), si = (sy * d.width + sx) * 4, oi = (yy * w + xx) * 4;
        o[oi] = p[si]; o[oi + 1] = p[si + 1]; o[oi + 2] = p[si + 2]; o[oi + 3] = 255;
      }
    }
    return out;
  };

  // ---------- convolution ----------
  img.gaussianKernel = sigma => {
    const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  };

  // Separable convolution with edge clamping; kernels are centred (odd length).
  img.convolveSeparable = (plane, w, h, kx, ky = kx) => {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const rx = (kx.length - 1) >> 1, ry = (ky.length - 1) >> 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -rx; k <= rx; k++) s += plane[row + cl(x + k, 0, w - 1)] * kx[k + rx];
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -ry; k <= ry; k++) s += tmp[cl(y + k, 0, h - 1) * w + x] * ky[k + ry];
        out[y * w + x] = s;
      }
    }
    return out;
  };

  // Arbitrary 2D kernel (Float32Array kw*kh, centred), edge clamping.
  img.convolve2D = (plane, w, h, kernel, kw, kh) => {
    const out = new Float32Array(w * h), rx = (kw - 1) >> 1, ry = (kh - 1) >> 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -ry; j <= ry; j++) {
        const row = cl(y + j, 0, h - 1) * w, krow = (j + ry) * kw;
        for (let i = -rx; i <= rx; i++) s += plane[row + cl(x + i, 0, w - 1)] * kernel[krow + i + rx];
      }
      out[y * w + x] = s;
    }
    return out;
  };

  img.gaussianBlur = (plane, w, h, sigma) => (sigma <= 0 ? Float32Array.from(plane) : img.convolveSeparable(plane, w, h, img.gaussianKernel(sigma)));

  // Box mean over a (2r+1)^2 window via an integral image; O(1) per pixel.
  img.boxBlur = (plane, w, h, r) => {
    const W = w + 1, I = new Float64Array(W * (h + 1)), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let rs = 0;
      for (let x = 0; x < w; x++) { rs += plane[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs; }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  };

  // ---------- statistics ----------
  img.histogram = (plane, bins = 256) => {
    const hst = new Uint32Array(bins);
    for (let i = 0; i < plane.length; i++) hst[cl(Math.floor(plane[i] * bins / 256), 0, bins - 1)]++;
    return hst;
  };

  img.minMax = plane => {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < plane.length; i++) { const v = plane[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return [mn, mx];
  };

  // Linear stretch of an arbitrary-range plane to 0..255.
  img.normalize = plane => {
    const [mn, mx] = img.minMax(plane), out = new Float32Array(plane.length), s = mx > mn ? 255 / (mx - mn) : 0;
    for (let i = 0; i < plane.length; i++) out[i] = (plane[i] - mn) * s;
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
