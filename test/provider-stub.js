'use strict';
/**
 * 本地假上游：模拟 OpenAI / Anthropic 兼容接口，用于验证真实协议路径
 * 用法：node test/provider-stub.js [port]
 */
const http = require('http');

const PORT = Number(process.argv[2] || 8899);
const log = [];

const RESUME_JSON = {
  basics: {
    name: '[NAME_1]', title: '高级前端工程师', email: '[EMAIL_1]', phone: '[PHONE_1]',
    summary: '针对目标岗位重写的简介，突出性能治理与架构能力。',
  },
  work: [{ company: '[COMPANY_1]', position: '高级前端工程师', start: '2020-04', end: '至今',
    bullets: ['主导中台前端架构重构，首屏耗时下降 42%', '建设组件库，覆盖 9 条业务线'] }],
  projects: [], education: [], skills: [], awards: [], certificates: [], customSections: [],
};

function pickResume(messages) {
  const asText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && (b.text || b.content)) || '').join('') : '');
  const user = messages.filter((m) => m.role === 'user').map((m) => asText(m.content)).join('\n');
  const f = user.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!f) return null;
  try { return JSON.parse(f[1]); } catch (_) { return null; }
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const entry = { path: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || '', body: raw.slice(0, 400) };
    log.push(entry);
    console.log(`[stub] ${req.method} ${req.url} auth=${entry.auth ? entry.auth.slice(0, 14) : '(none)'}`);

    if (req.url === '/__log') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(log));
    }
    if (req.url === '/__reset') {
      log.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.url === '/__boom') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
    }

    let body = {};
    try { body = JSON.parse(raw); } catch (_) { /* ignore */ }

    if (req.url.includes('/messages')) {
      // Anthropic 格式
      const masked = pickResume(body.messages || []);
      if (!masked) {
        // 连通性测试等无简历请求：返回纯文本
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'msg_ping', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: '连接正常' }],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 },
        }));
      }
      const out = { resume: masked, notes: [{ section: '工作经历', reason: '突出量化结果', before: '', after: '首屏耗时下降 42%' }], keywords: ['性能优化'], coverLetter: '' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(out)}\n\`\`\`` }],
        stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 200 },
      }));
    }

    // 指定单位名含 FAIL 时返回 500，用于验证批量任务里的单项失败隔离
    if (String(raw).includes('FAILTRIGGER')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'simulated upstream failure for this company' } }));
    }

    // OpenAI 格式
    if (body.model === '__fail__') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'upstream is down' } }));
    }
    const masked = pickResume(body.messages || []);
    if (!masked) {
      // 连通性测试等无简历请求：返回纯文本回复
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-ping', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '连接正常' }, finish_reason: 'stop' }],
      }));
    }
    const out = { resume: masked, notes: [{ section: '工作经历', reason: '突出量化结果', before: '', after: '首屏耗时下降 42%' }], keywords: ['性能优化'], coverLetter: '' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `以下是优化结果：\n\`\`\`json\n${JSON.stringify(out)}\n\`\`\`\n希望对你有帮助。` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[stub] listening on http://127.0.0.1:${PORT}`));
