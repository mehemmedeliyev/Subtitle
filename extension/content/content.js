/*
 * Content script: finds the video, collects its English subtitles, builds
 * complete sentences, asks the background for translations and draws the
 * translated subtitles on top of the video (also in full screen).
 */
(function () {
  'use strict';
  if (window.__gtContent) return;
  window.__gtContent = true;

  const S = self.GTSentences;
  const MIRROR_LABEL = 'GT Translation';

  let settings = Object.assign({}, self.GTDefaults);
  let video = null;

  // ---------- subtitle-mode state ----------
  let source = { kind: 'none', sig: '' };
  let sentences = [];
  const translations = new Map(); // English sentence -> translation
  const pending = new Set();
  const capturedFiles = []; // subtitle files seen by page-hook.js
  let noSourceSince = 0;
  let prefetchRunning = false;
  let changedTrack = null; // { track, mode } we changed, to restore later
  let failUntil = 0; // back-off after a failed translation request

  // ---------- live-mode state (DOM captions / audio) ----------
  let liveItems = []; // { text, tr, at }
  let liveBuffer = null;
  let domObserver = null;
  let domCaptionEls = [];
  let audioStatus = { status: 'idle', error: '' };
  let notice = null; // { text, until }

  // ======================================================================
  // Settings
  // ======================================================================
  chrome.storage.local.get(null, (stored) => {
    settings = Object.assign({}, self.GTDefaults, stored);
    applySiteSubsStyle();
    overlay.applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const prev = settings;
    const next = Object.assign({}, settings);
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue === undefined ? self.GTDefaults[k] : changes[k].newValue;
    settings = next;
    if (prev.targetLang !== next.targetLang || prev.provider !== next.provider || prev.claudeModel !== next.claudeModel) {
      translations.clear();
      pending.clear();
      liveItems.forEach((it) => { it.tr = null; retranslateLive(it); });
    }
    if (prev.mode !== next.mode || prev.enabled !== next.enabled) {
      liveItems = [];
      stopDomFallback();
      source = { kind: 'none', sig: '' };
      sentences = [];
      if (!next.enabled) restoreTrack();
    }
    if (prev.hideSiteSubs && !next.hideSiteSubs) {
      restoreTrack();
      source = { kind: 'none', sig: '' };
    }
    applySiteSubsStyle();
    overlay.applySettings();
    render();
  });

  function save(patch) {
    Object.assign(settings, patch);
    chrome.storage.local.set(patch);
  }

  // ======================================================================
  // Overlay (Shadow DOM so the page's CSS can't break it)
  // ======================================================================
  const overlay = (() => {
    const host = document.createElement('div');
    host.id = 'gt-subtitle-overlay';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;' +
      'z-index:2147483647;display:none;margin:0;padding:0;border:0;background:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          position: absolute; left: 50%; transform: translateX(-50%);
          pointer-events: auto; text-align: center; cursor: grab;
          font-family: "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif;
          user-select: none; -webkit-user-select: none; touch-action: none;
          box-sizing: border-box;
        }
        .box.dragging { cursor: grabbing; }
        .line { margin: 0.12em 0; line-height: 1.38; text-wrap: balance; }
        .line span.t {
          display: inline; padding: 0.08em 0.4em; border-radius: 0.18em;
          -webkit-box-decoration-break: clone; box-decoration-break: clone;
          color: #fff; font-weight: 600;
          text-shadow: 0 0 2px #000, 0 1px 3px #000, 0 0 6px rgba(0,0,0,.6);
        }
        .line .o {
          display: block; margin-top: 0.1em; font-size: 0.66em; font-weight: 500;
          color: #ffe28a; text-shadow: 0 0 2px #000, 0 1px 3px #000;
        }
        .line .o span { padding: 0.05em 0.35em; border-radius: 0.18em;
          -webkit-box-decoration-break: clone; box-decoration-break: clone; }
        .line.old { opacity: 0.55; font-size: 0.82em; }
        .line.wait span.t { color: #d8d8d8; font-weight: 500; font-style: italic; }
        .ctl {
          position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, -4px);
          display: flex; gap: 4px; opacity: 0; transition: opacity .15s;
          pointer-events: auto; white-space: nowrap;
        }
        .box:hover .ctl, .ctl:hover, .box.dragging .ctl { opacity: 1; }
        .ctl button {
          all: unset; cursor: pointer; font: 600 13px/1 "Segoe UI", Roboto, Arial, sans-serif;
          color: #fff; background: rgba(20,20,20,.85); border: 1px solid rgba(255,255,255,.25);
          border-radius: 6px; padding: 5px 8px; min-width: 16px; text-align: center;
        }
        .ctl button:hover { background: rgba(60,60,60,.95); }
        .ctl button.on { background: #6d4aff; border-color: #6d4aff; }
        .status {
          display: inline-block; margin-bottom: 4px; font: 500 12px/1.3 "Segoe UI", Roboto, Arial, sans-serif;
          color: #fff; background: rgba(0,0,0,.7); border-radius: 6px; padding: 3px 8px;
        }
        .status.err { background: rgba(170,30,30,.9); }
        .hidden { display: none !important; }
      </style>
      <div class="box" part="box">
        <div class="ctl">
          <button data-a="smaller" title="Kiçilt (Alt+Shift+↓)">A−</button>
          <button data-a="bigger" title="Böyüt (Alt+Shift+↑)">A+</button>
          <button data-a="orig" title="İngiliscə orijinalı göstər (Alt+Shift+E)">EN</button>
          <button data-a="lang" title="Dili dəyiş">AZ</button>
          <button data-a="off" title="Söndür (Alt+Shift+S)">✕</button>
        </div>
        <div class="status hidden"></div>
        <div class="lines"></div>
      </div>`;
    const box = root.querySelector('.box');
    const linesEl = root.querySelector('.lines');
    const statusEl = root.querySelector('.status');
    const btnOrig = root.querySelector('[data-a="orig"]');
    const btnLang = root.querySelector('[data-a="lang"]');
    let lastKey = '';
    let lastRect = '';
    let visible = false;

    root.querySelector('.ctl').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      e.preventDefault();
      const a = b.dataset.a;
      if (a === 'smaller') save({ fontSize: Math.max(12, settings.fontSize - 2) });
      if (a === 'bigger') save({ fontSize: Math.min(72, settings.fontSize + 2) });
      if (a === 'orig') save({ showOriginal: !settings.showOriginal });
      if (a === 'lang') save({ targetLang: settings.targetLang === 'az' ? 'tr' : 'az' });
      if (a === 'off') save({ enabled: false });
    }, true);
    // Keep clicks on the subtitles from pausing the video underneath.
    ['click', 'dblclick', 'mousedown', 'mouseup'].forEach((t) =>
      box.addEventListener(t, (e) => e.stopPropagation()));

    // Drag vertically to move the subtitles.
    let drag = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ctl') || e.button !== 0) return;
      drag = { y: e.clientY, pos: settings.posY, h: parseFloat(host.style.height) || 1 };
      box.classList.add('dragging');
      box.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      settings.posY = Math.min(88, Math.max(0, drag.pos - (dy / drag.h) * 100));
      applyBox();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      box.classList.remove('dragging');
      save({ posY: Math.round(settings.posY * 10) / 10 });
    };
    box.addEventListener('pointerup', endDrag);
    box.addEventListener('pointercancel', endDrag);

    function scale() {
      if (!settings.autoScale) return 1;
      const w = parseFloat(host.style.width) || 1000;
      return Math.min(2.4, Math.max(0.6, w / 1000));
    }

    function applyBox() {
      box.style.bottom = settings.posY + '%';
      box.style.maxWidth = settings.lineWidth + '%';
      box.style.width = 'max-content';
      box.style.fontSize = (settings.fontSize * scale()).toFixed(1) + 'px';
      const bg = 'rgba(0,0,0,' + settings.bgOpacity + ')';
      root.querySelectorAll('span.t, .o span').forEach((s) => { s.style.background = bg; });
    }

    function applySettings() {
      btnOrig.classList.toggle('on', !!settings.showOriginal);
      btnLang.textContent = (settings.targetLang || 'az').toUpperCase();
      lastKey = '';
      applyBox();
    }

    function parentForHost() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs && fs.tagName !== 'VIDEO') return fs;
      return document.body || document.documentElement;
    }

    function place(rect) {
      const parent = parentForHost();
      if (host.parentNode !== parent) parent.appendChild(host);
      const key = [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(',');
      if (key !== lastRect) {
        lastRect = key;
        host.style.left = rect.left + 'px';
        host.style.top = rect.top + 'px';
        host.style.width = rect.width + 'px';
        host.style.height = rect.height + 'px';
        applyBox();
      }
    }

    /** lines: [{tr, orig, old, wait}] */
    function show(lines, status) {
      const key = JSON.stringify([lines, status, settings.showOriginal]);
      if (key === lastKey) return;
      lastKey = key;
      linesEl.textContent = '';
      for (const l of lines) {
        const div = document.createElement('div');
        div.className = 'line' + (l.old ? ' old' : '') + (l.wait ? ' wait' : '');
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = l.tr;
        div.appendChild(t);
        if (settings.showOriginal && l.orig && l.orig !== l.tr) {
          const o = document.createElement('span');
          o.className = 'o';
          const inner = document.createElement('span');
          inner.textContent = l.orig;
          o.appendChild(inner);
          div.appendChild(o);
        }
        linesEl.appendChild(div);
      }
      if (status) {
        statusEl.textContent = status.text;
        statusEl.classList.toggle('err', !!status.error);
        statusEl.classList.remove('hidden');
      } else {
        statusEl.classList.add('hidden');
      }
      applyBox();
    }

    function setVisible(v) {
      if (v === visible) return;
      visible = v;
      host.style.display = v ? 'block' : 'none';
    }

    return { host, show, place, setVisible, applySettings };
  })();

  // Hide the site's own (English) subtitles while ours are active.
  const siteStyle = document.createElement('style');
  siteStyle.id = 'gt-site-subs-style';
  function applySiteSubsStyle() {
    const on = settings.enabled && settings.hideSiteSubs;
    const css = on ? `
      .jw-captions, .jw-text-track-container, .vjs-text-track-display, .plyr__captions,
      .mejs__captions-layer, .shaka-text-container, .fp-captions, .vds-captions,
      [data-gt-hidden] { opacity: 0 !important; }
      video::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; }
    ` : '';
    // Our own native fallback track (used only when the <video> itself is full screen).
    const mirrorCss = `video.gt-mirror::cue { color: #fff !important; background: rgba(0,0,0,${settings.bgOpacity}) !important;
      font-size: ${Math.round(settings.fontSize * 1.5)}px; text-shadow: 0 1px 3px #000 !important; }`;
    siteStyle.textContent = css + mirrorCss;
    if (!siteStyle.isConnected) (document.head || document.documentElement).appendChild(siteStyle);
  }

  // ======================================================================
  // Video discovery
  // ======================================================================
  function pickVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width < 160 || r.height < 90) continue;
      const area = r.width * r.height + (v.paused ? 0 : 1e7);
      if (area > bestArea) { best = v; bestArea = area; }
    }
    if (best !== video) {
      video = best;
      if (video) {
        ['seeked', 'play'].forEach((ev) => video.addEventListener(ev, () => { if (settings.mode === 'subtitle') prefetchAround(); }));
      }
    }
    return video;
  }

  // ======================================================================
  // Subtitle sources
  // ======================================================================
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__gt !== 'subs') return;
    const cues = S.parseSubtitleFile(e.data.text);
    if (!cues.length) return;
    const allText = cues.slice(0, 200).map((c) => c.text).join(' ');
    const lang = (e.data.lang || '').toLowerCase();
    let score = S.englishScore(allText);
    if (/^en|english|ingilis/.test(lang) || /[._/-]en([._-]|\.vtt|$)/i.test(e.data.url)) score += 0.3;
    const existing = capturedFiles.find((f) => f.url === e.data.url);
    if (existing) Object.assign(existing, { cues, score });
    else capturedFiles.push({ url: e.data.url, cues, score });
  });
  // Ask the page hook for subtitle files it caught before we were listening.
  window.postMessage({ __gt: 'hello' }, '*');

  function chooseTrack(v) {
    const tracks = Array.from(v.textTracks || []).filter((t) =>
      t.label !== MIRROR_LABEL && (t.kind === 'subtitles' || t.kind === 'captions'));
    if (!tracks.length) return null;
    return tracks.find((t) => /^en/i.test(t.language) || /english/i.test(t.label)) ||
      tracks.find((t) => t.mode === 'showing') || tracks[0];
  }

  function trackCues(t) {
    // A disabled track does not load its cues; "hidden" loads them without drawing.
    if (t.mode === 'disabled') {
      changedTrack = changedTrack || { track: t, mode: 'disabled' };
      t.mode = 'hidden';
    } else if (t.mode === 'showing' && settings.hideSiteSubs) {
      changedTrack = changedTrack || { track: t, mode: 'showing' };
      t.mode = 'hidden';
    }
    const list = t.cues;
    if (!list || !list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      out.push({ start: c.startTime, end: c.endTime, text: c.text || '' });
    }
    return out;
  }

  function restoreTrack() {
    if (changedTrack) {
      try { changedTrack.track.mode = changedTrack.mode; } catch (_) { /* ignore */ }
      changedTrack = null;
    }
  }

  function refreshSource() {
    if (!video) return;
    let cues = [];
    let kind = 'none';
    const tr = chooseTrack(video);
    if (tr) {
      cues = trackCues(tr);
      if (cues.length) kind = 'track';
    }
    if (!cues.length && capturedFiles.length) {
      const best = capturedFiles.slice().sort((a, b) => b.score - a.score)[0];
      if (best.score > 0.08) {
        cues = best.cues;
        kind = 'file';
      }
    }
    if (kind === 'none') {
      // Nothing in textTracks and no subtitle file: read the captions the
      // player draws on screen instead (live mode).
      if (!noSourceSince) noSourceSince = Date.now();
      if (Date.now() - noSourceSince > 3500) startDomFallback();
      source = { kind: domObserver ? 'dom' : 'none', sig: '' };
      sentences = [];
      return;
    }
    noSourceSince = 0;
    stopDomFallback();
    const sig = kind + ':' + cues.length + ':' + cues[0].start + ':' + cues[cues.length - 1].end;
    if (sig === source.sig) {
      if (video && !video.paused) prefetchAround();
      return;
    }
    source = { kind, sig };
    sentences = S.buildSentencesFromCues(cues);
    prefetchAround();
  }

  // ======================================================================
  // Translation (subtitle mode)
  // ======================================================================
  function requestTranslation(texts, context) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'translate', texts, context }, (res) => {
        if (chrome.runtime.lastError || !res) return resolve({ ok: false, error: 'Extension yenidən yükləndi – səhifəni yeniləyin.' });
        resolve(res);
      });
    });
  }

  function handleWarning(res) {
    if (res && res.warning) setNotice('Claude xətası: ' + res.warning + ' → Google istifadə olundu', 7000, true);
    if (res && !res.ok) setNotice('Tərcümə xətası: ' + res.error, 6000, true);
  }

  async function translateSentences(idxs) {
    const texts = [];
    for (const i of idxs) {
      const t = sentences[i] && sentences[i].text;
      if (t && !translations.has(t) && !pending.has(t) && !texts.includes(t)) texts.push(t);
    }
    if (!texts.length) return;
    texts.forEach((t) => pending.add(t));
    const first = idxs[0];
    const context = sentences.slice(Math.max(0, first - 3), first).map((s) => s.text);
    const res = await requestTranslation(texts, context);
    texts.forEach((t) => pending.delete(t));
    handleWarning(res);
    if (res.ok) {
      texts.forEach((t, k) => translations.set(t, res.translations[k]));
      render();
    } else {
      failUntil = Date.now() + 5000;
    }
    return res.ok;
  }

  function batchSize() {
    return settings.provider === 'claude' ? 15 : 6;
  }

  function prefetchAround() {
    if (!video || !sentences.length || !settings.enabled || settings.mode !== 'subtitle') return;
    if (Date.now() < failUntil) return;
    const i = Math.max(0, findSentence(video.currentTime));
    const near = [];
    for (let k = Math.max(0, i - 1); k < Math.min(sentences.length, i + 12); k++) {
      if (!translations.has(sentences[k].text) && !pending.has(sentences[k].text)) near.push(k);
    }
    const n = batchSize();
    // The first (currently visible) sentences go alone so they arrive fastest.
    if (near.length) translateSentences(near.slice(0, 2));
    for (let k = 2; k < near.length; k += n) translateSentences(near.slice(k, k + n));
    prefetchRest();
  }

  // Quietly translate what comes next (~40 sentences ahead) so there is never
  // a wait; re-armed every second as playback moves on.
  const PREFETCH_AHEAD = 40;
  async function prefetchRest() {
    if (prefetchRunning) return;
    prefetchRunning = true;
    try {
      while (settings.enabled && settings.mode === 'subtitle' && sentences.length) {
        const start = video ? Math.max(0, findSentence(video.currentTime)) : 0;
        const todo = [];
        const ahead = Math.min(sentences.length, PREFETCH_AHEAD);
        for (let pass = 0; pass < ahead && todo.length < batchSize() * 2; pass++) {
          const k = (start + pass) % sentences.length;
          const t = sentences[k].text;
          if (!translations.has(t) && !pending.has(t)) todo.push(k);
        }
        if (!todo.length || Date.now() < failUntil) break;
        if (!(await translateSentences(todo))) break;
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      prefetchRunning = false;
    }
  }

  function findSentence(t) {
    let lo = 0;
    let hi = sentences.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= t + 0.15) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function visibleSentence(t) {
    const i = findSentence(t);
    if (i < 0) return -1;
    const s = sentences[i];
    const next = sentences[i + 1];
    let until;
    if (next) until = next.start - s.end <= 2.5 ? next.start : s.end + 1.2;
    else until = s.end + 1.5;
    return t <= until ? i : -1;
  }

  // ======================================================================
  // Live mode: DOM caption fallback + audio
  // ======================================================================
  function getLiveBuffer() {
    if (!liveBuffer) {
      liveBuffer = new S.LiveSentenceBuffer((s) => addLive(s), { holdMs: 700, idleFlushMs: 5000 });
    }
    return liveBuffer;
  }

  function addLive(text) {
    const item = { text, tr: null, at: Date.now() };
    liveItems.push(item);
    if (liveItems.length > 8) liveItems.shift();
    retranslateLive(item);
    render();
  }

  async function retranslateLive(item) {
    const idx = liveItems.indexOf(item);
    const context = liveItems.slice(Math.max(0, idx - 3), idx).map((x) => x.text);
    const res = await requestTranslation([item.text], context);
    handleWarning(res);
    if (res.ok) {
      item.tr = res.translations[0];
      item.at = Date.now(); // reading time starts when the translation appears
      render();
    }
  }

  const CAPTION_SELECTORS = [
    '.jw-text-track-cue', '.jw-captions', '.vjs-text-track-display', '.plyr__captions',
    '.mejs__captions-text', '.shaka-text-container', '.ytp-caption-segment',
    '[class*="caption" i]', '[class*="subtitle" i]', '[class*="cue" i]',
  ].join(',');

  function findCaptionEls() {
    if (!video) return [];
    const vr = video.getBoundingClientRect();
    const scope = video.closest('.jwplayer, .video-js, .plyr, [class*="player" i]') ||
      (video.parentElement && video.parentElement.parentElement) || document.body;
    const els = Array.from(scope.querySelectorAll(CAPTION_SELECTORS)).filter((el) => {
      if (el === overlay.host || el.contains(video) || el.querySelector('video, button, input')) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > vr.top && r.top < vr.bottom && r.right > vr.left && r.left < vr.right;
    });
    // Keep only the outermost matches.
    return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  }

  function readDomCaptions() {
    domCaptionEls = findCaptionEls();
    const text = domCaptionEls.map((el) => el.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (settings.hideSiteSubs) domCaptionEls.forEach((el) => el.setAttribute('data-gt-hidden', ''));
    if (text) getLiveBuffer().push(text);
  }

  function startDomFallback() {
    if (domObserver || !video || settings.mode !== 'subtitle') return;
    const scope = video.closest('.jwplayer, .video-js, .plyr, [class*="player" i]') ||
      (video.parentElement && video.parentElement.parentElement) || document.body;
    let queued = false;
    domObserver = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; readDomCaptions(); }, 120);
    });
    domObserver.observe(scope, { subtree: true, childList: true, characterData: true });
    readDomCaptions();
  }

  function stopDomFallback() {
    if (!domObserver) return;
    domObserver.disconnect();
    domObserver = null;
    domCaptionEls.forEach((el) => el.removeAttribute('data-gt-hidden'));
    domCaptionEls = [];
    if (liveBuffer) liveBuffer.reset();
  }

  function liveLines() {
    const now = Date.now();
    const shown = liveItems.filter((it) => {
      if (!it.tr) return now - it.at < 8000;
      const words = S.wordCount(it.tr);
      return now - it.at < Math.max(4000, words * 450) + 2500;
    });
    const n = 1 + (settings.historyCount | 0);
    const last = shown.slice(-n);
    return last.map((it, k) => ({
      tr: it.tr || it.text,
      orig: it.text,
      old: k < last.length - 1,
      wait: !it.tr,
    }));
  }

  // ======================================================================
  // Rendering loop
  // ======================================================================
  function setNotice(text, ms, error) {
    notice = { text, until: Date.now() + ms, error };
  }

  function currentStatus() {
    if (notice && Date.now() < notice.until) return { text: notice.text, error: notice.error };
    if (settings.mode === 'audio') {
      if (audioStatus.status === 'error') return { text: '⚠ ' + audioStatus.error, error: true };
      if (audioStatus.status === 'idle') return { text: '🎧 Səs tərcüməsi dayanıb – extension menyusundan "▶ Başlat" düyməsini basın' };
      if (!liveItems.length) return { text: '🎧 Dinləyirəm…' };
    }
    return null;
  }

  function subtitleLines() {
    if (!video || !sentences.length) return [];
    const i = visibleSentence(video.currentTime);
    if (i < 0) return [];
    const lines = [];
    const h = settings.historyCount | 0;
    for (let k = Math.max(0, i - h); k < i; k++) {
      if (sentences[i].start - sentences[k].end > 6) continue;
      const t = sentences[k].text;
      lines.push({ tr: translations.get(t) || t, orig: t, old: true, wait: !translations.has(t) });
    }
    const t = sentences[i].text;
    lines.push({ tr: translations.get(t) || t, orig: t, old: false, wait: !translations.has(t) });
    if (!translations.has(t) && !pending.has(t)) prefetchAround();
    return lines;
  }

  // Fallback for when the <video> element itself is full screen (nothing
  // can be drawn over it then): mirror the text into a native text track.
  let mirrorTrack = null;
  let mirrorText = '';
  function updateMirror(lines) {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const active = fs && fs === video;
    if (!active) {
      if (mirrorTrack) { mirrorTrack.mode = 'disabled'; video && video.classList.remove('gt-mirror'); }
      mirrorText = '';
      return;
    }
    if (!mirrorTrack || !Array.from(video.textTracks).includes(mirrorTrack)) {
      mirrorTrack = video.addTextTrack('subtitles', MIRROR_LABEL, settings.targetLang);
    }
    video.classList.add('gt-mirror');
    mirrorTrack.mode = 'showing';
    const text = lines.map((l) => l.tr).join('\n');
    if (text === mirrorText) return;
    mirrorText = text;
    Array.from(mirrorTrack.cues || []).forEach((c) => mirrorTrack.removeCue(c));
    if (text) {
      const cue = new VTTCue(Math.max(0, video.currentTime - 0.5), video.currentTime + 3600, text);
      cue.line = -2;
      mirrorTrack.addCue(cue);
    }
  }

  function render() {
    if (!settings.enabled || !video) {
      overlay.setVisible(false);
      return;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) {
      overlay.setVisible(false);
      return;
    }
    let lines;
    if (settings.mode === 'audio' || source.kind === 'dom') lines = liveLines();
    else lines = subtitleLines();
    const status = currentStatus();
    updateMirror(lines);
    if (!lines.length && !status) {
      overlay.setVisible(false);
      return;
    }
    overlay.place(rect);
    overlay.show(lines, status);
    overlay.setVisible(true);
  }

  function frame() {
    try { render(); } catch (e) { if (!frame.logged) { frame.logged = true; console.warn("[GT] render error", e); } }
    requestAnimationFrame(frame);
  }

  setInterval(() => {
    if (!settings.enabled) return;
    pickVideo();
    if (settings.mode === 'subtitle') refreshSource();
  }, 1000);
  pickVideo();
  requestAnimationFrame(frame);
  // If audio translation is already running for this tab (e.g. after a reload), pick up its state.
  chrome.runtime.sendMessage({ type: 'audio-state' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    if (res.mine) audioStatus = { status: res.status, error: res.error || '' };
  });
  // Background tabs don't run requestAnimationFrame; keep timers alive anyway.
  setInterval(() => { if (document.hidden) render(); }, 500);

  document.addEventListener('fullscreenchange', () => render());

  // ======================================================================
  // Keyboard shortcuts
  // ======================================================================
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    let handled = true;
    if (e.code === 'ArrowUp') save({ fontSize: Math.min(72, settings.fontSize + 2) });
    else if (e.code === 'ArrowDown') save({ fontSize: Math.max(12, settings.fontSize - 2) });
    else if (e.code === 'KeyE') save({ showOriginal: !settings.showOriginal });
    else if (e.code === 'KeyS') save({ enabled: !settings.enabled });
    else if (e.code === 'KeyL') save({ targetLang: settings.targetLang === 'az' ? 'tr' : 'az' });
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ======================================================================
  // Messages from the popup / background
  // ======================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'live-sentence') {
      if (settings.mode === 'audio' && video) addLive(msg.text);
      return false;
    }
    if (msg.type === 'audio-status') {
      audioStatus = { status: msg.status, error: msg.error || '' };
      if (msg.status === 'listening') liveItems = liveItems.filter((x) => x.tr);
      render();
      return false;
    }
    if (msg.type === 'get-status') {
      pickVideo();
      if (!video) return false; // let a frame that has the video answer
      const translated = sentences.filter((s) => translations.has(s.text)).length;
      sendResponse({
        hasVideo: true,
        source: settings.mode === 'audio' ? 'audio' : source.kind,
        sentences: sentences.length,
        translated,
        live: liveItems.length,
      });
      return false;
    }
    if (msg.type === 'rescan') {
      window.postMessage({ __gt: 'rescan' }, '*');
      source = { kind: 'none', sig: '' };
      refreshSource();
      return false;
    }
    return false;
  });
})();
