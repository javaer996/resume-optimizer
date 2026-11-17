// 提示词模板编辑与历史记录

import { el, field, textInput, textArea, selectInput } from './form.js';
import { $, esc, toast, api, fmtTime, confirmDialog, openModal } from './util.js';

let getState = () => ({});
let savePrompts = () => {};

export function init(ctx) {
  getState = ctx.getState;
  savePrompts = ctx.savePrompts;
}

let editingId = null;
let draft = null;

const VAR_HELP = [
  ['{{companyName}}', '目标单位名称'],
  ['{{position}}', '应聘职位'],
  ['{{companyIntro}}', '单位简介'],
  ['{{jobDuties}}', '岗位职责'],
  ['{{requirements}}', '任职要求'],
  ['{{focusAreas}}', '重点考察范围'],
  ['{{cautions}}', '注意事项 / 红线'],
  ['{{tone}}', '风格偏好'],
  ['{{resumeJson}}', '简历 JSON（已脱敏）'],
  ['{{resumeText}}', '简历纯文本（已脱敏）'],
  ['{{extraInstruction}}', '用户在批量优化页填的附加要求'],
];

export function render() {
  const root = $('#prompts-root');
  const s = getState();
  root.innerHTML = '';

  const templates = s.prompts.templates || [];
  if (!editingId || !templates.find((t) => t.id === editingId)) {
    editingId = s.prompts.activeTemplateId || (templates[0] && templates[0].id);
  }
  const tpl = templates.find((t) => t.id === editingId);

  // 列宽交给 CSS：写死 240px 内联样式时，手机上会把右侧编辑区挤到 76px，
  // 里面每个按钮都横向溢出（实测「可见变量说明」溢出 29px、「恢复此版本」138px）。
  const layout = el('div', 'grid tpl-layout');

  /* 左侧模板列表 */
  const left = el('div', 'card');
  left.style.margin = '0';
  const lh = el('div', 'card-head');
  lh.appendChild(el('h3', null, '模板列表'));
  const addBtn = el('button', 'btn sm primary', '新建');
  addBtn.onclick = () => newTemplate();
  lh.appendChild(Object.assign(el('div', 'right'), {})).appendChild(addBtn);
  left.appendChild(lh);
  const lb = el('div', 'card-body tight');
  templates.forEach((t) => {
    const item = el('div', `job-item${t.id === editingId ? ' active' : ''}`);
    item.appendChild(el('div', 'ji-title', t.name));
    const meta = el('div', 'ji-meta');
    meta.textContent = `${t.builtin ? '内置' : '自定义'}${t.updatedAt ? ` · ${fmtTime(t.updatedAt)}` : ''}`;
    item.appendChild(meta);
    if (s.prompts.activeTemplateId === t.id) {
      item.appendChild(el('span', 'pill ok', '使用中'));
    }
    item.onclick = () => { editingId = t.id; draft = null; render(); };
    lb.appendChild(item);
  });
  left.appendChild(lb);
  layout.appendChild(left);

  /* 右侧编辑区 */
  const right = el('div');
  right.style.minWidth = '0';
  layout.appendChild(right);

  if (!tpl) {
    const e = el('div', 'card');
    const b = el('div', 'card-body');
    b.appendChild(el('div', 'empty', '还没有模板'));
    e.appendChild(b);
    right.appendChild(e);
    root.appendChild(layout);
    return;
  }

  if (!draft || draft.__id !== tpl.id) {
    draft = {
      __id: tpl.id,
      id: tpl.id,
      name: tpl.name,
      description: tpl.description || '',
      systemPrompt: tpl.systemPrompt,
      userPromptTemplate: tpl.userPromptTemplate,
      builtin: tpl.builtin,
    };
  }

  const c = el('div', 'card');
  c.style.margin = '0';
  const ch = el('div', 'card-head');
  ch.appendChild(el('h3', null, tpl.name));
  const chRight = el('div', 'right');
  if (s.prompts.activeTemplateId !== tpl.id) {
    const useBtn = el('button', 'btn sm', '设为默认使用');
    useBtn.onclick = async () => {
      await savePrompts({ action: 'activate', id: tpl.id });
      toast('已设为默认模板', 'ok');
    };
    chRight.appendChild(useBtn);
  } else {
    chRight.appendChild(el('span', 'pill ok', '使用中'));
  }
  if (!tpl.builtin) {
    const delBtn = el('button', 'btn sm danger', '删除模板');
    delBtn.onclick = async () => {
      if (!(await confirmDialog(`确定删除模板「${tpl.name}」？`, { danger: true, okText: '删除' }))) return;
      await savePrompts({ action: 'delete', id: tpl.id });
      editingId = null;
      draft = null;
      toast('已删除', 'ok');
    };
    chRight.appendChild(delBtn);
  }
  ch.appendChild(chRight);
  c.appendChild(ch);

  const body = el('div', 'card-body');

  body.appendChild(grid2(
    field('模板名称', textInput(draft.name, '模板名称', (v) => { draft.name = v; })),
    field('模板说明', textInput(draft.description, '一句话说明这个模板适合什么场景', (v) => { draft.description = v; })),
  ));

  const sysField = field('System 提示词（角色设定与硬性规则）', textArea(draft.systemPrompt, '', (v) => { draft.systemPrompt = v; }, { rows: 16, mono: true }));
  sysField.style.marginTop = '12px';
  body.appendChild(sysField);

  const userField = field('User 提示词（具体任务与数据）', textArea(draft.userPromptTemplate, '', (v) => { draft.userPromptTemplate = v; }, { rows: 16, mono: true }));
  userField.style.marginTop = '12px';
  body.appendChild(userField);

  /* 变量说明 */
  const varsBox = el('div');
  varsBox.style.marginTop = '12px';
  const toggle = el('button', 'btn ghost sm', '可用变量说明 ▾');
  varsBox.appendChild(toggle);
  const varsList = el('div');
  varsList.style.display = 'none';
  varsList.style.marginTop = '8px';
  const tb = el('table', 'mask-table');
  tb.innerHTML = '<thead><tr><th>变量</th><th>含义</th></tr></thead>';
  const tbody = document.createElement('tbody');
  VAR_HELP.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="token">${esc(k)}</td><td>${esc(v)}</td>`;
    tbody.appendChild(tr);
  });
  tb.appendChild(tbody);
  varsList.appendChild(tb);
  const note = el('div', 'tip');
  note.style.marginTop = '8px';
  note.innerHTML = '务必在提示词中保留「不得改动方括号占位符（如 [NAME_1]）」这条约束，'
    + '否则 AI 可能改写占位符，导致真实信息无法还原。';
  varsList.appendChild(note);
  toggle.onclick = () => {
    const open = varsList.style.display === 'none';
    varsList.style.display = open ? '' : 'none';
    toggle.textContent = open ? '可用变量说明 ▴' : '可用变量说明 ▾';
  };
  varsBox.appendChild(varsList);
  body.appendChild(varsBox);

  /* 操作按钮 */
  const actions = el('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap';
  const saveBtn = el('button', 'btn primary', '保存模板');
  saveBtn.onclick = async () => {
    if (!draft.name.trim()) { toast('请填写模板名称', 'err'); return; }
    saveBtn.disabled = true;
    try {
      await savePrompts({ template: draft });
      toast('已保存，修改已计入历史记录', 'ok');
      draft = null;
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  };
  actions.appendChild(saveBtn);

  const saveAs = el('button', 'btn', '另存为新模板');
  saveAs.onclick = async () => {
    const copy = { ...draft, id: '', name: `${draft.name} 副本`, builtin: false };
    try {
      await savePrompts({ template: copy });
      toast('已另存为新模板', 'ok');
      editingId = null;
      draft = null;
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  actions.appendChild(saveAs);

  const reset = el('button', 'btn', '放弃未保存的修改');
  reset.onclick = () => { draft = null; render(); };
  actions.appendChild(reset);
  body.appendChild(actions);
  c.appendChild(body);
  right.appendChild(c);

  /* 历史记录 */
  const history = s.prompts.history || [];
  const hc = el('div', 'card');
  hc.style.marginTop = '16px';
  const hh = el('div', 'card-head');
  hh.appendChild(el('h3', null, `历史记录（${history.length} / 10）`));
  hh.appendChild(el('span', 'sub', '每次保存或删除模板都会自动留档，可随时恢复'));
  hc.appendChild(hh);
  const hb = el('div', 'card-body');
  if (!history.length) {
    hb.appendChild(el('div', 'empty small', '还没有历史记录'));
  } else {
    history.forEach((h) => {
      const row = el('div', 'hist-row');
      const info = el('div', 'hist-info');
      info.appendChild(el('div', null, `${h.name}　${actionText(h.action)}`));
      info.appendChild(el('div', 'small muted', fmtTime(h.at)));
      row.appendChild(info);
      const acts = el('div', 'hist-acts');
      const view = el('button', 'btn sm', '查看');
      view.onclick = () => showHistory(h);
      acts.appendChild(view);
      const restore = el('button', 'btn sm', '恢复此版本');
      acts.appendChild(restore);
      restore.onclick = async () => {
        if (!(await confirmDialog(`把「${h.name}」恢复到这个版本？当前版本会先计入历史。`, { okText: '恢复' }))) return;
        try {
          await savePrompts({ action: 'restore', historyId: h.id });
          draft = null;
          toast('已恢复', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      row.appendChild(acts);
      hb.appendChild(row);
    });
  }
  hc.appendChild(hb);
  right.appendChild(hc);

  root.appendChild(layout);
}

function actionText(a) {
  return { edit: '· 编辑前版本', create: '· 创建时的内容', delete: '· 删除前版本', restore: '· 恢复前版本' }[a] || '';
}

function grid2(a, b) {
  const g = el('div', 'grid grid-2');
  g.appendChild(a);
  g.appendChild(b);
  return g;
}

function showHistory(h) {
  const wrap = el('div');
  const p1 = el('div');
  p1.appendChild(el('div', 'small muted', 'System 提示词'));
  const s1 = el('pre');
  s1.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:#fafbfc;border:1px solid var(--border);border-radius:6px;padding:10px;max-height:300px;overflow:auto;font-size:12.5px';
  s1.textContent = h.systemPrompt || '（空）';
  p1.appendChild(s1);
  wrap.appendChild(p1);

  const p2 = el('div');
  p2.style.marginTop = '12px';
  p2.appendChild(el('div', 'small muted', 'User 提示词'));
  const s2 = el('pre');
  s2.style.cssText = s1.style.cssText;
  s2.textContent = h.userPromptTemplate || '（空）';
  p2.appendChild(s2);
  wrap.appendChild(p2);

  openModal({ title: `${h.name}　${actionText(h.action)}`, body: wrap, width: '860px' });
}

function newTemplate() {
  const wrap = el('div');
  const nameInput = textInput('', '例如：国企风格 / 外企英文 / 技术岗强化', () => {});
  wrap.appendChild(field('模板名称', nameInput));
  wrap.appendChild(el('div', 'tip', '新模板会以当前模板的内容为起点，创建后即可自由编辑。'));

  const foot = document.createElement('div');
  const cancel = el('button', 'btn', '取消');
  const ok = el('button', 'btn primary', '创建');
  foot.appendChild(cancel);
  foot.appendChild(ok);
  const m = openModal({ title: '新建提示词模板', body: wrap, footer: foot, width: '520px' });
  cancel.onclick = () => m.close();

  const s = getState();
  const source = (s.prompts.templates || []).find((t) => t.id === editingId) || (s.prompts.templates || [])[0] || {};
  ok.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('请填写模板名称', 'err'); return; }
    try {
      await savePrompts({
        template: {
          id: '',
          name,
          description: `基于「${source.name || '模板'}」创建`,
          systemPrompt: source.systemPrompt || '',
          userPromptTemplate: source.userPromptTemplate || '',
        },
      });
      m.close();
      editingId = null;
      draft = null;
      toast('已创建', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}
