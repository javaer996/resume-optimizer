'use strict';

/**
 * 简历样式系统（HTML 与 PDF 共用一套「设计令牌」）。
 *
 * 分三层：
 *   1. 主题（THEMES）：选一个起点，决定头部样式、章节标题样式、项目符号、密度。
 *   2. 版式（layout）：用户对章节顺序、位置、样式的覆盖，存在 settings.export.layout。
 *   3. 自定义 CSS：只在 HTML / 浏览器引擎里生效，直接注入到 <style> 末尾。
 *
 * 两个渲染器都只吃 resolve() 的结果，所以「主题里长什么样」和「PDF 里长什么样」
 * 不会各写一套规则——新加一个主题只需要在 THEMES 里加一条。
 */

const SANS = '"PingFang SC", "SF Pro SC", "Helvetica Neue", "Microsoft YaHei", "WenQuanYi Zen Hei", system-ui, -apple-system, sans-serif';
const SERIF = '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, serif';

/** 章节顺序的默认值；customSections 永远排在最后 */
const DEFAULT_ORDER = ['summary', 'skills', 'work', 'projects', 'education', 'awards', 'certificates', 'customSections'];

const SECTION_META = {
  summary: { title: '个人简介', hint: '一两句话概括你的定位与最亮眼的成绩' },
  skills: { title: '专业技能', hint: '按类别分组，比堆一长串关键词更易读' },
  work: { title: '工作经历', hint: '公司 + 职位 + 时间，下面用要点写成果' },
  projects: { title: '项目经历', hint: '挑 2–3 个最能证明能力的项目' },
  education: { title: '教育经历', hint: '学校、专业、学位、时间' },
  awards: { title: '获奖经历', hint: '奖项名称 · 时间 · 说明' },
  certificates: { title: '证书 / 资质', hint: '语言、职业资格、技能认证' },
  customSections: { title: '自定义板块', hint: '开源贡献、出版、志愿经历等' },
};

/**
 * 八套内置主题。
 * header        头部长相：rule 细线 / band 色带 / center 居中大标题 / plain 纯文字 /
 *                 split 左色块右联系 / side 左竖栏 / frame 线框 / overline 上横线
 * sectionTitle  章节标题：underline 下划线 / bar 左竖条 / plain 细分隔线 / caps 字距小标 / chip 色块 / gutter 左侧栏
 * bullet        项目符号：dot / dash / square / ring
 * timeline      经历条目是否画时间线
 * radius        圆角形态：sharp 直角 / soft 小圆角 / round 大圆角 / pill 全圆角
 * icon          章节图标：none / dot / square / line / ring / diamond
 */
