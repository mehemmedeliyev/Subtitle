/*
 * Translation back-ends. Runs in the background service worker (which has the
 * host permissions, so there are no CORS problems).
 *
 *  - google: free, no key. Translates each sentence separately.
 *  - claude: needs an Anthropic API key. Translates a batch of sentences in
 *            one request, with the previous sentences as context, so the
 *            result reads naturally and keeps the meaning of the lecture.
 */
(function (root) {
  'use strict';

  const LANG_NAMES = { az: 'Azerbaijani (Latin script)', tr: 'Turkish' };

  const cache = new Map();
  const CACHE_MAX = 5000;

  function cacheKey(provider, target, text) {
    return provider + '|' + target + '|' + text;
  }

  function remember(key, value) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }

  function firstString(x) {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) for (const y of x) { const s = firstString(y); if (s) return s; }
    return '';
  }

  // Two free Google endpoints; the second one is used if the first is rate-limited.
  const GOOGLE_ENDPOINTS = [
    (text, tl) => ({
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
        encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text),
      parse: (data) => (data[0] || []).map((p) => p[0]).filter(Boolean).join(''),
    }),
    (text, tl) => ({
      url: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=' +
        encodeURIComponent(tl) + '&q=' + encodeURIComponent(text),
      parse: (data) => firstString(data),
    }),
  ];

  async function googleTranslateOne(text, target) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ep = GOOGLE_ENDPOINTS[attempt % GOOGLE_ENDPOINTS.length](text, target);
      try {
        const res = await fetch(ep.url);
        if (!res.ok) throw new Error('Google HTTP ' + res.status);
        const out = ep.parse(await res.json()).trim();
        if (!out) throw new Error('Google: boş cavab');
        return out;
      } catch (e) {
        lastErr = e;
        if (attempt % 2 === 1) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }

  async function googleTranslate(texts, target) {
    // Small concurrency pool – fast, but gentle on the free endpoint.
    const out = new Array(texts.length);
    let i = 0;
    const worker = async () => {
      while (i < texts.length) {
        const k = i++;
        out[k] = await googleTranslateOne(texts[k], target);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, texts.length) }, worker));
    return out;
  }

  const CLAUDE_SCHEMA = {
    type: 'object',
    properties: {
      translations: { type: 'array', items: { type: 'string' } },
    },
    required: ['translations'],
    additionalProperties: false,
  };

  function systemPrompt(target) {
    const lang = LANG_NAMES[target] || target;
    return [
      'You translate English video subtitles (online course / tutorial speech) into ' + lang + '.',
      'You receive a JSON object with "context" (earlier sentences, for reference only) and "sentences" (to translate).',
      'Return exactly one translation per item in "sentences", in the same order.',
      'Translate the meaning, not word by word: the viewer must fully understand what the speaker means.',
      'The speech may be informal, contain filler words, slang, idioms or non-native / regional English; render it as natural spoken ' + lang + '.',
      'Keep software names, UI labels, menu items and technical terms that are normally left in English (for example "Shader Editor", "Area light") in English, optionally with a short ' + lang + ' explanation in parentheses the first time they appear.',
      'Keep numbers and units. Do not add notes or commentary.',
    ].join('\n');
  }

  async function claudeTranslate(texts, context, target, settings) {
    const key = (settings.claudeKey || '').trim();
    if (!key) throw new Error('Claude API açarı yoxdur');
    const body = {
      model: settings.claudeModel || 'claude-opus-5',
      max_tokens: 16000,
      system: systemPrompt(target),
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: CLAUDE_SCHEMA },
      },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: JSON.stringify({ context: context || [], sentences: texts }),
      }],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = 'Claude HTTP ' + res.status;
      try {
        const err = await res.json();
        if (err && err.error && err.error.message) msg += ': ' + err.error.message;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Claude refused the request');
    const textBlock = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(textBlock);
    const list = parsed && parsed.translations;
    if (!Array.isArray(list) || list.length !== texts.length) {
      throw new Error('Claude returned ' + (list ? list.length : 0) + ' of ' + texts.length + ' translations');
    }
    return list.map((s) => String(s).trim());
  }

  // Free AI translation through Groq (same free key as speech recognition).
  // If a model is retired, the next one in the list is tried.
  const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];

  function groqKey(settings) {
    return (settings.groqKey || (settings.sttProvider === 'groq' ? settings.sttKey : '') || '').trim();
  }

  async function groqTranslate(texts, context, target, settings) {
    const key = groqKey(settings);
    if (!key) throw new Error('Groq API açarı yoxdur');
    const models = settings.groqModel ? [settings.groqModel].concat(GROQ_MODELS.filter((m) => m !== settings.groqModel)) : GROQ_MODELS;
    let lastErr;
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const body = {
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt(target) + '\nAnswer only with JSON: {"translations": ["...", ...]}.' },
            { role: 'user', content: JSON.stringify({ context: context || [], sentences: texts }) },
          ],
        };
        if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          // Free-tier rate limit: wait as told, then retry.
          const wait = parseFloat(res.headers.get('retry-after')) || 2 * (attempt + 1);
          lastErr = new Error('Groq limit (HTTP ' + res.status + ')');
          await new Promise((r) => setTimeout(r, Math.min(8, wait) * 1000));
          continue;
        }
        if (!res.ok) {
          let msg = 'Groq HTTP ' + res.status;
          try {
            const err = await res.json();
            if (err && err.error && err.error.message) msg += ': ' + err.error.message;
          } catch (_) { /* ignore */ }
          if (res.status === 401) throw new Error('Groq API açarı yanlışdır (401)');
          lastErr = new Error(msg);
          break; // e.g. model retired – try the next model
        }
        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        let list;
        try { list = JSON.parse(content).translations; } catch (_) { list = null; }
        if (Array.isArray(list) && list.length === texts.length) return list.map((s) => String(s).trim());
        lastErr = new Error('Groq returned ' + (Array.isArray(list) ? list.length : 0) + ' of ' + texts.length + ' translations');
      }
    }
    throw lastErr;
  }

  /**
   * Translate `texts` (array of complete sentences). Returns
   * { translations: string[], provider, warning? }.
   */
  async function translateBatch(texts, context, settings) {
    const target = settings.targetLang || 'az';
    const provider = settings.provider || 'google';
    const result = new Array(texts.length);
    const missing = [];
    texts.forEach((t, i) => {
      const hit = cache.get(cacheKey(provider, target, t));
      if (hit !== undefined) result[i] = hit;
      else missing.push(i);
    });
    if (!missing.length) return { translations: result, provider };

    const todo = missing.map((i) => texts[i]);
    let translated;
    let used = provider;
    let warning;
    if (provider === 'claude' || provider === 'groq') {
      try {
        translated = provider === 'claude'
          ? await claudeTranslate(todo, context, target, settings)
          : await groqTranslate(todo, context, target, settings);
      } catch (e) {
        warning = String(e.message || e);
        used = 'google';
      }
    }
    if (!translated) translated = await googleTranslate(todo, target);

    missing.forEach((idx, k) => {
      result[idx] = translated[k];
      remember(cacheKey(used, target, texts[idx]), translated[k]);
    });
    return { translations: result, provider: used, warning };
  }

  root.GTTranslate = { translateBatch };
})(typeof self !== 'undefined' ? self : globalThis);
