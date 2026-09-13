#!/usr/bin/env node
/**
 * link-doctor.js — 审计/修复目录树里的 symlink 与 junction（Windows 为主，POSIX 兼容）
 *
 * 用法:
 *   node link-doctor.js <root>                     # 只审计
 *   node link-doctor.js <root> --fix               # 审计并修复
 *   node link-doctor.js <root> --fix --remap "<old-prefix>=<new-prefix>"
 *
 * 分类:
 *   OK              穿透可达（statSync(link) 成功且前缀未过期）
 *   THROUGH-BROKEN  目标存在但穿过链接解析失败（pnpm junction 典型病）→ 可原地重建
 *   REMAPPABLE      指向旧前缀（如 <old-prefix>\...），映射到新前缀后目标存在
 *   DANGLING        目标不存在也无法映射（只报告，不处理）
 *
 * 设计铁律（勿改）:
 *   - 遍历不穿入 reparse point（lstat 判定，命中即记录）——pnpm 自指结构会让跟随式遍历死循环
 *   - 删除兜底顺序 unlinkSync → rmdirSync → rmSync(force)
 *   - 重建一律 symlinkSync(target, link, 'junction')
 */
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2);
const root = args[0];
const doFix = args.includes('--fix');
const remaps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remap') {
    const [from, to] = String(args[i + 1] || '').split('=');
    if (from && to) remaps.push({ from: path.resolve(from), to: path.resolve(to) });
  }
}
if (!root || !fs.existsSync(root)) { console.error('usage: node link-doctor.js <root> [--fix] [--remap OLD=NEW ...]'); process.exit(2); }

function cleanRaw(t) { return t ? t.replace(/^\\\?\?\\/i, '').replace(/^\\\?\\/i, '') : t; }

const results = [];
const visited = new Set();
(function walk(dir) {
  const key = dir.toLowerCase();
  if (visited.has(key)) return;
  visited.add(key);
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      let raw = null; try { raw = fs.readlinkSync(full); } catch {}
      const t = cleanRaw(raw);
      const eff = t && !path.isAbsolute(t) ? path.resolve(path.dirname(full), t) : t;
      let cls = 'OK', fixTo = '';
      let resolves = false;
      try { fs.statSync(full); resolves = true; } catch {}
      if (!resolves) {
        cls = 'DANGLING';
        if (eff) {
          for (const r of remaps) {
            if (eff.toLowerCase().startsWith(r.from.toLowerCase() + path.sep)) {
              const cand = path.join(r.to, eff.slice(r.from.length));
              try { fs.statSync(cand); cls = 'REBUILD-MAPPED'; fixTo = cand; break; } catch {}
            }
          }
          if (cls === 'DANGLING' && !t.startsWith('..')) {
            // 目标存在但穿透失败 → pnpm 式穿透损坏
            try { fs.statSync(eff); cls = 'THROUGH-BROKEN'; } catch {}
          }
        }
      } else if (eff && remaps.some(r => eff.toLowerCase().startsWith(r.from.toLowerCase() + path.sep))) {
        cls = 'OK-STALE-PREFIX';
      }
      results.push({ full, raw: t || '', eff: eff || '', cls, fixTo });
    } else if (st.isDirectory()) walk(full);
  }
})(root);

// dedup (walk may revisit via stack only once per dir; safe)
console.log('total links inspected: ' + results.length);
const byCls = {};
for (const r of results) byCls[r.cls] = (byCls[r.cls] || 0) + 1;
for (const k of Object.keys(byCls).sort()) console.log('  ' + k + ' : ' + byCls[k]);

if (doFix) {
  let fixed = 0, failed = [];
  for (const r of results.filter(x => x.cls === 'THROUGH-BROKEN' || x.cls === 'REBUILD-MAPPED')) {
    const target = r.fixTo || r.eff;
    let removed = false;
    for (const fn of [() => fs.unlinkSync(r.full), () => fs.rmdirSync(r.full), () => fs.rmSync(r.full, { force: true })]) {
      try { fn(); removed = true; break; } catch {}
    }
    if (!removed) { failed.push({ link: r.full, why: 'remove failed' }); continue; }
    try {
      fs.symlinkSync(target, r.full, 'junction');
      fs.statSync(r.full); // 穿透验证
      fixed++;
    } catch (e) { failed.push({ link: r.full, why: e.message }); }
  }
  console.log('FIXED=' + fixed + ' FAILED=' + failed.length);
  failed.slice(0, 20).forEach(f => console.log('  FAIL ' + f.link + ' :: ' + f.why));
} else {
  const act = results.filter(r => r.cls !== 'OK' && r.cls !== 'OK-STALE-PREFIX');
  console.log('(dry-run; rerun with --fix to repair ' + act.length + ' link(s))');
  act.slice(0, 30).forEach(r => console.log('  [' + r.cls + '] ' + r.full + '\n      -> ' + (r.fixTo || r.eff)));
}
