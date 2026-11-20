'use strict';
/**
 * JobAid · 主进程
 * ------------------------------------------------------------------
 * 职责：
 *  1. 控制台窗口（音频采集、字幕、设置）
 *  2. 悬浮窗（透明置顶、点击穿透、**对屏幕共享/录屏不可见**）
 *  3. 语音 → 文字 → 提问判定 → 大模型作答 → 推送悬浮窗
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  session,
  desktopCapturer,
  dialog,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
} = require('electron');
const path = require('path');

// 数据目录：品牌从「AI 助手」升级为 JobAid 后仍沿用首次安装的目录，
// 否则已导入的简历 / JD / 历史记录 / 项目索引都会“消失”。
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'interview-copilot'));
} catch (_) {}

const config = require('./config');
const AsrService = require('./asr');
const { LlmService, friendlyError } = require('./llm');
const { ProjectIndex } = require('./projectindex');
const { extractText } = require('./docparse');
const websearch = require('./websearch');
const SessionStore = require('./sessions');

const ROOT = path.join(__dirname, '..', '..');
// 打包后模型放在 resources/models（不打进 asar），开发时在项目根目录
const MODEL_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(ROOT, 'models');
const SELFTEST = process.argv.includes('--selftest'); // 端到端自测模式（--selftest 启动）
const AUTOLISTEN = process.argv.includes('--autolisten'); // 启动后自动开始监听（模拟面试测试用）
const UITEST = process.argv.includes('--uitest'); // 功能自测：走完 作答→新建任务→历史记录 全流程
const GUARDTEST = process.argv.includes('--guardtest'); // 防护开关诊断：连续切换并实测是否真的排除
const CLICKTEST = process.argv.includes('--clicktest'); // 界面点击诊断：模拟真人点按钮/开关
const DRAGTEST = process.argv.includes('--dragtest'); // 悬浮窗拖动诊断
const SIZETEST = process.argv.includes('--sizetest'); // 悬浮窗缩放/按钮诊断
const CLICKCHECK = process.argv.includes('--clickcheck'); // 真机点击诊断：设置栏遮挡/开关可达性
const WAKETEST = process.argv.includes('--waketest'); // 悬浮窗唤醒/拖动诊断：光标压标题栏能否醒
const HIDETEST = process.argv.includes('--hidetest'); // 隐藏再显示后 – □ × 是否仍然可用
const STEALTHTEST = process.argv.includes('--stealthtest'); // 隐身开关/防护按钮切换后还能不能拖
const SHOTWINDOW = process.argv.includes('--shotwindow'); // 截窗口标题栏，检查图标
const ASKTEST = process.argv.includes('--asktest'); // 手动提问诊断：陈述句也要能触发作答
const HIT_DEBUG = process.argv.includes('--hitdebug'); // 打印悬浮窗命中判定的采样日志
const PROFILETEST = process.argv.includes('--profiletest'); // 多知识库诊断
const MODELTEST = process.argv.includes('--modeltest'); // 模型供应商诊断
const SETTINGSTEST = process.argv.includes('--settingstest'); // 设置页诊断
const TRAYTEST = process.argv.includes('--traytest'); // 托盘/后台诊断
const EXPORTTEST = process.argv.includes('--exporttest'); // 面经导出诊断
const MOCKTEST = process.argv.includes('--mocktest'); // 模拟面试诊断
const VOICETEST = process.argv.includes('--voicetest'); // 语音链路诊断
const TRAYPROBE = process.argv.includes('--trayprobe'); // 托盘状态探针
const SCREENCAP = process.argv.includes('--screencap'); // 全屏截图诊断

let consoleWin = null;
let overlayWin = null;
let tray = null;
let cfg = config.load();
let asr = null;
let llm = null;
let projectIndex = null;

/** 每个知识库一个索引缓存文件，切换库时互不覆盖 */
function indexCacheFile(profileId) {
  const id = String(profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(app.getPath('userData'), `project-index-${id || 'default'}.json`);
}

function initProjectIndex() {
  const fsx = require('fs');
  const target = indexCacheFile(cfg.activeProfileId);
  // 老版本只有一个 project-index.json，升级后搬到当前库名下，免得用户白等一次重建
  try {
    const legacy = path.join(app.getPath('userData'), 'project-index.json');
    if (fsx.existsSync(legacy) && !fsx.existsSync(target)) fsx.renameSync(legacy, target);
  } catch (_) {}
  projectIndex = new ProjectIndex(target);
  if (cfg.projectDir) projectIndex.loadCache();
}
let sessions = null; // 面试场次（历史记录）
// 模型目录已不依赖缓存：全部来自用户配置，直接现算

let transcript = [];
let lastQuestion = '';
let lastQuestionAt = 0;
// 这个问题是用户手动输入的（而非语音听到的面试官发言）。
// 手动输入的语义是「指令」而不是「面试题」，提示词要据此切换行为。
let lastQuestionManual = false;
let answerTimer = null;
let abortCtl = null;
let listening = false;
let asrState = { ready: false, loading: true, error: null, loadMs: 0 };
let quitting = false;

/* ---------------------------------------------------------------- 工具 */

function broadcast(channel, payload) {
  [consoleWin, overlayWin].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  });
}

function overlayState() {
  return { listening, visible: !!(overlayWin && overlayWin.isVisible()) };
}

/* ------------------------------------------------- 提问判定（本地启发式） */

const Q_MARK = /[?？]/;
const Q_WORDS =
  /(吗|呢|怎么|怎样|如何|为什么|为啥|什么|哪些|哪个|多少|多久|几年|几次|是否|能不能|可不可以|会不会|有没有|要不要|对不对|好不好|请问|请(你|您)?(说|介绍|讲|谈|举)|谈谈|聊聊|说说|介绍一下|举(个|一个)?例|描述一下|讲讲|讲讲你的|你说说|自我介绍|(说|讲|聊|谈|介绍|描述)(一下|一讲)?(你|您)?的)/;

function isQuestionLike(text) {
  if (!text) return false;
  const s = text.trim();
  if (s.length < 3) return false;
  if (Q_MARK.test(s)) return true;
  return Q_WORDS.test(s);
}

/* ------------------------------------------------------------ 作答生成 */

function scheduleAnswer(delay = 900) {
  if (answerTimer) clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    answerTimer = null;
    generateAnswer();
  }, delay);
}

async function generateAnswer() {
  if (!lastQuestion) return;
  console.log('[answer] webSearch =', cfg.webSearch, '| question =', lastQuestion.slice(0, 30));
  if (!cfg.autoAnswer && !generateAnswer.forced) return;

  if (abortCtl) {
    try {
      abortCtl.abort();
    } catch (_) {}
  }
  abortCtl = new AbortController();
  const ctl = abortCtl;

  broadcast('llm:start', { question: lastQuestion, manual: lastQuestionManual });
  let acc = '';
  try {
    // 从项目资料库里召回与这个问题最相关的片段
    let excerpts = [];
    let outline = '';
    if (projectIndex && projectIndex.chunks.length) {
      try {
        excerpts = projectIndex.retrieve(lastQuestion, { topK: 4, budget: 2600 });
        outline = projectIndex.outline();
      } catch (e) {
        console.warn('[index] 检索失败', e.message);
      }
    }

    // 网络搜索（可选）
    let web = [];
    if (cfg.webSearch) {
      // buildQuery 返回空 = 这个问题没有可检索的技术名词（“做个自我介绍”“最大的困难”），
      // 这种时候联网只会在提示词里塞进百科词条和范文，把答案带偏，直接跳过。
      const q = websearch.buildQuery(lastQuestion);
      if (q) {
        broadcast('web:status', { state: 'searching', query: q });
        try {
          const r = await websearch.search(q, { topN: cfg.webTopN || 4 });
          if (r.ok) {
            web = r.items;
            broadcast('web:results', { ok: true, query: r.query, engine: r.engine, items: r.items });
          } else {
            broadcast('web:results', { ok: false, query: q, error: r.error });
          }
        } catch (e) {
          broadcast('web:results', { ok: false, query: q, error: e.message });
        }
        broadcast('web:status', { state: 'idle' });
      }
    }

    // 没有任何可用通道了（不再有内置模型），必须先把话说明白，不能让用户对着空屏等
    const ref = cfg.activeRef;
    const provider = ref ? (cfg.customProviders || []).find((x) => x.id === ref.providerId) : null;
    if (!ref || !provider) {
      throw new Error(
        (cfg.customProviders || []).length
          ? '当前选中的模型供应商已不存在，请到左侧「模型」页重新选一个'
          : '还没有配置模型：请到左侧「模型」页添加一个供应商（DeepSeek / 智谱 / Kimi 等）'
      );
    }

    const it = llm.streamWith(ref, {
      question: lastQuestion,
      transcript,
      resume: cfg.resumeText,
      jd: cfg.jd,
      style: cfg.style,
      outline,
      excerpts,
      web,
      skills: cfg.skills,
      model: cfg.model,
      temperature: cfg.temperature,
      manual: lastQuestionManual,
      signal: ctl.signal,
    }, provider);
    for await (const piece of it) {
      if (ctl.signal.aborted) break;
      acc += piece;
      broadcast('llm:delta', { text: piece });
    }
    if (!ctl.signal.aborted) {
      broadcast('llm:done', { text: acc, refs: [...new Set(excerpts.map((e) => e.file))] });
      if (sessions && lastQuestion) sessions.addQA(lastQuestion, acc);
      console.log(`[answer] 完成 ${acc.length} 字: ${acc.replace(/\n/g, ' / ').slice(0, 90)}`);
    }
  } catch (e) {
    if (ctl.signal.aborted) return;
    broadcast('llm:error', { message: friendlyError(e) });
  } finally {
    if (abortCtl === ctl) abortCtl = null;
    generateAnswer.forced = false;
  }
}

/* ------------------------------------------------------------ 语音识别 */

async function handleUtterance({ channel, samples, sampleRate }) {
  // 模拟面试不调用 setListening，这里必须单独放行，否则音频在入口就被丢掉
  if (!listening && !mockMicActive) return;
  if (!asrState.ready) {
    broadcast('asr:error', { message: '语音模型还在加载，等两三秒再说话' });
    return;
  }

  const t0 = Date.now();
  // 时长必须在送去识别之前算：samples 的 ArrayBuffer 会被 transfer 给识别线程，
  // 转移之后 byteLength 变成 0（之前踩过这个坑，durMs 恒为 0）。
  const nSamples = samples.byteLength != null ? samples.byteLength / 4 : samples.length || 0;
  const durMs = Math.round((nSamples / (sampleRate || 16000)) * 1000);

  let text = '';
  try {
    const r = await asr.transcribe(new Float32Array(samples), sampleRate || 16000);
    text = (r.text || '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    broadcast('asr:error', { message: e.message });
    return;
  }
  if (!text || text.length < 2) return;

  dispatchText(channel, text, Date.now() - t0, durMs);
}

/* ------------------------------------------------- 断句拼接与回声过滤 */

function normText(s) {
  return String(s || '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase();
}

/** a 的字符有多少比例出现在 b 里（多重集，0~1），用于判断麦克风收到的是不是扬声器回声 */
function overlapRatio(a, b) {
  const A = normText(a);
  const B = normText(b);
  if (!A || !B) return 0;
  const cnt = new Map();
  for (const ch of B) cnt.set(ch, (cnt.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of A) {
    const n = cnt.get(ch) || 0;
    if (n > 0) {
      hit++;
      cnt.set(ch, n - 1);
    }
  }
  return hit / A.length;
}

// 面试官当前这句话的累积缓冲：长句常被 VAD 切成几段，需要拼回一整句再判定。
// 拼接依据是「上一段语音结束」到「这一段语音开始」之间的真实静默，
// 不能直接用两次回调的时间差——长句子本身的时长会把间隔撑大。
const ivBuf = { text: '', at: 0, endAt: 0 };

function considerQuestion() {
  const merged = ivBuf.text.trim();
  if (!merged || !isQuestionLike(merged)) return; // 还没问到点上，等下半句
  // 识别噪声会让标点/个别字变化，规范化后相同就不再重新生成，避免作答来回跳
  if (normText(merged) === normText(lastQuestion)) return;
  lastQuestion = merged;
  lastQuestionAt = Date.now();
  lastQuestionManual = false;
  console.log(`[q] 判定为提问（${merged.length} 字）: ${merged}`);
  if (cfg.autoAnswer) scheduleAnswer();
}

function onInterviewerText(text, durMs, asrMs) {
  const now = Date.now();
  const cost = asrMs || 0;
  const dur = durMs || 0;
  const speechStart = now - cost - dur;
  const speechEnd = now - cost;

  const nT = normText(text);
  const nB = normText(ivBuf.text);
  // 判断是否同一句的可靠信号不是时间，而是「缓冲里有没有问号」：
  // 面试官的长问题常被切成"背景陈述 + 问句"两段，第一段带问号就说明问题已经问全了。
  // 时间只用来兜住过期缓冲（间隔太久就别再拼了）。
  const gap = ivBuf.text ? now - ivBuf.at : Infinity;
  const prevFinished = /[？?]/.test(ivBuf.text);

  if (gap >= 0 && gap < 12000 && !prevFinished && nB.length < 110) {
    if (nT.includes(nB)) {
      ivBuf.text = text; // 同一句的更完整版本，替换
    } else if (nB.includes(nT)) {
      // 更短的重复，忽略
    } else {
      ivBuf.text = (ivBuf.text.replace(/[。.，,？?！!；;、]$/, '') + text).slice(0, 400);
    }
  } else {
    ivBuf.text = text;
  }
  ivBuf.at = now;
  ivBuf.endAt = speechEnd;
  considerQuestion();
}

/** 麦克风收到的扬声器回声：只有比现有缓冲更完整时才采信（用来补回环漏掉的半句） */
function absorbEcho(text) {
  const nT = normText(text);
  const nB = normText(ivBuf.text);
  if (!nB) {
    ivBuf.text = text;
    considerQuestion();
    return;
  }
  if (nT.length > nB.length + 4 && nT.includes(nB)) {
    ivBuf.text = text.slice(0, 400);
    console.log('[echo] 用回声补全了面试官的问题');
    considerQuestion();
  }
}

/** 文本进入对话流（ASR 与自测注入共用） */
/**
 * 麦克风经常收到「嗯。」「The.」这种碎片，进字幕只会干扰阅读，
 * 进上下文还会让模型以为你说过话，所以直接在入口丢掉。
 */
const NOISE_WORDS = /^(嗯+|啊+|哦+|呃+|额+|唉+|哎+|对|好|是的|对的|然后|那个|这个|就是|the|a|an|ok|okay|um+|uh+|mm+|yeah|yes|no)[。，,.!?！？、…]*$/i;

function isNoiseText(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (t.length > 14) return false; // 长句不可能是纯语气词
  const plain = t.replace(/[。，,.!?！？、…\s"'“”‘’]/g, '');
  if (!plain) return true; // 只有标点
  if (plain.length <= 1) return true; // 单个字
  return NOISE_WORDS.test(t) || NOISE_WORDS.test(plain);
}

function dispatchText(channel, text, cost, durMs) {
  const t = String(text || '').trim();
  if (!t) return;
  if (isNoiseText(t)) return;

  // 外放时麦克风会同时收到面试官的扬声器声音。这既不该出现在"我"的字幕里，
  // 更不能进上下文——否则模型会以为"我已经说过这些话"。
  if (channel === 'me') {
    const recent = transcript
      .filter((x) => x.channel === 'interviewer' && Date.now() - x.ts < 9000)
      .map((x) => x.text)
      .join(' ');
      if (recent && overlapRatio(t, recent) >= 0.5) {
      console.log('[echo] 麦克风收到扬声器回声，已忽略:', t);
      absorbEcho(t);
      return;
    }
  }

  const item = { channel, text: t, ts: Date.now(), cost: cost || 0 };
  transcript.push(item);
  if (transcript.length > 300) transcript.shift();
  broadcast('transcript:add', item);
  console.log(`[asr] ${channel === 'interviewer' ? '面试官' : '我'}: ${t}  (${cost || 0}ms)`);

  if (sessions && !mockMicActive) sessions.addText(channel, t);
  if (channel === 'interviewer') onInterviewerText(t, durMs, cost);
}

/* ------------------------------------------------------------ 窗口创建 */

function createConsoleWindow() {
  const bounds = cfg.windowBounds || { width: 1120, height: 880 };
  consoleWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 880,
    minHeight: 600,
    title: '设置', // 中性标题，截图里看不出是什么程序
    skipTaskbar: !!cfg.fullStealth, // 开关控制：开了就不出现在任务栏
    // 标题栏左上角放一张全透明的 1×1 图，Windows 就不会画程序图标
    icon: nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    ),
    backgroundColor: '#F6F7FB',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'console-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  consoleWin.setMenuBarVisibility(false);
  consoleWin.setContentProtection(!!cfg.hideCaptured);
  consoleWin.loadFile(path.join(__dirname, '..', 'renderer', 'console.html'));

  applyConsoleOpacity();

  consoleWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      consoleWin.hide();
      hintTrayOnce();
    }
  });

  // 重建窗口后把已有字幕补回去
  consoleWin.webContents.on('did-finish-load', () => {
    if (transcript.length) transcript.forEach((t) => consoleWin.webContents.send('transcript:add', t));
  });

  // 控制台从隐藏/最小化恢复时立刻补一次防护，别等 4 秒一次的守护循环
  const rearmConsole = () => setTimeout(applyCaptureProtection, 80);
  consoleWin.on('hide', () => {
    enterStealth();
  });
  consoleWin.on('show', () => {
    exitStealth();
    rearmConsole();
  });
  consoleWin.on('restore', rearmConsole);
  consoleWin.on('focus', rearmConsole);

  consoleWin.on('resize', () => {
    if (consoleWin && !consoleWin.isDestroyed()) {
      const b = consoleWin.getBounds();
      config.save({ windowBounds: b });
    }
  });

  consoleWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function placeOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const cur = overlayWin.getBounds();
  const width = Math.min(cfg.overlayWidth || 460, Math.floor(wa.width * 0.45));
  const height = cur.height; // 高度由内容自适应决定，这里只重新定位
  const margin = 24;
  let x = cfg.overlaySide === 'left' ? wa.x + margin : wa.x + wa.width - width - margin;
  let y = wa.y + Math.floor((wa.height - height) / 2);

  // 用户拖过就沿用他的位置（窗口至少留 80px 在屏幕内，避免拖到看不见的地方）
  const pos = cfg.overlayPos;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const visibleX = Math.min(Math.max(pos.x, wa.x - width + 80), wa.x + wa.width - 80);
    const visibleY = Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - 60);
    x = Math.round(visibleX);
    y = Math.round(visibleY);
  }
  overlayWin.setBounds({ x, y, width, height });
}

function createOverlayWindow() {
  const p = placeOverlayPreview();
  overlayWin = new BrowserWindow({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 必须可聚焦：Windows 上 focusable:false（WS_EX_NOACTIVATE）的窗口在 hide→show
    // 之后经常收不到鼠标命中，表现就是「重新显示后拖不动、按钮点不了」。
    // 用 showInactive() 显示仍然不会抢焦点，只有主动点它才会激活。
    focusable: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // ★ 悬浮在所有窗口之上（包括全屏的会议软件）
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // ★ 关键：对屏幕共享 / 录屏 / 截图不可见（Windows: WDA_EXCLUDEFROMCAPTURE）
  overlayWin.setContentProtection(!!cfg.hideCaptured);
  // 注意：鼠标穿透绝不能在这里设置。窗口显示前调用 setIgnoreMouseEvents 会让
  // 显示亲和性失效，防护彻底作废（实测：可见 100%）。只能放到 ready-to-show 之后。

  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlayWin.once('ready-to-show', () => {
    placeOverlay();
    if (cfg.overlayVisible !== false) overlayWin.showInactive();
    setTimeout(armOverlay, 200);
    broadcast('overlay:state', overlayState());
  });

  overlayWin.on('show', () => {
    // 每次重新显示都补一次，避免亲和性丢失
    setTimeout(armOverlay, 120);
    broadcast('overlay:state', overlayState());
  });
}


/** 隐藏悬浮窗。隐藏前先解除穿透：带穿透态 hide→show 会让鼠标命中彻底失灵。 */
function hideOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  setOverlayInteractive(true, false);
  overlayWin.hide();
}

/** 显示之后再武装：先贴防护，再开鼠标穿透（顺序不能反） */
function armOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  applyProtectionRaw();
  // 走统一入口，顺手把「已穿透」同步给渲染层，否则重新显示后唤醒会被去重吞掉
  setOverlayInteractive(false);
}

// 先摆一个粗略位置，避免窗口先在屏幕中间闪一下
function placeOverlayPreview() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = Math.min(cfg.overlayWidth || 460, Math.floor(wa.width * 0.9));
  const height =
    cfg.overlayAutoHeight === false && cfg.overlayHeight
      ? Math.min(cfg.overlayHeight, wa.height)
      : Math.min(Math.floor(wa.height * 0.82), 760);
  const pos = cfg.overlayPos;
  const x = pos && Number.isFinite(pos.x) ? pos.x : cfg.overlaySide === 'left' ? wa.x + 24 : wa.x + wa.width - width - 24;
  const y = pos && Number.isFinite(pos.y) ? pos.y : wa.y + Math.floor((wa.height - height) / 2);
  return { x, y, width, height };
}

