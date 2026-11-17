'use strict';

/**
 * 简历优化工作台 —— 本地服务端
 *
 * 无第三方依赖，只用 Node 内置能力。
 * 启动：node server.js  （默认 0.0.0.0:8890）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./lib/store');
const mask = require('./lib/mask');
const prompts = require('./lib/prompts');
const providers = require('./lib/providers');
const optimize = require('./lib/optimize');
const render = require('./lib/render');
const themes = require('./lib/themes');
const pdf = require('./lib/pdf');
const research = require('./lib/research');
const cssai = require('./lib/cssai');
const auth = require('./lib/auth');

// 8888 是这台机器上唯一映射到宿主机、可以直接在浏览器里打开的端口
const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 默认数据                                                            */
/* ------------------------------------------------------------------ */

const EMPTY_PROFILE = {
  basics: {
    name: '', englishName: '', title: '', email: '', phone: '', location: '',
    address: '', website: '', wechat: '', idcard: '', summary: '', highlight: '', links: [],
  },
  education: [], work: [], projects: [], skills: [], awards: [], certificates: [], customSections: [],
};

const DEFAULT_LAYOUT = {
  order: themes.DEFAULT_ORDER.slice(),
  header: { style: 'inherit', align: 'inherit', chips: null, showContacts: true, showTitle: true, visible: true },
  sections: {},
  customCSS: '',
};

const DEFAULT_SETTINGS = {
  switches: { ...mask.DEFAULT_SWITCHES },
  customRules: [
    { id: 'r_wechat', label: 'WeChat', mode: 'literal', value: '', enabled: false },
  ],
  export: {
    theme: themes.DEFAULT_THEME, accent: '', fontSize: 0, lineHeight: 0,
    pageSize: 'A4', margin: '14mm 15mm',
    showPageNumbers: true, showWatermark: false, watermarkText: '内部草稿',
    hidden: [],
    layout: { ...DEFAULT_LAYOUT, header: { ...DEFAULT_LAYOUT.header }, sections: {} },
  },
  unmaskAuto: true,
};

/**
 * 合并导出设置里的 layout。
 *
 * 关键取舍：**「没传」和「传了空」必须区分开**。前端换主题时会主动清空 sections 与
 * header（否则旧主题的微调会把新主题改坏），如果服务端把旧值合并回来，用户明明看到
 * 覆盖被清掉了，刷新一次又全回来了——这是实际发生过的 bug。
 * 所以规则是：
 *   - 传了 sections / header：以传进来的为准（没提到的 key 视为删除）
 *   - 没传的字段：保持原值
 */
function mergeLayout(cur, patch) {
  if (!patch || typeof patch !== 'object') return cur || DEFAULT_LAYOUT;
  const base = cur && typeof cur === 'object' ? cur : DEFAULT_LAYOUT;
  const next = { ...base, ...patch };
  if ('sections' in patch) {
    next.sections = patch.sections && typeof patch.sections === 'object' ? patch.sections : {};
  } else {
    next.sections = { ...(base.sections || {}) };
  }
  if ('header' in patch) {
    next.header = patch.header && typeof patch.header === 'object' ? patch.header : {};
  } else {
    next.header = { ...(base.header || {}) };
  }
  return next;
}

const PROFILE_FILE = 'profile.json';
const COMPANIES_FILE = 'companies.json';
const JOBS_FILE = 'jobs.json';
const SETTINGS_FILE = 'settings.json';

