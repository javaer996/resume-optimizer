'use strict';

/**
 * 简历版式引擎：把我们自己的 PDF 写入器当画笔，按 lib/themes.js 解析出的设计令牌
 * 排出与 HTML 版一致的版面。
 *
 * 单位说明：CSS 里的 px 在打印时是 1/96 英寸，而 PDF 用 pt（1/72 英寸），
 * 所以所有来自样式表的长度都要乘 0.75。这样同一套数字在 HTML 与 PDF 里视觉一致。
 *
 * 职责边界：这个文件不认识「主题名」，只认识 resolve() 给的字段
 * （header.style / sections[].titleStyle / bullet / timeline / placement / scale …）。
 * 新增主题只需改 lib/themes.js。
 */

const { PDFWriter } = require('./writer');
const themes = require('../themes');

const CSS_PX = 0.75;
const MM = 2.834645669;

const INK = '#1f2328';

/** "14mm 15mm" → {top,right,bottom,left} 单位 pt */
function parseMargin(str) {
  const parts = String(str || '14mm 15mm').trim().split(/\s+/).map((p) => {
    const m = /^(-?[\d.]+)(mm|cm|in|pt|px)?$/.exec(p);
    if (!m) return null;
    const v = parseFloat(m[1]);
    switch (m[2]) {
      case 'cm': return v * 10 * MM;
      case 'in': return v * 72;
      case 'pt': return v;
      case 'px': return v * CSS_PX;
      default: return v * MM;
    }
  }).filter((v) => v != null && Number.isFinite(v));
  const [a, b = a, c = a, d = b] = parts;
  if (parts.length === 1) return { top: a, right: a, bottom: a, left: a };
  if (parts.length === 2) return { top: a, right: b, bottom: a, left: b };
  if (parts.length === 3) return { top: a, right: b, bottom: c, left: b };
  return { top: a, right: b, bottom: c, left: d };
}

const isCjk = (cp) => (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)
  || (cp >= 0x20000 && cp <= 0x3ffff);

const NO_LINE_START = new Set('，。、；：？！）》」』】〕…—·%,.;:?!)]}%');
const NO_LINE_END = new Set('（《「『【〔([{');

const BULLET_CHAR = { dot: '•', dash: '–', square: '▪', ring: '○', none: '' };

/* ---------------- 颜色工具 ---------------- */

