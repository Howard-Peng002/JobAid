'use strict';
/* 补通话界面文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['静音', '结束面试'],
  'zh-TW': ['靜音', '結束面試'],
  en: ['Mute', 'End interview'],
  ja: ['ミュート', '面接を終了'],
  ko: ['음소거', '면접 종료'],
  de: ['Stumm', 'Interview beenden'],
  ru: ['Без звука', 'Завершить'],
  fr: ['Muet', 'Terminer'],
  it: ['Muto', 'Termina'],
};

let n = 0;
for (const [lang, [a, b]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockMute:')) continue;
  block = block.replace('mockExit:', `mockMute: '${a}',\n      mockEndCall: '${b}',\n      mockExit:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(file, src, 'utf8');
console.log('更新:', n, '| mockMute:', (src.match(/mockMute:/g) || []).length);
