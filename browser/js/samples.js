// Synthetic test material, generated in the browser. Each sample degrades a known scene in a known way,
// so every filter category has something realistic to work on. Main thread only.
(function (root) {
  const AD = root.AD;
  if (typeof document === 'undefined') return;

  const rng = seed => { let s = (seed % 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  const gauss = r => () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const MONO = '"IBM Plex Mono", ui-monospace, "DejaVu Sans Mono", Menlo, monospace';

  // A street scene: sky, buildings with windows, kerb, a car with a licence plate. `t` shifts the car.
  function scene(w, h, { t = 0, plate = 'AB 123 CD', seed = 3 } = {}) {
    const c = canvas(w, h), g = c.getContext('2d'), r = rng(seed);
    const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, '#8fa9c4'); sky.addColorStop(1, '#c9d3dc');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w;) {
      const bw = w * (0.12 + r() * 0.12), bh = h * (0.25 + r() * 0.3);
      const tone = 90 + Math.floor(r() * 70);
      g.fillStyle = `rgb(${tone},${tone - 8},${tone - 18})`; g.fillRect(x, h * 0.62 - bh, bw, bh);
      g.fillStyle = 'rgba(30,40,55,0.75)';
      for (let wy = h * 0.62 - bh + 10; wy < h * 0.6 - 18; wy += 22) for (let wx = x + 8; wx < x + bw - 14; wx += 18) g.fillRect(wx, wy, 9, 13);
      x += bw + 4;
    }
    g.fillStyle = '#5d5f60'; g.fillRect(0, h * 0.62, w, h * 0.38);
    g.fillStyle = '#d9d4c4'; for (let x = 0; x < w; x += 60) g.fillRect(x, h * 0.82, 34, 5);
    // car
    const cx = w * 0.32 + t, cy = h * 0.6, cw = w * 0.36, ch = h * 0.2;
    g.fillStyle = '#7a1f1f'; g.beginPath(); g.roundRect(cx, cy, cw, ch, 14); g.fill();
    g.fillStyle = '#2b3442'; g.beginPath(); g.roundRect(cx + cw * 0.15, cy - ch * 0.45, cw * 0.7, ch * 0.55, 10); g.fill();
    g.fillStyle = '#111'; for (const wx of [cx + cw * 0.18, cx + cw * 0.82]) { g.beginPath(); g.arc(wx, cy + ch, ch * 0.32, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#f2d36b'; g.fillRect(cx + 8, cy + ch * 0.25, cw * 0.08, ch * 0.18); g.fillRect(cx + cw * 0.92 - 8, cy + ch * 0.25, cw * 0.08, ch * 0.18);
    // plate
    const pw = cw * 0.42, ph = pw * 0.22, px = cx + (cw - pw) / 2, py = cy + ch * 0.55;
    g.fillStyle = '#f4f4ef'; g.fillRect(px, py, pw, ph);
    g.fillStyle = '#1f3d8a'; g.fillRect(px, py, pw * 0.08, ph);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(px, py, pw, ph);
    g.fillStyle = '#111'; g.font = `600 ${Math.round(ph * 0.72)}px ${MONO}`; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillText(plate, px + pw * 0.54, py + ph * 0.54);
    return g.getImageData(0, 0, w, h);
  }

  function addNoise(d, sigma, seed = 9) {
    const n = gauss(rng(seed)), p = d.data;
    for (let i = 0; i < p.length; i += 4) { p[i] += n() * sigma; p[i + 1] += n() * sigma; p[i + 2] += n() * sigma; }
    return d;
  }

  function gammaDark(d, gain, gamma) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = 255 * gain * Math.pow(v / 255, gamma);
    const p = d.data; for (let i = 0; i < p.length; i += 4) { p[i] = lut[p[i]]; p[i + 1] = lut[p[i + 1]]; p[i + 2] = lut[p[i + 2]]; }
    return d;
  }

  function blur(d, sigma) { return AD.img.mapRGB(d, (pl, w, h) => AD.img.gaussianBlur(pl, w, h, sigma)); }

  function motionBlur(d, length, angleDeg) {
    const a = angleDeg * Math.PI / 180, n = Math.max(2, Math.round(length)), P = AD.img.toPlanes(d), { w, h } = P;
    const out = { w, h, r: new Float32Array(w * h), g: new Float32Array(w * h), b: new Float32Array(w * h) };
    for (let k = 0; k < n; k++) {
      const s = k / (n - 1) - 0.5, dx = Math.cos(a) * s * length, dy = Math.sin(a) * s * length;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, sx = x + dx, sy = y + dy;
        out.r[i] += AD.img.sampleBilinear(P.r, w, h, sx, sy) / n;
        out.g[i] += AD.img.sampleBilinear(P.g, w, h, sx, sy) / n;
        out.b[i] += AD.img.sampleBilinear(P.b, w, h, sx, sy) / n;
      }
    }
    return AD.img.fromPlanes(out);
  }

  // Shared with filter modules that register their own samples.
  AD.sampleTools = { scene, addNoise, blur, motionBlur, gammaDark, rng, gauss };

  const reg = (s) => AD.registerSample(s);

  reg({ id: 'plate', name: 'Dark, blurred licence plate', category: 'Adjust', description: 'underexposed, defocused, noisy, at an angle',
    make: async () => {
      const w = 960, h = 600, sharp = scene(w, h);
      // tilt the whole frame slightly to give the plate perspective
      const H = AD.geom.homography(
        [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
        [{ x: 40, y: 10 }, { x: w - 10, y: 60 }, { x: w - 60, y: h - 20 }, { x: 0, y: h - 50 }]);
      const tilted = AD.geom.warpPerspective(sharp, AD.geom.invert(H), w, h, 'bilinear', [40, 40, 40]);
      return addNoise(gammaDark(blur(tilted, 1.6), 0.45, 1.8), 4);
    } });

  reg({ id: 'motion-blur', name: 'Motion-blurred car', category: 'Deblurring', description: '21 px blur at 8°',
    make: async () => addNoise(motionBlur(scene(800, 500, { plate: 'MX 482 KT' }), 21, 8), 1.5) });

  reg({ id: 'defocus', name: 'Out-of-focus car', category: 'Deblurring', description: 'lens defocus, disk radius 4 px',
    make: async () => {
      const sharp = scene(800, 500, { plate: 'DF 905 LQ' });
      if (!AD.deblur) return addNoise(blur(sharp, 2.5), 1.5);
      const psf = AD.deblur.psfDisk(4);
      return addNoise(AD.img.mapRGB(sharp, (pl, w, h) => AD.deblur.convolve(pl, w, h, psf)), 1.5);
    } });

  reg({ id: 'periodic', name: 'Periodic interference', category: 'Denoise', description: 'two sinusoidal patterns over the scene',
    make: async () => {
      const d = scene(768, 512, { plate: 'PN 317 FX' }), p = d.data, w = d.width;
      for (let i = 0, j = 0; i < p.length; i += 4, j++) {
        const x = j % w, y = (j / w) | 0;
        const v = 28 * Math.sin(2 * Math.PI * (x * 0.09 + y * 0.03)) + 18 * Math.sin(2 * Math.PI * (x * -0.02 + y * 0.12));
        p[i] += v; p[i + 1] += v; p[i + 2] += v;
      }
      return d;
    } });

  reg({ id: 'jpeg', name: 'Heavily compressed JPEG', category: 'Denoise', description: '8×8 blocking at quality 8',
    make: async () => {
      const c = canvas(800, 500); c.getContext('2d').putImageData(scene(800, 500, { plate: 'JP 660 EG' }), 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.08));
      const bmp = await createImageBitmap(blob);
      return AD.bitmapToImageData(bmp, 800, 500);
    } });

  reg({ id: 'noisy', name: 'Low-light sensor noise', category: 'Denoise', description: 'Gaussian noise σ 22',
    make: async () => addNoise(scene(800, 500, { plate: 'NZ 204 RA' }), 22, 4) });

  reg({ id: 'barrel', name: 'Checkerboard, barrel distortion', category: 'Edit', description: 'wide-angle lens, k1 = −0.28',
    make: async () => {
      const w = 800, h = 600, c = canvas(w, h), g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      const sq = 50; g.fillStyle = '#111';
      for (let y = 0; y < h / sq; y++) for (let x = 0; x < w / sq; x++) if ((x + y) % 2) g.fillRect(x * sq, y * sq, sq, sq);
      const flat = g.getImageData(0, 0, w, h), cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy), k1 = -0.28;
      // distorted(x) samples flat at undistorted radius r_u = r_d (1 + k1 r_d^2)^-1 ... approximated by forward model
      return AD.img.warp(flat, w, h, (x, y, t) => {
        const dx = (x - cx) / R, dy = (y - cy) / R, r2 = dx * dx + dy * dy, f = 1 / (1 + k1 * r2);
        t[0] = cx + dx * f * R; t[1] = cy + dy * f * R; return true;
      }, 'bilinear', [255, 255, 255]);
    } });

  reg({ id: 'vhs', name: 'VHS tape capture', category: 'Adjust', description: 'line jitter, chroma shift and bleed, noise',
    make: async () => {
      const d = scene(720, 480, { plate: 'VH 198 SC' }), w = d.width, h = d.height, r = rng(5);
      const ycc = AD.img.toYCbCr(d);
      // chroma: shifted 6 px right and blurred horizontally (low chroma bandwidth)
      const shiftBlur = pl => { const out = new Float32Array(pl.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -4; k <= 4; k++) s += pl[y * w + Math.max(0, Math.min(w - 1, x - 6 + k))]; out[y * w + x] = s / 9; } return out; };
      ycc.cb = shiftBlur(ycc.cb); ycc.cr = shiftBlur(ycc.cr);
      const out = AD.img.fromYCbCr(ycc), p = out.data, src = new Uint8ClampedArray(p);
      let off = 0;
      for (let y = 0; y < h; y++) {
        off = Math.max(-5, Math.min(5, off + (r() - 0.5) * 1.6));
        const o = Math.round(off + (y > h - 14 ? 18 * r() : 0));   // head-switching noise at the bottom
        for (let x = 0; x < w; x++) { const sx = Math.max(0, Math.min(w - 1, x - o)), i = (y * w + x) * 4, si = (y * w + sx) * 4; p[i] = src[si]; p[i + 1] = src[si + 1]; p[i + 2] = src[si + 2]; }
      }
      return addNoise(out, 7, 6);
    } });

  reg({ id: 'saturation-patches', name: 'Faint tinted patches', category: 'Extract', description: 'low-contrast colour anomalies',
    make: async () => {
      const w = 960, h = 640, c = canvas(w, h), g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, '#a9a49a'); grad.addColorStop(1, '#7d776d');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      const d = g.getImageData(0, 0, w, h), p = d.data, n = gauss(rng(7));
      for (let i = 0, j = 0; i < p.length; i += 4, j++) {
        const x = j % w, y = (j / w) | 0, v = n() * 6;
        p[i] += v; p[i + 1] += v; p[i + 2] += v;
        const a = ((x - 610) / 110) ** 2 + ((y - 300) / 70) ** 2; if (a < 1) { const k = (1 - a) * 10; p[i] += k; p[i + 2] -= k; }
        const b = ((x - 250) / 60) ** 2 + ((y - 460) / 45) ** 2; if (b < 1) { const k = (1 - b) * 10; p[i + 1] += k; p[i] -= k * 0.6; }
      }
      return d;
    } });

  reg({ id: 'shaky', name: 'Shaky, noisy dashcam clip', category: 'Stabilization', description: '60 frames, hand shake + sensor noise',
    make: async () => {
      const w = 640, h = 400, base = scene(w + 60, h + 60, { plate: 'SK 771 DB' }), r = rng(21), frames = [];
      let jx = 0, jy = 0;
      for (let f = 0; f < 60; f++) {
        jx = Math.max(-22, Math.min(22, jx * 0.6 + (r() - 0.5) * 18)); jy = Math.max(-22, Math.min(22, jy * 0.6 + (r() - 0.5) * 14));
        frames.push(addNoise(AD.img.crop(base, 30 + jx, 30 + jy, w, h), 18, 100 + f));
      }
      return { frames, fps: 25 };
    } });

  reg({ id: 'interlaced', name: 'Interlaced video (moving car)', category: 'Interlace', description: '40 frames, fields 1/50 s apart',
    make: async () => {
      const w = 720, h = 480, frames = [];
      for (let f = 0; f < 40; f++) {
        const top = scene(w, h, { t: f * 10 - 120, plate: 'IL 553 NE' }), bottom = scene(w, h, { t: f * 10 - 115, plate: 'IL 553 NE' });
        const out = new ImageData(w, h);
        for (let y = 0; y < h; y++) { const s = y % 2 ? bottom : top; out.data.set(s.data.subarray(y * w * 4, (y + 1) * w * 4), y * w * 4); }
        frames.push(out);
      }
      return { frames, fps: 25 };
    } });
})(window);
