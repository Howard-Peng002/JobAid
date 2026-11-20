'use strict';
/* 按用户的窗口尺寸复现：小窗口 + 大字号，看容器是否溢出视口 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

// 独立脚本要自己注册，否则页面调用会一直挂着
ipcMain.handle('ui:zoom', async (e, f) => {
  try {
    e.sender.setZoomFactor(f);
  } catch (_) {}
  return { ok: true, zoom: f };
});

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1092,
    height: 640,
    show: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '..', 'src', 'preload', 'console-preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'console.html'));
  await new Promise((r) => setTimeout(r, 900));

  for (const scale of [1, 1.1, 1.2]) {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const apiRes = await window.api.setZoom(${scale});
      applyZoom(${scale});
      await new Promise((res) => setTimeout(res, 700));
      const appEl = document.querySelector('.app');
      const rail = document.querySelector('.rail');
      const comp = document.querySelector('.composer');
      const ar = appEl.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      const cr = comp ? comp.getBoundingClientRect() : null;
      return JSON.stringify({
        scale: ${scale},
        apiRes: apiRes,
        zoomFactor: window.devicePixelRatio,
        innerW: window.innerWidth, innerH: window.innerHeight,
        appRect: [Math.round(ar.left), Math.round(ar.top), Math.round(ar.right), Math.round(ar.bottom)],
        inlineW: appEl.style.width, inlineH: appEl.style.height,
        railRight: Math.round(rr.right), railW: Math.round(rr.width),
        compBottom: cr ? Math.round(cr.bottom) : null,
        compTop: cr ? Math.round(cr.top) : null,
        bodyScrollW: document.body.scrollWidth, bodyScrollH: document.body.scrollHeight,
        panelMinW: getComputedStyle(document.querySelector('.panel.active') || document.querySelector('.panel')).minWidth,
      });
    })()`);
    console.log('[fit]', r);
  }

  for (const scale of [1.1, 1.2]) {
    await win.webContents.executeJavaScript(`applyZoom(${scale})`);
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(path.join(__dirname, '..', 'shots', 'fit-' + String(scale).replace('.', '_') + '.png'), (await win.webContents.capturePage()).toPNG());
  }

  app.quit();
});