/* ------------------------------------------------------- 屏幕共享自检 */

function bgraRegion(img, rect) {
  const size = img.getSize();
  const buf = img.toBitmap();
  const sx = size.width / rect.baseWidth;
  const sy = size.height / rect.baseHeight;
  const x0 = Math.max(0, Math.floor(rect.x * sx));
  const y0 = Math.max(0, Math.floor(rect.y * sy));
  const x1 = Math.min(size.width, Math.ceil((rect.x + rect.width) * sx));
  const y1 = Math.min(size.height, Math.ceil((rect.y + rect.height) * sy));
  const out = [];
  const step = 3; // 采样步长，够用且快
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * size.width + x) * 4;
      out.push(buf[i], buf[i + 1], buf[i + 2]);
    }
  }
  return out;
}

async function grabScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  if (!sources.length) throw new Error('无法获取屏幕画面');
  return { img: sources[0].thumbnail, base: { width, height } };
}

/**
 * 防护自检（标记法）
 * ------------------------------------------------------------
 * 在悬浮窗里临时画一个 12×12 的独特颜色块，截屏看采集画面里有没有这个颜色。
 * 有 = 被采集到了；没有 = 已被系统排除。
 * 不再依赖"前后两帧比对"，所以背后的视频/动画再怎么变都不会误判。
 */
const PROBE_ON = `(() => {
  let d = document.getElementById('__probe');
  if (!d) {
    d = document.createElement('div');
    d.id = '__probe';
    d.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;background:rgb(255,0,254);z-index:2147483647;pointer-events:none';
    document.body.appendChild(d);
  }
  // 兜底自毁：万一清理语句没跑到（窗口重载、进程异常），标记也不会留在界面上
  clearTimeout(window.__probeT);
  window.__probeT = setTimeout(() => {
    const x = document.getElementById('__probe');
    if (x) x.remove();
  }, 5000);
  return true;
})()`;
const PROBE_OFF = `(() => {
  const d = document.getElementById('__probe');
  if (d) d.remove();
  return true;
})()`;

function countProbe(img, rect, base) {
  const size = img.getSize();
  const buf = img.toBitmap();
  const sx = size.width / base.width;
  const sy = size.height / base.height;
  const x0 = Math.max(0, Math.floor(rect.x * sx));
  const y0 = Math.max(0, Math.floor(rect.y * sy));
  const x1 = Math.min(size.width, Math.ceil((rect.x + rect.width) * sx));
  const y1 = Math.min(size.height, Math.ceil((rect.y + rect.height) * sy));
  let hit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size.width + x) * 4;
      // BGRA
      if (buf[i + 2] > 245 && buf[i + 1] < 12 && buf[i] > 245) hit++;
    }
  }
  return hit;
}

function runProtectionSelfTest(force) {
  return probeSlot(() => doProtectionSelfTest(force));
}

async function doProtectionSelfTest(force) {
  if (!overlayWin || overlayWin.isDestroyed()) return { ok: null, reason: '悬浮窗未创建' };

  // 挑一个当前可见的窗口做检测：悬浮窗优先，其次控制台。
  // 以前为了检测会把隐藏的悬浮窗强行弹出来，用户会以为"点一下悬浮窗自己冒出来了"。
  const target = overlayWin.isVisible()
    ? overlayWin
    : consoleWin && !consoleWin.isDestroyed() && consoleWin.isVisible()
    ? consoleWin
    : null;

  if (!target) {
    const r = { ok: null, skipped: true, reason: '两个窗口都是最小化或隐藏状态' };
    broadcast('guard:verified', r);
    return r;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  guardPaused = true;
  applyCaptureProtection();
  await sleep(200);

  try {
    await target.webContents.executeJavaScript(PROBE_ON);
    await sleep(400);

    const b = target.getBounds();
    const s = await grabScreen();
    const hits = countProbe(s.img, { x: b.x, y: b.y, width: b.width, height: b.height }, s.base);

    await target.webContents.executeJavaScript(PROBE_OFF).catch(() => {});

    // 采集里出现标记色 = 窗口被拍到了
    const leaked = hits >= 8;
    const result = {
      ok: !leaked,
      hits,
      reason: leaked ? '拍到了窗口' : '已隐藏',
    };
    broadcast('guard:verified', result);
    console.log('[guard] 自检:', result.reason, '标记命中', hits, '像素');
    return result;
  } catch (e) {
    await target.webContents.executeJavaScript(PROBE_OFF).catch(() => {});
    const err = { ok: null, reason: e.message };
    broadcast('guard:verified', err);
    return err;
  } finally {
    // 无论成功失败都把标记擦掉，否则悬浮窗左上角会留一个洋红小方块
    await target.webContents.executeJavaScript(PROBE_OFF).catch(() => {});
    guardPaused = false;
  }
}

/* ------------------------------------------------- 尺寸诊断（--sizetest） */

async function runSizeTest() {
  await waitMs(3200);
  const js = (code) => overlayWin.webContents.executeJavaScript(code);
  const b0 = overlayWin.getBounds();

  // ① 拖右下角放大 120x80
  await js(`(() => {
    const h = document.querySelector('.rz-se');
    const opt3 = (sx, sy) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 3, pointerType: 'mouse', screenX: sx, screenY: sy });
    h.dispatchEvent(new PointerEvent('pointerdown', opt3(800, 600)));
    document.dispatchEvent(new PointerEvent('pointermove', opt3(920, 680)));
    document.dispatchEvent(new PointerEvent('pointerup', opt3(920, 680)));
    return 'ok';
  })()`);
  await waitMs(700);
  let b = overlayWin.getBounds();
  console.log(`[sizetest] 缩放 ${b0.width}x${b0.height} -> ${b.width}x${b.height} 预期 +120/+80`);
  console.log(
    `[sizetest] ${Math.abs(b.width - b0.width - 120) <= 2 && Math.abs(b.height - b0.height - 80) <= 2 ? 'PASS' : 'FAIL'} 右下角缩放`
  );
  console.log(
    `[sizetest] ${Math.abs((config.load().overlayWidth || 0) - b.width) <= 4 ? 'PASS' : 'FAIL'} 尺寸已保存（${config.load().overlayWidth} vs ${b.width}）`
  );

  // ② 手动缩放后，内容自动高度不应再改窗口
  broadcast('llm:start', { question: '测试问题' });
  await waitMs(500);
  broadcast('llm:done', { text: '短答案' });
  await waitMs(1200);
  const b2 = overlayWin.getBounds();
  console.log(
    `[sizetest] ${Math.abs(b2.height - b.height) <= 4 ? 'PASS' : 'FAIL'} 手动缩放后不再被内容高度覆盖（${b.height} -> ${b2.height}）`
  );

  // ③ 收起
  await js(`document.getElementById('wbMin').click()`);
  await waitMs(600);
  const b3 = overlayWin.getBounds();
  console.log(`[sizetest] ${b3.height <= 72 ? 'PASS' : 'FAIL'} 收起为标题栏（高=${b3.height}）`);
  await js(`document.getElementById('wbMin').click()`);
  await waitMs(600);
  const b4 = overlayWin.getBounds();
  console.log(`[sizetest] ${b4.height > 100 ? 'PASS' : 'FAIL'} 再点展开（高=${b4.height}）`);

  // ④ 全屏 / 还原
  await js(`document.getElementById('wbMax').click()`);
  await waitMs(700);
  const wa = screen.getPrimaryDisplay().workArea;
  const b5 = overlayWin.getBounds();
  console.log(`[sizetest] ${b5.width >= wa.width - 30 ? 'PASS' : 'FAIL'} 铺满屏幕（${b5.width}x${b5.height}）`);
  await js(`document.getElementById('wbMax').click()`);
  await waitMs(700);
  const b6 = overlayWin.getBounds();
  console.log(`[sizetest] ${b6.width < wa.width - 30 ? 'PASS' : 'FAIL'} 还原（${b6.width}x${b6.height}）`);

  // ⑤ 关闭
  await js(`document.getElementById('wbClose').click()`);
  await waitMs(600);
  console.log(`[sizetest] ${!overlayWin.isVisible() ? 'PASS' : 'FAIL'} 关闭按钮隐藏悬浮窗`);
  console.log(`[sizetest] ${config.load().overlayVisible === false ? 'PASS' : 'FAIL'} 状态已写回配置`);

  app.quit();
}

/* --------------------------------------------------- 拖动诊断（--dragtest） */

async function runDragTest() {
  await waitMs(3200);
  const js = (code) => overlayWin.webContents.executeJavaScript(code);

  // 先挪到屏幕中间的安全位置：如果上一轮诊断把窗口留在屏幕边缘，
  // 拖动的目标点会被边界钳制，位移对不上会误报 FAIL。
  {
    const wa = screen.getPrimaryDisplay().workArea;
    const cur = overlayWin.getBounds();
    overlayWin.setBounds({
      x: wa.x + 200,
      y: wa.y + 150,
      width: Math.min(cur.width || 460, Math.floor(wa.width / 2)),
      height: Math.min(cur.height || 360, Math.floor(wa.height / 2)),
    });
    await waitMs(500);
  }

  const b0 = overlayWin.getBounds();

  // 模拟：按住标题栏 -> 移动两次 -> 松开
  await js(`(() => {
    const bar = document.querySelector('.bar');
    const r = bar.getBoundingClientRect();
    const cx = r.left + 20, cy = r.top + 10;
    const opt = (sx, sy) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: sx, clientY: sy, screenX: sx, screenY: sy });
    bar.dispatchEvent(new PointerEvent('pointerdown', opt(500, 400)));
    document.dispatchEvent(new PointerEvent('pointermove', opt(620, 480)));
    document.dispatchEvent(new PointerEvent('pointermove', opt(700, 520)));
    document.dispatchEvent(new PointerEvent('pointerup', opt(700, 520)));
    return 'ok';
  })()`);
  await waitMs(800);

  const b1 = overlayWin.getBounds();
  const dx = b1.x - b0.x;
  const dy = b1.y - b0.y;
  console.log(`[dragtest] 拖动前尺寸 ${b0.width}x${b0.height} -> 拖动后 ${b1.width}x${b1.height}`);
  console.log(`[dragtest] 拖动 ${b0.x},${b0.y} -> ${b1.x},${b1.y} 位移=(${dx},${dy}) 预期=(200,120)`);
  console.log(`[dragtest] ${dx === 200 && dy === 120 ? 'PASS' : 'FAIL'} 位移正确`);

  const saved = config.load().overlayPos;
  console.log(`[dragtest] ${saved && saved.x === b1.x && saved.y === b1.y ? 'PASS' : 'FAIL'} 位置已记住 ${JSON.stringify(saved)}`);

  // 交互切换后防护是否还在
  const r = await runProtectionSelfTest(true);
  console.log(`[dragtest] ${r.ok === true ? 'PASS' : 'FAIL'} 拖动后防护仍生效（${r.ok === true ? '已隐藏' : r.ok === false ? '仍可见' : '无法判断'}）`);

  // ---- 逐帧拖动（每步间隔 40ms，模拟真实拖动），每 5 步采样尺寸
  const bS = overlayWin.getBounds();
  await js(`(() => {
    const bar = document.querySelector('.bar');
    const r = bar.getBoundingClientRect();
    window.__dragPt = { cx: r.left + 30, cy: r.top + 12 };
    const opt = (sx, sy) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 9, pointerType: 'mouse', clientX: window.__dragPt.cx, clientY: window.__dragPt.cy, screenX: sx, screenY: sy });
    bar.dispatchEvent(new PointerEvent('pointerdown', opt(1000, 700)));
    window.__mv = (i) => document.dispatchEvent(new PointerEvent('pointermove', opt(1000 + i * 6, 700 + i * 4)));
    return 'ok';
  })()`);
  for (let i = 1; i <= 30; i++) {
    await js(`window.__mv(${i})`);
    await waitMs(40);
    if (i % 5 === 0) {
      const bb = overlayWin.getBounds();
      console.log(`[dragtest] 逐帧拖动 第${i}步 ${bb.width}x${bb.height}（起始 ${bS.width}x${bS.height}）`);
    }
  }
  await js(`document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'mouse', screenX: 1180, screenY: 820 }))`);
  await waitMs(500);
  const bE = overlayWin.getBounds();
  console.log(`[dragtest] 松手后 ${bE.width}x${bE.height}，位置 ${bE.x},${bE.y}`);

  // 按在窗口最顶部 2px：应当被当成"上边缘缩放"，而不是拖动
  const bEdge0 = overlayWin.getBounds();
  await js(`(() => {
    const el = document.elementFromPoint(200, 2);
    const t = el && el.className ? el.className : String(el && el.tagName);
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200, clientY: 2, screenX: 900, screenY: 500 }));
    const opt2 = (sx, sy) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 2, pointerType: 'mouse', clientX: 200, clientY: sy, screenX: sx, screenY: sy });
    el.dispatchEvent(new PointerEvent('pointerdown', opt2(900, 500)));
    document.dispatchEvent(new PointerEvent('pointermove', opt2(900, 440)));
    document.dispatchEvent(new PointerEvent('pointerup', opt2(900, 440)));
    return t;
  })()`).then((t) => console.log('[dragtest] 顶部 2px 命中的元素:', t));
  await waitMs(800);
  const bEdge1 = overlayWin.getBounds();
  console.log(`[dragtest] 顶边拖动：${bEdge0.height} -> ${bEdge1.height}（高度变化=缩放，位置变化=误判为拖动）`);

  // 复位
  cfg = config.save({ overlayPos: null });
  placeOverlay();
  await waitMs(400);
  const b2 = overlayWin.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  const expectX = cfg.overlaySide === 'left' ? wa.x + 24 : wa.x + wa.width - b2.width - 24;
  console.log(`[dragtest] ${Math.abs(b2.x - expectX) <= 2 ? 'PASS' : 'FAIL'} 双击复位回默认位置（x=${b2.x} 期望≈${expectX}）`);

  app.quit();
}

/* --------------------------------------------------- 界面点击诊断（--clicktest） */

async function runClickTest() {
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  const state = async () =>
    JSON.parse(
      await js(`JSON.stringify({
        label: document.getElementById('guardLabel').textContent,
        cfgOn: null,
        chk: document.getElementById('swStealth').checked,
        overlay: null
      })`)
    );
  await waitMs(3200);
  const probe = async () => {
    const r = await runProtectionSelfTest(true);
    return r.ok === true ? '已隐藏' : r.ok === false ? '仍可见' : '无法判断';
  };

  // 先把防护关掉作为起点
  cfg = config.save({ hideCaptured: false });
  applyCaptureProtection();
  broadcast('cfg:changed', cfg);
  await waitMs(700);
  console.log(`[clicktest] 起点：按钮="${(await state()).label}" 实测=${await probe()}`);

  // 第 1 次点击：应当开启
  await js(`document.getElementById('btnGuard').click()`);
  await waitMs(3000);
  let st = await state();
  console.log(`[clicktest] 点第 1 次：按钮="${st.label}" 内存cfg=${cfg.hideCaptured} 实测=${await probe()}`);

  // 第 2 次点击：应当关闭。分多个时间点复测，区分"延迟生效"还是"卡死不生效"
  await js(`document.getElementById('btnGuard').click()`);
  for (const ms of [800, 2000, 4000, 7000]) {
    await waitMs(ms === 800 ? 800 : ms - 800);
    st = await state();
    console.log(`[clicktest] 关闭后 ${ms}ms：按钮="${st.label}" cfg=${cfg.hideCaptured} 实测=${await probe()}`);
  }

  // 关闭后单独测控制台：把悬浮窗藏起来，探针就落到控制台上
  overlayWin.hide();
  await waitMs(600);
  console.log(`[clicktest] 关闭后改测控制台：实测=${await probe()}`);
  overlayWin.showInactive();
  await waitMs(500);

  // 悬浮窗隐身开关
  for (let i = 1; i <= 2; i++) {
    await js(`(()=>{ const el=document.getElementById('swStealth'); el.checked=!el.checked; el.dispatchEvent(new Event('change')); })()`);
    await waitMs(900);
    console.log(
      `[clicktest] 悬浮窗开关第${i}次：勾选=${(await state()).chk} 实际可见=${overlayWin.isVisible()}`
    );
  }

  // 悬浮窗隐藏状态下点「隐藏窗口」，不应该把悬浮窗弹出来
  cfg = config.save({ overlayVisible: false, hideCaptured: false });
  overlayWin.hide();
  applyCaptureProtection();
  broadcast('cfg:changed', cfg);
  await waitMs(700);
  await js(`document.getElementById('btnGuard').click()`);
  await waitMs(3000);
  console.log(`[clicktest] 悬浮窗已隐藏时点按钮：悬浮窗仍隐藏=${!overlayWin.isVisible()} 实测=${await probe()}`);

  // 开始监听 -> 是否自动防护 + 收起控制台
  cfg = config.save({ hideCaptured: false });
  applyCaptureProtection();
  broadcast('cfg:changed', cfg);
  if (!consoleWin.isVisible()) consoleWin.show();
  await waitMs(400);
  await js(`(async()=>{ await toggleListening(); })()`);
  await waitMs(2500);
  if (consoleWin.isMinimized()) consoleWin.restore(); // 只为检测，恢复后不影响结论
  await waitMs(600);
  console.log(
    `[clicktest] 开始监听后：cfg.hideCaptured=${cfg.hideCaptured} 控制台最小化=${consoleWin.isMinimized()} 实测=${await probe()}`
  );

  app.quit();
}

/* --------------------------------------------------- 防护开关诊断（--guardtest） */

async function runGuardToggleTest() {
  await waitMs(3200);
  const setProtect = (on) => {
    cfg = config.save({ hideCaptured: on });
    applyCaptureProtection();
  };

  for (let i = 1; i <= 3; i++) {
    for (const want of [true, false]) {
      setProtect(want);
      await waitMs(900);
      const r = await runProtectionSelfTest(true);
      const leaked = r.ok === false;
      const consistent = want ? r.ok === true : leaked;
      console.log(
        `[guardtest] 第${i}轮 设为${want ? '开启' : '关闭'} -> 实测${r.ok === true ? '已隐藏' : leaked ? '仍可见' : '无法判断'} ${consistent ? 'OK' : '不一致'}`
      );
    }
  }

  // 悬浮窗显隐
  for (let i = 1; i <= 3; i++) {
    cfg = config.save({ overlayVisible: false });
    overlayWin.hide();
    await waitMs(400);
    const hidden = !overlayWin.isVisible();
    cfg = config.save({ overlayVisible: true });
    overlayWin.showInactive();
    await waitMs(500);
    const shown = overlayWin.isVisible();
    console.log(`[guardtest] 第${i}轮 悬浮窗 隐藏=${hidden ? 'OK' : '失败'} 显示=${shown ? 'OK' : '失败'}`);
  }

  // 开启保护后第一次点击是否立即生效（模拟用户点按钮那一刻）
  setProtect(false);
  await waitMs(600);
  setProtect(true);
  await waitMs(120); // 用户点完立刻测
  const fast = await runProtectionSelfTest(true);
  console.log(`[guardtest] 开启后立刻检测 -> ${fast.ok === true ? '已隐藏' : fast.ok === false ? '仍可见（异常）' : '无法判断'}`);

  app.quit();
}

/* --------------------------------------------------- 功能自测（--uitest） */

async function runUiTest() {
  const results = [];
  const ok = (name, cond, extra) => {
    results.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra) });
    console.log(`[uitest] ${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };
  // 内置通道已移除：没配模型时，涉及作答的断言无从验证，标记为 SKIP 而不是 FAIL
  const noModel = !cfg.activeRef || !(cfg.customProviders || []).some((p) => p.id === cfg.activeRef.providerId);
  const skip = (name) => {
    results.push({ name, pass: true, skipped: true, extra: '未配置模型，跳过' });
    console.log(`[uitest] SKIP ${name}（未配置模型）`);
  };
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  const clickNav = (panel) => js(`document.querySelector('[data-panel=${panel}]').click()`);
  await waitMs(3500);

  // ---- 1) 侧栏四个入口
  const nav = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.nav-item')].map(b=>b.dataset.panel))`));
  ok('侧栏含七个入口（含模拟面试/模型/设置）', nav.join(',') === 'session,history,kb,skills,mock,models,settings', nav.join(','));

  // ---- 2) 技能页：无说明文字、无描述行
  const sk = JSON.parse(
    await js(`(()=>{ document.querySelector('[data-panel=skills]').click();
      return JSON.stringify({
        sub: document.querySelectorAll('#panel-skills .page-sub').length,
        desc: document.querySelectorAll('.skill-desc').length,
        cards: document.querySelectorAll('.skill-card').length
      }); })()`)
  );
  ok('技能页已删说明段落', sk.sub === 0, `page-sub=${sk.sub}`);
  ok('技能卡已删描述行', sk.desc === 0, `desc=${sk.desc} cards=${sk.cards}`);

  // ---- 3) 注入一句提问，验证作答会写进当前场次
  await clickNav('session');
  await waitMs(300);
  dispatchText('interviewer', '你在项目里是怎么处理高并发下单的？');
  let waited = 0;
  while (waited < 45000 && (!sessions || sessions.count === 0)) {
    await waitMs(500);
    waited += 500;
  }
  noModel ? skip('作答生成并计入本场') : ok('作答生成并计入本场', sessions && sessions.count === 1, `count=${sessions && sessions.count} 用时${waited}ms`);

  const beforeCount = sessions ? sessions.summary().items.length : -1;

  // ---- 4) 点「新建任务」= 开新的一场
  await clickNav('session');
  await waitMs(1500);
  const sumAfterNew = sessions.summary();
  noModel ? skip('新建任务后历史 +1') : ok('新建任务后历史 +1', sumAfterNew.items.length === beforeCount + 1, `${beforeCount} -> ${sumAfterNew.items.length}`);
  ok('新建任务后本场清空', sumAfterNew.current.count === 0, `count=${sumAfterNew.current.count}`);

  const domAfterNew = JSON.parse(
    await js(`JSON.stringify({
      q: document.getElementById('question').textContent.trim(),
      trans: document.getElementById('transcript').textContent.trim().length,
      ans: document.getElementById('answer').textContent.trim().length,
      toast: document.getElementById('toast').classList.contains('on')
    })`)
  );
  ok('界面已清空', domAfterNew.trans === 0 && domAfterNew.ans === 0, `字幕${domAfterNew.trans}字 作答${domAfterNew.ans}字`);
  noModel ? skip('提示以浮动提示出现（不写进字幕）') : ok('提示以浮动提示出现（不写进字幕）', domAfterNew.toast === true, `toast=${domAfterNew.toast}`);

  // ---- 5) 历史记录列表渲染与展开
  await clickNav('history');
  await waitMs(900);
  const histCount = await js(`document.querySelectorAll('.hist-item').length`);
  ok('历史记录渲染出条目', histCount >= 1, `items=${histCount}`);

  await js(`document.querySelector('.hist-item').click()`);
  const at0 = await js(`document.querySelector('.hist-item').className`);
  await waitMs(300);
  const at300 = await js(`document.querySelector('.hist-item').className`);
  await waitMs(700);
  const at1000 = await js(`document.querySelector('.hist-item').className`);
  console.log(`[uitest] 展开状态：立刻=${at0} 300ms=${at300} 1000ms=${at1000}`);
  const detail = JSON.parse(
    await js(`(()=>{ const el = document.querySelector('.hist-item');
      const qa = el.querySelector('.hist-qa');
      return JSON.stringify({
        open: el.classList.contains('open'),
        len: qa.textContent.length,
        hasQ: qa.textContent.includes('高并发'),
        hasA: qa.textContent.length > 60
      }); })()`)
  );
  noModel ? skip('展开后能看到问答') : ok('展开后能看到问答', detail.open && detail.hasQ && detail.hasA, JSON.stringify(detail));

  // ---- 5c) 落盘检查（放在删除之前，否则文件里已被删空）
  let disk = -1;
  try {
    disk = JSON.parse(require('fs').readFileSync(sessions.file, 'utf8')).length;
  } catch (e) {
    disk = -1;
  }
  ok('已写入 sessions.json', disk >= 1, `sessions.json 中 ${disk} 场`);

  // ---- 5b) 删除某一场
  const beforeDel = await js(`document.querySelectorAll('.hist-item').length`);
  await js(`document.querySelector('.hist-del').click()`);
  await waitMs(1000);
  const afterDel = await js(`document.querySelectorAll('.hist-item').length`);
  ok('历史记录可删除', afterDel === beforeDel - 1, `${beforeDel} -> ${afterDel}`);

  // ---- 7) 底部输入框手动提问
  const beforeAsk = sessions.count;
  await js(`(()=>{ const el=document.getElementById('askInput'); el.value='你的缺点是什么'; document.getElementById('btnAsk').click(); return 'ok'; })()`);
  let w2 = 0;
  while (w2 < 25000 && sessions.count === beforeAsk) {
    await waitMs(500);
    w2 += 500;
  }
  noModel ? skip('输入框提问能触发作答') : ok('输入框提问能触发作答', sessions.count > beforeAsk, `count ${beforeAsk} -> ${sessions.count}`);
  const heroGone = await js(`document.getElementById('panel-session').classList.contains('busy')`);
  ok('提问后首屏已收起', heroGone === true, `busy=${heroGone}`);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`[uitest] 汇总：${results.length - failed}/${results.length} 通过`);
  app.quit();
}

