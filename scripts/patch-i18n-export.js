'use strict';
/* 一次性补丁：给 9 个语言包补上面经相关文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['面经', '导出格式', '导出本场面经'],
  'zh-TW': ['面經', '匯出格式', '匯出本場面經'],
  en: ['Interview notes', 'Format', 'Export this session'],
  ja: ['面接ノート', '形式', 'このセッションを書き出す'],
  ko: ['면접 기록', '형식', '이 세션 내보내기'],
  de: ['Interview-Notizen', 'Format', 'Diese Sitzung exportieren'],
  ru: ['Заметки о собеседовании', 'Формат', 'Экспортировать сессию'],
  fr: ['Notes d’entretien', 'Format', 'Exporter cette session'],
  it: ['Note del colloquio', 'Formato', 'Esporta questa sessione'],
};

let n = 0;
for (const [lang, [a, b, c]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) {
    console.log('未找到:', lang);
    continue;
  }
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('interviewNotes')) continue;
  const inject = [
    `interviewNotes: '${a}',`,
    `      exportFormat: '${b}',`,
    `      exportNow: '${c}',`,
    '      uiOpacity:',
  ].join('\n');
  block = block.replace('uiOpacity:', inject);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}

fs.writeFileSync(file, src, 'utf8');
console.log('已更新:', n, '| interviewNotes 出现:', (src.match(/interviewNotes:/g) || []).length);
