// 通用工具：DOM 构建、转义、请求、提示、弹窗

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uid(prefix = 'x') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function toast(msg, type = '') {
  const wrap = $('#toast-wrap');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = msg;
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, type === 'err' ? 5200 : 2600);
}

/** 会话过期时统一跳回登录页：并发请求只跳一次，避免刷屏 */
let redirecting = false;
function sessionExpired() {
  if (redirecting) return;
  redirecting = true;
  const here = location.pathname + location.search + location.hash;
  const next = here && here !== '/' && here !== '/index.html'
    ? '/login.html?next=' + encodeURIComponent(here)
    : '/login.html';
  location.replace(next);
}

/** 401 一律当成"要重新登录"，而不是让页面弹一个看不懂的错误 */
function guard(res) {
  if (res.status === 401) {
    sessionExpired();
    const err = new Error('登录已过期，请重新登录');
    err.code = 'unauthenticated';
    throw err;
  }
  return res;
}

export async function api(path, body) {
  const opts = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = guard(await fetch(path, opts));
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(`服务返回异常（${res.status}）：${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!res.ok && data.error) throw new Error(data.error);
  return data;
}

/** 触发后端导出并下载 */
export async function download(path, body, fallbackName) {
  const res = guard(await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) {
    let msg = `导出失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disp = res.headers.get('content-disposition') || '';
  let name = fallbackName || '简历';
  // 优先 RFC 5987 的 filename*=UTF-8''，其次退回到 filename=…
  const star = disp.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disp.match(/filename="([^"]+)"/);
  if (star) {
    try { name = decodeURIComponent(star[1]); } catch (_) { name = star[1]; }
  } else if (plain) {
    try { name = decodeURIComponent(plain[1]); } catch (_) { name = plain[1]; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 弹窗：返回 { close }，body 可传 HTML 字符串或节点。
 *
 * 关闭有四条路：标题栏的「关闭」、点遮罩、Esc、以及调用方自己的取消按钮。
 * 以前只在 confirmDialog 里绑过 #modal-close，其它弹窗的「关闭」按钮点了没反应；
 * 手机上遮罩被铺满整屏、又没有键盘，于是整页卡死在一个关不掉的弹窗里。
 * 这里统一绑，谁都别再单独绑。
 */
export function openModal({ title, body, footer, width }) {
  const mask = $('#modal-mask');
  const modal = $('.modal', mask);
  $('#modal-title').textContent = title || '';
  const bodyEl = $('#modal-body');
  const footEl = $('#modal-foot');
  if (bodyEl) bodyEl.innerHTML = '';
  if (footEl) footEl.innerHTML = '';
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  if (footer) {
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else footEl.appendChild(footer);
  }
  modal.style.width = width ? `min(${width}, 100%)` : '';
  mask.classList.add('show');
  // 打开后把焦点放进弹窗，键盘用户可以直接 Tab；避免焦点留在背后的页面上
  const focusable = modal.querySelector('input, select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 60);
  const close = () => mask.classList.remove('show');
  bindModalDismiss();
  return { el: bodyEl, foot: footEl, close };
}

/**
 * 让弹窗能用「关闭按钮 / 点遮罩」关掉。
 * 用事件委托绑在遮罩上，只绑一次：手动开弹窗的地方（profile.js 的导入框）
 * 也走这个函数，所以不依赖某个具体弹窗的返回值。
 */
let modalDismissBound = false;
function bindModalDismiss() {
  if (modalDismissBound) return;
  modalDismissBound = true;
  const mask = $('#modal-mask');
  if (!mask) return;
  mask.addEventListener('click', (e) => {
    // 点「关闭」按钮
    if (e.target.closest('#modal-close')) {
      mask.classList.remove('show');
      return;
    }
    // 点遮罩本身（不是弹窗内部）也关，手机上没有 Esc 可用
    if (e.target === mask) mask.classList.remove('show');
  });
}

export function closeModal() {
  $('#modal-mask').classList.remove('show');
}

export function confirmDialog(message, { danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    const foot = document.createElement('div');
    foot.innerHTML = `
      <button class="btn" id="cd-cancel">取消</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="cd-ok">${esc(okText)}</button>`;
    const m = openModal({ title: '确认操作', body: `<p style="margin:0">${esc(message)}</p>`, footer: foot, width: '460px' });
    $('#cd-cancel', foot).onclick = () => { m.close(); resolve(false); };
    $('#cd-ok', foot).onclick = () => { m.close(); resolve(true); };
    $('#modal-close').onclick = () => { m.close(); resolve(false); };
  });
}

export function debounce(fn, wait = 600) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 深拷贝 */
export function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/** 给输入框做受控绑定：返回取消订阅函数 */
export function bindInput(node, getter, setter, { debounceMs = 0, onDone } = {}) {
  const handler = () => {
    setter(node.value);
    if (onDone) onDone(node.value);
  };
  const wrapped = debounceMs ? debounce(handler, debounceMs) : handler;
  node.addEventListener('input', wrapped);
  node.value = getter() == null ? '' : getter();
  return () => node.removeEventListener('input', wrapped);
}
