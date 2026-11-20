'use strict';
/**
 * 验证：窗口 resize（setBounds）之后，setContentProtection 是否失效？
 * 悬浮窗每次出答案都会 fitHeight → setBounds，如果这里失效，正好解释「内容一出现就露」。
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const RECT = { x: 160, y: 160, width: 320, height: 200 };
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!DOCTYPE html><html><body style="margin:0;background:#ff00ff;height:100vh"></body></html>'
)}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    backgroundColor: '#00000000',
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadURL(PAGE);
  win.showInactive();
  win.setContentProtection(true);
  await sleep(800);

  const before = await ratio(RECT);
  console.log(`resize 之前        可见 ${(before * 100).toFixed(1)}%`);

  // 模拟 fitHeight：改高度
  win.setBounds({ ...RECT, height: RECT.height + 60 });
  await sleep(700);
  const after = await ratio({ ...RECT, height: RECT.height + 60 });
  console.log(`setBounds 之后      可见 ${(after * 100).toFixed(1)}%   ${after < 0.05 ? '（仍隐藏）' : '（★ 露了！）'}`);

  // 再补一次保护
  win.setContentProtection(true);
  await sleep(600);
  const fixed = await ratio({ ...RECT, height: RECT.height + 60 });
  console.log(`重新贴一次保护后    可见 ${(fixed * 100).toFixed(1)}%`);

  win.destroy();
  setTimeout(() => app.quit(), 300);
});
