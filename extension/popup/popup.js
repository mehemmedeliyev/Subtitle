/* Popup: settings, status of the current tab, start/stop audio mode. */
'use strict';

const D = self.GTDefaults;
let settings = Object.assign({}, D);
let tab = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.local.set(patch);
  refreshUi();
}

function fillSttModels() {
  const sel = $('#sttModel');
  const models = self.GTSttModels[settings.sttProvider] || [];
  sel.textContent = '';
  models.forEach((m) => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m + (m === models[0] ? ' (tövsiyə)' : '');
    sel.appendChild(o);
  });
  sel.value = models.includes(settings.sttModel) ? settings.sttModel : models[0];
}

function refreshUi() {
  $$('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else if (el.tagName !== 'SELECT' && document.activeElement !== el) el.value = settings[k] ?? '';
  });
  $$('[data-radio]').forEach((group) => {
    const k = group.dataset.radio;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings[k]));
  });
  $$('[data-show]').forEach((el) => {
    const [k, v] = el.dataset.show.split('=');
    el.toggleAttribute('data-hidden', settings[k] !== v);
  });
  $('#fontSizeVal').textContent = settings.fontSize + 'px';
  $('#lineWidthVal').textContent = settings.lineWidth + '%';
  $('#historyCountVal').textContent = String(settings.historyCount);
  $('#bgOpacityVal').textContent = Math.round(settings.bgOpacity * 100) + '%';
  fillSttModels();
}

function bind() {
  $$('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    const ev = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(ev, () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range') v = parseFloat(el.value);
      else v = el.value.trim();
      const patch = { [k]: v };
      // The free Groq key works for both speech recognition and translation.
      if (k === 'sttKey' && settings.sttProvider === 'groq' && !settings.groqKey) patch.groqKey = v;
      if (k === 'groqKey' && settings.sttProvider === 'groq' && !settings.sttKey) patch.sttKey = v;
      save(patch);
    });
  });
  $$('[data-radio]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const patch = { [group.dataset.radio]: b.dataset.value };
      if (group.dataset.radio === 'sttProvider') patch.sttModel = '';
      save(patch);
      if (group.dataset.radio === 'mode') setTimeout(updateStatus, 300);
    });
  });
  $$('[data-step]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const [k, d] = b.dataset.step.split(':');
      save({ [k]: Math.min(72, Math.max(12, settings[k] + parseFloat(d))) });
    });
  });
  $('#inject').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    if (!res.ok) setStatus('İşə salmaq alınmadı: ' + res.error, 'warn');
    setTimeout(updateStatus, 1500);
  });
  $('#audioStart').addEventListener('click', startAudio);
  $('#audioStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'audio-stop' });
    updateAudioState();
  });
}

function setStatus(text, cls) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

async function updateStatus() {
  if (!tab) return;
  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: 'get-status' });
  } catch (_) { /* no content script / no video */ }
  $('#inject').classList.toggle('hidden', !!st);
  if (!st) {
    setStatus('Bu səhifədə video tapılmadı. Gumroad-da video açın (və ya aşağıdakı düymə ilə bu səhifədə işə salın).', 'warn');
    return;
  }
  if (!settings.enabled) return setStatus('Deaktivdir. Yuxarıdakı düymə ilə aktiv edin.', 'warn');
  const kinds = {
    track: 'Video altyazısı tapıldı',
    file: 'Altyazı faylı tapıldı',
    dom: 'Ekrandakı altyazı oxunur (canlı rejim)',
    audio: 'Səs rejimi',
    none: 'Altyazı axtarılır… (CC düyməsini bir dəfə yandırın və ya "Səs tərcüməsi" rejimini seçin)',
  };
  let text = kinds[st.source] || st.source;
  if (st.source === 'track' || st.source === 'file') {
    text += ` · ${st.sentences} cümlə, ${st.translated} tərcümə olunub`;
  }
  setStatus(text, st.source === 'none' ? 'warn' : 'ok');
}

async function updateAudioState() {
  const st = await chrome.runtime.sendMessage({ type: 'audio-state' });
  const running = st && st.tabId != null && st.status !== 'idle';
  const here = running && tab && st.tabId === tab.id;
  $('#audioStart').disabled = !!here;
  $('#audioStop').disabled = !running;
  const names = { starting: 'Başlayır…', listening: '🎧 Dinləyir', error: '⚠ Xəta', idle: 'Dayanıb' };
  let t = running ? (here ? names[st.status] || st.status : 'Başqa tabda işləyir') : 'Dayanıb';
  if (st && st.error && st.status === 'error') t += ': ' + st.error;
  $('#audioState').textContent = t;
}

async function startAudio() {
  if (!settings.sttKey && !(settings.sttProvider === 'groq' && settings.groqKey)) {
    $('#audioState').textContent = 'Əvvəlcə səs tanıma API açarını daxil edin.';
    return;
  }
  $('#audioStart').disabled = true;
  $('#audioState').textContent = 'Başlayır…';
  try {
    // Must be called from a user gesture in the extension UI.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ type: 'audio-start', tabId: tab.id, streamId });
    if (!res.ok) throw new Error(res.error);
  } catch (e) {
    $('#audioState').textContent = '⚠ ' + (e.message || e);
    $('#audioStart').disabled = false;
    return;
  }
  updateAudioState();
}

(async function init() {
  const stored = await chrome.storage.local.get(null);
  settings = Object.assign({}, D, stored);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  bind();
  refreshUi();
  updateStatus();
  updateAudioState();
  setInterval(updateStatus, 2000);
  setInterval(updateAudioState, 2000);
})();
