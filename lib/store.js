'use strict';

/**
 * 极简 JSON 文件存储层。
 * 每个实体一个 JSON 文件，写入采用「临时文件 + rename」保证原子性。
 * 不引入任何第三方依赖，单进程串行写即可满足本地工具场景。
 */

const fs = require('fs');
const path = require('path');

// DATA_DIR 可覆盖:自测脚本各自用一个临时目录,互不污染真实 data/
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const writeQueues = new Map();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileOf(key) {
  if (!/^[a-z0-9_-]+\.json$/i.test(key)) {
    throw new Error(`非法的存储键: ${key}`);
  }
  return path.join(DATA_DIR, key);
}

function readJSON(key, fallback) {
  ensureDir();
  const file = fileOf(key);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // 文件损坏时保留现场，回退默认值，避免整个应用起不来
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) { /* ignore */ }
    console.error(`[store] ${key} 解析失败，已备份并回退默认值:`, err.message);
    return fallback;
  }
}

function writeJSONNow(key, value) {
  ensureDir();
  const file = fileOf(key);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

/** 串行化同一文件的写入，避免并发请求互相覆盖 */
function writeJSON(key, value) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(() => writeJSONNow(key, value)).catch((err) => {
    console.error(`[store] 写入 ${key} 失败:`, err.message);
    throw err;
  });
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

function updateJSON(key, fallback, mutator) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev
    .then(() => {
      const cur = readJSON(key, fallback);
      const out = mutator(cur) || cur;
      return writeJSONNow(key, out);
    })
    .catch((err) => {
      console.error(`[store] 更新 ${key} 失败:`, err.message);
      throw err;
    });
  writeQueues.set(key, next.catch(() => {}));
  return next;
}

module.exports = { DATA_DIR, readJSON, writeJSON, updateJSON };
