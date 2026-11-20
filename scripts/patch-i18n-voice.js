'use strict';
/* 补音色相关文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['面试官音色', '试听'],
  'zh-TW': ['面試官音色', '試聽'],
  en: ['Interviewer voice', 'Preview'],
  ja: ['面接官の声', '試聴'],
  ko: ['면접관 음성', '미리 듣기'],
  de: ['Stimme', 'Anhören'],
  ru: ['Голос интервьюера', 'Прослушать'],
  fr: ['Voix', 'Écouter'],
  it: ['Voce', 'Ascolta'],
};

let n = 0;
for (const [lang, [a, b]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockVoiceStyle:')) continue;
  block = block.replace('mockMode:', `mockVoiceStyle: '${a}',\n      mockPreview: '${b}',\n      mockMode:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(file, src, 'utf8');
console.log('更新:', n, '| mockVoiceStyle:', (src.match(/mockVoiceStyle:/g) || []).length);
