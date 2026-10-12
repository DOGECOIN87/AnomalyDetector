// End-to-end test of natural-language control in headless Chromium, with a mock of the artifact `sample`
// capability that behaves like Claude calling the page's tools.  node test/assistant.mjs
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { start } from '../serve.mjs';

const server = await start(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('PASS ', name); } catch (e) { failures++; console.log('FAIL ', name, '\n      ', e.message.split('\n')[0]); } };

async function open(withClaude) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log('  pageerror:', e.message));
  if (withClaude) {
    await page.addInitScript(() => {
      // Mock of the sample capability: decides on tool calls from the user's words, like Claude would.
      window.__calls = [];
      const mock = async (input, opts) => {
        const last = input[input.length - 1].content, said = last.split('\nUser: ').pop().toLowerCase();
        window.__calls.push({ turns: input.length, bytes: JSON.stringify(input).length, images: (opts.images || []).length, tier: opts.modelTier, rules: input[0].content, last });
        // like the platform: a tool that throws returns "Error: ..." to Claude and the call carries on
        const tool = name => { const t = opts.tools.find(x => x.name === name); return { execute: async (a, c) => { try { return await t.execute(a, c); } catch (e) { return 'Error: ' + e.message; } } }; };
        const ctx = { signal: opts.signal };
        let text;
        if (said.includes('readable')) {
          const r = await tool('edit_chain').execute({ ops: [{ op: 'add', filter: 'clahe', params: { clip: 4 } }, { op: 'add', filter: 'unsharp-mask', params: { amount: 1.5 } }] }, ctx);
          const check = await tool('inspect_result').execute({}, ctx);
          text = `Added CLAHE (step ${r.completed[0].step}) and Unsharp Mask (step ${r.completed[1].step}). Contrast is now ${check.contrast}.`;
        } else if (said.includes('bogus')) {
          const r = await tool('edit_chain').execute({ ops: [{ op: 'add', filter: 'levels' }, { op: 'add', filter: 'not-a-filter' }] }, ctx);
          text = `Partly done: ${r.failed.error}`;
        } else if (said.includes('brighter')) {
          const r = await tool('edit_chain').execute({ ops: [{ op: 'set', step: 1, params: { clip: 99, tiles: 'x' } }] }, ctx);
          text = r.failed ? `Could not: ${r.failed.error}` : 'Done';
        } else if (said.includes('estimate')) {
          await tool('edit_chain').execute({ ops: [{ op: 'clear' }, { op: 'add', filter: 'motion-deblur' }] }, ctx);
          const r = await tool('run_action').execute({ step: 1, action: 'estimate' }, ctx);
          text = `Estimated length ${r.changed.length} px at ${r.changed.angle}°.`;
        } else if (said.includes('sample')) {
          const r = await tool('load_sample').execute({ id: 'noisy' }, ctx);
          text = typeof r === 'string' ? 'Kept your file, as you asked.' : 'Opened the noisy sample.';
        } else if (said.includes('undo')) {
          const r = await tool('undo').execute({}, ctx);
          text = `Undid ${r.undone}.`;
        } else text = 'I can adjust, denoise, deblur, rectify and measure. Tell me what you need.';
        opts.onText && opts.onText({ text, delta: text });
        return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
      };
      mock.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 }, images: { maxCount: 5, maxInputBytes: 2e7, mediaTypes: ['image/jpeg'] } });
      window.claude = { use: async name => (name === 'sample' ? mock : null) };
    });
  }
  await page.goto(url);
  await page.waitForFunction(() => window.AD && AD.state.source && AD.viewer.data);
  return page;
}

const say = async (page, text) => {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => !document.getElementById('chat-send').hidden, null, { timeout: 60000 });
  await page.waitForTimeout(150);
};
const chain = page => page.evaluate(() => AD.api.state().chain.map(s => s.filter));
const transcript = page => page.evaluate(() => [...document.querySelectorAll('#chat-log p')].map(p => `${p.className}: ${p.textContent}`));

// ---------------------------------------------------------------- command mode (no Claude)
{
  const page = await open(false);
  await check('command mode is shown without Claude', async () => assert.equal(await page.textContent('#chat-mode'), 'Commands only'));
  await check('commands edit the chain', async () => {
    await say(page, 'add clahe');
    await say(page, 'add levels');
    await say(page, 'set gamma to 1.8 on step 2');
    assert.deepEqual(await chain(page), ['clahe', 'levels']);
    assert.equal(await page.evaluate(() => AD.api.state().chain[1].params.gamma), 1.8);
    await say(page, 'move step 2 to 1');
    assert.deepEqual(await chain(page), ['levels', 'clahe']);
    await say(page, 'remove step 1');
    assert.deepEqual(await chain(page), ['clahe']);
  });
  await check('undo restores the previous chain', async () => {
    await say(page, 'undo');
    assert.deepEqual(await chain(page), ['levels', 'clahe']);
  });
  await check('bad values are reported, not applied', async () => {
    await say(page, 'set nonsense to 3 on step 1');
    const t = await transcript(page);
    assert.match(t[t.length - 1], /has no parameter "nonsense"/);
  });
  await page.close();
}

