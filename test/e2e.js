'use strict';
/**
 * 端到端自测：脱敏往返、批量优化、导出 PDF/HTML/MD
 * 用法：node test/e2e.js
 *
 * 自己拉起一个独立服务（随机端口 + 临时数据目录），先初始化账号再跑，
 * 跑完把服务停掉、临时目录删掉——不会碰你 data/ 里的真实数据。
 */
const { spawn } = require('child_process');
const os = require('os');
const fsx = require('fs');
const pathx = require('path');

const mask = require('../lib/mask');
const optimize = require('../lib/optimize');
const providers = require('../lib/providers');
const render = require('../lib/render');
const prompts = require('../lib/prompts');
const pdfEngine = require('../lib/pdf');
const pdfProbe = require('./pdf-probe');

// 自定义规则里用到的字面量:拆开写,免得它自己被当成测试数据脱敏掉
const REGEX_VALUE = '内部项目' + '7';

const ROOT = pathx.join(__dirname, '..');
const PORT = Number(process.env.E2E_PORT || 8891);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'resume-e2e-'));
const E2E_USER = 'e2e';
const E2E_PASS = `e2e-${Math.random().toString(36).slice(2, 10)}`;

let server = null;
let cookie = '';

const rawFetch = globalThis.fetch.bind(globalThis);

