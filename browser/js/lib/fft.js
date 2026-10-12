// Radix-2 complex FFT in 1D and 2D, plus helpers for frequency-domain filters (deconvolution, notch filtering).
// Spectra are { re, im, W, H, w, h } with Float64Array re/im of length W*H (W, H powers of two);
// w, h are the original image size before padding.
(function (root) {
  const AD = root.AD = root.AD || {};
  const fft = AD.fft = {};

  fft.nextPow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };

  const twiddles = new Map();
  function table(n) {
    let t = twiddles.get(n);
    if (!t) {
      t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2), rev: new Uint32Array(n) };
      for (let i = 0; i < n / 2; i++) { t.cos[i] = Math.cos(2 * Math.PI * i / n); t.sin[i] = Math.sin(2 * Math.PI * i / n); }
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); t.rev[i] = r; }
      twiddles.set(n, t);
    }
    return t;
  }

  // In-place transform of re/im (length n, power of two) starting at `off` with `stride`.
  // Inverse includes the 1/n scaling.
  fft.fft1d = (re, im, inverse = false, off = 0, stride = 1, n = re.length) => {
    const t = table(n), sign = inverse ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = t.rev[i];
      if (j > i) {
        const a = off + i * stride, b = off + j * stride;
        let tmp = re[a]; re[a] = re[b]; re[b] = tmp; tmp = im[a]; im[a] = im[b]; im[b] = tmp;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = t.cos[k * step], s = sign * t.sin[k * step];
          const a = off + (start + k) * stride, b = off + (start + k + half) * stride;
          const xr = re[b] * c - im[b] * s, xi = re[b] * s + im[b] * c;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[off + i * stride] /= n; im[off + i * stride] /= n; }
  };

  // In-place 2D transform; W and H must be powers of two.
  fft.fft2d = (re, im, W, H, inverse = false) => {
    for (let y = 0; y < H; y++) fft.fft1d(re, im, inverse, y * W, 1, W);
    for (let x = 0; x < W; x++) fft.fft1d(re, im, inverse, x, W, H);
  };

  // Copy a w*h plane into a W*H buffer. 'mirror' reflects the image into the padding, which avoids the
  // strong edge discontinuity (and resulting ringing) that zero padding causes in deconvolution.
  fft.pad = (plane, w, h, W, H, mode = 'mirror') => {
    const out = new Float64Array(W * H);
    // Mirror: the first half of the padding reflects the far edge, the second half reflects the near edge,
    // so the periodic tile is continuous both at the image border and where it wraps back to 0.
    const mirror = (v, n, N) => {
      if (v < n) return v;
      const P = N - n, k = v - n;
      return k < (P >> 1) ? Math.max(0, n - 1 - k) : Math.min(n - 1, N - 1 - v);
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x < w && y < h) out[y * W + x] = plane[y * w + x];
        else if (mode === 'zero') out[y * W + x] = 0;
        else if (mode === 'edge') out[y * W + x] = plane[Math.min(y, h - 1) * w + Math.min(x, w - 1)];
        else out[y * W + x] = plane[mirror(y, h, H) * w + mirror(x, w, W)];
      }
    }
    return out;
  };

  fft.forward = (plane, w, h, { pad = 'mirror', minPad = 0 } = {}) => {
    const W = fft.nextPow2(w + minPad), H = fft.nextPow2(h + minPad);
    const re = fft.pad(plane, w, h, W, H, pad), im = new Float64Array(W * H);
    fft.fft2d(re, im, W, H, false);
    return { re, im, W, H, w, h };
  };

  // Inverse transform of a spectrum (consumed in place); returns the real part cropped to w*h.
  fft.inverse = spec => {
    const { re, im, W, H, w, h } = spec;
    fft.fft2d(re, im, W, H, true);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = re[y * W + x];
    return out;
  };

  // Place a small centred PSF (pw*ph, sums to 1) into a W*H array with its centre at (0,0), wrapping
  // around, and return its transform (the OTF).
  fft.psfToOTF = (psf, pw, ph, W, H) => {
    const re = new Float64Array(W * H), im = new Float64Array(W * H), cx = (pw - 1) >> 1, cy = (ph - 1) >> 1;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const tx = ((x - cx) % W + W) % W, ty = ((y - cy) % H + H) % H;
      re[ty * W + tx] += psf[y * pw + x];
    }
    fft.fft2d(re, im, W, H, false);
    return { re, im, W, H };
  };

  // Map an unshifted frequency index (u, v) to display coordinates with DC at the centre, and back.
  fft.toCentered = (u, v, W, H) => [(u + W / 2) % W, (v + H / 2) % H];
  fft.fromCentered = (x, y, W, H) => [((Math.round(x) - W / 2) % W + W) % W, ((Math.round(y) - H / 2) % H + H) % H];

  // Log-magnitude image with DC centred, scaled to 0..255, as a W*H Float32Array.
  fft.logMagnitude = spec => {
    const { re, im, W, H } = spec, out = new Float32Array(W * H);
    let mx = 0;
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const i = v * W + u, m = Math.log1p(Math.hypot(re[i], im[i]));
      const [cx, cy] = fft.toCentered(u, v, W, H);
      out[cy * W + cx] = m; if (m > mx) mx = m;
    }
    if (mx > 0) for (let i = 0; i < out.length; i++) out[i] = out[i] / mx * 255;
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
