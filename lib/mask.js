'use strict';

/**
 * 敏感信息脱敏 / 还原引擎
 *
 * 设计目标：
 * 1. 发给 AI 的文本里，姓名、手机号、邮箱、学校、地址、公司名等敏感值替换为稳定占位符；
 * 2. AI 返回后，占位符再精确还原为原值（容忍 AI 对空格的轻微改动、全角/半角括号差异）；
 * 3. 占位符对同一个值保持稳定 —— AI 看到 "张伟" 的两处提及都是 [NAME_1]，语义不会断；
 * 4. 支持用户自定义脱敏规则（字面量或正则）；
 * 5. 每个任务一份「还原表」(vault)，不落进模型上下文之外的任何地方。
 */

const crypto = require('crypto');

const TOKEN_TYPES = {
  NAME: '姓名',
  PHONE: '手机号',
  EMAIL: '邮箱',
  SCHOOL: '学校',
  ADDRESS: '地址',
  COMPANY: '公司',
  IDCARD: '身份证号',
  WECHAT: '微信',
  URL: '链接',
  CUSTOM: '自定义',
};

const DEFAULT_SWITCHES = {
  NAME: true,
  PHONE: true,
  EMAIL: true,
  SCHOOL: true,
  ADDRESS: true,
  COMPANY: true,
  IDCARD: true,
  WECHAT: false,
  URL: false,
};

/** 判断某个值能否安全地做全局字面量替换（过短的值会造成误伤） */
function isReplaceable(value, minLen = 2) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < minLen) return false;
  // 必须至少含一个字母 / 数字 / 汉字；纯符号或纯空白无从脱敏
  // 注意：不能用 /^[\s\W]+$/ 判断 —— 未加 u 标志时 \W 会把汉字算作非单词字符
  if (!/[0-9A-Za-z\u4e00-\u9fa5]/.test(v)) return false;
  return true;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从简历结构化数据里抽取需要脱敏的实体。
 * 只抽取「候选人自己」的信息 —— 目标公司名不在其中，否则 AI 无法做针对性优化。
 */
function collectProfileEntities(profile) {
  const out = [];
  const push = (type, value) => {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (!v) return;
    out.push({ type, value: v });
  };

  const basics = (profile && profile.basics) || {};
  push('NAME', basics.name);
  push('NAME', basics.englishName);
  push('PHONE', basics.phone);
  push('EMAIL', basics.email);
  push('ADDRESS', basics.location);
  push('ADDRESS', basics.address);
  push('WECHAT', basics.wechat);
  push('URL', basics.website);
  push('IDCARD', basics.idcard);

  for (const edu of (profile && profile.education) || []) {
    push('SCHOOL', edu.school);
    push('ADDRESS', edu.location);
  }
  for (const job of (profile && profile.work) || []) {
    push('COMPANY', job.company);
    push('ADDRESS', job.location);
  }
  for (const p of (profile && profile.projects) || []) {
    push('COMPANY', p.org);
  }
  return out;
}

/** 通用正则探测器：即便用户没在结构化字段里填，也能兜住正文里的手机号/邮箱等 */
const DETECTORS = [
  { type: 'IDCARD', re: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g },
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'PHONE', re: /(?<![\d+])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g },
  { type: 'PHONE', re: /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g },
];

function typeLabel(type) {
  return TOKEN_TYPES[type] || type;
}

/**
 * 构建一次脱敏会话。
 * @param {object} profile 简历结构化数据
 * @param {object} opts { switches, customRules, salt }
 */
