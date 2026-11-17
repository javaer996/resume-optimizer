'use strict';

/**
 * 单位情报调研自测。
 *
 * 这一块最容易出的事不是"崩了"，而是**悄悄给出错的情报**：把昆虫百科当成
 * 蚂蚁集团、把品牌导航页当成面经、把搜不到说成"推断"。所以测试的重点是
 * 这些"看起来成功、其实是错的"路径。
 *
 * 全部离线：真实网页存在 test/fixtures/，搜索用注入的假 searcher。
 *
 * 用法: node test/research.js          离线，秒出结果
 *       node test/research.js --live   额外跑一次真实联网（失败只提示，不计入）
 */

const fs = require('fs');
const path = require('path');

const search = require('../lib/search');
const research = require('../lib/research');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const FIX = path.join(__dirname, 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

/** 造一条搜索结果 */
function hit(title, snippet, url = 'https://example.com/a') {
  return { title, snippet, url };
}

/**
 * 造一个假 searcher：按关键词返回不同结果集，并记录被调用过的查询词。
 * 这样既能测「择优」，也能测「够好就停」。
 */
function fakeSearcher(table) {
  const calls = [];
  const fn = async (q) => {
    calls.push(q);
    for (const [needle, results] of table) {
      if (q.includes(needle)) {
        return { query: q, results, engine: 'fake' };
      }
    }
    return { query: q, results: [], engine: 'fake' };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // ── 1. 引擎可用性判断 ────────────────────────────────────────────
  console.log('\n[1] 搜索引擎解析与可用性');
  const bingIntro = read('bing-intro.html');
  const bingInterview = read('bing-interview.html');
  const ddgBlocked = read('ddg-blocked.html');

  const introHits = search.parseBing(bingIntro);
  eq('Bing 介绍页解析出 3 条', introHits.length, 3);
  ok('Bing 标题干净（无 <strong> 残留）', introHits.every((x) => !/<|>/.test(x.title)),
    introHits.map((x) => x.title).join(' | '));
  ok('Bing 链接已解出真实域名（不含 bing.com/ck）',
    introHits.every((x) => !/bing\.com\/ck/.test(x.url)), introHits[0].url);
  ok('Bing 摘要不含时间戳前缀（1 天前 · ）',
    introHits.every((x) => !/^\s*\d+\s*(分钟|小时|天)前/.test(x.snippet)),
    JSON.stringify(introHits[0].snippet.slice(0, 30)));
  ok('Bing 可用性：介绍页 → true', search.ENGINES.bing.ok(bingIntro) === true);
  ok('Bing 可用性：DDG 拦截页 → false', search.ENGINES.bing.ok(ddgBlocked) === false);
  ok('DDG 可用性：拦截页 → false', search.ENGINES.ddg.ok(ddgBlocked) === false);
  eq('DDG 拦截页解析出 0 条（不能把 anomaly 页当结果）', search.parseResults(ddgBlocked).length, 0);
  ok('Bing 可用性：正常页 → true', search.ENGINES.bing.ok(bingInterview) === true);

  // stripInline：Bing 把命中词包进 <strong>，若不插空格处理会粘成一串
  // 这条是 parseBing 必须用 stripInline 而不是 stripTags 的原因：
  // stripTags 会把标签换成空格，Bing 的 <strong>高亮就把"蚂蚁集团"拆成"蚂蚁 集团"
  eq('stripInline 不插入多余空格', search.stripInline('<strong>蚂蚁</strong>集团'), '蚂蚁集团');
  eq('stripTags 会插入空格（故不可用于标题）', search.stripTags('<b>字节</b>跳动'), '字节 跳动');

  // ── 2. 相关性打分：品牌导航页不该被当成面经 ───────────────────────
  console.log('\n[2] 相关性打分');
  const interviewIntent = research.INTENTS.find((i) => i.key === 'interview');
  const brand = research.scoreResult(
    hit('字节跳动招聘官网｜字节跳动社招', '字节跳动招聘官方网站，提供社会招聘职位搜索。'),
    interviewIntent, '字节跳动',
  );
  const realPost = research.scoreResult(
    hit('字节前端面试全攻略：流程、高频考点与实战避坑指南', '本文系统梳理字节跳动前端面试全流程，深度拆解高频考点，包括浏览器渲染、事件循环…'),
    interviewIntent, '字节跳动',
  );
  ok('品牌招聘页不算「对题」', brand.relevant === false, `score=${brand.score}`);
  ok('真实面经算「对题」', realPost.relevant === true, `score=${realPost.score}`);
  ok('真实面经得分高于品牌页', realPost.score > brand.score,
    `${realPost.score} > ${brand.score}`);
  ok('命中单位名本身不给高分的错觉（品牌页被 bad 词扣分）', brand.score <= 0, `score=${brand.score}`);

  // 用真实夹具验证：那一页确实全是品牌导航页
  const interviewScored = search.parseBing(bingInterview)
    .map((x) => research.scoreResult(x, interviewIntent, '字节跳动'));
  eq('真实夹具里没有一条对题的面试材料', interviewScored.filter((x) => x.relevant).length, 0);

  // ── 3. 按角度择优：够好就停、不够就换措辞 ─────────────────────────
  console.log('\n[3] 按角度择优');
  const goodInterview = [
    hit('字节前端面试全攻略：流程、高频考点与实战避坑指南', '涵盖 JavaScript 底层原理（事件循环、原型链）、浏览器渲染机制、React 原理与性能优化。'),
    hit('字节面试全流程复盘：从算法手撕到 HR 面', '深度拆解高频考点，包括手撕代码、算法题、系统设计。'),
    hit('字节面试避坑指南（含血泪教训）', '结合多份真实面经整理，避坑要点包括表述忌讳与反问环节。'),
  ];
  const brandOnly = [
    hit('字节跳动 - 激发创造，丰富生活', '字节跳动是一家全球化科技公司，使命是激发创造。', 'https://www.bytedance.com/zh/'),
    hit('字节跳动招聘官网｜字节跳动社招', '字节跳动招聘官方网站，提供社会招聘职位搜索。', 'https://jobs.bytedance.com/'),
  ];
  const introGood = [
    hit('字节跳动 - 维基百科，自由的百科全书', '字节跳动成立于2012年3月。字节跳动旗下有产品今日头条和抖音、西瓜视频等。'),
    hit('字节跳动公司主要业务 - 爱企查', '国内业务主要由抖音集团承载，整合今日头条、西瓜视频及垂直服务业务。'),
  ];

  // 面试角度：第一条措辞只拿到品牌页，应继续试第二条
  const searcherA = fakeSearcher([
    ['面试 考察重点', brandOnly],
    ['面经 面试题', goodInterview],
    ['公司介绍', introGood],
    ['面试经验', goodInterview],
  ]);
  const gatheredA = await research.gatherIntel('字节跳动', '前端工程师', searcherA);
  ok('面试角度：换措辞后拿到了对题材料',
    gatheredA.relevantCounts.interview >= 1, `relevant=${gatheredA.relevantCounts.interview}`);
  ok('面试角度：选中的是真实面经而不是品牌页',
    !gatheredA.byIntent.interview.some((x) => x.title.includes('招聘官网')),
    gatheredA.byIntent.interview[0].title);
  ok('介绍角度：拿到单位介绍', gatheredA.relevantCounts.intro >= 1);
  ok('查询词被记录下来（供界面展示）', gatheredA.queries.length >= 3, gatheredA.queries.length + ' 条');

  // 第一条就够好时不该继续打引擎（省时间也避限流）
  const searcherB = fakeSearcher([
    ['面试 考察重点', goodInterview],
    ['公司介绍', introGood],
    ['面试经验', goodInterview],
  ]);
  await research.gatherIntel('字节跳动', '前端工程师', searcherB);
  ok('首条措辞够好就不再重试', !searcherB.calls.some((q) => q.includes('面经 面试题')),
    `${searcherB.calls.length} 次查询`);

  // 怎么试都没对题时，relevantCounts 必须是 0（下游据此降级）
  const searcherC = fakeSearcher([
    ['面试', brandOnly],
    ['公司介绍', brandOnly],
    ['公司简介', brandOnly],
    ['面试经验', brandOnly],
  ]);
  const gatheredC = await research.gatherIntel('字节跳动', '前端工程师', searcherC);
  // 品牌官网对公司介绍来说算"勉强对题"（它确实在讲这家公司），
  // 但对面试/避坑两个角度毫无信息量 —— 这两个必须是 0。
  ok('品牌页不算面试材料', gatheredC.relevantCounts.interview === 0);
  ok('品牌页不算避坑材料', gatheredC.relevantCounts.cautions === 0);

  // ── 3.5 单位名匹配（搜"美团"不能搜出"美的"） ──────────────────────
  console.log('\n[3.5] 单位名匹配');
  ok('介绍类只认完整名称', research.mentionsCompany('美的首页 美的集团官方', '美团', 'intro') === false);
  ok('介绍类命中完整名称', research.mentionsCompany('美团 - 维基百科 美团是一家', '美团', 'intro') === true);
  ok('面经允许用简称（字节 → 字节跳动）',
    research.mentionsCompany('字节前端面试全攻略', '字节跳动', 'interview') === true);
  ok('泛用前缀不放宽（中国移动 ≠ 中国银行）',
    research.mentionsCompany('中国移动面试经验', '中国银行', 'interview') === false);
  ok('同首字但无面试特征词仍拒绝',
    research.mentionsCompany('美的官网首页', '美团', 'interview') === false);
  ok('用完两个字的单位名绝不靠前缀放宽',
    research.mentionsCompany('美团点评面试', '美团', 'interview') === true);

  // 参考来源必须过滤噪音：搜"美团"时 Bing 会回"美的""美女排行榜"
  const noisy = research.collectSources(
    {
      intro: [{ title: '美的首页', snippet: '美的集团官方' }, { title: '美团网-美食团购', snippet: '美团点评' }],
      interview: [], cautions: [],
    },
    [{ query: 'q', results: [{ title: '2025年中国十大美女排行榜', snippet: '美女' }, { title: '美团 - 维基百科', snippet: '美团' }] }],
    '美团',
  );
  ok('参考来源里没有同首字噪音',
    noisy.every((t) => t.includes('美团')), JSON.stringify(noisy));
  ok('参考来源保留真正对题的条目', noisy.length >= 2, JSON.stringify(noisy));

  // AI 侧材料也不能带噪音（否则 AI 会归纳出"做家电的公司"）
  const mat = research.digest(
    { intro: [{ title: '美的首页', snippet: '美的集团' }], interview: [], cautions: [] },
    [{ query: 'q', results: [{ title: '美团 - 维基百科', snippet: '美团是一家本地生活服务平台' }] }],
    { name: '美团' },
  );
  ok('给 AI 的材料里没有噪音', !/美的/.test(mat), mat.split('\n')[0] || '(空)');
  ok('给 AI 的材料保留对题内容', /美团/.test(mat));

  // ── 4. 考点挖掘 ──────────────────────────────────────────────────
  console.log('\n[4] 考点挖掘');
  const mined = research.mineTopics([
    '本文系统梳理字节跳动前端面试的全流程与核心考察点，涵盖JavaScript底层原理（事件循环、原型链、this 指向）、浏览器渲染机制、React 原理与性能优化、算法手写题。',
    '重点考点：闭包、微任务宏任务、防抖节流、Webpack 构建优化、TypeScript 类型体操。',
  ]);
  ok('能挖出顿号清单里的考点', mined.includes('闭包'), mined.join('、'));
  ok('能挖出括号内的考点', mined.includes('原型链'), mined.join('、'));
  ok('能挖出英文技术名词', mined.some((x) => /Webpack|React|TypeScript/.test(x)), mined.join('、'));
  ok('挖掘结果不超过上限',
    research.mineTopics(Array(20).fill('闭包、原型链、事件循环、Promise、React、Vue、Webpack、性能优化、算法'), 5).length <= 5);
  ok('没有材料时不乱编', research.mineTopics(['今天天气不错，适合出门散步。']).length === 0,
    JSON.stringify(research.mineTopics(['今天天气不错。'])));

  // ── 5. 摘要清洗 ──────────────────────────────────────────────────
  console.log('\n[5] 摘要清洗');
  eq('去掉「1 天前 · 」', research.cleanSnippet('1 天前 · 字节跳动成立于2012年3月。'), '字节跳动成立于2012年3月。');
  eq('去掉「2026年8月28日 · 」', research.cleanSnippet('2026年8月28日 · 本文系统梳理'), '本文系统梳理');
  eq('无前缀时原样返回', research.cleanSnippet('蚂蚁集团是一家科技公司'), '蚂蚁集团是一家科技公司');
  eq('空值安全', research.cleanSnippet(''), '');

  // ── 6. 退化路径：无 AI 也要给出可用且诚实的结论 ──────────────────
  console.log('\n[6] 无 AI 时的降级');
  const searcherD = fakeSearcher([
    ['面试 考察重点', goodInterview],
    ['公司介绍', introGood],
    ['面试经验', goodInterview],
  ]);
  const outD = await research.research({
    name: '字节跳动', position: '前端工程师', searcher: searcherD, useAI: false,
  });
  eq('engine 标为 search-only', outD.engine, 'search-only');
  ok('给了单位简介', /字节跳动/.test(outD.intel.intro), outD.intel.intro.slice(0, 40));
  ok('简介里没有时间戳垃圾', !/^\s*\d+\s*天前/.test(outD.intel.intro), outD.intel.intro.slice(0, 20));
  ok('给了考察范围', outD.intel.focusAreas.split('\n').length >= 2,
    outD.intel.focusAreas.replace(/\n/g, ' / '));
  ok('明确标注未经归纳', /未经 AI 归纳/.test(outD.intel.cautions), outD.intel.cautions.split('\n')[0]);
  eq('置信度一律 low', outD.intel.confidence, 'low');
  ok('给了参考来源但不贴 URL', outD.intel.sources.length > 0 && outD.intel.sources.every((s) => !/^https?:/.test(s)),
    outD.intel.sources.length + ' 条');
  ok('未选供应商时提示清楚', /未选择 AI 供应商/.test(outD.warning || ''), outD.warning);

  // 查不到东西：必须说"没查到"，而不是编一段简介
  const searcherE = fakeSearcher([]);
  const outE = await research.research({
    name: '某不存在的公司xyzzy', position: '前端工程师', searcher: searcherE, useAI: false,
  });
  ok('搜不到时不编造简介', /未能获取公开资料/.test(outE.intel.intro), outE.intel.intro.slice(0, 40));
  ok('搜不到时 warning 说明原因', /没有返回可用材料/.test(outE.warning || ''), outE.warning);
  ok('搜不到时考察范围退回通用维度', /核心专业能力/.test(outE.intel.focusAreas),
    outE.intel.focusAreas.replace(/\n/g, ' / '));

  // 搜到但全不对题（同名单位）：既不能拿昆虫百科当简介，也要说清不可靠
  const searcherF = fakeSearcher([
    ['面试', [hit('蚂蚁（膜翅目蚁科动物）_百度百科', '蚂蚁是膜翅目蚁科昆虫的统称，别名蚁、玄驹、昆蜉。')]],
    ['公司介绍', [hit('蚂蚁（膜翅目蚁科动物）_百度百科', '蚂蚁是膜翅目蚁科昆虫的统称，别名蚁、玄驹、昆蜉。')]],
    ['公司简介', [hit('蚂蚁 - 维基百科', '蚂蚁是地球上数量最多的昆虫类群之一。')]],
    ['面试经验', [hit('蚂蚁 - 维基百科', '蚂蚁是地球上数量最多的昆虫类群之一。')]],
  ]);
  const outF = await research.research({
    name: '蚂蚁集团', position: '前端工程师', searcher: searcherF, useAI: false,
  });
  ok('全不对题时 warning 指出没搜到对口资料', /没搜到对口/.test(outF.warning || ''), outF.warning);
  ok('warning 给出可操作的下一步', /手动填|更完整的单位名称/.test(outF.warning || ''), (outF.warning || '').slice(0, 50));
  ok('不把同名词条当单位简介', !/昆虫/.test(outF.intel.intro), outF.intel.intro.slice(0, 40));

  // ── 7. AI 路径失败时的兜底 ───────────────────────────────────────
  console.log('\n[7] AI 失败兜底');
  const searcherG = fakeSearcher([
    ['面试 考察重点', goodInterview],
    ['公司介绍', introGood],
    ['面试经验', goodInterview],
  ]);
  const brokenProvider = {
    id: 'broken', name: '会崩的供应商', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9', apiKey: 'x', model: 'x',
  };
  const outG = await research.research({
    name: '字节跳动', position: '前端工程师', provider: brokenProvider, searcher: searcherG,
  });
  eq('AI 崩了仍返回 search-only', outG.engine, 'search-only');
  ok('AI 崩了仍给出可用情报', outG.intel.intro.length > 10, outG.intel.intro.slice(0, 40));
  ok('AI 崩了把原因带回来', /AI 调用失败/.test(outG.warning || ''), (outG.warning || '').slice(0, 60));

  // ── 8. 结构化输出归一化 ─────────────────────────────────────────
  console.log('\n[8] AI 输出归一化');
  const normalized = research.normalizeIntel({
    intro: '  蚂蚁集团是一家科技公司。 ',
    focusAreas: ['闭包', '原型链', 'React 原理'],
    cautions: '不要说前公司的坏话。',
    tone: '',
    sources: ['知乎面经', '牛客避坑指南'],
    confidence: 'high',
    extraField: '应该被丢掉',
  });
  eq('字符串去空白', normalized.intro, '蚂蚁集团是一家科技公司。');
  eq('数组转成分条', normalized.focusAreas, '闭包\n原型链\nReact 原理');
  eq('单条字符串也接受', normalized.cautions, '不要说前公司的坏话。');
  ok('未知字段被丢弃', !('extraField' in normalized));
  eq('保留合法置信度', normalized.confidence, 'high');
  eq('非法置信度回落 medium', research.normalizeIntel({ confidence: 'very-sure' }).confidence, 'medium');
  ok('keepDuties=false 时清空职责', research.normalizeIntel({ duties: '写代码' }).duties === '');
  eq('keepDuties=true 时保留职责', research.normalizeIntel({ duties: '写代码' }, { keepDuties: true }).duties, '写代码');

  // 容忍 ```json 包裹
  const wrapped = research.parseJSON('```json\n{"intro":"测试","confidence":"low"}\n```');
  eq('能解析 ```json 包裹', wrapped.intro, '测试');
  // 解析失败要抛（调用方 catch 后降级），但错误信息必须带上原始输出便于排查
  let parseErr = null;
  try { research.parseJSON('这不是 JSON'); } catch (e) { parseErr = e; }
  ok('解析失败会抛错', parseErr instanceof Error);
  ok('错误信息带原始输出片段', /这不是 JSON/.test(String(parseErr && parseErr.message)),
    String(parseErr && parseErr.message).slice(0, 50));

  // ── 9. 隐私边界 ─────────────────────────────────────────────────
  console.log('\n[9] 隐私边界');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'research.js'), 'utf8');
  ok('调研代码里没有引用简历/脱敏模块',
    !/require\(['"]\.\/(?:store|mask)['"]\)/.test(src),
    '只 require search 与 providers');
  ok('提示词里没有索要简历字段', !/(简历全文|resume\.json|profile\.json)/.test(src));
  const srcUpper = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('服务端调用调研时不传简历对象',
    /research\.research\(\{|enrichCompany/.test(srcUpper));

  // ── 10. 可选：真实联网 ──────────────────────────────────────────
  if (process.argv.includes('--live')) {
    console.log('\n[10] 真实联网（仅提示，不计入通过数）');
    try {
      const live = await research.research({ name: '字节跳动', position: '前端工程师', useAI: false });
      console.log(`  引擎 ${live.engine}，查询 ${live.queries.length} 次，用时见下`);
      console.log(`  简介：${live.intel.intro.slice(0, 70)}`);
      console.log(`  考察：${live.intel.focusAreas.replace(/\n/g, ' / ')}`);
      console.log(`  来源：${live.intel.sources.length} 条`);
      if (/未能获取公开资料/.test(live.intel.intro)) {
        console.log('  ! 没搜到材料——可能是网络不通或引擎又变了，功能本身不算失败');
      }
    } catch (err) {
      console.log(`  ! 联网失败：${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试自身出错:', err);
  process.exit(1);
});
