'use strict';
/* 检查通话气泡的实际计算样式，确认 me 气泡是不是真的用了深色底 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    webPreferences: { offscreen: true, preload: path.join(__dirname, '..', 'src', 'preload', 'console-preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'console.html'));
  await new Promise((r) => setTimeout(r, 800));

  const r = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('callStream');
    box.innerHTML = '';
    const mk = (kind, who, text) => {
      const d = document.createElement('div');
      d.className = 'call-msg ' + kind;
      const w = document.createElement('span');
      w.className = 'who'; w.textContent = who;
      const b = document.createElement('span');
      b.className = 'body'; b.textContent = text;
      d.appendChild(w); d.appendChild(b);
      box.appendChild(d);
      return d;
    };
    const me = mk('me', '我', '这是我说的话');
    const ai = mk('ai', '第 1 题', '这是面试官的问题');
    const cm = getComputedStyle(me);
    const ca = getComputedStyle(ai);
    return JSON.stringify({
      meClass: me.className,
      meBg: cm.backgroundColor,
      meColor: cm.color,
      meAlign: cm.alignSelf,
      aiBg: ca.backgroundColor,
      aiColor: ca.color,
      varText: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
    });
  })()`);

  console.log('[bubblecheck]', r);
  app.quit();
});
