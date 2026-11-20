'use strict';
/* 把 main.js 里的模拟面试模块整体替换成支持「文字/语音」+「HR/技术」+「草稿编辑、最后统一评分」的版本 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'main', 'main.js');
let src = fs.readFileSync(file, 'utf8');

const START = 'function mockSnapshot() {';
const END_MARK = "ipcMain.handle('mock:reset', async () => {";
const s = src.indexOf(START);
const e = src.indexOf(END_MARK);
if (s < 0 || e < 0) {
  console.log('定位失败', s, e);
  process.exit(1);
}
// 找到 reset handler 的结尾（下一个空白行 + 注释）
const after = src.indexOf('\n});', e) + 4;

const BLOCK = `function mockSnapshot() {
  if (!mockRun) return { active: false };
  const cur = mockRun.items[mockRun.idx] || null;
  return {
    active: true,
    mode: mockRun.mode,
    type: mockRun.type,
    total: mockRun.items.length,
    index: mockRun.idx,
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
  const n = Math.min(8, Math.max(3, Number(d.count) || 5));
  const type = d.type === 'hr' ? 'hr' : 'tech';
  const mode = d.mode === 'voice' ? 'voice' : 'text';
  const resume = (cfg.resumeText || '').slice(0, 2000);
  const jd = (cfg.jd || '').slice(0, 1500);
  if (!resume.trim()) throw new Error('这个知识库还没有简历，先去「知识库」导入');

  const prompt = [
    \`岗位：\${jdTitle}\`,
    jd ? \`岗位要求：\\n\${jd}\` : '',
    \`候选人简历：\\n\${resume}\`,
    '',
    \`请出一场\${type === 'hr' ? 'HR' : '技术'}面试的 \${n} 个问题。要求：\`,
    \`- 重点覆盖：\${MOCK_FOCUS[type]}\`,
    '- 由浅入深，每题能在 1-2 分钟内口头答完',
    type === 'tech' ? '- 结合简历里的具体项目提问，不要问空泛通用题' : '- 结合简历里的具体经历提问，不要问空泛通用题',
    '- 不要编号、不要任何解释',
    '',
    '只输出 JSON：{"questions":["问题1","问题2"]}',
  ]
    .filter(Boolean)
    .join('\\n');

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
      .split('\\n')
      .map((s) => s.replace(/^\\s*[\\d一二三四五六七八九十]+[.、)）]\\s*/, '').replace(/^[\\s"'\\[\\]{},]+|[\\s"',]+$/g, '').trim())
      .filter((s) => s.length > 6 && s.length < 200)
      .filter((s) => !/^"?questions"?\\s*:?\\s*\\[?$/i.test(s) && !/^[\\[\\]{},]+$/.test(s));
  }
  questions = questions.filter(Boolean).slice(0, n);
  if (!questions.length) throw new Error('模型没有返回有效问题，稍后再试一次');

  mockRun = {
    startedAt: Date.now(),
    type,
    mode,
    idx: 0,
    finished: false,
    scoring: null,
    items: questions.map((q) => ({ q, a: '', score: null, dims: null, comment: '', better: '' })),
    report: null,
  };
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
  broadcastMock();
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
    \`面试问题：\${item.q}\`,
    '',
    \`候选人的回答：\${(item.a || '').slice(0, 3000) || '（未作答）'}\`,
    '',
    '请评估这个回答，从四个维度打分（0-100）：',
    '- depth：技术深度，是否说到关键细节和取舍',
    '- clarity：表达清晰度，是否啰嗦、有没有跑题',
    '- structure：结构完整度，是否有层次、有结论',
    '- match：岗位匹配度，是否贴合岗位要求',
    '',
    '只输出 JSON：',
    '{"score":0-100,"dims":{"depth":0,"clarity":0,"structure":0,"match":0},"comment":"一句话点评，40字以内","better":"一句话改进方向，40字以内"}',
  ].join('\\n');

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
async function mockFinish() {
  if (!mockRun) throw new Error('还没有开始模拟面试');
  if (mockRun.finished) return mockSnapshot();
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
        \`Q\${i + 1}: \${x.q}\\n得分 \${x.score}（深度\${x.dims.depth}/清晰\${x.dims.clarity}/结构\${x.dims.structure}/匹配\${x.dims.match}）\\n回答：\${(x.a || '未作答').slice(0, 300)}\`
    )
    .join('\\n\\n');

  const prompt = [
    \`以下是一场\${mockRun.type === 'hr' ? 'HR' : '技术'}面试的问答与得分：\`,
    '',
    digest,
    '',
    \`总分 \${total}，四维均分：深度\${dimsAvg.depth}、清晰\${dimsAvg.clarity}、结构\${dimsAvg.structure}、匹配\${dimsAvg.match}\`,
    '',
    '请给出候选人画像，只输出 JSON：',
    '{"level":"一句话定位，如\\\\"基础扎实但表达偏啰嗦\\\\"",',
    '"strengths":["2-3 条具体强项，基于回答内容，不要空话"],',
    '"weaknesses":["2-3 条具体薄弱项，指出是哪个回答暴露的"],',
    '"advice":["2-3 条可执行的改进建议"]}',
  ].join('\\n');

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

ipcMain.handle('mock:finish', async () => {
  try {
    return { ok: true, state: await mockFinish() };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('mock:state', async () => mockSnapshot());

ipcMain.handle('mock:reset', async () => {
  mockRun = null;
  broadcastMock();
  return { ok: true };
});
`;

src = src.slice(0, s) + BLOCK + src.slice(after);
fs.writeFileSync(file, src, 'utf8');
console.log('替换完成，新长度', src.length);
