// 样式工作台：主题画廊 + 逐段版式 + 自定义 CSS + 实时预览

import { el, field, textInput, selectInput, switchInput } from './form.js';
import { $, esc, toast, debounce, download, api } from './util.js';

let getState = () => ({});
let markDirty = () => {};

export function init(ctx) {
  getState = ctx.getState;
  markDirty = ctx.markDirty;
}

/* ---------------- 小工具 ---------------- */

function card(title, sub, ...body) {
  const c = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h3', null, title));
  if (sub) head.appendChild(el('span', 'sub', sub));
  c.appendChild(head);
  const b = el('div', 'card-body');
  body.filter(Boolean).forEach((x) => b.appendChild(x));
  c.appendChild(b);
  return c;
}

function optList(list, value, onChange, { width = 108 } = {}) {
  const sel = selectInput(value == null ? '' : value, list.map((o) => ({ value: o.value, label: o.label })), onChange);
  sel.style.width = `${width}px`;
  return sel;
}

/** 拿当前导出设置，并保证 layout 结构存在 */
function expOf() {
  const s = getState();
  const exp = s.settings.export || {};
  if (!exp.layout || typeof exp.layout !== 'object') {
    exp.layout = { order: [], header: {}, sections: {}, customCSS: '' };
  }
  const L = exp.layout;
  if (!Array.isArray(L.order)) L.order = [];
  if (!L.header || typeof L.header !== 'object') L.header = {};
  if (!L.sections || typeof L.sections !== 'object') L.sections = {};
  if (typeof L.customCSS !== 'string') L.customCSS = '';
  if (!Array.isArray(exp.hidden)) exp.hidden = [];
  return exp;
}

function metaOf(s) {
  const list = (s.style && s.style.sections) || [];
  const map = {};
  list.forEach((m) => { map[m.key] = m; });
  return { list, map };
}

/** 让 order 与「已知章节」对齐：认识的键保留顺序，未知的丢掉，缺的补到末尾 */
function normalizeOrder(order, meta, defaultOrder) {
  const known = new Set(meta.list.map((m) => m.key));
  const out = [];
  (order || []).forEach((k) => {
    if (known.has(k) && !out.includes(k)) out.push(k);
  });
  (defaultOrder || []).forEach((k) => {
    if (known.has(k) && !out.includes(k)) out.push(k);
  });
  meta.list.forEach((m) => {
    if (!out.includes(m.key)) out.push(m.key);
  });
  // 自定义板块永远最后
  const custom = out.filter((k) => k === 'customSections');
  return out.filter((k) => k !== 'customSections').concat(custom);
}
/* ---------------- 主题缩略图 ---------------- */

/**
 * 缩略图要能看出「结构」而不只是颜色。
 * 之前每张卡只画了标题样式和项目符号，八张看起来像同一份简历换了个色。
 * 现在把条目排法（stack / inline / block / card）、章节编号、技能形态也画进去。
 */