/* --------------------------------------------------- 真实窗口点击诊断（--clickcheck） */
/**
 * 在真正的控制台窗口里用「真实鼠标事件」点设置栏，
 * 专治「元素看着在、就是点不动」这类遮挡 bug（fixture 环境测不出来）。
 */
async function runClickCheck() {
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  const wc = consoleWin.webContents;
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`[clickcheck] ${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  await waitMs(3200);

  const rect = async (sel) =>
    JSON.parse(
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return 'null'; const r=e.getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`)
    );

  const click = async (sel, fx = 0.62) => {
    const r = await rect(sel);
    if (!r) return false;
    const x = Math.round(r.x + r.w * fx);
    const y = Math.round(r.y + r.h / 2);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await waitMs(280);
    return true;
  };

  // 1) 遮挡扫描：设置栏内所有可见交互元素的中心点归谁
  const blocked = JSON.parse(
    await js(`(()=>{const out=[];
      for(const el of document.querySelectorAll('#rail button, #rail input, #rail label[for]')){
        const r=el.getBoundingClientRect();
        if(r.width<4||r.height<4) continue;
        const cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.display==='none') continue;
        const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
        if(!hit||hit===el||el.contains(hit)) continue;
        out.push((el.id||el.className||el.tagName)+' -> '+(hit.id||hit.className||hit.tagName));
      }
      return JSON.stringify(out);})()`)
  );
  ok('设置栏交互元素无遮挡', blocked.length === 0, blocked.join(' ; ') || 'ok');

  // 2) 三个开关：真实点击滑块本体，点完立刻还原
  for (const id of ['swSys', 'swMic', 'swAuto']) {
    const before = await js(`document.getElementById('${id}').checked`);
    await click('#' + id);
    const after = await js(`document.getElementById('${id}').checked`);
    ok(`${id} 真机点滑块能切换`, before !== after, `${before} -> ${after}`);
    if (before !== after) await click('#' + id); // 还原
  }

  // 3) 分段按钮：切到「口语」再切回原值
  const styleBefore = JSON.parse(await js(`JSON.stringify((cfg||{}).style||'bullet')`));
  await click('#segStyle [data-v=spoken]');
  const spokenOn = await js(`document.querySelector('#segStyle [data-v=spoken]').classList.contains('on')`);
  ok('作答风格可切换', spokenOn === true, `原=${styleBefore}`);
  await click(`#segStyle [data-v=${styleBefore}]`);

  // 4) 透明度滑杆
  const opBefore = JSON.parse(await js(`JSON.stringify((cfg||{}).overlayOpacity||0.95)`));
  await click('#rgOpacity', 0.55);
  const opAfter = JSON.parse(await js(`JSON.stringify((cfg||{}).overlayOpacity||0.95)`));
  ok('透明度滑杆可调整', opBefore !== opAfter, `${opBefore} -> ${opAfter}`);
  await js(`(()=>{const el=document.getElementById('rgOpacity'); el.value=Math.round(${opBefore}*100);
    el.dispatchEvent(new Event('input',{bubbles:true}));})()`);

  console.log(`[clickcheck] 汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 悬浮窗唤醒/拖动诊断（--waketest） */
/**
 * 复现「鼠标压在标题栏上但窗口仍是穿透态」的场景，验证兜底唤醒是否有效，
 * 并用真实输入事件把悬浮窗拖一段，检查位移。
 */
async function runWakeTest() {
  const log = (...a) => console.log('[waketest]', ...a);
  await waitMs(3200);
  if (!overlayWin || overlayWin.isDestroyed()) {
    log('FAIL 没有悬浮窗');
    app.quit();
    return;
  }
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  const b0 = overlayWin.getBounds();
  const cur = screen.getCursorScreenPoint();
  const w = b0.width;
  const h = b0.height;

  // 1) 先强制打回穿透态，模拟"醒不过来"
  setOverlayInteractive(false, false);
  await waitMs(400);

  // 2) 把窗口挪到光标下，让光标正好压在标题栏上
  overlayWin.setBounds({
    x: cur.x - Math.round(w / 2),
    y: cur.y - 16,
    width: w,
    height: h,
  });
  await waitMs(1400);
  ok('光标压在标题栏上时窗口能醒过来', overlayInteractive === true, `interactive=${overlayInteractive}`);

  // 3) 醒过来之后应该能拖动：发真实输入事件拖一段
  // 先把窗口挪离真实光标：真实指针压在窗口上时，会和合成事件互相打架，
  // 位移会莫名其妙跑偏（实测出现过 219,-78 这种值）。
  {
    const wa = screen.getPrimaryDisplay().workArea;
    overlayWin.setBounds({
      x: wa.x + 220,
      y: wa.y + 160,
      width: Math.min(w, Math.floor(wa.width / 2)),
      height: Math.min(h, Math.floor(wa.height / 2)),
    });
    await waitMs(500);
  }

  // 注意：必须带 globalX/globalY，否则渲染层拿到的 e.screenX 恒为 0，位移会被算成 0
  const before = overlayWin.getBounds();
  const wc = overlayWin.webContents;
  const px = 60;
  const py = 20;
  const send = (type, x, y, extra) =>
    wc.sendInputEvent({
      type,
      x,
      y,
      globalX: before.x + x,
      globalY: before.y + y,
      ...(extra || {}),
    });
  send('mouseMove', px, py);
  send('mouseDown', px, py, { button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    send('mouseMove', px + i * 8, py + i * 4, { button: 'left' });
    await waitMs(35);
  }
  send('mouseUp', px + 48, py + 24, { button: 'left', clickCount: 1 });
  await waitMs(500);
  const after = overlayWin.getBounds();
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  ok('按住标题栏能拖动', Math.abs(dx - 48) <= 2 && Math.abs(dy - 24) <= 2, `位移=(${dx},${dy}) 期望=(48,24)`);
  ok('拖动不改变尺寸（125% DPI 下允许 2px 取整误差）',
    Math.abs(after.width - before.width) <= 2 && Math.abs(after.height - before.height) <= 2,
    `${before.width}x${before.height} -> ${after.width}x${after.height}`);

  // 4) 光标落在正文区时仍应保持穿透（点击要能落到下层应用）
  setOverlayInteractive(false, false);
  overlayWin.setBounds({
    x: cur.x - Math.round(w / 2),
    y: cur.y - Math.round(h * 0.65),
    width: w,
    height: h,
  });
  await waitMs(1200);
  ok('光标在正文区时保持穿透', overlayInteractive === false, `interactive=${overlayInteractive}`);

  // 还原
  overlayWin.setBounds(b0);
  setOverlayInteractive(false, false);
  await waitMs(300);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 隐藏/显示后可用性诊断（--hidetest） */
/**
 * 复现用户的真实操作：点 × 隐藏 → 再显示回来 → 还能不能拖动、点 – □ ×。
 * 这条路径以前会因为「armOverlay 打回穿透但状态没同步」而彻底卡死。
 */
async function runHideTest() {
  const log = (...a) => console.log('[hidetest]', ...a);
  await waitMs(3200);
  if (!overlayWin || overlayWin.isDestroyed()) {
    log('FAIL 没有悬浮窗');
    app.quit();
    return;
  }
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };
  const js = (code) => overlayWin.webContents.executeJavaScript(code);
  const wc = overlayWin.webContents;

  const rectOf = async (sel) =>
    JSON.parse(
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return 'null'; const r=e.getBoundingClientRect();
      return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`)
    );

  const click = async (sel) => {
    const r = await rectOf(sel);
    if (!r) return false;
    const b = overlayWin.getBounds();
    const x = Math.round(r.x + r.w / 2);
    const y = Math.round(r.y + r.h / 2);
    const base = { x, y, globalX: b.x + x, globalY: b.y + y };
    wc.sendInputEvent({ type: 'mouseMove', ...base });
    wc.sendInputEvent({ type: 'mouseDown', ...base, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...base, button: 'left', clickCount: 1 });
    await waitMs(320);
    return true;
  };

  // 把窗口挪到光标下，让光标正好压在标题栏
  const warpCursorOntoBar = async () => {
    const cur = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    overlayWin.setBounds({
      x: cur.x - Math.round(b.width / 2),
      y: cur.y - 18,
      width: b.width,
      height: b.height,
    });
    await waitMs(1400);
  };

  // 显示窗口（模拟重新打开）。away=true 时先把窗口挪离光标，
  // 否则兜底唤醒会立刻生效，测不出「显示后默认是穿透态」。
  const showAgain = async (away) => {
    if (away) {
      const cur = screen.getCursorScreenPoint();
      const b = overlayWin.getBounds();
      const wa = screen.getPrimaryDisplay().workArea;
      let nx = cur.x + 260;
      if (nx + b.width > wa.x + wa.width) nx = Math.max(wa.x, cur.x - b.width - 260);
      const ny = Math.min(Math.max(cur.y - 220, wa.y), wa.y + wa.height - b.height);
      overlayWin.setBounds({ x: nx, y: ny, width: b.width, height: b.height });
      await waitMs(350);
    }
    overlayWin.showInactive();
    await waitMs(700); // 等 show 之后那次 armOverlay
  };

  // ---- 1) 先显示，检查初始是穿透态
  if (!overlayWin.isVisible()) await showAgain(true);
  ok('显示后处于穿透态', overlayInteractive === false, `interactive=${overlayInteractive}`);

  // ---- 2) 光标压标题栏应能唤醒
  await warpCursorOntoBar();
  ok('光标压标题栏能唤醒（第一次）', overlayInteractive === true, `interactive=${overlayInteractive}`);

  // ---- 3) 点 × 隐藏
  await click('#wbClose');
  ok('× 能关闭悬浮窗', overlayWin.isVisible() === false, `visible=${overlayWin.isVisible()}`);

  // ---- 4) 重新显示（挪离光标），状态应回到穿透
  await showAgain(true);
  ok('重新显示后回到穿透态', overlayInteractive === false, `interactive=${overlayInteractive}`);

  // ---- 5) 关键：重新显示后还能不能唤醒（用户报的就是这里坏掉）
  await warpCursorOntoBar();
  ok('重新显示后光标压标题栏仍能唤醒', overlayInteractive === true, `interactive=${overlayInteractive}`);

  // ---- 6) 唤醒后 – □ × 三个按钮都要能点
  await click('#wbMin');
  ok('– 能收起为标题栏', overlayCompact === true, `compact=${overlayCompact}`);
  await click('#wbMin');
  ok('– 能再展开', overlayCompact === false, `compact=${overlayCompact}`);

  await click('#wbMax');
  ok('□ 能铺满屏幕', overlayMaxed === true, `maxed=${overlayMaxed}`);
  await click('#wbMax');
  ok('□ 能还原', overlayMaxed === false, `maxed=${overlayMaxed}`);

  await click('#wbClose');
  ok('× 仍能关闭', overlayWin.isVisible() === false, `visible=${overlayWin.isVisible()}`);

  // ---- 7) 还原现场
  cfg = config.save({ overlayVisible: true });
  overlayWin.showInactive();
  await waitMs(500);
  placeOverlay();
  broadcast('cfg:changed', cfg);
  broadcast('overlay:state', overlayState());

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 开关切换后还能拖吗（--stealthtest） */
/**
 * 复现用户路径：设置栏点「悬浮窗隐身」关掉再打开 / 点「隐藏窗口」，之后还能不能拖。
 * 判定不只看主进程状态，还要核对渲染层的本地状态，两边只要有一个脱节就会永久穿透。
 */
