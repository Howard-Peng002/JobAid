'use strict';
/** 找出让窗口真正不进任务栏的写法。外部用 python 探针读扩展样式。 */
const { app, BrowserWindow } = require('electron');

const HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#333"></body>');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const mk = async (title, opt, lateSkip) => {
    const w = new BrowserWindow({ width: 300, height: 160, title, ...opt, webPreferences: { contextIsolation: true } });
    await w.loadURL(HTML);
    w.setTitle(title);
    if (lateSkip) {
      await new Promise((r) => setTimeout(r, 400));
      w.setSkipTaskbar(true);
    }
    return w;
  };

  await mk('T1-skip-as-option', { skipTaskbar: true });
  await mk('T2-type-toolbar', { skipTaskbar: true, type: 'toolbar' });
  await mk('T3-late-setSkip', { skipTaskbar: false }, true);
  await mk('T4-parent-owned', { skipTaskbar: true, parent: await mk('T-parent', { show: false }) });

  console.log('4 个测试窗口已创建，保持 14 秒…');
  setTimeout(() => app.quit(), 14000);
});