function thumbHtml(t) {
  const a = t.accent || '#333';
  const b = t.accent2 || a;
  const fam = t.serif ? '"Songti SC", "Noto Serif SC", Georgia, serif' : 'inherit';
  const line = (w, op = 0.15) => `<div class="tc-line" style="width:${w}%;background:rgba(0,0,0,${op})"></div>`;
  const layout = t.itemLayout || 'stack';
  const num = t.numbering || 'none';
  // 圆角与图标同样是结构差异，缩略图要能看出来
  const rad = { sharp: 0, soft: 6, round: 12, pill: 999 }[t.radius || 'soft'];
  const radCss = rad >= 999 ? '999px' : `${rad}px`;
  const icoKind = t.icon || 'none';
  const ico = {
    dot: `<span style="width:5px;height:5px;border-radius:50%;background:${a};display:inline-block;margin-right:4px;vertical-align:middle"></span>`,
    square: `<span style="width:5px;height:5px;border-radius:1px;background:${a};display:inline-block;margin-right:4px;vertical-align:middle"></span>`,
    line: `<span style="width:2px;height:6px;border-radius:1px;background:${a};display:inline-block;margin-right:4px;vertical-align:middle"></span>`,
    ring: `<span style="width:5px;height:5px;border-radius:50%;border:1.5px solid ${a};display:inline-block;margin-right:4px;vertical-align:middle"></span>`,
    diamond: `<span style="width:5px;height:5px;background:${a};display:inline-block;margin-right:4px;vertical-align:middle;transform:rotate(45deg)"></span>`,
  }[icoKind] || '';

  let head = '';
  if (t.header === 'band') {
    head = `<div class="tc-band" style="border-radius:${radCss};background:linear-gradient(115deg,${a},${b})">
      <div style="font-size:12px;font-weight:700;color:#fff;line-height:1.2">张明远</div>
      <div class="tc-line" style="width:52%;background:rgba(255,255,255,.55)"></div>
      <div class="tc-line" style="width:72%;background:rgba(255,255,255,.32)"></div>
    </div>`;
  } else if (t.header === 'center') {
    head = `<div style="text-align:center;padding:2px 0 6px;border-top:1px solid #e3e6ea;border-bottom:1px solid #e3e6ea">
      <div style="font-size:12px;font-weight:600;letter-spacing:.14em;color:${a}">张明远</div>
      ${line(46, 0.12)}
    </div>`;
  } else if (t.header === 'rule') {
    head = `<div style="padding-bottom:5px;border-bottom:2px solid ${a}">
      <div style="font-size:13px;font-weight:700;color:${a};line-height:1.15;font-family:${fam}">张明远</div>
    </div>`;
  } else {
    head = `<div><div style="font-size:13px;font-weight:700;line-height:1.15;color:${a};font-family:${fam}">张明远</div></div>`;
  }

  // 序号示意
  const numText = num === 'index' ? '01 ' : num === 'dot' ? '一、' : '';
  const numHtml = numText ? `<span style="opacity:.55;margin-right:3px">${numText}</span>` : '';

  // 章节标题示意
  const st = t.sectionTitle;
  let titleHtml = '';
  if (st === 'bar') {
    titleHtml = `<div style="border-left:3px solid ${a};padding-left:5px;color:${a};font-size:8px;font-weight:700;line-height:1.3">${ico}${numHtml}工作经历</div>`;
  } else if (st === 'underline') {
    titleHtml = `<div style="border-bottom:1.5px solid ${a};color:${a};font-size:8px;font-weight:700;padding-bottom:2px;line-height:1.3">${ico}${numHtml}工作经历</div>`;
  } else if (st === 'chip') {
    titleHtml = `<div style="display:inline-block;background:${a};color:#fff;font-size:7.5px;font-weight:700;padding:2px 6px;border-radius:${radCss}">${ico}${numHtml}工作经历</div>`;
  } else if (st === 'caps') {
    titleHtml = `<div style="color:${a};font-size:7.5px;font-weight:700;letter-spacing:.12em;line-height:1.3">${ico}${numHtml}WORK</div>
      <div style="width:16px;height:2px;background:${a};border-radius:${radCss};margin-top:3px"></div>`;
  } else if (st === 'gutter') {
    titleHtml = `<div style="display:flex;gap:6px;align-items:flex-start">
      <div style="width:34px;color:${a};font-size:7.5px;font-weight:700;line-height:1.4;flex:none">${ico}${numHtml}工作经历</div>
      <div style="flex:1;display:flex;flex-direction:column;gap:3px">${line(88)}${line(70)}</div>
    </div>`;
  } else if (st === 'plain') {
    titleHtml = `<div style="border-bottom:1px solid #dcdfe4;color:#374151;font-size:8px;font-weight:700;padding-bottom:2px">${ico}${numHtml}工作经历</div>`;
  } else {
    titleHtml = `<div style="font-size:8px;font-weight:700;color:${a}">${ico}${numHtml}工作经历</div>`;
  }

  const bullet = t.bullet === 'dash' ? '–' : t.bullet === 'square' ? '▪' : t.bullet === 'ring' ? '○' : '•';
  const bulletRow = (w) => `<div class="tc-row" style="gap:3px">
      <span style="color:${a};font-size:6px;line-height:1">${bullet}</span>
      <div class="tc-line" style="width:${w}%;background:rgba(0,0,0,0.13)"></div>
    </div>`;

  // 条目头部：四种排法各画成各自的样子
  let itemHead = '';
  if (layout === 'block') {
    itemHead = `<div style="font-size:6px;color:#9aa0a8;letter-spacing:.05em;margin-bottom:1px">2021 – 至今</div>
      <div class="tc-row" style="gap:3px"><div class="tc-line" style="width:44%;background:rgba(0,0,0,0.32);height:3px"></div></div>`;
  } else if (layout === 'inline') {
    itemHead = `<div class="tc-row" style="gap:3px;align-items:center">
      <div class="tc-line" style="width:30%;background:rgba(0,0,0,0.32);height:3px"></div>
      <span style="font-size:5px;color:#b9bec6">·</span>
      <div class="tc-line" style="width:22%;background:rgba(0,0,0,0.15);height:3px"></div>
    </div>`;
  } else {
    itemHead = `<div class="tc-row" style="justify-content:space-between;gap:4px">
      <div class="tc-line" style="width:56%;background:rgba(0,0,0,0.32);height:3px"></div>
      <div class="tc-line" style="width:24%;background:rgba(0,0,0,0.11);height:3px"></div>
    </div>`;
  }

  const itemWrap = layout === 'card'
    ? `<div style="background:rgba(0,0,0,.02);border-left:2.5px solid ${a};border-radius:0 ${radCss} ${radCss} 0;padding:4px 5px;display:flex;flex-direction:column;gap:3px">${itemHead}${bulletRow(82)}${bulletRow(66)}</div>`
    : `<div style="display:flex;flex-direction:column;gap:3px">${itemHead}${bulletRow(86)}${bulletRow(72)}</div>`;

  // 技能形态：标签版画成一排小方块
  const skillRows = t.skills === 'tags'
    ? `<div class="tc-row" style="gap:3px;margin-top:4px">
        <div style="width:22px;height:5px;background:rgba(0,0,0,.1);border-radius:${radCss}"></div>
        <div style="width:16px;height:5px;background:rgba(0,0,0,.1);border-radius:${radCss}"></div>
        <div style="width:20px;height:5px;background:rgba(0,0,0,.1);border-radius:${radCss}"></div>
        <div style="width:14px;height:5px;background:rgba(0,0,0,.1);border-radius:${radCss}"></div>
      </div>`
    : '';

  return `<div class="tc-thumb" style="font-family:${fam}">
    ${head}
    <div style="flex:1;display:flex;flex-direction:column;gap:4px;margin-top:2px">
      ${titleHtml}
      ${itemWrap}
      ${skillRows}
    </div>
  </div>`;
}

