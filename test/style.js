'use strict';

/**
 * 样式系统自测：主题 registry + 逐段覆盖 + 自定义 CSS。
 *
 * 核心不变量：
 *   1. 八套主题都能出 HTML 与 PDF，且两边用到的字完全一致（不会各写一套规则）
 *   2. 逐段覆盖（标题样式 / 位置 / 对齐 / 符号 / 字号 / 顺序 / 隐藏）在两边都生效
 *   3. 自定义 CSS 只注入 HTML，导出 PDF 时自动切浏览器引擎
 *   4. 任何主题、任何覆盖组合下，PDF 都不越界、不重叠
 *
 * 用法: node test/style.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const themes = require('../lib/themes');
const render = require('../lib/render');
const pdfEngine = require('../lib/pdf');
const { inspect } = require('./pdf-layout');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-style-'));
const THEME_IDS = Object.keys(themes.THEMES);

function makeProfile() {
  return {
    basics: {
      name: '张伟',
      englishName: 'Zhang Wei',
      title: '高级前端工程师',
      email: 'zhangwei@example.com',
      phone: '13800138000',
      location: '北京',
      website: 'https://github.com/zhangwei',
      summary: '六年前端开发经验，擅长大型 Web 应用的架构设计与性能优化。主导过多个千万级日活产品的重构，'
        + '首屏加载时间平均下降 40%。熟悉 React 生态与工程化体系，有跨端与微前端落地经验。',
    },
    education: [{
      school: '北京大学', major: '计算机科学与技术', degree: '本科',
      start: '2014-09', end: '2018-06', gpa: '3.7/4.0',
      bullets: ['主修数据结构、计算机网络、操作系统'],
    }],
    work: [
      {
        company: '星辰科技有限公司', position: '高级前端工程师', start: '2021-03', end: '至今', location: '北京',
        bullets: [
          '主导核心交易链路的前端重构，首屏时间从 3.2s 降至 1.8s，转化率提升 12%',
          '搭建公司级组件库，覆盖 12 条业务线，平均交付周期缩短 30%',
        ],
      },
      {
        company: '云图网络', position: '前端工程师', start: '2018-07', end: '2021-02',
        bullets: ['负责数据看板产品的前端开发，服务 200+ 企业客户'],
      },
    ],
    projects: [{
      name: '数据可视化平台', org: '星辰科技', role: '前端负责人',
      start: '2022-05', end: '2022-12', tech: ['React', 'TypeScript', 'ECharts'],
      bullets: ['抽象通用图表渲染层，支持 20+ 图表类型', '万级数据表格渲染耗时从 4s 优化到 300ms'],
    }],
    skills: [
      { category: '前端框架', items: ['React', 'Vue', 'TypeScript'] },
      { category: '工程化', items: ['Vite', 'Webpack', 'CI/CD'] },
    ],
    awards: [{ title: '年度优秀员工', date: '2023-01', detail: '公司级前 5%' }],
    certificates: [{ title: 'CET-6', date: '2016-12', detail: '580 分' }],
    customSections: [{ title: '开源贡献', items: ['为 Vite 提交过 3 个 PR', '维护一个 1.2k star 的组件库'] }],
  };
}

/** 从 HTML 里取正文纯文字 */
function plainHtml(html) {
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, html])[1];
  return body
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    // 联系方式里的 · 是版式分隔符：HTML 一行放得下、PDF 可能折成两行，
    // 分隔符数量随之变化，所以比对用字时统一去掉。
    .replace(/[\s•▪○–·]/g, '');
}

/** 从 PDF 里取回纯文字 */
async function plainPdf(buf, file) {
  fs.writeFileSync(file, buf);
  const { extractRuns } = require('./pdf-layout');
  const { pages } = await extractRuns(file);
  return pages.map((p) => p.runs.map((r) => r.str).join('')).join('').replace(/[\s•▪○–·]/g, '');
}

const canon = (s) => Array.from(s).sort().join('');

function diffChars(a, b) {
  const counts = (x) => {
    const m = new Map();
    for (const c of x) m.set(c, (m.get(c) || 0) + 1);
    return m;
  };
  const ca = counts(a);
  const cb = counts(b);
  const out = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const d = (ca.get(k) || 0) - (cb.get(k) || 0);
    if (d !== 0) out.push([k, d]);
  }
  return out;
}

