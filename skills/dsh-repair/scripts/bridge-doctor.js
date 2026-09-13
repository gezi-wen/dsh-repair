#!/usr/bin/env node
'use strict';
/**
 * bridge-doctor.js — 树外插件「依赖桥」体检（只读，不改任何文件）
 *
 * 用法:
 *   node bridge-doctor.js --home <DSH_HOME> [--profile web] [--json]
 *   # 不给 --home 时读 $env:DSH_HOME
 *
 * 查什么（每一项都对应一次真实事故）:
 *   1. 每个 link: 插件的核心 peer 是否有桥、桥是否指向**当前闭包**、穿透是否可达
 *      —— 悬空一条 = 插件 import 失败 = 整个 DSH 崩在 readiness 之前
 *   2. profile node_modules 里该插件的入口是否指向插件目录且穿透可达
 *   3. client 半身插件的 react 是否自带（0.1.5 起宿主不再随包发 react）
 *   4. pnpm 配套（autoInstallPeers: false / confirmModulesPurge: false）
 *   5. devDependencies 里的 @deepseek-ai/* 残留（会让本地 pnpm install 装出真副本覆盖桥）
 *   6. profile 里的孤儿链接（指向树外却不在 dependencies 名单）
 *
 * 退出码: 0 = 无 FAIL；1 = 有 FAIL；2 = 用法错误
 *
 * 判定一律用穿透验证（statSync(路径/package.json)），不采信 readlink 有值这件事本身。
 */
const path = require('path');
const lib = require('./bridge-lib');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const jsonOut = flag('--json');
const home = lib.resolveHome(opt('--home', null));
const profile = opt('--profile', 'web');

if (!home) {
  console.error('用法: node bridge-doctor.js --home <DSH_HOME> [--profile web] [--json]');
  console.error('  未给 --home 时读 $env:DSH_HOME。');
  process.exit(2);
}

const prof = lib.loadProfile(home, profile);
if (!prof.ok) {
  console.error('[FAIL] ' + prof.why);
  process.exit(1);
}

function describeBridge(b) {
  switch (b.cls) {
    case 'MISSING': return '桥不存在（期望 → ' + b.expected + '）';
    case 'NOT-LINK': return '桥位置是实体目录，需手工处理：' + b.bridgePath;
    case 'DANGLING': return '穿透失败（target=' + (b.target || '?') + '）';
    case 'STALE': return '指向 ' + (b.target || '?') + '，期望 ' + b.expected;
    case 'NO_CLOSURE': return '闭包里没有这个包（' + b.note + '）—— 先在 profile 里装它，或它不属于闭包';
    default: return b.cls;
  }
}

const plugins = lib.linkDeps(prof.pkg, prof.profileDir);
const depNames = new Set(Object.keys(Object.assign({}, prof.pkg.dependencies || {})));
const report = {
  home, profile, profileDir: prof.profileDir, closureDir: prof.closureDir,
  plugins: [], orphans: [], fails: 0, warns: 0, totalBridges: 0,
};

