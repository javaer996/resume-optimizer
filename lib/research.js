'use strict';

/**
 * 单位情报调研
 *
 * 用户只提供「单位名称 + 岗位要求」，其余信息（单位简介、重点考察范围、注意事项、
 * 风格偏好）由这里补齐：
 *
 *   1. 用单位名 + 岗位方向拼几条搜索词，抓公开网页的标题与摘要
 *   2. 把摘要丢给 AI，让它归纳成结构化情报
 *   3. AI 不可用（没配 Key / 网络不通 / 超时）时，退化成"只用搜索摘要做规则归并"
 *
 * 隐私边界很明确：**发出去的只有单位名和岗位方向**，绝不发送简历、姓名、联系方式。
 * 这一步发生在脱敏之前，也不经过简历对象——从代码结构上保证拿不到简历。
 */

const search = require('./search');
const providers = require('./providers');

const INTEL_SCHEMA = `{
  "intro": "单位简介：业务方向、规模、所处行业地位，2-4 句",
  "focusAreas": "重点考察范围：这个岗位大概率会考察什么，用「、」分隔或分条",
  "cautions": "注意事项：投递与面试时要避开的坑、红线、表述忌讳，分条",
  "tone": "风格偏好：这家单位喜欢什么样的表达风格，一句话",
  "duties": "岗位职责：根据单位与岗位方向推断的职责（若用户已提供则留空）",
  "requirements": "任职要求：根据单位与岗位方向推断的要求（若用户已提供则留空）",
  "sources": ["参考过的信息点，写成人话，不要贴 URL"],
  "confidence": "high | medium | low"
}`;

const SYSTEM_PROMPT = `你是一位熟悉国内招聘市场的求职顾问，擅长快速摸清一家单位的底细。

你会拿到两部分材料：
1. 用户提供的单位名称、应聘职位，以及（可能不完整的）招聘要求原文；
2. 从公开网页抓来的搜索摘要。

你的任务：把材料整理成可直接用于"针对性修改简历"的结构化情报。

硬性规则：
1. 只依据材料推断，**不要编造具体数字**（营收、人数、成立年份等）。材料没提到就说得模糊些。
2. 搜索摘要可能与目标单位无关（同名、过期信息、聚合站噪音），要自己判断取舍；
   拿不准的写"据公开信息"或直接留空，不要硬凑。
3. focusAreas 要具体到能力维度（例如"性能优化实战、框架原理、跨团队协作"），
   不要写"技术能力"这种没有信息量的词。
4. cautions 要能指导写作（例如"不要出现竞品公司名""强调稳定性而非快速迭代"）。
5. 全部输出简体中文，只输出 JSON，不要 Markdown 代码块外的解释。`;

/**
 * 判断一条材料是否在讲这家单位。
 *
 * 只在标题里查完整单位名是不够的：面经普遍用简称，标题常写「字节前端面试全攻略」
 * 而单位名是「字节跳动」，严格匹配会把最好的材料全丢掉。
 *
 * 所以面试/避坑两类允许用前两个字匹配——但**只在这条材料确实带面试特征词时**才放宽，
 * 避免「中国银行」把「中国移动面试」也算进来。单位介绍类一律要求完整名称，
 * 因为「美团」会搜出「美的首页」这种同首字的干扰。
 *
 * @param {string} text  标题 + 摘要
 * @param {string} name  单位名
 * @param {'intro'|'interview'|'cautions'} kind
 */
function mentionsCompany(text, name, kind) {
  const key = String(name || '').trim();
  if (!key) return true;
  const hay = String(text || '');
  if (hay.includes(key)) return true;
  if (kind === 'intro') return false;
  const short = key.slice(0, 2);
  if (short.length < 2 || key.length <= 2) return false;
  // 「中国移动」和「中国银行」共享前两个字，这类泛用词不能拿来放宽
  const GENERIC = ['中国', '北京', '上海', '广东', '深圳', '杭州', '江苏', '浙江',
    '国家', '中央', '东方', '华夏', '中华', '国际', '科技', '网络', '信息'];
  if (GENERIC.includes(short)) return false;
  if (!hay.includes(short)) return false;
  return /(面试|面经|考察|考点|真题|八股|避坑|经验|注意)/.test(hay);
}

