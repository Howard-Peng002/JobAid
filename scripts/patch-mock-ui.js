'use strict';
/* 替换 console.js 里的模拟面试前端逻辑 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'console.js');
let src = fs.readFileSync(file, 'utf8');

const START = '/* ------------------------------------------------------- 模拟面试 */';
const END = '/* ------------------------------------------------------- 模型供应商 */';
const s = src.indexOf(START);
const e = src.indexOf(END);
if (s < 0 || e < 0) {
  console.log('定位失败', s, e);
  process.exit(1);
}

const BLOCK = `/* ------------------------------------------------------- 模拟面试 */
const MOCK_DIMS = [
  ['depth', '技术深度'],
  ['clarity', '表达清晰'],
  ['structure', '结构完整'],
  ['match', '岗位匹配'],
];

let mockState = { active: false };
let mockOpt = { type: 'tech', mode: 'text', count: 5, voice: 'female' };
let mockMic = null;
let mockMicOn = false;
let mockSpeaking = false;

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

/** 语音模式：把题目读出来（用系统 TTS，不需要额外服务） */
function speakQuestion(text) {
  if (!window.speechSynthesis || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.02;
    const voices = (speechSynthesis.getVoices() || []).filter((v) => /zh/i.test(v.lang) || /Chinese|Huihui|Yaoyao|Kangkang|Xiaoxiao/i.test(v.name));
    const male = voices.find((v) => /Kangkang|Yunxi|Yunyang|男/i.test(v.name));
    const female = voices.find((v) => /Huihui|Yaoyao|Xiaoxiao|女/i.test(v.name));
    const pick = mockOpt.voice === 'male' ? male || female : female || male;
    if (pick) u.voice = pick;
    mockSpeaking = true;
    u.onend = () => { mockSpeaking = false; };
    u.onerror = () => { mockSpeaking = false; };
    speechSynthesis.speak(u);
  } catch (_) {
    mockSpeaking = false;
  }
}

function stopSpeaking() {
  try {
    if (window.speechSynthesis) speechSynthesis.cancel();
  } catch (_) {}
  mockSpeaking = false;
}

function renderMock(st) {
  const setup = $('mockSetup');
  const run = $('mockRun');
  const done = $('mockDone');
  if (!setup || !run || !done) return;

  mockState = st || { active: false };

  if (!st || !st.active) {
    setup.hidden = false;
    run.hidden = true;
    done.hidden = true;
    renderMockProfiles();
    stopSpeaking();
    mockMicStop();
    return;
  }

  if (!st.done) {
    setup.hidden = true;
    run.hidden = false;
    done.hidden = true;

    const voiceMode = st.mode === 'voice';
    $('mockVoiceTools').hidden = !voiceMode;
    $('mockMicBar').hidden = !voiceMode;
    $('selVoice').value = mockOpt.voice;

    $('mockIdx').textContent = \`\${st.index + 1} / \${st.total}\`;
    $('mockQuestion').textContent = st.question;
    $('mockAnswer').value = st.draft || '';
    $('btnMockPrev').disabled = st.index === 0;
    $('btnMockNext').disabled = st.index >= st.total - 1;

    const filled = (st.items || []).filter((x) => (x.a || '').trim()).length;
    $('mockHint2').textContent = st.scoring
      ? \`评分中 \${st.scoring.done}/\${st.scoring.total}…\`
      : \`已填写 \${filled}/\${st.total}\`;
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
        const copy = new Float32Array(samples);
        window.api.sendUtterance({ channel: 'me', samples: copy.buffer, sampleRate });
      },
      onLevel: () => {},
      onError: (m) => {
        $('mockMicHint').textContent = '语音出错：' + m;
      },
    });
    mockMicOn = true;
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
  if (mockMic) {
    try {
      mockMic.stop();
    } catch (_) {}
    mockMic = null;
  }
  mockMicOn = false;
  const btn = $('btnMockMic');
  if (btn) {
    btn.classList.remove('rec');
    btn.textContent = '按住说话';
  }
}

function bindMockEvents() {
  if (!$('btnMockStart')) return;

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
  };
  $('segMockCount').onclick = (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    markSeg('segMockCount', v);
    mockOpt.count = Number(v);
  };
  $('selVoice').onchange = () => {
    mockOpt.voice = $('selVoice').value;
    speakQuestion($('mockQuestion').textContent);
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
        if (mockOpt.mode === 'voice') speakQuestion(r.state.question);
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
    await mockSaveDraft();
    const r = await window.api.mockGoto(mockState.index + 1);
    if (r && r.ok) {
      renderMock(r.state);
      if (mockState.mode === 'voice') speakQuestion(r.state.question);
    }
  };

  $('btnMockFinish').onclick = async () => {
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

  $('btnMockQuit').onclick = async () => {
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

`;

src = src.slice(0, s) + BLOCK + src.slice(e);
fs.writeFileSync(file, src, 'utf8');
console.log('替换完成');
