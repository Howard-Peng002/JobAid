/**
 * 面试场次存储
 * ------------------------------------------------------------
 * 每场面试（一次「新建任务」到下一次「新建任务」之间）记为一场，
 * 保存问答与字幕，落盘到 userData/sessions.json，最多保留 40 场。
 * 只存本机，不上传。
 */
const fs = require('fs');
const path = require('path');

const MAX_SESSIONS = 40;
const MAX_TRANSCRIPT = 400;

function blank() {
  return { id: 'S' + Date.now(), startedAt: Date.now(), transcript: [], qa: [] };
}

class SessionStore {
  constructor(dir) {
    this.file = path.join(dir, 'sessions.json');
    this.list = this._load();
    this.cur = blank();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.list.slice(-MAX_SESSIONS)));
    } catch (e) {
      console.error('[sessions] 保存失败:', e.message);
    }
  }

  get currentId() {
    return this.cur.id;
  }

  get count() {
    return this.cur.qa.length;
  }

  addText(channel, text) {
    const t = this.cur.transcript;
    t.push({ channel, text, ts: Date.now() });
    if (t.length > MAX_TRANSCRIPT) t.splice(0, t.length - MAX_TRANSCRIPT);
  }

  addQA(question, answer) {
    this.cur.qa.push({ question, answer, ts: Date.now() });
    this._save(); // 每答完一题就落盘，意外退出也不丢
  }

  /** 把当前场次归档（有内容才存），返回归档的场次或 null */
  archive() {
    const c = this.cur;
    if (!c) return null;
    if (!c.qa.length && c.transcript.length < 3) return null;
    c.endedAt = Date.now();
    this.list.push(c);
    if (this.list.length > MAX_SESSIONS) this.list = this.list.slice(-MAX_SESSIONS);
    this._save();
    return c;
  }

  /** 开始新的一场，返回上一场是否被归档 */
  start() {
    const archived = this.archive();
    this.cur = blank();
    this._save();
    return !!archived;
  }

  clear() {
    this.cur = blank();
  }

  summary() {
    return {
      current: { id: this.cur.id, startedAt: this.cur.startedAt, count: this.cur.qa.length },
      items: this.list
        .slice()
        .reverse()
        .map((s) => ({
          id: s.id,
          startedAt: s.startedAt,
          endedAt: s.endedAt || s.startedAt,
          qaCount: s.qa.length,
          firstQuestion: s.qa.length ? s.qa[0].question : (s.transcript[0] ? s.transcript[0].text : ''),
        })),
    };
  }

  detail(id) {
    if (id === this.cur.id) return this.cur;
    return this.list.find((s) => s.id === id) || null;
  }

  remove(id) {
    const n = this.list.length;
    this.list = this.list.filter((s) => s.id !== id);
    if (this.list.length !== n) this._save();
    return this.list.length !== n;
  }
}

module.exports = SessionStore;