function hexToRgb(hex) {
  const s = String(hex || '#000000').replace('#', '');
  const full = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 按 t（0~1）把 from 混向 to */
const CN_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 章节序号，与 lib/render.js 的 numberLabel 保持同一套规则 */
function numberLabel(kind, index) {
  if (kind === 'index') return String(index + 1).padStart(2, '0');
  if (kind === 'dot') return `${CN_NUMS[index] || index + 1}、`;
  return '';
}

function blend(from, to, t) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

class Layout {
  /**
   * @param {PDFWriter} writer
   * @param {object} cfg themes.resolve() 的结果
   */
  constructor(writer, cfg) {
    this.w = writer;
    // 允许直接传导出设置（{theme:'classic'}），省得每个调用方都先 resolve 一次
    this.cfg = cfg && cfg.vars ? cfg : themes.resolve(cfg || {});
    const v = this.cfg.vars;
    this.accent = v.accent;
    this.accent2 = v.accent2;
    this.ink = v.ink;
    this.muted = v.muted;
    this.soft = v.soft;
    this.vars = v;
    this.basePx = v.fontSize;
    this.lineHeight = v.lineHeight;
    // 字号阶梯与间距节奏统一来自 themes.metrics()，与 HTML 端同一份数值。
    // 以前这里和 renderCSS 各写一套倍率，改一处忘一处就会出现
    // 「预览好看、导出挤成一团」。
    this.m = this.cfg.m
      || themes.metrics(v.fontSize, v.lineHeight, v.gapScale, (this.cfg.header || {}).style);
    this.gap = this.m.gap;
    this.labelW = (v.labelWidth || 92) * CSS_PX;

    this.size = writer.size;
    const margin = typeof this.cfg.page.margin === 'string' ? parseMargin(this.cfg.page.margin) : null;
    this.margin = margin || { top: 14 * MM, right: 15 * MM, bottom: 14 * MM, left: 15 * MM };
    this.left = this.margin.left;
    this.right = this.size[0] - this.margin.right;
    this.width = this.right - this.left;
    this.top = this.size[1] - this.margin.top;
    this.bottom = this.margin.bottom;

    this.y = this.top;
    this.primary = 'zh';
    // 主字体（中文字体）常常缺一些西文符号，比如 • 和 –，
    // 这些字逐个回退到西文字体，否则会印成方框。
    this.fallback = writer.hasFont('latin') ? 'latin' : null;
    this.tl = null;
  }

  /** 某个字符该用哪个字体：主字体有字形就用主字体，否则回退 */
  fontKeyFor(cp) {
    const primary = this.w.fonts.get(this.primary);
    if (primary && primary.font.cmap.has(cp)) return this.primary;
    if (this.fallback) {
      const fb = this.w.fonts.get(this.fallback);
      if (fb && fb.font.cmap.has(cp)) return this.fallback;
    }
    return this.primary;
  }

  /** 把字符串按字体切成若干段，避免整段退化成方框 */
  segments(str) {
    const out = [];
    let current = null;
    for (const ch of String(str)) {
      const key = this.fontKeyFor(ch.codePointAt(0));
      if (current && current.key === key) current.text += ch;
      else {
        current = { key, text: ch };
        out.push(current);
      }
    }
    return out;
  }

  /* ---------------- 度量 ---------------- */

  fontMetrics(key = this.primary) {
    const entry = this.w.fonts.get(key);
    if (!entry) throw new Error(`字体 ${key} 未注册`);
    const f = entry.font;
    return {
      ascender: f.ascender / f.unitsPerEm,
      descender: f.descender / f.unitsPerEm,
      unitsPerEm: f.unitsPerEm,
    };
  }

  /** 字符串宽度（pt）。key 传 null 时按字符逐个选字体 */
  measure(str, sizePx, key = null, charSpace = 0) {
    const sizePt = sizePx * CSS_PX;
    let total = 0;
    if (key) {
      const entry = this.w.fonts.get(key);
      if (!entry) return 0;
      const f = entry.font;
      let units = 0;
      for (const ch of String(str)) {
        const gid = f.cmap.get(ch.codePointAt(0));
        units += gid == null ? f.advances[0] : f.advances[gid];
      }
      total = units / f.unitsPerEm * sizePt;
    } else {
      for (const seg of this.segments(str)) total += this.measure(seg.text, sizePx, seg.key);
    }
    if (charSpace) total += charSpace * [...String(str)].length;
    return total;
  }

  /** 一个 line box 的高度（pt） */
  lineBox(sizePx, lineHeight = this.lineHeight) {
    return sizePx * lineHeight * CSS_PX;
  }

  /** 基线相对 line box 顶部的偏移（pt）。纵向度量统一用主字体，避免行高忽高忽低 */
  baselineOffset(sizePx, key = null, lineHeight = this.lineHeight) {
    const box = this.lineBox(sizePx, lineHeight);
    const m = this.fontMetrics(key || this.primary);
    const content = (m.ascender - m.descender) * sizePx * CSS_PX;
    const leading = box - content;
    return leading / 2 + m.ascender * sizePx * CSS_PX;
  }

  /* ---------------- 排版原语 ---------------- */

  newPage() {
    this.w.newPage();
    this.y = this.top;
  }

  /** 空间不够就翻页；返回是否翻了页 */
  ensure(height) {
    if (this.y - height >= this.bottom) return false;
    this.newPage();
    return true;
  }

  /**
   * 在一行里画一段文字，y 是基线。
   * 内部按字符选字体，所以中英混排、中文引号与 • 这类符号都能正确落字。
   */
  draw(str, x, baselineY, { sizePx = this.basePx, color = INK, key = null, charSpace = 0 } = {}) {
    if (!str) return 0;
    const sizePt = sizePx * CSS_PX;
    if (key) {
      this.w.text(x, baselineY, str, { font: key, size: sizePt, color, charSpace });
      return this.measure(str, sizePx, key, charSpace);
    }
    let cursor = x;
    for (const seg of this.segments(str)) {
      this.w.text(cursor, baselineY, seg.text, { font: seg.key, size: sizePt, color, charSpace });
      cursor += this.measure(seg.text, sizePx, seg.key, charSpace);
    }
    return cursor - x;
  }

  /** 横向渐变填充（用多条细矩形拼出来，PDF 里没有渐变对象） */
  gradientRect(x, y, w, h, from, to, steps = 64) {
    const n = Math.max(2, Math.min(steps, Math.ceil(w / 2)));
    const sw = w / n;
    for (let i = 0; i < n; i++) {
      this.w.rect(x + i * sw, y, sw + 0.35, h, { fill: blend(from, to, i / (n - 1)) });
    }
  }

  /** 居中画一行文字，返回宽度 */
  drawCentered(str, centerX, baselineY, opts = {}) {
    const w = this.measure(str, opts.sizePx || this.basePx, opts.key || null, opts.charSpace || 0);
    this.draw(str, centerX - w / 2, baselineY, opts);
    return w;
  }

  /** 右对齐画一行文字，返回宽度 */
  drawRight(str, rightX, baselineY, opts = {}) {
    const w = this.measure(str, opts.sizePx || this.basePx, opts.key || null, opts.charSpace || 0);
    this.draw(str, rightX - w, baselineY, opts);
    return w;
  }

  /**
   * 在 line 里找一个合适的位置断开。
   * @param {string} line 当前行
   * @param {string} nextCh 即将加进来的字符
   * @returns {number} 断开位置（0 表示找不到，只能硬断）
   */
  breakPoint(line, nextCh) {
    for (let i = line.length; i > 0; i--) {
      const prev = line[i - 1];
      const next = i < line.length ? line[i] : nextCh;
      if (prev === ' ' || prev === '-' || prev === '/') return i;
      if (isCjk(prev.codePointAt(0))) return i;
      if (next && isCjk(next.codePointAt(0))) return i;
    }
    return 0;
  }

  /**
   * 按宽度折行。中文逐字可断，西文按词断；标点避头尾。
   * @returns {string[]}
   */
  wrap(str, maxWidth, sizePx, key = null) {
    const text = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (this.measure(text, sizePx, key) <= maxWidth) return [text];

    const lines = [];
    let line = '';
    for (const ch of Array.from(text)) {
      if (line && this.measure(line + ch, sizePx, key) > maxWidth) {
        const cut = this.breakPoint(line, ch);
        if (cut > 0) {
          lines.push(line.slice(0, cut).replace(/\s+$/, ''));
          line = line.slice(cut).replace(/^ +/, '') + ch;
        } else {
          lines.push(line.replace(/\s+$/, ''));
          line = ch;
        }
        // 断开后剩下的那截可能还是超宽（窄栏 + 长英文单词），继续切
        while (line && this.measure(line, sizePx, key) > maxWidth && line.length > 1) {
          const again = this.breakPoint(line, '');
          if (again <= 0) break;
          lines.push(line.slice(0, again).replace(/\s+$/, ''));
          line = line.slice(again).replace(/^ +/, '');
        }
      } else {
        line += ch;
      }
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));

    // 避头尾：行首不能是收尾标点，行尾不能是起始标点
    for (let i = 1; i < lines.length; i++) {
      let guard = 0;
      while (lines[i] && NO_LINE_START.has(lines[i][0]) && guard++ < 8) {
        // 把标点收回上一行；若上一行因此超宽，就再把上一行的末字推到下一行
        const ch = lines[i][0];
        lines[i - 1] += ch;
        lines[i] = lines[i].slice(1);
        while (lines[i - 1].length > 1 && this.measure(lines[i - 1], sizePx, key) > maxWidth) {
          lines[i] = lines[i - 1].slice(-1) + lines[i];
          lines[i - 1] = lines[i - 1].slice(0, -1);
          if (NO_LINE_START.has(lines[i][0]) && lines[i].length > 1) break;
        }
      }
      guard = 0;
      while (lines[i - 1] && NO_LINE_END.has(lines[i - 1][lines[i - 1].length - 1]) && guard++ < 8) {
        const ch = lines[i - 1].slice(-1);
        lines[i] = ch + lines[i];
        lines[i - 1] = lines[i - 1].slice(0, -1);
        if (this.measure(lines[i], sizePx, key) > maxWidth) {
          // 下一行装不下就退回，宁可让起始标点留在行尾
          lines[i - 1] += ch;
          lines[i] = lines[i].slice(1);
          break;
        }
      }
    }
    return lines.filter((l) => l.length > 0).flatMap((l) => {
      // 最后兜底：避头尾的调整可能让某行变宽，超了就再硬切一刀
      if (this.measure(l, sizePx, key) <= maxWidth + 0.01) return [l];
      const out = [];
      let cur = '';
      for (const ch of Array.from(l)) {
        if (cur && this.measure(cur + ch, sizePx, key) > maxWidth) {
          out.push(cur);
          cur = ch;
        } else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    });
  }

  /**
   * 画一个段落（自动排版、自动翻页）。
   * @returns {number} 消耗的高度
   */
  paragraph(str, {
    x = this.left, width = this.width, sizePx = this.basePx,
    color = this.ink, lineHeight = this.lineHeight, indent = 0, hangingIndent = 0,
    justify = false, key = null,
  } = {}) {
    const avail = width - indent;
    const lines = this.wrap(str, avail - hangingIndent, sizePx, key);
    if (!lines.length) return 0;
    const box = sizePx * lineHeight * CSS_PX;
    let used = 0;
    lines.forEach((ln, i) => {
      this.ensure(box);
      const dx = i === 0 ? x + indent : x + indent + hangingIndent;
      const base = this.y - this.baselineOffset(sizePx, key, lineHeight);
      if (justify && i < lines.length - 1 && !isCjk(ln.codePointAt(0))) {
        const natural = this.measure(ln, sizePx, key);
        const extra = (avail - hangingIndent) - natural;
        const gaps = (ln.match(/ /g) || []).length;
        if (gaps > 0 && extra > 0) {
          this.draw(ln, dx, base, { sizePx, color, key, charSpace: extra / gaps });
          this.y -= box;
          used += box;
          return;
        }
      }
      this.draw(ln, dx, base, { sizePx, color, key });
      this.y -= box;
      used += box;
    });
    return used;
  }

  space(px) {
    this.y -= px * CSS_PX;
  }

  /* ---------------- 章节标题 ---------------- */

  /**
   * 章节图标。形状与 HTML 里的 SVG 一一对应，尺寸跟着字号走。
   * 返回图标占用的宽度（含右侧间距），调用方据此右移标题起点。
   */
  /**
   * 画章节图标。返回「图标宽 + 间距」，调用方据此右移文字起点。
   * x0 / color 可覆盖：色块(chip)标题的图标在色块内部，要用白色，
   * 且起点从色块内边距开始，不能画到色块外面。
   */
  sectionIcon(kind, baseY, sizePx, x0, colorOverride, holeColor) {
    if (!kind || kind === 'none' || kind === 'inherit') return 0;
    const d = sizePx * 0.62 * CSS_PX;      // 图标边长
    const gap = sizePx * 0.5 * CSS_PX;     // 与文字的间距——用户明确要求不能贴在一起
    const left = x0 == null ? this.left : x0;
    const cx = left + d / 2;
    const cy = baseY + sizePx * CSS_PX * 0.34; // 与汉字重心对齐
    const color = colorOverride || this.accent;
    if (kind === 'dot') {
      this.w.roundRect(cx - d / 2, cy - d / 2, d, d, d / 2, { fill: color });
    } else if (kind === 'ring') {
      // 空心环：外圈填色 + 内圈挖白（PDF 没有镂空填充，用覆盖法）
      this.w.roundRect(cx - d / 2, cy - d / 2, d, d, d / 2, { fill: color });
      const w = d * 0.54;
      // 空心环的「挖洞」要填成图标背后的底色：纸上是白色，色块标题里是 accent
      this.w.roundRect(cx - w / 2, cy - w / 2, w, w, w / 2, { fill: holeColor || '#ffffff' });
    } else if (kind === 'square') {
      this.w.roundRect(cx - d / 2, cy - d / 2, d, d, d * 0.2, { fill: color });
    } else if (kind === 'line') {
      this.w.roundRect(cx - d * 0.13, cy - d / 2, d * 0.26, d, d * 0.13, { fill: color });
    } else if (kind === 'diamond') {
      this.w.poly([
        [cx, cy - d / 2], [cx + d / 2, cy], [cx, cy + d / 2], [cx - d / 2, cy],
      ], { fill: color });
    }
    return d + gap;
  }

  /**
   * 画章节标题。返回标题占用的高度，并把 this.y 推进到标题下方。
   * 'hidden' 样式不画任何东西。
   */
  sectionTitle(sec, titleOverride) {
    const style = sec.titleStyle;
    const num = numberLabel(sec.numbering, sec.index || 0);
    const titleText = titleOverride || sec.title;
    if (style === 'hidden' || !titleText) return;
    // 序号用浅色，和标题拉开层次；gutter 版式里序号独占一行
    const title = num ? `${num}${titleText}` : titleText;
    const sizePx = this.m.sectionTitle;
    const box = this.lineBox(sizePx) * 0.98;
    const accent = this.accent;

    if (style === 'caps') {
      // 字距拉开的小标 + 一条向右淡出的细线（与 HTML 的 ::after 一致）
      const cs = 0.82 * CSS_PX;
      const capsSize = this.m.eyebrow;
      const capsBox = this.lineBox(capsSize);
      this.ensure(capsBox + this.m.titleGap);
      const base = this.y - this.baselineOffset(capsSize);
      const icoW = this.sectionIcon(sec.icon, base, capsSize);
      const w0 = this.draw(title, this.left + icoW, base, { sizePx: capsSize, color: accent, charSpace: cs });
      const w = icoW + w0;
      // 细线从标题右侧留一点空隙起画，用几段递减的浅色拼出淡出效果
      const lineX = this.left + w + 7 * CSS_PX;
      const lineW = this.right - lineX;
      if (lineW > 12 * CSS_PX) {
        const steps = 24;
        const segW = lineW / steps;
        for (let i = 0; i < steps; i++) {
          const t = i / (steps - 1);
          this.w.rect(lineX + i * segW, base - capsSize * CSS_PX * 0.24, segW + 0.35, 0.75, {
            fill: blend(accent, '#ffffff', 0.34 + t * 0.62),
          });
        }
      }
      this.y -= capsBox + this.m.titleGap;
      return w;
    }

    if (style === 'chip') {
      // 与 HTML 的 .sec--t-chip 用同一套尺寸:块高固定 1.62em、左右内边距 .72em。
      // 以前是 lineBox*0.86 + 上下各 3pt,块被撑到 2em 高,字装在中间显得偏上。
      const padX = sizePx * 0.72 * CSS_PX;
      const h = sizePx * 1.5 * CSS_PX;
      // 胶囊是往上画的:先按它的实际高度留位置,再夹住顶点不越过上边距。
      // 否则翻页后 y 刚回到页顶,胶囊就会顶出边距(实测「证书 / 资质」那一行)。
      this.ensure(h + 6);
      const top = this.y;
      const fm = this.fontMetrics(this.primary);
      const asc = fm.ascender * sizePx * CSS_PX;
      const desc = fm.descender * sizePx * CSS_PX;
      // 把字体的 ascent~descent 整段居中放进块里,与 HTML 的行盒居中同构,
      // 这样墨迹的上下留白只差零点几个像素,不会出现「顶部空一个字」。
      const base = top - (h - (asc - desc)) / 2 - asc;
      // 图标在胶囊里面(白色),和文字一样吃内边距,不能画到胶囊外面去。
      const icoW = this.sectionIcon(sec.icon, base, sizePx, this.left + padX, '#ffffff', accent);
      const w = this.measure(title, sizePx) + padX * 2 + icoW;
      this.w.roundRect(this.left, top - h, w, h, this.vars.radius, { fill: accent });
      // 文字在胶囊里垂直居中:按字体的实际 ascent/descent 算基线,
      // 不能用 lineBox 的近似值——那会让字顶穿出胶囊上沿,翻页后压到页边距。
      this.draw(title, this.left + padX + icoW, base, { sizePx, color: '#ffffff' });
      this.y = top - h - 5 * CSS_PX;
      return;
    }

    this.ensure(box + 14);

    const padLeft = style === 'bar' ? 8 * CSS_PX : 0;
    const base = this.y - this.baselineOffset(sizePx);
    if (style === 'bar') this.w.rect(this.left, this.y - box + 1.5, 3.5 * CSS_PX, box - 3, { fill: accent });
    const icoW = this.sectionIcon(sec.icon, base, sizePx);
    this.draw(title, this.left + padLeft + icoW, base, { sizePx, color: style === 'plain' ? this.ink : accent });
    this.y -= box;

    if (style === 'underline') {
      this.w.rect(this.left, this.y + 1.5, this.width, 1.5 * CSS_PX, { fill: accent });
      this.y -= 1.5 * CSS_PX;
    } else if (style === 'plain') {
      this.w.rect(this.left, this.y + 1, this.width, 0.75, { fill: '#dcdfe4' });
      this.y -= 0.75;
    }
    this.y -= this.m.titleGap;
  }

  /* ---------------- 正文组件 ---------------- */

  bullet(text, { sizePx = this.basePx * this.scale, color = this.ink, bulletChar = '•' } = {}) {
    const box = this.lineBox(sizePx);
    const indent = bulletChar ? this.m.bulletIndent : 0;
    const lines = this.wrap(text, this.width - indent - 1, sizePx);
    lines.forEach((ln, i) => {
      const pageBroken = this.ensure(box);
      const base = this.y - this.baselineOffset(sizePx);
      if (i === 0 && !pageBroken && bulletChar) {
        this.draw(bulletChar, this.left + 1, base, { sizePx: sizePx * (bulletChar === '▪' || bulletChar === '○' ? 0.82 : 1), color: this.accent });
      }
      this.draw(ln, this.left + indent, base, { sizePx, color });
      this.y -= box;
    });
    this.y -= this.m.bulletGap + 1.2 * CSS_PX;
  }

  /** 一行两端对齐的左值/右值（单位 + 时间） */
  twoColumn(leftText, roleText, rightText, { sizePx = this.basePx * this.scale, rightSizePx = this.m.meta, layout = 'stack' } = {}) {
    const box = this.lineBox(sizePx);
    // block 排法：时间先独占一行压在单位上方，像履历表
    if (layout === 'block' && rightText) {
      const metaBox = this.lineBox(rightSizePx);
      this.ensure(metaBox + box);
      const metaBase = this.y - this.baselineOffset(rightSizePx);
      this.draw(rightText, this.left, metaBase, { sizePx: rightSizePx, color: this.muted, charSpace: 0.24 * CSS_PX });
      this.y -= metaBox + 1.4 * CSS_PX;
      if (this.tl) this.tl.dots.push(metaBase - rightSizePx * CSS_PX * 0.34);
    }

    this.ensure(box);
    const base = this.y - this.baselineOffset(sizePx);
    const rightW = layout === 'inline' ? 0 : (rightText ? this.measure(rightText, rightSizePx) : 0);
    const gap = 10 * CSS_PX;

    this.draw(leftText, this.left, base, { sizePx, color: this.ink });
    let x = this.left + this.measure(leftText, sizePx) + 8 * CSS_PX;
    if (roleText) {
      const room = this.right - rightW - gap - x;
      if (room > 20) {
        const roleLines = this.wrap(roleText, room, sizePx);
        this.draw(roleLines[0] || '', x, base, { sizePx, color: this.soft });
        x += this.measure(roleLines[0] || '', sizePx);
      }
    }
    if (layout === 'inline' && rightText) {
      // 时间紧跟在后，用 · 分隔，不推到右边缘
      const sep = '·';
      const sepW = this.measure(` ${sep} `, rightSizePx);
      const whenW = this.measure(rightText, rightSizePx);
      if (x + sepW + whenW <= this.right) {
        this.draw(` ${sep} `, x, base, { sizePx: rightSizePx, color: '#b9bec6' });
        this.draw(rightText, x + sepW, base, { sizePx: rightSizePx, color: this.muted });
        x += sepW + whenW;
      }
    } else if (rightText && layout !== 'block') {
      this.drawRight(rightText, this.right, base, { sizePx: rightSizePx, color: this.muted });
    }
    if (this.tl) this.tl.dots.push(base - sizePx * CSS_PX * 0.34);
    this.y -= box;
    return { baseline: base, usedLeft: x };
  }

  /**
   * card 排法的条目底色。开始处记下 y 与左边距，结束时按实际高度补画背景。
   * 纸面没有圆角，所以只画左侧色条 + 浅底，跟 HTML 的卡片观感对齐。
   */
  itemStart() {
    if ((this.itemLayout || 'stack') !== 'card') return;
    this.cardTop = this.y;
    this.cardLeft = this.left;
  }

  itemEnd() {
    if ((this.itemLayout || 'stack') !== 'card') return;
    if (this.cardTop == null) return;
    const padX = 8 * CSS_PX;
    const padY = 5 * CSS_PX;
    const h = this.cardTop - this.y + padY * 2;
    // 底色铺在内容下面，所以用极浅的灰；左侧 2.4pt 的色条做强调
    this.w.rect(this.cardLeft - padX, this.y - padY, this.width + padX * 2, h, { fill: '#f6f7f9' });
    this.w.rect(this.cardLeft - padX, this.y - padY, 2.4 * CSS_PX, h, { fill: this.accent });
    this.cardTop = null;
  }

  /* ---------------- 头部 ---------------- */

  header(b) {
    const cfg = this.cfg.header;
    const S = this.basePx;
    const contacts = [b.phone, b.email, b.location, b.website].filter(Boolean);
    const nameSize = this.m.name;
    const titleText = cfg.showTitle ? (b.title || b.highlight || '') : '';
    const titleSize = this.m.title;
    const nameBox = this.lineBox(nameSize);
    const contactsShown = cfg.showContacts && contacts.length > 0;
    const center = cfg.align === 'center' || cfg.style === 'center';

    // 联系方式排布：chip 圆角块 / 纯文字用 · 分隔
    const chipMode = cfg.chips && cfg.style !== 'band' && cfg.style !== 'center';
    const chipSize = this.m.chip;
    const metaSize = this.m.meta;
    const contactH = contactsShown
      ? (chipMode ? this.lineBox(chipSize) * 0.9 + 4 * CSS_PX : this.lineBox(metaSize))
      : 0;

    if (cfg.style === 'band') {
      /* 渐变横幅：白色文字，联系方式在名字下方一行 */
      const padX = 17 * CSS_PX;
      const padY = 13 * CSS_PX;
      const bodyH = nameBox + (titleText ? this.lineBox(titleSize) : 0) + (contactsShown ? this.lineBox(metaSize) + 3 * CSS_PX : 0);
      const bandH = bodyH + padY * 2;
      this.ensure(bandH + 12);
      const top = this.y;
      this.gradientRect(this.left, top - bandH, this.width, bandH, this.accent, this.accent2);
      let cy = top - padY;
      // 横幅与居中这两种头部本来就是「整行一段话」的设计，一律用 · 分隔，
      // 不套胶囊——HTML 那边也是同一套规则，两边用字才对得上。
      const bandSep = '   ·   ';
      if (center) {
        const cx = (this.left + this.right) / 2;
        this.drawCentered(b.name || '姓名', cx, cy - this.baselineOffset(nameSize), { sizePx: nameSize, color: '#ffffff' });
        cy -= nameBox;
        if (titleText) {
          this.drawCentered(titleText, cx, cy - this.baselineOffset(titleSize), { sizePx: titleSize, color: '#f2f4f8' });
          cy -= this.lineBox(titleSize);
        }
        if (contactsShown) {
          const line = contacts.join(bandSep);
          this.drawCentered(line, cx, cy - 3 * CSS_PX - this.baselineOffset(metaSize), { sizePx: metaSize, color: '#eef1f6' });
        }
      } else {
        this.draw(b.name || '姓名', this.left + padX, cy - this.baselineOffset(nameSize), { sizePx: nameSize, color: '#ffffff' });
        cy -= nameBox;
        if (titleText) {
          this.draw(titleText, this.left + padX, cy - this.baselineOffset(titleSize), { sizePx: titleSize, color: '#f2f4f8' });
          cy -= this.lineBox(titleSize);
        }
        if (contactsShown) {
          cy -= 3 * CSS_PX;
          const line = contacts.join(bandSep);
          const size = metaSize;
          // 太长就缩到一行装得下
          const avail = this.width - padX * 2;
          let px = size;
          while (px > size * 0.7 && this.measure(line, px) > avail) px -= 0.25;
          this.draw(line, this.left + padX, cy - this.baselineOffset(px), { sizePx: px, color: '#eef1f6' });
        }
      }
      this.y = top - bandH;
      this.space(12);
      return;
    }

    /* 其余头部样式：名字/职位 + 右侧或下方联系方式 */
    const headBodyH = nameBox + (titleText ? this.lineBox(titleSize) : 0);
    const twoSide = !center && contactsShown && cfg.align !== 'center';

    let headH;
    if (center) headH = headBodyH + (contactsShown ? contactH + 4 * CSS_PX : 0);
    else if (twoSide) headH = Math.max(headBodyH, contactH);
    else headH = headBodyH + (contactsShown ? contactH + 3 * CSS_PX : 0);

    const decoH = (cfg.style === 'rule' ? 9 * CSS_PX + 2 : cfg.style === 'center' ? 14 * CSS_PX * 2 : 2) + (cfg.style === 'center' ? 0 : 0);
    this.ensure(headH + decoH + 12);
    const top = this.y;

    if (cfg.style === 'center') {
      // 上下各一条发丝线，姓名居中
      const cx = (this.left + this.right) / 2;
      this.space(12);
      let cy = this.y;
      this.drawCentered(b.name || '姓名', cx, cy - this.baselineOffset(nameSize), { sizePx: nameSize, color: this.ink, charSpace: 0.6 });
      cy -= nameBox;
      if (titleText) {
        this.drawCentered(titleText, cx, cy - this.baselineOffset(titleSize), { sizePx: titleSize, color: this.muted });
        cy -= this.lineBox(titleSize);
      }
      if (contactsShown) {
        cy -= 2 * CSS_PX;
        const line = contacts.join('  ·  ');
        this.drawCentered(line, cx, cy - this.baselineOffset(metaSize), { sizePx: metaSize, color: this.muted });
        cy -= contactH;
      }
      cy -= 11 * CSS_PX;
      this.w.rect(this.left, cy, this.width, 0.75, { fill: '#e3e6ea' });
      this.y = cy - 12 * CSS_PX;
      return;
    }

    const nameX = cfg.align === 'right' ? this.right : this.left;
    const drawName = (text, px) => (cfg.align === 'right'
      ? this.drawRight(text, nameX, this.y - this.baselineOffset(px), { sizePx: px, color: cfg.style === 'rule' ? this.accent : this.ink })
      : this.draw(text, nameX, this.y - this.baselineOffset(px), { sizePx: px, color: cfg.style === 'rule' ? this.accent : this.ink }));
    drawName(b.name || '姓名', nameSize);
    let cy = this.y - nameBox;
    if (titleText) {
      const color = this.muted;
      if (cfg.align === 'right') this.drawRight(titleText, this.right, cy - this.baselineOffset(titleSize), { sizePx: titleSize, color });
      else this.draw(titleText, this.left, cy - this.baselineOffset(titleSize), { sizePx: titleSize, color });
    }

    if (contactsShown) {
      if (twoSide) {
        // 右下对齐，逐行堆叠
        let y = top;
        let row = [];
        const rows = [];
        const maxW = this.width * 0.54;
        let rowW = 0;
        const chipPadX = 6 * CSS_PX;
        // 非胶囊模式下每项之间要画一个 · 分隔符，排版算宽度时必须把它算进去
        const sepW = chipMode ? 0 : this.measure('·', metaSize);
        const gapX = chipMode ? 6 * CSS_PX : 7 * CSS_PX;
        for (const c of contacts) {
          const w = chipMode ? Math.min(this.measure(c, chipSize) + chipPadX * 2, maxW) : this.measure(c, metaSize);
          const add = w + (row.length ? gapX + sepW : 0);
          if (rowW + add > maxW && row.length) { rows.push({ items: row, w: rowW }); row = []; rowW = 0; }
          row.push({ text: c, w, add });
          rowW += row.length === 1 ? w : add;
        }
        if (row.length) rows.push({ items: row, w: rowW });

        const chipH = chipMode ? this.lineBox(chipSize) * 0.86 + 4 * CSS_PX : 0;
        // 胶囊比一整行要矮，垂直居中要按胶囊自身高度算，
        // 否则基线按整行算会把文字顶到页边距外面。
        const chipLh = chipMode ? chipH / (chipSize * CSS_PX) : this.lineHeight;
        for (const r of rows) {
          let cx = this.right - r.w;
          r.items.forEach((it, i) => {
            if (i > 0 && !chipMode) {
              this.draw('·', cx, y - this.baselineOffset(metaSize), { sizePx: metaSize, color: this.muted });
              cx += sepW;
            }
            if (chipMode) {
              this.w.rect(cx, y - chipH, it.w, chipH, { fill: '#f2f3f5' });
              const base = y - this.baselineOffset(chipSize, null, chipLh);
              this.draw(it.text, cx + chipPadX, base, { sizePx: chipSize, color: this.soft });
            } else {
              const base = y - this.baselineOffset(metaSize);
              this.draw(it.text, cx, base, { sizePx: metaSize, color: this.muted });
            }
            cx += it.w + (chipMode ? 6 * CSS_PX : 7 * CSS_PX);
          });
          y -= chipMode ? chipH + 3 * CSS_PX : this.lineBox(metaSize);
        }
        cy = Math.min(cy, y);
      } else {
        cy -= 3 * CSS_PX;
        const line = contacts.join('   ·   ');
        this.draw(line, this.left, cy - this.baselineOffset(metaSize), { sizePx: metaSize, color: this.muted });
        cy -= contactH;
      }
    }

    this.y = Math.min(this.y - headH, cy);
    if (cfg.style === 'rule') {
      this.w.rect(this.left, this.y - 9 * CSS_PX, this.width, 1.5, { fill: this.accent });
      this.y -= 9 * CSS_PX + 1.5;
    }
    this.space(12);
  }

  /* ---------------- 章节 =--------------- */

  /** 在右侧栏里渲染正文（标题在左）；返回消耗高度 */
  renderBody(key, profile, sec) {
    const S = this.basePx;
    this.scale = sec.scale || 1;
    this.itemLayout = sec.itemLayout || 'stack';
    const layout = this.itemLayout;
    const bulletChar = BULLET_CHAR[sec.bullet] == null ? '•' : BULLET_CHAR[sec.bullet];
    const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

    switch (key) {
      case 'summary': {
        const s = (profile.basics || {}).summary;
        if (!s) return;
        const lines = this.wrap(s, this.width, S * this.scale);
        lines.forEach((ln) => {
          const box = this.lineBox(S * this.scale);
          this.ensure(box);
          const align = sec.align || 'left';
          const base = this.y - this.baselineOffset(S * this.scale);
          if (align === 'center') this.drawCentered(ln, (this.left + this.right) / 2, base, { sizePx: S * this.scale, color: this.ink });
          else if (align === 'right') this.drawRight(ln, this.right, base, { sizePx: S * this.scale, color: this.ink });
          else this.draw(ln, this.left, base, { sizePx: S * this.scale, color: this.ink });
          this.y -= box;
        });
        return;
      }
      case 'skills': {
        if (!nonEmpty(profile.skills)) return;
        // 标签形态在 HTML 里是一排独立小标签，条目之间没有分隔符；
        // 纸面上画不了圆角小标签，就用空格分开，保持两端用字一致。
        const sep = sec.skills === 'tags' ? '   ' : '、';
        const rows = profile.skills.map((s) => ({
          cat: s.category || '技能',
          items: (s.items || []).filter(Boolean).join(sep),
        })).filter((r) => r.items || r.cat !== '技能');
        if (!rows.length) return;
        const catSize = S * this.scale;
        const metaSize = this.m.meta;
        const catMin = S * 5.4 * CSS_PX;
        const catW = Math.min(catMin + 10 * CSS_PX, Math.max(catMin, ...rows.map((r) => this.measure(r.cat, metaSize) + 9 * CSS_PX)));
        for (const r of rows) {
          const box = this.lineBox(catSize);
          const lines = this.wrap(r.items, this.width - catW, catSize);
          let first = true;
          for (const ln of lines) {
            this.ensure(box);
            const base = this.y - this.baselineOffset(catSize);
            if (first) this.draw(r.cat, this.left, base, { sizePx: metaSize, color: this.accent });
            this.draw(ln, this.left + catW, base, { sizePx: catSize, color: this.soft });
            this.y -= box;
            first = false;
          }
          this.y -= this.m.bulletGap + 1 * CSS_PX;
        }
        return;
      }
      case 'work': {
        if (!nonEmpty(profile.work)) return;
        profile.work.forEach((j, idx) => {
          if (idx > 0) this.space(this.m.itemGap * (layout === 'card' ? 0.9 : 1));
          const right = [range(j.start, j.end), j.location].filter(Boolean).join('    ');
          this.itemStart();
          this.twoColumn(j.company || '', j.position || '', right, { layout });
          for (const bl of j.bullets || []) if (String(bl).trim()) this.bullet(bl, { bulletChar });
          this.itemEnd();
        });
        return;
      }
      case 'projects': {
        if (!nonEmpty(profile.projects)) return;
        profile.projects.forEach((p, idx) => {
          if (idx > 0) this.space(this.m.itemGap * (layout === 'card' ? 0.9 : 1));
          this.itemStart();
          this.twoColumn(p.name || '', p.role || '', range(p.start, p.end), { layout });
          if (p.org) this.paragraph(p.org, { sizePx: this.m.role, color: this.soft });
          if (nonEmpty(p.tech)) this.paragraph(`技术栈：${p.tech.join('、')}`, { sizePx: this.m.meta, color: this.muted });
          for (const bl of p.bullets || []) if (String(bl).trim()) this.bullet(bl, { bulletChar });
          this.itemEnd();
        });
        return;
      }
      case 'education': {
        if (!nonEmpty(profile.education)) return;
        profile.education.forEach((e, idx) => {
          if (idx > 0) this.space(this.m.itemGap * (layout === 'card' ? 0.9 : 1));
          const role = [e.major, e.degree].filter(Boolean).join(' · ');
          const right = [range(e.start, e.end), e.gpa ? `GPA ${e.gpa}` : ''].filter(Boolean).join('    ');
          this.itemStart();
          this.twoColumn(e.school || '', role, right, { layout });
          for (const bl of e.bullets || []) if (String(bl).trim()) this.bullet(bl, { bulletChar });
          this.itemEnd();
        });
        return;
      }
      case 'awards':
      case 'certificates': {
        const arr = key === 'awards' ? profile.awards : profile.certificates;
        if (!nonEmpty(arr)) return;
        for (const x of arr) {
          const line = [x.title, x.date, x.detail].filter(Boolean).join(' · ');
          if (line) this.bullet(line, { bulletChar });
        }
        return;
      }
      case 'custom': {
        const items = (profile.customItems || []);
        for (const it of items) this.bullet(it, { bulletChar });
        return;
      }
      default:
    }
  }

  /**
   * 排一个章节：处理标题位置（上方 / 左侧）、时间线、缩进与间距。
   */
  section(key, title, profile, sec) {
    if (sec.gapBefore) this.space(sec.gapBefore);

    const placement = sec.placement;
    const leftTitle = placement === 'left';

    if (leftTitle) {
      const bodyLeft = this.left + this.labelW;
      const bodyWidth = this.right - bodyLeft;
      if (bodyWidth < 30) {
        // 栏太窄就退回标题在上方
        this.sectionTitle(sec, title);
        this.renderBody(key, profile, sec);
        this.space(this.gap);
        return;
      }
      const topY = this.y;
      const saved = { left: this.left, right: this.right, width: this.width };
      // 标题列
      this.draw(title, this.left, topY - this.baselineOffset(this.m.sectionTitle), { sizePx: this.m.sectionTitle, color: this.accent });
      // 正文列
      this.left = bodyLeft;
      this.width = bodyWidth;
      if (sec.timeline) {
        this.tl = { x: bodyLeft - 10 * CSS_PX, dots: [] };
        this.left = bodyLeft + 13 * CSS_PX;
        this.width = bodyWidth - 13 * CSS_PX;
      }
      this.renderBody(key, profile, sec);
      const usedY = this.y;
      if (this.tl) {
        this.w.rect(this.tl.x, topY - 4, 1.2, topY - usedY - 6, { fill: '#e2e5e9' });
        for (const dy of this.tl.dots) this.w.rect(this.tl.x - 2.4, dy - 2.2, 6, 6, { fill: this.accent });
        this.tl = null;
      }
      this.left = saved.left;
      this.right = saved.right;
      this.width = saved.width;
      this.y = Math.min(usedY, topY - this.lineBox(this.m.sectionTitle));
      this.space(this.gap);
      return;
    }

    this.sectionTitle(sec, title);
    if (sec.timeline) {
      const topY = this.y;
      const saved = { left: this.left, width: this.width };
      this.tl = { x: this.left + 2.6, dots: [] };
      this.left = saved.left + 13 * CSS_PX;
      this.width = saved.width - 13 * CSS_PX;
      this.renderBody(key, profile, sec);
      const usedY = this.y;
      this.w.rect(this.tl.x, topY - 7, 1.2, topY - usedY - 6, { fill: '#e2e5e9' });
      for (const dy of this.tl.dots) {
        this.w.rect(this.tl.x - 2.4, dy - 2.2, 6, 6, { fill: this.accent });
      }
      this.tl = null;
      this.left = saved.left;
      this.width = saved.width;
      this.y = usedY;
      this.space(this.gap);
      return;
    }

    this.renderBody(key, profile, sec);
    this.space(this.gap);
  }
}

function range(s, e) {
  const a = String(s || '').trim();
  const z = String(e || '').trim();
  if (!a && !z) return '';
  if (!a) return z;
  if (!z) return a;
  return `${a} – ${z}`;
}

/**
 * 把简历数据排成 PDF。
 * @param {object} profile 归一化后的简历
 * @param {object} opts 导出设置（交给 themes.resolve 解析）
 * @returns {Buffer}
 */
function renderResumePDF(profile, opts = {}, fonts, extras = {}) {
  const b = profile.basics || {};
  const cfg = themes.resolve(opts);
  const writer = new PDFWriter({
    size: cfg.page.size,
    meta: {
      title: opts.docTitle || (b.name ? `${b.name} - 简历` : '简历'),
      author: b.name || '',
      subject: b.title || '',
    },
  });
  writer.addFont('zh', fonts.zh.file, fonts.zh.faceIndex || 0);
  writer.addFont('latin', fonts.latin.file, fonts.latin.faceIndex || 0);
  writer.newPage();

  const L = new Layout(writer, cfg);

  /* ---- 头部 ---- */
  if (cfg.header.visible) L.header(b);

  /* ---- 各章节按顺序 ---- */
  for (const sec of cfg.sections) {
    if (!sec.visible) continue;
    if (sec.key === 'customSections') {
      const list = profile.customSections || [];
      for (const cs of list) {
        if (!cs) continue;
        const items = (cs.items || []).map((x) => String(x || '').trim()).filter(Boolean);
        if (!cs.title && !items.length) continue;
        if (!items.length) continue;
        // 标题用这一条自定义板块自己的标题，而不是章节配置里的统一标题
        L.section('custom', cs.title || '其他', { customItems: items }, sec);
      }
      continue;
    }
    // 有内容才排，避免只剩一个空标题
    if (!hasContent(sec.key, profile)) continue;
    L.section(sec.key, sec.title, profile, sec);
  }

  /* ---- 装饰：水印与页码（全文档统一处理） ---- */
  if (extras.watermark) {
    const text = String(extras.watermark);
    const sizePx = 62;
    const fontPx = sizePx * CSS_PX;
    const tracking = 6 * CSS_PX;
    const textW = L.measure(text, sizePx) + tracking * [...text].length;
    const angle = (-26 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // 半透明效果用浅灰近似（等价于 rgba(120,130,145,0.13) 叠在白纸上）
    const watermarkColor = '#edeff2';
    for (const page of writer.pages) {
      const cx = writer.size[0] / 2;
      const cy = writer.size[1] / 2;
      let travelled = -textW / 2;
      for (const seg of L.segments(text)) {
        const segW = L.measure(seg.text, sizePx) + tracking * [...seg.text].length;
        writer.text(cx + cos * travelled, cy + sin * travelled, seg.text, {
          font: seg.key, size: fontPx, color: watermarkColor, charSpace: tracking, rotate: -26,
        });
        travelled += segW;
      }
    }
  }

  if (cfg.decor.pageNumbers && extras.total) {
    const sizePx = 9;
    writer.pages.forEach((page, i) => {
      const label = `${i + 1} / ${extras.total}`;
      const w = L.measure(label, sizePx);
      writer.text((writer.size[0] - w) / 2, L.margin.bottom * 0.45, label, {
        font: L.primary, size: sizePx * CSS_PX, color: L.muted,
      });
    });
  }

  return writer.toBuffer();
}

function hasContent(key, profile) {
  const nonEmpty = (a) => Array.isArray(a) && a.length > 0;
  switch (key) {
    case 'summary': return !!((profile.basics || {}).summary);
    case 'skills': return nonEmpty(profile.skills);
    case 'work': return nonEmpty(profile.work);
    case 'projects': return nonEmpty(profile.projects);
    case 'education': return nonEmpty(profile.education);
    case 'awards': return nonEmpty(profile.awards);
    case 'certificates': return nonEmpty(profile.certificates);
    default: return false;
  }
}

module.exports = { renderResumePDF, Layout, parseMargin, CSS_PX, blend, hexToRgb, rgbToHex };
