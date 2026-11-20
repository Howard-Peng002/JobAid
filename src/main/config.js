'use strict';
/**
 * 配置持久化：存放在 Electron userData 目录，卸载/升级不影响。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 模型
  model: 'deepseek-v4-flash', // 内置通道里的模型 id
  // 自定义供应商：{ id, name, baseUrl, apiKey, models: [] }
  // 走 OpenAI 兼容的 /chat/completions，所以 DeepSeek、通义、Kimi、智谱、Ollama 都能接
  customProviders: [],
  // 当前选择 { kind:'builtin'|'custom', providerId, model }；null 表示用内置的 cfg.model
  activeRef: null,
  // 界面：字体缩放 0.9/1/1.1/1.2、主题 light/dark、语言见 i18n.js
  uiScale: 1,
  uiOpacity: 1, // 控制台窗口透明度（0.3–1）
  fullStealth: false, // 完全隐身：隐藏时连托盘图标一起去掉
  uiTheme: 'light',
  lang: 'zh-CN',
  temperature: 0.5,
  style: 'bullet', // bullet | spoken | star

  // 悬浮窗
  overlayOpacity: 0.95,
  overlayTheme: 'dark', // dark | light
  overlaySide: 'right', // right | left（界面上不再提供切换，位置以拖动为准）
  showShortcuts: false, // 设置栏是否展开快捷键面板
  overlayWidth: 460,
  overlayPos: null, // 用户拖动后记住的位置 {x, y}
  overlayHeight: null, // 用户手动调过的高度
  overlayAutoHeight: true, // 高度是否跟随内容；手动缩放后置 false
  hideCaptured: true, // 防屏幕共享 / 录屏
  autoGuardOnListen: true, // 开始监听时自动开启防护并收起控制台
  stealthTaskbar: false, // 已废弃：任务栏不再隐藏，改由 overlayVisible 控制悬浮窗
  overlayVisible: true,

  // 网络搜索
  webSearch: false,
  webTopN: 4,

  // 技能（可编辑的作答取向）
  skills: [
    {
      id: 'tech',
      name: '技术细节优先',
      desc: '答技术题时先给方案，再给关键实现细节',
      prompt: '面对技术问题，先用一句话给出方案结论，再补 2 条关键实现细节（用什么、为什么）。',
      enabled: true,
    },
    {
      id: 'star',
      name: 'STAR 行为面试',
      desc: '经历类问题按情境-任务-行动-结果组织',
      prompt: '遇到"讲一次你…"这类经历题，按 情境→任务→行动→结果 的顺序说，每段一句，控制在四行内。',
      enabled: false,
    },
    {
      id: 'brief',
      name: '极简直给',
      desc: '只给最关键的一条，不铺陈',
      prompt: '尽量精炼：最多三行，第一行必须是结论。',
      enabled: false,
    },
    {
      id: 'ask',
      name: '反问环节',
      desc: '被问"你有什么想问的"时给高质量反问',
      prompt: '当对方问"你有什么想问我的"，输出 3 个具体的、能体现你真在思考岗位的反问，不要问薪资和加班。',
      enabled: true,
    },
  ],

  // 行为
  autoAnswer: true, // 检测到提问自动生成
  listening: false,
  sysAudio: true,
  mic: true,

  // 面试背景
  resumeText: '', // 简历正文（上传 PDF/Word 后自动解析，可手动微调）
  resumeFile: '', // 简历文件名（仅用于展示）
  resumeChars: 0,
  projectDir: '', // 项目资料库根目录
  jd: '', // 岗位 JD

  // 多知识库：每个库 = 一套 简历 + 岗位 JD + 项目资料目录，面向不同岗位
  // 顶层那几个字段始终镜像"当前库"，这样几十处读取点不用改，只有切换库时才对齐
  profiles: [],
  activeProfileId: '',

  // 内部
  windowBounds: null,
};

let cache = null;

/** 知识库里跟岗位强相关的字段；顶层同名属性和它保持镜像 */
const PROFILE_FIELDS = ['resumeText', 'resumeFile', 'resumeChars', 'jd', 'projectDir'];

function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function pickProfileFields(src) {
  const out = {};
  for (const k of PROFILE_FIELDS) out[k] = src[k] == null ? '' : src[k];
  return out;
}

/** 猜一个像样的库名：优先用项目目录名，其次简历文件名 */
function guessName(cfg) {
  if (cfg.projectDir) {
    const base = path.basename(String(cfg.projectDir).replace(/[\\/]+$/, ''));
    if (base && base.length <= 20) return base;
  }
  if (cfg.resumeFile) {
    const base = String(cfg.resumeFile).replace(/\.[^.]+$/, '');
    if (base && base.length <= 20) return base;
  }
  return '默认知识库';
}

