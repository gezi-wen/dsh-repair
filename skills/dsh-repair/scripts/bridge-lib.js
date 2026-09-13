'use strict';
/**
 * bridge-lib.js — 树外插件「依赖桥」的共用探测逻辑
 *
 * 被 bridge-doctor.js（体检）与 bridge-rebuild.js（重建）require。
 *
 * 桥的定义：
 *   <插件目录>/node_modules/@deepseek-ai/<pkg>
 *     →  $DSH_HOME/profiles/node_modules/@deepseek-ai/<pkg>   （安装依赖闭包）
 *
 * 为什么需要它：用 `link:<plugin-dir>/<name>` 接入 profile 的树外插件拿不到宿主核心包
 * —— Node 默认按 symlink 的**真实路径**解析（未开 --preserve-symlinks），require 从树外
 * 那个真实目录出发，够不到 junction 上级的 node_modules。桥是纯文件系统状态，
 * package.json 里没有一点记录；**悬空一条 = 插件 import 失败 = 整个 DSH 崩在 readiness 之前**。
 *
 * 设计铁律（勿改）：
 *   - 「readlink 有值」≠「链接能用」：判定健康必须做穿透可达性测试（statSync(路径/package.json)）。
 *   - 删除链接的兜底顺序：unlinkSync → rmdirSync → rmSync(force)。
 *   - 重建一律 symlinkSync(target, link, 'junction')：免管理员、绝对路径、libuv 对 Node 透明。
 *   - 判定「指向当前闭包」必须比较**规范化后的路径**（Windows 大小写不敏感 + \\?\ 前缀）。
 */
const fs = require('fs');
const path = require('path');

// ── 基础工具 ─────────────────────────────────────────────────────────