function createSession(profile, opts = {}) {
  const switches = { ...DEFAULT_SWITCHES, ...(opts.switches || {}) };
  const customRules = (opts.customRules || []).filter((r) => r && r.enabled !== false);
  const counters = new Map();
  const byValue = new Map(); // 归一化值 -> token
  const entries = []; // { token, type, value }

  function nextToken(type, label) {
    const base = type === 'CUSTOM' && label ? `CUSTOM_${label}` : type;
    const n = (counters.get(base) || 0) + 1;
    counters.set(base, n);
    return `${base}_${n}`;
  }

  function register(type, value, label) {
    const key = `${type}::${value}`;
    if (byValue.has(key)) return byValue.get(key);
    const token = nextToken(type, label);
    const entry = { token, type, label: label || typeLabel(type), value };
    byValue.set(key, token);
    entries.push(entry);
    return token;
  }

  // 1) 结构化实体
  const entities = collectProfileEntities(profile);
  for (const e of entities) {
    if (!switches[e.type]) continue;
    if (!isReplaceable(e.value, e.type === 'NAME' ? 2 : 3)) continue;
    register(e.type, e.value);
  }

  // 2) 自定义规则里的字面量（优先级更高，先于通用正则）
  for (const rule of customRules) {
    if (rule.mode === 'regex') continue;
    if (!isReplaceable(rule.value, 2)) continue;
    register('CUSTOM', rule.value.trim(), sanitizeLabel(rule.label));
  }

  // 按值长度降序，避免 "北京" 抢先匹配 "北京市海淀区"
  const literals = entries
    .filter((e) => e.type !== 'CUSTOM' || true)
    .slice()
    .sort((a, b) => b.value.length - a.value.length);

  const literalRegexes = literals.map((e) => ({
    entry: e,
    re: new RegExp(escapeRegExp(e.value), 'g'),
  }));

  const regexRules = customRules
    .filter((r) => r.mode === 'regex' && r.value)
    .map((r) => {
      let re;
      try {
        re = new RegExp(r.value, r.flags && /[gimsuy]/.test(r.flags) ? r.flags.replace(/g/g, '') + 'g' : 'g');
      } catch (err) {
        return null;
      }
      return { re, label: sanitizeLabel(r.label) || 'CUSTOM' };
    })
    .filter(Boolean);

  /**
   * 一次扫描内把所有命中收成区间，再按「最长优先」去重叠，从左到右替换。
   * 早先按类别顺序逐个 replace 会有两个问题：短的字面量会把长的正则切口（
   * "数据可视化平台" 被切成 数据[X]平台），以及先插入的占位符可能被后一条
   * 规则再次匹配。区间法对这两点都免疫。
   */
  function maskOnce(text) {
    const work = String(text == null ? '' : text);
    if (!work) return work;

    const spans = [];
    const push = (start, end, type, value, label, token) => {
      if (end > start) spans.push({ start, end, type, value, label, token });
    };

    for (const { entry, re } of literalRegexes) {
      if (!work.includes(entry.value)) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(work)) !== null) {
        if (!m[0]) { re.lastIndex += 1; continue; }
        push(m.index, m.index + m[0].length, entry.type, m[0], entry.label, entry.token);
      }
    }

    for (const det of DETECTORS) {
      if (!switches[det.type]) continue;
      const re = new RegExp(det.re.source, det.re.flags.includes('g') ? det.re.flags : `${det.re.flags}g`);
      let m;
      while ((m = re.exec(work)) !== null) {
        if (!m[0]) { re.lastIndex += 1; continue; }
        push(m.index, m.index + m[0].length, det.type, m[0]);
      }
    }

    for (const rule of regexRules) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(work)) !== null) {
        if (!m[0]) { rule.re.lastIndex += 1; continue; }
        push(m.index, m.index + m[0].length, 'CUSTOM', m[0], rule.label);
      }
    }

    if (!spans.length) return work;

    // 重叠时保留更长的（同类等长保留靠前的）
    spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept = [];
    for (const s of spans) {
      if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
      kept.push(s);
    }
    kept.sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = 0;
    for (const s of kept) {
      const token = s.token || register(s.type, s.value, s.label);
      out += work.slice(cursor, s.start) + `[${token}]`;
      cursor = s.end;
    }
    return out + work.slice(cursor);
  }

  function maskDeep(value) {
    if (typeof value === 'string') return maskOnce(value);
    if (Array.isArray(value)) return value.map(maskDeep);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
      return out;
    }
    return value;
  }

  return {
    mask: maskOnce,
    maskDeep,
    entries,
    switches,
    /** 序列化给前端展示「本次脱敏了哪些内容」 */
    report() {
      return entries.map((e) => ({ token: e.token, type: e.type, label: e.label, value: e.value }));
    },
  };
}

function sanitizeLabel(label) {
  return String(label || '')
    .trim()
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '')
    .slice(0, 12);
}

/**
 * 还原：把 AI 输出中的占位符换回真实值。
 * 容忍 AI 的小幅改写：大小写、空格、全角方括号、缺下划线。
 */
function unmask(text, entries) {
  let work = String(text == null ? '' : text);
  if (!work || !Array.isArray(entries) || !entries.length) return work;

  const sorted = entries.slice().sort((a, b) => b.token.length - a.token.length);
  for (const e of sorted) {
    if (!e.token) continue;
    const tokenBody = e.token.replace(/[_\-]/g, '[_\\- ]?');
    const re = new RegExp(`[\\[【(（]\\s*${tokenBody}\\s*[\\]】)）]`, 'gi');
    work = work.replace(re, () => e.value);
    // 少数模型会直接输出裸 token（不带括号）
    const bare = new RegExp(`(?<![A-Za-z0-9])${tokenBody}(?![A-Za-z0-9])`, 'gi');
    if (bare.test(work)) work = work.replace(bare, () => e.value);
  }

  // 兜底：AI 若加了标题/说明，把残留的服务端标记清掉
  work = work.replace(/[\[【]\s*(?:NAME|PHONE|EMAIL|SCHOOL|ADDRESS|COMPANY|IDCARD|WECHAT|URL|CUSTOM_\w+)_\d+\s*[\]】]/g, '');
  return work;
}

/** 检查文本里还剩多少未还原的占位符，用于前端提示 */
function findLeaks(text) {
  const re = /[\[【]\s*((?:NAME|PHONE|EMAIL|SCHOOL|ADDRESS|COMPANY|IDCARD|WECHAT|URL|CUSTOM_[A-Za-z0-9\u4e00-\u9fa5]*?)_\d+)\s*[\]】]/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
  return out;
}

/** 检测 AI 是否擅自往里塞了新的占位符（防注入/防臆造） */
function vaultId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  TOKEN_TYPES,
  DEFAULT_SWITCHES,
  createSession,
  unmask,
  findLeaks,
  collectProfileEntities,
  vaultId,
};
