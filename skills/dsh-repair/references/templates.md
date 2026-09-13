# 复用模板

## 受控启动抓 stderr（批处理模板）

占位符：`{{DSH_HOME}}`、`{{DSH_MEM}}`、`{{NODE}}`、`{{BINJS}}`。由调用方生成文件并回读校验后再执行（防反斜杠转义事故）。注意 stderr 单独落盘、stdout 追加、末行记录退出码：

```bat
@echo off
echo BOOT_START > "{{LOG_DIR}}\boot-out.log"
set "DSH_HOME={{DSH_HOME}}"
set "MY_PLUGIN_MEM_DIR={{DSH_MEM}}"
cd /d "{{DSH_HOME}}"
"{{NODE}}" "{{BINJS}}" web --host 127.0.0.1 --port 0 --no-open >>"{{LOG_DIR}}\boot-out.log" 2>"{{LOG_DIR}}\boot-err.log"
echo EXITCODE=%ERRORLEVEL% >>"{{LOG_DIR}}\boot-out.log"
```

轮询判定（node 侧）：ready = stdout 出现 `http://127.0.0.1:\d+`；早退 = 出现 `EXITCODE` 且无 ready；异常 = stderr 增长。ready 后再 HTTP GET `/` 探活一次。

## 合成 apply 测试（llm-pi-ai 样例）

「配置能解析但服务静默失效」时的终审。伪造最小 ctx，直调插件 apply，喂 settings.yaml 真实段：

```js
const { createRequire } = require('module');
const greq = createRequire('<全局安装>/@deepseek-ai/dsh/lib/bin.js');
const mod = await greq('@deepseek-ai/dsh-llm-pi-ai');   // inject: ['llm']
// yaml 解析注意版本：v2 具名 parse；老版在 .default
const section = yamlDoc['llm-pi-ai'];

const calls = [];
const ctx = {
  get(n) { return n === 'credentials' ? { async resolve() { return undefined; } } : undefined; },
  inject() {},                                            // 真实 inject 列表见适配器源码 const inject
  logger: { warn() {}, info() {}, error() {} },
  llm: {
    registerConfigurableProviders(e) { calls.push('providers:[' + e.map(x => x.provider).join(',') + ']'); return { replace() {} }; },
    registerModelDiscovery(ns) { calls.push('discovery:' + ns); },
    registerAdapter(routes) { calls.push('adapter:[' + routes.join(',') + ']'); return { replace() {} }; }
  }
};
try { mod.apply(ctx, section); console.log('OK', calls); }
catch (e) { console.log('THREW:', e.message); }          // 报错文案直接点名 provider/model/字段
```

判读：THREW → 文案即答案；OK 但 calls 缺 registerAdapter → 配置被 schema 静默剥离，逐项二分。

## 迭代补链 + 试启循环（profile 锚点缺核心包）

rc 升级后组合要求新核心模块、而 profile 解析不到全局安装时的通用循环：

```
round:
  若上轮报告缺失名 → 从全局内部作用域 junction 到 profile node_modules/@deepseek-ai/<name>
  清空日志 → start diag-boot.bat（用上面那个批处理模板生成）→ 每 4s 轮询（≤40s）
  READY            → 成功收工
  EXITED + ERR_MODULE_NOT_FOUND '@deepseek-ai/X' → 记入缺失集，下一轮
  其他             → 打印 stderr 尾部，人工判读
上限 6~8 轮，防止无限补
```

## 两机版本表快照 + diff

```bash
# 两端各跑（node stdin 管道喂一段调用 scan() 的脚本），输出 JSON 到本地
# scan() 的完整定义就在 scripts/dep-diff.js 里，直接复用它
# 任一端汇总
node scripts/dep-diff.js "<good>/node_modules" "<bad>/node_modules"
```

判读见 scripts/dep-diff.js 头注释。平台原生件（*-linux-x64* / *-win32-*）差异属正常。
