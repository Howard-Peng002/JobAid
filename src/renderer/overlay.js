'use strict';
/* 悬浮窗渲染进程：只做展示，不接收任何输入 */

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------- 拖动
 * 窗口该不该接收鼠标，由主进程按真实光标位置决定（标题栏/四边 = 可交互，正文 = 穿透），
 * 这里只负责"按下之后把窗口挪到哪"。
 *
 * 拖拽用「绝对定位 + 指针捕获 + 帧内合并」：
 * - 按下时记住窗口左上角与指针的起点，移动时算目标坐标直接发过去，
 *   不再逐帧累加位移（累加会因取整抖动、丢帧越拖越慢）。
 * - setPointerCapture 保证指针甩出窗口外也继续收到事件。
 * - requestAnimationFrame 合并同一帧内的多次移动，一帧只发一次 IPC。
 */
// 主进程通过 overlay:wake / overlay:sleep 告知真实交互态，这里只留一份镜像用于诊断
let interactive = false;

// 诊断用：暴露内部状态，便于 --stealthtest 等脚本核对
window.__ov = {
  get interactive() {
    return interactive;
  },
  get act() {
    return act;
  },
  get maxed() {
    return maxed;
  },
};

const barEl = document.querySelector('.bar');
const handles = [...document.querySelectorAll('.rz')];

let act = null; // { kind:'move'|'resize', edge, sx, sy, start:{x,y,w,h} }
let raf = 0;
let latest = null;
let dragMoved = false;
let autoHeight = true; // 由主进程通过 overlay:cfg 下发
let maxed = false;

function applyPending() {
  if (!act || !latest) return;
  const n = latest;
  latest = null;
  if (act.kind === 'move') {
    window.api.moveTo(Math.round(n.x), Math.round(n.y));
  } else {
    window.api.resizeTo(act.edge, Math.round(n.x), Math.round(n.y), Math.round(n.w), Math.round(n.h));
  }
}

function queue(next) {
  latest = next;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    applyPending();
  });
}

function startDrag(kind, edge, e) {
  const el = kind === 'move' ? barEl : e.currentTarget;
  try {
    el.setPointerCapture(e.pointerId);
  } catch (_) {}
  act = {
    kind,
    edge,
    sx: e.screenX,
    sy: e.screenY,
    start: { x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight },
  };
  dragMoved = false;
  if (kind === 'move') {
    window.api.beginDrag(); // 锁住尺寸，拖动过程不允许被内容自适应改高度
  } else {
    autoHeight = false;
    clearTimeout(resizeTimer);
  }
  e.preventDefault();
}

barEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.winbtns')) return;
  startDrag('move', '', e);
});

handles.forEach((h) => {
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || maxed) return;
    startDrag('resize', h.dataset.edge, e);
    e.stopPropagation();
  });
});

/**
 * 指针/鼠标移动统一入口。
 * 注意：窗口在穿透态（setIgnoreMouseEvents(true,{forward:true})）时，Windows 只把
 * 合成的 mouse 事件转发进来，pointermove 不会触发。只监听 pointermove 的话，
 * 鼠标移到标题栏也醒不过来，窗口就等于焊死在穿透状态——拖不动、点不了。
 */
function onMove(e) {
  if (act) {
    const dx = e.screenX - act.sx;
    const dy = e.screenY - act.sy;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;

    if (act.kind === 'move') {
      queue({
        x: act.start.x + dx,
        y: act.start.y + dy,
        w: act.start.w,
        h: act.start.h,
      });
      return;
    }

    const edge = act.edge;
    let { x, y, w, h } = act.start;
    if (edge.includes('e')) w = act.start.w + dx;
    if (edge.includes('s')) h = act.start.h + dy;
    if (edge.includes('w')) {
      w = act.start.w - dx;
      x = act.start.x + dx;
    }
    if (edge.includes('n')) {
      h = act.start.h - dy;
      y = act.start.y + dy;
    }
    queue({ x, y, w, h });
  }
}

// 这里只负责"拖动中"的位移计算。
// 窗口该不该接收鼠标（标题栏/边缘 = 可交互，正文 = 穿透）完全由主进程按
// 真实光标位置决定 —— 渲染层永远收不到可靠的事件转发，别再让它参与判断。
document.addEventListener('pointermove', onMove);

