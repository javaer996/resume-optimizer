// 应用主控：状态、路由、保存

import { $, $$, api, toast, clone, debounce, openModal } from './util.js';
import * as profileView from './profile.js';
import * as companiesView from './companies.js';
import * as optimizeView from './optimize.js';
import * as resultsView from './results.js';
import * as maskView from './maskview.js';
import * as promptsView from './prompts.js';
import * as providersView from './providers.js';
import * as settingsView from './settings.js';

export const state = {
  profile: null,
  companies: [],
  jobs: [],
  providers: { providers: [], activeId: '' },
  prompts: { templates: [], activeTemplateId: '', history: [] },
  settings: null,
  themes: [],
  tokens: {},
  pdfAvailable: false,
  selectedCompanies: [],
  activeJobId: null,
  activeCompanyId: null,
  currentView: 'profile',
};

const VIEWS = {
  profile: profileView,
  companies: companiesView,
  optimize: optimizeView,
  results: resultsView,
  mask: maskView,
  prompts: promptsView,
  providers: providersView,
  settings: settingsView,
};

const dirty = new Set();

function setHint(text, cls = '') {
  const el = $('#save-hint');
  el.textContent = text;
  el.className = `save-hint ${cls}`;
}

export function markDirty(kind) {
  dirty.add(kind);
  setHint('有未保存的修改…', '');
  scheduleSave();
}

const scheduleSave = debounce(async () => {
  await flushSave();
}, 900);

export async function flushSave() {
  if (!dirty.size) return;
  const kinds = Array.from(dirty);
  dirty.clear();
  setHint('保存中…');
  try {
    for (const kind of kinds) {
      if (kind === 'profile') {
        await api('/api/profile', { profile: state.profile });
      } else if (kind === 'settings') {
        await api('/api/settings', { settings: state.settings });
      }
    }
    setHint('已自动保存', 'ok');
    setTimeout(() => { if (!dirty.size && $('#save-hint').textContent === '已自动保存') setHint(''); }, 2200);
  } catch (err) {
    kinds.forEach((k) => dirty.add(k));
    setHint(`保存失败：${err.message}`, 'err');
  }
}

export function getState() {
  return state;
}

export async function refresh({ silent = true } = {}) {
  try {
    const data = await api('/api/state');
    const keepSelected = state.selectedCompanies;
    Object.assign(state, data);
    // 只保留仍存在的单位选择
    const ids = new Set(state.companies.map((c) => c.id));
    state.selectedCompanies = (keepSelected || []).filter((id) => ids.has(id));
    updateBadges();
    renderCurrent();
  } catch (err) {
    if (!silent) toast(`加载失败：${err.message}`, 'err');
  }
}

export function renderCurrent() {
  const view = VIEWS[state.currentView];
  if (view && view.render) view.render();
}

export function switchView(name) {
  state.currentView = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  renderCurrent();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function updateBadges() {
  const badge = $('#tab-company-count');
  if (badge) {
    badge.hidden = state.companies.length === 0;
    badge.textContent = String(state.companies.length);
  }
}

/* ---------------- 保存动作 ---------------- */

export async function saveCompany(company) {
  const res = await api('/api/companies', { company });
  await refresh();
  return res.company;
}

export async function saveProviders(providers, activeId) {
  const res = await api('/api/providers', { providers, activeId });
  state.providers = { providers: res.providers, activeId: res.activeId };
  renderCurrent();
  return res;
}

export async function savePrompts(payload) {
  const res = await api('/api/prompts', payload);
  if (res.templates) {
    state.prompts = {
      templates: res.templates,
      activeTemplateId: res.activeTemplateId,
      history: res.history || [],
    };
  }
  renderCurrent();
  return res;
}

/* ---------------- 启动 ---------------- */

async function boot() {
  const ctx = { getState, markDirty, refresh, saveCompany, savePrompts, saveProviders, switchView };
  profileView.init(ctx);
  companiesView.init({ ...ctx, saveCompanies: saveCompany });
  optimizeView.init(ctx);
  resultsView.init(ctx);
  maskView.init(ctx);
  promptsView.init(ctx);
  providersView.init({ ...ctx, saveProviders });
  settingsView.init(ctx);

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      flushSave();
      switchView(tab.dataset.view);
    });
  });

  $('#btn-save-all').addEventListener('click', async () => {
    dirty.add('profile');
    dirty.add('settings');
    await flushSave();
    await refresh();
    toast('已全部保存', 'ok');
  });

