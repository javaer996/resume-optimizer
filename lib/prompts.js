'use strict';

/**
 * 提示词模板
 * - 内置三套模板（标准优化 / 强匹配 JD / 精简重写）
 * - 用户可自定义编辑，编辑历史保留 10 条，可随时回滚
 */

const store = require('./store');

const FILE = 'prompts.json';
const HISTORY_LIMIT = 10;

const RESUME_SCHEMA_HINT = `{
  "basics": { "name": "占位符", "title": "职位", "email": "占位符", "phone": "占位符",
              "location": "占位符", "summary": "个人简介（字符串）", "links": ["链接"], "highlight": "一句话亮点" },
  "education": [ { "school": "占位符", "degree": "学历", "major": "专业",
                   "start": "YYYY-MM", "end": "YYYY-MM", "gpa": "GPA", "bullets": ["经历描述"] } ],
  "work": [ { "company": "占位符", "position": "职位", "start": "YYYY-MM", "end": "YYYY-MM 或 至今",
              "location": "占位符", "bullets": ["工作内容，建议带量化结果"] } ],
  "projects": [ { "name": "项目名", "org": "所属组织", "role": "角色", "start": "YYYY-MM", "end": "YYYY-MM",
                  "tech": ["技术栈"], "bullets": ["项目描述"] } ],
  "skills": [ { "category": "分类", "items": ["技能1", "技能2"] } ],
  "awards": [ { "title": "奖项", "date": "YYYY-MM", "detail": "说明" } ],
  "certificates": [ { "title": "证书", "date": "YYYY-MM", "detail": "说明" } ],
  "customSections": [ { "title": "自定义板块标题", "items": ["条目"] } ]
}`;

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl-standard',
    name: '标准优化（推荐）',
    description: '在不改变事实的前提下，重写表达、补强量化结果，并对齐目标岗位关键词。',
    systemPrompt: `你是一位资深的中文简历顾问，服务对象是求职者本人，不是招聘方。
你的任务：在【不虚构任何事实】的前提下，优化简历的表达与结构，使其更贴合目标单位的要求。

硬性规则：
1. 输出语言与简历原文一致（默认简体中文），专业术语可保留英文。
2. 【绝对不要】修改、删除、拆分、翻译或解释方括号占位符，例如 [NAME_1]、[COMPANY_2]、[PHONE_1]。
   它们代表已脱敏的真实信息，必须原样出现在相同语义位置。
3. 不得编造公司、学校、职称、时间、业绩数字。原文没有数字时，允许用"显著""约"等保守措辞，
   但不得凭空构造具体数值；若原文已有数字，必须原样保留。
4. 每条工作/项目要点控制在 1-2 行，用「动作 + 对象 + 方法 + 结果」结构，避免空洞形容词。
5. 只输出 JSON，不要输出 Markdown 代码块之外的任何解释。

输出 JSON 结构：
{
  "resume": <优化后的简历对象，结构与输入完全一致>,
  "notes": [ { "section": "板块名", "reason": "为什么这样改", "before": "原句", "after": "新句" } ],
  "keywords": ["从岗位要求中提取并已融入简历的关键词"],
  "coverLetter": "（可选）150 字以内的求职信开头，若无要求则留空字符串"
}`,
    userPromptTemplate: `请针对下面的目标单位信息优化这份简历。

【目标单位】
名称：{{companyName}}
应聘职位：{{position}}
单位简介：{{companyIntro}}
岗位职责：
{{jobDuties}}
任职要求：
{{requirements}}
重点考察范围：{{focusAreas}}
注意事项/红线：{{cautions}}
风格偏好：{{tone}}

【简历数据（已脱敏）】
\`\`\`json
{{resumeJson}}
\`\`\`

请严格按系统提示中的 JSON 结构返回简历对象，保持字段名与层级完全一致。`,
    builtin: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl-jd',
    name: 'JD 强匹配',
    description: '以岗位要求中的关键词为骨架重排要点，突出匹配度，适合竞争激烈的岗位。',
    systemPrompt: `你是一位擅长"岗位匹配度优化"的简历顾问。
工作方法：先从目标单位的岗位职责与任职要求中提取关键词与能力项，再逐条检查简历，
把最相关、最有分量的经历前置并强化表述；弱相关内容压缩为一句或合并。

硬性规则：
1. 不得虚构任何经历、数字、证书、公司或时间。
2. 【绝对不要】改动方括号占位符（如 [NAME_1]、[SCHOOL_1]），必须原样保留。
3. 输出同一套 JSON 结构，字段名与输入完全一致。
4. 输出 JSON，包含 resume / notes / keywords / coverLetter 四个键。`,
    userPromptTemplate: `请以"岗位匹配度最大化"为目标优化这份简历。

【目标单位】
名称：{{companyName}}
应聘职位：{{position}}
单位简介：{{companyIntro}}
岗位职责：
{{jobDuties}}
任职要求：
{{requirements}}
重点考察范围：{{focusAreas}}
注意事项/红线：{{cautions}}
风格偏好：{{tone}}

【简历数据（已脱敏）】
\`\`\`json
{{resumeJson}}
\`\`\``,
    builtin: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl-concise',
    name: '精简重排',
    description: '保留事实、压缩冗余，适合工作年限较长、内容过多需要收敛篇幅的简历。',
    systemPrompt: `你是一位简历精简专家。目标是把冗长的简历压缩到招聘方 30 秒内能读完的密度：
合并重复表述、删除无信息量的套话、把长段落改写为一条一句的要点。

硬性规则：
1. 不得删除方括号占位符，不得修改其内容，必须原样保留。
2. 不得新增事实；不得编造数字。
3. 每个板块的条目数量可减少，但关键时间线、公司、职位必须完整保留。
4. 输出 JSON，包含 resume / notes / keywords / coverLetter。`,
    userPromptTemplate: `请精简并重排这份简历，同时对齐目标单位要求。

【目标单位】
名称：{{companyName}}
应聘职位：{{position}}
单位简介：{{companyIntro}}
岗位职责：
{{jobDuties}}
任职要求：
{{requirements}}
重点考察范围：{{focusAreas}}
注意事项/红线：{{cautions}}
风格偏好：{{tone}}

【简历数据（已脱敏）】
\`\`\`json
{{resumeJson}}
\`\`\``,
    builtin: true,
    createdAt: new Date().toISOString(),
  },
];

