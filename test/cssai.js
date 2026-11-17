'use strict';
/**
 * 自定义 CSS 的 AI 生成自测
 * 用法：node test/cssai.js
 *
 * 三段：
 *  1. 清洗与校验（纯函数，不联网）
 *  2. generate() —— 把 providers.chat 换成本地假模型
 *  3. HTTP 集成 —— 自起服务 + 自起一个假的 OpenAI 兼容接口，走真实请求链路
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-cssai-'));
process.env.DATA_DIR = DATA;

const cssai = require('../lib/cssai');
const providers = require('../lib/providers');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function throws(name, fn, code) {
  try {
    await fn();
    ok(name, false, '没有抛错');
  } catch (err) {
    ok(name, !code || err.code === code, `${err.code || ''} ${err.message}`.trim());
  }
}

const GOOD_CSS = '.name { letter-spacing: .08em; }\n.sec-title { color: var(--accent); }';

(async () => {
  /* ---------------- 1. 清洗 ---------------- */
  console.log('\n=== 1. 清洗与校验 ===');
  const fenced = cssai.sanitize('```css\n' + GOOD_CSS + '\n```');
  ok('去掉 ```css 围栏', fenced.css === GOOD_CSS, JSON.stringify(fenced.css.slice(0, 24)));

  const bare = cssai.sanitize('```\n' + GOOD_CSS + '\n```');
  ok('去掉无语言标记的围栏', bare.css === GOOD_CSS);

  const styled = cssai.sanitize('<style>\n' + GOOD_CSS + '\n</style>');
  ok('去掉 <style> 包裹', styled.css === GOOD_CSS);

  const prose = cssai.sanitize('好的，下面是 CSS：\n' + GOOD_CSS);
  ok('丢掉前面的客套话', prose.css === GOOD_CSS, JSON.stringify(prose.css.slice(0, 20)));

  const prose2 = cssai.sanitize('这是你要的效果：\n\n/* 头部 */\n.head { background: #f6f7f9; }');
  ok('保留注释，丢掉解释行', prose2.css === '/* 头部 */\n.head { background: #f6f7f9; }', JSON.stringify(prose2.css));

  const comment = cssai.sanitize('/* 说明：整体更紧凑 */\n.page { padding: 8mm; }');
  ok('CSS 里的中文注释不会被误删', comment.css.includes('/* 说明'), JSON.stringify(comment.css));

  const list = cssai.sanitize('.a,\n.b { color: red; }');
  ok('多行选择器列表不被切断', list.css === '.a,\n.b { color: red; }', JSON.stringify(list.css));

  const imported = cssai.sanitize('@import url(https://fonts.example/x.css);\n' + GOOD_CSS);
  ok('去掉 @import', !/import/i.test(imported.css), imported.warnings.join('/'));
  ok('@import 有提示', imported.warnings.some((w) => w.includes('@import')));

  const remote = cssai.sanitize('.page { background: url("https://cdn.example/a.png") no-repeat; }');
  ok('外链图片换成 none', remote.css.includes('url(none)') || !remote.css.includes('cdn.example'), remote.css);
  ok('外链图片有提示', remote.warnings.some((w) => w.includes('外链')));

  const proto = cssai.sanitize('.page { background: url(//cdn.example/a.png); }');
  ok('协议相对外链也拦', !proto.css.includes('cdn.example'), proto.css);

  const dataUrl = cssai.sanitize('.page { background: url(data:image/png;base64,AAA); }');
  ok('data: 内联图片放行', dataUrl.css.includes('data:image/png'), dataUrl.css);

  const escape = cssai.sanitize('.a { color: red; }\n</style><script>alert(1)</script>');
  ok('挡住 </style> 逃逸', !/<\/?style|<\/?script/i.test(escape.css), escape.css);
  ok('逃逸有提示', escape.warnings.length > 0);

  const js = cssai.sanitize('.a { width: expression(alert(1)); background: javascript:alert(1); }');
  ok('去掉 expression 与 javascript:', !/expression|javascript:/i.test(js.css), js.css);

  const long = cssai.sanitize('.a { color: red; }'.repeat(1000));
  ok('超长内容被截断', long.css.length <= cssai.MAX_CSS, String(long.css.length));
  ok('截断有提示', long.warnings.some((w) => w.includes('截断')));

  ok('空内容不通过校验', cssai.validate('') === '没有生成任何 CSS');
  ok('散文不通过校验', /不像 CSS/.test(cssai.validate('这段文字没有 CSS') || ''));
  ok('缺右括号能报出来', /右花括号/.test(cssai.validate('.a { color: red; } }') || ''));
  ok('缺左括号能报出来', /左花括号/.test(cssai.validate('.a { color: red;') || ''));
  ok('注释没闭合能报出来', /注释/.test(cssai.validate('/* 没闭合\n.a{color:red}') || ''));
  ok('字符串里的花括号不算配平错误', cssai.balanceError('.a::after { content: "}"; }') === null);
  ok('正常 CSS 通过校验', cssai.validate(GOOD_CSS) === null);

  /* ---------------- 2. 提示词 ---------------- */
  console.log('\n=== 2. 提示词 ===');
  const msgs = cssai.buildMessages({ prompt: '标题更像杂志', current: '.name{color:red}', theme: 'modern' });
  ok('两条消息（system + user）', msgs.length === 2);
  ok('system 里有选择器清单', msgs[0].content.includes('.sec-title') && msgs[0].content.includes('.bullets li'));
  ok('system 里有 CSS 变量清单', msgs[0].content.includes('--accent') && msgs[0].content.includes('--m-section'));
  ok('system 要求只输出 CSS', /只输出 CSS/.test(msgs[0].content));
  ok('system 禁止 @import', /@import/.test(msgs[0].content));
  ok('user 里带上了效果描述', msgs[1].content.includes('标题更像杂志'));
  ok('user 里带上了当前 CSS', msgs[1].content.includes('.name{color:red}'));
  ok('user 里带上了主题', msgs[1].content.includes('modern'));
  const noCurrent = cssai.buildMessages({ prompt: 'x' });
  ok('没有当前 CSS 时不出现该段', !noCurrent[1].content.includes('当前已有的自定义 CSS'));
  ok('当前 CSS 会被截断到上限', cssai.buildMessages({ prompt: 'x', current: '.a{color:red}'.repeat(2000) })[1].content.length < 4200);

  /* ---------------- 3. generate() ---------------- */
  console.log('\n=== 3. generate() ===');
  const realChat = providers.chat;
  let lastMessages = null;
  providers.chat = async (p, messages) => {
    lastMessages = messages;
    return '```css\n' + GOOD_CSS + '\n```';
  };

  const FAKE = { id: 'fake', name: '假模型', protocol: 'openai', model: 'fake-1' };
  const out = await cssai.generate({ prompt: '更紧凑', provider: FAKE });
  ok('返回清洗后的 CSS', out.css === GOOD_CSS, JSON.stringify(out.css.slice(0, 20)));
  ok('带回模型名', out.model === 'fake-1', out.model);
  ok('带回耗时', typeof out.elapsedMs === 'number');
  ok('确实调用了模型', lastMessages && lastMessages.length === 2);

  providers.chat = async () => '抱歉，我无法完成这个请求。';
  await throws('模型跑偏时报错', () => cssai.generate({ prompt: 'x', provider: FAKE }), 'bad_css');

  providers.chat = async () => { throw new Error('401 Unauthorized'); };
  await throws('模型报错时抛 ai_failed', () => cssai.generate({ prompt: 'x', provider: FAKE }), 'ai_failed');

  providers.chat = realChat;
  await throws('空描述被拒绝', () => cssai.generate({ prompt: '  ', provider: FAKE }), 'empty_prompt');
  await throws('超长描述被拒绝', () => cssai.generate({ prompt: 'a'.repeat(cssai.MAX_PROMPT + 1), provider: FAKE }), 'prompt_too_long');
  await throws('没有供应商被拒绝', () => cssai.generate({ prompt: 'x' }), 'no_provider');

  /* ---------------- 4. HTTP 集成 ---------------- */
  console.log('\n=== 4. HTTP 集成 ===');
  let stubCss = GOOD_CSS;
  let stubSeen = null;
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      stubSeen = { url: req.url, auth: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: stubCss } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const STUB_PORT = stub.address().port;

  const PORT = Number(process.env.CSSAI_PORT || 8894);
  const BASE = `http://127.0.0.1:${PORT}`;
  const rawFetch = globalThis.fetch.bind(globalThis);
  let cookie = '';
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    let next = opts;
    if (target.startsWith(BASE) && cookie) next = { ...opts, headers: { ...(opts.headers || {}), cookie } };
    const res = await rawFetch(target, next);
    if (target.startsWith(BASE)) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of list) {
        const pair = line.split(';')[0];
        if (pair.startsWith('rh_session=')) cookie = pair === 'rh_session=' ? '' : pair;
      }
    }
    return res;
  };

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${log.slice(-300)}`)), 20000);
    server.stdout.on('data', (d) => {
      log += d.toString();
      if (log.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { log += d.toString(); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 ${code}：${log.slice(-300)}`)); });
  });

  try {
    const post = (p, body) => fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const anon = await rawFetch(BASE + '/api/css/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    ok('未登录不能生成', anon.status === 401, String(anon.status));

    const pass1 = `css-${Math.random().toString(36).slice(2, 10)}`;
    await post('/api/auth/setup', { username: 'cssai', pass: pass1 });
    const st = await fetch(BASE + '/api/state');
    ok('登录后能读状态', st.status === 200, String(st.status));

    const mockOnly = await post('/api/css/generate', { prompt: '更紧凑' });
    const mockBody = await mockOnly.json();
    ok('只有模拟供应商时拒绝生成', mockOnly.status === 400 && mockBody.code === 'no_provider', String(mockOnly.status));
    ok('拒绝理由指向供应商页', /供应商/.test(mockBody.error || ''), mockBody.error);

    const saved = await post('/api/providers', {
      providers: [{ id: 'stub', name: '测试模型', protocol: 'openai', baseUrl: `http://127.0.0.1:${STUB_PORT}`, apiKey: 'sk-test', model: 'stub-1' }],
      activeId: 'stub',
    });
    ok('保存测试供应商', saved.status === 200, String(saved.status));

    const gen = await post('/api/css/generate', { prompt: '标题更像杂志，左边加一条细线', theme: 'aurora' });
    const genBody = await gen.json();
    ok('生成成功', gen.status === 200 && genBody.ok === true, `${gen.status} ${genBody.error || ''}`);
    ok('返回的 CSS 正确', genBody.css === GOOD_CSS, JSON.stringify((genBody.css || '').slice(0, 24)));
    ok('带上供应商名', genBody.provider === '测试模型', genBody.provider);
    ok('打到 /v1/chat/completions', stubSeen && stubSeen.url === '/v1/chat/completions', stubSeen && stubSeen.url);
    ok('带上了 Bearer Key', stubSeen && stubSeen.auth === 'Bearer sk-test', stubSeen && stubSeen.auth);
    const sent = stubSeen ? JSON.parse(stubSeen.body) : {};
    ok('请求里带上了效果描述', JSON.stringify(sent.messages || []).includes('标题更像杂志'));
    ok('请求里带上了主题', JSON.stringify(sent.messages || []).includes('aurora'));

    stubCss = '.a { color: red;';
    const broken = await post('/api/css/generate', { prompt: 'x' });
    const brokenBody = await broken.json();
    ok('模型给出坏 CSS 时返回 422', broken.status === 422 && brokenBody.code === 'bad_css', String(broken.status));

    stubCss = '这段文字没有 CSS';
    const proseRes = await post('/api/css/generate', { prompt: 'x' });
    ok('模型跑偏时返回 422', proseRes.status === 422, String(proseRes.status));

    const empty = await post('/api/css/generate', { prompt: '   ' });
    ok('空描述返回 400', empty.status === 400, String(empty.status));

    stubCss = '好的：\n```css\n' + GOOD_CSS + '\n```';
    const refine = await post('/api/css/generate', { prompt: '再紧凑点', current: '.old { color: red; }' });
    const refineBody = await refine.json();
    ok('在此基础上调整也返回 CSS', refineBody.css === GOOD_CSS, JSON.stringify((refineBody.css || '').slice(0, 20)));
    ok('调整时把旧 CSS 发给模型', JSON.stringify(JSON.parse(stubSeen.body).messages).includes('.old { color: red; }'));
  } finally {
    if (server.exitCode === null) server.kill('SIGKILL');
    await new Promise((r) => stub.close(r));
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(1);
});
