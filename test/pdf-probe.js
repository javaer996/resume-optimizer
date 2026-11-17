'use strict';
/**
 * 极简 PDF 结构探针：不解码文本，只回答几个可断言的问题。
 * Chromium 的 PDF 会把对象写进压缩流，所以先把所有 FlateDecode 流 inflate 再数。
 */
const zlib = require('zlib');

function inflateAll(buf) {
  const src = buf.toString('latin1');
  const chunks = [src];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    try {
      chunks.push(zlib.inflateSync(raw).toString('latin1'));
    } catch (_) { /* 非 Flate 流，跳过 */ }
  }
  return chunks.join('\n');
}

function inspect(buffer) {
  const plain = buffer.toString('latin1');
  const full = inflateAll(buffer);
  const pageCount = (full.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const fonts = Array.from(new Set(
    (plain.match(/\/BaseFont\s*\/([#\w+.-]+)/g) || [])
      .map((s) => s.replace(/\/BaseFont\s*\//, '').replace(/^[A-Z]{6}\+/, '')),
  ));
  const mediaBox = (plain.match(/\/MediaBox\s*\[([^\]]+)\]/) || [])[1] || '';
  const box = mediaBox.trim().split(/\s+/).map(Number);
  return {
    bytes: buffer.length,
    pages: pageCount,
    fonts,
    cjkFonts: fonts.filter((f) => /WenQuanYi|Noto.*(CJK|SC)|SourceHan|SimSun|Hei/i.test(f)),
    toUnicode: (full.match(/\/ToUnicode/g) || []).length,
    widthMm: box[2] ? +(box[2] / 72 * 25.4).toFixed(1) : null,
    heightMm: box[3] ? +(box[3] / 72 * 25.4).toFixed(1) : null,
    producer: (plain.match(/\/Producer\s*\(([^)]*)\)/) || [])[1] || null,
  };
}

module.exports = { inspect, inflateAll };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node test/pdf-probe.js <file.pdf>');
    process.exit(2);
  }
  console.log(JSON.stringify(inspect(fs.readFileSync(file)), null, 2));
}
