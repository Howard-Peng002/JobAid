'use strict';
/**
 * 简历解析 + 项目资料库检索的端到端自检。
 * 会自动造一份 DOCX 和一份 PDF（含中文），再建一个假项目目录，最后验证召回是否命中。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { extractText } = require('../src/main/docparse');
const { ProjectIndex } = require('../src/main/projectindex');

const TMP = path.join(os.tmpdir(), 'ic-test-' + Date.now());

function docx(paragraphs) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

async function makeDocx(file, paragraphs) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file('word/document.xml', docx(paragraphs));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makePdf(file) {
  const win = new BrowserWindow({ show: false, width: 800, height: 1000 });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:"Microsoft YaHei",sans-serif;font-size:16px;line-height:1.8;padding:36px}
    h1{font-size:22px} li{margin:4px 0}
  </style></head><body>
    <h1>张明 · 后端工程师</h1>
    <p>五年服务端经验，主要方向为高并发交易系统与风控引擎。</p>
    <ul>
      <li>主导订单中心重构，把下单链路从 800 QPS 提升到 4200 QPS。</li>
      <li>设计信贷风控规则引擎，支持热更新，规则上线从两天缩短到十分钟。</li>
      <li>负责支付对账平台，日均处理 1200 万笔流水，差错率降到十万分之一。</li>
    </ul>
    <p>熟悉 Kafka、Redis、MySQL 分库分表，能在高峰期做容量评估与降级预案。</p>
  </body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const buf = await win.webContents.printToPDF({ printBackground: true });
  fs.writeFileSync(file, buf);
  win.destroy();
}

function write(rel, content) {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function assert(name, cond, detail) {
  console.log(`${cond ? '  OK  ' : ' FAIL '} ${name}${detail ? '  —— ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  console.log('临时目录:', TMP, '\n');

  /* ---------------- 1. DOCX ---------------- */
  console.log('=== 1. DOCX 解析 ===');
  const docxFile = path.join(TMP, 'resume.docx');
  await makeDocx(docxFile, [
    '李雷 · 高级前端工程师',
    '四年经验，负责过三个中后台系统从零搭建。',
    '主导组件库建设，把页面平均开发工时从 3 天压到 8 小时。',
  ]);
  const dx = await extractText(docxFile);
  console.log('  提取到:', JSON.stringify(dx.text.slice(0, 60)) + '…');
  assert('DOCX 提取出中文', dx.text.includes('高级前端工程师') && dx.kind === 'docx', `${dx.text.length} 字`);

  /* ---------------- 2. PDF ---------------- */
  console.log('\n=== 2. PDF 解析 ===');
  const pdfFile = path.join(TMP, 'resume.pdf');
  await makePdf(pdfFile);
  const pd = await extractText(pdfFile);
  console.log('  提取到:', JSON.stringify(pd.text.slice(0, 60).replace(/\n/g, ' ')) + '…');
  assert('PDF 提取出中文', pd.text.includes('订单中心') || pd.text.includes('风控'), `${pd.text.length} 字 / ${pd.pages || 0} 页`);

  /* ---------------- 3. 资料库建索引 ---------------- */
  console.log('\n=== 3. 资料库索引 ===');
  write(
    '信贷风控项目/README.md',
    `# 信贷风控规则引擎

## 背景
老系统规则写死在代码里，每次调整都要发版，平均两天才能上线一条规则。

## 方案
把规则抽成 DSL，运营在后台配置表达式，引擎用 Drools 编译执行。
规则变更通过配置中心推送，热更新不重启服务。

## 结果
单条规则上线时间从两天降到十分钟；支持每秒 3000 次规则命中；误杀率下降 40%。`
  );
  write(
    '信贷风控项目/src/rule_engine.java',
    `public class RuleEngine {
    // 使用 drools 做规则匹配，支持热更新
    public Decision evaluate(ApplyContext ctx) {
        KieSession session = container.newKieSession();
        session.insert(ctx);
        session.fireAllRules();
        return ctx.decision;
    }
}`
  );
  write(
    '电商订单项目/README.md',
    `# 订单中心重构

把下单链路拆成预校验、库存预占、创建订单三段，用 Kafka 削峰。
峰值从 800 QPS 提到 4200 QPS，大促期间没有出现超卖。`
  );
  write('乱七八糟/会议记录.txt', '周一例会：讨论了团建地点和下午茶预算，没有技术结论。');

  const idxFile = path.join(os.tmpdir(), 'ic-index-' + Date.now() + '.json');
  const idx = new ProjectIndex(idxFile);
  const stats = await idx.build(TMP, () => {});
  console.log('  索引结果:', JSON.stringify(stats));
  assert('索引到文件', stats.files >= 5, `${stats.files} 文件 / ${stats.chunks} 段`);
  assert('索引可缓存到磁盘', fs.existsSync(idxFile));

  /* ---------------- 4. 检索 ---------------- */
  console.log('\n=== 4. 按提问召回 ===');
  const cases = [
    ['你们的风控规则引擎是怎么做到热更新的？', '信贷风控项目'],
    ['订单系统怎么扛住大促峰值的？', '电商订单项目'],
    ['规则引擎用的什么技术栈？', '信贷风控项目'],
  ];
  for (const [q, expect] of cases) {
    const hits = idx.retrieve(q, { topK: 3 });
    const top = hits[0];
    const ok = !!top && top.file.includes(expect);
    console.log(`  问：${q}`);
    hits.forEach((h, i) => console.log(`     ${i + 1}. ${h.file} (${h.score})`));
    assert(`命中「${expect}」`, ok, top ? 'top1=' + top.file : '无结果');
  }

  const javaHit = idx.retrieve('RuleEngine 这个类怎么实现规则匹配的', { topK: 3 });
  console.log('  代码文件召回:', javaHit.map((h) => h.file).join(', ') || '（无）');
  assert('能召回到代码文件', javaHit.some((h) => h.file.endsWith('.java')));

  const noise = idx.retrieve('团建去哪里比较好', { topK: 2 });
  console.log('  无关提问的召回:', noise.map((n) => n.file).join(', ') || '（无）');

  /* ---------------- 5. 增量重建 ---------------- */
  console.log('\n=== 5. 增量重建 ===');
  const t0 = Date.now();
  const s2 = await idx.build(TMP, () => {});
  assert('重复建索引结果一致', s2.files === stats.files && s2.chunks === stats.chunks, `${Date.now() - t0}ms`);

  /* ---------------- 6. 目录概览 ---------------- */
  console.log('\n=== 6. 给模型看的目录概览 ===');
  console.log(idx.outline().split('\n').map((l) => '  ' + l).join('\n'));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  setTimeout(() => app.quit(), 200);
});
