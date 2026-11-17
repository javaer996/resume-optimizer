// 目标单位管理

import { el, field, textInput, textArea, selectInput } from './form.js';
import { $, $$, esc, toast, confirmDialog, openModal, download } from './util.js';

let getState = () => ({});
let refresh = () => {};
let saving = null;

export function init(ctx) {
  getState = ctx.getState;
  refresh = ctx.refresh;
  saving = ctx.saveCompanies;
}

/**
 * 表单只要求用户提供两样东西：单位名称、招聘要求。
 * 其余字段（单位简介 / 重点考察范围 / 注意事项 / 风格偏好 / 岗位职责）由「调研」自动补齐，
 * 补齐后仍然可改——自动结果不保证准确，用户永远是最终决策者。
 */
const PRIMARY = [
  { key: 'name', label: '单位名称', ph: '例如：某某银行科技部', required: true },
  { key: 'position', label: '应聘职位', ph: '例如：高级前端工程师' },
  {
    key: 'requirements',
    label: '招聘要求',
    ph: '把招聘启事里的岗位职责与任职要求整段粘进来即可，格式不限。\n例如：\n1. 负责核心交易系统前端开发；\n2. 5 年以上前端经验，熟悉 React 生态；\n3. 有性能优化实战经验。',
    type: 'area',
    rows: 7,
  },
];

const DERIVED = [
  { key: 'intro', label: '单位简介', rows: 3, ph: '业务方向、规模、行业地位…' },
  { key: 'focusAreas', label: '重点考察范围', rows: 3, ph: '面试大概率考察的能力维度…' },
  { key: 'cautions', label: '注意事项 / 红线', rows: 3, ph: '写作与投递时要避开的坑…' },
  { key: 'tone', label: '风格偏好', rows: 1, ph: '这家单位偏好的表达风格' },
  { key: 'duties', label: '岗位职责', rows: 3, ph: '从招聘要求里拆出来的职责条目' },
];

const BLANK = {
  name: '', position: '', intro: '', duties: '', requirements: '',
  focusAreas: '', cautions: '', tone: '', research: null,
};

export function render() {
  const root = $('#companies-root');
  const state = getState();
  root.innerHTML = '';

  const list = state.companies || [];
  const selected = new Set(state.selectedCompanies || []);

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap';
  const count = el('span', 'pill info', `已选 ${selected.size} / ${list.length}`);
  bar.appendChild(count);
  const selAll = el('button', 'btn sm', '全选');
  selAll.onclick = () => {
    state.selectedCompanies = list.map((c) => c.id);
    refresh();
  };
  const selNone = el('button', 'btn sm', '全不选');
  selNone.onclick = () => { state.selectedCompanies = []; refresh(); };
  bar.appendChild(selAll);
  bar.appendChild(selNone);
  root.appendChild(bar);

  if (!list.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, '还没有目标单位'));
    empty.appendChild(document.createTextNode('点击右上角「新建单位」，只填单位名称和招聘要求；也可以「批量导入」一次粘贴多个岗位'));
    root.appendChild(empty);
    return;
  }

  const grid = el('div', 'company-grid');
  list.forEach((c) => grid.appendChild(companyCard(c, selected.has(c.id))));
  root.appendChild(grid);
}

