'use strict';
/* 补 mockEnd（结束面试）文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': '结束面试',
  'zh-TW': '結束面試',
  en: 'End interview',
  ja: '面接を終了',
  ko: '면접 종료',
  de: 'Interview beenden',
  ru: 'Завершить интервью',
  fr: 'Terminer l’entretien',
  it: 'Termina colloquio',
};

let n = 0;
for (const [lang, val] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockEnd:')) continue;
  block = block.replace('mockQuit:', `mockEnd: '${val}',\n      mockQuit:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}

fs.writeFileSync(file, src, 'utf8');
console.log('已更新:', n, '| mockEnd 出现:', (src.match(/mockEnd:/g) || []).length);
