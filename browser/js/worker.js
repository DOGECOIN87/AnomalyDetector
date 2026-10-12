// Engine worker: runs the filter chain off the main thread. Protocol (main <-> worker):
//   main -> { type: 'init', files, poolSize, cacheMB } | { type: 'source', meta } | { type: 'chain', chain }
//           { type: 'render', id, k, frame, scale, lane } | { type: 'cancel', id } | { type: 'action', id, uid, actionId, frame }
//           { type: 'frame', id, buffer, width, height } | { type: 'frameError', id, message } | { type: 'cache', mb }
//   worker -> { type: 'ready', filters } | { type: 'result', id, ... } | { type: 'failed', id, message } | { type: 'cancelled', id }
//             { type: 'needFrame', id, index, scale } | { type: 'progress', fraction, text } | { type: 'log', msg, level }
/* global importScripts */
importScripts('lib/img.js', 'lib/fft.js', 'lib/geom.js', 'lib/gpu.js', 'registry.js', 'engine.js', 'pool.js');

const AD = self.AD;
let engine = null;
const frameWaiters = new Map();
let frameSeq = 0;
const tokens = new Map();      // render id -> token
const laneTokens = new Map();  // lane -> token of its latest render

function fetchFrame(index, scale) {
  const id = ++frameSeq;
  return new Promise((resolve, reject) => {
    frameWaiters.set(id, { resolve, reject });
    self.postMessage({ type: 'needFrame', id, index, scale });
  });
}

function loadFilters(files) {
  const failed = [];
  for (const f of files) {
    try { importScripts(f); } catch (e) { failed.push(`${f}: ${e.message}`); }
  }
  return failed;
}

self.onmessage = async ev => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      const failed = loadFilters(m.files);
      let pool = null;
      try { pool = m.poolSize > 1 ? new AD.StripPool(m.poolSize, m.files) : null; } catch (e) { pool = null; }
      engine = new AD.Engine({
        fetchFrame, pool, cacheMB: m.cacheMB,
        onProgress: (fraction, text) => self.postMessage({ type: 'progress', fraction, text }),
        onLog: (msg, level) => self.postMessage({ type: 'log', msg, level }),
      });
      for (const f of failed) self.postMessage({ type: 'log', msg: `Worker could not load ${f}`, level: 'e' });
      self.postMessage({ type: 'ready', filters: [...AD.filters.keys()], gpu: !!(AD.gpu && AD.gpu.available), pool: pool ? pool.size : 0 });
      break;
    }
    case 'cache': engine.setCacheBudget(m.mb); break;
    case 'source': engine.setSource(m.meta); break;
    case 'chain': engine.setChain(m.chain); break;
    case 'frame': {
      const w = frameWaiters.get(m.id); frameWaiters.delete(m.id);
      if (w) w.resolve(new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height));
      break;
    }
    case 'frameError': {
      const w = frameWaiters.get(m.id); frameWaiters.delete(m.id);
      if (w) w.reject(new Error(m.message));
      break;
    }
    case 'cancel': { const t = tokens.get(m.id); if (t) t.cancelled = true; break; }
    case 'render': {
      const token = { cancelled: false };
      if (m.lane) { const prev = laneTokens.get(m.lane); if (prev) prev.cancelled = true; laneTokens.set(m.lane, token); }
      tokens.set(m.id, token);
      try {
        const r = await engine.render(m.k, m.frame, m.scale, token);
        if (token.cancelled) { self.postMessage({ type: 'cancelled', id: m.id }); break; }
        // Copy so the cached ImageData stays usable; transfer the copy.
        const buf = r.image.data.slice().buffer;
        self.postMessage({
          type: 'result', id: m.id, buffer: buf, width: r.image.width, height: r.image.height,
          overlay: r.overlay || null, readout: r.readout || null, error: r.error || null, steps: r.steps, frameCount: r.frameCount,
        }, [buf]);
      } catch (e) {
        if (e instanceof AD.CancelError) self.postMessage({ type: 'cancelled', id: m.id });
        else self.postMessage({ type: 'failed', id: m.id, message: (e && e.message) || String(e) });
      } finally { tokens.delete(m.id); }
      break;
    }
    case 'action': {
      const token = { cancelled: false };
      try {
        const patch = await engine.runAction(m.uid, m.actionId, m.frame, 1, token);
        self.postMessage({ type: 'result', id: m.id, patch: patch || {} });
      } catch (e) {
        self.postMessage({ type: 'failed', id: m.id, message: (e && e.message) || String(e) });
      }
      break;
    }
  }
};