const THEMES = {
  aurora: {
    id: 'aurora',
    name: '晨曦渐变',
    desc: '顶部渐变横幅 + 白色大标题，条目上下堆叠，视觉冲击力强，适合互联网、设计、品牌类岗位',
    tag: '推荐',
    accent: '#4f46e5',
    accent2: '#0ea5e9',
    ink: '#111827',
    muted: '#5b6472',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'band',
    sectionTitle: 'caps',
    bullet: 'dot',
    itemLayout: 'stack',
    numbering: 'none',
    skills: 'rows',
    radius: 'round',
    icon: 'none',
    timeline: false,
    chips: true,
    fontSize: 13.5,
    lineHeight: 1.66,
    gapScale: 1,
  },
  editorial: {
    id: 'editorial',
    name: '杂志侧栏',
    desc: '章节标题排在左侧窄栏、正文右栏，条目时间与单位同一行两端对齐，像杂志内页，适合文字岗、编辑、市场',
    tag: '',
    accent: '#8a1c3b',
    accent2: '#c2410c',
    ink: '#1a1a1a',
    muted: '#6b6b6b',
    soft: '#3f3f3f',
    fontFamily: SERIF,
    serif: true,
    header: 'rule',
    sectionTitle: 'gutter',
    bullet: 'dash',
    itemLayout: 'inline',
    numbering: 'none',
    skills: 'rows',
    radius: 'sharp',
    icon: 'line',
    timeline: false,
    chips: false,
    fontSize: 13,
    lineHeight: 1.7,
    gapScale: 1.1,
    labelWidth: 92,
  },
  timeline: {
    id: 'timeline',
    name: '时间线',
    desc: '时间段单独占一行压在单位上方，由一条竖线串起每段经历，适合经历线清晰、想强调成长路径的候选人',
    tag: '',
    accent: '#0f766e',
    accent2: '#14b8a6',
    ink: '#111827',
    muted: '#5b6472',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'rule',
    sectionTitle: 'bar',
    bullet: 'dot',
    itemLayout: 'block',
    numbering: 'none',
    skills: 'rows',
    radius: 'soft',
    icon: 'dot',
    timeline: true,
    chips: true,
    fontSize: 12.8,
    lineHeight: 1.6,
    gapScale: 0.95,
  },
  spotlight: {
    id: 'spotlight',
    name: '海报大标题',
    desc: '超大居中姓名 + 上下发丝线，章节带 01/02 编号，留白很多，适合设计、市场、管理类岗位',
    tag: '大气',
    accent: '#111827',
    accent2: '#6b7280',
    ink: '#111827',
    muted: '#6b7280',
    soft: '#4b5563',
    fontFamily: SANS,
    serif: false,
    header: 'center',
    sectionTitle: 'caps',
    bullet: 'ring',
    itemLayout: 'inline',
    numbering: 'index',
    skills: 'tags',
    radius: 'sharp',
    icon: 'ring',
    timeline: false,
    chips: false,
    fontSize: 13,
    lineHeight: 1.75,
    gapScale: 1.25,
  },
  classic: {
    id: 'classic',
    name: '经典衬线',
    desc: '宋体 + 深蓝下划线，章节按「一、二、三」编号，最符合国内传统简历的读法，投国企、金融不会出错',
    tag: '',
    accent: '#1a4d8f',
    accent2: '#1a4d8f',
    ink: '#1f2328',
    muted: '#6b7280',
    soft: '#4b5563',
    fontFamily: SERIF,
    serif: true,
    header: 'rule',
    sectionTitle: 'underline',
    bullet: 'dot',
    itemLayout: 'stack',
    numbering: 'dot',
    skills: 'rows',
    radius: 'sharp',
    icon: 'none',
    timeline: false,
    chips: true,
    fontSize: 13.5,
    lineHeight: 1.62,
    gapScale: 1,
  },
  modern: {
    id: 'modern',
    name: '现代卡片',
    desc: '每段经历是一张带左侧色条的浅底卡片，技能做成标签，块面清晰，技术岗通用',
    tag: '通用',
    accent: '#0f6fbf',
    accent2: '#0ea5e9',
    ink: '#1f2328',
    muted: '#6b7280',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'plain',
    sectionTitle: 'chip',
    bullet: 'square',
    itemLayout: 'card',
    numbering: 'none',
    skills: 'tags',
    radius: 'soft',
    icon: 'square',
    timeline: false,
    chips: true,
    fontSize: 13.2,
    lineHeight: 1.62,
    gapScale: 0.92,
  },
  minimal: {
    id: 'minimal',
    name: '极简黑白',
    desc: '只有黑白灰，纯文字头部、细分隔线标题、短横项目符号，靠字重和间距分层次，适合学术、研究、外企',
    tag: '',
    accent: '#111827',
    accent2: '#111827',
    ink: '#111827',
    muted: '#6b7280',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'plain',
    sectionTitle: 'plain',
    bullet: 'dash',
    itemLayout: 'inline',
    numbering: 'none',
    skills: 'rows',
    radius: 'sharp',
    icon: 'none',
    timeline: false,
    chips: false,
    fontSize: 13,
    lineHeight: 1.6,
    gapScale: 1,
  },
  compact: {
    id: 'compact',
    name: '紧凑一页',
    desc: '色块章节标题 + 时间靠右，字号行距收紧，尽量把内容压进一页，适合经历多但要投一页的场景',
    tag: '省空间',
    accent: '#166534',
    accent2: '#16a34a',
    ink: '#1f2328',
    muted: '#6b7280',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'rule',
    sectionTitle: 'chip',
    bullet: 'square',
    itemLayout: 'inline',
    numbering: 'none',
    skills: 'rows',
    radius: 'soft',
    icon: 'diamond',
    timeline: false,
    chips: true,
    fontSize: 12,
    lineHeight: 1.5,
    gapScale: 0.85,
  },
  /* ---- 下面四套是第二组：把「圆角 / 图标 / 头部」这几维新拆出来的组合用上 ---- */
  ivory: {
    id: 'ivory',
    name: '象牙留白',
    desc: '居中大姓名 + 上下细线，章节带菱形图标与编号，直角排版留白多，适合学术、研究、教师岗',
    tag: '',
    accent: '#6b5340',
    accent2: '#8c7358',
    ink: '#2b2520',
    muted: '#7a6f65',
    soft: '#4a423a',
    fontFamily: SERIF,
    serif: true,
    header: 'center',
    sectionTitle: 'caps',
    bullet: 'ring',
    itemLayout: 'block',
    numbering: 'index',
    skills: 'tags',
    timeline: false,
    chips: false,
    radius: 'sharp',
    icon: 'diamond',
    fontSize: 12.6,
    lineHeight: 1.6,
    gapScale: 0.95,
  },
  coral: {
    id: 'coral',
    name: '珊瑚活力',
    desc: '渐变横幅 + 全圆角，圆点图标配色块标题，卡片排法，观感轻快，适合运营、市场、内容岗',
    tag: '亲和',
    accent: '#e0567a',
    accent2: '#f59e0b',
    ink: '#241a1d',
    muted: '#6f6166',
    soft: '#43383c',
    fontFamily: SANS,
    serif: false,
    header: 'band',
    sectionTitle: 'chip',
    bullet: 'dot',
    itemLayout: 'card',
    numbering: 'none',
    skills: 'tags',
    timeline: false,
    chips: true,
    radius: 'pill',
    icon: 'dot',
    fontSize: 12.4,
    lineHeight: 1.52,
    gapScale: 0.8,
  },
  slate: {
    id: 'slate',
    name: '石板极简',
    desc: '纯文字头部 + 短线图标，左竖条标题配时间独占一行的履历排法，冷静克制，适合技术、产品岗',
    tag: '',
    accent: '#334155',
    accent2: '#475569',
    ink: '#0f172a',
    muted: '#64748b',
    soft: '#334155',
    fontFamily: SANS,
    serif: false,
    header: 'plain',
    sectionTitle: 'bar',
    bullet: 'square',
    itemLayout: 'block',
    numbering: 'none',
    skills: 'rows',
    timeline: true,
    chips: false,
    radius: 'sharp',
    icon: 'line',
    fontSize: 12.6,
    lineHeight: 1.56,
    gapScale: 0.88,
  },
  grid: {
    id: 'grid',
    name: '网格秩序',
    desc: '下划线标题 + 方块图标，时间靠右排放、技能做成标签，结构感强的通用款，投任何行业都不出错',
    tag: '通用',
    accent: '#1d4ed8',
    accent2: '#3b82f6',
    ink: '#111827',
    muted: '#4b5563',
    soft: '#374151',
    fontFamily: SANS,
    serif: false,
    header: 'rule',
    sectionTitle: 'underline',
    bullet: 'dash',
    itemLayout: 'inline',
    numbering: 'none',
    skills: 'tags',
    timeline: false,
    chips: true,
    radius: 'soft',
    icon: 'square',
    fontSize: 13,
    lineHeight: 1.64,
    gapScale: 0.96,
  },
};
const THEME_LIST = Object.values(THEMES);
const DEFAULT_THEME = 'aurora';

