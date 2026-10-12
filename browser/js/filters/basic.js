// Reference filters that exercise each part of the filter API: frame selection (frameCount), a rect parameter,
// a margin-free point operation with readout, and the saturation anomaly detector from the original app.
(function (root) {
  const AD = root.AD;

  AD.registerFilter({
    id: 'select-frames', name: 'Select Frames', category: 'Select Frames',
    description: 'Keep a range of frames, optionally every Nth one.',
    keywords: ['trim', 'range', 'decimate', 'skip'],
    params: [
      { id: 'from', label: 'First frame', type: 'range', min: 0, max: 'lastFrame', step: 1, default: 0 },
      { id: 'to', label: 'Last frame', type: 'range', min: 0, max: 'lastFrame', step: 1, default: (inp, info) => info.frameCount - 1 },
      { id: 'every', label: 'Keep every Nth frame', type: 'range', min: 1, max: 30, step: 1, default: 1 },
    ],
    frameCount: (n, p) => {
      const a = Math.min(p.from, p.to), b = Math.min(Math.max(p.from, p.to), n - 1);
      return Math.max(1, Math.floor((b - a) / Math.max(1, p.every)) + 1);
    },
    temporal: true,
    async apply(_input, p, ctx) {
      const a = Math.min(p.from, p.to);
      return AD.img.clone(await ctx.input(a + ctx.frameIndex * Math.max(1, p.every)));
    },
  });

  AD.registerFilter({
    id: 'crop', name: 'Crop', category: 'Edit',
    description: 'Cut out a rectangular region.',
    params: [{ id: 'rect', label: 'Region', type: 'rect', default: inp => ({ x: Math.round(inp.width * 0.25), y: Math.round(inp.height * 0.25), w: Math.round(inp.width * 0.5), h: Math.round(inp.height * 0.5) }) }],
    apply(input, p) {
      const r = p.rect;
      return AD.img.crop(input, r.x, r.y, Math.max(1, r.w), Math.max(1, r.h));
    },
  });

  // Ported from the first browser version: contrast-limited equalisation, then HSL saturation, thresholded.
  AD.registerFilter({
    id: 'saturation-anomaly', name: 'Saturation Anomaly', category: 'Extract',
    description: 'Contrast-limited histogram equalisation, then the HSL saturation channel; pixels above the threshold are highlighted.',
    keywords: ['hsl', 'colour', 'tint', 'detect'],
    params: [
      { id: 'view', label: 'Show', type: 'select', default: 'highlight', options: [
        { value: 'highlight', label: 'Highlight over greyscale' }, { value: 'saturation', label: 'Saturation channel' }, { value: 'equalized', label: 'Equalised colour' }] },
      { id: 'equalize', label: 'Equalise histogram first', type: 'bool', default: true },
      { id: 'clip', label: 'Contrast boost limit', type: 'range', min: 1, max: 40, step: 1, default: 20, when: p => p.equalize },
      { id: 'threshold', label: 'Saturation threshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35 },
      { id: 'color', label: 'Highlight colour', type: 'color', default: '#ff5a1f', when: p => p.view === 'highlight' },
    ],
    apply(input, p) {
      const n = input.width * input.height, src = input.data;
      let eq = input;
      if (p.equalize) {
        eq = AD.img.clone(input);
        const q = eq.data, cap = p.clip * n / 256;
        for (let ch = 0; ch < 3; ch++) {
          const hst = new Float64Array(256);
          for (let i = ch; i < q.length; i += 4) hst[q[i]]++;
          let excess = 0;
          for (let v = 0; v < 256; v++) if (hst[v] > cap) { excess += hst[v] - cap; hst[v] = cap; }
          let acc = 0, min = -1; const lut = new Uint8ClampedArray(256), cdf = new Float64Array(256);
          for (let v = 0; v < 256; v++) { acc += hst[v] + excess / 256; cdf[v] = acc; if (min < 0 && acc > 0) min = acc; }
          for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.max(0, cdf[v] - min) / Math.max(1, n - min) * 255);
          for (let i = ch; i < q.length; i += 4) q[i] = lut[q[i]];
        }
      }
      if (p.view === 'equalized') return { image: p.equalize ? eq : AD.img.clone(input) };
      const e = eq.data, out = new ImageData(input.width, input.height), o = out.data;
      const hex = p.color || '#ff5a1f', hr = parseInt(hex.slice(1, 3), 16), hg = parseInt(hex.slice(3, 5), 16), hb = parseInt(hex.slice(5, 7), 16);
      let sum = 0, hits = 0;
      for (let i = 0; i < e.length; i += 4) {
        const r = e[i] / 255, g = e[i + 1] / 255, b = e[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
        const s = d < 0.05 ? 0 : Math.min(1, d / (1 - Math.abs(2 * l - 1)));
        sum += s;
        if (p.view === 'saturation') { o[i] = o[i + 1] = o[i + 2] = s * 255; }
        else if (s >= p.threshold) { o[i] = hr; o[i + 1] = hg; o[i + 2] = hb; hits++; }
        else { o[i] = o[i + 1] = o[i + 2] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) * 0.8; }
        if (p.view === 'saturation' && s >= p.threshold) hits++;
        o[i + 3] = 255;
      }
      return { image: out, readout: { 'Mean saturation': (sum / n).toFixed(3), 'Pixels above threshold': (hits / n * 100).toFixed(2) + ' %' } };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