/* ---------------- 账户 ---------------- */

// 顶栏那个「账户」按钮：显示当前账号、改密码、退出登录
async function accountDialog() {
  let info = { user: '' };
  try { info = await api('/api/auth/status'); } catch (_) { /* 401 会自己跳走 */ }

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field">
      <label>当前账号</label>
      <div class="kv-inline"><b>${info.user ? info.user.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) : '—'}</b>
        <span class="muted">密码以加盐哈希保存在 data/auth.json</span></div>
    </div>
    <div class="field">
      <label for="acct-cur">当前密码</label>
      <input id="acct-cur" type="password" autocomplete="current-password" placeholder="改密码需要先验证">
    </div>
    <div class="field">
      <label for="acct-new">新密码</label>
      <input id="acct-new" type="password" autocomplete="new-password" placeholder="至少 8 位">
    </div>
    <div class="field">
      <label for="acct-new2">再输一次</label>
      <input id="acct-new2" type="password" autocomplete="new-password" placeholder="确认新密码">
    </div>
    <p class="tip with-icon" id="acct-msg" hidden></p>
  `;

  const foot = document.createElement('div');
  const logout = document.createElement('button');
  logout.className = 'btn quiet';
  logout.textContent = '退出登录';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await api('/api/auth/logout', {}); } catch (_) { /* 忽略 */ }
    location.replace('/login.html');
  });
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = '改密码';
  save.addEventListener('click', async () => {
    const cur = $('#acct-cur').value;
    const next = $('#acct-new').value;
    const next2 = $('#acct-new2').value;
    const msg = $('#acct-msg');
    const show = (text) => { msg.hidden = false; msg.textContent = text; };
    if (!cur) return show('请先填当前密码。');
    if (next.length < 8) return show('新密码至少 8 位。');
    if (next !== next2) return show('两次输入的新密码不一致。');
    save.disabled = true;
    try {
      await api('/api/auth/change-password', { current: cur, next });
      toast('密码已更新', 'ok');
      close();
    } catch (err) {
      show(err.message || '改密码失败');
      save.disabled = false;
    }
  });
  foot.appendChild(logout);
  foot.appendChild(save);

  const { close } = openModal({ title: '账户', body, footer: foot, width: '440px' });
  $('#acct-cur').focus();
}


  $('#btn-account').addEventListener('click', accountDialog);

  $('#btn-new-company').addEventListener('click', () => companiesView.newCompanyDialog());
  $('#btn-import-company').addEventListener('click', () => companiesView.importDialog());

  window.addEventListener('beforeunload', (e) => {
    if (dirty.size) {
      flushSave();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      dirty.add('profile');
      dirty.add('settings');
      flushSave();
      toast('已保存', 'ok');
    }
    if (e.key === 'Escape') $('#modal-mask').classList.remove('show');
  });

  await refresh({ silent: false });

  const hash = location.hash.replace('#', '');
  if (VIEWS[hash]) switchView(hash);
  else switchView('profile');

  if (!state.profile.basics.name && !state.profile.work.length) {
    toast('提示：可以先点「填入示例数据」快速体验完整流程', '');
  }
}

boot().catch((err) => {
  console.error(err);
  toast(`应用初始化失败：${err.message}`, 'err');
});

window.__app = { state, refresh, switchView };
