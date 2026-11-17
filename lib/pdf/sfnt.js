'use strict';

/**
 * 最小 TrueType 解析与子集化。
 *
 * PDF 里要内嵌的字体必须自己处理：中文字体动辄十几 MB，全量内嵌不现实，
 * 所以这里只保留文档实际用到的字形，并重新编号成 0..n-1。
 * 重新编号之后 loca / hmtx / maxp 都跟着缩，几千字节就能装下整份简历的字。
 *
 * 只支持 glyf 轮廓的字体（TrueType / TTC）。CFF/OTF 会明确报错，
 * 不静默产出坏文件。
 */

const fs = require('fs');

const u16 = (b, o) => b.readUInt16BE(o);
const i16 = (b, o) => b.readInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

const HEAD_MAGIC = 0x5f0f3cf5;

/**
 * 读取字体，返回带度量、cmap、loca 的普通对象。
 * @param {string} file 字体文件路径
 * @param {number} faceIndex TTC 里的 face 序号
 */
function readFont(file, faceIndex = 0) {
  const buf = fs.readFileSync(file);
  let base = 0;
  if (buf.toString('latin1', 0, 4) === 'ttcf') {
    const count = u32(buf, 8);
    if (faceIndex >= count) throw new Error(`${file} 只有 ${count} 个 face，取不到第 ${faceIndex} 个`);
    base = u32(buf, 12 + faceIndex * 4);
  }
  const version = u32(buf, base);
  if (version === 0x4f54544f) throw new Error(`${file} 是 CFF/OTF 轮廓，本引擎只支持 glyf`);
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new Error(`${file} 不是可识别的 TrueType（sfnt=0x${version.toString(16)}）`);
  }

  const numTables = u16(buf, base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16;
    const tag = buf.toString('latin1', r, r + 4);
    tables[tag] = { offset: u32(buf, r + 8), length: u32(buf, r + 12) };
  }
  for (const need of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) {
    if (!tables[need]) throw new Error(`${file} 缺少必需的 ${need} 表`);
  }
  if (u32(buf, tables.head.offset + 12) !== HEAD_MAGIC) {
    throw new Error(`${file} 的 head 表校验魔数不对，文件可能损坏`);
  }

  const font = {
    file,
    faceIndex,
    buf,
    tables,
    unitsPerEm: u16(buf, tables.head.offset + 18),
    indexToLocFormat: i16(buf, tables.head.offset + 50),
    numGlyphs: u16(buf, tables.maxp.offset + 4),
    ascender: i16(buf, tables.hhea.offset + 4),
    descender: i16(buf, tables.hhea.offset + 6),
    lineGap: i16(buf, tables.hhea.offset + 8),
    numberOfHMetrics: u16(buf, tables.hhea.offset + 34),
    bbox: [
      i16(buf, tables.head.offset + 36),
      i16(buf, tables.head.offset + 38),
      i16(buf, tables.head.offset + 40),
      i16(buf, tables.head.offset + 42),
    ],
    postscriptName: null,
  };
  font.glyphOffsets = readLoca(font);
  font.advances = readAdvances(font);
  font.cmap = readCmap(font);
  font.postscriptName = readPostScriptName(font) || `${file.split('/').pop()}#${faceIndex}`;
  return font;
}

function readLoca(font) {
  const { buf, tables, numGlyphs } = font;
  const off = tables.loca.offset;
  const out = new Int32Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    out[i] = font.indexToLocFormat === 0 ? u16(buf, off + i * 2) * 2 : u32(buf, off + i * 4);
  }
  return out;
}

function readAdvances(font) {
  const { buf, tables, numGlyphs, numberOfHMetrics } = font;
  const off = tables.hmtx.offset;
  const out = new Int32Array(numGlyphs);
  let last = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) last = u16(buf, off + i * 4);
    out[i] = last;
  }
  return out;
}

/** 解析 cmap，优先取 (3,10)/(3,1) 的 format 12 / format 4 子表 */
function readCmap(font) {
  const { buf, tables } = font;
  const base = tables.cmap.offset;
  const count = u16(buf, base + 2);
  let best = null;
  for (let i = 0; i < count; i++) {
    const r = base + 4 + i * 8;
    const plat = u16(buf, r);
    const enc = u16(buf, r + 2);
    const sub = base + u32(buf, r + 4);
    const format = u16(buf, sub);
    if (format !== 4 && format !== 12) continue;
    let score = 0;
    if (plat === 3 && enc === 10) score = 4;
    else if (plat === 3 && enc === 1) score = 3;
    else if (plat === 0) score = 2;
    else score = 1;
    if (format === 12) score += 0.5;
    if (!best || score > best.score) best = { score, sub, format };
  }
  if (!best) throw new Error(`${font.file} 没有可用的 cmap 子表（format 4/12）`);

  const map = new Map();
  if (best.format === 4) {
    const sub = best.sub;
    const segX2 = u16(buf, sub + 6);
    const seg = segX2 / 2;
    const endO = sub + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < seg; s++) {
      const end = u16(buf, endO + s * 2);
      const start = u16(buf, startO + s * 2);
      if (start === 0xffff || start > end) continue;
      const delta = i16(buf, deltaO + s * 2);
      const rangeOffset = u16(buf, rangeO + s * 2);
      for (let c = start; c <= end && c < 0x10000; c++) {
        let gid;
        if (rangeOffset === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const gi = rangeO + s * 2 + rangeOffset + (c - start) * 2;
          if (gi + 1 >= buf.length) continue;
          gid = u16(buf, gi);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(c, gid);
      }
    }
  } else {
    const sub = best.sub;
    const groups = u32(buf, sub + 12);
    for (let i = 0; i < groups; i++) {
      const r = sub + 16 + i * 12;
      const sc = u32(buf, r);
      const ec = u32(buf, r + 4);
      const sg = u32(buf, r + 8);
      for (let c = sc; c <= ec; c++) map.set(c, sg + (c - sc));
    }
  }
  return map;
}

