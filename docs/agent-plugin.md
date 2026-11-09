# LogicMargin agent 插件

插件包含审查技能、HTTP MCP、评审 API、网页和 CLI。一个常驻后台进程同时提供 `/mcp`、`/api` 与内嵌网页；CLI 只在启动、配置和恢复时短暂运行。安装后可在其他工程使用，无需在业务工程安装 npm 依赖或启动 Vite。

0.9.7 默认使用 Go 原生程序，内嵌网页、HTTP MCP、评审 API、会话管理与 CLI。用户无需安装 Node.js、Go、Bun 或 npm；Node.js 和 Go 只用于源码开发与构建。按操作系统和架构分发五个 ZIP，旧 Node 通用 ZIP 不再是默认发行。

网页“设置”使用居中窗口，分为“界面”“快捷键”和“版本与更新”。常用审查键位可录制、停用或恢复默认，保存范围与输入边界见[快捷键说明](keyboard-shortcuts.md)。版本页可读取运行中原生服务版本，手动检查官方稳定版，并在服务本机一键更新已有 Codex 插件与 Go 服务。远程页面只能检查；详细信任、备份与失败恢复边界见 [网页本机更新](local-updates.md)。

## 在线安装与更新

需要 Git、支持 `plugin` 命令的 Codex，以及首次启动时到 GitHub Releases 的网络连接。macOS/Linux 下载启动器需要 `curl`、`unzip` 与 `shasum` 或 `sha256sum`；Windows 使用 PowerShell。无需安装本工程的 npm 依赖或手动克隆仓库：

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin
codex plugin add logic-margin@logic-margin-local
```

Codex 管理远程 Git marketplace，并稀疏检出插件目录；Git 对象的传输量仍由宿主和 Git 决定。这条路径携带 `scripts/logic-margin.sh`（macOS/Linux）与 `scripts/logic-margin.ps1`（Windows）启动器。首次启动按插件固定版本从官方 GitHub Release 下载匹配平台的原生 ZIP，验证同名 SHA-256 后运行；后续复用本地程序。它不在安装机器上编译，也不自动选择另一个版本。`logic-margin-local` 是沿用的 marketplace 标识，也用于在线安装。

同名 marketplace 的来源或 Git ref 不同时，Codex 会拒绝直接覆盖。切换前备份旧根目录，再通过 `codex plugin marketplace remove logic-margin-local --json` 移除该来源注册，随后添加固定目标来源；插件缓存会保留，但重新注册前暂时不在清单中。注册失败时从目录备份恢复；不要删除会话数据。网页更新器自动执行这一受控步骤，见 [网页本机更新](local-updates.md)。

已有安装先完成下文“升级与数据连续性”的停服与备份步骤，再让 Agent 更新插件：

```sh
codex plugin marketplace upgrade logic-margin-local --json
codex plugin add logic-margin@logic-margin-local --json
```

先核对 upgrade 返回的 `errors` 为空，再安装并核对返回的 `version` 与 `installedPath`。`upgrade` 只刷新 marketplace，第二步才更新实际安装。此路径跟随 `main` 上的插件版本；若要求固定版本，首次注册时将 `--ref main` 改为 `--ref v0.9.7`，之后更新仍保持该 tag。启动器的下载版本始终固定为当前插件版本，不使用浮动的 latest。

Codex 会移除旧版本缓存。更新后通过原宿主重新加载技能，按新版 `installedPath` 定位入口；旧 `LM_CLI` 路径可能已失效。安装成功与后台切换分别验证，恢复步骤见下文。

以上是可由 Agent 执行的命令流程；网页也可由用户明确点击触发受控本机更新，不会在每次评审时自动检查网络或替换文件。宿主不会为本地 ZIP 目录下载新版；ZIP 安装按下一节更换目录后重新注册。

## ZIP 安装（无需 Git）

从 [GitHub Release v0.9.7](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.7) 下载匹配平台的 `logic-margin-agent-0.9.7-TARGET.zip` 与同名 `.zip.sha256`：

| 平台 | TARGET |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Linux ARM64 | `linux-arm64` |
| Linux x64 | `linux-x64` |
| Windows x64 | `win32-x64` |

例如 macOS ARM64 的附件是 `logic-margin-agent-0.9.7-darwin-arm64.zip` 和 `logic-margin-agent-0.9.7-darwin-arm64.zip.sha256`。每个包只包含对应平台的程序、内嵌网页和插件材料；解压后运行无需下载运行时。

在下载目录校验，下面以 macOS ARM64 为例；Linux 将 `shasum -a 256` 换成 `sha256sum` 并选对应文件：

```sh
shasum -a 256 -c logic-margin-agent-0.9.7-darwin-arm64.zip.sha256
```

Windows PowerShell 用 `certutil -hashfile .\logic-margin-agent-0.9.7-win32-x64.zip SHA256`，与 `.zip.sha256` 内的摘要比较。一致后解压到持久位置，将 ZIP 顶层目录注册为 marketplace：

```sh
codex plugin marketplace add /absolute/path/to/logic-margin-agent-0.9.7-darwin-arm64
codex plugin add logic-margin@logic-margin-local
```

Windows 用实际的 `logic-margin-agent-0.9.7-win32-x64` 目录，包含空格的路径加引号。更新已有安装前先停止身份确认的旧后台、备份实际数据，步骤见下一节。

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

## 升级与数据连续性

0.8.x Node 服务与 0.9.7 Go 服务使用兼容的保存格式，但必须保持同一数据目录只有一个后台写入者。升级不需要删除会话、归档或重新创建评审：

1. 记录实际 `LOGIC_MARGIN_HOME`、`LOGIC_MARGIN_DATA_DIR`、端口和原 session ID。用已安装入口的 `server status` 核对登记实例、健康身份和版本；默认数据是 `~/.logic-margin/sessions`，自定义目录以实际服务记录为准。
2. 用 `server stop` 停止身份核验通过的旧受管实例，确认进程已退出，再备份实际会话目录。新版原生 CLI 也可检查和停止登记的旧实例。身份不匹配、进程仍存活但不健康或端口归属不明时保留现场诊断；不能按端口猜进程并强杀，也不能删登记文件绕过单写保护。
3. 更新 Git 插件或下载、校验并注册新版平台 ZIP。保留原 home、会话数据和端口；不要让旧 Node 与新 Go 同时写同一目录。新会话或重载技能后重新定位 `LM_CLI`。
4. 用新版入口 `server start` 启动，再检查 `server status` 的版本、健康和 MCP 地址。需要首次注册或修复配置时用 `server setup`；原宿主按返回结果重载/重连 MCP，核实工具实际可用。
5. 通过 `get_review` 读取原 session ID，核对目的、轮次与未完成反馈后继续。待处理的等待调用可能因停服结束；更新、重启或连接恢复都不代表评审通过。

保持原浏览器访问地址也能保留该地址下的草稿和待同步操作；浏览器数据不会随插件搬迁。备份与恢复针对实际会话目录，不删除 `sessions` 来完成升级。旧 Node 入口仅为开发兼容对照，不再用于正常安装。

## 单进程后台与 MCP 连接

将实际入口的绝对路径记为 `LM_CLI`：平台 ZIP 使用 `plugins/logic-margin/skills/logic-margin/scripts/logic-margin`（Windows 为 `logic-margin.exe`）；Git marketplace 使用技能目录内的 `scripts/logic-margin.sh` 或 `scripts/logic-margin.ps1`。macOS/Linux 保留文件执行权限，直接调用：

```sh
"$LM_CLI" server setup
```

PowerShell 将 `$LM_CLI` 设为实际 `.exe` 或 `.ps1` 路径，用 `& $LM_CLI server setup` 调用，包含空格的路径也适用。以下 shell 示例均按对应方式调用，不在前面加 `node`。

`server setup` 先启动或复用唯一后台，再用短暂的 `codex app-server` 配置进程，通过 Codex 原生 API 注册当前 `CODEX_HOME` 用户配置中的 `mcp_servers.logic_margin.url` 与 `tool_timeout_sec`。默认超时为 86400 秒，已有更长值保留；同名配置指向不同服务、已禁用或不兼容时拒绝覆盖。其他 MCP 和无关配置保持原值，配置进程不调用模型，完成后退出。该步骤要求 PATH 中可调用 `codex`。

核对输出的 `mcpUrl` 与 `mcp` 对象。`reloadRequired: true` 表示仍需原宿主重载或重连 MCP；确认 `start_review`、`wait_review` 等工具实际可调用后才开始评审。安装成功、后台健康、配置写入和工具加载分别核实，不把其中一个当作其余步骤完成。

后续评审用 `server start` 检查并复用后台，不必重复写配置。后台服务多个 Agent 与评审，CLI 退出后网页仍可访问。MCP 在同一端口通过 Streamable HTTP 连接，没有常驻 stdio 桥、独立监听进程或前端开发服务。

正常流程使用 MCP 的 `start_review`、`wait_review`、`acknowledge_review`、`revise_review` 等工具。长等待发生在工具内部，普通批注保存与连接保活不调用模型。调用仍受 Codex 配置和宿主连接层期限限制；服务退出后的完整恢复流程见 [代理评审流程](https://github.com/SunneeYang/LogicMargin/blob/main/docs/agent-workflow.md#中断和恢复)。

## Tailscale 与服务管理

默认只监听 `127.0.0.1`，端口由程序分配；正常重启继续使用原端口，让同一浏览器地址下的草稿与待同步操作继续可用。原端口被其他服务占用时会明确报错，不会静默换地址。

在运行服务的机器上，要求 Tailscale/局域网访问时可以执行：

```sh
"$LM_CLI" server start --host 0.0.0.0 --port 5173
```

随后在 MCP 的 `public_url` 使用分享地址 `http://100.124.38.121:5173`。MCP 路由始终只接受本机连接，即使网页/API 开放到私有网络；MCP 与需核验的源码工作区位于同一机器。另一台机器上的 Agent 可显式用原生 CLI 的兼容命令 `--url` 连接评审 API，但不是远程 MCP。`public_url` / CLI `--public-url` 只改变分享链接，不开放监听；显式 API 地址不会迁移或覆盖数据。