/**
 * 把搜索结果压成提示词里的一段材料，控制长度避免喧宾夺主。
 *
 * 材料只从"经过择优"的结果里取，理由：搜「美团」时 Bing 会返回「美的首页」
 * 「2025 年中国十大美女排行榜」，这些一旦进提示词，AI 就会煞有介事地归纳出
 * 一家"做家电的公司"。宁可给 AI 少一点材料，也不能给错的。
 *
 * 判据是"全名出现"或"该条已被判定为对题"。不用前缀匹配——「中国银行」的前两个字
 * 是「中国」，那样会放进一整屏无关内容。
 */
function digest(byIntent, results, { maxItems = 12, maxChars = 2200, name = '' } = {}) {
  const key = String(name || '').trim();
  const seen = new Set();
  const pool = [];
  const add = (item) => {
    const title = String((item && item.title) || '').trim();
    if (!title || seen.has(title)) return;
    seen.add(title);
    pool.push(item);
  };
  for (const k of ['intro', 'interview', 'cautions']) {
    for (const item of (byIntent && byIntent[k]) || []) {
      if (mentionsCompany(`${item.title || ''} ${item.snippet || ''}`, key, k)) add(item);
    }
  }
  // 兜底的原始结果只收确实提到这家单位的
  for (const r of results || []) {
    for (const item of r.results || []) {
      if (mentionsCompany(`${item.title || ''} ${item.snippet || ''}`, key, 'intro')) add(item);
    }
  }
  const lines = [];
  let used = 0;
  for (const item of pool) {
    if (lines.length >= maxItems) break;
    const line = `- ${item.title}${item.snippet ? `：${item.snippet}` : ''}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/**
 * 三个调研角度。每个角度给几条不同措辞——搜索引擎对措辞极其敏感
 * （实测「字节跳动 前端工程师 面试 考察重点」只返回品牌导航页，
 * 换成「字节跳动 前端 面试 考察重点」就能拿到真正的面经），
 * 所以要按变体逐个试，而不是赌一句话。
 */
const INTENTS = [
  {
    key: 'intro',
    queries: (name) => [
      `${name} 公司介绍 业务方向 主营业务`,
      `${name} 公司简介 成立 总部 旗下产品`,
    ],
    // 命中这些词说明确实是"单位介绍"类内容
    good: /(公司|集团|简介|介绍|主营|业务|成立|总部|旗下|产品|行业|客户)/g,
    bad: /(招聘|简历|投递|岗位职责|股价|行情|天气)/,
  },
  {
    key: 'interview',
    queries: (name, pos) => {
      const short = pos.replace(/(工程师|专家|经理|主管|专员|总监|高级|资深|初级)/g, '').trim();
      const role = short || pos;
      return [
        role ? `${name} ${role} 面试 考察重点` : `${name} 面试 考察重点`,
        role ? `${name} ${role} 面经 面试题` : `${name} 面经 面试题`,
      ];
    },
    good: /(面试|面经|考察|考点|真题|八股|复盘|流程|几轮|手撕|算法题)/g,
    bad: /(招聘官网|校园招聘|社招|内推码)/,
  },
  {
    key: 'cautions',
    queries: (name) => [
      `${name} 面试经验 注意事项 避坑`,
      `${name} 面试 坑 建议 经验`,
    ],
    good: /(避坑|注意|经验|建议|坑|血泪|复盘|技巧|提醒)/g,
    bad: /(招聘官网|校园招聘)/,
  },
];

/** 按单位与岗位生成首选查询词（每角度第一条，供展示与调试） */
function buildQueries(company, position) {
  const name = String(company || '').trim();
  const pos = String(position || '').trim();
  if (!name) return [];
  return INTENTS.map((it) => {
    const list = it.queries(name, pos);
    return Array.isArray(list) ? list[0] : String(list);
  });
}

/**
 * 按角度逐个搜集材料。
 *
 * 每个角度先试第一条查询；如果返回的结果"不像这个角度的材料"（比如问面试
 * 却只拿到官网导航页），就换下一条措辞重试。判断标准是 scoreResult 的总分。
 * 这样即使某句查询踩空了，也不至于整个角度都空着。
 *
 * @param {Function} [searcher] 抓取函数，默认 search.query；测试时可注入假数据
 * @returns {Promise<{searched:Array, byIntent:object, relevantCounts:object, queries:Array}>}
 */
async function gatherIntel(name, position, searcher = search.query) {
  const searched = [];
  const byIntent = {};
  /** 每个角度"真的对题"的条数。0 表示这个角度其实没搜到东西。 */
  const relevantCounts = {};
  const queries = [];
  for (const intent of INTENTS) {
    const variants = intent.queries(name, position).filter(Boolean);
    let best = { score: -1, relevant: 0, results: [] };
    for (const q of variants) {
      let r = await searcher(q, { limit: 5, timeoutMs: 12000 });
      // Bing 时不时回 200 + 空响应（不是错误，只是没人）。这种"这次没人"不该
      // 被当成"这个词搜不到东西"，否则一个角度会因为一次抖动整体空掉。
      if (!r.results.length && !r.error) {
        await new Promise((r2) => setTimeout(r2, 900));
        r = await searcher(q, { limit: 5, timeoutMs: 12000 });
      }
      queries.push(q);
      searched.push(r);
      if (!r.results.length) continue;
      const scored = r.results
        .map((item) => ({ item, ...scoreResult(item, intent, name) }))
        .sort((a, b) => b.score - a.score);
      const total = scored.reduce((n, x) => n + Math.max(0, x.score), 0);
      const relevant = scored.filter((x) => x.relevant).length;
      // 优先比"有几条真的对题"，再比总分：品牌官网能靠单位名刷分，
      // 但它们对"面试考察什么"毫无信息量。
      const better = relevant > best.relevant
        || (relevant === best.relevant && total > best.score);
      if (better) best = { score: total, relevant, results: scored.map((x) => x.item) };
      // 已经攒到 3 条对题材料就别再打搜索引擎了（它限流很敏感）
      if (relevant >= 3) break;
      await new Promise((r2) => setTimeout(r2, 600));
    }
    byIntent[intent.key] = best.results;
    relevantCounts[intent.key] = best.relevant;
  }
  return { searched, byIntent, relevantCounts, queries };
}

/**
 * 给一条结果打相关性分：越像本角度的材料分越高。
 *
 * `relevant` 单列出来是有原因的：命中单位名只能说明"提到了这家公司"，
 * 不能说明它是面试材料。搜「蚂蚁集团 前端 面试」时，Bing 有时只回品牌
 * 官网，那些结果标题里有单位名、却和面试毫无关系——如果只看总分，它们
 * 会被当成"最好的面试材料"，把真正的问题（没搜到）掩盖掉。
 */
function scoreResult(item, intent, name) {
  const hay = `${item.title} ${item.snippet}`;
  const hits = new Set(hay.match(intent.good) || []);
  // 命中本角度的特征词还不够，必须真的在讲这家单位。
  // 搜「美团」时 Bing 只按第一个字返回「美的首页」，那条也含"集团/公司"，
  // 不加上这层会被算成"找到了单位介绍"。
  const relevant = hits.size > 0 && mentionsCompany(hay, name, intent.key);
  let score = Math.min(hits.size, 6) * 2;
  if (name && item.title.includes(name)) score += 2;
  if (item.snippet && item.snippet.length > 60) score += 1;
  if (intent.bad && intent.bad.test(hay)) score -= 6;
  return { score, relevant };
}

/** 从模型输出里抽 JSON（容忍 ```json 包裹与前后解释） */
function parseJSON(text) {
  const raw = String(text || '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch (_) { return undefined; } };
  let out = tryParse(raw);
  if (out !== undefined) return out;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    out = tryParse(fence[1].trim());
    if (out !== undefined) return out;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    out = tryParse(raw.slice(start, end + 1));
    if (out !== undefined) return out;
  }
  throw new Error(`无法解析调研结果。原始输出前 200 字：${raw.slice(0, 200)}`);
}

function str(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => String(x).trim()).join('；');
  return String(v).trim();
}

/** 只保留已知字段，并把数组形式的 focusAreas/cautions 转成换行分条 */
function normalizeIntel(raw, { keepDuties = false, keepRequirements = false } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const asLines = (v) => {
    if (Array.isArray(v)) return v.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join('\n');
    return str(v);
  };
  return {
    intro: str(src.intro),
    focusAreas: asLines(src.focusAreas),
    cautions: asLines(src.cautions),
    tone: str(src.tone),
    duties: keepDuties ? asLines(src.duties) : '',
    requirements: keepRequirements ? asLines(src.requirements) : '',
    sources: Array.isArray(src.sources) ? src.sources.filter(Boolean).map(String).slice(0, 10) : [],
    confidence: ['high', 'medium', 'low'].includes(src.confidence) ? src.confidence : 'medium',
  };
}

/**
 * 从"面试/考察"类的搜索摘要里挖考察维度。
 * 这些摘要通常已经把考点罗列出来了（"重点涵盖闭包、事件循环、React 原理…"），
 * 比通用话术有信息量。做法是找摘要里的顿号/逗号清单，挑出像技术名词的短语。
 */
function mineTopics(snippets, limit = 8) {
  const KNOWN = [
    '闭包', '原型链', '事件循环', 'Promise', 'this 指向', '作用域', '垃圾回收',
    'React', 'Vue', 'Hooks', '虚拟 DOM', 'Fiber', '响应式原理', '组件化',
    'Webpack', 'Vite', '工程化', '构建优化', 'Tree-Shaking', '模块化',
    '性能优化', '首屏加载', '渲染性能', '内存泄漏', '监控', '埋点',
    'HTTP', '缓存', '跨域', '安全', 'XSS', 'CSRF', '浏览器渲染',
    '算法', '数据结构', '手写代码', '系统设计', '架构设计', '微前端',
    'TypeScript', 'Node', 'SSR', '状态管理', '单元测试', '自动化测试',
    '项目深挖', '业务理解', '沟通协作', '团队协作', '技术选型', '故障排查',
    // 下面是面经摘要里高频出现、但上面那批容易漏的说法
    'JavaScript', 'CSS', 'DOM', 'ES6', '异步', '回调', '微任务', '宏任务',
    '继承', '深浅拷贝', '防抖', '节流', '柯里化', '数组方法', '正则',
    'React Hooks', '生命周期', 'diff', '路由', '懒加载', '代码分割',
    '打包', 'babel', 'npm', 'pnpm', 'monorepo', '脚手架', '组件库',
    '设计模式', '网络协议', 'TCP', 'HTTPS', 'HTTP2', 'DNS', '浏览器缓存',
    '重排重绘', '事件委托', '节流防抖', 'Promise 原理', 'async/await',
    '沟通表达', '简历项目', '实习经历', '算法题', '场景题', '开放题',
  ];
  const text = snippets.join('\n');
  const hits = [];
  const add = (t) => {
    const v = String(t || '').trim();
    if (v && !hits.includes(v)) hits.push(v);
  };
  for (const k of KNOWN) {
    if (text.includes(k)) add(k);
    if (hits.length >= limit) return hits;
  }

  // 摘要里常写成"包括事件循环、Vue 响应式、Webpack 构建优化"，
  // 这些词未必在 KNOWN 里，但确实是考点。做法是在"包括/涵盖/如/："之后
  // 找顿号清单，只保留像技术名词的短词（含英文、或长度 2–8 且不含口语助词）。
  const LIST_LEAD = /(包括|涵盖|涉及|例如|如|主要是|考点|重点)[：:]\s*|(包括|涵盖|涉及|例如)[^。；]{0,4}/g;
  let m;
  while ((m = LIST_LEAD.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const seg = tail.split(/[。；;\n]/)[0];
    const parts = seg.split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    for (const p of parts) {
      const clean = p.replace(/^[（(\s]+|[）)\s]+$/g, '').replace(/等$/, '');
      if (!clean || clean.length > 12) continue;
      if (/[的了和与及或是]/.test(clean) && !/[A-Za-z]/.test(clean)) continue;
      if (/^[\d\s.]+$/.test(clean)) continue;
      add(clean);
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** 摘要开头常带"1 天前 · ""2026年8月25日 · "这类时间戳前缀，去掉 */
function cleanSnippet(s) {
  return String(s || '')
    .replace(/^\s*\d+\s*(分钟|小时|天|周|个月|年)前\s*[·・|｜\-—]?\s*/, '')
    .replace(/^\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[·・|｜\-—]?\s*/, '')
    .trim();
}

/**
 * 没有 AI 时的退路：只用搜索摘要和招聘要求做规则归并。
 *
 * 这里的目标不是"猜得准"，而是**不要装作准**：宁可给一段短而中性的文字，
 * 也不要塞三段互相重复的拼接摘要——那会让用户误信。所以：
 *  - 简介只取最相关的一条摘要的前两句
 *  - 考察范围优先从"面试"角度的摘要里挖真实考点，其次看招聘要求的关键词
 *  - 明确写"未经归纳"，confidence 一律 low
 *
 * @param {object} [byIntent] { intro:[], interview:[], cautions:[] } 已按角度筛过、按相关度排过序
 */
function fallbackIntel(company, position, requirements, results, byIntent, relevantCounts) {
  const name = String(company || '').trim();
  const pick = (list) => (list || []).map((item) => ({
    s: cleanSnippet(item.snippet),
    title: String(item.title || '').trim(),
    url: item.url || '',
  })).filter((x) => x.s.length >= 30);

  // 简介：优先用「单位介绍」角度里排第一的那条，只留前两句。
  // 只有这个角度真有对题结果时才用——否则会拿"蚂蚁（昆虫）"当公司简介。
  const introOk = byIntent && byIntent.intro && byIntent.intro.length
    && (!relevantCounts || relevantCounts.intro > 0);
  const introPool = introOk
    ? pick(byIntent.intro)
    : pick(results.flatMap((r) => r.results || []));
  // 排序要点：标题里出现完整单位名的优先。只出现"蚂蚁"是不够的——
  // 搜"蚂蚁集团"会同时返回昆虫词条，光看关键词会把百科的蚂蚁当成公司。
  const introRanked = introPool.slice().sort((a, b) => {
    const score = (x) => {
      let n = 0;
      if (name && x.title.includes(name)) n += 4;
      if (name && x.s.includes(name)) n += 3;
      if (/(维基|百科|官网|介绍|关于|About)/i.test(x.title)) n += 2;
      if (/\.(gov|edu)\.|wikipedia|baike|about/i.test(x.url)) n += 1;
      if (x.s.length > 120) n += 1;
      return n;
    };
    return score(b) - score(a);
  });
  let intro = '';
  if (introRanked.length) {
    const top = introRanked[0];
    // 最后一道闸：正文必须真的提到这家单位。搜索引擎在没有好结果时会返回
    // 看似相关实则无关的内容（实测查一个不存在的公司名，回了一段大模型介绍），
    // 那种东西绝不能当单位简介。
    const mentions = name && (top.title.includes(name) || top.s.includes(name));
    if (mentions) {
      const sent = top.s.split(/(?<=[。！？.!?])\s*/).slice(0, 2).join('');
      intro = sent.length > 240 ? `${sent.slice(0, 240)}…` : sent;
    }
  }
  if (!intro) intro = `${company}：未能获取公开资料，建议手动填写单位简介。`;

  // 考察范围：优先用「面试」角度的摘要挖真实考点，挖不到再看招聘要求。
  // 同样要求这个角度确实搜到了对题内容，不然挖出来的只是品牌官网的文案。
  const interviewOk = byIntent && byIntent.interview && byIntent.interview.length
    && (!relevantCounts || relevantCounts.interview > 0);
  const interviewPool = interviewOk
    ? pick(byIntent.interview).map((x) => x.s)
    : pick(results.flatMap((r) => r.results || []))
      .filter((x) => /(面试|考察|考点|面经|真题|八股|笔试题)/.test(x.title + x.s))
      .map((x) => x.s);
  const mined = mineTopics(interviewPool);
  if (mined.length) {
    const focusAreas = mined.slice(0, 8).join('\n');
    const cautions = [
      `以下考点由 ${interviewPool.length} 条面试相关摘要自动提取，未经 AI 归纳，请核对。`,
      '摘要可能来自往年或其他岗位，最终以招聘方最新要求为准。',
    ].join('\n');
    return {
      intro, focusAreas, cautions, tone: '', duties: '', requirements: '',
      sources: collectSources(byIntent, results, name),
      confidence: 'low',
    };
  }

  const req = String(requirements || '');
  const FOCUS_HINTS = [
    ['性能', '性能优化'], ['架构', '系统架构'], ['框架', '框架原理'],
    ['算法', '算法与数据结构'], ['源码', '源码阅读'], ['工程化', '前端工程化'],
    ['团队', '团队协作'], ['沟通', '跨部门沟通'], ['业务', '业务理解'],
    ['数据', '数据分析'], ['安全', '安全意识'], ['测试', '质量保障'],
    ['设计', '方案设计'], ['管理', '项目管理'], ['英语', '英语能力'],
    ['云', '云服务经验'], ['数据库', '数据库'], ['运维', '运维部署'],
  ];
  const hits = [];
  for (const [needle, label] of FOCUS_HINTS) {
    if (req.includes(needle) && !hits.includes(label)) hits.push(label);
  }
  const focusAreas = hits.length
    ? hits.slice(0, 8).join('\n')
    : `${position || '目标岗位'}的核心专业能力\n项目经历的真实性深挖\n岗位方向的基础知识`;

  const cautions = [
    '以下内容由搜索摘要与招聘要求自动归并，未经 AI 归纳，请核对后再使用。',
    '确认单位名称是否与招聘方一致，避免同名单位的信息串入。',
  ].join('\n');

  return {
    intro,
    focusAreas,
    cautions,
    tone: '',
    duties: '',
    requirements: '',
    sources: collectSources(byIntent, results, name),
    confidence: 'low',
  };
}

/**
 * 汇总参考来源：三个角度的标题优先，不够再从全量结果里补。
 *
 * 必须按单位名过滤。实测搜「美团」时带回了「美的首页」「2025 年中国十大美女排行榜」，
 * 这些标题若原样列在"参考来源"里，等于替用户背书一堆无关内容——宁可来源为空，
 * 也不能让对方误以为情报有依据。
 */
function collectSources(byIntent, results, name) {
  const key = String(name || '').trim();
  const out = [];
  const push = (item, kind) => {
    const title = String((item && item.title) || '').trim();
    const text = `${title} ${(item && item.snippet) || ''}`;
    if (!title || out.includes(title)) return;
    if (!mentionsCompany(text, key, kind)) return;
    out.push(title.slice(0, 60));
  };
  // 搜「美团」时 Bing 会回「美的首页」「美女排行榜」，那些条目虽然过了打分，
  // 但根本没在讲这家单位，列进参考来源等于替噪音背书。
  for (const k of ['intro', 'interview', 'cautions']) {
    for (const item of (byIntent && byIntent[k]) || []) push(item, k);
  }
  for (const r of results || []) {
    for (const item of r.results || []) push(item, 'intro');
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

/**
 * 调研一家单位。
 *
 * @param {object} input
 * @param {string} input.name       单位名称（必填）
 * @param {string} input.position   应聘职位
 * @param {string} [input.requirements] 已有的岗位要求原文（只用于让 AI 少犯错，不做搜索词）
 * @param {object} [input.provider] AI 供应商；不传则跳过 AI，只用搜索摘要
 * @param {boolean} [input.useAI]   是否调用 AI，默认有 provider 就调
 * @param {Function} [input.searcher] 抓取函数（仅供测试注入）
 * @returns {Promise<{intel:object, samples:Array, queries:Array, engine:string, warning?:string}>}
 */
async function research(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('请先填写单位名称');
  const position = String(input.position || '').trim();
  const requirements = String(input.requirements || '').trim();

  // searcher 只为测试注入；线上永远走 search.query
  const { searched, byIntent, relevantCounts, queries } = await gatherIntel(name, position, input.searcher);
  const failed = searched.filter((s) => s.error && !s.results.length);
  const relevantTotal = Object.values(relevantCounts || {}).reduce((n, x) => n + x, 0);
  let warning = '';
  if (!relevantTotal) {
    // 搜到了结果但全都不对题（同名词条、品牌导航页）—— 说清楚，
    // 别让人以为这份情报是有依据的
    const hitSomething = Object.values(byIntent).some((list) => list && list.length);
    warning = hitSomething
      ? `没搜到对口的公开资料（搜索引擎对「${name}」这种短名容易只按首字检索，也可能只回官网导航）。`
        + '可以先手动填几条重点考察范围，或换用更完整的单位名称再试一次。'
      : '搜索没有返回可用材料。可以先手动填几条重点考察范围，或接一个 AI 供应商试试。';
  } else if (failed.length) {
    warning = `${failed.length} 个查询失败（${failed.map((f) => f.error).join('、')}），情报可能不完整`;
  }

  const material = digest(byIntent, searched, { name });
  const used = material ? material.split('\n').length : 0;
  const useAI = input.useAI !== false && !!input.provider;
  if (!useAI) {
    return {
      intel: fallbackIntel(name, position, requirements, searched, byIntent, relevantCounts),
      samples: searched,
      queries,
      used,
      engine: 'search-only',
      warning: warning || (input.provider ? '' : '未选择 AI 供应商，只整理了搜索摘要'),
    };
  }

  const userPrompt = [
    `【单位名称】${name}`,
    `【应聘职位】${position || '（未指定）'}`,
    requirements ? `【用户提供的招聘要求原文】\n${requirements.slice(0, 1500)}` : '【用户提供的招聘要求原文】（未提供）',
    '',
    '【公开网页搜索摘要】',
    material || '（没有搜到可用材料，请仅根据单位名称与岗位做保守推断，confidence 标 low）',
    '',
    '请按系统提示中的结构输出 JSON，字段名与层级保持一致：',
    INTEL_SCHEMA,
  ].join('\n');

  const started = Date.now();
  let raw;
  try {
    raw = await providers.chat(input.provider, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);
  } catch (err) {
    // AI 挂了不能让整个流程挂掉：退回搜索摘要，并把原因带回去给用户看
    return {
      intel: fallbackIntel(name, position, requirements, searched, byIntent, relevantCounts),
      samples: searched,
      queries,
      used,
      engine: 'search-only',
      warning: `AI 调用失败（${err.message}），已退回搜索摘要`,
    };
  }

  let intel;
  try {
    intel = normalizeIntel(parseJSON(raw), {
      keepDuties: !requirements,
      keepRequirements: !requirements,
    });
  } catch (err) {
    return {
      intel: fallbackIntel(name, position, requirements, searched, byIntent, relevantCounts),
      samples: searched,
      queries,
      used,
      engine: 'search-only',
      warning: `AI 返回的内容无法解析（${err.message}），已退回搜索摘要`,
    };
  }

  return {
    intel,
    samples: searched,
    queries,
    used,
    engine: 'search+ai',
    elapsedMs: Date.now() - started,
    warning,
  };
}

module.exports = {
  research,
  buildQueries,
  digest,
  parseJSON,
  normalizeIntel,
  fallbackIntel,
  mineTopics,
  cleanSnippet,
  gatherIntel,
  scoreResult,
  collectSources,
  mentionsCompany,
  INTENTS,
  SYSTEM_PROMPT,
  INTEL_SCHEMA,
};