// ---------------------------------------------------------------- Claude mode (mocked)
{
  const page = await open(true);
  await page.waitForFunction(() => document.getElementById('chat-mode').textContent === 'Claude');
  await check('Claude mode, with image and thorough options', async () => {
    assert.equal(await page.isVisible('#chat-see-wrap'), true);
    assert.equal(await page.isVisible('#chat-think-wrap'), true);
  });
  await check('"make the plate readable" adds filters and inspects the result', async () => {
    await page.evaluate(() => AD.debug.clearChain());
    await say(page, 'Make the plate readable');
    assert.deepEqual(await chain(page), ['clahe', 'unsharp-mask']);
    const call = await page.evaluate(() => window.__calls[window.__calls.length - 1]);
    assert.equal(call.images, 1, 'sent the current image');
    assert.equal(call.tier, 'quick');
    assert.match(call.rules, /clahe — Local Contrast \(CLAHE\)/, 'catalog in the prompt');
    assert.match(call.last, /"chain":\[\]/, 'state in the prompt');
    assert.match(call.last, /Attached image: the current result, 960x600/);
    assert.ok(call.bytes < 120000, `prompt is ${call.bytes} bytes`);
    const t = (await transcript(page)).join('\n');
    assert.match(t, /Added Local Contrast \(CLAHE\) as step 1/);
    assert.match(t, /Contrast is now/);
  });
  await check('invalid filter ids and values come back as errors Claude can read', async () => {
    await say(page, 'add something bogus');
    let t = (await transcript(page)).join('\n');
    assert.match(t, /add failed: unknown filter "not-a-filter"/);
    assert.match(t, /Partly done: unknown filter/);
    await say(page, 'make it brighter');
    t = (await transcript(page)).join('\n');
    assert.match(t, /Could not: Local Contrast \(CLAHE\) › tiles must be a number/);
  });
  await check('actions run through the tools (motion blur estimate)', async () => {
    await page.evaluate(() => AD.loadSample('motion-blur'));
    await page.waitForTimeout(300);
    await say(page, 'estimate the blur and fix it');
    assert.deepEqual(await chain(page), ['motion-deblur']);
    const p = await page.evaluate(() => AD.api.state().chain[0].params);
    assert.ok(p.length > 15 && p.length < 30, `length ${p.length}`);
  });
  await check('"Undo last" reverts a whole request', async () => {
    await page.click('#chat-undo');
    await page.waitForTimeout(150);
    assert.deepEqual(await chain(page), ['clahe', 'unsharp-mask', 'levels']);
  });
  await check('replacing the user\'s own file asks first; declining keeps it', async () => {
    await page.evaluate(() => { delete AD.state.source.sample; AD.state.source.name = 'evidence.jpg'; });
    await page.fill('#chat-input', 'open the noisy sample');
    await page.press('#chat-input', 'Enter');
    await page.waitForSelector('#chat-confirm:not([hidden])');
    assert.match(await page.textContent('#chat-confirm-q'), /evidence\.jpg/);
    await page.click('#chat-deny');
    await page.waitForFunction(() => !document.getElementById('chat-send').hidden);
    assert.equal(await page.evaluate(() => AD.state.source.name), 'evidence.jpg');
    assert.match((await transcript(page)).join('\n'), /Kept your file/);
    // allow this time
    await page.fill('#chat-input', 'open the noisy sample');
    await page.press('#chat-input', 'Enter');
    await page.waitForSelector('#chat-confirm:not([hidden])');
    await page.click('#chat-allow');
    await page.waitForFunction(() => !document.getElementById('chat-send').hidden);
    assert.match(await page.evaluate(() => AD.state.source.name), /Low-light/);
  });
  await check('the conversation is kept across requests', async () => {
    await say(page, 'what can you do?');
    const call = await page.evaluate(() => window.__calls[window.__calls.length - 1]);
    assert.ok(call.turns >= 5, `turns ${call.turns}`);
  });
  await page.screenshot({ path: process.argv[2] || '/tmp/assistant.png' });
  await page.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
