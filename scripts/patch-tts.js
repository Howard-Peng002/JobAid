'use strict';
/* 用 Edge 神经语音替换系统 TTS */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'console.js');
let src = fs.readFileSync(file, 'utf8');

const START = '/** 语音模式：把题目读出来（用系统 TTS，不需要额外服务） */';
const END = 'function renderMock(st) {';
const s = src.indexOf(START);
const e = src.indexOf(END);
if (s < 0 || e < 0) {
  console.log('定位失败', s, e);
  process.exit(1);
}

const BLOCK = `/** 语音模式：用 Edge 神经语音念题（音质接近真人），失败时退回系统 TTS */
let mockAudio = null;

function fallbackSpeak(text, after) {
  if (!window.speechSynthesis) {
    if (after) after();
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const voices = (speechSynthesis.getVoices() || []).filter((v) => /zh/i.test(v.lang));
    const isMale = /Yun|男/i.test(mockOpt.voice);
    const pick =
      voices.find((v) => new RegExp(isMale ? 'Kangkang|Yun' : 'Huihui|Yaoyao|Xiaoxiao', 'i').test(v.name)) ||
      voices[0];
    if (pick) u.voice = pick;
    u.onend = () => after && after();
    u.onerror = () => after && after();
    speechSynthesis.speak(u);
  } catch (_) {
    if (after) after();
  }
}

async function speakQuestion(text) {
  if (!text) return;
  micSuspend = true;

  if (mockAudio) {
    try {
      mockAudio.pause();
    } catch (_) {}
    mockAudio = null;
  }
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}

  const after = () => {
    mockSpeaking = false;
    micSuspend = false;
    // 念完自动开麦，进入自动流转：说完静音够久就进下一题
    if (mockState.active && !mockState.done && mockState.mode === 'voice') {
      mockMicStart().then(() => {
        autoFlow = true;
        resetSilenceTimer();
      });
    }
  };

  mockSpeaking = true;
  try {
    const r = await window.api.mockTts({ text, voice: mockOpt.voice });
    if (r && r.ok && r.audio) {
      const audio = new Audio('data:audio/mpeg;base64,' + r.audio);
      mockAudio = audio;
      audio.onended = after;
      audio.onerror = after;
      await audio.play();
      return;
    }
    fallbackSpeak(text, after);
  } catch (_) {
    fallbackSpeak(text, after);
  }
}

function stopSpeaking() {
  if (mockAudio) {
    try {
      mockAudio.pause();
      mockAudio.currentTime = 0;
    } catch (_) {}
    mockAudio = null;
  }
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}
  mockSpeaking = false;
  micSuspend = false; // 别把麦克风永久静音
}

`;

src = src.slice(0, s) + BLOCK + src.slice(e);
fs.writeFileSync(file, src, 'utf8');
console.log('替换完成');