function companyCard(c, isSelected) {
  const card = el('div', `company-card${isSelected ? ' selected' : ''}`);

  const head = el('div', 'cc-head');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.style.marginTop = '3px';
  cb.checked = isSelected;
  cb.onchange = () => {
    const state = getState();
    const set = new Set(state.selectedCompanies || []);
    if (cb.checked) set.add(c.id); else set.delete(c.id);
    state.selectedCompanies = Array.from(set);
    refresh();
  };
  head.appendChild(cb);

  const titleWrap = el('div');
  titleWrap.style.flex = '1';
  titleWrap.appendChild(el('div', 'cc-name', c.name || '未命名单位'));
  titleWrap.appendChild(el('div', 'cc-pos', c.position || '未填写职位'));
  head.appendChild(titleWrap);
  card.appendChild(head);

  const meta = el('div', 'cc-meta');
  if (c.focusAreas) meta.appendChild(el('span', 'pill', `考察范围 ${short(c.focusAreas)}`));
  if (c.cautions) meta.appendChild(el('span', 'pill warn', '有注意事项'));
  if (c.requirements) meta.appendChild(el('span', 'pill', `要求 ${c.requirements.split('\n').filter(Boolean).length} 条`));
  // 只有名称和要求、还没调研过 —— 提示可以一键补齐
  if (!c.requirements && !c.duties) meta.appendChild(el('span', 'pill err', '未填写招聘要求'));
  if (c.research && c.research.at) {
    const conf = CONFIDENCE[c.research.confidence] || CONFIDENCE.low;
    meta.appendChild(el('span', `pill ${conf.cls}`, conf.text));
  } else if (c.name && !hasIntel(c)) {
    meta.appendChild(el('span', 'pill info', '待调研'));
  }
  card.appendChild(meta);

  const foot = el('div', 'cc-foot');
  const edit = el('button', 'btn sm', '编辑');
  edit.onclick = () => editDialog(c);
  // 没有情报时给一个最省事的入口，直接补齐
  if (!hasIntel(c)) {
    const fill = el('button', 'btn sm primary', '补齐情报');
    fill.onclick = async () => {
      fill.disabled = true;
      fill.textContent = '调研中…';
      try {
        const out = await runResearch(c);
        const n = Object.entries(out.intel || {})
          .filter(([k, v]) => ['intro', 'focusAreas', 'cautions', 'tone'].includes(k) && String(v || '').trim()).length;
        await saving({
          ...c,
          intro: out.intel.intro || '',
          focusAreas: out.intel.focusAreas || '',
          cautions: out.intel.cautions || '',
          tone: out.intel.tone || '',
          research: {
            engine: out.engine, confidence: out.intel.confidence,
            sources: out.intel.sources || [], at: new Date().toISOString(),
            warning: out.warning || '',
          },
        });
        toast(`已补齐 ${n} 项情报，点「编辑」可核对修改`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        fill.disabled = false;
        fill.textContent = '补齐情报';
      }
    };
    foot.appendChild(fill);
  }
  const dup = el('button', 'btn sm', '复制');
  dup.onclick = async () => {
    const state = getState();
    const copy = { ...c, id: '', name: `${c.name}（副本）` };
    await saving(copy);
    toast('已复制单位', 'ok');
  };
  const del = el('button', 'btn sm danger', '删除');
  del.onclick = async () => {
    if (!(await confirmDialog(`确定删除「${c.name}」？该操作不可撤销。`, { danger: true, okText: '删除' }))) return;
    await fetch('/api/companies/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }),
    });
    const state = getState();
    state.selectedCompanies = (state.selectedCompanies || []).filter((x) => x !== c.id);
    await refresh();
    toast('已删除', 'ok');
  };
  foot.appendChild(edit);
  foot.appendChild(dup);
  foot.appendChild(del);
  card.appendChild(foot);
  return card;
}

function short(s, n = 12) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

/** 调一次调研接口，失败抛错交给调用方处理 */
async function runResearch(company) {
  const res = await fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: String(company.name || '').trim(),
      position: String(company.position || '').trim(),
      requirements: company.requirements || '',
    }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || '调研失败');
  return out;
}

export function newCompanyDialog() {
  editDialog(null);
}

