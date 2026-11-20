/**
 * 模拟面试官
 * ------------------------------------------------------------
 * 把题库里的问题用系统中文音色念出来。
 * 声音走默认播放设备 → JobAid 通过系统回环采集到 → 走完整的
 * 「断句 → 识别 → 判定提问 → 检索/作答 → 悬浮窗」链路。
 *
 * 用法：
 *   node scripts/interviewer.js            交互窗口（默认）
 *   node scripts/interviewer.js --say 3    只念第 3 题然后退出
 *   node scripts/interviewer.js --all      依次念完全部，间隔 14 秒
 *   node scripts/interviewer.js --list     列出题库
 *
 * 注意：必须用 `env -u ELECTRON_RUN_AS_NODE` 启动（本机该变量会让 Electron 退化成 Node）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const BANK = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const QS = BANK.questions;

if (args.includes('--list')) {
  QS.forEach((q, i) => console.log(`${String(i + 1).padStart(2)}. [${q.cat}] ${q.text}`));
  process.exit(0);
}

const ONLY = argOf('--say') ? Number(argOf('--say')) - 1 : null;
const ALL = args.includes('--all');
const MODE = ONLY !== null ? 'once' : ALL ? 'all' : 'ui';
const GAP = Number(argOf('--gap') || 14) * 1000;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let idx = ONLY !== null ? ONLY : 0;
let autoTimer = null;
let autoOn = ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.log('[interviewer]', ...a);
}

function status(text, live) {
  if (win && !win.isDestroyed()) win.webContents.send('status', { text, live: !!live });
  log(text);
}

function pushQuestion() {
  if (!win || win.isDestroyed()) return;
  const q = QS[idx];
  if (!q) return;
  win.webContents.send('q', {
    index: idx,
    total: QS.length,
    cat: q.cat,
    text: q.text,
    hint: q.hint,
  });
}

async function speak(text, rate) {
  if (!win || win.isDestroyed()) return 'no-window';
  const r = await win.webContents.executeJavaScript(
    `window.speakNow(${JSON.stringify(text)}, ${rate || 1.05})`
  );
  return r;
}

async function speakCurrent() {
  const q = QS[idx];
  if (!q) return;
  status(`正在朗读第 ${idx + 1} 题…`, false);
  const started = Date.now();
  const r = await speak(q.text);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  status(`第 ${idx + 1} 题朗读结束（${sec}s，${r}）`, true);
  return r;
}

function scheduleNext() {
  clearTimeout(autoTimer);
  if (!autoOn) return;
  if (idx >= QS.length - 1) {
    status('全部题目已问完', true);
    if (MODE === 'all') setTimeout(() => app.quit(), 1200);
    return;
  }
  status(`等 ${GAP / 1000} 秒后问下一题…`, false);
  autoTimer = setTimeout(async () => {
    idx += 1;
    pushQuestion();
    await sleep(500);
    await speakCurrent();
    scheduleNext();
  }, GAP);
}

async function step(dir) {
  clearTimeout(autoTimer);
  const next = Math.max(0, Math.min(QS.length - 1, idx + dir));
  if (next === idx) return;
  idx = next;
  pushQuestion();
  if (autoOn) {
    await sleep(400);
    await speakCurrent();
    scheduleNext();
  }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 720,
    height: 340,
    minWidth: 560,
    show: MODE === 'ui',
    alwaysOnTop: MODE === 'ui',
    title: '模拟面试官',
    backgroundColor: '#14161d',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname, 'interviewer.html'));

  // 等渲染层报就绪，再等音色列表加载完
  await new Promise((resolve) => {
    let done = false;
    ipcMain.once('ui:ready', () => { done = true; resolve(); });
    setTimeout(() => { if (!done) resolve(); }, 3000);
  });
  await sleep(600);

  pushQuestion();
  log(`题库 ${QS.length} 题 · 模式 ${MODE}`);

  ipcMain.on('cmd', async (_e, cmd) => {
    if (cmd === 'speak') {
      const r = await speakCurrent();
      if (r === 'ended' || r === 'timeout') scheduleNext();
    } else if (cmd === 'next') step(1);
    else if (cmd === 'prev') step(-1);
    else if (cmd === 'auto-on') { autoOn = true; status('自动连问已开启', true); }
    else if (cmd === 'auto-off') { autoOn = false; clearTimeout(autoTimer); status('自动连问已关闭', false); }
    else if (cmd === 'quit') app.quit();
  });
  ipcMain.on('gap', (_e, ms) => {
    log('间隔改为', ms, '秒');
  });

  if (MODE === 'once') {
    await sleep(400);
    await speakCurrent();
    await sleep(700);
    app.quit();
    return;
  }

  if (MODE === 'all') {
    await sleep(600);
    await speakCurrent();
    scheduleNext();
  }
});

app.on('window-all-closed', () => app.quit());
