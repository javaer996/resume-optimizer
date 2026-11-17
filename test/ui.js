'use strict';
/**
 * 界面验证：逐页截图 + 抓控制台报错 + 断言关键 DOM
 * 用法：node test/ui.js            自起一个临时服务（拷贝当前 data/，账号另建），不碰你的数据
 *      node test/ui.js http://…    打已经跑着的服务，需要 RESUME_USER / RESUME_PASS
 */
const puppeteer = require('/data/dsh/tools/headless/node_modules/puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OUT = process.env.OUT || '/tmp/ui-shots';
const ROOT = path.join(__dirname, '..');
const AUTH_USER = process.env.RESUME_USER || 'uitest';
const AUTH_PASS = process.env.RESUME_PASS || `uitest-${Math.random().toString(36).slice(2, 10)}`;

let BASE = process.argv[2] || '';
let server = null;
let tempData = '';

function waitReady(proc) {
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`服务启动超时：${log.slice(-300)}`)), 20000);
    proc.stdout.on('data', (d) => {
      log += d.toString();
      if (log.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', (d) => { log += d.toString(); });
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`服务退出 ${c}：${log.slice(-300)}`)); });
  });
}

async function ensureServer() {
  if (BASE) return;
  const PORT = Number(process.env.UI_PORT || 8893);
  tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ui-'));
  // 把当前 data/ 拷一份，页面才有真实内容可看；账号文件不拷，用测试账号
  const src = path.join(ROOT, 'data');
  if (fs.existsSync(src)) {
    for (const name of fs.readdirSync(src)) {
      if (name === 'auth.json') continue;
      const from = path.join(src, name);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(tempData, name));
    }
  }
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tempData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady(server);
}

async function getToken() {
  const st = await (await fetch(`${BASE}/api/auth/status`)).json();
  const endpoint = st.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, pass: AUTH_PASS }),
  });
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()[0] : '';
  if (!setCookie) {
    throw new Error(`登录失败（${res.status}）：${await res.text().catch(() => '')}。`
      + '打已有服务时请用 RESUME_USER / RESUME_PASS 指定账号密码。');
  }
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

