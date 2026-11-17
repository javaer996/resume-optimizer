'use strict';

/**
 * 登录认证。
 *
 * 设计取舍(为了不给这个零依赖的本地工具加包袱):
 *   - 账号与口令存在 data/auth.json,scrypt 加盐哈希,**不存明文**
 *   - 会话是一枚 HMAC 签名的 HttpOnly cookie,服务端不保存 session,
 *     重启服务不用重新登录;签名密钥也在 auth.json 里
 *   - 连续输错按来源 IP 短时锁定,避免离线爆破
 *
 * 注意:这套东西是为「本机一个人用、但端口映射到了宿主机的工具」设计的,
 * cookie 没加 Secure(本地是 http),真要放到公网请自己套一层 HTTPS 反代。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = 'auth.json';
const COOKIE = 'rh_session';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_USER = 1;
const MIN_PASS = 8;
const MAX_PASS = 200;
const MAX_USER = 60;

const DAYS_DEFAULT = 7;
const DAYS_REMEMBER = 30;
/** 剩余寿命少于这个比例时续签,让常用的人不会突然被踢下线 */
const RENEW_RATIO = 0.5;

const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

/** ip -> { count, firstAt, until } */
const attempts = new Map();

/* ------------------------------------------------------------------ */
/* 账号存储                                                            */
/* ------------------------------------------------------------------ */

function file() {
  return path.join(store.DATA_DIR, FILE);
}

function read() {
  const data = store.readJSON(FILE, null);
  if (!data || typeof data !== 'object' || !data.user || !data.hash) return null;
  return data;
}

function exists() {
  return read() !== null;
}

function save(data) {
  const target = file();
  if (!fs.existsSync(store.DATA_DIR)) fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  // 权限收紧:同一台机器上的其他用户不该读到口令哈希与签名密钥
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (_) { /* 某些文件系统不支持 */ }
  return data;
}

