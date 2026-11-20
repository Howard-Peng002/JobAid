'use strict';
/**
 * 验证：把回环流的 video 轨禁用/停掉之后，音频是否还继续进来？
 */
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
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
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 0.5 * env * 30000), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((w, p, cb) => cb(true));
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

  const tone = path.join(__dirname, 'tone.wav');
  writeTone(tone, 40, 620);

  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'test-loopback-video.html'));

  const url = 'file:///' + tone.replace(/\\/g, '/');
  const play = await win.webContents.executeJavaScript(`window.__play(${JSON.stringify(url)})`);
  console.log('播放:', play);
  await sleep(400);

  console.log('\n=== 回环音频：video 轨状态的影响 ===');
  for (const mode of ['keep', 'disableVideo', 'stopVideo']) {
    const r = await win.webContents.executeJavaScript(`window.__capture(${JSON.stringify(mode)}, 2500)`);
    const label = {
      keep: 'video 保持开启',
      disableVideo: 'video.enabled=false（应用当前做法）',
      stopVideo: 'video track.stop()',
    }[mode];
    if (r.error) {
      console.log(` FAIL  ${label} —— ${r.error}`);
    } else {
      console.log(
        `${r.rms > 0.002 ? '  OK  ' : ' FAIL '} ${label.padEnd(30)} RMS=${r.rms} 音轨=${r.audioTracks} 视轨=${r.videoTracks} ctx=${r.ctxRate}`
      );
    }
    await sleep(500);
  }

  win.destroy();
  setTimeout(() => app.quit(), 300);
});
