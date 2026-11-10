# DeepSeek Harness 连接、恢复与 CLI 回退

此包由 DSH 加载器启动固定版本 Go CLI `server start`，连接官方 MCP Client 并注册随包技能。工具名为 `mcp__logic_margin__start_review`、`mcp__logic_margin__wait_review` 等。DSH 使用自己的插件重载，不运行 Codex 专用 `server setup`，不修改 Codex 配置。

`LM_CLI` 是本技能 `scripts/logic-margin.sh`（Windows 为 `logic-margin.ps1`）的实际绝对路径；同目录有原生程序时优先使用。首次运行会下载并校验固定版本官方包。CLI、MCP 与待核验源码须在同机；远程 provider 的文件不因本机连接就可读取。

## 独立检查服务与当前 MCP 链路

用宿主终端执行 `"$LM_CLI" server status`（PowerShell 为 `& $LM_CLI server status`），核对服务身份、版本、home、dataDir 和原端口。再实际调用只读 `mcp__logic_margin__list_reviews`，优先传已知 `context`，成功返回才确认当前 DSH MCP 连接可用。插件已加载、工具名已列出或状态有 `mcp: true`，都不能代替初始化与实际调用。

本机网络/进程探测若被沙箱权限拒绝，先按宿主许可路径复核，不把 `Operation not permitted` 当作服务退出，也不据此启动第二个写入者。

区分故障层次：

- launcher 下载失败、固定版 Release/附件 404：先核对包版本与公开制品。main 可能先于对应发行，不静默改清单或下载其他版本绕过校验；按 [DSH 安装更新](plugin-updates.md) 使用已公开的匹配包。这不是 HTTP 或 MCP 已不健康的证据。
- 服务未运行且原进程已退出：安全时用 `server start`，保留原登记、端口和数据。进程仍活但不健康、身份/版本冲突时保留现场，按已授权范围诊断恢复，不盲杀、删锁或启动第二个写入者。
- HTTP 健康兼容而握手/工具装载失败：重载此 DSH 插件尝试一次，再做只读调用；仍失败就在原任务授权内使用下节 CLI 回退，明确当前通道。来源、参数和轮次错误按业务错误处理。

一次 `wait_review` 预算为 86400000 毫秒，在工具内等待，不调用模型、不领取或归档；宿主、网络、进程仍可结束等待。正常等人工提交不是故障。重连后用 `get_review` 核对原 session 和固定历史，从最后实际处理的 submission ID 继续；连接重试不保证续接旧的在途调用。

## 安全 CLI 回退

沿用实际 `LOGIC_MARGIN_HOME`、`LOGIC_MARGIN_DATA_DIR`、端口、session ID 与已处理游标。等待前检查 `"$LM_CLI" --help` 是否支持 `--no-consume`；旧 CLI 仍可用 `list`、`get`、`verify` 只读诊断和恢复读取，不支持该标志时说明安全等待的版本限制，不能去掉标志使用会自动领取的等待。

```sh
"$LM_CLI" get SESSION_ID
"$LM_CLI" wait SESSION_ID --no-consume
"$LM_CLI" wait SESSION_ID --after SUBMISSION_ID --no-consume
"$LM_CLI" ack SESSION_ID SUBMISSION_ID
"$LM_CLI" cleanup SESSION_ID --mode archive
```

需要新建时，先用 `start` 取得 session ID/链接并交给用户，再等待；核验、基线、修订和回复的文件参数仍按共享评审格式传入。写请求发出而响应丢失时，先 `list --context ... --state all` / `get` 核对原轮次及发布记录，确认未生效后再重试，避免重复创建或发布。

`wait --no-consume` 与 MCP 一样只交付固定结果：反馈带 `requiresAcknowledgement`，通过且有清理策略时带 `cleanupPending`。实际读完反馈后显式 `ack`；核对通过快照且已获清理授权后显式 `cleanup`。取消或超时不会消费。默认 CLI 等待的旧自动领取/归档语义仍保留，本技能回退不使用它。

CLI 长等待能否持续挂起并自动唤醒由 DSH 终端能力决定。支持时保留同一进程；没有自动唤醒时报告限制、保留会话和句柄，不反复 `get` 或启动新等待模拟 MCP，也不把中断当通过。

## 网页访问与共享服务

新建或首次打开评审前，按共享技能先检查实际执行主机、访问设备和可用网络，未明确范围就询问并等待。恢复同一会话或发布新版沿用仍适用的已核实选择。分享链接和监听必须匹配；`0.0.0.0` 监听所有 IPv4 接口，`public_url` 不会改绑定或防火墙，本机打开不证明跨设备可达。跨设备只分享网页，MCP 仍限本机。

仅卸载 DSH 插件撤销其工具和技能，不停止可能供其他宿主共用的后台。版本调整按授权和备份流程保留同一数据目录、端口与 session，不修改真实 Codex 安装。
