'use strict';
/* 补齐模拟面试新增文案（类型/方式/上下题/语音） */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['面试类型', '作答方式', '技术面试', 'HR 面试', '文字作答', '语音作答', '重听', '按住说话', '上一题', '下一题', '提交作答'],
  'zh-TW': ['面試類型', '作答方式', '技術面試', 'HR 面試', '文字作答', '語音作答', '重聽', '按住說話', '上一題', '下一題', '提交作答'],
  en: ['Interview type', 'Answer mode', 'Technical', 'HR', 'Written', 'Voice', 'Replay', 'Hold to talk', 'Previous', 'Next', 'Submit answers'],
  ja: ['面接の種類', '回答方法', '技術面接', 'HR 面接', '文字入力', '音声入力', 'もう一度聞く', '押して話す', '前へ', '次へ', '回答を提出'],
  ko: ['면접 유형', '답변 방식', '기술 면접', 'HR 면접', '텍스트', '음성', '다시 듣기', '눌러서 말하기', '이전', '다음', '답변 제출'],
  de: ['Interview-Typ', 'Antwortmodus', 'Technisch', 'HR', 'Schriftlich', 'Sprache', 'Erneut hören', 'Zum Sprechen halten', 'Zurück', 'Weiter', 'Antworten senden'],
  ru: ['Тип интервью', 'Способ ответа', 'Техническое', 'HR', 'Текстом', 'Голосом', 'Прослушать', 'Удерживайте', 'Назад', 'Далее', 'Отправить'],
  fr: ['Type d’entretien', 'Mode de réponse', 'Technique', 'RH', 'Écrit', 'Voix', 'Réécouter', 'Maintenir pour parler', 'Précédent', 'Suivant', 'Envoyer'],
  it: ['Tipo di colloquio', 'Modalità risposta', 'Tecnico', 'HR', 'Scritto', 'Voce', 'Riascolta', 'Tieni premuto', 'Indietro', 'Avanti', 'Invia risposte'],
};

let n = 0;
for (const [lang, arr] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) continue;
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockType:')) continue;
  const [a, b, c, d, e, f, g, h, i, j, k] = arr;
  const inject = [
    `mockType: '${a}',`,
    `      mockMode: '${b}',`,
    `      mockTech: '${c}',`,
    `      mockHr: '${d}',`,
    `      mockText: '${e}',`,
    `      mockVoice: '${f}',`,
    `      mockReplay: '${g}',`,
    `      mockSpeak: '${h}',`,
    `      mockPrev: '${i}',`,
    `      mockNext: '${j}',`,
    `      mockFinish: '${k}',`,
    '      mock:',
  ].join('\n');
  block = block.replace('mock:', inject);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}

fs.writeFileSync(file, src, 'utf8');
console.log('已更新:', n, '| mockType 出现:', (src.match(/mockType:/g) || []).length);
