/* Background service worker: translation requests, audio-mode orchestration. */
importScripts('lib/settings.js', 'lib/translate.js');

const OFFSCREEN_URL = 'offscreen/offscreen.html';

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return Object.assign({}, self.GTDefaults, stored);
}

async function getAudioState() {
  const { audio } = await chrome.storage.session.get('audio');
  return audio || { tabId: null, status: 'idle', error: '' };
}

async function setAudioState(patch) {
  const next = Object.assign(await getAudioState(), patch);
  await chrome.storage.session.set({ audio: next });
  return next;
}

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* tab without our content script */ });
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function sendToOffscreen(msg) {
  // The document may still be starting up – retry a few times.
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
    } catch (e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Offscreen document did not respond');
}

async function startAudio(tabId, streamId) {
  const current = await getAudioState();
  if (current.tabId != null && current.status !== 'idle') await stopAudio();

  const settings = await getSettings();
  // One free Groq key serves both speech recognition and AI translation.
  const sttKey = (settings.sttKey || (settings.sttProvider === 'groq' ? settings.groqKey : '') || '').trim();
  if (!sttKey) throw new Error('Səs tanıma üçün API açarı daxil edin (Groq pulsuzdur).');

  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture the tab audio to recognise speech for live translation.',
    });
  }
  await setAudioState({ tabId, status: 'starting', error: '' });
  const res = await sendToOffscreen({
    type: 'start',
    streamId,
    stt: {
      provider: settings.sttProvider,
      key: sttKey,
      model: settings.sttModel || self.GTSttModels[settings.sttProvider][0],
    },
  });
  if (!res || !res.ok) {
    await stopAudio();
    throw new Error((res && res.error) || 'Səs tutula bilmədi');
  }
  await setAudioState({ status: 'listening' });
  sendToTab(tabId, { type: 'audio-status', status: 'listening' });
}

async function stopAudio() {
  const state = await getAudioState();
  if (await hasOffscreen()) {
    try { await sendToOffscreen({ type: 'stop' }); } catch (_) { /* ignore */ }
    try { await chrome.offscreen.closeDocument(); } catch (_) { /* ignore */ }
  }
  if (state.tabId != null) sendToTab(state.tabId, { type: 'audio-status', status: 'idle' });
  await setAudioState({ tabId: null, status: 'idle' });
}

async function injectInto(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/page-hook.js'],
    world: 'MAIN',
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['lib/settings.js', 'lib/sentences.js', 'content/content.js'],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  const reply = (promise) => {
    promise
      .then((r) => sendResponse(Object.assign({ ok: true }, r || {})))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  };

  switch (msg.type) {
    case 'translate':
      return reply(getSettings().then((s) => self.GTTranslate.translateBatch(msg.texts, msg.context, s)));

    case 'audio-start':
      return reply(startAudio(msg.tabId, msg.streamId));

    case 'audio-stop':
      return reply(stopAudio());

    case 'audio-state':
      return reply(getAudioState().then((st) =>
        Object.assign({}, st, { mine: !!(sender.tab && sender.tab.id === st.tabId) })));

    case 'inject':
      return reply(injectInto(msg.tabId));

    // ---- from the offscreen document ----
    case 'audio-sentence':
      getAudioState().then((s) => sendToTab(s.tabId, { type: 'live-sentence', text: msg.text }));
      return false;

    case 'audio-status':
      setAudioState({ status: msg.status, error: msg.error || '' }).then((s) => {
        sendToTab(s.tabId, { type: 'audio-status', status: msg.status, error: msg.error || '' });
      });
      return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getAudioState();
  if (s.tabId === tabId) stopAudio();
});
