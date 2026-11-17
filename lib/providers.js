'use strict';

/**
 * AI 供应商层
 *
 * 支持两种协议：
 *  - openai    ：OpenAI / DeepSeek / Moonshot / 智谱 / 通义 / Ollama / one-api 等兼容 /chat/completions 的服务
 *  - anthropic ：Claude Messages API 形态
 *  - mock      ：内置离线模拟器，无需 Key 即可跑通全流程（用于试用与自测）
 *
 * 供应商配置整体存 data/providers.json，可保存任意多个。
 */

const store = require('./store');

const FILE = 'providers.json';

const DEFAULT_PROVIDERS = [
  {
    id: 'mock',
    name: '内置模拟器（离线，无需 Key）',
    protocol: 'mock',
    baseUrl: '',
    apiKey: '',
    model: 'mock-resume-1',
    temperature: 0.5,
    maxTokens: 4096,
    jsonMode: false,
    timeoutMs: 60000,
    headers: {},
    enabled: true,
    builtin: true,
    createdAt: new Date().toISOString(),
  },
];

async function list() {
  const data = store.readJSON(FILE, null);
  if (!data || !Array.isArray(data.providers) || !data.providers.length) {
    await store.writeJSON(FILE, { providers: DEFAULT_PROVIDERS, activeId: 'mock' });
    return { providers: DEFAULT_PROVIDERS, activeId: 'mock' };
  }
  return data;
}

async function save(payload) {
  const providers = (payload.providers || []).map((p) => normalizeProvider(p));
  const activeId = payload.activeId || providers[0]?.id || '';
  await store.writeJSON(FILE, { providers, activeId });
  return { providers, activeId };
}

