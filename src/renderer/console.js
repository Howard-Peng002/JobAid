'use strict';
/* 控制台渲染进程：音频采集、字幕、设置 */

const $ = (id) => document.getElementById(id);

let cfg = null;
let profilesState = { items: [], activeId: '' };
let pendingRename = false;
let editingProviderId = '';
let listening = false;
let captures = [];
let displayStream = null;
let currentAnswer = '';
let levelBuf = { interviewer: 0, me: 0 };
let chStat = { interviewer: { peak: 0, count: 0 }, me: { peak: 0, count: 0 } };
let reasoningStepDone = false;
let listenStartAt = 0;
let warnedNoSys = false;

/* ------------------------------------------------------- 模拟面试 */
const MOCK_DIMS = [
  ['depth', '技术深度'],
  ['clarity', '表达清晰'],
  ['structure', '结构完整'],
  ['match', '岗位匹配'],
];

let mockState = { active: false };
const MOCK_VOICES = [
  ['zh-CN-XiaoxiaoNeural', '女 · 晓晓（温柔）'],
  ['zh-CN-XiaoyiNeural', '女 · 晓伊（活泼）'],
  ['zh-CN-liaoning-XiaobeiNeural', '女 · 晓北（东北）'],
  ['zh-CN-YunxiNeural', '男 · 云希（年轻）'],
  ['zh-CN-YunjianNeural', '男 · 云健（沉稳）'],
  ['zh-CN-YunyangNeural', '男 · 云扬（播报）'],
  ['zh-CN-YunxiaNeural', '男 · 云夏（少年）'],
];

function fillVoiceSelects() {
  ['selVoice', 'selVoiceSetup'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const keep = el.value;
    el.innerHTML = '';
    MOCK_VOICES.forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      el.appendChild(o);
    });
    el.value = keep || mockOpt.voice;
  });
}

let mockOpt = { type: 'tech', mode: 'text', count: 5, voice: 'zh-CN-XiaoxiaoNeural' };
let mockMic = null;
let mockMicOn = false;
let mockSpeaking = false;
let micSuspend = false; // 念题期间丢弃麦克风输入，避免把 TTS 的声音当成回答
let lastLevelReset = 0;
const ttsCache = new Map(); // voice|text -> base64，避免每次念题都现合成

function ttsKey(text, voice) {
  return voice + '|' + text;
}

/** 预生成音频：题目一确定就后台合成，等用户听完回答时早就准备好了 */
function prefetchTts(text, voice) {
  const t = String(text || '');
  if (!t) return;
  const key = ttsKey(t, voice);
  if (ttsCache.has(key) || ttsCache.size > 60) return;
  window.api
    .mockTts({ text: t, voice })
    .then((r) => {
      if (r && r.ok && r.audio) ttsCache.set(key, r.audio);
    })
    .catch(() => {});
}
let lastAiSpeech = ''; // 面试官最近念过的题，用来识别「把 AI 的声音当成了我的话」
let liveBubble = null; // 当前正在说的那条气泡，识别出新词就往里追加
let autoFlow = false; // 语音模式的自动流转（念完自动开麦、说完自动下一题）
let silenceTimer = null;
const AUTO_SILENCE_MS = 7000; // 说话中间停顿很正常，太短会「没答完就跳题」

function renderMockProfiles() {
  const sel = $('mockProfile');
  if (!sel) return;
  const items = profilesState.items || [];
  const cur = activeProfile();
  sel.innerHTML = '';
  items.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    if (cur && p.id === cur.id) o.selected = true;
    sel.appendChild(o);
  });
}

/** 语音模式：用 Edge 神经语音念题（音质接近真人），失败时退回系统 TTS */
let mockAudio = null;

let mockCtx = null;
let mockSource = null;

/** 用 Web Audio 解码播放：比 <audio> 稳，mp3 支持问题也绕开了 */
async function playBase64Audio(b64, onEnd) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!mockCtx) mockCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (mockCtx.state === 'suspended') await mockCtx.resume();
  const buf = await mockCtx.decodeAudioData(bytes.buffer.slice(0));
  const src = mockCtx.createBufferSource();
  src.buffer = buf;
  src.connect(mockCtx.destination);
  src.onended = () => {
    if (mockSource === src) mockSource = null;
    if (onEnd) onEnd();
  };
  mockSource = src;
  src.start();
}

function stopPlayback() {
  if (mockSource) {
    try {
      mockSource.stop();
    } catch (_) {}
    mockSource = null;
  }
}

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
  lastAiSpeech = String(text);

  stopPlayback();
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}

  let stageDone = false;
  const after = () => {
    if (stageDone) return;
    stageDone = true;
    clearTimeout(stageGuard);
    mockSpeaking = false;
    micSuspend = false;
    // 念完自动开麦，进入自动流转：说完静音够久就进下一题
    if (mockState.active && !mockState.done && mockState.mode === 'voice') {
      mockMicStart().then(() => {
        autoFlow = true;
        resetSilenceTimer();
        setCallStage('请回答，说完点「我说完了」或停顿几秒', 'listening');
      });
    }
  };

  mockSpeaking = true;
  setCallStage('面试官正在提问…', 'speaking');
  const stageGuard = setTimeout(() => after(), 25000);

  const cached = ttsCache.get(ttsKey(text, mockOpt.voice));
  try {
    const r = cached ? { ok: true, audio: cached } : await window.api.mockTts({ text, voice: mockOpt.voice });
    if (r && r.ok && r.audio) {
      ttsCache.set(ttsKey(text, mockOpt.voice), r.audio);
      await playBase64Audio(r.audio, after);
      return;
    }
    fallbackSpeak(text, after);
  } catch (_) {
    fallbackSpeak(text, after);
  }
}

function textOverlap(a, b) {
  const norm = (x) => String(x || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase();
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  const cnt = new Map();
  for (const ch of B) cnt.set(ch, (cnt.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of A) {
    const n = cnt.get(ch) || 0;
    if (n > 0) {
      hit++;
      cnt.set(ch, n - 1);
    }
  }
  return hit / A.length;
}

/** 语音识别出的一小段文字：立刻上屏 + 并进本题草稿 */
function appendMockSpeech(text) {
  const t = (text || '').trim();
  if (!t) return;
  // 外放时麦克风会录到面试官的声音：和刚念过的题高度重合的，直接丢掉
  if (lastAiSpeech && textOverlap(t, lastAiSpeech) > 0.55) {
    console.log('[mock] 丢弃疑似回声：', t);
    return;
  }
  const idx = mockState.index;
  const item = (mockState.items || [])[idx];
  if (item) item.a = ((item.a || '') + (item.a ? ' ' : '') + t).trim();

  if (mockState.mode === 'voice') {
    // 通话形态：同一题的话累积到同一个气泡，像实时字幕一样往上长
    if (!liveBubble || liveBubble.dataset.idx !== String(idx)) {
      liveBubble = addCallMsg('me', '我', t);
      if (liveBubble) liveBubble.dataset.idx = String(idx);
    } else {
      const b = liveBubble.querySelector('.body');
      if (b) b.textContent = (b.textContent ? b.textContent + ' ' : '') + t;
      const box = $('callStream');
      if (box) box.scrollTop = box.scrollHeight;
    }
    setCallStage('正在听你说…', 'listening');
  }
  const ta = $('mockAnswer');
  if (ta) {
    ta.value = item ? item.a : t;
    ta.scrollTop = ta.scrollHeight;
  }
  window.api.mockSave({ index: idx, text: item ? item.a : t });
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!autoFlow) return;
  silenceTimer = setTimeout(() => {
    if (!mockState.active || mockState.done) return;
    if (mockState.index >= mockState.total - 1) autoFinish();
    else autoAdvance();
  }, AUTO_SILENCE_MS);
}

function stopAutoFlow() {
  autoFlow = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;
}

/** 通话模式：说完一段、静音够久，自动进入下一题 */
async function autoAdvance() {
  if (!mockState.active || mockState.done) return;
  setCallStage('面试官正在想下一个问题…', 'idle');
  const hint = $('mockHint2');
  if (hint) hint.textContent = '面试官正在想下一个问题…';
  await mockSaveDraft();
  const r = await window.api.mockNext();
  if (r && r.ok) {
    renderMock(r.state);
    prefetchTts(r.state.question, mockOpt.voice);
    speakQuestion(r.state.question);
  } else {
    if (hint) hint.textContent = (r && r.error) || '出题失败';
    setCallStage('出题失败，点「下一题」重试', 'idle');
    autoFlow = false;
  }
}

async function autoFinish() {
  stopAutoFlow();
  mockMicStop();
  setCallStage('正在评分，马上出报告…', 'idle');
  const hint = $('mockHint2');
  if (hint) hint.textContent = '正在评分…';
  await mockSaveDraft();
  const r = await window.api.mockFinish();
  if (r && r.ok) renderMock(r.state);
  else if (hint) hint.textContent = (r && r.error) || '评分失败';
}

function stopSpeaking() {
  stopPlayback();
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}
  mockSpeaking = false;
  micSuspend = false; // 别把麦克风永久静音
}

