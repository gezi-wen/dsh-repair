# Windows 远程作业陷阱清单

跨机修 Windows 上的 DSH（通常经 OpenSSH 或其它远程 shell）时，以下每一条都真实摔过。

## 进程生命周期

- **`start /min` 开的窗口会随 ssh 会话关闭被杀。**「脱离运行」不可靠：诊断批处理若 2 秒内自崩则侥幸能看到日志，长任务（npm install）必死且无 EXITCODE。对策：同步长连接跑完（bash timeout 放足），或 schtasks 一次性任务。
- **杀进程必须按 PID**，先映射可执行文件路径再动手。`taskkill /IM electron.exe` 会把机器上所有 Electron 应用（包括编辑器）一起带走。
- 找 dsh 实例：`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 后按 CommandLine 匹配 `bin.js` + `web`。

## 命令执行与引号

- **cmd 引号转义地狱。** 一律避免多层引号：PowerShell/node 脚本写本地 → 经 stdin 管道喂远端：
  ```bash
  ssh host "node" < script.js
  ssh host 'powershell -NoProfile -Command -' <<'EOF' ... EOF
  ```
- **经 stdin 喂的脚本，里面的交互式子进程会吃掉脚本剩下的部分。** 远端进程从同一个 stdin 读脚本，而脚本里若有子进程也去读 stdin（`read`、交互式确认、`ssh` 会话、node/python 的 stdin 读取），它就把还没被解释器读走的后续行吞了——表现是脚本**中途静默截断**，报错指向莫名其妙的地方。对策：凡是经管道喂的脚本，其中的交互式子进程一律加 `< /dev/null`。（实测踩到过，绕了好几轮才定位。）
- **递归 grep 必须先排除 `sessions/` 与 `node_modules/`。** `$DSH_HOME/sessions` 是会话历史、量极大；撞进去轻则输出刷爆主上下文，重则把另一台机器的历史搜索记录整段拉出来。用 `--glob '!sessions/**' --glob '!node_modules/**'`，或先 `fd`/`ls` 限定范围再搜。（实测同一天撞了两次。）
- **Node ≥24 spawnSync 直接调 `.cmd` 报 EINVAL**（CVE-2024-27980 补丁）。过 `cmd.exe /d /c`（注意 /s 会改变去引号规则，慎用）或直接调 `node .../npm/bin/npm-cli.js`。
- 生成的 .bat 内容必须**回读校验后再执行**——JS 字符串里手写反斜杠极易出 `E:foo\...` 这类静默损坏，cmd 校验重定向路径失败会直接拒绝执行整行且无输出。
- 重定向语法：分开写 `1>"out" 2>"err"`；`2>>&1` 是非法语法，整行会被 cmd 静默丢弃。

## PowerShell（尤其 5.1）

- 深层目录遍历可能卡死数分钟且 stdout 被缓冲、全程无输出。Windows 文件系统手术**优先 Node**（lstat/readlink/symlinkSync('junction')），秒级完成。
- stdin 模式下脚本报错可能吞掉后续所有输出——关键步骤加 step 日志，FATAL 处打印 stack 前 3 行。
- PS 5.1 没有 `.ForEach` 数组方法、不支持 `(if ...)` 内联表达式；`$p.CommandLine` 判空要防 null。
- 控制台 GBK 乱码是常态：脚本开头 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`，日志内容尽量 ASCII。
- WMI/CimInstance 偶发无输出：换 node + tasklist CSV 解析兜底。

## 文件传输与路径

- **scp 的相对目标落在 sftp 主目录，可能与 cmd 会话的 %USERPROFILE% 不同**（见过 sftp 主目录与 cmd 会话的 `%USERPROFILE%` 指向不同用户目录而并存）。传文件用绝对路径 `host:E:/path/file`；临时产物统一放 `%TEMP%` 并在收尾清理。
- PowerShell `-File` 有时找不到刚 scp 的文件（同上主目录漂移）；stdin 管道可完全绕开落盘。

## pnpm 特有

- **pnpm 在 Windows 上 link: 依赖生成的 junction 可能整体穿透损坏**：readlink 显示正常、目标存在，但任何穿过链接的 stat 都失败。健康检查必须做穿透可达性（`statSync(link + '/package.json')`），不能只验目标存在。
- 同一机器上新旧两种布局并存：老项目是绝对 junction（搬家即悬空），新项目是相对 symlink（搬家免疫）。审计脚本必须同时处理两种目标的解析方式。
- 同盘 `Move-Item` 搬 pnpm 项目 = 内容完好但全部绝对 junction 悬空。搬完后要么在新家重装依赖，要么用 link-doctor --fix --remap 原地重指。

## 杂项

- 远端 cmd 里没有 `head/tail/grep`——管道过滤放在本地侧，或全用 node 处理。
- 凭据/令牌不落盘不进启动行：GUI 经私有通道认证，别指望裸 HTTP 能查运行时状态；运行时证据来自受控启动日志或合成调用。
