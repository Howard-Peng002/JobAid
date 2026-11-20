'use strict';
/* 一次性补丁：给 9 个语言包补上 uiOpacity / appControl / quitApp / quitConfirm */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['界面透明度', '程序', '退出 JobAid', '退出 JobAid？正在进行的面试将结束。'],
  'zh-TW': ['介面透明度', '程式', '結束 JobAid', '結束 JobAid？進行中的面試將結束。'],
  en: ['Window opacity', 'App', 'Quit JobAid', 'Quit JobAid? The session in progress will end.'],
  ja: ['画面の透明度', 'アプリ', 'JobAid を終了', 'JobAid を終了しますか？進行中の面接は終了します。'],
  ko: ['창 투명도', '앱', 'JobAid 종료', 'JobAid를 종료할까요? 진행 중인 면접이 끝납니다.'],
  de: ['Fensterdeckkraft', 'App', 'JobAid beenden', 'JobAid beenden? Die laufende Sitzung wird beendet.'],
  ru: ['Прозрачность окна', 'Приложение', 'Выйти из JobAid', 'Выйти из JobAid? Текущая сессия завершится.'],
  fr: ['Opacité de la fenêtre', 'Application', 'Quitter JobAid', 'Quitter JobAid ? La session en cours sera terminée.'],
  it: ['Opacità finestra', 'App', 'Esci da JobAid', 'Uscire da JobAid? La sessione in corso terminerà.'],
};

let count = 0;
for (const [lang, [a, b, c, d]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) {
    console.log('未找到语言包:', lang);
    continue;
  }
  const end = src.indexOf('\n    },', start);
  if (end < 0) {
    console.log('未找到包结尾:', lang);
    continue;
  }
  let block = src.slice(start, end);
  if (block.includes('uiOpacity:')) continue;
  const injected = [
    `uiOpacity: '${a}',`,
    `      appControl: '${b}',`,
    `      quitApp: '${c}',`,
    `      quitConfirm: '${d}',`,
    '      guardOn:',
  ].join('\n');
  block = block.replace('guardOn:', injected);
  src = src.slice(0, start) + block + src.slice(end);
  count++;
}

fs.writeFileSync(file, src, 'utf8');
console.log('已更新语言包:', count, '| uiOpacity 出现次数:', (src.match(/uiOpacity:/g) || []).length);