/* ---------------- 可选项（前端据此生成控件） ---------------- */

const TITLE_STYLES = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'underline', label: '下划线' },
  { value: 'bar', label: '左竖条' },
  { value: 'plain', label: '细分隔线' },
  { value: 'caps', label: '字距小标' },
  { value: 'chip', label: '色块' },
  { value: 'gutter', label: '左侧栏' },
  { value: 'hidden', label: '不显示标题' },
];

const BULLETS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'dot', label: '圆点 •' },
  { value: 'dash', label: '短横 –' },
  { value: 'square', label: '方块 ▪' },
  { value: 'ring', label: '空心环 ○' },
  { value: 'none', label: '不显示' },
];

const ALIGNS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
];

const PLACEMENTS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'above', label: '标题在上方' },
  { value: 'left', label: '标题在左侧' },
];

/**
 * 条目布局。这是 8 套主题之间差异最大的一维：
 * - stack    单位在上、时间在右，最常见的中文简历排法
 * - inline   单位与时间同一行靠两端（紧凑，省一行）
 * - block    时间单独占一行、压在单位上方（像履历表，强调时间跨度）
 * - card     每个条目带浅底与左侧色条，块感强
 */
const ITEM_LAYOUTS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'stack', label: '上下堆叠' },
  { value: 'inline', label: '时间靠右' },
  { value: 'block', label: '时间在上' },
  { value: 'card', label: '色条卡片' },
];

/**
 * 圆角形态。这是「气质」层面的差异：直角偏正式、圆角偏亲和。
 * 之前所有主题都硬编码 14px/7px/5px 几个值，八套看起来同一个模子。
 */
const RADII = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'sharp', label: '直角' },
  { value: 'soft', label: '小圆角' },
  { value: 'round', label: '大圆角' },
  { value: 'pill', label: '全圆角' },
];

/**
 * 章节图标。用 SVG 画在标题序号的位置，不依赖字体，
 * 导出 PDF 时画成同样的几何图形，两端一致。
 */