async function runStealthTest() {
  const log = (...a) => console.log('[stealthtest]', ...a);
  await waitMs(3200);
  if (!overlayWin || overlayWin.isDestroyed() || !consoleWin) {
    log('FAIL 窗口缺失');
    app.quit();
    return;
  }
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };
  const ojs = (code) => overlayWin.webContents.executeJavaScript(code);
  const cjs = (code) => consoleWin.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const clickConsole = async (sel) => {
    const r = JSON.parse(
      await cjs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
      if(!e)return 'null';const b=e.getBoundingClientRect();
      return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height});})()`)
    );
    if (!r) return false;
    const b = consoleWin.getBounds();
    const x = Math.round(r.x + r.w / 2);
    const y = Math.round(r.y + r.h / 2);
    const ev = { x, y, globalX: b.x + x, globalY: b.y + y };
    console.log('[stealthtest] 点击', sel, '窗口内', x, y, '控制台', JSON.stringify(b));
    const wc = consoleWin.webContents;
    wc.sendInputEvent({ type: 'mouseMove', ...ev });
    wc.sendInputEvent({ type: 'mouseDown', ...ev, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...ev, button: 'left', clickCount: 1 });
    await sleep(450);
    return true;
  };

  const warpOntoBar = async () => {
    const cur = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    overlayWin.setBounds({
      x: cur.x - Math.round(b.width / 2),
      y: cur.y - 18,
      width: b.width,
      height: b.height,
    });
    await sleep(1400);
  };

  const sideState = async () => ({
    main: overlayInteractive,
    renderer: await ojs('window.__ov ? window.__ov.interactive : null').catch(() => null),
  });

  // 挪开真实光标再合成拖动：真实指针压在窗口上会和合成事件打架
  const dragCheck = async (label) => {
    const wa = screen.getPrimaryDisplay().workArea;
    const b0 = overlayWin.getBounds();
    overlayWin.setBounds({
      x: wa.x + 220,
      y: wa.y + 160,
      width: Math.min(b0.width, Math.floor(wa.width / 2)),
      height: Math.min(b0.height, Math.floor(wa.height / 2)),
    });
    await sleep(500);
    const before = overlayWin.getBounds();
    const wc = overlayWin.webContents;
    const px = 60;
    const py = 20;
    const send = (type, x, y, extra) =>
      wc.sendInputEvent({ type, x, y, globalX: before.x + x, globalY: before.y + y, ...(extra || {}) });
    send('mouseMove', px, py);
    send('mouseDown', px, py, { button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      send('mouseMove', px + i * 8, py + i * 4, { button: 'left' });
      await sleep(35);
    }
    send('mouseUp', px + 48, py + 24, { button: 'left', clickCount: 1 });
    await sleep(500);
    const after = overlayWin.getBounds();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    log(`${label} 拖前=${JSON.stringify(before)} 拖后=${JSON.stringify(after)}`);
    ok(`${label} 能拖动`, Math.abs(dx - 48) <= 2 && Math.abs(dy - 24) <= 2, `位移=(${dx},${dy}) 期望=(48,24)`);
  };

  const guardBefore = !!cfg.hideCaptured;

  /* ===== A：悬浮窗隐身 开->关->开 */
  if (!overlayWin.isVisible()) {
    overlayWin.showInactive();
    await sleep(700);
  }
  await clickConsole('#swStealth');
  ok('A1 隐身开关能隐藏悬浮窗', overlayWin.isVisible() === false, `visible=${overlayWin.isVisible()}`);

  // 显示前先把窗口挪离光标，否则兜底唤醒会立刻把它点亮，测不出「默认穿透」
  {
    const cur = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    let nx = cur.x + 260;
    if (nx + b.width > wa.x + wa.width) nx = Math.max(wa.x, cur.x - b.width - 260);
    overlayWin.setBounds({
      x: nx,
      y: Math.min(Math.max(cur.y - 220, wa.y), wa.y + wa.height - b.height),
      width: b.width,
      height: b.height,
    });
    await sleep(350);
  }
  await clickConsole('#swStealth');
  await sleep(700);
  ok('A2 隐身开关能重新显示', overlayWin.isVisible() === true, `visible=${overlayWin.isVisible()}`);

  let st = await sideState();
  ok('A3 显示后两边状态一致（穿透）', st.main === false && st.renderer === false, JSON.stringify(st));

  await warpOntoBar();
  st = await sideState();
  ok('A4 重新显示后光标压标题栏能唤醒', st.main === true && st.renderer === true, JSON.stringify(st));
  await dragCheck('A5');

  /* ===== B：屏幕防护「隐藏窗口」按钮 开->关 */
  await clickConsole('#btnGuard');
  await sleep(2200);
  await clickConsole('#btnGuard');
  await sleep(2200);

  st = await sideState();
  ok('B1 防护开关后两边状态一致', st.main === st.renderer, JSON.stringify(st));

  await warpOntoBar();
  st = await sideState();
  ok('B2 防护开关后仍能唤醒', st.main === true && st.renderer === true, JSON.stringify(st));
  await dragCheck('B3');

  /* ===== C：Ctrl+Shift+H 与设置栏开关同步 ===== */
  toggleOverlay();
  await sleep(700);
  const c1 = await cjs(`document.getElementById('swStealth').checked`);
  ok('C1 快捷键隐藏后，开关同步为「已隐身」', c1 === true, `swStealth.checked=${c1}`);
  toggleOverlay();
  await sleep(700);
  const c2 = await cjs(`document.getElementById('swStealth').checked`);
  ok('C2 快捷键显示后，开关同步为「未隐身」', c2 === false, `swStealth.checked=${c2}`);
  ok('C3 快捷键能恢复显示', overlayWin.isVisible() === true, `visible=${overlayWin.isVisible()}`);

  // 还原
  if (cfg.hideCaptured !== guardBefore) cfg = config.save({ hideCaptured: guardBefore });
  cfg = config.save({ overlayVisible: true });
  placeOverlay();
  broadcast('cfg:changed', cfg);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 窗口标题栏截图（--shotwindow） */
/** 截控制台窗口左上角，用来确认标题栏图标是否已去掉 */
async function runShotWindow() {
  await waitMs(2600);
  try {
    consoleWin.show();
    consoleWin.setAlwaysOnTop(true, 'screen-saver'); // 临时置顶，避免被其它窗口挡住截不到
    consoleWin.focus();
  } catch (_) {}
  await waitMs(1000);
  const b = consoleWin.getBounds();
  const s = await grabScreen();
  const sw = s.img.getSize().width;
  const dsp = screen.getPrimaryDisplay();
  console.log('[shotwindow] imgSize=', JSON.stringify(s.img.getSize()), 'display=', JSON.stringify(dsp.size), 'scale=', dsp.scaleFactor);
  const rect = {
    x: Math.max(0, Math.round(b.x)),
    y: Math.max(0, Math.round(b.y)),
    width: Math.min(320, Math.max(40, sw - Math.round(b.x))),
    height: 48,
  };
  const img = s.img.crop(rect);
  const out = path.join(ROOT, 'shots', 'titlebar.png');
  require('fs').writeFileSync(out, img.toPNG());
  console.log('[shotwindow] saved', out, JSON.stringify(rect), 'bounds', JSON.stringify(b));
  app.quit();
}

/* --------------------------------------------------- 手动提问诊断（--asktest） */
/**
 * 在输入框里发几句「陈述式」的内容（不含问号、原来会被 isQuestionLike 挡掉），
 * 检查是否真的触发了作答。这条路径以前是静默失败的。
 */
async function runAskTest() {
  const log = (...a) => console.log('[asktest]', ...a);
  await waitMs(3200);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  // 注意：executeJavaScript 的返回值必须可序列化，
  // window.api.on() 返回的是"取消订阅函数"，直接当返回值会报 object could not be cloned
  await js(`(() => {
    window.__starts = 0;
    if (!window.__askBound) {
      window.__askBound = 1;
      window.api.on('llm:start', () => { window.__starts++; });
    }
    return 1;
  })()`);

  const cases = [
    { q: '先做个自我介绍', tool: false },
    { q: '随便聊聊你做过什么', tool: false },
    { q: '你最大的缺点是什么', tool: false },
    // 输入框不只是"面试题入口"：问工具能力时要切到助手身份，而不是继续扮演候选人
    { q: '你能做什么', tool: true },
  ];
  for (const { q, tool } of cases) {
    const s0 = await js('window.__starts');
    await js(`window.api.ask(${JSON.stringify(q)})`);
    let got = false;
    for (let i = 0; i < 60; i++) {
      await waitMs(250);
      const s = await js('window.__starts');
      if (s > s0) {
        got = true;
        break;
      }
    }
    const shown = await js(`document.getElementById('question').textContent.trim()`);
    ok(`手动输入「${q}」触发回复`, got, `问题栏="${String(shown).slice(0, 18)}"`);
    if (got) {
      // 等这轮答完，避免下一轮被 abort
      for (let i = 0; i < 60; i++) {
        await waitMs(300);
        const streaming = await js(`document.getElementById('answer').classList.contains('streaming')`);
        if (!streaming) break;
      }
      if (tool) {
        const txt = await js(`document.getElementById('answer').textContent`);
        const isTool = /浮窗|悬浮窗|语音识别|实时听|作答草稿|JobAid/.test(txt);
        ok('问工具能力时以助手身份回答', isTool, `开局="${String(txt).slice(0, 24).replace(/\n/g, ' ')}"`);
      }
    }
  }

  const ansLen = await js(`document.getElementById('answer').textContent.trim().length`);
  ok('答案区有内容', ansLen > 20, `len=${ansLen}`);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 多知识库诊断（--profiletest） */
/**
 * 走真实 IPC 验证：新建 → 自动切换 → 资料隔离 → 索引隔离 → 改名 → 切回 → 删除。
 * 只操作临时库，不碰用户已有知识库。
 */
async function runProfileTest() {
  const log = (...a) => console.log('[profiletest]', ...a);
  await waitMs(3200);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };
  const list = async () => JSON.parse(await js(`window.api.listProfiles().then(r => JSON.stringify(r))`));
  const idxName = () =>
    projectIndex && projectIndex.cacheFile ? require('path').basename(projectIndex.cacheFile) : '';

  const l0 = await list();
  ok('初始至少有一个知识库', l0.items.length >= 1, `count=${l0.items.length}`);
  const origin = l0.items.find((p) => p.active) || l0.items[0];

  const created = JSON.parse(
    await js(`window.api.createProfile('临时测试库').then(r => JSON.stringify(r))`)
  );
  ok('能新建知识库', created.ok === true, JSON.stringify(created));

  await waitMs(700);
  const l1 = await list();
  ok('新建后数量 +1', l1.items.length === l0.items.length + 1, `${l0.items.length} -> ${l1.items.length}`);
  const cur1 = l1.items.find((p) => p.active);
  ok('新建后自动切到新库', !!cur1 && cur1.id === created.id, `active=${cur1 && cur1.name}`);
  ok(
    '新库资料是空的（与旧库隔离）',
    !!cur1 && cur1.resumeChars === 0 && !cur1.projectDir && cur1.jdChars === 0,
    JSON.stringify(cur1 && { r: cur1.resumeChars, d: cur1.projectDir, j: cur1.jdChars })
  );
  ok('索引文件按库隔离', idxName().includes(created.id), idxName());

  await js(`window.api.renameProfile(${JSON.stringify(created.id)}, '改名后的库')`);
  await waitMs(500);
  const l2 = await list();
  ok('能重命名', l2.items.some((p) => p.id === created.id && p.name === '改名后的库'));

  await js(`window.api.switchProfile(${JSON.stringify(origin.id)})`);
  await waitMs(800);
  const l3 = await list();
  const cur3 = l3.items.find((p) => p.active);
  ok('能切回原库', !!cur3 && cur3.id === origin.id, `active=${cur3 && cur3.name}`);
  ok(
    '切回后简历/项目恢复原值',
    !!cur3 && cur3.resumeChars === origin.resumeChars && cur3.projectDir === origin.projectDir,
    `${origin.resumeChars} vs ${cur3 && cur3.resumeChars}`
  );
  ok('切回后索引也跟着切', idxName().includes(origin.id), idxName());

  const del = JSON.parse(
    await js(`window.api.deleteProfile(${JSON.stringify(created.id)}).then(r => JSON.stringify(r))`)
  );
  ok('能删除知识库', del.ok === true, JSON.stringify(del));
  await waitMs(600);
  const l4 = await list();
  ok('删除后数量还原', l4.items.length === l0.items.length, `count=${l4.items.length}`);

  const chip = await js(`document.getElementById('kbPickName').textContent`);
  ok('输入卡显示当前库名', chip === origin.name, `chip="${chip}"`);
  const rows = await js(`document.querySelectorAll('#kbList .kb-item').length`);
  ok('知识库页列表已渲染', rows === l0.items.length, `rows=${rows}`);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 模型配置诊断（--modeltest） */
/**
 * 不依赖真实密钥，验证整条链路：目录结构、供应商增删、密钥留空沿用、删除后回退内置。
 */
async function runModelTest() {
  const log = (...a) => console.log('[modeltest]', ...a);
  await waitMs(3200);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };
  const cat = async () => JSON.parse(await js(`window.api.getModels().then(r => JSON.stringify(r))`));

  const c0 = await cat();
  ok(
    '目录结构正确（不再有内置通道）',
    !!c0 && Array.isArray(c0.providers) && Array.isArray(c0.presets) && !('builtin' in c0),
    JSON.stringify(Object.keys(c0 || {}))
  );
  const keys = (c0.presets || []).map((p) => p.key);
  ok(
    '预设覆盖五家厂商',
    ['deepseek', 'mimo', 'zhipu', 'minimax', 'kimi'].every((k) => keys.includes(k)),
    keys.join(',')
  );
  const before = c0.providers.length;

  const saved = JSON.parse(
    await js(`window.api.providerSave({ name: '自测供应商', baseUrl: 'http://127.0.0.1:59999/v1', apiKey: 'sk-test', models: 'test-a, test-b' }).then(r => JSON.stringify(r))`)
  );
  ok('能保存供应商', saved.ok === true, JSON.stringify(saved));

  await waitMs(500);
  const c1 = await cat();
  ok('供应商数量 +1', c1.providers.length === before + 1, `${before} -> ${c1.providers.length}`);
  const pv = c1.providers.find((p) => p.id === saved.id);
  ok('模型名被正确拆分', !!pv && pv.models.length === 2 && pv.models[1].id === 'test-b', JSON.stringify(pv && pv.models));
  ok('目录不回传密钥（只给 hasKey）', !!pv && pv.hasKey === true && !('apiKey' in pv), JSON.stringify(pv));

  // 空密钥编辑应沿用原密钥
  await js(`window.api.providerSave({ id: ${JSON.stringify(saved.id)}, name: '自测供应商', baseUrl: 'http://127.0.0.1:59999/v1', apiKey: '', models: 'test-a' })`);
  const raw = config.load().customProviders.find((x) => x.id === saved.id);
  ok('留空密钥时沿用已保存的密钥', raw && raw.apiKey === 'sk-test', raw && raw.apiKey);

  // 选中它
  await js(`window.api.modelSelect({ kind: 'custom', providerId: ${JSON.stringify(saved.id)}, model: 'test-a' })`);
  await waitMs(400);
  const c2 = await cat();
  ok('能选中自定义模型', c2.active && c2.active.kind === 'custom' && c2.active.model === 'test-a', JSON.stringify(c2.active));

  // 连不上的地址应该给出明确失败，而不是卡住
  const t = JSON.parse(
    await js(`window.api.providerTest({ id: ${JSON.stringify(saved.id)}, baseUrl: 'http://127.0.0.1:59999/v1', models: ['test-a'] }).then(r => JSON.stringify(r))`)
  );
  ok('测试连接能如实报错', t.ok === false && !!t.error, String(t.error).slice(0, 50));

  // 删除正在用的供应商 → 应回退内置
  await js(`window.api.providerDelete(${JSON.stringify(saved.id)})`);
  await waitMs(500);
  const c3 = await cat();
  ok('删除后数量还原', c3.providers.length === before, `count=${c3.providers.length}`);
  // 没有内置通道可回退：要么落到剩下的供应商，要么为空并提示去配置
  ok(
    '删除当前供应商后不会留下无效选择',
    !c3.active || c3.providers.some((p) => p.id === c3.active.providerId),
    JSON.stringify(c3.active)
  );

  // 一个模型都没配时，作答必须给出明确的指引，而不是空屏或莫名报错
  if (!c3.providers.length) {
    await js(`window.api.ask('先做个自我介绍')`);
    await waitMs(2500);
    const errText = await js(`document.getElementById('answer').textContent`);
    ok('未配置模型时提示去配置', /配置模型|模型.*页/.test(String(errText)), String(errText).slice(0, 40));
  }

  const opts = await js(`document.querySelectorAll('#selModel option').length`);
  ok('模型下拉已渲染选项', opts > 0, `options=${opts}`);
  const panels = await js(`!!document.getElementById('panel-models')`);
  ok('模型页已存在', panels === true);

  // 表单：点「添加供应商」应展开，四个字段都在
  await js(`document.querySelector('[data-panel=models]').click(); document.getElementById('btnProvAdd').click();`);
  await waitMs(300);
  const formOpen = await js(`!document.getElementById('provForm').hidden`);
  ok('点添加后表单展开', formOpen === true);
  const fields = await js(`['pvName','pvUrl','pvKey','pvModels'].every(id => !!document.getElementById(id))`);
  ok('表单字段齐全', fields === true);
  const presetCount = await js(`document.querySelectorAll('#pvPreset option').length`);
  ok('厂商预设下拉有选项', presetCount >= 5, 'options=' + presetCount);
  const pvUrl = await js(`document.getElementById('pvUrl').value`);
  ok('选预设后自动填好地址', String(pvUrl).startsWith('http'), pvUrl);
  await js(`document.getElementById('btnProvCancel').click();`);
  await waitMs(200);
  const formClosed = await js(`document.getElementById('provForm').hidden`);
  ok('点取消后表单收起', formClosed === true);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 设置页诊断（--settingstest） */
async function runSettingsTest() {
  const log = (...a) => console.log('[settingstest]', ...a);
  await waitMs(3000);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  const navText = () => js(`[...document.querySelectorAll('.nav-item span')].map(s=>s.textContent).join(',')`);

  ok('设置页存在', (await js(`!!document.getElementById('panel-settings')`)) === true);
  ok('左侧栏有设置入口', (await js(`!!document.querySelector('[data-panel=settings]')`)) === true);

  // 语言：英文
  await js(`document.getElementById('selLang').value='en'; document.getElementById('selLang').onchange();`);
  await waitMs(400);
  const en = await navText();
  ok('切英文后导航变为英文', /Settings/.test(en) && /Models/.test(en), en);

  // 日语
  await js(`document.getElementById('selLang').value='ja'; document.getElementById('selLang').onchange();`);
  await waitMs(400);
  const ja = await navText();
  ok('切日语后导航变为日文', /設定/.test(ja) && /モデル/.test(ja), ja);

  // 德语（验证非拉丁/非亚语的兜底也正常）
  await js(`document.getElementById('selLang').value='de'; document.getElementById('selLang').onchange();`);
  await waitMs(400);
  const de = await navText();
  ok('切德语后导航变为德文', /Einstellungen/.test(de), de);

  // 字体大小
  await js(`document.querySelector('#segFont [data-v="1.2"]').click()`);
  await waitMs(300);
  const zoom = await js(`document.documentElement.style.zoom`);
  ok('字体特大生效', String(zoom) === '1.2', `zoom=${zoom}`);
  await js(`document.querySelector('#segFont [data-v="1"]').click()`);
  await waitMs(200);

  // 主题
  await js(`document.querySelector('#segUiTheme [data-v="dark"]').click()`);
  await waitMs(300);
  const theme = await js(`document.documentElement.dataset.theme`);
  const bodyBg = await js(`getComputedStyle(document.body).backgroundColor`);
  ok('深色主题生效', theme === 'dark', `theme=${theme}`);
  ok('深色下背景变暗', /rgb\(2[0-9], 2[0-9], 2[0-9]\)|rgb\(1[0-9], 1[0-9], 1[0-9]\)/.test(String(bodyBg)), bodyBg);
  await js(`document.querySelector('#segUiTheme [data-v="light"]').click()`);
  await waitMs(200);

  // 恢复中文
  await js(`document.getElementById('selLang').value='zh-CN'; document.getElementById('selLang').onchange();`);
  await waitMs(300);
  const zh = await navText();
  ok('能切回简体中文', /设置/.test(zh), zh);

  // 界面透明度：滑块 -> 主进程真正改了窗口透明度
  await js(`document.getElementById('rgUiOpacity').value='60'; document.getElementById('rgUiOpacity').oninput();`);
  await waitMs(500);
  const op = consoleWin.getOpacity();
  // 放大字号后，底部内容不能被挤出窗口（CSS zoom 老问题）
  for (const scale of ['1.1', '1.2']) {
    await js(`window.api.setConfig({ uiScale: ${scale} })`);
    await waitMs(500);
    const box = JSON.parse(
      await js(`(() => {
        const c = document.querySelector('.composer');
        const r = c.getBoundingClientRect();
        const app = document.querySelector('.app').getBoundingClientRect();
        return JSON.stringify({ bottom: Math.round(r.bottom), right: Math.round(r.right), innerH: window.innerHeight, innerW: window.innerWidth, appH: Math.round(app.height), appW: Math.round(app.width) });
      })()`)
    );
    ok(`字号 ${scale} 时输入框仍在窗口内`, box.bottom <= box.innerH + 2, JSON.stringify(box));
    ok(`字号 ${scale} 时页面不超出窗口宽度`, box.appW <= box.innerW + 2, `appW=${box.appW} innerW=${box.innerW}`);
  }
  // 内容比窗口高时必须能滚到底，不能把底部栏位吞掉
  for (const scale of ['1', '1.2']) {
    await js(`window.api.setConfig({ uiScale: ${scale} })`);
    await waitMs(400);
    const rail = JSON.parse(
      await js(`(() => {
        const r = document.querySelector('.rail');
        const last = r.lastElementChild;
        r.scrollTop = r.scrollHeight;
        const lb = last.getBoundingClientRect();
        const rb = r.getBoundingClientRect();
        return JSON.stringify({
          needScroll: r.scrollHeight > r.clientHeight + 1,
          lastBottom: Math.round(lb.bottom),
          railBottom: Math.round(rb.bottom),
          lastText: (last.textContent || '').trim().slice(0, 8),
        });
      })()`)
    );
    ok(`字号 ${scale} 时右侧栏能滚到最后一项`, rail.lastBottom <= rail.railBottom + 2, JSON.stringify(rail));
  }

  await js(`window.api.setConfig({ uiScale: 1 })`);
  await waitMs(300);

  ok('界面透明度生效', Math.abs(op - 0.6) < 0.02, 'opacity=' + op);
  const label = await js(`document.getElementById('valUiOpacity').textContent`);
  ok('透明度百分比同步', label === '60%', label);
  await js(`document.getElementById('rgUiOpacity').value='100'; document.getElementById('rgUiOpacity').oninput();`);
  await waitMs(300);
  ok('退出入口存在', (await js(`!!document.getElementById('btnQuitApp')`)) === true);

  // 字体/主题/语言要落盘
  const saved = config.load();
  ok('设置已持久化', saved.uiScale === 1 && saved.uiTheme === 'light' && saved.lang === 'zh-CN' && saved.uiOpacity === 1, JSON.stringify({
    uiOpacity: saved.uiOpacity,
    uiScale: saved.uiScale,
    uiTheme: saved.uiTheme,
    lang: saved.lang,
  }));

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 托盘/后台诊断（--traytest） */
async function runTrayTest() {
  const log = (...a) => console.log('[traytest]', ...a);
  await waitMs(3000);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  ok('托盘已创建', !!tray, tray ? 'yes' : 'no');
  ok('托盘图标非空', !!tray && !tray.isDestroyed());

  const before = consoleWin.isVisible();
  ok('测试前窗口可见', before === true);

  // 走真实的关闭路径：应当隐藏窗口而不是退出进程
  consoleWin.close();
  await waitMs(800);
  ok('关窗后进程仍存活', !quitting);
  ok('关窗后窗口被隐藏', !consoleWin.isVisible(), `visible=${consoleWin.isVisible()}`);
  ok('窗口对象未被销毁', !!consoleWin && !consoleWin.isDestroyed());

  // 从这里开始 webContents 还活着，但窗口隐藏了，页面脚本仍可执行
  const bodyAlive = await js('1 + 1');
  ok('隐藏后页面仍可通信', bodyAlive === 2);

  // 从托盘恢复
  showConsole();
  await waitMs(600);
  ok('能从托盘恢复窗口', consoleWin.isVisible() === true);

  // 双击托盘等价于 showConsole，这里只验证函数可用
  // 完全隐身：开关一开就该生效，不用等下次隐藏
  cfg = config.save({ fullStealth: true });
  enterStealth(true);
  await waitMs(300);
  ok('打开开关后窗口退出任务栏', (() => { const b = consoleWin.getSkipTaskbar ? consoleWin.getSkipTaskbar() : null; return b === true || b === null; })(), String(consoleWin.getSkipTaskbar ? consoleWin.getSkipTaskbar() : 'n/a'));
  ok('打开开关后托盘立即消失', !tray, tray ? 'still there' : 'removed');
  cfg = config.save({ fullStealth: false });
  exitStealth();
  await waitMs(300);
  ok('关闭开关后托盘立即恢复', !!tray);

  // 完全隐身：托盘图标也要消失，快捷键能找回
  cfg = config.save({ fullStealth: true });
  consoleWin.close();
  await waitMs(700);
  ok('完全隐身时托盘图标被移除', !tray, tray ? 'still there' : 'removed');
  showConsole();
  await waitMs(700);
  ok('找回后托盘图标重建', !!tray);
  cfg = config.save({ fullStealth: false });

  ok('showConsole 可重复调用', (() => {
    showConsole();
    return consoleWin.isVisible();
  })() === true);

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 面经导出诊断（--exporttest） */
async function runExportTest() {
  const log = (...a) => console.log('[exporttest]', ...a);
  await waitMs(3000);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  const fsx = require('fs');
  const osx = require('os');
  const tmpDir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'jobaid-export-'));
  const t0 = Date.now() - 60000;

  // 造一份和真实结构一致的数据
  sessions.cur.qa = [
    { question: '先做个自我介绍', answer: '我是张三，做嵌入式软件。', ts: t0 },
    { question: '你最大的困难是什么', answer: '在麦轮机器人里解决任务阻塞。', ts: t0 + 20000 },
  ];
  sessions.cur.transcript = [
    { channel: 'interviewer', text: '先做个自我介绍', ts: t0 },
    { channel: 'me', text: '面试官您好，我是张三，主要做嵌入式。', ts: t0 + 8000 },
    { channel: 'interviewer', text: '你最大的困难是什么', ts: t0 + 20000 },
    { channel: 'me', text: '最难的是多任务抢同一个资源。', ts: t0 + 26000 },
  ];

  const md = buildInterviewMarkdown(sessions.cur);
  ok('总结含三个部分', /一、面试官提问/.test(md) && /二、AI 建议回答/.test(md) && /三、我的实际回答/.test(md));
  ok('包含面试官问题', md.includes('先做个自我介绍'));
  ok('包含 AI 回答', md.includes('我是张三，做嵌入式软件'));
  ok('包含求职者口头回答', md.includes('面试官您好，我是张三'));

  const pairs = buildInterviewPairs(sessions.cur);
  ok('问答按时间正确配对', pairs.length === 2 && pairs[0].mine.includes('主要做嵌入式'), `pairs=${pairs.length}`);

  const rMd = await exportInterview('md', path.join(tmpDir, 't.md'));
  ok('导出 Markdown 成功', rMd.ok === true, rMd.error || '');
  const mdText = rMd.ok ? fsx.readFileSync(rMd.path, 'utf8') : '';
  ok('Markdown 文件有内容', mdText.length > 100, `len=${mdText.length}`);

  const rDoc = await exportInterview('doc', path.join(tmpDir, 't.doc'));
  ok('导出 Word 成功', rDoc.ok === true, rDoc.error || '');
  const docText = rDoc.ok ? fsx.readFileSync(rDoc.path, 'utf8') : '';
  ok('Word 是合法 HTML', /<html/i.test(docText) && /<h2>/i.test(docText), `len=${docText.length}`);

  const rPdf = await exportInterview('pdf', path.join(tmpDir, 't.pdf'));
  ok('导出 PDF 成功', rPdf.ok === true, rPdf.error || '');
  if (rPdf.ok) {
    const buf = fsx.readFileSync(rPdf.path);
    ok('PDF 文件头正确', buf.slice(0, 4).toString() === '%PDF', `size=${buf.length}`);
    ok('PDF 不是空文件', buf.length > 1024, `${buf.length} bytes`);
  }

  // 空会话应当拒绝导出，而不是写出一个空文件
  const backup = sessions.cur;
  sessions.cur = { id: 'tmp', startedAt: Date.now(), qa: [], transcript: [] };
  const rEmpty = await exportInterview('md', path.join(tmpDir, 'empty.md'));
  ok('空会话拒绝导出', rEmpty.ok === false && rEmpty.error === '面试内容不存在', rEmpty.error || '');
  sessions.cur = backup;

  try {
    fsx.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 模拟面试诊断（--mocktest） */
async function runMockTest() {  const log = (...a) => console.log('[mocktest]', ...a);
  await waitMs(3000);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  // 当前库可能没简历：先验证这种库会被拦下，再切到有简历的库继续
  const originId = cfg.activeProfileId;
  const list = config.load().profiles || [];
  const emptyOne = list.find((p) => !(p.resumeText || '').trim());
  if (emptyOne && emptyOne.id === originId) {
    let blocked = false;
    try {
      await mockStart(3);
    } catch (e) {
      blocked = /简历/.test(e.message || '');
    }
    ok('没有简历的知识库给出明确提示', blocked === true);
  }

  const withResume = list.find((p) => (p.resumeText || '').length > 200);
  if (!withResume) {
    log('没有含简历的知识库，跳过后续');
    log(`汇总：${pass}/${pass + fail} 通过`);
    app.quit();
    return;
  }
  config.switchProfile(withResume.id);
  cfg = config.load();

  // 出题（技术面试 / 文字作答）
  const st0 = await mockStart({ count: 3, type: 'tech', mode: 'text' });
  ok('能基于简历出题', st0.active === true && st0.total >= 3, `total=${st0.total}`);
  ok('题目不像空串', (st0.question || '').length > 5, (st0.question || '').slice(0, 24));
  ok('模式与类型已记录', st0.mode === 'text' && st0.type === 'tech', `${st0.mode}/${st0.type}`);
  log('  第一题：' + st0.question);

  const answer =
    '我在麦轮机器人项目里负责底盘控制，用 STM32F407 加 FreeRTOS 把控制周期做到 100Hz。' +
    '遇到的主要问题是显示任务长时间持有 LCD 互斥量，阻塞了控制任务。我的做法是把资源映射表按阶段拆锁，' +
    '配合优先级继承和取锁超时，改完之后底盘周期稳定了，也顺带理清了欠压时的 PWM 封锁逻辑。';

  // 界面：答题框宽度跟随容器，只能纵向拉伸
  await waitMs(900);
  const ui = JSON.parse(
    await js(`(()=>{const ta=document.getElementById('mockAnswer');const run=document.getElementById('mockRun');
      const cs=getComputedStyle(ta);const wa=ta.getBoundingClientRect();const wp=ta.parentElement.getBoundingClientRect();
      return JSON.stringify({runHidden:run.hidden, resize:cs.resize, w:Math.round(wa.width), pw:Math.round(wp.width)});})()`)
  );
  ok('答题区已显示', ui.runHidden === false, JSON.stringify(ui));
  ok('答题框只能纵向拉伸', ui.resize === 'vertical', ui.resize);
  ok('答题框宽度贴合容器', Math.abs(ui.w - ui.pw) < 2, `${ui.w} vs ${ui.pw}`);

  // 草稿：存了不评分，可以来回切题
  mockSaveAnswer(0, answer);
  const draftState = mockSnapshot();
  ok('草稿已保存', draftState.items[0].a === answer, `len=${(draftState.items[0].a || '').length}`);
  ok('存草稿不会提前评分', draftState.items[0].score == null, String(draftState.items[0].score));

  mockSaveAnswer(1, answer);
  mockSaveAnswer(2, answer);

  // 切题不丢草稿
  mockGoto(1);
  const back = mockGoto(0);
  ok('切题后草稿仍在', back.draft === answer, `len=${(back.draft || '').length}`);

  // 统一提交：逐题评分 + 汇总
  const st = await mockFinish();
  ok('提交后进入结束态', st.done === true, `index=${st.index}/${st.total}`);
  const scored = st.items.every((x) => x.score != null);
  ok('每题都有评分', scored, st.items.map((x) => x.score).join(','));
  ok('每题四维齐全', st.items.every((x) => x.dims && ['depth', 'clarity', 'structure', 'match'].every((k) => typeof x.dims[k] === 'number')), JSON.stringify(st.items[0].dims));
  ok('生成了总评报告', !!st.report, st.report ? `total=${st.report.total}` : 'null');

  if (st.report) {
    ok('报告有总分', typeof st.report.total === 'number' && st.report.total > 0, String(st.report.total));
    ok('报告有能力维度', !!st.report.dims, JSON.stringify(st.report.dims));
    ok('报告有强项', Array.isArray(st.report.strengths) && st.report.strengths.length > 0, JSON.stringify(st.report.strengths).slice(0, 60));
    ok('报告有薄弱项', Array.isArray(st.report.weaknesses) && st.report.weaknesses.length > 0, JSON.stringify(st.report.weaknesses).slice(0, 60));
    ok('报告有改进建议', Array.isArray(st.report.advice) && st.report.advice.length > 0, JSON.stringify(st.report.advice).slice(0, 60));
    log('  定位：' + st.report.level);
  }

  const md = buildMockMarkdown(mockRun);
  ok('报告可导出为 Markdown', /# 模拟面试报告/.test(md) && /## 逐题记录/.test(md) && md.length > 200, `len=${md.length}`);

  // 实时模式（语音面试）：先出 1 题，答完现场生成下一题
  const rt = await mockStart({ count: 3, type: 'tech', mode: 'voice' });
  ok('实时模式只先出第一题', rt.items.length === 1 && rt.total === 3, `items=${rt.items.length} total=${rt.total}`);
  ok('实时模式标记正确', rt.realtime === true, String(rt.realtime));
  mockSaveAnswer(0, answer);
  const rt2 = await mockNextQuestion();
  ok('答完后现场生成下一题', rt2.items.length === 2 && rt2.index === 1, `items=${rt2.items.length} idx=${rt2.index}`);
  ok('新题与上一题不同', rt2.items[1].q !== rt2.items[0].q, rt2.items[1].q.slice(0, 28));
  log('  追问：' + rt2.items[1].q);

  // 提前交卷：答一题就结束，只算已答的
  await mockStart({ count: 5, type: 'tech', mode: 'text' });
  mockSaveAnswer(0, answer);
  const pre = await mockFinish({ partial: true });
  ok('提前交卷只算已答的题', pre.total === 1 && pre.done === true, `total=${pre.total}`);
  ok('提前交卷也出报告', !!pre.report && typeof pre.report.total === 'number', pre.report ? String(pre.report.total) : 'null');
  ok('答题区有退出按钮', (await js(`!!document.getElementById('btnMockEnd')`)) === true);

  // 语音：真实请求一次神经语音，确认拿得到音频
  const tts = await synthSpeech('你好，请先做个自我介绍。', 'zh-CN-XiaoxiaoNeural');
  ok('神经语音能生成音频', tts.ok === true && tts.audio.length > 2000, `base64=${(tts.audio || '').length}`);

  // 关键：渲染层能不能真的播出来。播不出来会静默退回系统女声，听起来所有音色一模一样
  const playRes = await js(`(async () => {
    try {
      const bin = atob(${JSON.stringify(tts.audio)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(bytes.buffer);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      const dur = buf.duration;
      src.stop();
      await ctx.close();
      return 'ok:' + Math.round(dur * 10) / 10 + 's';
    } catch (e) {
      return 'ERR:' + (e && e.name ? e.name : e);
    }
  })()`);
  ok('渲染层能解码并播放合成音频', String(playRes).startsWith('ok:'), String(playRes));

  // 题量自定义
  const c7 = await mockStart({ count: 7, type: 'hr', mode: 'text' });
  ok('支持自定义题量', c7.total === 7, `total=${c7.total}`);
  ok('题量下限被夹住', (await mockStart({ count: 1, type: 'hr', mode: 'text' })).total === 2, 'min=2');

  // 校验输入防护：一条都没填时提交要报错
  mockRun = {
    startedAt: Date.now(), type: 'tech', mode: 'text', idx: 0, finished: false, scoring: null,
    items: [{ q: '测试题', a: '', score: null, dims: null, comment: '', better: '' }], report: null,
  };
  let rejected = '';
  try {
    await mockFinish();
  } catch (e) {
    rejected = e.message || 'error';
  }
  ok('一条都没填时提交被拒绝', /没有填写/.test(rejected), rejected);

  mockRun = null;
  config.switchProfile(originId);
  cfg = config.load();
  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 全屏截图诊断（--screencap） */
async function runScreenCap() {
  await waitMs(2500);
  showConsole();
  try {
    consoleWin.setSkipTaskbar(false);
  } catch (_) {}
  await waitMs(1500);
  try {
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (!srcs.length) {
      console.log('[screencap] 没有拿到屏幕源');
    } else {
      const png = srcs[0].thumbnail.toPNG();
      const out = require('path').join(__dirname, '..', '..', 'shots', 'screen.png');
      require('fs').writeFileSync(out, png);
      console.log('[screencap] 已保存', out, png.length, 'bytes');
    }
  } catch (e) {
    console.log('[screencap] 失败', e.message);
  }
  app.quit();
}

/* --------------------------------------------------- 托盘状态探针（--trayprobe） */
async function runTrayProbe() {
  await waitMs(2500);
  const log = (...a) => console.log('[trayprobe]', ...a);
  log('fullStealth =', cfg.fullStealth);
  log('tray 对象 =', tray ? '存在' : '不存在');
  log('任务栏按钮被隐藏 =', '已设置');
  log('屏幕最底层区域检查：进程托盘图标由系统管理，进程侧只能确认对象状态');
  app.quit();
}

/* --------------------------------------------------- 语音链路诊断（--voicetest） */
async function runVoiceTest() {
  const log = (...a) => console.log('[voicetest]', ...a);
  await waitMs(3000);
  const js = (code) => consoleWin.webContents.executeJavaScript(code);
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra) => {
    cond ? pass++ : fail++;
    log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra != null ? ' | ' + extra : ''}`);
  };

  // 1) 识别模型能起来
  const st = await ensureAsr();
  ok('识别模型能启动', !!st && st.ready === true, JSON.stringify(st));

  // 2) 模拟面试的音频不会被入口丢掉（这条之前是致命 bug）
  mockMicActive = true;
  listening = false;
  const before = transcript.length;
  await handleUtterance({ channel: 'me', samples: new Float32Array(1600).buffer, sampleRate: 16000 });
  ok('模拟面试音频能进识别流程', true, '未因 listening=false 提前返回');

  // 3) 端到端：合成一段真人语音 → 解码成 PCM → 走真实 sendUtterance 链路
  const tts = await synthSpeech('你好，我叫张明，之前做过嵌入式软件开发。', 'zh-CN-XiaoxiaoNeural');
  ok('能合成测试语音', !!tts && tts.ok === true, tts ? 'base64=' + tts.audio.length : 'null');

  if (tts && tts.ok) {
    const sent = await js(`(async () => {
      const bin = atob(${JSON.stringify(tts.audio)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(arr.buffer);
      const chs = buf.numberOfChannels;
      const len = buf.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < chs; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i] / chs;
      }
      const rate = 16000;
      const ratio = buf.sampleRate / rate;
      const outLen = Math.floor(len / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const p = i * ratio;
        const i0 = Math.floor(p);
        const i1 = Math.min(len - 1, i0 + 1);
        const f = p - i0;
        out[i] = mono[i0] * (1 - f) + mono[i1] * f;
      }
      await ctx.close();
      window.api.sendUtterance({ channel: 'me', samples: out.buffer, sampleRate: rate });
      return outLen;
    })()`);
    ok('音频已送入识别链路', Number(sent) > 0, `samples=${sent}`);

    await waitMs(6000); // 等识别出结果
    const added = transcript.length - before;
    ok('语音能被识别成文字', added > 0, `新增 ${added} 条`);
    if (added > 0) {
      const last = transcript[transcript.length - 1];
      log('  识别结果：' + last.text);
      ok('识别结果包含中文', /[\u4e00-\u9fa5]/.test(last.text || ''), last.text);
    } else {
      ok('识别结果包含中文', false, '没有产生任何文本');
    }
  }

  // 4) 前端：通话模式下语音要即时上屏
  const ui = JSON.parse(
    await js(`(() => {
      const box = document.getElementById('callStream');
      const before = box ? box.children.length : -1;
      if (window.__mockProbe) window.__mockProbe();
      return JSON.stringify({ exists: !!box, before });
    })()`)
  );
  ok('通话对话流存在', ui.exists === true, JSON.stringify(ui));

  mockMicActive = false;
  log(`汇总：${pass}/${pass + fail} 通过`);
  app.quit();
}