for (const lp of plugins) {
  const entry = { name: lp.name, dir: lp.dir, problems: [], bridges: [], react: null, pnpm: null, devPeers: [] };
  const pkg = lib.readJsonSafe(path.join(lp.dir, 'package.json'));
  if (!pkg) {
    entry.problems.push({ level: 'FAIL', code: 'PLUGIN-MISSING', msg: '插件目录或 package.json 读不到：' + lp.dir });
    report.plugins.push(entry);
    continue;
  }

  // 1. profile node_modules 里的入口
  const depEntry = lib.probe(path.join(prof.profileDir, 'node_modules', lp.name));
  if (!depEntry.exists) {
    entry.problems.push({ level: 'FAIL', code: 'PROFILE-ENTRY', msg: 'profile 的 node_modules 里没有这个条目（运行 `dsh plugin --profile ' + profile + ' install`）' });
  } else if (!depEntry.throughOk) {
    entry.problems.push({ level: 'FAIL', code: 'PROFILE-ENTRY', msg: '入口穿透失败：' + (depEntry.target || depEntry.path) });
  } else if (depEntry.isLink && !lib.samePath(depEntry.target, lp.dir)) {
    entry.problems.push({ level: 'WARN', code: 'PROFILE-ENTRY-STALE', msg: '入口指向 ' + depEntry.target + '，期望 ' + lp.dir });
  }
  if (depEntry.throughOk && depEntry.name && depEntry.name !== lp.name) {
    entry.problems.push({ level: 'WARN', code: 'NAME-MISMATCH', msg: 'package.json 的 name=' + depEntry.name + ' ≠ 依赖 key ' + lp.name });
  }

  // 2. 核心 peer 的桥
  for (const peer of lib.corePeers(pkg)) {
    const b = lib.classifyBridge(lp.dir, peer, prof.closureDir);
    entry.bridges.push(b);
    if (b.cls !== 'OK') {
      entry.problems.push({ level: 'FAIL', code: 'BRIDGE-' + b.cls, msg: peer + ' :: ' + describeBridge(b) });
    } else if (b.note) {
      entry.problems.push({ level: 'WARN', code: 'BRIDGE-VERSION', msg: peer + ' :: ' + b.note });
    }
  }

  // 3. react（client 半身必需）
  if (lib.hasReactPeer(pkg)) {
    const r = lib.probeReact(lp.dir);
    entry.react = { peer: true, isLink: r.isLink, throughOk: r.throughOk, version: r.version, target: r.target };
    if (!r.throughOk) {
      entry.problems.push({
        level: lib.hasClientHalf(pkg) ? 'FAIL' : 'WARN',
        code: 'REACT-MISSING',
        msg: 'peer 声明 react 但插件目录里没有可用的 react' + (lib.hasClientHalf(pkg) ? '（client 半身必需；0.1.5 起宿主不再随包发 react，需在插件目录 pnpm install）' : ''),
      });
    }
  }

  // 4. pnpm 配套
  const pc = lib.checkPnpmConfig(lp.dir);
  entry.pnpm = pc;
  if (!pc.exists) {
    entry.problems.push({ level: 'WARN', code: 'PNPM-CFG', msg: '没有 pnpm-workspace.yaml（依赖桥三件事之二：autoInstallPeers: false + confirmModulesPurge: false）' });
  } else {
    if (!pc.autoInstallPeers) entry.problems.push({ level: 'WARN', code: 'PNPM-CFG', msg: 'pnpm-workspace.yaml 缺 autoInstallPeers: false —— 本地 pnpm install 会覆盖桥' });
    if (!pc.confirmModulesPurge) entry.problems.push({ level: 'WARN', code: 'PNPM-CFG', msg: 'pnpm-workspace.yaml 缺 confirmModulesPurge: false —— 无 TTY 环境 install 可能中止' });
  }

  // 5. devDependencies 残留
  const devs = lib.devCorePeers(pkg);
  entry.devPeers = devs;
  if (devs.length) {
    entry.problems.push({
      level: 'WARN', code: 'DEV-PEER',
      msg: 'devDependencies 残留 ' + devs.length + ' 个 @deepseek-ai/*（' + devs.slice(0, 3).join(', ') + (devs.length > 3 ? ' …' : '') + '）—— 本地 pnpm install 会装出真副本覆盖桥',
    });
  }

  report.plugins.push(entry);
}

// 6. 孤儿链接
report.orphans = lib.findOrphanLinks(prof.profileDir, home, depNames);

for (const p of report.plugins) {
  report.totalBridges += p.bridges.length;
  report.fails += p.problems.filter((x) => x.level === 'FAIL').length;
  report.warns += p.problems.filter((x) => x.level === 'WARN').length;
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.fails ? 1 : 0);
}

console.log('=== 依赖桥体检 · profile=' + profile + ' ===');
console.log('home     : ' + home);
console.log('profile  : ' + prof.profileDir);
console.log('闭包      : ' + prof.closureDir);
console.log('树外插件  : ' + plugins.length + ' 个 link:');
console.log('');

for (const p of report.plugins) {
  const f = p.problems.filter((x) => x.level === 'FAIL').length;
  const w = p.problems.filter((x) => x.level === 'WARN').length;
  const tag = f ? '[FAIL]' : w ? '[WARN]' : '[OK]  ';
  const bits = [];
  bits.push(p.bridges.length ? '桥 ' + p.bridges.filter((b) => b.cls === 'OK').length + '/' + p.bridges.length : '无核心 peer');
  if (p.react && p.react.peer) bits.push('react ' + (p.react.throughOk ? (p.react.version || 'OK') : '缺失'));
  console.log(tag + ' ' + p.name.padEnd(30) + bits.join(' · '));
  for (const pr of p.problems) console.log('        ' + pr.level + ' ' + pr.code + ' :: ' + pr.msg);
}

if (report.orphans.length) {
  console.log('');
  console.log('孤儿链接（profile 里指向树外、但不在 dependencies 名单）：');
  for (const o of report.orphans) {
    console.log('  ' + o.name + '  ->  ' + o.target);
    console.log('      ' + o.path);
  }
  console.log('  处理：cmd /c rmdir "<上面的路径>"   （只摘链接，不进目录）');
}

console.log('');
console.log('结论: FAIL=' + report.fails + ' WARN=' + report.warns + ' 插件=' + report.plugins.length + ' 桥=' + report.totalBridges);
if (report.fails) {
  console.log('下一步: node bridge-rebuild.js --home "' + home + '" --profile ' + profile + ' --fix');
  console.log('        （先不加 --fix 跑一遍看它打算做什么）');
}
process.exit(report.fails ? 1 : 0);
