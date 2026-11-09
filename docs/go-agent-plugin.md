# LogicMargin Go 迁移包

这是 `arch/go-backend` 的独立发行候选。一个 Go 可执行文件包含 HTTP MCP、评审 API、会话管理、CLI 和现有 React 网页，用户运行时无需 Node、Bun、Go 或 npm。开发和构建前端仍需要 Node。主线 Git marketplace 与已发布的 0.8.7 包尚未切换，候选包不应使用主线升级命令覆盖。

选择与操作系统和架构匹配的 ZIP，校验旁边的 `.zip.sha256` 后解压到持久位置。macOS/Linux 直接运行 `plugins/logic-margin/skills/logic-margin/scripts/logic-margin`，Windows 用对应的 `logic-margin.exe`。本机实验建议显式设置独立 `LOGIC_MARGIN_HOME`，让迁移程序与现有 Node 服务使用不同的数据和登记文件。

```sh
export LOGIC_MARGIN_HOME="$PWD/go-review-home"
./plugins/logic-margin/skills/logic-margin/scripts/logic-margin server start
./plugins/logic-margin/skills/logic-margin/scripts/logic-margin --help
./plugins/logic-margin/skills/logic-margin/scripts/logic-margin server status
./plugins/logic-margin/skills/logic-margin/scripts/logic-margin server stop
```

在执行环境需要 Tailscale 网页访问时，首次启动可用 `server start --host 0.0.0.0 --port 5173`，实际端口以返回值为准。MCP 继续只接受本机连接。`--public-url` 只改变分享地址；不会打开监听。

正常审查通过包内技能和 HTTP MCP 完成。`server setup` 会按原有行为配置当前 Codex home 的 MCP 地址和超时；只在需要安装/注册候选版本时使用。返回 `reloadRequired` 后仍需宿主重连，启动服务和加载工具分别验证。`get`、`wait`、`ack`、`revise`、`cleanup` 等兼容 CLI 命令由 `--help` 查询。会话仍为兼容 JSON；备份/迁移使用实际数据目录，两个后端不能同时写同一目录。

当前候选保留既有行为，并接入代码 diff 与流程图的后端预计算；算法、回退与资源上限见 `docs/backend-precompute.md`。多人同时审查另行评估。Go 的并发能力不代表账号、权限或多人协作协议已经实现。具体迁移状态和验收范围见源代码中的 `docs/go-backend-migration.md`。