function readPostScriptName(font) {
  const t = font.tables.name;
  if (!t) return null;
  const { buf } = font;
  const count = u16(buf, t.offset + 2);
  const strOff = t.offset + u16(buf, t.offset + 4);
  for (let i = 0; i < count; i++) {
    const r = t.offset + 6 + i * 12;
    const plat = u16(buf, r);
    const id = u16(buf, r + 6);
    if (id !== 6) continue;
    const len = u16(buf, r + 8);
    const so = u16(buf, r + 10);
    if (strOff + so + len > buf.length) continue;
    const raw = buf.subarray(strOff + so, strOff + so + len);
    if (plat === 3 || plat === 0) {
      const swapped = Buffer.from(raw);
      if (swapped.length % 2 === 0) swapped.swap16();
      return swapped.toString('utf16le').replace(/\0/g, '');
    }
    return raw.toString('latin1');
  }
  return null;
}

/** 复合字形引用的子字形（简单字形返回空数组） */
function compositeGlyphs(font, gid) {
  const start = font.glyphOffsets[gid];
  const end = font.glyphOffsets[gid + 1];
  if (end <= start) return [];
  const buf = font.buf;
  const o = font.tables.glyf.offset + start;
  if (i16(buf, o) >= 0) return [];
  const refs = [];
  let p = o + 10;
  for (;;) {
    if (p + 4 > buf.length) break;
    const flags = u16(buf, p);
    const idx = u16(buf, p + 2);
    refs.push(idx);
    p += 4;
    p += (flags & 1) ? 4 : 2;
    if (flags & 8) p += 2;
    else if (flags & 2) p += 2;
    else if (flags & 4) p += 4;
    if (!(flags & 32)) break;
  }
  return refs;
}

/** 复合字形内部要改 glyphIndex，重新编号后必须跟着改 */
function patchComposite(buf, remap) {
  if (buf.length < 10 || i16(buf, 0) >= 0) return buf;
  const out = Buffer.from(buf);
  let p = 10;
  for (;;) {
    if (p + 4 > out.length) break;
    const flags = u16(out, p);
    const idx = u16(out, p + 2);
    if (remap.has(idx)) out.writeUInt16BE(remap.get(idx), p + 2);
    p += 4;
    p += (flags & 1) ? 4 : 2;
    if (flags & 8) p += 2;
    else if (flags & 2) p += 2;
    else if (flags & 4) p += 4;
    if (!(flags & 32)) break;
  }
  return out;
}

function checksum(buf) {
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** 把若干张表打包成合法的 sfnt 文件 */
function buildSfnt(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(n * 16 - searchRange, 10);

  let offset = 12 + n * 16;
  const bodies = [];
  tags.forEach((tag, i) => {
    const data = tables[tag];
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    const r = 12 + i * 16;
    header.write(tag, r, 4, 'latin1');
    header.writeUInt32BE(checksum(padded), r + 4);
    header.writeUInt32BE(offset, r + 8);
    header.writeUInt32BE(data.length, r + 12);
    bodies.push(padded);
    offset += padded.length;
  });

  const out = Buffer.concat([header, ...bodies]);
  const headIdx = tags.indexOf('head');
  if (headIdx >= 0) {
    const headOff = out.readUInt32BE(12 + headIdx * 16 + 8);
    out.writeUInt32BE(0, headOff + 8);
    out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headOff + 8);
  }
  return out;
}

