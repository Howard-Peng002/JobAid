'use strict';
/**
 * 项目资料库：把一个文件夹变成可按问题检索的本地知识库。
 *
 * 不依赖向量模型、不联网：文件 → 分块 → 中文二元组 + 英文词 的倒排索引 →
 * 提问时用 BM25 打分召回最相关的几段，塞进提示词。
 */
const fs = require('fs');
const path = require('path');
const { extractText, isSupported, MAX_BYTES } = require('./docparse');

const SKIP_DIR = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', '.next', '.nuxt', '.cache',
  'coverage', 'vendor', 'packages', 'tmp', 'temp', '.gradle', '.mvn', 'release', 'debug',
]);

const MAX_FILES = 600;
const MAX_DEPTH = 6;
const CHUNK = 650;
const OVERLAP = 90;

/* --------------------------------------------------------------- 分词 */

function tokenize(s) {
  const out = [];
  const lower = String(s).toLowerCase();
  const latin = lower.match(/[a-z0-9][a-z0-9_+#.\-]{1,}/g);
  if (latin) out.push(...latin);
  const cjk = lower.match(/[\u4e00-\u9fff]+/g);
  if (cjk) {
    for (const seg of cjk) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

/* ------------------------------------------------------------- 分块 */

function chunkText(text, size = CHUNK, overlap = OVERLAP) {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > size) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      let i = 0;
      while (i < p.length) {
        chunks.push(p.slice(i, i + size));
        i += size - overlap;
      }
      continue;
    }
    if ((buf + '\n\n' + p).length > size) {
      if (buf) chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/* ------------------------------------------------------------- 遍历 */

function walk(root) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && files.length < MAX_FILES) {
    const { dir, depth } = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of ents) {
      if (files.length >= MAX_FILES) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (SKIP_DIR.has(ent.name.toLowerCase())) continue;
        if (ent.name.startsWith('.')) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'project-index.json') continue; // 索引缓存别把自己索引进去
        if (!isSupported(full)) continue;
        let st;
        try {
          st = fs.statSync(full);
        } catch (_) {
          continue;
        }
        if (!st.size || st.size > MAX_BYTES) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        files.push({ full, rel, mtime: Math.round(st.mtimeMs), size: st.size });
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

/* --------------------------------------------------------------- 主体 */

class ProjectIndex {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.root = '';
    this.builtAt = 0;
    this.files = [];
    this.chunks = []; // [{p, t}]
    this.postings = new Map();
    this.lens = [];
    this.avgLen = 1;
    this.building = false;
    this.fileError = 0;
  }

  stats() {
    return {
      root: this.root,
      files: this.files.length,
      chunks: this.chunks.length,
      builtAt: this.builtAt,
      failed: this.fileError,
      chars: this.chunks.reduce((n, c) => n + c.t.length, 0),
    };
  }

  /* ---------- 缓存 ---------- */

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (!raw || !raw.root) return false;
      this.root = raw.root;
      this.builtAt = raw.builtAt || 0;
      this.files = raw.files || [];
      this.chunks = raw.chunks || [];
      this._rebuildPostings();
      return true;
    } catch (_) {
      return false;
    }
  }

  saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ root: this.root, builtAt: this.builtAt, files: this.files, chunks: this.chunks }),
        'utf8'
      );
    } catch (e) {
      console.error('[index] 缓存写入失败', e.message);
    }
  }

  clear() {
    this.root = '';
    this.files = [];
    this.chunks = [];
    this.postings = new Map();
    this.builtAt = 0;
    this.saveCache();
  }

  /* ---------- 建索引 ---------- */

  async build(root, onProgress) {
    if (this.building) return this.stats();
    this.building = true;
    const t0 = Date.now();
    try {
      // 同目录增量化：内容没变的文件复用已有分块
      const reuse = new Map();
      if (this.root === root) {
        const byPath = new Map();
        for (const c of this.chunks) {
          if (!byPath.has(c.p)) byPath.set(c.p, []);
          byPath.get(c.p).push(c);
        }
        for (const f of this.files) {
          reuse.set(f.rel, { mtime: f.mtime, size: f.size, chunks: byPath.get(f.rel) || [] });
        }
      }

      const files = walk(root);
      const chunks = [];
      let failed = 0;
      let done = 0;

      for (const f of files) {
        done++;
        if (onProgress && done % 5 === 0) onProgress(done, files.length, f.rel);
        const prev = reuse.get(f.rel);
        if (prev && prev.mtime === f.mtime && prev.size === f.size && prev.chunks.length) {
          chunks.push(...prev.chunks);
          continue;
        }
        try {
          const { text } = await extractText(f.full);
          if (!text || text.length < 15 || text.includes('\uFFFD')) {
            failed++;
            continue;
          }
          for (const t of chunkText(text)) {
            if (t.length >= 20) chunks.push({ p: f.rel, t });
          }
        } catch (_) {
          failed++;
        }
      }

      this.root = root;
      this.files = files.map((f) => ({ rel: f.rel, mtime: f.mtime, size: f.size }));
      this.chunks = chunks;
      this.fileError = failed;
      this.builtAt = Date.now();
      this._rebuildPostings();
      this.saveCache();
      return { ...this.stats(), costMs: Date.now() - t0 };
    } finally {
      this.building = false;
    }
  }

  _rebuildPostings() {
    const postings = new Map();
    const lens = new Array(this.chunks.length);
    let total = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const toks = tokenize(this.chunks[i].t);
      lens[i] = toks.length;
      total += toks.length;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, n] of tf) {
        let m = postings.get(t);
        if (!m) {
          m = new Map();
          postings.set(t, m);
        }
        m.set(i, n);
      }
    }
    this.postings = postings;
    this.lens = lens;
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  /* ---------- 检索 ---------- */

  /**
   * @param {string} question
   * @param {{topK?:number, budget?:number}} [opt]
   * @returns {Array<{file:string, text:string, score:number}>}
   */
  retrieve(question, opt = {}) {
    const topK = opt.topK || 4;
    const budget = opt.budget || 2600;
    if (!this.chunks.length) return [];

    const terms = [...new Set(tokenize(question))];
    if (!terms.length) return [];

    const N = this.chunks.length;
    const k1 = 1.2;
    const b = 0.6;
    const scores = new Float64Array(N);
    const hits = new Set();
    let any = false;

    for (const term of terms) {
      const post = this.postings.get(term);
      if (!post) continue;
      any = true;
      const df = post.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [i, tf] of post) {
        const dl = this.lens[i] || 1;
        const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / this.avgLen));
        scores[i] += idf * norm;
        hits.add(i);
      }
    }
    if (!any) return [];

    // 路径命中也算相关（问「信贷项目」时，credit-system/ 下的文件该被优先召回）
    for (const i of hits) {
      const p = this.chunks[i].p.toLowerCase();
      let bonus = 0;
      for (const term of terms) if (term.length >= 2 && p.includes(term)) bonus += 0.35;
      if (bonus) scores[i] += bonus * 2;
    }

    const ranked = [...hits].sort((a, b2) => scores[b2] - scores[a]);

    const out = [];
    const perFile = new Map();
    let used = 0;
    for (const i of ranked) {
      if (out.length >= topK || used >= budget) break;
      const c = this.chunks[i];
      const cnt = perFile.get(c.p) || 0;
      if (cnt >= 2) continue; // 同一文件最多两段，保证覆盖面
      const piece = c.t.slice(0, budget - used);
      if (piece.length < 40) break;
      out.push({ file: c.p, text: piece, score: Number(scores[i].toFixed(3)) });
      perFile.set(c.p, cnt + 1);
      used += piece.length;
    }
    return out;
  }

  /** 给模型看的目录概览 */
  outline(limit = 40) {
    if (!this.files.length) return '';
    const dirs = new Map();
    for (const f of this.files) {
      const d = path.dirname(f.rel);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(path.basename(f.rel));
    }
    const lines = [];
    let n = 0;
    for (const [d, names] of dirs) {
      if (n >= limit) break;
      const label = d === '.' ? '(根目录)' : d;
      lines.push(`${label}/  —— ${names.slice(0, 8).join('、')}${names.length > 8 ? ` 等 ${names.length} 个文件` : ''}`);
      n++;
    }
    if (dirs.size > limit) lines.push(`…还有 ${dirs.size - limit} 个目录`);
    return lines.join('\n');
  }
}

module.exports = { ProjectIndex, tokenize };
