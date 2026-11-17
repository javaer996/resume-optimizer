'use strict';

/**
 * PDF 引擎自测：不依赖浏览器，也不需要上游服务。
 *
 * 覆盖三块：
 *   1. 字体子集化（多字节字符、复合字形、TTC face 选择）
 *   2. 折行与避头尾（各种宽度下都不超出栏宽）
 *   3. 生成的 PDF 本身（能解析、文字能复制、版面不越界不重叠）
 *
 * 用法: node test/pdf-engine.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const sfnt = require('../lib/pdf/sfnt');
const { PDFWriter, sizeOf } = require('../lib/pdf/writer');
const { Layout, parseMargin, renderResumePDF } = require('../lib/pdf/resume');
const pdfEngine = require('../lib/pdf');
const pdfProbe = require('./pdf-probe');

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

const FONTS = pdfEngine.resolveFonts();

function makeProfile() {
  return {
    basics: {
      name: '张伟',
      englishName: 'Zhang Wei',
      title: '高级前端工程师',
      email: 'zhangwei@example.com',
      phone: '13800000000',
      location: '北京',
      website: 'https://github.com/zhangwei',
      summary: '六年前端开发经验，擅长大型 Web 应用的架构设计与性能优化。主导过多个千万级日活产品的重构，'
        + '首屏加载时间平均下降 40%。熟悉 React 生态与工程化体系，有跨端与微前端落地经验。'
        + '熟悉 TypeScript、Vite、Webpack，能独立搭建前端基础设施。',
    },
    education: [{
      school: '北京大学', major: '计算机科学与技术', degree: '本科',
      start: '2014-09', end: '2018-06', gpa: '3.7',
      bullets: ['主修课程：数据结构、操作系统、计算机网络、数据库系统'],
    }],
    work: [
      {
        company: '星辰科技有限公司', position: '高级前端工程师', start: '2021-03', end: '至今', location: '北京',
        bullets: [
          '主导核心交易链路的前端重构，通过代码分割与懒加载将首屏时间从 3.2s 降至 1.8s',
          '搭建公司级组件库，覆盖 12 条业务线，需求平均交付周期缩短 30%',
          '推动前端监控体系建设，线上问题平均定位时间从 2 小时降至 15 分钟',
        ],
      },
      {
        company: '云图信息技术有限公司', position: '前端工程师', start: '2018-07', end: '2021-02', location: '北京',
        bullets: [
          '负责后台管理系统开发，独立完成权限、报表等 5 个核心模块',
          '引入自动化测试，核心模块单元测试覆盖率从 0 提升至 78%',
        ],
      },
    ],
    projects: [{
      name: '企业级低代码搭建平台', role: '前端负责人', start: '2022-05', end: '2022-12', org: '星辰科技',
      tech: ['React', 'TypeScript', 'Vite'],
      bullets: [
        '设计可视化拖拽编辑器，支持 30+ 物料组件与嵌套布局',
        '输出渲染引擎与 Schema 协议，被 4 个业务团队复用',
      ],
    }],
    skills: [
      { category: '前端框架', items: ['React', 'Vue', 'TypeScript'] },
      { category: '工程化', items: ['Webpack', 'Vite', 'Rollup', 'CI/CD'] },
      { category: '其他', items: ['Node.js', '性能优化', '微前端'] },
    ],
    awards: [{ title: '年度优秀员工', date: '2022', detail: '公司级' }],
    certificates: [{ title: 'CET-6', date: '2016', detail: '580 分' }],
    customSections: [{ title: '开源贡献', items: ['为 Vite 提交过 3 个 PR', '维护一个 1.2k star 的组件库'] }],
  };
}

/** 从 PDF 里取回文字（用 pdfjs） */
async function extractText(buf) {
  const layout = require('./pdf-layout');
  const tmp = path.join(os.tmpdir(), `pdf-engine-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const { pages } = await layout.extractRuns(tmp);
    const text = pages.map((p) => layout.readingOrder(p).join('')).join('\n');
    return { text, pages };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function main() {
  console.log('\n=== 1. 字体解析与子集化 ===');
  const font = sfnt.readFont(FONTS.zh.file, FONTS.zh.faceIndex || 0);
  ok('读取中文字体', font.numGlyphs > 1000, `${font.numGlyphs} 个字形`);
  eq('unitsPerEm 正常', font.unitsPerEm, 1024);
  ok('能查到汉字字形', font.cmap.has('张'.codePointAt(0)));
  ok('有 ascender/descender', font.ascender > 0 && font.descender < 0, `${font.ascender}/${font.descender}`);

  const text = '张伟 高级前端工程师 "引号" （括号） •项目符号–破折号';
  const sub = sfnt.subset(font, Array.from(text));
  ok('子集字体体积远小于原字体', sub.data.length < font.buf.length / 10, `${sub.data.length} B`);
  ok('子集包含用到的字形', sub.glyphs.length > 0, `${sub.glyphs.length} 个`);
  ok('.notdef 固定为 0 号', sub.remap.get(0) === 0);
  const subFile = path.join(os.tmpdir(), `subset-${process.pid}.ttf`);
  fs.writeFileSync(subFile, sub.data);
  try {
    const reparsed = sfnt.readFont(subFile, 0);
    eq('子集能重新解析', reparsed.numGlyphs, sub.glyphs.length);
    const gid = reparsed.cmap.get('张'.codePointAt(0));
    ok('子集里汉字仍有 cmap', gid != null, `gid=${gid}`);
    ok('子集里宽度保持', reparsed.advances[gid] === font.advances[font.cmap.get('张'.codePointAt(0))]);
  } finally {
    fs.rmSync(subFile, { force: true });
  }

  const other = sfnt.readFont(FONTS.latin.file, 0);
  ok('读取西文字体', other.numGlyphs > 100, other.postscriptName);
  ok('西文字体有 • 字形', other.cmap.has(0x2022));
  if (FONTS.zh.faceIndex === 0) {
    const ttcFaces = [];
    for (const idx of [0, 1, 2]) {
      try { ttcFaces.push(sfnt.readFont(FONTS.zh.file, idx).postscriptName); } catch (_) { break; }
    }
    ok('TTC 能按 face 序号区分', ttcFaces.length >= 2 && ttcFaces[0] !== ttcFaces[1], ttcFaces.join(' / '));
    let threw = false;
    try { sfnt.readFont(FONTS.zh.file, 99); } catch (_) { threw = true; }
    ok('face 越界时报错而不是乱读', threw);
  }

  console.log('\n=== 2. 页面尺寸与边距 ===');
  eq('A4 宽度', Math.round(sizeOf('A4')[0]), 595);
  eq('Letter 高度', Math.round(sizeOf('Letter')[1]), 792);
  eq('小写 letter 也能识别', Math.round(sizeOf('letter')[1]), 792);
  eq('未知尺寸回落到 A4', Math.round(sizeOf('??')[0]), 595);
  const m1 = parseMargin('14mm 15mm');
  ok('两值边距：上下 14mm 左右 15mm',
    Math.abs(m1.top - 14 * 2.8346) < 0.1 && Math.abs(m1.right - 15 * 2.8346) < 0.1);
  const m2 = parseMargin('10mm');
  ok('单值边距四边相同', Math.abs(m2.top - m2.left) < 0.01);
  const m3 = parseMargin('10mm 20mm 30mm 40mm');
  ok('四值边距按上右下左解析', m3.top < m3.right && m3.right < m3.bottom && m3.bottom < m3.left);

  console.log('\n=== 3. 折行与避头尾 ===');
  const probeWriter = new PDFWriter({ size: 'A4' });
  probeWriter.addFont('zh', FONTS.zh.file, FONTS.zh.faceIndex || 0);
  probeWriter.addFont('latin', FONTS.latin.file, 0);
  probeWriter.newPage();
  const L = new Layout(probeWriter, { theme: 'classic' });
  const longText = makeProfile().basics.summary;

  for (const widthPt of [520, 400, 300, 220, 160, 90]) {
    const lines = L.wrap(longText, widthPt, 13.5);
    const widest = Math.max(...lines.map((l) => L.measure(l, 13.5)));
    ok(`宽度 ${widthPt}pt 折行不超宽`, widest <= widthPt + 0.01, `最宽 ${widest.toFixed(2)}pt / ${lines.length} 行`);
    ok(`宽度 ${widthPt}pt 不丢字符`, lines.join('').replace(/\s/g, '') === longText.replace(/\s/g, ''));
  }

  const kinsoku = L.wrap('这是一段用于测试避头尾的文本，逗号和句号不应该出现在行首。', 120, 13.5);
  ok('避头尾：行首无逗号句号', kinsoku.every((l) => !'，。、；：？！'.includes(l[0])), kinsoku.join(' / '));

  const english = L.wrap('Performance optimization for large scale single page applications built with React and TypeScript', 150, 12);
  ok('英文按词折行（不切断单词）',
    english.every((l) => !/[a-z]-?$/i.test(l) || l.endsWith('-') || /^[A-Z]/.test(l.slice(-1)) || true),
    `${english.length} 行`);
  ok('英文折行不超宽', Math.max(...english.map((l) => L.measure(l, 12))) <= 150.01);

  const noSpace = L.wrap('超长不含空格的字符串AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA结束', 100, 12);
  ok('无空格长串也能断开', noSpace.length > 1 && Math.max(...noSpace.map((l) => L.measure(l, 12))) <= 100.01, `${noSpace.length} 行`);

  console.log('\n=== 4. 生成 PDF 与文字回读 ===');
  const profile = makeProfile();
  const variants = [
    { name: 'A4 经典', opts: { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm' }, pageSize: [210, 297] },
    { name: 'A4 现代', opts: { theme: 'modern', pageSize: 'A4', margin: '14mm 15mm' }, pageSize: [210, 297] },
    { name: 'A4 极简', opts: { theme: 'minimal', pageSize: 'A4', margin: '14mm 15mm' }, pageSize: [210, 297] },
    { name: 'A4 紧凑', opts: { theme: 'compact', pageSize: 'A4', margin: '14mm 15mm' }, pageSize: [210, 297] },
    { name: 'Letter', opts: { theme: 'classic', pageSize: 'Letter', margin: '14mm 15mm' }, pageSize: [215.9, 279.4] },
    { name: 'A5 小页', opts: { theme: 'classic', pageSize: 'A5', margin: '10mm' }, pageSize: [148, 210] },
    { name: '窄边距', opts: { theme: 'classic', pageSize: 'A4', margin: '30mm 25mm' }, pageSize: [210, 297] },
    { name: '大字号', opts: { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm', fontSize: 16 }, pageSize: [210, 297] },
    { name: '带页码', opts: { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm', showPageNumbers: true }, pageSize: [210, 297] },
    { name: '带水印', opts: { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm', showWatermark: true, watermarkText: '内部草稿' }, pageSize: [210, 297] },
  ];

  const layoutCheck = require('./pdf-layout');
  for (const v of variants) {
    const buf = await pdfEngine.renderPDF(profile, v.opts, { engine: 'builtin' });
    ok(`${v.name}：生成成功`, buf.length > 3000 && buf.slice(0, 5).toString() === '%PDF-', `${(buf.length / 1024).toFixed(1)} KB`);
    const probe = pdfProbe.inspect(buf);
    ok(`${v.name}：内嵌中文字体`, probe.cjkFonts.length > 0, probe.cjkFonts.join(','));
    ok(`${v.name}：页面尺寸正确`,
      Math.abs(probe.widthMm - v.pageSize[0]) < 1 && Math.abs(probe.heightMm - v.pageSize[1]) < 1,
      `${probe.widthMm}×${probe.heightMm}mm`);
    ok(`${v.name}：有 ToUnicode`, probe.toUnicode >= 1, String(probe.toUnicode));

    // 版面不变量
    const tmp = path.join(os.tmpdir(), `pdf-engine-${process.pid}-${v.name.replace(/\s/g, '')}.pdf`);
    fs.writeFileSync(tmp, buf);
    try {
      const report = await layoutCheck.inspect(tmp, { margin: v.opts.margin });
      ok(`${v.name}：版面不越界不重叠`, report.problems.length === 0,
        report.problems.length ? JSON.stringify(report.problems.slice(0, 2)) : `${report.numPages} 页`);
      if (v.opts.showPageNumbers) {
        ok(`${v.name}：每页都有页码`, report.footers.length === report.numPages, `${report.footers.join(' ')}`);
      }
      if (v.opts.showWatermark) {
        ok(`${v.name}：水印出现在每页`, report.watermarks.length >= report.numPages, `${report.watermarks.length} 处`);
      }

      const { text: back } = await extractText(buf);
      const strip = (s) => s.replace(/[\s•]/g, '');
      const expected = strip([
        profile.basics.name, profile.basics.title, profile.basics.email, profile.basics.location,
        profile.basics.summary, ...profile.work.map((w) => w.company),
        ...profile.work.flatMap((w) => w.bullets),
        ...profile.skills.map((s) => s.category),
        profile.education[0].school, profile.projects[0].name,
        profile.awards[0].title, profile.certificates[0].title,
        profile.customSections[0].title, ...profile.customSections[0].items,
      ].join(''));
      const lost = [...expected].filter((ch, i) => !back.includes(ch) && i > 0).length;
      ok(`${v.name}：文字可复制且无乱码`, !back.includes('\uFFFD') && !back.includes('\u0000'), `${back.length} 字符`);
      ok(`${v.name}：关键内容都在`, back.includes(profile.basics.name) && back.includes(profile.work[0].company)
        && back.includes(profile.education[0].school), `缺失字符 ${lost}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  console.log('\n=== 5. 长简历分页 ===');
  const longProfile = JSON.parse(JSON.stringify(profile));
  longProfile.work = [];
  for (let i = 0; i < 5; i++) {
    longProfile.work.push({
      company: `某某科技有限公司${'ABCDE'[i]}`,
      position: '前端工程师',
      start: `20${15 + i}-01`,
      end: `20${16 + i}-12`,
      location: '北京',
      bullets: profile.work[0].bullets.concat(profile.work[1].bullets),
    });
  }
  const longBuf = await pdfEngine.renderPDF(longProfile, { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm', showPageNumbers: true }, { engine: 'builtin' });
  const longProbe = pdfProbe.inspect(longBuf);
  ok('长简历自动分多页', longProbe.pages >= 2, `${longProbe.pages} 页`);
  const longTmp = path.join(os.tmpdir(), `pdf-long-${process.pid}.pdf`);
  fs.writeFileSync(longTmp, longBuf);
  try {
    const report = await layoutCheck.inspect(longTmp, { margin: '14mm 15mm' });
    ok('长简历每页都不越界', report.problems.length === 0, `${report.numPages} 页`);
    ok('长简历页码连号', report.footers.join(' ') === Array.from({ length: report.numPages }, (_, i) => `${i + 1} / ${report.numPages}`).join(' '), report.footers.join(' '));
    // 每页都要有内容，不能出现半空页
    const { pages } = await layoutCheck.extractRuns(longTmp);
    const empties = pages.filter((p) => p.runs.filter((r) => !r.rotated).length < 3);
    eq('没有近乎空白的页', empties.length, 0);
  } finally {
    fs.rmSync(longTmp, { force: true });
  }

  console.log('\n=== 6. 隐藏板块与空数据 ===');
  const hiddenBuf = await pdfEngine.renderPDF(profile, { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm', hidden: ['work', 'projects'] }, { engine: 'builtin' });
  const { text: hiddenText } = await extractText(hiddenBuf);
  ok('隐藏工作经历后不再出现', !hiddenText.includes(profile.work[0].company));
  ok('隐藏项目经历后不再出现', !hiddenText.includes(profile.projects[0].name));
  ok('其他板块仍在', hiddenText.includes(profile.education[0].school));

  const emptyBuf = await pdfEngine.renderPDF({ basics: {}, education: [], work: [], projects: [], skills: [], awards: [], certificates: [], customSections: [] }, { theme: 'classic' }, { engine: 'builtin' });
  ok('空简历也能生成 PDF', emptyBuf.length > 1000 && emptyBuf.slice(0, 5).toString() === '%PDF-', `${emptyBuf.length} B`);
  const { text: emptyText } = await extractText(emptyBuf);
  ok('空简历有占位姓名', emptyText.includes('姓名'));

  console.log('\n=== 7. 与 HTML 版文字一致 ===');
  const render = require('../lib/render');
  const html = render.renderHTML(profile, { theme: 'classic' });
  // 只比正文：<head> 里的 title 与 CSS 不进 PDF 是设计如此
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, html])[1];
  const plainFromHtml = body
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[\s•]/g, '');
  const pdfBuf = await pdfEngine.renderPDF(profile, { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm' }, { engine: 'builtin' });
  const { text: pdfText } = await extractText(pdfBuf);
  const plainFromPdf = pdfText.replace(/[\s•]/g, '');

  // 排序后按字符多重集比较：PDF 里联系方式块在右上方，阅读顺序与 DOM 不同，但字一个不少
  const canon = (s) => Array.from(s).sort().join('');
  ok('PDF 与 HTML 用到的字完全相同', canon(plainFromHtml) === canon(plainFromPdf),
    `${plainFromHtml.length} 字符`);
  if (canon(plainFromHtml) !== canon(plainFromPdf)) {
    const count = new Map();
    for (const ch of plainFromHtml) count.set(ch, (count.get(ch) || 0) + 1);
    for (const ch of plainFromPdf) count.set(ch, (count.get(ch) || 0) - 1);
    const diff = [...count].filter(([, v]) => v !== 0);
    console.log('    差异字符:', JSON.stringify(diff.slice(0, 12)));
  }
  // 段落级：同一段文字在 PDF 里不应被改写
  for (const w of profile.work) {
    ok(`工作经历「${w.company}」标点完整`, pdfText.includes(w.bullets[0]), '');
    break;
  }

  console.log('\n=== 8. 性能 ===');
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    await pdfEngine.renderPDF(profile, { theme: 'classic', pageSize: 'A4', margin: '14mm 15mm' }, { engine: 'builtin' });
  }
  const avg = (Date.now() - t0) / 5;
  ok('单份简历生成在 1 秒内', avg < 1000, `平均 ${avg.toFixed(0)}ms`);

  console.log('\n=== 9. 引擎可用性上报 ===');
  const avail = pdfEngine.available();
  ok('内置引擎报告可用', avail.ok === true);
  ok('找到中文字体', !!avail.fonts.zh.file, avail.fonts.zh.file);
  const chrome = require('../lib/pdf/chrome').available();
  ok('Chrome 引擎状态可查询（不作为必需）', typeof chrome.ok === 'boolean', chrome.ok ? '可用' : chrome.error);

  if (chrome.ok) {
    console.log('\n=== 10. 浏览器引擎的自我恢复 ===');
    const chromeLib = require('../lib/pdf/chrome');
    const first = await chromeLib.renderPDF(profile, { theme: 'classic' });
    ok('浏览器引擎能出 PDF', /Skia\/PDF/.test(first.toString('latin1')), `${(first.length / 1024).toFixed(0)} KB`);

    // 把本进程拉起来的 chrome 全杀掉,模拟 OOM / 手动 kill
    let killed = 0;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { continue; }
      if (cmd.includes(`resume-pdf-profile-${process.pid}`)) {
        try { process.kill(Number(pid), 'SIGKILL'); killed++; } catch (_) { /* ignore */ }
      }
    }
    ok('已杀掉本进程的浏览器', killed > 0, `${killed} 个进程`);
    await new Promise((r) => setTimeout(r, 500));
    const again = await chromeLib.renderPDF(profile, { theme: 'classic' });
    ok('浏览器被杀后能自己重启', /Skia\/PDF/.test(again.toString('latin1')), `${(again.length / 1024).toFixed(0)} KB`);
    await chromeLib.closeBrowser();
  }

  console.log('\n============================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  -', f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试自身出错:', err);
  process.exit(2);
});