function addCallMsg(kind, who, text) {
  const box = $('callStream');
  if (!box) return null;
  const d = document.createElement('div');
  d.className = 'call-msg ' + kind;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;
  d.appendChild(w);
  d.appendChild(body);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}

function setCallStage(status, orbClass) {
  if ($('callStatus')) $('callStatus').textContent = status;
  const orb = $('callOrb');
  if (!orb) return;
  orb.classList.remove('speaking', 'listening', 'idle');
  if (orbClass) orb.classList.add(orbClass);
}

/** 通话视图：只有声波、状态和对话流，没有输入框 */
function renderCall(st) {
  const badge = $('callBadge');
  if (badge) {
    badge.textContent = `${st.type === 'hr' ? 'HR' : '技术'}面试 · 第 ${st.index + 1}/${st.total} 题`;
  }
  liveBubble = null;
  const box = $('callStream');
  if (box) {
    box.innerHTML = '';
    (st.items || []).forEach((it, i) => {
      if (it.q) addCallMsg('ai', `第 ${i + 1} 题`, it.q);
      if ((it.a || '').trim()) addCallMsg('me', '我', it.a.trim());
    });
    box.scrollTop = box.scrollHeight;
  }
}

function renderMock(st) {
  const setup = $('mockSetup');
  const run = $('mockRun');
  const done = $('mockDone');
  if (!setup || !run || !done) return;

  mockState = st || { active: false };
  const call = $('mockCall');
  if (call) call.hidden = true;

  if (!st || !st.active) {
    setup.hidden = false;
    run.hidden = true;
    done.hidden = true;
    renderMockProfiles();
    stopSpeaking();
    mockMicStop();
    return;
  }

  if (!st.done && st.mode === 'voice') {
    // 语音面试：通话形态，不给输入框
    setup.hidden = true;
    run.hidden = true;
    done.hidden = true;
    if (call) call.hidden = false;
    renderCall(st);
    return;
  }

  if (!st.done) {
    setup.hidden = true;
    run.hidden = false;
    done.hidden = true;

    const voiceMode = false;
    $('mockVoiceTools').hidden = !voiceMode;
    $('mockMicBar').hidden = !voiceMode;
    $('selVoice').value = mockOpt.voice;

    $('mockIdx').textContent = `${st.index + 1} / ${st.total}`;
    $('mockQuestion').textContent = st.question;
    $('mockAnswer').value = st.draft || '';
    $('btnMockPrev').disabled = st.index === 0 || st.realtime; // 实时面试不能倒回去
    $('btnMockNext').disabled = st.index >= st.total - 1;
    $('btnMockNext').textContent = '下一题';
    if (st.realtime && st.mode === 'voice' && $('mockMicHint') && mockMicOn) {
      $('mockMicHint').textContent = '正在听，停顿 3 秒会自动进入下一题';
    }

    const filled = (st.items || []).filter((x) => (x.a || '').trim()).length;
    $('mockHint2').textContent = st.scoring
      ? `评分中 ${st.scoring.done}/${st.scoring.total}…`
      : `已填写 ${filled}/${st.total}`;
    $('btnMockFinish').disabled = !!st.scoring || filled === 0;
    return;
  }

  // 结束：报告
  setup.hidden = true;
  run.hidden = true;
  done.hidden = false;
  stopSpeaking();
  mockMicStop();

  const r = st.report;
  $('mockTotal').textContent = r ? String(r.total) : '—';
  $('mockLevel').textContent = r && r.level ? r.level : '';

  const box = $('mockDims');
  box.innerHTML = '';
  if (r && r.dims) {
    MOCK_DIMS.forEach(([k, label]) => {
      const v = Math.max(0, Math.min(100, Number(r.dims[k]) || 0));
      const row = document.createElement('div');
      row.className = 'dim-row';
      row.innerHTML = '<span class="k"></span><span class="bar"><i></i></span><span class="v"></span>';
      row.querySelector('.k').textContent = label;
      row.querySelector('i').style.width = v + '%';
      row.querySelector('.v').textContent = String(v);
      box.appendChild(row);
    });
  }

  const adv = $('mockAdvice');
  adv.innerHTML = '';
  if (r) {
    const blocks = [
      ['强项', r.strengths, 'var(--ok)'],
      ['薄弱项', r.weaknesses, 'var(--bad)'],
      ['改进建议', r.advice, 'var(--text-2)'],
    ];
    blocks.forEach(([title, list, color]) => {
      if (!list || !list.length) return;
      const d = document.createElement('div');
      d.className = 'adv-block';
      const h = document.createElement('h4');
      h.textContent = title;
      h.style.color = color;
      const ul = document.createElement('ul');
      ul.style.margin = '0';
      ul.style.padding = '0';
      ul.style.listStyle = 'none';
      list.forEach((t) => {
        const li = document.createElement('li');
        li.textContent = '· ' + t;
        ul.appendChild(li);
      });
      d.appendChild(h);
      d.appendChild(ul);
      adv.appendChild(d);
    });
  }
}

/** 切题/提交前先把当前这题的草稿存回主进程 */
async function mockSaveDraft() {
  if (!mockState.active || mockState.done) return;
  const ta = $('mockAnswer');
  if (!ta) return;
  await window.api.mockSave({ index: mockState.index, text: ta.value });
}

async function mockMicStart() {
  if (mockMic) return true;
  try {
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    mockMic = new VoiceCapture({
      channel: 'me',
      stream: ms,
      onUtterance: (channel, samples, sampleRate) => {
        if (micSuspend) return; // 正在念题，麦克风收到的是 AI 的声音
        const copy = new Float32Array(samples);
        window.api.sendUtterance({ channel: 'me', samples: copy.buffer, sampleRate });
      },
      onLevel: (v) => {
        const orb = $('callOrb');
        if (orb) orb.style.setProperty('--level', String(Math.max(0, Math.min(1, (v || 0) * 6))));
        // 只要还有声音，就别急着跳到下一题 —— 光靠识别结果会漏掉小声说话的时候
        if (autoFlow && (v || 0) > 0.1 && Date.now() - lastLevelReset > 600) {
          lastLevelReset = Date.now();
          resetSilenceTimer();
        }
      },
      onError: (m) => {
        $('mockMicHint').textContent = '语音出错：' + m;
      },
    });
    mockMicOn = true;
    const asrRes = await window.api.mockMic(true);
    if (asrRes && asrRes.asr && !asrRes.asr.ready) {
      $('mockMicHint').textContent = '语音模型加载中，等两三秒再说话…';
      setCallStage('语音模型加载中…', 'idle');
    }
    $('btnMockMic').classList.add('rec');
    $('btnMockMic').textContent = '停止录音';
    $('mockMicHint').textContent = '正在听，说完点一下停止';
    return true;
  } catch (e) {
    $('mockMicHint').textContent = '麦克风不可用：' + e.message;
    return false;
  }
}

function mockMicStop() {
  clearTimeout(silenceTimer);
  autoFlow = false;
  if (mockMic) {
    try {
      mockMic.stop();
    } catch (_) {}
    mockMic = null;
  }
  if (mockMicOn) window.api.mockMic(false);
  mockMicOn = false;
  const btn = $('btnMockMic');
  if (btn) {
    btn.classList.remove('rec');
    btn.textContent = '按住说话';
  }
}