function ensureDefaults() {
  if (!fs.existsSync(store.DATA_DIR)) fs.mkdirSync(store.DATA_DIR, { recursive: true });
  if (!fs.existsSync(path.join(store.DATA_DIR, PROFILE_FILE))) store.writeJSON(PROFILE_FILE, EMPTY_PROFILE).catch(() => {});
  if (!fs.existsSync(path.join(store.DATA_DIR, SETTINGS_FILE))) store.writeJSON(SETTINGS_FILE, DEFAULT_SETTINGS).catch(() => {});
  if (!fs.existsSync(path.join(store.DATA_DIR, COMPANIES_FILE))) store.writeJSON(COMPANIES_FILE, { companies: [] }).catch(() => {});
  if (!fs.existsSync(path.join(store.DATA_DIR, JOBS_FILE))) store.writeJSON(JOBS_FILE, { jobs: [] }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 业务：公司与批量任务                                                */
/* ------------------------------------------------------------------ */

async function listCompanies() {
  const data = store.readJSON(COMPANIES_FILE, { companies: [] });
  return Array.isArray(data.companies) ? data.companies : [];
}

async function upsertCompany(input) {
  const now = new Date().toISOString();
  const company = {
    id: input.id || `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: String(input.name || '').trim(),
    position: String(input.position || '').trim(),
    intro: String(input.intro || ''),
    duties: String(input.duties || ''),
    requirements: String(input.requirements || ''),
    focusAreas: String(input.focusAreas || ''),
    cautions: String(input.cautions || ''),
    tone: String(input.tone || ''),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    updatedAt: now,
    createdAt: input.createdAt || now,
  };
  if (!company.name) throw new Error('单位名称不能为空');

  // 调研元信息。注意三态：对象=写入；null=清空；缺省=沿用旧值（普通编辑不该抹掉调研记录）
  const researchPatch = input.research === undefined
    ? undefined
    : (input.research && typeof input.research === 'object'
      ? {
        engine: String(input.research.engine || ''),
        confidence: ['high', 'medium', 'low'].includes(input.research.confidence) ? input.research.confidence : '',
        sources: Array.isArray(input.research.sources) ? input.research.sources.slice(0, 10).map(String) : [],
        at: String(input.research.at || ''),
        warning: String(input.research.warning || ''),
      }
      : null);

  let saved = null;
  await store.updateJSON(COMPANIES_FILE, { companies: [] }, (cur) => {
    const list = Array.isArray(cur.companies) ? cur.companies : [];
    const idx = list.findIndex((c) => c.id === company.id);
    const prev = idx >= 0 ? list[idx] : null;
    const research = researchPatch === undefined ? (prev ? (prev.research || null) : null) : researchPatch;
    const merged = { ...company, research };
    if (idx >= 0) list[idx] = { ...prev, ...merged };
    else list.unshift(merged);
    saved = merged;
    return { companies: list };
  });
  return saved;
}

async function deleteCompany(id) {
  await store.updateJSON(COMPANIES_FILE, { companies: [] }, (cur) => ({
    companies: (cur.companies || []).filter((c) => c.id !== id),
  }));
}

/** 这家单位是否还缺情报（只有名称 + 招聘要求） */
function needsIntel(c) {
  if (!c || !c.name) return false;
  const hasFields = !!(String(c.intro || '').trim() || String(c.focusAreas || '').trim());
  const researched = !!(c.research && c.research.at);
  return !hasFields && !researched;
}

/**
 * 给一家单位补齐情报，并把结果写回库。
 * 返回补齐后的单位对象；调研失败返回 null（调用方照旧用原对象继续）。
 */
async function enrichCompany(company) {
  const provider = await pickResearchProvider();
  const out = await research.research({
    name: company.name,
    position: company.position,
    requirements: company.requirements,
    provider,
    useAI: !!provider,
  });
  const intel = out.intel || {};
  if (!intel.intro && !intel.focusAreas) return null;
  const saved = await upsertCompany({
    ...company,
    intro: intel.intro || company.intro || '',
    focusAreas: intel.focusAreas || company.focusAreas || '',
    cautions: intel.cautions || company.cautions || '',
    tone: intel.tone || company.tone || '',
    research: {
      engine: out.engine,
      confidence: intel.confidence,
      sources: intel.sources || [],
      at: new Date().toISOString(),
      warning: out.warning || '',
    },
  });
  return saved;
}

/**
 * 调研该用哪个供应商。
 * 离线模拟器对调研没意义（它只会复述输入），所以当作"没有 AI"。
 */
async function pickResearchProvider() {
  const state = await providers.list();
  const p = state.providers.find((x) => x.id === state.activeId)
    || state.providers.find((x) => x.enabled !== false)
    || null;
  if (!p || p.protocol === 'mock') return null;
  return p;
}

async function getJobs() {
  const data = store.readJSON(JOBS_FILE, { jobs: [] });
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function saveJob(job) {
  await store.updateJSON(JOBS_FILE, { jobs: [] }, (cur) => {
    const jobs = Array.isArray(cur.jobs) ? cur.jobs : [];
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) jobs[idx] = job;
    else jobs.unshift(job);
    return { jobs: jobs.slice(0, 60) };
  });
}

async function deleteJob(id) {
  await store.updateJSON(JOBS_FILE, { jobs: [] }, (cur) => ({
    jobs: (cur.jobs || []).filter((j) => j.id !== id),
  }));
}

/** 进行中的任务句柄：id -> { cancelled } */
const running = new Map();

function newJob(companyIds, meta) {
  return {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    templateId: meta.templateId,
    providerId: meta.providerId,
    providerName: meta.providerName,
    templateName: meta.templateName,
    // 批量跑的时候是否顺手给缺情报的单位做调研（前端可关）
    autoResearch: meta.autoResearch !== false,
    items: companyIds.map((cid) => ({
      companyId: cid,
      companyName: meta.companyNames?.[cid] || '',
      status: 'pending',
      stage: '',
      error: '',
      elapsedMs: 0,
      result: null,
    })),
  };
}

/**
 * 跑一个批量任务（后台异步，前端轮询进度）
 */
async function runJob(job, ctx) {
  running.set(job.id, { cancelled: false });
  try {
    for (let i = 0; i < job.items.length; i += 1) {
      const flag = running.get(job.id);
      if (!flag || flag.cancelled) {
        job.status = 'cancelled';
        for (let k = i; k < job.items.length; k += 1) {
          if (job.items[k].status === 'pending') job.items[k].status = 'skipped';
        }
        break;
      }
      const item = job.items[i];
      if (item.status !== 'pending') continue; // 重试时跳过已完成项
      let company = ctx.companies.find((c) => c.id === item.companyId);
      item.status = 'running';
      await saveJob(job);

      if (!company) {
        item.status = 'failed';
        item.error = '单位已不存在';
        await saveJob(job);
        continue;
      }

      // 只有名称和招聘要求、还没调研过 —— 优化前先把情报补齐，
      // 否则提示词里「重点考察范围 / 注意事项」都是空的，针对性别不明显。
      if (job.autoResearch !== false && needsIntel(company)) {
        // 标出阶段：不然后面多花十几秒调研，界面却停在"正在生成"，看着像卡死
        item.stage = 'research';
        await saveJob(job);
        try {
          const enriched = await enrichCompany(company);
          if (enriched) company = enriched;
        } catch (err) {
          // 调研失败不该让整条优化失败：降级为"没有情报"继续跑
          console.warn(`[research] ${company.name} 调研失败:`, err.message);
        }
        item.stage = 'optimize';
        await saveJob(job);
      }

      const started = Date.now();
      try {
        const result = await optimize.optimizeResume({
          profile: ctx.profile,
          company,
          template: ctx.template,
          provider: ctx.provider,
          opts: ctx.opts,
        });
        item.status = 'done';
        item.elapsedMs = Date.now() - started;
        item.result = {
          resume: result.resume,
          notes: result.notes,
          keywords: result.keywords,
          coverLetter: result.coverLetter,
          leaks: result.leaks,
          vault: result.vault,
          maskReport: result.maskReport,
          maskedPreview: result.maskedPreview,
          company: {
            id: company.id, name: company.name, position: company.position,
            focusAreas: company.focusAreas, cautions: company.cautions,
          },
          editedAt: null,
        };
      } catch (err) {
        item.status = 'failed';
        item.error = err && err.message ? err.message : String(err);
        item.elapsedMs = Date.now() - started;
      }
      await saveJob(job);
    }
    if (job.status === 'running') {
      job.status = job.items.some((it) => it.status === 'failed') ? 'finished_with_errors' : 'finished';
    }
  } catch (err) {
    job.status = 'failed';
    job.error = String(err && err.message ? err.message : err);
  } finally {
    job.finishedAt = new Date().toISOString();
    running.delete(job.id);
    await saveJob(job).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function sendJSON(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(root, rel) {
  const target = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (!target.startsWith(path.resolve(root))) return null;
  return target;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  /* ---- 登录 ---- */
  if (p === '/api/auth/status' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...auth.status(), authed: !!auth.session(req) });
  }

  if (p === '/api/auth/setup' && method === 'POST') {
    const body = await readBody(req);
    try {
      const { user } = await auth.setup({ username: body.username, pass: body.pass });
      res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue(user)));
      console.log(`[auth] 初始化账号 ${user}`);
      return sendJSON(res, 200, { ok: true, user });
    } catch (err) {
      return sendJSON(res, err.status || 400, { ok: false, code: err.code || 'error', error: err.message });
    }
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const ip = clientIp(req);
    try {
      const out = await auth.login({ username: body.username, pass: body.pass, remember: !!body.remember, ip });
      res.setHeader('Set-Cookie', auth.cookieHeader(out.token, { days: body.remember ? 30 : 7 }));
      console.log(`[auth] 登录成功 ${out.user} (${ip})`);
      return sendJSON(res, 200, { ok: true, user: out.user });
    } catch (err) {
      if (err.code === 'bad_credentials') console.warn(`[auth] 登录失败 (${ip})`);
      return sendJSON(res, err.status || 401, { ok: false, code: err.code || 'error', error: err.message });
    }
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/auth/change-password' && method === 'POST') {
    const sess = auth.session(req);
    if (!sess) return sendJSON(res, 401, { ok: false, code: 'unauthenticated', error: '请先登录' });
    const body = await readBody(req);
    try {
      // 改密码会轮换签名密钥,所以给这一端换一张剩余寿命相同的新令牌
      const days = Math.max(1, Math.round(((sess.exp || 0) - Date.now()) / 86400000)) || 7;
      const out = await auth.changePassword({ user: sess.user, current: body.current, next: body.next, days });
      res.setHeader('Set-Cookie', auth.cookieHeader(out.token, { days }));
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      // 当前密码错不是「会话过期」,别用 401,否则前端会把人踢回登录页
      const status = err.code === 'bad_credentials' ? 400 : (err.status || 400);
      return sendJSON(res, status, { ok: false, code: err.code || 'error', error: err.message });
    }
  }

  /* ---- 总览 ---- */
  if (p === '/api/state' && method === 'GET') {
    const [providerState, promptState] = await Promise.all([providers.list(), prompts.get()]);
    return sendJSON(res, 200, {
      // 过一遍归一化：手工编辑过的 profile.json 可能少字段，前端会直接崩
      // （曾因把 customSections 写成 customItems 导致整页白屏）
      profile: optimize.normalizeResume(store.readJSON(PROFILE_FILE, EMPTY_PROFILE), EMPTY_PROFILE),
      companies: await listCompanies(),
      jobs: (await getJobs()).map(summarizeJob),
      providers: providerState,
      prompts: promptState,
      settings: store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS),
      // style: 主题画廊、可选项、章节元信息——前端据此生成样式工作台
      style: themes.describe(),
      themes: Object.values(themes.THEMES),
      tokens: mask.TOKEN_TYPES,
      pdfAvailable: pdf.available().ok,
      pdfEngine: pdf.available().ok ? (process.env.PDF_ENGINE || 'builtin') : null,
    });
  }

  /* ---- 简历 ---- */
  if (p === '/api/profile' && method === 'POST') {
    const body = await readBody(req);
    const profile = optimize.normalizeResume(body.profile || {}, EMPTY_PROFILE);
    await store.writeJSON(PROFILE_FILE, profile);
    return sendJSON(res, 200, { ok: true, profile });
  }

  /* ---- 单位 ---- */
  if (p === '/api/companies' && method === 'POST') {
    const body = await readBody(req);
    const company = await upsertCompany(body.company || body);
    return sendJSON(res, 200, { ok: true, company });
  }
  if (p === '/api/companies/delete' && method === 'POST') {
    const body = await readBody(req);
    await deleteCompany(body.id);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 单位情报调研：只发单位名与岗位方向，不碰简历 ---- */
  if (p === '/api/research' && method === 'POST') {
    const body = await readBody(req);
    if (!String(body.name || '').trim()) {
      return sendJSON(res, 400, { ok: false, error: '请先填写单位名称' });
    }
    // provider 只在用户明确想用 AI 时才取；模拟器会被当成"没有 AI"
    const provider = body.useAI === false ? null : await pickResearchProvider();
    try {
      const out = await research.research({
        name: body.name,
        position: body.position,
        requirements: body.requirements,
        provider,
        useAI: !!provider,
      });
      return sendJSON(res, 200, { ok: true, ...out });
    } catch (err) {
      return sendJSON(res, 200, { ok: false, error: err.message });
    }
  }

  /* ---- 用一句话生成自定义 CSS ---- */
  if (p === '/api/css/generate' && method === 'POST') {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendJSON(res, 400, { ok: false, code: 'empty_prompt', error: '先说说想要什么效果' });
    const state = await providers.list();
    const wanted = body.providerId
      ? state.providers.find((x) => x.id === body.providerId)
      : state.providers.find((x) => x.id === state.activeId) || state.providers.find((x) => x.enabled !== false);
    if (!wanted || wanted.protocol === 'mock') {
      return sendJSON(res, 400, {
        ok: false,
        code: 'no_provider',
        error: '还没有可用的 AI 供应商（模拟供应商不会真的写 CSS），请先到「供应商」页配置一个',
      });
    }
    try {
      const out = await cssai.generate({
        prompt,
        current: body.current,
        theme: body.theme,
        provider: wanted,
      });
      return sendJSON(res, 200, { ok: true, provider: wanted.name || wanted.model, ...out });
    } catch (err) {
      return sendJSON(res, err.status || 400, { ok: false, code: err.code || 'css_failed', error: err.message });
    }
  }

  /* ---- 供应商 ---- */
  if (p === '/api/providers' && method === 'POST') {
    const body = await readBody(req);
    const saved = await providers.save(body);
    return sendJSON(res, 200, { ok: true, ...saved });
  }
  if (p === '/api/providers/test' && method === 'POST') {
    const body = await readBody(req);
    const state = await providers.list();
    const provider = body.provider
      ? providers.normalizeProvider(body.provider)
      : state.providers.find((x) => x.id === (body.providerId || state.activeId));
    if (!provider) return sendJSON(res, 400, { ok: false, error: '未找到供应商配置' });
    try {
      const started = Date.now();
      const text = await providers.chat(provider, [
        { role: 'system', content: '你是连通性测试助手，只需按要求简短回复。' },
        { role: 'user', content: '请只回复四个字：连接正常' },
      ]);
      return sendJSON(res, 200, { ok: true, elapsedMs: Date.now() - started, reply: String(text).slice(0, 200) });
    } catch (err) {
      return sendJSON(res, 200, { ok: false, error: err.message });
    }
  }

  /* ---- 提示词 ---- */
  if (p === '/api/prompts' && method === 'GET') {
    return sendJSON(res, 200, await prompts.get());
  }
  if (p === '/api/prompts' && method === 'POST') {
    const body = await readBody(req);
    if (body.action === 'delete') {
      return sendJSON(res, 200, { ok: true, ...(await prompts.deleteTemplate(body.id)) });
    }
    if (body.action === 'activate') {
      return sendJSON(res, 200, { ok: true, ...(await prompts.setActive(body.id)) });
    }
    if (body.action === 'restore') {
      return sendJSON(res, 200, { ok: true, ...(await prompts.restoreHistory(body.historyId)) });
    }
    const state = await prompts.saveTemplate(body.template || body);
    return sendJSON(res, 200, { ok: true, ...state });
  }

  /* ---- 设置 ---- */
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const cur = store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
    const patch = body.settings || {};
    const exportPatch = patch.export || {};
    const next = {
      ...cur,
      ...patch,
      switches: { ...cur.switches, ...(patch.switches || {}) },
      export: {
        ...cur.export,
        ...exportPatch,
        // layout 是「主题 + 逐段覆盖」，前端可能只改其中一层，
        // 浅合并会把没提交的字段冲掉（比如只调了某个章节的序号）。
        layout: mergeLayout(cur.export && cur.export.layout, exportPatch.layout),
      },
    };
    if (Array.isArray((body.settings || {}).customRules)) next.customRules = body.settings.customRules;
    await store.writeJSON(SETTINGS_FILE, next);
    return sendJSON(res, 200, { ok: true, settings: next });
  }

  /* ---- 预览提示词（脱敏后实际发给 AI 的内容） ---- */
  if (p === '/api/preview' && method === 'POST') {
    const body = await readBody(req);
    const ctx = await resolveContext(body);
    const preview = optimize.previewPrompt({
      profile: ctx.profile, company: ctx.company, template: ctx.template, opts: ctx.opts,
    });
    return sendJSON(res, 200, { ok: true, ...preview, provider: ctx.provider ? ctx.provider.name : null });
  }

  /* ---- 发起批量优化 ---- */
  if (p === '/api/optimize' && method === 'POST') {
    const body = await readBody(req);
    const ctx = await resolveContext(body);
    const companyIds = Array.isArray(body.companyIds) && body.companyIds.length
      ? body.companyIds
      : (ctx.company ? [ctx.company.id] : []);
    if (!companyIds.length) return sendJSON(res, 400, { ok: false, error: '请至少选择一个目标单位' });

    const companyNames = {};
    for (const c of ctx.companies) companyNames[c.id] = c.name;

    const job = newJob(companyIds, {
      templateId: ctx.template?.id,
      templateName: ctx.template?.name,
      providerId: ctx.provider?.id,
      providerName: ctx.provider?.name,
      companyNames,
    });
    await saveJob(job);
    // 不阻塞 HTTP 响应
    runJob(job, ctx).catch((err) => console.error('[job] 异常:', err));
    return sendJSON(res, 200, { ok: true, job: summarizeJob(job) });
  }

  /* ---- 重试失败项 ---- */
  const retryMatch = p.match(/^\/api\/jobs\/([\w-]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    const jobId = retryMatch[1];
    if (running.has(jobId)) return sendJSON(res, 409, { ok: false, error: '任务仍在执行中' });
    const jobs = await getJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return sendJSON(res, 404, { ok: false, error: '任务不存在' });
    const retryable = job.items.filter((it) => it.status === 'failed' || it.status === 'skipped');
    if (!retryable.length) return sendJSON(res, 400, { ok: false, error: '没有需要重试的项目' });
    retryable.forEach((it) => { it.status = 'pending'; it.error = ''; it.elapsedMs = 0; });
    job.status = 'running';
    job.finishedAt = null;
    await saveJob(job);
    const ctx = await resolveContext({ templateId: job.templateId, providerId: job.providerId });
    runJob(job, ctx).catch((err) => console.error('[job] 重试异常:', err));
    return sendJSON(res, 200, { ok: true, job: summarizeJob(job) });
  }

  /* ---- 任务状态 ---- */
  const jobMatch = p.match(/^\/api\/jobs\/([\w-]+)$/);
  if (jobMatch && method === 'GET') {
    const jobs = await getJobs();
    const job = jobs.find((j) => j.id === jobMatch[1]);
    if (!job) return sendJSON(res, 404, { ok: false, error: '任务不存在' });
    const full = url.searchParams.get('full') === '1';
    return sendJSON(res, 200, { ok: true, job: full ? job : summarizeJob(job) });
  }
  const jobAction = p.match(/^\/api\/jobs\/([\w-]+)\/(cancel|delete)$/);
  if (jobAction && method === 'POST') {
    const [, id, action] = jobAction;
    if (action === 'cancel') {
      const flag = running.get(id);
      if (flag) flag.cancelled = true;
      else return sendJSON(res, 200, { ok: false, error: '任务未在运行中' });
      return sendJSON(res, 200, { ok: true });
    }
    await deleteJob(id);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 保存单个结果（编辑后） ---- */
  if (p === '/api/jobs/result' && method === 'POST') {
    const body = await readBody(req);
    const jobs = await getJobs();
    const job = jobs.find((j) => j.id === body.jobId);
    if (!job) return sendJSON(res, 404, { ok: false, error: '任务不存在' });
    const item = job.items.find((it) => it.companyId === body.companyId);
    if (!item || !item.result) return sendJSON(res, 404, { ok: false, error: '结果不存在' });
    if (body.resume) item.result.resume = optimize.normalizeResume(body.resume, item.result.resume);
    if (typeof body.coverLetter === 'string') item.result.coverLetter = body.coverLetter;
    item.result.editedAt = new Date().toISOString();
    await saveJob(job);
    return sendJSON(res, 200, { ok: true, job: summarizeJob(job) });
  }

  /* ---- 脱敏 / 还原工具 ---- */
  if (p === '/api/unmask' && method === 'POST') {
    const body = await readBody(req);
    const entries = Array.isArray(body.vault) ? body.vault : [];
    const text = mask.unmask(body.text, entries);
    return sendJSON(res, 200, { ok: true, text, leaks: mask.findLeaks(text) });
  }

  /* ---- 导出 ---- */
  if (p === '/api/export/pdf' && method === 'POST') {
    const body = await readBody(req);
    const settings = store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
    const opts = { ...settings.export, ...(body.opts || {}) };
    const profile = optimize.normalizeResume(body.resume || {}, EMPTY_PROFILE);
    let pdf;
    try {
      pdf = await render.renderPDF(profile, opts);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
    const name = sanitizeFilename(body.filename || `${(profile.basics && profile.basics.name) || '简历'}-${opts.theme || 'classic'}`);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent(name)}.pdf`,
      'Cache-Control': 'no-store',
    });
    return res.end(pdf);
  }

  if (p === '/api/export/html' && method === 'POST') {
    const body = await readBody(req);
    const settings = store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
    const opts = { ...settings.export, ...(body.opts || {}) };
    const profile = optimize.normalizeResume(body.resume || {}, EMPTY_PROFILE);
    const html = render.renderHTML(profile, opts);
    const name = sanitizeFilename(body.filename || '简历');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="resume.html"; filename*=UTF-8''${encodeURIComponent(name)}.html`,
    });
    return res.end(html);
  }

  if (p === '/api/export/markdown' && method === 'POST') {
    const body = await readBody(req);
    const settings = store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
    const opts = { ...settings.export, ...(body.opts || {}) };
    const profile = optimize.normalizeResume(body.resume || {}, EMPTY_PROFILE);
    const md = render.renderMarkdown(profile, opts);
    const name = sanitizeFilename(body.filename || '简历');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="resume.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`,
    });
    return res.end(md);
  }

  if (p === '/api/preview/html' && method === 'POST') {
    const body = await readBody(req);
    const opts = { ...(body.opts || {}) };
    const profile = optimize.normalizeResume(body.resume || {}, EMPTY_PROFILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(render.renderHTML(profile, opts));
  }

  return sendJSON(res, 404, { ok: false, error: `未知接口 ${method} ${p}` });
}

