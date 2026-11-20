'use strict';
/**
 * 对照实验：透明窗口 vs 不透明窗口，setContentProtection 是否都能挡住屏幕采集？
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');

const W = 320;
const H = 200;

function html(bg, round) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!DOCTYPE html><html><body style="margin:0;background:${bg};height:100vh">
       <div style="position:absolute;inset:${round ? '10px' : '0'};background:#ff00ff;border-radius:14px"></div>
     </body></html>`
  )}`;
}

async function measure(rect) {
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
  for (let y = Math.floor(rect.y * sy) + 8; y < Math.floor((rect.y + rect.height) * sy) - 8; y += 4) {
    for (let x = Math.floor(rect.x * sx) + 8; x < Math.floor((rect.x + rect.width) * sx) - 8; x += 4) {
      const i = (y * isz.width + x) * 4;
      tot++;
      if (bmp[i + 2] > 200 && bmp[i] > 200 && bmp[i + 1] < 90) hit++; // BGRA 洋红
    }
  }
  return tot ? hit / tot : 0;
}

async function trial(name, opts, bg, round) {
  const rect = { x: 120, y: 120, width: W, height: H };
  const win = new BrowserWindow({
    ...rect,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: opts.transparent ? '#00000000' : '#ff00ff',
    webPreferences: { contextIsolation: true },
    ...opts,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadURL(html(bg, round));
  win.setContentProtection(true);
  win.showInactive();
  await new Promise((r) => setTimeout(r, 700));

  const prot = await measure(rect);
  win.setContentProtection(false);
  await new Promise((r) => setTimeout(r, 700));
  const raw = await measure(rect);

  win.destroy();
  await new Promise((r) => setTimeout(r, 250));

  const ok = raw > 0.5 && prot < 0.05;
  console.log(
    `${ok ? '  OK  ' : ' FAIL '} ${name}\n         保护中可见 ${(prot * 100).toFixed(1)}%  |  关闭保护可见 ${(raw * 100).toFixed(1)}%`
  );
  return ok;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  console.log('=== setContentProtection 对照实验 ===\n');
  const r1 = await trial('A. 不透明窗口（transparent:false）', { transparent: false }, '#ff00ff', false);
  const r2 = await trial('B. 透明窗口 + 页面内不透明色块（transparent:true）', { transparent: true }, 'transparent', true);
  const r3 = await trial('C. 透明窗口 + 整页不透明背景（transparent:true）', { transparent: true }, '#ff00ff', false);

  console.log('\n结论：');
  console.log('  不透明窗口可防共享 =', r1);
  console.log('  透明窗口可防共享   =', r2 && r3);
  setTimeout(() => app.quit(), 300);
});
