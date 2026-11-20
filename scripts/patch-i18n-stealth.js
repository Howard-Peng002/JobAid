'use strict';
/* 补完全隐身相关文案 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['完全隐身', '连托盘图标一起隐藏，按 Ctrl+Shift+O 找回'],
  'zh-TW': ['完全隱身', '連托盤圖示一起隱藏，按 Ctrl+Shift+O 找回'],
  en: ['Full stealth', 'Hides the tray icon too. Press Ctrl+Shift+O to return.'],
  ja: ['完全ステルス', 'タスクトレイも隠します。Ctrl+Shift+O で戻れます。'],
  ko: ['완전 숨김', '트레이 아이콘도 숨깁니다. Ctrl+Shift+O 로 복귀.'],
  de: ['Vollständig unsichtbar', 'Auch Tray-Symbol ausblenden. Ctrl+Shift+O zum Zurückholen.'],
  ru: ['Полная скрытность', 'Скрывает и значок в трее. Ctrl+Shift+O — вернуться.'],
  fr: ['Furtivité totale', 'Masque aussi l’icône. Ctrl+Shift+O pour revenir.'],
  it: ['Modalità invisibile', 'Nasconde anche l’icona. Ctrl+Shift+O per tornare.'],
};

let n = 0;
for (const [lang, [a, b]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('fullStealth:')) continue;
  block = block.replace('guard:', `fullStealth: '${a}',\n      fullStealthHint: '${b}',\n      guard:`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(file, src, 'utf8');
console.log('更新:', n, '| fullStealth:', (src.match(/fullStealth:/g) || []).length);
