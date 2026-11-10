# MCP 连接、恢复与 CLI 回退

## 先诊断，再建立连接

按主技能定位 `LM_CLI`。先通过宿主终端运行只读检查；PowerShell 使用 `& $LM_CLI server status`：

```sh
"$LM_CLI" server status
```

分别确认三个层次，报告实际失败的那一层：

- 固定版本启动器是否成功执行。下载失败或官方附件 404 属于制品/网络问题，还不能判定后台或 MCP 不健康。核对插件清单的固定版本与对应公开 Release；main 的版本可能尚未发行。按 [插件更新](plugin-updates.md) 使用已公开的匹配版本，不更改清单、不静默下载其他版本绕过校验。
- `server status` 是否确认已登记实例的 HTTP 健康、身份和兼容版本。它的 `mcp: true` 只声明服务能力，不验证宿主的 MCP 初始化握手。
- 当前宿主是否能实际调用只读 `list_reviews`。优先使用已知 `context`；成功返回才证明当前 MCP 连接与工具调用可用。工具列表中显示名字、配置写入成功或有 `mcpUrl` 均不足以证明这一点。

本机网络或进程探测自身返回 `Operation not permitted` / 权限不足时，先按宿主允许的权限路径复核；探测受限不能直接当作后台退出，也不能据此启动第二个写入者。

状态恢复分支：

- `running: true` 且 `compatible: true`：复用原后台，检查宿主 MCP 地址与返回的 `mcpUrl` 一致，再做只读调用。
- 没有登记后台，或后台不可达且 `processRunning: false`：安全启动时用 `server start`，沿用已有 home、dataDir、端口和会话。新评审的网页访问范围先按主技能确认。
- `processRunning: true` 但不健康、身份不匹配或端口占用：保留现场并报告诊断，不凭一次超时杀进程、删登记或启动第二个写入者。
- `compatible: false`：核对实际版本与数据备份，按已有安装/更新授权处理；不能把版本冲突当作握手故障或擅自替换正在使用的后台。

## Codex 注册与有界恢复

首次确需注册且后台兼容时执行：

```sh
"$LM_CLI" server setup
```

它启动或复用后台，通过短暂的 `codex app-server` 配置进程，仅更新当前 `CODEX_HOME` 的 `mcp_servers.logic_margin.url` 和 `tool_timeout_sec`；默认 86400 秒，保留更长值及无关配置。同名服务指向别处、已禁用或配置不兼容时报告冲突，不覆盖。

核对 `mcpUrl`、`mcp.serverName` 和 `mcp.toolTimeoutSec`。`reloadRequired: true` 时，用宿主提供的重载/重连动作尝试一次，再实际调用 `list_reviews`。宿主没有该能力或仍握手失败时，说明 HTTP 与 MCP 各自状态；后台健康兼容就按下节走原生 CLI，不因工具装载问题丢弃评审或反复要求用户重开会话。来源校验、参数错误和轮次冲突按业务错误处理，不当作连接故障。

MCP 正常时使用其评审工具。`wait_review` 在工具内长轮询和 SSE 保活，不调用模型；86400 秒仍受宿主、网络与进程限制。正常等待人工提交不属于故障。

## MCP 不可用时的 CLI 回退

在已授权的评审任务内使用原生 CLI，沿用同一 home、dataDir、端口、session ID 和最后实际处理的 submission 游标。文件参数相对终端工作目录解析；传入绝对路径可避免切换目录造成来源误认。显式 `--url` / `LOGIC_MARGIN_URL` 只连接指定 API，不另建本机后台。

写请求已发出但响应丢失时，先用 `list --context ... --state all` 和 `get SESSION_ID` 核对原 session、来源、轮次及固定发布记录，确认未生效后才重试 `start`、`revise` 或 `reply`；不能因同 context 就假定是同一评审。初始化握手尚未完成且工具写请求未发出时，可直接选择等价 CLI 命令。

等待前检查 `"$LM_CLI" --help` 支持 `--no-consume`。旧 CLI 仍可用 `list`、`get`、`verify` 做只读诊断与恢复读取；不支持该标志时说明安全等待的版本限制，不能去掉标志退回会自动领取的等待。以下是常见流程，固定 B 参数仍按 [评审格式](review-format.md#固定基线-b) 传入：

```sh
"$LM_CLI" start review.logic-margin.json --source-root /path/to/workspace --purpose "实际目的"
"$LM_CLI" get SESSION_ID
"$LM_CLI" wait SESSION_ID --no-consume
"$LM_CLI" wait SESSION_ID --after SUBMISSION_ID --no-consume
"$LM_CLI" ack SESSION_ID SUBMISSION_ID
"$LM_CLI" reply SESSION_ID COMMENT_ID --body "临时回应"
"$LM_CLI" revise SESSION_ID updated.logic-margin.json --source-root /path/to/workspace --base-round ROUND --summary "本轮实际变化" --replies-file replies.json
"$LM_CLI" cleanup SESSION_ID --mode archive
```

创建先取得 session ID 与链接并交给用户，再执行等待；既有会话从 `get` 恢复。`wait --no-consume` 仅交付固定结果：反馈返回 `requiresAcknowledgement`，通过且有归档策略时返回 `cleanupPending`。实际读完反馈后显式 `ack`；核对当前通过快照且已有清理授权后显式 `cleanup`。它不会自动领取或归档，取消/超时也不会。

不带 `--no-consume` 的 CLI 等待保留旧自动领取和授权策略下归档的兼容行为；本技能回退使用只读等待。该标志也可用于 `start/revise/resume --wait`，不能用于不等待的命令。

CLI 长等待能否持续挂起并在完成时自动唤醒取决于宿主终端工具。支持时保留这一进程等待；只返回运行句柄而没有自动唤醒时，如实说明限制并保留会话/句柄，不承诺与 MCP 相同的无模型等待，不反复调用 `get` 或新开等待进程模拟它。MCP 恢复后先用 `get_review` 核对原会话及未处理历史，再从已核实游标继续；取消、断线和超时都不等于人工通过。

## 网页监听、数据与版本

默认回环监听 `127.0.0.1`。新建或首次打开评审前，按主技能检查执行主机、访问设备、活跃网卡/默认路由和可核实的隧道状态，基于实际设备和地址询问访问范围，等待尚未给出的选择。不要从固定网络选项、接口名字或某一地址段猜定访问方式。

沿用已核实的端口与数据目录。需要跨设备分享时，先说明实际监听范围再配置；例如 `0.0.0.0` 会监听所有 IPv4 接口，不是只绑定分享链接所选网卡。`public_url` 只生成链接，不改变监听或防火墙；本机能打开也不能证明用户设备可达。MCP 仍只接受本机连接，源码核验与 MCP 必须同机。

调整已运行实例的监听前，核对状态并按已授权范围停止经身份验证的受管实例，再按确认地址启动。`LOGIC_MARGIN_HOME` 隔离登记，`LOGIC_MARGIN_DATA_DIR` 指定评审目录；默认数据独立于插件缓存。升级按 [插件更新](plugin-updates.md#更新后使用) 保留原数据、端口和 session，不删会话/锁/登记文件绕过单写入者检查。
