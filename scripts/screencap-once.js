// 一次性全屏截图，用于读取系统窗口内容（诊断用）
const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const srcs = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2560, height: 1600 },
    });
    if (!srcs.length) {
      console.log('[cap] 没有拿到屏幕源');
      app.quit();
      return;
    }
    const out = path.join(__dirname, '..', 'shots', 'device-code.png');
    const png = srcs[0].thumbnail.toPNG();
    fs.writeFileSync(out, png);
    console.log('[cap] 已保存', out, png.length, 'bytes', srcs[0].thumbnail.getSize());
  } catch (e) {
    console.log('[cap] 失败', e.message);
  }
  app.quit();
});