function bindMockEvents() {
  if (!$('btnMockStart')) return;
  fillVoiceSelects();

  $('segMockType').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segMockType', v);
    mockOpt.type = v;
  };
  $('segMockMode').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segMockMode', v);
    mockOpt.mode = v;
    $('mockVoiceGroup').hidden = v !== 'voice';
  };

  // 设置区选音色：和通话界面那个下拉保持同步
  $('selVoiceSetup').onchange = () => {
    mockOpt.voice = $('selVoiceSetup').value;
    if ($('selVoice')) $('selVoice').value = mockOpt.voice;
  };
  $('btnVoicePreview').onclick = async () => {
    mockOpt.voice = $('selVoiceSetup').value;
    $('btnVoicePreview').disabled = true;
    try {
      await speakQuestion('你好，我是今天的面试官，我们开始吧。');
    } finally {
      $('btnVoicePreview').disabled = false;
    }
  };
  $('segMockCount').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segMockCount', v);
    mockOpt.count = Number(v);
    $('mockCountCustom').value = '';
  };
  $('mockCountCustom').oninput = () => {
    const v = Number($('mockCountCustom').value);
    if (!(v >= 2 && v <= 20)) return;
    mockOpt.count = v;
    markSeg('segMockCount', ''); // 自定义时取消预设高亮
  };
  $('selVoice').onchange = () => {
    mockOpt.voice = $('selVoice').value;
    if ($('selVoiceSetup')) $('selVoiceSetup').value = mockOpt.voice;
    speakQuestion($('mockQuestion').textContent || lastAiSpeech);
  };

  $('btnMockStart').onclick = async () => {
    stopSpeaking();
    const pid = $('mockProfile').value;
    if (pid && pid !== profilesState.activeId) await window.api.switchProfile(pid);
    $('mockHint').textContent = '正在根据简历和岗位出题…';
    $('btnMockStart').disabled = true;
    try {
      const r = await window.api.mockStart({ count: mockOpt.count, type: mockOpt.type, mode: mockOpt.mode });
      if (r && r.ok) {
        $('mockHint').textContent = '';
        renderMock(r.state);
        if (mockOpt.mode === 'voice') {
          prefetchTts(r.state.question, mockOpt.voice);
          speakQuestion(r.state.question);
        }
      } else {
        $('mockHint').textContent = (r && r.error) || '出题失败';
      }
    } finally {
      $('btnMockStart').disabled = false;
    }
  };

  $('btnMockPrev').onclick = async () => {
    if (mockState.index <= 0) return;
    await mockSaveDraft();
    const r = await window.api.mockGoto(mockState.index - 1);
    if (r && r.ok) {
      renderMock(r.state);
      if (mockState.mode === 'voice') speakQuestion(r.state.question);
    }
  };

  $('btnMockNext').onclick = async () => {
    if (mockState.index >= mockState.total - 1) return;
    clearTimeout(silenceTimer);
    await mockSaveDraft();
    const btn = $('btnMockNext');
    btn.disabled = true;
    try {
      if (mockState.realtime) {
        // 真实面试节奏：答完这一题，面试官根据你的回答想下一个问题（可以追问）
        $('mockHint2').textContent = '面试官正在想下一个问题…';
        const r = await window.api.mockNext();
        if (r && r.ok) {
          renderMock(r.state);
          if (mockState.mode === 'voice') {
            prefetchTts(r.state.question, mockOpt.voice);
            speakQuestion(r.state.question);
          }
        } else {
          $('mockHint2').textContent = (r && r.error) || '出题失败';
        }
      } else {
        const r = await window.api.mockGoto(mockState.index + 1);
        if (r && r.ok) {
          renderMock(r.state);
          if (mockState.mode === 'voice') {
            prefetchTts(r.state.question, mockOpt.voice);
            speakQuestion(r.state.question);
          }
        }
      }
    } finally {
      btn.disabled = false;
    }
  };

  $('btnMockFinish').onclick = async () => {
    stopAutoFlow();
    mockMicStop();
    await mockSaveDraft();
    $('btnMockFinish').disabled = true;
    $('mockHint2').textContent = '评分中…';
    try {
      const r = await window.api.mockFinish();
      if (r && r.ok) renderMock(r.state);
      else $('mockHint2').textContent = (r && r.error) || '评分失败';
    } finally {
      $('btnMockFinish').disabled = false;
    }
  };

  $('btnMockEnd').onclick = async () => {
    // 直接退出模拟面试，不评分也不保留本次记录
    stopAutoFlow();
    stopSpeaking();
    mockMicStop();
    await window.api.mockReset();
    renderMock(null);
  };

  const hangup = async () => {
    stopAutoFlow();
    stopSpeaking();
    mockMicStop();
    await window.api.mockReset();
    renderMock(null);
  };
  if ($('btnCallDone')) 
    $('btnCallDone').onclick = async () => {
      clearTimeout(silenceTimer);
      if (!mockState.active || mockState.done) return;
      if (mockState.index >= mockState.total - 1) autoFinish();
      else autoAdvance();
    };
  if ($('btnCallHangup')) $('btnCallHangup').onclick = hangup;
  if ($('btnCallEnd')) $('btnCallEnd').onclick = hangup;
  if ($('btnCallMute')) 
    $('btnCallMute').onclick = () => {
      if (mockMic) {
        mockMicStop();
        $('btnCallMute').classList.add('on');
        $('btnCallMute').textContent = '已静音';
        setCallStage('已静音，点「已静音」恢复', 'idle');
      } else {
        mockMicStart().then(() => {
          $('btnCallMute').classList.remove('on');
          $('btnCallMute').textContent = '静音';
          autoFlow = true;
          resetSilenceTimer();
          setCallStage('请回答，说完停顿一下会自动进入下一题', 'listening');
        });
      }
    };

  if ($('btnMockQuit')) $('btnMockQuit').onclick = async () => {
    stopAutoFlow();
    stopSpeaking();
    mockMicStop();
    await window.api.mockReset();
    renderMock(null);
  };

  $('btnMockAgain').onclick = async () => {
    await window.api.mockReset();
    renderMock(null);
  };

  $('btnMockExport').onclick = async () => {
    const r = await window.api.mockExport();
    $('mockLevel').textContent = r && r.ok ? '已导出：' + r.path : r && r.canceled ? '' : '导出失败：' + ((r && r.error) || '');
  };

  $('btnReplay').onclick = () => {
    speakQuestion($('mockQuestion').textContent);
  };

  $('btnMockMic').onclick = async () => {
    if (mockMic) {
      mockMicStop();
      $('mockMicHint').textContent = '';
      return;
    }
    await mockMicStart();
  };
}

/* ------------------------------------------------------- 模型供应商 */

function activeModelLabel() {
  const act = modelCatalog.active;
  if (!act || !act.providerId) return '未配置';
  const p = findProvider(act.providerId);
  if (!p) return '（供应商已删除，请重新选择）';
  const m = act.model || (p.models && p.models[0] && p.models[0].id) || '';
  return `${p.name} · ${m}`;
}

function renderProviders() {
  const box = $('provList');
  if (!box) return;
  const act = modelCatalog.active || {};
  const list = modelCatalog.providers || [];

  $('curModelText').textContent = activeModelLabel();
  if ($('curModelHint')) $('curModelHint').textContent = list.length ? '' : '还未配置';

  box.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.style.margin = '0';
    d.textContent = '还没有配置任何供应商。这个版本不再内置模型通道，需要你自己填一个（DeepSeek / 智谱 / Kimi 等都有预设）。';
    box.appendChild(d);
    return;
  }

  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'pv-item' + (act.providerId === p.id ? ' active' : '');
    row.innerHTML = `
      <div class="pv-meta"><b></b><span></span></div>
      <button class="ghost" data-act="test">测试</button>
      <button class="ghost" data-act="edit">编辑</button>
      <button class="ghost" data-act="del">删除</button>`;
    row.querySelector('b').textContent = p.name;
    row.querySelector('.pv-meta span').textContent = p.baseUrl;

    row.querySelector('[data-act=test]').onclick = async () => {
      addNote(`正在测试「${p.name}」…`);
      const r = await window.api.providerTest({ id: p.id, baseUrl: p.baseUrl, models: p.models.map((m) => m.id) });
      if (r && r.ok) addNote(`「${p.name}」连接正常（${r.latency}ms，返回：${r.sample || '空'}）`);
      else addNote(`「${p.name}」连接失败：${(r && r.error) || '未知错误'}`);
    };
    row.querySelector('[data-act=edit]').onclick = () => openProvForm(p);
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!window.confirm(`删除供应商「${p.name}」？`)) return;
      await window.api.providerDelete(p.id);
    };
    box.appendChild(row);
  });
}

function renderPresets() {
  const sel = $('pvPreset');
  if (!sel) return;
  const presets = modelCatalog.presets || [];
  sel.innerHTML = '';
  presets.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.onchange = () => {
    const p = presets.find((x) => x.key === sel.value);
    if (!p) return;
    if (p.baseUrl) {
      $('pvUrl').value = p.baseUrl;
      $('pvModels').value = (p.models || []).join(', ');
      if (!$('pvName').value.trim() || presets.some((x) => x.name === $('pvName').value)) $('pvName').value = p.name;
    } else {
      // 「其它」：清空让用户自己填
      $('pvUrl').value = '';
      $('pvModels').value = '';
      if (presets.some((x) => x.name === $('pvName').value)) $('pvName').value = '';
    }
  };
}

