# DeepSeek Harness 连接与恢复

此包由 DSH 插件加载器启动固定版本的 Go CLI `server start`，连接官方 MCP Client，并注册随包技能。工具名为 `mcp__logic_margin__start_review`、`mcp__logic_margin__wait_review` 等。不要运行 Codex 专用的 `server setup`，不要修改 Codex 配置，也不要用 CLI 循环等待替代 MCP。

`LM_CLI` 位于本技能目录 `scripts/logic-margin.sh`（Windows 为 `logic-margin.ps1`）；同目录有原生程序时优先使用。首次运行会下载并校验固定版本的官方平台包。CLI、MCP 和需要核验的源码必须在同一台本机；本适配不承诺远程执行 provider 的文件可由本机 MCP 读取。

用宿主终端按实际绝对路径执行 `LM_CLI server status` 检查服务；后台健康但工具缺失时，在 DSH 重载此插件。服务不存在时执行 `server start`，然后重载插件。所有操作沿用实际 `LOGIC_MARGIN_HOME`、`LOGIC_MARGIN_DATA_DIR`、端口和 session ID；不要猜进程、强杀、删锁或清空数据。版本不匹配时先核对旧实例与备份，再按用户授权停止旧版本、启动新版。

一次 `wait_review` 调用预算为 86400000 毫秒。它不调用模型、不领取意见、不归档；宿主、网络和进程仍可结束等待。取消或重启后，用 `get_review` 读取原 session，核对未处理历史，再从最后实际处理的 submission ID 继续等候。不要用超时或取消代替人工通过。连接重试不保证续接旧的在途调用。

仅卸载 DSH 插件会撤销它拥有的工具和技能，不停止可能被其他宿主使用的共享后台。Tailscale/局域网仅用于分享网页；MCP 仍限本机。需要分享时按已授权的监听地址设置 `public_url`，不要开放远程 MCP。
