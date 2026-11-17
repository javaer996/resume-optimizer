'use strict';

/**
 * 极简网页搜索（零依赖）
 *
 * 只做一件事：把关键词丢给 DuckDuckGo 的 HTML 版，抓回「标题 + 链接 + 摘要」。
 * 用途是给「单位情报调研」提供原材料——只发单位名与岗位方向这类公开信息，
 * 绝不发送简历内容或个人资料。
 *
 * 为什么不接搜索 API：要 Key、要计费、要额外配置。这里的量很小（一次调研 2–3 个查询），
 * HTML 版足够，而且失败也不会影响主流程——调研拿不到料就退化成纯 AI 推断。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';


const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&apos;': "'", '&hellip;': '…', '&mdash;': '—',
  '&ndash;': '–', '&middot;': '·', '&ldquo;': '“', '&rdquo;': '”',
  // Bing 的摘要里常见这几个，不解会把 "1 天前&ensp;·&ensp;" 原样留在正文里
  '&ensp;': ' ', '&emsp;': ' ', '&thinsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
  '&times;': '×', '&middot;': '·', '&nbsp;': ' ',

};

/** 解 HTML 实体（常见命名实体 + 十进制/十六进制数码） */
function decodeEntities(s) {
  return String(s).replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(m);
    if (hex) return safeCodePoint(parseInt(hex[1], 16), m);
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) return safeCodePoint(Number(dec[1]), m);
    return m;
  });
}

/** fromCodePoint 遇到坏值会抛错，这里兜住 */
function safeCodePoint(n, fallback) {
  try { return String.fromCodePoint(n); } catch (_) { return fallback; }
}

/** 去掉标签，压缩空白 */
function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 去掉标签但**不插空格**。
 * Bing 会把命中的关键词包进 <strong>，"<strong>蚂蚁</strong>集团" 用 stripTags
 * 会变成 "蚂蚁 集团"——显示难看，更要紧的是按单位名匹配时会失配。
 */
function stripInline(s) {
  const spaced = String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ');
  return decodeEntities(spaced.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DDG 的跳转链接形如 //duckduckgo.com/l/?uddg=<encoded>，取出真实地址 */
function realUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (_) { return href; }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/**
 * 解析搜索结果页。
 * DDG 的 HTML 结构是 .result__a（标题链接）+ .result__snippet（摘要），
 * 两者在同一条结果里按顺序出现，用非贪婪跨段匹配即可，不必引入 DOM 解析器。
 */
function parseResults(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<div[^>]*class="[^"]*nav-link|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = realUrl(m[1]);
    const title = stripInline(m[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    const tail = m[3];
    const snipM = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(tail);
    const snippet = snipM ? stripInline(snipM[1]) : '';
    out.push({ title, url, snippet });
    if (out.length >= 10) break;
  }
  return out;
}

/** 解析 Bing 的结果页。Bing 的链接是 /ck/a?...&u=a1<base64>，要解码取真实地址 */
function parseBing(html) {
  const out = [];
  const chunks = html.split(/<li class="b_algo"/i).slice(1);
  for (const chunk of chunks) {
    const m = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!m) continue;
    let url = decodeEntities(m[1]);
    // u=a1<base64url> 才是目标地址；没有就说明是站内链接，跳过
    const b64 = /[?&]u=a1([A-Za-z0-9_\-]+)/.exec(url);
    if (b64) {
      try {
        url = Buffer.from(b64[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch (_) { continue; }
    }
    if (!/^https?:/i.test(url) || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue;
    const title = stripInline(m[2]);
    const snipM = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)
      || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    out.push({ title, url, snippet: snipM ? stripInline(snipM[1]) : '' });
    if (out.length >= 10) break;
  }
  return out;
}

const ENGINES = {
  ddg: {
    label: 'DuckDuckGo',
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=cn-zh`,
    parse: parseResults,
    // DDG 限流时返回 202 + 一个 "anomaly" 页面，正文里没有结果节点
    ok: (html) => /result__a/.test(html),
  },
  bing: {
    label: 'Bing',
    // mkt=zh-CN 不能省：不带地区时 Bing 会给回完全不相干的结果
    // （实测「蚂蚁集团 公司介绍」返回 Facebook、联通营业厅）
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&setlang=zh-CN`,
    parse: parseBing,
    ok: (html) => /b_algo/.test(html),
  },
};

/**
 * 按顺序试这些引擎；前一个没结果就换下一个。
 * 默认 Bing 在前：DuckDuckGo 的 HTML 版对云主机 IP 经常直接返回 202 拦截页，
 * 与其每次都白跑一趟，不如把它当备份。
 */
const ENGINE_ORDER = (process.env.SEARCH_ENGINES || 'bing,ddg')
  .split(',').map((x) => x.trim()).filter((x) => ENGINES[x]);

/** 单次抓取（含一次空响应重试） */
async function fetchOnce(engine, q, timeoutMs, outerSignal) {
  let lastErr = '';
  // Bing 偶尔返回 200 但正文 0 字节，重试一次通常就好了
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(engine.build(q), {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        },
        signal: outerSignal || ctl.signal,
        redirect: 'follow',
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const html = await res.text();
      if (!html.trim()) { lastErr = '空响应'; continue; }
      if (!engine.ok(html)) { lastErr = '被拦截'; continue; }
      const results = engine.parse(html);
      if (results.length) return { results };
      lastErr = '无结果';
    } catch (err) {
      lastErr = err.name === 'AbortError' ? '超时' : err.message;
      if (outerSignal) return { error: lastErr }; // 外部取消就别重试了
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastErr };
}

/**
 * 跑一次搜索。
 * @param {string} query
 * @param {object} [opts] { limit, timeoutMs, signal }
 * @returns {Promise<{query:string, results:Array, error?:string, engine?:string}>}
 * 永远不抛错——搜不到就返回空结果，让调用方决定怎么退化。
 */
async function query(q, opts = {}) {
  const limit = opts.limit || 6;
  const timeoutMs = opts.timeoutMs || 12000;
  const errors = [];
  for (const id of ENGINE_ORDER) {
    const engine = ENGINES[id];
    const out = await fetchOnce(engine, q, timeoutMs, opts.signal);
    if (out.results && out.results.length) {
      return { query: q, results: out.results.slice(0, limit), engine: engine.label };
    }
    errors.push(`${engine.label} ${out.error || '无结果'}`);
  }
  return { query: q, results: [], error: errors.join('；') || '未配置可用搜索引擎' };
}

/** 依次跑多个查询（串行，避免把对方打急），查询之间留一点间隔 */
async function searchMany(queries, opts = {}) {
  const out = [];
  const gap = opts.gapMs == null ? 350 : opts.gapMs;
  for (const q of queries) {
    if (!String(q || '').trim()) continue;
    out.push(await query(q, opts));
    if (gap && out.length < queries.length) await new Promise((r) => setTimeout(r, gap));
  }
  return out;
}

module.exports = {
  query, searchMany, parseResults, parseBing,
  decodeEntities, stripTags, stripInline, realUrl, ENGINES,
};