function openProvForm(p) {
  editingProviderId = p ? p.id : '';
  $('provFormTitle').textContent = p ? '编辑供应商' : '添加供应商';
  $('pvKey').value = '';
  $('pvKey').placeholder = p && p.hasKey ? '已保存，留空表示不修改' : 'sk-...';
  $('provTestMsg').textContent = '';
  $('provForm').hidden = false;

  if (p) {
    $('pvName').value = p.name;
    $('pvUrl').value = p.baseUrl;
    $('pvModels').value = (p.models || []).map((m) => m.id || m).join(', ');

  } else {
    renderPresets();
    const sel = $('pvPreset');
    if (sel && sel.options.length) {
      sel.selectedIndex = 0;
      sel.onchange();
    }
    $('pvName').focus();
  }
}

function formProvider() {
  return {
    id: editingProviderId,
    name: $('pvName').value.trim(),
    baseUrl: $('pvUrl').value.trim(),
    apiKey: $('pvKey').value.trim(),
    models: $('pvModels').value,
  };
}

function bindProviderEvents() {
  if (!$('btnProvAdd')) return;
  $('btnProvAdd').onclick = () => openProvForm(null);
  $('btnProvCancel').onclick = () => {
    $('provForm').hidden = true;
  };
  $('btnProvSave').onclick = async () => {
    const r = await window.api.providerSave(formProvider());
    if (r && r.ok) {
      $('provForm').hidden = true;
      addNote('供应商已保存，可在顶部模型下拉里选它。');
    } else {
      $('provTestMsg').textContent = (r && r.error) || '保存失败';
    }
  };
  $('btnProvTest').onclick = async () => {
    const f = formProvider();
    $('provTestMsg').textContent = '正在测试…';
    const r = await window.api.providerTest(f);
    $('provTestMsg').textContent =
      r && r.ok ? `连接正常（${r.latency}ms，返回：${r.sample || '空'}）` : `连接失败：${(r && r.error) || '未知错误'}`;
  };
}

/* ------------------------------------------------------- 多知识库 */

function activeProfile() {
  const items = profilesState.items || [];
  return items.find((p) => p.id === profilesState.activeId) || items[0] || null;
}

function profileSummary(p) {
  const dirName = p.projectDir ? String(p.projectDir).split(/[\\/]/).filter(Boolean).pop() : '';
  return [
    p.resumeChars ? `简历 ${p.resumeChars} 字` : '简历未导入',
    dirName ? `项目 ${dirName}` : '项目未设置',
    p.jdChars ? `JD ${p.jdChars} 字` : 'JD 为空',
  ].join(' · ');
}

function renderProfiles() {
  const items = profilesState.items || [];
  const cur = activeProfile();

  // 输入卡左上角的当前库
  if ($('kbPickName')) $('kbPickName').textContent = cur ? cur.name : '未配置';

  // 首屏下拉菜单
  const menu = $('kbMenu');
  if (menu) {
    menu.innerHTML = '';
    items.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'kb-menu-item' + (cur && p.id === cur.id ? ' on' : '');
      b.innerHTML = '<i></i><span></span>';
      b.querySelector('span').textContent = p.name;
      b.onclick = async () => {
        menu.hidden = true;
        if (cur && p.id === cur.id) return;
        await window.api.switchProfile(p.id);
      };
      menu.appendChild(b);
    });
    if (items.length) {
      const sep = document.createElement('div');
      sep.className = 'kb-menu-sep';
      menu.appendChild(sep);
    }
    const manage = document.createElement('button');
    manage.className = 'kb-menu-item';
    manage.innerHTML = '<i></i><span>管理知识库…</span>';
    manage.onclick = () => {
      menu.hidden = true;
      switchPanel('kb');
    };
    menu.appendChild(manage);
  }

  // 知识库页的库列表
  const list = $('kbList');
  if (!list) return;
  list.innerHTML = '';
  items.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'kb-item' + (cur && p.id === cur.id ? ' on' : '');
    row.innerHTML = `
      <span class="dot"></span>
      <div class="kb-meta"><b></b></div>
      <button class="ghost" data-act="rename">重命名</button>
      <button class="ghost" data-act="del">删除</button>`;
    row.querySelector('b').textContent = p.name;
    // 摘要不显示在卡片上（用户嫌啰嗦），挪到悬停提示里，信息不丢
    row.title = profileSummary(p);
    row.onclick = async (e) => {
      if (e.target.dataset && e.target.dataset.act) return;
      if (cur && p.id === cur.id) return;
      await window.api.switchProfile(p.id);
    };
    row.querySelector('[data-act=rename]').onclick = (e) => {
      e.stopPropagation();
      startRename(row, p);
    };
    row.querySelector('[data-act=del]').onclick = async (e) => {
      e.stopPropagation();
      if (profilesState.items.length <= 1) {
        addNote('至少保留一个知识库。');
        return;
      }
      const ok = window.confirm(`删除知识库「${p.name}」？\n其中的简历、JD 和项目索引都会一起移除。`);
      if (!ok) return;
      const r = await window.api.deleteProfile(p.id);
      if (r && !r.ok) addNote(r.error || '删除失败');
    };
    list.appendChild(row);
  });

  if (pendingRename) {
    pendingRename = false;
    const row = list.querySelector('.kb-item.on');
    const p = cur;
    if (row && p) startRename(row, p);
  }
}

/** 卡片内联改名，避免用 prompt（Electron 里不可用） */
function startRename(row, p) {
  const b = row.querySelector('b');
  if (!b) return;
  const input = document.createElement('input');
  input.className = 'kb-rename';
  input.value = p.name;
  b.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (name && name !== p.name) await window.api.renameProfile(p.id, name);
    renderProfiles();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      done = true;
      renderProfiles();
    }
  };
}

function bindProfileEvents() {
  const chip = $('btnKbPick');
  const menu = $('kbMenu');
  if (chip && menu) {
    chip.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    };
    // 点击别处收起
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== chip) menu.hidden = true;
    });
  }
  const add = $('btnKbNew');
  if (add) {
    add.onclick = async () => {
      const r = await window.api.createProfile('新知识库');
      if (r && r.ok) pendingRename = true;
      // 主进程会广播 profiles:state，渲染由回调统一处理
    };
  }
}

/* ------------------------------------------------------------ 初始化 */