/** 只覆盖用到的字符的 format 4 子表 */
function buildCmap4(font, remap) {
  const pairs = [];
  for (const [code, gid] of font.cmap) {
    if (code > 0xffff || !remap.has(gid)) continue;
    pairs.push([code, remap.get(gid)]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  const segs = [];
  for (const [code, gid] of pairs) {
    const last = segs[segs.length - 1];
    if (last && code === last.end + 1 && gid === last.startGid + (code - last.start)) last.end = code;
    else segs.push({ start: code, end: code, startGid: gid });
  }
  segs.push({ start: 0xffff, end: 0xffff, startGid: 0 });
  if (segs[0].start !== 0) segs.unshift({ start: 0, end: 0, startGid: 0 });

  const segCount = segs.length;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 ** entrySelector * 2;
  const sub = Buffer.alloc(16 + segCount * 8);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(0, 4);
  sub.writeUInt16BE(segCount * 2, 6);
  sub.writeUInt16BE(searchRange, 8);
  sub.writeUInt16BE(entrySelector, 10);
  sub.writeUInt16BE(segCount * 2 - searchRange, 12);

  let p = 14;
  for (const s of segs) { sub.writeUInt16BE(s.end, p); p += 2; }
  sub.writeUInt16BE(0, p); p += 2;
  for (const s of segs) { sub.writeUInt16BE(s.start, p); p += 2; }
  for (const s of segs) { sub.writeUInt16BE((s.startGid - s.start) & 0xffff, p); p += 2; }
  for (let i = 0; i < segCount; i++) { sub.writeUInt16BE(0, p); p += 2; }

  const head = Buffer.alloc(12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(3, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(12, 8);
  return Buffer.concat([head, sub]);
}

/**
 * 子集化。
 * @param {object} font readFont 的返回值
 * @param {Iterable<string>} chars 文档里用到的字符
 * @returns {{ data: Buffer, remap: Map<number,number>, glyphs: number[], unitsPerEm: number }}
 */
function subset(font, chars) {
  const keep = [];
  const seen = new Set();
  const add = (g) => { if (!seen.has(g)) { seen.add(g); keep.push(g); } };

  add(0);
  const cps = new Set();
  for (const ch of chars) {
    const cp = typeof ch === 'number' ? ch : ch.codePointAt(0);
    if (!Number.isFinite(cp)) continue;
    const g = font.cmap.get(cp);
    if (g != null) { add(g); cps.add(cp); }
  }
  // 复合字形引用的子字形也要带上，否则引用会指向空字形
  const stack = [...keep];
  while (stack.length) {
    const g = stack.pop();
    for (const ref of compositeGlyphs(font, g)) {
      if (!seen.has(ref)) { seen.add(ref); keep.push(ref); stack.push(ref); }
    }
  }

  const remap = new Map(keep.map((g, i) => [g, i]));
  const n = keep.length;

  const parts = [];
  const loca = new Uint32Array(n + 1);
  let cursor = 0;
  keep.forEach((g, i) => {
    loca[i] = cursor;
    const s = font.glyphOffsets[g];
    const e = font.glyphOffsets[g + 1];
    if (e > s) {
      let raw = Buffer.from(font.buf.subarray(font.tables.glyf.offset + s, font.tables.glyf.offset + e));
      raw = patchComposite(raw, remap);
      const pad = (4 - (raw.length % 4)) % 4;
      const chunk = pad ? Buffer.concat([raw, Buffer.alloc(pad)]) : raw;
      parts.push(chunk);
      cursor += chunk.length;
    }
  });
  loca[n] = cursor;
  const glyf = Buffer.concat(parts);

  const shortLoca = cursor <= 0x1fffe;
  const locaBuf = Buffer.alloc((n + 1) * (shortLoca ? 2 : 4));
  for (let i = 0; i <= n; i++) {
    if (shortLoca) locaBuf.writeUInt16BE(loca[i] >> 1, i * 2);
    else locaBuf.writeUInt32BE(loca[i], i * 4);
  }

  const head = Buffer.from(font.buf.subarray(font.tables.head.offset, font.tables.head.offset + font.tables.head.length));
  head.writeInt16BE(shortLoca ? 0 : 1, 50);
  head.writeUInt32BE(0, 8);

  const maxp = Buffer.from(font.buf.subarray(font.tables.maxp.offset, font.tables.maxp.offset + font.tables.maxp.length));
  maxp.writeUInt16BE(n, 4);

  const hhea = Buffer.from(font.buf.subarray(font.tables.hhea.offset, font.tables.hhea.offset + font.tables.hhea.length));
  hhea.writeUInt16BE(n, 34);

  const hmtx = Buffer.alloc(n * 4);
  keep.forEach((g, i) => {
    hmtx.writeUInt16BE(font.advances[g], i * 4);
    hmtx.writeInt16BE(0, i * 4 + 2);
  });

  const tables = {
    head,
    hhea,
    maxp,
    hmtx,
    loca: locaBuf,
    glyf,
    cmap: buildCmap4(font, remap),
  };
  for (const tag of ['cvt ', 'fpgm', 'prep', 'gasp']) {
    const t = font.tables[tag];
    if (t) tables[tag] = Buffer.from(font.buf.subarray(t.offset, t.offset + t.length));
  }

  return { data: buildSfnt(tables), remap, glyphs: keep, unitsPerEm: font.unitsPerEm };
}

module.exports = { readFont, subset, buildSfnt, checksum, compositeGlyphs, u16, i16, u32 };
