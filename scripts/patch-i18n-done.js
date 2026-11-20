'use strict';
/* 补「我说完了」文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': '我说完了',
  'zh-TW': '我說完了',
  en: 'I’m done',
  ja: '話し終わりました',
  ko: '말 다 했어요',
  de: 'Ich bin fertig',
  ru: 'Я закончил',
  fr: 'J’ai terminé',
  it: 'Ho finito',
};

let n = 0;
for (const [lang, val] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockDoneSpeak:')) continue;
  block = block.replace('mockMute:', `mockDoneSpeak: '${val}',\n      mockMute:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(file, src, 'utf8');
console.log('更新:', n, '| mockDoneSpeak:', (src.match(/mockDoneSpeak:/g) || []).length);
