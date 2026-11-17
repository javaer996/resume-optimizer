// 优化结果：查看 / 编辑 / 导出

import { el, field, textInput, textArea, listSection, itemBlock, grid, linesToArray, arrayToLines } from './form.js';
import { $, esc, toast, api, download, fmtTime, fmtDuration, openModal, confirmDialog, clone, uid } from './util.js';
import { ensurePolling } from './optimize.js';

let getState = () => ({});
let refresh = () => {};
let switchView = () => {};

export function init(ctx) {
  getState = ctx.getState;
  refresh = ctx.refresh;
  switchView = ctx.switchView || (() => {});
  getState().__resultsRender = render;
}

let currentJob = null;
let currentItem = null;
let previewHtml = '';
let previewOpts = null;

export function render() {
  const root = $('#results-root');
  const s = getState();
  root.innerHTML = '';

  const jobs = s.jobs || [];
  if (!jobs.length) {
    const c = el('div', 'card');
    const b = el('div', 'card-body');
    const empty = el('div', 'empty');
    empty.appendChild(el('strong', null, '还没有优化结果'));
    empty.appendChild(document.createTextNode('先到「批量优化」页发起一次任务'));
    b.appendChild(empty);
    c.appendChild(b);
    root.appendChild(c);
    return;
  }

  if (!currentJob || !jobs.find((j) => j.id === currentJob)) {
    currentJob = s.activeJobId && jobs.find((j) => j.id === s.activeJobId) ? s.activeJobId : jobs[0].id;
  }

  const layout = el('div', 'result-layout');

  /* 左：任务列表 */
  const left = el('div', 'card');
  const lh = el('div', 'card-head');
  lh.appendChild(el('h3', null, '优化任务'));
  left.appendChild(lh);
  const lb = el('div', 'card-body tight');
  const listEl = el('div', 'job-list');
  jobs.forEach((j) => {
    const item = el('div', `job-item${j.id === currentJob ? ' active' : ''}`);
    item.appendChild(el('div', 'ji-title', `${j.templateName || '模板'} · ${j.providerName || ''}`));
    const meta = el('div', 'ji-meta');
    const failPart = j.failed ? ` · ${j.failed} 个失败` : '';
    meta.textContent = `${fmtTime(j.createdAt)} · ${j.done}/${j.total} 完成${failPart}${j.status === 'running' ? ' · 进行中' : ''}`;
    item.appendChild(meta);
    if (j.status === 'finished_with_errors') item.classList.add('has-error');
    if (j.status === 'running') {
      const p = el('div', 'progress');
      p.style.marginTop = '6px';
      const inner = document.createElement('i');
      inner.style.width = `${Math.round(((j.done + j.failed) / Math.max(1, j.total)) * 100)}%`;
      p.appendChild(inner);
      item.appendChild(p);
    }
    item.onclick = () => {
      currentJob = j.id;
      currentItem = null;
      previewHtml = '';
      render();
    };
    listEl.appendChild(item);
  });
  lb.appendChild(listEl);
  left.appendChild(lb);
  layout.appendChild(left);

  /* 中：结果 */
  const job = jobs.find((j) => j.id === currentJob);
  const middle = el('div');
  layout.appendChild(middle);

  if (!job) return;

  if (!currentItem || !job.items.find((i) => i.companyId === currentItem)) {
    const first = job.items.find((i) => i.status === 'done' && i.hasResult);
    currentItem = first ? first.companyId : (job.items[0] && job.items[0].companyId);
  }

  /* 单位切换条 */
  const switcher = el('div', 'card');
  const swBody = el('div', 'card-body tight');
  const tabs = el('div');
  tabs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  job.items.forEach((it) => {
    const b = el('button', `btn sm${it.companyId === currentItem ? ' primary' : ''}`);
    b.textContent = `${it.companyName || '单位'}${it.status === 'done' ? '' : ` · ${statusText(it.status, it.stage)}`}`;
    b.disabled = it.status !== 'done' || !it.hasResult;
    b.onclick = () => { currentItem = it.companyId; previewHtml = ''; render(); };
    tabs.appendChild(b);
  });
  swBody.appendChild(tabs);
  if (job.status === 'running') {
    const tip = el('div', 'small muted');
    tip.style.marginTop = '8px';
    tip.textContent = '任务进行中，结果会自动刷新…';
    swBody.appendChild(tip);
  }
  if (job.status === 'finished_with_errors') {
    const t = el('div', 'small');
    t.style.cssText = 'margin-top:8px;color:#b42318';
    t.textContent = `有 ${job.failed} 个项目未成功，其余结果可正常查看与导出。`;
    t.style.display = 'flex';
    t.style.alignItems = 'center';
    t.style.gap = '8px';
    const retryBtn = el('button', 'btn sm', '重试失败项');
    retryBtn.onclick = async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = '正在重试…';
      try {
        const res = await api(`/api/jobs/${job.id}/retry`, {});
        getState().activeJobId = res.job.id;
        fullCache.clear();
        await refresh();
        switchView('results');
        ensurePolling();
        toast('已重新发起失败项', 'ok');
      } catch (err) {
        toast(`重试失败：${err.message}`, 'err');
        retryBtn.disabled = false;
        retryBtn.textContent = '重试失败项';
      }
    };
    t.appendChild(retryBtn);
    swBody.appendChild(t);
  }
  switcher.appendChild(swBody);
  middle.appendChild(switcher);

  const itemSummary = job.items.find((i) => i.companyId === currentItem);
  if (!itemSummary) { layout.appendChild(el('div')); return; }

  if (itemSummary.status === 'failed') {
    const c = el('div', 'card');
    const b = el('div', 'card-body');
    const t = el('div', 'tip err');
    t.textContent = `该单位优化失败：${itemSummary.error || '未知错误'}`;
    b.appendChild(t);
    c.appendChild(b);
    middle.appendChild(c);
    layout.appendChild(el('div'));
    root.appendChild(layout);
    return;
  }
  if (!itemSummary.hasResult) {
    const c = el('div', 'card');
    const b = el('div', 'card-body');
    const waiting = itemSummary.status === 'running'
      ? (itemSummary.stage === 'research'
        ? '正在搜索并整理这家单位的情报，随后开始优化简历…'
        : '正在生成…')
      : '等待生成…';
    b.appendChild(el('div', 'empty', waiting));
    c.appendChild(b);
    middle.appendChild(c);
    layout.appendChild(el('div'));
    root.appendChild(layout);
    return;
  }

  loadFull(job.id, currentItem).then((data) => {
    if (!data) return;
    currentItemData = data.item;
    currentJobData = data.job;
    renderMiddle(middle, data.job, data.item);
    renderRight(layout, data.job, data.item);
  });

  root.appendChild(layout);
}