/* ---------------- 渲染 ---------------- */

export function render() {
  const root = $('#settings-root');
  const s = getState();
  if (!s.settings) return;
  root.innerHTML = '';

  const exp = expOf();
  const meta = metaOf(s);
  const topics = (s.style && s.style.themes) || s.themes || [];

  exp.layout.order = normalizeOrder(exp.layout.order, meta, (s.style && s.style.defaultOrder) || []);
  exp.layout.sections = exp.layout.sections || {};

  root.appendChild(themeCard(exp, topics, meta));
  root.appendChild(sectionCard(exp, meta, s));
  root.appendChild(typoCard(exp, s));
  root.appendChild(cssCard(exp));
  root.appendChild(previewCard(exp, s));

  refreshPreview(true);
}

/* --- 1. 主题画廊 --- */
function themeCard(exp, topics, meta) {
  const gallery = el('div', 'theme-gallery');
  const probe = el('div');
  if (!topics.length) {
    probe.appendChild(el('div', 'tip warn', '没有读到主题列表，请刷新页面后重试。'));
    return card('主题', '选一套作为起点，下面的逐段设置会覆盖它', probe);
  }
  topics.forEach((t) => {
    const c = el('button', `theme-card${exp.theme === t.id ? ' on' : ''}`);
    c.type = 'button';
    c.innerHTML = `${thumbHtml(t)}
      <div class="tc-meta">
        <div class="tc-name">${esc(t.name)}${t.tag ? `<span class="tc-tag">${esc(t.tag)}</span>` : ''}</div>
        <div class="tc-desc">${esc(t.desc || '')}</div>
      </div>
      <span class="tc-check">✓</span>`;
    c.onclick = () => {
      exp.theme = t.id;
      // 换主题时把逐段覆盖清掉，否则旧主题的覆盖会把新主题改得面目全非
      exp.layout.sections = {};
      exp.layout.header = {};
      markDirty('settings');
      render();
    };
    gallery.appendChild(c);
  });
  probe.appendChild(gallery);
  const note = el('div', 'small muted');
  note.style.marginTop = '12px';
  note.textContent = '切换主题会重置下方的逐段覆盖设置；想让同一份内容适配不同岗位，可以在上方直接点主题预览效果。';
  probe.appendChild(note);
  return card('主题', `${topics.length} 套内置模板`, probe);
}

// 只有这几块有「单位 / 职位 / 时间」的条目结构，条目排法对它们才起作用
const ITEM_SECTIONS = new Set(['work', 'projects', 'education']);