/** 保证 profiles 存在（老配置只有单套资料，这里迁移成第一个知识库） */
function ensureProfiles(cfg) {
  if (!Array.isArray(cfg.profiles) || !cfg.profiles.length) {
    const p = { id: newId(), name: guessName(cfg), ...pickProfileFields(cfg) };
    cfg.profiles = [p];
    cfg.activeProfileId = p.id;
    return cfg;
  }
  let cur = cfg.profiles.find((p) => p && p.id === cfg.activeProfileId);
  if (!cur) {
    cur = cfg.profiles[0];
    cfg.activeProfileId = cur.id;
  }
  // 库是真相源，读出来的时候把当前库镜像到顶层
  for (const k of PROFILE_FIELDS) cfg[k] = cur[k] == null ? '' : cur[k];
  return cfg;
}

/**
 * 内置通道已经去掉，老配置里的 activeRef 可能还指着 builtin，
 * 加载时统一归一到「第一个可用供应商」，没有就置空。
 */
function normalizeActiveRef(cfg) {
  const ref = cfg.activeRef;
  const list = cfg.customProviders || [];
  const valid = ref && ref.kind === 'custom' && list.some((p) => p.id === ref.providerId);
  if (valid) return cfg;
  const first = list[0];
  cfg.activeRef = first
    ? { kind: 'custom', providerId: first.id, model: (first.models || [])[0] || '' }
    : null;
  return cfg;
}

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (_) {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  // 旧版本把简历正文存在 background 里，迁移过来
  if (!cache.resumeText && saved.background) {
    cache.resumeText = saved.background;
    cache.resumeChars = saved.background.length;
  }
  return normalizeActiveRef(ensureProfiles(cache));
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] 保存失败', e.message);
  }
}

function save(patch) {
  const next = { ...load(), ...patch };
  // 顶层字段被改了（上传简历、改 JD、换项目目录），同步回当前库，避免两套数据漂移
  const cur = (next.profiles || []).find((p) => p && p.id === next.activeProfileId);
  if (cur) {
    for (const k of PROFILE_FIELDS) if (k in patch) cur[k] = next[k];
  }
  cache = next;
  persist();
  return cache;
}

/* ------------------------------------------------------- 知识库操作 */

function listProfiles() {
  const cfg = load();
  return cfg.profiles.map((p) => ({
    id: p.id,
    name: p.name || '未命名',
    active: p.id === cfg.activeProfileId,
    resumeChars: (p.resumeText || '').length,
    resumeFile: p.resumeFile || '',
    projectDir: p.projectDir || '',
    jdChars: (p.jd || '').length,
  }));
}

function createProfile(name) {
  const cfg = load();
  const p = {
    id: newId(),
    name: String(name || '新知识库').slice(0, 20),
    ...pickProfileFields({}),
  };
  cfg.profiles.push(p);
  cache = { ...cfg, profiles: cfg.profiles };
  persist();
  return p;
}

function renameProfile(id, name) {
  const cfg = load();
  const p = cfg.profiles.find((x) => x && x.id === id);
  if (!p) return false;
  p.name = String(name || '').slice(0, 20) || p.name;
  persist();
  return true;
}

function deleteProfile(id) {
  const cfg = load();
  if (cfg.profiles.length <= 1) return { ok: false, error: '至少保留一个知识库' };
  const idx = cfg.profiles.findIndex((x) => x && x.id === id);
  if (idx < 0) return { ok: false, error: '知识库不存在' };
  cfg.profiles.splice(idx, 1);
  if (cfg.activeProfileId === id) {
    cfg.activeProfileId = cfg.profiles[0].id;
    for (const k of PROFILE_FIELDS) cfg[k] = cfg.profiles[0][k] || '';
  }
  persist();
  return { ok: true };
}

/** 切换当前知识库：把目标库镜像到顶层字段 */
function switchProfile(id) {
  const cfg = load();
  const p = cfg.profiles.find((x) => x && x.id === id);
  if (!p) return { ok: false, error: '知识库不存在' };
  cfg.activeProfileId = p.id;
  for (const k of PROFILE_FIELDS) cfg[k] = p[k] || '';
  persist();
  return { ok: true };
}

function get(key) {
  return load()[key];
}

module.exports = {
  load,
  save,
  get,
  DEFAULTS,
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  switchProfile,
};
