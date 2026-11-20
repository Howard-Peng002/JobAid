'use strict';
/**
 * 渲染 logo 预览图（开发用）：shots/logo-preview.png
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/logo-preview.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 560,
    backgroundColor: '#F6F7FB',
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, 'logo-preview.html'));
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'shots', 'logo-preview.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out, img.getSize());
  app.quit();
});