// 主进程会主动改穿透态（显示窗口、防护补救、光标进出热区），同步本地状态供诊断
window.api.on('overlay:wake', () => {
  interactive = true;
});
window.api.on('overlay:sleep', () => {
  interactive = false;
});

function endAct() {
  if (!act) return;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  // 松手前把还没提交的最后一帧补上，否则"快速拖一下就松手"会完全不动
  applyPending();
  const kind = act.kind;
  act = null;
  latest = null;
  if (kind === 'move') window.api.endDrag();
  else window.api.endResize();
}

document.addEventListener('pointerup', endAct);
document.addEventListener('pointercancel', endAct);
window.addEventListener('blur', () => {
  endAct();
});

/* ------------------------------------------------------- 窗口按钮 */
$('wbMin').addEventListener('click', () => window.api.compact());
$('wbMax').addEventListener('click', () => window.api.maximize());
$('wbClose').addEventListener('click', () => window.api.close());

// 双击标题栏 = 最大化/还原（和普通窗口一致）
barEl.addEventListener('dblclick', () => {
  if (dragMoved) return;
  window.api.maximize();
});

let acc = '';
let resizeTimer = null;

/* 让悬浮窗高度贴合内容，避免大片空白 */
function fitHeight(payload) {
  if (payload && typeof payload.autoHeight === 'boolean') autoHeight = payload.autoHeight;
  if (!autoHeight) return; // 用户手动缩放过，就别再按内容改高度
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const box = $('a');
    let contentH = 0;
    for (const el of box.children) {
      const cs = getComputedStyle(el);
      contentH += el.offsetHeight + (parseFloat(cs.marginBottom) || 0);
    }
    const q = $('q');
    const qh = q.textContent.trim() ? q.offsetHeight + 12 : 0;
    // wrap 内边距16 + 顶栏38 + 底栏28 + 正文上下内边距24
    const total = 16 + 38 + 28 + qh + contentH + 24;
    window.api.resize(total);
  }, 140);
}

function setDot(kind, text) {
  const d = $('dot');
  d.className = 'dot' + (kind ? ' ' + kind : '');
  $('phase').textContent = text;
}

function renderAnswer(text) {
  const box = $('a');
  box.textContent = '';
  text.split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const div = document.createElement('div');
    div.className = 'ln';
    div.textContent = line;
    box.appendChild(div);
  });
  if (!box.children.length) {
    const s = document.createElement('span');
    s.className = 'ph';
    s.textContent = '…';
    box.appendChild(s);
  }
}

window.api.on('overlay:cfg', (c) => {
  document.documentElement.style.setProperty('--op', c.opacity ?? 0.95);
  document.body.dataset.theme = c.theme === 'light' ? 'light' : 'dark';
  if (typeof c.autoHeight === 'boolean') autoHeight = c.autoHeight;
  if (typeof c.maxed === 'boolean') {
    maxed = c.maxed;
    document.body.classList.toggle('maxed', maxed);
  }
  // 收起状时隐藏正文，只留标题栏
  document.body.classList.toggle('compact', !!c.compact);
});

window.api.on('listen:state', (p) => {
  if (p.listening) setDot('on', '监听中');
  else setDot('', '已暂停');
});

window.api.on('session:clear', () => {
  acc = '';
  $('q').textContent = '';
  $('a').innerHTML = '<span class="ph">等待面试官提问…</span>';
  fitHeight();
});

window.api.on('llm:start', (p) => {
  acc = '';
  $('q').textContent = p.question || '';
  const box = $('a');
  box.textContent = '';
  box.classList.add('streaming');
  box.scrollTop = 0;
  setDot('think', '思考中');
  fitHeight();
});

window.api.on('llm:delta', (p) => {
  acc += p.text;
  renderAnswer(acc);
  setDot('think', '思考中');
  fitHeight();
});

window.api.on('llm:done', (p) => {
  const text = (p.text || acc || '').trim();
  const box = $('a');
  box.classList.remove('streaming');
  if (/^[—\-–]+$/.test(text)) {
    box.innerHTML = '<span class="ph">（面试官在陈述，无需作答）</span>';
  } else {
    renderAnswer(text);
  }
  setDot('on', '就绪');
  fitHeight();
});

window.api.on('llm:error', (p) => {
  const box = $('a');
  box.classList.remove('streaming');
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'err';
  d.textContent = '生成失败：' + p.message;
  box.appendChild(d);
  setDot('err', '出错');
  fitHeight();
});

window.addEventListener('DOMContentLoaded', () => fitHeight());
