'use strict';
/**
 * 截取控制台窗口左上角，确认标题栏图标是否已去掉。
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-titlebar.js
 */
const { app, desktopCapturer, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const CFG = path.join(process.env.APPDATA || '', 'interview-copilot', 'config.json');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const b = cfg.windowBounds || { x: 0, y: 0, width: 1120, height: 880 };
  const d = screen.getPrimaryDisplay();
  const scale = d.scaleFactor || 1;

  const src = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) },
  });
  const img = src[0].thumbnail;

  // 裁窗口左上角 280x48（物理像素）
  const rect = {
    x: Math.max(0, Math.round(b.x * scale)),
    y: Math.max(0, Math.round(b.y * scale)),
    width: Math.round(280 * scale),
    height: Math.round(48 * scale),
  };
  const cropped = img.crop(rect);
  const out = path.join(__dirname, '..', 'shots', 'titlebar.png');
  fs.writeFileSync(out, cropped.toPNG());
  console.log('saved', out, cropped.getSize(), 'windowBounds=', JSON.stringify(b));
  app.quit();
});
