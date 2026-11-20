// 验证 Electron 里的 speechSynthesis 能否用系统中文音色朗读
const { app, BrowserWindow } = require('electron');
const path = require('path');

const TEXT = '你在轴承监测项目里，三通道 50k 采样率是怎么保证不丢数的？';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('data:text/html;charset=utf-8,<body>tts</body>');

  const voices = await win.webContents.executeJavaScript(
    `new Promise((r) => {
       const get = () => speechSynthesis.getVoices();
       let v = get();
       if (v.length) return r(v.map(x => x.name + '|' + x.lang));
       speechSynthesis.onvoiceschanged = () => r(get().map(x => x.name + '|' + x.lang));
       setTimeout(() => r(get().map(x => x.name + '|' + x.lang)), 2500);
     })`
  );
  console.log('音色数:', voices.length);
  voices.forEach((v) => console.log('  -', v));

  const zh = voices.filter((v) => /zh|Chinese|Huihui|Yaoyao|Kangkang/i.test(v));
  console.log('中文音色:', zh.length ? zh.join(', ') : '无');

  const ok = await win.webContents.executeJavaScript(
    `new Promise((r) => {
       try {
         const u = new SpeechSynthesisUtterance(${JSON.stringify(TEXT)});
         const vs = speechSynthesis.getVoices();
         const pick = vs.find(v => /zh/i.test(v.lang)) || vs[0];
         if (pick) u.voice = pick;
         u.lang = pick ? pick.lang : 'zh-CN';
         u.rate = 1.0;
         u.onstart = () => r('started');
         u.onend = () => r('ended');
         u.onerror = (e) => r('error:' + (e.error || 'unknown'));
         speechSynthesis.speak(u);
         setTimeout(() => r('timeout-no-event'), 12000);
       } catch (e) { r('throw:' + e.message); }
     })`
  );
  console.log('朗读结果:', ok);
  app.quit();
});
