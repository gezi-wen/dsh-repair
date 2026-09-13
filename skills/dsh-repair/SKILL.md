---
name: dsh-repair
description: Diagnose and repair broken DSH deployments on Windows or Linux, and upgrade DSH safely between versions. Use whenever DSH fails to boot (ERR_MODULE_NOT_FOUND, "cannot resolve profile bundle"), a plugin or service silently dies (model providers vanish from the Models page, settings buttons stop working), node_modules junctions/symlinks break after moving or cleaning up projects, global npm/pnpm trees look damaged, versions drift between dsh core and its internal packages, logs are clean but a feature is dead, or stderr seems swallowed by a GUI shell. Also use before, during, and after ANY DSH upgrade or global package reinstall (npm i -g @deepseek-ai/dsh@…), for out-of-tree plugins mounted with link, which cannot reach the host's core packages, for a model/provider entry that is configured but never appears in the Models page, whenever junctions or symlinks under a plugin directory are suspected or were hand-made, and proactively before/after any disk cleanup or project relocation on a machine running DSH.
---

# DSH Repair

从真实事故中沉淀的 DSH 部署修复手艺。核心教条只有一条：

> **先拿到运行时的真话，再动手。** 启动日志干净 ≠ 一切正常；配置能解析 ≠ apply 能活；readlink 有值 ≠ 链接能用。每一层都要用能逼出真相的手段亲自验证。

## 最坏场景先摆出来

**目标机器的 DSH 已经起不来，而操作者不在现场、看不到界面。** 典型场景是从另一台机器经 SSH 连进来收拾它。写每一步时都按这个前提：