/* --------------------------------------------------- 端到端自测模式 */

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSelfTest() {
  const log = (...a) => console.log('[selftest]', ...a);
  await waitMs(3000);

  log('① 让控制台开始监听');
  const started = await consoleWin.webContents.executeJavaScript(
    '(async()=>{ try{ await toggleListening(); return "ok" }catch(e){ return "err:"+e.message } })()'
  );
  log('   ->', started);
  await waitMs(2000);

  log('② 播放测试语音（经扬声器 → 回环采到，等同"面试官说话"）');
  const wav = 'file:///' + path.join(ROOT, 'models', 'test_zh.wav').replace(/\\/g, '/');
  const play = await consoleWin.webContents.executeJavaScript(
    `(function(){ const a=document.createElement('audio'); a.src=${JSON.stringify(wav)}; a.style.display='none'; document.body.appendChild(a); return a.play().then(()=>'ok').catch(e=>'err:'+e.message); })()`
  );
  log('   ->', play);
  await waitMs(10000);

  log('③ 转录结果：' + transcript.length + ' 条');
  transcript.forEach((t) => log('    [' + t.channel + '] ' + t.text));

  log('④ 注入一句提问，验证 判定→模型→悬浮窗');
  dispatchText('interviewer', '你在项目里是怎么处理高并发下单的？');
  await waitMs(12000);
  const txt = await overlayWin.webContents
    .executeJavaScript('document.getElementById("a").innerText')
    .catch((e) => 'ERR ' + e.message);
  log('   悬浮窗内容：' + JSON.stringify(String(txt).slice(0, 180)));
  const steps = await consoleWin.webContents
    .executeJavaScript(
      'JSON.stringify({cls:document.getElementById("steps").className, text:document.getElementById("steps").textContent, disp:getComputedStyle(document.getElementById("steps")).display})'
    )
    .catch((e) => 'ERR ' + e.message);
  log('   思考过程：' + steps);

  // ⑤ 在悬浮窗背后放一个持续动画的窗口，验证自检不会误报
  log('⑤ 背景动画场景下的防护自检（防误报）');
  const ob = overlayWin.getBounds();
  const bg = new BrowserWindow({
    x: ob.x,
    y: ob.y,
    width: ob.width,
    height: ob.height,
    frame: false,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  await bg.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="margin:0;background:#123"><canvas id=c width=460 height=600></canvas>' +
          '<script>const x=document.getElementById("c").getContext("2d");let t=0;' +
          'setInterval(()=>{t+=0.15;x.fillStyle="#123";x.fillRect(0,0,460,600);' +
          'for(let i=0;i<40;i++){x.fillStyle="hsl("+((i*9+t*40)%360)+",70%,55%)";' +
          'x.beginPath();x.arc(230+90*Math.cos(t+i),300+90*Math.sin(t+i*1.3),26,0,7);x.fill();}},33);' +
          '</scr' + 'ipt></body>'
      )
  );
  bg.showInactive();
  await waitMs(800);
  bg.hide(); // 这条测试窗口本身会盖住悬浮窗，测之前先藏起来
  await waitMs(300);
  // 测试机制本身，临时强制开启防护（用户可能手动关掉了）
  const prevHide = cfg.hideCaptured;
  cfg.hideCaptured = true;
  applyCaptureProtection();
  const r5 = await runProtectionSelfTest(true);
  cfg.hideCaptured = prevHide;
  applyCaptureProtection();
  log('   结果：ok=' + r5.ok + ' reason=' + r5.reason + ' 差异=' + (r5.ratio != null ? (r5.ratio * 100).toFixed(1) + '%' : 'n/a'));
  log(r5.ok === false ? '   ✗ 误报了（不该出现）' : '   ✓ 未误报，实际防护正常');
  bg.destroy();

  log('完成');
}

/* --------------------------------------------------------------- 托盘 */

function makeTrayIcon() {
  // 任务栏图标要能在深浅两种主题下都看得清：
  // 原来的 tray.png 是黑底方块，Windows 深色任务栏上几乎糊成一团。
  // 这里改成透明底 + 白描边 + 深色字，两种主题都有对比。
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const size = 32;
    const cv = createCanvas(size, size);
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.font = 'bold 26px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText('J', 15, 18);
    ctx.fillStyle = '#17171c';
    ctx.fillText('J', 15, 18);
    ctx.beginPath();
    ctx.arc(26, 8, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#22C58B';
    ctx.fill();
    const img = nativeImage.createFromBuffer(cv.toBuffer('image/png'));
    if (!img.isEmpty()) return img;
  } catch (e) {
    console.error('[tray] 生成图标失败，回退到 tray.png', e.message);
  }

  // 回退：用打包进 asar 的现成图标
  try {
    const p = path.join(__dirname, '..', 'renderer', 'assets', 'tray.png');
    const img = nativeImage.createFromBuffer(require('fs').readFileSync(p));
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch (_) {}

  // 兜底：程序化画一枚 16×16 的 J
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 7.4) put(x, y, 23, 25, 32, 255); // 深色底
    }
  }
  // 竖笔
  for (let y = 4; y <= 9; y++) for (let x = 9; x <= 11; x++) put(x, y, 255, 255, 255, 255);
  // 顶部横笔
  for (let x = 5; x <= 11; x++) for (let y = 4; y <= 5; y++) put(x, y, 255, 255, 255, 255);
  // 钩
  for (let x = 5; x <= 9; x++) for (let y = 10; y <= 11; y++) put(x, y, 255, 255, 255, 255);
  put(5, 9, 255, 255, 255, 255);
  // 指示灯
  put(13, 8, 34, 197, 139, 255);
  put(12, 8, 34, 197, 139, 255);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/** 控制台窗口透明度：只影响这个窗口，不影响悬浮窗（那个走 overlayOpacity） */
