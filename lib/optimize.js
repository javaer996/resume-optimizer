'use strict';

/**
 * 优化流水线：脱敏 → 组装提示词 → 调用模型 → 解析 → 还原 → 归一化
 */

const mask = require('./mask');
const providers = require('./providers');

const DEFAULT_OPTS = {
  switches: null,
  customRules: [],
  jobDuties: '',
  requirements: '',
  companyIntro: '',
  focusAreas: '',
  cautions: '',
  tone: '专业、简洁、结果导向',
  extraInstruction: '',
};

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => `- ${String(x).trim()}`).join('\n');
  return String(v).trim();
}

/** 把简历对象渲染成提示词里可读的纯文本（比裸 JSON 更省 token，也更稳） */
function renderResumeText(profile) {
  const lines = [];
  const b = profile.basics || {};
  lines.push('## 基本信息');
  if (b.name) lines.push(`姓名：${b.name}`);
  if (b.title) lines.push(`目标职位：${b.title}`);
  if (b.email) lines.push(`邮箱：${b.email}`);
  if (b.phone) lines.push(`电话：${b.phone}`);
  if (b.location) lines.push(`所在地：${b.location}`);
  if (b.website) lines.push(`主页：${b.website}`);
  if (b.summary) lines.push(`个人简介：${b.summary}`);
  if (b.highlight) lines.push(`一句话亮点：${b.highlight}`);

  const section = (title, arr, fmt) => {
    if (!Array.isArray(arr) || !arr.length) return;
    lines.push(`\n## ${title}`);
    arr.forEach((item, i) => {
      lines.push(`### ${i + 1}. ${fmt.head(item)}`);
      for (const line of fmt.lines(item)) if (line) lines.push(`- ${line}`);
    });
  };

  section('教育经历', profile.education, {
    head: (e) => [e.school, e.major, e.degree].filter(Boolean).join(' · '),
    lines: (e) => [
      [e.start, e.end].filter(Boolean).join(' ~ ') + (e.gpa ? ` | GPA ${e.gpa}` : ''),
      ...(e.bullets || []),
    ],
  });

  section('工作经历', profile.work, {
    head: (j) => [j.company, j.position].filter(Boolean).join(' · '),
    lines: (j) => [
      [j.start, j.end].filter(Boolean).join(' ~ ') + (j.location ? ` | ${j.location}` : ''),
      ...(j.bullets || []),
    ],
  });

  section('项目经历', profile.projects, {
    head: (p) => [p.name, p.role].filter(Boolean).join(' · '),
    lines: (p) => [
      [p.org, [p.start, p.end].filter(Boolean).join(' ~ ')].filter(Boolean).join(' | '),
      (p.tech || []).length ? `技术栈：${(p.tech || []).join('、')}` : '',
      ...(p.bullets || []),
    ],
  });

  section('技能', profile.skills, {
    head: (s) => s.category || '技能',
    lines: (s) => [(s.items || []).join('、')],
  });

  section('获奖', profile.awards, {
    head: (a) => a.title || '',
    lines: (a) => [[a.date, a.detail].filter(Boolean).join(' | ')],
  });

  section('证书', profile.certificates, {
    head: (c) => c.title || '',
    lines: (c) => [[c.date, c.detail].filter(Boolean).join(' | ')],
  });

  section('其他', profile.customSections, {
    head: (s) => s.title || '',
    lines: (s) => (s.items || []).map(String),
  });

  return lines.join('\n');
}

function renderCompanyBlock(company, opts) {
  const c = company || {};
  return {
    companyName: c.name || '（未指定单位）',
    position: c.position || opts.position || '（未指定职位）',
    companyIntro: asText(c.intro || opts.companyIntro) || '（未提供）',
    jobDuties: asText(c.duties || opts.jobDuties) || '（未提供）',
    requirements: asText(c.requirements || opts.requirements) || '（未提供）',
    focusAreas: asText(c.focusAreas || opts.focusAreas) || '（未提供）',
    cautions: asText(c.cautions || opts.cautions) || '（未提供）',
    tone: c.tone || opts.tone || '专业、简洁、结果导向',
  };
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
  });
}

