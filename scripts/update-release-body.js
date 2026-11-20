// 一次性更新 Release 说明（修正附件名）
const https = require('https');

for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const TOKEN = process.env.GITHUB_TOKEN;
const RELEASE_ID = process.env.RELEASE_ID;

const body = `JobAid 面试练习与复盘助手，Windows 桌面版第一个公开版本。

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
| \`JobAid-Usage.txt\` | 安装、配置、快捷键、常见问题 |

## 安装提示

Windows 可能弹出「已保护你的电脑」——这是安装包未做代码签名导致的，不是病毒。
点「更多信息」→「仍要运行」即可。

## 首次使用必做

1. 左侧栏「模型」→ 添加供应商并填入自己的 API Key（推荐 DeepSeek）
2. 左侧栏「知识库」→ 粘贴简历与目标岗位 JD

不配这两样无法出题。语音识别首次加载约需 2-3 秒。

详见仓库 README。本项目仅供个人技术学习与面试练习使用，请勿用于要求独立作答的正式测评。`;

const payload = Buffer.from(JSON.stringify({ body }), 'utf8');
const req = https.request(
  {
    hostname: 'api.github.com',
    path: `/repos/Howard-Peng002/JobAid/releases/${RELEASE_ID}`,
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'JobAid-Publisher',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
    },
    timeout: 30000,
  },
  (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        console.log('HTTP', res.statusCode, '| 页面:', j.html_url || j.message);
      } catch (e) {
        console.log('HTTP', res.statusCode, d.slice(0, 200));
      }
    });
  }
);
req.on('error', (e) => console.error('请求失败:', e.message));
req.write(payload);
req.end();
