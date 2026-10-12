// Channels: colour-space conversion and channel extraction, mixer, swap, split view, false colour,
// decorrelation stretch (PCA), greyscale and channel difference.
(function (root) {
  const AD = root.AD;
  const CH = AD.channels = {};

  // ---------------------------------------------------------------- colour science
  // sRGB <-> linear via a 256-entry LUT (inputs are 8-bit).
  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const delin = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const Xn = 95.047, Yn = 100, Zn = 108.883;
  const E3 = Math.pow(6 / 29, 3), K3 = 3 * Math.pow(6 / 29, 2);
  const flab = t => (t > E3 ? Math.cbrt(t) : t / K3 + 4 / 29);
  const flabInv = t => (t > 6 / 29 ? t * t * t : K3 * (t - 4 / 29));
  const UN = 4 * Xn / (Xn + 15 * Yn + 3 * Zn), VN = 9 * Yn / (Xn + 15 * Yn + 3 * Zn);
  const hueDeg = (y, x) => { const h = Math.atan2(y, x) * 180 / Math.PI; return h < 0 ? h + 360 : h; };

  function xyz(r, g, b, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    o[0] = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) * 100;
    o[1] = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) * 100;
    o[2] = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) * 100;
  }
  function lab(r, g, b, o) {
    xyz(r, g, b, o);
    const fx = flab(o[0] / Xn), fy = flab(o[1] / Yn), fz = flab(o[2] / Zn);
    o[0] = 116 * fy - 16; o[1] = 500 * (fx - fy); o[2] = 200 * (fy - fz);
  }
  // L*a*b* -> sRGB 0..255 (unclamped floats)
  function lab2rgb(L, a, bb, o) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const X = Xn * flabInv(fx) / 100, Y = Yn * flabInv(fy) / 100, Z = Zn * flabInv(fz) / 100;
    const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    const G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    o[0] = 255 * delin(Math.max(0, R)); o[1] = 255 * delin(Math.max(0, G)); o[2] = 255 * delin(Math.max(0, B));
  }
  CH.lab2rgb = lab2rgb;

  // Each space: components (name, native min/max for display, circular?) and a converter (r, g, b in 0..255) -> o[].
  const SPACES = {
    rgb: { label: 'RGB', comps: [['R', 0, 255], ['G', 0, 255], ['B', 0, 255]], f: (r, g, b, o) => { o[0] = r; o[1] = g; o[2] = b; } },
    hsv: { label: 'HSV', comps: [['H', 0, 360, true], ['S', 0, 1], ['V', 0, 1]], f: (r, g, b, o) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      o[0] = d === 0 ? 0 : mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
      if (o[0] < 0) o[0] += 360;
      o[1] = mx === 0 ? 0 : d / mx; o[2] = mx / 255;
    } },
    hsl: { label: 'HSL', comps: [['H', 0, 360, true], ['S', 0, 1], ['L', 0, 1]], f: (r, g, b, o) => {
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, d = mx - mn, l = (mx + mn) / 2;
      SPACES.hsv.f(r, g, b, o);
      o[1] = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); o[2] = l;
    } },
    hsi: { label: 'HSI', comps: [['H', 0, 360, true], ['S', 0, 1], ['I', 0, 1]], f: (r, g, b, o) => {
      const i = (r + g + b) / 3, mn = Math.min(r, g, b);
      const num = 0.5 * ((r - g) + (r - b)), den = Math.sqrt((r - g) * (r - g) + (r - b) * (g - b));
      const th = den === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, num / den))) * 180 / Math.PI;
      o[0] = den === 0 ? 0 : b <= g ? th : 360 - th; o[1] = i === 0 ? 0 : 1 - mn / i; o[2] = i / 255;
    } },
    ycbcr601: { label: 'YCbCr (BT.601)', comps: [['Y', 0, 255], ['Cb', 0, 255], ['Cr', 0, 255]], f: (r, g, b, o) => {
      o[0] = 0.299 * r + 0.587 * g + 0.114 * b; o[1] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b; o[2] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    } },
    ycbcr709: { label: 'YCbCr (BT.709)', comps: [['Y', 0, 255], ['Cb', 0, 255], ['Cr', 0, 255]], f: (r, g, b, o) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; o[0] = y; o[1] = 128 + (b - y) / 1.8556; o[2] = 128 + (r - y) / 1.5748;
    } },
    yuv: { label: 'YUV', comps: [['Y', 0, 1], ['U', -0.436, 0.436], ['V', -0.615, 0.615]], f: (r, g, b, o) => {
      r /= 255; g /= 255; b /= 255; const y = 0.299 * r + 0.587 * g + 0.114 * b; o[0] = y; o[1] = 0.492 * (b - y); o[2] = 0.877 * (r - y);
    } },
    yiq: { label: 'YIQ', comps: [['Y', 0, 1], ['I', -0.596, 0.596], ['Q', -0.523, 0.523]], f: (r, g, b, o) => {
      r /= 255; g /= 255; b /= 255;
      o[0] = 0.299 * r + 0.587 * g + 0.114 * b; o[1] = 0.596 * r - 0.274 * g - 0.322 * b; o[2] = 0.211 * r - 0.523 * g + 0.312 * b;
    } },
    xyz: { label: 'CIE XYZ (D65)', comps: [['X', 0, 95.05], ['Y', 0, 100], ['Z', 0, 108.9]], f: xyz },
    lab: { label: 'CIE L*a*b*', comps: [['L*', 0, 100], ['a*', -128, 127], ['b*', -128, 127]], f: lab },
    lch: { label: 'CIE L*C*h', comps: [['L*', 0, 100], ['C*', 0, 134], ['h', 0, 360, true]], f: (r, g, b, o) => {
      lab(r, g, b, o); const a = o[1], bb = o[2]; o[1] = Math.hypot(a, bb); o[2] = o[1] < 1e-9 ? 0 : hueDeg(bb, a);
    } },
    luv: { label: 'CIE L*u*v*', comps: [['L*', 0, 100], ['u*', -84, 176], ['v*', -135, 108]], f: (r, g, b, o) => {
      xyz(r, g, b, o); const X = o[0], Y = o[1], Z = o[2], d = X + 15 * Y + 3 * Z;
      const L = 116 * flab(Y / Yn) - 16; o[0] = L;
      if (d === 0) { o[1] = 0; o[2] = 0; return; }
      o[1] = 13 * L * (4 * X / d - UN); o[2] = 13 * L * (9 * Y / d - VN);
    } },
    cmy: { label: 'CMY', comps: [['C', 0, 1], ['M', 0, 1], ['Y', 0, 1]], f: (r, g, b, o) => { o[0] = 1 - r / 255; o[1] = 1 - g / 255; o[2] = 1 - b / 255; } },
    cmyk: { label: 'CMYK', comps: [['C', 0, 1], ['M', 0, 1], ['Y', 0, 1], ['K', 0, 1]], f: (r, g, b, o) => {
      const k = 1 - Math.max(r, g, b) / 255; o[3] = k;
      if (k >= 1) { o[0] = o[1] = o[2] = 0; return; }
      o[0] = (1 - r / 255 - k) / (1 - k); o[1] = (1 - g / 255 - k) / (1 - k); o[2] = (1 - b / 255 - k) / (1 - k);
    } },
    chroma: { label: 'Normalised rgb (chromaticity)', comps: [['r', 0, 1], ['g', 0, 1], ['b', 0, 1]], f: (r, g, b, o) => {
      const s = r + g + b; if (!s) { o[0] = o[1] = o[2] = 1 / 3; return; } o[0] = r / s; o[1] = g / s; o[2] = b / s;
    } },
    ohta: { label: 'Ohta I1I2I3', comps: [['I1', 0, 255], ['I2', -127.5, 127.5], ['I3', -127.5, 127.5]], f: (r, g, b, o) => {
      o[0] = (r + g + b) / 3; o[1] = (r - b) / 2; o[2] = (2 * g - r - b) / 4;
    } },
  };
  CH.SPACES = SPACES;
  const SPACE_OPTIONS = Object.entries(SPACES).map(([value, s]) => ({ value, label: s.label }));
  const COMPONENT_OPTIONS = [{ value: 'all', label: 'All components (as R, G, B)' }];
  for (let i = 0; i < 4; i++) COMPONENT_OPTIONS.push({ value: String(i), label: `Component ${i + 1}` });
  // every channel of every space, for channel-difference
  const ALL_CHANNELS = [];
  for (const [k, s] of Object.entries(SPACES)) s.comps.forEach((c, i) => ALL_CHANNELS.push({ value: `${k}.${i}`, label: `${s.label} · ${c[0]}` }));

  // Convert every pixel; returns { planes: [Float32Array...], comps }.
  CH.convert = (d, space) => {
    const S = SPACES[space], n = d.width * d.height, p = d.data, k = S.comps.length;
    const planes = Array.from({ length: k }, () => new Float32Array(n)), o = [0, 0, 0, 0];
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      S.f(p[i], p[i + 1], p[i + 2], o);
      for (let c = 0; c < k; c++) planes[c][j] = o[c];
    }
    return { planes, comps: S.comps };
  };

  // ---------------------------------------------------------------- colour maps
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const STOPS = {
    viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
    inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
    magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
    iron: ['#000000', '#20008c', '#8a00a8', '#d4206a', '#f55a1e', '#fca30a', '#fde65e', '#ffffff'],
    jet: ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#7f0000'],
    gray: ['#000000', '#ffffff'],
  };
  function lutFromStops(stops) {
    const cols = stops.map(hex), lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (cols.length - 1), a = Math.min(cols.length - 2, Math.floor(t)), f = t - a;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(cols[a][c] * (1 - f) + cols[a + 1][c] * f);
    }
    return lut;
  }
  function turbo() {
    const lut = new Uint8ClampedArray(768);
    for (let i = 0; i < 256; i++) {
      const x = i / 255, x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
      lut[i * 3] = 255 * (0.13572138 + 4.6153926 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5);
      lut[i * 3 + 1] = 255 * (0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5);
      lut[i * 3 + 2] = 255 * (0.1066733 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5);
    }
    return lut;
  }
  function hot() {
    const lut = new Uint8ClampedArray(768);
    for (let i = 0; i < 256; i++) { const x = i / 255; lut[i * 3] = 255 * Math.min(1, 3 * x); lut[i * 3 + 1] = 255 * Math.min(1, Math.max(0, 3 * x - 1)); lut[i * 3 + 2] = 255 * Math.max(0, 3 * x - 2); }
    return lut;
  }
  function hueWheel() {
    const lut = new Uint8ClampedArray(768);
    for (let i = 0; i < 256; i++) {
      const h = i / 256 * 6, x = 1 - Math.abs((h % 2) - 1), k = Math.floor(h);
      const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][k];
      lut[i * 3] = r * 255; lut[i * 3 + 1] = g * 255; lut[i * 3 + 2] = b * 255;
    }
    return lut;
  }
  const LUTS = {};
  const getLut = (name, custom) => {
    if (name === 'custom') return lutFromStops(custom.filter(Boolean));
    if (!LUTS[name]) LUTS[name] = name === 'turbo' ? turbo() : name === 'hot' ? hot() : name === 'hue' ? hueWheel() : lutFromStops(STOPS[name] || STOPS.gray);
    return LUTS[name];
  };
  CH.getLut = getLut;
  const LUT_OPTIONS = [
    { value: 'none', label: 'None (greyscale)' }, { value: 'inferno', label: 'Inferno' }, { value: 'viridis', label: 'Viridis' },
    { value: 'magma', label: 'Magma' }, { value: 'turbo', label: 'Turbo' }, { value: 'jet', label: 'Jet' }, { value: 'hot', label: 'Hot' },
    { value: 'iron', label: 'Iron (thermal)' }, { value: 'hue', label: 'Hue wheel (for hue channels)' },
  ];

  // Map a plane to 8-bit indices using [lo, hi]; returns Uint8ClampedArray.
  function toIndex(plane, lo, hi, invert) {
    const out = new Uint8ClampedArray(plane.length), s = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = 0; i < plane.length; i++) { const v = (plane[i] - lo) * s; out[i] = invert ? 255 - v : v; }
    return out;
  }
  function paint(idx, w, h, lut) {
    const out = new ImageData(w, h), o = out.data;
    for (let i = 0, j = 0; j < idx.length; i += 4, j++) {
      const v = idx[j];
      if (lut) { o[i] = lut[v * 3]; o[i + 1] = lut[v * 3 + 1]; o[i + 2] = lut[v * 3 + 2]; } else { o[i] = o[i + 1] = o[i + 2] = v; }
      o[i + 3] = 255;
    }
    return out;
  }
  const stats = plane => {
    let mn = Infinity, mx = -Infinity, s = 0;
    for (let i = 0; i < plane.length; i++) { const v = plane[i]; if (v < mn) mn = v; if (v > mx) mx = v; s += v; }
    return { min: mn, max: mx, mean: s / plane.length };
  };
  const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));

  // ---------------------------------------------------------------- filters
  AD.registerFilter({
    id: 'color-space', name: 'Colour Space / Extract Channel', category: 'Channels',
    description: 'Convert to another colour space and show all of its components, or one component as an image (optionally normalised or false-coloured).',
    keywords: ['hsv', 'hsl', 'hsi', 'lab', 'lch', 'luv', 'xyz', 'ycbcr', 'yuv', 'yiq', 'cmyk', 'cmy', 'ohta', 'chromaticity', 'channel', 'component', 'hue', 'saturation'],
    testSample: 'plate',
    params: [
      { id: 'space', label: 'Colour space', type: 'select', default: 'hsv', options: SPACE_OPTIONS },
      { id: 'component', label: 'Show', type: 'select', default: '1', options: COMPONENT_OPTIONS,
        hint: 'Component order follows the space name (e.g. HSV: 1 = H, 2 = S, 3 = V; CMYK: 4 = K).' },
      { id: 'normalize', label: 'Stretch to full range (min–max)', type: 'bool', default: false },
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
      { id: 'lut', label: 'False colour', type: 'select', default: 'none', options: LUT_OPTIONS, when: p => p.component !== 'all' },
    ],
    // no margin: the readout statistics are global, so this must not be split into strips
    apply(input, p) {
      const S = SPACES[p.space] || SPACES.rgb, { width: w, height: h } = input;
      const { planes } = CH.convert(input, p.space);
      if (p.component === 'all') {
        const idx = S.comps.slice(0, 3).map((c, i) => { const st = p.normalize ? stats(planes[i]) : { min: c[1], max: c[2] }; return toIndex(planes[i], st.min, st.max, p.invert); });
        const out = new ImageData(w, h), o = out.data;
        for (let i = 0, j = 0; j < w * h; i += 4, j++) { o[i] = idx[0][j]; o[i + 1] = idx[1][j]; o[i + 2] = idx[2][j]; o[i + 3] = 255; }
        const readout = {};
        S.comps.forEach((c, i) => { const st = stats(planes[i]); readout[`${c[0]} mean (min…max)`] = `${fmt(st.mean)} (${fmt(st.min)}…${fmt(st.max)})`; });
        if (S.comps.length > 3) readout.Note = `${S.comps[3][0]} not shown in the RGB composite; pick component 4 to see it.`;
        return { image: out, readout };
      }
      const ci = Math.min(S.comps.length - 1, parseInt(p.component, 10) || 0), c = S.comps[ci], st = stats(planes[ci]);
      const lo = p.normalize ? st.min : c[1], hi = p.normalize ? st.max : c[2];
      const lut = p.lut && p.lut !== 'none' ? getLut(p.lut) : null;
      return {
        image: paint(toIndex(planes[ci], lo, hi, p.invert), w, h, lut),
        readout: { Channel: `${S.label} · ${c[0]}`, Mean: fmt(st.mean), Min: fmt(st.min), Max: fmt(st.max), 'Display range': `${fmt(lo)} … ${fmt(hi)}${c[3] ? ' (circular)' : ''}` },
      };
    },
  });

  const PRESETS = {
    identity: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bt601: [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
    bt709: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
    swaprb: [0, 0, 1, 0, 1, 0, 1, 0, 0],
    sepia: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131],
    redboost: [2, -0.5, -0.5, 0, 1, 0, 0, 0, 1],
  };
  const M = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  const MIX_LABELS = { rr: 'R ← R', rg: 'R ← G', rb: 'R ← B', gr: 'G ← R', gg: 'G ← G', gb: 'G ← B', br: 'B ← R', bg: 'B ← G', bb: 'B ← B' };
  const mixMatrix = p => (p.preset !== 'custom' && PRESETS[p.preset] ? PRESETS[p.preset] : M.map(k => p[k]));

  AD.registerFilter({
    id: 'channel-mixer', name: 'Channel Mixer', category: 'Channels',
    description: 'Each output channel is a weighted sum of the input R, G and B plus an offset.',
    keywords: ['matrix', 'mix', 'sepia'],
    testSample: 'plate',
    params: [
      { id: 'preset', label: 'Preset', type: 'select', default: 'custom', options: [
        { value: 'custom', label: 'Custom (sliders)' }, { value: 'identity', label: 'Identity' }, { value: 'bt601', label: 'Grey BT.601' },
        { value: 'bt709', label: 'Grey BT.709' }, { value: 'swaprb', label: 'Swap R and B' }, { value: 'sepia', label: 'Sepia' }, { value: 'redboost', label: 'Red separation' }] },
      ...M.map((k, i) => ({ id: k, label: MIX_LABELS[k], type: 'range', min: -2, max: 2, step: 0.01, default: PRESETS.identity[i], when: p => p.preset === 'custom' })),
      { id: 'or', label: 'R offset', type: 'range', min: -255, max: 255, step: 1, default: 0 },
      { id: 'og', label: 'G offset', type: 'range', min: -255, max: 255, step: 1, default: 0 },
      { id: 'ob', label: 'B offset', type: 'range', min: -255, max: 255, step: 1, default: 0 },
      { id: 'mono', label: 'Monochrome (use the R row for all)', type: 'bool', default: false },
    ],
    margin: () => 0,
    apply(input, p) {
      const m = mixMatrix(p).slice();
      if (p.mono) { m[3] = m[6] = m[0]; m[4] = m[7] = m[1]; m[5] = m[8] = m[2]; }
      const off = p.mono ? [p.or, p.or, p.or] : [p.or, p.og, p.ob];
      return AD.img.mapPixels(input, (r, g, b, o) => {
        o[0] = m[0] * r + m[1] * g + m[2] * b + off[0]; o[1] = m[3] * r + m[4] * g + m[5] * b + off[1]; o[2] = m[6] * r + m[7] * g + m[8] * b + off[2];
      });
    },
    gpu(input, p) {
      const m = mixMatrix(p).slice();
      if (p.mono) { m[3] = m[6] = m[0]; m[4] = m[7] = m[1]; m[5] = m[8] = m[2]; }
      const off = p.mono ? [p.or, p.or, p.or] : [p.or, p.og, p.ob];
      return AD.gpu.run('vec4 fx(vec2 uv) { vec3 c = texture(u_img, uv).rgb * 255.0; return vec4((u_m * c + u_off) / 255.0, 1.0); }',
        { image: input, nearest: true, uniforms: { u_m: m, u_off: off } });
    },
  });

  const SRC = [{ value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }, { value: 'y', label: 'Luma' }, { value: 'zero', label: '0 (black)' }, { value: 'full', label: '255 (full)' }];
  const SRC_CODE = { r: 0, g: 1, b: 2, y: 3, zero: 4, full: 5 };
  AD.registerFilter({
    id: 'swap-channels', name: 'Swap / Route Channels', category: 'Channels',
    description: 'Choose where each output channel comes from: any input channel, luma, black or full.',
    keywords: ['swap', 'route', 'reorder', 'bgr'],
    testSample: 'plate',
    params: [
      { id: 'r', label: 'Output red from', type: 'select', default: 'b', options: SRC },
      { id: 'g', label: 'Output green from', type: 'select', default: 'g', options: SRC },
      { id: 'b', label: 'Output blue from', type: 'select', default: 'r', options: SRC },
    ],
    margin: () => 0,
    apply(input, p) {
      const pick = [p.r, p.g, p.b].map(k => SRC_CODE[k] ?? 4), v = [0, 0, 0, 0, 0, 255];
      return AD.img.mapPixels(input, (r, g, b, o) => {
        v[0] = r; v[1] = g; v[2] = b; v[3] = 0.299 * r + 0.587 * g + 0.114 * b;
        o[0] = v[pick[0]]; o[1] = v[pick[1]]; o[2] = v[pick[2]];
      });
    },
    gpu(input, p) {
      const pick = [p.r, p.g, p.b].map(k => SRC_CODE[k] ?? 4);
      return AD.gpu.run(`vec4 fx(vec2 uv) {
        vec3 c = texture(u_img, uv).rgb; float y = dot(c, vec3(0.299, 0.587, 0.114));
        float v[6] = float[6](c.r, c.g, c.b, y, 0.0, 1.0);
        return vec4(v[int(u_pick.x)], v[int(u_pick.y)], v[int(u_pick.z)], 1.0); }`, { image: input, nearest: true, uniforms: { u_pick: pick } });
    },
  });

  AD.registerFilter({
    id: 'split-channels', name: 'Split Channels', category: 'Channels',
    description: 'Show the components of a colour space side by side as greyscale tiles (2×2 grid with the original) for comparison.',
    keywords: ['tile', 'side by side', 'separate', 'components'],
    testSample: 'plate',
    params: [
      { id: 'space', label: 'Colour space', type: 'select', default: 'rgb', options: SPACE_OPTIONS.filter(o => SPACES[o.value].comps.length === 3) },
      { id: 'normalize', label: 'Stretch each tile (min–max)', type: 'bool', default: false },
    ],
    apply(input, p) {
      const S = SPACES[p.space] || SPACES.rgb, { width: w, height: h } = input, { planes } = CH.convert(input, p.space);
      const out = new ImageData(w * 2, h * 2), o = out.data, src = input.data;
      const tiles = [null, ...planes.map((pl, i) => { const st = p.normalize ? stats(pl) : { min: S.comps[i][1], max: S.comps[i][2] }; return toIndex(pl, st.min, st.max, false); })];
      const pos = [[0, 0], [w, 0], [0, h], [w, h]];
      tiles.forEach((t, k) => {
        const [ox, oy] = pos[k];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const j = y * w + x, i = ((oy + y) * w * 2 + ox + x) * 4;
          if (t) { o[i] = o[i + 1] = o[i + 2] = t[j]; } else { o[i] = src[j * 4]; o[i + 1] = src[j * 4 + 1]; o[i + 2] = src[j * 4 + 2]; }
          o[i + 3] = 255;
        }
      });
      const overlay = [{ type: 'text', x: 8, y: 22, text: 'Original' }, ...S.comps.map((c, i) => ({ type: 'text', x: pos[i + 1][0] + 8, y: pos[i + 1][1] + 22, text: `${S.label} · ${c[0]}` }))];
      return { image: out, overlay };
    },
  });

  // Paint a vertical colour-scale bar into `out` (in place) and return overlay labels for it.
  function legend(out, lut, lo, hi) {
    const { width: w, height: h } = out, o = out.data;
    if (w < 40 || h < 40) return [];
    const bw = Math.max(8, Math.round(w * 0.025)), bh = Math.round(h * 0.6), x0 = w - bw - Math.round(w * 0.03), y0 = Math.round(h * 0.2);
    for (let y = 0; y < bh; y++) {
      const k = Math.round((1 - y / (bh - 1)) * 255) * 3;
      for (let x = 0; x < bw; x++) { const i = ((y0 + y) * w + x0 + x) * 4; o[i] = lut[k]; o[i + 1] = lut[k + 1]; o[i + 2] = lut[k + 2]; }
    }
    return [{ type: 'rect', x: x0, y: y0, w: bw, h: bh, color: '#ffffff' },
      { type: 'text', x: x0 - 34, y: y0 + 4, text: String(hi) }, { type: 'text', x: x0 - 34, y: y0 + bh + 4, text: String(lo) }];
  }

  AD.registerFilter({
    id: 'false-color', name: 'False Colour', category: 'Channels',
    description: 'Map brightness (or one channel) through a colour scale so small intensity differences become visible colour differences.',
    keywords: ['lut', 'heatmap', 'thermal', 'pseudo colour', 'inferno', 'viridis', 'jet', 'turbo'],
    testSample: 'plate',
    params: [
      { id: 'lut', label: 'Colour scale', type: 'select', default: 'inferno', options: LUT_OPTIONS.filter(o => o.value !== 'none').concat([{ value: 'custom', label: 'Custom gradient' }]) },
      { id: 'source', label: 'From', type: 'select', default: 'y', options: [{ value: 'y', label: 'Luma' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }] },
      { id: 'lo', label: 'Range start', type: 'range', min: 0, max: 255, step: 1, default: 0 },
      { id: 'hi', label: 'Range end', type: 'range', min: 0, max: 255, step: 1, default: 255 },
      { id: 'c1', label: 'Gradient start', type: 'color', default: '#000000', when: p => p.lut === 'custom' },
      { id: 'c2', label: 'Gradient middle', type: 'color', default: '#d9431c', when: p => p.lut === 'custom' },
      { id: 'c3', label: 'Gradient end', type: 'color', default: '#ffffff', when: p => p.lut === 'custom' },
      { id: 'legend', label: 'Show legend bar', type: 'bool', default: true },
    ],
    apply(input, p) {
      const { width: w, height: h } = input, d = input.data, lut = getLut(p.lut, [p.c1, p.c2, p.c3]);
      const lo = Math.min(p.lo, p.hi), hi = Math.max(p.lo, p.hi), s = hi > lo ? 255 / (hi - lo) : 0;
      const out = new ImageData(w, h), o = out.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = p.source === 'r' ? d[i] : p.source === 'g' ? d[i + 1] : p.source === 'b' ? d[i + 2] : d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const k = Math.max(0, Math.min(255, Math.round((v - lo) * s))) * 3;
        o[i] = lut[k]; o[i + 1] = lut[k + 1]; o[i + 2] = lut[k + 2]; o[i + 3] = 255;
      }
      return { image: out, overlay: p.legend ? legend(out, lut, lo, hi) : [] };
    },
    gpu(input, p) {
      const lut = getLut(p.lut, [p.c1, p.c2, p.c3]), lutImg = new ImageData(256, 1);
      for (let i = 0; i < 256; i++) { lutImg.data[i * 4] = lut[i * 3]; lutImg.data[i * 4 + 1] = lut[i * 3 + 1]; lutImg.data[i * 4 + 2] = lut[i * 3 + 2]; lutImg.data[i * 4 + 3] = 255; }
      const lo = Math.min(p.lo, p.hi), hi = Math.max(p.lo, p.hi);
      const w = p.source === 'r' ? [1, 0, 0] : p.source === 'g' ? [0, 1, 0] : p.source === 'b' ? [0, 0, 1] : [0.299, 0.587, 0.114];
      const out = AD.gpu.run(`vec4 fx(vec2 uv) {
        float v = dot(texture(u_img, uv).rgb * 255.0, u_w);
        float k = clamp(floor((v - u_lo) * u_s + 0.5), 0.0, 255.0);
        return vec4(texture(u_lut, vec2((k + 0.5) / 256.0, 0.5)).rgb, 1.0); }`,
      { image: input, nearest: true, uniforms: { u_w: w, u_lo: lo, u_s: hi > lo ? 255 / (hi - lo) : 0 }, textures: { u_lut: lutImg } });
      return { image: out, overlay: p.legend ? legend(out, lut, lo, hi) : [] };
    },
  });

  // Symmetric 3x3 eigen-decomposition by cyclic Jacobi rotations. Returns { values, vectors (columns) } sorted descending.
  CH.eig3 = A => {
    const a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-12) break;
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
    return { values: order.map(i => Math.max(0, a[i][i])), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]]) };
  };

  AD.registerFilter({
    id: 'decorrelation-stretch', name: 'Decorrelation Stretch', category: 'Channels',
    description: 'Rotate colours onto their principal components, stretch each to equal spread and rotate back. Exaggerates subtle colour differences (faded pigment, stains, hidden marks).',
    keywords: ['pca', 'principal component', 'dstretch', 'enhance colour', 'faded'],
    testSample: 'faded-pigment',
    params: [
      { id: 'space', label: 'Work in', type: 'select', default: 'rgb', options: [{ value: 'rgb', label: 'RGB' }, { value: 'lab', label: 'CIE L*a*b*' }] },
      { id: 'sigma', label: 'Target spread (σ)', type: 'range', min: 10, max: 100, step: 1, default: 50, hint: 'Standard deviation each component is stretched to, in 0–255 units.' },
      { id: 'output', label: 'Output', type: 'select', default: 'stretched', options: [
        { value: 'stretched', label: 'Stretched colour image' }, { value: 'pc1', label: 'Principal component 1' }, { value: 'pc2', label: 'Principal component 2' }, { value: 'pc3', label: 'Principal component 3' }] },
    ],
    async apply(input, p, ctx) {
      const { width: w, height: h } = input, d = input.data, n = w * h;
      const useLab = p.space === 'lab', o = [0, 0, 0];
      // channel values per pixel in working space, scaled to roughly 0..255
      const X = new Float32Array(n * 3);
      for (let i = 0, j = 0; j < n; i += 4, j++) {
        if (useLab) { lab(d[i], d[i + 1], d[i + 2], o); X[j * 3] = o[0] * 2.55; X[j * 3 + 1] = o[1] + 128; X[j * 3 + 2] = o[2] + 128; }
        else { X[j * 3] = d[i]; X[j * 3 + 1] = d[i + 1]; X[j * 3 + 2] = d[i + 2]; }
      }
      await ctx.checkpoint();
      const step = Math.max(1, Math.floor(n / 200000)), mean = [0, 0, 0];
      let m = 0;
      for (let j = 0; j < n; j += step, m++) for (let c = 0; c < 3; c++) mean[c] += X[j * 3 + c];
      for (let c = 0; c < 3; c++) mean[c] /= m;
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let j = 0; j < n; j += step) for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) C[a][b] += (X[j * 3 + a] - mean[a]) * (X[j * 3 + b] - mean[b]);
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) { C[a][b] /= Math.max(1, m - 1); C[b][a] = C[a][b]; }
      const { values, vectors: V } = CH.eig3(C);
      const total = values[0] + values[1] + values[2] || 1;
      const readout = {};
      values.forEach((v, i) => { readout[`PC${i + 1} variance`] = `${v.toFixed(1)} (${(v / total * 100).toFixed(1)} %)`; });
      const out = new ImageData(w, h), q = out.data;
      if (p.output !== 'stretched') {
        const k = parseInt(p.output.slice(2), 10) - 1, e = V[k], sd = Math.sqrt(values[k]) || 1;
        for (let j = 0, i = 0; j < n; j++, i += 4) {
          const t = (X[j * 3] - mean[0]) * e[0] + (X[j * 3 + 1] - mean[1]) * e[1] + (X[j * 3 + 2] - mean[2]) * e[2];
          q[i] = q[i + 1] = q[i + 2] = 128 + t / sd * 42.5; q[i + 3] = 255;   // ±3σ -> 0..255
        }
        return { image: out, readout };
      }
      // T = V diag(sigma / sqrt(lambda)) V^T ; output = mean + T (x - mean)
      const g = values.map(v => p.sigma / Math.sqrt(Math.max(v, 1e-6)));
      const T = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let k = 0; k < 3; k++) T[a][b] += V[k][a] * g[k] * V[k][b];
      // keep the overall mean where it was, so brightness does not jump
      for (let j = 0, i = 0; j < n; j++, i += 4) {
        const x0 = X[j * 3] - mean[0], x1 = X[j * 3 + 1] - mean[1], x2 = X[j * 3 + 2] - mean[2];
        const y0 = mean[0] + T[0][0] * x0 + T[0][1] * x1 + T[0][2] * x2;
        const y1 = mean[1] + T[1][0] * x0 + T[1][1] * x1 + T[1][2] * x2;
        const y2 = mean[2] + T[2][0] * x0 + T[2][1] * x1 + T[2][2] * x2;
        if (useLab) { lab2rgb(y0 / 2.55, y1 - 128, y2 - 128, o); q[i] = o[0]; q[i + 1] = o[1]; q[i + 2] = o[2]; }
        else { q[i] = y0; q[i + 1] = y1; q[i + 2] = y2; }
        q[i + 3] = 255;
        if ((j & 0x3ffff) === 0) await ctx.checkpoint();
      }
      return { image: out, readout };
    },
  });

  const GREY = { bt601: [0.299, 0.587, 0.114], bt709: [0.2126, 0.7152, 0.0722], average: [1 / 3, 1 / 3, 1 / 3] };
  AD.registerFilter({
    id: 'grayscale', name: 'Greyscale', category: 'Channels',
    description: 'Convert to greyscale with a chosen weighting.',
    keywords: ['gray', 'grey', 'mono', 'black and white', 'luma', 'luminance'],
    testSample: 'plate',
    params: [
      { id: 'method', label: 'Method', type: 'select', default: 'bt601', options: [
        { value: 'bt601', label: 'Luma BT.601' }, { value: 'bt709', label: 'Luma BT.709' }, { value: 'average', label: 'Average' },
        { value: 'lightness', label: 'Lightness (max+min)/2' }, { value: 'max', label: 'Maximum' }, { value: 'lstar', label: 'CIE L*' }, { value: 'custom', label: 'Custom weights' }] },
      { id: 'wr', label: 'Red weight', type: 'range', min: -1, max: 2, step: 0.01, default: 0.333, when: p => p.method === 'custom' },
      { id: 'wg', label: 'Green weight', type: 'range', min: -1, max: 2, step: 0.01, default: 0.333, when: p => p.method === 'custom' },
      { id: 'wb', label: 'Blue weight', type: 'range', min: -1, max: 2, step: 0.01, default: 0.333, when: p => p.method === 'custom' },
    ],
    margin: () => 0,
    apply(input, p) {
      const o3 = [0, 0, 0], W = p.method === 'custom' ? [p.wr, p.wg, p.wb] : GREY[p.method];
      return AD.img.mapPixels(input, (r, g, b, o) => {
        let v;
        if (W) v = W[0] * r + W[1] * g + W[2] * b;
        else if (p.method === 'lightness') v = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
        else if (p.method === 'max') v = Math.max(r, g, b);
        else { lab(r, g, b, o3); v = o3[0] * 2.55; }
        o[0] = o[1] = o[2] = v;
      });
    },
  });

  AD.registerFilter({
    id: 'channel-difference', name: 'Channel Difference', category: 'Channels',
    description: 'Subtract one channel from another (each scaled to 0–1 in its own space) to reveal where they disagree.',
    keywords: ['subtract', 'difference', 'ratio'],
    testSample: 'saturation-patches',
    params: [
      { id: 'a', label: 'Channel A', type: 'select', default: 'rgb.0', options: ALL_CHANNELS },
      { id: 'b', label: 'Channel B', type: 'select', default: 'rgb.1', options: ALL_CHANNELS },
      { id: 'gain', label: 'Gain', type: 'range', min: 0.25, max: 20, step: 0.25, default: 4 },
      { id: 'offset', label: 'Offset (grey level for no difference)', type: 'range', min: 0, max: 255, step: 1, default: 128 },
      { id: 'abs', label: 'Absolute difference', type: 'bool', default: false },
    ],
    margin: () => 0,
    apply(input, p) {
      const pick = key => { const [s, i] = key.split('.'), S = SPACES[s] || SPACES.rgb, k = Math.min(S.comps.length - 1, +i || 0); return { S, k, c: S.comps[k] }; };
      const A = pick(p.a), B = pick(p.b), oa = [0, 0, 0, 0], ob = [0, 0, 0, 0];
      const na = v => (v - A.c[1]) / (A.c[2] - A.c[1]), nb = v => (v - B.c[1]) / (B.c[2] - B.c[1]);
      const base = p.abs ? 0 : p.offset;
      return AD.img.mapPixels(input, (r, g, b, o) => {
        A.S.f(r, g, b, oa); B.S.f(r, g, b, ob);
        let dlt = na(oa[A.k]) - nb(ob[B.k]);
        if (p.abs) dlt = Math.abs(dlt);
        o[0] = o[1] = o[2] = base + dlt * p.gain * 255;
      });
    },
  });

  // ---------------------------------------------------------------- sample
  if (typeof document !== 'undefined') {
    AD.registerSample({ id: 'faded-pigment', name: 'Faded pigment on rock', category: 'Channels', description: 'faint ochre figures, barely visible',
      make: async () => {
        const w = 800, h = 520, c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#9d8f80'; g.fillRect(0, 0, w, h);
        g.globalAlpha = 0.09; g.fillStyle = '#b0402a'; g.strokeStyle = '#b0402a'; g.lineWidth = 9; g.lineCap = 'round';
        // figures: a person, an animal, hand prints
        const person = (x, y, s) => { g.beginPath(); g.arc(x, y, 12 * s, 0, 7); g.fill(); g.beginPath(); g.moveTo(x, y + 12 * s); g.lineTo(x, y + 70 * s); g.moveTo(x - 30 * s, y + 35 * s); g.lineTo(x + 30 * s, y + 30 * s); g.moveTo(x, y + 70 * s); g.lineTo(x - 22 * s, y + 115 * s); g.moveTo(x, y + 70 * s); g.lineTo(x + 24 * s, y + 112 * s); g.stroke(); };
        person(180, 140, 1.4); person(300, 170, 1.1);
        g.beginPath(); g.ellipse(560, 230, 110, 45, -0.1, 0, 7); g.fill();
        g.beginPath(); for (const lx of [480, 510, 600, 630]) { g.moveTo(lx, 260); g.lineTo(lx - 5, 330); } g.moveTo(660, 210); g.lineTo(720, 160); g.stroke();
        g.fillStyle = '#d2a63a'; for (const [hx, hy] of [[150, 400], [250, 420], [640, 420]]) { g.beginPath(); g.ellipse(hx, hy, 26, 32, 0, 0, 7); g.fill(); }
        g.globalAlpha = 1;
        const d = g.getImageData(0, 0, w, h), p = d.data;
        let s = 11; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
        for (let i = 0, j = 0; i < p.length; i += 4, j++) {
          const x = j % w, y = (j / w) | 0;
          const t = 18 * Math.sin(x * 0.013 + Math.sin(y * 0.021) * 2) + 12 * Math.sin(y * 0.031 + x * 0.007) + (r() - 0.5) * 26;
          p[i] += t; p[i + 1] += t * 0.95; p[i + 2] += t * 0.9;
        }
        return d;
      } });
  }
})(typeof window !== 'undefined' ? window : globalThis);
