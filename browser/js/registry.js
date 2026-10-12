// Filter and sample registry. Loaded on the main thread, in the engine worker, in pool workers and in Node tests.
(function (root) {
  const AD = root.AD = root.AD || {};

  AD.CATEGORIES = ['Select Frames', 'Interlace', 'Edit', 'Channels', 'Adjust', 'Sharpen', 'Denoise', 'Deblurring',
    'Stabilization', 'Integrate', 'Extract', 'Verify', 'Measure', 'Presentation'];

  const filters = AD.filters = AD.filters || new Map();
  const samples = AD.samples = AD.samples || [];
  const listeners = [];
  AD.onRegistryChange = fn => listeners.push(fn);
  const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* UI refresh only */ } });

  AD.registerFilter = def => {
    const problems = [];
    if (!def || typeof def.id !== 'string' || !/^[a-z0-9-]+$/.test(def.id)) problems.push('id must be kebab-case');
    if (!def.name) problems.push('name is required');
    if (!AD.CATEGORIES.includes(def.category)) problems.push(`category "${def.category}" is not one of AD.CATEGORIES`);
    if (typeof def.apply !== 'function') problems.push('apply() is required');
    if (problems.length) throw new Error(`registerFilter(${def && def.id}): ${problems.join('; ')}`);
    if (filters.has(def.id)) throw new Error(`registerFilter: duplicate id "${def.id}"`);
    def.params = def.params || [];
    def.actions = def.actions || [];
    for (const p of def.params) if (!p.id || !p.type) throw new Error(`registerFilter(${def.id}): every param needs id and type`);
    filters.set(def.id, def);
    changed();
    return def;
  };

  AD.registerSample = s => {
    if (!s || !s.id || !s.name || typeof s.make !== 'function') throw new Error('registerSample: id, name and make() are required');
    if (samples.some(x => x.id === s.id)) throw new Error(`registerSample: duplicate id "${s.id}"`);
    samples.push(s);
    changed();
    return s;
  };

  // Evaluate parameter defaults for a filter given its input size.
  AD.defaultParams = (def, input, info = { frameCount: 1, fps: 25 }) => {
    const out = {};
    for (const p of def.params) {
      const d = p.default;
      out[p.id] = typeof d === 'function' ? d(input, info) : (d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : d);
      if (out[p.id] === undefined) {
        if (p.type === 'range' || p.type === 'number') out[p.id] = p.min !== undefined && typeof p.min === 'number' ? p.min : 0;
        else if (p.type === 'bool') out[p.id] = false;
        else if (p.type === 'select') out[p.id] = p.options && p.options.length ? p.options[0].value : null;
        else if (p.type === 'text') out[p.id] = '';
        else if (p.type === 'color') out[p.id] = '#ff0000';
        else out[p.id] = null;
      }
    }
    return out;
  };

  // Scale pixel-unit parameters for preview rendering (see FILTER_API.md, "Preview scale").
  AD.scaleParams = (def, params, s) => {
    if (s === 1) return params;
    const out = { ...params };
    for (const p of def.params) {
      const v = params[p.id];
      if (v == null) continue;
      if ((p.type === 'range' || p.type === 'number') && p.unit === 'px') out[p.id] = v * s;
      else if (p.type === 'points' && Array.isArray(v)) out[p.id] = v.map(q => ({ ...q, x: q.x * s, y: q.y * s }));
      else if (p.type === 'rect' && typeof v === 'object') out[p.id] = { x: v.x * s, y: v.y * s, w: v.w * s, h: v.h * s };
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
