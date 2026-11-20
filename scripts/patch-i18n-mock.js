'use strict';
/* 补齐模拟面试相关文案（9 种语言） */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'renderer', 'i18n.js');
let src = fs.readFileSync(file, 'utf8');

const ADD = {
  'zh-CN': ['模拟面试', '题目数量', '开始模拟面试', '结束', '提交回答', '再来一场', '在这里写下你的回答，说完再提交…'],
  'zh-TW': ['模擬面試', '題目數量', '開始模擬面試', '結束', '提交回答', '再來一場', '在這裡寫下你的回答，說完再提交…'],
  en: ['Mock interview', 'Questions', 'Start mock interview', 'End', 'Submit answer', 'Start over', 'Type your answer here…'],
  ja: ['模擬面接', '問題数', '模擬面接を開始', '終了', '回答を送信', 'もう一度', 'ここに回答を入力してください…'],
  ko: ['모의 면접', '문항 수', '모의 면접 시작', '종료', '답변 제출', '다시 하기', '여기에 답변을 작성하세요…'],
  de: ['Probeinterview', 'Fragen', 'Probeinterview starten', 'Beenden', 'Antwort senden', 'Nochmal', 'Antwort hier eingeben…'],
  ru: ['Пробное интервью', 'Вопросов', 'Начать интервью', 'Завершить', 'Отправить ответ', 'Ещё раз', 'Напишите ответ здесь…'],
  fr: ['Entretien simulé', 'Questions', 'Démarrer', 'Terminer', 'Envoyer la réponse', 'Recommencer', 'Écrivez votre réponse ici…'],
  it: ['Colloquio simulato', 'Domande', 'Inizia', 'Termina', 'Invia risposta', 'Ricomincia', 'Scrivi qui la tua risposta…'],
};

let n = 0;
for (const [lang, [a, b, c, d, e, f, g]] of Object.entries(ADD)) {
  const marker = lang.includes('-') ? `'${lang}': {` : `    ${lang}: {`;
  const start = src.indexOf(marker);
  if (start < 0) {
    console.log('未找到:', lang);
    continue;
  }
  const end = src.indexOf('\n    },', start);
  if (end < 0) continue;
  let block = src.slice(start, end);
  if (block.includes('mockStart:')) continue;
  const inject = [
    `mock: '${a}',`,
    `      mockCount: '${b}',`,
    `      mockStart: '${c}',`,
    `      mockQuit: '${d}',`,
    `      mockSubmit: '${e}',`,
    `      mockAgain: '${f}',`,
    `      mockAnswerPh: '${g}',`,
    '      interviewNotes:',
  ].join('\n');
  block = block.replace('interviewNotes:', inject);
  src = src.slice(0, start) + block + src.slice(end);
  n++;
}

fs.writeFileSync(file, src, 'utf8');
console.log('已更新:', n, '| mockStart 出现:', (src.match(/mockStart:/g) || []).length);
