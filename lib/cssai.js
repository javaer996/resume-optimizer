'use strict';

/**
 * 用一句话描述想要的效果，让 AI 写出一段只作用于简历预览的 CSS。
 *
 * 设计要点：
 * - AI 只会拿到「结构说明 + 可用变量」，不会拿到简历内容（隐私边界和 research 一致）
 * - 输出必须清洗：去掉代码块围栏、@import、外链 url()、`</style>` 逃逸
 * - 解析失败/模型跑偏时抛错，由上层决定是否保留原有 CSS（绝不静默覆盖）
 */

const providers = require('./providers');

const MAX_CSS = 12000;
const MAX_PROMPT = 600;
const MAX_CURRENT = 4000;

const SELECTORS = `可用选择器（只能用这些类名，不要发明新类）：
.page                          整张 A4 纸（背景、内边距、水印）
.head                          头部容器；修饰类 .head--band 色带 / .head--center 居中 / .head--rule 下划线
.head .name / .head .title / .head .eyebrow     姓名、职位、眉标
.head .contacts .contact / .head .chip          联系方式、联系方式胶囊
.sec                           每个章节；修饰类 .sec--t-caps 大写细体 / .sec--t-chip 色块 / .sec--t-bar 竖条 / .sec--t-gutter 左栏 / .sec--t-underline 下划线 / .sec--t-plain 纯文字
.sec .sec-title / .sec .sec-num / .sec .sec-ico / .sec .sec-body     章节标题、序号、图标、正文
.sec--left / .sec--right       左右分栏章节的两侧
.item .item-head .item-left .item-right        条目、首行、左右两半
.item .item-org / .item-role / .item-loc / .item-sub / .item-when      单位、角色、地点、副标题、时间
.item--card                    卡片式条目
.bullets li                    要点列表项（::before 是项目符号）
.summary                       个人简介段落
.skill-row .skill-cat .skill-items .skill-tag .skill-tags    技能行、分类名、技能、标签
.tech .sep .watermark          技术栈行、分隔符、水印

注意：主题自带的规则往往比你写的更具体（例如姓名是 .head--band .name）。所以要写 .head .name、
.sec .sec-title、.item .item-org 这种带一层父级的选择器，不要只写 .name、.sec-title，否则改不动。`;

const VARS = `可用 CSS 变量（优先用它们，这样跟随主题与逐段设置）：
--accent 主色  --ink 正文色  --muted 次要色  --soft 分隔线色
--font-family --font-size --line-height --gap 基础间距 --label-w
--radius --radius-sm            圆角
--sec-scale                     章节整体缩放
--m-name --m-name-track --m-title --m-section --m-eyebrow   字号阶梯
--m-org --m-role --m-meta --m-chip --m-summary
--m-head-gap --m-section-gap --m-title-gap --m-item-gap --m-bullet-gap --m-indent`;

const SYSTEM = [
  '你是简历排版与 CSS 专家。用户会用自然语言描述想要的效果，你把它翻译成一段 CSS。',
  '',
  '硬性规则：',
  '1. 只输出 CSS 本身，不要任何解释、不要 Markdown 代码块围栏、不要 <style> 标签。',
  '2. 只使用下面列出的选择器；不要新增类名、不要写 JS、不要用 @import 或外链字体/图片。',
  '3. 尽量用 CSS 变量（如 var(--accent)、var(--m-section)），这样能跟随主题；需要固定值时用 px/pt/em。',
  '4. 简历要打印在 A4 上：不要 position: fixed、不要超大留白、不要把内容顶出纸张；避免会撑破分页的写法。',
  '5. 用注释分段（/* 头部 */），每段注释不超过一行。',
  '6. 代码要短，通常 20–80 行足够；不要重复主题已有的样式。',
  '',
  SELECTORS,
  '',
  VARS,
].join('\n');

/** 去掉 ```css 围栏与前后废话，只留 CSS 主体 */
function stripFence(raw) {
  let s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  const fence = s.match(/```(?:css|CSS)?\s*\n([\s\S]*?)```/);
  if (fence) s = fence[1];
  s = s.replace(/^\s*<style[^>]*>/i, '').replace(/<\/style>\s*$/i, '');
  return s.trim();
}

/** 从「解释 + CSS」混排里切出 CSS：丢掉第一个 { 之前的散文行，保留注释与选择器 */
function cutToCss(s) {
  if (!s) return s;
  const firstBrace = s.indexOf('{');
  if (firstBrace < 0) return s;
  const head = s.slice(0, firstBrace);
  const lines = head.split('\n');
  let cut = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const isComment = line.startsWith('/*') || line.startsWith('*');
    if (isComment) continue;
    // 中文句子、或以句末标点收尾的句子 = 散文，不是选择器
    if (/[\u4e00-\u9fa5]/.test(line) || /[。？！：]$/.test(line)) cut = i + 1;
  }
  if (!cut) return s;
  return (lines.slice(cut).join('\n') + s.slice(head.length)).trim();
}

