// Natural-language control. The page asks Claude (the artifact `sample` capability, on the viewer's own account)
// and hands it the app's own functions as tools; Claude decides which to call. Without Claude (a local copy of the
// page) a small command parser handles simple instructions.
(function (root) {
  const AD = root.AD;
  const $ = id => document.getElementById(id);
  const api = () => AD.api;

  const HISTORY_TURNS = 8;
  const turns = [];               // {role, content} — the page keeps the conversation; Claude remembers nothing
  let sample = null, canSeeImages = false, busy = null, snapshotTaken = false;

  // ---------------------------------------------------------------- transcript
  function line(cls, text) {
    const p = document.createElement('p');
    p.className = cls; p.textContent = text;
    $('chat-log').append(p);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    return p;
  }
  const status = t => { $('chat-status').textContent = t; };

  // ---------------------------------------------------------------- confirmation for destructive steps
  function confirmInPage(question) {
    return new Promise(resolve => {
      const box = $('chat-confirm');
      box.hidden = false;
      $('chat-confirm-q').textContent = question;
      const done = ok => { box.hidden = true; $('chat-allow').onclick = $('chat-deny').onclick = null; resolve(ok); };
      $('chat-allow').onclick = () => done(true);
      $('chat-deny').onclick = () => done(false);
    });
  }

  // Take one undo snapshot per request, just before its first change.
  function beforeChange(label) {
    if (snapshotTaken) return;
    api().pushUndo(label); snapshotTaken = true;
    $('chat-undo').disabled = false;
  }

  // ---------------------------------------------------------------- tools offered to Claude
  const STEP = { description: 'Step number in the History list (1 = top, applied first).', type: 'integer', minimum: 1 };
  function makeTools(label) {
    const mutate = fn => async (input, ctx) => { if (ctx && ctx.signal && ctx.signal.aborted) throw new Error('stopped'); beforeChange(label); return fn(input); };
    return [
      {
        name: 'edit_chain',
        description: 'Change the processing chain with a list of operations applied in order: add a filter (optionally at a position, with params), set params of a step, remove, move, enable/disable, select, or clear all. Step numbers refer to the chain as it is when that operation runs. Returns what each operation did and the resulting chain.',
        inputSchema: {
          type: 'object',
          properties: {
            ops: {
              type: 'array', minItems: 1,
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['add', 'set', 'remove', 'move', 'enable', 'disable', 'select', 'clear'] },
                  filter: { type: 'string', description: 'Filter id from the catalog (for add).' },
                  step: STEP,
                  position: { type: 'integer', minimum: 1, description: 'add: insert as this step number (default: at the end). move: new step number.' },
                  params: { type: 'object', description: 'Parameter values by parameter id (for add or set). Points are [{x,y}] and rects {x,y,w,h} in pixels of that step\'s input image.' },
                },
                required: ['op'],
              },
            },
          },
          required: ['ops'],
        },
        execute: mutate(async ({ ops }) => {
          if (!Array.isArray(ops) || !ops.length) throw new Error('ops must be a non-empty array');
          const done = [];
          for (const [i, o] of ops.entries()) {
            try {
              let r;
              if (o.op === 'add') r = await api().add(o.filter, o.params || {}, o.position ?? null);
              else if (o.op === 'set') r = api().set(o.step, o.params || {});
              else if (o.op === 'remove') r = api().remove(o.step);
              else if (o.op === 'move') r = api().move(o.step, o.position);
              else if (o.op === 'enable' || o.op === 'disable') r = api().enable(o.step, o.op === 'enable');
              else if (o.op === 'select') r = api().select(o.step);
              else if (o.op === 'clear') r = api().clear();
              else throw new Error(`unknown op "${o.op}"`);
              done.push({ op: o.op, ...r });
              line('tool', `› ${describeOp(o, r)}`);
            } catch (e) {
              line('tool err', `› ${o.op} failed: ${e.message}`);
              return { completed: done, failed: { index: i, op: o.op, error: e.message }, chain: api().state().chain.map(brief) };
            }
          }
          return { completed: done, chain: api().state().chain.map(brief) };
        }),
      },
      {
        name: 'run_action',
        description: 'Run a filter\'s built-in action on the current frame, e.g. "auto" (Levels), "estimate" (deblurring: measure the blur; lens distortion: fit k1 from marked lines), "detect" (periodic noise peaks, deblocking grid). Returns the parameter values it set.',
        inputSchema: { type: 'object', properties: { step: STEP, action: { type: 'string' } }, required: ['step', 'action'] },
        execute: mutate(async ({ step, action }) => {
          const r = await api().action(step, String(action));
          line('tool', `› Ran ${action} on step ${r.step}: ${Object.entries(r.changed).map(([k, v]) => `${k} = ${AD.fmtValue(v)}`).join(', ') || 'no change'}`);
          return r;
        }),
      },
      {
        name: 'inspect_result',
        description: 'Render the final result (or a given step) at full resolution and return objective numbers: size, mean brightness, contrast, clipped black/white %, edge strength, the step\'s readout and any step errors. Use it to check the effect of changes.',
        inputSchema: { type: 'object', properties: { step: STEP } },
        execute: async ({ step }) => { const r = await api().inspect(step ?? null); line('tool', `› Checked ${r.of}: brightness ${r.meanBrightness}, contrast ${r.contrast}`); return r; },
      },
      {
        name: 'set_view',
        description: 'Change what the viewer shows: show = "result" | "step" (the selected step) | "original"; compare = true for a split view with the original; frame = frame number (1-based) for videos.',
        inputSchema: { type: 'object', properties: { show: { type: 'string', enum: ['result', 'step', 'original'] }, compare: { type: 'boolean' }, frame: { type: 'integer', minimum: 1 } } },
        execute: async ({ show, compare, frame }) => {
          const r = {};
          if (show) Object.assign(r, api().show(show));
          if (compare !== undefined) Object.assign(r, api().compare(compare));
          if (frame !== undefined) Object.assign(r, api().frame(frame));
          line('tool', `› View: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          return r;
        },
      },
      {
        name: 'load_sample',
        description: 'Open one of the built-in sample images or clips (replaces the current image). Only when the user asks for a sample or test material.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', enum: api().samples().map(s => s.id) } }, required: ['id'] },
        execute: async ({ id }) => {
          const st = api().state();
          if (st.source && st.source.userFile && !(await confirmInPage(`Replace your open file "${st.source.name}" with a sample?`))) throw new Error('the user declined replacing their file');
          beforeChange(label);
          const r = await api().loadSample(String(id));
          line('tool', `› Opened sample: ${r.loaded}`);
          return r;
        },
      },
      {
        name: 'save',
        description: 'Offer a file to the user (they confirm the download): kind = "frame" (result image), "step" (selected step\'s output), "frames" (ZIP of all result frames), "video", "project" (chain as JSON) or "report" (HTML processing report).',
        inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['frame', 'step', 'frames', 'video', 'project', 'report'] } }, required: ['kind'] },
        execute: async ({ kind }) => { const r = await api().save(String(kind)); line('tool', `› Offered ${kind} for download`); return r; },
      },
      {
        name: 'undo',
        description: 'Undo the changes made by the previous request (restores the chain and view as they were before it).',
        execute: async () => { const lbl = api().undo(); $('chat-undo').disabled = !api().canUndo(); line('tool', `› Undid "${lbl}"`); return { undone: lbl, chain: api().state().chain.map(brief) }; },
      },
    ];
  }

  const brief = s => ({ step: s.step, filter: s.filter, enabled: s.enabled, ...(s.error ? { error: s.error } : {}) });
  function describeOp(o, r) {
    const name = id => (AD.filters.get(id) || {}).name || id;
    if (o.op === 'add') return `Added ${name(r.filter)} as step ${r.step}${r.warnings ? ` (${r.warnings.join('; ')})` : ''}`;
    if (o.op === 'set') return `Step ${r.step}: ${Object.keys(o.params || {}).map(k => `${k} = ${AD.fmtValue(r.params[k])}`).join(', ')}${r.warnings ? ` (${r.warnings.join('; ')})` : ''}`;
    if (o.op === 'remove') return `Removed step ${r.removed}`;
    if (o.op === 'move') return `Moved step ${r.moved} to ${r.to}`;
    if (o.op === 'enable' || o.op === 'disable') return `${r.enabled ? 'Enabled' : 'Disabled'} step ${r.step}`;
    if (o.op === 'select') return `Selected step ${r.selected}`;
    if (o.op === 'clear') return `Cleared ${r.removed} step(s)`;
    return o.op;
  }

  // ---------------------------------------------------------------- prompt
  function rules() {
    return `You operate "Anomaly Detector", a forensic image and video enhancement app running in the user's browser. The user tells you in plain language what they want; you do it with the tools, then reply.

How the app works:
- A source (image, image sequence or video) runs through a chain of filters shown as numbered steps in History; step 1 runs first, each step processes the output of the step above it. The result is the output of the last step.
- Filters and their parameters are listed in the catalog below (id — name (category): description | params | actions). Use only these ids and parameter ids. Ranges are min..max; [a|b] lists allowed values; "px" values are pixels of the full-resolution image.
- points and rect parameters are in pixel coordinates of the step's INPUT image (its size is given per step as inputSize). When you are shown an image, it is the current result (= the input a new filter added at the end receives), possibly downscaled: the message says the scale.

How to act:
- Do what was asked with as few changes as possible. Prefer adjusting an existing step over adding a duplicate. Batch all chain changes into one edit_chain call when you can.
- Typical recipes: dark image → clahe or levels (run action "auto"), exposure-gamma, retinex; noise → nl-means / wavelet-denoise / median; noisy video → motion-smoothing (frame-average only when the camera and subject are still, or to combine a range into one image); JPEG blocks → deblocking; motion blur → motion-deblur then run_action "estimate"; out of focus → optical-deblur then "estimate"; plate at an angle → perspective-correction with the four plate corners (TL, TR, BR, BL); repeating pattern → periodic-noise then run_action "detect"; colour cast → white-balance; hidden colour differences → decorrelation-stretch or extract-channel; measurements → the Measure filters.
- Order matters: fix geometry and blur before sharpening; denoise before strong contrast boosts.
- If a request is ambiguous or would discard the user's work, ask instead of guessing. Do not load samples unless asked.
- Never claim to recover detail that is not in the image; enhancement only reveals what the pixels contain. Say so if the user expects more.
- After acting, reply in 1-3 short plain sentences saying what you changed (step numbers and key values). If you only answered a question, just answer it.

Filter catalog:
${api().catalog()}

Samples (load only when asked): ${api().samples().map(s => s.id).join(', ')}`;
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    $('chat-input').value = '';
    line('me', text);
    if (!sample) return localCommand(text);

    const ctl = new AbortController();
    busy = ctl; snapshotTaken = false;
    setBusy(true);
    const label = text.length > 60 ? text.slice(0, 57) + '…' : text;
    let image = null, imageNote = '';
    try {
      if ($('chat-see').checked && canSeeImages) {
        image = await api().snapshotImage(1024);
        if (image) imageNote = `\n\nAttached image: the current result, ${image.width}x${image.height} px at full resolution, sent at ${image.sentWidth}x${image.sentHeight} (scale ${image.scale.toFixed(4)}). Divide coordinates you read off the image by ${image.scale.toFixed(4)} to get full-resolution pixels.`;
      }
    } catch (e) { image = null; }
    const state = JSON.stringify(api().state());
    const msg = `Current app state:\n${state.length > 12000 ? state.slice(0, 12000) + '…' : state}${imageNote}\n\nUser: ${text}`;
    const input = [{ role: 'user', content: rules() }, ...turns.slice(-HISTORY_TURNS), { role: 'user', content: msg }];
    const out = line('ai', 'Thinking…');
    status($('chat-think').checked ? 'Thinking (thorough)…' : 'Working…');
    try {
      const res = await sample(input, {
        tools: makeTools(label), signal: ctl.signal, modelTier: $('chat-think').checked ? 'default' : 'quick',
        ...(image ? { images: [image.blob] } : {}),
        onText: ({ text: t }) => { out.textContent = t; $('chat-log').scrollTop = $('chat-log').scrollHeight; },
      });
      out.textContent = res.text;
      if (res.truncated) line('note', 'The reply was cut short; ask for less at once.');
      turns.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
    } catch (e) {
      out.textContent = e.text || '';
      if (!e.text) out.remove();
      handleError(e);
      turns.push({ role: 'user', content: text });
    } finally {
      busy = null; setBusy(false); status('');
      $('chat-undo').disabled = !api().canUndo();
    }
  }

  function handleError(e) {
    const code = e && e.code;
    if (code === 'cancelled') return line('note', 'Stopped. Changes made so far stay; use Undo to revert them.');
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'tools_unavailable'].includes(code)) {
      line('note err', code === 'not_granted' ? 'Claude was not allowed for this page, so only simple commands work now (try "help").' : 'Claude is not available here, so only simple commands work (try "help").');
      sample = null; updateMode();
      return;
    }
    if (code === 'images_unavailable') { canSeeImages = false; updateMode(); return line('note', 'Images cannot be sent from here; try again without "Let Claude see the image".'); }
    if (code === 'rate_limited') return line('note err', 'Too many requests or your usage limit was reached. Try again in a little while.');
    if (code === 'session_expired') return line('note err', 'Your Claude session expired. Sign in again, then retry.');
    if (code === 'refused') return line('note err', 'Claude declined that request. Rephrase it.');
    if (code === 'prompt_too_large') return line('note err', 'Too much to send at once. Clear the conversation and try again.');
    line('note err', `Something went wrong (${code || 'error'}). Try again.`);
  }

  // ---------------------------------------------------------------- local commands (no Claude)
  const HELP = 'Simple commands: "add levels", "add clahe to step 1", "set gamma to 1.8 on step 2", "remove step 2", "move step 3 to 1", "disable step 2", "run auto on step 1", "clear", "undo", "show original | result", "compare on | off", "frame 12", "sample plate", "save report".';
  function findFilter(q) {
    q = q.toLowerCase().trim();
    const all = [...AD.filters.values()];
    return all.find(d => d.id === q) || all.find(d => d.name.toLowerCase() === q) || all.find(d => d.name.toLowerCase().includes(q) || d.id.includes(q.replace(/\s+/g, '-')))
      || all.find(d => (d.keywords || []).some(k => k.toLowerCase() === q));
  }
  async function localCommand(text) {
    const t = text.toLowerCase().trim();
    let m;
    const reply = s => line('ai', s);
    try {
      snapshotTaken = false;
      const change = () => beforeChange(text);
      if (/^(help|\?|what can you do)/.test(t)) return reply(HELP);
      if (t === 'undo') return reply(`Undid "${api().undo()}".`);
      if (t === 'clear') { change(); api().clear(); return reply('Cleared the chain.'); }
      if ((m = t.match(/^add (.+?)(?: (?:at|as|to) step (\d+))?$/))) {
        const d = findFilter(m[1]); if (!d) return reply(`No filter matches "${m[1]}".`);
        change(); const r = await api().add(d.id, {}, m[2] ? Number(m[2]) : null); return reply(`Added ${d.name} as step ${r.step}.`);
      }
      if ((m = t.match(/^set (\S+) (?:to|=) (\S+)(?: (?:on|of|for) step (\d+))?$/))) {
        const st = api().state(), ref = m[3] ? Number(m[3]) : st.selectedStep;
        if (!ref) return reply('Say which step, e.g. "set gamma to 1.5 on step 2".');
        const v = isNaN(Number(m[2])) ? (m[2] === 'on' || m[2] === 'true' ? true : m[2] === 'off' || m[2] === 'false' ? false : m[2]) : Number(m[2]);
        change(); api().set(ref, { [m[1]]: v }); return reply(`Set ${m[1]} on step ${ref}.`);
      }
      if ((m = t.match(/^(?:remove|delete) step (\d+)$/))) { change(); api().remove(Number(m[1])); return reply(`Removed step ${m[1]}.`); }
      if ((m = t.match(/^move step (\d+) to (\d+)$/))) { change(); api().move(Number(m[1]), Number(m[2])); return reply(`Moved step ${m[1]} to ${m[2]}.`); }
      if ((m = t.match(/^(enable|disable) step (\d+)$/))) { change(); api().enable(Number(m[2]), m[1] === 'enable'); return reply(`${m[1] === 'enable' ? 'Enabled' : 'Disabled'} step ${m[2]}.`); }
      if ((m = t.match(/^run (\S+) on step (\d+)$/))) { change(); const r = await api().action(Number(m[2]), m[1]); return reply(`Ran ${m[1]}: ${Object.entries(r.changed).map(([k, v]) => `${k} = ${AD.fmtValue(v)}`).join(', ')}.`); }
      if ((m = t.match(/^show (original|result|step)$/))) { api().show(m[1]); return reply(`Showing ${m[1]}.`); }
      if ((m = t.match(/^compare (on|off)$/))) { api().compare(m[1] === 'on'); return reply(`Compare ${m[1]}.`); }
      if ((m = t.match(/^(?:go to )?frame (\d+)$/))) { const r = api().frame(Number(m[1])); return reply(`Frame ${r.frame} of ${r.of}.`); }
      if ((m = t.match(/^(?:load )?sample (\S+)$/))) {
        const st = api().state();
        if (st.source && st.source.userFile && !(await confirmInPage(`Replace your open file "${st.source.name}" with a sample?`))) return reply('Kept your file.');
        change(); const r = await api().loadSample(m[1]); return reply(`Opened ${r.loaded}.`);
      }
      if ((m = t.match(/^save (frame|step|frames|video|project|report)$/))) { await api().save(m[1]); return reply(`Offered the ${m[1]} for download.`); }
      reply(`I can only follow simple commands without Claude. ${HELP}`);
    } catch (e) { line('note err', e.message); }
    finally { $('chat-undo').disabled = !api().canUndo(); }
  }

  // ---------------------------------------------------------------- UI wiring
  function setBusy(on) {
    $('chat-send').hidden = on; $('chat-stop').hidden = !on;
    $('chat-input').disabled = false;
  }
  function updateMode() {
    $('chat-mode').textContent = sample ? 'Claude' : 'Commands only';
    $('chat-mode').title = sample ? 'Requests are answered by Claude on your account' : 'Claude is not available in this copy of the page; simple commands work';
    $('chat-see-wrap').hidden = !sample || !canSeeImages;
    $('chat-think-wrap').hidden = !sample;
    $('chat-input').placeholder = sample ? 'Tell the app what to do, e.g. "make the plate readable"' : 'Type a command, e.g. "add clahe" (type help for the list)';
  }

  function init() {
    if (!$('chat-form')) return;
    updateMode();
    $('chat-form').addEventListener('submit', e => { e.preventDefault(); send($('chat-input').value); });
    $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('chat-input').value); } });
    $('chat-stop').addEventListener('click', () => { if (busy) busy.abort(); });
    $('chat-undo').addEventListener('click', () => { try { line('tool', `› Undid "${api().undo()}"`); } catch (e) { line('note err', e.message); } $('chat-undo').disabled = !api().canUndo(); });
    $('chat-clear').addEventListener('click', () => { turns.length = 0; $('chat-log').textContent = ''; showSuggestions(); });
    showSuggestions();
    const c = root.claude;
    if (c && typeof c.use === 'function') {
      c.use('sample').then(async s => {
        if (!s) return;
        const lim = await s.limits().catch(() => null);
        if (lim && !lim.tools) return;   // this view cannot run page tools: keep command mode
        sample = s; canSeeImages = !!(lim && lim.images);
        updateMode();
      }).catch(() => {});
    }
  }

  function showSuggestions() {
    const box = $('chat-log');
    if (box.childElementCount) return;
    const p = document.createElement('div');
    p.className = 'chips';
    for (const s of ['Make the plate readable', 'Remove the noise', 'Undo the motion blur', 'Straighten the plate', 'What can you do?']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = s;
      b.addEventListener('click', () => { p.remove(); send(s === 'What can you do?' && !sample ? 'help' : s); });
      p.append(b);
    }
    box.append(p);
  }

  AD.assistant = { init, send, _setSample: (s, images = true) => { sample = s; canSeeImages = images; updateMode(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
