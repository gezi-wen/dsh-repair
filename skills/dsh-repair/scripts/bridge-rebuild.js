#!/usr/bin/env node
'use strict';
/**
 * bridge-rebuild.js — 树外插件「依赖桥」重建
 *
 * 用法:
 *   node bridge-rebuild.js --home <DSH_HOME> [--profile web]            # dry-run，只列计划
 *   node bridge-rebuild.js --home <DSH_HOME> [--profile web] --fix      # 真建
 *   node bridge-rebuild.js --home <DSH_HOME> --profile web --fix --only my-plugin
 *
 * 动作范围（只碰这四类，别的什么都不动）:
 *   MISSING    建桥
 *   DANGLING   原地重建
 *   STALE      重指向当前闭包
 *   NO-CLOSURE 不猜 —— 闭包里没有这个包就直接报错，先在 profile 里装它
 *   NOT-LINK   桥位置是实体目录 → **不自动删**（可能是 pnpm 装出的真副本，删了会连带丢依赖），
 *              只报告，让操作者决定
 *
 * 每建一条立刻做穿透验证（statSync(桥/package.json)）。收工后请再跑一次 bridge-doctor.js 复查。
 */
const path = require('path');
const lib = require('./bridge-lib');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const doFix = flag('--fix');
const only = opt('--only', null);
const home = lib.resolveHome(opt('--home', null));
const profile = opt('--profile', 'web');

if (!home) {
  console.error('用法: node bridge-rebuild.js --home <DSH_HOME> [--profile web] [--only <插件名>] [--fix]');
  console.error('  不加 --fix 是 dry-run。未给 --home 时读 $env:DSH_HOME。');
  process.exit(2);
}

const prof = lib.loadProfile(home, profile);
if (!prof.ok) {
  console.error('[FAIL] ' + prof.why);
  process.exit(1);
}

const plugins = lib.linkDeps(prof.pkg, prof.profileDir).filter((p) => !only || p.name === only);
if (!plugins.length) {
  console.error('[FAIL] 没有匹配的 link: 插件' + (only ? '（--only ' + only + '）' : '') + '。');
  process.exit(1);
}

const planned = [];
const done = [];
const blocked = [];
const skippedOk = [];

for (const lp of plugins) {
  const pkg = lib.readJsonSafe(path.join(lp.dir, 'package.json'));
  if (!pkg) {
    blocked.push({ plugin: lp.name, pkg: null, why: '插件目录或 package.json 读不到：' + lp.dir });
    continue;
  }
  const peers = lib.corePeers(pkg);
  if (!peers.length) continue;

  for (const peer of peers) {
    const b = lib.classifyBridge(lp.dir, peer, prof.closureDir);
    if (b.cls === lib.CLS.OK) { skippedOk.push({ plugin: lp.name, peer }); continue; }
    if (b.cls === lib.CLS.NO_CLOSURE) {
      blocked.push({ plugin: lp.name, pkg: peer, why: '闭包里没有这个包（' + b.note + '）—— 先在 profile 里装它，别猜目标' });
      continue;
    }
    if (b.cls === lib.CLS.NOT_LINK) {
      blocked.push({ plugin: lp.name, pkg: peer, why: '桥位置是实体目录，不自动删：' + b.bridgePath + '（确认可删后手工 `cmd /c rmdir` 再跑本脚本）' });
      continue;
    }
    planned.push(b);
  }

  // client 半身缺 react：不自动链（版本选择有风险），只提示
  if (lib.hasReactPeer(pkg)) {
    const r = lib.probeReact(lp.dir);
    if (!r.throughOk && lib.hasClientHalf(pkg)) {
      blocked.push({
        plugin: lp.name, pkg: 'react',
        why: 'client 半身缺 react（' + path.join(lp.dir, 'node_modules', 'react') + '）—— 在插件目录跑 pnpm install，别手工链（宿主闭包的 react 大版本可能不匹配 peer ' + (pkg.peerDependencies.react || '?') + '）',
      });
    }
  }

  // pnpm 配套（只提醒，不改别人的 package 配置）
  const pc = lib.checkPnpmConfig(lp.dir);
  if (pc.exists && (!pc.autoInstallPeers || !pc.confirmModulesPurge)) {
    blocked.push({
      plugin: lp.name, pkg: 'pnpm-workspace.yaml',
      why: '缺 ' + [!pc.autoInstallPeers ? 'autoInstallPeers: false' : null, !pc.confirmModulesPurge ? 'confirmModulesPurge: false' : null].filter(Boolean).join(' + ') + '（本地 pnpm install 会覆盖桥）—— 需人工补，脚本不碰',
    });
  }
}

console.log('=== 依赖桥重建 · profile=' + profile + ' ===');
console.log('home   : ' + home);
console.log('闭包    : ' + prof.closureDir);
console.log('模式    : ' + (doFix ? 'FIX（真建）' : 'dry-run（只列计划）'));
console.log('');

if (skippedOk.length) console.log('已健康: ' + skippedOk.length + ' 条桥（' + Array.from(new Set(skippedOk.map((s) => s.plugin))).join(', ') + '）');

if (planned.length) {
  console.log('');
  console.log((doFix ? '重建' : '待建') + ':');
  for (const b of planned) {
    const verb = { MISSING: '建桥', DANGLING: '重建', STALE: '重指向' }[b.cls] || b.cls;
    console.log('  [' + b.cls + '] ' + verb + '  ' + b.bridgePath);
    console.log('        → ' + b.expected);
    if (b.target) console.log('        原 target: ' + b.target);
  }
}

if (doFix && planned.length) {
  console.log('');
  for (const b of planned) {
    const r = lib.makeBridge(b.bridgePath, b.expected);
    if (r.ok) done.push(b);
    else blocked.push({ plugin: path.basename(path.dirname(path.dirname(b.bridgePath))), pkg: b.pkgName, why: r.why + '（' + b.bridgePath + '）' });
  }
  console.log('已建: ' + done.length + ' 条');
  for (const b of done) console.log('  OK  ' + b.bridgePath + '  →  ' + b.expected);
}

if (blocked.length) {
  console.log('');
  console.log('需人工处理:');
  for (const x of blocked) console.log('  ' + x.plugin + ' :: ' + x.pkg + ' :: ' + x.why);
}

console.log('');
if (!doFix && planned.length) {
  console.log('这是 dry-run。确认无误后加 --fix 执行：');
  console.log('  node bridge-rebuild.js --home "' + home + '" --profile ' + profile + ' --fix');
} else if (doFix) {
  console.log('复查: node bridge-doctor.js --home "' + home + '" --profile ' + profile + '"');
  console.log('提醒: 若这是刚接入的新插件，还要在 profile 里跑 `dsh plugin --profile ' + profile + ' install`。');
}

process.exit(blocked.length && !done.length ? 1 : 0);
