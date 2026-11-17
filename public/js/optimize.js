// 批量优化：选择单位 / 模板 / 供应商，发起任务并轮询进度

import { el, field, textInput, textArea, selectInput, switchInput } from './form.js';
import { $, esc, toast, api, fmtTime, openModal, clone } from './util.js';

let getState = () => ({});
let refresh = () => {};
let switchView = () => {};

export function init(ctx) {
  getState = ctx.getState;
  refresh = ctx.refresh;
  switchView = ctx.switchView || (() => {});
}

let pollTimer = null;

/// 选择状态的局部刷新引用：只改文本与禁用态，避免整页重渲染导致焦点/选中态丢失
let selRefs = null;

function syncSelection() {
  if (!selRefs) return;
  const s = getState();
  const n = (s.selectedCompanies || []).length;
  if (selRefs.sub) selRefs.sub.textContent = `共 ${s.companies.length} 个，已选 ${n} 个`;
  if (selRefs.startBtn) {
    selRefs.startBtn.textContent = `为 ${n} 个单位生成简历`;
    selRefs.startBtn.disabled = n === 0;
  }
  if (selRefs.previewBtn) selRefs.previewBtn.disabled = n === 0;
  if (selRefs.est) selRefs.est.textContent = `预计发起 ${n} 次模型调用`;
}

