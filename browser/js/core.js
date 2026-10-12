// Main-thread application: sources, viewer, panels, player, export. The filter chain itself runs in the
// engine worker (js/worker.js) via WorkerBackend, or on this thread via LocalBackend when workers are unavailable.
(function (root) {
  const AD = root.AD = root.AD || {};
  const $ = id => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Math.random().toString(36).slice(2, 10);

  // Filter files, relative to js/ (the worker resolves importScripts against its own URL).
  AD.FILTER_FILES = ['filters/basic.js', 'filters/channels.js', 'filters/adjust.js', 'filters/denoise.js', 'filters/deblur.js',
    'filters/fourier.js', 'filters/geometry.js', 'filters/video.js', 'filters/stabilize.js', 'filters/measure.js', 'filters/presentation.js'];

  // ---------------------------------------------------------------- options & state
  const OPT_DEFAULTS = { autorecover: true, auth: false, filename: '$in$ts', format: 'jpeg', quality: 90, maxdim: 4096, cache: 512 };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ad.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ad.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const S = AD.state = {
    source: null, chain: [], sel: null, frame: 0,
    show: 'result', compare: false, overlays: true, tool: 'pan', editParam: null,
    inMark: null, outMark: null, playing: false, interactive: false,
    stepStats: new Map(), logLines: [],
    opts: { ...OPT_DEFAULTS, ...store.get('opts', {}) },
  };

  // ---------------------------------------------------------------- log
  function log(msg, level = '') {
    const t = new Date();
    const stamp = t.toTimeString().slice(0, 8);
    S.logLines.push({ t: t.toISOString(), msg, level });
    const box = $('log');
    if (box) {
      box.append(el('p', { class: level, text: `${stamp}  ${msg}` }));
      while (box.childElementCount > 300) box.firstChild.remove();
      box.scrollTop = box.scrollHeight;
    }
  }
  AD.log = log;

  // ---------------------------------------------------------------- backends
  class WorkerBackend {
    constructor() {
      this.w = new Worker('js/worker.js');
      this.seq = 0; this.pending = new Map();
      this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.w.onerror = e => reject(new Error(e.message || 'worker failed to start')); });
      this.w.onmessage = ev => this.onMessage(ev.data);
      const pool = clamp((navigator.hardwareConcurrency || 4) - 1, 1, 8);
      this.w.postMessage({ type: 'init', files: AD.FILTER_FILES, poolSize: pool, cacheMB: S.opts.cache });
    }
    onMessage(m) {
      if (m.type === 'ready') { this.info = m; this.readyResolve(m); return; }
      if (m.type === 'needFrame') {
        provideFrame(m.index, m.scale).then(img => {
          const buf = img.data.slice().buffer;
          this.w.postMessage({ type: 'frame', id: m.id, buffer: buf, width: img.width, height: img.height }, [buf]);
        }, e => this.w.postMessage({ type: 'frameError', id: m.id, message: e.message }));
        return;
      }
      if (m.type === 'progress') return setProgress(m.fraction, m.text);
      if (m.type === 'log') return log(m.msg, m.level);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'result') {
        if (m.patch) return p.resolve(m.patch);
        p.resolve({ image: new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height), overlay: m.overlay, readout: m.readout, error: m.error, steps: m.steps, frameCount: m.frameCount });
      } else if (m.type === 'cancelled') p.resolve(null);
      else p.reject(new Error(m.message));
    }
    call(msg) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.w.postMessage({ ...msg, id }); }); }
    setSource(meta) { this.w.postMessage({ type: 'source', meta }); }
    setChain(chain) { this.w.postMessage({ type: 'chain', chain }); }
    setCache(mb) { this.w.postMessage({ type: 'cache', mb }); }
    render(k, frame, scale, lane) { return this.call({ type: 'render', k, frame, scale, lane }); }
    action(uid, actionId, frame) { return this.call({ type: 'action', uid, actionId, frame }); }
  }

  class LocalBackend {
    constructor() {
      this.engine = new AD.Engine({ fetchFrame: provideFrame, onProgress: setProgress, onLog: log, cacheMB: S.opts.cache });
      this.lanes = new Map();
      this.ready = Promise.resolve({ gpu: !!(AD.gpu && AD.gpu.available), pool: 0, local: true });
    }
    setSource(meta) { this.engine.setSource(meta); }
    setChain(chain) { this.engine.setChain(JSON.parse(JSON.stringify(chain))); }
    setCache(mb) { this.engine.setCacheBudget(mb); }
    async render(k, frame, scale, lane) {
      const token = { cancelled: false };
      if (lane) { const prev = this.lanes.get(lane); if (prev) prev.cancelled = true; this.lanes.set(lane, token); }
      try { const r = await this.engine.render(k, frame, scale, token); return token.cancelled ? null : r; }
      catch (e) { if (e instanceof AD.CancelError) return null; throw e; }
    }
    action(uid, actionId, frame) { return this.engine.runAction(uid, actionId, frame, 1, { cancelled: false }); }
  }

  let backend = null;

  // ---------------------------------------------------------------- sources
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  function bitmapToImageData(src, w, h) {
    scratch.width = w; scratch.height = h;
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, w, h);
    return sctx.getImageData(0, 0, w, h);
  }
  AD.bitmapToImageData = bitmapToImageData;

  function capSize(w, h) {
    const s = Math.min(1, S.opts.maxdim / Math.max(w, h));
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)), s];
  }

  function frameLRU(n) {
    const m = new Map();
    return {
      get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
      set(k, v) { m.set(k, v); if (m.size > n) m.delete(m.keys().next().value); },
    };
  }

  async function decodeImageFile(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) {
      bmp = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file), im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name}: this browser cannot decode that image format`)); };
        im.src = url;
      });
    }
    const W = bmp.width || bmp.naturalWidth, H = bmp.height || bmp.naturalHeight;
    const [w, h, s] = capSize(W, H);
    const data = bitmapToImageData(bmp, w, h);
    if (bmp.close) bmp.close();
    return { data, W, H, scaled: s < 1 };
  }

  async function imageSource(file) {
    const d = await decodeImageFile(file);
    if (d.scaled) log(`${file.name}: ${d.W}×${d.H} reduced to ${d.data.width}×${d.data.height} (Program options › Max decoded frame size)`, 'w');
    return { id: uid(), name: file.name, kind: 'image', width: d.data.width, height: d.data.height, frameCount: 1, fps: 25, files: [file], getFrame: async () => d.data };
  }

  async function sequenceSource(files) {
    files = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const first = await decodeImageFile(files[0]);
    const lru = frameLRU(32);
    lru.set(0, first.data);
    const W = first.data.width, H = first.data.height;
    return {
      id: uid(), name: `${files[0].name} … (${files.length} images)`, kind: 'sequence', width: W, height: H,
      frameCount: files.length, fps: 25, files,
      async getFrame(i) {
        let d = lru.get(i);
        if (!d) {
          d = (await decodeImageFile(files[i])).data;
          if (d.width !== W || d.height !== H) d = bitmapToImageData(await createImageBitmap(d), W, H);
          lru.set(i, d);
        }
        return d;
      },
    };
  }

  const once = (target, ok, bad = 'error', ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${ok}`)); }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onBad = () => { cleanup(); reject(new Error((target.error && target.error.message) || `${bad}`)); };
    const cleanup = () => { clearTimeout(t); target.removeEventListener(ok, onOk); target.removeEventListener(bad, onBad); };
    target.addEventListener(ok, onOk); target.addEventListener(bad, onBad);
  });

  async function estimateFps(v) {
    if (!v.requestVideoFrameCallback) return null;
    const times = [];
    await new Promise(resolve => {
      const stop = setTimeout(resolve, 1500);
      const cb = (now, meta) => { times.push(meta.mediaTime); if (times.length >= 12) { clearTimeout(stop); resolve(); } else v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      v.play().catch(() => { clearTimeout(stop); resolve(); });
    });
    v.pause();
    const d = []; for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
    if (d.length < 3) return null;
    d.sort((a, b) => a - b);
    const fps = 1 / d[d.length >> 1];
    const common = [10, 12, 12.5, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    const snap = common.find(c => Math.abs(c - fps) / c < 0.03);
    return snap || Math.round(fps * 100) / 100;
  }

  // Fallback video source: seek a <video> element per frame. Not always frame-exact; js/io/video.js
  // (WebCodecs) replaces it for containers it can demux.
  async function videoElementSource(file) {
    const url = URL.createObjectURL(file), v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await once(v, 'loadedmetadata');
    if (!Number.isFinite(v.duration)) { v.currentTime = 1e9; await once(v, 'seeked').catch(() => {}); }
    const duration = v.duration;
    if (!Number.isFinite(duration) || !v.videoWidth) throw new Error(`${file.name}: this browser cannot decode that video`);
    const fps = (await estimateFps(v)) || 25;
    const [w, h] = capSize(v.videoWidth, v.videoHeight);
    const lru = frameLRU(24);
    let queue = Promise.resolve();
    const src = {
      id: uid(), name: file.name, kind: 'video', width: w, height: h, fps, files: [file], duration, decoder: 'video element (seeking)',
      frameCount: Math.max(1, Math.round(duration * fps)),
      getFrame(i) {
        const hit = lru.get(i); if (hit) return Promise.resolve(hit);
        const job = queue.then(async () => {
          const again = lru.get(i); if (again) return again;
          const t = Math.min(duration - 0.001, (i + 0.5) / src.fps);
          if (Math.abs(v.currentTime - t) > 1e-4) { v.currentTime = t; await once(v, 'seeked'); }
          const d = bitmapToImageData(v, w, h);
          lru.set(i, d);
          return d;
        });
        queue = job.catch(() => {});
        return job;
      },
    };
    if (fps === 25 && !v.requestVideoFrameCallback) log(`${file.name}: frame rate unknown, assuming 25 fps. Set the real rate in the Player.`, 'w');
    return src;
  }

  async function videoSource(file) {
    if (AD.io && AD.io.openVideo) {
      try { return await AD.io.openVideo(file, { maxdim: S.opts.maxdim, log }); }
      catch (e) { log(`${file.name}: frame-exact decoder unavailable (${e.message}); falling back to seeking`, 'w'); }
    }
    return videoElementSource(file);
  }

  async function sampleSource(sample) {
    const made = await sample.make();
    const frames = made instanceof ImageData ? [made] : made.frames;
    return {
      id: uid(), name: `Sample: ${sample.name}`, kind: frames.length > 1 ? 'sequence' : 'image', sample: sample.id,
      width: frames[0].width, height: frames[0].height, frameCount: frames.length, fps: made.fps || 25, files: [],
      getFrame: async i => frames[clamp(i, 0, frames.length - 1)],
    };
  }

  // Frame at preview scale for the engine.
  const scaledCache = frameLRU(16);
  async function provideFrame(index, scale) {
    const src = S.source;
    if (!src) throw new Error('no source');
    const full = await src.getFrame(clamp(index, 0, src.frameCount - 1));
    if (scale >= 1) return full;
    const key = `${src.id}:${index}:${scale}`;
    const hit = scaledCache.get(key); if (hit) return hit;
    const w = Math.max(1, Math.round(full.width * scale)), h = Math.max(1, Math.round(full.height * scale));
    const tmp = document.createElement('canvas'); tmp.width = full.width; tmp.height = full.height;
    tmp.getContext('2d').putImageData(full, 0, 0);
    const d = bitmapToImageData(tmp, w, h);
    scaledCache.set(key, d);
    return d;
  }

  async function sha256(file) {
    const buf = await file.arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function authenticate(src) {
    if (!src.files.length || !crypto.subtle) return;
    src.hashes = [];
    for (const f of src.files) {
      const h = await sha256(f);
      src.hashes.push({ name: f.name, size: f.size, sha256: h });
      log(`SHA-256 ${f.name}: ${h}`);
    }
  }

  async function setSource(src) {
    stopPlay();
    S.source = src; S.frame = 0; S.inMark = null; S.outMark = null; S.editParam = null;
    V.fitNext = true;
    backend.setSource({ id: src.id, frameCount: src.frameCount, fps: src.fps, width: src.width, height: src.height, name: src.name });
    syncChain();
    $('fps').value = src.fps;
    $('drophint').hidden = true;
    updateSourceInfo();
    log(`Loaded ${src.kind} "${src.name}": ${src.width}×${src.height}, ${src.frameCount} frame${src.frameCount === 1 ? '' : 's'}${src.kind === 'video' ? ` at ${src.fps} fps (${src.decoder || 'decoder'})` : ''}`);
    renderAll();
    if (S.opts.auth) authenticate(src).catch(e => log('Hashing failed: ' + e.message, 'e'));
  }
  AD.setSource = setSource;

  function updateSourceInfo() {
    const s = S.source;
    $('srcinfo').textContent = s ? `${s.name} · ${s.width}×${s.height}${s.frameCount > 1 ? ` · ${s.frameCount} frames · ${s.fps} fps` : ''}` : 'No source loaded';
    $('srcinfo').title = $('srcinfo').textContent;
  }

  async function openFiles(files) {
    files = [...files];
    if (!files.length) return;
    try {
      setBusy(true, 'Opening…');
      const videos = files.filter(f => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ogv|3gp)$/i.test(f.name));
      if (videos.length) await setSource(await videoSource(videos[0]));
      else if (files.length > 1) await setSource(await sequenceSource(files));
      else await setSource(await imageSource(files[0]));
    } catch (e) {
      log(e.message, 'e');
      showError(e.message);
    } finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- chain helpers
  const stepIndex = u => S.chain.findIndex(s => s.uid === u);
  const selIndex = () => stepIndex(S.sel);

  function frameCountAt(k) {
    let n = S.source ? S.source.frameCount : 1;
    for (let i = 0; i <= k && i < S.chain.length; i++) {
      const s = S.chain[i], def = AD.filters.get(s.filterId);
      if (s.enabled && def && def.frameCount) n = Math.max(1, Math.floor(def.frameCount(n, s.params)) || 1);
    }
    return n;
  }

  function syncChain() {
    backend.setChain(S.chain.map(s => ({ uid: s.uid, filterId: s.filterId, enabled: s.enabled, params: s.params })));
    if (S.opts.autorecover) store.set('recovery', { chain: S.chain.map(s => ({ filterId: s.filterId, enabled: s.enabled, params: s.params })), at: Date.now() });
  }

  function chainChanged({ interactive = false } = {}) {
    syncChain();
    renderChain();
    requestRender({ interactive });
  }

  async function addFilter(id) {
    const def = AD.filters.get(id);
    if (!def) return;
    const at = S.sel ? selIndex() + 1 : S.chain.length;
    let dims = S.source ? { width: S.source.width, height: S.source.height } : { width: 640, height: 480 };
    if (S.source && at > 0) {
      try { const r = await backend.render(at - 1, Math.min(S.frame, frameCountAt(at - 1) - 1), 1, null); if (r) dims = { width: r.image.width, height: r.image.height }; } catch (e) { /* defaults fall back to source size */ }
    }
    const info = { frameCount: frameCountAt(at - 1), fps: S.source ? S.source.fps : 25 };
    const step = { uid: uid(), filterId: id, enabled: true, params: AD.defaultParams(def, dims, info) };
    S.chain.splice(at, 0, step);
    S.sel = step.uid;
    if (S.show === 'original') setShow('result');
    log(`Added ${def.name}`);
    chainChanged();
    renderInspector();
  }
  AD.addFilter = addFilter;

  function removeStep(u) {
    const i = stepIndex(u); if (i < 0) return;
    const [s] = S.chain.splice(i, 1);
    log(`Removed ${(AD.filters.get(s.filterId) || {}).name || s.filterId}`);
    if (S.sel === u) S.sel = S.chain[i] ? S.chain[i].uid : S.chain[i - 1] ? S.chain[i - 1].uid : null;
    S.editParam = null;
    chainChanged(); renderInspector();
  }

  function moveStep(u, d) {
    const i = stepIndex(u), j = i + d;
    if (i < 0 || j < 0 || j >= S.chain.length) return;
    [S.chain[i], S.chain[j]] = [S.chain[j], S.chain[i]];
    chainChanged();
  }

  function setParam(step, id, value, { interactive = false, quiet = false } = {}) {
    step.params = { ...step.params, [id]: value };
    if (!quiet) {
      const def = AD.filters.get(step.filterId), p = def.params.find(q => q.id === id);
      log(`${def.name} › ${p ? p.label || p.id : id} = ${fmtValue(value)}`);
    }
    chainChanged({ interactive });
  }

  function fmtValue(v) {
    if (v == null) return '–';
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    if (Array.isArray(v)) return v.map(p => `(${Math.round(p.x)}, ${Math.round(p.y)})`).join(' ');
    if (typeof v === 'object' && 'w' in v) return `${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.w)}×${Math.round(v.h)}`;
    return String(v);
  }
  AD.fmtValue = fmtValue;

  // ---------------------------------------------------------------- render scheduling
  // Which step does the viewer show? k = -1 is the source.
  function displayK() {
    const si = selIndex();
    if (S.editParam && si >= 0) {
      const def = AD.filters.get(S.chain[si].filterId), p = def && def.params.find(q => q.id === S.editParam);
      return p && p.space === 'output' ? si : si - 1;
    }
    if (S.show === 'original') return -1;
    if (S.show === 'step' && si >= 0) return si;
    return S.chain.length - 1;
  }

  function displayLabel(k) {
    if (k < 0) return 'Original';
    const def = AD.filters.get(S.chain[k].filterId), name = def ? def.name : S.chain[k].filterId;
    if (S.editParam && k === selIndex() - 1) return `Input of ${(AD.filters.get(S.chain[k + 1].filterId) || {}).name}`;
    return k === S.chain.length - 1 && S.show === 'result' ? `Result · ${name}` : `Step ${k + 1} · ${name}`;
  }

  function previewScale() {
    if (!S.interactive || !S.source) return 1;
    const vp = $('viewport'), dpr = window.devicePixelRatio || 1;
    const need = Math.max(vp.clientWidth * dpr / S.source.width, vp.clientHeight * dpr / S.source.height) * 1.15;
    if (S.source.width * S.source.height < 1.2e6 || need >= 1) return 1;
    for (const s of [0.75, 0.5, 0.375, 0.25, 0.125]) if (s * 0.75 < need) return s;
    return 0.125;
  }

  let renderTimer = 0, idleTimer = 0, renderSeq = 0;
  function requestRender({ interactive = false, delay = 0 } = {}) {
    if (interactive) {
      S.interactive = true;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { S.interactive = false; requestRender(); }, 280);
    }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderNow(); }, delay);
  }

  async function renderNow() {
    clearTimeout(renderTimer);
    if (!S.source) { V.data = null; draw(); return null; }
    const seq = ++renderSeq;
    const k = displayK(), count = frameCountAt(k);
    S.frame = clamp(S.frame, 0, count - 1);
    const scale = previewScale();
    setBusy(true);
    try {
      const r = await backend.render(k, S.frame, scale, 'view');
      if (!r || seq !== renderSeq) return null;
      let orig = null;
      if (S.compare && k >= 0) {
        const o = await backend.render(-1, Math.min(S.frame, S.source.frameCount - 1), scale, 'compare');
        if (o && seq === renderSeq) orig = o.image;
      }
      if (seq !== renderSeq) return null;
      for (const st of r.steps || []) S.stepStats.set(st.uid, st);
      showResult(r, orig, scale, k);
      renderChainStats();
      renderReadout(k, r);
      updatePlayer(r.frameCount);
      return r;
    } catch (e) {
      log('Render failed: ' + e.message, 'e');
      showError(e.message);
      return null;
    } finally {
      if (seq === renderSeq) setBusy(false);
    }
  }
  AD.renderNow = renderNow;

  function renderAll() { renderChain(); renderInspector(); requestRender(); }

  // ---------------------------------------------------------------- viewer
  const V = AD.viewer = {
    zoom: 1, cx: 0, cy: 0, data: null, scale: 1, fw: 0, fh: 0, overlay: [], orig: null, split: 0.5,
    fitNext: true, bmp: document.createElement('canvas'), obmp: document.createElement('canvas'), colors: {},
  };

  function readColors() {
    const cs = getComputedStyle(document.documentElement), g = n => cs.getPropertyValue(n).trim();
    V.colors = { accent: g('--accent'), hit: g('--hit'), warn: g('--warn'), fg: g('--fg'), bg: g('--raised') };
  }

  function showResult(r, orig, scale, k) {
    const img = r.image;
    V.data = img; V.scale = scale; V.overlay = r.overlay || []; V.k = k;
    const fw = Math.round(img.width / scale), fh = Math.round(img.height / scale);
    const dimsChanged = fw !== V.fw || fh !== V.fh;
    V.fw = fw; V.fh = fh;
    V.bmp.width = img.width; V.bmp.height = img.height;
    V.bmp.getContext('2d').putImageData(img, 0, 0);
    V.orig = null;
    if (orig) { V.obmp.width = orig.width; V.obmp.height = orig.height; V.obmp.getContext('2d').putImageData(orig, 0, 0); V.orig = V.obmp; }
    if (V.fitNext || dimsChanged) { fit(); V.fitNext = false; }
    $('vlabel-r').textContent = displayLabel(k) + (scale < 1 ? ` · preview ${Math.round(scale * 100)}%` : '');
    $('vlabel-l').hidden = !V.orig;
    $('vlabel-l').textContent = 'Original';
    $('errbox').hidden = !r.error;
    if (r.error) $('errbox').textContent = `This step failed: ${r.error}. Showing its input instead.`;
    draw();
  }

  function fit() {
    const vp = $('viewport');
    if (!V.fw) return;
    V.zoom = Math.min(vp.clientWidth / V.fw, vp.clientHeight / V.fh) * 0.96;
    V.cx = V.fw / 2; V.cy = V.fh / 2;
    updateZoomLabel();
  }

  function zoomAt(factor, sx, sy) {
    const vp = $('viewport');
    if (sx == null) { sx = vp.clientWidth / 2; sy = vp.clientHeight / 2; }
    const [ix, iy] = toImage(sx, sy);
    V.zoom = clamp(V.zoom * factor, 0.02, 64);
    V.cx = ix - (sx - vp.clientWidth / 2) / V.zoom;
    V.cy = iy - (sy - vp.clientHeight / 2) / V.zoom;
    updateZoomLabel(); draw();
  }

  const updateZoomLabel = () => { $('zoomval').textContent = Math.round(V.zoom * 100) + '%'; };

  function toImage(sx, sy) {
    const vp = $('viewport');
    return [(sx - vp.clientWidth / 2) / V.zoom + V.cx, (sy - vp.clientHeight / 2) / V.zoom + V.cy];
  }
  function toScreen(x, y) {
    const vp = $('viewport');
    return [(x - V.cx) * V.zoom + vp.clientWidth / 2, (y - V.cy) * V.zoom + vp.clientHeight / 2];
  }

  function draw() {
    const cv = $('view'), vp = $('viewport'), dpr = window.devicePixelRatio || 1;
    const W = vp.clientWidth, H = vp.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    if (!V.data) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [x0, y0] = toScreen(0, 0);
    c.imageSmoothingEnabled = V.zoom < 2;
    c.imageSmoothingQuality = 'high';
    c.drawImage(V.bmp, x0, y0, V.fw * V.zoom, V.fh * V.zoom);
    if (V.orig) {
      const split = V.split * W;
      c.save(); c.beginPath(); c.rect(0, 0, split, H); c.clip();
      c.fillStyle = '#000'; c.fillRect(0, 0, split, H);
      c.drawImage(V.orig, x0, y0, V.fw * V.zoom, V.fh * V.zoom);
      c.restore();
      c.fillStyle = V.colors.accent; c.fillRect(split - 1, 0, 2, H);
      c.beginPath(); c.arc(split, H / 2, 9, 0, Math.PI * 2); c.fill();
    }
    if (S.overlays && !S.editParam) drawOverlay(c, V.overlay, 1 / V.scale);
    if (S.editParam) drawEditHandles(c);
  }

  function colorOf(name) { return V.colors[name] || name || V.colors.accent; }

  function drawLabel(c, x, y, text, color) {
    c.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    const w = c.measureText(text).width + 8;
    c.fillStyle = 'rgba(0,0,0,0.7)'; c.fillRect(x, y - 15, w, 17);
    c.fillStyle = color === V.colors.accent ? '#e1e8e5' : color; c.fillText(text, x + 4, y - 3);
  }

  // Overlay coords are in the displayed image's pixels; k = 1/scale converts them to full-resolution units.
  function drawOverlay(c, shapes, k = 1) {
    if (!shapes) return;
    const P = (x, y) => toScreen(x * k, y * k);
    c.lineWidth = 2;
    for (const s of shapes) {
      const col = colorOf(s.color);
      c.strokeStyle = col; c.fillStyle = col;
      c.setLineDash(s.dash ? [6, 4] : []);
      if (s.type === 'line') {
        const [a, b] = P(s.x1, s.y1), [d, e] = P(s.x2, s.y2);
        c.beginPath(); c.moveTo(a, b); c.lineTo(d, e); c.stroke();
        if (s.label) drawLabel(c, (a + d) / 2 + 6, (b + e) / 2 - 4, s.label, col);
      } else if (s.type === 'poly' && s.points && s.points.length) {
        c.beginPath();
        s.points.forEach((p, i) => { const [x, y] = P(p.x, p.y); i ? c.lineTo(x, y) : c.moveTo(x, y); });
        if (s.closed) c.closePath();
        c.stroke();
        if (s.label) { const [x, y] = P(s.points[0].x, s.points[0].y); drawLabel(c, x + 6, y - 6, s.label, col); }
      } else if (s.type === 'rect') {
        const [x, y] = P(s.x, s.y), [x2, y2] = P(s.x + s.w, s.y + s.h);
        c.strokeRect(x, y, x2 - x, y2 - y);
        if (s.label) drawLabel(c, x, y - 4, s.label, col);
      } else if (s.type === 'circle') {
        const [x, y] = P(s.x, s.y);
        c.beginPath(); c.arc(x, y, Math.max(2, s.r * k * V.zoom), 0, Math.PI * 2); c.stroke();
        if (s.label) drawLabel(c, x + 8, y - 8, s.label, col);
      } else if (s.type === 'text') {
        const [x, y] = P(s.x, s.y);
        drawLabel(c, x, y, s.text, col);
      }
    }
    c.setLineDash([]);
  }

  // ---------------------------------------------------------------- point editing
  function editTarget() {
    const si = selIndex();
    if (si < 0 || !S.editParam) return null;
    const step = S.chain[si], def = AD.filters.get(step.filterId), p = def.params.find(q => q.id === S.editParam);
    return p ? { step, def, p } : null;
  }

  function drawEditHandles(c) {
    const t = editTarget(); if (!t) return;
    const v = t.step.params[t.p.id], col = V.colors.accent;
    c.lineWidth = 2; c.strokeStyle = col;
    if (t.p.type === 'rect' && v) {
      const [x, y] = toScreen(v.x, v.y), [x2, y2] = toScreen(v.x + v.w, v.y + v.h);
      c.setLineDash([6, 4]); c.strokeRect(x, y, x2 - x, y2 - y); c.setLineDash([]);
      for (const [hx, hy] of [[x, y], [x2, y], [x, y2], [x2, y2]]) { c.fillStyle = col; c.fillRect(hx - 5, hy - 5, 10, 10); }
      return;
    }
    if (!Array.isArray(v)) return;
    const pts = v.map(q => toScreen(q.x, q.y)), shape = t.p.shape || 'points';
    c.beginPath();
    if (shape === 'polygon' || shape === 'polyline') {
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      if (shape === 'polygon' && pts.length > 2) c.closePath();
    } else if (shape === 'segments') {
      for (let i = 0; i + 1 < pts.length; i += 2) { c.moveTo(...pts[i]); c.lineTo(...pts[i + 1]); }
    }
    c.stroke();
    pts.forEach(([x, y], i) => {
      c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.55)'; c.fill(); c.stroke();
      c.beginPath(); c.arc(x, y, 2, 0, Math.PI * 2); c.fillStyle = col; c.fill();
      const label = t.p.labels ? t.p.labels[i] : String(i + 1);
      if (label) drawLabel(c, x + 10, y - 8, label, col);
    });
  }

  function hitHandle(sx, sy) {
    const t = editTarget(); if (!t) return -1;
    const v = t.step.params[t.p.id];
    if (t.p.type === 'rect' && v) {
      const corners = [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.h], [v.x + v.w, v.y + v.h]];
      for (let i = 0; i < 4; i++) { const [x, y] = toScreen(...corners[i]); if (Math.hypot(x - sx, y - sy) < 12) return i; }
      return -1;
    }
    if (!Array.isArray(v)) return -1;
    for (let i = v.length - 1; i >= 0; i--) { const [x, y] = toScreen(v[i].x, v[i].y); if (Math.hypot(x - sx, y - sy) < 13) return i; }
    return -1;
  }

  // ---------------------------------------------------------------- pointer handling
  const pointers = new Map();
  let drag = null;

  function onPointerDown(e) {
    const vp = $('viewport'), r = vp.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    vp.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: sx, y: sy });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), zoom: V.zoom }; return; }
    if (!V.data) return;
    if (V.orig && Math.abs(sx - V.split * vp.clientWidth) < 12) { drag = { type: 'split' }; return; }
    const t = S.tool === 'edit' ? editTarget() : null;
    if (t) {
      const [ix, iy] = toImage(sx, sy);
      const h = hitHandle(sx, sy), v = t.step.params[t.p.id];
      if (t.p.type === 'rect') {
        if (h >= 0) drag = { type: 'rect-corner', corner: h, t };
        else if (v && ix >= v.x && ix <= v.x + v.w && iy >= v.y && iy <= v.y + v.h) drag = { type: 'rect-move', t, ox: ix - v.x, oy: iy - v.y };
        else { drag = { type: 'rect-new', t, x0: ix, y0: iy }; setParam(t.step, t.p.id, { x: ix, y: iy, w: 1, h: 1 }, { interactive: true, quiet: true }); }
        return;
      }
      if (h >= 0) { drag = { type: 'point', i: h, t }; return; }
      const max = t.p.max != null ? t.p.max : t.p.count;
      const pts = Array.isArray(v) ? v : [];
      if (max == null || pts.length < max) {
        const nv = [...pts, { x: ix, y: iy }];
        setParam(t.step, t.p.id, nv, { interactive: true, quiet: true });
        drag = { type: 'point', i: nv.length - 1, t };
        return;
      }
    }
    if (S.tool === 'zoom') { zoomAt(e.altKey || e.shiftKey || e.button === 2 ? 1 / 1.6 : 1.6, sx, sy); return; }
    drag = { type: 'pan', sx, sy, cx: V.cx, cy: V.cy };
  }

  function onPointerMove(e) {
    const vp = $('viewport'), r = vp.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: sx, y: sy });
    updatePixel(sx, sy);
    if (!drag) {
      vp.style.cursor = V.orig && Math.abs(sx - V.split * vp.clientWidth) < 12 ? 'ew-resize'
        : S.tool === 'edit' && hitHandle(sx, sy) >= 0 ? 'move' : S.tool === 'zoom' ? 'zoom-in' : S.tool === 'edit' ? 'crosshair' : 'grab';
      return;
    }
    const [ix, iy] = toImage(sx, sy);
    if (drag.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      V.zoom = clamp(drag.zoom * Math.hypot(a.x - b.x, a.y - b.y) / drag.d, 0.02, 64); updateZoomLabel(); draw();
    } else if (drag.type === 'pan') {
      V.cx = drag.cx - (sx - drag.sx) / V.zoom; V.cy = drag.cy - (sy - drag.sy) / V.zoom; draw();
    } else if (drag.type === 'split') {
      V.split = clamp(sx / vp.clientWidth, 0.02, 0.98); draw();
    } else if (drag.type === 'point') {
      const { t } = drag, v = [...t.step.params[t.p.id]];
      v[drag.i] = { x: clamp(ix, 0, V.fw), y: clamp(iy, 0, V.fh) };
      setParam(t.step, t.p.id, v, { interactive: true, quiet: true }); draw();
    } else if (drag.type.startsWith('rect')) {
      const { t } = drag, v = { ...t.step.params[t.p.id] };
      if (drag.type === 'rect-new') { v.x = Math.min(drag.x0, ix); v.y = Math.min(drag.y0, iy); v.w = Math.abs(ix - drag.x0); v.h = Math.abs(iy - drag.y0); }
      else if (drag.type === 'rect-move') { v.x = ix - drag.ox; v.y = iy - drag.oy; }
      else {
        const x1 = drag.corner % 2 ? v.x : v.x + v.w, y1 = drag.corner > 1 ? v.y : v.y + v.h;
        v.x = Math.min(x1, ix); v.y = Math.min(y1, iy); v.w = Math.abs(ix - x1); v.h = Math.abs(iy - y1);
      }
      v.w = Math.max(1, v.w); v.h = Math.max(1, v.h);
      setParam(t.step, t.p.id, v, { interactive: true, quiet: true }); draw();
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (drag && (drag.type === 'point' || drag.type.startsWith('rect'))) {
      const { t } = drag;
      log(`${t.def.name} › ${t.p.label || t.p.id} = ${fmtValue(t.step.params[t.p.id])}`);
      renderInspector();
    }
    if (pointers.size < 2) drag = pointers.size ? drag : null;
  }

  function onDblClick(e) {
    const t = S.tool === 'edit' ? editTarget() : null;
    if (!t || t.p.type !== 'points') return;
    const r = $('viewport').getBoundingClientRect(), h = hitHandle(e.clientX - r.left, e.clientY - r.top);
    const v = t.step.params[t.p.id] || [];
    const min = t.p.min != null ? t.p.min : t.p.count;
    if (h >= 0 && (min == null || v.length > min)) setParam(t.step, t.p.id, v.filter((_, i) => i !== h));
  }

  function updatePixel(sx, sy) {
    if (!V.data) return;
    const [ix, iy] = toImage(sx, sy);
    const x = Math.floor(ix), y = Math.floor(iy);
    if (x < 0 || y < 0 || x >= V.fw || y >= V.fh) { $('pixel').textContent = '–'; return; }
    const px = clamp(Math.floor(ix * V.scale), 0, V.data.width - 1), py = clamp(Math.floor(iy * V.scale), 0, V.data.height - 1);
    const i = (py * V.data.width + px) * 4, d = V.data.data;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    const yv = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    $('pixel').textContent = `x ${x}  y ${y}\nR ${r}  G ${g}  B ${b}  Y ${yv}\n${hex}${V.scale < 1 ? '  (preview)' : ''}`;
  }

  // ---------------------------------------------------------------- panels
  function renderFilterList() {
    const q = ($('filter-search').value || '').trim().toLowerCase();
    const box = $('filter-list'); box.textContent = '';
    let shown = 0;
    for (const cat of AD.CATEGORIES) {
      const defs = [...AD.filters.values()].filter(d => d.category === cat && (!q || (d.name + ' ' + (d.description || '') + ' ' + (d.keywords || []).join(' ')).toLowerCase().includes(q)));
      if (!defs.length) continue;
      shown += defs.length;
      const det = el('details', { class: 'cat', open: q || store.get('cat:' + cat, false) ? true : null },
        el('summary', { text: `${cat} (${defs.length})` }),
        defs.sort((a, b) => a.name.localeCompare(b.name)).map(d => el('button', { type: 'button', title: d.description || '', onclick: () => addFilter(d.id), text: d.name })));
      det.addEventListener('toggle', () => { if (!q) store.set('cat:' + cat, det.open); });
      box.append(det);
    }
    if (!shown) box.append(el('p', { class: 'empty', text: q ? 'No filter matches that search.' : 'No filters loaded.' }));
  }

  function renderChain() {
    const ul = $('chain'); ul.textContent = '';
    ul.append(el('li', { class: 'src' }, el('span', { text: '◆' }), el('span', { class: 'nm', text: S.source ? S.source.name : 'No source' }), el('span')));
    S.chain.forEach((s, i) => {
      const def = AD.filters.get(s.filterId), st = S.stepStats.get(s.uid) || {};
      const li = el('li', { class: [s.uid === S.sel ? 'sel' : '', s.enabled ? '' : 'off', st.error ? 'err' : ''].join(' '), 'data-uid': s.uid, tabindex: 0,
        onclick: () => selectStep(s.uid), onkeydown: e => { if (e.key === 'Enter') selectStep(s.uid); } },
        el('input', { type: 'checkbox', checked: s.enabled ? true : null, 'aria-label': 'Enable step', onclick: e => e.stopPropagation(),
          onchange: e => { s.enabled = e.target.checked; log(`${s.enabled ? 'Enabled' : 'Disabled'} ${def ? def.name : s.filterId}`); chainChanged(); } }),
        el('span', { class: 'nm' }, `${i + 1}. ${def ? def.name : s.filterId + ' (missing)'}`, el('small', { class: 'stat', text: stepStatText(st) })),
        el('span', { class: 'ops' },
          el('button', { type: 'button', 'aria-label': 'Move up', disabled: i === 0 ? true : null, onclick: e => { e.stopPropagation(); moveStep(s.uid, -1); }, text: '↑' }),
          el('button', { type: 'button', 'aria-label': 'Move down', disabled: i === S.chain.length - 1 ? true : null, onclick: e => { e.stopPropagation(); moveStep(s.uid, 1); }, text: '↓' }),
          el('button', { type: 'button', 'aria-label': 'Remove', onclick: e => { e.stopPropagation(); removeStep(s.uid); }, text: '✕' })));
      ul.append(li);
    });
    $('chain-count').textContent = S.chain.length ? `${S.chain.length} step${S.chain.length > 1 ? 's' : ''}` : '';
  }

  const stepStatText = st => (st.error ? 'Error: ' + st.error : st.ms != null ? `${st.ms} ms` : '');
  function renderChainStats() {
    for (const li of $('chain').querySelectorAll('li[data-uid]')) {
      const st = S.stepStats.get(li.dataset.uid) || {};
      li.querySelector('.stat').textContent = stepStatText(st);
      li.classList.toggle('err', !!st.error);
    }
  }

  function selectStep(u) {
    if (S.sel === u) return;
    S.sel = u; S.editParam = null;
    if (S.tool === 'edit') setTool('pan');
    renderChain(); renderInspector();
    if (S.show === 'step') requestRender();
  }

  function renderInspector() {
    const box = $('params'); box.textContent = '';
    const si = selIndex();
    $('readout').hidden = true;
    const editable = si >= 0 && AD.filters.get(S.chain[si].filterId)?.params.some(p => p.type === 'points' || p.type === 'rect');
    $('tool-edit').disabled = !editable;
    if (si < 0) {
      $('insp-title').textContent = 'Parameters';
      box.append(el('p', { class: 'empty', text: S.chain.length ? 'Select a step in History to change its parameters.' : 'Add a filter from the Filters panel. Each one appears in History and runs on the output of the step above it.' }));
      const rec = store.get('recovery', null);
      if (!S.chain.length && S.opts.autorecover && rec && rec.chain && rec.chain.length) {
        box.append(el('button', { type: 'button', onclick: () => restoreChain(rec.chain, 'recovered'), text: `Restore previous chain (${rec.chain.length} step${rec.chain.length > 1 ? 's' : ''})` }));
      }
      return;
    }
    const step = S.chain[si], def = AD.filters.get(step.filterId);
    $('insp-title').textContent = `${si + 1}. ${def ? def.name : step.filterId}`;
    if (!def) { box.append(el('p', { class: 'empty', text: 'This filter is not available in this version.' })); return; }
    if (def.description) box.append(el('p', { class: 'desc', text: def.description }));
    for (const p of def.params) {
      if (p.when && !p.when(step.params)) continue;
      box.append(paramControl(step, def, p));
    }
    if (def.actions.length) {
      box.append(el('div', { class: 'actions' }, def.actions.map(a => el('button', { type: 'button', onclick: () => runAction(step, def, a), text: a.label }))));
    }
    const st = S.stepStats.get(step.uid);
    if (st && st.readout && V.k === si) renderReadout(si, { readout: st.readout });
  }

  function paramControl(step, def, p) {
    const v = step.params[p.id], label = p.label || p.id, id = `p-${step.uid}-${p.id}`;
    const hint = p.hint ? el('span', { class: 'hint', text: p.hint }) : null;
    if (p.type === 'range' || p.type === 'number') {
      const max = p.max === 'lastFrame' ? frameCountAt(selIndex() - 1) - 1 : p.max;
      const out = el('output', { for: id, text: fmtNum(v, p) });
      if (p.type === 'number') {
        return el('div', { class: 'prm' }, el('div', { class: 'hd' }, el('label', { for: id, text: label })),
          el('input', { type: 'number', id, value: v, min: p.min, max, step: p.step || 'any', onchange: e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) setParam(step, p.id, n); } }), hint);
      }
      return el('div', { class: 'prm' }, el('div', { class: 'hd' }, el('label', { for: id, text: label }), out),
        el('input', { type: 'range', id, min: p.min, max, step: p.step || 1, value: v,
          oninput: e => { const n = parseFloat(e.target.value); out.textContent = fmtNum(n, p); setParam(step, p.id, n, { interactive: true, quiet: true }); },
          onchange: e => log(`${def.name} › ${label} = ${fmtNum(parseFloat(e.target.value), p)}`) }), hint);
    }
    if (p.type === 'select') {
      return el('div', { class: 'prm' }, el('label', { for: id, text: label }),
        el('select', { id, onchange: e => { const o = p.options.find(o => String(o.value) === e.target.value); setParam(step, p.id, o ? o.value : e.target.value); renderInspector(); } },
          p.options.map(o => el('option', { value: o.value, selected: o.value === v ? true : null, text: o.label }))), hint);
    }
    if (p.type === 'bool') {
      return el('label', { class: 'prm check' }, el('input', { type: 'checkbox', id, checked: v ? true : null, onchange: e => { setParam(step, p.id, e.target.checked); renderInspector(); } }), label);
    }
    if (p.type === 'text' || p.type === 'color') {
      return el('div', { class: 'prm' }, el('label', { for: id, text: label }),
        el('input', { type: p.type, id, value: v || '', onchange: e => setParam(step, p.id, e.target.value) }), hint);
    }
    if (p.type === 'points' || p.type === 'rect') {
      const editing = S.editParam === p.id;
      const n = p.type === 'points' ? (Array.isArray(v) ? v.length : 0) : v ? 1 : 0;
      const status = p.type === 'rect' ? (v ? fmtValue(v) : 'not set') : `${n} point${n === 1 ? '' : 's'}${p.count ? ` of ${p.count}` : ''}`;
      return el('div', { class: 'prm' }, el('div', { class: 'hd' }, el('span', { text: label }), el('output', { text: status })),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: editing ? 'on' : null, onclick: () => toggleEdit(p.id), text: editing ? 'Done editing' : 'Edit on image' }),
          el('button', { type: 'button', onclick: () => resetParam(step, def, p), text: 'Reset' })),
        el('span', { class: 'hint', text: p.hint || (p.type === 'rect' ? 'Drag on the image to draw the area; drag inside it to move.' : (p.max != null && p.max !== p.count) ? 'Click to add a point, drag to move, double-click to remove.' : 'Drag the numbered handles into place.') }));
    }
    return el('p', { class: 'empty', text: `${label}: unsupported parameter type ${p.type}` });
  }

  function fmtNum(v, p) {
    if (v == null || Number.isNaN(v)) return '–';
    const d = p.step && p.step < 1 ? Math.min(4, Math.ceil(-Math.log10(p.step))) : 0;
    return Number(v).toFixed(d) + (p.unit ? ` ${p.unit}` : '');
  }

  async function resetParam(step, def, p) {
    const k = stepIndex(step.uid);
    let dims = { width: S.source ? S.source.width : 640, height: S.source ? S.source.height : 480 };
    try { const r = await backend.render(k - 1, S.frame, 1, null); if (r) dims = { width: r.image.width, height: r.image.height }; } catch (e) { /* keep source size */ }
    const fresh = AD.defaultParams({ params: [p] }, dims, { frameCount: frameCountAt(k - 1), fps: S.source ? S.source.fps : 25 });
    setParam(step, p.id, fresh[p.id]);
    renderInspector();
  }

  function toggleEdit(paramId) {
    S.editParam = S.editParam === paramId ? null : paramId;
    setTool(S.editParam ? 'edit' : 'pan', true);
    renderInspector(); requestRender();
  }

  async function runAction(step, def, a) {
    try {
      setBusy(true, a.label + '…');
      const patch = await backend.action(step.uid, a.id, S.frame);
      step.params = { ...step.params, ...patch };
      log(`${def.name} › ${a.label}: ${Object.entries(patch).map(([k, v]) => `${k} = ${fmtValue(v)}`).join(', ') || 'no change'}`);
      chainChanged(); renderInspector();
    } catch (e) { log(`${def.name} › ${a.label} failed: ${e.message}`, 'e'); }
    finally { setBusy(false); }
  }

  function renderReadout(k, r) {
    const dl = $('readout');
    const show = r && r.readout && k === selIndex();
    dl.hidden = !show;
    if (!show) return;
    dl.textContent = '';
    for (const [key, val] of Object.entries(r.readout)) dl.append(el('dt', { text: key }), el('dd', { text: String(val) }));
  }

  function restoreChain(list, how) {
    const missing = [];
    S.chain = list.filter(s => { const ok = AD.filters.has(s.filterId); if (!ok) missing.push(s.filterId); return ok; })
      .map(s => ({ uid: uid(), filterId: s.filterId, enabled: s.enabled !== false, params: s.params || {} }));
    S.sel = S.chain.length ? S.chain[S.chain.length - 1].uid : null;
    log(`Chain ${how}: ${S.chain.length} step${S.chain.length === 1 ? '' : 's'}${missing.length ? `; skipped unknown filters ${missing.join(', ')}` : ''}`, missing.length ? 'w' : '');
    chainChanged(); renderInspector();
  }

  // ---------------------------------------------------------------- tools, show modes
  function setTool(t, fromEdit) {
    if (t === 'edit' && !fromEdit) {
      const si = selIndex(), def = si >= 0 && AD.filters.get(S.chain[si].filterId);
      const p = def && def.params.find(q => q.type === 'points' || q.type === 'rect');
      if (!p) return;
      S.editParam = p.id; renderInspector(); requestRender();
    }
    if (t !== 'edit' && S.editParam) { S.editParam = null; renderInspector(); requestRender(); }
    S.tool = t;
    for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  }

  function setShow(m) {
    S.show = m;
    for (const b of document.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', String(b.dataset.show === m));
    requestRender();
  }

  // ---------------------------------------------------------------- player
  function updatePlayer(count) {
    count = count || frameCountAt(displayK());
    const multi = count > 1;
    for (const id of ['first', 'prev', 'play', 'next', 'last', 'seek', 'mark-in', 'mark-out']) $(id).disabled = !multi;
    $('seek').max = Math.max(0, count - 1);
    $('seek').value = S.frame;
    const fps = S.source ? S.source.fps : 25;
    const t = S.frame / fps, mm = Math.floor(t / 60), ss = (t % 60).toFixed(2).padStart(5, '0');
    $('framelabel').textContent = S.source ? `Frame ${S.frame + 1} / ${count} · ${mm}:${ss}` : 'Frame – / –';
    $('inout').textContent = S.inMark == null && S.outMark == null ? 'Range: all frames' : `Range: ${(S.inMark ?? 0) + 1}–${(S.outMark ?? count - 1) + 1}`;
  }

  function gotoFrame(f, interactive) {
    const count = frameCountAt(displayK());
    S.frame = clamp(f, 0, count - 1);
    updatePlayer(count);
    requestRender({ interactive });
  }

  async function play() {
    if (S.playing) { stopPlay(); return; }
    S.playing = true; $('play').textContent = 'Pause';
    log('Playback started');
    while (S.playing) {
      const t0 = performance.now(), count = frameCountAt(displayK());
      const lo = S.inMark ?? 0, hi = S.outMark ?? count - 1;
      S.frame = S.frame >= hi ? lo : S.frame + 1;
      S.interactive = true;
      await renderNow();
      const wait = 1000 / (S.source ? S.source.fps : 25) - (performance.now() - t0);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }
  function stopPlay() {
    if (!S.playing) return;
    S.playing = false; $('play').textContent = 'Play'; S.interactive = false;
    requestRender();
  }

  // ---------------------------------------------------------------- busy / errors / progress
  function setBusy(on, text) {
    $('busybar').style.width = on ? '35%' : '0';
    if (text) $('vlabel-r').textContent = text;
  }
  function setProgress(fraction, text) {
    $('busybar').style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
    if (text) $('vlabel-r').textContent = `${text} ${Math.round(fraction * 100)}%`;
  }
  function showError(msg) { const b = $('errbox'); b.hidden = false; b.textContent = msg; }

  // ---------------------------------------------------------------- saving files
  async function saveFile(filename, data) {
    try {
      const dl = root.claude && root.claude.use ? await root.claude.use('downloads') : null;
      if (dl) { await dl.save({ filename, data }); log(`Saved ${filename}`); return true; }
    } catch (e) {
      if (e && e.code === 'declined') { log(`Save of ${filename} declined`, 'w'); return false; }
      log(`Save failed: ${(e && e.message) || e}`, 'e'); return false;
    }
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob), a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    log(`Saved ${filename}`);
    return true;
  }
  AD.saveFile = saveFile;

  function fileName(ext, extra = {}) {
    const base = S.source ? S.source.name.replace(/^Sample: /, '').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') : 'untitled';
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    let n = S.opts.filename || '$in$ts';
    n = n.replace(/\$in/g, base).replace(/\$ts/g, '_' + ts).replace(/\$fn/g, String((extra.frame ?? S.frame) + 1).padStart(5, '0')).replace(/\$flt/g, (extra.filter || 'result').replace(/\W+/g, '_'));
    return `${n}.${ext}`;
  }

  async function encodeFrame(img, overlay, scale, type, quality) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.putImageData(img, 0, 0);
    if (overlay && overlay.length && S.overlays) {
      // Draw overlays at image scale by temporarily pointing the viewer transform at this canvas.
      const saved = { zoom: V.zoom, cx: V.cx, cy: V.cy };
      const vp = $('viewport');
      V.zoom = scale; V.cx = (vp.clientWidth / 2) / scale; V.cy = (vp.clientHeight / 2) / scale;
      drawOverlay(g, overlay, 1 / scale);
      Object.assign(V, saved);
    }
    return new Promise(resolve => c.toBlob(resolve, type, quality));
  }

  const MIME = { jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'] };

  async function saveFrame(k, label) {
    if (!S.source) return;
    setBusy(true, 'Rendering full resolution…');
    try {
      const r = await backend.render(k, S.frame, 1, 'export');
      if (!r) return;
      const [type, ext] = MIME[S.opts.format] || MIME.jpeg;
      const blob = await encodeFrame(r.image, r.overlay, 1, type, S.opts.quality / 100);
      await saveFile(fileName(ext, { filter: label }), blob);
    } catch (e) { log('Save failed: ' + e.message, 'e'); }
    finally { setBusy(false); }
  }

  function exportRange() {
    const count = frameCountAt(S.chain.length - 1);
    return [S.inMark ?? 0, Math.min(S.outMark ?? count - 1, count - 1)];
  }

  // Minimal ZIP writer (stored, no compression: PNG is already compressed).
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(entries) {
    const parts = [], central = [], enc = new TextEncoder();
    let offset = 0;
    for (const { name, data } of entries) {
      const nm = enc.encode(name), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
      parts.push(lh.buffer, nm, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, nm);
      offset += 30 + nm.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  AD.makeZip = makeZip;

  async function saveZip() {
    if (!S.source) return;
    const [a, b] = exportRange(), k = S.chain.length - 1, entries = [];
    try {
      for (let f = a; f <= b; f++) {
        setProgress((f - a) / (b - a + 1), `Rendering frame ${f + 1}`);
        const r = await backend.render(k, f, 1, 'export');
        if (!r) return;
        const blob = await encodeFrame(r.image, r.overlay, 1, 'image/png');
        entries.push({ name: fileName('png', { frame: f }).replace(/(\.png)$/, `_${String(f + 1).padStart(5, '0')}$1`), data: new Uint8Array(await blob.arrayBuffer()) });
      }
      await saveFile(fileName('zip'), makeZip(entries));
    } catch (e) { log('ZIP export failed: ' + e.message, 'e'); }
    finally { setBusy(false); }
  }

  async function saveVideo() {
    if (!S.source) return;
    const [a, b] = exportRange(), k = S.chain.length - 1, fps = S.source.fps;
    if (AD.io && AD.io.exportVideo) {
      try {
        const blob = await AD.io.exportVideo({ from: a, to: b, fps, render: f => backend.render(k, f, 1, 'export'), progress: setProgress, log });
        if (blob) await saveFile(fileName(blob.type.includes('mp4') ? 'mp4' : 'webm'), blob);
        return;
      } catch (e) { log(`Encoder unavailable (${e.message}); using real-time recording`, 'w'); }
      finally { setBusy(false); }
    }
    // Fallback: pre-render frames as JPEG, then replay them in real time into MediaRecorder.
    if (typeof MediaRecorder === 'undefined') { log('This browser cannot record video. Use Save result frames (ZIP).', 'e'); return; }
    try {
      const shots = [];
      let W = 0, H = 0;
      for (let f = a; f <= b; f++) {
        setProgress((f - a) / (b - a + 1) * 0.7, `Rendering frame ${f + 1}`);
        const r = await backend.render(k, f, 1, 'export');
        if (!r) return;
        if (!W) { W = r.image.width & ~1; H = r.image.height & ~1; }
        shots.push(await encodeFrame(r.image, r.overlay, 1, 'image/jpeg', 0.95));
      }
      const c = el('canvas', { width: W, height: H }), g = c.getContext('2d');
      const stream = c.captureStream(0), track = stream.getVideoTracks()[0];
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 }), chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      const done = new Promise(r => { rec.onstop = r; });
      rec.start();
      const t0 = performance.now();
      for (let i = 0; i < shots.length; i++) {
        const bmp = await createImageBitmap(shots[i]);
        g.drawImage(bmp, 0, 0, W, H); bmp.close();
        track.requestFrame ? track.requestFrame() : null;
        setProgress(0.7 + 0.3 * i / shots.length, 'Encoding');
        const wait = t0 + (i + 1) * 1000 / fps - performance.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      rec.stop(); await done;
      const type = (mime.split(';')[0]) || 'video/webm';
      await saveFile(fileName(type.includes('mp4') ? 'mp4' : 'webm'), new Blob(chunks, { type }));
    } catch (e) { log('Video export failed: ' + e.message, 'e'); }
    finally { setBusy(false); }
  }

  function projectJSON() {
    return JSON.stringify({
      app: 'Anomaly Detector', version: 1, saved: new Date().toISOString(),
      source: S.source ? { name: S.source.name, kind: S.source.kind, width: S.source.width, height: S.source.height, frameCount: S.source.frameCount, fps: S.source.fps, hashes: S.source.hashes || null } : null,
      chain: S.chain.map(s => ({ filterId: s.filterId, enabled: s.enabled, params: s.params })),
    }, null, 2);
  }

  async function openProject(file) {
    try {
      const j = JSON.parse(await file.text());
      if (!j || !Array.isArray(j.chain)) throw new Error('not a project file');
      restoreChain(j.chain, `loaded from ${file.name}`);
      if (j.source && (!S.source || j.source.name !== S.source.name)) log(`Project was made for "${j.source.name}". Open that source to reproduce it exactly.`, 'w');
    } catch (e) { log(`Could not open project: ${e.message}`, 'e'); }
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  async function saveReport() {
    if (S.source && S.opts.auth && !S.source.hashes) await authenticate(S.source).catch(() => {});
    let thumb = '';
    try {
      const r = S.source ? await backend.render(S.chain.length - 1, S.frame, 1, 'export') : null;
      if (r) {
        const s = Math.min(1, 900 / r.image.width), c = el('canvas', { width: Math.round(r.image.width * s), height: Math.round(r.image.height * s) });
        const t = el('canvas', { width: r.image.width, height: r.image.height }); t.getContext('2d').putImageData(r.image, 0, 0);
        c.getContext('2d').drawImage(t, 0, 0, c.width, c.height);
        thumb = `<figure><img src="${c.toDataURL('image/png')}" alt="Result at frame ${S.frame + 1}"><figcaption>Result, frame ${S.frame + 1}</figcaption></figure>`;
      }
    } catch (e) { /* report without thumbnail */ }
    const src = S.source;
    const steps = S.chain.map((s, i) => {
      const def = AD.filters.get(s.filterId) || { name: s.filterId, params: [], description: '' };
      const ps = def.params.map(p => `<tr><td>${esc(p.label || p.id)}</td><td>${esc(fmtValue(s.params[p.id]))}${p.unit ? ' ' + esc(p.unit) : ''}</td></tr>`).join('');
      return `<section><h3>${i + 1}. ${esc(def.name)}${s.enabled ? '' : ' (disabled)'}</h3><p class="cat">${esc(def.category || '')}</p><p>${esc(def.description || '')}</p>${ps ? `<table>${ps}</table>` : ''}</section>`;
    }).join('');
    const hashes = src && src.hashes ? src.hashes.map(h => `<tr><td>${esc(h.name)}</td><td>${h.size} bytes</td><td><code>${h.sha256}</code></td></tr>`).join('') : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Processing report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1a2220}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:28px;border-bottom:1px solid #ccc}h3{margin:18px 0 2px}.cat{color:#666;margin:0;font-size:.85rem}table{border-collapse:collapse;margin:6px 0}td{border:1px solid #ddd;padding:3px 8px;vertical-align:top}code{font-size:.8rem;word-break:break-all}img{max-width:100%}pre{white-space:pre-wrap;font-size:.8rem;background:#f4f4f4;padding:8px}</style></head><body>
<h1>Processing report</h1><p>Generated ${esc(new Date().toString())} by Anomaly Detector (browser).</p>
<h2>Source</h2>${src ? `<table><tr><td>Name</td><td>${esc(src.name)}</td></tr><tr><td>Type</td><td>${esc(src.kind)}</td></tr><tr><td>Decoded size</td><td>${src.width}×${src.height}</td></tr><tr><td>Frames</td><td>${src.frameCount}${src.frameCount > 1 ? ` at ${src.fps} fps` : ''}</td></tr></table>` : '<p>No source loaded.</p>'}
${hashes ? `<h2>File authentication</h2><table>${hashes}</table>` : ''}
<h2>Processing chain</h2>${steps || '<p>No filters applied.</p>'}
${thumb ? `<h2>Result</h2>${thumb}` : ''}
<h2>Log</h2><pre>${esc(S.logLines.map(l => `${l.t}  ${l.msg}`).join('\n'))}</pre></body></html>`;
    await saveFile(fileName('html').replace(/\.html$/, '_report.html'), html);
  }

  // ---------------------------------------------------------------- options dialog
  function openOptions() {
    const o = S.opts;
    $('opt-autorecover').checked = o.autorecover; $('opt-auth').checked = o.auth; $('opt-filename').value = o.filename;
    $('opt-format').value = o.format; $('opt-quality').value = o.quality; $('opt-maxdim').value = o.maxdim; $('opt-cache').value = o.cache;
    $('options').showModal();
  }
  function saveOptions() {
    const o = S.opts;
    o.autorecover = $('opt-autorecover').checked;
    const auth = $('opt-auth').checked; if (auth && !o.auth && S.source) authenticate(S.source).catch(() => {});
    o.auth = auth;
    o.filename = $('opt-filename').value || '$in$ts';
    o.format = $('opt-format').value;
    o.quality = clamp(parseInt($('opt-quality').value, 10) || 90, 10, 100);
    o.maxdim = clamp(parseInt($('opt-maxdim').value, 10) || 4096, 256, 8192);
    o.cache = clamp(parseInt($('opt-cache').value, 10) || 512, 64, 4096);
    backend.setCache(o.cache);
    store.set('opts', o);
    log('Program options updated');
  }

  // ---------------------------------------------------------------- samples menu
  function renderSamples() {
    const box = $('sample-list'); box.textContent = '';
    if (!AD.samples.length) { box.append(el('p', { class: 'empty', text: 'No samples loaded.' })); return; }
    const byCat = new Map();
    for (const s of AD.samples) { const c = s.category || 'General'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(s); }
    let first = true;
    for (const [cat, list] of byCat) {
      if (!first) box.append(el('hr')); first = false;
      for (const s of list) box.append(el('button', { type: 'button', onclick: () => loadSample(s) }, s.name, el('small', { text: cat + (s.description ? ' · ' + s.description : '') })));
    }
  }

  async function loadSample(s) {
    $('menu-samples').open = false;
    try { setBusy(true, 'Generating sample…'); await setSource(await sampleSource(s)); }
    catch (e) { log(`Sample failed: ${e.message}`, 'e'); }
    finally { setBusy(false); }
  }
  AD.loadSample = id => { const s = AD.samples.find(x => x.id === id); return s ? loadSample(s) : Promise.reject(new Error('no sample ' + id)); };

  // ---------------------------------------------------------------- programmatic control (used by the assistant)
  // Everything validates and coerces its input, and throws an Error with a message an AI or a person can act on.
  const stepRef = ref => {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const i = Number(ref) - 1;
      if (i < 0 || i >= S.chain.length) throw new Error(`there is no step ${ref}; the chain has ${S.chain.length} step(s)`);
      return S.chain[i];
    }
    const st = S.chain.find(x => x.uid === ref);
    if (!st) throw new Error(`unknown step "${ref}"; refer to steps by their number (1 = top)`);
    return st;
  };

  // Output size of step k (k = -1: source), from the last render that computed it.
  function outputSize(k) {
    for (let i = k; i >= 0; i--) {
      const st = S.stepStats.get(S.chain[i].uid);
      if (S.chain[i].enabled && st && st.w) return { width: st.w, height: st.h };
      if (S.chain[i].enabled && !(st && st.w)) break;
    }
    return S.source ? { width: S.source.width, height: S.source.height } : { width: 640, height: 480 };
  }

  function coerceParams(def, patch, k) {
    if (!patch || typeof patch !== 'object') return {};
    const out = {}, warnings = [];
    for (const [key, raw] of Object.entries(patch)) {
      const p = def.params.find(q => q.id === key);
      if (!p) throw new Error(`${def.name} has no parameter "${key}"; valid: ${def.params.map(q => q.id).join(', ')}`);
      let v = raw;
      if (p.type === 'range' || p.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) throw new Error(`${def.name} › ${key} must be a number`);
        const max = p.max === 'lastFrame' ? frameCountAt(k - 1) - 1 : p.max;
        if (typeof p.min === 'number' && v < p.min) { warnings.push(`${key} raised to its minimum ${p.min}`); v = p.min; }
        if (typeof max === 'number' && v > max) { warnings.push(`${key} lowered to its maximum ${max}`); v = max; }
      } else if (p.type === 'select') {
        const o = p.options.find(o => String(o.value) === String(v)) || p.options.find(o => String(o.label).toLowerCase() === String(v).toLowerCase());
        if (!o) throw new Error(`${def.name} › ${key} must be one of: ${p.options.map(o => o.value).join(', ')}`);
        v = o.value;
      } else if (p.type === 'bool') v = v === true || v === 'true' || v === 1;
      else if (p.type === 'color') { if (!/^#[0-9a-f]{6}$/i.test(String(v))) throw new Error(`${def.name} › ${key} must be a colour like #ff8800`); }
      else if (p.type === 'text') v = String(v);
      else if (p.type === 'points') {
        if (!Array.isArray(v)) throw new Error(`${def.name} › ${key} must be an array of {x, y} points`);
        v = v.map(q => ({ x: Number(q.x), y: Number(q.y) }));
        if (v.some(q => !Number.isFinite(q.x) || !Number.isFinite(q.y))) throw new Error(`${def.name} › ${key}: every point needs numeric x and y`);
        const need = p.count, mn = p.min ?? need, mx = p.max ?? need;
        if (mn != null && v.length < mn) throw new Error(`${def.name} › ${key} needs at least ${mn} points`);
        if (mx != null && v.length > mx) throw new Error(`${def.name} › ${key} takes at most ${mx} points`);
      } else if (p.type === 'rect') {
        v = { x: Number(v && v.x), y: Number(v && v.y), w: Number(v && v.w), h: Number(v && v.h) };
        if (Object.values(v).some(n => !Number.isFinite(n)) || v.w <= 0 || v.h <= 0) throw new Error(`${def.name} › ${key} must be {x, y, w, h} with positive w and h`);
      }
      out[key] = v;
    }
    return { params: out, warnings };
  }

  const describeStep = (st, i) => {
    const def = AD.filters.get(st.filterId), stats = S.stepStats.get(st.uid) || {};
    const inSize = outputSize(i - 1);
    return { step: i + 1, filter: st.filterId, name: def ? def.name : st.filterId, enabled: st.enabled, params: st.params,
      inputSize: `${inSize.width}x${inSize.height}`, ...(stats.error ? { error: stats.error } : {}), ...(stats.readout ? { readout: stats.readout } : {}) };
  };

  // Simple, objective numbers about an image, so an AI can check the effect of a change without seeing it.
  function imageStats(img) {
    const d = img.data, n = img.width * img.height, step = Math.max(1, Math.floor(n / 200000));
    let s = 0, s2 = 0, lo = 0, hi = 0, grad = 0, m = 0;
    for (let j = 0; j < n; j += step) {
      const i = j * 4, y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      s += y; s2 += y * y; m++;
      if (y <= 2) lo++; if (y >= 253) hi++;
      if (j + 1 < n && (j + 1) % img.width) { const k2 = i + 4; grad += Math.abs(y - (0.299 * d[k2] + 0.587 * d[k2 + 1] + 0.114 * d[k2 + 2])); }
    }
    const mean = s / m;
    return { size: `${img.width}x${img.height}`, meanBrightness: +mean.toFixed(1), contrast: +Math.sqrt(Math.max(0, s2 / m - mean * mean)).toFixed(1),
      clippedBlack: `${(lo / m * 100).toFixed(2)}%`, clippedWhite: `${(hi / m * 100).toFixed(2)}%`, edgeStrength: +(grad / m).toFixed(2) };
  }

  const undoStack = [];
  AD.api = {
    state() {
      const k = displayK();
      return {
        source: S.source ? { name: S.source.name, kind: S.source.kind, size: `${S.source.width}x${S.source.height}`, frames: S.source.frameCount, fps: S.source.fps, userFile: !S.source.sample } : null,
        frame: S.frame + 1, frameCount: frameCountAt(S.chain.length - 1), showing: S.show, compare: S.compare,
        selectedStep: selIndex() >= 0 ? selIndex() + 1 : null,
        chain: S.chain.map(describeStep),
        resultSize: (({ width, height }) => `${width}x${height}`)(outputSize(S.chain.length - 1)),
        viewer: displayLabel(k),
      };
    },
    // One line per filter: id, name, category, parameters with types/ranges/options, actions.
    catalog() {
      const lines = [];
      for (const cat of AD.CATEGORIES) for (const d of [...AD.filters.values()].filter(x => x.category === cat)) {
        const ps = d.params.map(p => {
          if (p.type === 'range' || p.type === 'number') return `${p.id} ${p.min ?? ''}..${p.max === 'lastFrame' ? 'lastFrame' : (p.max ?? '')}${p.unit ? ' ' + p.unit : ''}`;
          if (p.type === 'select') return `${p.id} [${p.options.map(o => o.value).join('|')}]`;
          if (p.type === 'points') return `${p.id} points(${p.count ?? `${p.min ?? 0}-${p.max ?? '∞'}`}${p.labels ? ' ' + p.labels.join(',') : ''}${p.space === 'output' ? ', on output' : ''})`;
          return `${p.id} ${p.type}`;
        });
        lines.push(`${d.id} — ${d.name} (${cat}): ${d.description || ''} | params: ${ps.join('; ') || 'none'}${d.actions.length ? ` | actions: ${d.actions.map(a => a.id).join(', ')}` : ''}`);
      }
      return lines.join('\n');
    },
    samples: () => AD.samples.map(s => ({ id: s.id, name: s.name, kind: s.category })),

    snapshot: () => ({ chain: JSON.parse(JSON.stringify(S.chain)), sel: S.sel, show: S.show, compare: S.compare, frame: S.frame }),
    restore(snap) {
      S.chain = JSON.parse(JSON.stringify(snap.chain)); S.sel = snap.sel; S.compare = snap.compare; S.frame = snap.frame; S.editParam = null;
      $('compare').setAttribute('aria-pressed', String(S.compare));
      setShow(snap.show); chainChanged(); renderInspector();
    },
    pushUndo(label) { undoStack.push({ label, snap: AD.api.snapshot() }); if (undoStack.length > 30) undoStack.shift(); },
    undo() {
      // skip entries that match the current state (a request that changed nothing)
      const now = JSON.stringify(AD.api.snapshot().chain);
      while (undoStack.length && JSON.stringify(undoStack[undoStack.length - 1].snap.chain) === now) undoStack.pop();
      const u = undoStack.pop();
      if (!u) throw new Error('nothing to undo');
      AD.api.restore(u.snap); log(`Undid: ${u.label}`);
      return u.label;
    },
    canUndo: () => undoStack.length > 0,

    async add(filterId, params = {}, position = null) {
      const def = AD.filters.get(String(filterId));
      if (!def) throw new Error(`unknown filter "${filterId}"`);
      const at = position == null ? S.chain.length : Math.max(0, Math.min(S.chain.length, Number(position) - 1));
      const dims = outputSize(at - 1), info = { frameCount: frameCountAt(at - 1), fps: S.source ? S.source.fps : 25 };
      const { params: p, warnings } = coerceParams(def, params, at);
      const step = { uid: uid(), filterId: def.id, enabled: true, params: { ...AD.defaultParams(def, dims, info), ...p } };
      S.chain.splice(at, 0, step); S.sel = step.uid;
      log(`Assistant added ${def.name} as step ${at + 1}`);
      chainChanged(); renderInspector();
      return { step: at + 1, filter: def.id, params: step.params, ...(warnings.length ? { warnings } : {}) };
    },
    set(ref, params) {
      const st = stepRef(ref), k = S.chain.indexOf(st), def = AD.filters.get(st.filterId);
      const { params: p, warnings } = coerceParams(def, params, k);
      st.params = { ...st.params, ...p };
      log(`Assistant set ${def.name} › ${Object.entries(p).map(([a, b]) => `${a} = ${fmtValue(b)}`).join(', ')}`);
      chainChanged(); if (S.sel === st.uid) renderInspector();
      return { step: k + 1, params: st.params, ...(warnings.length ? { warnings } : {}) };
    },
    remove(ref) { const st = stepRef(ref), k = S.chain.indexOf(st); removeStep(st.uid); return { removed: k + 1 }; },
    move(ref, to) {
      const st = stepRef(ref), from = S.chain.indexOf(st), j = Math.max(0, Math.min(S.chain.length - 1, Number(to) - 1));
      S.chain.splice(from, 1); S.chain.splice(j, 0, st); chainChanged();
      return { moved: from + 1, to: j + 1 };
    },
    enable(ref, on) { const st = stepRef(ref); st.enabled = !!on; chainChanged(); return { step: S.chain.indexOf(st) + 1, enabled: st.enabled }; },
    clear() { const n = S.chain.length; S.chain = []; S.sel = null; S.editParam = null; chainChanged(); renderInspector(); return { removed: n }; },
    select(ref) { const st = stepRef(ref); selectStep(st.uid); return { selected: S.chain.indexOf(st) + 1 }; },
    show(mode) { if (!['result', 'step', 'original'].includes(mode)) throw new Error('show must be result, step or original'); setShow(mode); return { showing: mode }; },
    compare(on) { S.compare = !!on; $('compare').setAttribute('aria-pressed', String(S.compare)); requestRender(); return { compare: S.compare }; },
    frame(n) { const c = frameCountAt(displayK()); gotoFrame(Math.max(1, Math.min(c, Math.round(Number(n)))) - 1); return { frame: S.frame + 1, of: c }; },
    async action(ref, actionId) {
      const st = stepRef(ref), def = AD.filters.get(st.filterId), a = def.actions.find(x => x.id === actionId);
      if (!a) throw new Error(`${def.name} has no action "${actionId}"${def.actions.length ? `; available: ${def.actions.map(x => x.id).join(', ')}` : ''}`);
      const patch = await backend.action(st.uid, a.id, S.frame);
      st.params = { ...st.params, ...patch }; chainChanged(); renderInspector();
      log(`Assistant ran ${def.name} › ${a.label}`);
      return { step: S.chain.indexOf(st) + 1, changed: patch };
    },
    async loadSample(id) {
      const s = AD.samples.find(x => x.id === id);
      if (!s) throw new Error(`unknown sample "${id}"; available: ${AD.samples.map(x => x.id).join(', ')}`);
      await loadSample(s); return { loaded: s.name };
    },
    // Render the result (or step k) at full resolution and summarise it.
    async inspect(ref = null) {
      if (!S.source) throw new Error('no image is open');
      const k = ref == null ? S.chain.length - 1 : S.chain.indexOf(stepRef(ref));
      const r = await backend.render(k, Math.min(S.frame, frameCountAt(k) - 1), 1, 'assistant');
      if (!r) throw new Error('render was cancelled');
      for (const st of r.steps || []) S.stepStats.set(st.uid, st);
      renderChainStats();
      const errors = (r.steps || []).filter(x => x.error).map(x => `step ${S.chain.findIndex(c => c.uid === x.uid) + 1}: ${x.error}`);
      return { of: k < 0 ? 'original' : `step ${k + 1}`, ...imageStats(r.image), ...(r.readout ? { readout: r.readout } : {}), ...(errors.length ? { errors } : {}) };
    },
    // JPEG of what a new filter added at the end would receive (the current result), longest side <= maxSide.
    async snapshotImage(maxSide = 1024) {
      if (!S.source) return null;
      const k = S.chain.length - 1, r = await backend.render(k, Math.min(S.frame, frameCountAt(k) - 1), 1, 'assistant');
      if (!r) return null;
      const s = Math.min(1, maxSide / Math.max(r.image.width, r.image.height));
      const full = el('canvas', { width: r.image.width, height: r.image.height }); full.getContext('2d').putImageData(r.image, 0, 0);
      const c = el('canvas', { width: Math.max(1, Math.round(r.image.width * s)), height: Math.max(1, Math.round(r.image.height * s)) });
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(full, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
      return { blob, width: r.image.width, height: r.image.height, sentWidth: c.width, sentHeight: c.height, scale: s };
    },
    async save(kind) {
      const si = selIndex();
      if (kind === 'frame') await saveFrame(S.chain.length - 1, 'result');
      else if (kind === 'step') await saveFrame(si >= 0 ? si : S.chain.length - 1, si >= 0 ? (AD.filters.get(S.chain[si].filterId) || {}).name : 'result');
      else if (kind === 'frames') await saveZip();
      else if (kind === 'video') await saveVideo();
      else if (kind === 'project') await saveFile(fileName('json').replace(/\.json$/, '_project.json'), projectJSON());
      else if (kind === 'report') await saveReport();
      else throw new Error('save kind must be frame, step, frames, video, project or report');
      return { offered: kind };
    },
    log,
  };

  // ---------------------------------------------------------------- wiring
  AD.start = async function start() {
    readColors();
    try { backend = new WorkerBackend(); const info = await Promise.race([backend.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('worker did not start')), 8000))]); log(`Engine worker ready · ${info.filters.length} filters · ${info.pool} strip workers · GPU ${info.gpu ? 'on' : 'off'}`); }
    catch (e) { backend = new LocalBackend(); log(`Running filters on the page thread (${e.message})`, 'w'); }
    AD.backend = backend;

    renderFilterList(); renderSamples(); renderChain(); renderInspector(); updatePlayer(1);
    AD.onRegistryChange(() => { renderFilterList(); renderSamples(); });

    $('filter-search').addEventListener('input', renderFilterList);
    $('open-image').addEventListener('change', e => { closeMenus(); openFiles(e.target.files); e.target.value = ''; });
    $('open-seq').addEventListener('change', e => { closeMenus(); openFiles(e.target.files); e.target.value = ''; });
    $('open-video').addEventListener('change', e => { closeMenus(); openFiles(e.target.files); e.target.value = ''; });
    $('open-project').addEventListener('change', e => { closeMenus(); if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; });
    document.querySelector('#menu-file .drop').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      closeMenus();
      const act = b.dataset.act, si = selIndex();
      if (act === 'quicksave') saveFrame(si >= 0 ? si : S.chain.length - 1, si >= 0 ? (AD.filters.get(S.chain[si].filterId) || {}).name : 'result');
      else if (act === 'save-frame') saveFrame(S.chain.length - 1, 'result');
      else if (act === 'save-zip') saveZip();
      else if (act === 'save-video') saveVideo();
      else if (act === 'save-project') saveFile(fileName('json').replace(/\.json$/, '_project.json'), projectJSON());
      else if (act === 'save-report') saveReport();
      else if (act === 'options') openOptions();
    });
    const closeMenus = () => document.querySelectorAll('details.menu').forEach(d => { d.open = false; });
    document.addEventListener('click', e => { if (!e.target.closest('details.menu')) closeMenus(); });
    $('opt-close').addEventListener('click', () => { saveOptions(); $('options').close(); });
    $('options').addEventListener('close', saveOptions);

    for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
    for (const b of document.querySelectorAll('[data-show]')) b.addEventListener('click', () => setShow(b.dataset.show));
    $('compare').addEventListener('click', () => { S.compare = !S.compare; $('compare').setAttribute('aria-pressed', String(S.compare)); requestRender(); });
    $('overlay-toggle').addEventListener('click', () => { S.overlays = !S.overlays; $('overlay-toggle').setAttribute('aria-pressed', String(S.overlays)); draw(); });
    $('fit-image').addEventListener('click', () => { fit(); draw(); });
    $('zoom-1').addEventListener('click', () => { V.zoom = 1 / (window.devicePixelRatio || 1); updateZoomLabel(); draw(); });
    $('zoom-in').addEventListener('click', () => zoomAt(1.25));
    $('zoom-out').addEventListener('click', () => zoomAt(0.8));

    const vp = $('viewport');
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    vp.addEventListener('dblclick', onDblClick);
    vp.addEventListener('contextmenu', e => { if (S.tool === 'zoom') e.preventDefault(); });
    vp.addEventListener('wheel', e => { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    vp.addEventListener('dragover', e => { e.preventDefault(); });
    vp.addEventListener('drop', e => { e.preventDefault(); openFiles(e.dataTransfer.files); });
    new ResizeObserver(() => { if (V.fitNext) fit(); draw(); }).observe(vp);

    $('first').addEventListener('click', () => gotoFrame(S.inMark ?? 0));
    $('last').addEventListener('click', () => gotoFrame(S.outMark ?? frameCountAt(displayK()) - 1));
    $('prev').addEventListener('click', () => gotoFrame(S.frame - 1));
    $('next').addEventListener('click', () => gotoFrame(S.frame + 1));
    $('play').addEventListener('click', play);
    $('seek').addEventListener('input', e => gotoFrame(parseInt(e.target.value, 10), true));
    $('mark-in').addEventListener('click', () => { S.inMark = S.frame; log(`In point: frame ${S.frame + 1}`); updatePlayer(); });
    $('mark-out').addEventListener('click', () => { S.outMark = S.frame; log(`Out point: frame ${S.frame + 1}`); updatePlayer(); });
    $('fps').addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!S.source || !(v > 0)) return;
      S.source.fps = v;
      if (S.source.kind === 'video' && S.source.duration) S.source.frameCount = Math.max(1, Math.round(S.source.duration * v));
      backend.setSource({ id: S.source.id, frameCount: S.source.frameCount, fps: v, width: S.source.width, height: S.source.height, name: S.source.name });
      syncChain(); updateSourceInfo(); log(`Frame rate set to ${v} fps`); requestRender();
    });

    document.addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea, dialog')) return;
      if (e.key === 'ArrowRight') { gotoFrame(S.frame + (e.shiftKey ? 10 : 1)); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { gotoFrame(S.frame - (e.shiftKey ? 10 : 1)); e.preventDefault(); }
      else if (e.key === ' ' && S.source && S.source.frameCount > 1) { play(); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-') zoomAt(0.8);
      else if (e.key === '0') { fit(); draw(); }
    });

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const retheme = () => { readColors(); draw(); };
    mq.addEventListener('change', retheme);
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Open on a working example rather than an empty viewer.
    const first = AD.samples.find(s => s.id === 'plate') || AD.samples[0];
    if (first) await loadSample(first);
  };

  // Test hooks (used by test/smoke.mjs).
  AD.debug = { S, V, frameCountAt, selectStep, clearChain: () => { S.chain = []; S.sel = null; S.editParam = null; chainChanged(); renderInspector(); }, setParam: (u, id, v) => setParam(S.chain[stepIndex(u)], id, v), removeStep, renderNow, displayK, setShow, makeZip, projectJSON };
})(window);
