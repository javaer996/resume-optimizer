// AI 供应商配置

import { el, field, textInput, textArea, selectInput, switchInput } from './form.js';
import { $, esc, toast, api, confirmDialog, openModal, clone } from './util.js';

let getState = () => ({});
let saveProviders = () => {};

export function init(ctx) {
  getState = ctx.getState;
  saveProviders = ctx.saveProviders;
}

const PRESETS = [
  {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '官方接口，需要海外网络环境',
  },
  {
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '兼容 OpenAI 协议，中文效果好，价格低',
  },
  {
    label: 'Moonshot 月之暗面',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    note: 'Kimi 背后的模型服务',
  },
  {
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    note: '国内可直连',
  },
  {
    label: '阿里通义千问',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: 'DashScope 兼容模式',
  },
  {
    label: '本地 Ollama',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:14b',
    note: '完全本地运行，数据不出机器，apiKey 随便填',
  },
  {
    label: 'one-api / new-api 网关',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:3000/v1',
    model: 'gpt-4o-mini',
    note: '自建聚合网关，统一管理多个上游',
  },
  {
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    note: '使用 Messages API 协议',
  },
];

export function render() {
  const root = $('#providers-root');
  const s = getState();
  root.innerHTML = '';

  const list = s.providers.providers || [];

  const bar = el('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap';
  const addBtn = el('button', 'btn primary sm', '添加供应商');
  addBtn.onclick = () => editProvider(null);
  bar.appendChild(addBtn);
  root.appendChild(bar);

  const tip = el('div', 'tip');
  tip.innerHTML = '你的 API Key 只保存在本机 <code>data/providers.json</code>，不会以任何方式上传或出现在导出文件中。'
    + '所有请求都由本机 Node 进程直接发往你填写的接口地址。';
  tip.style.marginBottom = '14px';
  root.appendChild(tip);

  if (!list.length) {
    const e = el('div', 'empty');
    e.appendChild(el('strong', null, '还没有供应商配置'));
    root.appendChild(e);
    return;
  }

  list.forEach((p, idx) => {
    const card = el('div', 'company-card');
    card.style.marginBottom = '10px';

    const head = el('div', 'cc-head');
    head.style.alignItems = 'center';
    const nameBox = el('div');
    nameBox.style.flex = '1';
    nameBox.appendChild(el('div', 'cc-name', p.name));
    const meta = el('div', 'cc-pos');
    meta.textContent = `${protocolName(p.protocol)} · ${p.model || '未填写模型'}${p.baseUrl ? ` · ${p.baseUrl}` : ''}`;
    nameBox.appendChild(meta);
    head.appendChild(nameBox);

    if (s.providers.activeId === p.id) {
      head.appendChild(el('span', 'pill ok', '当前使用'));
    } else {
      const useBtn = el('button', 'btn sm', '设为当前');
      useBtn.onclick = async () => {
        await saveProviders(list, p.id);
        toast(`已切换到「${p.name}」`, 'ok');
      };
      head.appendChild(useBtn);
    }
    card.appendChild(head);

    const foot = el('div', 'cc-foot');
    const testBtn = el('button', 'btn sm', '测试连接');
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      try {
        const res = await api('/api/providers/test', { provider: p });
        if (res.ok) toast(`连接正常（${res.elapsedMs}ms）：${res.reply}`, 'ok');
        else toast(`连接失败：${res.error}`, 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
      }
    };
    foot.appendChild(testBtn);

    const editBtn = el('button', 'btn sm', '编辑');
    editBtn.onclick = () => editProvider(p);
    foot.appendChild(editBtn);

    const dupBtn = el('button', 'btn sm', '复制');
    dupBtn.onclick = async () => {
      const copy = { ...p, id: '', name: `${p.name} 副本` };
      const next = [...list, copy];
      await saveProviders(next, s.providers.activeId);
      toast('已复制', 'ok');
    };
    foot.appendChild(dupBtn);

    if (!p.builtin) {
      const delBtn = el('button', 'btn sm danger', '删除');
      delBtn.onclick = async () => {
        if (!(await confirmDialog(`确定删除供应商「${p.name}」？`, { danger: true, okText: '删除' }))) return;
        const next = list.filter((x) => x.id !== p.id);
        await saveProviders(next, s.providers.activeId === p.id ? (next[0] && next[0].id) || '' : s.providers.activeId);
        toast('已删除', 'ok');
      };
      foot.appendChild(delBtn);
    }
    card.appendChild(foot);
    root.appendChild(card);
  });
}

function protocolName(p) {
  return { openai: 'OpenAI 兼容', anthropic: 'Anthropic Messages', mock: '内置模拟器' }[p] || p;
}

function editProvider(existing) {
  const draft = existing ? clone(existing) : {
    id: '', name: '', protocol: 'openai', baseUrl: '', apiKey: '', model: '',
    temperature: 0.5, maxTokens: 4096, jsonMode: false, timeoutMs: 60000, headers: {}, enabled: true,
  };

  const wrap = el('div');

  /* 快速预设 */
  const presetWrap = el('div');
  presetWrap.appendChild(el('div', 'small muted', '快速填充预设'));
  const presetRow = el('div');
  presetRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px';
  PRESETS.forEach((preset) => {
    const b = el('button', 'btn sm', preset.label);
    b.title = preset.note;
    b.onclick = () => {
      draft.protocol = preset.protocol;
      draft.baseUrl = preset.baseUrl;
      draft.model = preset.model;
      if (!draft.name.trim() || PRESETS.some((x) => x.label === draft.name)) draft.name = preset.label;
      rebuild();
    };
    presetRow.appendChild(b);
  });
  presetWrap.appendChild(presetRow);
  wrap.appendChild(presetWrap);

  const formBox = el('div');
  wrap.appendChild(formBox);

  function rebuild() {
    formBox.innerHTML = '';
    formBox.appendChild(grid2(
      field('显示名称 *', textInput(draft.name, '例如：我的 DeepSeek', (v) => { draft.name = v; })),
      field('协议类型', selectInput(draft.protocol, [
        { value: 'openai', label: 'OpenAI 兼容（推荐，覆盖绝大多数服务）' },
        { value: 'anthropic', label: 'Anthropic Messages API' },
        { value: 'mock', label: '内置模拟器（离线测试用）' },
      ], (v) => { draft.protocol = v; rebuild(); })),
    ));

    if (draft.protocol === 'mock') {
      const t = el('div', 'tip');
      t.style.marginTop = '12px';
      t.textContent = '内置模拟器不需要网络和 Key，会按固定规则生成一份演示用的优化结果，适合先跑通整个流程。';
      formBox.appendChild(t);
      return;
    }

    const apiField = field(
      'API Key',
      textInput(draft.apiKey, draft.protocol === 'anthropic' ? 'sk-ant-…' : 'sk-…', (v) => { draft.apiKey = v; }, { type: 'password' }),
      '仅保存在本机，不会上传',
    );
    apiField.style.marginTop = '12px';
    formBox.appendChild(apiField);

    const urlField = field(
      '接口地址（Base URL）',
      textInput(draft.baseUrl, draft.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1', (v) => { draft.baseUrl = v; }),
      '可填到 /v1 为止；也支持直接填完整的 /chat/completions 地址',
    );
    urlField.style.marginTop = '12px';
    formBox.appendChild(urlField);

    const modelField = field(
      '模型名称',
      textInput(draft.model, 'deepseek-chat', (v) => { draft.model = v; }),
      '必须与服务商文档中的名称完全一致',
    );
    modelField.style.marginTop = '12px';
    formBox.appendChild(modelField);

    const metricsGrid = grid3(
      field('温度（0-2）', numberInput(draft.temperature, (v) => { draft.temperature = v; }, 0, 2, 0.1)),
      field('最大输出 token', numberInput(draft.maxTokens, (v) => { draft.maxTokens = v; }, 256, 32000, 256)),
      field('超时（毫秒）', numberInput(draft.timeoutMs, (v) => { draft.timeoutMs = v; }, 5000, 300000, 1000)),
    );
    metricsGrid.style.marginTop = '12px';
    formBox.appendChild(metricsGrid);

    const opts = el('div');
    opts.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:8px';
    opts.appendChild(switchInput(draft.jsonMode, '请求 JSON 输出模式（部分服务在优化简历时更稳定）', (v) => { draft.jsonMode = v; }));
    formBox.appendChild(opts);

    /* 自定义请求头 */
    const headerBox = el('div');
    headerBox.style.marginTop = '12px';
    const hToggle = el('button', 'btn ghost sm', '自定义请求头 ▾');
    headerBox.appendChild(hToggle);
    const hList = el('div');
    hList.style.display = 'none';
    hList.style.marginTop = '8px';
    const hHint = el('div', 'small muted', '格式：每行一个，如 `X-Org-Id: abc123`。需要走代理或网关鉴权时才用。');
    hList.appendChild(hHint);
    const hArea = textArea(
      Object.entries(draft.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
      'X-Custom-Header: value',
      (v) => {
        const h = {};
        v.split('\n').forEach((line) => {
          const i = line.indexOf(':');
          if (i > 0) {
            const k = line.slice(0, i).trim();
            const val = line.slice(i + 1).trim();
            if (k) h[k] = val;
          }
        });
        draft.headers = h;
      },
      { rows: 3, mono: true },
    );
    hList.appendChild(hArea);
    hToggle.onclick = () => {
      const open = hList.style.display === 'none';
      hList.style.display = open ? '' : 'none';
      hToggle.textContent = open ? '自定义请求头 ▴' : '自定义请求头 ▾';
    };
    headerBox.appendChild(hList);
    formBox.appendChild(headerBox);
  }

  rebuild();

  const foot = document.createElement('div');
  const cancel = el('button', 'btn', '取消');
  const test = el('button', 'btn', '先测试连接');
  const save = el('button', 'btn primary', existing ? '保存修改' : '添加');
  foot.appendChild(cancel);
  foot.appendChild(test);
  foot.appendChild(save);
  const m = openModal({ title: existing ? `编辑：${existing.name}` : '添加 AI 供应商', body: wrap, footer: foot, width: '760px' });
  cancel.onclick = () => m.close();

  test.onclick = async () => {
    test.disabled = true;
    test.textContent = '测试中…';
    try {
      const res = await api('/api/providers/test', { provider: draft });
      if (res.ok) toast(`连接正常（${res.elapsedMs}ms）：${res.reply}`, 'ok');
      else toast(`连接失败：${res.error}`, 'err');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      test.disabled = false;
      test.textContent = '先测试连接';
    }
  };

  save.onclick = async () => {
    if (!draft.name.trim()) { toast('请填写显示名称', 'err'); return; }
    if (draft.protocol !== 'mock') {
      if (!draft.baseUrl.trim()) { toast('请填写接口地址', 'err'); return; }
      if (!draft.model.trim()) { toast('请填写模型名称', 'err'); return; }
    }
    save.disabled = true;
    try {
      const s = getState();
      const list = clone(s.providers.providers || []);
      const idx = list.findIndex((x) => x.id === draft.id && draft.id);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft);
      const activeId = s.providers.activeId || draft.id || (list[0] && list[0].id);
      await saveProviders(list, activeId);
      m.close();
      toast(existing ? '已保存' : '已添加', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      save.disabled = false;
    }
  };
}

function numberInput(value, onChange, min, max, step) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = value == null ? '' : value;
  if (min != null) input.min = min;
  if (max != null) input.max = max;
  if (step != null) input.step = step;
  input.addEventListener('input', () => onChange(Number(input.value)));
  return input;
}

function grid2(a, b) {
  const g = el('div', 'grid grid-2');
  g.appendChild(a);
  g.appendChild(b);
  return g;
}

function grid3(a, b, c) {
  const g = el('div', 'grid grid-3');
  g.appendChild(a);
  g.appendChild(b);
  g.appendChild(c);
  return g;
}