/* --- 2. 逐段版式 --- */
function sectionCard(exp, meta, s) {
  const holder = el('div');
  const titles = (s.style && s.style.titles) || [{ value: 'inherit', label: '跟随主题' }];
  const bullets = (s.style && s.style.bullets) || [{ value: 'inherit', label: '跟随主题' }];
  const aligns = (s.style && s.style.aligns) || [{ value: 'inherit', label: '跟随主题' }];
  const places = (s.style && s.style.placements) || [{ value: 'inherit', label: '跟随主题' }];
  const itemLayouts = (s.style && s.style.itemLayouts) || [{ value: 'inherit', label: '跟随主题' }];
  const numberings = (s.style && s.style.numberings) || [{ value: 'inherit', label: '跟随主题' }];
  const icons = (s.style && s.style.icons) || [{ value: 'inherit', label: '跟随主题' }];
  const hidden = new Set(exp.hidden || []);

  function opt(key) {
    if (!exp.layout.sections[key]) exp.layout.sections[key] = {};
    return exp.layout.sections[key];
  }
  // 把被清空的覆盖删掉，否则持久化里会留一堆 {"work":{}} 这种空壳
  const prune = () => {
    const secs = exp.layout.sections || {};
    Object.keys(secs).forEach((k) => {
      if (!secs[k] || !Object.keys(secs[k]).length) delete secs[k];
    });
    const h = exp.layout.header || {};
    Object.keys(h).forEach((k) => {
      if (h[k] === undefined || h[k] === 'inherit') delete h[k];
    });
  };
  const touch = (preview = true) => {
    prune();
    markDirty('settings');
    if (preview) refreshPreview();
  };

  function draw() {
    holder.innerHTML = '';
    const list = el('div', 'sec-editor');
    const order = exp.layout.order;

    order.forEach((key, index) => {
      const m = meta.map[key] || { key, title: key, hint: '' };
      const ov = exp.layout.sections[key] || {};
      const isCustom = key === 'customSections';
      const row = el('div', `sec-row${hidden.has(key) ? ' off' : ''}`);

      row.appendChild(el('div', 'sr-handle', '⋮⋮'));

      const main = el('div', 'sr-main');
      const titleBox = el('div', 'sr-titlebox');
      const nameInput = textInput(ov.title || m.title, m.title, (v) => {
        const cur = opt(key);
        const t = v.trim();
        if (!t || t === m.title) delete cur.title;
        else cur.title = t;
        touch(false);
      });
      nameInput.style.fontWeight = '550';
      nameInput.style.padding = '5px 9px';
      nameInput.style.fontSize = '13.5px';
      nameInput.title = m.hint || '';
      titleBox.appendChild(nameInput);
      main.appendChild(titleBox);

      const ctrls = el('div', 'sr-controls');
      ctrls.appendChild(optList(titles, ov.titleStyle || 'inherit', (v) => {
        const cur = opt(key);
        if (v === 'inherit') delete cur.titleStyle; else cur.titleStyle = v;
        // 选了左侧栏，位置默认跟着走
        if (v === 'gutter' && !cur.placement) cur.placement = 'left';
        touch();
      }, { width: 96 }));
      if (!isCustom) {
        ctrls.appendChild(optList(places, ov.placement || 'inherit', (v) => {
          const cur = opt(key);
          if (v === 'inherit') delete cur.placement; else cur.placement = v;
          touch();
        }, { width: 104 }));
      }
      ctrls.appendChild(optList(aligns, ov.align || 'inherit', (v) => {
        const cur = opt(key);
        if (v === 'inherit') delete cur.align; else cur.align = v;
        touch();
      }, { width: 92 }));
      ctrls.appendChild(optList(bullets, ov.bullet || 'inherit', (v) => {
        const cur = opt(key);
        if (v === 'inherit') delete cur.bullet; else cur.bullet = v;
        touch();
      }, { width: 92 }));
      // 条目排法只对「有单位/时间的条目」有意义；纯列表章节不显示
      if (ITEM_SECTIONS.has(key)) {
        ctrls.appendChild(optList(itemLayouts, ov.itemLayout || 'inherit', (v) => {
          const cur = opt(key);
          if (v === 'inherit') delete cur.itemLayout; else cur.itemLayout = v;
          touch();
        }, { width: 104 }));
      }
      ctrls.appendChild(optList(numberings, ov.numbering || 'inherit', (v) => {
        const cur = opt(key);
        if (v === 'inherit') delete cur.numbering; else cur.numbering = v;
        touch();
      }, { width: 96 }));
      ctrls.appendChild(optList(icons, ov.icon || 'inherit', (v) => {
        const cur = opt(key);
        if (v === 'inherit') delete cur.icon; else cur.icon = v;
        touch();
      }, { width: 96 }));

      const scaleWrap = el('label', null, '字号');
      const scaleInput = document.createElement('input');
      scaleInput.type = 'number';
      scaleInput.min = '0.7';
      scaleInput.max = '1.4';
      scaleInput.step = '0.05';
      scaleInput.value = ov.scale || 1;
      scaleInput.style.width = '58px';
      scaleInput.style.padding = '4px 6px';
      scaleInput.style.fontSize = '12px';
      scaleInput.onchange = () => {
        const cur = opt(key);
        const n = Number(scaleInput.value);
        if (!Number.isFinite(n) || n <= 0 || Math.abs(n - 1) < 0.001) delete cur.scale;
        else cur.scale = Math.min(1.4, Math.max(0.7, n));
        touch();
      };
      scaleWrap.appendChild(scaleInput);
      ctrls.appendChild(scaleWrap);
      const tail = el('div', 'sr-tail');
      tail.style.cssText = 'display:flex;align-items:center;gap:8px';
      tail.appendChild(switchInput(!hidden.has(key), '', (v) => {
        if (v) hidden.delete(key); else hidden.add(key);
        exp.hidden = Array.from(hidden);
        row.classList.toggle('off', !v);
        touch();
      }));

      const orderBox = el('div', 'sr-order');
      // 用 SVG 而不是 ↑↓ 字符：这两个字符不在中文字体里时会回退到符号字体，
      // Windows 上那个字体把这个字形画得又大又高，直接顶出按钮边界。
      const arrow = (dir) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 10 10');
        svg.setAttribute('width', '10');
        svg.setAttribute('height', '10');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        // 上下箭头各一条折线，用 currentColor 跟随按钮文字色
        path.setAttribute('d', dir === 'up' ? 'M5 1.6 L8.6 6.2 H1.4 Z' : 'M5 8.4 L1.4 3.8 H8.6 Z');
        path.setAttribute('fill', 'currentColor');
        svg.appendChild(path);
        return svg;
      };
      const up = el('button', null, '');
      up.appendChild(arrow('up'));
      up.title = '上移';
      up.setAttribute('aria-label', '上移');
      up.type = 'button';
      up.disabled = index === 0;
      up.onclick = () => {
        const arr = exp.layout.order;
        [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
        touch(false);
        draw();
      };
      const down = el('button', null, '');
      down.appendChild(arrow('down'));
      down.title = '下移';
      down.setAttribute('aria-label', '下移');
      down.type = 'button';
      // 最后一项固定是自定义板块，不让别的板块排到它后面
      down.disabled = index >= order.length - 1 || order[index + 1] === 'customSections';
      down.onclick = () => {
        const arr = exp.layout.order;
        [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
        touch(false);
        draw();
      };
      orderBox.appendChild(up);
      orderBox.appendChild(down);
      tail.appendChild(orderBox);
      main.appendChild(tail);

      row.appendChild(main);
      row.appendChild(ctrls);
      list.appendChild(row);
    });

    holder.appendChild(list);

    const foot = el('div');
    foot.style.cssText = 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap';
    const reset = el('button', 'btn sm', '恢复默认顺序与样式');
    reset.type = 'button';
    reset.onclick = () => {
      exp.layout.sections = {};
      exp.layout.order = normalizeOrder([], meta, (getState().style && getState().style.defaultOrder) || []);
      markDirty('settings');
      render();
    };
    foot.appendChild(reset);
    const hint = el('div', 'small muted');
    hint.style.cssText = 'display:flex;align-items:center';
    hint.textContent = '「跟随主题」表示用当前主题自带的样式。';
    foot.appendChild(hint);
    holder.appendChild(foot);
  }

  draw();
  return card('逐段版式', '每一块都能单独调标题样式、位置、对齐、符号与字号', holder);
}

/* --- 3. 头部与排版 --- */
function typoCard(exp, s) {
  const holder = el('div');
  const H = exp.layout.header;
  const hStyles = [
    { value: 'inherit', label: '跟随主题' },
    { value: 'rule', label: '细线分割' },
    { value: 'band', label: '渐变横幅' },
    { value: 'center', label: '居中大标题' },
    { value: 'plain', label: '纯文字' },
  ];
  const hAligns = [
    { value: 'inherit', label: '跟随主题' },
    { value: 'left', label: '左对齐' },
    { value: 'center', label: '居中' },
    { value: 'right', label: '右对齐' },
  ];

  const g1 = el('div', 'grid grid-2');
  g1.appendChild(field('头部样式', optList(hStyles, H.style || 'inherit', (v) => {
    if (v === 'inherit') delete H.style; else H.style = v;
    markDirty('settings');
    refreshPreview();
  }, { width: '100%' })));
  g1.appendChild(field('头部对齐', optList(hAligns, H.align || 'inherit', (v) => {
    if (v === 'inherit') delete H.align; else H.align = v;
    markDirty('settings');
    refreshPreview();
  }, { width: '100%' })));
  holder.appendChild(g1);

  const sw = el('div');
  sw.style.cssText = 'display:flex;gap:22px;flex-wrap:wrap;margin-top:16px';
  sw.appendChild(switchInput(H.chips == null ? true : !!H.chips, '联系方式用胶囊标签', (v) => {
    H.chips = v;
    markDirty('settings');
    refreshPreview();
  }));
  sw.appendChild(switchInput(H.showContacts == null ? true : !!H.showContacts, '显示联系方式', (v) => {
    H.showContacts = v;
    markDirty('settings');
    refreshPreview();
  }));
  sw.appendChild(switchInput(H.showTitle == null ? true : !!H.showTitle, '显示职位 / 一句话定位', (v) => {
    H.showTitle = v;
    markDirty('settings');
    refreshPreview();
  }));
  holder.appendChild(sw);

  holder.appendChild(el('div', 'divider'));

  const g2 = el('div', 'grid grid-4');
  g2.appendChild(field('正文字号（px）', numInput(exp.fontSize, 8, 20, 0.5, (v) => {
    exp.fontSize = v;
    markDirty('settings');
    refreshPreview();
  }), '留空用主题默认'));
  g2.appendChild(field('行高', numInput(exp.lineHeight, 1, 2.6, 0.02, (v) => {
    exp.lineHeight = v;
    markDirty('settings');
    refreshPreview();
  }), '留空用主题默认'));
  g2.appendChild(field('页面尺寸', optList([
    { value: 'A4', label: 'A4（210×297mm）' },
    { value: 'Letter', label: 'Letter（216×279mm）' },
    { value: 'A5', label: 'A5（148×210mm）' },
  ], exp.pageSize || 'A4', (v) => {
    exp.pageSize = v;
    markDirty('settings');
    refreshPreview();
  }, { width: '100%' })));
  g2.appendChild(field('页边距', textInput(exp.margin || '14mm 15mm', '14mm 15mm', (v) => {
    exp.margin = v;
    markDirty('settings');
    refreshPreview();
  }), '如 14mm 15mm'));
  holder.appendChild(g2);

  const g3 = el('div', 'grid grid-2');
  g3.style.marginTop = '14px';
  const accentField = field('主题色（留空用主题默认）', textInput(exp.accent || '', '#4f46e5', (v) => {
    exp.accent = v.trim();
    markDirty('settings');
    refreshPreview();
  }));
  g3.appendChild(accentField);
  const decor = el('div');
  decor.style.cssText = 'display:flex;gap:20px;flex-wrap:wrap;align-items:center;padding-top:6px';
  decor.appendChild(switchInput(exp.showPageNumbers, '显示页码', (v) => {
    exp.showPageNumbers = v;
    markDirty('settings');
    refreshPreview();
  }));
  decor.appendChild(switchInput(exp.showWatermark, '显示水印', (v) => {
    exp.showWatermark = v;
    markDirty('settings');
    refreshPreview();
    wmBox.hidden = !v;
  }));
  g3.appendChild(decor);
  holder.appendChild(g3);

  const wmBox = field('水印文字', textInput(exp.watermarkText || '内部草稿', '内部草稿', (v) => {
    exp.watermarkText = v;
    markDirty('settings');
    refreshPreview();
  }));
  wmBox.style.marginTop = '12px';
  wmBox.style.maxWidth = '280px';
  wmBox.hidden = !exp.showWatermark;
  holder.appendChild(wmBox);

  return card('头部与排版', '整体字号、页面尺寸与装饰；单段微调见上一张卡片', holder);
}

function numInput(value, min, max, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = value == null || value === 0 ? '' : value;
  input.placeholder = '主题默认';
  input.min = min;
  input.max = max;
  input.step = step;
  input.addEventListener('input', () => onChange(input.value === '' ? 0 : Number(input.value)));
  return input;
}

/* --- 4. 自定义 CSS --- */
const CSS_CHEATS = [
  ['.page', '整页容器，可改 padding、背景、字体'],
  ['.head / .head .name', '头部、姓名（姓名要带 .head 才能压过主题）'],
  ['.head .title', '职位'],
  ['.head .contacts .contact / .head .chip', '联系方式整行、每一段'],
  ['.sec / .sec .sec-title', '章节、章节标题'],
  ['.sec .sec-body', '章节正文区域'],
  ['.item / .item-head', '一条经历、经历标题行'],
  ['.item .item-org / .item .item-role', '机构名、职位名'],
  ['.item .item-right', '右侧时间'],
  ['.bullets li', '要点列表的每一条'],
  ['.summary', '个人简介段落'],
  ['.skill-row .skill-cat', '技能行、技能分类'],
  ['--accent / --ink', 'CSS 变量：主色、正文色'],
];

const SAMPLE_CSS = `/* 例：章节标题加一条左侧竖线 */
.sec .sec-title { border-left: 2px solid var(--accent); padding-left: .5em; }
/* 例：姓名拉开字距 */
.head .name { letter-spacing: .06em; }
/* 例：要点圆点换成主题色竖线 */
.bullets li::before { content: ""; width: 2px; height: .92em;
  background: var(--accent); top: .32em; left: -8px; }
/* 例：整页左右留白更大 */
.page { padding-inline: 6mm; }`;

/* --- 4.4 用一句话让 AI 写 CSS --- */
function cssAiBox(exp, ta) {
  const s = getState();
  const plist = (s.providers && s.providers.providers) || [];
  const activeId = (s.providers && s.providers.activeId) || '';
  const active = plist.find((p) => p.id === activeId) || plist.find((p) => p.enabled !== false) || null;
  const usable = !!active && active.protocol !== 'mock';

  const box = el('div', 'css-ai');
  const head = el('div', 'css-ai-head');
  head.appendChild(el('span', 'css-ai-label', '说一句想要的效果'));
  head.appendChild(el('span', 'css-ai-who', usable
    ? `AI：${active.name || active.model}`
    : '还没有可用的 AI 供应商'));
  box.appendChild(head);

  const input = document.createElement('textarea');
  input.className = 'css-ai-input';
  input.rows = 2;
  input.spellcheck = false;
  input.placeholder = '例如：标题做得像杂志，左边加一条细竖线；条目之间再紧凑一点，正文用深灰';
  input.maxLength = 600;
  input.title = '按 Ctrl/⌘ + Enter 直接生成';
  box.appendChild(input);

  const acts = el('div', 'css-ai-acts');
  const gen = el('button', 'btn sm primary', '生成 CSS');
  gen.type = 'button';
  gen.title = '按你的描述重新写一段 CSS（可撤销）';
  const refine = el('button', 'btn sm', '在此基础上调整');
  refine.type = 'button';
  refine.title = '把编辑器里现有的 CSS 一起发给 AI，让它在此基础上改';
  const undo = el('button', 'btn sm quiet', '撤销生成');
  undo.type = 'button';
  undo.title = '退回生成之前的那一版 CSS';
  undo.hidden = true;
  const status = el('span', 'css-ai-status small muted');
  acts.append(gen, refine, undo, status);
  box.appendChild(acts);

  if (!usable) {
    box.classList.add('off');
    gen.disabled = true;
    refine.disabled = true;
    const tip = el('div', 'tip warn');
    tip.innerHTML = '<b>还没有可用的 AI 供应商</b>「模拟供应商」不会真的写 CSS。到「供应商」页加一个真实模型，这里就能用了。';
    box.appendChild(tip);
  }

  let prev = null;
  let busy = false;

  function applyCss(css) {
    ta.value = css;
    exp.layout.customCSS = css;
    markDirty('settings');
    refreshPreview(true);
  }

  async function run(mode) {
    if (busy) return;
    const prompt = input.value.trim();
    if (!prompt) {
      toast('先说说想要什么效果', 'err');
      input.focus();
      return;
    }
    busy = true;
    const before = ta.value;
    gen.disabled = true;
    refine.disabled = true;
    status.textContent = 'AI 正在写 CSS…';
    try {
      const out = await api('/api/css/generate', {
        prompt,
        current: mode === 'refine' ? ta.value : '',
        theme: exp.theme,
      });
      if (!out.ok) throw new Error(out.error || '生成失败');
      prev = before;
      applyCss(out.css);
      undo.hidden = false;
      const lines = out.css.split('\n').filter((l) => l.trim()).length;
      status.textContent = `已生成 ${lines} 行${out.provider ? ` · ${out.provider}` : ''}`;
      if (out.warnings && out.warnings.length) toast(out.warnings.join('；'), '');
      toast('CSS 已生成并应用', 'ok');
    } catch (err) {
      status.textContent = '';
      toast(err.message || '生成失败', 'err');
    } finally {
      busy = false;
      gen.disabled = false;
      refine.disabled = false;
    }
  }

  gen.onclick = () => run('new');
  refine.onclick = () => run('refine');
  undo.onclick = () => {
    if (prev == null) return;
    applyCss(prev);
    prev = null;
    undo.hidden = true;
    status.textContent = '已撤销上一次生成';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run('new');
    }
  });

  return box;
}

