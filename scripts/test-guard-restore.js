'use strict';
/** 取消鼠标穿透后，防护能否恢复？ */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const RECT = { x: 220, y: 200, width: 320, height: 200 };
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

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadURL(PAGE);
  win.showInactive();

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(true);
  await sleep(800);
  console.log(`穿透开启 + 防护     可见 ${(await ratio() * 100).toFixed(1)}%`);

  win.setIgnoreMouseEvents(false);
  win.setContentProtection(true);
  await sleep(900);
  const r2 = await ratio();
  console.log(`取消穿透 + 重贴防护 可见 ${(r2 * 100).toFixed(1)}%   ${r2 < 0.05 ? '（已恢复）' : '（★ 无法恢复）'}`);

  win.destroy();
  setTimeout(() => app.quit(), 300);
});