/** 去掉 Windows 扩展前缀（readlinkSync 在 junction 上常返回 \\?\E:\... 或 \??\E:\...） */
function cleanRaw(t) {
  return t ? String(t).replace(/^\\\\\?\\/, '').replace(/^\\\?\\/, '') : t;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function readLinkTarget(p) {
  try { return cleanRaw(fs.readlinkSync(p)); } catch { return null; }
}

function pathExists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 规范化比较：Windows 大小写不敏感，去尾部分隔符 */
function normPath(p) {
  if (!p) return null;
  let s = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function samePath(a, b) {
  const na = normPath(a), nb = normPath(b);
  return !!na && !!nb && na === nb;
}

/** child 是否位于 parent 之下（含自身） */
function within(child, parent) {
  const nc = normPath(child), np = normPath(parent);
  if (!nc || !np) return false;
  return nc === np || nc.startsWith(np + path.sep);
}

// ── 探测一个包位置 ───────────────────────────────────────────────────

/**
 * 探测某个路径上的包：存在性 / 是否链接 / 链接目标 / 穿透可达 / 自身 version+name。
 * throughOk 是硬指标 —— link-doctor 铁律 3：目标存在、readlink 有值，仍可能整体穿透损坏。
 */
function probe(p) {
  const out = { path: p, exists: false, isLink: false, target: null, throughOk: false, version: null, name: null };
  let st = null;
  try { st = fs.lstatSync(p); } catch { return out; }
  out.exists = true;
  out.isLink = st.isSymbolicLink();
  if (out.isLink) out.target = readLinkTarget(p);
  const j = readJsonSafe(path.join(p, 'package.json'));
  if (j) {
    out.throughOk = true;
    out.version = j.version || null;
    out.name = j.name || null;
  }
  return out;
}

// ── profile / 插件解析 ───────────────────────────────────────────────

function resolveHome(explicit) {
  const h = explicit || process.env.DSH_HOME;
  return h ? path.resolve(h) : null;
}

function loadProfile(home, profile) {
  const profileDir = path.join(home, 'profiles', profile);
  const closureDir = path.join(home, 'profiles', 'node_modules');
  const pkg = readJsonSafe(path.join(profileDir, 'package.json'));
  if (!pkg) return { ok: false, why: 'profile 的 package.json 读不到：' + path.join(profileDir, 'package.json') };
  return { ok: true, profileDir, closureDir, pkg };
}

/** 从 profile 的 dependencies 里挑出 link: 项，解析出插件真实目录 */
function linkDeps(pkg, profileDir) {
  const deps = Object.assign({}, pkg.dependencies || {});
  const out = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
    const raw = spec.slice('link:'.length);
    out.push({ name, spec, dir: path.resolve(profileDir, raw.replace(/\//g, path.sep)) });
  }
  return out;
}

/** profile 声明的『安装依赖闭包』根：$DSH_HOME/profiles/node_modules/@deepseek-ai */
function closureScopeDir(closureDir) {
  return path.join(closureDir, '@deepseek-ai');
}

function corePeers(pkg) {
  const peers = Object.assign({}, pkg.peerDependencies || {});
  return Object.keys(peers).filter(n => n.startsWith('@deepseek-ai/'));
}

function hasReactPeer(pkg) {
  const peers = Object.assign({}, pkg.peerDependencies || {});
  return Object.prototype.hasOwnProperty.call(peers, 'react');
}

function hasClientHalf(pkg) {
  return !!(pkg && pkg.dsh && pkg.dsh.client);
}

function devCorePeers(pkg) {
  const dev = Object.assign({}, pkg.devDependencies || {});
  return Object.keys(dev).filter(n => n.startsWith('@deepseek-ai/'));
}

// ── 桥的分类 ─────────────────────────────────────────────────────────

const CLS = {
  OK: 'OK',
  MISSING: 'MISSING',           // peer 声明了但桥不存在
  NOT_LINK: 'NOT-LINK',         // 桥位置是实体目录（pnpm 装出真副本，覆盖桥语义）
  DANGLING: 'DANGLING',         // 桥在但穿透失败（目标被删 / 搬家后遗症）
  STALE: 'STALE',               // 指向的不是当前闭包（升级后指向旧版本目录）
  NO_CLOSURE: 'NO-CLOSURE',     // 闭包里没有这个包（先在 profile 装，或它不属于闭包）
};

/** 判定一条桥（不修复）：返回 {pkgName, bridgePath, expected, cls, target, version, expectedVersion, note} */
function classifyBridge(pluginDir, pkgName, closureDir) {
  const bridgePath = path.join(pluginDir, 'node_modules', ...pkgName.split('/'));
  const expected = path.join(closureScopeDir(closureDir), ...pkgName.split('/').slice(1));
  const expProbe = probe(expected);
  const r = {
    pkgName, bridgePath, expected, cls: CLS.OK, target: null,
    version: null, expectedVersion: expProbe.version, note: '',
  };
  if (!expProbe.throughOk) {
    r.cls = CLS.NO_CLOSURE;
    r.note = expProbe.exists ? '闭包条目存在但穿透失败' : '闭包中没有该包';
    return r;
  }
  const p = probe(bridgePath);
  if (!p.exists) { r.cls = CLS.MISSING; return r; }
  if (!p.isLink) { r.cls = CLS.NOT_LINK; r.note = '实体目录（pnpm 装出的真副本）'; return r; }
  r.target = p.target;
  if (!p.throughOk) { r.cls = CLS.DANGLING; return r; }
  r.version = p.version;
  if (!samePath(p.target, expected)) { r.cls = CLS.STALE; return r; }
  if (r.version && r.expectedVersion && r.version !== r.expectedVersion) {
    r.note = '版本不一致 ' + r.version + ' vs 闭包 ' + r.expectedVersion;
  }
  return r;
}

/** 桥是否需要重建（doctor 与 rebuild 共用同一判定） */
function needsRebuild(cls) {
  return cls === CLS.MISSING || cls === CLS.NOT_LINK || cls === CLS.DANGLING || cls === CLS.STALE;
}

// ── 插件目录里 node_modules 的完整探测 ───────────────────────────────

/** 插件自带的 react（client 半身需要；0.1.5 起宿主不再随包发 react） */
function probeReact(pluginDir) {
  return probe(path.join(pluginDir, 'node_modules', 'react'));
}

/** 插件目录的 pnpm 配套配置（依赖桥三件事之二） */
function checkPnpmConfig(pluginDir) {
  const f = path.join(pluginDir, 'pnpm-workspace.yaml');
  let txt = null;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return { exists: false, autoInstallPeers: null, confirmModulesPurge: null, path: f }; }
  return {
    exists: true,
    autoInstallPeers: /^\s*autoInstallPeers\s*:\s*false\s*$/m.test(txt),
    confirmModulesPurge: /^\s*confirmModulesPurge\s*:\s*false\s*$/m.test(txt),
    path: f,
  };
}

/**
 * profile 里残留、却已不在 dependencies 名单里的链接 —— 孤儿（实测清理过一个 profile 里
 * 残留的 4 个，目标目录早已不存在）。
 *
 * 判据要收紧，否则会把 pnpm 自动维护的「安装依赖闭包」全误报成孤儿：
 * 闭包条目在 `$DSH_HOME/profiles/node_modules/<name>` 有同名兄弟，且两者指向同一处；
 * 而真正的孤儿（自研插件的残留 junction）在闭包里**没有对应条目**，或已经悬空。
 */
function findOrphanLinks(profileDir, home, depNames) {
  const nm = path.join(profileDir, 'node_modules');
  const closureNm = path.join(home, 'profiles', 'node_modules');
  const out = [];
  const skip = new Set(['.bin', '.pnpm', '.modules.yaml', '.package-lock.json', '.pnpm-workspace-state.json']);
  let ents = [];
  try { ents = fs.readdirSync(nm, { withFileTypes: true }); } catch { return out; }

  const scanOne = (p, name) => {
    const cur = probe(p);
    if (!cur.exists || !cur.isLink) return;
    if (depNames.has(name)) return;              // 在依赖名单里 → 正常
    if (!cur.target) return;
    const abs = path.isAbsolute(cur.target) ? cur.target : path.resolve(path.dirname(p), cur.target);
    // $DSH_HOME 树内的一切由 dsh / pnpm 自己维护（含 .dsh-module-fallback 这类内部兜底目录）→ 正常
    if (within(abs, home)) return;
    // 自动维护的闭包：与 profiles/node_modules 下同名条目指向同一处 → 不是孤儿
    const closureEntry = path.join(closureNm, ...name.split('/'));
    const cp = probe(closureEntry);
    if (cp.exists) {
      if (cp.isLink && samePath(cp.target, abs)) return;
      if (within(abs, closureEntry)) return;
      if (!cp.isLink && samePath(closureEntry, abs)) return;
    }
    out.push({ name, path: p, target: abs, dangling: !cur.throughOk });
  };

  for (const e of ents) {
    if (skip.has(e.name)) continue;
    const full = path.join(nm, e.name);
    if (e.name.startsWith('@')) {
      let subs = [];
      try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) scanOne(path.join(full, s.name), e.name + '/' + s.name);
    } else {
      scanOne(full, e.name);
    }
  }
  return out;
}

// ── 删除 / 重建（只被 rebuild 调用） ─────────────────────────────────

/** 删除一个链接：unlink → rmdir → rm(force) 三级兜底 */
function removeLink(p) {
  for (const fn of [
    () => fs.unlinkSync(p),
    () => fs.rmdirSync(p),
    () => fs.rmSync(p, { force: true }),
  ]) {
    try { fn(); return true; } catch { /* 下一个兜底 */ }
  }
  return false;
}

/** 建一条桥并当场穿透验证；返回 {ok, why} */
function makeBridge(bridgePath, target) {
  const parent = path.dirname(bridgePath);
  try { fs.mkdirSync(parent, { recursive: true }); } catch { /* 已存在 */ }
  if (!removeLinkIfPresent(bridgePath)) return { ok: false, why: '旧链接删除失败' };
  try {
    fs.symlinkSync(target, bridgePath, 'junction');
  } catch (e) {
    return { ok: false, why: 'symlinkSync 失败: ' + e.message };
  }
  if (!probe(bridgePath).throughOk) return { ok: false, why: '重建后穿透验证仍失败' };
  return { ok: true };
}

function removeLinkIfPresent(p) {
  try { fs.lstatSync(p); } catch { return true; }   // 本来就不存在
  if (!isLink(p)) return false;                     // 实体目录，不擅自动
  return removeLink(p);
}

module.exports = {
  cleanRaw, isLink, readLinkTarget, pathExists, readJsonSafe,
  normPath, samePath, within,
  probe, resolveHome, loadProfile, linkDeps, closureScopeDir,
  corePeers, hasReactPeer, hasClientHalf, devCorePeers,
  CLS, classifyBridge, needsRebuild, probeReact, checkPnpmConfig, findOrphanLinks,
  removeLink, makeBridge,
};