function scryptKey(plain, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPass(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptKey(plain, salt);
  return {
    salt,
    hash: key.toString('hex'),
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen,
  };
}

async function verifyPass(plain, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const key = await scryptKey(plain, rec.salt, {
    N: rec.N || SCRYPT.N, r: rec.r || SCRYPT.r, p: rec.p || SCRYPT.p, keylen: rec.keylen || SCRYPT.keylen,
  });
  const a = Buffer.from(key.toString('hex'));
  const b = Buffer.from(String(rec.hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* 校验与错误                                                          */
/* ------------------------------------------------------------------ */

class AuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizeUsername(name) {
  return String(name == null ? '' : name).trim();
}

function checkCredentials(username, plain) {
  const pass = String(plain == null ? '' : plain);
  if (username.length < MIN_USER || username.length > MAX_USER) {
    throw new AuthError('bad_username', `用户名长度需要在 ${MIN_USER}–${MAX_USER} 之间`, 400);
  }
  if (pass.length < MIN_PASS) {
    throw new AuthError('weak_pass', `密码至少 ${MIN_PASS} 位`, 400);
  }
  if (pass.length > MAX_PASS) {
    throw new AuthError('bad_pass', '密码太长了', 400);
  }
  if (pass === username) {
    throw new AuthError('weak_pass', '密码不能和用户名一样', 400);
  }
}

/* ------------------------------------------------------------------ */
/* 会话令牌                                                            */
/* ------------------------------------------------------------------ */

function secretOf(data) {
  if (!data.secret) {
    data.secret = crypto.randomBytes(32).toString('hex');
    save(data);
  }
  return Buffer.from(data.secret, 'hex');
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function issue(user, { days = DAYS_DEFAULT } = {}) {
  const data = read();
  if (!data) throw new AuthError('not_configured', '还没有设置账号', 400);
  const now = Date.now();
  const ttl = days * 24 * 60 * 60 * 1000;
  return sign({ u: user, iat: now, exp: now + ttl, ttl }, secretOf(data));
}

/**
 * 校验请求里的会话。
 * 返回 { user, refresh } —— refresh 不为空表示快到期的旧令牌需要续签。
 */
function session(req) {
  const data = read();
  if (!data) return null;
  const raw = parseCookies(req.headers && req.headers.cookie)[COOKIE];
  if (!raw || raw.length > 4096) return null;

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secretOf(data)).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || typeof payload.u !== 'string') return null;
  if (payload.exp <= Date.now()) return null;
  // 账号被改过之后,旧令牌立即作废
  if (payload.u !== data.user) return null;

  const ttl = typeof payload.ttl === 'number' && payload.ttl > 0 ? payload.ttl : DAYS_DEFAULT * 86400000;
  const left = payload.exp - Date.now();
  const refresh = left < ttl * RENEW_RATIO ? issue(data.user, { days: ttl / 86400000 }) : null;
  return { user: data.user, refresh, exp: payload.exp };
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function cookieHeader(token, { days = DAYS_DEFAULT } = {}) {
  const maxAge = Math.max(0, Math.round(days * 86400));
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ------------------------------------------------------------------ */
/* 失败节流                                                            */
/* ------------------------------------------------------------------ */

function lockLeft(ip) {
  const rec = attempts.get(ip);
  if (!rec) return 0;
  if (rec.until && rec.until > Date.now()) return rec.until - Date.now();
  return 0;
}

function noteFail(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, firstAt: now, until: 0 };
  if (now - rec.firstAt > FAIL_WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = now;
    rec.until = 0;
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.until = now + LOCK_MS;
    rec.count = 0;
    rec.firstAt = now;
  }
  attempts.set(ip, rec);
}

function noteSuccess(ip) {
  attempts.delete(ip);
}

/* ------------------------------------------------------------------ */
/* 对外的几个动作                                                      */
/* ------------------------------------------------------------------ */

function status() {
  const data = read();
  return { needsSetup: !data, user: data ? data.user : '' };
}

async function setup({ username, pass }) {
  if (exists()) throw new AuthError('already_configured', '账号已经设置过了', 400);
  const user = normalizeUsername(username);
  checkCredentials(user, pass);
  const rec = await hashPass(String(pass));
  save({ user, ...rec, secret: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() });
  return { user };
}

async function login({ username, pass, ip = 'unknown', remember = false }) {
  const wait = lockLeft(ip);
  if (wait > 0) {
    throw new AuthError('locked', `尝试次数过多,请 ${Math.ceil(wait / 1000)} 秒后再试`, 429);
  }
  const data = read();
  if (!data) throw new AuthError('not_configured', '还没有设置账号,请先完成初始化', 400);

  const user = normalizeUsername(username);
  const okName = user === data.user;
  // 用户名错也要走一次哈希,免得用响应时间就能判断用户名对不对
  const okPass = await verifyPass(String(pass == null ? '' : pass), data);
  if (!okName || !okPass) {
    noteFail(ip);
    throw new AuthError('bad_credentials', '用户名或密码不对', 401);
  }
  noteSuccess(ip);
  return { user: data.user, token: issue(data.user, { days: remember ? DAYS_REMEMBER : DAYS_DEFAULT }) };
}

async function changePassword({ user, current, next, days = DAYS_DEFAULT }) {
  const data = read();
  if (!data) throw new AuthError('not_configured', '还没有设置账号', 400);
  if (normalizeUsername(user) !== data.user) throw new AuthError('bad_credentials', '账号不匹配', 401);
  const ok = await verifyPass(String(current == null ? '' : current), data);
  if (!ok) throw new AuthError('bad_credentials', '当前密码不对', 401);
  checkCredentials(data.user, next);
  const rec = await hashPass(String(next));
  // 换密码就把签名密钥一起换掉:别的设备上还在用的旧令牌立刻作废,
  // 调用方拿这张新令牌续上自己这一端。
  const secret = crypto.randomBytes(32).toString('hex');
  save({ ...data, ...rec, secret, updatedAt: new Date().toISOString() });
  return { user: data.user, token: issue(data.user, { days }) };
}

module.exports = {
  FILE,
  COOKIE,
  AuthError,
  MIN_PASS,
  status,
  exists,
  setup,
  login,
  changePassword,
  session,
  issue,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  lockLeft,
  attempts,
};
