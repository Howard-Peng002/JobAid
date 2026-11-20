'use strict';
/**
 * 开发期自检：
 *  1) 系统声音回环采集是否可用（面试官的声音）
 *  2) setContentProtection 是否真的让窗口从屏幕采集中消失
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/test-probe.js
 */
const { app, BrowserWindow, session, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

function writeTone(file, seconds, freq) {
  const rate = 44100;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 4);
    const v = Math.sin(2 * Math.PI * freq * t) * 0.45 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.2;
    buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(v * env * 30000))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDisplayMediaRequestHandler(
    (req, cb) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((s) => cb(s.length ? { video: s[0], audio: 'loopback' } : {}))
        .catch(() => cb({}));
    },
    { useSystemPicker: false }
  );

  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, 'test-audio.html'));

  // 在同一进程内播放，排除外部播放器变量
  const tone = path.join(__dirname, 'tone.wav');
  writeTone(tone, 8, 660);
  const url = 'file:///' + tone.replace(/\\/g, '/');
  const playState = await win.webContents.executeJavaScript(`window.__play(${JSON.stringify(url)})`);
  console.log('播放状态:', playState);

  const info = await win.webContents.executeJavaScript('window.__run(4000)');
  console.log('=== 系统声音回环 ===');
  console.log('音轨数:', info.tracks, '| 标签:', JSON.stringify(info.labels || []));
  console.log('每 0.5s 平均 RMS:', JSON.stringify(info.rms));
  const peak = Math.max(0, ...(info.rms || [0]));
  console.log('峰值 RMS:', peak, peak > 0.002 ? '=> OK 回环有声音' : '=> FAIL 没有采到声音');
  if (info.error) console.log('错误:', info.error);

  // ---------- 内容保护 ----------
  const display = screen.getPrimaryDisplay();
  const w = 320,
    h = 200;
  const x = display.workArea.x + 80,
    y = display.workArea.y + 80;

  const probe = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#ff00ff',
    webPreferences: { contextIsolation: false },
  });
  await probe.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
  probe.setAlwaysOnTop(true, 'screen-saver');
  probe.setContentProtection(true);
  await new Promise((r) => setTimeout(r, 900));

  const grab = async () => {
    const sz = display.size;
    const src = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: sz.width, height: sz.height },
    });
    const img = src[0].thumbnail;
    const isz = img.getSize();
    const bmp = img.toBitmap();
    const sx = isz.width / sz.width,
      sy = isz.height / sz.height;
    let hit = 0,
      tot = 0;
    for (let yy = Math.floor(y * sy) + 10; yy < Math.floor((y + h) * sy) - 10; yy += 6) {
      for (let xx = Math.floor(x * sx) + 10; xx < Math.floor((x + w) * sx) - 10; xx += 6) {
        const i = (yy * isz.width + xx) * 4;
        tot++;
        if (bmp[i + 2] > 200 && bmp[i] > 200 && bmp[i + 1] < 90) hit++;
      }
    }
    return { ratio: hit / Math.max(1, tot) };
  };

  const withProt = await grab();
  probe.setContentProtection(false);
  await new Promise((r) => setTimeout(r, 900));
  const withoutProt = await grab();

  console.log('\n=== 内容保护（防共享）===');
  console.log('开启保护时洋红像素占比:', (withProt.ratio * 100).toFixed(2) + '%');
  console.log('关闭保护时洋红像素占比:', (withoutProt.ratio * 100).toFixed(2) + '%');
  console.log(
    withoutProt.ratio > 0.5 && withProt.ratio < 0.05
      ? '=> OK 内容保护生效：开启后窗口完全不出现在画面里'
      : '=> FAIL 内容保护未按预期生效'
  );

  probe.destroy();
  win.destroy();
  setTimeout(() => app.quit(), 300);
});
