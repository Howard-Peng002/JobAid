'use strict';
/**
 * 验证调用时机：在窗口显示前 vs 显示后调用 setContentProtection，效果是否一致。
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const W = 320;
const H = 200;
const RECT = { x: 140, y: 140, width: W, height: H };

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!DOCTYPE html><html><body style="margin:0;background:#ff00ff;height:100vh"></body></html>'
)}`;

async function magentaRatio() {
  const display = screen.getPrimaryDisplay();
  const sz = display.size;
  const src = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: sz.width, height: sz.height },
  });
  const img = src[0].thumbnail;
  const isz = img.getSize();
  const bmp = img.toBitmap();
  const sx = isz.width / sz.width;
  const sy = isz.height / sz.height;
  let hit = 0;
  let tot = 0;
  for (let y = Math.floor(RECT.y * sy) + 8; y < Math.floor((RECT.y + H) * sy) - 8; y += 4) {
    for (let x = Math.floor(RECT.x * sx) + 8; x < Math.floor((RECT.x + W) * sx) - 8; x += 4) {
      const i = (y * isz.width + x) * 4;
      tot++;
      if (bmp[i + 2] > 200 && bmp[i] > 200 && bmp[i + 1] < 90) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('=== 调用时机对照 ===\n');

  // 情形 1：像真实 app 那样，先设置保护，再 load，再 show
  let win = new BrowserWindow({
    ...RECT,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // ← 显示之前调用（app 当前的做法）
  win.loadURL(PAGE);
  win.showInactive();
  await sleep(900);
  const r1 = await magentaRatio();
  win.destroy();
  await sleep(300);

  // 情形 2：load 并 show 之后再设置保护
  win = new BrowserWindow({
    ...RECT,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadURL(PAGE);
  win.showInactive();
  await sleep(500);
  win.setContentProtection(true); // ← 显示之后调用
  await sleep(700);
  const r2 = await magentaRatio();
  win.destroy();
  await sleep(300);

  console.log(`情形1  显示前设置保护   屏幕采集可见：${(r1 * 100).toFixed(1)}%   ${r1 < 0.05 ? '（已隐藏）' : '（★ 露了）'}`);
  console.log(`情形2  显示后设置保护   屏幕采集可见：${(r2 * 100).toFixed(1)}%   ${r2 < 0.05 ? '（已隐藏）' : '（★ 露了）'}`);
  console.log('\n如果情形1 > 5%，说明「窗口未显示时调用 setContentProtection 会失效」，这就是线上露出的根因。');
  setTimeout(() => app.quit(), 300);
});
