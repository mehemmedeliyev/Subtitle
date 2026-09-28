// Tests the audio-mode pipeline without a browser: VAD segmentation,
// WAV encoding, ordered STT results and complete-sentence assembly.
// Run: node tests/audio.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sent = [];
const sandbox = {
  console, setTimeout, clearTimeout, Blob, FormData, Float32Array, ArrayBuffer, DataView, Math, Map, Date, JSON, String, Promise,
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } },
};
sandbox.self = sandbox;
vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), sandbox, { filename: f });
load('lib/sentences.js');
load('offscreen/offscreen.js');

const RATE = 48000;
function blocks(seconds, amp) {
  const out = [];
  const n = Math.round((seconds * RATE) / 2048);
  for (let i = 0; i < n; i++) {
    const b = new Float32Array(2048);
    for (let k = 0; k < b.length; k++) b[k] = amp ? amp * Math.sin((i * 2048 + k) * 0.05) * (0.6 + 0.4 * Math.random()) : (Math.random() - 0.5) * 0.001;
    out.push(b);
  }
  return out;
}

(async () => {
  // --- Segmenter ---
  const segs = [];
  let silences = 0;
  const seg = vm.runInContext('(r, a, b) => new Segmenter(r, a, b)', sandbox)(RATE, (s, d) => segs.push(d), () => silences++);
  [...blocks(1, 0), ...blocks(3, 0.3), ...blocks(0.6, 0), ...blocks(2.5, 0.3), ...blocks(1.6, 0)].forEach((b) => seg.feed(b));
  assert.strictEqual(segs.length, 2, 'two speech segments, got ' + segs.length);
  assert.ok(segs[0] > 3000 && segs[0] < 4200, 'first segment ~3.3-3.8s, got ' + segs[0]);
  assert.ok(silences >= 1, 'long silence reported');

  // Very long speech is cut at 13 s max.
  const segs2 = [];
  const seg2 = vm.runInContext('(r, a, b) => new Segmenter(r, a, b)', sandbox)(RATE, (s, d) => segs2.push(d), () => {});
  [...blocks(30, 0.3), ...blocks(1, 0)].forEach((b) => seg2.feed(b));
  assert.ok(segs2.length >= 3 && segs2.every((d) => d <= 13100), 'long speech split, got ' + segs2);

  // --- WAV encoding ---
  const wav = vm.runInContext('encodeWav', sandbox)(new Float32Array(16000));
  assert.strictEqual(wav.size, 44 + 32000);

  // --- STT → sentences, results out of order ---
  const replies = ['We need to connect the.', 'node to the output. Then we', 'render the scene.'];
  const delays = [120, 10, 10];
  let call = 0;
  sandbox.fetch = async (url, opts) => {
    const k = call++;
    assert.strictEqual(opts.body.get('language'), 'en');
    await new Promise((r) => setTimeout(r, delays[k]));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text: replies[k] }) };
  };
  vm.runInContext(`
    session = { ctx: { sampleRate: 48000 }, stt: { provider: 'groq', key: 'x', model: 'whisper-large-v3' },
      seq: 0, nextEmit: 0, results: new Map(), inflight: 0, transcript: '', dead: false,
      segmenter: { inSpeech: true, quietMs: 0 } };
    session.buffer = new self.GTSentences.LiveSentenceBuffer((t) => chrome.runtime.sendMessage({ type: 'audio-sentence', text: t }),
      { holdMs: 250, idleFlushMs: 15000, dedupe: false });
  `, sandbox);
  const s = vm.runInContext('session', sandbox);
  const onSegment = vm.runInContext('onSegment', sandbox);
  await Promise.all([onSegment(s, new Float32Array(48000), 3000), onSegment(s, new Float32Array(48000), 3000), onSegment(s, new Float32Array(48000), 3000)]);
  await new Promise((r) => setTimeout(r, 400));
  const out = sent.filter((m) => m.type === 'audio-sentence').map((m) => m.text);
  assert.deepStrictEqual(out, ['We need to connect the node to the output.', 'Then we render the scene.']);
  console.log('audio.test.js: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
