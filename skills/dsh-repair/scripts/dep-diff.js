#!/usr/bin/env node
/**
 * dep-diff.js — 对比两份 node_modules 树的 name@version 地图（顶层 + 一层 @scope）
 *
 * 用法: node dep-diff.js "<good>/node_modules" "<bad>/node_modules"
 *
 * 判读指南:
 *   - 仅补丁号差异 + 平台原生件（*-linux-x64 / *-win32-*）→ 包层基本洗清，去查别的层
 *   - 内部伙伴包新于核心（如 core rc.1 而 internals rc.2）→ 核心 升到 registry latest 配平
 */
const fs = require('fs'), path = require('path');

function scan(nodeModules) {
  const out = {};
  const scopes = ['', '@deepseek-ai', '@earendil-works'];
  for (const sc of scopes) {
    const base = path.join(nodeModules, sc);
    let ents = []; try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const f = path.join(base, e.name);
      if (sc === '' && e.name.startsWith('@')) continue; // scope 目录本身跳过（已单独扫）
      try {
        const j = JSON.parse(fs.readFileSync(path.join(f, 'package.json'), 'utf8'));
        out[(sc ? sc + '/' : '') + e.name] = j.version;
      } catch {}
    }
  }
  return out;
}

const a = scan(process.argv[2]), b = scan(process.argv[3]);
if (!Object.keys(a).length || !Object.keys(b).length) {
  console.error('usage: node dep-diff.js <good-node_modules> <bad-node-modules>');
  process.exit(2);
}
const ka = new Set(Object.keys(a)), kb = new Set(Object.keys(b));
console.log('A=' + ka.size + ' entries  B=' + kb.size + ' entries');
console.log('--- version mismatches ---');
let mc = 0;
for (const k of [...ka].sort()) if (kb.has(k) && a[k] !== b[k]) { console.log('  ' + k + ': A=' + a[k] + ' B=' + b[k]); mc++; }
if (!mc) console.log('  (none)');
console.log('--- only in A ---');
const miss = [...ka].filter(k => !kb.has(k));
miss.forEach(k => console.log('  ' + k + '@' + a[k]));
if (!miss.length) console.log('  (none)');
console.log('--- only in B ---');
const ext = [...kb].filter(k => !ka.has(k));
ext.forEach(k => console.log('  ' + k + '@' + b[k]));
if (!ext.length) console.log('  (none)');