同一入口提供 `server status`、`server stop`。状态包含版本兼容、进程存活与 MCP 地址；实例身份、健康和版本匹配才复用，关闭通过实例令牌验证。启动锁避免多个 Agent 启动多个写入者。MCP 失败后，原 Agent 通过通用终端运行 CLI 检查：健康则重连，确认进程已退出则 `server start`；进程仍在但不健康、身份不符或端口冲突时保留现场并诊断。旧服务版本不兼容时，经身份核验停止旧实例再启动。正常等待不反复唤醒模型；优雅停服会明确结束待处理调用，强制崩溃后的发现时机仍由客户端断线处理与超时决定。

## 它会怎样工作

Agent 核对当前工程源码，整理节点、连线、输入输出和源码依据，生成固定快照评审文件，以 `--purpose` 明确此次目的，发起会话并等待。同一 thread/workflow 下的不同目的分别生成 session ID；可用 `--context` 记录归属。新评审从空批注开始，同一目的的修改则沿原 session 继续。你在图上批注，保存单条意见不会结束等待；点击“提交本轮”后，agent 记录实际处理的轮次，在原工作区修改逻辑，把最终回应和新版图一起发布并等待下一轮。确认解决和整轮通过由你完成。

MCP `start_review` 在创建前核验真实来源；`revise_review` 再次核验，并必填实际审阅的 `base_round` 与 `summary`。文件和 `source_root` 使用服务机器上的绝对路径，最终回应通过 `replies_file` 同版发布；逻辑未变时必填 `unchanged_reason`。`reply_review` 用于临时交流，发布新版前由人继续核对线程。完整参数与回应格式见 [代理评审流程](https://github.com/SunneeYang/LogicMargin/blob/main/docs/agent-workflow.md)。

代码改动评审在创建时可分别提供原版图 `baseline_file`、旧树 `baseline_source_root` 和当前图 `review_file`、当前树 `source_root`。Agent 先按真实 Git 基线读取原版源码，再生成同 ID 的前后图并分别核验。固定基线 B 在 R1 就可用于比较，后续评审轮次继续继承 B；也可按上一轮快照查看本轮变化。旧会话可用 `attach_review_baseline` 核验并补入 B，沿用原 session ID、轮次及批注。材料生成和 CLI 参数见插件内的评审格式参考。

也可先评审原系统再实施改造。发起时用原版图、真实源码根目录及 `baseline_review: true`，页面先显示 B 并接收改造意见。Agent 取回意见后修改和验证源码，再发布第一次实现图 R1，之后继续 R2、R3。会话始终保留最初的 B 供比较。

网页支持查看字段变化和单独核对依据更新。历史图只读；目标被移除后，原批注仍可从讨论列表回到提出时流程，保留当前讨论状态。缺少 B 的旧会话明确显示基线待提供。

代码对照只消费固定 B/R 已保存且能配对的源码片段，不从当前工作区补读。统一与并排视图共用单一竖向滚动入口，支持逐次扩展上下文；总览定位当前片段。文本差异先显示，结构结果有效后自动采用“结构重点”，明确移动且修改的块可“与原位置对照”。不支持、无效语法、不确定边界或预算耗尽时自动保留文本回退并说明原因，不提供手动高亮切换；结构重点不使用 SemanticDiff 引擎，也不判断通用语义等价，边界见 [结构 diff](https://github.com/SunneeYang/LogicMargin/blob/main/docs/structural-diff.md)。

日常网页同步仅包含当前图、批注线程、基线摘要及历史目录；完整基线、旧快照与固定意见包按需读取。反馈交付仍包含意见；通过交付只返回摘要、解决数量和 session/submission 索引，不输出批注、回复或源码文件清单，较早未领取反馈只列 `earlierSubmissionIds`。按需用 `get_review` 或兼容 CLI `get` 读取完整会话及归档；完整备份保持不变。会话响应与包内静态资源自动协商 gzip，无需给命令添加参数。

托管服务将原批注、回复、状态和每轮快照保存在运行服务机器的 `~/.logic-margin/sessions`，可按同一会话 ID 恢复。`LOGIC_MARGIN_HOME` 可更换服务与数据根目录，`LOGIC_MARGIN_DATA_DIR` 可单独指定会话目录；登记后重启仍沿用这个目录，无需重复环境变量。备份应包含实际会话目录。插件更新不会删除这些数据。开发服务器仍使用工程中的 `.logic-margin/sessions`；两者不自动混用。Agent 的代码编辑、测试和 Git 操作仍受原任务范围约束，发起评审不包含提交或推送授权。

原生 CLI 保留脚本和远端 API 的兼容命令；文件参数相对当前工程解析。`--help` 提供全部命令；`LOGIC_MARGIN_URL`、`LOGIC_MARGIN_PUBLIC_URL` 可提供兼容 CLI 的默认地址，显式参数优先。正常评审通过本机 MCP，源码编辑、测试和 Git 仍由原 Agent 完成。

## 评审隔离与清理

`list --context ID --state all` 按上下文查活动与归档评审，概要包含目的、轮次和状态。继续既有评审用原 session ID；为另一个目的发起审查时重新 `start --purpose TEXT [--context ID]`，不会继承文件里的旧批注。旧版无 scope 的会话继续兼容。

`cleanup SESSION_ID` 默认只归档已通过评审，保留完整图、批注与历史；`get SESSION_ID` 可以读归档，`restore SESSION_ID` 恢复同一会话。用户明确要求清理未完成评审时用 `--force`。永久删除用 `cleanup SESSION_ID --mode delete`，会删除该 ID 的活动及归档数据，无法恢复；没有默认批量删除。

MCP `wait_review` 不自动领取或归档。Agent 实际读取反馈后用 `acknowledge_review` 领取；`cleanup_on_approval: true` 保存通过后归档策略，取得 `approved: true` 与 `cleanupPending: true` 后再调用 `cleanup_review`。期间有新修改会拒绝旧版本清理并保留数据，网页确认通过本身不触发归档。CLI 兼容命令 `start --cleanup-on-approval` 与 `wait` 的自动领取、输出通过结果后归档行为继续兼容。归档位于实际会话数据目录，备份应包含完整目录；插件更新不删除归档。

评审轮次、图对象和回复数量不设固定业务条数上限，保留单条格式、长度、引用及发布基线校验。容量取决于机器和实际数据量。

## 开发与验证

源码开发需要 Node.js、npm、`go.mod` 指定的 Go，以及打包所需的 `zip`。这些是维护者工具，不是用户安装依赖。在 LogicMargin 源工程中构建，产生大量临时数据的命令按项目规则用 harness 包裹：

```sh
npm ci
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run build:go
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOWORK=off go test ./... -count=1
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run test:go:agent
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run test:go:compat
```

`build:go` 构建当前平台程序并内嵌前端。`npm test` 与旧 Node 后端作为开发兼容对照保留；旧 Node 通用包和 Bun 编译包不再是正常安装路径。前端开发可继续用 `npm run dev`，正式 Go 路径的浏览器验收用 `npm run test:go:e2e`。

按目标生成原生 ZIP 与 `.zip.sha256`：

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run package:agent -- --target darwin-arm64
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run package:agent -- --target darwin-x64
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run package:agent -- --target linux-arm64
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run package:agent -- --target linux-x64
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run package:agent -- --target win32-x64
```

输出位于 `artifacts/logic-margin-agent-0.9.7-TARGET.zip`，不包含本机实际会话、浏览器草稿或私有评审材料。包内直接运行 `scripts/logic-margin` / `scripts/logic-margin.exe`，不依赖 marketplace 下载器。每个平台须分别做原生运行验收；五目标 `CGO_ENABLED=0` 交叉编译通过不等于目标系统已验收。历史迁移记录仅实际运行了 macOS ARM64，具体测试与兼容边界见 [Go 验收](go-backend-validation.md) 和 [结构 diff 验收](structural-diff.md)。

## 维护者发布

同步 `package.json`、`package-lock.json` 根版本与 `packages[""]` 版本、Codex 插件 `plugin.json`、DSH 插件 `package.json` 和 `cmd/logic-margin/main.go` 默认版本为 0.9.7，再准备发布：

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run release:agent -- v0.9.7
/Users/hcm-b0677/.codex/bin/agent-tmp-run npm run test:release
```

发行目标是 GitHub tag `v0.9.7`，附件为五平台各一份 `logic-margin-agent-0.9.7-TARGET.zip`、一个 `dsh-plugin-logicmargin-0.9.7.tgz`、各自的 `.sha256` 和统一 `SHA256SUMS`。Git marketplace 的启动器按插件版本定位这些官方附件，校验后执行本平台程序；不将 Node 通用 ZIP 或开发 oracle 当成默认发布。DSH 使用生成的 tgz 安装，npm 与市场收录另行发布，见 [DSH 分发说明](deepseek-harness.md#市场与账号)。

推送 tag 与创建 GitHub Release 分别按用户授权执行。跨平台构建、原生运行、CI 完成和附件实际可下载是不同结果；以实际检查和 Release 附件为准，本地打包不代表已发布。维护时同时检查仓库启动器与 ZIP 内的技能说明，确保两条入口描述一致。

这是面向有本地执行能力的 Agent 的技能与 HTTP MCP 插件；ChatGPT 网页端不能仅靠 ZIP 启动本机程序。网页和评审 API 供可信本机或私有网络使用，尚未实现账号、权限或多人协作；含本机文件操作的 MCP 额外限制为回环连接。

格式依据：[OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins) 与 [Codex marketplace 命令](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)。本包采用 portable `plugin.json`，在线分发通过 Git marketplace，离线分发通过 Release ZIP；未上架 OpenAI 公共插件目录。