export function render() {
  const root = $('#optimize-root');
  const s = getState();
  root.innerHTML = '';
  selRefs = null;

  if (!s.companies.length) {
    const tip = el('div', 'tip warn');
    tip.innerHTML = '还没有目标单位。请先到「目标单位」页添加，或点击下方按钮快速创建。';
    root.appendChild(tip);
    const b = el('button', 'btn primary');
    b.textContent = '去添加目标单位';
    b.style.marginTop = '12px';
    b.onclick = () => switchView('companies');
    root.appendChild(b);
    return;
  }

  /* --- 第一步：选单位 --- */
  const c1 = card('1. 选择目标单位', `共 ${s.companies.length} 个，已选 ${(s.selectedCompanies || []).length} 个`);
  const grid = el('div');
  grid.style.cssText = 'display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))';
  s.companies.forEach((c) => {
    const label = el('label');
    label.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--border);border-radius:7px;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (s.selectedCompanies || []).includes(c.id);
    cb.onchange = () => {
      const set = new Set(s.selectedCompanies || []);
      if (cb.checked) set.add(c.id); else set.delete(c.id);
      s.selectedCompanies = Array.from(set);
      label.style.borderColor = cb.checked ? 'var(--accent)' : 'var(--border)';
      syncSelection();
    };
    label.appendChild(cb);
    const box = el('div');
    box.appendChild(el('div', null, c.name || '未命名'));
    box.appendChild(el('div', 'small muted', c.position || '未填写职位'));
    label.appendChild(box);
    if (cb.checked) label.style.borderColor = 'var(--accent)';
    grid.appendChild(label);
  });
  c1.body.appendChild(grid);
  const quick = el('div');
  quick.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const all = el('button', 'btn sm', '全选');
  all.onclick = () => { s.selectedCompanies = s.companies.map((c) => c.id); render(); };
  const none = el('button', 'btn sm', '全不选');
  none.onclick = () => { s.selectedCompanies = []; render(); };
  quick.appendChild(all);
  quick.appendChild(none);
  c1.body.appendChild(quick);
  root.appendChild(c1.card);

  /* --- 第二步：模板与供应商 --- */
  const c2 = card('2. 选择提示词模板与 AI 供应商');
  const tplSel = selectInput(
    s.prompts.activeTemplateId,
    s.prompts.templates.map((t) => ({ value: t.id, label: t.name })),
    (v) => { s.prompts.activeTemplateId = v; api('/api/prompts', { action: 'activate', id: v }); render(); },
  );
  const provSel = selectInput(
    s.providers.activeId,
    s.providers.providers.map((p) => ({
      value: p.id,
      label: `${p.name}${p.model ? `（${p.model}）` : ''}${p.protocol === 'mock' ? ' · 离线' : ''}`,
    })),
    (v) => {
      s.providers.activeId = v;
      api('/api/providers', { providers: s.providers.providers, activeId: v });
      render();
    },
  );
  const g2 = el('div', 'grid grid-2');
  g2.appendChild(field('提示词模板', tplSel));
  g2.appendChild(field('AI 供应商', provSel));
  c2.body.appendChild(g2);

  const tpl = s.prompts.templates.find((t) => t.id === s.prompts.activeTemplateId);
  if (tpl && tpl.description) {
    const d = el('div', 'small muted');
    d.style.marginTop = '6px';
    d.textContent = tpl.description;
    c2.body.appendChild(d);
  }
  const prov = s.providers.providers.find((p) => p.id === s.providers.activeId);
  if (prov && prov.protocol === 'mock') {
    const t = el('div', 'tip warn');
    t.style.marginTop = '10px';
    t.innerHTML = '当前使用<b>内置模拟器</b>：无需 API Key，可完整跑通流程，但优化内容为规则生成的演示结果。'
      + '要获得真实效果，请到「AI 供应商」页配置你自己的模型服务。';
    c2.body.appendChild(t);
  }
  root.appendChild(c2.card);

  /* --- 第三步：附加指令 --- */
  const c3 = card('3. 附加要求（可选）', '会追加到提示词末尾，作用于本批全部单位');
  const extra = textArea(s.optimizeExtra || '', '例如：每段经历控制在 3 条以内；突出团队管理经验；不要使用「赋能」「抓手」等词…', (v) => {
    getState().optimizeExtra = v;
  }, { rows: 3 });
  c3.body.appendChild(extra);
  root.appendChild(c3.card);

  /* --- 执行区 --- */
  const c4 = card('4. 开始优化');
  const selectedCount = (s.selectedCompanies || []).length;
  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';

  const startBtn = el('button', 'btn primary', `为 ${selectedCount} 个单位生成简历`);
  startBtn.disabled = selectedCount === 0;
  startBtn.onclick = () => startJob(selectedCount);
  bar.appendChild(startBtn);

  const previewBtn = el('button', 'btn', '预览发给 AI 的内容');
  previewBtn.disabled = selectedCount === 0;
  previewBtn.onclick = () => previewPrompt();
  bar.appendChild(previewBtn);

  const est = el('span', 'small muted', `预计发起 ${selectedCount} 次模型调用`);
  bar.appendChild(est);
  c4.body.appendChild(bar);

  const info = el('div', 'tip');
  info.style.marginTop = '12px';
  info.innerHTML = '每个单位会单独调用一次 AI，生成一版专属简历。姓名、手机号、邮箱、学校、地址、'
    + '公司名等敏感信息在发送前会被替换成 [NAME_1] 这样的占位符，AI 返回后再自动还原成真实内容。';
  c4.body.appendChild(info);
  root.appendChild(c4.card);

  selRefs = { sub: c1.subEl, startBtn, previewBtn, est };
  syncSelection();

  /* --- 进行中的任务 --- */
  const running = (s.jobs || []).filter((j) => j.status === 'running');
  if (running.length) {
    const c5 = card('进行中的任务');
    running.forEach((j) => {
      const row = el('div');
      row.style.marginBottom = '12px';
      const head = el('div');
      head.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:6px';
      head.appendChild(el('strong', null, `${j.templateName || ''} · ${j.providerName || ''}`));
      head.appendChild(el('span', 'pill info', `${j.done + j.failed} / ${j.total}`));
      head.appendChild(el('span', 'small muted', fmtTime(j.createdAt)));
      const spacer = el('span');
      spacer.style.marginLeft = 'auto';
      head.appendChild(spacer);
      const cancel = el('button', 'btn sm danger', '取消');
      cancel.onclick = async () => {
        await fetch(`/api/jobs/${j.id}/cancel`, { method: 'POST' });
        toast('已请求取消');
      };
      head.appendChild(cancel);
      row.appendChild(head);

      const p = el('div', 'progress');
      const inner = document.createElement('i');
      inner.style.width = `${Math.round(((j.done + j.failed) / Math.max(1, j.total)) * 100)}%`;
      p.appendChild(inner);
      row.appendChild(p);

      const list = el('div', 'small muted');
      list.style.marginTop = '6px';
      list.textContent = j.items.map((it) => `${it.companyName || '—'}${statusMark(it.status)}`).join('  ·  ');
      row.appendChild(list);
      c5.body.appendChild(row);
    });
    root.appendChild(c5.card);
    ensurePolling();
  }
}

function statusMark(status) {
  return { pending: '⏳', running: '⏳', done: '✓', failed: '✗', skipped: '—' }[status] || '';
}

function card(title, sub) {
  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.appendChild(el('h3', null, title));
  const subEl = sub ? el('span', 'sub', sub) : null;
  if (subEl) h.appendChild(subEl);
  const b = el('div', 'card-body');
  c.appendChild(h);
  c.appendChild(b);
  return { card: c, body: b, subEl };
}