async function boot() {
  const state = await window.api.boot();
  cfg = state.config;
  profilesState = state.profiles || { items: [], activeId: '' };
  applyConfigToUI(cfg);
  renderProfiles();
  renderProject(state.project);
  setAsrState(state.asr);
  renderGuard();
  bindEvents();

  window.api.on('models:list', renderModels);
  // boot 里已经带了目录，这里再拉一次兜住"广播早于页面加载"的情况
  if (state.models) renderModels(state.models);
  else renderProviders();
  window.api.getModels().then((r) => { if (r && r.builtin) renderModels(r); });
  // 内置通道异常不再清空下拉：自定义供应商的模型还能用
  window.api.on('models:error', (p) => addNote('内置模型通道异常：' + p.message));
  window.api.on('asr:state', setAsrState);
  window.api.on('asr:error', (p) => addNote('识别出错：' + p.message));
  window.api.on('transcript:add', (item) => {
    // 模拟面试的语音回答只填进答题框，不要混进实时面试的字幕
    if (mockMicOn && item && item.channel === 'me' && mockState && mockState.active && !mockState.done) {
      resetSilenceTimer();
      appendMockSpeech(item.text);
      return;
    }
    addTranscript(item);
  });
  window.api.on('listen:state', (p) => {
    listening = p.listening;
    reflectListenButton();
  });
  window.api.on('session:clear', () => {
    setHero(true);
    $('transcript').innerHTML = '';
    $('answer').textContent = '';
    $('question').textContent = '';
    currentAnswer = '';
    renderRefs(null);
  });
  window.api.on('cfg:changed', (p) => {
    const switched = p.activeProfileId !== cfg.activeProfileId;
    cfg = p;
    // 之前只存不刷：用 Ctrl+Shift+H 或悬浮窗上的 × 改变可见性后，
    // 设置栏的「悬浮窗隐身」开关不会跟着变，看起来像"按键失灵"
    syncToggleUI(p);
    // 切换知识库后简历 / JD / 项目都换了，需要整页重刷
    if (switched) {
      applyConfigToUI(p);
      renderProfiles();
    }
  });

  window.api.on('mock:state', renderMock);

  window.api.on('profiles:state', (p) => {
    profilesState = p;
    renderProfiles();
  });

  window.api.on('llm:start', (p) => {
    setHero(false);
    stepsReset();
    reasoningStepDone = false;
    currentAnswer = '';
    // 手动输入不是面试官在说话，别硬套「面试官问」这个前缀
    $('question').textContent = (p.manual ? '你问：' : '面试官问：') + p.question;
    $('answer').classList.remove('err');
    $('answer').textContent = '';
    $('answer').classList.add('streaming');
    renderRefs(null);
  });
  window.api.on('llm:delta', (p) => {
    if (!reasoningStepDone) {
      reasoningStepDone = true;
      stepAdd('正在结合资料与网页信息组织作答…');
    }
    currentAnswer += p.text;
    $('answer').textContent = currentAnswer;
    $('answer').scrollTop = $('answer').scrollHeight;
  });
  window.api.on('llm:done', (p) => {
    currentAnswer = p.text || currentAnswer;
    $('answer').classList.remove('streaming');
    if (/^[—\-–]+$/.test(currentAnswer.trim())) {
      $('answer').innerHTML = '<span class="ph">（面试官在陈述，无需作答）</span>';
    } else {
      $('answer').textContent = currentAnswer;
    }
    renderRefs(p.refs);
    if ($('steps').classList.contains('on')) stepAdd('作答完成', true);
  });
  window.api.on('llm:error', (p) => {
    $('answer').classList.remove('streaming');
    $('answer').classList.add('err');
    $('answer').textContent = '生成失败：' + p.message;
  });
  window.api.on('overlay:state', () => {});

  window.api.on('project:state', renderProject);
  window.api.on('guard:applied', (p) => {
    if (!p) return;
    cfg.hideCaptured = !!p.hideCaptured;
    renderGuard();
    toast('开始监听，已自动对屏幕共享隐藏');
  });
  window.api.on('session:state', () => {
    if (document.getElementById('panel-history').classList.contains('active')) renderHistory();
  });
  window.api.on('web:status', (p) => {
    if (p && p.state === 'searching') stepAdd('正在联网检索：' + p.query);
  });
  window.api.on('web:results', (r) => {
    if (!r) return;
    if (r.ok) {
      const titles = r.items.map((i) => i.title).slice(0, 3).join(' / ');
      stepAdd(`检索到 ${r.items.length} 条网页，作为作答依据：${titles}`, true);
    } else {
      stepAdd('联网检索失败：' + (r.error || '未知原因'), true);
    }
  });
  window.api.on('guard:verified', (r) => {
    if (!r || r.skipped) return;
    guardVerified = r.ok === true ? true : r.ok === false ? false : null;
    showTestOut(
      r.ok === true ? 'ok' : r.ok === false ? 'bad' : '',
      (r.ok === true ? '✓ ' : r.ok === false ? '✗ ' : '· ') + r.reason +
        (r.ratio != null ? `（差异 ${(r.ratio * 100).toFixed(1)}%）` : '')
    );
    renderGuard();
  });
  window.api.on('project:progress', (p) => {
    const bar = $('projBar');
    const fill = $('projBarIn');
    const tip = $('projProgress');
    if (!p) {
      bar.classList.remove('on');
      tip.textContent = '';
      return;
    }
    bar.classList.add('on');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 6;
    fill.style.width = pct + '%';
    tip.textContent = `正在索引 ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`;
  });

  // 电平表刷新
  setInterval(() => {
    setBar('barSys', 'valSys', levelBuf.interviewer);
    setBar('barMic', 'valMic', levelBuf.me);
  }, 90);

  setInterval(renderChStats, 600);
}

function setBar(barId, valId, v) {
  const pct = (Math.max(0, Math.min(1, v)) * 100).toFixed(0);
  const el = $(barId);
  el.style.background = `linear-gradient(to right, #5b5bd6 ${pct}%, #edeef4 ${pct}%)`;
  $(valId).textContent = pct;
}

function resetChStats() {
  chStat = { interviewer: { peak: 0, count: 0 }, me: { peak: 0, count: 0 } };
  listenStartAt = Date.now();
  warnedNoSys = false;
  renderChStats();
}

function renderChStats() {
  const draw = (ch, elId, label) => {
    const el = $(elId);
    if (!el) return;
    if (!listening) {
      // 没开始监听就整行留空，避免界面上多出两行占位说明
      el.className = 'ch-stat';
      el.textContent = '';
      return;
    }
    const s = chStat[ch];
    const peak = Math.round(s.peak * 100);
    const elapsed = Date.now() - listenStartAt;
    if (peak === 0 && elapsed > 12000) {
      el.className = 'ch-stat bad';
      el.textContent = `⚠ ${label}一直没有声音进来`;
      if (ch === 'interviewer' && !warnedNoSys) {
        warnedNoSys = true;
        addNote(
          '系统声音通道一直没有声音。若面试官在说话：请检查系统默认播放设备（蓝牙耳机常见此问题），或改用「立体声混音」。也可以只靠麦克风收音。'
        );
      }
    } else if (peak > 0) {
      el.className = 'ch-stat ok';
      el.textContent = `峰值 ${peak} · 已识别 ${s.count} 句`;
    } else {
      el.className = 'ch-stat';
      el.textContent = '等待声音…';
    }
  };
  draw('interviewer', 'sysStat', '系统声音');
  draw('me', 'micStat', '麦克风');
}

/* ------------------------------------------------------- 思考过程 */

function stepsReset() {
  const box = $('steps');
  box.textContent = '';
  box.classList.remove('on');
}

function stepAdd(text, done) {
  const box = $('steps');
  box.classList.add('on');
  const row = document.createElement('div');
  row.className = 'st' + (done ? ' done' : '');
  const mark = document.createElement('i');
  mark.textContent = done ? '✓' : '·';
  const span = document.createElement('span');
  span.textContent = text;
  row.append(mark, span);
  box.appendChild(row);
  return row;
}

function renderRefs(refs) {
  const box = $('refs');
  box.textContent = '';
  if (!refs || !refs.length) {
    box.classList.remove('on');
    return;
  }
  const label = document.createElement('b');
  label.textContent = '参考资料：';
  box.appendChild(label);
  refs.forEach((f, i) => {
    if (i) box.appendChild(document.createTextNode(' · ')); // 之前两个文件名直接粘在一起
    const s = document.createElement('span');
    s.textContent = f;
    s.title = f;
    box.appendChild(s);
  });
  box.classList.add('on');
}

/* ------------------------------------------------------------ 设置同步 */

let uiZoom = 1;

/**
 * CSS zoom 会把元素按比例放大，但 100vh 仍按原视口算，结果整体比窗口高，
 * 底部（首页输入框、设置页最后一项）就被挤到窗口外面。
 * 这里把根容器显式换算成「视口 ÷ 缩放」，放大多少都刚好铺满。
 */
function applyZoom(scale) {
  uiZoom = Number(scale) || 1;
  // 清掉早期用 CSS zoom 留下的痕迹
  document.documentElement.style.zoom = '';
  const app = document.querySelector('.app');
  if (app) {
    app.style.width = '';
    app.style.height = '';
  }
  // 交给 Electron 原生缩放：视口 CSS 像素会跟着变，100vh / sticky 都算得对
  if (window.api && window.api.setZoom) window.api.setZoom(uiZoom);
}

window.addEventListener('DOMContentLoaded', () => applyZoom(uiZoom));

function applyUiSettings(c) {
  document.documentElement.dataset.theme = c.uiTheme === 'dark' ? 'dark' : 'light';
  applyZoom(c.uiScale || 1);
  if (window.I18N) I18N.setLang(c.lang || 'zh-CN');
  markSeg('segFont', String(c.uiScale || 1));
  markSeg('segUiTheme', c.uiTheme || 'light');
  const sel = $('selLang');
  if (sel) sel.value = c.lang || 'zh-CN';
  const rg = $('rgUiOpacity');
  const pct = Math.round((typeof c.uiOpacity === 'number' ? c.uiOpacity : 1) * 100);
  if (rg) rg.value = String(pct);
  if ($('valUiOpacity')) $('valUiOpacity').textContent = pct + '%';
}

