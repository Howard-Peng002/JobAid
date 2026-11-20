'use strict';
/**
 * 全向可点击性测试（真实鼠标事件，不是 el.click()）
 * 目的：捕获「元素在视觉上存在，但点击被上层拦截」这类 bug。
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/test-ui-click.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const R = path.join(__dirname, '..', 'src', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'console-preload.js');

let cfg = {
  model: 'deepseek-v4-flash',
  style: 'bullet',
  overlayOpacity: 0.95,
  overlayTheme: 'dark',
  overlaySide: 'right',
  overlayWidth: 460,
  hideCaptured: false,
  autoAnswer: true,
  listening: false,
  sysAudio: true,
  mic: true,
  webSearch: false,
  overlayVisible: true,
  skills: [],
  jd: '',
  resumeText: '',
};

const calls = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function reg() {
  ipcMain.handle('boot', async () => ({
    config: cfg,
    asr: { ready: true, loading: false, error: null, loadMs: 1200 },
    listening: false,
    protectedOn: false,
    project: null,
  }));
  ipcMain.handle('cfg:set', async (_e, patch) => {
    Object.assign(cfg, patch);
    calls.push({ ch: 'cfg:set', patch });
    return cfg;
  });
  ipcMain.handle('listen:toggle', async () => {
    calls.push({ ch: 'listen:toggle' });
    return cfg;
  });
  ipcMain.handle('ask:text', async (_e, t) => {
    calls.push({ ch: 'ask:text', t });
    return true;
  });
  ipcMain.handle('answer:regen', async () => {
    calls.push({ ch: 'answer:regen' });
    return cfg;
  });
  ipcMain.handle('context:clear', async () => {
    calls.push({ ch: 'context:clear' });
    return cfg;
  });
  ipcMain.handle('overlay:toggle', async () => {
    calls.push({ ch: 'overlay:toggle' });
    return cfg;
  });
  ipcMain.handle('selftest', async () => {
    calls.push({ ch: 'selftest' });
    return { ok: true, ratio: 0.001, reason: 'fixture' };
  });
  ipcMain.handle('sessions:list', async () => ({ current: { id: 'S1', count: 0 }, items: [] }));
  ipcMain.handle('sessions:get', async () => ({ id: 'S1', qa: [] }));
  ipcMain.handle('session:new', async () => {
    calls.push({ ch: 'session:new' });
    return { archived: false, current: { id: 'S2', count: 0 }, items: [] };
  });
  ipcMain.handle('session:delete', async () => true);
  ipcMain.handle('models:get', async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }]);
  ipcMain.handle('resume:pick', async () => ({ ok: false }));
  ipcMain.handle('project:pick', async () => ({ ok: false }));
  ipcMain.on('utterance', () => {});
}

const results = [];
function assert(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
}

(async () => {
  await app.whenReady();
  reg();

  const win = new BrowserWindow({
    width: 1120,
    height: 900,
    show: true,
    backgroundColor: '#f5f6fa',
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(R, 'console.html'));
  win.webContents.send('models:list', [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }]);
  await wait(1200);

  const js = (code) => win.webContents.executeJavaScript(code);

  async function rectOf(sel) {
    return js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return null; const r=e.getBoundingClientRect();
      if(!r.width||!r.height) return {x:r.x,y:r.y,w:0,h:0,hidden:true};
      return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  }

  async function clickSel(sel, fx = 0.5, fy = 0.5) {
    // 设置栏内容变长后，底部的按钮可能在视口外，先滚到可视区再点
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(e) e.scrollIntoView({block:'center'});})()`);
    await wait(150);
    const r = await rectOf(sel);
    if (!r || r.hidden) return { ok: false, reason: 'not-visible' };
    const x = Math.round(r.x + r.w * fx);
    const y = Math.round(r.y + r.h * fy);
    const wc = win.webContents;
    const z = wc.getZoomFactor ? wc.getZoomFactor() : 1; // 有缩放时坐标要换算回设备像素
    const dx = Math.round(x * z);
    const dy = Math.round(y * z);
    wc.sendInputEvent({ type: 'mouseMove', x: dx, y: dy });
    wc.sendInputEvent({ type: 'mouseDown', x: dx, y: dy, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: dx, y: dy, button: 'left', clickCount: 1 });
    await wait(220);
    return { ok: true, x, y };
  }

  // 命中测试：中心点最上层元素必须是目标自身或其后代
  async function hitIs(sel, fx = 0.5, fy = 0.5) {
    // 元素可能在滚动区外，先滚到可视区，否则 elementFromPoint 拿到 null
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(e) e.scrollIntoView({block:'center'});})()`);
    await wait(150);
    return js(`(()=>{const t=document.querySelector(${JSON.stringify(sel)});if(!t)return 'no-target';
      const r=t.getBoundingClientRect();
      const el=document.elementFromPoint(r.x+r.width*${fx}, r.y+r.height*${fy});
      if(!el) return 'null';
      if(el===t||t.contains(el)) return 'self';
      return el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?'.'+String(el.className).split(' ')[0]:'');})()`);
  }

  /* ---------------- 1. 命中测试：谁在接收点击 ---------------- */
  const hits = {
    '#swSys': await hitIs('#swSys', 0.62),
    '#swMic': await hitIs('#swMic', 0.62),
    '#swAuto': await hitIs('#swAuto', 0.62),
    '#swStealth': await hitIs('#swStealth', 0.62),
    '#segStyle [data-v=spoken]': await hitIs('#segStyle [data-v=spoken]'),
    '#segTheme [data-v=light]': await hitIs('#segTheme [data-v=light]'),
    '#rgOpacity': await hitIs('#rgOpacity', 0.3),
    '#btnGuard': await hitIs('#btnGuard'),
    '#btnListen': await hitIs('#btnListen'),
  };
  console.log('命中对象：', hits);

  const hitOk = Object.entries(hits).every(([, v]) => v === 'self');
  assert('滑块/按钮中心点未被遮挡', hitOk, JSON.stringify(hits));

  /* ---------------- 2. 四个开关：点滑块本体 ---------------- */
  for (const [id, key] of [
    ['#swSys', 'sysAudio'],
    ['#swMic', 'mic'],
    ['#swAuto', 'autoAnswer'],
    ['#swKeys', 'showShortcuts'],
  ]) {
    const before = await js(`document.getElementById('${id.slice(1)}').checked`);
    await clickSel(id, 0.62, 0.5); // 点在视觉滑块上，不是文字
    const after = await js(`document.getElementById('${id.slice(1)}').checked`);
    assert(`${id} 点滑块能切换`, before !== after, `${before} -> ${after}`);
  }

  // 悬浮窗隐身：勾选 = 隐藏，配置反向
  const sb = await js(`document.getElementById('swStealth').checked`);
  await clickSel('#swStealth', 0.62, 0.5);
  const sa = await js(`document.getElementById('swStealth').checked`);
  assert('#swStealth 点滑块能切换', sb !== sa, `${sb} -> ${sa}`);

  // 点左侧文字（label for）也应生效
  const lb = await js(`document.getElementById('swSys').checked`);
  await clickSel('.rail .row label[for=swSys]', 0.3, 0.5);
  const la = await js(`document.getElementById('swSys').checked`);
  assert('点开关文字也能切换', lb !== la, `${lb} -> ${la}`);

  /* ---------------- 3. 分段按钮 ---------------- */
  for (const [sel, val, cfgKey] of [
    ['#segStyle [data-v=spoken]', 'spoken', 'style'],
    ['#segStyle [data-v=star]', 'star', 'style'],
    ['#segTheme [data-v=light]', 'light', 'overlayTheme'],
  ]) {
    await clickSel(sel);
    const on = await js(`document.querySelector(${JSON.stringify(sel)}).classList.contains('on')`);
    assert(`点 ${sel} 高亮且写入配置`, on && cfg[cfgKey] === val, `on=${on} cfg.${cfgKey}=${cfg[cfgKey]}`);
  }

  /* ---------------- 4. 透明度滑杆 ---------------- */
  const ob = cfg.overlayOpacity;
  await clickSel('#rgOpacity', 0.55, 0.5);
  assert('透明度滑杆可拖动赋值', cfg.overlayOpacity !== ob, `${ob} -> ${cfg.overlayOpacity}`);

  /* ---------------- 5. 侧栏导航 ---------------- */
  for (const [label, panel] of [
    ['历史记录', 'history'],
    ['知识库', 'kb'],
    ['技能', 'skills'],
  ]) {
    await clickSel(`.nav-item[data-panel="${panel}"]`);
    const active = await js(`document.getElementById('panel-${panel}').classList.contains('active')`);
    assert(`侧栏「${label}」可切换`, active);
  }
  await clickSel('.nav-item[data-panel="session"]');
  const backSession = await js(`document.getElementById('panel-session').classList.contains('active')`);
  assert('侧栏「新建任务」可切回', backSession);

  /* ---------------- 6. 顶栏：齿轮折叠设置栏 ---------------- */
  const off0 = await js(`document.body.classList.contains('rail-off')`);
  await clickSel('#btnRail');
  const off1 = await js(`document.body.classList.contains('rail-off')`);
  await clickSel('#btnRail');
  const off2 = await js(`document.body.classList.contains('rail-off')`);
  assert('齿轮能折叠/展开设置栏', off0 !== off1 && off2 === off0, `${off0} -> ${off1} -> ${off2}`);

  /* ---------------- 7. 开始监听 ---------------- */
  // 测试环境没有音频设备，startCaptures 会提前退出，所以只验证点击事件确实落到按钮上
  await js(`window.__listenClicks=0;
    document.getElementById('btnListen').addEventListener('click',()=>window.__listenClicks++,{once:true})`);
  await clickSel('#btnListen');
  const listenClicks = await js('window.__listenClicks');
  assert('「开始监听」可点击', listenClicks === 1, `click 事件 ${listenClicks} 次`);

  /* ---------------- 8. 底栏工具 ---------------- */
  calls.length = 0;
  await clickSel('#btnWeb');
  assert('底栏「网络搜索」可点击', calls.some((c) => c.ch === 'cfg:set' && 'webSearch' in c.patch));

  calls.length = 0;
  await clickSel('#btnPlus');
  const kbActive = await js(`document.getElementById('panel-kb').classList.contains('active')`);
  assert('底栏「+」可点击', kbActive);

  await clickSel('.nav-item[data-panel="session"]');

  /* ---------------- 9. 输入框：真实键盘回车 ---------------- */
  calls.length = 0;
  await clickSel('#askInput', 0.2, 0.5);
  await js(`(()=>{const el=document.getElementById('askInput');el.value='测试一下回车';el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await wait(300);
  assert('输入框回车能提交', calls.some((c) => c.ch === 'ask:text'), JSON.stringify(calls));

  /* ---------------- 10. 防护按钮 ---------------- */
  calls.length = 0;
  await clickSel('#btnGuard');
  await wait(600);
  assert('「隐藏窗口/防护」按钮可点击', calls.some((c) => c.ch === 'selftest'), JSON.stringify(calls));

  /* ---------------- 11. 布局：无横向溢出 ---------------- */
  const layout = await js(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth,
    railRight:document.getElementById('rail').getBoundingClientRect().right,
    innerW:window.innerWidth})`);
  assert('页面无横向溢出', layout.sw <= layout.cw + 1, JSON.stringify(layout));
  assert('设置栏未被挤出窗口', layout.railRight <= layout.innerW + 1, JSON.stringify(layout));

  /* ---------------- 12. 全量遮挡扫描：所有可见交互元素的中心点 ---------------- */
  // 逐个面板扫一遍，防止「某个面板里的按钮被上层盖住却看不出来」
  for (const panel of ['session', 'history', 'kb', 'skills']) {
    await js(`(()=>{document.body.classList.remove('rail-off');
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
      document.getElementById('panel-${panel}').classList.add('active');})()`);
    await wait(120);
    const blocked = await js(`(()=>{
      const out=[];
      const list=document.querySelectorAll('button, input, select, textarea, label[for], [data-v]');
      for(const el of list){
        const r=el.getBoundingClientRect();
        if(r.width<4||r.height<4) continue;
        if(r.bottom<0||r.top>innerHeight) continue;
        const cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') continue;
        const x=r.x+r.width/2, y=r.y+r.height/2;
        if(x<0||y<0||x>innerWidth||y>innerHeight) continue;
        const hit=document.elementFromPoint(x,y);
        if(!hit) { out.push((el.id||el.className||el.tagName)+' -> null'); continue; }
        if(hit===el||el.contains(hit)) continue;
        // 透明的 range/checkbox 被自己的视觉层盖住不算问题，只要命中元素在目标内部
        out.push((el.id||(el.className||el.tagName))+' -> '+(hit.id||hit.className||hit.tagName));
      }
      return out;})()`);
    assert(`面板「${panel}」交互元素无遮挡`, blocked.length === 0, blocked.join(' ; ') || 'ok');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[ui-click] 汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('失败项：', failed.map((f) => f.name).join(' / '));
  app.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('异常', e);
  app.exit(1);
});
