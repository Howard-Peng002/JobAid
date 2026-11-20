'use strict';
/** 受控实验：带标记的窗口，开了内容保护后，标记还会不会出现在采集里？ */
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');

const RECT = { x: 300, y: 240, width: 300, height: 200 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<body style="margin:0;background:#1b1e28">' +
    '<div id="p" style="position:fixed;left:0;top:0;width:12px;height:12px;background:rgb(255,0,254)"></div>' +
    '</body>'
)}`;

function countProbe(img) {
  const size = img.getSize();
  const buf = img.toBitmap();
  const sx = size.width / screen.getPrimaryDisplay().size.width;
  const sy = size.height / screen.getPrimaryDisplay().size.height;
  const x0 = Math.floor(RECT.x * sx);
  const y0 = Math.floor(RECT.y * sy);
  const x1 = Math.ceil((RECT.x + RECT.width) * sx);
  const y1 = Math.ceil((RECT.y + RECT.height) * sy);
  let hit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size.width + x) * 4;
      if (buf[i + 2] > 245 && buf[i + 1] < 12 && buf[i] > 245) hit++;
    }
  }
  return hit;
}

async function grab() {
  const sz = screen.getPrimaryDisplay().size;
  const s = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sz.width, height: sz.height } });
  return s[0].thumbnail;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((w, p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDisplayMediaRequestHandler(
    (req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb(s.length ? { video: s[0], audio: 'loopback' } : {})).catch(() => cb({}));
    },
    { useSystemPicker: false }
  );
  const win = new BrowserWindow({
    ...RECT,
    frame: false,
    transparent: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  await win.loadURL(PAGE);
  win.showInactive();
  await sleep(800);

  console.log('保护开启，标记命中:', countProbe(await grab()), '像素');

  // 再模拟一次"先设穿透"
  win.setIgnoreMouseEvents(true, { forward: true });
  await sleep(700);
  console.log('设鼠标穿透后，标记命中:', countProbe(await grab()), '像素');

  // 关键：先起一个屏幕采集会话（模拟"监听中"的 getDisplayMedia 回环）
  await win.webContents.executeJavaScript(`(async () => {
    window.__ds = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: true });
    return 'ok';
  })()`).catch((e) => 'err ' + e.message);
  await sleep(900);
  console.log('有采集会话时，标记命中:', countProbe(await grab()), '像素');

  win.setContentProtection(false);
  await sleep(700);
  console.log('关闭保护后，标记命中:', countProbe(await grab()), '像素');

  win.destroy();
  setTimeout(() => app.quit(), 300);
});