- **没有 GUI。** 要看界面状态，先把它变成可读文本（实时 Slot 树、dump 配置、会话日志、产物响应码），别依赖截图和人眼判断。
- **操作者不在现场。** 命令要能直接粘贴、自带前置检查与判读标准。不要留「先确认一下环境」这种需要现场即兴发挥的步骤 —— 远端的操作者没法问你。
- **跨平台。** 两台机器可能一台 Windows、一台 Linux。先看 [Windows 远程作业陷阱](#windows-远程作业陷阱速记)，别把一边的结论套到另一边（见铁律 10）。
- **先问「最近动过什么」。** 这类故障多半是刚折腾过 —— 升级、加插件、改模型配置。这句话比翻半天源码快（铁律 6）。

## 症状 → 嫌疑层速查

| 症状 | 优先怀疑 | 跳转 |
|---|---|---|
| boot 崩溃，`ERR_MODULE_NOT_FOUND` 指向插件内部依赖 | 插件 node_modules 里 junction/symlink 断裂（搬家/清理后遗症） | [修链接](#修链接junction--symlink) |
| boot 崩溃，`cannot resolve profile bundle "X"` | profile 的 node_modules 链接穿透损坏或缺失 | [修链接](#修链接junction--symlink) + [profile 锚点规则](#profile-锚点规则) |
| boot 成功但某服务静默失效（模型页缺提供方、按钮死、namespace 缺席） | 配置在 apply 运行时解析抛异常，或插件 inject 的服务未注册 | [合成 apply 测试](#合成-apply-测试配置层终审) |
| 全局包被 force 重装过 / 升级后行为异常 | 核心与内部伙伴包版本漂移 | [版本配平](#版本配平) |
| 日志干净但功能死了 | 默认日志级别吞了 loader 报错；用合成测试或提权日志逼真话 | [三层验证](#三层验证收工前必过) |
| 升级/重装全局包时报 EPERM / EBUSY | 运行中的实例锁着原生模块（Windows），实例没停干净 | [升级 DSH](#升级-dsh) →「升级前」 |
| 配置里明明写了某模型/提供方，模型页却没有 | 适配器**静默丢弃**它目录里没有的 id（不报错） | [合成 apply 测试](#合成-apply-测试配置层终审) |
| 树外插件（`link:`）升 core 后找不到 `@deepseek-ai/*` | 够不到安装依赖闭包，需要依赖桥 | [依赖桥](#依赖桥树外插件接入宿主) |
| 升级后行为变了，但没人改过配置 | `settings.yaml` 可能在启动后被客户端程序化重写 | [升级 DSH](#升级-dsh) →「升级后必查」 |

## 黄金铁律（每一条都是摔出来的）

1. **壳会吞 stderr。** 桌面壳（如 dsh-desktop-electron）只把 stderr 尾部留在内存、崩溃时才展示。要真话就绕开壳：写一个带 `1>out.log 2>err.log` 重定向的批处理直跑 `node <dsh>/lib/bin.js web --host 127.0.0.1 --port 0 --no-open`。
2. **cordis 的报错走 stdout 不走 stderr**，且默认日志级别下 loader 的等待/失败可能完全无声。两个流都要留档、都要全文读。
3. **readlink 正常 ≠ 链接能用。** pnpm 在 Windows 上生成的 junction 可能整体「穿透损坏」：目标存在、readlink 有值，但 `statSync(link + '/package.json')` 失败。健康检查必须做穿透可达性测试。
4. **Config 解析通过 ≠ apply 能活。** schemastery 的 schema 只校形状；真正的解析器（如 llm-pi-ai 的 `resolveProfiles`）在 apply 第一行同步执行，抛异常即插件静默死亡。诚实的离线测试是合成 ctx 直调 `apply()`——报错文案还会点名元凶。
5. **同版本对照是最快的排除法。** 手头若有另一台正常运行的同类安装（或快照），全量 diff 包版本表，五分钟洗清或定罪整个包层。
6. **先问用户时间线再考古。** 「加完 X 才坏的」「清理之后才这样」一句话抵半天源码阅读。
7. **升级 / 重装全局包前必须停实例。** Windows 下运行中的 DSH 锁着原生模块（实测 `koffi.node` 被锁），而被加载的 `.node` 无法覆盖，`npm i -g` 会 EPERM / EBUSY。验法：试着以 `ReadWrite` + 共享模式 `None` 独占打开那个文件，能打开才算停干净。
8. **`apply` 不抛异常 ≠ 配置生效。** 适配器可能**静默丢弃**它目录里没有的条目（实测：`llm-pi-ai` 把 settings 里 7 条 openrouter 丢掉了 1 条，不报错）。配置层终审要多做一步：`listModels(provider)` 核对**实际公布**的清单。
9. **改完本文件的 frontmatter，回头确认技能还在。** 未加引号的 description 里一旦出现 `: `（比如写 `link: xxx`），YAML 就解析失败，**整个技能从目录里静默消失** —— 不报错、不提示，只是不见了。改完务必解析一遍 frontmatter，并确认技能列表里还在。（实测踩出来的教训。）
10. **「上次这样能行」换平台即作废。** 本技能里凡标着 Windows 实测的结论，拿到 Linux 都要重新判定，不要照抄。

## 三层验证（收工前必过）

1. **文件层**：每个关键包的 `package.json` 可穿透访问（穿过链接 statSync 成功）。
2. **组合层**：`bin.js web --dump-default-config`（含 profile bundle 行）。注意裸 `--dump-config` 不含 bundle 层，验证 profile 必须用前者。
3. **运行层**：受控启动 → ready 行出现 → stdout/stderr 双零告警 → （能连 UI 时）用户目测功能页。

### 运行层要「问到运行实例」，不是读配置

插件到底在不在工作，第一手证据在**会话文件**里 —— 不在 settings、不在 `package.json`、不在「模块能 import」。用 [`scripts/inspect-session.js`](scripts/inspect-session.js)：

```bash
node scripts/inspect-session.js --latest --grep "my-plugin:recall"
#   → 最近会话 / 解压方式 / 帧数 / 记录条数 / 匹配条数 + 截断样本
```

判读：`source.kind='plugin'` 的记录数 = 插件注入次数；`{"name":"<插件名>:<tag>","text":...}` 就是它注入的 prompt section。**注入了才算工作。**

两个实测踩过的坑：

- **会话文件是追加式多帧 zstd**（见过单文件 411 帧）。Node 的 `zstdDecompressSync` 与 `createZstdDecompress()` 流式**都只解第一帧** —— 只拿到约 191 字节的会话头，看起来像「这个会话是空的」，极易误判。必须外部 `zstd -d -c` 一次解全（Windows 上 anaconda 的 `Library\bin\zstd.exe` 就有）。脚本已按「外部 zstd → 回退 Node 并告警」处理。
- **统计告警别用裸词**。拿 `my-plugin: cannot` 去 grep，会命中会话里**关于这条告警的讨论** —— 报告正文、验证脚本输出、日志文件内容全都会被存进会话，于是自己写的字变成假警报（实测：初看「15 条告警 + 9 条 injection failed」，逐条看原文后发现全部是自己的文本，真实告警为 0）。匹配代码真正输出的完整格式，并**逐条看原文**再下结论。
- 顺带：当前实例的 stdout 常常**没有落到任何文件**（桌面壳持有），所以「去翻启动日志」这条路经常走不通 —— 会话文件才是稳的那条。

## 修链接（junction / symlink）

用 [`scripts/link-doctor.js`](scripts/link-doctor.js)，一个脚本两种模式：

```bash
# 只审计：遍历树（不穿入链接）、分类每根链接
node link-doctor.js "<plugin-dir>" 
# 审计 + 修复：
#   - 穿透损坏但目标存在的链接 → 原地重建为 junction
#   - 目标指向旧前缀且映射后存在的（如 <old-prefix>\X → <new-prefix>\X）→ 重指向
node link-doctor.js "<new-prefix>" --fix --remap "<old-prefix>=<new-prefix>"
```

要点：
- 遍历**不得穿入** reparse point（pnpm 自指结构会让跟随式遍历死循环）；用 lstat 判定、命中即记录不递归。
- 删除链接的兜底顺序：`unlinkSync` → `rmdirSync` → `rmSync(force)`，三者逐一尝试。
- 重建一律 `fs.symlinkSync(target, link, 'junction')`：免管理员、绝对路径、libuv 对 Node 透明。
- 相对 symlink（`..\` 开头目标）搬家后天然存活，不要误伤：只有「穿透失败」或「指向已消失前缀」的才动。

## 依赖桥（树外插件接入宿主）

`$DSH_HOME/profiles/node_modules` 是 dsh 每次启动 profile 时**自动维护**的「安装依赖闭包」：全是指向安装树的链接（`dsh-app-boot` 的 `ensureSymlink()`，Windows 走 junction）。装进 profile 的插件靠 Node 普通 parent-walk 就能拿到宿主核心包，升 core 时自动跟着走。

**但在 `$DSH_HOME` 树外的插件拿不到** —— 典型是自己写的插件用 `link:<plugin-dir>/<name>` 接入。**而且 link 进 profile 也没用**：Node 默认解析 symlink 的**真实路径**（未开 `--preserve-symlinks`），`require` 仍从树外那个真实目录出发。实测：经 junction 启动一个探测脚本，`__filename` 打印的是真实路径，`require` 也按真实路径找，够不到 junction 的上级 `node_modules`。

所以树外插件要在**自己目录里**建桥：

```
<插件>/node_modules/@deepseek-ai/<pkg>  →  链接  →  $DSH_HOME/profiles/node_modules/@deepseek-ai/<pkg>
```

配套三件事，缺一不可：

| 动作 | 为什么 |
|---|---|
| peer 里 `@deepseek-ai/*` 写 `*` | 写死版本范围就够不到新版本（预发布 semver 规则）；写 `*` 交给宿主 |
| 从 devDependencies 里摘掉所有 `@deepseek-ai/*` | 那是为了让本地 `pnpm install` 能解析而加的权宜写法；留着 pnpm 会装出真副本、覆盖桥 |
| `pnpm-workspace.yaml` 加 `autoInstallPeers: false` + `confirmModulesPurge: false` | 前者保证 pnpm 不装 peer（实测：重跑 install 后 13 条桥全存活）；后者防止无 TTY 环境 install 中止 |

client 侧插件另需**显式自带 react**：新版本可能不再随包发 react（实测 0.1.5 就没有，0.1.2 有 18.3.1），以前是靠 `autoInstallPeers` 默认 true 顺带装上的。

**风险讲清楚**：桥是纯文件系统状态，不在任何清单里。悬空一条 = 插件 import 失败 = **整个 DSH 崩在 readiness 之前**，不是单个插件失效。换机器 / 恢复备份 / 手滑之后没有任何命令能重建，只能手工重做。所以**能装进 profile 就装进 profile**，桥只用于必须保留 `link:` 的场景（开发期改源码即时重载）。

### 桥的体检与重建（`scripts/bridge-doctor.js` / `scripts/bridge-rebuild.js`）

桥不在任何清单里，所以**升级前后、搬家后、接入新插件后各跑一次体检**：

```bash
node bridge-doctor.js  --home "$DSH_HOME" --profile web        # 只读体检；有 FAIL 退出码 1
node bridge-rebuild.js --home "$DSH_HOME" --profile web        # dry-run，只列计划
node bridge-rebuild.js --home "$DSH_HOME" --profile web --fix  # 真建（每建一条当场穿透验证）
```

体检逐条查，全部走**穿透验证**（不采信 readlink 有值）：桥是否存在 / 是否指向**当前闭包** / 穿透是否可达；profile 入口链接；client 半身的 react（0.1.5 起宿主不再随包发）；`pnpm-workspace.yaml` 的两项配置；devDependencies 里残留的 `@deepseek-ai/*`（会让本地 `pnpm install` 装出真副本覆盖桥）；profile 里的孤儿链接（指向树外却已不在 dependencies 名单）。

重建只动四类：`MISSING` 建桥、`DANGLING` 原地重建、`STALE` 重指向当前闭包、`NO-CLOSURE` 报错**不猜目标**；`NOT-LINK`（桥位置是实体目录）**拒绝自动删**，留人工判断——那可能是 pnpm 装出的真副本，删了会连带丢依赖。

> 实测：5 个 link 插件 / 14 条桥全健康，唯一 WARN 是真发现（某个 link 插件的 devDependencies 残留 10 个 `@deepseek-ai/*`）。脚本自带 29 项断言的隔离挂具（假 HOME + 6 种桥状态），覆盖 MISSING / DANGLING / STALE / NOT-LINK / NO-CLOSURE / 孤儿。

## Profile 锚点规则

profile 目录（`$DSH_HOME/profiles/<name>`）里的模块解析**永远碰不到全局安装**——它不是全局前缀的祖先目录。因此：

- bundle patch 或 bundle 代码引用的任何 `@deepseek-ai/*` 核心 包，必须在 profile 的 `node_modules` 里有实体或链接；
- rc 升级后组合新增核心模块引用时，按「缺谁链谁→试启→再缺再链」迭代，源取全局安装内部的同名包；
- 组合里 `llm-pi-ai` 这类行来自 bundle（如 dsh-web-app），不在 profile package.json 里——查组合用 dump-default-config，别翻 profile 文件。

> **2026-09-10 补充：本节开头那个绝对说法要打折。** 「profile 里的模块解析永远碰不到全局安装」对**树外**成立，但树内的 profile 有一条自动通路 —— `$DSH_HOME/profiles/node_modules` 这个「安装依赖闭包」由 dsh **启动时自动维护**（实测：一个全新的隔离 HOME 首次启动 web profile 后，它自动出现，186 个顶层条目），profile 及其内部包靠 Node 普通 parent-walk 就能拿到 `@deepseek-ai/*` 核心包。因此：
> - 装进 profile 的插件**不需要**手工链核心包，升 core 自动跟随；
> - 「缺谁链谁」只在两种情况还需要：(a) 该包是 bundle 专属、闭包不含；(b) 插件在 `$DSH_HOME` 树外 —— 那是[依赖桥](#依赖桥树外插件接入宿主)的场景。

## 版本配平

全局树被 force 重装或升级后，先做两机（或两时刻）版本表 diff：

```bash
node scripts/dep-diff.js "<好的安装>/node_modules" "<坏的安装>/node_modules"
```

判读：
- 仅补丁号差异（同 minor）+ 平台原生件差异 → 包层洗清，继续找别的层；
- 内部伙伴包版本新于核心（如 core=rc.1 而 internals=rc.2）→ 升级核心到 registry latest 配平；
- 升级流程：**停掉所有实例**（共享 storages 的第二个实例是数据风险）→ 同步长连接跑
  `node "<node>/node_modules/npm/bin/npm-cli.js" install -g @deepseek-ai/dsh@<ver> --force --prefer-offline --no-audit --no-fund`
  → 回退 = 重装旧版本号。

## 合成 apply 测试（配置层终审）

当「服务静默失效 + 日志干净」时，绕过整条启动管线，伪造最小 ctx 直接调插件的 `apply(ctx, 真实配置)`：

- ctx 需要：被 inject 的服务（看插件源码 `const inject = [...]`）、`get()`、`logger`、以及目标服务桩（如 llm 的 register* 方法，只记调用不做事）。
- 配置取自 settings.yaml 对应段，用 yaml 包解析（注意导出形状随大版本不同：v2 具名 `parse`，老版在 `.default`）。
- 抛异常 → 错误文案通常直接点名（provider/model/字段）；完成 → 注册桩的调用序列就是预期行为清单。
- 实战样例（llm-pi-ai）：[references/templates.md](references/templates.md#合成-apply-测试)。

**关键补充（2026-09-10）：`apply` 不抛异常不等于生效 —— 还要看它公布了什么。** 适配器可能**静默丢弃**它目录里没有的条目：实测 `llm-pi-ai` 把 settings 里 7 条 openrouter 丢掉了 1 条（`stealth/ox-alpha`），`Config()` 通过、`apply()` 成功、全程无一条报错。所以配置层终审是**两步**：

1. `Config(section)` 校形状；
2. 合成 ctx 调 `apply()`，**再调 `adapter.listModels(provider)`**，把实际公布清单和配置清单逐条对齐。

假 ctx 要补的方法：`llm-pi-ai` 至少需要 `registerConfigurableProviders` / `registerAdapter` / `registerModelDiscovery`（缺一个会以 `is not a function` 点名，照着补）；`llm-deepseek` 只需前两个。注意 `listModels` 只回 `provider / id / name / inputModalities` 四个字段 —— 想核对 `contextWindow` / `maxTokens` 得去翻适配器的内置目录数据。

## 升级 DSH

升 core 是**主动制造故障面**，按最坏情况准备。

**升级前**

1. **停实例。** Windows 上用「独占打开一个原生 `.node`」证明确实停干净了（见铁律 7）。「systemd headless + electron 壳」这类双实例形态，**两个都要停**。
2. **备份**：`settings.yaml`、`$DSH_HOME/sessions`、profile 的 `package.json` 与 `pnpm-workspace.yaml`。
3. （推荐）**隔离预演**：独立 npm prefix + 独立 `$DSH_HOME` + 插件副本，活实例零接触 —— 会话格式、settings、会话数据全不碰真的，坏了直接删。代价是磁盘和时间。

**升级：两条命令连着敲完再重启**

```powershell
npm install -g @deepseek-ai/dsh@<新版本>
dsh plugin --profile web install
```

中间态（core 已新、profile 还是旧 client 包）**不要启动**，会版本错配。

**升级后必查**

- `dsh --version`；
- `--dump-default-config`（**不是**裸 `--dump-config`，后者不含 bundle 层）确认 bundle 与插件行都在；
- **复查 `settings.yaml`**：实测升级后 25 秒它被客户端整体重写过（连值都被改），别假设只有自己会写它；
- 树外插件的桥是否指到新版本（读 `<插件>/node_modules/@deepseek-ai/<pkg>/package.json` 的 version）；
- 运行态三层（见[三层验证](#三层验证收工前必过)）；client 半身用**实时 Slot 树**核对，别只看截图或配置文件；
- 会话格式可能不可降级（0.1.5 起是 V3）：旧日志会另存保留，但**回退旧版本读不了新会话**。

**平台差异（未在 Linux 验证）**：本节全部实测在 Windows。拿到 Linux 要重新判定 —— 那边用 symlink 不用 junction，没有 Windows 那套「加载中的 `.node` 被锁」，但会有别的坑。

## Windows 远程作业陷阱（速记）

完整清单见 [references/windows-pitfalls.md](references/windows-pitfalls.md)。最致命四条：

1. OpenSSH 里 `start /min` 开的窗口会随 ssh 会话关闭被杀——长任务要么同步长连接跑完，要么计划任务。
2. Node ≥24 的 spawnSync 直接调 `.cmd` 报 EINVAL（CVE-2024-27980 补丁），过 cmd.exe 或直接调 npm-cli.js。
3. cmd 引号转义地狱 → 一律把 PowerShell/node 脚本经 stdin 管道喂给远端（`ssh host "node" < script.js`），脚本内不做跨层引号体操。
4. PowerShell 深层目录遍历会卡死且缓冲输出；Windows 文件系统手术优先 Node（lstat/readlink/symlinkSync）。
5. **递归 grep 必须先排除 `sessions/` 与 `node_modules/`** —— `$DSH_HOME/sessions` 量极大，撞进去轻则刷爆输出，重则把另一台机器的历史搜索记录整段拉出来。
6. **经 stdin 喂给远端的脚本，里面的交互式子进程会把脚本剩下的部分吃掉** —— 同一根管道被两端争用，表现是脚本中途静默截断。凡是经管道喂的脚本，其中的交互式子进程一律加 `< /dev/null`。

## 案例库

按时间倒序追加。每份含背景、定位过程、修复、教训与「实测 / 未验证」标注；新事故修完后照此格式在 `references/` 下新建一份。
