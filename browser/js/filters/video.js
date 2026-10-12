// Video integration: motion-compensated smoothing and plain frame averaging.
(function (root) {
  const AD = root.AD;
  const VD = AD.video = AD.video || {};
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---------------------------------------------------------------- motion estimation
  // Box-downsample a plane by an integer factor.
  function downsample(Y, w, h, f) {
    const W = Math.max(1, Math.floor(w / f)), H = Math.max(1, Math.floor(h / f)), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += Y[(y * f + j) * w + x * f + i];
      out[y * W + x] = s / (f * f);
    }
    return { P: out, W, H };
  }

  // Sum of absolute differences between the block at (x0, y0) of A and the block displaced by (dx, dy) in B.
  // Pixels displaced outside B are clamped to the edge.
  function sad(A, B, w, h, x0, y0, bw, bh, dx, dy, limit) {
    let s = 0;
    for (let y = y0; y < y0 + bh; y++) {
      const by = clamp(y + dy, 0, h - 1) * w, ay = y * w;
      for (let x = x0; x < x0 + bw; x++) {
        const d = A[ay + x] - B[by + clamp(x + dx, 0, w - 1)];
        s += d < 0 ? -d : d;
      }
      if (s >= limit) return s;   // early exit: already worse than the best candidate
    }
    return s;
  }

  // Block motion from frame A (current) to frame B (neighbour): for each block, the displacement (vx, vy) such
  // that A(p) ≈ B(p + v). Coarse search on a 4x downsampled image, predictive candidates from neighbouring
  // blocks, full-resolution refinement and parabolic sub-pixel interpolation.
  VD.estimateMotion = (A, B, w, h, { block = 16, search = 32 } = {}) => {
    const bx = Math.max(1, Math.ceil(w / block)), by = Math.max(1, Math.ceil(h / block));
    const vx = new Float32Array(bx * by), vy = new Float32Array(bx * by), err = new Float32Array(bx * by);
    const f = w >= 64 && h >= 64 && search >= 8 ? 4 : 1;
    const a = f > 1 ? downsample(A, w, h, f) : { P: A, W: w, H: h }, b = f > 1 ? downsample(B, w, h, f) : { P: B, W: w, H: h };
    const cs = Math.max(1, Math.ceil(search / f));
    for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
      const x0 = i * block, y0 = j * block, bw = Math.min(block, w - x0), bh = Math.min(block, h - y0), k = j * bx + i;
      // coarse full search
      const cx0 = Math.floor(x0 / f), cy0 = Math.floor(y0 / f), cbw = Math.max(1, Math.min(Math.ceil(bw / f), a.W - cx0)), cbh = Math.max(1, Math.min(Math.ceil(bh / f), a.H - cy0));
      // Predicted motion: median of the left, upper and upper-right neighbours (already estimated).
      const nbrs = [];
      if (i > 0) nbrs.push(k - 1);
      if (j > 0) { nbrs.push(k - bx); if (i + 1 < bx) nbrs.push(k - bx + 1); }
      const med = arr => { const a = arr.slice().sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; };
      const px = Math.round(med(nbrs.map(q => vx[q]))), py = Math.round(med(nbrs.map(q => vy[q])));
      // Cost = SAD + λ · area · distance to the nearer of "no motion" and the prediction. Noise makes many offsets
      // almost equally good in weakly textured blocks; the penalty keeps the field coherent there and costs
      // nothing where the texture decides clearly.
      const LAMBDA = 0.6;
      const penalty = (dx, dy, area, unit) => LAMBDA * area * Math.min(Math.abs(dx) + Math.abs(dy), Math.abs(dx - px / unit) + Math.abs(dy - py / unit));
      let best = Infinity, bdx = 0, bdy = 0;
      for (let dy = -cs; dy <= cs; dy++) for (let dx = -cs; dx <= cs; dx++) {
        const pen = penalty(dx, dy, cbw * cbh, f);
        if (pen >= best) continue;
        const s = sad(a.P, b.P, a.W, a.H, cx0, cy0, cbw, cbh, dx, dy, best - pen) + pen;
        if (s < best) { best = s; bdx = dx; bdy = dy; }
      }
      // candidates at full resolution: coarse result, zero and the prediction
      const cands = [[bdx * f, bdy * f], [0, 0], [px, py]];
      let fb = Infinity, fx = 0, fy = 0;
      for (const [cx, cy] of cands) {
        const s = sad(A, B, w, h, x0, y0, bw, bh, cx, cy, fb) + penalty(cx, cy, bw * bh, 1);
        if (s < fb) { fb = s; fx = cx; fy = cy; }
      }
      // refine around the best candidate
      const r = f > 1 ? f : 2;
      let rx = fx, ry = fy;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(fx + dx) > search || Math.abs(fy + dy) > search) continue;
        const pen = penalty(fx + dx, fy + dy, bw * bh, 1);
        const s = sad(A, B, w, h, x0, y0, bw, bh, fx + dx, fy + dy, fb - pen) + pen;
        if (s < fb) { fb = s; rx = fx + dx; ry = fy + dy; }
      }
      fb = sad(A, B, w, h, x0, y0, bw, bh, rx, ry, Infinity);   // plain SAD for the sub-pixel fit and error
      // parabolic sub-pixel refinement on each axis
      const sp = (m, c, p) => { const den = m - 2 * c + p; return den > 0 ? clamp(0.5 * (m - p) / den, -0.5, 0.5) : 0; };
      const sx = sp(sad(A, B, w, h, x0, y0, bw, bh, rx - 1, ry, Infinity), fb, sad(A, B, w, h, x0, y0, bw, bh, rx + 1, ry, Infinity));
      const sy = sp(sad(A, B, w, h, x0, y0, bw, bh, rx, ry - 1, Infinity), fb, sad(A, B, w, h, x0, y0, bw, bh, rx, ry + 1, Infinity));
      vx[k] = rx + sx; vy[k] = ry + sy; err[k] = fb / (bw * bh);
    }
    return { vx, vy, err, bx, by, block };
  };

  // Dense displacement at pixel (x, y): bilinear interpolation between block centres (no block seams).
  function denseField(F, w, h) {
    const dx = new Float32Array(w * h), dy = new Float32Array(w * h), B = F.block;
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) / B - 0.5, 0, F.by - 1), j0 = Math.floor(fy), j1 = Math.min(F.by - 1, j0 + 1), ty = fy - j0;
      for (let x = 0; x < w; x++) {
        const fx = clamp((x + 0.5) / B - 0.5, 0, F.bx - 1), i0 = Math.floor(fx), i1 = Math.min(F.bx - 1, i0 + 1), tx = fx - i0;
        const a = j0 * F.bx + i0, b = j0 * F.bx + i1, c = j1 * F.bx + i0, d = j1 * F.bx + i1;
        dx[y * w + x] = (F.vx[a] * (1 - tx) + F.vx[b] * tx) * (1 - ty) + (F.vx[c] * (1 - tx) + F.vx[d] * tx) * ty;
        dy[y * w + x] = (F.vy[a] * (1 - tx) + F.vy[b] * tx) * (1 - ty) + (F.vy[c] * (1 - tx) + F.vy[d] * tx) * ty;
      }
    }
    return { dx, dy };
  }

  const toPlanes3 = img => { const P = AD.img.toPlanes(img); return [P.r, P.g, P.b]; };

  // ---------------------------------------------------------------- Motion Smoothing
  AD.registerFilter({
    id: 'motion-smoothing', name: 'Motion Smoothing', category: 'Integrate',
    description: 'Reduce noise in video by averaging each frame with its neighbours after aligning them to it, so moving objects and camera pans stay sharp instead of ghosting. Where alignment fails, a neighbour is ignored for those pixels.',
    keywords: ['temporal', 'denoise', 'motion compensated', 'video smoothing', 'noise reduction', 'frames', 'integrate'],
    testSample: 'traffic',
    temporal: true,
    params: [
      { id: 'radius', label: 'Frames each side', type: 'range', min: 1, max: 6, step: 1, default: 2, hint: '2 averages up to 5 frames.' },
      { id: 'tolerance', label: 'Noise tolerance', type: 'range', min: 2, max: 60, step: 1, default: 18, hint: 'About the noise level (0–255 levels). Higher smooths more but may ghost where alignment is poor.' },
      { id: 'search', label: 'Largest motion', type: 'range', min: 4, max: 96, step: 1, default: 32, unit: 'px', hint: 'Biggest movement between neighbouring frames to look for.' },
      { id: 'block', label: 'Block size', type: 'select', default: 16, options: [{ value: 8, label: '8 px (finer motion, slower)' }, { value: 16, label: '16 px' }, { value: 32, label: '32 px (smoother, faster)' }] },
      { id: 'show', label: 'Show', type: 'select', default: 'result', options: [
        { value: 'result', label: 'Result' }, { value: 'vectors', label: 'Result with motion vectors' }, { value: 'weights', label: 'Frames used per pixel' }] },
    ],
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, n = w * h, R = Math.round(p.radius), f = ctx.frameIndex, N = ctx.inputFrameCount;
      if (N < 2) return { image: AD.img.clone(input), readout: { Note: 'Single frame: nothing to average.' } };
      const block = Math.max(4, Math.round(+p.block * ctx.scale)), search = Math.max(2, Math.round(p.search));
      const Yc = AD.img.luma(input), C = toPlanes3(input);   // motion is estimated on luma
      const acc = C.map(pl => Float64Array.from(pl)), wsum = new Float64Array(n).fill(1);
      // Trust is judged on the worst colour channel (a misaligned red texture can look fine in luma). For noise
      // of σ = tolerance, the 3x3 mean |difference| of a correctly aligned channel is about 1.13σ, so the
      // knee sits above the noise of the worst of three channels.
      const t = p.tolerance, knee = 1.6 * t, soft = 2 * (0.8 * t) ** 2;
      const diff = new Float32Array(n);
      let used = 0, motionPrev = null, overlay = [];
      for (let d = -R; d <= R; d++) {
        const g = f + d;
        if (!d || g < 0 || g >= N) continue;
        const nb = await ctx.input(g);
        if (nb.width !== w || nb.height !== h) continue;
        const Yn = AD.img.luma(nb), F = VD.estimateMotion(Yc, Yn, w, h, { block, search });
        await ctx.checkpoint();
        const { dx, dy } = denseField(F, w, h), Nn = toPlanes3(nb), warped = Nn.map(() => new Float32Array(n));
        const dms = [];
        for (let c = 0; c < 3; c++) {
          const wc = warped[c], src = Nn[c], cur = C[c];
          for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
            wc[i] = AD.img.sampleBilinear(src, w, h, x + dx[i], y + dy[i]);
            diff[i] = Math.abs(wc[i] - cur[i]);
          }
          dms.push(AD.img.boxBlur(diff, w, h, 1));   // 3x3 mean, so single noisy pixels don't decide on their own
        }
        for (let i = 0; i < n; i++) {
          const e = Math.max(dms[0][i], dms[1][i], dms[2][i]) - knee, wt = e <= 0 ? 1 : Math.exp(-(e * e) / soft);
          if (wt < 0.01) continue;
          for (let c = 0; c < 3; c++) acc[c][i] += wt * warped[c][i];
          wsum[i] += wt;
        }
        used++;
        if (d === -1 || (d === 1 && !motionPrev)) motionPrev = { F, d };
        await ctx.checkpoint();
        ctx.progress(used / Math.min(2 * R, N - 1), 'Motion smoothing');
      }
      const out = new ImageData(w, h), o = out.data;
      let wtot = 0;
      if (p.show === 'weights') {
        for (let i = 0, j = 0; i < n; i++, j += 4) { const v = (wsum[i] - 1) / Math.max(1, used) * 255; o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255; wtot += wsum[i]; }
      } else {
        for (let i = 0, j = 0; i < n; i++, j += 4) { o[j] = acc[0][i] / wsum[i]; o[j + 1] = acc[1][i] / wsum[i]; o[j + 2] = acc[2][i] / wsum[i]; o[j + 3] = 255; wtot += wsum[i]; }
      }
      let mean = 0;
      if (motionPrev) {
        const { F, d } = motionPrev;
        for (let k = 0; k < F.vx.length; k++) mean += Math.hypot(F.vx[k], F.vy[k]);
        mean /= F.vx.length;
        if (p.show === 'vectors') {
          // arrows show where each block moved FROM the neighbouring frame (pointing into the current frame)
          const s = d < 0 ? -1 : 1;
          for (let j = 0; j < F.by; j++) for (let i = 0; i < F.bx; i++) {
            const k = j * F.bx + i, cx = (i + 0.5) * F.block, cy = (j + 0.5) * F.block, mx = F.vx[k] * s, my = F.vy[k] * s;
            if (Math.hypot(mx, my) < 0.75) continue;
            overlay.push({ type: 'line', x1: cx + mx, y1: cy + my, x2: cx, y2: cy, color: Math.hypot(mx, my) > search * 0.9 ? 'hit' : 'warn' });
          }
        }
      }
      return {
        image: out, overlay,
        readout: {
          'Frames averaged (mean)': (wtot / n).toFixed(2) + ` of ${used + 1}`,
          'Mean motion vs. neighbour': `${(mean / ctx.scale).toFixed(1)} px`,
        },
      };
    },
  });

  // ---------------------------------------------------------------- Frame Averaging (no motion compensation)
  AD.registerFilter({
    id: 'frame-average', name: 'Frame Averaging', category: 'Integrate',
    description: 'Combine several frames pixel by pixel (mean, median, minimum or maximum) without any alignment. Reduces noise on a static camera; moving things blur or ghost (use Motion Smoothing for those).',
    keywords: ['average', 'integrate', 'median', 'temporal', 'stack', 'noise'],
    testSample: 'traffic',
    temporal: true,
    params: [
      { id: 'mode', label: 'Frames', type: 'select', default: 'window', options: [{ value: 'window', label: 'Sliding window around each frame' }, { value: 'range', label: 'Whole range into one image' }] },
      { id: 'radius', label: 'Frames each side', type: 'range', min: 1, max: 15, step: 1, default: 2, when: p => p.mode === 'window' },
      { id: 'from', label: 'First frame', type: 'range', min: 0, max: 'lastFrame', step: 1, default: 0, when: p => p.mode === 'range' },
      { id: 'to', label: 'Last frame', type: 'range', min: 0, max: 'lastFrame', step: 1, default: (inp, info) => Math.min(info.frameCount - 1, 24), when: p => p.mode === 'range' },
      { id: 'op', label: 'Combine by', type: 'select', default: 'mean', options: [{ value: 'mean', label: 'Mean' }, { value: 'median', label: 'Median (removes passing objects)' }, { value: 'min', label: 'Minimum' }, { value: 'max', label: 'Maximum' }] },
    ],
    frameCount: (n, p) => (p.mode === 'range' ? 1 : n),
    async apply(_input, p, ctx) {
      const N = ctx.inputFrameCount, list = [];
      if (p.mode === 'range') { const a = clamp(Math.min(p.from, p.to), 0, N - 1), b = clamp(Math.max(p.from, p.to), 0, N - 1); for (let i = a; i <= b; i++) list.push(i); }
      else for (let i = ctx.frameIndex - Math.round(p.radius); i <= ctx.frameIndex + Math.round(p.radius); i++) if (i >= 0 && i < N) list.push(i);
      const frames = [];
      for (const i of list) { const fr = await ctx.input(i); if (!frames.length || (fr.width === frames[0].width && fr.height === frames[0].height)) frames.push(fr); await ctx.checkpoint(); }
      const { width: w, height: h } = frames[0], out = new ImageData(w, h), o = out.data, k = frames.length, buf = new Float32Array(k);
      for (let i = 0; i < w * h * 4; i++) {
        if ((i & 3) === 3) { o[i] = 255; continue; }
        if (p.op === 'mean') { let s = 0; for (let j = 0; j < k; j++) s += frames[j].data[i]; o[i] = s / k; continue; }
        for (let j = 0; j < k; j++) buf[j] = frames[j].data[i];
        if (p.op === 'min') { let m = 255; for (let j = 0; j < k; j++) if (buf[j] < m) m = buf[j]; o[i] = m; }
        else if (p.op === 'max') { let m = 0; for (let j = 0; j < k; j++) if (buf[j] > m) m = buf[j]; o[i] = m; }
        else { const a = buf.subarray(0, k).sort(); o[i] = k % 2 ? a[k >> 1] : (a[k / 2 - 1] + a[k / 2]) / 2; }
      }
      return { image: out, readout: { 'Frames combined': k } };
    },
  });

  // ---------------------------------------------------------------- sample
  if (typeof document !== 'undefined') {
    AD.registerSample({ id: 'traffic', name: 'Noisy street, moving car', category: 'Integrate', description: '40 frames: car drives through, camera pans slowly, sensor noise',
      make: async () => {
        const T = AD.sampleTools, w = 640, h = 400, frames = [];
        for (let f = 0; f < 40; f++) {
          const big = T.scene(w + 80, h + 20, { t: f * 7 - 140, plate: 'TR 314 VK' });
          frames.push(T.addNoise(AD.img.crop(big, 20 + f, 10, w, h), 20, 300 + f));   // pan 1 px/frame, car 7 px/frame
        }
        return { frames, fps: 25 };
      } });
  }
})(typeof window !== 'undefined' ? window : globalThis);
