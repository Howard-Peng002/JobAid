'use strict';
/* 文案改成「后台隐藏」 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['后台隐藏', '开启后任务栏和托盘都不显示，按 Ctrl+Shift+O 找回'],
  'zh-TW': ['後台隱藏', '開啟後工作列和托盤都不顯示，按 Ctrl+Shift+O 找回'],
  en: ['Hide in background', 'Hides taskbar and tray. Press Ctrl+Shift+O to return.'],
  ja: ['バックグラウンドで隠す', 'タスクバーとトレイを非表示。Ctrl+Shift+O で戻れます。'],
  ko: ['백그라운드 숨김', '작업 표시줄과 트레이를 숨깁니다. Ctrl+Shift+O 로 복귀.'],
  de: ['Im Hintergrund ausblenden', 'Taskleiste und Tray ausblenden. Ctrl+Shift+O zum Zurückholen.'],
  ru: ['Скрыть в фоне', 'Скрывает панель задач и трей. Ctrl+Shift+O — вернуться.'],
  fr: ['Masquer en arrière-plan', 'Masque la barre des tâches et le tray. Ctrl+Shift+O pour revenir.'],
  it: ['Nascondi in background', 'Nasconde barra delle applicazioni e tray. Ctrl+Shift+O per tornare.'],
};

let n = 0;
for (const [lang, [a, b]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (!block.includes('fullStealth:')) continue;
  block = block.replace(/fullStealth: '[^']*'/, `fullStealth: '${a}'`);
  block = block.replace(/fullStealthHint: '[^']*'/, `fullStealthHint: '${b}'`);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}
fs.writeFileSync(file, src, 'utf8');
console.log('更新:', n);
