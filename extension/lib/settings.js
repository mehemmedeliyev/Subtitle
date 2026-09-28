/* Default settings, shared by the popup, content script and background. */
(function (root) {
  'use strict';
  root.GTDefaults = {
    enabled: true,
    mode: 'subtitle', // 'subtitle' = translate the video's subtitles, 'audio' = listen to the speech
    targetLang: 'az', // 'az' | 'tr'
    provider: 'google', // 'google' (free) | 'claude' (API key, best quality)
    claudeKey: '',
    claudeModel: 'claude-opus-5',
    sttProvider: 'groq', // speech recognition: 'groq' | 'openai'
    sttKey: '',
    sttModel: '',
    fontSize: 28, // px at a 1000px wide video
    autoScale: true, // grow/shrink with the video (bigger in full screen)
    lineWidth: 70, // max subtitle width, % of the video width
    historyCount: 1, // how many previous sentences stay visible above the current one
    showOriginal: false, // also show the English sentence
    hideSiteSubs: true, // hide the site's own English subtitles
    bgOpacity: 0.65,
    posY: 9, // distance from the bottom of the video, % of its height
  };
  root.GTSttModels = {
    groq: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    openai: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  };
})(typeof self !== 'undefined' ? self : globalThis);