async function cleanup() {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (tempData) { try { fs.rmSync(tempData, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
}

const VIEWS = [
  ['profile', '我的简历'],
  ['companies', '目标单位'],
  ['optimize', '批量优化'],
  ['results', '优化结果'],
  ['mask', '脱敏设置'],
  ['prompts', '提示词'],
  ['providers', 'AI 供应商'],
  ['settings', '导出设置'],
];

(async () => {
  await ensureServer();
  const token = await getToken();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/data/dsh/tools/headless/bin/chrome-headless-shell',
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--user-data-dir=/data/dsh/tools/headless/.profile-ui'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setCookie({ name: 'rh_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  const failures = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) => failures.push(`${req.url()} — ${req.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));

  const results = [];
  for (const [view, label] of VIEWS) {
    await page.evaluate((v) => window.__app.switchView(v), view);
    await new Promise((r) => setTimeout(r, 900));
    const shot = path.join(OUT, `${view}.png`);
    await page.screenshot({ path: shot });

    const info = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const visibleCards = Array.from(document.querySelectorAll('.view.active .card'))
        .filter((c) => c.getBoundingClientRect().height > 0);
      const inputs = document.querySelectorAll('.view.active input, .view.active textarea, .view.active select');
      const texts = (active ? active.innerText : '').replace(/\s+/g, ' ').trim();
      return {
        hasActive: !!active,
        cards: visibleCards.length,
        inputs: inputs.length,
        docHeight: document.documentElement.scrollHeight,
        emptyBlock: visibleCards.length === 0 && inputs.length === 0,
        textLen: texts.length,
        sample: texts.slice(0, 120),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    });
    results.push({ view, label, shot, ...info });
    console.log(`${view.padEnd(10)} cards=${String(info.cards).padStart(2)} inputs=${String(info.inputs).padStart(3)} h=${info.docHeight} overflow=${info.horizontalOverflow} "${info.sample.slice(0, 60)}"`);
  }

  // 交互测试：编辑简历 -> 自动保存 -> 刷新后仍在
  console.log('\n--- 交互：编辑并保存 ---');
  await page.evaluate(() => window.__app.switchView('profile'));
  await new Promise((r) => setTimeout(r, 600));
  const nameInput = await page.$('#view-profile input');
  await nameInput.click({ clickCount: 3 });
  await page.keyboard.type('测试工程师');
  await new Promise((r) => setTimeout(r, 1800));
  const hint = await page.$eval('#save-hint', (e) => e.textContent);
  console.log(`保存提示: "${hint}"`);

  const saved = await page.evaluate(async () => {
    const res = await fetch('/api/state');
    const d = await res.json();
    return d.profile.basics.name;
  });
  console.log(`服务端已保存的姓名长度: ${saved.length}`);

  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 900));
  const afterReload = await page.evaluate(() => {
    const el = document.querySelector('#view-profile input');
    return el ? el.value : null;
  });
  console.log(`刷新后输入框内容长度: ${afterReload ? afterReload.length : 'null'}`);

  // 弹窗测试
  console.log('\n--- 交互：弹窗 ---');
  await page.evaluate(() => window.__app.switchView('companies'));
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#btn-new-company');
  await new Promise((r) => setTimeout(r, 600));
  const modalOpen = await page.$eval('#modal-mask', (e) => e.classList.contains('show'));
  const modalInputs = await page.$$eval('#modal-body input, #modal-body textarea', (els) => els.length);
  await page.screenshot({ path: path.join(OUT, 'modal-company.png') });
  console.log(`弹窗打开=${modalOpen} 字段数=${modalInputs}`);
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));

  // 预览 iframe 是否渲染出内容
  console.log('\n--- 交互：简历预览 iframe ---');
  await page.evaluate(() => window.__app.switchView('settings'));
  await new Promise((r) => setTimeout(r, 2200));
  const frameInfo = await page.evaluate(() => {
    const f = document.querySelector('#settings-root iframe');
    if (!f) return { found: false };
    const doc = f.contentDocument;
    const body = doc && doc.body;
    return {
      found: true,
      hasDoc: !!doc,
      textLen: body ? body.innerText.length : 0,
      name: body ? (body.querySelector('.name') ? body.querySelector('.name').textContent : '') : '',
      secCount: body ? body.querySelectorAll('.sec').length : 0,
    };
  });
  console.log(`iframe: found=${frameInfo.found} textLen=${frameInfo.textLen} sections=${frameInfo.secCount}`);

  // 手机宽度响应式
  console.log('\n--- 响应式：390px 宽 ---');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.evaluate(() => window.__app.switchView('profile'));
  await new Promise((r) => setTimeout(r, 700));
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    gridCols: getComputedStyle(document.querySelector('#view-profile .grid')).gridTemplateColumns,
  }));
  console.log(`溢出=${mobile.overflow} scrollW=${mobile.scrollW} innerW=${mobile.innerW}`);
  await page.screenshot({ path: path.join(OUT, 'mobile-profile.png'), fullPage: false });

  // 手机端专项：这四件事都曾经真的坏过，加断言防止再坏
  console.log('\n--- 手机端专项（390px） ---');
  const mobileIssues = await page.evaluate(() => {
    const out = { tall: 0, tight: 0, overflowing: 0, details: [] };
    // ① 文字被压成竖排：非空文本、高度远大于宽度
    for (const e of document.querySelectorAll('.view.active *, #modal-body *')) {
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (e.children.length === 0 && (e.textContent || '').trim().length > 4 && b.height > b.width * 2.6) {
        out.tall++;
        out.details.push(`tall: ${e.tagName} "${(e.textContent || '').trim().slice(0, 12)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
    }
    // ② 按钮贴在一起
    const btns = [...document.querySelectorAll('.view.active button, #modal-foot button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !b.disabled;
    });
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i].getBoundingClientRect();
        const b = btns[j].getBoundingClientRect();
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapY < a.height * 0.5 || Math.abs(a.top - b.top) > 6) continue;
        const gap = b.left > a.left ? b.left - a.right : a.left - b.right;
        if (gap >= 0 && gap < 6) {
          out.tight++;
          out.details.push(`tight: ${btns[i].textContent.trim().slice(0, 8)}|${btns[j].textContent.trim().slice(0, 8)} gap=${Math.round(gap)}`);
        }
      }
    }
    // ③ 横向溢出（以可见视图为参照，.sheet 的 overflow:hidden 会掩盖这个问题）
    const view = document.querySelector('.view.active');
    const vb = view.getBoundingClientRect();
    for (const e of view.querySelectorAll('*')) {
      const b = e.getBoundingClientRect();
      if (b.width > 0 && b.right > vb.right + 1) {
        out.overflowing++;
        out.details.push(`over: ${e.tagName}.${String(e.className).slice(0, 18)} +${Math.round(b.right - vb.right)}px`);
      }
    }
    return out;
  });
  await page.evaluate(() => window.__app.switchView('settings'));
  await new Promise((r) => setTimeout(r, 1800));
  const arrowIssues = await page.evaluate(() => {
    // 逐段控件行的上下箭头必须在卡片内（用户反复报过这里溢出）
    const out = [];
    for (const row of document.querySelectorAll('.sec-row')) {
      const rb = row.getBoundingClientRect();
      for (const b of row.querySelectorAll('.sr-order button')) {
        const bb = b.getBoundingClientRect();
        const over = Math.max(bb.right - rb.right, bb.bottom - rb.bottom, rb.left - bb.left, rb.top - bb.top);
        if (over > 0.5) out.push(`arrow +${Math.round(over)}px`);
      }
    }
    return out;
  });
  mobileIssues.arrow = arrowIssues.length;
  arrowIssues.slice(0, 3).forEach((d) => mobileIssues.details.push(`${d}（逐段箭头）`));

  console.log(`  竖排文字=${mobileIssues.tall} 按钮过近=${mobileIssues.tight} 横向溢出=${mobileIssues.overflowing} 箭头出界=${mobileIssues.arrow}`);
  if (mobileIssues.details.length) mobileIssues.details.slice(0, 6).forEach((d) => console.log(`  · ${d}`));


  // 自定义 CSS 的 AI 助手：结构、无供应商时的禁用态、手机端输入框字号
  // 这三条都容易在改版时被悄悄弄坏：按钮消失、模拟供应商也能点、手机上输入框被放大
  console.log('\n--- 自定义 CSS 的 AI 助手 ---');
  {
    const aiIssues = [];
    const ai = await page.evaluate(() => {
      const box = document.querySelector('.css-ai');
      if (!box) return { found: false };
      const btns = [...box.querySelectorAll('.css-ai-acts button')];
      const input = box.querySelector('.css-ai-input');
      const view = document.querySelector('.view.active');
      return {
        found: true,
        label: ((box.querySelector('.css-ai-label') || {}).textContent || '').trim(),
        placeholder: input ? input.placeholder : '',
        buttons: btns.map((b) => b.textContent.trim()),
        visible: btns.filter((b) => !b.hidden).length,
        off: box.classList.contains('off'),
        disabled: btns.filter((b) => !b.hidden).every((b) => b.disabled),
        tip: ((box.querySelector('.tip') || {}).textContent || '').trim(),
        beforeEditor: !!(box.nextElementSibling && box.nextElementSibling.classList.contains('css-editor')),
        fs: input ? parseFloat(getComputedStyle(input).fontSize) : 0,
        over: Math.round(box.getBoundingClientRect().right - view.getBoundingClientRect().right),
      };
    });
    if (!ai.found) aiIssues.push('样式页找不到 .css-ai');
    else {
      console.log(`  标签="${ai.label}" 按钮=${ai.buttons.join('/')} 禁用=${ai.disabled} 字号=${ai.fs}px 溢出=${ai.over}px`);
      if (ai.label !== '说一句想要的效果') aiIssues.push(`标签文案不对：${ai.label}`);
      if (!/例如/.test(ai.placeholder)) aiIssues.push('占位符里没有示例');
      if (ai.buttons.length !== 3 || ai.visible !== 2) aiIssues.push(`按钮数量不对：${ai.buttons.join('/')}`);
      if (!ai.beforeEditor) aiIssues.push('AI 输入框没有排在 CSS 编辑器上方');
      if (!ai.off || !ai.disabled) aiIssues.push('只有模拟供应商时生成按钮应当是禁用状态');
      if (!/供应商/.test(ai.tip)) aiIssues.push('禁用时没有说明原因');
      if (ai.fs < 16) aiIssues.push(`手机端输入框 ${ai.fs}px，iOS 聚焦会被放大`);
      if (ai.over > 1) aiIssues.push(`AI 输入框横向溢出 ${ai.over}px`);
    }
    mobileIssues.ai = aiIssues.length;
    aiIssues.forEach((d) => mobileIssues.details.push(`${d}（AI CSS）`));
    if (!aiIssues.length) console.log('  AI 助手结构正常');
  }

  // 色块章节标题（modern / coral / compact 三套）的几何：文字必须视觉居中。
  // 这里用真实渲染量，不看 CSS 字面——曾经用 line-height:1.6 + padding:.2em 把
  // 色块撑到 2em 高，13px 的字装在 27px 的块里，看起来就像「顶部空了一整个字」。
  console.log('\n--- 色块章节标题（几何） ---');
  {
    const render = require(path.join(__dirname, '..', 'lib', 'render.js'));
    const demo = {
      basics: { name: '张伟', title: '高级前端工程师', email: 'a@example.com', phone: '13800138000', location: '北京',
        summary: '六年前端开发经验，擅长大型 Web 应用的架构设计与性能优化。' },
      work: [{ company: '星辰科技有限公司', position: '高级前端工程师', start: '2021-03', end: '至今',
        bullets: ['主导核心交易链路的前端重构，首屏时间从 3.2s 降至 1.8s'] }],
      skills: [{ category: '前端框架', items: ['React', 'Vue'] }],
    };
    const chipIssues = [];
    for (const theme of ['modern', 'coral', 'compact']) {
      const html = render.renderHTML(demo, { theme }, { inline: true });
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 120));
      const g = await page.evaluate(() => {
        const t = document.querySelector('.sec--t-chip .sec-title');
        if (!t) return null;
        const b = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        const ico = t.querySelector('.sec-ico');
        const range = document.createRange();
        const tn = [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
        if (tn) range.selectNodeContents(tn);
        const lb = tn ? range.getBoundingClientRect() : null;
        return {
          h: b.height, fs: parseFloat(cs.fontSize),
          icoColor: ico ? getComputedStyle(ico).color : null,
          textColor: cs.color, bg: cs.backgroundColor,
          lineTop: lb ? lb.top - b.top : null, lineH: lb ? lb.height : null,
        };
      });
      if (!g) { chipIssues.push(`${theme} 找不到色块标题`); continue; }
      const ratio = g.h / g.fs;
      const okH = ratio >= 1.4 && ratio <= 1.72;
      const okIco = g.icoColor && g.icoColor === g.textColor && g.icoColor !== g.bg;
      console.log(`  ${theme.padEnd(8)} 块高/字号=${ratio.toFixed(2)} 图标色=${g.icoColor || '-'} 文字色=${g.textColor}`);
      if (!okH) chipIssues.push(`${theme} 色块高度 ${g.h.toFixed(1)}px / 字号 ${g.fs.toFixed(2)}px = ${ratio.toFixed(2)}，应在 1.4–1.72 之间`);
      if (!okIco) chipIssues.push(`${theme} 色块里的图标看不见（图标色 ${g.icoColor} / 底色 ${g.bg}）`);
    }
    mobileIssues.chip = chipIssues.length;
    chipIssues.slice(0, 4).forEach((d) => mobileIssues.details.push(`${d}（色块标题）`));
    if (!chipIssues.length) console.log('  色块标题几何正常');
  }

  await page.setViewport({ width: 1440, height: 900 });

  console.log('\n=== 控制台错误 ===');
  if (!errors.length) console.log('无');
  else errors.slice(0, 20).forEach((e) => console.log(e));

  console.log('\n=== 失败请求 ===');
  if (!failures.length) console.log('无');
  else failures.slice(0, 20).forEach((e) => console.log(e));

  fs.writeFileSync(path.join(OUT, 'report.json'),
    JSON.stringify({ results, errors, failures, frameInfo, mobile, mobileIssues }, null, 2));

  // 手机端这三类问题都曾经真的出现过，出现任何一条都算失败
  const mobileBad = mobileIssues.tall + mobileIssues.tight + mobileIssues.overflowing + (mobileIssues.arrow || 0) + (mobileIssues.ai || 0);
  if (mobileBad) console.log(`\n✗ 手机端有 ${mobileBad} 处问题`);

  await browser.close();
  await cleanup();
  process.exit(errors.length || failures.length || mobileBad ? 1 : 0);
})().catch(async (err) => {
  console.error('UI 测试异常:', err);
  await cleanup();
  process.exit(2);
});
