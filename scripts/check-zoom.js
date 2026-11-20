'use strict';
/* 依次切换字号，观察每一档的视口与容器尺寸，定位累积误差 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1120,
    height: 880,
    show: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '..', 'src', 'preload', 'console-preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'console.html'));
  await new Promise((r) => setTimeout(r, 900));

  for (const scale of [1, 0.9, 1.1, 1.2, 1, 1.2, 0.9]) {
    const r = await win.webContents.executeJavaScript(`(async () => {
      applyZoom(${scale});
      await new Promise((res) => setTimeout(res, 250));
      const appEl = document.querySelector('.app');
      const rect = appEl.getBoundingClientRect();
      return JSON.stringify({
        scale: ${scale},
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        clientW: document.documentElement.clientWidth,
        clientH: document.documentElement.clientHeight,
        appW: Math.round(rect.width),
        appH: Math.round(rect.height),
        inlineW: appEl.style.width,
        inlineH: appEl.style.height,
        railScrollH: document.querySelector('.rail').scrollHeight,
        railClientH: document.querySelector('.rail').clientHeight,
        railScrollbarW: document.querySelector('.rail').offsetWidth - document.querySelector('.rail').clientWidth,
        docScrollW: document.documentElement.scrollWidth,
        docScrollH: document.documentElement.scrollHeight,
      });
    })()`);
    console.log('[zoomcheck]', r);
  }

  // 截三档各一张
  for (const scale of [0.9, 1, 1.2]) {
    await win.webContents.executeJavaScript(`applyZoom(${scale})`);
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(path.join(__dirname, '..', 'shots', 'zoom-' + String(scale).replace('.', '_') + '.png'), (await win.webContents.capturePage()).toPNG());
  }

  app.quit();
});
