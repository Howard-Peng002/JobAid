'use strict';
/**
 * 大模型作答。
 *
 * 只走用户自己配置的 OpenAI 兼容接口 —— 不再内置任何厂商通道，
 * 这样软件分发给别人时用的是对方自己的账号和额度，不会消耗发布者的资源。
 */

const STYLE_HINT = {
  bullet: '用 3–5 行短句，每行不超过 24 个字，像候选人口头回答的要点提纲。',
  spoken: '写成 2–3 句连贯的口语，可以直接照着念出来，自然不生硬。',
  star: '按 STAR（情境-任务-行动-结果）组织，但每段只用一行短句，不要写"STAR"字样。',
};

/** 常见厂商的预设，省得用户自己查 Base URL 和模型名 */
const PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: '控制台 platform.deepseek.com',
  },
  {
    key: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    hint: '开放平台 platform.xiaomimimo.com',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4-plus', 'glm-4-flash'],
    hint: '控制台 open.bigmodel.cn',
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    hint: '国内站 api.minimax.cn；海外用 api.minimax.io',
  },
  {
    key: 'kimi',
    name: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.6', 'kimi-k2.5'],
    hint: '控制台 platform.moonshot.cn',
  },
  {
    key: 'custom',
    name: '其它（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    hint: '任意兼容 /v1/chat/completions 的服务，包括本地 Ollama、vLLM',
  },
];

/**
 * 输入框模式：用户是在「下指令」，不是在当面试官。
 * 这套提示词不能跟面试模式混用 —— 只要开头写"你是正在面试的候选人"，
 * 模型就会把「你能做什么」也当成面试题来答。
 */
function buildManualSystem({ resume, jd, style, skills }) {
  const lines = [
    '你是 JobAid，一个跑在桌面上的面试辅助工具，同时也是懂技术的求职助理。',
    '用户会在输入框里向你下指令，常见的是：改写/润色/精简某段话、总结、翻译、解释一个概念、做面试准备计划、问你能做什么，或者直接贴一道面试题让你给作答草稿。',
    '',
    '规则：',
    '1. 直接执行要求，不要寒暄、不要复述指令、不要解释你打算怎么做。',
    '2. 让你改写/润色/精简某段话时：只输出改写后的版本本身，不要加"好的""以下是"这类前缀，也不要点评改动。',
    '3. 让你解释概念、做计划、给建议时：直接给结论和可执行的下一步，别铺陈。',
    '4. 问你自己的能力/用法时：以 JobAid 助手身份直接说明功能，不要扮演求职者。',
    `5. 只有当用户贴的确实是一道面试题时，才按候选人第一人称给作答草稿。${STYLE_HINT[style] || STYLE_HINT.bullet}`,
    '6. 作答时严禁编造简历里没有的经历、数字、公司名；资料里没有的细节用「我之前做过的一个项目」这类占位写法。',
    '7. 不要使用 Markdown 标题、加粗星号、代码块。纯文本。中文回答，除非要求英文。',
  ];
  if (resume && resume.trim()) {
    lines.push('', '【用户简历（改写或作答时的唯一事实来源）】', resume.trim().slice(0, 6000));
  }
  if (jd && jd.trim()) {
    lines.push('', '【目标岗位 JD】', jd.trim().slice(0, 1500));
  }
  const enabled = (skills || []).filter((s) => s && s.enabled && s.prompt);
  if (enabled.length) {
    lines.push('', '【用户启用的偏好】');
    enabled.forEach((s) => lines.push(`- ${s.name}：${s.prompt}`));
  }
  return lines.join('\n');
}

// 用户在问"这个工具能干什么"。这类问题靠提示词很难压住"候选人"人格，直接走专用分支。
const SELF_ASK = /(你能做什么|你会做什么|你有什么功能|有哪些功能|怎么用你|如何使用|怎么使用|你是谁|介绍一下你自己|你能干嘛|能帮我做什么)/;

function buildSelfSystem() {
  return [
    '你是 JobAid，一个桌面端的面试实时辅助工具。用户正在问你能做什么，直接用助手身份介绍，不要扮演求职者、不要提用户简历。',
    '',
    '你的主要能力（用简洁的几条说明，不要写成一整段）：',
    '1. 实时听：采集系统声音（面试官）和麦克风（你自己），本地离线语音识别，音频不出本机。',
    '2. 自动作答：判断面试官是否在提问，用大模型生成可以直接念出来的作答草稿，显示在浮窗里。',
    '3. 浮窗防窥：悬浮窗对屏幕共享、录屏不可见，可拖动、可调透明度、可一键隐藏。',
    '4. 有记忆：可以导入简历、JD、项目文件夹，作答会引用你的真实经历，不会瞎编。',
    '5. 手动提问：就是这个输入框，可以粘贴面试题让它作答，也可以让它帮你改写简历、解释概念、制定准备计划。',
    '6. 其它：历史记录、全局快捷键（Ctrl+Shift+H 显隐浮窗、M 开关监听、O 开控制台、J 重新作答）。',
    '',
    '不要说"我能做嵌入式开发"这类求职者口吻的话。',
    '不要写"这个问题有点歧义""我理解为…"这类元评论，第一句就必须是 JobAid 的身份声明。',
    '不要使用 Markdown 加粗星号、标题、代码块，纯文本，每条一行。',
  ].join('\n');
}