function applyConfigToUI(c) {
  applyUiSettings(c);
  $('swSys').checked = c.sysAudio !== false;
  $('swMic').checked = c.mic !== false;
  $('swAuto').checked = c.autoAnswer !== false;
  $('swStealth').checked = c.overlayVisible === false; // 勾选 = 悬浮窗隐身
  $('rgOpacity').value = Math.round((c.overlayOpacity ?? 0.95) * 100);
  $('valOpacity').textContent = $('rgOpacity').value + '%';
  $('btnWeb').classList.toggle('on', !!c.webSearch);
  skills = Array.isArray(c.skills) ? c.skills : [];
  renderSkills();
  renderJd(c.jd);
  renderResume(c);
  renderGuard();
  markSeg('segStyle', c.style || 'bullet');
  markSeg('segTheme', c.overlayTheme || 'dark');
  syncKeysPanel(c.showShortcuts);
  if ($('swFullStealth')) $('swFullStealth').checked = !!c.fullStealth;
}

/**
 * 只同步开关类控件，不重渲染列表。
 * 用于 cfg:changed 这种"状态被别处改了"的场景：重渲染技能/简历会打断用户正在编辑的内容。
 */
function syncToggleUI(c) {
  if (!c) return;
  const setChecked = (id, v) => {
    const el = $(id);
    if (el && el.checked !== v) el.checked = v;
  };
  setChecked('swSys', c.sysAudio !== false);
  setChecked('swMic', c.mic !== false);
  setChecked('swAuto', c.autoAnswer !== false);
  setChecked('swStealth', c.overlayVisible === false);

  const rg = $('rgOpacity');
  if (rg) {
    const v = Math.round((c.overlayOpacity ?? 0.95) * 100);
    if (Number(rg.value) !== v) {
      rg.value = v;
      $('valOpacity').textContent = v + '%';
    }
  }

  markSeg('segStyle', c.style || 'bullet');
  markSeg('segTheme', c.overlayTheme || 'dark');
  syncKeysPanel(c.showShortcuts);
  if ($('swFullStealth')) $('swFullStealth').checked = !!c.fullStealth;
}

function markSeg(id, value) {
  const box = $(id);
  if (!box) return; // 控件可能已被移除（「位置」已换成「快捷键显示」）
  [...box.querySelectorAll('button')].forEach((b) => {
    b.classList.toggle('on', b.dataset.v === value);
  });
}

/** 快捷键面板：开关与展开状态一起同步 */
function syncKeysPanel(on) {
  const sw = $('swKeys');
  const list = $('keyList');
  if (!sw || !list) return;
  const v = !!on;
  if (sw.checked !== v) sw.checked = v;
  list.classList.toggle('on', v);
}

function bindEvents() {
  const set = (patch) => window.api.setConfig(patch).then((c) => (cfg = c));

  $('swSys').onchange = (e) => set({ sysAudio: e.target.checked });
  $('swMic').onchange = (e) => set({ mic: e.target.checked });
  $('swAuto').onchange = (e) => set({ autoAnswer: e.target.checked });
  // 侧栏切换
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.panel === 'session') {
        startNewSession();
        return;
      }
      switchPanel(b.dataset.panel);
      if (b.dataset.panel === 'history') renderHistory();
    };
  });
  $('btnWeb').onclick = () => {
    const next = !cfg.webSearch;
    cfg.webSearch = next;
    $('btnWeb').classList.toggle('on', next);
    set({ webSearch: next });
    addNote(next ? '联网已开启：之后每次作答前会先检索网页，把结果作为依据。' : '联网已关闭。');
  };
  $('btnSkillAdd').onclick = () => {
    skills.push({ id: 's' + Date.now(), name: '新技能', desc: '描述这个技能解决什么', prompt: '', enabled: true });
    renderSkills();
    saveSkills();
  };
  $('btnRail').onclick = () => document.body.classList.toggle('rail-off');

  async function askFromInput() {
    const el = $('askInput');
    const v = el.value.trim();
    if (!v) return;
    el.value = '';
    el.style.height = 'auto';
    setHero(false);
    try {
      await window.api.ask(v);
    } catch (e) {
      addNote('提问失败：' + (e && e.message ? e.message : e));
    }
  }
  $('btnAsk').onclick = askFromInput;
  $('btnPlus').onclick = () => switchPanel('kb');
  $('askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askFromInput();
    }
  });
  $('askInput').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
  });
  document.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      $('askInput').value = c.dataset.q || '';
      $('askInput').focus();
    };
  });

  $('btnGuard').onclick = onGuardClick;
  bindProfileEvents();
  bindProviderEvents();
  bindMockEvents();
  $('swStealth').onchange = (e) => {
    set({ overlayVisible: !e.target.checked });
    addNote(e.target.checked ? '悬浮窗已隐藏，按 Ctrl+Shift+H 可重新显示。' : '悬浮窗已显示。');
  };

  // 快捷键面板：勾选后展开全部快捷键
  $('swKeys').onchange = (e) => {
    const on = e.target.checked;
    $('keyList').classList.toggle('on', on);
    set({ showShortcuts: on });
  };

  // 完全隐身：连托盘一起去掉，必须让用户确认一次
  $('swFullStealth').onchange = (e) => {
    const on = e.target.checked;
    if (on && !window.confirm('开启后隐藏窗口时，任务栏和托盘图标都会消失。\n只有按 Ctrl+Shift+O 才能找回控制台。\n\n确定开启吗？')) {
      e.target.checked = false;
      return;
    }
    set({ fullStealth: on });
  };

  $('rgOpacity').oninput = (e) => {
    $('valOpacity').textContent = e.target.value + '%';
    set({ overlayOpacity: e.target.value / 100 });
  };

  $('segStyle').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segStyle', v);
    set({ style: v });
  };
  $('segTheme').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segTheme', v);
    set({ overlayTheme: v });
  };

  // ---- 设置页：字体大小 / 界面主题 / 语言 ----
  $('segFont').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segFont', v);
    document.documentElement.style.zoom = v;
    set({ uiScale: parseFloat(v) });
  };
  $('segExport').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segExport', v);
  };
  $('btnExport').onclick = async () => {
    const fmt = ($('segExport').querySelector('button.on') || {}).dataset?.v || 'md';
    $('exportHint').textContent = '正在导出…';
    const r = await window.api.exportInterview(fmt);
    $('exportHint').textContent = r && r.ok ? '导出成功：' + r.path : r && r.canceled ? '' : '导出失败：' + ((r && r.error) || '未知错误');
  };

  $('segUiTheme').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segUiTheme', v);
    document.documentElement.dataset.theme = v === 'dark' ? 'dark' : 'light';
    set({ uiTheme: v });
  };
  $('rgUiOpacity').oninput = () => {
    const v = Number($('rgUiOpacity').value);
    $('valUiOpacity').textContent = v + '%';
    window.api.setUiOpacity(v / 100);
  };
  $('btnQuitApp').onclick = () => {
    if (window.confirm(I18N.t('quitConfirm', '退出 JobAid？正在进行的面试将结束。'))) window.api.quitApp();
  };
  $('selLang').onchange = () => {
    const v = $('selLang').value;
    if (window.I18N) I18N.setLang(v);
    // 语言变了，动态渲染出来的部分（供应商卡片、知识库列表等）要重刷
    renderProfiles();
    renderProviders();
    renderSkills();
    set({ lang: v });
  };

  // ---- 岗位 JD：编辑 / 保存 / 取消 ----
  $('btnJdEdit').onclick = () => {
    $('txtJd').readOnly = false;
    $('txtJd').focus();
    $('btnJdEdit').hidden = true;
    $('btnJdSave').hidden = false;
    $('btnJdCancel').hidden = false;

  };
  $('btnJdSave').onclick = async () => {
    const v = $('txtJd').value;
    await window.api.setConfig({ jd: v });
    cfg.jd = v;
    endJdEdit();
    renderJd(v);
    addNote(v.trim() ? `岗位 JD 已保存（${v.trim().length} 字），之后的作答会带上它。` : '岗位 JD 已清空。');
  };
  $('btnJdCancel').onclick = () => {
    $('txtJd').value = cfg.jd || '';
    endJdEdit();
    renderJd(cfg.jd);
  };

  // ---- 简历 ----
  $('btnResume').onclick = pickResume;
  $('btnResumeSwap').onclick = pickResume;
  $('btnResumeDel').onclick = async () => {
    await window.api.clearResume();
    cfg.resumeText = '';
    cfg.resumeFile = '';
    renderResume({});
    addNote('简历已移除。');
  };
  $('btnResumeEdit').onclick = () => {
    const t = $('txtResume');
    t.hidden = !t.hidden;
    $('btnResumeEdit').textContent = t.hidden ? '编辑文字' : '收起';
    if (!t.hidden) t.focus();
  };
  let t3 = null;
  $('txtResume').oninput = (e) => {
    clearTimeout(t3);
    t3 = setTimeout(() => {
      set({ resumeText: e.target.value, resumeChars: e.target.value.length });
    }, 700);
  };

  // ---- 项目资料库 ----
  $('btnProjPick').onclick = pickProject;
  $('btnProjRebuild').onclick = rebuildProject;
  $('btnProjDel').onclick = async () => {
    const r = await window.api.clearProject();
    cfg.projectDir = '';
    renderProject(r.stats);
    addNote('项目资料库已清除。');
  };
  $('btnProjOpen').onclick = () => window.api.openProject();

  $('selModel').onchange = (e) => set({ model: e.target.value });
  $('btnListen').onclick = () => toggleListening();
  $('btnRegen').onclick = () => window.api.regen();
  $('btnClear').onclick = () => window.api.clearContext();
}

