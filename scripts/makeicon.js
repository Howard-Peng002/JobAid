'use strict';
/**
 * 生成应用图标：build/logo.svg → PNG 多尺寸 + Windows .ico
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/makeicon.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ASSETS = path.join(ROOT, 'src', 'renderer', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function makeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  await win.loadFile(path.join(__dirname, 'icon-render.html'));
  fs.mkdirSync(ASSETS, { recursive: true });

  const entries = [];
  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`renderPng(${size})`);
    const png = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    entries.push({ size, png });
    if (size === 256) fs.writeFileSync(path.join(BUILD, 'icon.png'), png);
    if (size === 64) fs.writeFileSync(path.join(ASSETS, 'tray.png'), png);
    if (size === 32) fs.writeFileSync(path.join(BUILD, 'icon-32.png'), png);
  }

  fs.writeFileSync(path.join(BUILD, 'icon.ico'), makeIco(entries));
  console.log('icon.ico bytes:', fs.statSync(path.join(BUILD, 'icon.ico')).size);
  console.log('icon.png bytes:', fs.statSync(path.join(BUILD, 'icon.png')).size);
  console.log('done');
  app.quit();
});
