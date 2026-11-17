'use strict';

/**
 * PDF 渲染入口。
 *
 * 默认走纯 JS 引擎（lib/pdf/*），不依赖浏览器：直接拼 PDF 字节，
 * 字体自己子集化内嵌。只有在找不到可用字体、或显式要求 CHROME 时才回落到无头 Chrome。
 *
 * 两种引擎接受同一套 opts，同一份数据排出来的文字内容一致。
 */

const fs = require('fs');
const path = require('path');
const { renderResumePDF } = require('./resume');

const FONT_CANDIDATES = {
  zh: [
    { file: '/data/dsh/tools/headless/fonts/root/fonts-wqy-zenhei/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', faceIndex: 0 },
    { file: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', faceIndex: 0 },
    { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', faceIndex: 0 },
    { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', faceIndex: 0 },
  ],
  latin: [
    { file: '/data/dsh/tools/headless/fonts/root/fonts-dejavu-core/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
    { file: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
  ],
};

function firstExisting(list) {
  for (const c of list) if (c && c.file && fs.existsSync(c.file)) return c;
  return null;
}

/**
 * 找字体。可用环境变量覆盖：
 *   PDF_FONT_ZH=/path/font.ttc  PDF_FONT_ZH_FACE=0  PDF_FONT_LATIN=/path/font.ttf
 */
function resolveFonts() {
  const zh = process.env.PDF_FONT_ZH && fs.existsSync(process.env.PDF_FONT_ZH)
    ? { file: process.env.PDF_FONT_ZH, faceIndex: Number(process.env.PDF_FONT_ZH_FACE || 0) }
    : firstExisting(FONT_CANDIDATES.zh);
  const latin = process.env.PDF_FONT_LATIN && fs.existsSync(process.env.PDF_FONT_LATIN)
    ? { file: process.env.PDF_FONT_LATIN, faceIndex: 0 }
    : firstExisting(FONT_CANDIDATES.latin) || zh;
  if (!zh) {
    const hint = process.env.PDF_FONT_ZH
      ? `（环境变量 PDF_FONT_ZH 指向的 ${process.env.PDF_FONT_ZH} 不存在）`
      : '';
    const err = new Error(
      `找不到可用的中文字体${hint}，无法用内置引擎生成 PDF。`
      + '请设置环境变量 PDF_FONT_ZH 指向一个 TrueType/TTC 字体（如 wqy-zenhei.ttc）。',
    );
    err.code = 'NO_FONT';
    throw err;
  }
  return { zh, latin };
}

/** 内置引擎是否可用（不改动任何状态） */
function available() {
  try {
    const fonts = resolveFonts();
    return { ok: true, fonts };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 生成 PDF。
 * @param {object} profile 归一化后的简历
 * @param {object} opts 导出设置
 * @param {object} [cfg] { engine: 'builtin'|'chrome' }
 * @returns {Promise<Buffer>}
 */
async function renderPDF(profile, opts = {}, cfg = {}) {
  // 引擎可以写在第三参（内部调用），也可以写在导出设置里（HTTP 接口只方便传一层）
  const asked = cfg.engine || opts.engine || process.env.PDF_ENGINE || '';
  const engine = asked || 'builtin';
  if (engine === 'chrome') return require('./chrome').renderPDF(profile, opts);

  // 自定义 CSS 只有浏览器会解释，内置引擎读不懂选择器。
  // 与其悄悄忽略用户的样式，不如换到浏览器引擎把它真正应用上。
  // 但调用方**显式**要求 builtin 时就照办，别自作主张。
  const custom = customCSSOf(opts);
  if (custom && asked !== 'builtin') {
    const chrome = require('./chrome').available();
    if (chrome.ok) return require('./chrome').renderPDF(profile, opts);
  }

  let fonts;
  try {
    fonts = resolveFonts();
  } catch (err) {
    // 没有可用字体时退回浏览器引擎：装得上 Chrome 的机器通常也有系统字体
    if (err.code === 'NO_FONT') {
      const chrome = require('./chrome').available();
      if (chrome.ok) return require('./chrome').renderPDF(profile, opts);
    }
    throw err;
  }
  const extras = {
    watermark: opts.showWatermark && opts.watermarkText ? opts.watermarkText : null,
    pageNumbers: !!opts.showPageNumbers,
  };

  // 页码要写"第 n / 共 m 页"，得先知道总页数。
  // 排版是纯计算，多排一遍只花几毫秒，比事后改 PDF 简单得多。
  if (extras.pageNumbers || extras.watermark) {
    const first = renderResumePDF(profile, opts, fonts, {
      watermark: extras.watermark,
      pageNumbers: null,
    });
    extras.total = countPages(first);
    if (!extras.pageNumbers) return first;
  }
  return renderResumePDF(profile, opts, fonts, extras);
}

function countPages(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Count\s+(\d+)/);
  return m ? Number(m[1]) : 1;
}

/** 导出设置里有没有自定义 CSS（字符串里只有空白也算没有） */
function customCSSOf(opts) {
  const layout = opts && opts.layout && typeof opts.layout === 'object' ? opts.layout : null;
  const raw = (layout && typeof layout.customCSS === 'string' && layout.customCSS)
    || (typeof opts.customCSS === 'string' && opts.customCSS)
    || '';
  return String(raw).trim() ? raw : '';
}

module.exports = { renderPDF, available, resolveFonts, countPages, customCSSOf };