const DEFAULT_STATE = {
  templates: DEFAULT_TEMPLATES,
  activeTemplateId: 'tpl-standard',
  history: [],
};

async function get() {
  const data = store.readJSON(FILE, null);
  if (!data || !Array.isArray(data.templates) || !data.templates.length) {
    await store.writeJSON(FILE, DEFAULT_STATE);
    return DEFAULT_STATE;
  }
  return {
    templates: data.templates,
    activeTemplateId: data.activeTemplateId || data.templates[0].id,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

/**
 * 保存模板。若内容有变化，先把「旧版本」压入历史（最多 10 条）。
 */
async function saveTemplate(template) {
  const state = await get();
  const now = new Date().toISOString();
  const idx = state.templates.findIndex((t) => t.id === template.id);

  if (idx >= 0) {
    const prev = state.templates[idx];
    const changed = prev.systemPrompt !== template.systemPrompt
      || prev.userPromptTemplate !== template.userPromptTemplate
      || prev.name !== template.name;
    if (changed) {
      state.history.unshift({
        id: `h_${Date.now().toString(36)}`,
        at: now,
        templateId: prev.id,
        name: prev.name,
        systemPrompt: prev.systemPrompt,
        userPromptTemplate: prev.userPromptTemplate,
        action: 'edit',
      });
      state.history = state.history.slice(0, HISTORY_LIMIT);
    }
    state.templates[idx] = {
      ...prev,
      ...template,
      builtin: prev.builtin,
      updatedAt: now,
    };
  } else {
    const created = {
      id: template.id || `tpl_${Date.now().toString(36)}`,
      name: template.name || '未命名模板',
      description: template.description || '',
      systemPrompt: template.systemPrompt || '',
      userPromptTemplate: template.userPromptTemplate || '',
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    state.templates.push(created);
    state.history.unshift({
      id: `h_${Date.now().toString(36)}`,
      at: now,
      templateId: created.id,
      name: created.name,
      systemPrompt: created.systemPrompt,
      userPromptTemplate: created.userPromptTemplate,
      action: 'create',
    });
    state.history = state.history.slice(0, HISTORY_LIMIT);
  }
  await store.writeJSON(FILE, state);
  return state;
}

async function deleteTemplate(id) {
  const state = await get();
  const target = state.templates.find((t) => t.id === id);
  if (!target) throw new Error('模板不存在');
  if (target.builtin) throw new Error('内置模板不可删除，可另存为自定义模板');
  state.templates = state.templates.filter((t) => t.id !== id);
  if (state.activeTemplateId === id) state.activeTemplateId = state.templates[0]?.id || '';
  state.history.unshift({
    id: `h_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    templateId: id,
    name: target.name,
    systemPrompt: target.systemPrompt,
    userPromptTemplate: target.userPromptTemplate,
    action: 'delete',
  });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  await store.writeJSON(FILE, state);
  return state;
}

async function setActive(id) {
  const state = await get();
  state.activeTemplateId = id;
  await store.writeJSON(FILE, state);
  return state;
}

/** 用历史记录回滚：把历史快照写回为一条历史（可再次撤销） */
async function restoreHistory(historyId) {
  const state = await get();
  const snap = state.history.find((h) => h.id === historyId);
  if (!snap) throw new Error('历史记录不存在');
  const idx = state.templates.findIndex((t) => t.id === snap.templateId);
  if (idx < 0) throw new Error('对应模板已被删除，无法恢复');
  const prev = state.templates[idx];
  state.history.unshift({
    id: `h_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    templateId: prev.id,
    name: prev.name,
    systemPrompt: prev.systemPrompt,
    userPromptTemplate: prev.userPromptTemplate,
    action: 'restore',
  });
  state.templates[idx] = { ...prev, systemPrompt: snap.systemPrompt, userPromptTemplate: snap.userPromptTemplate };
  state.history = state.history.slice(0, HISTORY_LIMIT);
  await store.writeJSON(FILE, state);
  return state;
}

module.exports = {
  get,
  saveTemplate,
  deleteTemplate,
  setActive,
  restoreHistory,
  DEFAULT_TEMPLATES,
  RESUME_SCHEMA_HINT,
  HISTORY_LIMIT,
};