/* ---------------- 屏幕防护 ---------------- */

let guardVerified = null; // null=未检测  true=实测已隐藏  false=实测仍可见

let testOutTimer = null;
function showTestOut(kind, text) {
  const out = $('testOut');
  out.className = 'test-out show' + (kind ? ' ' + kind : '');
  out.textContent = text;
  clearTimeout(testOutTimer);
  testOutTimer = setTimeout(() => out.classList.remove('show'), 8000);
}

function renderGuard() {
  const on = !!cfg.hideCaptured;
  const btn = $('btnGuard');
  // 只有确认拍到才标红，其余一律绿/中性，避免误报时吓人
  const bad = on && guardVerified === false;
  btn.className = 'guard-btn' + (on ? ' on' : '') + (bad ? ' bad' : '');

  $('guardLabel').textContent = !on ? I18N.t('guardOn', '隐藏窗口') : I18N.t('guardOff', '关闭隐藏');

  const pill = $('pillGuard');
  if (!on) {
    pill.className = 'pill bad';
    pill.textContent = '防护已关闭';
  } else if (guardVerified === true) {
    pill.className = 'pill ok';
    pill.textContent = '已隐藏共享';
  } else if (guardVerified === false) {
    pill.className = 'pill warn';
    pill.textContent = '建议复查';
  } else {
    pill.className = 'pill ok';
    pill.textContent = '防护已开启';
  }
}

async function onGuardClick() {
  const on = !!cfg.hideCaptured;
  if (on) {
    cfg = await window.api.setConfig({ hideCaptured: false });
    guardVerified = null;
    renderGuard();
    toast('已取消隐藏：窗口会重新出现在屏幕共享里');
    return;
  }
  cfg = await window.api.setConfig({ hideCaptured: true });
  guardVerified = null;
  renderGuard();
  // 说清"隐藏"到底藏的是什么，避免以为自己的屏幕上也该消失
  toast('已对屏幕共享隐藏，你自己的屏幕上照常可见');
  await runTest();
}

function endJdEdit() {
  $('txtJd').readOnly = true;
  $('btnJdEdit').hidden = false;
  $('btnJdSave').hidden = true;
  $('btnJdCancel').hidden = true;
}

function renderJd(text) {
  const v = text || '';
  $('txtJd').value = v;

}

function setAsrState(s) {
  const el = $('pillAsr');
  if (!s) return;
  if (s.ready) {
    el.className = 'pill ok';
    el.textContent = '语音模型就绪';
  } else if (s.error) {
    el.className = 'pill bad';
    el.textContent = '语音模型异常';
  } else {
    el.className = 'pill warn';
    el.textContent = '语音模型加载中…';
  }
}

let modelCatalog = { providers: [], presets: [], active: null, configured: false };

/**
 * 模型下拉。没有内置通道了，只列用户自己配的供应商。
 * option 的 value 编码成 `c:<providerId>:<model>`。
 */
function renderModels(cat) {
  const sel = $('selModel');
  if (!cat) return;
  if (Array.isArray(cat)) cat = { providers: [], active: null };
  modelCatalog = cat;

  const providers = (cat.providers || []).filter((p) => p.models && p.models.length);
  sel.innerHTML = '';

  if (!providers.length) {
    sel.innerHTML = '<option value="">未配置模型</option>';
    sel.onchange = null;
    renderProviders();
    return;
  }

  providers.forEach((p) => {
    const g = document.createElement('optgroup');
    g.label = p.name || '自定义';
    p.models.forEach((m) => {
      const o = document.createElement('option');
      o.value = `c:${p.id}:${m.id}`;
      o.textContent = m.name || m.id;
      g.appendChild(o);
    });
    sel.appendChild(g);
  });

  const act = cat.active;
  if (act && act.providerId) {
    const want = `c:${act.providerId}:${act.model || ''}`;
    const exists = [...sel.querySelectorAll('option')].some((o) => o.value === want);
    if (exists) sel.value = want;
    else sel.selectedIndex = 0;
  } else {
    sel.selectedIndex = 0;
  }

  sel.onchange = async () => {
    const v = sel.value;
    if (!v) return;
    const parts = v.split(':');
    await window.api.modelSelect({ kind: 'custom', providerId: parts[1], model: parts.slice(2).join(':') });
    addNote('已切换模型，下一轮作答会用新的模型。');
  };

  renderProviders();
}

function findProvider(id) {
  return (modelCatalog.providers || []).find((p) => p.id === id);
}

/* ------------------------------------------------------------ 监听控制 */

function reflectListenButton() {
  const b = $('btnListen');
  if (listening) {
    b.textContent = window.I18N ? I18N.t('stopListen', '停止监听') : '停止监听';
    b.classList.add('rec');
  } else {
    b.textContent = window.I18N ? I18N.t('startListen', '开始监听') : '开始监听';
    b.classList.remove('rec');
  }
}

async function toggleListening() {
  if (listening) {
    await stopListening();
    await window.api.toggleListening(false);
    return;
  }
  const ok = await startCaptures();
  if (!ok) return;
  await window.api.toggleListening(true);
  listening = true;
  reflectListenButton();
  resetChStats();
  $('transcript').innerHTML = '';
  addNote('开始监听。建议先让面试官说一句话，确认左侧「面试官」电平在跳动。');
}

async function startCaptures() {
  if (captures.length) return true;
  let any = false;

  if ($('swSys').checked) {
    try {
      // 系统回环：拿会议软件播放出来的声音（面试官）
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 },
        audio: true,
      });
      // 画面留着不动（停掉视频轨可能连带停掉音频回环），只把帧丢掉省算力
      displayStream.getVideoTracks().forEach((t) => (t.enabled = false));
      const audioTracks = displayStream.getAudioTracks();
      if (!audioTracks.length) {
        addNote('系统声音：没有拿到音频轨。请确认系统正在播放声音，或检查系统音频设置。');
      } else {
        captures.push(
          new VoiceCapture({
            channel: 'interviewer',
            stream: new MediaStream(audioTracks),
            onUtterance: sendUtterance,
            onLevel: (v) => {
              levelBuf.interviewer = v;
              if (v > chStat.interviewer.peak) chStat.interviewer.peak = v;
            },
            onError: (m) => addNote('系统声音处理出错：' + m),
          })
        );
        any = true;
      }
    } catch (e) {
      addNote('系统声音采集失败：' + e.message);
    }
  }

  if ($('swMic').checked) {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      captures.push(
        new VoiceCapture({
          channel: 'me',
          stream: ms,
          onUtterance: sendUtterance,
          onLevel: (v) => {
            levelBuf.me = v;
            if (v > chStat.me.peak) chStat.me.peak = v;
          },
          onError: (m) => addNote('麦克风处理出错：' + m),
        })
      );
      any = true;
    } catch (e) {
      addNote('麦克风不可用：' + e.message);
    }
  }

  if (!any) {
    addNote('没有可用的音频来源，请至少打开一个开关。');
    stopListening();
    return false;
  }
  return true;
}

function sendUtterance(channel, samples, sampleRate) {
  // 复制一份再转移，避免主进程持有后此处被 detach
  const copy = new Float32Array(samples);
  window.api.sendUtterance({ channel, samples: copy.buffer, sampleRate });
}

async function stopListening() {
  captures.forEach((c) => c.stop());
  captures = [];
  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
  }
  levelBuf.interviewer = 0;
  levelBuf.me = 0;
  listening = false;
  reflectListenButton();
  renderChStats();
}

/* ------------------------------------------------------- 简历与资料库 */

