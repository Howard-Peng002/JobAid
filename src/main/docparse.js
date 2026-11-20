'use strict';
/**
 * 文档文本提取：简历解析 & 项目资料索引共用。
 * 支持 PDF / DOCX / DOC / 纯文本 / 常见代码与数据文件。
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024; // 单文件上限 2MB

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.ini', '.conf', '.env', '.sql', '.sh', '.bat', '.ps1',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.scala', '.vue', '.svelte',
  '.css', '.scss', '.less', '.toml', '.properties', '.gradle', '.dockerfile',
]);

const DOC_EXT = new Set(['.pdf', '.docx', '.doc']);

function extOf(p) {
  return path.extname(p).toLowerCase();
}

function isSupported(p) {
  const e = extOf(p);
  return TEXT_EXT.has(e) || DOC_EXT.has(e);
}

/** 粗略判断是否二进制（前 8KB 出现 0 字节即认为是） */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(file) {
  const { PDFParse } = require('pdf-parse');
  const buf = fs.readFileSync(file);
  const parser = new PDFParse({ data: buf });
  try {
    const res = await parser.getText();
    return { text: clean(res.text), pages: res.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocx(file) {
  const mammoth = require('mammoth');
  const res = await mammoth.extractRawText({ path: file });
  return { text: clean(res.value) };
}

async function extractDoc(file) {
  const WordExtractor = require('word-extractor');
  const ex = new WordExtractor();
  const doc = await ex.extract(file);
  return { text: clean(doc.getBody()) };
}

/**
 * @param {string} file
 * @returns {Promise<{text:string, kind:string, pages?:number, warning?:string}>}
 */
async function extractText(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，已跳过`);
  }
  const e = extOf(file);
  if (e === '.pdf') {
    const r = await extractPdf(file);
    if (!r.text || r.text.length < 20) {
      return { ...r, kind: 'pdf', warning: '这份 PDF 里没有可提取的文字层，可能是扫描件/图片版，建议换一份文字版 PDF' };
    }
    return { ...r, kind: 'pdf' };
  }
  if (e === '.docx') return { ...(await extractDocx(file)), kind: 'docx' };
  if (e === '.doc') return { ...(await extractDoc(file)), kind: 'doc' };

  const buf = fs.readFileSync(file);
  if (looksBinary(buf)) throw new Error('二进制文件，已跳过');
  return { text: clean(buf.toString('utf8')), kind: 'text' };
}

module.exports = { extractText, isSupported, extOf, TEXT_EXT, DOC_EXT, MAX_BYTES, clean };