function normalizeProvider(p) {
  const out = {
    id: String(p.id || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`),
    name: String(p.name || '未命名供应商').slice(0, 60),
    protocol: ['openai', 'anthropic', 'mock'].includes(p.protocol) ? p.protocol : 'openai',
    baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(p.apiKey || ''),
    model: String(p.model || '').trim(),
    temperature: clamp(Number(p.temperature ?? 0.5), 0, 2),
    maxTokens: Math.round(clamp(Number(p.maxTokens ?? 4096), 256, 32000)),
    jsonMode: !!p.jsonMode,
    timeoutMs: Math.round(clamp(Number(p.timeoutMs ?? 60000), 5000, 300000)),
    headers: p.headers && typeof p.headers === 'object' ? p.headers : {},
    enabled: p.enabled !== false,
    builtin: !!p.builtin,
    createdAt: p.createdAt || new Date().toISOString(),
  };
  if (out.protocol === 'mock') out.model = out.model || 'mock-resume-1';
  return out;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function resolveEndpoint(p) {
  const base = p.baseUrl || (
    p.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'
  );
  if (p.protocol === 'anthropic') {
    if (/\/v1\/messages$/.test(base)) return base;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

class ProviderError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, extra);
  }
}

/**
 * 调用模型，返回纯文本。
 * @param {object} provider
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} opts { jsonMode }
 */
async function chat(provider, messages, opts = {}) {
  if (!provider) throw new ProviderError('未选择 AI 供应商');
  if (provider.protocol === 'mock') return mockChat(messages);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutMs || 60000);
  try {
    if (provider.protocol === 'anthropic') {
      return await chatAnthropic(provider, messages, opts, controller.signal);
    }
    return await chatOpenAI(provider, messages, opts, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ProviderError(`请求超时（${provider.timeoutMs}ms）`, { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function chatOpenAI(provider, messages, opts, signal) {
  const url = resolveEndpoint(provider);
  const body = {
    model: provider.model,
    messages,
    temperature: provider.temperature,
    max_tokens: provider.maxTokens,
    stream: false,
  };
  if ((opts.jsonMode || provider.jsonMode)) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`供应商返回 ${res.status}: ${shorten(text)}`, { status: res.status, raw: text });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new ProviderError(`无法解析供应商响应（前 300 字）：${shorten(text, 300)}`, { raw: text });
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  if (typeof data?.choices?.[0]?.text === 'string') return data.choices[0].text;
  throw new ProviderError('供应商响应中没有可用文本内容', { raw: text });
}

async function chatAnthropic(provider, messages, opts, signal) {
  const url = resolveEndpoint(provider);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: m.content }],
  }));
  const body = {
    model: provider.model,
    max_tokens: provider.maxTokens,
    temperature: provider.temperature,
    messages: rest,
  };
  if (system) body.system = system;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {}),
      ...(provider.headers || {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`供应商返回 ${res.status}: ${shorten(text)}`, { status: res.status, raw: text });
  }
  const data = JSON.parse(text);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const out = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!out) throw new ProviderError('供应商响应中没有可用文本内容', { raw: text });
  return out;
}

function shorten(s, n = 500) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/* ------------------------------------------------------------------ */
/* 内置模拟器：离线可跑通全流程，行为上模仿"合理但保守"的优化结果      */
/* ------------------------------------------------------------------ */
function mockChat(messages) {
  const userMsg = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const systemMsg = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

  // 提示词里的简历是以 JSON 代码块直接给出的（见模板中的 ```json 段）
  const fence = userMsg.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let resume = null;
  if (fence) {
    try { resume = JSON.parse(fence[1]); } catch (_) { resume = null; }
  }
  if (!resume) {
    return JSON.stringify({ ok: false, reason: '模拟器未收到简历数据' });
  }

  // 单位信息在【目标单位】文本块里
  const pick = (label) => {
    const m = userMsg.match(new RegExp(`${label}：([^\\n]*)`));
    const v = m ? m[1].trim() : '';
    return v.startsWith('（未') ? '' : v;
  };
  const companyName = pick('名称');
  const position = pick('应聘职位');
  const focusRaw = pick('重点考察范围');
  const keywords = focusRaw
    ? focusRaw.split(/[、，,；;\/|]+/).map((x) => x.trim()).filter(Boolean).slice(0, 6)
    : ['交付效率', '质量保障'];

  const clone = JSON.parse(JSON.stringify(resume));
  const notes = [];
  const companyLabel = companyName || '目标单位';

  // 1) 个人简介：补一句与岗位对齐的表述
  if (clone.basics && typeof clone.basics.summary === 'string' && clone.basics.summary.trim()) {
    const before = clone.basics.summary.trim();
    const tail = `针对${companyLabel}${position ? `的${position}` : ''}岗位，突出可量化交付与跨团队协作能力。`;
    clone.basics.summary = before.endsWith('。') ? before + tail : `${before}。${tail}`;
    notes.push({
      section: '个人简介',
      reason: '对齐岗位要求，补充与目标单位直接相关的表述',
      before: before.slice(0, 40),
      after: clone.basics.summary.slice(-40),
    });
  }

  // 2) 要点：补句号 + 给无量化结果的条目加关键词（模拟真实模型的补量化行为）
  const rewrite = (list, sectionName, kw) => {
    for (const item of list || []) {
      if (!Array.isArray(item.bullets)) continue;
      item.bullets = item.bullets.map((b) => {
        const original = String(b).trim();
        if (!original) return original;
        let next = original.replace(/[；;]$/, '');
        if (!/[。.!！]$/.test(next)) next += '。';
        if (!/\d/.test(next) && kw.length) {
          const k = kw[(sectionName === '工作经历' ? 0 : 1) % kw.length];
          next = next.replace(/。$/, `，${k}相关的产出得到显著提升。`);
        }
        if (next !== original) {
          notes.push({
            section: sectionName,
            reason: '补充可验证的结果描述，贴合考察范围',
            before: original.slice(0, 40),
            after: next.slice(0, 48),
          });
        }
        return next;
      });
    }
  };
  rewrite(clone.work, '工作经历', keywords);
  rewrite(clone.projects, '项目经历', keywords);

  // 3) 技能：把考察范围里的关键词并入技能分类（不新增事实，只重组已有内容）
  if (Array.isArray(clone.skills) && clone.skills.length && position) {
    const first = clone.skills[0];
    if (Array.isArray(first.items) && !first.items.includes(position)) {
      // 不把岗位名塞进技能，保持真实性；仅记录说明
      notes.push({ section: '技能', reason: '保持技能分类与岗位职责的相关性', before: '', after: first.category });
    }
  }

  return JSON.stringify({
    resume: clone,
    notes,
    keywords,
    coverLetter: '',
    providerNote: '（本结果由内置模拟器生成，仅用于验证流程；接入真实模型后将输出真实优化内容）',
  });
}

module.exports = {
  list,
  save,
  chat,
  resolveEndpoint,
  normalizeProvider,
  ProviderError,
  mockChat,
};
