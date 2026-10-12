// Edit / geometry: resize, rotate, flip, pixel aspect, perspective correction, lens distortion, cylinder unroll,
// canvas size. (Crop is in basic.js.)
(function (root) {
  const AD = root.AD;
  const G = AD.geometry = {};
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const INTERP = { id: 'interp', label: 'Interpolation', type: 'select', default: 'bicubic', options: [
    { value: 'nearest', label: 'Nearest (no new values)' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'bicubic', label: 'Bicubic' }] };

  // ---------------------------------------------------------------- separable resampling (correct for up- and down-scaling)
  const KERNELS = {
    nearest: { r: 0.5, f: x => (x >= -0.5 && x < 0.5 ? 1 : 0) },
    bilinear: { r: 1, f: x => Math.max(0, 1 - Math.abs(x)) },
    bicubic: { r: 2, f: x => { x = Math.abs(x); const a = -0.5; return x <= 1 ? (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1 : x < 2 ? a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a : 0; } },
    lanczos3: { r: 3, f: x => { if (x === 0) return 1; if (Math.abs(x) >= 3) return 0; const px = Math.PI * x; return 3 * Math.sin(px) * Math.sin(px / 3) / (px * px); } },
  };
  // Precompute, for each output index, the contributing input indices and weights.
  function weights(inN, outN, kernel) {
    const k = KERNELS[kernel] || KERNELS.bicubic, scale = outN / inN, support = k.r * Math.max(1, 1 / scale), list = [];
    for (let o = 0; o < outN; o++) {
      const c = (o + 0.5) / scale - 0.5, lo = Math.floor(c - support) + 1, hi = Math.floor(c + support), idx = [], w = [];
      let s = 0;
      for (let i = lo; i <= hi; i++) {
        const wt = kernel === 'nearest' ? (i === clamp(Math.round(c), 0, inN - 1) ? 1 : 0) : k.f((i - c) * Math.min(1, scale));
        if (wt === 0) continue;
        idx.push(clamp(i, 0, inN - 1)); w.push(wt); s += wt;
      }
      if (!idx.length) { idx.push(clamp(Math.round(c), 0, inN - 1)); w.push(1); s = 1; }
      list.push({ idx: Int32Array.from(idx), w: Float32Array.from(w.map(v => v / s)) });
    }
    return list;
  }
  G.resample = (input, outW, outH, kernel = 'bicubic') => {
    outW = Math.max(1, Math.round(outW)); outH = Math.max(1, Math.round(outH));
    const { width: w, height: h } = input, d = input.data, wx = weights(w, outW, kernel), wy = weights(h, outH, kernel);
    const tmp = new Float32Array(outW * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < outW; x++) {
      const { idx, w: ws } = wx[x]; let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) { const i = (y * w + idx[k]) * 4; r += d[i] * ws[k]; g += d[i + 1] * ws[k]; b += d[i + 2] * ws[k]; }
      const j = (y * outW + x) * 3; tmp[j] = r; tmp[j + 1] = g; tmp[j + 2] = b;
    }
    const out = new ImageData(outW, outH), o = out.data;
    for (let y = 0; y < outH; y++) {
      const { idx, w: ws } = wy[y];
      for (let x = 0; x < outW; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < idx.length; k++) { const j = (idx[k] * outW + x) * 3; r += tmp[j] * ws[k]; g += tmp[j + 1] * ws[k]; b += tmp[j + 2] * ws[k]; }
        const i = (y * outW + x) * 4; o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = 255;
      }
    }
    return out;
  };

  AD.registerFilter({
    id: 'resize', name: 'Resize', category: 'Edit',
    description: 'Change the image size by a percentage or to an exact size. Enlarging adds no detail; Lanczos and bicubic keep edges sharpest.',
    keywords: ['scale', 'enlarge', 'zoom', 'upscale', 'downscale'],
    testSample: 'plate',
    params: [
      { id: 'mode', label: 'Size by', type: 'select', default: 'percent', options: [{ value: 'percent', label: 'Percentage' }, { value: 'size', label: 'Width and height' }] },
      { id: 'percent', label: 'Scale', type: 'range', min: 5, max: 800, step: 1, default: 200, unit: '%', when: p => p.mode === 'percent' },
      { id: 'width', label: 'Width', type: 'number', min: 1, max: 16384, step: 1, unit: 'px', default: inp => inp.width * 2, when: p => p.mode === 'size' },
      { id: 'height', label: 'Height', type: 'number', min: 1, max: 16384, step: 1, unit: 'px', default: inp => inp.height * 2, when: p => p.mode === 'size' },
      { id: 'keepAspect', label: 'Keep aspect ratio (height follows width)', type: 'bool', default: true, when: p => p.mode === 'size' },
      { id: 'kernel', label: 'Interpolation', type: 'select', default: 'lanczos3', options: [
        { value: 'nearest', label: 'Nearest' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'lanczos3', label: 'Lanczos-3' }] },
    ],
    apply(input, p) {
      let W, H;
      if (p.mode === 'percent') { W = input.width * p.percent / 100; H = input.height * p.percent / 100; }
      else { W = p.width; H = p.keepAspect ? p.width * input.height / input.width : p.height; }
      return G.resample(input, Math.min(16384, W), Math.min(16384, H), p.kernel);
    },
  });

  // ---------------------------------------------------------------- rotate / flip
  G.rotate90 = (input, turns) => {
    turns = ((turns % 4) + 4) % 4;
    const { width: w, height: h } = input, d = input.data, W = turns % 2 ? h : w, H = turns % 2 ? w : h, out = new ImageData(W, H), o = out.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [X, Y] = turns === 0 ? [x, y] : turns === 1 ? [h - 1 - y, x] : turns === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const i = (y * w + x) * 4, j = (Y * W + X) * 4;
      o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255;
    }
    return out;
  };

  // Homography-based warp on the GPU (bilinear) — output pixel centre (x+0.5, y+0.5) maps to input coordinate via H.
  function gpuWarp(input, H, outW, outH, fill) {
    return AD.gpu.run(`vec4 fx(vec2 uv) {
      vec2 p = uv * u_out - 0.5;
      vec3 q = u_h * vec3(p, 1.0);
      if (q.z <= 1e-9) return vec4(u_fill, 1.0);
      vec2 s = q.xy / q.z;
      if (s.x < -0.5 || s.y < -0.5 || s.x > u_size.x - 0.5 || s.y > u_size.y - 0.5) return vec4(u_fill, 1.0);
      return texture(u_img, (s + 0.5) / u_size); }`,
    { image: input, width: outW, height: outH, uniforms: { u_h: H, u_fill: fill.map(v => v / 255) } });
  }

  function rotationSetup(input, p) {
    const a = p.angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), { width: w, height: h } = input;
    const W = p.expand ? Math.round(Math.abs(w * c) + Math.abs(h * s)) : w, H = p.expand ? Math.round(Math.abs(w * s) + Math.abs(h * c)) : h;
    // output (x, y) -> input: rotate by -angle around the centres
    const cx = (w - 1) / 2, cy = (h - 1) / 2, ox = (W - 1) / 2, oy = (H - 1) / 2;
    const M = [c, s, cx - c * ox - s * oy, -s, c, cy + s * ox - c * oy, 0, 0, 1];
    return { W, H, M };
  }

  AD.registerFilter({
    id: 'rotate', name: 'Rotate', category: 'Edit',
    description: 'Rotate by any angle (clockwise positive). Multiples of 90° are exact, with no interpolation.',
    keywords: ['turn', 'straighten', 'level horizon', 'tilt'],
    testSample: 'plate',
    params: [
      { id: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, step: 0.1, default: -3, unit: '°' },
      { id: 'expand', label: 'Enlarge canvas to fit', type: 'bool', default: true },
      { id: 'background', label: 'Background', type: 'color', default: '#000000' },
      INTERP,
    ],
    apply(input, p) {
      if (Math.abs(p.angle % 90) < 1e-9) return G.rotate90(input, Math.round(p.angle / 90));
      const { W, H, M } = rotationSetup(input, p);
      return AD.geom.warpPerspective(input, M, W, H, p.interp, hex(p.background));
    },
    gpu(input, p) {
      if (p.interp !== 'bilinear' || Math.abs(p.angle % 90) < 1e-9) throw new Error('only bilinear rotation runs on the GPU');
      const { W, H, M } = rotationSetup(input, p);
      return gpuWarp(input, M, W, H, hex(p.background));
    },
  });

  AD.registerFilter({
    id: 'flip', name: 'Flip / Mirror', category: 'Edit',
    description: 'Mirror the image horizontally, vertically, or both.',
    keywords: ['mirror', 'reverse'],
    params: [{ id: 'axis', label: 'Flip', type: 'select', default: 'h', options: [{ value: 'h', label: 'Horizontally (left ↔ right)' }, { value: 'v', label: 'Vertically (top ↔ bottom)' }, { value: 'both', label: 'Both (= rotate 180°)' }] }],
    margin: p => (p.axis === 'h' ? 0 : NaN),   // only a horizontal flip keeps rows independent
    apply(input, p) {
      const { width: w, height: h } = input, d = input.data, out = new ImageData(w, h), o = out.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = p.axis === 'v' ? x : w - 1 - x, sy = p.axis === 'h' ? y : h - 1 - y, i = (sy * w + sx) * 4, j = (y * w + x) * 4;
        o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255;
      }
      return out;
    },
  });

  // ---------------------------------------------------------------- pixel aspect ratio
  const PAR = { pal43: 16 / 15, pal169: 64 / 45, ntsc43: 10 / 11, ntsc169: 40 / 33, field: 2 };
  AD.registerFilter({
    id: 'pixel-aspect', name: 'Pixel Aspect Ratio', category: 'Edit',
    description: 'Correct non-square pixels (e.g. PAL/NTSC DVR footage, or single-field images that look squashed) so shapes and measurements are true.',
    keywords: ['par', 'anamorphic', 'squashed', 'stretched', 'd1', 'pal', 'ntsc', 'field'],
    testSample: 'plate',
    params: [
      { id: 'preset', label: 'Source pixels', type: 'select', default: 'pal43', options: [
        { value: 'pal43', label: 'PAL 4:3 (16:15)' }, { value: 'pal169', label: 'PAL 16:9 (64:45)' }, { value: 'ntsc43', label: 'NTSC 4:3 (10:11)' },
        { value: 'ntsc169', label: 'NTSC 16:9 (40:33)' }, { value: 'field', label: 'Single field (2:1 tall)' }, { value: 'custom', label: 'Custom' }] },
      { id: 'ratio', label: 'Pixel width ÷ height', type: 'range', min: 0.25, max: 4, step: 0.001, default: 1, when: p => p.preset === 'custom' },
      { id: 'mode', label: 'Fix by', type: 'select', default: 'width', options: [{ value: 'width', label: 'Changing width' }, { value: 'height', label: 'Changing height' }] },
    ],
    apply(input, p) {
      const r = p.preset === 'custom' ? p.ratio : PAR[p.preset];
      // 'field' means each pixel stands for two lines: stretch vertically
      const sx = p.preset === 'field' ? 1 : p.mode === 'width' ? r : 1, sy = p.preset === 'field' ? 2 : p.mode === 'height' ? 1 / r : 1;
      return G.resample(input, input.width * sx, input.height * sy, 'bicubic');
    },
  });

  // ---------------------------------------------------------------- perspective correction
  G.quadSize = q => {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return { w: (d(q[0], q[1]) + d(q[3], q[2])) / 2, h: (d(q[0], q[3]) + d(q[1], q[2])) / 2 };
  };
  function perspectiveSetup(input, p) {
    if (!p.quad || p.quad.length !== 4) throw new Error('place all four corner points');
    const q = p.quad.map(c => ({ x: c.x - 0.5, y: c.y - 0.5 }));   // marked points are pixel-edge coords; warps use pixel centres
    const est = G.quadSize(q);
    let W, H;
    if (p.size === 'aspect') { const a = Math.max(1e-6, p.realW) / Math.max(1e-6, p.realH); W = Math.max(est.w, est.h * a); H = W / a; }
    else if (p.size === 'px') { W = p.outW; H = p.outH; }
    else { W = est.w; H = est.h; }
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    // the marked corners are the object's outer edges, so map them to the output's pixel edges
    const rect = [{ x: -0.5, y: -0.5 }, { x: W - 0.5, y: -0.5 }, { x: W - 0.5, y: H - 0.5 }, { x: -0.5, y: H - 0.5 }];
    let outToIn = AD.geom.homography(rect, q);
    if (!outToIn) throw new Error('the four points are degenerate (three in a line?)');
    let OW = W, OH = H;
    if (p.whole) {
      const inToOut = AD.geom.invert(outToIn), pts = [[0, 0], [input.width - 1, 0], [input.width - 1, input.height - 1], [0, input.height - 1]].map(([x, y]) => AD.geom.apply(inToOut, x, y));
      if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) throw new Error('the whole frame does not fit (horizon inside the image); turn off "Rectify whole frame"');
      const x0 = Math.min(...pts.map(t => t[0])), y0 = Math.min(...pts.map(t => t[1])), x1 = Math.max(...pts.map(t => t[0])), y1 = Math.max(...pts.map(t => t[1]));
      const cap = Math.sqrt(Math.max(1, (x1 - x0) * (y1 - y0)) / (input.width * input.height * 4)), k = Math.max(1, cap);
      OW = Math.max(1, Math.round((x1 - x0) / k)); OH = Math.max(1, Math.round((y1 - y0) / k));
      outToIn = AD.geom.multiply(outToIn, [k, 0, x0, 0, k, y0, 0, 0, 1]);
    }
    return { outToIn, OW, OH, W, H };
  }

  AD.registerFilter({
    id: 'perspective-correction', name: 'Perspective Correction', category: 'Edit',
    description: 'Make a plane seen at an angle (licence plate, document, sign, floor) appear face-on: mark its four corners and it is rectified to a rectangle.',
    keywords: ['rectify', 'homography', 'keystone', 'licence plate', 'document', 'plane'],
    testSample: 'plate',
    params: [
      { id: 'quad', label: 'Corners', type: 'points', count: 4, shape: 'polygon', labels: ['TL', 'TR', 'BR', 'BL'],
        default: inp => [{ x: inp.width * 0.3, y: inp.height * 0.3 }, { x: inp.width * 0.7, y: inp.height * 0.3 }, { x: inp.width * 0.7, y: inp.height * 0.7 }, { x: inp.width * 0.3, y: inp.height * 0.7 }],
        hint: 'Drag TL, TR, BR, BL onto the corners of the flat object, in that order.' },
      { id: 'size', label: 'Output size', type: 'select', default: 'auto', options: [
        { value: 'auto', label: 'From the marked edges' }, { value: 'aspect', label: 'From real-world dimensions' }, { value: 'px', label: 'Exact pixels' }] },
      { id: 'realW', label: 'Real width', type: 'number', min: 0.001, step: 'any', default: 520, when: p => p.size === 'aspect', hint: 'Any unit; e.g. an EU plate is 520 × 110 mm.' },
      { id: 'realH', label: 'Real height', type: 'number', min: 0.001, step: 'any', default: 110, when: p => p.size === 'aspect' },
      { id: 'outW', label: 'Width', type: 'number', min: 1, max: 8192, step: 1, unit: 'px', default: 520, when: p => p.size === 'px' },
      { id: 'outH', label: 'Height', type: 'number', min: 1, max: 8192, step: 1, unit: 'px', default: 110, when: p => p.size === 'px' },
      { id: 'whole', label: 'Rectify whole frame (not just the marked area)', type: 'bool', default: false },
      INTERP,
    ],
    apply(input, p) {
      const { outToIn, OW, OH, W, H } = perspectiveSetup(input, p);
      return { image: AD.geom.warpPerspective(input, outToIn, OW, OH, p.interp, [0, 0, 0]), readout: { 'Rectified size': `${W} × ${H} px`, Output: `${OW} × ${OH} px` } };
    },
    gpu(input, p) {
      if (p.interp !== 'bilinear') throw new Error('only bilinear warps run on the GPU');
      const { outToIn, OW, OH, W, H } = perspectiveSetup(input, p);
      return { image: gpuWarp(input, outToIn, OW, OH, [0, 0, 0]), readout: { 'Rectified size': `${W} × ${H} px`, Output: `${OW} × ${OH} px` } };
    },
  });

  // ---------------------------------------------------------------- lens distortion (Brown-Conrady)
  // Coordinates are normalised by the half-diagonal R around the (offset) centre. The model maps an undistorted
  // (corrected) point u to where it appears in the distorted photo:
  //   d = u (1 + k1 r² + k2 r⁴ + k3 r⁶) + tangential(p1, p2), r = |u|.  Barrel distortion has k1 < 0.
  G.distort = (x, y, p) => {
    const r2 = x * x + y * y, rad = 1 + p.k1 * r2 + p.k2 * r2 * r2 + p.k3 * r2 * r2 * r2;
    return [x * rad + 2 * p.p1 * x * y + p.p2 * (r2 + 2 * x * x), y * rad + p.p1 * (r2 + 2 * y * y) + 2 * p.p2 * x * y];
  };
  // Inverse by fixed-point iteration (distorted -> undistorted).
  G.undistort = (x, y, p) => {
    let ux = x, uy = y;
    for (let i = 0; i < 30; i++) {
      const [dx, dy] = G.distort(ux, uy, p);
      ux += x - dx; uy += y - dy;
    }
    return [ux, uy];
  };
  function lensSetup(input, p) {
    const { width: w, height: h } = input, cx = (w - 1) / 2 + p.cx / 100 * w, cy = (h - 1) / 2 + p.cy / 100 * h, R = Math.hypot(w, h) / 2;
    let s = 1;   // output zoom: output normalised coord u = (x - cx) / R * s
    if (p.fit !== 'none') {
      const border = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16; border.push([t * (w - 1), 0], [t * (w - 1), h - 1], [0, t * (h - 1)], [w - 1, t * (h - 1)]); }
      if (p.fit === 'fill') {
        // largest s so every output border pixel samples inside the source
        let lo = 0.1, hi = 10;
        for (let it = 0; it < 40; it++) {
          const m = (lo + hi) / 2;
          const ok = border.every(([x, y]) => { const [dx, dy] = G.distort((x - cx) / R * m, (y - cy) / R * m, p); const sx = cx + dx * R, sy = cy + dy * R; return sx >= -0.5 && sy >= -0.5 && sx <= w - 0.5 && sy <= h - 0.5; });
          if (ok) lo = m; else hi = m;
        }
        s = lo;
      } else {
        // keep: every source border pixel lands inside the output
        let need = 0;
        for (const [x, y] of border) { const [ux, uy] = G.undistort((x - cx) / R, (y - cy) / R, p); need = Math.max(need, Math.abs(ux) * R / ((w - 1) / 2 + 1e-9), Math.abs(uy) * R / ((h - 1) / 2 + 1e-9)); }
        s = need > 0 ? need : 1;
      }
    }
    return { w, h, cx, cy, R, s };
  }

  // Straightness error of point groups after undoing distortion with params p (sum of squared line residuals).
  G.lineResidual = (groups, w, h, p) => {
    const cx = (w - 1) / 2 + p.cx / 100 * w, cy = (h - 1) / 2 + p.cy / 100 * h, R = Math.hypot(w, h) / 2;
    let err = 0;
    for (const g of groups) {
      if (g.length < 3) continue;
      const pts = g.map(q => G.undistort((q.x - cx) / R, (q.y - cy) / R, p));
      const mx = pts.reduce((s, q) => s + q[0], 0) / pts.length, my = pts.reduce((s, q) => s + q[1], 0) / pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
      // smallest eigenvalue of the scatter matrix = sum of squared perpendicular distances to the best line
      err += (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    }
    return err;
  };
  G.estimateK1 = (groups, w, h, base) => {
    const f = k1 => G.lineResidual(groups, w, h, { ...base, k1 });
    let a = -1, b = 1;
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = b - gr * (b - a), d = a + gr * (b - a), fc = f(c), fd = f(d);
    for (let i = 0; i < 60; i++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = f(c); }
      else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = f(d); }
    }
    return (a + b) / 2;
  };

  const lineParam = n => ({ id: `line${n}`, label: `Straight line ${n}`, type: 'points', min: 0, max: 16, shape: 'polyline', default: [],
    hint: n === 1 ? 'Click 3+ points along an edge that should be straight (building, kerb, door). Use 2–4 lines, ideally near the image edges.' : undefined });

  AD.registerFilter({
    id: 'lens-distortion', name: 'Lens Distortion', category: 'Edit',
    description: 'Straighten lines bent by wide-angle or fisheye-like lenses (barrel or pincushion distortion), using the Brown–Conrady model. Mark lines that should be straight and press Estimate.',
    keywords: ['barrel', 'pincushion', 'fisheye', 'undistort', 'wide angle', 'dashcam', 'cctv'],
    testSample: 'barrel',
    params: [
      { id: 'k1', label: 'Radial k1', type: 'range', min: -1, max: 1, step: 0.001, default: -0.2, hint: 'Negative corrects barrel (bulging) distortion.' },
      { id: 'k2', label: 'Radial k2', type: 'range', min: -1, max: 1, step: 0.001, default: 0 },
      { id: 'k3', label: 'Radial k3', type: 'range', min: -1, max: 1, step: 0.001, default: 0 },
      { id: 'p1', label: 'Tangential p1', type: 'range', min: -0.1, max: 0.1, step: 0.0005, default: 0 },
      { id: 'p2', label: 'Tangential p2', type: 'range', min: -0.1, max: 0.1, step: 0.0005, default: 0 },
      { id: 'cx', label: 'Centre offset X', type: 'range', min: -20, max: 20, step: 0.1, default: 0, unit: '%' },
      { id: 'cy', label: 'Centre offset Y', type: 'range', min: -20, max: 20, step: 0.1, default: 0, unit: '%' },
      { id: 'fit', label: 'Framing', type: 'select', default: 'fill', options: [{ value: 'fill', label: 'Zoom to hide empty corners' }, { value: 'keep', label: 'Keep every source pixel' }, { value: 'none', label: 'No zoom' }] },
      lineParam(1), lineParam(2), lineParam(3), lineParam(4),
      INTERP,
    ],
    actions: [{ id: 'estimate', label: 'Estimate k1 from lines', run: async (input, p) => {
      const groups = [p.line1, p.line2, p.line3, p.line4].filter(g => Array.isArray(g) && g.length >= 3);
      if (!groups.length) throw new Error('mark at least one line with 3 or more points first');
      return { k1: Math.round(G.estimateK1(groups, input.width, input.height, { ...p, k2: 0, k3: 0 }) * 1000) / 1000, k2: 0, k3: 0 };
    } }],
    apply(input, p) {
      const { w, h, cx, cy, R, s } = lensSetup(input, p);
      const out = AD.img.warp(input, w, h, (x, y, t) => {
        const [dx, dy] = G.distort((x - cx) / R * s, (y - cy) / R * s, p);
        t[0] = cx + dx * R; t[1] = cy + dy * R; return true;
      }, p.interp, [0, 0, 0]);
      const overlay = [];
      for (const g of [p.line1, p.line2, p.line3, p.line4]) if (Array.isArray(g) && g.length >= 2) {
        // show where the marked points end up after correction
        overlay.push({ type: 'poly', color: 'warn', points: g.map(q => { const [ux, uy] = G.undistort((q.x - cx) / R, (q.y - cy) / R, p); return { x: cx + ux / s * R, y: cy + uy / s * R }; }) });
      }
      return { image: out, overlay, readout: { Zoom: s.toFixed(3) } };
    },
  });

  // ---------------------------------------------------------------- cylinder unroll
  AD.registerFilter({
    id: 'unroll-cylinder', name: 'Unroll Cylinder', category: 'Edit',
    description: 'Flatten text or a label wrapped around a cylinder (bottle, can, pole) seen side-on. Draw the region from the cylinder\'s left edge to its right edge.',
    keywords: ['unwrap', 'bottle', 'can', 'label', 'curved', 'pole'],
    testSample: 'cylinder',
    params: [
      { id: 'rect', label: 'Cylinder region', type: 'rect', default: inp => ({ x: inp.width * 0.2, y: inp.height * 0.2, w: inp.width * 0.6, h: inp.height * 0.6 }),
        hint: 'Left and right sides on the cylinder\'s silhouette; top and bottom around the part to flatten.' },
      { id: 'maxAngle', label: 'Unroll up to', type: 'range', min: 30, max: 89, step: 1, default: 75, unit: '°', hint: 'Near the silhouette the surface is seen edge-on and has little detail.' },
      INTERP,
    ],
    apply(input, p) {
      const r = p.rect;
      if (!r) throw new Error('draw the cylinder region first');
      const R = Math.max(0.5, r.w / 2), cx = r.x + r.w / 2, th = p.maxAngle * Math.PI / 180;
      const W = Math.max(1, Math.round(2 * th * R)), H = Math.max(1, Math.round(r.h));
      return { image: AD.img.warp(input, W, H, (x, y, t) => { const a = ((x + 0.5) / W * 2 - 1) * th; t[0] = cx + R * Math.sin(a) - 0.5; t[1] = r.y + y; return true; }, p.interp),
        readout: { Radius: `${(R).toFixed(1)} px`, 'Arc shown': `${(2 * p.maxAngle).toFixed(0)}°`, Output: `${W} × ${H} px` } };
    },
  });

  // ---------------------------------------------------------------- canvas size
  const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'centre', 'right', 'bottom-left', 'bottom', 'bottom-right'];
  AD.registerFilter({
    id: 'canvas-size', name: 'Canvas Size', category: 'Edit',
    description: 'Pad or trim the image to an exact size without scaling it.',
    keywords: ['pad', 'border', 'frame size', 'extend'],
    params: [
      { id: 'width', label: 'Width', type: 'number', min: 1, max: 16384, step: 1, unit: 'px', default: inp => inp.width + 100 },
      { id: 'height', label: 'Height', type: 'number', min: 1, max: 16384, step: 1, unit: 'px', default: inp => inp.height + 100 },
      { id: 'anchor', label: 'Anchor', type: 'select', default: 'centre', options: ANCHORS.map(a => ({ value: a, label: a })) },
      { id: 'color', label: 'Fill', type: 'color', default: '#000000' },
    ],
    apply(input, p) {
      const W = Math.max(1, Math.round(p.width)), H = Math.max(1, Math.round(p.height)), k = ANCHORS.indexOf(p.anchor), ax = k % 3, ay = Math.floor(k / 3);
      const ox = Math.round((W - input.width) * ax / 2), oy = Math.round((H - input.height) * ay / 2), [fr, fg, fb] = hex(p.color);
      const out = new ImageData(W, H), o = out.data, d = input.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = x - ox, sy = y - oy, j = (y * W + x) * 4;
        if (sx >= 0 && sy >= 0 && sx < input.width && sy < input.height) { const i = (sy * input.width + sx) * 4; o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; }
        else { o[j] = fr; o[j + 1] = fg; o[j + 2] = fb; }
        o[j + 3] = 255;
      }
      return out;
    },
  });

  // ---------------------------------------------------------------- sample
  if (typeof document !== 'undefined') {
    AD.registerSample({ id: 'cylinder', name: 'Label on a bottle', category: 'Edit', description: 'text and stripes wrapped round a cylinder',
      make: async () => {
        const w = 800, h = 520, flat = document.createElement('canvas'); flat.width = 900; flat.height = 260;
        const g = flat.getContext('2d');
        g.fillStyle = '#f1ead8'; g.fillRect(0, 0, 900, 260);
        for (let x = 0; x < 900; x += 60) { g.fillStyle = (x / 60) % 2 ? '#1f3d8a' : '#d9431c'; g.fillRect(x, 0, 30, 34); }
        g.fillStyle = '#1a1a1a'; g.font = '600 64px "IBM Plex Mono", ui-monospace, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('BATCH 7Q-4419-K', 450, 120);
        g.font = '500 30px "IBM Plex Mono", ui-monospace, monospace'; g.fillText('EXP 2027-03  LOT 88231', 450, 200);
        const label = g.getImageData(0, 0, 900, 260);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const cg = c.getContext('2d'), grad = cg.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, '#2c3a3f'); grad.addColorStop(1, '#46565b'); cg.fillStyle = grad; cg.fillRect(0, 0, w, h);
        const bg = cg.getImageData(0, 0, w, h), R = 230, cx = 400, top = 130;
        // the label covers 200° of the bottle; we see the front 180°
        const span = 200 * Math.PI / 180;
        for (let y = 0; y < 260; y++) for (let x = cx - R; x < cx + R; x++) {
          const s = (x + 0.5 - cx) / R; if (Math.abs(s) >= 1) continue;
          const a = Math.asin(s), u = (a / span + 0.5) * 900, shade = 0.55 + 0.45 * Math.cos(a);
          if (u < 0 || u >= 899) continue;
          const i = ((top + y) * w + x) * 4, u0 = Math.floor(u), f = u - u0, li = (y * 900 + u0) * 4;
          for (let k = 0; k < 3; k++) bg.data[i + k] = (label.data[li + k] * (1 - f) + label.data[li + 4 + k] * f) * shade;
        }
        return bg;
      } });
  }
})(typeof window !== 'undefined' ? window : globalThis);