async function startJob(count) {
  const s = getState();
  try {
    const res = await api('/api/optimize', {
      profile: s.profile,
      companyIds: s.selectedCompanies,
      templateId: s.prompts.activeTemplateId,
      providerId: s.providers.activeId,
      extraInstruction: s.optimizeExtra || '',
      switches: s.settings.switches,
      customRules: s.settings.customRules,
    });
    toast(`已发起 ${count} 个优化任务，正在后台执行`, 'ok');
    s.activeJobId = res.job.id;
    await refresh();
    switchView('results');
  } catch (err) {
    toast(`发起失败：${err.message}`, 'err');
  }
}

export function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const s = getState();
    const hasRunning = (s.jobs || []).some((j) => j.status === 'running');
    if (!hasRunning) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const sig = () => (s.jobs || []).map((j) => `${j.id}:${j.done}:${j.failed}:${j.status}`
      + `:${(j.items || []).map((i) => `${i.status}${i.stage || ''}`).join(',')}`).join('|');
    const before = sig();
    try {
      const data = await api('/api/state');
      Object.assign(s, { jobs: data.jobs });
      const after = sig();
      if (before !== after) {
        const cur = s.currentView;
        if (cur === 'optimize') render();
        else if (cur === 'results') {
          const mod = getState().__resultsRender;
          if (typeof mod === 'function') mod();
        }
      }
      const stillRunning = (s.jobs || []).some((j) => j.status === 'running');
      if (!stillRunning) {
        toast('优化任务已全部结束', 'ok');
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (_) { /* 网络抖动忽略，下次再试 */ }
  }, 1800);
}

async function previewPrompt() {
  const s = getState();
  const companyId = (s.selectedCompanies || [])[0];
  if (!companyId) return;
  try {
    const res = await api('/api/preview', {
      profile: s.profile,
      companyId,
      templateId: s.prompts.activeTemplateId,
      providerId: s.providers.activeId,
      switches: s.settings.switches,
      customRules: s.settings.customRules,
      extraInstruction: s.optimizeExtra || '',
    });
    showPreview(res, s.companies.find((c) => c.id === companyId));
  } catch (err) {
    toast(`预览失败：${err.message}`, 'err');
  }
}

export function showPreview(res, company) {
  const wrap = el('div');
  const tip = el('div', 'tip');
  tip.innerHTML = `以下内容将<b>原样发送</b>给 AI。可以看到姓名、电话等已被替换为占位符；`
    + `目标单位「${esc(company ? company.name : '')}」的名字会保留，以便 AI 做针对性优化。`;
  wrap.appendChild(tip);

  const tabs = el('div', 'seg');
  tabs.style.margin = '12px 0';
  const panes = {};
  ['system', 'user', 'mask'].forEach((k) => {
    const pane = el('div');
    pane.style.display = 'none';
    panes[k] = pane;
  });

  const renderMsg = (msg) => {
    const box = el('div');
    box.style.marginBottom = '10px';
    box.appendChild(el('div', 'small muted', msg.role === 'system' ? 'System 提示词' : 'User 提示词'));
    const pre = el('pre', 'code');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:#fafbfc;border:1px solid var(--border);border-radius:6px;padding:10px;max-height:420px;overflow:auto;font-size:12.5px;margin:4px 0 0';
    pre.textContent = msg.content;
    box.appendChild(pre);
    return box;
  };
  res.messages.forEach((m) => panes[m.role === 'system' ? 'system' : 'user'].appendChild(renderMsg(m)));

  const table = el('table', 'mask-table');
  table.innerHTML = '<thead><tr><th>类型</th><th>原始值</th><th>替换为</th></tr></thead>';
  const tb = document.createElement('tbody');
  (res.maskReport || []).forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(r.label)}</td><td>${esc(r.value)}</td><td class="token">[${esc(r.token)}]</td>`;
    tb.appendChild(tr);
  });
  if (!(res.maskReport || []).length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="3" class="muted">本次没有需要脱敏的内容</td>';
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  panes.mask.appendChild(table);

  const seg = el('div', 'seg');
  const labels = { system: 'System 提示词', user: 'User 提示词', mask: `脱敏映射表（${(res.maskReport || []).length}）` };
  Object.keys(panes).forEach((k, idx) => {
    const b = el('button', idx === 0 ? 'on' : '', labels[k]);
    b.onclick = () => {
      Array.from(seg.children).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      Object.entries(panes).forEach(([kk, pp]) => { pp.style.display = kk === k ? '' : 'none'; });
    };
    seg.appendChild(b);
  });
  Object.entries(panes).forEach(([k, pp]) => { pp.style.display = k === 'system' ? '' : 'none'; });

  wrap.appendChild(seg);
  Object.values(panes).forEach((p) => wrap.appendChild(p));

  openModal({ title: '发送给 AI 的完整内容（已脱敏）', body: wrap, width: '900px' });
}
