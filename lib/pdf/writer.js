'use strict';

/**
 * 极简 PDF 写入器：足够画一份简历，不追求通用。
 *
 * 输出结构：Catalog → Pages → Page → 内容流（Flate 压缩）。
 * 字体一律走 Type0 / CIDFontType2 + Identity-H，字体文件由 sfnt.js 子集化后内嵌，
 * 因此中文不依赖阅读器里装了什么字体，也不会出现方框。
 */

const zlib = require('zlib');
const sfnt = require('./sfnt');

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
};

function sizeOf(name) {
  if (Array.isArray(name)) return name;
  const key = String(name || 'A4').trim().toLowerCase();
  const found = Object.keys(PAGE_SIZES).find((k) => k.toLowerCase() === key);
  return found ? PAGE_SIZES[found] : PAGE_SIZES.A4;
}

/** 颜色统一成 "r g b" 三个 0~1 的数 */
function colorParts(c) {
  const s = String(c || '#000000').replace('#', '');
  const full = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function escPdfText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function utf16Hex(cp) {
  if (cp > 0xffff) {
    const v = cp - 0x10000;
    const hi = 0xd800 + (v >> 10);
    const lo = 0xdc00 + (v & 0x3ff);
    return [hi.toString(16).padStart(4, '0').toUpperCase(), lo.toString(16).padStart(4, '0').toUpperCase()];
  }
  return [cp.toString(16).padStart(4, '0').toUpperCase()];
}

class PDFWriter {
  /**
   * @param {object} opts
   * @param {string|number[]} opts.size 页面尺寸
   * @param {object} opts.meta { title, author, subject, creator }
   */
  constructor(opts = {}) {
    this.size = sizeOf(opts.size);
    this.meta = opts.meta || {};
    this.pages = [];
    this.fonts = new Map(); // key -> { font, subset }
    this.current = null;
  }

  /**
   * 注册一个字体。
   * @param {string} key 内容流里引用字体用的键
   * @param {string} file 字体文件路径
   * @param {number} faceIndex TTC face 序号
   */
  addFont(key, file, faceIndex = 0) {
    if (this.fonts.has(key)) return this.fonts.get(key).font;
    const font = sfnt.readFont(file, faceIndex);
    this.fonts.set(key, { font, subset: null });
    return font;
  }

  hasFont(key) {
    return this.fonts.has(key);
  }

  /** 新起一页 */
  newPage() {
    const page = { ops: [] };
    this.pages.push(page);
    this.current = page;
    return page;
  }

  get pageCount() {
    return this.pages.length;
  }

  /* ---------- 绘制原语（页坐标以左下角为原点） ---------- */

  text(x, y, str, { font = 'zh', size = 10, color = '#000000', charSpace = 0, rotate = 0 } = {}) {
    const s = String(str == null ? '' : str);
    if (!s) return;
    this.current.ops.push({ t: 'text', x, y, s, font, size, color, charSpace, rotate });
  }

  rect(x, y, w, h, { fill = '#000000' } = {}) {
    if (w <= 0 || h <= 0) return;
    this.current.ops.push({ t: 'rect', x, y, w, h, fill });
  }

  line(x1, y1, x2, y2, { color = '#000000', width = 1 } = {}) {
    this.current.ops.push({ t: 'line', x1, y1, x2, y2, color, width });
  }

  /**
   * 圆角矩形。PDF 只有直角 re，圆角要用四段三次贝塞尔拼。
   * 半径按短边的一半夹住，否则小色块配大圆角会算出反向的控制点、图形翻边。
   * 半径小于 0.3pt 时直接走直角，省掉没必要的路径。
   */
  roundRect(x, y, w, h, r, { fill = '#000000' } = {}) {
    if (w <= 0 || h <= 0) return;
    const rr = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
    if (rr < 0.3) { this.rect(x, y, w, h, { fill }); return; }
    this.current.ops.push({ t: 'rrect', x, y, w, h, r: rr, fill });
  }

  /** 多边形（菱形、三角等）。points = [[x, y], ...] */
  poly(points, { fill = '#000000' } = {}) {
    if (!Array.isArray(points) || points.length < 3) return;
    this.current.ops.push({ t: 'poly', points, fill });
  }

  /* ---------- 编码 ---------- */

  /** 每页内容流：把文本按字体切成段，用 CID 十六进制写 */
  encodeContent(page) {
    const out = [];
    let lastFill = null;
    for (const op of page.ops) {
      if (op.t === 'rect') {
        const [r, g, b] = colorParts(op.fill);
        out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
        out.push(`${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.w.toFixed(2)} ${op.h.toFixed(2)} re f`);
        lastFill = null;
        continue;
      }
      if (op.t === 'rrect') {
        const [r, g, b] = colorParts(op.fill);
        out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
        const { x, y, w, h } = op;
        const k = op.r;
        const c = k * 0.5522847498; // 四分之一圆的贝塞尔控制点系数
        const n = (v) => v.toFixed(2);
        out.push(`${n(x + k)} ${n(y)} m`);
        out.push(`${n(x + w - k)} ${n(y)} l`);
        out.push(`${n(x + w - k + c)} ${n(y)} ${n(x + w)} ${n(y + k - c)} ${n(x + w)} ${n(y + k)} c`);
        out.push(`${n(x + w)} ${n(y + h - k)} l`);
        out.push(`${n(x + w)} ${n(y + h - k + c)} ${n(x + w - k + c)} ${n(y + h)} ${n(x + w - k)} ${n(y + h)} c`);
        out.push(`${n(x + k)} ${n(y + h)} l`);
        out.push(`${n(x + k - c)} ${n(y + h)} ${n(x)} ${n(y + h - k + c)} ${n(x)} ${n(y + h - k)} c`);
        out.push(`${n(x)} ${n(y + k)} l`);
        out.push(`${n(x)} ${n(y + k - c)} ${n(x + k - c)} ${n(y)} ${n(x + k)} ${n(y)} c`);
        out.push('f');
        lastFill = null;
        continue;
      }
      if (op.t === 'poly') {
        const [r, g, b] = colorParts(op.fill);
        out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
        const n = (v) => v.toFixed(2);
        op.points.forEach(([x, y], i) => {
          out.push(`${n(x)} ${n(y)} ${i === 0 ? 'm' : 'l'}`);
        });
        out.push('f');
        lastFill = null;
        continue;
      }
      if (op.t === 'line') {
        const [r, g, b] = colorParts(op.color);
        out.push('q');
        out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
        out.push(`${Math.max(0.1, op.width).toFixed(2)} w`);
        out.push(`${op.x1.toFixed(2)} ${op.y1.toFixed(2)} m ${op.x2.toFixed(2)} ${op.y2.toFixed(2)} l S`);
        out.push('Q');
        lastFill = null;
        continue;
      }

      const entry = this.fonts.get(op.font);
      if (!entry || !entry.subset) continue;
      let hex = '';
      for (const ch of op.s) {
        const cp = ch.codePointAt(0);
        const gid = entry.font.cmap.get(cp);
        const cid = gid == null ? 0 : entry.subset.remap.get(gid);
        hex += (cid == null ? 0 : cid).toString(16).padStart(4, '0').toUpperCase();
      }
      if (!hex) continue;
      const rgbKey = op.color || '#000000';
      if (rgbKey !== lastFill) {
        const [r, g, b] = colorParts(rgbKey);
        out.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
        lastFill = rgbKey;
      }
      out.push('q');
      out.push('BT');
      out.push(`/${op.font} ${op.size.toFixed(2)} Tf`);
      // Tc 属于文本状态，会跨 BT/ET 一直生效——上一段设了字距，这一段不写就会被带上，
      // 于是标题的字距「泄漏」到后面的日期里，宽度算不对。所以每段都显式写一次。
      out.push(`${(op.charSpace || 0).toFixed(2)} Tc`);
      let tm;
      if (op.rotate) {
        const a = (op.rotate * Math.PI) / 180;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        tm = `${cos.toFixed(5)} ${sin.toFixed(5)} ${(-sin).toFixed(5)} ${cos.toFixed(5)} ${op.x.toFixed(2)} ${op.y.toFixed(2)}`;
      } else {
        tm = `1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)}`;
      }
      out.push(`${tm} Tm`);
      out.push(`<${hex}> Tj`);
      out.push('ET');
      out.push('Q');
    }
    return out.join('\n');
  }

  buildToUnicode(entry) {
    const { font, subset } = entry;
    const lines = [];
    const items = [];
    const seen = new Set();
    for (const [cp, gid] of font.cmap) {
      const cid = subset.remap.get(gid);
      if (cid == null || seen.has(cid)) continue;
      seen.add(cid);
      items.push([cid, cp]);
    }
    items.sort((a, b) => a[0] - b[0]);

    lines.push('/CIDInit /ProcSet findresource begin');
    lines.push('12 dict begin');
    lines.push('begincmap');
    lines.push('/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def');
    lines.push('/CMapName /Adobe-Identity-UCS def');
    lines.push('/CMapType 2 def');
    lines.push('1 begincodespacerange');
    lines.push('<0000> <FFFF>');
    lines.push('endcodespacerange');

    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const [cid, cp] of chunk) {
        const dst = utf16Hex(cp).join('');
        lines.push(`<${cid.toString(16).padStart(4, '0').toUpperCase()}> <${dst}>`);
      }
      lines.push('endbfchar');
    }
    lines.push('endcmap');
    lines.push('CMapName currentdict /CMap defineresource pop');
    lines.push('end');
    lines.push('end');
    return lines.join('\n');
  }

  /**
   * 序列化为 PDF。
   * @returns {Buffer}
   */
  toBuffer() {
    // 1) 收集用到的字符，做子集化
    for (const entry of this.fonts.values()) {
      const chars = new Set();
      for (const page of this.pages) {
        for (const op of page.ops) {
          if (op.t !== 'text') continue;
          const font = this.fonts.get(op.font);
          if (font !== entry) continue;
          for (const ch of op.s) chars.add(ch);
        }
      }
      entry.subset = sfnt.subset(entry.font, chars);
    }

    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length; // 1-based 对象号
    };
    const addStream = (dict, data) => {
      const deflated = zlib.deflateSync(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1'), { level: 9 });
      const chunks = [Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${deflated.length} >>\nstream\n`, 'latin1'), deflated, Buffer.from('\nendstream', 'latin1')];
      return add(Buffer.concat(chunks));
    };

    // 2) 字体
    const fontRefs = {};
    for (const [key, entry] of this.fonts) {
      const { font, subset } = entry;
      // PDF 约定子集前缀是 6 个大写字母
      const tag = `${key.toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 6).padEnd(6, 'X');
      const baseFont = `${tag}+${font.postscriptName.replace(/[^\w-]/g, '')}`;
      const scale = 1000 / font.unitsPerEm;

      // 宽度：只写非默认宽度的 CID。
      // /W 的 "c [w1 w2 ...]" 形式要求这些 CID 连续，所以必须按连续段分组——
      // 把不相邻的 CID 挤进同一个数组，阅读器会把宽度算到错误的字上。
      const widths = [];
      for (const [origGid, cid] of subset.remap) {
        const w = Math.round(font.advances[origGid] * scale * 100) / 100;
        if (w !== 1000) widths.push([cid, w]);
      }
      widths.sort((a, b) => a[0] - b[0]);
      const runs = [];
      for (const [cid, w] of widths) {
        const last = runs[runs.length - 1];
        if (last && cid === last.start + last.ws.length) last.ws.push(w);
        else runs.push({ start: cid, ws: [w] });
      }
      const wChunks = [];
      for (let i = 0; i < runs.length; i += 100) {
        for (const r of runs.slice(i, i + 100)) {
          wChunks.push(`${r.start} [${r.ws.join(' ')}]`);
        }
      }

      const fontFile = addStream(
        `/Length1 ${subset.data.length}`,
        subset.data,
      );

      const descriptor = add(`<< /Type /FontDescriptor /FontName /${baseFont}
  /Flags 4 /FontBBox [${font.bbox.map((v) => Math.round(v * scale)).join(' ')}]
  /ItalicAngle 0 /Ascent ${Math.round(font.ascender * scale)} /Descent ${Math.round(font.descender * scale)}
  /CapHeight ${Math.round(font.ascender * 0.7 * scale)} /StemV 80
  /FontFile2 ${fontFile} 0 R >>`);

      const cidFont = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont}
  /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
  /FontDescriptor ${descriptor} 0 R /DW 1000
  ${wChunks.length ? `/W [${wChunks.join(' ')}]` : ''}
  /CIDToGIDMap /Identity >>`);

      const toUnicode = addStream('', this.buildToUnicode(entry));
      const type0 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont}
  /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
      fontRefs[key] = type0;
    }

    // 3) 页面
    // 每页占两个对象（内容流 + 页面），所以 Pages 对象紧跟在它们后面
    const pagesObjNum = objects.length + this.pages.length * 2 + 1;
    const pageNums = [];
    for (const page of this.pages) {
      const content = addStream('', this.encodeContent(page));
      const resources = Object.entries(fontRefs)
        .map(([k, n]) => `/${k} ${n} 0 R`).join(' ');
      const pageNum = add(`<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${this.size[0]} ${this.size[1]}]
  /Resources << /Font << ${resources} >> /ProcSet [/PDF /Text] >>
  /Contents ${content} 0 R >>`);
      pageNums.push(pageNum);
    }

    const pagesNum = add(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
    if (pagesNum !== pagesObjNum) {
      throw new Error(`PDF 对象编号错位：预期 ${pagesObjNum}，实际 ${pagesNum}`);
    }

    const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
    const metaParts = [];
    if (this.meta.title) metaParts.push(`/Title (${escPdfText(this.meta.title)})`);
    if (this.meta.author) metaParts.push(`/Author (${escPdfText(this.meta.author)})`);
    if (this.meta.subject) metaParts.push(`/Subject (${escPdfText(this.meta.subject)})`);
    metaParts.push('/Creator (Resume Optimizer)');
    metaParts.push(`/Producer (Resume Optimizer PDF Engine)`);
    const infoNum = add(`<< ${metaParts.join(' ')} >>`);

    // 4) 落盘：header + 对象 + xref
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.push(offset);
      chunks.push(head, buf, tail);
      offset += head.length + buf.length + tail.length;
    });
    const xrefStart = offset;
    const xref = [`xref`, `0 ${objects.length + 1}`, '0000000000 65535 f '];
    for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n `);
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(`${xref.join('\n')}\n${trailer}`, 'latin1'));

    return Buffer.concat(chunks);
  }
}

module.exports = { PDFWriter, PAGE_SIZES, sizeOf, colorParts };