let currentJobData = null;
let currentItemData = null;
const fullCache = new Map();

async function loadFull(jobId, companyId) {
  const key = `${jobId}:${companyId}`;
  if (!fullCache.has(key)) {
    try {
      const res = await api(`/api/jobs/${jobId}?full=1`);
      const job = res.job;
      const item = job.items.find((i) => i.companyId === companyId);
      if (!item || !item.result) return null;
      fullCache.set(key, { job, item });
      return { job, item };
    } catch (err) {
      toast(`加载结果失败：${err.message}`, 'err');
      return null;
    }
  }
  return fullCache.get(key);
}

function statusText(s, stage) {
  // 调研阶段单独说清楚：否则用户只看到"进行中"卡十几秒，以为程序死了
  if (s === 'running' && stage === 'research') return '调研单位情报';
  return { pending: '待执行', running: '进行中', done: '已完成', failed: '失败', skipped: '已跳过' }[s] || s;
}

function renderMiddle(middle, job, item) {
  const s = getState();
  const r = item.result;
  const settings = s.settings.export || {};

  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.appendChild(el('h3', null, `${r.company.name || ''}${r.company.position ? ` · ${r.company.position}` : ''}`));
  const right = el('div', 'right');

  const editBtn = el('button', 'btn sm', '编辑内容');
  editBtn.onclick = () => openEditor(job, item);
  right.appendChild(editBtn);

  const themeSel = document.createElement('select');
  themeSel.style.width = 'auto';
  (s.themes || []).forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    if ((previewOpts && previewOpts.theme) === t.id) o.selected = true;
    else if (!previewOpts && settings.theme === t.id) o.selected = true;
    themeSel.appendChild(o);
  });
  themeSel.onchange = () => {
    previewOpts = { ...(previewOpts || settings), theme: themeSel.value };
    previewHtml = '';
    render();
  };
  right.appendChild(themeSel);

  const pdfBtn = el('button', 'btn sm primary', '导出 PDF');
  pdfBtn.onclick = () => exportFile('pdf', job, item, previewOpts || settings);
  right.appendChild(pdfBtn);

  const moreBtn = el('button', 'btn sm', '更多…');
  moreBtn.onclick = () => openMoreMenu(job, item, previewOpts || settings);
  right.appendChild(moreBtn);

  h.appendChild(right);
  c.appendChild(h);

  const body = el('div', 'card-body');
  const frameWrap = el('div');
  frameWrap.style.position = 'relative';
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frameWrap.appendChild(frame);
  body.appendChild(frameWrap);
  c.appendChild(body);
  middle.appendChild(c);

  const opts = previewOpts || settings;
  if (previewHtml) {
    frame.srcdoc = previewHtml;
  } else {
    frame.srcdoc = '<div style="font:14px sans-serif;color:#94a3b8;padding:40px;text-align:center">正在渲染预览…</div>';
    fetch('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: r.resume, opts }),
    }).then((res) => res.text()).then((html) => {
      previewHtml = html;
      frame.srcdoc = html;
    }).catch((err) => {
      frame.srcdoc = `<div style="font:14px sans-serif;color:#b42318;padding:30px">预览失败：${esc(err.message)}</div>`;
    });
  }

  // 编辑时间提示
  if (r.editedAt) {
    const t = el('div', 'small muted');
    t.style.marginTop = '8px';
    t.textContent = `最后编辑：${fmtTime(r.editedAt)}`;
    body.appendChild(t);
  }
}

