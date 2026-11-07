# LogicMargin agent 插件

插件包含审查技能、HTTP MCP、评审 API、网页和 CLI。一个常驻后台进程同时提供 `/mcp`、`/api` 与内嵌网页；CLI 只在启动、配置和恢复时短暂运行。安装后可在其他工程使用，无需在业务工程安装 npm 依赖或启动 Vite。

默认通用包复用 Node.js 22.18+，适用于 macOS、Windows 和 Linux；另提供包含运行时的可选原生包。默认包只携带应用代码和网页，避免每个插件都分发一份运行时。

## 在线安装与更新

需要 Node.js 22.18+、Git 与支持 `plugin` 命令的 Codex，无需安装本工程的 npm 依赖或手动克隆仓库：

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin
codex plugin add logic-margin@logic-margin-local
```

Codex 管理远程 Git marketplace，并稀疏检出插件目录；Git 对象的传输量仍由宿主和 Git 决定。这条路径使用仓库中已构建的独立 CLI，安装时不构建应用。`logic-margin-local` 是沿用的 marketplace 标识，也用于在线安装。

以前从源码或 ZIP 添加过同名本地 marketplace 时，重新执行上述命令即可切换到远程来源，不需要先卸载，也不删除原源码或解压目录。

Agent 可以执行原生命令更新：

```sh
codex plugin marketplace upgrade logic-margin-local --json
codex plugin add logic-margin@logic-margin-local --json
```

先核对 upgrade 返回的 `errors` 为空，再安装并核对返回的 `version` 与 `installedPath`。`upgrade` 只刷新 marketplace，第二步才更新实际安装。此路径跟随 `main` 上已构建的版本；若要求固定版本，首次注册时将 `--ref main` 改为具体 tag，例如 `--ref v0.8.5`，之后更新仍保持该 tag。

Codex 会移除旧版本缓存。更新完成后开始新会话或重新加载技能，按新版 `installedPath` 定位 CLI；当前会话保存的旧 `LM_CLI` 路径可能已失效。更新不自动中断正在进行的评审或停止后台服务；新版入口报告服务版本不匹配时，再用新版 CLI 的 `server stop` 关闭经身份核验的旧实例，随后重试以复用原数据和端口。

这是可由 Agent 执行的更新流程，不是每次评审时自动检查网络或后台替换文件。宿主不会为本地 ZIP 目录下载新版；ZIP 安装按下一节更换目录后重新注册。

## ZIP 安装（无需 Git）

从 [GitHub Releases](https://github.com/SunneeYang/LogicMargin/releases/latest) 下载 `logic-margin-agent-0.8.5.zip` 和同名 `.zip.sha256`。它包含网页、服务端与 CLI，不包含 Node 运行时、npm 依赖或源码工程。

在下载目录校验文件：macOS 使用 `shasum -a 256 -c logic-margin-agent-0.8.5.zip.sha256`，Linux 使用 `sha256sum -c logic-margin-agent-0.8.5.zip.sha256`；Windows PowerShell 用 `Get-FileHash .\logic-margin-agent-0.8.5.zip -Algorithm SHA256`，与 `.sha256` 内的摘要比较。

解压并将目录放在持久位置，然后执行：

```sh
codex plugin marketplace add /absolute/path/to/logic-margin-agent-0.8.5
codex plugin add logic-margin@logic-margin-local
```

开始新的 agent 会话，使用：

```text
用 $logic-margin:logic-margin 为当前功能发起逻辑评审，等待我的批注。
让程序自动启动本机服务。
```

恢复已有评审时，提供会话 ID 或完整链接：

```text
用 $logic-margin:logic-margin 继续这个评审，读取已提交意见并修改逻辑：
http://100.124.38.121:5173/?session=<sessionId>
```

插件在 Agent 所在执行环境调用 CLI；安装不复制真实评审数据。首次使用还需注册下面的本机 HTTP MCP，正常评审随后通过 MCP 完成。

## 单进程后台与 MCP 连接

首次在原 Agent 的执行环境运行包内 CLI（将路径替换为实际安装位置）：

```sh
node /path/to/plugin/skills/logic-margin/scripts/logic-margin.mjs server setup
```

`server setup` 先启动或复用唯一后台，再用短暂的 `codex app-server` 配置进程，通过 Codex 原生 API 注册当前 `CODEX_HOME` 用户配置中的 `mcp_servers.logic_margin.url` 与 `tool_timeout_sec`。默认超时为 86400 秒，已有更长值保留；同名配置指向不同服务、已禁用或不兼容时拒绝覆盖。其他 MCP 和无关配置保持原值，配置进程不调用模型，完成后退出。该步骤要求 PATH 中可调用 `codex`。

核对输出的 `mcpUrl` 与 `mcp` 对象。`reloadRequired: true` 表示仍需原宿主重载或重连 MCP；确认 `start_review`、`wait_review` 等工具实际可调用后才开始评审。安装成功、后台健康、配置写入和工具加载分别核实，不把其中一个当作其余步骤完成。

后续评审用 `server start` 检查并复用后台，不必重复写配置。后台服务多个 Agent 与评审，CLI 退出后网页仍可访问。MCP 在同一端口通过 Streamable HTTP 连接，没有常驻 stdio 桥、独立监听进程或前端开发服务。

正常流程使用 MCP 的 `start_review`、`wait_review`、`acknowledge_review`、`revise_review` 等工具。长等待发生在工具内部，普通批注保存与连接保活不调用模型。调用仍受 Codex 配置和宿主连接层期限限制；服务退出后的完整恢复流程见 [代理评审流程](https://github.com/SunneeYang/LogicMargin/blob/main/docs/agent-workflow.md#中断和恢复)。

## Tailscale 与服务管理

默认只监听 `127.0.0.1`，端口由程序分配；正常重启继续使用原端口，让同一浏览器地址下的草稿与待同步操作继续可用。原端口被其他服务占用时会明确报错，不会静默换地址。

在运行服务的机器上，要求 Tailscale/局域网访问时可以执行：

```sh
node /path/to/plugin/skills/logic-margin/scripts/logic-margin.mjs server start --host 0.0.0.0 --port 5173
```

随后在 MCP 的 `public_url` 使用分享地址 `http://100.124.38.121:5173`。MCP 路由始终只接受本机连接，即使网页/API 开放到私有网络；MCP 与需核验的源码工作区位于同一机器。另一台机器上的 Agent 可显式用旧 CLI `--url` 连接评审 API，但不是远程 MCP。`public_url` / CLI `--public-url` 只改变分享链接，不开放监听；显式 API 地址不会迁移或覆盖数据。