function buildSystem({ question, resume, jd, style, outline, skills, manual }) {
  if (manual && SELF_ASK.test(String(question || ''))) return buildSelfSystem();
  if (manual) return buildManualSystem({ resume, jd, style, skills });

  const lines = [
    '你是「JobAid」，正在以候选人的第一视角参加一场真实的求职面试。',
    '你的唯一任务：针对面试官的最后一句提问，给出一份候选人"看一眼就能开口说"的作答草稿。',
    '',
    '硬性规则：',
    '1. 只输出作答内容本身。不要寒暄、不要复述问题、不要解释你在做什么、不要写"回答："这类前缀。',
    `2. ${STYLE_HINT[style] || STYLE_HINT.bullet}`,
    '3. 第一人称、口语化。不要书面语堆砌，不要排比句，不要空话套话。',
    '4. 严禁编造简历与项目资料里没有的经历、数字、公司名、项目名。资料里没有的细节，用「我之前做过的一个项目」这类占位写法。',
    '5. 如果最后一句只是陈述、寒暄或面试官在自言自语，不是提问，就只输出一个字符：—',
    '6. 技术题/算法题：第一行一句话给思路，之后每行一个关键步骤，不要写代码块、不要贴代码。',
    '7. 不要使用 Markdown 标题、加粗星号、代码块。纯文本，用换行分隔。',
    '8. 中文回答。除非问题本身是英文。',
  ];
  if (resume && resume.trim()) {
    lines.push('', '【候选人简历（作答必须与此一致，优先引用其中的真实项目与数据）】', resume.trim().slice(0, 6000));
  }
  if (jd && jd.trim()) {
    lines.push('', '【应聘岗位 JD（作答尽量贴合岗位要求的关键词）】', jd.trim().slice(0, 1500));
  }
  if (outline && outline.trim()) {
    lines.push('', '【候选人项目资料库目录（需要细节时会给出摘录）】', outline.trim().slice(0, 1200));
  }
  const enabled = (skills || []).filter((s) => s && s.enabled && s.prompt);
  if (enabled.length) {
    lines.push('', '【本轮启用的技能（优先遵守）】');
    enabled.forEach((s) => lines.push(`- ${s.name}：${s.prompt}`));
  }
  return lines.join('\n');
}

function buildUser({ question, transcript, excerpts, web }) {
  const recent = (transcript || [])
    .slice(-10)
    .map((t) => `${t.channel === 'interviewer' ? '面试官' : '我'}：${t.text}`)
    .join('\n');

  const parts = ['【最近对话】', recent || '（无）', '', `【面试官最后一句】${question}`, ''];

  if (excerpts && excerpts.length) {
    parts.push('【候选人项目资料摘录（与本次提问最相关的片段，可作为作答依据）】');
    excerpts.forEach((e, i) => {
      parts.push(`--- 片段 ${i + 1}（来自 ${e.file}）---`, e.text, '');
    });
  }
  if (web && web.length) {
    parts.push('【网络检索结果（自动检索的网页摘要，可能与问题无关。只在与提问确实相关时用作事实依据；无关的内容直接忽略，绝不要被它带偏或引用它的措辞。）】');
    web.forEach((w, i) => parts.push(`${i + 1}. ${w.title} —— ${w.snippet}（${w.url}）`));
    parts.push('');
  }
  parts.push('请针对最后一句，给出作答草稿。');
  return parts.join('\n');
}

/* --------------------------------- 自定义供应商（OpenAI 兼容协议） */

/**
 * 把用户填的 Base URL 规范成完整的 chat/completions 地址。
 * 兼容这几种写法：
 *   https://api.deepseek.com            → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1         → https://api.deepseek.com/v1/chat/completions
 *   http://localhost:11434/v1/chat/completions → 原样使用
 */
function normalizeEndpoint(input) {
  const u = String(input || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+(\.\d+)?$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

function explainHttpError(status, detail) {
  const hint =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? '接口地址不对，检查 Base URL（多数服务要带 /v1）'
        : status === 429
          ? '请求过于频繁或余额不足'
          : status >= 500
            ? '服务端错误，稍后重试'
            : `HTTP ${status}`;
  const tail = detail ? `：${detail}` : '';
  return new Error(hint + tail);
}

/** 走 OpenAI 兼容接口做流式生成 */
async function* streamOpenAI({ baseUrl, apiKey, model, messages, temperature, signal, maxTokens }) {
  const url = normalizeEndpoint(baseUrl);
  if (!url) throw new Error('还没有填写 Base URL');
  if (!model) throw new Error('还没有填写模型名');

  const payload = {
    model,
    messages,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : 0.5,
  };
  if (maxTokens) payload.max_tokens = maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (_) {}
    throw explainHttpError(res.status, detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) yield d.content;
      } catch (_) {
        // 有的服务会插空行或心跳，忽略即可
      }
    }
  }
}