function cssCard(exp) {
  const holder = el('div');

  const bar = el('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap';
  const engineTip = el('span', 'pill info', '导出 PDF 时自动切到浏览器引擎');
  engineTip.title = '内置排版引擎读不懂 CSS 选择器，所以一旦写了自定义 CSS，导出 PDF 会用本机 Chrome 渲染，保证样式生效';
  bar.appendChild(engineTip);
  const insert = el('button', 'btn sm', '插入示例');
  insert.type = 'button';
  insert.style.marginLeft = 'auto';
  insert.onclick = () => {
    const ta = $('.css-editor', holder);
    ta.value = ta.value.trim() ? `${ta.value}\n\n${SAMPLE_CSS}` : SAMPLE_CSS;
    ta.dispatchEvent(new Event('input'));
  };
  bar.appendChild(insert);
  const clear = el('button', 'btn sm danger', '清空');
  clear.type = 'button';
  clear.onclick = () => {
    const ta = $('.css-editor', holder);
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
  };
  bar.appendChild(clear);
  holder.appendChild(bar);

  const ta = document.createElement('textarea');
  ta.className = 'css-editor';
  ta.spellcheck = false;
  ta.placeholder = '/* 直接写 CSS，会追加在主题样式之后 */\n.head .name { letter-spacing: .04em; }';
  ta.value = exp.layout.customCSS || '';
  const apply = debounce(() => {
    exp.layout.customCSS = ta.value;
    markDirty('settings');
    refreshPreview();
  }, 600);
  ta.addEventListener('input', apply);
  // Tab 缩进而不是跳焦点
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = ta;
      ta.value = `${value.slice(0, a)}  ${value.slice(b)}`;
      ta.selectionStart = ta.selectionEnd = a + 2;
      apply();
    }
  });
  holder.appendChild(ta);

  holder.insertBefore(cssAiBox(exp, ta), ta);

  const det = document.createElement('details');
  det.style.marginTop = '12px';
  const sum = document.createElement('summary');
  sum.className = 'small muted';
  sum.style.cssText = 'cursor:pointer;padding:4px 0';
  sum.textContent = '可以改哪些选择器？';
  det.appendChild(sum);
  const cheats = el('div', 'css-cheats');
  cheats.style.marginTop = '10px';
  CSS_CHEATS.forEach(([sel, desc]) => {
    const row = el('div');
    row.appendChild(el('code', null, sel));
    row.appendChild(el('span', null, desc));
    cheats.appendChild(row);
  });
  det.appendChild(cheats);
  holder.appendChild(det);

  return card('自定义 CSS', '说一句想要的效果让 AI 写，也可以直接改代码；同级选择器里后写的优先', holder);
}

