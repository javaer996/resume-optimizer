// 脱敏设置：开关、自定义规则、实时预览

import { el, field, textInput, textArea, selectInput, switchInput, grid } from './form.js';
import { $, esc, toast, api, debounce } from './util.js';

let getState = () => ({});
let markDirty = () => {};

export function init(ctx) {
  getState = ctx.getState;
  markDirty = ctx.markDirty;
}

const TYPE_ORDER = ['NAME', 'PHONE', 'EMAIL', 'SCHOOL', 'ADDRESS', 'COMPANY', 'IDCARD', 'WECHAT', 'URL'];

const TYPE_DESC = {
  NAME: '简历里的姓名、英文名',
  PHONE: '手机号、座机号（含正文中出现的）',
  EMAIL: '所有邮箱地址',
  SCHOOL: '教育经历中的学校名称',
  ADDRESS: '所在城市、详细地址',
  COMPANY: '工作经历中的公司名称',
  IDCARD: '身份证号',
  WECHAT: '微信号',
  URL: '个人主页 / 链接',
};

export function render() {
  const root = $('#mask-root');
  const s = getState();
  root.innerHTML = '';

  const settings = s.settings;

  /* 内置规则 */
  const c1 = el('div');
  c1.appendChild(el('h4', null, '内置敏感类型'));
  const desc = el('div', 'small muted');
  desc.style.margin = '4px 0 10px';
  desc.textContent = '打开的类型会在发送给 AI 前被替换为占位符。占位符对同一个值保持稳定，AI 不会因此看不懂上下文。';
  c1.appendChild(desc);

  const gridEl = el('div');
  gridEl.style.cssText = 'display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))';
  TYPE_ORDER.forEach((type) => {
    const row = el('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:7px';
    const sw = switchInput(settings.switches[type] !== false, '', async (v) => {
      settings.switches[type] = v;
      markDirty('settings');
      refreshPreview();
    });
    sw.style.marginTop = '1px';
    row.appendChild(sw);
    const box = el('div');
    box.appendChild(el('div', null, `${s.tokens[type] || type}（${type}）`));
    box.appendChild(el('div', 'small muted', TYPE_DESC[type] || ''));
    row.appendChild(box);
    gridEl.appendChild(row);
  });
  c1.appendChild(gridEl);
  root.appendChild(c1);

  /* 自定义规则 */
  const c2 = el('div');
  c2.style.marginTop = '22px';
  const h2 = el('div');
  h2.style.cssText = 'display:flex;align-items:center;gap:10px';
  h2.appendChild(el('h4', null, '自定义脱敏规则'));
  const addBtn = el('button', 'btn sm primary', '添加规则');
  addBtn.onclick = () => {
    settings.customRules.push({
      id: `r_${Date.now().toString(36)}`,
      label: '',
      mode: 'literal',
      value: '',
      enabled: true,
    });
    markDirty('settings');
    render();
  };
  h2.appendChild(addBtn);
  c2.appendChild(h2);

  const hint = el('div', 'small muted');
  hint.style.margin = '4px 0 10px';
  hint.textContent = '适合脱敏简历里的其它敏感词：前东家产品名、客户名、内部项目代号等。字面量 = 精确匹配文本；正则 = 用 JavaScript 正则表达式匹配。';
  c2.appendChild(hint);

  const rules = settings.customRules || [];
  if (!rules.length) {
    const e = el('div', 'empty', '还没有自定义规则');
    c2.appendChild(e);
  }
  rules.forEach((rule, idx) => {
    c2.appendChild(ruleRow(rule, idx, rules));
  });
  root.appendChild(c2);

  /* 实时预览 */
  const c3 = el('div');
  c3.style.marginTop = '22px';
  c3.appendChild(el('h4', null, '脱敏效果实时预览'));
  const ph = el('div', 'small muted');
  ph.style.margin = '4px 0 8px';
  ph.textContent = '用你当前的简历内容演示：左边是原文，右边是实际发给 AI 的样子。';
  c3.appendChild(ph);
  const rows = el('div', 'grid grid-2');
  const left = el('div');
  left.appendChild(el('div', 'small muted', '原始内容（仅本机可见）'));
  previewLeft = textArea('', '', () => {}, { rows: 12 });
  previewLeft.readOnly = true;
  left.appendChild(previewLeft);
  const right = el('div');
  right.appendChild(el('div', 'small muted', '发送给 AI 的内容'));
  previewRight = textArea('', '', () => {}, { rows: 12 });
  previewRight.readOnly = true;
  right.appendChild(previewRight);
  rows.appendChild(left);
  rows.appendChild(right);
  c3.appendChild(rows);
  root.appendChild(c3);

  refreshPreview();
}

let previewLeft = null;
let previewRight = null;

const refreshPreview = debounce(async () => {
  const s = getState();
  try {
    const res = await api('/api/preview', {
      profile: s.profile,
      templateId: s.prompts.activeTemplateId,
      switches: s.settings.switches,
      customRules: s.settings.customRules,
    });
    if (previewLeft) previewLeft.value = res.messages[1] ? res.messages[1].content : '';
    if (previewRight) previewRight.value = res.messages[1] ? res.messages[1].content : '';
    // 左侧展示真实值：把占位符还原回去
    if (previewLeft) {
      const unmasked = await api('/api/unmask', { text: res.messages[1] ? res.messages[1].content : '', vault: res.maskReport || [] });
      previewLeft.value = unmasked.text;
    }
  } catch (err) {
    if (previewRight) previewRight.value = `预览失败：${err.message}`;
  }
}, 500);

function ruleRow(rule, idx, rules) {
  const box = el('div');
  box.style.cssText = 'border:1px solid var(--border);border-radius:7px;padding:10px 12px;margin-bottom:8px;background:#fcfcfd';

  const top = el('div');
  top.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:8px';
  top.appendChild(switchInput(rule.enabled !== false, '', (v) => {
    rule.enabled = v;
    markDirty('settings');
    refreshPreview();
  }));
  top.appendChild(el('span', 'small muted', `规则 #${idx + 1}`));
  const del = el('button', 'btn ghost sm danger', '删除');
  del.style.marginLeft = 'auto';
  del.onclick = () => {
    rules.splice(idx, 1);
    markDirty('settings');
    render();
  };
  top.appendChild(del);
  box.appendChild(top);

  const g = el('div', 'grid grid-3');
  g.appendChild(field('匹配方式', selectInput(rule.mode || 'literal', [
    { value: 'literal', label: '字面量（精确匹配）' },
    { value: 'regex', label: '正则表达式' },
  ], (v) => { rule.mode = v; markDirty('settings'); refreshPreview(); })));
  g.appendChild(field('占位符名称', textInput(rule.label, '例如 PRODUCT，则显示为 [CUSTOM_PRODUCT_1]', (v) => {
    rule.label = v.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 12);
    markDirty('settings');
    refreshPreview();
  })));
  box.appendChild(g);

  const valField = field(rule.mode === 'regex' ? '正则表达式' : '要脱敏的原文', textInput(rule.value, rule.mode === 'regex' ? '(内部项目|某某计划)' : '例如：星辰计划', (v) => {
    rule.value = v;
    markDirty('settings');
    refreshPreview();
  }, { mono: rule.mode === 'regex' }));
  valField.style.marginTop = '8px';
  box.appendChild(valField);

  if (rule.mode === 'regex' && rule.value) {
    try { new RegExp(rule.value); } catch (err) {
      const t = el('div', 'tip err');
      t.style.marginTop = '6px';
      t.textContent = `正则无法编译：${err.message}`;
      box.appendChild(t);
    }
  }
  return box;
}