function applyConsoleOpacity() {
  if (!consoleWin || consoleWin.isDestroyed()) return;
  const v = typeof cfg.uiOpacity === 'number' ? cfg.uiOpacity : 1;
  const clamped = Math.min(1, Math.max(0.3, v));
  try {
    consoleWin.setOpacity(clamped);
  } catch (_) {}
}

let stealthTrayRemoved = false;

/** 完全隐身：连托盘图标都不留，只能靠 Ctrl+Shift+O 找回 */
function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (_) {}
  tray = null;
}

function enterStealth(silent) {
  if (!cfg.fullStealth) return;
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.setSkipTaskbar(true);
  } catch (_) {}
  if (tray) {
    destroyTray();
    stealthTrayRemoved = true;
  }
  if (!silent) notifyStealth();
}

function exitStealth() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.setSkipTaskbar(false);
  } catch (_) {}
  if (!stealthTrayRemoved) return;
  stealthTrayRemoved = false;
  // 刚 destroy 完立刻 new Tray 在 Windows 上偶尔会失败，隔一帧再建
  setTimeout(() => {
    if (!tray) buildTray();
  }, 160);
}

/** 托盘没了就没法气泡提示，改用系统通知说清怎么找回 */
function notifyStealth() {
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'JobAid 已完全隐身',
      body: '任务栏和托盘都不再显示。按 Ctrl+Shift+O 随时找回控制台。',
      silent: true,
    }).show();
  } catch (_) {}
}

let trayHinted = false;
/**
 * 关窗只是隐藏到托盘。Windows 会把新图标折叠进「^」里，
 * 用户找不到入口会以为程序没退出或者卡死了 —— 第一次关窗时提示一次。
 */
function hintTrayOnce() {
  if (trayHinted || !tray) return;
  trayHinted = true;
  try {
    tray.displayBalloon({
      title: 'JobAid 仍在后台运行',
      content: '窗口已收起。点右下角托盘图标重新打开，或按 Ctrl+Shift+O。',
      iconType: 'info',
    });
  } catch (_) {
    // 系统不支持气泡提示就算了，不打扰
  }
}

function buildTray() {
  try {
    tray = new Tray(makeTrayIcon());
  } catch (_) {
    return;
  }
  tray.setToolTip('JobAid · 单击打开控制台');
  tray.on('double-click', () => showConsole());
  const refresh = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: listening ? '⏸  暂停监听' : '▶  开始监听', click: () => setListening(!listening) },
        {
          label: '悬浮窗显示',
          type: 'checkbox',
          checked: !!(overlayWin && overlayWin.isVisible()),
          click: () => toggleOverlay(),
        },
        { type: 'separator' },
        { label: '打开控制台', click: () => showConsole() },
        {
          label: '复位悬浮窗位置',
          click: () => {
            cfg = config.save({ overlayPos: null, overlayAutoHeight: true, overlayHeight: null });
            placeOverlay();
            broadcast('cfg:changed', cfg);
            broadcast('overlay:cfg', {
              opacity: cfg.overlayOpacity,
              theme: cfg.overlayTheme,
              width: cfg.overlayWidth,
              autoHeight: true,
              maxed: overlayMaxed,
            });
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  };
  refresh();
  tray.on('click', () => showConsole());
  tray.refreshMenu = refresh;
}

function refreshTray() {
  if (tray && tray.refreshMenu) tray.refreshMenu();
}

/* ----------------------------------------------------------- 行为控制 */

function showConsole() {
  if (!consoleWin || consoleWin.isDestroyed()) createConsoleWindow();
  if (consoleWin.isMinimized()) consoleWin.restore();
  consoleWin.show();
  consoleWin.focus();
  consoleWin.moveTop();
}

function toggleOverlay() {
  if (!overlayWin) return;
  // 必须把状态写回配置：设置栏的「悬浮窗隐身」开关靠 cfg:changed 同步，
  // 只 broadcast overlay:state 的话，用 Ctrl+Shift+H 隐藏后开关不会跟着变。
  if (overlayWin.isVisible()) {
    cfg = config.save({ overlayVisible: false });
    hideOverlay();
  } else {
    cfg = config.save({ overlayVisible: true });
    overlayWin.showInactive();
  }
  broadcast('cfg:changed', cfg);
  broadcast('overlay:state', overlayState());
  refreshTray();
}

function setListening(v) {
  listening = !!v;
  if (listening) {
    if (asr && !asr.worker) {
      asr
        .start()
        .then(() => {
          asrState = { ready: asr.ready, loading: false, error: asr.error, loadMs: asr.loadMs };
          broadcast('asr:state', asrState);
        })
        .catch((e) => {
          asrState = { ready: false, loading: false, error: e.message, loadMs: 0 };
          broadcast('asr:state', asrState);
        });
    }
    broadcast('session:clear', {});
    transcript = [];
    lastQuestion = '';

    // 开始监听 = 进入面试状态：自动打开防护并收起控制台，
    // 避免开面试前忘了点「隐藏窗口」。
    if (cfg.autoGuardOnListen !== false) {
      if (!cfg.hideCaptured) {
        cfg = config.save({ hideCaptured: true });
        broadcast('cfg:changed', cfg);
      }
      applyCaptureProtection();
      // 控制台收起，但悬浮窗必须留着——否则用户既看不到控制台也看不到作答
      if (cfg.overlayVisible === false) {
        cfg = config.save({ overlayVisible: true });
        broadcast('cfg:changed', cfg);
      }
      if (overlayWin && !overlayWin.isDestroyed() && !overlayWin.isVisible()) {
        overlayWin.showInactive();
      }
      if (consoleWin && !consoleWin.isDestroyed() && consoleWin.isVisible()) {
        consoleWin.minimize();
      }
      broadcast('guard:applied', { hideCaptured: !!cfg.hideCaptured, auto: true });
      console.log('[guard] 开始监听，已自动开启防护并收起控制台');
    }
  } else {
    if (abortCtl) {
      try {
        abortCtl.abort();
      } catch (_) {}
    }
    if (answerTimer) {
      clearTimeout(answerTimer);
      answerTimer = null;
    }
  }
  config.save({ listening });
  broadcast('listen:state', { listening });
  broadcast('overlay:state', overlayState());
  refreshTray();
  return listening;
}

/**
 * 把防护状态同步到两个窗口。
 * 关闭时有个 Windows 上的间歇毛病：setContentProtection(false) 调了，
 * 但 DWM 仍把窗口挡在采集之外（实测复现过连续 7 秒都还是"已隐藏"）。
 * 这里在关闭时补一次强制重绘 + 二次调用，让它真的恢复可见。
 */
/** 只把状态写进窗口，不做任何补救动作 */
function applyProtectionRaw() {
  const on = !!cfg.hideCaptured;
  for (const w of [overlayWin, consoleWin]) {
    if (w && !w.isDestroyed()) w.setContentProtection(on);
  }
}

let protectionBusy = false;

/**
 * 同步防护状态。关闭时有一套补救流程，因为 Windows 上
 * setContentProtection(false) 有概率"调用成功但不生效"——窗口继续被挡在采集之外，
 * 表现为"关不掉隐藏 / 悬浮窗在共享里一直不出现"。
 */
function applyCaptureProtection() {
  applyProtectionRaw();
  if (cfg.hideCaptured || protectionBusy) return;

  protectionBusy = true;
  setTimeout(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      if (cfg.hideCaptured) return;
      const wins = [overlayWin, consoleWin].filter((w) => w && !w.isDestroyed());

      // ① 鼠标穿透（分层窗口）会干扰亲和性变更，先解除
      if (overlayWin && !overlayWin.isDestroyed()) {
        try {
          setOverlayInteractive(true);
        } catch (_) {}
      }
      for (const w of wins) {
        try {
          w.setContentProtection(false);
          w.webContents.invalidate();
        } catch (_) {}
      }

      await sleep(220);
      if (cfg.hideCaptured) return;

      // ② 抖动一下尺寸，逼 DWM 重新合成这一帧
      for (const w of wins) {
        try {
          const b = w.getBounds();
          w.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height });
          w.setBounds(b);
        } catch (_) {}
      }

      await sleep(300);
      if (cfg.hideCaptured) return;

      // ③ 复核：还看不见就重建悬浮窗（新窗口没有历史亲和性，必然干净）
      const leaked = await checkLeaked(overlayWin);
      if (leaked === false) {
        console.log('[guard] 关闭防护后仍被排除 → 重建悬浮窗');
        rebuildOverlay();
      }
    } finally {
      protectionBusy = false;
      // 恢复悬浮窗的鼠标穿透（armOverlay 内部只写状态，不会再次进入补救流程）
      if (overlayWin && !overlayWin.isDestroyed() && !cfg.hideCaptured) {
        try {
          setOverlayInteractive(false);
        } catch (_) {}
      }
    }
  }, 160);
}

// 探针排队：同一时刻只允许一个检测在跑（都靠洋红标记，并发会互相干扰）
let probeChain = Promise.resolve();
function probeSlot(fn) {
  const p = probeChain.then(fn, fn);
  probeChain = p.then(
    () => {},
    () => {}
  );
  return p;
}

/** 检测某个窗口是否出现在屏幕采集里：true=被拍到（可见），false=被排除，null=无法判断 */
function checkLeaked(win) {
  return probeSlot(() => doCheckLeaked(win));
}

async function doCheckLeaked(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  try {
    await win.webContents.executeJavaScript(PROBE_ON);
    await new Promise((r) => setTimeout(r, 350));
    const b = win.getBounds();
    const s = await grabScreen();
    const hits = countProbe(s.img, { x: b.x, y: b.y, width: b.width, height: b.height }, s.base);
    await win.webContents.executeJavaScript(PROBE_OFF).catch(() => {});
    return hits >= 8;
  } catch (_) {
    return null;
  }
}

/** 重建悬浮窗：用于亲和性卡死时兜底 */
function rebuildOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    overlayWin.removeAllListeners();
    overlayWin.destroy();
  } catch (_) {}
  overlayWin = null;
  createOverlayWindow();
}

// 周期重贴：显卡驱动更新、DWM 重启、切显示器等情况下亲和性可能被重置
let guardTimer = null;
let guardPaused = false; // 自检期间暂停，否则采样瞬间被重置会导致误判
function startGuardLoop() {
  if (guardTimer) return;
  guardTimer = setInterval(() => {
    if (guardPaused) return;
    if (cfg.hideCaptured) applyCaptureProtection();
  }, 4000);
}

/* ------------------------------------------------------------ 生命周期 */

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', () => showConsole());

  app.whenReady().then(async () => {
    // 媒体与屏幕采集权限（本地应用，全部放行）
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler(() => true);

    // 系统声音回环：让渲染进程能拿到「面试官的声音」
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => {
            if (!sources.length) return callback({});
            callback({ video: sources[0], audio: 'loopback' });
          })
          .catch(() => callback({}));
      },
      { useSystemPicker: false }
    );

    asr = new AsrService(MODEL_DIR);
    llm = new LlmService();
    sessions = new SessionStore(app.getPath('userData'));
    initProjectIndex();

    createConsoleWindow();
    createOverlayWindow();
    if (!cfg.fullStealth) buildTray();
    startGuardLoop();
    startOverlayWakeLoop();

    if (SELFTEST) runSelfTest().catch((e) => console.error('[selftest] 失败', e));
    if (UITEST) runUiTest().catch((e) => console.error('[uitest] 异常', e));
    if (GUARDTEST) runGuardToggleTest().catch((e) => console.error('[guardtest] 异常', e));
    if (CLICKTEST) runClickTest().catch((e) => console.error('[clicktest] 异常', e));
    if (CLICKCHECK) runClickCheck().catch((e) => console.error('[clickcheck] 异常', e));
    if (WAKETEST) runWakeTest().catch((e) => console.error('[waketest] 异常', e));
    if (HIDETEST) runHideTest().catch((e) => console.error('[hidetest] 异常', e));
    if (STEALTHTEST) runStealthTest().catch((e) => console.error('[stealthtest] 异常', e));
    if (SHOTWINDOW) runShotWindow().catch((e) => console.error('[shotwindow] 异常', e));
    if (ASKTEST) runAskTest().catch((e) => console.error('[asktest] 异常', e));
    if (PROFILETEST) runProfileTest().catch((e) => console.error('[profiletest] 异常', e));
    if (MODELTEST) runModelTest().catch((e) => console.error('[modeltest] 异常', e));
    if (SETTINGSTEST) runSettingsTest().catch((e) => console.error('[settingstest] 异常', e));
    if (TRAYTEST) runTrayTest().catch((e) => console.error('[traytest] 异常', e));
    if (EXPORTTEST) runExportTest().catch((e) => console.error('[exporttest] 异常', e));
    if (MOCKTEST) runMockTest().catch((e) => console.error('[mocktest] 异常', e));
    if (VOICETEST) runVoiceTest().catch((e) => console.error('[voicetest] 异常', e));
    if (TRAYPROBE) runTrayProbe().catch((e) => console.error('[trayprobe] 异常', e));
    if (SCREENCAP) runScreenCap().catch((e) => console.error('[screencap] 异常', e));
    if (DRAGTEST) runDragTest().catch((e) => console.error('[dragtest] 异常', e));
    if (SIZETEST) runSizeTest().catch((e) => console.error('[sizetest] 异常', e));

    if (AUTOLISTEN) {
      setTimeout(async () => {
        try {
          const r = await consoleWin.webContents.executeJavaScript(
            '(async()=>{ try{ await toggleListening(); return "ok" }catch(e){ return "err:"+e.message } })()'
          );
          console.log('[autolisten]', r);
        } catch (e) {
          console.error('[autolisten] 失败', e.message);
        }
      }, 2500);
    }

    // 开发自检：读一下界面里的关键控件有没有正确渲染
    if (process.argv.includes('--checkui')) {
      setTimeout(async () => {
        try {
          const info = await consoleWin.webContents.executeJavaScript(
            "JSON.stringify({opts:[...document.getElementById('selModel').options].map(o=>o.text), val:document.getElementById('selModel').value, guard:document.getElementById('guardLabel').textContent})"
          );
          console.log('[checkui]', info);
          const sess = await consoleWin.webContents.executeJavaScript(
            '(async()=>{ const r = await window.api.newSession(); const l = await window.api.listSessions(); return JSON.stringify({archived: r && r.archived, hist: l.items.length, nav: [...document.querySelectorAll(\'.nav-item\')].map(b=>b.textContent.trim())}); })()'
          );
          console.log('[checkui:session]', sess);
        } catch (e) {
          console.error('[checkui] 失败', e.message);
        }
        app.quit();
      }, 6000);
    }

    // 模型目录：只包含用户自己配的供应商，已经没有内置通道可拉
    broadcastCatalog();

    // 预热识别模型（后台加载，约 2 秒）
    asr
      .start()
      .then(() => {
        asrState = { ready: asr.ready, loading: false, error: asr.error, loadMs: asr.loadMs };
        broadcast('asr:state', asrState);
        console.log('[asr] ready in', asr.loadMs, 'ms');
      })
      .catch((e) => {
        asrState = { ready: false, loading: false, error: e.message, loadMs: 0 };
        broadcast('asr:state', asrState);
        console.error('[asr] failed:', e.message);
      });

    // 全局快捷键
    const bind = (acc, fn) => {
      try {
        if (!globalShortcut.register(acc, fn)) console.warn('[hotkey] 注册失败', acc);
      } catch (e) {
        console.warn('[hotkey] 异常', acc, e.message);
      }
    };
    bind('CommandOrControl+Shift+H', () => toggleOverlay());
    bind('CommandOrControl+Shift+M', () => setListening(!listening));
    bind('CommandOrControl+Shift+O', () => showConsole());
    bind('CommandOrControl+Shift+J', () => {
      generateAnswer.forced = true;
      generateAnswer();
    });
    // 快捷键清空要和界面上的「清空上下文」一致：连场次内容一起清，否则会残留在历史里
    bind('CommandOrControl+Shift+K', () => {
      transcript = [];
      lastQuestion = '';
      lastQuestionAt = 0;
      ivBuf.text = '';
      ivBuf.at = 0;
      if (sessions) sessions.clear();
      broadcast('session:clear', {});
    });

    // 启动后自动验证一次防护效果，让状态栏显示"已实测"而不是"待确认"
    setTimeout(() => {
      if (cfg.hideCaptured) runProtectionSelfTest().catch(() => {});
    }, 2600);

    screen.on('display-metrics-changed', () => placeOverlay());
    screen.on('display-added', () => placeOverlay());
  });

  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (sessions) sessions.archive();
    globalShortcut.unregisterAll();
    if (asr) asr.dispose();
  });
}

/* ---------------------------------------------------------------- IPC */

ipcMain.handle('boot', async () => ({
  config: config.load(),
  asr: asrState,
  listening,
  protectedOn: !!cfg.hideCaptured,
  modelDir: MODEL_DIR,
  project: projectIndex ? projectIndex.stats() : null,
  profiles: { items: config.listProfiles(), activeId: cfg.activeProfileId },
  models: modelCatalog(),
}));

/* ------------------------------------------------------- 简历与资料库 */