同一入口提供 `server status`、`server stop`。状态包含版本兼容、进程存活与 MCP 地址；实例身份、健康和版本匹配才复用，关闭通过实例令牌验证。启动锁避免多个 Agent 启动多个写入者。MCP 失败后，原 Agent 通过通用终端运行 CLI 检查：健康则重连，确认进程已退出则 `server start`；进程仍在但不健康、身份不符或端口冲突时保留现场并诊断。旧服务版本不兼容时，经身份核验停止旧实例再启动。正常等待不反复唤醒模型；优雅停服会明确结束待处理调用，强制崩溃后的发现时机仍由客户端断线处理与超时决定。

## 它会怎样工作

Agent 核对当前工程源码，整理节点、连线、输入输出和源码依据，生成固定快照评审文件，以 `--purpose` 明确此次目的，发起会话并等待。同一 thread/workflow 下的不同目的分别生成 session ID；可用 `--context` 记录归属。新评审从空批注开始，同一目的的修改则沿原 session 继续。你在图上批注，保存单条意见不会结束等待；点击“提交本轮”后，agent 记录实际处理的轮次，在原工作区修改逻辑，把最终回应和新版图一起发布并等待下一轮。确认解决和整轮通过由你完成。

MCP `start_review` 在创建前核验真实来源；`revise_review` 再次核验，并必填实际审阅的 `base_round` 与 `summary`。文件和 `source_root` 使用服务机器上的绝对路径，最终回应通过 `replies_file` 同版发布；逻辑未变时必填 `unchanged_reason`。`reply_review` 用于临时交流，发布新版前由人继续核对线程。完整参数与回应格式见 [代理评审流程](https://github.com/SunneeYang/LogicMargin/blob/main/docs/agent-workflow.md)。

代码改动评审在创建时可分别提供原版图 `baseline_file`、旧树 `baseline_source_root` 和当前图 `review_file`、当前树 `source_root`。Agent 先按真实 Git 基线读取原版源码，再生成同 ID 的前后图并分别核验。固定基线 B 在 R1 就可用于比较，后续评审轮次继续继承 B；也可按上一轮快照查看本轮变化。旧会话可用 `attach_review_baseline` 核验并补入 B，沿用原 session ID、轮次及批注。材料生成和 CLI 参数见插件内的评审格式参考。

也可先评审原系统再实施改造。发起时用原版图、真实源码根目录及 `baseline_review: true`，页面先显示 B 并接收改造意见。Agent 取回意见后修改和验证源码，再发布第一次实现图 R1，之后继续 R2、R3。会话始终保留最初的 B 供比较。

网页支持查看字段变化和单独核对依据更新。历史图只读；目标被移除后，原批注仍可从讨论列表回到提出时流程，保留当前讨论状态。缺少 B 的旧会话明确显示基线待提供。

日常网页同步仅包含当前图、批注线程、基线摘要及历史目录；完整基线、旧快照与固定意见包按需读取。反馈交付仍包含意见；通过交付只返回摘要、解决数量和 session/submission 索引，不输出批注、回复或源码文件清单，较早未领取反馈只列 `earlierSubmissionIds`。按需用 `get_review` 或兼容 CLI `get` 读取完整会话及归档；完整备份保持不变。会话响应与包内静态资源自动协商 gzip，无需给命令添加参数。

托管服务将原批注、回复、状态和每轮快照保存在运行服务机器的 `~/.logic-margin/sessions`，可按同一会话 ID 恢复。`LOGIC_MARGIN_HOME` 可更换服务与数据根目录，`LOGIC_MARGIN_DATA_DIR` 可单独指定会话目录；登记后重启仍沿用这个目录，无需重复环境变量。备份应包含实际会话目录。插件更新不会删除这些数据。开发服务器仍使用工程中的 `.logic-margin/sessions`；两者不自动混用。Agent 的代码编辑、测试和 Git 操作仍受原任务范围约束，发起评审不包含提交或推送授权。

CLI 位于插件的 `skills/logic-margin/scripts/logic-margin.mjs`，保留脚本和远端 API 的兼容命令；文件参数相对当前工程解析。`--help` 提供全部命令；`LOGIC_MARGIN_URL`、`LOGIC_MARGIN_PUBLIC_URL` 可提供兼容 CLI 的默认地址，显式参数优先。正常评审通过本机 MCP，源码编辑、测试和 Git 仍由原 Agent 完成。

## 评审隔离与清理

`list --context ID --state all` 按上下文查活动与归档评审，概要包含目的、轮次和状态。继续既有评审用原 session ID；为另一个目的发起审查时重新 `start --purpose TEXT [--context ID]`，不会继承文件里的旧批注。旧版无 scope 的会话继续兼容。

`cleanup SESSION_ID` 默认只归档已通过评审，保留完整图、批注与历史；`get SESSION_ID` 可以读归档，`restore SESSION_ID` 恢复同一会话。用户明确要求清理未完成评审时用 `--force`。永久删除用 `cleanup SESSION_ID --mode delete`，会删除该 ID 的活动及归档数据，无法恢复；没有默认批量删除。

MCP `wait_review` 不自动领取或归档。Agent 实际读取反馈后用 `acknowledge_review` 领取；`cleanup_on_approval: true` 保存通过后归档策略，取得 `approved: true` 与 `cleanupPending: true` 后再调用 `cleanup_review`。期间有新修改会拒绝旧版本清理并保留数据，网页确认通过本身不触发归档。旧 CLI `start --cleanup-on-approval` 与 `wait` 的自动领取、输出通过结果后归档行为继续兼容。归档位于实际会话数据目录，备份应包含完整目录；插件更新不删除归档。

评审轮次、图对象和回复数量不设固定业务条数上限，保留单条格式、长度、引用及发布基线校验。容量取决于机器和实际数据量。

## 开发与验证

在 LogicMargin 源工程中构建：

```sh
npm run package:agent
npm run test:agent
```

构建更新插件内的独立 CLI，并生成 `artifacts/logic-margin-agent-0.8.5.zip`。前端、HTTP MCP、会话 API 与启动管理一起打包；包中不包含本机实际会话、浏览器草稿或魔灵秘境专用评审包。默认包构建仅需工程 npm 依赖及系统 `zip`。

## 维护者发布

先同步 `package.json`、`package-lock.json` 根版本与 `packages[""]` 版本、插件 `plugin.json`，再准备发布包：

```sh
npm run release:agent -- v0.8.5
npm run test:release
```

发布准备会核对 tag 与四处版本一致，重新构建并生成 ZIP 与 `.zip.sha256`。将源码与更新后的 `plugins/logic-margin/skills/logic-margin/scripts/logic-margin.mjs` 一起提交；Git marketplace 直接使用这份文件。

在已获推送和发布授权后，推送对应的 `vX.Y.Z` tag 到 GitHub。Release workflow 会在 macOS、Windows、Linux 上验证 Node 通用包，通过后在 Ubuntu 构建，核对已提交 CLI 与构建结果一致，再创建 GitHub Release 并附上 ZIP、SHA-256 校验文件和自动生成的版本说明。已存在的 Release 不覆盖；普通分支 push 只验证，不发布。可选原生包仍按需本地构建。

本地打包或添加这份 workflow 不代表已经完成线上发布；以 GitHub Release 及其附件实际可下载为准。

## 可选原生包

可选原生包只在构建时需要 Bun，安装方无需 Node/Bun/npm。按目标分别打包，避免将多个运行时塞进同一个包：

```sh
npm run package:agent -- --native
npm run package:agent -- --target darwin-arm64
npm run package:agent -- --target darwin-x64
npm run package:agent -- --target linux-arm64
npm run package:agent -- --target linux-x64
npm run package:agent -- --target win32-x64
```

原生包中直接运行 `scripts/logic-margin`，Windows 使用 `scripts/logic-margin.exe`；在 PowerShell 中用 `& "C:\path with spaces\logic-margin.exe" --help`。原生目标限制来自 Bun；不声称支持 Windows ARM64 原生构建。macOS/Linux 保留文件执行权限。当前机器的实际运行验证与其他平台 CI 结果分别记录，不把交叉编译成功等同于运行验证。

这是面向有本地执行能力的 Agent 的技能与 HTTP MCP 插件；ChatGPT 网页端不能仅靠 ZIP 启动本机程序。网页和评审 API 供可信本机或私有网络使用，没有账号与权限管理；含本机文件操作的 MCP 额外限制为回环连接。

格式依据：[OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins) 与 [Codex marketplace 命令](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)。本包采用 portable `plugin.json`，在线分发通过 Git marketplace，离线分发通过 Release ZIP；未上架 OpenAI 公共插件目录。