function renderResume(c) {
  const text = (c && c.resumeText) || '';
  const has = !!text.trim();
  $('resumeEmpty').hidden = has;
  $('resumeFilled').hidden = !has;
  $('txtResume').value = text;
  $('resumeName').textContent = (c && c.resumeFile) || '已解析的简历';
  if (!has) {
    $('txtResume').hidden = true;
    $('btnResumeEdit').textContent = '编辑文字';
  }
}

async function pickResume() {
  const btn = $('btnResume');
  btn.disabled = true;
  btn.textContent = '解析中…';
  try {
    const r = await window.api.pickResume();
    if (!r || r.canceled) return;
    if (!r.ok) {
      addNote('简历解析失败：' + r.error);
      return;
    }
    cfg.resumeText = r.text;
    cfg.resumeFile = r.file;
    renderResume({ resumeText: r.text, resumeFile: r.file });
    const extra = [r.pages ? `${r.pages} 页` : '', r.warning || ''].filter(Boolean).join('，');
    addNote(`简历已解析：${r.file}，${r.chars} 字${extra ? `（${extra}）` : ''}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '上传简历（PDF / Word）';
  }
}

function renderProject(s) {
  const has = !!(s && s.root);
  $('projEmpty').hidden = has;
  $('projFilled').hidden = !has;
  $('projBar').classList.remove('on');
  $('projProgress').textContent = '';
  if (!has) return;

  const name = s.root.split(/[\\/]/).filter(Boolean).pop() || s.root;
  $('projName').textContent = name;
  $('projName').title = s.root;

}

async function pickProject() {
  const btn = $('btnProjPick');
  btn.disabled = true;
  btn.textContent = '索引中…';
  try {
    const r = await window.api.pickProject();
    if (!r || r.canceled) return;
    if (!r.ok) {
      addNote('资料库索引失败：' + r.error);
      return;
    }
    renderProject(r.stats);
    addNote(summaryOf(r.stats));
  } finally {
    btn.disabled = false;
    btn.textContent = '选择文件夹';
  }
}

async function rebuildProject() {
  const btn = $('btnProjRebuild');
  btn.disabled = true;
  try {
    const r = await window.api.rebuildProject();
    if (!r.ok) {
      addNote('重建失败：' + r.error);
      return;
    }
    renderProject(r.stats);
    addNote(summaryOf(r.stats));
  } finally {
    btn.disabled = false;
  }
}

function summaryOf(s) {
  return `资料库就绪：${s.files} 个文件、${s.chunks} 段${s.failed ? `，${s.failed} 个无法解析已跳过` : ''}。面试提问时会自动检索相关片段。`;
}

/* --------------------------------------------------- 侧栏与面板切换 */

/* --------------------------------------------------------- 历史记录 */

let histOpen = null;

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

async function startNewSession() {
  const r = await window.api.newSession();
  switchPanel('session');
  resetUi();
  if (r && r.archived) toast('上一场已存入历史记录');
  renderHistory();
}

function resetUi() {
  currentAnswer = '';
  stepsReset();
  $('question').textContent = '';
  $('answer').textContent = '';
  $('transcript').textContent = '';
  renderRefs(null);
  resetChStats();
}

async function renderHistory() {
  const box = $('histList');
  if (!box) return;
  const r = await window.api.listSessions();
  box.textContent = '';
  const items = (r && r.items) || [];
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '';
    box.appendChild(d);
    return;
  }
  items.forEach((it) => {
    const wrap = document.createElement('div');
    wrap.className = 'hist-item';

    const top = document.createElement('div');
    top.className = 'hist-top';
    const time = document.createElement('span');
    time.className = 'hist-time';
    time.textContent = fmtTime(it.startedAt);
    const meta = document.createElement('span');
    meta.className = 'hist-meta';
    meta.textContent = `${it.qaCount} 个问题`;
    const more = document.createElement('span');
    more.className = 'hist-more';
    more.textContent = '展开';

    const del = document.createElement('button');
    del.className = 'hist-del';
    del.textContent = '删除';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      await window.api.deleteSession(it.id);
      renderHistory();
      toast('已删除这场记录');
    };

    top.append(time, meta, more, del);

    const det = document.createElement('div');
    det.className = 'hist-qa';

    wrap.append(top, det);

    wrap.onclick = async () => {
      const open = wrap.classList.toggle('open');
      more.textContent = open ? '收起' : '展开';
      if (!open) return;
      if (det.dataset.loaded) return;
      const d = await window.api.getSession(it.id);
      det.textContent = '';
      if (!d || !d.qa || !d.qa.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = '这场没有生成作答（可能只开了字幕）。';
        det.appendChild(e);
      } else {
        d.qa.forEach((x) => {
          const q = document.createElement('div');
          q.className = 'hist-q';
          q.textContent = '问：' + x.question;
          const a = document.createElement('div');
          a.className = 'hist-a';
          a.textContent = x.answer;
          det.append(q, a);
        });
      }
      det.dataset.loaded = '1';
    };

    box.appendChild(wrap);
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function setHero(show) {
  const panel = $('panel-session');
  if (panel) panel.classList.toggle('busy', !show);
}

function switchPanel(name) {
  if (name === 'mock') {
    window.api.mockState().then(renderMock).catch(() => {});
    renderMockProfiles();
  }
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}



/* --------------------------------------------------------------- 技能 */

let skills = [];

function renderSkills() {
  const box = $('skillList');
  box.textContent = '';
  if (!skills.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有技能';
    box.appendChild(d);
    return;
  }
  skills.forEach((sk, idx) => {
    const card = document.createElement('div');
    card.className = 'skill-card';

    const head = document.createElement('div');
    head.className = 'skill-head';

    const name = document.createElement('span');
    name.className = 'skill-name';
    name.textContent = sk.name;

    const sw = document.createElement('span');
    sw.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!sk.enabled;
    input.onchange = () => {
      skills[idx].enabled = input.checked;
      saveSkills();
    };
    const track = document.createElement('span');
    sw.append(input, track);

    const edit = document.createElement('button');
    edit.className = 'ghost';
    edit.textContent = '编辑';

    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '删除';

    head.append(name, sw, edit, del);

    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.hidden = true;
    ta.value = sk.prompt || '';
    ta.placeholder = '写给模型的指令，例如：技术题先给方案结论，再补两条实现细节。';

    edit.onclick = () => {
      ta.hidden = !ta.hidden;
      edit.textContent = ta.hidden ? '编辑' : '收起';
      if (!ta.hidden) ta.focus();
    };
    ta.onblur = () => {
      skills[idx].prompt = ta.value;
      saveSkills();
    };
    del.onclick = () => {
      skills.splice(idx, 1);
      renderSkills();
      saveSkills();
    };

    card.append(head, ta);
    box.appendChild(card);
  });
}

function saveSkills() {
  window.api.setConfig({ skills });
}

/* ------------------------------------------------------------ 自检 */

async function runTest() {
  showTestOut('', '正在截屏比对，请稍候…');
  try {
    const r = await window.api.selfTest(true);
    guardVerified = r.ok === true ? true : r.ok === false ? false : null;
    showTestOut(
      r.ok === true ? 'ok' : r.ok === false ? 'bad' : '',
      (r.ok === true ? '✓ ' : r.ok === false ? '✗ ' : '· ') +
        r.reason +
        (r.ratio != null ? `（差异 ${(r.ratio * 100).toFixed(1)}%）` : '')
    );
    renderGuard();
  } catch (e) {
    showTestOut('bad', '检测失败：' + e.message);
  }
}

/* ------------------------------------------------------------ 字幕 */

function addTranscript(item) {
  if (chStat[item.channel]) chStat[item.channel].count++;
  const box = $('transcript');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'line ' + (item.channel === 'interviewer' ? 'sys' : 'me');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = item.channel === 'interviewer' ? '面试官' : '求职者';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = item.text;
  line.appendChild(who);
  line.appendChild(txt);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function addNote(msg) {
  const box = $('transcript');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'line note';
  const who = document.createElement('span');
  who.className = 'who';
  who.style.background = '#fff8eb';
  who.style.color = '#9a5b06';
  who.textContent = '提示';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.style.color = '#7b8194';
  txt.textContent = msg;
  line.appendChild(who);
  line.appendChild(txt);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  // 提示是一次性提醒：最多留两条，且 8 秒后自动消失，别把字幕区占满
  const notes = box.querySelectorAll('.line.note');
  for (let i = 0; i < notes.length - 2; i++) notes[i].remove();
  setTimeout(() => {
    if (!line.isConnected) return;
    line.style.transition = 'opacity .4s';
    line.style.opacity = '0';
    setTimeout(() => line.remove(), 420);
  }, 8000);
}

boot();
