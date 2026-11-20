'use strict';
/**
 * 端到端管道自检：音频流 → VAD 断句 → 重采样 → 本地 ASR
 * 验证的是应用真实使用的 audio-engine.js 与 asr.js。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  // audio-engine.js 里用到了 Buffer（Node 侧），页面里用 btoa 替代
  await win.loadFile(path.join(__dirname, 'test-pipeline.html'));
  await win.webContents.executeJavaScript(
    'window.Buffer = { from: (ab) => ({ toString: () => { const u8 = new Uint8Array(ab); let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); } }) }; void 0;'
  );

  const wav = 'file:///' + path.join(__dirname, '..', 'models', 'test_zh.wav').replace(/\\/g, '/');
  console.log('开始采集（会外放约 6 秒测试语音）…');
  const t0 = Date.now();

  let res;
  try {
    res = await win.webContents.executeJavaScript(`window.__start(${JSON.stringify(wav)})`);
  } catch (e) {
    console.log('采集失败:', e.message);
    app.quit();
    return;
  }
  const capMs = Date.now() - t0;
  console.log(`VAD 断句成功：${res.ch} | ${res.len} 样点 @ ${res.rate}Hz | 约 ${(res.len / res.rate).toFixed(2)}s | 用时 ${capMs}ms`);

  const AsrService = require('../src/main/asr.js');
  const asr = new AsrService(path.join(__dirname, '..', 'models'));
  await asr.start();
  console.log('ASR 模型加载:', asr.loadMs, 'ms');

  const buf = Buffer.from(res.b64, 'base64');
  // 落盘一份，方便用 test-asr 单独比对
  (function saveWav(f32, rate, file) {
    const n = f32.length;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2);
    require('fs').writeFileSync(file, b);
  })(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), res.rate, require('path').join(__dirname, '..', 'shots', 'captured.wav'));
  console.log('已保存 shots/captured.wav');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t1 = Date.now();
  const r = await asr.transcribe(new Float32Array(ab), res.rate);
  console.log('识别用时:', Date.now() - t1, 'ms');
  console.log('识别文本:', JSON.stringify((r.text || '').replace(/<\|[^|]*\|>/g, '')));

  asr.dispose();
  win.destroy();
  setTimeout(() => app.quit(), 200);
});
