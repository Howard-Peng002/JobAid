'use strict';
/* 语音模式改为通话视图 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'console.js');
let src = fs.readFileSync(file, 'utf8');

// 1) 插入通话视图渲染函数（放在 renderMock 之前）
const anchor = 'function renderMock(st) {';
const helpers = `function addCallMsg(kind, who, text) {
  const box = $('callStream');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'call-msg ' + kind;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  d.appendChild(w);
  d.appendChild(document.createTextNode(text));
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
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
    badge.textContent = \`\${st.type === 'hr' ? 'HR' : '技术'}面试 · 第 \${st.index + 1}/\${st.total} 题\`;
  }
  const box = $('callStream');
  if (box) {
    box.innerHTML = '';
    (st.items || []).forEach((it, i) => {
      if (it.q) addCallMsg('ai', \`第 \${i + 1} 题\`, it.q);
      if ((it.a || '').trim()) addCallMsg('me', '我', it.a.trim());
    });
    box.scrollTop = box.scrollHeight;
  }
}

${anchor}`;

if (!src.includes(anchor)) {
  console.log('锚点缺失');
  process.exit(1);
}
src = src.replace(anchor, helpers);

// 2) renderMock：语音模式走通话视图
src = src.replace(
  `  mockState = st || { active: false };

  if (!st || !st.active) {`,
  `  mockState = st || { active: false };
  const call = $('mockCall');
  if (call) call.hidden = true;

  if (!st || !st.active) {`
);

src = src.replace(
  `  if (!st.done) {
    setup.hidden = true;
    run.hidden = false;
    done.hidden = true;

    const voiceMode = st.mode === 'voice';`,
  `  if (!st.done && st.mode === 'voice') {
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

    const voiceMode = false;`
);

fs.writeFileSync(file, src, 'utf8');
console.log('通话视图已接入');
