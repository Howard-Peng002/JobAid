'use strict';
/* 新增 mockExit（退出），避免和 mockQuit（结束）共用文案 */
const fs = require('fs');
const path = require('path');

const i18nFile = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(i18nFile, 'utf8');

const ADD = {
  'zh-CN': '退出',
  'zh-TW': '退出',
  en: 'Exit',
  ja: '終了',
  ko: '나가기',
  de: 'Beenden',
  ru: 'Выйти',
  fr: 'Quitter',
  it: 'Esci',
};

let n = 0;
for (const [lang, val] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockExit:')) continue;
  block = block.replace('mockQuit:', `mockExit: '${val}',\n      mockQuit:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(i18nFile, src, 'utf8');
console.log('i18n 更新:', n, '| mockExit:', (src.match(/mockExit:/g) || []).length);

const htmlFile = path.join(__dirname, '..', 'src', 'renderer', 'console.html');
let html = fs.readFileSync(htmlFile, 'utf8');
html = html.replace(
  '<button class="ghost" id="btnMockEnd" data-i18n="mockQuit">退出</button>',
  '<button class="ghost" id="btnMockEnd" data-i18n="mockExit">退出</button>'
);
fs.writeFileSync(htmlFile, html, 'utf8');
console.log('按钮已改用 mockExit');