function sanitizeFilename(name) {
  return String(name || '简历').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 80) || '简历';
}

function summarizeJob(job) {
  const done = job.items.filter((i) => i.status === 'done').length;
  const failed = job.items.filter((i) => i.status === 'failed').length;
  return {
    id: job.id,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    status: job.status,
    error: job.error || '',
    templateId: job.templateId,
    templateName: job.templateName,
    providerId: job.providerId,
    providerName: job.providerName,
    total: job.items.length,
    done,
    failed,
    items: job.items.map((i) => ({
      companyId: i.companyId,
      companyName: i.companyName,
      status: i.status,
      stage: i.stage || '',
      error: i.error,
      elapsedMs: i.elapsedMs,
      hasResult: !!i.result,
    })),
  };
}

async function resolveContext(body) {
  const settings = store.readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);
  const [providerState, promptState, companies] = await Promise.all([
    providers.list(), prompts.get(), listCompanies(),
  ]);

  const profile = body.profile
    ? optimize.normalizeResume(body.profile, EMPTY_PROFILE)
    : store.readJSON(PROFILE_FILE, EMPTY_PROFILE);

  const company = body.companyId
    ? companies.find((c) => c.id === body.companyId)
    : (body.company || null);

  const templateId = body.templateId || promptState.activeTemplateId;
  const template = promptState.templates.find((t) => t.id === templateId)
    || promptState.templates[0];

  const providerId = body.providerId || providerState.activeId;
  const provider = providerState.providers.find((x) => x.id === providerId)
    || providerState.providers.find((x) => x.enabled !== false)
    || providerState.providers[0];

  const opts = {
    switches: body.switches ? { ...settings.switches, ...body.switches } : settings.switches,
    customRules: body.customRules || settings.customRules,
    jobDuties: body.jobDuties || '',
    requirements: body.requirements || '',
    companyIntro: body.companyIntro || '',
    focusAreas: body.focusAreas || '',
    cautions: body.cautions || '',
    tone: body.tone || '',
    extraInstruction: body.extraInstruction || '',
  };

  return { profile, company, companies, template, provider, opts, settings };
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

