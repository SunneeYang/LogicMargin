# LogicMargin agent 插件

插件包含审查技能、网页、API 和 CLI。安装后可在其他工程中使用，不需要在那个工程安装 npm 依赖或手动启动 Vite。未指定服务地址时，命令会自动启动或复用本机服务并等待就绪。

默认通用包复用 Node.js 22.18+，适用于 macOS、Windows 和 Linux；另提供包含运行时的可选原生包。默认包只携带应用代码和网页，避免每个插件都分发一份运行时。

## 安装

解压 `logic-margin-agent-0.5.0.zip`，将解压目录放在持久位置，然后执行：

```sh
codex plugin marketplace add /absolute/path/to/logic-margin-agent-0.5.0
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

插件在 agent 所在执行环境中调用 CLI，首次发起评审时自动启动包内服务。显式指定 API 地址时只连接该地址，不会改为另一份本机会话。安装不复制真实评审数据。

## Tailscale 与服务管理

默认只监听 `127.0.0.1`，端口由程序分配；正常重启继续使用原端口，让同一浏览器地址下的草稿与待同步操作继续可用。原端口被其他服务占用时会明确报错，不会静默换地址。

在运行服务的机器上，要求 Tailscale/局域网访问时可以执行：

```sh
node /path/to/plugin/skills/logic-margin/scripts/logic-margin.mjs server start --host 0.0.0.0 --port 5173
```

随后向 agent 提供分享地址 `http://100.124.38.121:5173`；另一台机器上的 agent 另外指定 API 地址。`--public-url` 只改变分享链接，不会开放监听接口。已有开发服务可以通过显式 `--url` 继续使用，不会迁移或覆盖它的数据。

同一入口提供 `server status`、`server stop`。进程身份、健康检查和版本均匹配时才复用；关闭通过实例令牌请求，不按不可靠的 PID 直接杀进程。启动锁避免多个 agent 同时启动多个写入进程，异常退出后可恢复。旧服务版本不匹配时先停止旧实例再重试。

## 它会怎样工作

Agent 核对当前工程源码，整理节点、连线、输入输出和源码依据，生成固定快照评审文件，以 `--purpose` 明确此次目的，发起会话并等待。同一 thread/workflow 下的不同目的分别生成 session ID；可用 `--context` 记录归属。新评审从空批注开始，同一目的的修改则沿原 session 继续。你在图上批注，保存单条意见不会结束等待；点击“提交本轮”后，agent 记录实际处理的轮次，在原工作区修改逻辑，把最终回应和新版图一起发布并等待下一轮。确认解决和整轮通过由你完成。

CLI 的 `verify <review.json> --source-root <workspace>` 可先核验真实来源；`revise` 自动再核验，并必填 `--base-round NUMBER --summary TEXT`。`--source-root` 默认当前工程，最终回应可通过 `--replies-file` 传入，逻辑未变时必填 `--unchanged-reason`。独立 `reply` 用于临时交流，发布新版前不能确认解决或通过。完整命令与回应格式见 [代理评审流程](agent-workflow.md)。

网页默认显示当前图，支持切换修改前快照、查看字段变化和单独核对依据更新。历史图只读；目标被移除后，原批注仍可从讨论列表回到提出时流程，保留当前讨论状态。

日常网页同步仅包含当前图、批注线程及历史目录；旧快照与固定意见包按需读取。现有 CLI 完整会话接口和完整备份保持不变。会话响应与包内静态资源自动协商 gzip，无需给命令添加参数。

托管服务将原批注、回复、状态和每轮快照保存在运行服务机器的 `~/.logic-margin/sessions`，可按同一会话 ID 恢复。`LOGIC_MARGIN_HOME` 可更换服务与数据根目录，`LOGIC_MARGIN_DATA_DIR` 可单独指定会话目录；登记后重启仍沿用这个目录，无需重复环境变量。备份应包含实际会话目录。插件更新不会删除这些数据。开发服务器仍使用工程中的 `.logic-margin/sessions`；两者不自动混用。Agent 的代码编辑、测试和 Git 操作仍受原任务范围约束，发起评审不包含提交或推送授权。

CLI 位于插件的 `skills/logic-margin/scripts/logic-margin.mjs`。文件参数相对当前工程解析，因此无需切换到插件目录。`--help` 提供全部命令；`LOGIC_MARGIN_URL`、`LOGIC_MARGIN_PUBLIC_URL` 可提供默认地址，显式参数优先。

## 评审隔离与清理

`list --context ID --state all` 按上下文查活动与归档评审，概要包含目的、轮次和状态。继续既有评审用原 session ID；为另一个目的发起审查时重新 `start --purpose TEXT [--context ID]`，不会继承文件里的旧批注。旧版无 scope 的会话继续兼容。

`cleanup SESSION_ID` 默认只归档已通过评审，保留完整图、批注与历史；`get SESSION_ID` 可以读归档，`restore SESSION_ID` 恢复同一会话。用户明确要求清理未完成评审时用 `--force`。永久删除用 `cleanup SESSION_ID --mode delete`，会删除该 ID 的活动及归档数据，无法恢复；没有默认批量删除。

`start --cleanup-on-approval` 持久化通过后归档策略；`wait` / `resume --wait` 的同名选项只为本次等待启用。代理先取得并输出最终通过结果，再按该版本归档；期间有新修改会拒绝归档并保留数据。网页确认通过本身不触发清理。归档位于实际会话数据目录，备份应包含完整目录；插件更新不删除归档。

评审轮次、图对象和回复数量不设固定业务条数上限，保留单条格式、长度、引用及发布基线校验。容量取决于机器和实际数据量。

## 开发与验证

在 LogicMargin 源工程中构建：

```sh
npm run package:agent
npm run test:agent
```

构建更新插件内的独立 CLI，并生成 `artifacts/logic-margin-agent-0.5.0.zip`。前端、会话 API 与启动管理一起打包；包中不包含本机实际会话、浏览器草稿或魔灵秘境专用评审包。默认包构建仅需工程 npm 依赖及系统 `zip`。

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

这是面向有本地命令执行能力的 agent 的技能插件，没有 MCP 服务；ChatGPT 网页端不能仅靠这个 ZIP 运行 CLI。服务目前供可信本机或私有网络使用，没有账号和权限管理。

格式依据：[OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。本包采用 portable `plugin.json` 与本地 marketplace，未发布到公共目录。
