// Run: node tests/sentences.test.js
const assert = require('assert');
const S = require('../extension/lib/sentences.js');

// 1. Cues that cut sentences in the middle are merged into whole sentences.
const cues = [
  { start: 55, end: 58, text: "well, it makes sense to talk about brightnesses or" },
  { start: 58, end: 61, text: "light ratios when there's more than one light in" },
  { start: 61, end: 63, text: "the scene. So let's add a second light, e.g. a" },
  { start: 63, end: 66, text: "rim light. Dr. Smith uses 3.5 watts! Right?" },
];
const out = S.buildSentencesFromCues(cues);
assert.deepStrictEqual(out.map((s) => s.text), [
  "well, it makes sense to talk about brightnesses or light ratios when there's more than one light in the scene.",
  "So let's add a second light, e.g. a rim light.",
  "Dr. Smith uses 3.5 watts!",
  "Right?",
]);
assert.strictEqual(out[0].start, 55);
assert.ok(out[0].end > 61 && out[0].end <= 63, 'first sentence ends inside the 3rd cue');
assert.ok(out[1].start >= out[0].end - 0.01);

// 2. Rolling (duplicated) captions are de-duplicated.
const rolling = [
  { start: 0, end: 2, text: 'so the first thing we do' },
  { start: 2, end: 4, text: 'so the first thing we do is open the' },
  { start: 4, end: 6, text: 'is open the shader editor.' },
];
assert.deepStrictEqual(S.buildSentencesFromCues(rolling).map((s) => s.text),
  ['so the first thing we do is open the shader editor.']);

// 3. Run-on text without punctuation is split into readable chunks.
const words = Array.from({ length: 90 }, (_, i) => 'word' + i);
const runOn = [];
for (let i = 0; i < 90; i += 9) runOn.push({ start: i, end: i + 1, text: words.slice(i, i + 9).join(' ') });
const split = S.buildSentencesFromCues(runOn);
assert.ok(split.length >= 2 && split.every((s) => S.wordCount(s.text) <= 45));

// 4. VTT parsing.
const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n<v Bob>Hello &amp; welcome\n\n00:01:02.000 --> 00:01:03.000\nsecond';
assert.deepStrictEqual(S.parseSubtitleFile(vtt), [
  { start: 1, end: 2.5, text: '<v Bob>Hello &amp; welcome' },
  { start: 62, end: 63, text: 'second' },
]);
assert.strictEqual(S.cleanText('<v Bob>Hello &amp; welcome [music]'), 'Hello & welcome');

// 5. Live buffer: holds incomplete text, merges premature periods.
(async () => {
  const got = [];
  const b = new S.LiveSentenceBuffer((s) => got.push(s), { holdMs: 50, idleFlushMs: 200 });
  b.push('So what we are going to do');
  b.push('is add a light.');           // completes sentence, held briefly
  b.push('Then we render it.');         // confirms previous
  assert.deepStrictEqual(got, ['So what we are going to do is add a light.']);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(got.slice(1), ['Then we render it.']);

  got.length = 0;
  b.push('We need to connect the.');    // Whisper-style premature period on dangling word
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(got, []);      // still waiting
  b.push('node to the output.');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(got, ['We need to connect the node to the output.']);

  got.length = 0;
  b.push('and this has no end');
  await new Promise((r) => setTimeout(r, 260));
  assert.deepStrictEqual(got, ['and this has no end']);
  console.log('sentences.test.js: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
