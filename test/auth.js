'use strict';
/**
 * 登录认证自测：账号初始化、登录节流、会话令牌、改密码、HTTP 拦截
 * 用法：node test/auth.js
 *
 * 两个临时数据目录：一个给模块级用例，一个给自起的 HTTP 服务；
 * 跑完都删掉，不会污染 data/。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// store.js 在 require 时读 DATA_DIR，所以必须先设再 require
const MOD_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-auth-mod-'));
process.env.DATA_DIR = MOD_DATA;

const auth = require('../lib/auth');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function throws(name, fn, code) {
  return fn().then(
    () => ok(name, false, '没有抛错'),
    (err) => ok(name, !code || err.code === code, code ? `${err.code}` : err.message),
  );
}

const GOOD = 'Correct1Pass';
const CLEANUP = [];

function cookieOf(token) { return `${auth.COOKIE}=${token}`; }
function reqWith(cookie) { return { headers: { cookie } }; }

(async () => {
  console.log('\n=== 1. 账号初始化 ===');
  ok('未初始化时 needsSetup', auth.status().needsSetup === true);
  ok('未初始化时 exists 为假', auth.exists() === false);

  await throws('用户名不能为空', () => auth.setup({ username: '   ', pass: GOOD }), 'bad_username');
  await throws('密码太短被拒', () => auth.setup({ username: 'tester', pass: '1234567' }), 'weak_pass');
  await throws('用户名太长被拒', () => auth.setup({ username: 'x'.repeat(61), pass: GOOD }), 'bad_username');
  await throws('密码太长被拒', () => auth.setup({ username: 'tester', pass: 'a'.repeat(201) }), 'bad_pass');
  await throws('密码不能等于用户名', () => auth.setup({ username: 'sameuser', pass: 'sameuser' }), 'weak_pass');

  const created = await auth.setup({ username: '  tester  ', pass: GOOD });
  ok('初始化成功且用户名被 trim', created.user === 'tester', created.user);
  ok('初始化后 needsSetup 为假', auth.status().needsSetup === false);
  ok('初始化后 exists 为真', auth.exists() === true);
  await throws('重复初始化被拒', () => auth.setup({ username: 'other', pass: GOOD }), 'already_configured');

  const raw = JSON.parse(fs.readFileSync(path.join(MOD_DATA, 'auth.json'), 'utf8'));
  ok('落盘不含明文密码', !JSON.stringify(raw).includes(GOOD));
  ok('落盘有 salt 与 hash', typeof raw.salt === 'string' && typeof raw.hash === 'string',
    `salt ${raw.salt.length} / hash ${raw.hash.length}`);
  ok('落盘有签名密钥', typeof raw.secret === 'string' && raw.secret.length === 64);
  ok('用户名以小写形式保存', raw.user === 'tester', raw.user);

  console.log('\n=== 2. 登录与节流 ===');
  const login = await auth.login({ username: 'tester', pass: GOOD, ip: '10.0.0.1' });
  ok('正确凭据可以登录', login.user === 'tester' && typeof login.token === 'string');
  ok('令牌是三段结构里的两段', login.token.split('.').length === 2, login.token.slice(0, 16) + '…');
  ok('大小写敏感', await auth.login({ username: 'TESTER', pass: GOOD, ip: '10.0.0.2' })
    .then(() => false, (e) => e.code === 'bad_credentials'));
  ok('用户名两端空格被忽略',
    await auth.login({ username: ' tester ', pass: GOOD, ip: '10.0.0.3' }).then((r) => r.user === 'tester', () => false));

  await throws('密码错误被拒', () => auth.login({ username: 'tester', pass: `${GOOD}x`, ip: '10.0.0.4' }), 'bad_credentials');
  await throws('用户名错误被拒', () => auth.login({ username: 'nobody', pass: GOOD, ip: '10.0.0.5' }), 'bad_credentials');
  await throws('空密码被拒', () => auth.login({ username: 'tester', pass: '', ip: '10.0.0.6' }), 'bad_credentials');

  const lockIp = '10.9.9.9';
  for (let i = 0; i < 5; i += 1) {
    await auth.login({ username: 'tester', pass: 'wrong' + i + 'xx', ip: lockIp }).catch(() => {});
  }
  const lockedErr = await auth.login({ username: 'tester', pass: GOOD, ip: lockIp }).then(() => null, (e) => e);
  ok('连续 5 次失败后锁定', !!lockedErr && lockedErr.code === 'locked', lockedErr && lockedErr.code);
  ok('锁定状态返回 429', !!lockedErr && lockedErr.status === 429, lockedErr && String(lockedErr.status));
  ok('锁定剩余时间大于 0', auth.lockLeft(lockIp) > 0, `${Math.round(auth.lockLeft(lockIp) / 1000)}s`);
  ok('锁定只影响这个 IP', await auth.login({ username: 'tester', pass: GOOD, ip: '10.0.0.7' })
    .then((r) => r.user === 'tester', () => false));
  auth.attempts.delete(lockIp);

  console.log('\n=== 3. 会话令牌 ===');
  const t = (await auth.login({ username: 'tester', pass: GOOD, ip: '10.1.1.1' })).token;
  ok('有效令牌解析出用户', (auth.session(reqWith(cookieOf(t))) || {}).user === 'tester');
  ok('没有 cookie 时为 null', auth.session(reqWith('')) === null);
  ok('没有 cookie 头时为 null', auth.session({ headers: {} }) === null);
  ok('签名被篡改时为 null', auth.session(reqWith(cookieOf(`${t.slice(0, -2)}xy`))) === null);
  ok('格式不对时为 null', auth.session(reqWith(cookieOf('garbage'))) === null);

  const [body, mac] = t.split('.');
  const badPayload = Buffer.from('{"u":"tester","exp":9999999999999,"ttl":1}', 'utf8').toString('base64url');
  ok('载荷被篡改时为 null', auth.session(reqWith(cookieOf(`${badPayload}.${mac}`))) === null);

  const secretBuf = Buffer.from(raw.secret, 'hex');
  const forged = (payload) => {
    const b = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const m = crypto.createHmac('sha256', secretBuf).update(b).digest('base64url');
    return `${b}.${m}`;
  };
  const expired = forged({ u: 'tester', iat: Date.now() - 9000000, exp: Date.now() - 1000, ttl: 604800000 });
  ok('过期令牌为 null', auth.session(reqWith(cookieOf(expired))) === null);
  const other = forged({ u: 'other', iat: Date.now(), exp: Date.now() + 900000, ttl: 604800000 });
  ok('换成别人名字的令牌为 null', auth.session(reqWith(cookieOf(other))) === null);

  const fresh = forged({ u: 'tester', iat: Date.now(), exp: Date.now() + 6 * 86400000, ttl: 7 * 86400000 });
  ok('剩余寿命充足时不续签', (auth.session(reqWith(cookieOf(fresh))) || {}).refresh === null);
  const nearly = forged({ u: 'tester', iat: Date.now() - 6 * 86400000, exp: Date.now() + 86400000, ttl: 7 * 86400000 });
  const nearSess = auth.session(reqWith(cookieOf(nearly))) || {};
  ok('剩不到一半时给续签令牌', typeof nearSess.refresh === 'string' && nearSess.refresh.length > 20);
  ok('续签出来的令牌可用', (auth.session(reqWith(cookieOf(nearSess.refresh))) || {}).user === 'tester');

  const cookieH = auth.cookieHeader(t);
  ok('cookie 带 HttpOnly', /HttpOnly/.test(cookieH));
  ok('cookie 带 SameSite=Lax', /SameSite=Lax/.test(cookieH));
  ok('cookie 作用域为 /', /Path=\//.test(cookieH));
  ok('默认 7 天', /Max-Age=604800/.test(cookieH), cookieH.match(/Max-Age=\d+/)[0]);
  ok('记住我 30 天', /Max-Age=2592000/.test(auth.cookieHeader(t, { days: 30 })));
  ok('登出 cookie 立即过期', /Max-Age=0/.test(auth.clearCookieHeader()));
  ok('登出 cookie 仍然 HttpOnly', /HttpOnly/.test(auth.clearCookieHeader()));

  const parsed = auth.parseCookies(`a=1; ${auth.COOKIE}=${t}; b=hello%20world; bad`);
  ok('解析多个 cookie', parsed[auth.COOKIE] === t);
  ok('解析百分号编码', parsed.b === 'hello world');
  ok('跳过没有等号的部分', Object.keys(parsed).length === 3, Object.keys(parsed).join(','));
  ok('解析空头不报错', Object.keys(auth.parseCookies(undefined)).length === 0);

  console.log('\n=== 4. 改密码 ===');
  await throws('当前密码不对被拒',
    () => auth.changePassword({ user: 'tester', current: 'nope', next: 'Another1Pass' }), 'bad_credentials');
  await throws('新密码太短被拒',
    () => auth.changePassword({ user: 'tester', current: GOOD, next: '123' }), 'weak_pass');
  await throws('账号不匹配被拒',
    () => auth.changePassword({ user: 'someone', current: GOOD, next: 'Another1Pass' }), 'bad_credentials');

  const changed = await auth.changePassword({ user: 'tester', current: GOOD, next: 'Another1Pass' });
  ok('改密码返回新令牌', typeof changed.token === 'string' && changed.token !== t);
  ok('旧密码立即失效', await auth.login({ username: 'tester', pass: GOOD, ip: '10.2.2.2' })
    .then(() => false, (e) => e.code === 'bad_credentials'));
  ok('新密码可以登录', await auth.login({ username: 'tester', pass: 'Another1Pass', ip: '10.2.2.3' })
    .then((r) => r.user === 'tester', () => false));
  ok('改密码前的令牌作废（别的设备被踢下线）', auth.session(reqWith(cookieOf(t))) === null);
  ok('改密码返回的新令牌可用', (auth.session(reqWith(cookieOf(changed.token))) || {}).user === 'tester');

  console.log('\n=== 5. HTTP 层 ===');
  const HTTP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-auth-http-'));
  CLEANUP.push(MOD_DATA, HTTP_DATA);
  const PORT = Number(process.env.AUTH_TEST_PORT || 8892);
  const BASE = `http://127.0.0.1:${PORT}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: HTTP_DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bootLog = { text: '' };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${bootLog.text.slice(-300)}`)), 20000);
    server.stdout.on('data', (d) => {
      bootLog.text += d.toString();
      if (bootLog.text.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { bootLog.text += d.toString(); });
    server.on('exit', (c) => { clearTimeout(timer); reject(new Error(`服务退出 ${c}`)); });
  });

  let sessionCookie = '';
  const call = async (p, opts = {}) => {
    const res = await fetch(BASE + p, {
      redirect: 'manual',
      ...opts,
      headers: { ...(opts.headers || {}), ...(sessionCookie ? { cookie: sessionCookie } : {}) },
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(';')[0];
      if (pair.startsWith(`${auth.COOKIE}=`)) sessionCookie = pair === `${auth.COOKIE}=` ? '' : pair;
    }
    return res;
  };

  let r = await call('/api/state');
  ok('未登录访问 API 返回 401', r.status === 401, String(r.status));
  const body401 = await r.json();
  ok('401 里带 unauthenticated 标记', body401.code === 'unauthenticated', body401.code);

  r = await call('/');
  ok('未登录访问首页跳登录页', r.status === 302 && String(r.headers.get('location')).includes('/login.html'),
    `${r.status} → ${r.headers.get('location')}`);

  r = await call('/js/app.js');
  ok('未登录拿不到前端脚本', r.status === 302, String(r.status));

  r = await call('/styles.css');
  ok('未登录拿不到样式表', r.status === 302, String(r.status));

  r = await call('/login.html');
  ok('登录页本身可以匿名打开', r.status === 200, String(r.status));

  r = await call('/api/auth/status');
  const st = await r.json();
  ok('status 显示需要初始化', st.needsSetup === true && st.authed === false);

  r = await call('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'httpuser', pass: 'HttpPass123' }),
  });
  ok('初始化账号 200', r.status === 200, String(r.status));
  ok('初始化后拿到会话 cookie', sessionCookie.startsWith(`${auth.COOKIE}=`), sessionCookie.slice(0, 22) + '…');

  r = await call('/api/state');
  ok('登录后可以读状态', r.status === 200, String(r.status));

  r = await call('/js/app.js');
  ok('登录后能拿到前端脚本', r.status === 200, String(r.status));

  r = await call('/api/auth/status');
  const st2 = await r.json();
  ok('status 显示已登录', st2.authed === true && st2.user === 'httpuser', `${st2.user}`);

  const saved = sessionCookie;
  sessionCookie = '';
  r = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'httpuser', pass: 'wrong-pass' }),
  });
  ok('HTTP 登录失败返回 401', r.status === 401, String(r.status));
  ok('失败响应带 bad_credentials', (await r.json()).code === 'bad_credentials');

  r = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'httpuser', pass: 'HttpPass123', remember: true }),
  });
  ok('HTTP 登录成功返回 200', r.status === 200, String(r.status));
  ok('记住我下发 30 天 cookie',
    String(r.headers.getSetCookie()[0]).includes('Max-Age=2592000'),
    String(r.headers.getSetCookie()[0]).match(/Max-Age=\d+/)?.[0] || '');

  sessionCookie = `${auth.COOKIE}=forged.token`;
  r = await call('/api/state');
  ok('伪造 cookie 被拒', r.status === 401, String(r.status));

  sessionCookie = saved;
  r = await call('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 'wrong-one', next: 'Another2Pass' }),
  });
  ok('改密码时当前密码错返回 400（不是 401，免得前端被踢回登录页）', r.status === 400, String(r.status));

  r = await call('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 'HttpPass123', next: 'Another2Pass' }),
  });
  ok('改密码成功返回 200', r.status === 200, String(r.status));
  ok('改密码顺手换发新 cookie', sessionCookie !== saved, '已换发');
  r = await call('/api/state');
  ok('改密码后当前会话仍然可用', r.status === 200, String(r.status));

  r = await call('/api/auth/logout', { method: 'POST' });
  ok('登出返回 200', r.status === 200, String(r.status));
  ok('登出把 cookie 清掉', /Max-Age=0/.test(String(r.headers.getSetCookie()[0])));
  sessionCookie = '';
  r = await call('/api/state');
  ok('登出后 API 回到 401', r.status === 401, String(r.status));
  r = await call('/api/auth/logout', { method: 'POST' });
  ok('重复登出也不报错', r.status === 200, String(r.status));

  const perm = fs.statSync(path.join(HTTP_DATA, 'auth.json')).mode & 0o777;
  ok('auth.json 权限为 600', perm === 0o600, perm.toString(8));

  server.kill('SIGTERM');
  await new Promise((res) => setTimeout(res, 200));
  if (server.exitCode === null) server.kill('SIGKILL');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`通过 ${pass} 项,失败 ${fail} 项`);
  console.log('='.repeat(50));

  for (const dir of CLEANUP) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n自测脚本异常:', err);
  for (const dir of CLEANUP) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  process.exit(2);
});