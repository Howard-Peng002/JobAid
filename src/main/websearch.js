'use strict';
/**
 * 轻量网络搜索：抓 Bing 的结果页，不需要 API Key。
 * 主用 cn.bing.com（国内可直连），失败再退回 DuckDuckGo。
 * 网络不通时如实报错，绝不伪造结果。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&(ensp|emsp|thinsp|middot|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo|bull);/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]{2,8};/gi, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function timeout(ms, ctl) {
  return setTimeout(() => ctl.abort(), ms);
}

async function bing(q, topN, timeoutMs) {
  const ctl = new AbortController();
  const t = timeout(timeoutMs, ctl);
  try {
    const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN', {
      headers: HEADERS,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Bing 返回 ${res.status}`);
    const html = await res.text();

    const items = [];
    const blocks = html.split('class="b_algo"').slice(1);
    for (const blk of blocks) {
      if (items.length >= topN) break;
      const a = blk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const url = decodeEntities(a[1]);
      const title = stripTags(a[2]);
      const p = blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = p ? stripTags(p[1]) : '';
      if (title && snippet && /^https?:/.test(url)) items.push({ title, url, snippet });
    }
    if (!items.length) throw new Error('Bing 结果解析为空');
    return items;
  } finally {
    clearTimeout(t);
  }
}

async function ddg(q, topN, timeoutMs) {
  const ctl = new AbortController();
  const t = timeout(timeoutMs, ctl);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      headers: HEADERS,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`DuckDuckGo 返回 ${res.status}`);
    const html = await res.text();
    const items = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snips = [];
    const re2 = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re2.exec(html))) snips.push(stripTags(m[1]));
    let i = 0;
    while ((m = re.exec(html)) && items.length < topN) {
      const href = m[1];
      const real = (href.match(/[?&]uddg=([^&]+)/) || [])[1];
      items.push({
        title: stripTags(m[2]),
        url: real ? decodeURIComponent(real) : href,
        snippet: snips[i] || '',
      });
      i++;
    }
    const cleaned = items.filter((x) => x.title && x.snippet);
    if (!cleaned.length) throw new Error('DuckDuckGo 结果解析为空');
    return cleaned;
  } finally {
    clearTimeout(t);
  }
}

// 口语里的功能词，拼查询时去掉（按"词"整体匹配，不再逐字删除——逐字删会把语义打碎）
const STOP_WORDS = new Set([
  '你', '我', '他', '她', '它', '您', '咱', '我们', '你们', '他们', '她们',
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '是', '在', '有', '和', '与', '及', '或',
  '就', '都', '也', '还', '很', '太', '更', '最', '这个', '那个', '哪个', '什么', '怎么', '怎样',
  '如何', '为什么', '为啥', '哪些', '请问', '说说', '介绍', '讲讲', '谈谈', '聊聊', '一下', '以及',
  '进行', '关于', '对于', '能不能', '可不可以', '会不会', '有没有', '要不要', '可以', '应该',
]);

// 泛名词，对检索没有区分度，留着只会命中百科词条
const GENERIC = /^(项目|项目里|问题|东西|事情|情况|方面|部分|内容|时候|相关|经验|经历|工作|公司|岗位|职位)$/;

const VERB_PREFIX = /^(处理|实现|保证|完成|进行|使用|采用|知道|了解|解决|设计|做过|写过|学习|理解|掌握|说说|讲讲|介绍|聊聊)/;
// 时间/数量修饰（"一百毫秒内"这类，单独拿去搜没有意义）
const TIME_AFFIX = /(一?[百十千]?[毫秒微]秒(内|之内)?|[0-9]+\s*(ms|毫秒|秒|分钟)(内|之内)?)/gi;

// 英文技术词（FreeRTOS / SPI / CAN / C++ / Node.js …）
const TECH_TOKEN = /[A-Za-z][A-Za-z0-9+#._-]{1,20}/g;
const EN_STOP = /^(a|an|the|and|or|is|are|was|were|to|of|in|on|at|for|with|why|how|what|when|which|do|does|did|can|could|would|should|i|you|we|they|it|this|that)$/i;

// 中文技术名词白名单。中文口语里有检索价值的词其实很有限，
// 与其逐字过滤（会把语义打碎），不如只认这些确切的术语。
const ZH_TECH =
  /(任务调度|实时性|优先级反转|优先级|信号量|互斥量?|消息队列|队列|上下文切换|栈溢出|内存池|内存泄漏|看门狗|双缓冲|环形缓冲|状态机|时频|傅里叶|小波|滤波|特征提取|量化|算子|推理|模型部署|低功耗|休眠|唤醒|中断|串口|总线|协议栈|裸机|任务切换|死锁|抖动|漂移|闭环|pid|并发|事务|幂等|分库分表|削峰|限流|熔断|缓存|索引|主从|分片|微服务|容器|负载均衡|一致性|分布式锁|持久化|压力测试|性能优化)/i;

/**
 * 把一句口头提问压成搜索关键词。
 *
 * 关键教训：**绝不能拿含单个汉字的短语去搜** —— Bing 会把「用 FreeRTOS 裸机跑」
 * 当成在查汉字「用」，直接返回百度百科的字典词条，纯噪声塞进提示词反而把答案带偏。
 * 所以只保留英文技术词和中文技术名词白名单里的词。
 *
 * 返回空字符串表示"这个问题不值得联网"，调用方应直接跳过检索。
 */
function buildQuery(question) {
  const raw = String(question || '')
    .replace(/[，。！？、,.!?；;：:"'“”‘’（）()【】]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';

  const tech = (raw.match(TECH_TOKEN) || []).filter((t) => t.length >= 2 && !EN_STOP.test(t));
  const zhTech = [...new Set(raw.match(ZH_TECH) || [])].filter((t) => !tech.some((e) => e.toLowerCase() === t.toLowerCase()));

  // 没有任何技术名词：面试里的「做个自我介绍」「最大的困难」都属于这类，
  // 联网只会把范文、百科、招聘广告塞进提示词。
  if (!tech.length && !zhTech.length) return '';

  return [...tech.slice(0, 2), ...zhTech.slice(0, 2)].join(' ').slice(0, 40);
}

// 明显不是资料页的结果：字典词条、软件下载站。用它们当依据只会把答案带偏
const JUNK_TITLE = /(百科|汉典|字典|词典|拼音|笔画|部首|的意思|组词|汉语国学|在线翻译|控制面板|官方下载|驱动下载|免费下载|破解|激活工具)/;

function isJunk(item) {
  const t = `${item.title || ''} ${item.snippet || ''}`;
  return JUNK_TITLE.test(t);
}

/**
 * @param {string} query
 * @param {{topN?:number, timeoutMs?:number}} [opt]
 */
async function search(query, opt = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '搜索词为空', items: [] };
  const topN = opt.topN || 4;
  const timeoutMs = opt.timeoutMs || 8000;

  const errors = [];
  for (const [name, fn] of [
    ['bing', bing],
    ['ddg', ddg],
  ]) {
    try {
      const items = await fn(q, topN, timeoutMs);
      const clean = items.filter((it) => !isJunk(it));
      if (!clean.length) {
        errors.push(`${name}: 结果均与问题无关`);
        continue;
      }
      return { ok: true, query: q, engine: name, items: clean.slice(0, topN) };
    } catch (e) {
      errors.push(`${name}: ${e.name === 'AbortError' ? '超时' : e.message}`);
    }
  }
  return { ok: false, error: errors.join('；'), items: [] };
}

module.exports = { search, buildQuery };