const ICONS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'none', label: '无图标' },
  { value: 'dot', label: '实心圆点' },
  { value: 'square', label: '方块' },
  { value: 'line', label: '短竖线' },
  { value: 'ring', label: '空心环' },
  { value: 'diamond', label: '菱形' },
];

/** 圆角形态换算成像素 */
const RADIUS_PX = { sharp: 0, soft: 6, round: 12, pill: 999 };

/** 章节序号：none 无 / index 01 02 / dot 一、二、 */
const NUMBERINGS = [
  { value: 'inherit', label: '跟随主题' },
  { value: 'none', label: '不编号' },
  { value: 'index', label: '数字 01' },
  { value: 'dot', label: '顿号 一、' },
];

/* ---------------- 版面度量 ---------------- */

/**
 * 字号阶梯与间距节奏。
 *
 * 两个渲染器都从这里取值——以前 HTML 的 renderCSS 和 PDF 的 Layout 各写一套
 * 倍率（1.82 / 2 / 2.2），改一处忘另一处就会出现「预览好看、导出挤成一团」。
 *
 * 名字尺寸跟头部样式有关：横幅和居中排版本来就是大标题，纯文字头部收一点。
 * 其余字号都只是正文的倍数，跟着用户调的字号一起缩放。
 */
function metrics(fontSize, lineHeight, gapScale, headerStyle) {
  const S = fontSize;
  const gap = 11 * gapScale;
  const nameMul = headerStyle === 'center' ? 2.28 : headerStyle === 'band' ? 2.02 : 1.92;
  return {
    fontSize: S,
    lineHeight,
    gap,
    // 字号阶梯
    name: S * nameMul,
    title: S * 1.04,
    sectionTitle: S * 1.02,
    eyebrow: S * 0.84,
    org: S * 1.04,
    role: S * 0.96,
    meta: S * 0.88,
    chip: S * 0.84,
    summary: S * 1.01,
    // 间距节奏：一个 11px 的基准往上按比例放大，视觉上才「有节奏」而不是随手加
    headGap: gap * 1.42,
    sectionGap: gap * 1.26,
    titleGap: gap * 0.6,
    itemGap: gap * 0.75,
    bulletGap: gap * 0.16,
    // 悬挂缩进：项目符号挂在左侧，正文对齐成一条线
    bulletIndent: S * 0.98,
    // 名字的字距（em）。中文大标题收紧一点更精神，居中排版反而要拉开
    nameTracking: headerStyle === 'center' ? 0.13 : -0.012,
  };
}

/* ---------------- 解析 ---------------- */