export function editDialog(company) {
  const draft = company ? { ...company } : { ...BLANK };
  const wrap = el('div');

  /* ---- 一、你只需要填这些 ---- */
  wrap.appendChild(grid2(
    field('单位名称 *', textInput(draft.name, PRIMARY[0].ph, (v) => { draft.name = v; })),
    field('应聘职位', textInput(draft.position, PRIMARY[1].ph, (v) => { draft.position = v; })),
  ));
  const reqField = field('招聘要求', textArea(draft.requirements, PRIMARY[2].ph, (v) => { draft.requirements = v; }, { rows: 7 }),
    '岗位职责和任职要求一起粘贴就行，不用整理格式——调研时会自动拆分。');
  reqField.style.marginTop = '12px';
  wrap.appendChild(reqField);

  /* ---- 二、调研条 ---- */
  const bar = el('div', 'research-bar');
  const runBtn = el('button', 'btn primary sm', company && company.intro ? '重新调研' : '自动补齐单位情报');
  const status = el('div', 'rs-status', '');
  bar.appendChild(runBtn);
  bar.appendChild(status);
  wrap.appendChild(bar);

  /* ---- 三、调研结果（可展开可改） ---- */
  const derivedBox = el('div', 'derived-box');
  const derivedTitle = el('div', 'group-title', '单位情报');
  derivedBox.appendChild(derivedTitle);

  const badgeRow = el('div', 'rs-badges');
  derivedBox.appendChild(badgeRow);

  const derivedInputs = {};
  for (const f of DERIVED) {
    const ctl = f.rows > 1
      ? textArea(draft[f.key], f.ph || '', (v) => { draft[f.key] = v; }, { rows: f.rows })
      : textInput(draft[f.key], f.ph || '', (v) => { draft[f.key] = v; });
    derivedInputs[f.key] = ctl;
    const fd = field(f.label, ctl);
    fd.style.marginTop = '12px';
    derivedBox.appendChild(fd);
    // 自动填入的内容用淡淡底色标一下，让人一眼看出"这是机器写的，我没确认"
    if (draft[f.key]) ctl.classList.add('auto-filled');
  }

  const sourceBox = el('div', 'rs-sources');
  derivedBox.appendChild(sourceBox);
  wrap.appendChild(derivedBox);

  const showDerived = (on) => { derivedBox.style.display = on ? '' : 'none'; };
  showDerived(hasIntel(draft));

  /* 把一次调研结果写回表单 */
  const applyIntel = (out) => {
    const intel = out.intel || {};
    const filled = [];
    for (const f of DERIVED) {
      const v = String(intel[f.key] || '').trim();
      if (!v) continue;
      draft[f.key] = v;
      if (derivedInputs[f.key]) {
        derivedInputs[f.key].value = v;
        derivedInputs[f.key].classList.add('auto-filled');
      }
      filled.push(f.label);
    }
    const at = new Date().toISOString();
    draft.research = {
      engine: out.engine || '',
      confidence: intel.confidence || 'low',
      sources: intel.sources || [],
      at,
      warning: out.warning || '',
    };
    renderBadges(badgeRow, draft, out);
    renderSources(sourceBox, intel.sources || []);
    showDerived(hasIntel(draft));
    return filled;
  };

  if (hasIntel(draft)) {
    renderBadges(badgeRow, draft, null);
    renderSources(sourceBox, (draft.research && draft.research.sources) || []);
  }

  runBtn.onclick = async () => {
    if (!draft.name.trim()) { toast('请先填写单位名称', 'err'); return; }
    runBtn.disabled = true;
    const label = runBtn.textContent;
    runBtn.textContent = '正在搜索并整理…';
    status.innerHTML = '<span class="spinner"></span>先搜公开网页，再整理成情报，大约 5–15 秒';
    try {
      const out = await runResearch(draft);
      const filled = applyIntel(out);
      // 报"用上的"而不是"搜到的"：搜到 20 条里有 14 条是噪音时，
      // 说"参考 20 条网页"等于替噪音背书
      const n = typeof out.used === 'number'
        ? out.used
        : (out.samples || []).reduce((a, s2) => a + (s2.results || []).length, 0);
          // 没搜到对口资料时不假装"参考了 N 条"：N 是噪音条数，说出来等于替噪音背书
      status.textContent = filled.length
        ? (n ? `已补全 ${filled.length} 项（参考 ${n} 条网页），请核对后再用`
          : `已补全 ${filled.length} 项，但没搜到对口的公开资料——这些是按岗位方向推断的，请自行核实`)
        : `没搜到对口的公开资料，没能整理出情报，建议手动填写以上字段`;
      if (out.warning) toast(out.warning, 'warn');
    } catch (err) {
      status.textContent = `调研失败：${err.message}`;
      toast(err.message, 'err');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = label;
    }
  };

  /* ---- 四、说明与按钮 ---- */
  const tip = el('div', 'tip');
  tip.style.marginTop = '14px';
  tip.innerHTML = '调研只会把<b>单位名称与岗位方向</b>发给搜索引擎和 AI，不包含你的简历、姓名或联系方式。'
    + '「单位名称」是目标公司，不会脱敏（否则无法做针对性优化）；你的<b>上家公司名</b>会脱敏为 [COMPANY_n]。';
  wrap.appendChild(tip);

  const foot = document.createElement('div');
  const cancel = el('button', 'btn', '取消');
  const save = el('button', 'btn primary', company ? '保存修改' : '创建单位');
  foot.appendChild(cancel);
  foot.appendChild(save);

  const m = openModal({ title: company ? '编辑单位' : '新建单位', body: wrap, footer: foot, width: '820px' });
  cancel.onclick = () => m.close();
  save.onclick = async () => {
    if (!draft.name.trim()) { toast('请填写单位名称', 'err'); return; }
    save.disabled = true;
    try {
      await saving(draft);
      m.close();
      toast(company ? '已保存' : '已创建', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  };
}

function grid2(a, b) {
  const g = el('div', 'grid grid-2');
  g.appendChild(a);
  g.appendChild(b);
  return g;
}

/** 这份单位是否已经有调研来的内容 */
function hasIntel(c) {
  return !!(c && (c.intro || c.focusAreas || c.cautions || (c.research && c.research.at)));
}

const CONFIDENCE = {
  high: { cls: 'ok', text: '依据较充分' },
  medium: { cls: 'info', text: '部分推断' },
  low: { cls: 'warn', text: '推断为主，请核对' },
};

/** 置信度、来源数量、调研时间 */
function renderBadges(host, draft, out) {
  host.innerHTML = '';
  const r = draft.research || {};
  const conf = CONFIDENCE[r.confidence] || CONFIDENCE.low;
  host.appendChild(el('span', `pill ${conf.cls}`, conf.text));
  if (r.engine === 'search+ai') host.appendChild(el('span', 'pill info', '搜索 + AI 归纳'));
  else if (r.engine === 'search-only') host.appendChild(el('span', 'pill warn', '仅搜索摘要，未经归纳'));
  const srcCount = (r.sources || []).length;
  if (srcCount) host.appendChild(el('span', 'pill', `参考 ${srcCount} 条`));
  if (r.at) {
    const d = new Date(r.at);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    host.appendChild(el('span', 'pill', `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} 调研`));
  }
  if (out && out.warning) host.appendChild(el('span', 'pill err', out.warning));
}

/** 参考来源：只列标题，鼠标悬停看完整标题（不贴 URL，避免一堆长链接撑破布局） */
function renderSources(host, sources) {
  host.innerHTML = '';
  const list = (sources || []).filter(Boolean);
  if (!list.length) return;
  host.appendChild(el('div', 'rs-src-title', '参考来源'));
  const wrap = el('div', 'rs-src-list');
  for (const s of list.slice(0, 6)) {
    const tag = el('span', 'rs-src', String(s).slice(0, 46));
    tag.title = String(s);
    wrap.appendChild(tag);
  }
  host.appendChild(wrap);
}

/** 批量导入：一行一个单位名，或「单位名 | 职位」，用 --- 分隔多段详细内容 */
export function importDialog() {
  const ta = document.createElement('textarea');
  ta.className = 'code';
  ta.rows = 16;
  ta.placeholder = `格式一（每行一个单位）：
某某银行 | 高级前端工程师
某某证券 | 前端开发

格式二（用 === 分隔多个单位的详细信息）：
单位名称：某某银行
应聘职位：高级前端工程师
岗位职责：
1. 负责核心交易系统前端开发
2. 推动前端工程化建设
任职要求：
1. 5 年以上前端经验
2. 熟悉 React 生态
重点考察范围：性能优化、框架原理
注意事项：不要出现竞品公司名

===

单位名称：某某证券
应聘职位：前端开发
岗位职责：
...`;

  const foot = document.createElement('div');
  const autoWrap = document.createElement('label');
  autoWrap.style.cssText = 'display:flex;align-items:center;gap:7px;margin-right:auto;font-size:13px;color:var(--muted);cursor:pointer';
  const autoCb = document.createElement('input');
  autoCb.type = 'checkbox';
  autoCb.checked = true;
  autoWrap.appendChild(autoCb);
  autoWrap.appendChild(document.createTextNode('导入后自动调研单位情报'));
  foot.appendChild(autoWrap);
  const cancel = el('button', 'btn', '取消');
  const ok = el('button', 'btn primary', '解析并导入');
  foot.appendChild(cancel);
  foot.appendChild(ok);

  const m = openModal({ title: '批量导入单位', body: ta, footer: foot, width: '820px' });
  cancel.onclick = () => m.close();
  ok.onclick = async () => {
    const parsed = parseBulk(ta.value);
    if (!parsed.length) { toast('没有解析出任何单位，请检查格式', 'err'); return; }
    ok.disabled = true;
    const auto = autoCb.checked;
    try {
      let done = 0;
      for (const p of parsed) {
        done += 1;
        // 只要名称在就能建；调研失败不影响保存
        let record = p;
        if (auto && p.name) {
          ok.textContent = `调研中 ${done}/${parsed.length}…`;
          try {
            const out = await runResearch(p);
            record = {
              ...p,
              intro: out.intel.intro || p.intro || '',
              focusAreas: out.intel.focusAreas || p.focusAreas || '',
              cautions: out.intel.cautions || p.cautions || '',
              tone: out.intel.tone || p.tone || '',
              research: {
                engine: out.engine, confidence: out.intel.confidence,
                sources: out.intel.sources || [], at: new Date().toISOString(),
                warning: out.warning || '',
              },
            };
          } catch (_) { /* 调研失败就用原样数据保存 */ }
        }
        await saving(record);
      }
      m.close();
      toast(auto ? `已导入 ${parsed.length} 个单位并补齐情报` : `已导入 ${parsed.length} 个单位`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      ok.disabled = false;
      ok.textContent = '解析并导入';
    }
  };
}

const KEY_MAP = [
  [/^(单位名称|公司名称|公司|单位)\s*[:：]/, 'name'],
  [/^(应聘职位|职位|岗位)\s*[:：]/, 'position'],
  [/^(单位简介|公司简介|简介|公司介绍)\s*[:：]/, 'intro'],
  [/^(岗位职责|工作职责|职责|工作内容)\s*[:：]/, 'duties'],
  [/^(任职要求|岗位要求|要求|资格)\s*[:：]/, 'requirements'],
  [/^(重点考察范围|考察范围|考察重点|面试重点)\s*[:：]/, 'focusAreas'],
  [/^(注意事项|红线|备注|特别说明)\s*[:：]/, 'cautions'],
  [/^(风格偏好|风格|语气)\s*[:：]/, 'tone'],
];

export function parseBulk(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // 格式二优先：含「单位名称：」这类键
  if (/^(单位名称|公司名称|公司|单位)\s*[:：]/m.test(raw)) {
    const chunks = raw.split(/\n\s*={3,}\s*\n/);
    const out = [];
    for (const chunk of chunks) {
      const c = { name: '', position: '', intro: '', duties: '', requirements: '', focusAreas: '', cautions: '', tone: '' };
      let currentKey = null;
      const buffers = {};
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (currentKey) buffers[currentKey] += '\n';
          continue;
        }
        let matched = false;
        for (const [re, key] of KEY_MAP) {
          if (re.test(trimmed)) {
            currentKey = key;
            buffers[key] = trimmed.replace(re, '').trim();
            matched = true;
            break;
          }
        }
        if (matched) continue;
        if (currentKey) buffers[currentKey] += (buffers[currentKey] ? '\n' : '') + trimmed.replace(/^[\-•\d.、)]+\s*/, '');
      }
      for (const [k, v] of Object.entries(buffers)) c[k] = String(v).trim();
      if (c.name) out.push(c);
    }
    if (out.length) return out;
  }

  // 格式一：每行「单位 | 职位」
  return raw.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*[|｜]\s*/);
      return {
        name: parts[0] || '', position: parts[1] || '',
        intro: '', duties: '', requirements: '', focusAreas: '', cautions: '', tone: '',
      };
    })
    .filter((c) => c.name);
}

export function exportCompanies() {
  const state = getState();
  const blob = new Blob([JSON.stringify(state.companies || [], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '目标单位.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