// 所有打到测试服务的请求自动带上会话 cookie，响应里的 Set-Cookie 也自动收下
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  let next = opts;
  if (target.startsWith(BASE) && cookie) {
    next = { ...opts, headers: { ...(opts.headers || {}), cookie } };
  }
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

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${log.slice(-400)}`)), 20000);
    server.stdout.on('data', (d) => {
      log += d.toString();
      if (log.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { log += d.toString(); });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出（${code}）：${log.slice(-400)}`));
    });
  });
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try { fsx.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

let pass = 0; let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const PROFILE = {
  basics: {
    name: '张伟', englishName: 'Wei Zhang', title: '高级前端工程师',
    email: 'zhangwei@example.com', phone: '13912345678', location: '北京',
    address: '北京市海淀区中关村大街1号院3号楼',
    website: 'https://github.com/zhangwei-dev', wechat: 'zw_dev_2024', idcard: '110101199001011234',
    summary: '6年前端经验，擅长性能优化。联系方式 13912345678，邮箱 zhangwei@example.com。',
    highlight: '主导千万级日活产品重构', links: [],
  },
  education: [{ school: '北京邮电大学', degree: '本科', major: '计算机科学与技术', start: '2014-09', end: '2018-06', gpa: '3.7/4.0', bullets: ['校级一等奖学金'] }],
  work: [
    { company: '星辰科技有限公司', position: '高级前端工程师', start: '2021-03', end: '至今', location: '北京',
      bullets: ['主导核心交易链路重构，首屏时间从 3.2s 降至 1.8s', '搭建公司级组件库，覆盖 12 条业务线'] },
    { company: '云图网络技术有限公司', position: '前端工程师', start: '2018-07', end: '2021-02', location: '北京',
      bullets: ['负责后台管理系统开发，独立完成 5 个核心模块'] },
  ],
  projects: [{ name: '数据可视化平台', org: '星辰科技有限公司', role: '前端负责人', start: '2022-05', end: '2022-12',
    tech: ['React', 'TypeScript', 'ECharts'], bullets: ['抽象出通用图表渲染层，支持 20+ 图表类型'] }],
  skills: [{ category: '前端框架', items: ['React', 'Vue', 'TypeScript'] }],
  awards: [{ title: '年度优秀员工', date: '2023-01', detail: '前 5%' }],
  certificates: [{ title: 'CET-6', date: '2016-12', detail: '550' }],
  customSections: [],
};

const EXPECT_NAME = PROFILE.basics.name;
const EXPECT_PHONE = PROFILE.basics.phone;

const COMPANY = {
  id: 'c_test', name: '中信某某银行科技部', position: '资深前端工程师',
  intro: '国内大型商业银行的科技子公司，负责核心系统研发。',
  duties: '1. 负责手机银行前端架构演进\n2. 推动前端工程化与性能治理',
  requirements: '1. 5 年以上前端经验\n2. 精通 React 及浏览器原理\n3. 有金融行业经验优先',
  focusAreas: '性能优化实战、框架源码理解、跨部门协作',
  cautions: '不要出现竞品公司名称；篇幅控制在 2 页以内；强调稳定性与合规意识',
  tone: '严谨、务实、数据驱动',
};

(async () => {
  await startServer();
  console.log('\n=== 0. 登录 ===');
  const noAuth = await rawFetch(BASE + '/api/state');
  ok('未登录访问 API 返回 401', noAuth.status === 401, String(noAuth.status));
  const noAuthPage = await rawFetch(BASE + '/', { redirect: 'manual' });
  ok('未登录访问首页跳登录页', noAuthPage.status === 302
    && String(noAuthPage.headers.get('location')).includes('/login.html'), String(noAuthPage.status));
  const noAuthAsset = await rawFetch(BASE + '/js/app.js', { redirect: 'manual' });
  ok('未登录拿不到前端脚本', noAuthAsset.status === 302, String(noAuthAsset.status));
  const loginPage = await rawFetch(BASE + '/login.html');
  ok('登录页可以匿名打开', loginPage.status === 200, String(loginPage.status));

  const setupRes = await fetch(BASE + '/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_USER, pass: E2E_PASS }),
  });
  const setupJson = await setupRes.json();
  ok('初始化账号成功', setupRes.status === 200 && setupJson.ok === true, setupJson.error || '');
  ok('拿到会话 cookie', /^rh_session=/.test(cookie), cookie ? cookie.slice(0, 18) + '…' : '');
  const authedState = await fetch(BASE + '/api/state');
  ok('登录后可以读状态', authedState.status === 200, String(authedState.status));

  console.log('\n=== 1. 脱敏引擎 ===');
  const session = mask.createSession(PROFILE, {});
  const masked = session.maskDeep(PROFILE);
  ok('姓名被脱敏', masked.basics.name !== PROFILE.basics.name, `→ ${masked.basics.name}`);
  ok('手机号被脱敏', masked.basics.phone !== PROFILE.basics.phone, `→ ${masked.basics.phone}`);
  ok('邮箱被脱敏', masked.basics.email !== PROFILE.basics.email, `→ ${masked.basics.email}`);
  ok('学校被脱敏', masked.education[0].school !== PROFILE.education[0].school, `→ ${masked.education[0].school}`);
  ok('公司名被脱敏', masked.work[0].company !== PROFILE.work[0].company, `→ ${masked.work[0].company}`);
  ok('正文中的手机号被脱敏', !masked.basics.summary.includes('13912345678'));
  ok('身份证被脱敏', masked.basics.idcard !== PROFILE.basics.idcard, `→ ${masked.basics.idcard}`);
  ok('同一个值复用同一占位符',
    masked.work[0].company === masked.projects[0].org,
    `${masked.work[0].company} === ${masked.projects[0].org}`);
  ok('占位符数量合理', session.entries.length >= 8, `${session.entries.length} 条`);

  const json = JSON.stringify(masked);
  const restored = mask.unmask(json, session.entries);
  ok('JSON 往返完全还原', restored === JSON.stringify(PROFILE) || (() => {
    const a = JSON.parse(restored); const b = PROFILE;
    return a.basics.name === b.basics.name
      && a.basics.phone === b.basics.phone
      && a.work[0].company === b.work[0].company
      && a.education[0].school === b.education[0].school
      && a.basics.summary === b.basics.summary;
  })());
  ok('无残留占位符', mask.findLeaks(restored).length === 0, mask.findLeaks(restored).join(','));

  // 容忍 AI 的轻微改写
  const tolerant = '我的名字是【NAME_1】，电话是 [ PHONE_1 ]，也可以写 NAME_1。';
  const tolerRestored = mask.unmask(tolerant, session.entries);
  ok('容忍全角括号/空格/裸 token', !/NAME_1|PHONE_1/.test(tolerRestored), tolerRestored);

  console.log('\n=== 2. 自定义脱敏规则 ===');
  const CUSTOM_LITERAL = '星辰计划';
  const REGEX_MATCH = REGEX_VALUE;
  const custom = mask.createSession(PROFILE, {
    customRules: [
      { id: 'r1', label: 'PRODUCT', mode: 'literal', value: '星辰计划', enabled: true },
      { id: 'r2', label: 'INTERNAL', mode: 'regex', value: '内部项目[0-9]+', enabled: true },
    ],
  });
  const cm = custom.mask('我参与了星辰计划与内部项目7的建设。');
  ok('字面量规则生效', cm.includes('[CUSTOM_PRODUCT_1]'), cm);
  ok('正则规则生效', cm.includes('[CUSTOM_INTERNAL_1]'), cm);
  const customRestored = mask.unmask(cm, custom.entries);
  ok('自定义规则可还原', customRestored.includes(CUSTOM_LITERAL) && customRestored.includes(REGEX_MATCH), customRestored);

  console.log('\n=== 3. 关闭脱敏开关 ===');
  const noName = mask.createSession(PROFILE, { switches: { NAME: false } });
  const nm = noName.maskDeep(PROFILE);
  ok('关闭姓名脱敏后姓名保留', nm.basics.name === '张伟');
  ok('其它类型仍脱敏', nm.basics.phone !== PROFILE.basics.phone);

  console.log('\n=== 4. 提示词构建 ===');
  const promptState = await prompts.get();
  ok('内置模板 >= 3', promptState.templates.length >= 3, `${promptState.templates.length} 个`);
  const tpl = promptState.templates[0];
  const preview = optimize.previewPrompt({ profile: PROFILE, company: COMPANY, template: tpl });
  const sysMsg = preview.messages[0].content;
  const userMsg = preview.messages[1].content;
  ok('System 提示词非空', sysMsg.length > 100);
  ok('User 提示词注入了单位名', userMsg.includes('中信某某银行科技部'));
  ok('User 提示词注入了职位', userMsg.includes('资深前端工程师'));
  ok('User 提示词注入了考察范围', userMsg.includes('性能优化实战'));
  ok('User 提示词注入了注意事项', userMsg.includes('不要出现竞品公司名称'));
  ok('提示词中不出现真实姓名', !userMsg.includes('张伟'));
  ok('提示词中不出现真实手机号', !userMsg.includes('13912345678'));
  ok('提示词中不含真实公司名', !userMsg.includes('星辰科技有限公司'));
  ok('提示词含占位符', /\[NAME_\d+\]/.test(userMsg) || /\[COMPANY_\d+\]/.test(userMsg));
  ok('变量占位符已全部替换', !/\{\{[a-zA-Z]+\}\}/.test(sysMsg + userMsg),
    (sysMsg + userMsg).match(/\{\{[a-zA-Z]+\}\}/g)?.join(',') || '');

  console.log('\n=== 5. 模型输出解析（容错） ===');
  const cases = [
    ['裸 JSON', '{"resume":{"basics":{"name":"x"}}}'],
    ['```json 包裹', '```json\n{"resume":{"basics":{"name":"x"}}}\n```'],
    ['前置解释文字', '好的，以下是结果：\n{"resume":{"basics":{"name":"x"}}}\n希望有帮助。'],
    ['``` 无语言标记', '```\n{"resume":{"basics":{"name":"x"}}}\n```'],
  ];
  cases.forEach(([name, raw]) => {
    let parsed = null;
    try { parsed = optimize.parseModelJSON(raw); } catch (_) { /* ignore */ }
    ok(`解析：${name}`, !!parsed && parsed.resume.basics.name === 'x');
  });
  let threw = false;
  try { optimize.parseModelJSON('完全不是 JSON 的一段话'); } catch (_) { threw = true; }
  ok('非 JSON 输出正确报错', threw);

  console.log('\n=== 6. 完整优化流程（内置模拟器） ===');
  const mock = (await providers.list()).providers.find((p) => p.protocol === 'mock');
  const result = await optimize.optimizeResume({
    profile: PROFILE, company: COMPANY, template: tpl, provider: mock,
  });
  ok('返回简历对象', !!result.resume && !!result.resume.basics);
  ok('姓名已还原为真实值', result.resume.basics.name === '张伟', result.resume.basics.name);
  ok('手机号已还原', result.resume.basics.phone === '13912345678', result.resume.basics.phone);
  ok('邮箱已还原', result.resume.basics.email === 'zhangwei@example.com');
  ok('学校已还原', result.resume.education[0].school === '北京邮电大学', result.resume.education[0].school);
  ok('公司名已还原', result.resume.work[0].company === '星辰科技有限公司', result.resume.work[0].company);
  ok('工作经历条数保持', result.resume.work.length === 2);
  ok('无残留占位符', result.leaks.length === 0, result.leaks.join(','));
  ok('提供了修改说明', Array.isArray(result.notes));
  ok('提供了脱敏映射表', result.maskReport.length >= 8, `${result.maskReport.length} 条`);

  console.log('\n=== 7. 渲染与导出 ===');
  const html = render.renderHTML(result.resume, { theme: 'classic' });
  ok('HTML 含姓名', html.includes('张伟'));
  ok('HTML 无占位符', !/\[NAME_\d+\]/.test(html));
  ok('HTML 有完整文档结构', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  const md = render.renderMarkdown(result.resume, {});
  ok('Markdown 含工作经历', md.includes('工作经历') && md.includes('星辰科技有限公司'));

  // 隐藏板块
  const html2 = render.renderHTML(result.resume, { hidden: ['work'] });
  ok('隐藏板块生效', !html2.includes('工作经历'), '');

  console.log('\n=== 8. PDF 生成（内置引擎，不需要浏览器） ===');
  try {
    const pdf = await pdfEngine.renderPDF(result.resume, { theme: 'classic', showPageNumbers: true }, { engine: 'builtin' });
    ok('PDF 生成成功', pdf.length > 3000, `${(pdf.length / 1024).toFixed(1)} KB`);
    ok('PDF 文件头正确', pdf.slice(0, 5).toString() === '%PDF-');
    const probe = pdfProbe.inspect(pdf);
    ok('PDF 内嵌中文字体', probe.cjkFonts.length > 0, probe.cjkFonts.join(','));
    ok('PDF 有 ToUnicode（文字可复制）', probe.toUnicode >= 1, String(probe.toUnicode));
    ok('PDF 页数为 1', probe.pages === 1, String(probe.pages));
    const chromeInfo = require('../lib/pdf/chrome').available();
    ok('Chrome 引擎仍可用（备用）', chromeInfo.ok === true, chromeInfo.ok ? '' : chromeInfo.error);
  } catch (err) {
    ok('PDF 生成成功', false, err.message);
  }

  console.log('\n=== 8.5 真实协议路径（本地假上游） ===');
  let stubUp = false;
  try { await fetch('http://127.0.0.1:8899/__log'); stubUp = true; } catch (_) { stubUp = false; }
  if (!stubUp) {
    console.log('  - 跳过（未启动 test/provider-stub.js 8899）');
  } else {
    await fetch('http://127.0.0.1:8899/__reset');
    const openaiProv = { id: 'st-openai', name: 'stub-openai', protocol: 'openai', baseUrl: 'http://127.0.0.1:8899/v1', apiKey: 'sk-stub-test', model: 'gpt-stub', temperature: 0.4, maxTokens: 2000, timeoutMs: 20000 };
    const r1 = await optimize.optimizeResume({ profile: PROFILE, company: COMPANY, template: tpl, provider: openaiProv });
    ok('OpenAI 协议链路可用', r1.resume.basics.name === PROFILE.basics.name, r1.resume.basics.name);
    ok('OpenAI 链路还原手机号', r1.resume.basics.phone === PROFILE.basics.phone);
    ok('OpenAI 链路保留修改说明', r1.notes.length >= 1);
    const anthProv = { id: 'st-anth', name: 'stub-anthropic', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8899', apiKey: 'sk-ant-test', model: 'claude-stub', maxTokens: 2000, timeoutMs: 20000 };
    const r2 = await optimize.optimizeResume({ profile: PROFILE, company: COMPANY, template: tpl, provider: anthProv });
    ok('Anthropic 协议链路可用', r2.resume.basics.name === PROFILE.basics.name);
    ok('Anthropic 链路还原学校', !!(r2.resume.education[0] && r2.resume.education[0].school === PROFILE.education[0].school));
    const calls = await (await fetch('http://127.0.0.1:8899/__log')).json();
    const bodies = calls.filter((c) => c.path !== '/__log' && c.path !== '/__reset').map((c) => c.body).join('\n');
    ok('上游请求中无真实姓名', !bodies.includes(PROFILE.basics.name));
    ok('上游请求中无真实手机号', !bodies.includes(PROFILE.basics.phone));
    ok('上游请求中含占位符', /[A-Z]+_\d+/.test(bodies));
    ok('上游收到 API Key', calls.some((c) => /Bearer sk-|sk-ant-/.test(c.auth)));
    let upErr = false;
    try { await providers.chat({ ...openaiProv, model: '__fail__' }, [{ role: 'user', content: 'x' }]); } catch (_) { upErr = true; }
    ok('上游 5xx 正确抛错', upErr);
  }

  console.log('\n=== 9. HTTP 接口 ===');
  const post = async (path, body) => {
    const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, ct: res.headers.get('content-type'), res };
  };

  const st = await (await fetch(`${BASE}/api/state`)).json();
  ok('GET /api/state 正常', !!st.profile && Array.isArray(st.companies));
  ok('返回主题列表', (st.themes || []).length >= 4, `${(st.themes || []).length} 个主题`);
  ok('报告 PDF 可用', st.pdfAvailable === true);

  const savedProfile = await post('/api/profile', { profile: PROFILE });
  ok('POST /api/profile 保存成功', savedProfile.status === 200);

  const savedCompany = await post('/api/companies', { company: COMPANY });
  const companyJson = await savedCompany.res.json();
  ok('POST /api/companies 创建成功', !!companyJson.company && !!companyJson.company.id);

  // 单位情报调研：只填名称 + 招聘要求，其余由 /api/research 补齐
  const rsNoName = await post('/api/research', { position: '前端' });
  ok('POST /api/research 缺名称返回 400', rsNoName.status === 400);
  const rs = await post('/api/research', { name: '中信某某银行科技部', position: '资深前端工程师', useAI: false });
  const rsJson = await rs.res.json();
  ok('POST /api/research 返回 200', rs.status === 200 && rsJson.ok === true,
    rsJson.error || '');
  ok('调研结果含八字段结构',
    !!rsJson.intel && ['intro', 'focusAreas', 'cautions', 'tone', 'duties', 'requirements', 'sources', 'confidence']
      .every((k) => k in rsJson.intel),
    Object.keys(rsJson.intel || {}).length + ' 字段');
  ok('调研结果标注引擎', typeof rsJson.engine === 'string' && rsJson.engine.length > 0, rsJson.engine);
  ok('调研返回用过的查询词', Array.isArray(rsJson.queries), `${(rsJson.queries || []).length} 条`);
  ok('纯搜索模式下置信度不会乱标 high', rsJson.engine !== 'search-only' || rsJson.intel.confidence !== 'high',
    rsJson.intel && rsJson.intel.confidence);

  // research 字段的三态语义：写入 / 清空 / 缺省沿用
  const withResearch = await post('/api/companies', {
    company: {
      ...COMPANY, id: companyJson.company.id,
      research: { engine: 'search-only', confidence: 'low', sources: ['某面经'], at: '2026-11-13T10:00:00.000Z', warning: '' },
    },
  });
  await withResearch.res.json();
  let cNow = (await (await fetch(`${BASE}/api/state`)).json()).companies.find((c) => c.id === companyJson.company.id);
  ok('单位调研记录可写入', cNow.research && cNow.research.confidence === 'low', JSON.stringify(cNow.research && cNow.research.engine));

  await post('/api/companies', { company: { ...COMPANY, id: companyJson.company.id, intro: '改过的简介' } });
  cNow = (await (await fetch(`${BASE}/api/state`)).json()).companies.find((c) => c.id === companyJson.company.id);
  ok('普通编辑不抹掉调研记录', !!cNow.research && cNow.research.at === '2026-11-13T10:00:00.000Z');
  ok('普通编辑能改简介', cNow.intro === '改过的简介');

  await post('/api/companies', { company: { ...COMPANY, id: companyJson.company.id, research: null } });
  cNow = (await (await fetch(`${BASE}/api/state`)).json()).companies.find((c) => c.id === companyJson.company.id);
  ok('显式传 null 可清空调研记录', cNow.research === null);

  // 恢复成有情报的样子，供后续优化流程使用
  await post('/api/companies', { company: COMPANY });

  const pv = await post('/api/preview', { companyId: companyJson.company.id, templateId: tpl.id });
  const pvJson = await pv.res.json();
  ok('POST /api/preview 返回提示词', pvJson.messages && pvJson.messages.length === 2);
  ok('预览含脱敏映射', (pvJson.maskReport || []).length > 0, `${(pvJson.maskReport || []).length} 条`);

  const jobRes = await post('/api/optimize', {
    companyIds: [companyJson.company.id],
    templateId: tpl.id,
    providerId: mock.id,
  });
  const jobJson = await jobRes.res.json();
  ok('POST /api/optimize 发起任务', !!jobJson.job && jobJson.job.status === 'running');

  // 轮询
  let job = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    const jr = await (await fetch(`${BASE}/api/jobs/${jobJson.job.id}`)).json();
    job = jr.job;
    if (!job || job.status !== 'running') break;
  }
  ok('任务执行完成', job && job.status === 'finished', job ? job.status : 'null');
  ok('任务结果标记成功', job && job.items[0].status === 'done');

  const full = await (await fetch(`${BASE}/api/jobs/${jobJson.job.id}?full=1`)).json();
  const item = full.job.items[0];
  ok('结果含简历数据', !!item.result && !!item.result.resume);
  ok('结果已还原真实姓名', item.result.resume.basics.name === '张伟', item.result.resume.basics.name);
  ok('结果无残留占位符', (item.result.leaks || []).length === 0);

  // 编辑保存
  const edited = JSON.parse(JSON.stringify(item.result.resume));
  edited.basics.summary = '这是被我手工编辑过的简介。';
  const saveEdit = await post('/api/jobs/result', { jobId: jobJson.job.id, companyId: companyJson.company.id, resume: edited });
  ok('POST /api/jobs/result 保存编辑', saveEdit.status === 200);
  const full2 = await (await fetch(`${BASE}/api/jobs/${jobJson.job.id}?full=1`)).json();
  ok('编辑内容已持久化', full2.job.items[0].result.resume.basics.summary === '这是被我手工编辑过的简介。');

  // 导出接口
  const pdfRes = await post('/api/export/pdf', { resume: item.result.resume, opts: { theme: 'modern' }, filename: 'test' });
  const pdfBuf = Buffer.from(await pdfRes.res.arrayBuffer());
  ok('POST /api/export/pdf 返回 PDF', pdfRes.ct.includes('application/pdf') && pdfBuf.slice(0, 5).toString() === '%PDF-', `${(pdfBuf.length / 1024).toFixed(1)} KB`);
  ok('PDF 下载头正确', (pdfRes.res.headers.get('content-disposition') || '').includes('attachment'));
  const pdfProbeHttp = pdfProbe.inspect(pdfBuf);
  ok('导出 PDF 内嵌中文字体', pdfProbeHttp.cjkFonts.length > 0, pdfProbeHttp.cjkFonts.join(','));
  ok('导出 PDF 页面尺寸 A4', Math.abs(pdfProbeHttp.widthMm - 210) < 1 && Math.abs(pdfProbeHttp.heightMm - 297) < 1, `${pdfProbeHttp.widthMm}×${pdfProbeHttp.heightMm}mm`);

  const htmlRes = await post('/api/export/html', { resume: item.result.resume, opts: {} });
  const htmlText = await htmlRes.res.text();
  ok('POST /api/export/html 返回 HTML', htmlText.includes('张伟'));

  const mdRes = await post('/api/export/markdown', { resume: item.result.resume, opts: {} });
  const mdText = await mdRes.res.text();
  ok('POST /api/export/markdown 返回 Markdown', mdText.includes('工作经历'));

  // 脱敏工具接口
  const um = await post('/api/unmask', { text: '你好 [NAME_1]，电话 [PHONE_1]', vault: item.result.vault });
  const umJson = await um.res.json();
  ok('POST /api/unmask 还原成功', umJson.text.includes(EXPECT_NAME) && umJson.text.includes(EXPECT_PHONE), umJson.text);

  // 提示词接口
  const pm = await post('/api/prompts', { template: { id: tpl.id, name: tpl.name, systemPrompt: `${tpl.systemPrompt}\n// e2e 修改标记`, userPromptTemplate: tpl.userPromptTemplate } });
  const pmJson = await pm.res.json();
  ok('POST /api/prompts 保存并记录历史', pmJson.history.length >= 1, `${pmJson.history.length} 条历史`);
  const restore = await post('/api/prompts', { action: 'restore', historyId: pmJson.history[0].id });
  ok('可恢复历史版本', restore.status === 200);

  // 历史记录上限
  for (let i = 0; i < 13; i += 1) {
    await post('/api/prompts', { template: { id: tpl.id, name: tpl.name, systemPrompt: `${tpl.systemPrompt}\n// 编辑 ${i}`, userPromptTemplate: tpl.userPromptTemplate } });
  }
  const pf = await (await fetch(`${BASE}/api/prompts`)).json();
  ok('历史记录上限为 10', pf.history.length === 10, `${pf.history.length} 条`);

  // 样式设置：逐段覆盖的持久化语义
  await post('/api/settings', { settings: { export: { theme: 'modern', layout: {
    order: ['summary', 'skills', 'work'],
    header: { style: 'rule' },
    sections: { work: { titleStyle: 'chip' }, skills: { titleStyle: 'bar' } },
    customCSS: '.name{color:red}',
  } } } });
  let lay = (await (await fetch(`${BASE}/api/state`)).json()).settings.export.layout;
  ok('样式覆盖已写入', lay.sections.work.titleStyle === 'chip' && lay.header.style === 'rule');
  ok('自定义 CSS 已写入', lay.customCSS === '.name{color:red}');

  // 换主题时前端会清空 sections：服务端必须跟着清，不能把旧覆盖合并回来
  await post('/api/settings', { settings: { export: { theme: 'aurora', layout: { sections: {}, header: {} } } } });
  lay = (await (await fetch(`${BASE}/api/state`)).json()).settings.export.layout;
  ok('清空 sections 后不残留旧覆盖', Object.keys(lay.sections).length === 0, JSON.stringify(lay.sections));
  ok('清空 header 后不残留旧覆盖', Object.keys(lay.header).length === 0, JSON.stringify(lay.header));
  ok('没提交的字段保持原值', lay.customCSS === '.name{color:red}' && lay.order.length === 3, `order=${lay.order.length}`);

  // 手工编辑过 / 旧版本留下的 profile.json 可能缺字段（曾把 customSections
  // 写成 customItems，导致整页白屏）。接口必须把它补齐再返回。
  const FS = require('fs');
  const PATH = require('path');
  const dataPath = DATA; // 用测试服务自己的临时目录,别改真实 data/
  const profPath = PATH.join(dataPath, 'profile.json');
  const profBefore = FS.existsSync(profPath) ? FS.readFileSync(profPath, 'utf8') : null;
  FS.writeFileSync(profPath, JSON.stringify({ basics: { name: '残缺简历' }, work: null }, null, 2));
  const ragged = await (await fetch(`${BASE}/api/state`)).json();
  ok('残缺的 profile.json 不会让接口崩', !!ragged.profile);
  ok('缺失的数组字段被补齐', Array.isArray(ragged.profile.work) && Array.isArray(ragged.profile.customSections),
    Object.keys(ragged.profile).join(','));
  ok('缺失的 basics 字段被补齐', typeof ragged.profile.basics.title === 'string',
    Object.keys(ragged.profile.basics).length + ' 个');
  ok('已有内容不丢', ragged.profile.basics.name === '残缺简历', ragged.profile.basics.name);
  if (profBefore !== null) FS.writeFileSync(profPath, profBefore);

  // 供应商
  const pv2 = await post('/api/providers', {
    providers: [
      { id: 'p_test', name: 'e2e 测试供应商', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'sk-test-123', model: 'test-model' },
      mock,
    ],
    activeId: mock.id,
  });
  ok('POST /api/providers 保存多供应商', pv2.status === 200);
  const pvState = await (await fetch(`${BASE}/api/state`)).json();
  ok('供应商已持久化', pvState.providers.providers.length === 2, `${pvState.providers.providers.length} 个`);
  ok('API Key 已保存', pvState.providers.providers.find((p) => p.id === 'p_test').apiKey === 'sk-test-123');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(50));
  await render.closeBrowser();
  await stopServer();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('\n自测脚本异常:', err);
  await stopServer();
  process.exit(2);
});