function pick(v, fallback) {
  return v == null || v === '' || v === 'inherit' ? fallback : v;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 自定义 CSS 可能来自布局对象，也可能直接放在导出设置顶层；空白视为没有 */
function cssOf(layout, opts) {
  const raw = typeof layout.customCSS === 'string' ? layout.customCSS : opts.customCSS;
  return typeof raw === 'string' && raw.trim() ? raw : '';
}

/**
 * 把「主题 + 用户覆盖」摊平成渲染器直接可用的结构。
 * @param {object} opts 导出设置（theme / accent / fontSize / lineHeight / hidden / layout ...）
 */
function resolve(opts = {}) {
  const theme = THEMES[opts.theme] || THEMES[DEFAULT_THEME];
  const layout = opts.layout && typeof opts.layout === 'object' ? opts.layout : {};
  const hidden = new Set(Array.isArray(opts.hidden) ? opts.hidden : []);
  const hOver = layout.header && typeof layout.header === 'object' ? layout.header : {};
  const sOver = layout.sections && typeof layout.sections === 'object' ? layout.sections : {};

  const vars = {
    accent: opts.accent || theme.accent,
    accent2: theme.accent2 || theme.accent,
    ink: theme.ink,
    muted: theme.muted,
    soft: theme.soft,
    fontFamily: opts.fontFamily || theme.fontFamily,
    serif: !!theme.serif,
    fontSize: num(opts.fontSize, theme.fontSize),
    lineHeight: num(opts.lineHeight, theme.lineHeight),
    gapScale: theme.gapScale == null ? 1 : theme.gapScale,
    labelWidth: theme.labelWidth || 92,
    // 圆角：sharp 0 / soft 6 / round 12 / pill 999。
    // 注意 sharp 是 0，不能用 || 兜底——0 是合法值，会被当成"没设置"。
    radiusKind: pick(layout.radius, theme.radius || 'soft'),
    radius: RADIUS_PX[pick(layout.radius, theme.radius || 'soft')] ?? RADIUS_PX.soft,
  };

  const headerStyle = pick(hOver.style, theme.header);
  const header = {
    style: headerStyle,
    align: pick(hOver.align, theme.header === 'center' ? 'center' : 'left'),
    chips: hOver.chips == null ? !!theme.chips : !!hOver.chips,
    showContacts: hOver.showContacts == null ? true : !!hOver.showContacts,
    showTitle: hOver.showTitle == null ? true : !!hOver.showTitle,
    visible: hidden.has('basics') ? false : (hOver.visible == null ? true : !!hOver.visible),
  };

  // 顺序：用户给的顺序优先，但只保留认识的键；没提到的按默认顺序追加
  const requested = Array.isArray(layout.order) ? layout.order.filter((k) => SECTION_META[k]) : [];
  const order = [];
  for (const k of requested) if (!order.includes(k)) order.push(k);
  for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);
  // 自定义板块永远最后，避免被挤到中间后和固定板块混排
  const custom = order.filter((k) => k === 'customSections');
  const sections = order.filter((k) => k !== 'customSections').concat(custom);

  const resolvedSections = sections.map((key, index) => {
    const meta = SECTION_META[key];
    const ov = sOver[key] && typeof sOver[key] === 'object' ? sOver[key] : {};
    const titleStyle = pick(ov.titleStyle, theme.sectionTitle);
    return {
      key,
      index,
      title: String(ov.title || meta.title),
      visible: hidden.has(key) ? false : (ov.visible === false ? false : true),
      titleStyle,
      // 左侧栏样式本身就是标题在左边，不需要再叠一次 placement
      placement: pick(ov.placement, titleStyle === 'gutter' ? 'left' : 'above'),
      align: pick(ov.align, header.align === 'center' ? 'center' : 'left'),
      bullet: pick(ov.bullet, theme.bullet),
      itemLayout: pick(ov.itemLayout, theme.itemLayout || 'stack'),
      numbering: ov.numbering == null ? (theme.numbering || 'none') : pick(ov.numbering, theme.numbering || 'none'),
      skills: pick(ov.skills, theme.skills || 'rows'),
      icon: pick(ov.icon, theme.icon || 'none'),
      timeline: ov.timeline == null ? !!theme.timeline : !!ov.timeline,
      scale: num(ov.scale, 1),
      gapBefore: Number.isFinite(Number(ov.gapBefore)) ? Number(ov.gapBefore) : 0,
    };
  });

  return {
    theme,
    vars,
    // 字号阶梯与间距，HTML 与 PDF 共用
    m: metrics(vars.fontSize, vars.lineHeight, vars.gapScale, header.style),
    header,
    sections: resolvedSections,
    order: sections,
    page: {
      size: opts.pageSize || 'A4',
      margin: opts.margin || '14mm 15mm',
    },
    decor: {
      pageNumbers: !!opts.showPageNumbers,
      watermark: opts.showWatermark && opts.watermarkText ? String(opts.watermarkText) : null,
      total: null,
    },
    customCSS: cssOf(layout, opts),
    hidden,
  };
}

function themeById(id) {
  return THEMES[id] || null;
}

/** 给前端的描述：主题清单 + 可选项 + 章节元信息 */
function describe() {
  return {
    themes: THEME_LIST.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      tag: t.tag || '',
      accent: t.accent,
      accent2: t.accent2,
      serif: !!t.serif,
      header: t.header,
      sectionTitle: t.sectionTitle,
      bullet: t.bullet,
      itemLayout: t.itemLayout || 'stack',
      numbering: t.numbering || 'none',
      skills: t.skills || 'rows',
      radius: t.radius || 'soft',
      icon: t.icon || 'none',
      timeline: !!t.timeline,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      labelWidth: t.labelWidth || 92,
    })),
    titles: TITLE_STYLES,
    bullets: BULLETS,
    aligns: ALIGNS,
    placements: PLACEMENTS,
    itemLayouts: ITEM_LAYOUTS,
    radii: RADII,
    icons: ICONS,
    numberings: NUMBERINGS,
    sections: Object.entries(SECTION_META).map(([key, m]) => ({ key, title: m.title, hint: m.hint })),
    defaultOrder: DEFAULT_ORDER.slice(),
    defaultTheme: DEFAULT_THEME,
  };
}

module.exports = {
  THEMES,
  THEME_LIST,
  THEME_BY_ID: THEMES,
  DEFAULT_THEME,
  DEFAULT_ORDER,
  SECTION_META,
  TITLE_STYLES,
  BULLETS,
  ALIGNS,
  PLACEMENTS,
  resolve,
  metrics,
  describe,
  themeById,
  SANS,
  SERIF,
};