function renderRight(layout, job, item) {
  const r = item.result;
  const panel = el('div');
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.gap = '16px';

  /* 修改说明 */
  const c1 = el('div', 'card');
  const h1 = el('div', 'card-head');
  h1.appendChild(el('h3', null, 'AI 做了哪些修改'));
  c1.appendChild(h1);
  const b1 = el('div', 'card-body');
  if ((r.notes || []).length) {
    const list = el('div', 'notes-list');
    r.notes.forEach((n) => {
      const d = el('div', 'note');
      const sec = el('div', 'n-sec', n.section || '调整');
      d.appendChild(sec);
      if (n.reason) {
        const reason = el('div', null, n.reason);
        d.appendChild(reason);
      }
      if (n.after) {
        const diff = el('div', 'n-diff');
        if (n.before && n.before !== n.after) {
          diff.appendChild(el('span', 'n-before', n.before));
          diff.appendChild(document.createTextNode(' → '));
        }
        diff.appendChild(el('span', 'n-after', n.after));
        d.appendChild(diff);
      }
      list.appendChild(d);
    });
    b1.appendChild(list);
  } else {
    b1.appendChild(el('div', 'muted small', '本次没有记录到逐条修改说明。'));
  }
  c1.appendChild(b1);
  panel.appendChild(c1);

  /* 关键词 */
  if ((r.keywords || []).length) {
    const c2 = el('div', 'card');
    const h2 = el('div', 'card-head');
    h2.appendChild(el('h3', null, '已融入的关键词'));
    c2.appendChild(h2);
    const b2 = el('div', 'card-body');
    const wrap = el('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
    r.keywords.forEach((k) => wrap.appendChild(el('span', 'pill info', k)));
    b2.appendChild(wrap);
    c2.appendChild(b2);
    panel.appendChild(c2);
  }

  /* 单位信息 */
  if (r.company && (r.company.focusAreas || r.company.cautions)) {
    const c3 = el('div', 'card');
    const h3 = el('div', 'card-head');
    h3.appendChild(el('h3', null, '本版依据的单位信息'));
    c3.appendChild(h3);
    const b3 = el('div', 'card-body');
    if (r.company.focusAreas) {
      b3.appendChild(el('div', 'small muted', '重点考察范围'));
      b3.appendChild(el('div', null, r.company.focusAreas));
    }
    if (r.company.cautions) {
      const t = el('div', 'tip warn');
      t.style.marginTop = '8px';
      t.textContent = `注意事项：${r.company.cautions}`;
      b3.appendChild(t);
    }
    c3.appendChild(b3);
    panel.appendChild(c3);
  }

  /* 脱敏报告 */
  const c4 = el('div', 'card');
  const h4 = el('div', 'card-head');
  h4.appendChild(el('h3', null, `脱敏映射表（${(r.maskReport || []).length}）`));
  const collapse = el('button', 'btn ghost sm', '展开');
  const h4Right = el('div', 'right');
  h4Right.appendChild(collapse);
  h4.appendChild(h4Right);
  c4.appendChild(h4);
  const b4 = el('div', 'card-body');
  b4.style.display = 'none';
  if ((r.maskReport || []).length) {
    const tb = el('table', 'mask-table');
    tb.innerHTML = '<thead><tr><th>类型</th><th>真实值</th><th>占位符</th></tr></thead>';
    const tbody = document.createElement('tbody');
    r.maskReport.forEach((m) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(m.label)}</td><td>${esc(m.value)}</td><td class="token">[${esc(m.token)}]</td>`;
      tbody.appendChild(tr);
    });
    tb.appendChild(tbody);
    b4.appendChild(tb);
  } else {
    b4.appendChild(el('div', 'muted small', '本次没有需要脱敏的内容。'));
  }
  collapse.onclick = () => {
    const open = b4.style.display === 'none';
    b4.style.display = open ? '' : 'none';
    collapse.textContent = open ? '收起' : '展开';
  };
  c4.appendChild(b4);
  panel.appendChild(c4);

  /* 校验信息 */
  const c5 = el('div', 'card');
  const h5 = el('div', 'card-head');
  h5.appendChild(el('h3', null, '生成信息'));
  c5.appendChild(h5);
  const b5 = el('div', 'card-body');
  const kv = [
    ['生成时间', fmtTime(job.createdAt)],
    ['耗时', fmtDuration(item.elapsedMs)],
    ['模板', job.templateName || '—'],
    ['供应商', job.providerName || '—'],
    ['还原校验', (r.leaks || []).length ? `发现 ${r.leaks.length} 个未还原占位符` : '通过（无残留占位符）'],
  ];
  kv.forEach(([k, v]) => {
    const row = el('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:space-between;padding:3px 0;font-size:12.5px';
    row.appendChild(el('span', 'muted', k));
    row.appendChild(el('span', null, v));
    b5.appendChild(row);
  });
  if ((r.leaks || []).length) {
    const t = el('div', 'tip warn');
    t.style.marginTop = '8px';
    t.textContent = `检测到残留占位符：${r.leaks.join('、')}。请在编辑界面手动替换或重新生成。`;
    b5.appendChild(t);
  }
  c5.appendChild(b5);
  panel.appendChild(c5);

  layout.appendChild(panel);
}

/* ---------------- 导出 ---------------- */

async function exportFile(kind, job, item, opts) {
  const r = item.result;
  const base = `${r.company.name || '简历'}-${(r.resume.basics && r.resume.basics.name) || ''}`.replace(/^-+|-+$/g, '');
  const filename = `${base}-${job.id.slice(-4)}`;
  const path = { pdf: '/api/export/pdf', html: '/api/export/html', md: '/api/export/markdown' }[kind];
  const ext = { pdf: 'pdf', html: 'html', md: 'md' }[kind];
  try {
    toast(kind === 'pdf' ? '正在生成 PDF…' : '正在导出…');
    await download(path, { resume: r.resume, opts, filename }, `${filename}.${ext}`);
    toast('已导出', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function openMoreMenu(job, item, opts) {
  const wrap = el('div');
  const btnWrap = el('div');
  btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const mk = (label, desc, fn) => {
    const b = el('button', 'btn block');
    b.style.cssText = 'justify-content:flex-start;flex-direction:column;align-items:flex-start;padding:10px 14px;text-align:left';
    b.appendChild(el('span', null, label));
    b.appendChild(el('span', 'small muted', desc));
    b.onclick = fn;
    return b;
  };

  btnWrap.appendChild(mk('导出 HTML', '单文件，可直接用浏览器打开或打印', async () => {
    await exportFile('html', job, item, opts);
  }));
  btnWrap.appendChild(mk('导出 Markdown', '方便粘贴到其它平台', async () => {
    await exportFile('md', job, item, opts);
  }));
  btnWrap.appendChild(mk('复制纯文本', '适合粘贴到网申系统', async () => {
    const text = resumeToText(item.result.resume);
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'ok');
    } catch (_) {
      openModal({ title: '纯文本内容（请手动复制）', body: textArea(text, '', () => {}, { rows: 20 }) });
    }
  }));
  btnWrap.appendChild(mk('另存为我的简历', '用这版内容替换「我的简历」中的基础数据', async () => {
    if (!(await confirmDialog('将用这版优化结果覆盖「我的简历」的全部内容，确定继续？', { okText: '覆盖' }))) return;
    const s = getState();
    s.profile = clone(item.result.resume);
    await api('/api/profile', { profile: s.profile });
    await refresh();
    toast('已另存为我的简历', 'ok');
  }));
  btnWrap.appendChild(mk('重新生成这一份', '用相同单位与模板再跑一次', async () => {
    const s = getState();
    try {
      await api('/api/optimize', {
        profile: s.profile,
        companyIds: [item.companyId],
        templateId: job.templateId,
        providerId: job.providerId,
        switches: s.settings.switches,
        customRules: s.settings.customRules,
      });
      fullCache.clear();
      await refresh();
      toast('已重新发起', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }));

  wrap.appendChild(btnWrap);
  openModal({ title: '更多操作', body: wrap, width: '480px' });
}

function resumeToText(r) {
  const L = [];
  const b = r.basics || {};
  L.push(b.name || '');
  if (b.title) L.push(b.title);
  const contact = [b.phone, b.email, b.location].filter(Boolean).join(' | ');
  if (contact) L.push(contact);
  L.push('');
  if (b.summary) { L.push('【个人简介】', b.summary, ''); }
  if ((r.work || []).length) {
    L.push('【工作经历】');
    r.work.forEach((j) => {
      L.push(`${j.company} | ${j.position} | ${j.start} - ${j.end}`);
      (j.bullets || []).forEach((x) => L.push(`- ${x}`));
      L.push('');
    });
  }
  if ((r.projects || []).length) {
    L.push('【项目经历】');
    r.projects.forEach((p) => {
      L.push(`${p.name} | ${p.role} | ${p.start} - ${p.end}`);
      if ((p.tech || []).length) L.push(`技术栈：${p.tech.join('、')}`);
      (p.bullets || []).forEach((x) => L.push(`- ${x}`));
      L.push('');
    });
  }
  if ((r.education || []).length) {
    L.push('【教育经历】');
    r.education.forEach((e) => {
      L.push(`${e.school} | ${e.major} | ${e.degree} | ${e.start} - ${e.end}`);
    });
    L.push('');
  }
  if ((r.skills || []).length) {
    L.push('【专业技能】');
    r.skills.forEach((s) => L.push(`${s.category}：${(s.items || []).join('、')}`));
  }
  return L.join('\n');
}

/* ---------------- 编辑器 ---------------- */

function openEditor(job, item) {
  const draft = clone(item.result.resume);
  const wrap = el('div');

  const nav = el('div');
  nav.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px';
  const panes = {};
  const paneWrap = el('div');
  const names = [
    ['basics', '基本信息'], ['work', '工作'], ['projects', '项目'],
    ['education', '教育'], ['skills', '技能'], ['extra', '获奖/证书/其它'],
  ];
  names.forEach(([k], idx) => {
    const pane = el('div');
    pane.style.display = idx === 0 ? '' : 'none';
    panes[k] = pane;
    paneWrap.appendChild(pane);
    const b = el('button', `btn sm${idx === 0 ? ' primary' : ''}`, names[idx][1]);
    b.onclick = () => {
      Array.from(nav.children).forEach((x) => x.className = 'btn sm');
      b.className = 'btn sm primary';
      Object.entries(panes).forEach(([kk, pp]) => { pp.style.display = kk === k ? '' : 'none'; });
    };
    nav.appendChild(b);
  });

  panes.basics.appendChild(grid(2,
    field('姓名', textInput(draft.basics.name, '', (v) => { draft.basics.name = v; })),
    field('目标职位', textInput(draft.basics.title, '', (v) => { draft.basics.title = v; })),
    field('手机号', textInput(draft.basics.phone, '', (v) => { draft.basics.phone = v; })),
    field('邮箱', textInput(draft.basics.email, '', (v) => { draft.basics.email = v; })),
    field('所在城市', textInput(draft.basics.location, '', (v) => { draft.basics.location = v; })),
    field('个人主页', textInput(draft.basics.website, '', (v) => { draft.basics.website = v; })),
  ));
  panes.basics.appendChild(field('个人简介', textArea(draft.basics.summary, '', (v) => { draft.basics.summary = v; }, { rows: 5 })));

  panes.work.appendChild(listSection({
    title: '工作经历', items: draft.work,
    makeEmpty: () => ({ company: '', position: '', start: '', end: '', location: '', bullets: [] }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.company || '工作', h);
      block.appendChild(grid(2,
        field('公司', textInput(x.company, '', (v) => { x.company = v; h.refresh(); })),
        field('职位', textInput(x.position, '', (v) => { x.position = v; })),
        field('开始', textInput(x.start, '', (v) => { x.start = v; })),
        field('结束', textInput(x.end, '', (v) => { x.end = v; })),
      ));
      block.appendChild(field('要点（每行一条）', textArea(arrayToLines(x.bullets), '', (v) => { x.bullets = linesToArray(v); }, { rows: 5 })));
      return block;
    },
  }));

  panes.projects.appendChild(listSection({
    title: '项目经历', items: draft.projects,
    makeEmpty: () => ({ name: '', org: '', role: '', start: '', end: '', tech: [], bullets: [] }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.name || '项目', h);
      block.appendChild(grid(2,
        field('项目名', textInput(x.name, '', (v) => { x.name = v; h.refresh(); })),
        field('角色', textInput(x.role, '', (v) => { x.role = v; })),
        field('开始', textInput(x.start, '', (v) => { x.start = v; })),
        field('结束', textInput(x.end, '', (v) => { x.end = v; })),
        field('技术栈（、分隔）', textInput((x.tech || []).join('、'), '', (v) => {
          x.tech = v.split(/[、,，]/).map((t) => t.trim()).filter(Boolean);
        })),
      ));
      block.appendChild(field('要点（每行一条）', textArea(arrayToLines(x.bullets), '', (v) => { x.bullets = linesToArray(v); }, { rows: 4 })));
      return block;
    },
  }));

  panes.education.appendChild(listSection({
    title: '教育经历', items: draft.education,
    makeEmpty: () => ({ school: '', degree: '', major: '', start: '', end: '', gpa: '', bullets: [] }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.school || '教育', h);
      block.appendChild(grid(2,
        field('学校', textInput(x.school, '', (v) => { x.school = v; h.refresh(); })),
        field('专业', textInput(x.major, '', (v) => { x.major = v; })),
        field('学历', textInput(x.degree, '', (v) => { x.degree = v; })),
        field('GPA', textInput(x.gpa, '', (v) => { x.gpa = v; })),
        field('开始', textInput(x.start, '', (v) => { x.start = v; })),
        field('结束', textInput(x.end, '', (v) => { x.end = v; })),
      ));
      return block;
    },
  }));

  panes.skills.appendChild(listSection({
    title: '专业技能', items: draft.skills,
    makeEmpty: () => ({ category: '', items: [] }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.category || '技能', h);
      block.appendChild(grid(2,
        field('分类', textInput(x.category, '', (v) => { x.category = v; h.refresh(); })),
        field('技能项（、分隔）', textInput((x.items || []).join('、'), '', (v) => {
          x.items = v.split(/[、,，]/).map((t) => t.trim()).filter(Boolean);
        })),
      ));
      return block;
    },
  }));

  panes.extra.appendChild(listSection({
    title: '获奖', items: draft.awards,
    makeEmpty: () => ({ title: '', date: '', detail: '' }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.title || '奖项', h);
      block.appendChild(grid(3,
        field('名称', textInput(x.title, '', (v) => { x.title = v; h.refresh(); })),
        field('时间', textInput(x.date, '', (v) => { x.date = v; })),
        field('说明', textInput(x.detail, '', (v) => { x.detail = v; })),
      ));
      return block;
    },
  }));
  panes.extra.appendChild(listSection({
    title: '证书', items: draft.certificates,
    makeEmpty: () => ({ title: '', date: '', detail: '' }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.title || '证书', h);
      block.appendChild(grid(3,
        field('名称', textInput(x.title, '', (v) => { x.title = v; h.refresh(); })),
        field('时间', textInput(x.date, '', (v) => { x.date = v; })),
        field('说明', textInput(x.detail, '', (v) => { x.detail = v; })),
      ));
      return block;
    },
  }));
  panes.extra.appendChild(listSection({
    title: '自定义板块', items: draft.customSections,
    makeEmpty: () => ({ title: '', items: [] }),
    renderItem: (x, i, h) => {
      const block = itemBlock(i, x.title || '板块', h);
      block.appendChild(field('标题', textInput(x.title, '', (v) => { x.title = v; h.refresh(); })));
      block.appendChild(field('内容（每行一条）', textArea(arrayToLines(x.items), '', (v) => { x.items = linesToArray(v); }, { rows: 3 })));
      return block;
    },
  }));

  wrap.appendChild(nav);
  wrap.appendChild(paneWrap);

  const foot = document.createElement('div');
  const cancel = el('button', 'btn', '取消');
  const save = el('button', 'btn primary', '保存修改');
  foot.appendChild(cancel);
  foot.appendChild(save);
  const m = openModal({ title: '编辑简历内容', body: wrap, footer: foot, width: '900px' });
  cancel.onclick = () => m.close();
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api('/api/jobs/result', {
        jobId: job.id, companyId: item.companyId, resume: draft,
      });
      fullCache.delete(`${job.id}:${item.companyId}`);
      previewHtml = '';
      m.close();
      await refresh();
      toast('已保存修改', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  };
}
