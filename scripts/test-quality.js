'use strict';
/**
 * 作答质量体检：用真实配置（简历/JD/项目库）生成几条典型答案，直接打印出来看。
 * 运行：node scripts/test-quality.js [模型id]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { LlmService } = require(path.join(ROOT, 'src', 'main', 'llm.js'));

// 纯 node 环境里拿不到 Electron 的 userData，直接读真实配置文件
const CFG_PATH = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'interview-copilot', 'config.json');

const QUESTIONS = [
  '先做个自我介绍',
  '你在项目里遇到的最大困难是什么？怎么解决的',
  '为什么用 FreeRTOS，裸机跑不行吗',
];

(async () => {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const llm = new LlmService();
  const provider = (cfg.customProviders || []).find((x) => x.id === (cfg.activeRef || {}).providerId);
  if (!provider) {
    console.log('还没有配置模型供应商，先在应用里加一个');
    process.exit(1);
  }
  const model = process.argv[2] || (cfg.activeRef || {}).model || provider.models[0];

  console.log('=== 模型:', model, '| 风格:', cfg.style, '| 温度:', cfg.temperature);
  console.log('=== 简历:', (cfg.resumeText || '').length, '字 | JD:', (cfg.jd || '').length, '字');
  console.log('');

  for (const q of QUESTIONS) {
    process.stdout.write(`\n───────── 问：${q}\n`);
    const t0 = Date.now();
    let out = '';
    try {
      // 走真实联网流程（和主进程一致）
      let web = [];
      if (cfg.webSearch) {
        const query = require(path.join(ROOT, 'src', 'main', 'websearch.js')).buildQuery(q);
        if (query) {
          const ws = require(path.join(ROOT, 'src', 'main', 'websearch.js'));
          const r = await ws.search(query, { topN: cfg.webTopN || 4 });
          if (r.ok) {
            web = r.items;
            process.stdout.write(`[联网] 检索词="${query}" 命中 ${web.length} 条\n`);
          } else {
            process.stdout.write(`[联网] 跳过（${r.error}）\n`);
          }
        } else {
          process.stdout.write('[联网] 跳过（问题里没有可检索的技术名词）\n');
        }
      }
      for await (const piece of llm.streamWith({ kind: 'custom', model }, {
        question: q,
        transcript: [{ channel: 'interviewer', text: q }],
        resume: cfg.resumeText,
        jd: cfg.jd,
        style: cfg.style,
        outline: '',
        excerpts: [],
        web,
        skills: cfg.skills,
        model,
        temperature: cfg.temperature,
      }, provider)) {
        out += piece;
        process.stdout.write(piece);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`\n[${secs}s, ${out.length} 字]\n`);
    } catch (e) {
      console.log('\n[失败]', e && e.message);
    }
  }
  process.exit(0);
})();
