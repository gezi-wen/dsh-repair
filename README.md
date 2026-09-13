# dsh-repair

一个 DSH 插件，内容只有一份技能：安装时把包内的 `skills/` 注册为一个技能根，于是这份技能随插件进入 agent 的技能目录。

```sh
dsh plugin --profile web add dsh-repair
```

## 技能覆盖什么

- **起不来怎么查**：boot 崩在 readiness 之前（`ERR_MODULE_NOT_FOUND`、`cannot resolve profile bundle`）、插件 `node_modules` 里 junction/symlink 穿透损坏、树外插件的依赖桥悬空
- **活着但残废**：服务静默失效（模型页缺提供方、按钮死）、配置能解析但 `apply` 抛异常、适配器静默丢弃它目录里没有的模型 id、日志干净却功能死了
- **依赖桥**：树外插件（`link:`）拿不到宿主核心包时的桥机制，以及 `bridge-doctor.js` / `bridge-rebuild.js` 的体检与重建
- **升级 DSH**：升级前停实例、备份、隔离预演；升级后的三层验证与 `settings.yaml` 复查
- **Windows 远程作业**：跨机经 SSH 收拾 Windows 上的 DSH 时的一整份坑清单（进程生命周期、引号转义、PowerShell、pnpm junction、路径漂移）

`scripts/` 里六个脚本随技能一起发：`bridge-doctor.js`（只读体检）、`bridge-rebuild.js`（重建，dry-run 优先）、`bridge-lib.js`（共用探测逻辑）、`dep-diff.js`（两棵 `node_modules` 版本表 diff）、`inspect-session.js`（从会话文件取运行时证据）、`link-doctor.js`（审计/修复 symlink 与 junction）。路径一律从 `--home` 或 `$DSH_HOME` 解析，没有写死任何一台机器。

## 布局

```
package.json        # dsh.bundle.patch → cordis.patch.yml
cordis.patch.yml    # 插入一行 @deepseek-ai/dsh-skill-filesystem，customSkillDirs 指向 skills/
skills/
  dsh-repair/
    SKILL.md
    references/
      templates.md
      windows-pitfalls.md
    scripts/
      package.json      # {"type":"commonjs"} —— 本包是 ESM 包，这六个脚本是 CommonJS
      bridge-doctor.js
      bridge-lib.js
      bridge-rebuild.js
      dep-diff.js
      inspect-session.js
      link-doctor.js
```

`cordis.patch.yml` 用的机制和 DSH 自带 agent preset 装载自己的技能是同一套：`!!js` 里的 `baseUrl` 解析到本包，所以路径跟着安装位置走。

## License

MIT
