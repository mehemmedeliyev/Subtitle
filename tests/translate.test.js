// Tests lib/translate.js with a mocked fetch. Run: node tests/translate.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
let claudeMode = 'ok';
const sandbox = { console, setTimeout, clearTimeout, Map, JSON, Promise, encodeURIComponent, URL };
sandbox.self = sandbox;
sandbox.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (url.startsWith('https://api.anthropic.com')) {
    if (claudeMode === 'error') return { ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) };
    const body = JSON.parse(opts.body);
    const { sentences } = JSON.parse(body.messages[0].content);
    return { ok: true, status: 200, json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ translations: sentences.map((s) => 'C:' + s) }) }],
    }) };
  }
  if (url.startsWith('https://api.groq.com')) {
    const body = JSON.parse(opts.body);
    if (body.model === 'openai/gpt-oss-120b') {
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: { message: 'model decommissioned' } }) };
    }
    const { sentences } = JSON.parse(body.messages[1].content);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ translations: sentences.map((s) => 'Q:' + s) }) } }],
    }) };
  }
  const q = new URL(url).searchParams.get('q');
  return { ok: true, status: 200, json: async () => [[['G:' + q, q]]] };
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'translate.js'), 'utf8'), sandbox);
const T = sandbox.GTTranslate;

(async () => {
  let r = await T.translateBatch(['Hello there.', 'Second one.'], [], { provider: 'google', targetLang: 'az' });
  assert.deepStrictEqual([...r.translations], ['G:Hello there.', 'G:Second one.']);
  assert.ok(calls[0].url.includes('tl=az'));

  calls.length = 0;
  r = await T.translateBatch(['Hello there.'], [], { provider: 'google', targetLang: 'az' });
  assert.strictEqual(calls.length, 0, 'cached');

  r = await T.translateBatch(['A.', 'B.'], ['ctx.'], { provider: 'claude', claudeKey: 'k', targetLang: 'tr', claudeModel: 'claude-opus-5' });
  assert.deepStrictEqual([...r.translations], ['C:A.', 'C:B.']);
  const req = calls.find((c) => c.url.includes('anthropic'));
  const body = JSON.parse(req.opts.body);
  assert.strictEqual(body.model, 'claude-opus-5');
  assert.strictEqual(body.output_config.format.type, 'json_schema');
  assert.strictEqual(req.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(body.system.includes('Turkish'));

  // Groq (free AI): shares the speech-recognition key; retired model → next model.
  calls.length = 0;
  r = await T.translateBatch(['Groq one.', 'Groq two.'], ['ctx.'], { provider: 'groq', sttProvider: 'groq', sttKey: 'gsk', targetLang: 'az' });
  assert.deepStrictEqual([...r.translations], ['Q:Groq one.', 'Q:Groq two.']);
  const g = calls.filter((c) => c.url.includes('groq'));
  assert.strictEqual(g.length, 2, 'first model retired, second used');
  assert.strictEqual(g[0].opts.headers.authorization, 'Bearer gsk');
  assert.strictEqual(JSON.parse(g[1].opts.body).model, 'llama-3.3-70b-versatile');

  claudeMode = 'error';
  r = await T.translateBatch(['New sentence.'], [], { provider: 'claude', claudeKey: 'bad', targetLang: 'az' });
  assert.deepStrictEqual([...r.translations], ['G:New sentence.']);
  assert.ok(/401/.test(r.warning), 'warning explains the fallback');
  console.log('translate.test.js: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