async function main() {
  const profile = makeProfile();

  console.log('\n=== 1. 主题定义 ===');
  ok('至少 8 套主题', THEME_IDS.length >= 8, `${THEME_IDS.length} 套：${THEME_IDS.join(' / ')}`);
  eq('默认主题存在', !!themes.THEMES[themes.DEFAULT_THEME], true);
  const REQUIRED = ['id', 'name', 'desc', 'accent', 'ink', 'muted', 'soft', 'fontFamily', 'header', 'sectionTitle', 'bullet', 'fontSize', 'lineHeight'];
  const VALID_HEADER = ['band', 'rule', 'center', 'plain'];
  const VALID_TITLE = ['underline', 'bar', 'plain', 'caps', 'chip', 'gutter'];
  const VALID_BULLET = ['dot', 'dash', 'square', 'ring'];
  for (const id of THEME_IDS) {
    const t = themes.THEMES[id];
    const missing = REQUIRED.filter((k) => t[k] == null);
    ok(`${id}：字段完整`, !missing.length, missing.length ? `缺 ${missing.join(',')}` : '');
    eq(`${id}：id 与键一致`, t.id, id);
    ok(`${id}：header 合法`, VALID_HEADER.includes(t.header), t.header);
    ok(`${id}：sectionTitle 合法`, VALID_TITLE.includes(t.sectionTitle), t.sectionTitle);
    ok(`${id}：bullet 合法`, VALID_BULLET.includes(t.bullet), t.bullet);
    ok(`${id}：色值合法`, /^#[0-9a-f]{6}$/i.test(t.accent) && /^#[0-9a-f]{6}$/i.test(t.ink), t.accent);
  }
  const distinct = new Set(THEME_IDS.map((id) => `${themes.THEMES[id].header}|${themes.THEMES[id].sectionTitle}`));
  ok('主题之间不只是换颜色', distinct.size >= 5, `${distinct.size} 种头部/标题组合`);

  // ── 1.5 主题的结构差异：不只是换颜色 ──
  console.log('\n=== 1.5 主题结构差异 ===');
  const structOf = (id) => {
    const t = themes.THEMES[id];
    return `${t.header}|${t.sectionTitle}|${t.itemLayout || 'stack'}|${t.numbering || 'none'}|${t.skills || 'rows'}`;
  };
  const structs = new Set(THEME_IDS.map(structOf));
  ok('8 套主题的结构组合各不相同', structs.size === THEME_IDS.length,
    `${structs.size}/${THEME_IDS.length} 种`);

  // 头部形态至少三种，条目排法至少三种，不能全靠配色区分
  ok('头部形态至少有 3 种', new Set(THEME_IDS.map((id) => themes.THEMES[id].header)).size >= 3,
    [...new Set(THEME_IDS.map((id) => themes.THEMES[id].header))].join(','));
  ok('章节标题形态至少有 5 种',
    new Set(THEME_IDS.map((id) => themes.THEMES[id].sectionTitle)).size >= 5);
  ok('条目排法至少有 3 种',
    new Set(THEME_IDS.map((id) => themes.THEMES[id].itemLayout || 'stack')).size >= 3,
    [...new Set(THEME_IDS.map((id) => themes.THEMES[id].itemLayout))].join(','));
  ok('项目符号至少有 3 种', new Set(THEME_IDS.map((id) => themes.THEMES[id].bullet)).size >= 3);
  ok('技能形态有两种', new Set(THEME_IDS.map((id) => themes.THEMES[id].skills || 'rows')).size >= 2);

  // 每种条目排法都要在 HTML 里真的换掉 DOM，而不是只换个 class。
  // 注意只看 <body> 里的标记——CSS 里本来就有 .item-when / .sec-num 这些选择器，
  // 拿整份 HTML 去 grep 会永远命中。
  const layoutMarkup = (theme) => {
    const h = render.renderHTML(profile, { theme });
    const i = h.indexOf('<body>');
    return i < 0 ? h : h.slice(i);
  };
  const stackHtml = layoutMarkup('aurora');
  const blockHtml = layoutMarkup('timeline');
  const cardHtml = layoutMarkup('modern');
  const inlineHtml = layoutMarkup('editorial');
  ok('stack 排法：时间在标题行右侧', /class="item-right"/.test(stackHtml) && !/item-when/.test(stackHtml));
  ok('block 排法：时间单独占一行', /class="item-when"/.test(blockHtml) && /sec--items-block/.test(blockHtml));
  ok('card 排法：条目带卡片类名', /class="item item--card"/.test(cardHtml));
  ok('inline 排法：时间与单位同一行', /item-head--inline/.test(inlineHtml));
  ok('四种排法的 DOM 互不相同',
    new Set([stackHtml, blockHtml, cardHtml, inlineHtml].map((h) => {
      const m = h.match(/<article class="item[^"]*">[\s\S]{0,220}/);
      return m ? m[0] : '';
    })).size >= 3);

  // 章节序号
  ok('classic 章节带顿号编号', /<span class="sec-num">一、<\/span>/.test(layoutMarkup('classic')));
  ok('spotlight 章节带 01 编号', /<span class="sec-num">01<\/span>/.test(layoutMarkup('spotlight')));
  ok('aurora 不编号', !/sec-num/.test(stackHtml));

  // 技能标签
  ok('modern 技能渲染成标签', /class="skill-tag"/.test(cardHtml));
  ok('aurora 技能是一行文字', /class="skill-items"/.test(stackHtml));

  // 逐段覆盖也能改这三项
  const ovRes = themes.resolve({ theme: 'aurora', layout: { sections: { work: { itemLayout: 'card', numbering: 'index' } } } });
  const ovWork = ovRes.sections.find((s) => s.key === 'work');
  eq('逐段可以覆盖条目排法', ovWork.itemLayout, 'card');
  eq('逐段可以覆盖编号', ovWork.numbering, 'index');
  const ovHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { work: { itemLayout: 'card' } } } });
  ok('覆盖后的排法真的进到 HTML 里', /class="item item--card"/.test(ovHtml));

  // ── 1.6 圆角与图标：这一维必须能拉开差异，不能八套一个模子 ──
  console.log('\n=== 1.6 圆角与图标 ===');
  ok('12 套主题', THEME_IDS.length >= 12, `${THEME_IDS.length} 套`);
  const withRadius = THEME_IDS.map((id) => themes.THEMES[id].radius || 'soft');
  const withIcon = THEME_IDS.map((id) => themes.THEMES[id].icon || 'none');
  ok('圆角形态至少有 3 种', new Set(withRadius).size >= 3, [...new Set(withRadius)].join(','));
  ok('图标至少有 3 种（含无图标）', new Set(withIcon).size >= 3, [...new Set(withIcon)].join(','));
  const combo = new Set(THEME_IDS.map((id) => `${themes.THEMES[id].radius || 'soft'}|${themes.THEMES[id].icon || 'none'}`));
  ok('圆角+图标的组合至少 6 种', combo.size >= 6, `${combo.size} 种`);
  ok('至少有一套主题完全没有圆角', withRadius.includes('sharp'));
  ok('至少有一套主题是全圆角', withRadius.includes('pill'));
  ok('至少有一套主题完全不显示图标', withIcon.includes('none'));

  // 直角主题的圆角变量必须真的是 0，不能留 2px 的圆边
  const sharpCss = render.renderCSS({ theme: 'editorial' });
  eq('直角主题 --radius 是 0', (sharpCss.match(/--radius: ([^;]+);/) || [])[1], '0px');
  eq('直角主题 --radius-sm 也是 0', (sharpCss.match(/--radius-sm: ([^;]+);/) || [])[1], '0px');
  ok('大圆角主题 --radius 不是 0', (render.renderCSS({ theme: 'aurora' }).match(/--radius: ([^;]+);/) || [])[1] !== '0px');
  // sharp 的合法值就是 0，用 || 兜底会把它误判成"没设置"
  eq('sharp 不能被兜底成 soft', themes.resolve({ theme: 'modern', layout: { radius: 'sharp' } }).vars.radius, 0);
  eq('pill 解析成 999', themes.resolve({ theme: 'modern', layout: { radius: 'pill' } }).vars.radius, 999);

  // 图标真的画进 HTML，且与文字有间距
  const icoHtml = layoutMarkup('modern');
  ok('带图标的主题真的有 svg', /<svg class="sec-ico"/.test(icoHtml));
  ok('无图标的主题没有 svg', !/<svg class="sec-ico"/.test(layoutMarkup('aurora')));
  ok('图标有 margin-right（不贴字）', /\.sec-ico\s*\{[^}]*margin-right/.test(render.renderCSS({ theme: 'modern' })));
  ok('序号也有 margin-right（不贴字）', /\.sec-num\s*\{[^}]*margin-right/.test(render.renderCSS({ theme: 'classic' })));
  // 只覆盖 work 不够——re 抓的是全页第一个 svg，那也是别的板块的图标。
  // 把每个板块都覆盖成同一个形状，再看抓到的路径是否随形状变化。
  const shapeOf = (k) => {
    const sections = {};
    for (const key of themes.describe().sections.map((x) => x.key)) sections[key] = { icon: k };
    const h = render.renderHTML(profile, { theme: 'modern', layout: { sections } });
    return (h.match(/<svg class="sec-ico"[^>]*>([\s\S]*?)<\/svg>/) || [])[1] || '';
  };
  eq('五种图标形状互不相同', new Set(['dot', 'square', 'line', 'ring', 'diamond'].map(shapeOf)).size, 5);

  // 逐段可以覆盖图标
  const ovIco = themes.resolve({ theme: 'aurora', layout: { sections: { work: { icon: 'diamond' } } } });
  eq('逐段可以覆盖图标', ovIco.sections.find((s) => s.key === 'work').icon, 'diamond');

  // PDF 端画出同样的图标：形状原语必须存在且能出页
  ok('PDF writer 有 roundRect', typeof new (require('../lib/pdf/writer').PDFWriter)({ size: 'A4' }).roundRect === 'function');
  ok('PDF writer 有 poly', typeof new (require('../lib/pdf/writer').PDFWriter)({ size: 'A4' }).poly === 'function');

  console.log('\n=== 2. 令牌解析与顺序 ===');
  const d = themes.describe();
  ok('describe 给前端主题列表', (d.themes || []).length === THEME_IDS.length);
  ok('describe 给章节元信息', (d.sections || []).length === themes.DEFAULT_ORDER.length);
  ok('describe 给可选项', d.titles.length >= 6 && d.bullets.length >= 4 && d.aligns.length >= 3 && d.placements.length >= 2);

  const base = themes.resolve({ theme: 'aurora' });
  eq('默认顺序与 DEFAULT_ORDER 一致', base.sections.map((s) => s.key).join(','), themes.DEFAULT_ORDER.join(','));
  eq('customSections 永远最后', base.sections[base.sections.length - 1].key, 'customSections');
  ok('accent 可被覆盖', themes.resolve({ theme: 'aurora', accent: '#123456' }).vars.accent === '#123456');
  ok('字号可被覆盖', themes.resolve({ theme: 'aurora', fontSize: 15 }).vars.fontSize === 15);
  ok('非法字号回落主题默认', themes.resolve({ theme: 'aurora', fontSize: 'abc' }).vars.fontSize === themes.THEMES.aurora.fontSize);

  const reordered = themes.resolve({ theme: 'aurora', layout: { order: ['work', 'summary', 'customSections'] } });
  eq('自定义顺序生效且补全', reordered.sections.slice(0, 2).map((s) => s.key).join(','), 'work,summary');
  eq('自定义顺序后 customSections 仍在最后', reordered.sections[reordered.sections.length - 1].key, 'customSections');
  ok('未知键被忽略', !reordered.sections.some((s) => s.key === 'nonsense'));

  const gutter = themes.resolve({ theme: 'editorial', layout: { sections: { skills: { titleStyle: 'gutter' } } } });
  const skillSec = gutter.sections.find((s) => s.key === 'skills');
  eq('gutter 自动把标题放到左侧', skillSec.placement, 'left');
  eq('editorial 本来就是左栏主题，其它章节也在左侧', gutter.sections.find((s) => s.key === 'work').placement, 'left');
  const auroraGutter = themes.resolve({ theme: 'aurora', layout: { sections: { skills: { titleStyle: 'gutter' } } } });
  eq('非 gutter 主题里其它章节仍在标题在上方', auroraGutter.sections.find((s) => s.key === 'work').placement, 'above');

  const over = themes.resolve({
    theme: 'aurora',
    layout: {
      header: { style: 'center', align: 'center', chips: false, showTitle: false },
      sections: {
        work: { title: '实习与工作', titleStyle: 'chip', align: 'center', bullet: 'ring', scale: 0.9 },
        projects: { visible: false },
      },
    },
  });
  const w = over.sections.find((s) => s.key === 'work');
  eq('头部样式覆盖', over.header.style, 'center');
  ok('头部 chips 开关', over.header.chips === false && over.header.showTitle === false);
  eq('章节改名', w.title, '实习与工作');
  eq('章节标题样式', w.titleStyle, 'chip');
  eq('章节对齐', w.align, 'center');
  eq('章节符号', w.bullet, 'ring');
  eq('章节字号倍率', w.scale, 0.9);
  eq('章节可单独隐藏', over.sections.find((s) => s.key === 'projects').visible, false);

  const hidden = themes.resolve({ theme: 'aurora', hidden: ['basics', 'awards'] });
  eq('hidden 能隐藏头部', hidden.header.visible, false);
  eq('hidden 能隐藏章节', hidden.sections.find((s) => s.key === 'awards').visible, false);

  const css = themes.resolve({ theme: 'aurora', layout: { customCSS: '.name{color:red}' } });
  eq('自定义 CSS 进 cfg', css.customCSS, '.name{color:red}');
  eq('自定义 CSS 别名也认', themes.resolve({ theme: 'aurora', customCSS: '.x{}' }).customCSS, '.x{}');

  console.log('\n=== 3. HTML 渲染 ===');
  for (const id of THEME_IDS) {
    const html = render.renderHTML(profile, { theme: id });
    const t = themes.THEMES[id];
    ok(`${id}：头部 class 跟随主题`, html.includes(`head head--${t.header}`), t.header);
    ok(`${id}：章节都带 sec 本体`, (html.match(/class="sec sec--/g) || []).length === themes.DEFAULT_ORDER.length,
      `${(html.match(/class="sec sec--/g) || []).length} 个`);
    ok(`${id}：设计令牌写进 :root`, html.includes('--accent:') && html.includes('--font-size:'));
    ok(`${id}：正文内容都在`, html.includes(profile.work[0].company) && html.includes(profile.basics.name));
    ok(`${id}：没有未替换的模板变量`, !html.includes('${') && !html.includes('undefined'));
  }

  const chipHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { work: { titleStyle: 'chip' } } } });
  ok('逐段覆盖体现在 class 上', chipHtml.includes('sec--t-chip'));
  const leftHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { work: { titleStyle: 'gutter' } } } });
  ok('gutter 体现为左栏布局', leftHtml.includes('sec--left'));
  const scaleHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { work: { scale: 0.9 } } } });
  ok('字号倍率写成 CSS 变量', scaleHtml.includes('--sec-scale:0.9'));
  const renHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { work: { title: '实习与工作' } } } });
  ok('章节改名出现在 HTML', renHtml.includes('实习与工作') && !renHtml.includes('>工作经历<'));
  const hidHtml = render.renderHTML(profile, { theme: 'aurora', layout: { sections: { awards: { visible: false } } } });
  ok('隐藏章节不出现在 HTML', !hidHtml.includes(profile.awards[0].title));
  const cssHtml = render.renderHTML(profile, { theme: 'aurora', layout: { customCSS: '.name{color:#ff0000}' } });
  ok('自定义 CSS 注入 HTML', cssHtml.includes('.name{color:#ff0000}'));
  ok('自定义 CSS 在主题样式之后', cssHtml.lastIndexOf('.name{color:#ff0000}') > cssHtml.indexOf('--accent:'));
  const emptyCssHtml = render.renderHTML(profile, { theme: 'aurora', layout: { customCSS: '   ' } });
  ok('空白 CSS 不产生空注释块', !emptyCssHtml.includes('===== 自定义 CSS ====='));

  const md = render.renderMarkdown(profile, { theme: 'aurora', layout: { sections: { work: { title: '实习与工作' }, awards: { visible: false } } } });
  ok('Markdown 跟随章节改名', md.includes('实习与工作'));
  ok('Markdown 尊重隐藏', !md.includes(profile.awards[0].title));
  ok('Markdown 不含自定义 CSS', !md.includes('.name{color'));

  console.log('\n=== 4. PDF 渲染（八套主题） ===');
  for (const id of THEME_IDS) {
    const file = path.join(TMP, `${id}.pdf`);
    const buf = await pdfEngine.renderPDF(profile, { theme: id, pageSize: 'A4', margin: '14mm 15mm' }, { engine: 'builtin' });
    fs.writeFileSync(file, buf);
    const r = await inspect(file, { margin: '14mm 15mm' });
    ok(`${id}：不越界不重叠`, r.problems.length === 0, r.problems.slice(0, 2).map((p) => `${p.kind}:${p.str}`).join(' | '));
    ok(`${id}：A4 尺寸`, r.pages[0].widthMm === 210 && r.pages[0].heightMm === 297, `${r.pages[0].widthMm}×${r.pages[0].heightMm}mm`);
    const text = await plainPdf(buf, file);
    ok(`${id}：关键内容可回读`, text.includes(profile.work[0].company) && text.includes(profile.basics.name) && text.includes('开源贡献'));
    ok(`${id}：无方框与乱码`, !text.includes('\uFFFD') && !text.includes('\u0000'));
    const hp = plainHtml(render.renderHTML(profile, { theme: id }));
    const diff = diffChars(hp, text);
    ok(`${id}：PDF 与 HTML 用字一致`, diff.length === 0, diff.length ? JSON.stringify(diff.slice(0, 6)) : '');
  }

  console.log('\n=== 5. 逐段覆盖在 PDF 里生效 ===');
  const cases = [
    { name: '标题色块', layout: { sections: { work: { titleStyle: 'chip' } } } },
    { name: '左侧栏标题', layout: { sections: { work: { titleStyle: 'gutter' }, skills: { titleStyle: 'gutter' } } } },
    { name: '居中正文', layout: { sections: { summary: { align: 'center' } } } },
    { name: '环形符号', layout: { sections: { work: { bullet: 'ring' } } } },
    { name: '短横符号', layout: { sections: { projects: { bullet: 'dash' } } } },
    { name: '方点符号', layout: { sections: { work: { bullet: 'square' } } } },
    { name: '无符号', layout: { sections: { work: { bullet: 'none' } } } },
    { name: '小字号章节', layout: { sections: { work: { scale: 0.8 } } } },
    { name: '大字号章节', layout: { sections: { work: { scale: 1.35 } } } },
    { name: '隐藏标题', layout: { sections: { awards: { titleStyle: 'hidden' } } } },
    { name: '改名 + 隐藏章节', layout: { sections: { work: { title: '实习与工作' }, projects: { visible: false } } } },
    { name: '倒序章节', layout: { order: ['customSections', 'work', 'summary', 'skills', 'projects', 'education', 'awards', 'certificates'] } },
    { name: '居中头部', layout: { header: { style: 'center' } } },
    { name: '纯文字头部', layout: { header: { style: 'plain', chips: false } } },
    { name: '无联系方式头部', layout: { header: { showContacts: false } } },
    { name: 'Letter + 窄边距', layout: {}, opts: { pageSize: 'Letter', margin: '10mm' } },
    { name: '全程 timeline', layout: { sections: { work: { timeline: true }, projects: { timeline: true }, education: { timeline: true } } } },
  ];
  for (const c of cases) {
    const file = path.join(TMP, `ov-${pass}.pdf`);
    const buf = await pdfEngine.renderPDF(profile, { theme: 'aurora', ...(c.opts || {}), layout: c.layout }, { engine: 'builtin' });
    fs.writeFileSync(file, buf);
    const margin = (c.opts && c.opts.margin) || '14mm 15mm';
    const r = await inspect(file, { margin });
    ok(`${c.name}：版面合规`, r.problems.length === 0, r.problems.slice(0, 2).map((p) => `${p.kind}:${p.str}`).join(' | '));
  }

  // 覆盖的组合确实改变了输出，而不是被悄悄忽略
  const plain = await pdfEngine.renderPDF(profile, { theme: 'aurora' }, { engine: 'builtin' });
  const renamed = await pdfEngine.renderPDF(profile, { theme: 'aurora', layout: { sections: { work: { title: '实习与工作' } } } }, { engine: 'builtin' });
  const p1 = await plainPdf(plain, path.join(TMP, 'cmp-a.pdf'));
  const p2 = await plainPdf(renamed, path.join(TMP, 'cmp-b.pdf'));
  ok('PDF 里章节确实改名了', p2.includes('实习与工作') && !p1.includes('实习与工作'));
  const hiddenWork = await pdfEngine.renderPDF(profile, { theme: 'aurora', layout: { sections: { work: { visible: false } } } }, { engine: 'builtin' });
  const p3 = await plainPdf(hiddenWork, path.join(TMP, 'cmp-c.pdf'));
  ok('PDF 里章节确实被隐藏了', !p3.includes(profile.work[0].company));
  const noTitle = await pdfEngine.renderPDF(profile, { theme: 'aurora', layout: { sections: { work: { titleStyle: 'hidden' } } } }, { engine: 'builtin' });
  const p4 = await plainPdf(noTitle, path.join(TMP, 'cmp-d.pdf'));
  ok('PDF 里标题确实藏起来了', !p4.includes('工作经历') && p4.includes(profile.work[0].company));

  // ── 5.5 字号阶梯：HTML 与 PDF 必须取同一份数值 ──
  console.log('\n=== 5.5 字号阶梯与间距 ===');
  const m = themes.resolve({ theme: 'aurora' }).m;
  ok('resolve 带回字号阶梯', !!m && typeof m.name === 'number', `name=${m && m.name}`);
  const REQUIRED_M = ['fontSize', 'lineHeight', 'gap', 'name', 'title', 'sectionTitle', 'eyebrow',
    'org', 'role', 'meta', 'chip', 'summary', 'headGap', 'sectionGap', 'titleGap', 'itemGap',
    'bulletGap', 'bulletIndent', 'nameTracking'];
  const missingM = REQUIRED_M.filter((k) => m[k] == null);
  ok('阶梯字段齐全', !missingM.length, missingM.join(','));

  // 层级关系：名字 > 章节标题 > 正文 > 注释。塌了就是排版失去层次。
  ok('名字最大', m.name > m.sectionTitle * 1.5, `${m.name.toFixed(1)} vs ${m.sectionTitle.toFixed(1)}`);
  ok('章节标题不小于正文', m.sectionTitle >= m.fontSize * 0.95, m.sectionTitle.toFixed(1));
  ok('注释小于正文', m.meta < m.fontSize, `${m.meta.toFixed(1)} < ${m.fontSize}`);
  ok('字距小标最小', m.eyebrow < m.meta, `${m.eyebrow.toFixed(1)}`);
  ok('章节间距大于标题间距', m.sectionGap > m.titleGap);
  ok('头部间距大于章节间距', m.headGap > m.sectionGap);

  // 居中排版的姓名更大（大字标题），字距要拉开
  const centerM = themes.resolve({ theme: 'spotlight' }).m;
  ok('居中排版的姓名更大', centerM.name > m.name, `${centerM.name.toFixed(1)} > ${m.name.toFixed(1)}`);
  ok('居中排版的字距是正值', centerM.nameTracking > 0, String(centerM.nameTracking));
  ok('左对齐排版的字距收紧', m.nameTracking < 0, String(m.nameTracking));

  // 改字号时整条阶梯等比缩放；改密度时只动间距
  const big = themes.metrics(20, 1.6, 1, 'band');
  const small = themes.metrics(10, 1.6, 1, 'band');
  ok('字号翻倍时名字也翻倍', Math.abs(big.name / small.name - 2) < 0.01, (big.name / small.name).toFixed(3));
  ok('间距不随字号变', Math.abs(big.sectionGap - small.sectionGap) < 0.01);
  const dense = themes.metrics(13.5, 1.6, 1.4, 'band');
  ok('密度加大时间距变大', dense.sectionGap > themes.metrics(13.5, 1.6, 1, 'band').sectionGap);

  // HTML 里这些值必须真的落到 CSS 变量上
  const metricsHtml = render.renderHTML(profile, { theme: 'aurora' });
  ok('CSS 变量里有名字字号', /--m-name:\s*[\d.]+px/.test(metricsHtml), (metricsHtml.match(/--m-name:[^;]+/) || [''])[0]);
  ok('CSS 变量里有章节间距', /--m-section-gap:\s*[\d.]+px/.test(metricsHtml));
  ok('CSS 不再硬编码姓名倍率', !/font-size:\s*calc\(var\(--font-size\)\s*\*\s*1\.82\)/.test(metricsHtml));

  // 窄屏预览要放弃纸张比例，否则 794px 的纸塞进 312px 的框只能横滚
  ok('窄屏有重排规则', /@media screen and \(max-width: 620px\)/.test(metricsHtml));
  ok('窄屏下左栏标题退回标题在上方', /max-width: 620px[\s\S]{0,900}\.sec--left\s*\{\s*display:\s*block/.test(metricsHtml));

  console.log('\n=== 6. 引擎选择 ===');
  eq('有 CSS 时识别出 CSS', pdfEngine.customCSSOf({ layout: { customCSS: '.a{}' } }), '.a{}');
  eq('空白 CSS 视为没有', pdfEngine.customCSSOf({ layout: { customCSS: '  \n ' } }), '');
  eq('顶层 customCSS 也认', pdfEngine.customCSSOf({ customCSS: '.b{}' }), '.b{}');
  const chrome = require('../lib/pdf/chrome').available();
  ok('浏览器引擎状态可查询', typeof chrome.ok === 'boolean', chrome.ok ? '可用' : chrome.error);
  if (chrome.ok) {
    const cssPdf = await pdfEngine.renderPDF(profile, { theme: 'aurora', layout: { customCSS: '.name{color:#c00}' } });
    ok('有自定义 CSS 时改用浏览器引擎', /Skia\/PDF/.test(cssPdf.toString('latin1')), 'Skia');
    const plainPdfBuf = await pdfEngine.renderPDF(profile, { theme: 'aurora' });
    ok('没有自定义 CSS 时用内置引擎', /Resume Optimizer PDF Engine/.test(plainPdfBuf.toString('latin1')));
    const forced = await pdfEngine.renderPDF(profile, { theme: 'aurora', layout: { customCSS: '.x{}' } }, { engine: 'builtin' });
    ok('显式指定 builtin 时不切引擎', /Resume Optimizer PDF Engine/.test(forced.toString('latin1')));
    // HTTP 导出只方便传一层参数，引擎开关写在 opts 里也要认
    const optBuiltin = await pdfEngine.renderPDF(profile, { theme: 'aurora', engine: 'builtin', layout: { customCSS: '.x{}' } });
    ok('opts.engine=builtin 同样不切引擎', /Resume Optimizer PDF Engine/.test(optBuiltin.toString('latin1')));
    const optChrome = await pdfEngine.renderPDF(profile, { theme: 'aurora', engine: 'chrome' });
    ok('opts.engine=chrome 强制浏览器引擎', /Skia\/PDF/.test(optChrome.toString('latin1')));
  }

  console.log('\n=== 7. 页面尺寸与装饰 ===');
  for (const [size, mm] of [['A4', [210, 297]], ['Letter', [215.9, 279.4]], ['A5', [148, 210]]]) {
    const file = path.join(TMP, `size-${size}.pdf`);
    const buf = await pdfEngine.renderPDF(profile, { theme: 'aurora', pageSize: size }, { engine: 'builtin' });
    fs.writeFileSync(file, buf);
    const r = await inspect(file, { margin: '14mm 15mm' });
    ok(`${size} 尺寸正确`, Math.abs(r.pages[0].widthMm - mm[0]) < 1 && Math.abs(r.pages[0].heightMm - mm[1]) < 1,
      `${r.pages[0].widthMm}×${r.pages[0].heightMm}mm`);
    ok(`${size} 不越界`, r.problems.length === 0, `${r.problems.length} 个问题`);
  }
  const wmFile = path.join(TMP, 'wm.pdf');
  const wmBuf = await pdfEngine.renderPDF(profile, { theme: 'aurora', showWatermark: true, watermarkText: '内部草稿', showPageNumbers: true }, { engine: 'builtin' });
  fs.writeFileSync(wmFile, wmBuf);
  const wm = await inspect(wmFile, { margin: '14mm 15mm' });
  ok('水印是旋转文字', wm.watermarks.length > 0, `${wm.watermarks.length} 段`);
  ok('水印不参与越界判定', wm.problems.length === 0);
  ok('页码存在', wm.footers.length > 0, wm.footers.join(' '));

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  // 自定义 CSS 那组会用 Chrome 引擎渲一次 PDF，浏览器实例不关掉进程就一直挂着不退
  await render.closeBrowser();
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
