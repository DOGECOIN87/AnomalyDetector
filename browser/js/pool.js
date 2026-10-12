// Strip worker pool. In the engine worker, AD.StripPool spawns N copies of this same file; inside a pool
// worker (named 'strip') it loads the filters and runs apply() on the strips it is sent.
/* global importScripts */
(function (root) {
  const AD = root.AD = root.AD || {};
  const isStripWorker = typeof WorkerGlobalScope !== 'undefined' && root.name === 'strip';

  if (isStripWorker) {
    // A strip worker is started on this file directly (the engine worker importScripts it for StripPool).
    importScripts('lib/img.js', 'lib/fft.js', 'lib/geom.js', 'registry.js');
    root.onmessage = async ev => {
      const m = ev.data;
      if (m.type === 'init') {
        for (const f of m.files) { try { importScripts(f); } catch (e) { /* reported by the engine worker */ } }
        root.postMessage({ type: 'ready' });
        return;
      }
      if (m.type === 'run') {
        try {
          const def = AD.filters.get(m.filterId);
          const input = new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height);
          const ctx = {
            ...m.info,
            input: () => Promise.reject(new Error('strip workers cannot read other frames')),
            original: () => Promise.reject(new Error('strip workers cannot read other frames')),
            memo: (key, fn) => Promise.resolve().then(fn),
            checkpoint: () => Promise.resolve(),
            progress: () => {}, log: () => {},
          };
          let out = await def.apply(input, m.params, ctx);
          if (out && !(out instanceof ImageData)) out = out.image;
          root.postMessage({ type: 'done', id: m.id, buffer: out.data.buffer, width: out.width, height: out.height }, [out.data.buffer]);
        } catch (e) {
          root.postMessage({ type: 'error', id: m.id, message: (e && e.message) || String(e) });
        }
      }
    };
    return;
  }

  class StripPool {
    constructor(size, files) {
      this.workers = [];
      this.queue = [];
      this.waiting = new Map();
      this.seq = 0;
      for (let i = 0; i < size; i++) {
        const w = new Worker('pool.js', { name: 'strip' });
        w.busy = false;
        w.onmessage = ev => this.onMessage(w, ev.data);
        w.onerror = () => { w.dead = true; };
        w.postMessage({ type: 'init', files });
        this.workers.push(w);
      }
    }
    get size() { return this.workers.filter(w => !w.dead).length; }

    run(filterId, image, params, info) {
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.waiting.set(id, { resolve, reject });
        this.queue.push({ id, filterId, image, params, info });
        this.pump();
      });
    }

    pump() {
      for (const w of this.workers) {
        if (w.busy || w.dead || !this.queue.length) continue;
        const job = this.queue.shift();
        w.busy = true;
        const buf = job.image.data.buffer;
        w.postMessage({ type: 'run', id: job.id, filterId: job.filterId, buffer: buf, width: job.image.width, height: job.image.height, params: job.params, info: job.info }, [buf]);
      }
    }

    onMessage(w, m) {
      if (m.type === 'ready') return;
      w.busy = false;
      const job = this.waiting.get(m.id); this.waiting.delete(m.id);
      if (job) {
        if (m.type === 'done') job.resolve(new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height));
        else job.reject(new Error(m.message));
      }
      this.pump();
    }
  }
  AD.StripPool = StripPool;
})(typeof self !== 'undefined' ? self : globalThis);
