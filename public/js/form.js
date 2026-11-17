// 表单构件：字段、可增删排序的列表区块

import { $, esc, uid } from './util.js';

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function field(label, control, hint) {
  const wrap = el('div', 'field');
  if (label) {
    const l = el('label', null, label);
    wrap.appendChild(l);
  }
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el('div', 'hint', hint));
  return wrap;
}

export function textInput(value, placeholder, onInput, opts = {}) {
  const input = document.createElement('input');
  input.type = opts.type || 'text';
  input.value = value == null ? '' : value;
  if (placeholder) input.placeholder = placeholder;
  if (opts.mono) input.className = 'mono';
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

export function textArea(value, placeholder, onInput, opts = {}) {
  const ta = document.createElement('textarea');
  ta.value = value == null ? '' : value;
  if (placeholder) ta.placeholder = placeholder;
  if (opts.rows) ta.rows = opts.rows;
  if (opts.mono) ta.className = 'code';
  ta.addEventListener('input', () => onInput(ta.value));
  return ta;
}

export function selectInput(value, options, onChange) {
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function switchInput(checked, label, onChange) {
  const wrap = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  const track = el('span', 'track');
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(track);
  if (label) wrap.appendChild(el('span', null, label));
  return wrap;
}

export function btn(label, onClick, cls = 'btn sm') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function emptyHint(text) {
  const d = el('div', 'empty');
  d.appendChild(el('strong', null, text));
  return d;
}

/**
 * 可增删、可排序的列表区块。
 * opts: { title, hint, items, makeEmpty, renderItem, onChange, emptyText, addLabel }
 */
export function listSection(opts) {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h3', null, opts.title));
  if (opts.hint) head.appendChild(el('span', 'sub', opts.hint));
  const right = el('div', 'right');
  const count = el('span', 'pill', '0');
  right.appendChild(count);
  right.appendChild(btn(opts.addLabel || '添加', () => {
    opts.items.push(opts.makeEmpty ? opts.makeEmpty() : {});
    opts.onChange && opts.onChange();
    renderAll();
  }, 'btn sm primary'));
  head.appendChild(right);
  card.appendChild(head);

  const body = el('div', 'card-body');
  const listEl = el('div');
  body.appendChild(listEl);
  card.appendChild(body);

  function move(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= opts.items.length) return;
    const [it] = opts.items.splice(index, 1);
    opts.items.splice(next, 0, it);
    opts.onChange && opts.onChange();
    renderAll();
  }

  function remove(index) {
    opts.items.splice(index, 1);
    opts.onChange && opts.onChange();
    renderAll();
  }

  function renderAll() {
    listEl.innerHTML = '';
    count.textContent = String(opts.items.length);
    if (!opts.items.length) {
      listEl.appendChild(emptyHint(opts.emptyText || '暂无内容'));
      return;
    }
    opts.items.forEach((item, index) => {
      listEl.appendChild(opts.renderItem(item, index, {
        move: (d) => move(index, d),
        remove: () => remove(index),
        refresh: renderAll,
      }));
    });
  }

  renderAll();
  card.__renderAll = renderAll;
  return card;
}

/** 生成一个可增删条目的外壳：带序号与操作按钮 */
export function itemBlock(index, title, handlers, { canMove = true } = {}) {
  const block = el('div', 'item-block');
  const head = el('div', 'ib-head');
  head.appendChild(el('span', 'idx', `#${index + 1}`));
  head.appendChild(el('strong', null, title || ''));
  const right = el('div', 'right');
  if (canMove) {
    right.appendChild(btn('↑', () => handlers.move(-1), 'btn ghost sm'));
    right.appendChild(btn('↓', () => handlers.move(1), 'btn ghost sm'));
  }
  right.appendChild(btn('删除', () => handlers.remove(), 'btn danger sm'));
  head.appendChild(right);
  block.appendChild(head);
  return block;
}

export function grid(cols, ...children) {
  const g = el('div', `grid grid-${cols}`);
  children.filter(Boolean).forEach((c) => g.appendChild(c));
  return g;
}

/** 把一行一行的文本与数组互转 */
export function linesToArray(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.replace(/\s+$/, '').trim())
    .filter((s) => s.length > 0);
}

export function arrayToLines(arr) {
  return (arr || []).join('\n');
}

export { esc, uid, $ };
