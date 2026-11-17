'use strict';

/**
 * 渲染层：把简历数据渲染为 HTML / Markdown。
 *
 * 样式全部来自 lib/themes.js 的 resolve()——这里不判断「哪个主题该长什么样」，
 * 只把解析结果翻译成 CSS 变量与 class。所以新增主题不用改这个文件。
 *
 * 自定义 CSS 的可用选择器（导出页里有同一份说明）：
 *   .page            整页容器（可改 padding / 背景 / 字体）
 *   .head            头部区域      .name 姓名      .title 职位      .contacts 联系方式行
 *   .chip            联系方式的每一项
 *   .sec             一个章节      .sec-title 章节标题      .sec-body 章节正文
 *   .item            一条经历      .item-head 标题行      .item-org 机构/公司
 *   .item-role       职位/专业     .item-right 时间      .item-sub 补充行      .tech 技术栈
 *   .bullets         要点列表      .bullets li 单条要点
 *   .summary         个人简介段落  .skill-row 技能行      .skill-cat 技能分类
 * 变量：--accent --accent2 --ink --muted --soft --font-size --line-height --gap --label-w
 */

const themes = require('./themes');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nonEmpty(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function range(start, end) {
  const a = String(start || '').trim();
  const b = String(end || '').trim();
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  return `${a} – ${b}`;
}

const BULLET_CHAR = { dot: '•', dash: '–', square: '▪', ring: '○', none: '' };

function bulletsHtml(list, bullet) {
  const items = (list || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!items.length) return '';
  const cls = bullet && bullet !== 'dot' ? `bullets bullets--${bullet}` : 'bullets';
  return `<ul class="${cls}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}

/* ---------------- 各板块的正文片段 ---------------- */

const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 章节序号：01 / 02 或 一、二、 */
function numberLabel(kind, index) {
  if (kind === 'index') return String(index + 1).padStart(2, '0');
  if (kind === 'dot') return `${CN_NUMS[index] || index + 1}、`;
  return '';
}

/** 一条经历的标题行。四种排法的 DOM 不同，不只是换 CSS。 */
function itemHead(org, role, right, layout) {
  const roleHtml = role ? `<span class="item-role">${esc(role)}</span>` : '';
  if (layout === 'block') {
    // 时间单独占一行压在单位上方，像履历表
    return `<div class="item-when">${right}</div>
        <div class="item-head">
          <div class="item-left"><span class="item-org">${esc(org)}</span>${roleHtml}</div>
        </div>`;
  }
  if (layout === 'inline') {
    // 单位 · 职位 · 时间 连成一行，像杂志的署名行，不把时间推到右边缘
    return `<div class="item-head item-head--inline">
          <div class="item-left"><span class="item-org">${esc(org)}</span>${roleHtml}<span class="item-right">${right}</span></div>
        </div>`;
  }
  return `<div class="item-head">
          <div class="item-left"><span class="item-org">${esc(org)}</span>${roleHtml}</div>
          <div class="item-right">${right}</div>
        </div>`;
}

function bodyOf(key, profile, sec) {
  const bullet = sec.bullet;
  const layout = sec.itemLayout || 'stack';
  const itemCls = layout === 'card' ? 'item item--card' : 'item';
  switch (key) {
    case 'summary': {
      const s = (profile.basics || {}).summary;
      return s ? `<p class="summary">${esc(s)}</p>` : '';
    }
    case 'skills': {
      if (!nonEmpty(profile.skills)) return '';
      const rows = profile.skills.map((s) => ({
        cat: s.category || '技能',
        items: (s.items || []).filter(Boolean),
      })).filter((r) => r.items.length || r.cat !== '技能');
      if (!rows.length) return '';
      // tags 形态：分类名后面跟一排小标签，块感强、扫得快
      if (sec.skills === 'tags') {
        return rows.map((r) => `<div class="skill-row skill-row--tags">
          <span class="skill-cat">${esc(r.cat)}</span>
          <span class="skill-tags">${r.items.map((i) => `<span class="skill-tag">${esc(i)}</span>`).join('')}</span>
        </div>`).join('');
      }
      return rows.map((r) => `<div class="skill-row"><span class="skill-cat">${esc(r.cat)}</span><span class="skill-items">${esc(r.items.join('、'))}</span></div>`).join('');
    }
    case 'work': {
      if (!nonEmpty(profile.work)) return '';
      return profile.work.map((j) => `<article class="${itemCls}">
        ${itemHead(j.company, j.position, `${esc(range(j.start, j.end))}${j.location ? `<span class="item-loc">${esc(j.location)}</span>` : ''}`, layout)}
        ${bulletsHtml(j.bullets, bullet)}
      </article>`).join('');
    }
    case 'projects': {
      if (!nonEmpty(profile.projects)) return '';
      return profile.projects.map((p) => `<article class="${itemCls}">
        ${itemHead(p.name, p.role, esc(range(p.start, p.end)), layout)}
        ${p.org ? `<div class="item-sub">${esc(p.org)}</div>` : ''}
        ${nonEmpty(p.tech) ? `<div class="tech">技术栈：${esc(p.tech.join('、'))}</div>` : ''}
        ${bulletsHtml(p.bullets, bullet)}
      </article>`).join('');
    }
    case 'education': {
      if (!nonEmpty(profile.education)) return '';
      return profile.education.map((e) => `<article class="${itemCls}">
        ${itemHead(e.school, [e.major, e.degree].filter(Boolean).join(' · '), `${esc(range(e.start, e.end))}${e.gpa ? `<span class="item-loc">GPA ${esc(e.gpa)}</span>` : ''}`, layout)}
        ${bulletsHtml(e.bullets, bullet)}
      </article>`).join('');
    }
    case 'awards': {
      if (!nonEmpty(profile.awards)) return '';
      const items = profile.awards.map((a) => [a.title, a.date, a.detail].filter(Boolean).join(' · ')).filter(Boolean);
      if (!items.length) return '';
      return `<ul class="bullets${bullet && bullet !== 'dot' ? ` bullets--${bullet}` : ''}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
    }
    case 'certificates': {
      if (!nonEmpty(profile.certificates)) return '';
      const items = profile.certificates.map((c) => [c.title, c.date, c.detail].filter(Boolean).join(' · ')).filter(Boolean);
      if (!items.length) return '';
      return `<ul class="bullets${bullet && bullet !== 'dot' ? ` bullets--${bullet}` : ''}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
    }
    default:
      return '';
  }
}

/**
 * 章节图标。用内联 SVG 画几何图形，不依赖字体——
 * 一是不受系统字体回退影响（↑↓ 那种坑），二是导出 PDF 时能画成一模一样的形状。
 * 图标和标题文字之间靠 CSS 的 margin-right 留出呼吸空间。
 */
function iconMarkup(kind) {
  if (!kind || kind === 'none' || kind === 'inherit') return '';
  const shapes = {
    dot: '<circle cx="5" cy="5" r="3.1" fill="currentColor"/>',
    square: '<rect x="2" y="2" width="6" height="6" rx="1.2" fill="currentColor"/>',
    line: '<rect x="4" y="1" width="2" height="8" rx="1" fill="currentColor"/>',
    ring: '<circle cx="5" cy="5" r="2.7" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    diamond: '<path d="M5 .9 L9.1 5 L5 9.1 L.9 5 Z" fill="currentColor"/>',
  };
  const shape = shapes[kind];
  if (!shape) return '';
  return `<svg class="sec-ico" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">${shape}</svg>`;
}

function sectionHtml(key, title, inner, sec) {
  const mods = [
    'sec',
    `sec--t-${sec.titleStyle}`,
    `sec--${sec.placement}`,
    `sec--a-${sec.align}`,
  ];
  if (sec.timeline) mods.push('sec--timeline');
  if (sec.itemLayout && sec.itemLayout !== 'stack') mods.push(`sec--items-${sec.itemLayout}`);
  if (sec.icon && sec.icon !== 'none') mods.push(`sec--ico-${sec.icon}`);
  if (sec.scale !== 1) mods.push('sec--scaled');
  const gapStyle = sec.gapBefore ? ` style="margin-top:${sec.gapBefore}px"` : '';
  const scaleStyle = sec.scale !== 1 ? ` style="--sec-scale:${sec.scale}"` : '';
  // 序号只加在标题前面，不影响无标题的版式
  const num = sec.titleStyle === 'hidden' ? '' : numberLabel(sec.numbering, sec.index);
  const numHtml = num ? `<span class="sec-num">${esc(num)}</span>` : '';
  const icoHtml = sec.titleStyle === 'hidden' ? '' : iconMarkup(sec.icon);
  const titleHtml = sec.titleStyle === 'hidden' ? ''
    : `<h2 class="sec-title">${icoHtml}${numHtml}${esc(title)}</h2>`;
  return `<section class="${mods.join(' ')}"${gapStyle}${scaleStyle}>
      ${titleHtml}
      <div class="sec-body">${inner}</div>
    </section>`;
}

function headerHtml(profile, cfg) {
  const b = profile.basics || {};
  if (!cfg.header.visible) return '';
  const contacts = [
    b.phone, b.email, b.location, b.website,
  ].filter(Boolean);
  const chips = contacts.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  const plainContacts = contacts.map((c) => `<span class="contact">${esc(c)}</span>`).join('<span class="sep">·</span>');
  const nameHtml = `<h1 class="name">${esc(b.name) || '姓名'}</h1>`;
  const titleText = b.title || b.highlight || '';
  const titleHtml = cfg.header.showTitle && titleText ? `<div class="title">${esc(titleText)}</div>` : '';
  // 横幅与居中头部是「整行一段话」的设计，联系方式一律用 · 串起来；
  // 胶囊只在左右分栏的头部里用，这样 PDF 才能和 HTML 用同一套规则。
  const chipMode = cfg.header.chips && cfg.header.style !== 'band' && cfg.header.style !== 'center';
  const contactHtml = cfg.header.showContacts && contacts.length
    ? (chipMode ? `<div class="contacts">${chips}</div>` : `<div class="contacts contacts--plain">${plainContacts}</div>`)
    : '';
  return `<header class="head head--${cfg.header.style} head--a-${cfg.header.align}">
      <div class="head-main">${nameHtml}${titleHtml}</div>
      ${contactHtml}
    </header>`;
}

/**
 * 生成简历正文 HTML（不含 <html> 外壳），导出与打印共用。
 * @param {object} profile
 * @param {object} opts 导出设置；样式细节由 themes.resolve(opts) 决定
 */
function renderBody(profile, opts = {}) {
  const cfg = themes.resolve(opts);
  const out = [headerHtml(profile, cfg)];

  for (const sec of cfg.sections) {
    if (!sec.visible) continue;
    if (sec.key === 'customSections') {
      if (!nonEmpty(profile.customSections)) continue;
      for (const cs of profile.customSections) {
        if (!cs) continue;
        const items = (cs.items || []).map((i) => String(i || '').trim()).filter(Boolean);
        if (!cs.title && !items.length) continue;
        const inner = items.length
          ? `<ul class="bullets${sec.bullet !== 'dot' ? ` bullets--${sec.bullet}` : ''}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
          : '';
        if (!inner) continue;
        out.push(sectionHtml('custom', cs.title || '其他', inner, sec));
      }
      continue;
    }
    const inner = bodyOf(sec.key, profile, sec);
    if (!inner) continue;
    out.push(sectionHtml(sec.key, sec.title, inner, sec));
  }
  return out.filter(Boolean).join('\n');
}

/* ---------------- CSS ---------------- */

const TITLE_CSS = {
  underline: `.sec--t-underline .sec-title{
    border-bottom:1.5px solid var(--accent);padding-bottom:calc(var(--m-bullet-gap) * 1.4);
    color:var(--accent);margin-bottom:calc(var(--m-title-gap) * 1.1)}`,
  bar: `.sec--t-bar .sec-title{
    border-left:3.5px solid var(--accent);padding-left:calc(var(--gap) * .68);
    color:var(--ink);letter-spacing:.005em}`,
  plain: `.sec--t-plain .sec-title{
    border-bottom:1px solid rgba(0,0,0,.11);padding-bottom:calc(var(--m-bullet-gap) * 1.5);
    color:var(--ink);margin-bottom:calc(var(--m-title-gap) * 1.05)}`,
  /* 字距小标：全大写拉丁字母的排版语言搬到中文上，靠字距和细线撑起层次。
     线不做成一整条——短促的一段强调线更像「标记」而不是「分隔」。 */
  caps: `.sec--t-caps .sec-title{
    color:var(--accent);letter-spacing:.16em;text-indent:.16em;
    font-size:var(--m-eyebrow);font-weight:700;line-height:1.5;
    display:flex;align-items:center;gap:calc(var(--gap) * .64);
    margin-bottom:var(--m-title-gap)}
  .sec--t-caps .sec-title::after{
    content:"";flex:1 1 auto;height:1px;
    background:linear-gradient(to right, color-mix(in srgb, var(--accent) 42%, transparent), transparent);
    min-width:24px}`,
  /* 色块标题：文字必须视觉居中，不能靠 line-height 撑高度。
     原来写 line-height:1.6 + padding:.2em，色块高度被撑到 2em——13px 的字
     装进 27px 的块里，上下各空 7px，看起来就像「顶部空了一整个字」。
     改成固定高度 + flex 居中：高度锁在 1.62em，行高收到 1，
     文字的行盒在块内垂直居中，块高只比字高多出三四个像素。 */
  chip: `.sec--t-chip .sec-title{
    display:inline-flex;align-items:center;
    /* 上下内边距 .18em + 行高 1.14em 正好 1.5em；用 padding 而不是写死 height，
       标题被改长折行时色块能自己长高，不会把字漏到色块外面 */
    min-height:1.5em;line-height:1.14;padding:.18em .72em;
    background:var(--accent);color:#fff;
    border-radius:var(--radius-sm);letter-spacing:.03em;
    box-shadow:0 2px 6px -2px color-mix(in srgb, var(--accent) 55%, transparent)}`,
  gutter: `.sec--t-gutter{gap:calc(var(--gap) * .9)}
  .sec--t-gutter .sec-title{
    color:var(--accent);letter-spacing:.01em;margin:0;text-align:left;
    font-size:var(--m-section);line-height:1.45}`,
  hidden: '',
};

const BULLET_CSS = `.bullets{list-style:none;margin:var(--m-bullet-gap) 0 0;padding-left:var(--m-indent)}
  .bullets li{position:relative;margin:calc(var(--m-bullet-gap) * .8) 0;text-align:justify}
  .bullets li:first-child{margin-top:0}
  /* 默认圆点。注意 .bullets 是「默认样式」，不带 --dot 修饰类——
     这里漏了 content 的话所有列表都会变成没有项目符号的纯段落。 */
  .bullets li::before{content:"•";position:absolute;left:calc(var(--m-indent) * -1 + 2px);top:0;color:var(--accent);
    font-size:1em;line-height:inherit}
  .bullets--dash li::before{content:"–"}
  .bullets--square li::before{content:"▪";font-size:.86em;top:.08em}
  .bullets--ring li::before{content:"○";font-size:.82em;top:.06em}
  .bullets--none{padding-left:0}
  .bullets--none li::before{content:""}`;

/** 把 "14mm 15mm" / "10mm" 展开成 CSS padding 简写，与 @page 的边距保持一致 */
function cssPadding(margin) {
  const parts = String(margin || '14mm 15mm').trim().split(/\s+/).filter(Boolean);
  const unit = (x) => (/^[\d.]+$/.test(x) ? `${x}mm` : x);
  if (parts.length === 1) return unit(parts[0]);
  if (parts.length === 2) return `${unit(parts[0])} ${unit(parts[1])}`;
  if (parts.length === 3) return `${unit(parts[0])} ${unit(parts[1])} ${unit(parts[2])}`;
  return parts.slice(0, 4).map(unit).join(' ');
}

function renderCSS(opts = {}) {
  const cfg = themes.resolve(opts);
  const v = cfg.vars;
  const m = cfg.m;
  const titleCss = Object.values(TITLE_CSS).join('\n  ');
  // 阶梯值全部换算成 px 写进变量，CSS 里只引用变量，不再各自乘系数
  const px = (n) => `${n.toFixed(2)}px`;
  // “14mm 15mm” 这种简写在 @page 里合法，但 padding 需要展开成四值
  const pad = cssPadding(cfg.page.margin);
  // 圆角：pill 直接给一个够大的数让浏览器夹到半高，其余按像素走。
  // sharp 是 0，小圆角也必须跟着是 0——否则「直角」主题里还留着 2px 的圆边。
  const radiusCss = v.radius >= 999 ? '999px' : `${v.radius}px`;
  const radiusSmCss = v.radius >= 999 ? '999px' : `${v.radius === 0 ? 0 : Math.max(2, Math.round(v.radius * 0.55))}px`;

  const vars = `
    --accent: ${v.accent};
    --accent2: ${v.accent2};
    --ink: ${v.ink};
    --muted: ${v.muted};
    --soft: ${v.soft};
    --font-size: ${v.fontSize}px;
    --line-height: ${v.lineHeight};
    --gap: ${px(m.gap)};
    --label-w: ${v.labelWidth}px;
    --font-family: ${v.fontFamily};
    --m-name: ${px(m.name)};
    --m-title: ${px(m.title)};
    --m-section: ${px(m.sectionTitle)};
    --m-eyebrow: ${px(m.eyebrow)};
    --m-org: ${px(m.org)};
    --m-role: ${px(m.role)};
    --m-meta: ${px(m.meta)};
    --m-chip: ${px(m.chip)};
    --m-summary: ${px(m.summary)};
    --m-head-gap: ${px(m.headGap)};
    --m-section-gap: ${px(m.sectionGap)};
    --m-title-gap: ${px(m.titleGap)};
    --m-item-gap: ${px(m.itemGap)};
    --m-bullet-gap: ${px(m.bulletGap)};
    --m-indent: ${px(m.bulletIndent)};
    --m-name-track: ${m.nameTracking}em;
    --radius: ${radiusCss};
    --radius-sm: ${radiusSmCss};`;

  return `
  @page { size: ${cfg.page.size}; margin: ${cfg.page.margin}; }
  :root {${vars}
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: var(--font-family);
    font-size: var(--font-size); line-height: var(--line-height);
    color: var(--ink);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    font-variant-numeric: tabular-nums;
  }
  .page { padding: 0; }

  /* ---------- 头部 ---------- */
  .head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: calc(var(--gap) * 1.4);
    padding-bottom: var(--m-title-gap);
    margin-bottom: var(--m-head-gap);
    border-bottom: 1px solid rgba(0, 0, 0, .07);
  }
  .head-main { min-width: 0; }
  .name {
    font-size: var(--m-name); margin: 0; font-weight: 700;
    letter-spacing: var(--m-name-track); line-height: 1.12;
    color: var(--ink);
  }
  .title {
    font-size: var(--m-title); color: var(--muted);
    margin-top: calc(var(--gap) * .34); font-weight: 500;
    letter-spacing: .01em;
  }
  .contacts {
    display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end;
    align-items: center; max-width: 54%; padding-top: calc(var(--gap) * .28);
  }
  .chip {
    font-size: var(--m-chip); color: var(--soft);
    background: rgba(0, 0, 0, .042);
    border-radius: 999px; padding: .22em .72em; white-space: nowrap;
    line-height: 1.5;
  }
  .contacts--plain { gap: .55em; }
  .contact { font-size: var(--m-meta); color: var(--muted); white-space: nowrap; }
  .sep { color: rgba(0, 0, 0, .22); }

  /* 头部样式：细线 / 横幅 / 居中 / 纯文字 */
  .head--plain { border-bottom: 0; padding-bottom: 0; }
  .head--rule {
    align-items: flex-end;
    border-bottom: 2px solid var(--accent);
    padding-bottom: calc(var(--gap) * .72);
  }
  .head--rule .name { color: var(--accent); }
  /* 横幅：名字与联系方式上下堆叠。并排时联系方式只有右侧一半宽度，
     稍长就会折成两行、右边留一大块空白，看起来像没排完。 */
  .head--band {
    background: linear-gradient(118deg, var(--accent) 0%, var(--accent2) 100%);
    border-radius: var(--radius); border-bottom: 0;
    padding: calc(var(--gap) * 1.32) calc(var(--gap) * 1.75);
    flex-direction: column; align-items: stretch; gap: 0;
    color: #fff;
    box-shadow: 0 10px 26px -12px rgba(0, 0, 0, .38);
  }
  .head--band .contacts {
    max-width: none; justify-content: flex-start;
    padding-top: calc(var(--gap) * .62); gap: .8em;
  }
  .head--band .name { color: #fff; letter-spacing: .012em; }
  .head--band .title { color: rgba(255, 255, 255, .93); }
  .head--band .chip { background: rgba(255, 255, 255, .21); color: #fff; }
  .head--band .contact { color: rgba(255, 255, 255, .94); }
  .head--band .sep { color: rgba(255, 255, 255, .52); }
  .head--center {
    flex-direction: column; align-items: center; text-align: center;
    gap: calc(var(--gap) * .62);
    border-top: 1px solid rgba(0, 0, 0, .13);
    border-bottom: 1px solid rgba(0, 0, 0, .13);
    border-radius: 0; padding: calc(var(--gap) * 1.15) 0;
  }
  .head--center .name { letter-spacing: .16em; text-indent: .16em; color: var(--ink); }
  .head--center .title { margin-top: 0; letter-spacing: .12em; text-indent: .12em; }
  .head--center .contacts { justify-content: center; max-width: none; padding-top: 0; }

  .head--a-center { flex-direction: column; align-items: center; text-align: center; }
  .head--a-center .contacts { justify-content: center; max-width: none; }
  .head--a-right { flex-direction: row-reverse; }
  .head--a-right .contacts { justify-content: flex-start; }

  /* ---------- 章节 ---------- */
  .sec { margin: 0 0 var(--m-section-gap); break-inside: avoid; }
  .sec-title {
    font-size: var(--m-section); margin: 0 0 var(--m-title-gap);
    font-weight: 700; line-height: 1.4; color: var(--ink);
    letter-spacing: .01em;
  }
  .sec--left {
    display: grid; grid-template-columns: var(--label-w) minmax(0, 1fr);
    align-items: start; column-gap: calc(var(--gap) * .9);
  }
  .sec--left .sec-title { margin-bottom: 0; padding-right: 4px; }
  .sec--a-center { text-align: center; }
  .sec--a-center .item-head { justify-content: center; }
  .sec--a-right { text-align: right; }
  .sec--a-right .item-head { flex-direction: row-reverse; }
  .sec--scaled .sec-body { font-size: calc(var(--font-size) * var(--sec-scale, 1)); }

  /* 时间线：一条竖线串起条目，结点对齐标题基线 */
  .sec--timeline .sec-body {
    border-left: 1.5px solid rgba(0, 0, 0, .09);
    padding-left: calc(var(--gap) * 1.15); margin-left: 2px;
  }
  .sec--timeline .item { position: relative; }
  .sec--timeline .item::before {
    content: ""; position: absolute;
    left: calc(var(--gap) * -1.15 - 3.5px); top: .42em;
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 0 2.5px #fff;
  }
  ${titleCss}

  /* ---------- 条目 ---------- */
  .sec-body > .item + .item { margin-top: var(--m-item-gap); }
  .item { break-inside: avoid; }
  .item-head {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: calc(var(--gap) * .8);
  }
  .item-left {
    display: flex; align-items: baseline; gap: .55em;
    flex-wrap: wrap; min-width: 0;
  }
  .item-org {
    font-weight: 650; font-size: var(--m-org); color: var(--ink);
    letter-spacing: -.004em;
  }
  .item-role {
    color: var(--soft); font-size: var(--m-role);
  }
  .item-role::before {
    content: "·"; color: rgba(0, 0, 0, .22); margin-right: .5em;
  }
  .item-right {
    color: var(--muted); font-size: var(--m-meta);
    text-align: right; white-space: nowrap; flex: none;
    letter-spacing: .008em;
  }
  .item-loc { margin-left: .7em; }
  .item-sub { color: var(--soft); font-size: var(--m-role); margin-top: calc(var(--gap) * .12); }
  .tech { color: var(--muted); font-size: var(--m-meta); margin-top: calc(var(--gap) * .12); }

  /* ---------- 条目排法：四种结构，不只是换颜色 ---------- */
  /* inline：单位 · 职位 · 时间 连成一行，像杂志的署名行，不把时间推到右边缘。
     三者都用 inline，让文字自然续排、换行时也不会把时间甩到另一边。 */
  .item-head--inline { display: block; }
  .item-head--inline .item-left { display: inline; }
  .item-head--inline .item-right { display: inline; white-space: normal; }
  .item-head--inline .item-right::before {
    content: "·"; color: rgba(0, 0, 0, .22); margin: 0 .5em;
  }
  .item-head--inline .item-role::before { content: none; }
  .item-head--inline .item-role { margin-left: .5em; }
  .item-head--inline .item-loc { margin-left: .6em; }

  /* block：时间独占一行压在单位上方，像履历表，强调时间跨度 */
  .sec--items-block .item-when {
    font-size: var(--m-meta); color: var(--muted);
    letter-spacing: .06em; margin-bottom: calc(var(--gap) * .18);
  }
  .sec--items-block .item-when .item-loc { margin-left: .8em; }
  .sec--items-block .item-head { justify-content: flex-start; }

  /* card：每个条目是一张带左侧色条的浅底卡片，块感强 */
  /* 卡片会额外占上下内边距，所以比 stack 排法更紧凑，否则整份简历会被撑长 */
  .item--card {
    background: rgba(0, 0, 0, .018);
    border-left: 3px solid var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    padding: calc(var(--gap) * .42) calc(var(--gap) * .78) calc(var(--gap) * .46);
  }
  .item--card + .item--card { margin-top: calc(var(--m-item-gap) * .9); }

  /* 章节图标：与标题文字之间必须留出边距，不能贴着字。
     图标用 .62em 见方，比字号略小，视觉上与汉字的重心对齐。 */
  .sec-ico {
    width: .62em; height: .62em; flex: none;
    margin-right: .5em; vertical-align: -.02em;
    color: var(--accent);
  }
  /* caps 样式是 flex 布局，图标要自己撑住不被压扁 */
  .sec--t-caps .sec-ico { margin-right: calc(var(--gap) * .46); }
  /* gutter 的标题在窄栏里，图标单独占一行 */
  .sec--t-gutter .sec-ico { display: block; margin: 0 0 .26em; }
  /* 色块标题里的图标要用白色——否则 accent 画在 accent 底上等于隐身。
     它和文字一样吃色块的内边距，不能画到色块外面。 */
  .sec--t-chip .sec-ico { color: currentColor; opacity: .9; margin-right: .42em; }

  /* 章节序号。和图标同理，序号与标题之间要留出边距——
     贴在一起会读成「一、」和标题是同一个词。 */
  .sec-num {
    color: var(--accent); opacity: .55; font-weight: 600;
    margin-right: .5em; font-variant-numeric: tabular-nums;
  }
  /* 图标后面紧跟序号时，两者的间距收一点，避免中间出现双份空隙 */
  .sec-ico + .sec-num { margin-left: 0; }
  .sec--t-caps .sec-num { opacity: .7; }
  .sec--t-gutter .sec-num { display: block; margin: 0 0 .12em; font-size: var(--m-eyebrow); }

  /* 技能标签形态 */
  .skill-row--tags { align-items: baseline; }
  .skill-tags { display: flex; flex-wrap: wrap; gap: 4px 5px; }
  .skill-tag {
    font-size: var(--m-meta); color: var(--soft);
    background: rgba(0, 0, 0, .045);
    border-radius: var(--radius-sm); padding: .1em .5em; line-height: 1.55;
    white-space: nowrap;
  }
  .sec--a-center .skill-tags { justify-content: center; }
  .sec--a-right .skill-tags { justify-content: flex-end; }
  ${BULLET_CSS}

  .summary {
    margin: 0; font-size: var(--m-summary);
    text-align: justify; color: var(--soft); line-height: 1.7;
  }
  /* 技能行：分类做「标签」，条目另起一列并对齐。
     用 grid 而不是 flex，这样条目折行时会贴着左边界续下来，
     不会缩在分类词后面。 */
  .skill-row {
    display: grid; grid-template-columns: calc(var(--font-size) * 5.4) minmax(0, 1fr);
    column-gap: .85em; align-items: baseline;
    margin: calc(var(--m-bullet-gap) * 1.2) 0;
  }
  .skill-row:first-child { margin-top: 0; }
  .skill-cat {
    font-size: var(--m-meta); font-weight: 650; color: var(--accent);
    white-space: nowrap; letter-spacing: .01em;
  }
  .skill-items { color: var(--soft); line-height: 1.65; }

  /* ---------- 水印 ---------- */
  .watermark {
    position: fixed; inset: 0; display: flex;
    align-items: center; justify-content: center;
    pointer-events: none; z-index: 99;
  }
  .watermark span {
    font-size: 62px; color: rgba(120, 130, 145, 0.13);
    transform: rotate(-26deg); font-weight: 700;
    letter-spacing: 6px; white-space: nowrap;
  }

  /* 屏幕上模拟纸张 */
  @media screen {
    body { background: #eceef1; padding: 24px 0; }
    .page {
      width: 210mm; min-height: 297mm; margin: 0 auto;
      background: #fff; padding: ${pad};
      box-shadow: 0 1px 2px rgba(16, 24, 40, .06), 0 14px 38px -10px rgba(16, 24, 40, .18);
      border-radius: 3px;
    }
  }
  /* 窄屏（手机看预览）：不再假装是一张 210mm 的白纸。
     794px 的固定宽度塞进 320px 的容器里只能横着滚，读起来很难受；
     这里放弃纸张比例，让内容按容器宽度重排。导出与打印不受影响。 */
  @media screen and (max-width: 620px) {
    /* 窄屏：不再假装是一张 210mm 的纸（794px 塞进 312px 只能横滚），
       但也不该变成一段贴边的纯文本——留出纸张的内边距和一点阴影，
       读起来才像一份简历而不是一个网页。边距按比例缩小到观看距离合适的量。 */
    body { background: #eceef1; padding: 10px 8px 16px; }
    .page {
      width: auto; min-height: 0;
      padding: calc(var(--gap) * 2.1) calc(var(--gap) * 1.7);
      background: #fff; border-radius: 6px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, .07), 0 10px 28px -12px rgba(16, 24, 40, .22);
    }
    .head--band {
      border-radius: 10px;
      padding: calc(var(--gap) * 1.35) calc(var(--gap) * 1.15);
    }
    .head, .head--center, .head--band { flex-direction: column; align-items: stretch; }
    .head--center { align-items: center; }
    .contacts { max-width: none; justify-content: flex-start; }
    .head--center .contacts { justify-content: center; }
    .head--band .contacts { justify-content: flex-start; }
    .sec--left { display: block; }
    .sec--left .sec-title { margin-bottom: var(--m-title-gap); }
    .item-right { white-space: normal; text-align: left; }
    .item-head { flex-wrap: wrap; gap: 0; }
    .skill-row { grid-template-columns: 1fr; row-gap: .15em; }
    .watermark span { font-size: 40px; }
  }
  @media print {
    .page {
      width: auto; min-height: 0; margin: 0; padding: 0;
      box-shadow: none; border-radius: 0;
    }
    .head--band { border-radius: 12px; box-shadow: none; }
  }
  ${cfg.customCSS ? `\n  /* ===== 自定义 CSS ===== */\n  ${cfg.customCSS}\n` : ''}
  `;
}

function renderHTML(profile, opts = {}) {
  const cfg = themes.resolve(opts);
  const title = `${(profile.basics && profile.basics.name) || '简历'} - 简历`;
  const watermark = cfg.decor.watermark
    ? `<div class="watermark"><span>${esc(cfg.decor.watermark)}</span></div>` : '';
  const fonts = cfg.vars.serif
    ? '<link rel="preconnect" href="https://fonts.googleapis.com">'
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(cfg.theme.id)}" data-header="${esc(cfg.header.style)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${fonts}<style>${renderCSS(opts)}</style>
</head>
<body>
${watermark}
<div class="page">
${renderBody(profile, opts)}
</div>
</body>
</html>`;
}

function renderMarkdown(profile, opts = {}) {
  const cfg = themes.resolve(opts);
  const b = profile.basics || {};
  const L = [];
  if (cfg.header.visible && (b.name || b.title)) {
    L.push(`# ${b.name || '姓名'}`);
    if (b.title) L.push(`**${b.title}**`);
    const contacts = [b.phone, b.email, b.location, b.website].filter(Boolean);
    if (contacts.length) L.push(contacts.join(' | '));
    L.push('');
  }
  const visible = new Set(cfg.sections.filter((s) => s.visible).map((s) => s.key));
  const sec = (key, title, lines) => {
    if (!visible.has(key) || !lines.length) return;
    L.push(`## ${title}`, '');
    lines.forEach((l) => L.push(l));
    L.push('');
  };

  if (b.summary) sec('summary', titleOf(cfg, 'summary'), [b.summary, '']);

  sec('skills', titleOf(cfg, 'skills'), (profile.skills || []).map((s) => `- **${s.category || '技能'}**：${(s.items || []).join('、')}`));
  sec('work', titleOf(cfg, 'work'), (profile.work || []).flatMap((j) => [
    `### ${j.company}${j.position ? ` · ${j.position}` : ''}`,
    `*${range(j.start, j.end)}${j.location ? ` | ${j.location}` : ''}*`,
    ...(j.bullets || []).map((x) => `- ${x}`),
    '',
  ]));
  sec('projects', titleOf(cfg, 'projects'), (profile.projects || []).flatMap((p) => [
    `### ${p.name}${p.role ? ` · ${p.role}` : ''}`,
    `*${range(p.start, p.end)}${p.org ? ` | ${p.org}` : ''}*`,
    ...(p.tech || []).length ? [`技术栈：${p.tech.join('、')}`] : [],
    ...(p.bullets || []).map((x) => `- ${x}`),
    '',
  ]));
  sec('education', titleOf(cfg, 'education'), (profile.education || []).flatMap((e) => [
    `### ${e.school}${[e.major, e.degree].filter(Boolean).length ? ` · ${[e.major, e.degree].filter(Boolean).join(' · ')}` : ''}`,
    `*${range(e.start, e.end)}${e.gpa ? ` | GPA ${e.gpa}` : ''}*`,
    ...(e.bullets || []).map((x) => `- ${x}`),
    '',
  ]));
  sec('awards', titleOf(cfg, 'awards'), (profile.awards || []).map((a) => `- ${[a.title, a.date, a.detail].filter(Boolean).join(' · ')}`));
  sec('certificates', titleOf(cfg, 'certificates'), (profile.certificates || []).map((c) => `- ${[c.title, c.date, c.detail].filter(Boolean).join(' · ')}`));
  if (visible.has('customSections')) {
    for (const cs of profile.customSections || []) {
      sec('customSections', cs.title || '其他', (cs.items || []).map((i) => `- ${i}`));
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function titleOf(cfg, key) {
  const s = cfg.sections.find((x) => x.key === key);
  return s ? s.title : key;
}

/**
 * PDF 渲染已迁到 lib/pdf/（纯 JS 引擎，不需要浏览器）。
 * 这里保留同名导出，方便老调用方，实际转发给 lib/pdf 的对应实现。
 */
async function renderPDF(profile, opts = {}, cfg = {}) {
  return require('./pdf').renderPDF(profile, opts, cfg);
}

async function closeBrowser() {
  return require('./pdf/chrome').closeBrowser();
}

function findChrome() {
  return require('./pdf/chrome').findChrome();
}

module.exports = {
  THEMES: themes.THEMES,
  themeDescribe: themes.describe,
  resolveStyle: themes.resolve,
  renderHTML,
  renderBody,
  renderCSS,
  renderMarkdown,
  renderPDF,
  closeBrowser,
  findChrome,
};
