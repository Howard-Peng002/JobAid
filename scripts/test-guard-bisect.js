'use strict';
/**
 * 逐项排查：真实悬浮窗的哪个设置会让 setContentProtection 失效。
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const RECT = { x: 200, y: 180, width: 320, height: 200 };
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!DOCTYPE html><html><body style="margin:0;background:#ff00ff;height:100vh"></body></html>'
)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ratio(rect) {
  const d = screen.getPrimaryDisplay();
  const sz = d.size;
  const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sz.width, height: sz.height } });
  const img = src[0].thumbnail;
  const isz = img.getSize();
  const bmp = img.toBitmap();
  const sx = isz.width / sz.width;
  const sy = isz.height / sz.height;
  let hit = 0,
    tot = 0;
  for (let y = Math.floor(rect.y * sy) + 8; y < Math.floor((rect.y + rect.height) * sy) - 8; y += 4) {
    for (let x = Math.floor(rect.x * sx) + 8; x < Math.floor((rect.x + rect.width) * sx) - 8; x += 4) {
      const i = (y * isz.width + x) * 4;
      tot++;
      if (bmp[i + 2] > 200 && bmp[i] > 200 && bmp[i + 1] < 90) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

/** 与 createOverlayWindow 完全一致的基础配置 */
function makeWin() {
  const win = new BrowserWindow({
    ...RECT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  return win;
}

async function trial(label, setup) {
  const win = makeWin();
  if (setup) setup(win);
  win.setContentProtection(true);
  await win.loadURL(PAGE);
  win.showInactive();
  await sleep(900);
  const r = await ratio(RECT);
  win.destroy();
  await sleep(250);
  const ok = r < 0.05;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}  — 采集中可见 ${(r * 100).toFixed(1)}%`);
  return ok;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('=== 逐项排查：哪个设置让防护失效 ===\n');
  const results = {};

  results.base = await trial('0. 基础配置（无附加设置）', null);
  results.ignoreMouse = await trial('1. + setIgnoreMouseEvents(true,{forward:true})', (w) =>
    w.setIgnoreMouseEvents(true, { forward: true })
  );
  results.allWorkspaces = await trial('2. + setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})', (w) =>
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  );
  results.both = await trial('3. + 两者都有（= 当前 app 的真实配置）', (w) => {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  });
  results.noForward = await trial('4. setIgnoreMouseEvents(true) 不带 forward', (w) => {
    w.setIgnoreMouseEvents(true);
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  });

  console.log('\n=== 结论 ===');
  Object.entries(results).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v ? '正常隐藏' : '★ 失效'}`));
  setTimeout(() => app.quit(), 300);
});
