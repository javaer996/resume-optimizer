'use strict';

/**
 * 备用引擎：用本机无头 Chrome 打印 PDF。
 *
 * 内置引擎（lib/pdf/*）不需要浏览器，是默认路径；这个引擎只在显式指定
 * PDF_ENGINE=chrome、或需要 Chrome 特有排版（比如依赖系统字体的 CSS）时使用。
 * 两者接受同样的 opts。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { renderHTML } = require('../render');

const CHROME_WRAPPER = '/data/dsh/tools/headless/bin/chrome-headless-shell';
const PUPPETEER_DIR = '/data/dsh/tools/headless/node_modules/puppeteer-core';

function findChrome() {
  if (fs.existsSync(CHROME_WRAPPER)) return CHROME_WRAPPER;
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** Chrome 引擎是否可用 */
function available() {
  const exe = findChrome();
  if (!exe) return { ok: false, error: '未找到可用的浏览器（Chrome/Chromium）' };
  if (!fs.existsSync(PUPPETEER_DIR)) {
    return { ok: false, error: `未找到 puppeteer-core（期望 ${PUPPETEER_DIR}）` };
  }
  return { ok: true, executablePath: exe };
}

let browserPromise = null;

async function getBrowser() {
  const exe = findChrome();
  if (!exe) {
    throw new Error('未找到可用的浏览器，无法生成 PDF。请设置环境变量 CHROME_PATH 指向 Chrome/Chromium 可执行文件。');
  }
  if (!fs.existsSync(PUPPETEER_DIR)) {
    throw new Error(`未找到 puppeteer-core（期望路径 ${PUPPETEER_DIR}），无法生成 PDF。`);
  }
  if (browserPromise) {
    // 浏览器进程可能已经没了(被系统 OOM 杀掉、手动 kill、崩溃)。
    // 这时候还抱着旧的实例,后面每一次导出都会报 "Connection closed." 直到重启服务。
    const live = await browserPromise.catch(() => null);
    // puppeteer 25 去掉了 isConnected(),只剩 connected 布尔属性
    const alive = live && (typeof live.isConnected === 'function' ? live.isConnected() : live.connected !== false);
    if (alive) return live;
    browserPromise = null;
    if (live) await live.close().catch(() => {});
  }
  if (!browserPromise) {
    browserPromise = (async () => {
      // eslint-disable-next-line import/no-dynamic-require
      const puppeteer = require(PUPPETEER_DIR);
      return puppeteer.launch({
        executablePath: exe,
        headless: 'shell',
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--font-render-hinting=none',
          // 每个进程用自己的 profile 目录。共用一个目录时,后启动的 Chrome 会接管
          // 前一个实例的 profile 锁,那个实例(比如常驻服务里的)会直接掉线,
          // 之后所有导出都报 "Connection closed."。
          `--user-data-dir=${path.join(os.tmpdir(), 'resume-pdf-profile-' + process.pid)}`,
        ],
      });
    })();
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

const DEAD = /Connection closed|Target closed|Protocol error|Session closed|browser has disconnected|WebSocket is not open/i;

async function renderPDF(profile, opts = {}) {
  const html = renderHTML(profile, opts);
  try {
    return await renderOnce(html, opts);
  } catch (err) {
    // 连接断了就丢掉浏览器重来一次,不给用户留下「导出一直失败」的状态
    if (!DEAD.test(String(err && err.message))) throw err;
    await closeBrowser();
    return renderOnce(html, opts);
  }
}

async function renderOnce(html, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    // 等字体就绪，避免中文回退成方框
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (_) { /* ignore */ }
    const pdf = await page.pdf({
      format: opts.pageSize || 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: !!opts.showPageNumbers,
      headerTemplate: '<div></div>',
      footerTemplate: opts.showPageNumbers
        ? '<div style="width:100%;font-size:9px;color:#6b7280;text-align:center;font-family:sans-serif;">'
          + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>'
        : '<div></div>',
      margin: {
        top: opts.showPageNumbers ? '14mm' : (opts.marginTop || '14mm'),
        bottom: opts.showPageNumbers ? '16mm' : (opts.marginBottom || '14mm'),
        left: '15mm',
        right: '15mm',
      },
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (_) { /* ignore */ }
  browserPromise = null;
}

module.exports = { renderPDF, closeBrowser, findChrome, available };