function explainNetworkError(e) {
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  if (code === 'ECONNREFUSED') return '连接被拒绝，检查 Base URL 的域名和端口';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，检查 Base URL 拼写和网络';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时，检查网络或代理';
  if (/certificate|SSL|TLS/i.test(String(e && e.message))) return '证书校验失败，检查是否用了 http 或自签证书';
  if (e && e.name === 'AbortError') return '已取消';
  return (e && e.message) || String(e);
}

/** 非流式调用：出题、评分这类需要完整 JSON 的场景用它 */
async function completeOpenAI({ baseUrl, apiKey, model, messages, temperature, maxTokens, signal }) {
  const url = normalizeEndpoint(baseUrl);
  if (!url) throw new Error('还没有填写 Base URL');
  if (!model) throw new Error('还没有填写模型名');

  const payload = {
    model,
    messages,
    stream: false,
    temperature: typeof temperature === 'number' ? temperature : 0.3,
  };
  if (maxTokens) payload.max_tokens = maxTokens;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch (_) {}
    throw explainHttpError(res.status, detail);
  }

  const json = await res.json();
  const choice = json && json.choices && json.choices[0];
  const msg = choice && choice.message;
  let content = (msg && msg.content) || '';
  // 少数服务把内容放在数组里
  if (!content && msg && Array.isArray(msg.content)) {
    content = msg.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
  }
  if (!String(content).trim()) {
    // 推理型模型（如 deepseek-v4-pro）会先烧一大段 reasoning，预算不够时正文直接为空，
    // 这里必须说清楚，否则上层只能拿到空串然后莫名其妙地解析失败
    const used = (json && json.usage && json.usage.completion_tokens_details && json.usage.completion_tokens_details.reasoning_tokens) || 0;
    if (choice.finish_reason === 'length' || used > 0) {
      throw new Error(
        `模型把输出预算耗在思考上了（推理 token ${used}），没有产出正文。换一个非推理模型（如 deepseek-chat），或调大输出上限。`
      );
    }
    throw new Error('模型没有返回内容');
  }
  return content;
}

/** 从模型输出里抠出 JSON（有的模型会包 ```json 或加解释文字） */
function parseJsonLoose(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/** 试连通性：发一句最短的话，看能不能拿到回复 */
async function testProvider(p) {
  const t0 = Date.now();
  const model = (p && p.models && p.models[0]) || (p && p.model) || '';
  if (!model) return { ok: false, error: '没有填写模型名' };
  try {
    let got = '';
    for await (const piece of streamOpenAI({
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model,
      messages: [{ role: 'user', content: '回复"ok"即可' }],
      temperature: 0,
      maxTokens: 8,
    })) {
      got += piece;
      if (got.length > 24) break;
    }
    return { ok: true, sample: got.trim().slice(0, 40), latency: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: explainNetworkError(e), latency: Date.now() - t0 };
  }
}

class LlmService {
  /** 统一的提示词构造 */
  buildMessages(payload) {
    const { question, transcript, resume, jd, style, outline, excerpts, web, skills, manual } = payload;
    return [
      { role: 'system', content: buildSystem({ question, resume, jd, style, outline, skills, manual }) },
      { role: 'user', content: buildUser({ question, transcript, excerpts, web }) },
    ];
  }

  /**
   * 走用户配置的供应商。没有配置就明确报错，不要静默失败。
   * @param {{kind:'custom', providerId?:string, model?:string}} ref
   * @param {object} payload 提示词素材
   * @param {{baseUrl:string, apiKey:string, models:string[]}} provider
   */
  async *streamWith(ref, payload, provider) {
    if (!provider || !provider.baseUrl) {
      throw new Error('还没有配置模型：请到左侧「模型」页添加一个供应商');
    }
    const messages = this.buildMessages(payload);
    const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.5;
    const model = (ref && ref.model) || (provider.models && provider.models[0]) || '';
    yield* streamOpenAI({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      messages,
      temperature,
      signal: payload.signal,
    });
  }
}

function friendlyError(e) {
  if (e && e.name === 'AbortError') return '已取消';
  const msg = (e && e.message) || '';
  return msg || '生成失败';
}

module.exports = {
  LlmService,
  friendlyError,
  streamOpenAI,
  completeOpenAI,
  parseJsonLoose,
  testProvider,
  normalizeEndpoint,
  PROVIDER_PRESETS,
};
