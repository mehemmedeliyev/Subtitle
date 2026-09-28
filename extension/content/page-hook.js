/*
 * Runs in the page's own JavaScript world (MAIN) at document_start.
 *
 * Many players (JW Player, which Gumroad uses, Video.js, Plyr, ...) download
 * the .vtt/.srt subtitle file themselves and draw the captions with their own
 * HTML, so the text never reaches video.textTracks. Here we notice those
 * downloads and hand the whole file to the content script – with the full
 * file, sentences can be assembled completely *before* they are shown.
 */
(function () {
  'use strict';
  if (window.__gtPageHook) return;
  window.__gtPageHook = true;

  const seen = new Set();
  const captured = []; // kept so a content script that starts later can ask for them again

  function looksLikeSubs(url, text) {
    if (!text || text.length < 20) return false;
    const head = text.slice(0, 400);
    if (/^﻿?WEBVTT/.test(head)) return true;
    return /\d{1,2}:\d{2}[.,]\d{3}\s*-->\s*(\d+:)?\d{1,2}:\d{2}[.,]\d{3}/.test(head) &&
      (/\.(srt|vtt|webvtt)(\?|#|$)/i.test(url) || /^\s*\d+\s*\r?\n/.test(head));
  }

  function post(url, text, lang) {
    const key = url + '|' + text.length;
    if (seen.has(key)) return;
    seen.add(key);
    const msg = { __gt: 'subs', url: String(url), text, lang: lang || '' };
    captured.push(msg);
    window.postMessage(msg, '*');
  }

  function maybeSubsUrl(url, ct) {
    return /\.(srt|vtt|webvtt)(\?|#|$)/i.test(url) || /(text\/vtt|subrip|x-subrip)/i.test(ct || '') ||
      /caption|subtitle|transcript/i.test(url);
  }

  // --- fetch ---
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      p.then((res) => {
        try {
          const url = res.url || String((args[0] && args[0].url) || args[0]);
          const ct = res.headers.get('content-type') || '';
          if (!maybeSubsUrl(url, ct) && !/text\/plain/i.test(ct)) return;
          res.clone().text().then((t) => { if (looksLikeSubs(url, t)) post(url, t); }).catch(() => {});
        } catch (_) { /* ignore */ }
      }).catch(() => {});
      return p;
    };
  }

  // --- XMLHttpRequest ---
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url) {
      this.__gtUrl = url;
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      this.addEventListener('load', function () {
        try {
          if (this.responseType && this.responseType !== 'text') return;
          const url = this.responseURL || String(this.__gtUrl || '');
          const ct = this.getResponseHeader('content-type') || '';
          if (!maybeSubsUrl(url, ct) && !/text\/plain/i.test(ct)) return;
          const t = this.responseText;
          if (looksLikeSubs(url, t)) post(url, t);
        } catch (_) { /* ignore */ }
      });
      return send.apply(this, arguments);
    };
  }

  // --- JW Player: ask the player for its caption files directly ---
  // Covers the case where the extension was loaded after the player
  // already downloaded the subtitles.
  const fetched = new Set();
  function scanJw() {
    try {
      if (typeof window.jwplayer !== 'function') return;
      document.querySelectorAll('.jwplayer, [id^="jwplayer"]').forEach((el) => {
        let p;
        try { p = window.jwplayer(el.id || el); } catch (_) { return; }
        if (!p || typeof p.getPlaylistItem !== 'function') return;
        const item = p.getPlaylistItem();
        const tracks = (item && (item.tracks || item.captions)) || [];
        tracks.forEach((tr) => {
          const kind = (tr.kind || 'captions').toLowerCase();
          if (!tr.file || (kind !== 'captions' && kind !== 'subtitles')) return;
          const url = new URL(tr.file, location.href).href;
          if (fetched.has(url)) return;
          fetched.add(url);
          origFetch(url, { credentials: 'include' })
            .then((r) => r.text())
            .then((t) => { if (looksLikeSubs(url + '.vtt', t)) post(url, t, tr.language || tr.label || ''); })
            .catch(() => fetched.delete(url));
        });
      });
    } catch (_) { /* ignore */ }
  }
  let scans = 0;
  const timer = setInterval(() => {
    scanJw();
    if (++scans > 120) clearInterval(timer); // ~4 minutes
  }, 2000);
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__gt === 'hello' || e.data.__gt === 'rescan') captured.forEach((m) => window.postMessage(m, '*'));
    if (e.data.__gt === 'rescan') {
      fetched.clear();
      scanJw();
    }
  });
})();
