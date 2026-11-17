'use strict';
/**
 * 停止本项目的 node server.js（本机没有 pkill）。
 * 只匹配 cmdline 恰为 `node server.js` 的进程，避免误杀包含同名字符串的 shell。
 *
 *   node test/stop.js        停掉全部（默认）
 *   node test/stop.js 8901   只停监听这个端口的那个（看进程环境变量里的 PORT，
 *                            没设 PORT 的算默认 8888）
 *
 * 自测脚本会临时起自己的服务，加上端口参数就不会顺手把常驻的那个也停掉。
 */
const fs = require('fs');

const want = process.argv[2] ? String(process.argv[2]) : '';
const killed = [];

function portOf(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const hit = raw.split('\0').find((kv) => kv.startsWith('PORT='));
    return hit ? hit.slice(5) : '8888';
  } catch (_) {
    return '8888';
  }
}

for (const pid of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { continue; }
  const argv = raw.split('\0').filter(Boolean);
  if (argv.length !== 2) continue;
  if (!/(^|\/)node$/.test(argv[0])) continue;
  if (!/server\.js$/.test(argv[1])) continue;
  if (want && portOf(pid) !== want) continue;
  try { process.kill(Number(pid), 'SIGTERM'); killed.push(pid); } catch (_) { /* ignore */ }
}
console.log(killed.length ? `已停止: ${killed.join(', ')}` : '没有正在运行的服务');
