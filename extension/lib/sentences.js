/*
 * Sentence utilities shared by the content script and the offscreen (audio) page.
 *
 * The core problem this solves: subtitle cues (and speech-recognition chunks)
 * cut sentences in the middle. Translating a half sentence gives a wrong
 * translation, so everything here is about re-assembling *complete* sentences
 * before anything is sent to the translator.
 */
(function (root) {
  'use strict';

  // Words that end with "." but do not end a sentence.
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
    'eg', 'ie', 'no', 'nos', 'fig', 'figs', 'approx', 'inc', 'ltd', 'co', 'corp',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov',
    'dec', 'mt', 'ft', 'vol', 'ch', 'sec', 'min', 'max', 'u.s', 'u.k', 'a.m', 'p.m',
    'ca', 'cf', 'al', 'dept', 'est', 'govt', 'misc', 'ref', 'rev', 'resp', 'ver',
  ]);

  // If a "sentence" ends with one of these words it is almost certainly cut
  // off (speech recognisers love to put a period after every chunk).
  const DANGLING = new Set([
    'and', 'or', 'but', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'with',
    'for', 'from', 'by', 'that', 'which', 'who', 'because', 'so', 'is', 'are',
    'was', 'were', 'be', 'if', 'when', 'while', 'like', 'your', 'my', 'our',
    'their', 'his', 'her', 'its', 'this', 'these', 'those', 'than', 'then',
    'as', 'into', 'onto', 'about', 'we', 'you', "you're", "we're", "it's",
    'i', "i'm", 'can', 'will', 'would', 'should', 'could', 'just', 'also',
    'very', 'really', 'some', 'any', 'more', 'most', 'where', 'how', 'what',
  ]);

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

  function decodeEntities(s) {
    return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      const low = e.toLowerCase();
      if (ENTITIES[low] !== undefined) return ENTITIES[low];
      if (low[0] === '#') {
        const code = low[1] === 'x' ? parseInt(low.slice(2), 16) : parseInt(low.slice(1), 10);
        if (!isNaN(code)) return String.fromCodePoint(code);
      }
      return m;
    });
  }

  /** Normalise raw cue / caption text into a single clean line. */
  function cleanText(t) {
    if (!t) return '';
    let s = String(t)
      .replace(/<[^>]*>/g, ' ') // VTT tags: <c>, <i>, <v Speaker>, timestamps
      .replace(/\{\\[^}]*\}/g, ' '); // SSA style tags
    s = decodeEntities(s)
      .replace(/\[[^\]]{0,40}\]/g, ' ') // [music], [laughs]
      .replace(/\([^)]{0,25}(music|laugh|applause|inaudible|silence)[^)]{0,10}\)/gi, ' ')
      .replace(/♪+/g, ' ')
      .replace(/^\s*(>>|-)\s*/gm, '') // speaker change markers
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  function wordCount(s) {
    const m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function lastWord(s) {
    const m = s.match(/([A-Za-z][A-Za-z'.]*)\W*$/);
    return m ? m[1].toLowerCase().replace(/\.+$/, '') : '';
  }

  /**
   * Returns the character positions (exclusive end indices) where sentences end.
   * `atEndIsFinal` – whether a terminator at the very end of the text counts.
   */
  function findSentenceEnds(text, atEndIsFinal) {
    const ends = [];
    const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    let m;
    while ((m = re.exec(text))) {
      const endIdx = m.index + m[0].length;
      const punct = m[0];
      const rest = text.slice(endIdx);
      const nextChar = (rest.match(/\S/) || [''])[0];
      if (endIdx >= text.length && !atEndIsFinal) continue;

      if (/^[.…]/.test(punct) && !/[!?]/.test(punct)) {
        // Word right before the period.
        const before = text.slice(0, m.index);
        const wm = before.match(/([A-Za-z][A-Za-z.]*)$/);
        const word = wm ? wm[1] : '';
        if (word && punct === '.') {
          if (ABBREVIATIONS.has(word.toLowerCase())) continue;
          if (/^[A-Z]$/.test(word)) continue; // initials: "J. R. R."
        }
        // A lowercase continuation means it wasn't really a sentence end.
        if (nextChar && /[a-z]/.test(nextChar)) continue;
      }
      ends.push(endIdx);
    }
    return ends;
  }

  /**
   * Remove text that is repeated because of "rolling" captions
   * (each cue repeats the previous line and adds a few words).
   * Returns the part of `next` that is new compared to `prev`.
   */
  function removeOverlap(prev, next) {
    if (!prev || !next) return next;
    const p = prev.toLowerCase();
    const n = next.toLowerCase();
    if (p.endsWith(n)) return '';
    if (n.startsWith(p) && p.length > 0) return next.slice(prev.length).trim();
    const pw = prev.split(' ');
    const nw = next.split(' ');
    const max = Math.min(pw.length, nw.length, 40);
    for (let k = max; k >= 3; k--) {
      const tail = pw.slice(pw.length - k).join(' ').toLowerCase();
      const head = nw.slice(0, k).join(' ').toLowerCase();
      if (tail === head) return nw.slice(k).join(' ');
    }
    return next;
  }

  /**
   * Build complete sentences from a full list of timed cues
   * ({start, end, text}). Used when the whole subtitle file is available.
   * Each sentence gets {text, start, end} in seconds.
   */
  function buildSentencesFromCues(rawCues, opts) {
    const o = Object.assign({ maxWords: 45, maxDuration: 16 }, opts || {});
    const cues = rawCues
      .map((c) => ({ start: +c.start, end: +c.end, text: cleanText(c.text) }))
      .filter((c) => c.text && isFinite(c.start) && isFinite(c.end))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    // Concatenate into one stream while remembering where each cue lives.
    let full = '';
    const segs = [];
    let prevText = '';
    for (const c of cues) {
      let t = removeOverlap(prevText, c.text);
      if (c.text === prevText) t = '';
      prevText = c.text;
      if (!t) {
        // Duplicate cue – just stretch the previous segment in time.
        if (segs.length) segs[segs.length - 1].end = Math.max(segs[segs.length - 1].end, c.end);
        continue;
      }
      if (full) full += ' ';
      const from = full.length;
      full += t;
      segs.push({ from, to: full.length, start: c.start, end: Math.max(c.end, c.start + 0.05) });
    }
    if (!full) return [];

    const timeAt = (idx, isEnd) => {
      // Binary search segment containing idx.
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid].from <= idx) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      const len = Math.max(1, s.to - s.from);
      const frac = Math.min(1, Math.max(0, (idx - s.from + (isEnd ? 1 : 0)) / len));
      return s.start + frac * (s.end - s.start);
    };

    // Segment boundaries are good fall-back split points for run-on text.
    const boundaries = segs.map((s) => s.to);

    const ends = findSentenceEnds(full, true);
    if (!ends.length || ends[ends.length - 1] < full.length) ends.push(full.length);

    const sentences = [];
    let start = 0;
    for (const e of ends) {
      let piece = full.slice(start, e);
      let pieceStart = start;
      // Split sentences that run too long (subtitles without punctuation).
      while (wordCount(piece) > o.maxWords ||
        timeAt(pieceStart + piece.length - 1, true) - timeAt(pieceStart, false) > o.maxDuration) {
        const cut = pickSplit(full, pieceStart, pieceStart + piece.length, boundaries, o);
        if (!cut) break;
        pushSentence(sentences, full.slice(pieceStart, cut), pieceStart, cut, timeAt);
        pieceStart = cut;
        piece = full.slice(pieceStart, e);
      }
      pushSentence(sentences, piece, pieceStart, e, timeAt);
      start = e;
    }
    return sentences;
  }

  function pickSplit(full, from, to, boundaries, o) {
    // Candidate split positions: cue boundaries and commas/semicolons inside the range.
    const cands = [];
    for (const b of boundaries) if (b > from && b < to) cands.push(b);
    const re = /[,;:—–]\s/g;
    re.lastIndex = from;
    let m;
    while ((m = re.exec(full)) && m.index < to) cands.push(m.index + 1);
    if (!cands.length) return 0;
    const limitWords = Math.max(8, Math.floor(o.maxWords * 0.75));
    let best = 0;
    let bestScore = -Infinity;
    for (const c of cands) {
      const wc = wordCount(full.slice(from, c));
      if (wc < 4) continue;
      const before = full.slice(Math.max(from, c - 2), c);
      const punctBonus = /[,;:—–]\s?$/.test(before) ? 6 : 0;
      const score = punctBonus - Math.abs(wc - limitWords) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  function pushSentence(list, piece, from, to, timeAt) {
    const text = piece.trim();
    if (!text || !/[A-Za-z0-9]/.test(text)) return;
    const lead = piece.length - piece.trimStart().length;
    const trail = piece.length - piece.trimEnd().length;
    const start = timeAt(from + lead, false);
    const end = timeAt(Math.max(from + lead, to - trail - 1), true);
    list.push({ text, start, end: Math.max(end, start + 0.3) });
  }

  /**
   * Incremental sentence assembler for *live* text (DOM captions or speech
   * recognition). Text is pushed as it arrives; complete sentences are emitted
   * through `onSentence`. The last sentence is briefly held back so that a
   * continuation (lowercase start, dangling word) can be merged into it.
   */
  class LiveSentenceBuffer {
    constructor(onSentence, opts) {
      this.onSentence = onSentence;
      this.o = Object.assign({ holdMs: 900, idleFlushMs: 6000, maxWords: 45, dedupe: true }, opts || {});
      this.buf = '';
      this.lastRaw = '';
      this.timer = null;
    }

    /** Push a new piece of text. `replace` = the caption element's full current text. */
    push(raw) {
      const text = cleanText(raw);
      if (!text) return;
      let add = text;
      if (this.o.dedupe) {
        if (text === this.lastRaw) return;
        add = removeOverlap(this.lastRaw, text);
        if (this.buf) add = removeOverlap(this.buf, add);
        this.lastRaw = text;
      }
      if (!add) return;
      this.buf = this.join(this.buf, add);
      this.process(false);
    }

    join(a, b) {
      if (!a) return b;
      // Undo a premature period if the new text is clearly a continuation.
      if (/[a-z]/.test(b[0]) && /[.…]$/.test(a) && !/\.\.\.$/.test(a)) {
        const lw = lastWord(a);
        if (!ABBREVIATIONS.has(lw)) a = a.replace(/[.…]+$/, '');
      }
      return a + ' ' + b;
    }

    /**
     * Emit every confirmed sentence. With `force` (called after a quiet
     * period) the remaining tail is emitted too, even without a terminator.
     */
    process(force) {
      clearTimeout(this.timer);
      this.timer = null;
      const ends = findSentenceEnds(this.buf, true);
      let start = 0;
      let held = false;
      for (const e of ends) {
        const sentence = this.buf.slice(start, e).trim();
        const atEnd = this.buf.slice(e).trim() === '';
        if (atEnd && !force) {
          // Hold the last sentence a moment: more words may still belong to it.
          held = !DANGLING.has(lastWord(sentence));
          break;
        }
        this.emit(sentence);
        start = e;
      }
      this.buf = this.buf.slice(start).trim();

      // Run-on text without punctuation: split at a comma near the limit.
      while (this.o.maxWords && wordCount(this.buf) > this.o.maxWords) {
        const words = this.buf.split(' ');
        let cut = Math.floor(this.o.maxWords * 0.75);
        for (let i = cut; i > 6; i--) {
          if (/[,;:]$/.test(words[i - 1])) { cut = i; break; }
        }
        this.emit(words.slice(0, cut).join(' '));
        this.buf = words.slice(cut).join(' ');
      }

      if (!this.buf) return;
      if (force) {
        this.emit(this.buf);
        this.buf = '';
        return;
      }
      // Flush after a quiet period (every push re-arms this timer).
      this.timer = setTimeout(() => this.process(true), held ? this.o.holdMs : this.o.idleFlushMs);
    }

    emit(s) {
      s = s.trim();
      if (s && /[A-Za-z0-9]/.test(s)) this.onSentence(s);
    }

    flush() {
      this.process(true);
      if (this.buf) {
        this.emit(this.buf);
        this.buf = '';
      }
    }

    reset() {
      clearTimeout(this.timer);
      this.timer = null;
      this.buf = '';
      this.lastRaw = '';
    }
  }

  /** Parse a WebVTT or SRT file into cues. */
  function parseSubtitleFile(text) {
    const cues = [];
    const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = src.split(/\n{2,}/);
    const timeRe = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    for (const block of blocks) {
      const lines = block.split('\n');
      const idx = lines.findIndex((l) => timeRe.test(l));
      if (idx < 0) continue;
      const m = lines[idx].match(timeRe);
      const body = lines.slice(idx + 1).join('\n').trim();
      if (!body) continue;
      cues.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: body });
    }
    return cues;
  }

  function parseTime(t) {
    const parts = t.replace(',', '.').split(':').map(parseFloat);
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s;
  }

  /** Rough check that a piece of text is English (to pick the right subtitle file). */
  function englishScore(text) {
    const words = (text.toLowerCase().match(/[a-z']+/g) || []).slice(0, 600);
    if (words.length < 5) return 0;
    const common = new Set(['the', 'and', 'you', 'to', 'is', 'it', 'of', 'that', 'this', 'we', 'in', 'a', 'so', 'can', 'what', 'with', 'for', 'on', 'be', 'are', 'just', 'i', 'have', 'going']);
    let hit = 0;
    for (const w of words) if (common.has(w)) hit++;
    return hit / words.length;
  }

  const api = {
    cleanText,
    findSentenceEnds,
    removeOverlap,
    buildSentencesFromCues,
    LiveSentenceBuffer,
    parseSubtitleFile,
    englishScore,
    wordCount,
  };
  root.GTSentences = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
