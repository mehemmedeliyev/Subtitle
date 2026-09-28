/*
 * Offscreen document for "translate the audio" mode.
 *
 * 1. Captures the tab's audio (and plays it back so the video stays audible).
 * 2. Voice-activity detection cuts the audio at natural pauses.
 * 3. Each piece is sent to a Whisper-class speech recogniser (Groq or OpenAI),
 *    forced to English, with the previous transcript as a prompt so accents,
 *    names and technical words are recognised consistently.
 * 4. The transcript goes through LiveSentenceBuffer so only *complete*
 *    sentences are sent on for translation.
 */
'use strict';

const STT_URLS = {
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions',
};

// Phrases Whisper tends to invent on music / near-silence.
const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'thank you for watching', 'thank you for watching.', 'bye', 'bye.', 'bye-bye.',
  'please subscribe', 'subtitles by the amara.org community', '.', 'so', 'okay.',
]);

let session = null;

function report(status, error) {
  chrome.runtime.sendMessage({ type: 'audio-status', status, error: error || '' }).catch(() => {});
}

function sendSentence(text) {
  chrome.runtime.sendMessage({ type: 'audio-sentence', text }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        stop();
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === 'stop') {
    stop();
    sendResponse({ ok: true });
  }
  return false;
});

async function start({ streamId, stt }) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // capturing mutes the tab – play it back

  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute).connect(ctx.destination);

  const s = {
    stream, ctx, node, stt,
    seq: 0, nextEmit: 0, results: new Map(), inflight: 0,
    transcript: '', dead: false,
  };
  s.buffer = new self.GTSentences.LiveSentenceBuffer(sendSentence, {
    holdMs: 250, // speech is live – show a finished sentence right away
    idleFlushMs: 15000, // unfinished text is flushed on a real pause instead (see onLongSilence)
    dedupe: false,
  });
  s.segmenter = new Segmenter(ctx.sampleRate,
    (samples, dur) => onSegment(s, samples, dur),
    () => { if (s.inflight === 0) s.buffer.flush(); });
  node.port.onmessage = (e) => s.segmenter.feed(e.data);
  session = s;
  report('listening');
}

function stop() {
  const s = session;
  session = null;
  if (!s) return;
  s.dead = true;
  try { s.buffer.flush(); } catch (_) { /* ignore */ }
  try { s.node.port.onmessage = null; } catch (_) { /* ignore */ }
  s.stream.getTracks().forEach((t) => t.stop());
  s.ctx.close().catch(() => {});
}

/** Voice-activity based segmentation with an adaptive noise floor. */
class Segmenter {
  constructor(rate, onSegment, onLongSilence) {
    this.rate = rate;
    this.onSegment = onSegment;
    this.onLongSilence = onLongSilence;
    this.noise = 0.004;
    this.inSpeech = false;
    this.pre = [];
    this.chunks = [];
    this.durMs = 0;
    this.speechMs = 0;
    this.silentMs = 0;
    this.quietMs = 0;
    this.longSilenceSent = true;
  }

  feed(block) {
    const ms = (block.length / this.rate) * 1000;
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    // Noise floor follows quiet parts fast and loud parts slowly.
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.997 + rms * 0.003;
    this.noise = Math.min(0.05, Math.max(0.0008, this.noise));
    const voiced = rms > Math.max(0.006, this.noise * 2.2);

    if (!this.inSpeech) {
      this.pre.push(block);
      if (this.pre.length * ms > 350) this.pre.shift(); // keep ~300 ms pre-roll
      if (voiced) {
        this.inSpeech = true;
        this.chunks = this.pre;
        this.pre = [];
        this.durMs = this.chunks.length * ms;
        this.speechMs = ms;
        this.silentMs = 0;
        this.longSilenceSent = false;
      } else {
        this.quietMs += ms;
        if (this.quietMs > 1300 && !this.longSilenceSent) {
          this.longSilenceSent = true;
          this.onLongSilence();
        }
      }
      return;
    }

    this.chunks.push(block);
    this.durMs += ms;
    if (voiced) {
      this.silentMs = 0;
      this.speechMs += ms;
    } else {
      this.silentMs += ms;
    }
    // Prefer cutting at sentence-like pauses; accept shorter pauses once long.
    const pauseNeeded = this.durMs > 8000 ? 250 : 450;
    if ((this.silentMs >= pauseNeeded && this.durMs >= 2000) || this.silentMs >= 900 || this.durMs >= 13000) {
      this.cut();
    }
  }

  cut() {
    const blocks = this.chunks;
    const speechMs = this.speechMs;
    const durMs = this.durMs;
    this.inSpeech = false;
    this.quietMs = this.silentMs;
    this.chunks = [];
    this.pre = [];
    if (speechMs < 350) return;
    let len = 0;
    for (const b of blocks) len += b.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const b of blocks) { all.set(b, o); o += b.length; }
    this.onSegment(all, durMs);
  }
}

function resampleTo16k(samples, rate) {
  const ratio = rate / 16000;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = a; k < b; k++) sum += samples[k];
    out[i] = b > a ? sum / (b - a) : samples[a] || 0;
  }
  return out;
}

function encodeWav(samples) {
  // Normalise quiet speech a little – helps recognition.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak > 0 && peak < 0.5 ? Math.min(4, 0.9 / peak) : 1;
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] * gain));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function onSegment(s, samples, durMs) {
  if (s.dead) return;
  const id = s.seq++;
  s.inflight++;
  let text = '';
  try {
    const wav = encodeWav(resampleTo16k(samples, s.ctx.sampleRate));
    text = await transcribe(s, wav);
    if (s.hadError) {
      s.hadError = false;
      report('listening');
    }
    const norm = text.trim().toLowerCase();
    if (HALLUCINATIONS.has(norm) && durMs < 4000) text = '';
  } catch (e) {
    s.hadError = true;
    report('error', String((e && e.message) || e));
  } finally {
    s.inflight--;
  }
  // Emit transcripts strictly in order, even if requests finish out of order.
  s.results.set(id, text);
  while (s.results.has(s.nextEmit)) {
    const t = s.results.get(s.nextEmit);
    s.results.delete(s.nextEmit);
    s.nextEmit++;
    if (t && !s.dead) {
      s.transcript = (s.transcript + ' ' + t).slice(-400);
      s.buffer.push(t);
    }
  }
  if (s.inflight === 0 && !s.segmenter.inSpeech && s.segmenter.quietMs > 1300) s.buffer.flush();
}

async function transcribe(s, wav) {
  const cfg = s.stt;
  const url = STT_URLS[cfg.provider] || STT_URLS.groq;
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = new FormData();
    fd.append('file', wav, 'speech.wav');
    fd.append('model', cfg.model);
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    const prompt = s.transcript.trim().slice(-220);
    if (prompt) fd.append('prompt', prompt);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key }, body: fd });
    if (res.status === 429 || res.status >= 500) {
      const wait = parseFloat(res.headers.get('retry-after')) || 1.5 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(10, wait) * 1000));
      continue;
    }
    if (!res.ok) {
      let msg = 'STT HTTP ' + res.status;
      try { const j = await res.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (_) { /* ignore */ }
      if (res.status === 401) msg = 'Səs tanıma API açarı yanlışdır (401).';
      throw new Error(msg);
    }
    const data = await res.json();
    return String(data.text || '').trim();
  }
  throw new Error('Səs tanıma xidməti cavab vermir (limit). Bir az sonra yenidən yoxlayın.');
}