/* --- 5. 预览与导出 --- */
let previewSeq = 0;

function previewCard(exp, s) {
  const holder = el('div');
  const bar = el('div', 'preview-bar');
  holder.appendChild(bar);

  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('title', '简历预览');
  const stage = el('div', 'preview-stage');
  stage.appendChild(frame);
  holder.appendChild(stage);

  const mk = (label, kind, path, fallback) => {
    const b = el('button', `btn sm${kind === 'pdf' ? ' primary' : ''}`, label);
    b.type = 'button';
    b.onclick = async () => {
      try {
        toast(kind === 'pdf' ? '正在生成 PDF…' : '正在导出…');
        const name = (s.profile.basics && s.profile.basics.name) || '我的简历';
        await download(path, { resume: s.profile, opts: exp, filename: name }, fallback);
        toast('已导出', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    return b;
  };
  bar.appendChild(mk('导出 PDF', 'pdf', '/api/export/pdf', '简历.pdf'));
  bar.appendChild(mk('导出 HTML', 'html', '/api/export/html', '简历.html'));
  bar.appendChild(mk('导出 Markdown', 'md', '/api/export/markdown', '简历.md'));

  if (s.pdfAvailable) {
    const eng = el('span', 'pill', s.pdfEngine === 'chrome' ? 'PDF：浏览器引擎' : 'PDF：内置引擎');
    eng.title = s.pdfEngine === 'chrome'
      ? '当前用本机 Chrome 打印 PDF（PDF_ENGINE=chrome）'
      : '当前用项目自带的纯 JS 引擎生成 PDF，不依赖浏览器；写了自定义 CSS 时会自动改用浏览器引擎';
    bar.appendChild(eng);
  }

  const status = el('span', 'pb-status', '待更新');
  bar.appendChild(status);

  if (!s.pdfAvailable) {
    const t = el('div', 'tip err', '当前环境既没有可用字体也没有可用的 Chrome，PDF 导出不可用；HTML 与 Markdown 不受影响。');
    t.style.marginBottom = '12px';
    holder.insertBefore(t, stage);
  }

  const c = card('实时预览与导出', '预览即最终 PDF 的排版，可按 Ctrl/⌘ + P 打印', holder);
  // 把 iframe 引用挂到卡片上，供 refreshPreview 使用
  c.__frame = frame;
  c.__status = status;
  return c;
}

async function renderInto(frame, status, opts) {
  const s = getState();
  const seq = ++previewSeq;
  if (status) {
    status.classList.add('busy');
    status.textContent = '渲染中…';
  }
  try {
    const res = await fetch('/api/preview/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: s.profile, opts }),
    });
    const html = await res.text();
    if (seq !== previewSeq) return;
    frame.srcdoc = html;
    if (status) {
      status.classList.remove('busy');
      const t = new Date();
      status.textContent = `已更新 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
  } catch (err) {
    if (seq !== previewSeq) return;
    if (status) {
      status.classList.remove('busy');
      status.textContent = '渲染失败';
    }
    frame.srcdoc = `<div style="font:14px sans-serif;color:#d70015;padding:30px">预览失败：${esc(err.message)}</div>`;
  }
}

let pendingPreview = null;

export function refreshPreview(immediate = false) {
  if (immediate) {
    doPreview();
    return;
  }
  if (pendingPreview) clearTimeout(pendingPreview);
  pendingPreview = setTimeout(doPreview, 320);
}

function doPreview() {
  pendingPreview = null;
  const cardEl = $('#settings-root .card:last-child');
  const frame = cardEl && cardEl.__frame;
  if (!frame) return;
  if (!frame.isConnected) return;
  renderInto(frame, cardEl.__status, expOf());
}
