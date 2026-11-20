#!/usr/bin/env node
/**
 * JobAid 一键发布到 GitHub
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish-github.js
 *
 * 需要 token 具备 repo 权限。脚本会依次完成：
 *   1. 校验账号
 *   2. 创建公开仓库 Howard-Peng002/JobAid（已存在则跳过）
 *   3. 推送本地 main 分支
 *   4. 创建 / 复用 v1.0.0 Release
 *   5. 上传 JobAid-Setup.exe 与 使用说明.txt
 *
 * 可重复执行：已存在的仓库、Release、同名附件都会自动跳过。
 * 注意：脚本直连 GitHub，请在不走 HTTP 代理的环境下运行。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const OWNER = 'Howard-Peng002';
const REPO = 'JobAid';
const TAG = 'v1.0.0';
const RELEASE_TITLE = 'JobAid v1.0.0';

const ASSETS = [
  { file: path.join(ROOT, 'download', 'JobAid-Setup.exe'), name: 'JobAid-Setup.exe' },
  { file: path.join(ROOT, 'download', '使用说明.txt'), name: '使用说明.txt' },
];

const RELEASE_BODY = `JobAid 面试练习与复盘助手，Windows 桌面版第一个公开版本。

## 包含什么

- 模拟面试：按简历 + JD 出题，文字 / 语音两种作答，答完生成能力画像
- 语音面试：Edge 神经语音念题（7 种中文音色）+ 本地语音识别作答，支持追问
- 面经复盘：导出 Markdown / Word / PDF
- 实时辅助：听写提问并生成参考回答，浮窗显示
- 隐私设计：简历、JD、语音、API Key 全部只存本机

## 下载

| 文件 | 说明 |
|---|---|
| \`JobAid-Setup.exe\` | Windows 安装包，约 284MB（内含语音识别模型） |
| \`使用说明.txt\` | 安装、配置、快捷键、常见问题 |

## 安装提示

Windows 可能弹出「已保护你的电脑」——这是安装包未做代码签名导致的，不是病毒。
点「更多信息」→「仍要运行」即可。

## 首次使用必做

1. 左侧栏「模型」→ 添加供应商并填入自己的 API Key（推荐 DeepSeek）
2. 左侧栏「知识库」→ 粘贴简历与目标岗位 JD

不配这两样无法出题。语音识别首次加载约需 2-3 秒。

详见仓库 README。本项目仅供个人技术学习与面试练习使用，请勿用于要求独立作答的正式测评。
`;

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量。');
  console.error('用法: GITHUB_TOKEN=ghp_xxx node scripts/publish-github.js');
  process.exit(1);
}

function request(method, hostname, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body == null
      ? null
      : Buffer.isBuffer(opts.body)
        ? opts.body
        : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body), 'utf8');

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'JobAid-Publisher',
      ...(opts.headers || {}),
    };
    if (payload) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const req = https.request(
      { hostname, path: pathname, method, headers, timeout: opts.timeout || 120000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.setTimeout(opts.timeout || 120000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadAsset(releaseId, asset) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(asset.file).size;
    const pathname = `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`;
    const req = https.request(
      {
        hostname: 'uploads.github.com',
        path: pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'JobAid-Publisher',
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
        timeout: 900000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* 忽略 */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.setTimeout(900000, () => req.destroy(new Error('上传超时')));
    req.on('error', reject);
    fs.createReadStream(asset.file)
      .on('error', reject)
      .pipe(req);
  });
}

function die(msg, extra) {
  console.error(`\n[失败] ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

(async () => {
  // 1. 校验账号
  const me = await request('GET', 'api.github.com', '/user');
  if (me.status !== 200) die('token 无效或权限不足', `HTTP ${me.status} ${me.text.slice(0, 200)}`);
  console.log(`[1/5] 账号确认: ${me.json.login}`);

  // 2. 创建仓库
  let repo = await request('GET', 'api.github.com', `/repos/${OWNER}/${REPO}`);
  if (repo.status === 200) {
    console.log(`[2/5] 仓库已存在: ${repo.json.html_url}`);
  } else {
    repo = await request('POST', 'api.github.com', '/user/repos', {
      body: {
        name: REPO,
        description: '面试练习与复盘助手 · 简历 + JD 驱动的模拟面试、语音问答与面经导出',
        homepage: `https://github.com/${OWNER}/${REPO}`,
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        license_template: 'mit',
      },
    });
    if (repo.status !== 201) die('创建仓库失败', `HTTP ${repo.status} ${repo.text.slice(0, 300)}`);
    console.log(`[2/5] 仓库已创建: ${repo.json.html_url}`);
  }

  // 3. 推送代码（URL 内嵌凭据，同时禁用 credential helper 以免弹窗）
  const remote = `https://${encodeURIComponent(OWNER)}:${encodeURIComponent(TOKEN)}@github.com/${OWNER}/${REPO}.git`;
  try {
    execFileSync(
      'git',
      ['-c', 'credential.helper=', 'push', remote, 'main:main', '--force'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      }
    );
    console.log('[3/5] 代码已推送到 main');
  } catch (e) {
    const detail = (e.stderr || Buffer.from('')).toString().slice(0, 500);
    die('git push 失败', detail);
  }

  // 4. 创建或复用 Release
  let release = await request('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (release.status === 200) {
    console.log(`[4/5] Release 已存在: ${release.json.html_url}`);
  } else {
    release = await request('POST', 'api.github.com', `/repos/${OWNER}/${REPO}/releases`, {
      body: {
        tag_name: TAG,
        name: RELEASE_TITLE,
        body: RELEASE_BODY,
        draft: false,
        prerelease: false,
      },
    });
    if (release.status !== 201) die('创建 Release 失败', `HTTP ${release.status} ${release.text.slice(0, 300)}`);
    console.log(`[4/5] Release 已创建: ${release.json.html_url}`);
  }

  // 5. 上传附件
  const existing = new Set((release.json.assets || []).map((a) => a.name));
  for (const asset of ASSETS) {
    if (!fs.existsSync(asset.file)) {
      console.warn(`[5/5] 跳过（文件不存在）: ${asset.file}`);
      continue;
    }
    if (existing.has(asset.name)) {
      console.log(`[5/5] 已存在，跳过: ${asset.name}`);
      continue;
    }
    const mb = (fs.statSync(asset.file).size / 1024 / 1024).toFixed(1);
    process.stdout.write(`[5/5] 上传 ${asset.name} (${mb}MB) ... `);
    const up = await uploadAsset(release.json.id, asset);
    if (up.status !== 201) die(`上传 ${asset.name} 失败`, `HTTP ${up.status} ${up.text.slice(0, 300)}`);
    console.log('完成');
  }

  console.log('\n========================================');
  console.log('发布完成');
  console.log(`  仓库  : https://github.com/${OWNER}/${REPO}`);
  console.log(`  下载  : https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  console.log('========================================');
})().catch((e) => die('未捕获异常', e.stack || e.message));
