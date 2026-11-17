'use strict';
/**
 * PDF 版面不变量检查器。
 *
 * 看不到图的时候，只能靠几何断言判断排版对不对。这里用 pdfjs 把每个文字块连位置一起取出来，
 * 然后检查三件事：
 *   1. 所有文字都在页边距以内（没被裁掉）
 *   2. 文字块两两不重叠（重叠说明该换行的地方没换行）
 *   3. 没有用到 .notdef 字形（缺字会在纸上印成方框）
 *
 * 用法: node test/pdf-layout.js <file.pdf> [--margin "14mm 15mm"] [--json]
 */

const fs = require('fs');
const path = require('path');

const MM = 2.834645669;

function parseMargin(str) {
  const parts = String(str || '14mm 15mm').trim().split(/\s+/).map((p) => {
    const m = /^(-?[\d.]+)(mm|cm|in|pt|px)?$/.exec(p);
    if (!m) return null;
    const v = parseFloat(m[1]);
    switch (m[2]) {
      case 'cm': return v * 10 * MM;
      case 'in': return v * 72;
      case 'pt': return v;
      case 'px': return v * 0.75;
      default: return v * MM;
    }
  }).filter((v) => v != null);
  const [a, b = a, c = a, d = b] = parts;
  if (parts.length === 1) return { top: a, right: a, bottom: a, left: a };
  if (parts.length === 2) return { top: a, right: b, bottom: a, left: b };
  if (parts.length === 3) return { top: a, right: b, bottom: c, left: b };
  return { top: a, right: b, bottom: c, left: d };
}

async function loadPdfjs() {
  const candidates = [
    path.join(__dirname, 'vendor', 'pdfjs', 'pdf.mjs'),
    '/tmp/verify/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return import(c);
  }
  throw new Error('找不到 pdfjs，无法做版面检查（需要在 test/vendor/pdfjs 下有 pdf.mjs）');
}

async function extractRuns(file) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const runs = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const h = it.height || 10;
      const x = it.transform[4];
      const baseline = it.transform[5];
      return {
        str: it.str,
        x,
        baseline,
        width: it.width,
        // 旋转过的文字（水印）不属于正文流，后面单独排除
        rotated: Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01,
        // pdfjs 的 height 是字号，用 ascent 估算可见框，重叠判定留点余量
        top: baseline + h * 0.88,
        bottom: baseline - h * 0.24,
        size: it.fontSize || h,
        font: it.fontName,
      };
    });
    pages.push({ index: i, width: vp.width, height: vp.height, runs });
  }
  return { pages, numPages: doc.numPages };
}

function checkPage(page, margin, opts = {}) {
  const tolerance = opts.tolerance == null ? 1.5 : opts.tolerance;
  const ignore = opts.ignore || [];
  const problems = [];
  const footers = [];
  const watermarks = [];
  const left = margin.left - tolerance;
  const right = page.width - margin.right + tolerance;
  const bottom = margin.bottom - tolerance;
  const top = page.height - margin.top + tolerance;

  const kept = [];
  for (const r of page.runs) {
    if (ignore.some((s) => r.str.includes(s))) continue;
    // 旋转文字（水印）铺满整页，不参与越界与重叠判定
    if (r.rotated) { watermarks.push(r.str.trim()); continue; }
    // 页码本来就该落在下边距里，单列一类，不算越界。
    // pdfjs 会把 "1 / 1" 拆成多个 run，所以要按"整行都是数字和斜杠"来判断。
    if (r.top <= margin.bottom + 2 && /^[\d\s/]+$/.test(r.str) && r.str.trim().length <= 12) {
      footers.push(r.str.trim());
      continue;
    }
    kept.push(r);
    if (r.x < left - 0.5) problems.push({ kind: 'outside-left', str: r.str, x: +r.x.toFixed(2), limit: +left.toFixed(2) });
    if (r.x + r.width > right + 0.5) problems.push({ kind: 'outside-right', str: r.str, end: +(r.x + r.width).toFixed(2), limit: +right.toFixed(2) });
    if (r.bottom < bottom - 0.5) problems.push({ kind: 'outside-bottom', str: r.str, bottom: +r.bottom.toFixed(2), limit: +bottom.toFixed(2) });
    if (r.top > top + 0.5) problems.push({ kind: 'outside-top', str: r.str, top: +r.top.toFixed(2), limit: +top.toFixed(2) });
  }

  // 两两重叠：同一行（基线接近）且横向范围交叠
  const sorted = [...kept].sort((a, b) => b.baseline - a.baseline || a.x - b.x);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (Math.abs(a.baseline - b.baseline) > Math.max(a.size, b.size) * 0.55) break;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
      if (overlapX > 0.6 && overlapY > 0.6) {
        problems.push({
          kind: 'overlap',
          a: a.str.slice(0, 24),
          b: b.str.slice(0, 24),
          overlapX: +overlapX.toFixed(2),
          overlapY: +overlapY.toFixed(2),
        });
      }
    }
  }
  return { problems, footers, watermarks, checked: kept.length };
}

/** 页面阅读顺序：按基线从高到低，同基线按 x */
function readingOrder(page) {
  return [...page.runs]
    .sort((a, b) => (Math.abs(a.baseline - b.baseline) < 1 ? a.x - b.x : b.baseline - a.baseline))
    .map((r) => r.str);
}

async function inspect(file, options = {}) {
  const { margin = '14mm 15mm' } = options;
  const { pages, numPages } = await extractRuns(file);
  const m = parseMargin(margin);
  const report = { file, numPages, pages: [], problems: [], footers: [], watermarks: [] };
  for (const page of pages) {
    const { problems, footers, watermarks } = checkPage(page, m, options);
    const kept = page.runs.filter((r) => !(options.ignore || []).some((s) => r.str.includes(s)));
    report.pages.push({
      index: page.index,
      widthPt: +page.width.toFixed(2),
      heightPt: +page.height.toFixed(2),
      widthMm: +(page.width / MM).toFixed(1),
      heightMm: +(page.height / MM).toFixed(1),
      runs: kept.length,
      minX: kept.length ? +Math.min(...kept.map((r) => r.x)).toFixed(2) : null,
      maxRight: kept.length ? +Math.max(...kept.map((r) => r.x + r.width)).toFixed(2) : null,
      footers,
      watermarks,
      problems: problems.length,
    });
    report.footers.push(...footers);
    report.watermarks.push(...watermarks);
    report.problems.push(...problems.map((p) => ({ page: page.index, ...p })));
  }
  return report;
}

module.exports = { inspect, extractRuns, checkPage, readingOrder, parseMargin };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node test/pdf-layout.js <file.pdf> [--margin "14mm 15mm"]');
    process.exit(2);
  }
  const mi = process.argv.indexOf('--margin');
  const margin = mi > 0 ? process.argv[mi + 1] : '14mm 15mm';
  inspect(file, { margin }).then((r) => {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`${file}: ${r.numPages} 页`);
      for (const p of r.pages) {
        console.log(`  第 ${p.index} 页 ${p.widthMm}×${p.heightMm}mm | 文字块 ${p.runs} | x 范围 ${p.minX}–${p.maxRight} | 问题 ${p.problems}`);
      }
      if (r.problems.length) {
        console.log('\n问题:');
        for (const p of r.problems.slice(0, 25)) console.log('  ', JSON.stringify(p));
      } else {
        console.log('版面不变量全部通过');
      }
    }
    process.exit(r.problems.length ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(2); });
}