ensureDefaults();

// 登出做成幂等的:哪怕会话已经过期也回 200 并清 cookie,前端不用判断
const OPEN_API = new Set(['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']);
// 登录页要能匿名打开,所以它和它的图标不能走鉴权
const OPEN_STATIC = new Set(['/login.html', '/favicon.ico']);

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const sess = auth.session(req);
  // 快到期就悄悄续一张,用户不会写着写着被踢回登录页
  if (sess && sess.refresh) res.setHeader('Set-Cookie', auth.cookieHeader(sess.refresh));

  if (url.pathname.startsWith('/api/')) {
    if (!OPEN_API.has(url.pathname) && !sess) {
      return sendJSON(res, 401, { ok: false, code: 'unauthenticated', error: '登录已过期，请重新登录' });
    }
    handleApi(req, res, url).catch((err) => {
      console.error('[api] 未捕获异常:', err);
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: err.message || String(err) });
      else res.end();
    });
    return;
  }

  if (!OPEN_STATIC.has(url.pathname) && !sess) {
    // 页面跳登录页;静态资源也一起拦(否则未登录也能把前端代码全拉走)
    res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`简历优化工作台已启动: http://${HOST}:${PORT}`);
  console.log(`数据目录: ${store.DATA_DIR}`);
  if (!pdf.available().ok) console.warn('警告：' + pdf.available().error);
});

process.on('SIGINT', async () => {
  await render.closeBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await render.closeBrowser();
  process.exit(0);
});

module.exports = { server };