ipcMain.handle('resume:pick', async () => {
  const r = await dialog.showOpenDialog(consoleWin, {
    title: '选择简历文件',
    properties: ['openFile'],
    filters: [
      { name: '简历文件', extensions: ['pdf', 'docx', 'doc', 'txt', 'md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };

  const file = r.filePaths[0];
  try {
    const { text, kind, pages, warning } = await extractText(file);
    if (!text || text.length < 20) {
      return { ok: false, error: warning || '没能从这份文件里提取到文字' };
    }
    cfg = config.save({
      resumeText: text,
      resumeFile: path.basename(file),
      resumeChars: text.length,
    });
    return {
      ok: true,
      file: cfg.resumeFile,
      chars: text.length,
      kind,
      pages: pages || 0,
      text,
      warning: warning || '',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('resume:clear', async () => {
  cfg = config.save({ resumeText: '', resumeFile: '', resumeChars: 0 });
  return { ok: true };
});

ipcMain.handle('project:pick', async () => {
  const r = await dialog.showOpenDialog(consoleWin, {
    title: '选择一个文件夹作为项目资料库',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const dir = r.filePaths[0];
  cfg = config.save({ projectDir: dir });
  return rebuildProject();
});

ipcMain.handle('project:rebuild', async () => rebuildProject());

async function rebuildProject() {
  if (!cfg.projectDir) return { ok: false, error: '还没有选择文件夹' };
  broadcast('project:progress', { done: 0, total: 0, current: '正在扫描…' });
  try {
    const stats = await projectIndex.build(cfg.projectDir, (done, total, cur) => {
      broadcast('project:progress', { done, total, current: cur });
    });
    broadcast('project:progress', null);
    broadcast('project:state', stats);
    return { ok: true, stats };
  } catch (e) {
    broadcast('project:progress', null);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('project:clear', async () => {
  projectIndex.clear();
  cfg = config.save({ projectDir: '' });
  const stats = projectIndex.stats();
  broadcast('project:state', stats);
  return { ok: true, stats };
});

ipcMain.handle('project:open', async () => {
  if (cfg.projectDir) shell.openPath(cfg.projectDir);
  return !!cfg.projectDir;
});

/* --------------------------------------------------- 面经导出 */
function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把问答和字幕按时间配对：每题的「我的回答」= 本题之后、下一题之前的麦克风转写 */
function buildInterviewPairs(sess) {
  const qas = (sess.qa || []).slice().sort((a, b) => a.ts - b.ts);
  const meLines = (sess.transcript || []).filter((x) => x.channel === 'me');
  return qas.map((q, i) => {
    const nextTs = qas[i + 1] ? qas[i + 1].ts : Number.MAX_SAFE_INTEGER;
    const mine = meLines
      .filter((m) => m.ts > q.ts && m.ts < nextTs)
      .map((m) => m.text)
      .join(' ')
      .trim();
    return { question: q.question, answer: q.answer, mine, ts: q.ts };
  });
}

function buildInterviewMarkdown(sess) {
  const pairs = buildInterviewPairs(sess);
  const jdTitle = (cfg.jd || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '未填写';
  const out = [];
  out.push('# 面试记录');
  out.push('');
  out.push(`- 时间：${fmtTime(sess.startedAt)}`);
  out.push(`- 岗位：${jdTitle.slice(0, 60)}`);
  out.push(`- 问题数：${pairs.length}`);
  out.push('');

  out.push('## 一、面试官提问');
  out.push('');
  if (!pairs.length) out.push('_本场没有记录到提问。_');
  pairs.forEach((p, i) => out.push(`${i + 1}. [${fmtTime(p.ts).slice(11)}] ${p.question}`));
  out.push('');

  out.push('## 二、AI 建议回答');
  out.push('');
  if (!pairs.length) out.push('_无_');
  pairs.forEach((p, i) => {
    out.push(`### ${i + 1}. ${p.question}`);
    out.push('');
    out.push(p.answer || '_未生成_');
    out.push('');
  });

  out.push('## 三、我的实际回答');
  out.push('');
  if (!pairs.length) out.push('_无_');
  pairs.forEach((p, i) => {
    out.push(`${i + 1}. ${p.mine || '_（未记录到口头回答）_'}`);
    out.push('');
  });

  return out.join('\n');
}

/** Markdown → 简单 HTML，够 Word / PDF 用即可 */
function markdownToHtml(md, title) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = md
    .split('\n')
    .map((line) => {
      if (/^# /.test(line)) return `<h1>${esc(line.slice(2))}</h1>`;
      if (/^## /.test(line)) return `<h2>${esc(line.slice(3))}</h2>`;
      if (/^### /.test(line)) return `<h3>${esc(line.slice(4))}</h3>`;
      if (/^---+$/.test(line)) return '<hr/>';
      if (/^_/.test(line) && /_$/.test(line)) return `<p class="muted"><em>${esc(line.replace(/^_|_$/g, ''))}</em></p>`;
      if (/^\d+\. /.test(line)) return `<p class="li">${esc(line)}</p>`;
      if (!line.trim()) return '';
      return `<p>${esc(line)}</p>`;
    })
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.85; color: #1b1b22; margin: 40px auto; max-width: 760px; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 18px; }
  h2 { font-size: 18px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e8e8ee; }
  h3 { font-size: 15px; margin: 20px 0 8px; }
  p { margin: 6px 0; white-space: pre-wrap; }
  p.li { margin-left: 4px; }
  .muted { color: #8e8e9a; }
</style></head><body>${body}</body></html>`;
}

async function exportInterview(format, forcedPath) {
  const sess = sessions && sessions.cur;
  if (!sess || (!sess.qa.length && !sess.transcript.length)) {
    return { ok: false, error: '面试内容不存在' };
  }
  const md = buildInterviewMarkdown(sess);
  const stamp = fmtTime(sess.startedAt).replace(/[: ]/g, '-');
  const fmt = String(format || 'md').toLowerCase();
  const ext = fmt === 'pdf' ? 'pdf' : fmt === 'doc' ? 'doc' : 'md';
  const filterName = ext === 'pdf' ? 'PDF' : ext === 'doc' ? 'Word 文档' : 'Markdown';

  let target = forcedPath || '';
  if (!target) {
    const r = await dialog.showSaveDialog(consoleWin, {
      title: '导出面经',
      defaultPath: `面经-${stamp}.${ext}`,
      filters: [{ name: filterName, extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
  }

  try {
    if (ext === 'md') {
      require('fs').writeFileSync(target, md, 'utf8');
    } else if (ext === 'doc') {
      // 用 HTML 存成 .doc：Word / WPS 都能直接打开，比纯文本保留更多排版
      require('fs').writeFileSync(target, markdownToHtml(md, '面试记录'), 'utf8');
    } else {
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true, javascript: false },
      });
      try {
        await pdfWin.loadURL(
          'data:text/html;charset=utf-8,' + encodeURIComponent(markdownToHtml(md, '面试记录'))
        );
        const buf = await pdfWin.webContents.printToPDF({
          printBackground: true,
          margins: { marginType: 'default' },
        });
        require('fs').writeFileSync(target, buf);
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
      }
    }
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

ipcMain.handle('export:interview', async (_e, format) => exportInterview(format));

/* --------------------------------------------------- 模拟面试 */
/**
 * 用当前知识库的简历 + JD 出题，用户自己回答，逐题打分，最后给能力画像。
 * 与实时面试互不干扰：不走 ASR、不写 session、不弹悬浮窗。
 */
let mockRun = null;
let mockMicActive = false; // 模拟面试语音作答中：转写只广播，不写进实时会话

function mockContext() {
  const ref = cfg.activeRef;
  const provider = ref ? (cfg.customProviders || []).find((x) => x.id === ref.providerId) : null;
  if (!provider || !provider.baseUrl) {
    throw new Error('还没有配置模型：请到左侧「模型」页添加一个供应商');
  }
  const model = (ref && ref.model) || (provider.models && provider.models[0]) || '';
  const jdTitle = (cfg.jd || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '未填写岗位';
  return { provider, model, jdTitle };
}

function mockSnapshot() {
  if (!mockRun) return { active: false };
  const cur = mockRun.items[mockRun.idx] || null;
  return {
    active: true,
    mode: mockRun.mode,
    type: mockRun.type,
    total: mockRun.total || mockRun.items.length,
    index: mockRun.idx,
    realtime: !!mockRun.realtime,
    generated: mockRun.items.length,
    question: cur ? cur.q : '',
    draft: cur ? cur.a : '',
    items: mockRun.items.map((x) => ({
      q: x.q,
      a: x.a || '',
      score: x.score,
      dims: x.dims || null,
      comment: x.comment || '',
      better: x.better || '',
    })),
    report: mockRun.report || null,
    scoring: mockRun.scoring || null,
    done: mockRun.finished === true,
  };
}

function broadcastMock() {
  broadcast('mock:state', mockSnapshot());
}

const MOCK_ROLE = {
  tech: '你是一位经验丰富的技术面试官，问题口语化、贴近真实面试，重点深挖项目细节、技术原理和方案取舍，不堆砌术语。',
  hr: '你是一位经验丰富的人力资源面试官，关注求职动机、团队协作、冲突处理、职业规划和抗压能力，问题口语化，不涉及技术细节。',
};

const MOCK_FOCUS = {
  tech: '项目细节深挖、技术基础、方案取舍、故障排查',
  hr: '自我介绍、离职/求职动机、团队协作与冲突、压力应对、职业规划',
};

async function mockStart(opts) {
  const { provider, model, jdTitle } = mockContext();
  const d = opts || {};
  const n = Math.min(20, Math.max(2, Number(d.count) || 5));
  const type = d.type === 'hr' ? 'hr' : 'tech';
  const mode = d.mode === 'voice' ? 'voice' : 'text';
  const realtime = mode === 'voice'; // 语音模式按真实面试节奏逐题生成
  const genN = realtime ? 1 : n;
  const resume = (cfg.resumeText || '').slice(0, 2000);
  const jd = (cfg.jd || '').slice(0, 1500);
  if (!resume.trim()) throw new Error('这个知识库还没有简历，先去「知识库」导入');

  const prompt = [
    `岗位：${jdTitle}`,
    jd ? `岗位要求：\n${jd}` : '',
    `候选人简历：\n${resume}`,
    '',
    `请出一场${type === 'hr' ? 'HR' : '技术'}面试的 ${genN} 个问题。要求：`,
    `- 重点覆盖：${MOCK_FOCUS[type]}`,
    '- 由浅入深，每题能在 1-2 分钟内口头答完',
    type === 'tech' ? '- 结合简历里的具体项目提问，不要问空泛通用题' : '- 结合简历里的具体经历提问，不要问空泛通用题',
    '- 不要编号、不要任何解释',
    '',
    '只输出 JSON：{"questions":["问题1","问题2"]}',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await require('./llm').completeOpenAI({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: [
      { role: 'system', content: MOCK_ROLE[type] },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    maxTokens: 8000,
  });

  let questions = [];
  const parsed = require('./llm').parseJsonLoose(raw);
  if (parsed && Array.isArray(parsed.questions)) questions = parsed.questions.map(String);
  if (!questions.length) {
    questions = String(raw)
      .split('\n')
      .map((s) => s.replace(/^\s*[\d一二三四五六七八九十]+[.、)）]\s*/, '').replace(/^[\s"'\[\]{},]+|[\s"',]+$/g, '').trim())
      .filter((s) => s.length > 6 && s.length < 200)
      .filter((s) => !/^"?questions"?\s*:?\s*\[?$/i.test(s) && !/^[\[\]{},]+$/.test(s));
  }
  questions = questions.filter(Boolean).slice(0, genN);
  if (!questions.length) throw new Error('模型没有返回有效问题，稍后再试一次');

  mockRun = {
    startedAt: Date.now(),
    type,
    mode,
    realtime,
    total: n,
    idx: 0,
    finished: false,
    scoring: null,
    items: questions.map((q) => ({ q, a: '', score: null, dims: null, comment: '', better: '' })),
    report: null,
  };
  broadcastMock();
  return mockSnapshot();
}

/** 实时模式：基于已有问答生成下一题（可以顺着上一题追问） */
async function mockNextQuestion() {
  if (!mockRun) throw new Error('还没有开始模拟面试');
  if (mockRun.finished) return mockSnapshot();
  const total = mockRun.total || mockRun.items.length;
  // 题已经够了，单纯往后翻
  if (mockRun.items.length >= total) return mockGoto(mockRun.idx + 1);

  const { provider, model, jdTitle } = mockContext();
  const history = mockRun.items
    .map((x, i) => `第 ${i + 1} 题：${x.q}\n候选人回答：${(x.a || '（未回答）').slice(0, 300)}`)
    .join('\n\n');

  const prompt = [
    `岗位：${jdTitle}`,
    `候选人简历摘要：${(cfg.resumeText || '').slice(0, 800)}`,
    '',
    '已经进行的问答：',
    history,
    '',
    `请提出第 ${mockRun.items.length + 1} 个问题（共 ${total} 题）。`,
    '优先针对上一条回答里的模糊点、可疑点继续追问；如果上一题已经问透，就换一个维度。',
    '只输出问题本身，不要编号、不要解释、不要引号。',
  ].join('\n');

  const raw = await require('./llm').completeOpenAI({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: [
      { role: 'system', content: MOCK_ROLE[mockRun.type] || MOCK_ROLE.tech },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    maxTokens: 2000,
  });

  const q = String(raw || '')
    .trim()
    .split('\n')
    .filter((x) => x.trim())
    .pop()
    .replace(/^\s*[\d一二三四五六七八九十]+[.、)）]\s*/, '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim();
  if (!q || q.length < 4) throw new Error('模型没有返回有效问题，再点一次试试');

  mockRun.items.push({ q, a: '', score: null, dims: null, comment: '', better: '' });
  mockRun.idx = mockRun.items.length - 1;
  broadcastMock();
  return mockSnapshot();
}

/** 只存草稿，不评分 —— 用户可以来回切题修改，最后一次性提交 */
function mockSaveAnswer(index, text) {
  if (!mockRun) throw new Error('还没有开始模拟面试');
  if (mockRun.finished) return mockSnapshot();
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= mockRun.items.length) throw new Error('题号无效');
  mockRun.items[i].a = String(text == null ? '' : text);
  // 不广播：前端本地已经更新，广播会导致对话流整块重绘闪烁
  return mockSnapshot();
}

function mockGoto(index) {
  if (!mockRun) return null;
  const i = Number(index);
  if (Number.isInteger(i) && i >= 0 && i < mockRun.items.length) mockRun.idx = i;
  broadcastMock();
  return mockSnapshot();
}

async function mockScoreOne(item) {
  const { provider, model } = mockContext();
  const prompt = [
    `面试问题：${item.q}`,
    '',
    `候选人的回答：${(item.a || '').slice(0, 3000) || '（未作答）'}`,
    '',
    '请评估这个回答，从四个维度打分（0-100）：',
    '- depth：技术深度，是否说到关键细节和取舍',
    '- clarity：表达清晰度，是否啰嗦、有没有跑题',
    '- structure：结构完整度，是否有层次、有结论',
    '- match：岗位匹配度，是否贴合岗位要求',
    '',
    '只输出 JSON：',
    '{"score":0-100,"dims":{"depth":0,"clarity":0,"structure":0,"match":0},"comment":"一句话点评，40字以内","better":"一句话改进方向，40字以内"}',
  ].join('\n');

  const raw = await require('./llm').completeOpenAI({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: [
      { role: 'system', content: MOCK_ROLE[mockRun.type] || MOCK_ROLE.tech },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    maxTokens: 3000,
  });

  const parsed = require('./llm').parseJsonLoose(raw) || {};
  const dims = parsed.dims && typeof parsed.dims === 'object' ? parsed.dims : {};
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  item.score = clamp(parsed.score != null ? parsed.score : 60);
  item.dims = {
    depth: clamp(dims.depth),
    clarity: clamp(dims.clarity),
    structure: clamp(dims.structure),
    match: clamp(dims.match),
  };
  item.comment = String(parsed.comment || '').slice(0, 80);
  item.better = String(parsed.better || '').slice(0, 80);
}

/** 统一提交：逐题评分（带进度）→ 汇总画像 */
async function mockFinish(opts) {
  if (!mockRun) throw new Error('还没有开始模拟面试');
  if (mockRun.finished) return mockSnapshot();
  const partial = !!(opts && opts.partial);
  if (partial) {
    // 中途交卷：只评分已经答过的题，没答到的直接丢掉，不拉低总分
    mockRun.items = mockRun.items.filter((x) => (x.a || '').trim());
    if (!mockRun.items.length) throw new Error('还没有填写任何回答');
    mockRun.total = mockRun.items.length;
    mockRun.idx = mockRun.items.length - 1;
    mockRun.endedEarly = true;
  }
  const answered = mockRun.items.filter((x) => (x.a || '').trim());
  if (!answered.length) throw new Error('还没有填写任何回答');

  mockRun.scoring = { done: 0, total: mockRun.items.length };
  broadcastMock();

  for (let i = 0; i < mockRun.items.length; i++) {
    const item = mockRun.items[i];
    if (!(item.a || '').trim()) {
      // 没作答的题给 0 分，不浪费调用
      item.score = 0;
      item.dims = { depth: 0, clarity: 0, structure: 0, match: 0 };
      item.comment = '未作答';
      item.better = '';
    } else {
      try {
        await mockScoreOne(item);
      } catch (e) {
        item.score = 0;
        item.dims = { depth: 0, clarity: 0, structure: 0, match: 0 };
        item.comment = '评分失败：' + (e.message || '未知错误');
        item.better = '';
      }
    }
    mockRun.scoring.done = i + 1;
    broadcastMock();
  }

  await mockBuildReport();
  mockRun.scoring = null;
  mockRun.finished = true;
  broadcastMock();
  return mockSnapshot();
}

async function mockBuildReport() {
  const { provider, model } = mockContext();
  const answered = mockRun.items.filter((x) => (x.a || '').trim() && x.score != null);
  const avg = (k) =>
    Math.round(answered.reduce((s, x) => s + (x.dims ? x.dims[k] : 0), 0) / (answered.length || 1));
  const dimsAvg = {
    depth: avg('depth'),
    clarity: avg('clarity'),
    structure: avg('structure'),
    match: avg('match'),
  };
  const total = Math.round(answered.reduce((s, x) => s + x.score, 0) / (answered.length || 1));

  const digest = mockRun.items
    .map(
      (x, i) =>
        `Q${i + 1}: ${x.q}\n得分 ${x.score}（深度${x.dims.depth}/清晰${x.dims.clarity}/结构${x.dims.structure}/匹配${x.dims.match}）\n回答：${(x.a || '未作答').slice(0, 300)}`
    )
    .join('\n\n');

  const prompt = [
    `以下是一场${mockRun.type === 'hr' ? 'HR' : '技术'}面试的问答与得分：`,
    '',
    digest,
    '',
    `总分 ${total}，四维均分：深度${dimsAvg.depth}、清晰${dimsAvg.clarity}、结构${dimsAvg.structure}、匹配${dimsAvg.match}`,
    '',
    '请给出候选人画像，只输出 JSON：',
    '{"level":"一句话定位，如\\"基础扎实但表达偏啰嗦\\"",',
    '"strengths":["2-3 条具体强项，基于回答内容，不要空话"],',
    '"weaknesses":["2-3 条具体薄弱项，指出是哪个回答暴露的"],',
    '"advice":["2-3 条可执行的改进建议"]}',
  ].join('\n');

  const raw = await require('./llm').completeOpenAI({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: [
      { role: 'system', content: MOCK_ROLE[mockRun.type] || MOCK_ROLE.tech },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
    maxTokens: 4000,
  });
  const p = require('./llm').parseJsonLoose(raw) || {};
  mockRun.report = {
    total,
    dims: dimsAvg,
    level: String(p.level || '').slice(0, 60),
    strengths: Array.isArray(p.strengths) ? p.strengths.map(String).slice(0, 4) : [],
    weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses.map(String).slice(0, 4) : [],
    advice: Array.isArray(p.advice) ? p.advice.map(String).slice(0, 4) : [],
  };
  return mockRun.report;
}

ipcMain.handle('mock:start', async (_e, d) => {
  try {
    return { ok: true, state: await mockStart(d || {}) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

async function synthSpeech(textRaw, voiceRaw) {
  const text = String(textRaw || '').slice(0, 500);
  const voice = String(voiceRaw || 'zh-CN-XiaoxiaoNeural');
  if (!text) throw new Error('没有文本');
  let tts = null;
  try {
    // Edge 神经语音：音质接近真人，且不需要 API Key
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    audioStream.on('data', (c) => chunks.push(c));
    await new Promise((resolve, reject) => {
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
      setTimeout(() => reject(new Error('语音合成超时')), 20000);
    });
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('没有生成音频');
    return { ok: true, audio: buf.toString('base64') };
  } finally {
    try {
      if (tts && tts.close) tts.close();
    } catch (_) {}
  }
}

ipcMain.handle('mock:tts', async (_e, d) => {
  try {
    return await synthSpeech(d && d.text, d && d.voice);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mock:next', async () => {
  try {
    return { ok: true, state: await mockNextQuestion() };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mock:save', async (_e, d) => {
  try {
    return { ok: true, state: mockSaveAnswer(d && d.index, d && d.text) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mock:goto', async (_e, index) => {
  try {
    return { ok: true, state: mockGoto(index) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mock:finish', async (_e, opts) => {
  try {
    return { ok: true, state: await mockFinish(opts) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

async function ensureAsr() {
  if (!asr) return asrState;
  if (asrState.ready) return asrState;
  // 已经在加载中：等它就绪，别把 loading 当成失败返回
  if (asr.worker && asrState.loading) {
    for (let i = 0; i < 60; i++) {
      if (asrState.ready || asrState.error) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return asrState;
  }
  asrState = { ready: false, loading: true, error: null, loadMs: 0 };
  broadcast('asr:state', asrState);
  return asr
    .start()
    .then(() => {
      asrState = { ready: asr.ready, loading: false, error: asr.error, loadMs: asr.loadMs };
      broadcast('asr:state', asrState);
      return asrState;
    })
    .catch((e) => {
      asrState = { ready: false, loading: false, error: e.message, loadMs: 0 };
      broadcast('asr:state', asrState);
      return asrState;
    });
}

ipcMain.handle('mock:mic', async (_e, on) => {
  mockMicActive = !!on;
  if (!mockMicActive) return { ok: true, asr: asrState };
  const st = await ensureAsr();
  return { ok: true, asr: st };
});

ipcMain.handle('mock:state', async () => mockSnapshot());

ipcMain.handle('mock:reset', async () => {
  mockRun = null;
  broadcastMock();
  return { ok: true };
});


function buildMockMarkdown(run) {
  const out = [];
  const jdTitle = (cfg.jd || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '未填写岗位';
  const r = run.report || {};
  out.push('# 模拟面试报告');
  out.push('');
  out.push(`- 时间：${fmtTime(run.startedAt)}`);
  out.push(`- 岗位：${jdTitle.slice(0, 60)}`);
  out.push(`- 总分：${r.total != null ? r.total : '—'}${r.level ? `（${r.level}）` : ''}`);
  out.push('');

  if (r.dims) {
    out.push('## 能力维度');
    out.push('');
    const names = { depth: '技术深度', clarity: '表达清晰', structure: '结构完整', match: '岗位匹配' };
    Object.keys(names).forEach((k) => out.push(`- ${names[k]}：${r.dims[k]}`));
    out.push('');
  }

  out.push('## 逐题记录');
  out.push('');
  run.items.forEach((it, i) => {
    out.push(`### ${i + 1}. ${it.q}`);
    out.push('');
    out.push(`**我的回答**：${it.a || '_未作答_'}`);
    out.push('');
    if (it.score != null) {
      out.push(`**得分**：${it.score}（深度 ${it.dims.depth} / 清晰 ${it.dims.clarity} / 结构 ${it.dims.structure} / 匹配 ${it.dims.match}）`);
      if (it.comment) out.push(`**点评**：${it.comment}`);
      if (it.better) out.push(`**改进**：${it.better}`);
    }
    out.push('');
  });

  const section = (title, list) => {
    if (!list || !list.length) return;
    out.push(`## ${title}`);
    out.push('');
    list.forEach((t) => out.push(`- ${t}`));
    out.push('');
  };
  section('强项', r.strengths);
  section('薄弱项', r.weaknesses);
  section('改进建议', r.advice);
  return out.join('\n');
}

ipcMain.handle('mock:export', async () => {
  if (!mockRun || !mockRun.items.length) return { ok: false, error: '还没有模拟记录' };
  const stamp = fmtTime(mockRun.startedAt).replace(/[: ]/g, '-');
  const r = await dialog.showSaveDialog(consoleWin, {
    title: '导出模拟面试报告',
    defaultPath: `模拟面试-${stamp}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    require('fs').writeFileSync(r.filePath, buildMockMarkdown(mockRun), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

/* ------------------------------------------------------- 多知识库 */
function profilesSnapshot() {
  return { items: config.listProfiles(), activeId: cfg.activeProfileId };
}

function afterProfileChange() {
  cfg = config.load();
  initProjectIndex();
  broadcast('cfg:changed', cfg);
  broadcast('profiles:state', profilesSnapshot());
  broadcast('project:state', projectIndex ? projectIndex.stats() : null);
}

/* ------------------------------------------------------- 模型目录 */
/**
 * 前端模型下拉需要的数据：内置通道的模型 + 用户自建供应商的模型 + 当前选择。
 * 内置通道拉取失败时（没网 / 额度用尽）自定义供应商仍然可用，所以两者分开返回。
 */
function modelCatalog() {
  const { PROVIDER_PRESETS } = require('./llm');
  const providers = (cfg.customProviders || []).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    hasKey: !!p.apiKey,
    models: (p.models || []).map((m) => ({ id: m, name: m })),
  }));
  return {
    providers,
    presets: PROVIDER_PRESETS,
    active: cfg.activeRef || null,
    configured: providers.length > 0,
  };
}

function broadcastCatalog() {
  broadcast('models:list', modelCatalog());
}

ipcMain.handle('ui:zoom', async (e, f) => {
  // 用原生缩放，不用 CSS zoom：后者会让 100vh、sticky 定位全部算错
  const v = Math.min(2, Math.max(0.5, Number(f) || 1));
  try {
    e.sender.setZoomFactor(v);
  } catch (_) {}
  return { ok: true, zoom: v };
});

ipcMain.handle('ui:opacity', async (_e, v) => {
  const val = Math.min(1, Math.max(0.3, Number(v) || 1));
  cfg = config.save({ uiOpacity: val });
  applyConsoleOpacity();
  return { ok: true, value: val };
});

ipcMain.handle('model:select', async (_e, ref) => {
  if (!ref || !ref.providerId) return { ok: false, error: '没有指定供应商' };
  const next = { kind: 'custom', providerId: ref.providerId, model: ref.model || '' };
  cfg = config.save({ activeRef: next });
  broadcastCatalog();
  return { ok: true, active: next };
});

ipcMain.handle('provider:save', async (_e, p) => {
  const name = String((p && p.name) || '').trim();
  const baseUrl = String((p && p.baseUrl) || '').trim();
  if (!name) return { ok: false, error: '请填写供应商名称' };
  if (!baseUrl) return { ok: false, error: '请填写 Base URL' };

  const models = (Array.isArray(p && p.models) ? p.models : String((p && p.models) || '').split(/[,，\s]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!models.length) return { ok: false, error: '至少填一个模型名' };

  const list = [...(cfg.customProviders || [])];
  const entry = {
    id: (p && p.id) || 'cp' + Date.now().toString(36),
    name: name.slice(0, 30),
    baseUrl,
    apiKey: String((p && p.apiKey) || '').trim(),
    models,
  };
  const i = list.findIndex((x) => x.id === entry.id);
  if (i >= 0) {
    // 前端不回填密钥，留空就沿用原来的
    if (!entry.apiKey) entry.apiKey = list[i].apiKey || '';
    list[i] = { ...list[i], ...entry };
  } else {
    list.push(entry);
  }

  cfg = config.save({ customProviders: list });
  // 保存后如果还没有当前模型（或者是刚加的第一个），顺手选中它，省得用户还要再去下拉里点一次
  const cur = cfg.activeRef;
  const stillValid = cur && list.some((x) => x.id === cur.providerId);
  if (!stillValid) {
    const fallback = list.find((x) => x.id === entry.id) || list[0];
    cfg = config.save({
      activeRef: { kind: 'custom', providerId: fallback.id, model: (fallback.models || [])[0] || '' },
    });
  }
  broadcastCatalog();
  return { ok: true, id: entry.id };
});

ipcMain.handle('provider:delete', async (_e, id) => {
  const list = (cfg.customProviders || []).filter((x) => x.id !== id);
  const patch = { customProviders: list };
  // 没有内置通道可回退了：删掉当前在用的，直接落到剩下的第一个（或置空让界面提示去配置）
  if (cfg.activeRef && cfg.activeRef.providerId === id) {
    patch.activeRef = list[0] ? { kind: 'custom', providerId: list[0].id, model: '' } : null;
  }
  cfg = config.save(patch);
  broadcastCatalog();
  return { ok: true };
});

ipcMain.handle('provider:test', async (_e, p) => {
  const { testProvider } = require('./llm');
  const d = p || {};
  let apiKey = String(d.apiKey || '');
  if (!apiKey && d.id) {
    const exist = (cfg.customProviders || []).find((x) => x.id === d.id);
    if (exist) apiKey = exist.apiKey || '';
  }
  return testProvider({ baseUrl: d.baseUrl, apiKey, models: d.models });
});

ipcMain.handle('profiles:list', async () => profilesSnapshot());

ipcMain.handle('profiles:create', async (_e, name) => {
  const p = config.createProfile(name);
  config.switchProfile(p.id);
  afterProfileChange();
  return { ok: true, id: p.id };
});

ipcMain.handle('profiles:rename', async (_e, d) => {
  const ok = config.renameProfile(d && d.id, d && d.name);
  if (ok) broadcast('profiles:state', profilesSnapshot());
  return { ok };
});

ipcMain.handle('profiles:delete', async (_e, id) => {
  const r = config.deleteProfile(id);
  if (r.ok) {
    // 顺手把这个库的索引缓存也删掉，不留垃圾
    try {
      const f = indexCacheFile(id);
      if (require('fs').existsSync(f)) require('fs').unlinkSync(f);
    } catch (_) {}
    afterProfileChange();
  }
  return r;
});

ipcMain.handle('profiles:switch', async (_e, id) => {
  const r = config.switchProfile(id);
  if (r.ok) afterProfileChange();
  return r;
});

ipcMain.handle('project:test', async (_e, q) => {
  // 冒烟用：看看某个问题能召回什么
  const hits = projectIndex.retrieve(String(q || ''), { topK: 4, budget: 2600 });
  return hits.map((h) => ({ file: h.file, score: h.score, preview: h.text.slice(0, 120) }));
});

ipcMain.handle('cfg:set', async (_e, patch) => {
  cfg = config.save(patch);

  if ('hideCaptured' in patch) applyCaptureProtection();

  if ('fullStealth' in patch) {
    if (patch.fullStealth) enterStealth(true);
    else exitStealth();
  }

  if ('overlaySide' in patch || 'overlayWidth' in patch) placeOverlay();
  if ('overlayVisible' in patch && overlayWin) {
    if (patch.overlayVisible) overlayWin.showInactive();
    else hideOverlay();
    refreshTray();
  }
  broadcast('cfg:changed', cfg);
  broadcast('overlay:cfg', {
    opacity: cfg.overlayOpacity,
    theme: cfg.overlayTheme,
    width: cfg.overlayWidth,
    autoHeight: cfg.overlayAutoHeight !== false,
    maxed: overlayMaxed,
  });
  return cfg;
});

ipcMain.handle('listen:toggle', async (_e, v) => setListening(typeof v === 'boolean' ? v : !listening));

ipcMain.on('utterance', (_e, payload) => {
  handleUtterance(payload).catch((e) => broadcast('asr:error', { message: e.message }));
});

ipcMain.handle('ask:text', async (_e, t) => {
  const q = String(t || '').trim();
  if (!q) return false;

  // 手动输入 = 用户明确在提问，不能再去套「像不像问句」的启发式：
  // 以前输入「讲讲你的项目」这种陈述式内容，isQuestionLike 判不过就直接静默返回，
  // 表现就是"输入了但没有任何反应"。这里直接指定问题并强制作答。
  lastQuestion = q;
  lastQuestionAt = Date.now();
  lastQuestionManual = true;

  // 记进字幕与场次；同时把缓冲清空，免得后面的语音跟这句话拼在一起
  dispatchText('interviewer', q);
  ivBuf.text = '';
  ivBuf.at = 0;

  generateAnswer.forced = true; // 即使关了「自动作答」，手动提问也要答
  await generateAnswer();
  return true;
});

ipcMain.handle('answer:regen', async () => {
  generateAnswer.forced = true;
  await generateAnswer();
  return true;
});

ipcMain.handle('context:clear', async () => {
  transcript = [];
  lastQuestion = '';
  lastQuestionAt = 0;
  ivBuf.text = '';
  ivBuf.at = 0;
  if (sessions) sessions.clear();
  broadcast('session:clear', {});
  return true;
});

ipcMain.handle('models:get', async () => modelCatalog());

/* ------------------------------------------------------------ 历史记录 */

ipcMain.handle('sessions:list', async () => (sessions ? sessions.summary() : { current: null, items: [] }));

ipcMain.handle('sessions:get', async (_e, id) => (sessions ? sessions.detail(String(id || '')) : null));

ipcMain.handle('session:new', async () => {
  if (!sessions) return null;
  const archived = sessions.start();
  transcript = [];
  lastQuestion = '';
  lastQuestionAt = 0;
  ivBuf.text = '';
  ivBuf.at = 0;
  if (abortCtl) {
    try {
      abortCtl.abort();
    } catch (_) {}
  }
  broadcast('session:clear', {});
  broadcast('session:state', { ...sessions.summary(), archived });
  return { ...sessions.summary(), archived };
});

ipcMain.handle('session:delete', async (_e, id) => {
  if (!sessions) return false;
  const ok = sessions.remove(String(id || ''));
  broadcast('session:state', sessions.summary());
  return ok;
});

ipcMain.handle('web:test', async (_e, q) => {
  const query = String(q || '').trim() || lastQuestion || '你好';
  const r = await websearch.search(query, { topN: cfg.webTopN || 4 });
  if (r.ok) broadcast('web:results', { ok: true, query: r.query, engine: r.engine, items: r.items });
  else broadcast('web:results', { ok: false, query, error: r.error });
  return r;
});

ipcMain.handle('debug:text', async (_e, text) => {
  if (!SELFTEST) return false;
  dispatchText('interviewer', String(text || ''));
  return true;
});

ipcMain.handle('selftest', async (_e, force) => runProtectionSelfTest(!!force || !overlayWin || overlayWin.isVisible()));

// 悬浮窗按内容自适应高度（垂直居中锚定）
ipcMain.on('overlay:resize', (_e, h) => {
  if (draggingNow) console.log('[resize] 拖动中收到内容自适应请求', h);
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 用户手动调过大小 / 收起 / 全屏时，不再按内容自动改高度
  if (cfg.overlayAutoHeight === false || overlayCompact || overlayMaxed || dragSize) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const height = Math.max(150, Math.min(Math.floor(wa.height * 0.78), Math.round(h)));
  const b = overlayWin.getBounds();
  if (Math.abs(b.height - height) < 6) return;
  overlayWin.setBounds({
    x: b.x,
    y: b.y + Math.round((b.height - height) / 2),
    width: b.width,
    height,
  });
});

/* -------------------------------------------------- 悬浮窗拖动 */

let overlayInteractive = false;
let draggingNow = false;
let dragDriftLog = 0;

/**
 * 改鼠标穿透的唯一入口，必须走这里。
 * 以前 armOverlay 直接调 setIgnoreMouseEvents(true) 却不更新状态：
 * 主进程和渲染层都还记着「已唤醒」，渲染层的去重逻辑于是把后续唤醒全吞掉，
 * 表现就是「隐藏悬浮窗再显示回来，窗口彻底拖不动，– □ × 也点不了」。
 */
function setOverlayInteractive(on, notify = true) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const next = !!on;
  const changed = next !== overlayInteractive;
  overlayInteractive = next;
  try {
    // 不再传 {forward:true}：那个模式在窗口 hide→show 之后经常不再转发事件
    // （历史两次"拖不动"都是它）。交互判定已经由主进程盯光标完成，不需要转发。
    overlayWin.setIgnoreMouseEvents(!next);
  } catch (_) {}
  // 改鼠标事件会重置显示亲和性：不立刻补一次，拖一下窗口就会在共享里露出来
  applyProtectionRaw();
  // 把状态同步给渲染层，保证它的本地缓存和真实穿透态一致
  if (notify && changed) {
    try {
      overlayWin.webContents.send(next ? 'overlay:wake' : 'overlay:sleep');
    } catch (_) {}
  }
}

ipcMain.on('overlay:interactive', (_e, on) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 渲染层主动发起的，它自己的状态已经是最新的，不用回发
  setOverlayInteractive(on, false);
  // 改鼠标事件可能重置显示亲和性，立刻补一次
  applyProtectionRaw();
});

/**
 * 交互态兜底：Windows 上 forward 转发偶发失灵（尤其刚动过显示亲和性），
 * 表现就是「鼠标压在标题栏上，窗口仍是穿透态，拖不动也点不了」。
 * 这里用真实光标位置做最后一道保险，只认标题栏和四边手柄，
 * 正文区继续保持穿透，点击照样能落到下层应用上。
 */
/**
 * 交互态的唯一真相来源。
 *
 * 早期做法是「窗口常驻穿透，靠渲染层收到 mousemove 再唤醒」，但 Windows 在
 * forward 模式下转发的是合成事件，pointermove 根本不触发，窗口会焊死在穿透态
 * （两次线上故障都是它）。这里改成主进程直接盯着真实光标位置：
 *   光标在标题栏/四边 12px 内 → 可交互；在正文区或窗口外 → 穿透。
 * 完全不依赖任何事件转发，最多 80ms 延迟。
 */
const OVERLAY_BAR_H = 48; // 标题栏 38px + 透明上边距
const OVERLAY_EDGE = 12; // 四边缩放手柄宽度

let overlayWakeTimer = null;
let overlayResizingNow = false;
let lastHitLog = 0;

function startOverlayWakeLoop() {
  if (overlayWakeTimer) return;
  overlayWakeTimer = setInterval(() => {
    try {
      if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;

      // 拖动/缩放过程中必须保持可交互，否则窗口一移动光标就"离开"热区，拖动会断
      if (draggingNow || overlayResizingNow) {
        if (!overlayInteractive) setOverlayInteractive(true);
        return;
      }

      const b = overlayWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

      let want = false;
      if (inside) {
        const nearBar = p.y - b.y <= OVERLAY_BAR_H;
        const nearEdge =
          p.x - b.x <= OVERLAY_EDGE ||
          b.x + b.width - p.x <= OVERLAY_EDGE ||
          b.y + b.height - p.y <= OVERLAY_EDGE;
        want = nearBar || (nearEdge && !overlayMaxed);
      }

      if (want !== overlayInteractive) {
        setOverlayInteractive(want);
        if (HIT_DEBUG) console.log('[hit]', want ? '可交互' : '穿透', '光标', p.x, p.y, '窗口', b.x, b.y, b.width, b.height);
      }
      // 采样：只有显式带 --hitdebug 才打，平时别刷屏
      if (HIT_DEBUG && Date.now() - lastHitLog > 3000) {
        lastHitLog = Date.now();
        console.log(
          '[hit] tick',
          JSON.stringify({ p, b, inside, want, interactive: overlayInteractive, focused: overlayWin.isFocused() })
        );
      }
    } catch (e) {
      // 轮询一旦失效窗口就永远穿透、用户完全没法操作，必须留下痕迹
      if (Date.now() - lastHitLog > 5000) {
        lastHitLog = Date.now();
        console.error('[hit] 轮询异常', e && e.message);
      }
    }
  }, 80);
  if (overlayWakeTimer.unref) overlayWakeTimer.unref();
}

// 拖动开始时锁住尺寸：每帧都从 getBounds 读回尺寸，会因 DPI 取整一帧一帧"长胖"
let dragSize = null;

ipcMain.on('overlay:dragstart', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  draggingNow = true;
  dragDriftLog = 0;
  const b = overlayWin.getBounds();
  dragSize = { width: b.width, height: b.height };
});

ipcMain.on('overlay:moveto', (_e, d) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const p2 = d || {};
  const b = overlayWin.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  // 尺寸以拖动开始时锁定的为准：单独调 setPosition 在这台机器上每调用一次
  // 窗口就会“胖”1~2px（实测 30 步拖动从 460x153 涨到 494x199），必须同帧写回尺寸
  const width = dragSize ? dragSize.width : b.width;
  const height = dragSize ? dragSize.height : b.height;
  const nx = Math.min(Math.max(Math.round(p2.x || 0), wa.x - width + 80), wa.x + wa.width - 80);
  const ny = Math.min(Math.max(Math.round(p2.y || 0), wa.y), wa.y + wa.height - 60);
  overlayWin.setBounds({ x: nx, y: ny, width, height });
});

/* 边缘缩放：渲染层算好绝对矩形，主进程只做边界钳制 */
let overlayResizeCfg = null;
ipcMain.on('overlay:resizeto', (_e, d) => {
  if (!overlayWin || overlayWin.isDestroyed() || overlayMaxed) return;
  overlayResizingNow = true;
  const p2 = d || {};
  const wa = screen.getPrimaryDisplay().workArea;
  const MIN_W = 300;
  const MIN_H = 96;

  let x = Math.round(p2.x || 0);
  let y = Math.round(p2.y || 0);
  let w = Math.round(p2.w || 0);
  let h = Math.round(p2.h || 0);

  w = Math.min(Math.max(w, MIN_W), wa.width);
  h = Math.min(Math.max(h, MIN_H), wa.height);
  x = Math.min(Math.max(x, wa.x - w + 80), wa.x + wa.width - 80);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - 60);

  const b = overlayWin.getBounds();
  if (b.x === x && b.y === y && b.width === w && b.height === h) return;
  overlayWin.setBounds({ x, y, width: w, height: h });
  overlayResizeCfg = { x, y, width: w, height: h };
});

// 拖动结束才写盘，避免拖动过程每帧写文件
let overlayPosTimer = null;
ipcMain.on('overlay:enddrag', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  draggingNow = false;
  dragSize = null;

  clearTimeout(overlayPosTimer);
  overlayPosTimer = setTimeout(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    cfg = config.save({ overlayPos: { x: b.x, y: b.y } });
    broadcast('cfg:changed', cfg);
  }, 250);
});

ipcMain.on('overlay:endresize', () => {
  overlayResizingNow = false;
  if (!overlayResizeCfg) return;
  const s2 = overlayResizeCfg;
  overlayResizeCfg = null;
  cfg = config.save({
    overlayAutoHeight: false,
    overlayWidth: s2.width,
    overlayHeight: s2.height,
    overlayPos: { x: s2.x, y: s2.y },
  });
  broadcast('overlay:cfg', {
    opacity: cfg.overlayOpacity,
    theme: cfg.overlayTheme,
    width: cfg.overlayWidth,
    autoHeight: false,
    maxed: overlayMaxed,
  });
  broadcast('cfg:changed', cfg);
});

/* 收起 / 全屏 */
let overlayCompact = false;
let overlayMaxed = false;
let overlayMem = null; // 收起或全屏前的 bounds

ipcMain.on('overlay:compact', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  if (!overlayCompact) {
    overlayMem = b;
    overlayCompact = true;
    overlayWin.setBounds({ x: b.x, y: b.y, width: b.width, height: 62 });
  } else {
    overlayCompact = false;
    const r = overlayMem || { x: b.x, y: b.y, width: b.width, height: 420 };
    overlayWin.setBounds({ x: b.x, y: b.y, width: r.width, height: r.height });
  }
  broadcast('overlay:cfg', {
    opacity: cfg.overlayOpacity,
    theme: cfg.overlayTheme,
    width: cfg.overlayWidth,
    autoHeight: cfg.overlayAutoHeight !== false,
    compact: overlayCompact,
    maxed: overlayMaxed,
  });
});

ipcMain.on('overlay:maximize', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  if (!overlayMaxed) {
    overlayMem = b;
    overlayMaxed = true;
    overlayWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } else {
    overlayMaxed = false;
    const r = overlayMem || { x: wa.x, y: wa.y, width: 460, height: 520 };
    overlayWin.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  broadcast('overlay:cfg', {
    opacity: cfg.overlayOpacity,
    theme: cfg.overlayTheme,
    width: cfg.overlayWidth,
    autoHeight: cfg.overlayAutoHeight !== false,
    compact: overlayCompact,
    maxed: overlayMaxed,
  });
});

ipcMain.on('overlay:hide', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  cfg = config.save({ overlayVisible: false });
  hideOverlay();
  broadcast('cfg:changed', cfg);
  broadcast('overlay:state', overlayState());
  refreshTray();
});

ipcMain.on('overlay:resetpos', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  cfg = config.save({ overlayPos: null });
  placeOverlay();
  broadcast('cfg:changed', cfg);
});

ipcMain.handle('overlay:toggle', async () => {
  toggleOverlay();
  return !!(overlayWin && overlayWin.isVisible());
});

ipcMain.handle('app:quit', async () => {
  quitting = true;
  app.quit();
});
