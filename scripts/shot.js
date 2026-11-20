'use strict';
/**
 * 仅用于开发期截图核对 UI，不参与应用运行。
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/shot.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const R = path.join(__dirname, '..', 'src', 'renderer');
const OUT = path.join(__dirname, '..', 'shots');

const FIXTURE_CFG = {
  model: 'deepseek-v4-flash',
  style: 'bullet',
  overlayOpacity: 0.95,
  overlayTheme: 'dark',
  overlaySide: 'right',
  overlayWidth: 460,
  hideCaptured: true,
  autoAnswer: true,
  listening: true,
  sysAudio: true,
  mic: true,
  resumeText: '张明 · 后端工程师\n五年服务端经验，主要方向为高并发交易系统与风控引擎。\n主导订单中心重构，把下单链路从 800 QPS 提升到 4200 QPS。\n设计信贷风控规则引擎，支持热更新，规则上线从两天缩短到十分钟。',
  resumeFile: '张明-后端工程师.pdf',
  resumeChars: 128,
  projectDir: 'D:/面试资料/我的项目集',
  webSearch: true,
  webTopN: 4,
  skills: [
    { id: 'tech', name: '技术细节优先', desc: '答技术题时先给方案，再给关键实现细节', prompt: '先给方案结论，再补两条关键实现细节。', enabled: true },
    { id: 'star', name: 'STAR 行为面试', desc: '经历类问题按情境-任务-行动-结果组织', prompt: '按 STAR 顺序说，每段一句。', enabled: false },
    { id: 'ask', name: '反问环节', desc: '被问“你有什么想问的”时给高质量反问', prompt: '输出 3 个具体反问。', enabled: true },
  ],
  jd: '后端工程师：负责高并发交易系统设计，熟悉 Kafka、MySQL、缓存。',
  activeProfileId: 'p1',
  profiles: [
    { id: 'p1', name: '后端工程师', resumeText: 'x'.repeat(128), resumeFile: '张明-后端工程师.pdf', resumeChars: 128, jd: '后端工程师：负责高并发交易系统设计', projectDir: 'D:/面试资料/我的项目集' },
    { id: 'p2', name: '嵌入式软件工程师', resumeText: 'y'.repeat(3105), resumeFile: '彭永合+嵌入式.pdf', resumeChars: 3105, jd: '嵌入式软件实习生', projectDir: 'D:/桌面/嵌入式软件工程师' },
  ],
};

const DEMO_Q = '你刚才提到做过订单系统，能具体说说你是怎么处理高并发下单的吗？';
const DEMO_A = [
  '我之前做过一个电商订单系统',
  '大促时单机下单峰值能到每秒几千',
  '我的做法分三层：先削峰、再分库、最后兜底',
  '第一层用消息队列把下单请求异步化',
  '第二层按用户维度分库分表，避免热点',
  '第三层做库存预扣和幂等校验，防止超卖',
].join('\n');

function reg() {
  ipcMain.handle('boot', async () => ({
    config: FIXTURE_CFG,
    asr: { ready: true, loading: false, error: null, loadMs: 2526 },
    listening: true,
    protectedOn: true,
    project: { root: 'D:////面试资料////我的项目集', files: 218, chunks: 1463, builtAt: Date.now(), failed: 3, chars: 962000 },
    profiles: {
      activeId: 'p1',
      items: [
        { id: 'p1', name: '后端工程师', active: true, resumeChars: 128, resumeFile: '张明-后端工程师.pdf', projectDir: 'D:/面试资料/我的项目集', jdChars: 40 },
        { id: 'p2', name: '嵌入式软件工程师', active: false, resumeChars: 3105, resumeFile: '彭永合+嵌入式.pdf', projectDir: 'D:/桌面/嵌入式软件工程师', jdChars: 550 },
      ],
    },
  }));
  ['cfg:set', 'listen:toggle', 'answer:regen', 'context:clear', 'overlay:toggle', 'app:quit'].forEach((c) =>
    ipcMain.handle(c, async () => FIXTURE_CFG)
  );
  ipcMain.handle('sessions:list', async () => ({
    current: { id: 'S1', startedAt: Date.now(), count: 1 },
    items: [
      { id: 'S3', startedAt: Date.now() - 3600e3, endedAt: Date.now() - 3000e3, qaCount: 7, firstQuestion: '你在轴承监测项目里怎么保证不丢数？' },
      { id: 'S2', startedAt: Date.now() - 26 * 3600e3, endedAt: Date.now() - 25 * 3600e3, qaCount: 11, firstQuestion: '自我介绍' },
      { id: 'S1', startedAt: Date.now() - 50 * 3600e3, endedAt: Date.now() - 49 * 3600e3, qaCount: 4, firstQuestion: 'FreeRTOS 优先级怎么排的' },
    ],
  }));
  ipcMain.handle('sessions:get', async () => ({
    id: 'S3',
    qa: [
      { question: '你在轴承监测项目里用 SPI 采三轴振动，带宽怎么算的？怎么保证 100ms 内不丢数？', answer: '三轴各 5000 点、每点 16 位，一批 30KB，摊到 100ms 是 300KB/s，SPI 时钟远高于这个。保证不丢数靠 DMA 双缓冲加 DRDY 中断触发，读的同时另一块缓冲在攒数。' },
      { question: '离线准确率 99.92% 是不是太高了？', answer: '按采集批次划分训练集和测试集，参数只在训练集统计，避免同段信号串到两边。' },
    ],
  }));
  ipcMain.handle('session:new', async () => ({ archived: true, current: {}, items: [] }));
  ipcMain.handle('session:delete', async () => true);
  ipcMain.handle('selftest', async () => ({ ok: true, ratio: 0.184, reason: '屏幕采集到的画面中不含悬浮窗内容，防共享已生效' }));
  ipcMain.on('utterance', () => {});
  ipcMain.on('overlay:resize', (e, h) => {
    const w = require('electron').BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    w.setBounds({ ...b, height: Math.max(150, Math.min(560, Math.round(h))) });
  });
}

async function shootConsole() {
  const win = new BrowserWindow({
    width: 1120,
    height: 940,
    show: false,
    backgroundColor: '#f5f6fa',
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, '..', 'src', 'preload', 'console-preload.js'), contextIsolation: true },
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'console-preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(R, 'console.html'));
  win.webContents.send('models:list', [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'auto', name: 'Auto' },
  ]);
  // 先截一张首屏（还没有提问时的样子）
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(path.join(OUT, 'console-hero.png'), (await win.webContents.capturePage()).toPNG());

  win.webContents.send('transcript:add', { channel: 'interviewer', text: '先简单介绍一下你自己吧。' });
  win.webContents.send('transcript:add', { channel: 'me', text: '好的。我做了五年后端，主要在做电商交易这一块。' });
  win.webContents.send('transcript:add', { channel: 'interviewer', text: DEMO_Q });
  win.webContents.send('llm:start', { question: DEMO_Q });
  win.webContents.send('web:status', { state: 'searching', query: '高并发 下单' });
  win.webContents.send('web:results', {
    ok: true,
    engine: 'bing',
    query: '高并发 下单',
    items: [
      { title: '高并发下单系统的库存扣减方案', url: 'https://example.com/a', snippet: '…' },
      { title: '消息队列削峰在交易链路的应用', url: 'https://example.com/b', snippet: '…' },
      { title: '分布式锁与幂等设计', url: 'https://example.com/c', snippet: '…' },
    ],
  });
  win.webContents.send('llm:done', { text: DEMO_A, refs: ['电商订单项目/README.md', '订单中心重构设计.md'] });
  win.webContents.send('guard:verified', {
    ok: true,
    ratio: 0.001,
    reason: '显示悬浮窗后画面没有变化，防护确实生效',
  });
  await new Promise((r) => setTimeout(r, 1400));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'console.png'), img.toPNG());

  // 再截一张设置栏滚到底的，检查屏幕防护区块
  await win.webContents.executeJavaScript(
    "const r=document.getElementById('rail'); if(r) r.scrollTop = 460;"
  );
  await new Promise((r) => setTimeout(r, 500));
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'console-side.png'), img2.toPNG());

  // 勾选「快捷键显示」，截一张展开后的样子
  await win.webContents.executeJavaScript(
    "(()=>{const k=document.getElementById('swKeys'); if(k&&!k.checked) k.click();})()"
  );
  await new Promise((r) => setTimeout(r, 500));
  console.log('[measure]', await win.webContents.executeJavaScript(`(()=>{const q=(s)=>document.querySelector(s); const R=(e)=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),w:Math.round(r.width),right:Math.round(r.right)};}; const rail=q('#rail'),keys=q('#keyList'),kbd=q('.key kbd'),sp=q('.key span'); return JSON.stringify({rail:R(rail),keys:R(keys),kbd:R(kbd),span:R(sp),body:Math.round(document.body.getBoundingClientRect().right)});})()`));
  const imgKeys = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'console-keys.png'), imgKeys.toPNG());

  // 语音模式设置区
  await win.webContents.executeJavaScript(`(()=>{document.querySelector('[data-panel=mock]').click();})()`);
  await new Promise((r)=>setTimeout(r,300));
  await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('#segMockMode button[data-v=voice]'); if(b) b.click();})()`);
  await new Promise((r)=>setTimeout(r,400));
  fs.writeFileSync(path.join(OUT, 'console-mock-voice.png'), (await win.webContents.capturePage()).toPNG());

  // 通话视图
  await win.webContents.executeJavaScript("document.querySelector('[data-panel=mock]').click()");
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`(()=>{
    const st={active:true,mode:'voice',type:'tech',total:5,index:1,question:'x',draft:'',items:[
      {q:'你在轴承监测项目里，三通道数据是怎么同步对齐的？',a:'我用 SPI 读了 AD4134 的三轴数据，每批 5000 点。'},
      {q:'如果 CWT 和推理在另一个线程跑着，DMA 已经把下一批写进缓冲，你怎么切缓冲？',a:''}]};
    document.getElementById('mockSetup').hidden=true;
    document.getElementById('mockRun').hidden=true;
    const c=document.getElementById('mockCall'); c.hidden=false;
    renderCall(st);
    document.getElementById('callStatus').textContent='请回答，说完点「我说完了」或停顿几秒';
    document.getElementById('callOrb').classList.add('listening');
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'console-call.png'), (await win.webContents.capturePage()).toPNG());

  // 模拟面试页
  await win.webContents.executeJavaScript("document.querySelector('[data-panel=mock]').click()");
  await new Promise((r) => setTimeout(r, 450));
  fs.writeFileSync(path.join(OUT, 'console-mock.png'), (await win.webContents.capturePage()).toPNG());

  // 模型页
  await win.webContents.executeJavaScript("document.querySelector('[data-panel=models]').click()");
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'console-models.png'), (await win.webContents.capturePage()).toPNG());

  // 展开添加表单，看预设下拉
  await win.webContents.executeJavaScript("document.getElementById('btnProvAdd').click()");
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(path.join(OUT, 'console-models-form.png'), (await win.webContents.capturePage()).toPNG());

  // 设置页
  await win.webContents.executeJavaScript("document.querySelector('[data-panel=settings]').click()");
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'console-settings.png'), (await win.webContents.capturePage()).toPNG());

  // 英文界面
  await win.webContents.executeJavaScript("document.getElementById('selLang').value='en'; document.getElementById('selLang').onchange();");
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(path.join(OUT, 'console-settings-en.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.getElementById('selLang').value='zh-CN'; document.getElementById('selLang').onchange();");

  // 深色主题
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'console-dark.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");

  // 知识库 / 技能两个面板
  await win.webContents.executeJavaScript("document.querySelector('[data-panel=kb]').click()");
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'console-kb.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript("document.querySelector('[data-panel=history]').click()");
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript("document.querySelector('.hist-item').click()");
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(OUT, 'console-history.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript("document.querySelector('[data-panel=skills]').click()");
  await new Promise((r) => setTimeout(r, 400));
  console.log('导航项状态:', await win.webContents.executeJavaScript(
    "JSON.stringify([...document.querySelectorAll('.nav-item')].map(b=>({t:b.textContent.trim(),c:b.className})))"
  ));
  console.log('面板状态:', await win.webContents.executeJavaScript(
    "JSON.stringify([...document.querySelectorAll('.panel')].map(p=>({id:p.id,active:p.classList.contains('active')})))"
  ));
  fs.writeFileSync(path.join(OUT, 'console-skills.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript("document.querySelector('[data-panel=session]').click()");
  win.destroy();
}

async function shootOverlay() {
  const win = new BrowserWindow({
    width: 460,
    height: 560,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#3a4a63', // 模拟悬浮窗背后的桌面/会议画面
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(R, 'overlay.html'));
  win.webContents.send('overlay:cfg', { opacity: 0.95, theme: 'dark', width: 460 });
  win.webContents.send('listen:state', { listening: true });
  win.webContents.send('llm:start', { question: DEMO_Q });
  win.webContents.send('web:status', { state: 'searching', query: '高并发 下单' });
  win.webContents.send('web:results', {
    ok: true,
    engine: 'bing',
    query: '高并发 下单',
    items: [
      { title: '高并发下单系统的库存扣减方案', url: 'https://example.com/a', snippet: '…' },
      { title: '消息队列削峰在交易链路的应用', url: 'https://example.com/b', snippet: '…' },
      { title: '分布式锁与幂等设计', url: 'https://example.com/c', snippet: '…' },
    ],
  });
  win.webContents.send('llm:done', { text: DEMO_A, refs: ['电商订单项目/README.md', '订单中心重构设计.md'] });
  win.webContents.send('guard:verified', {
    ok: true,
    ratio: 0.001,
    reason: '显示悬浮窗后画面没有变化，防护确实生效',
  });
  await new Promise((r) => setTimeout(r, 1200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'overlay.png'), img.toPNG());
  win.destroy();
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  reg();
  await shootConsole();
  await shootOverlay();
  app.quit();
});
