#!/usr/bin/env node
'use strict';
/**
 * inspect-session.js — 从 DSH 会话文件里取「运行时证据」（只读）
 *
 * 为什么需要它：判断「某插件在运行实例里到底有没有工作」时，**会话文件是第一手证据**
 * —— 比如某个插件（如 my-plugin）的 `source.kind='plugin'` + `my-plugin:recall` prompt section。
 * 配置文件写了什么、模块能不能 import，都不等于它在跑。
 *
 * 两个必须知道的坑（都实测踩过）：
 *   1. `session.v3.jsonl.zstd` 是**追加式多帧 zstd**（见过单文件 370 帧）。Node 的
 *      `zstdDecompressSync` 和 `createZstdDecompress()` 流式**都只解第一帧**，只会
 *      拿到 191 字节的会话头，看起来像「这个会话是空的」。必须用外部 `zstd -d -c`
 *      一次解全。本脚本优先走外部 zstd。
 *   2. **统计告警别用裸词**。`my-plugin: cannot` 这类模式会命中会话里「关于这条告警
 *      的讨论」—— 报告正文、验证脚本输出、日志文件内容都会被存进会话，于是你
 *      自己写的字变成假警报。要匹配代码真正输出的完整格式，并且**逐条看原文**再下结论。
 *
 * 用法：
 *   node inspect-session.js --latest [--grep "my-plugin:recall"] [--samples 8] [--chars 320]
 *   node inspect-session.js <path/to/session.v3.jsonl.zstd> [--grep ...]
 *   node inspect-session.js --latest --grep "source.kind" --sessions-root "<DSH_HOME>/sessions"
 *
 * 退出码：0 正常；1 找不到会话文件或解压失败；2 用法错误
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const sessionsRoot = opt('--sessions-root', process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : null);
const grepPattern = opt('--grep', null);
const sampleCount = parseInt(opt('--samples', '6'), 10);
const sampleChars = parseInt(opt('--chars', '320'), 10);

// ── 找 zstd ──────────────────────────────────────────────────────────
function findZstd() {
  if (process.env.ZSTD_BIN && fs.existsSync(process.env.ZSTD_BIN)) return process.env.ZSTD_BIN;
  try {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['zstd'], { encoding: 'utf8' });
    if (probe.status === 0) {
      const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch { /* 探查失败就继续猜路径 */ }
  const guesses = [
    'C:\\Program Files\\zstd\\zstd.exe',
    'C:\\Program Files (x86)\\anaconda3\\Library\\bin\\zstd.exe',
    'E:\\Program Files (x86)\\anaconda3\\Library\\bin\\zstd.exe',
    path.join(os.homedir(), 'anaconda3', 'Library', 'bin', 'zstd.exe'),
    '/usr/bin/zstd', '/usr/local/bin/zstd',
  ];
  for (const g of guesses) { if (fs.existsSync(g)) return g; }
  return null;
}

// ── 选会话文件 ───────────────────────────────────────────────────────
function latestSession(root) {
  if (!root || !fs.existsSync(root)) return null;
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.name.startsWith('session.v3.jsonl')) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs, size: st.size };
    }
  };
  walk(root, 0);
  return best;
}

let target = argv.find((a) => !a.startsWith('--') && a !== sessionsRoot && a !== grepPattern && fs.existsSync(a));
let frameHint = '';

if (!target) {
  if (!flag('--latest')) {
    console.error('用法: node inspect-session.js --latest [--grep "pattern"] [--sessions-root <dir>]');
    console.error('      node inspect-session.js <session.v3.jsonl.zstd> [--grep "pattern"]');
    console.error('  --sessions-root 默认取 $env:DSH_HOME/sessions。');
    process.exit(2);
  }
  const latest = latestSession(sessionsRoot);
  if (!latest) { console.error('[FAIL] 在 ' + sessionsRoot + ' 下找不到 session.v3.jsonl*'); process.exit(1); }
  target = latest.file;
  console.log('最近会话: ' + target);
  console.log('  改于 ' + new Date(latest.mtimeMs).toLocaleString() + '，' + Math.round(latest.size / 1024) + ' KB');
} else {
  console.log('会话文件: ' + target);
}

// ── 解压（外部 zstd 优先，能解全部帧）────────────────────────────────
const raw = fs.readFileSync(target);
let magicCount = 0;
for (let i = 0; i + 3 < raw.length; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) magicCount++;
}
frameHint = 'zstd 帧数(magic 计数): ' + magicCount;

const zstd = findZstd();
const tmp = path.join(os.tmpdir(), 'dsh-session-decoded-' + process.pid + '.jsonl');
let text = null;

if (zstd) {
  const fd = fs.openSync(tmp, 'w');
  // 用文件描述符重定向，不走 pipe —— 受限执行环境下管道捕获会 EPERM
  const r = spawnSync(zstd, ['-d', '-c', '-q', target], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  if (r.status === 0) {
    text = fs.readFileSync(tmp, 'utf8');
    console.log('解压: 外部 zstd（全帧）-> ' + Math.round(Buffer.byteLength(text, 'utf8') / 1024) + ' KB');
  } else {
    console.log('解压: 外部 zstd 退出码 ' + r.status + '，回退 Node');
  }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

if (text === null) {
  try {
    const zlib = require('zlib');
    text = zlib.zstdDecompressSync(raw).toString('utf8');
    console.log('解压: Node 单帧 —— ⚠️ 多帧会话只能拿到第一帧，结论不可用（装个 zstd，或设 ZSTD_BIN）');
  } catch (e) {
    console.error('[FAIL] 解压失败: ' + e.message);
    process.exit(1);
  }
}

console.log(frameHint);

const lines = text.split('\n').filter((l) => l.trim());
console.log('记录条数: ' + lines.length);
console.log('');

if (!grepPattern) {
  console.log('未给 --grep，只报告文件概况。常用模式示例：');
  console.log('  --grep "my-plugin:recall"        看插件的注入记录');
  console.log('  --grep \'"kind":"plugin"\'        看所有插件来源的记录');
} else {
  const hits = lines.filter((l) => l.includes(grepPattern));
  console.log('匹配 "' + grepPattern + '": ' + hits.length + ' 条');
  const shown = hits.slice(0, sampleCount);
  shown.forEach((l, i) => {
    const idx = l.indexOf(grepPattern);
    const start = Math.max(0, idx - 120);
    console.log('  [' + (i + 1) + '] …' + l.slice(start, start + sampleChars) + '…');
  });
  if (hits.length > shown.length) console.log('  （另有 ' + (hits.length - shown.length) + ' 条未显示）');
  console.log('');
  console.log('⚠️ 必须逐条看原文再下结论：匹配到的可能是「关于该模式的讨论」，而不是运行时输出。');
}