function buildMessages(template, company, opts, maskedResume) {
  const vars = {
    ...renderCompanyBlock(company, opts),
    resumeJson: JSON.stringify(maskedResume, null, 2),
    resumeText: renderResumeText(maskedResume),
    extraInstruction: opts.extraInstruction || '',
  };
  const system = fillTemplate(template.systemPrompt || '', vars);
  const user = fillTemplate(template.userPromptTemplate || '', vars);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 从模型输出里抽出 JSON（容忍 ```json 包裹、前后解释文字） */
function parseModelJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('模型返回为空');

  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (_) { return undefined; }
  };

  let out = tryParse(raw);
  if (out !== undefined) return out;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    out = tryParse(fence[1].trim());
    if (out !== undefined) return out;
  }

  // 从第一个 { 到最后一个 } 截取
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    out = tryParse(raw.slice(start, end + 1));
    if (out !== undefined) return out;
  }
  throw new Error(`无法从模型输出中解析 JSON。原始输出前 300 字：${raw.slice(0, 300)}`);
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 归一化模型返回的简历，保证前端渲染不会因为缺字段而崩 */
function normalizeResume(input, fallback) {
  const src = input && typeof input === 'object' ? input : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const base = src.resume && typeof src.resume === 'object' ? src.resume : src;

  const arr = (v) => (Array.isArray(v) ? v : []);

  const basics = base.basics && typeof base.basics === 'object' ? base.basics : (fb.basics || {});
  const out = {
    basics: {
      name: str(basics.name),
      englishName: str(basics.englishName),
      title: str(basics.title),
      email: str(basics.email),
      phone: str(basics.phone),
      location: str(basics.location),
      address: str(basics.address),
      website: str(basics.website),
      wechat: str(basics.wechat),
      idcard: str(basics.idcard),
      summary: str(basics.summary),
      highlight: str(basics.highlight),
      links: arr(basics.links).map(str),
    },
    education: arr(base.education || fb.education).map((e) => ({
      school: str(e.school), degree: str(e.degree), major: str(e.major),
      start: str(e.start), end: str(e.end), gpa: str(e.gpa), location: str(e.location),
      bullets: arr(e.bullets).map(str),
    })),
    work: arr(base.work || fb.work).map((j) => ({
      company: str(j.company), position: str(j.position),
      start: str(j.start), end: str(j.end), location: str(j.location),
      bullets: arr(j.bullets).map(str),
    })),
    projects: arr(base.projects || fb.projects).map((p) => ({
      name: str(p.name), org: str(p.org), role: str(p.role),
      start: str(p.start), end: str(p.end),
      tech: arr(p.tech).map(str), bullets: arr(p.bullets).map(str),
    })),
    skills: arr(base.skills || fb.skills).map((s) => ({
      category: str(s.category), items: arr(s.items).map(str),
    })),
    awards: arr(base.awards || fb.awards).map((a) => ({
      title: str(a.title), date: str(a.date), detail: str(a.detail),
    })),
    certificates: arr(base.certificates || fb.certificates).map((c) => ({
      title: str(c.title), date: str(c.date), detail: str(c.detail),
    })),
    customSections: arr(base.customSections || fb.customSections).map((s) => ({
      title: str(s.title), items: arr(s.items).map(str),
    })),
  };
  return out;
}

function normalizeNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, 200).map((n) => ({
    section: str(n?.section),
    reason: str(n?.reason),
    before: str(n?.before),
    after: str(n?.after),
  })).filter((n) => n.section || n.reason || n.after);
}

/**
 * 执行一次优化。
 * @returns {Promise<object>} 含 resume（已还原真实信息）、notes、keywords、脱敏报告等
 */
async function optimizeResume({ profile, company, template, provider, opts = {} }) {
  if (!profile || typeof profile !== 'object') throw new Error('缺少简历数据');
  if (!template) throw new Error('缺少提示词模板');

  const options = { ...DEFAULT_OPTS, ...opts };
  const session = mask.createSession(profile, {
    switches: options.switches,
    customRules: options.customRules,
  });

  const maskedResume = session.maskDeep(profile);
  const maskedCompany = session.maskDeep({
    name: company?.name || '',
    position: company?.position || '',
    intro: company?.intro || '',
    duties: company?.duties || '',
    requirements: company?.requirements || '',
    focusAreas: company?.focusAreas || '',
    cautions: company?.cautions || '',
    tone: company?.tone || options.tone || '',
  });

  const messages = buildMessages(template, maskedCompany, options, maskedResume);

  const started = Date.now();
  const raw = await providers.chat(provider, messages);
  const elapsedMs = Date.now() - started;

  const parsed = parseModelJSON(raw);
  const entries = session.entries;

  // 还原：先深拷贝结构，再逐字段还原字符串
  const restoredResume = unmaskDeep(parsed.resume || parsed, entries);
  const resume = normalizeResume(restoredResume, profile);

  const notes = normalizeNotes(parsed.notes).map((n) => ({
    ...n,
    before: mask.unmask(n.before, entries),
    after: mask.unmask(n.after, entries),
    reason: mask.unmask(n.reason, entries),
  }));

  const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : []).map((k) => mask.unmask(str(k), entries));
  const coverLetter = mask.unmask(str(parsed.coverLetter), entries);

  const leaks = mask.findLeaks(JSON.stringify(resume));

  return {
    resume,
    notes,
    keywords,
    coverLetter,
    leaks,
    elapsedMs,
    vault: entries,
    maskReport: session.report(),
    maskedPreview: session.mask(renderResumeText(profile)),
    provider: provider ? { id: provider.id, name: provider.name, model: provider.model, protocol: provider.protocol } : null,
  };
}

function unmaskDeep(value, entries) {
  if (typeof value === 'string') return mask.unmask(value, entries);
  if (Array.isArray(value)) return value.map((v) => unmaskDeep(v, entries));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unmaskDeep(v, entries);
    return out;
  }
  return value;
}

/** 供"查看发给 AI 的内容"使用：不调用模型，只返回脱敏后的提示词 */
function previewPrompt({ profile, company, template, opts = {} }) {
  const options = { ...DEFAULT_OPTS, ...opts };
  const session = mask.createSession(profile, {
    switches: options.switches,
    customRules: options.customRules,
  });
  const maskedResume = session.maskDeep(profile);
  const maskedCompany = session.maskDeep({
    name: company?.name || '',
    position: company?.position || '',
    intro: company?.intro || '',
    duties: company?.duties || '',
    requirements: company?.requirements || '',
    focusAreas: company?.focusAreas || '',
    cautions: company?.cautions || '',
    tone: company?.tone || options.tone || '',
  });
  return {
    messages: buildMessages(template, maskedCompany, options, maskedResume),
    maskReport: session.report(),
  };
}

module.exports = {
  optimizeResume,
  previewPrompt,
  parseModelJSON,
  normalizeResume,
  renderResumeText,
  buildMessages,
  DEFAULT_OPTS,
};
