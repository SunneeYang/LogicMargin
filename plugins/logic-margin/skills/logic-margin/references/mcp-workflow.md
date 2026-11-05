# MCP 连接、恢复与 CLI 兼容

## 首次连接

在原 Agent 的执行环境运行包内 CLI：

```sh
node "$LM_CLI" server setup
```

该命令启动或复用唯一的 HTTP 后台，用短暂的 `codex app-server` 配置进程注册 `logic_margin`，结束后退出。`codex` 必须在 PATH 中可用。它通过 Codex 原生配置 API，仅更新当前 `CODEX_HOME` 用户配置中的 `mcp_servers.logic_margin.url` 与 `tool_timeout_sec`，默认 86400 秒，保留已设置的更长值。它保留无关配置；同名服务指向别处、已禁用或配置不兼容时，报告冲突而不覆盖。

核对输出的 `mcpUrl`、`mcp.serverName`、`mcp.toolTimeoutSec`。`reloadRequired: true` 要求原宿主重载或重连 MCP；核实 `start_review`、`wait_review` 等工具实际可调用后才继续。注册成功、后台健康和宿主工具加载是三个分别核实的结果。宿主暂不支持重载时，报告此限制，不宣称原会话已切换完成。

后续每次评审只需 `server start` 核验并复用后台；正常评审通过 MCP。HTTP MCP、评审 API 与静态网页共用同一进程和端口，CLI 及配置进程均不常驻。多个 Agent 共用后台，评审以 session ID 隔离。

MCP 调用可以保持挂起直到人提交；内部长轮询与 SSE 保活不调用模型。86400 秒是 Codex 此 MCP 服务的工具超时，仍受宿主或连接层的其他限制，不能承诺无限等待或强制崩溃后立即返回。

## 监听、数据与版本

默认后台监听 `127.0.0.1`，选择端口后记录下来；正常重启沿用原端口与数据目录。`LOGIC_MARGIN_HOME` 隔离服务和登记文件，`LOGIC_MARGIN_DATA_DIR` 指定评审目录；默认数据在 `~/.logic-margin/sessions`，独立于插件缓存。

用户要求局域网或 Tailscale 网页访问时，按授权范围启动，例如：

```sh
node "$LM_CLI" server start --host 0.0.0.0 --port 5173
```

已有实例监听不同地址时，先核对状态，再停止经身份验证的受管实例并按新地址启动。`public_url` 只生成分享链接，不改变监听。MCP 路由始终只接受本机连接；需要读源码的 MCP 与源码工作区位于同一机器。远端 Agent 的显式 CLI `--url` 兼容入口仍可连接评审 API，但不是远程 MCP。

升级后若返回版本不匹配，使用新版 CLI 检查 `server status`，经核验后 `server stop`，再 `server start`；沿用真实数据和原 session ID。数据目录、登记身份或端口不明确时先报告诊断，保留原文件和实例。

## MCP 失败后的恢复

MCP 客户端把连接错误或工具超时交回原 Agent。Agent 通过宿主的通用终端工具执行 CLI，这条通道不依赖 LogicMargin MCP：

```sh
node "$LM_CLI" server status
```

- `running: true` 且 `compatible: true`：后台健康，重连原 MCP，再读取原评审。
- 没有登记后台，或后台不可达且 `processRunning: false`：用 `server start` 拉起，已有登记时保留原端口、数据和会话。
- `processRunning: true` 但不健康、身份不匹配或端口被占用：保留现场，报告诊断；不能据一个超时直接杀进程或启动第二个写入者。
- `compatible: false`：核对版本，按前节关闭经身份验证的旧实例后启动新版。

服务正在正常等待人工提交不是故障；源码校验、轮次冲突或参数错误按工具返回修正，不当作后台退出。优雅停服会向未完成 MCP 调用返回明确错误；强制退出后的发现时机取决于客户端断线处理与超时。

恢复连接后用 `get_review` 核对原会话。`wait_review` 使用最后实际处理的提交作为 `after_submission`，领取过但未处理完的反馈仍应从历史补做。通过结果只带摘要与 session/submission 索引；更早反馈以 `earlierSubmissionIds` 列出，需要内容时仍用 `get_review`，无需寻找本地记录文件。调用取消或断线不会触发 MCP 的领取和归档。

## 显式使用旧 CLI 流程

旧 CLI 保留，用于脚本、远端 API 和明确选择兼容路径的宿主；正常 MCP 流程不依赖它持续等待。CLI 文件参数相对调用时的工作目录解析；MCP 的文件与 `source_root` 参数必须使用本机绝对路径。

```sh
node "$LM_CLI" start review.logic-margin.json --source-root /path/to/workspace --purpose "实际目的" --wait
node "$LM_CLI" start current.logic-margin.json --source-root /path/to/current --baseline-file before.logic-margin.json --baseline-source-root /path/to/before --purpose "核对本次修改" --wait
node "$LM_CLI" start before.logic-margin.json --source-root /path/to/original --baseline-review --purpose "先在原系统上讨论改造" --wait
node "$LM_CLI" baseline SESSION_ID before.logic-margin.json --source-root /path/to/before
node "$LM_CLI" wait SESSION_ID --after SUBMISSION_ID
node "$LM_CLI" ack SESSION_ID SUBMISSION_ID
node "$LM_CLI" reply SESSION_ID COMMENT_ID --body "临时回应"
```

CLI `wait` 保留原来的自动领取，以及已授权策略下输出通过结果后归档的行为；MCP `wait_review` 只交付结果，实际读到反馈后另调 `acknowledge_review`，通过后另调 `cleanup_review`。两者的交付语义不同，恢复时核对固定历史和实际处理游标。

固定基线 B 的生成与核验见 [评审格式](review-format.md#固定基线-b)。MCP 的 `start_review`、`verify_review` 接受可选 `baseline_file` 与 `baseline_source_root`；图中已嵌入 B 时仍须明确旧树根目录。先在原系统上提出改造时，`start_review` 使用原版 `review_file`、其 `source_root` 与 `baseline_review: true`，随后按意见修改实际源码并发布 R1。旧会话补录使用 `attach_review_baseline(session_id, baseline_file, source_root)`，其中 `source_root` 指向修改前源码。后续 `revise_review` 自动继承 B，`base_round` 始终填写 `get_review` 或 `wait_review` 返回的实际轮次。

CLI 在 stdout 输出 JSON，在 stderr 输出链接；原生包直接调用对应可执行文件。完整命令由 `--help` 查询。显式 `--url` / `LOGIC_MARGIN_URL` 只连接指定评审 API，不会替换成本机新会话。若兼容宿主让 CLI 等待命令频繁返回运行句柄，继续等待仍可能需要模型调用，应如实说明该限制。
