// Chain evaluation engine. Runs in the engine worker (normally) or on the main thread (fallback, tests).
// Owns the per-step frame cache, memoisation, cancellation, preview scaling, strip parallelism and GPU selection.
(function (root) {
  const AD = root.AD = root.AD || {};

  class CancelError extends Error { constructor() { super('Cancelled'); this.name = 'CancelError'; } }
  AD.CancelError = CancelError;

  // Short stable hash for cache keys (two 32-bit FNV-style lanes).
  const hash = s => {
    let a = 0x811c9dc5, b = 0x9747b28c;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822507); }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  };
  AD.hash = hash;

  // Yield to the event loop quickly (setTimeout is clamped to 4 ms after nesting).
  const yieldNow = (() => {
    if (typeof MessageChannel === 'undefined') return () => new Promise(r => setTimeout(r, 0));
    const ch = new MessageChannel(), q = [];
    ch.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
    if (ch.port1.unref) ch.port1.unref();
    return () => new Promise(r => { q.push(r); ch.port2.postMessage(0); });
  })();
  AD.yieldNow = yieldNow;

  class LRU {
    constructor(budgetBytes) { this.budget = budgetBytes; this.map = new Map(); this.bytes = 0; }
    get(k) { const e = this.map.get(k); if (!e) return undefined; this.map.delete(k); this.map.set(k, e); return e.v; }
    set(k, v, bytes) {
      if (this.map.has(k)) { this.bytes -= this.map.get(k).b; this.map.delete(k); }
      this.map.set(k, { v, b: bytes }); this.bytes += bytes;
      for (const [key, e] of this.map) { if (this.bytes <= this.budget || this.map.size <= 1) break; this.map.delete(key); this.bytes -= e.b; }
    }
    clear() { this.map.clear(); this.bytes = 0; }
  }

  const bytesOf = r => (r && r.image ? r.image.data.length : 0) + 256;

  class Engine {
    // fetchFrame(index, scale) -> Promise<ImageData>; pool: optional strip pool with .size and .run(...)
    constructor({ fetchFrame, pool = null, onProgress = () => {}, onLog = () => {}, cacheMB = 512 } = {}) {
      this.fetchFrame = fetchFrame;
      this.pool = pool;
      this.onProgress = onProgress;
      this.onLog = onLog;
      this.cache = new LRU(cacheMB * 1024 * 1024);
      this.memoStore = new Map();
      this.inflight = new Map();
      this.stats = new Map();      // uid -> { ms, error, readout }
      this.loggedErrors = new Set();
      this.gpuFailed = new Set();
      this.pathTimes = new Map();  // filter id -> { gpu, cpu } ms per megapixel
      this.source = null;
      this.chain = [];
      this.sigs = [];
    }

    setCacheBudget(mb) { this.cache.budget = mb * 1024 * 1024; }

    setSource(meta) {
      this.source = meta;
      this.cache.clear(); this.memoStore.clear(); this.stats.clear(); this.loggedErrors.clear();
      this.recompute();
    }

    setChain(chain) {
      this.chain = chain.map(s => ({ uid: s.uid, filterId: s.filterId, enabled: s.enabled !== false, params: s.params || {} }));
      this.recompute();
    }

    recompute() {
      const src = this.source ? `${this.source.id}:${this.source.frameCount}:${this.source.fps}` : 'none';
      let prev = hash(src);
      this.sigs = this.chain.map(s => (prev = hash(prev + '|' + (s.enabled ? s.filterId + JSON.stringify(s.params) : '-'))));
      this.srcSig = hash(src);
    }

    frameCountAt(k) {
      let n = this.source ? this.source.frameCount : 1;
      for (let i = 0; i <= k && i < this.chain.length; i++) {
        const s = this.chain[i], def = AD.filters.get(s.filterId);
        if (s.enabled && def && def.frameCount) n = Math.max(1, Math.floor(def.frameCount(n, s.params)) || 1);
      }
      return n;
    }

    sigAt(k) { return k < 0 ? this.srcSig : this.sigs[k]; }

    // Public: evaluate the output of step k (k = -1 is the source) at frame f and preview scale s.
    async render(k, f, s, token) {
      const res = await this.evalStep(k, f, s, token);
      const steps = this.chain.slice(0, k + 1).map(st => ({ uid: st.uid, ...(this.stats.get(st.uid) || {}) }));
      return { ...res, steps, frameCount: this.frameCountAt(k) };
    }

    async evalStep(k, f, s, token) {
      // A shared in-flight evaluation may be cancelled by another render; retry it for this one.
      for (let attempt = 0; ; attempt++) {
        try { return await this.evalOnce(k, f, s, token); }
        catch (e) { if (e instanceof CancelError && !token.cancelled && attempt < 8) continue; throw e; }
      }
    }

    async evalOnce(k, f, s, token) {
      if (token.cancelled) throw new CancelError();
      const count = this.frameCountAt(k);
      f = Math.max(0, Math.min(count - 1, f | 0));
      if (k < 0) {
        const key = `${this.srcSig}@${s}#${f}`;
        const hit = this.cache.get(key); if (hit) return hit;
        return this.dedupe(key, async () => {
          const image = await this.fetchFrame(f, s);
          const r = { image };
          this.cache.set(key, r, bytesOf(r));
          return r;
        });
      }
      const step = this.chain[k];
      if (!step.enabled) { const prev = await this.evalStep(k - 1, f, s, token); return { image: prev.image }; }
      const key = `${this.sigs[k]}@${s}#${f}`;
      const hit = this.cache.get(key); if (hit) return hit;
      return this.dedupe(key, () => this.runStep(k, f, s, token, key));
    }

    async dedupe(key, fn) {
      if (this.inflight.has(key)) return this.inflight.get(key);
      const p = fn();
      this.inflight.set(key, p);
      try { return await p; } finally { this.inflight.delete(key); }
    }

    makeCtx(k, f, s, token, label) {
      const eng = this, inCount = this.frameCountAt(k - 1);
      let lastYield = Date.now();
      return {
        frameIndex: f, frameCount: this.frameCountAt(k), inputFrameCount: inCount,
        fps: this.source ? this.source.fps : 25, scale: s, stepIndex: k,
        input: i => eng.evalStep(k - 1, Math.max(0, Math.min(inCount - 1, i | 0)), s, token).then(r => r.image),
        original: i => eng.evalStep(-1, i, s, token).then(r => r.image),
        memo: (key, fn) => eng.memo(`${eng.sigs[k]}@${s}`, key, fn, token),
        checkpoint: async () => {
          if (Date.now() - lastYield < 12) { if (token.cancelled) throw new CancelError(); return; }
          await yieldNow(); lastYield = Date.now();
          if (token.cancelled) throw new CancelError();
        },
        progress: (fraction, text) => eng.onProgress(fraction, text || label),
        log: (msg, level) => eng.onLog(`${label}: ${msg}`, level),
      };
    }

    memo(scope, key, fn, token) {
      let m = this.memoStore.get(scope);
      if (!m) {
        m = new Map(); this.memoStore.set(scope, m);
        if (this.memoStore.size > 64) this.memoStore.delete(this.memoStore.keys().next().value);
      }
      if (!m.has(key)) {
        const p = Promise.resolve().then(fn);
        m.set(key, p);
        p.catch(() => { if (m.get(key) === p) m.delete(key); });
      }
      return m.get(key);
    }

    async runStep(k, f, s, token, key) {
      const step = this.chain[k], def = AD.filters.get(step.filterId);
      const label = def ? def.name : step.filterId;
      if (!def) return this.fail(step, `Unknown filter "${step.filterId}"`, (await this.evalStep(k - 1, f, s, token)).image);
      const params = AD.scaleParams(def, step.params, s);
      const ctx = this.makeCtx(k, f, s, token, label);
      // Frame-count-changing filters map their own frames, so don't pre-fetch input at f for them.
      const input = def.frameCount ? null : await ctx.input(f);
      const t0 = Date.now();
      let out;
      try {
        out = await this.invoke(def, input, params, ctx);
      } catch (e) {
        if (e instanceof CancelError) throw e;
        const fallback = input || (await ctx.input(Math.min(f, ctx.inputFrameCount - 1)));
        return this.fail(step, (e && e.message) || String(e), fallback);
      }
      const r = out instanceof ImageData ? { image: out } : out;
      if (!r || !(r.image instanceof ImageData)) {
        return this.fail(step, 'Filter returned no image', input || (await ctx.input(f)));
      }
      this.stats.set(step.uid, { ms: Date.now() - t0, error: null, readout: r.readout || null, w: Math.round(r.image.width / s), h: Math.round(r.image.height / s) });
      this.loggedErrors.delete(step.uid);
      this.cache.set(key, r, bytesOf(r));
      return r;
    }

    fail(step, message, image) {
      this.stats.set(step.uid, { ms: 0, error: message, readout: null });
      if (!this.loggedErrors.has(step.uid + message)) { this.loggedErrors.add(step.uid + message); this.onLog(`${step.filterId}: ${message}`, 'e'); }
      return { image, error: message };
    }

    // GPU or CPU? Each path is timed (ms per megapixel) the first time it runs on a decent-sized image, and the
    // faster one is used from then on. Software WebGL (no GPU) is often slower than the CPU workers.
    async invoke(def, input, params, ctx) {
      const mp = input ? input.width * input.height / 1e6 : 0;
      const t = this.pathTimes.get(def.id) || {};
      const gpuOk = def.gpu && !this.gpuFailed.has(def.id) && AD.gpu && AD.gpu.available;
      const useGpu = gpuOk && (t.gpu == null || t.cpu == null ? t.gpu == null : t.gpu <= t.cpu);
      if (useGpu) {
        try {
          const t0 = Date.now(), r = await def.gpu(input, params, ctx);
          if (mp > 0.05) this.pathTimes.set(def.id, { ...t, gpu: (Date.now() - t0) / mp });
          return r;
        } catch (e) {
          if (e instanceof CancelError) throw e;
          this.gpuFailed.add(def.id);
          this.onLog(`${def.name}: GPU path failed (${e.message}); using CPU`, 'w');
        }
      }
      const t0 = Date.now();
      let r;
      if (def.margin && input && this.pool && this.pool.size > 1 && input.width * input.height >= 200000) {
        const m = Math.ceil(def.margin(params, ctx));
        if (Number.isFinite(m) && m >= 0) r = await this.runStrips(def, input, params, ctx, m);
      }
      if (r === undefined) r = await def.apply(input, params, ctx);
      if (gpuOk && mp > 0.05) this.pathTimes.set(def.id, { ...(this.pathTimes.get(def.id) || {}), cpu: (Date.now() - t0) / mp });
      return r;
    }

    // Split rows into strips with `m` rows of overlap, run them on the pool, stitch the centres back.
    async runStrips(def, input, params, ctx, m) {
      const { width: w, height: h } = input;
      const n = Math.max(1, Math.min(this.pool.size, Math.floor(h / Math.max(16, 2 * m + 16))));
      if (n < 2) return def.apply(input, params, ctx);
      const per = Math.ceil(h / n), row = w * 4, jobs = [];
      for (let i = 0; i < n; i++) {
        const y0 = i * per, y1 = Math.min(h, y0 + per);
        if (y0 >= y1) break;
        const a = Math.max(0, y0 - m), b = Math.min(h, y1 + m);
        const strip = new ImageData(input.data.slice(a * row, b * row), w, b - a);
        const info = { frameIndex: ctx.frameIndex, frameCount: ctx.frameCount, inputFrameCount: ctx.inputFrameCount, fps: ctx.fps, scale: ctx.scale, strip: { top: a, fullHeight: h } };
        jobs.push(this.pool.run(def.id, strip, params, info).then(out => ({ out, y0, y1, a })));
      }
      const parts = await Promise.all(jobs);
      await ctx.checkpoint();
      const out = new ImageData(w, h);
      for (const { out: o, y0, y1, a } of parts) {
        if (!(o instanceof ImageData) || o.width !== w) throw new Error('strip output has the wrong size');
        out.data.set(o.data.subarray((y0 - a) * row, (y1 - a) * row), y0 * row);
      }
      return out;
    }

    async runAction(uid, actionId, f, s, token) {
      const k = this.chain.findIndex(st => st.uid === uid);
      if (k < 0) throw new Error('step not found');
      const step = this.chain[k], def = AD.filters.get(step.filterId);
      const action = def && def.actions.find(a => a.id === actionId);
      if (!action) throw new Error('action not found');
      const ctx = this.makeCtx(k, f, s, token, def.name);
      const input = await ctx.input(f);
      return action.run(input, AD.scaleParams(def, step.params, s), ctx);
    }
  }

  AD.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