/**
 * 清洗：去围栏 → 去危险写法 → 截断。
 * 返回 { css, warnings: [] }
 */
function sanitize(raw) {
  const warnings = [];
  let css = cutToCss(stripFence(raw));

  if (/@import/i.test(css)) {
    css = css.replace(/@import[^;]*;?/gi, '');
    warnings.push('去掉了 @import（不允许加载外部资源）');
  }
  if (/url\(\s*['"]?(https?:)?\/\//i.test(css)) {
    css = css.replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*\)/gi, 'none');
    warnings.push('去掉了外链图片/字体');
  }
  if (/<\/?style|<\/?script/i.test(css)) {
    css = css.replace(/<\/?(?:style|script)[^>]*>/gi, '');
    warnings.push('去掉了 style/script 标签');
  }
  if (/expression\s*\(|javascript:/i.test(css)) {
    css = css.replace(/expression\s*\([^)]*\)/gi, '').replace(/javascript:/gi, '');
    warnings.push('去掉了脚本类写法');
  }
  if (css.length > MAX_CSS) {
    css = css.slice(0, MAX_CSS);
    warnings.push(`超过 ${MAX_CSS} 字符，已截断`);
  }
  return { css: css.trim(), warnings };
}

/** 括号配平（跳过注释与字符串），返回 null 或错误说明 */
function balanceError(css) {
  let depth = 0;
  let i = 0;
  const s = String(css || '');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return '注释没有闭合（缺少 */）';
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= s.length) return '字符串没有闭合';
      i = j + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth < 0) return '右花括号多了';
    }
    i += 1;
  }
  if (depth > 0) return '左花括号没有闭合';
  return null;
}

/** 看起来像 CSS 吗（至少有选择器和一对花括号） */
function looksLikeCss(css) {
  return /\{/.test(css) && /\}/.test(css) && /[a-z-]+\s*:/.test(css);
}

function validate(css) {
  const s = String(css || '').trim();
  if (!s) return '没有生成任何 CSS';
  const bad = balanceError(s);
  if (bad) return `CSS 语法不完整：${bad}`;
  if (!looksLikeCss(s)) return '生成的内容不像 CSS（没有找到选择器与属性）';
  return null;
}

function buildMessages({ prompt, current, theme }) {
  const lines = [
    theme ? `当前主题：${theme}（可以在此基础上微调，也可以直接覆盖）` : '',
    `【想要的效果】${prompt}`,
  ].filter(Boolean);
  if (current && current.trim()) {
    lines.push('', '【当前已有的自定义 CSS】（在此基础上调整，不要丢掉用户已经满意的部分）', current.slice(0, MAX_CURRENT));
  }
  lines.push('', '请直接输出 CSS。');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * @param {{prompt: string, current?: string, theme?: string, provider: object}} input
 * @returns {Promise<{css: string, warnings: string[], model: string, elapsedMs: number}>}
 */
async function generate(input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    const err = new Error('先说说想要什么效果');
    err.code = 'empty_prompt';
    err.status = 400;
    throw err;
  }
  if (prompt.length > MAX_PROMPT) {
    const err = new Error(`描述太长了（${prompt.length} 字），请压到 ${MAX_PROMPT} 字以内`);
    err.code = 'prompt_too_long';
    err.status = 400;
    throw err;
  }
  if (!input.provider) {
    const err = new Error('还没有可用的 AI 供应商，请先到「供应商」页配置一个');
    err.code = 'no_provider';
    err.status = 400;
    throw err;
  }

  const started = Date.now();
  let raw;
  try {
    raw = await providers.chat(input.provider, buildMessages({
      prompt,
      current: input.current,
      theme: input.theme,
    }));
  } catch (err) {
    const out = new Error(`AI 调用失败：${err.message}`);
    out.code = 'ai_failed';
    out.status = 502;
    throw out;
  }

  const { css, warnings } = sanitize(raw);
  const bad = validate(css);
  if (bad) {
    const err = new Error(bad);
    err.code = 'bad_css';
    err.status = 422;
    err.raw = String(raw || '').slice(0, 800);
    throw err;
  }

  return {
    css,
    warnings,
    model: input.provider.model || input.provider.name || '',
    elapsedMs: Date.now() - started,
  };
}

module.exports = {
  MAX_CSS,
  MAX_PROMPT,
  SYSTEM,
  SELECTORS,
  VARS,
  stripFence,
  sanitize,
  balanceError,
  looksLikeCss,
  validate,
  buildMessages,
  generate,
};
