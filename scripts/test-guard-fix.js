'use strict';
/** 确认最终修复方案：鼠标穿透放到窗口显示之后再调用。 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const RECT = { x: 240, y: 220, width: 320, height: 200 };
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!DOCTYPE html><html><body style="margin:0;background:#ff00ff;height:100vh"></body></html>'
)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ratio() {
  const d = screen.getPrimaryDisplay();
  const sz = d.size;
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sz.width, height: sz.height } });
  const img = src[0].thumbnail;
  const isz = img.getSize();
  const bmp = img.toBitmap();
  const sx = isz.width / sz.width,
    sy = isz.height / sz.height;
  let hit = 0,
    tot = 0;
  for (let y = Math.floor(RECT.y * sy) + 8; y < Math.floor((RECT.y + RECT.height) * sy) - 8; y += 4) {
    for (let x = Math.floor(RECT.x * sx) + 8; x < Math.floor((RECT.x + RECT.width) * sx) - 8; x += 4) {
      const i = (y * isz.width + x) * 4;
      tot++;
      if (bmp[i + 2] > 200 && bmp[i] > 200 && bmp[i + 1] < 90) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

function base() {
  const w = new BrowserWindow({
    ...RECT,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  return w;
}

async function run(label, fn) {
  const win = base();
  await fn(win);
  await sleep(900);
  const r = await ratio();
  win.destroy();
  await sleep(250);
  console.log(`${r < 0.05 ? '  OK  ' : ' FAIL '} ${label}  — 可见 ${(r * 100).toFixed(1)}%`);
  return r < 0.05;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('=== 最终方案验证 ===\n');

  // A：现状（创建时就设穿透，再贴防护，然后加载显示）
  await run('A. 创建时设穿透（当前 app 做法）', async (w) => {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setContentProtection(true);
    await w.loadURL(PAGE);
    w.showInactive();
  });

  // B：修复方案（先贴防护，加载显示后再设穿透）
  const okB = await run('B. 显示后再设穿透（修复方案）', async (w) => {
    w.setContentProtection(true);
    await w.loadURL(PAGE);
    w.showInactive();
    await sleep(250);
    w.setIgnoreMouseEvents(true, { forward: true });
  });

  // C：修复方案 + 定期重贴防护（app 里的守护循环行为）
  const okC = await run('C. 修复方案 + 之后每 4s 重贴防护', async (w) => {
    w.setContentProtection(true);
    await w.loadURL(PAGE);
    w.showInactive();
    await sleep(250);
    w.setIgnoreMouseEvents(true, { forward: true });
    setTimeout(() => w.setContentProtection(true), 500);
  });

  console.log('\n结论：修复方案有效 =', okB && okC);
  setTimeout(() => app.quit(), 300);
});
