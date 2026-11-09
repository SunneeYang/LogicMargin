# LogicMargin 代理评审流程

正常评审由原 Agent 通过 HTTP MCP 完成。一个 LogicMargin 后台进程同时提供 `/mcp`、评审 API 与网页；CLI 只在启动、诊断和恢复时短暂运行。源码修改、测试和 Git 操作仍在原 Agent 的授权工作区完成。

网页批注和“提交本轮”是两个动作。保存单条批注只更新会话；提交意见或确认通过才让等待工具返回。代理回复不会自动解决批注，最终复核由人完成。

## 连接服务

0.9.6 默认使用 Go 原生 CLI，用户无需安装 Node.js 或 Go。将平台 ZIP 内 `skills/logic-margin/scripts/logic-margin`（Windows 为 `logic-margin.exe`）的绝对路径记为 `LM_CLI`；Git marketplace 对应使用 `scripts/logic-margin.sh` / `scripts/logic-margin.ps1`，首次启动下载并校验与插件固定版本一致的本平台程序。PowerShell 用 `& $LM_CLI` 替换下面的 `"$LM_CLI"` 调用，例如 `& $LM_CLI server setup`。

首次使用执行：

```sh
"$LM_CLI" server setup
```

它启动或复用后台，并通过短暂的 Codex 配置进程，注册当前 `CODEX_HOME` 用户配置中的 `logic_margin` HTTP MCP 地址与 `tool_timeout_sec`。默认工具超时为 86400 秒，保留已设置的更长值；同名不同服务或禁用配置会报错而不覆盖。配置进程不运行模型，完成后退出。

核对返回的 `mcpUrl` 与 MCP 配置结果，然后在原宿主重载或重连 MCP。返回 `reloadRequired: true` 不是工具已经加载；确认工具可调用后才进入等待。后续只需 `server start` 检查并复用后台，正常评审使用下文 MCP 工具。配置、监听、更新和 CLI 兼容详见 [插件文档](agent-plugin.md)。

## 发起与等待

按真实源码或文档整理 `schemaVersion: 1` 的流程图，记录来源快照、覆盖范围和依据，规则见 [评审格式](../plugins/logic-margin/skills/logic-margin/references/review-format.md)。MCP 的文件和来源目录参数都使用服务机器上的绝对路径。

调用 `start_review`，例如：

```json
{
  "review_file": "/path/to/review.logic-margin.json",
  "source_root": "/path/to/source-workspace",
  "purpose": "订单失败分支实现复核",
  "context": "实际 thread/workflow 标识",
  "public_url": "http://100.124.38.121:5173"
}
```

`start_review` 创建前核验源码文件、片段摘要和快照指纹；`verify_review` 可独立核验，不创建任务。来源范围优先取 `snapshot.files`，未声明时取图内依据涉及的文件。校验不能代替按源码核对业务语义。 Go CLI 在同次核验中另行捕获原始完整源码，发布成功后仅向本机后台上传可选分析缓存；旧服务或上传失败不改变已成功的发布。全文绑定快照内文件 SHA 与已核验片段，只用于后端结构分析，不写入评审/历史 JSON，也不自动上传本地导入。

每个独立目的分别创建任务，即使来自同一对话或使用同一评审文件，也取得新的 session ID。`purpose` 必填，`context` 使用实际上下文标识，可省略。新建任务不继承文件里的旧批注；同一目的的连续修改沿原 session 调用 `revise_review`。

创建成功后立即把完整审查链接给用户，再调用 `wait_review`：

```json
{
  "session_id": "SESSION_ID"
}
```

工具内部保持等待和连接保活，不需要模型反复调用“再检查一下”。保存单条批注不返回；人工固定提交或确认通过后才返回结果。`timeout_seconds` 可限制本次等待，最终仍受 Codex 和宿主工具期限约束。

有新意见时，评审者通过顶栏提交给代理；没有新意见但仍有未解决批注时，顶栏先定位待处理或待复核线程。新版尚未发布时只能定位核对；新版发布且全部已保存意见解决后可完成人工批准。浏览器草稿保留，不作为整轮批准的阻塞条件。

## 读取、领取与发布新版

等待结果包含 `sessionId`、`round`、`approved` 和固定 `submission`。反馈的 `submission.review` 包含本次评审 ID、版本、源码快照和意见；反馈结果存在 `earlierSubmissions` 时逐份核对。

通过结果只返回摘要与 `sessionId`、`submission.id` 索引，使用 `resolvedCommentCount`，省略批注、回复和源码文件清单。其 `submission.review` 保留 id、title、revision，snapshot 仅含 repository、commit、fingerprint、capturedAt 和 dirty。更早未领取反馈在通过结果中只列 `earlierSubmissionIds`；需要补查内容时调用 `get_review`。完整历史仍在服务端保存，该工具也可读取归档。

MCP `wait_review` 只交付结果，不领取、不归档。实际读取反馈后调用 `acknowledge_review`：

```json
{
  "session_id": "SESSION_ID",
  "submission_id": "wait_review 返回的 submission.id"
}
```

领取记录只证明 Agent 已取回意见，不证明修改完成。这样断线或取消等待时，不会因提前领取而漏掉意见。需要完整图、轮次或历史时调用 `get_review`；`reply_review` 用原 comment ID 和 inline `body` 发送临时回应。

Agent 在原工作区处理意见，验证相应改动，再生成新版图，沿用相同评审 ID 和仍代表同一业务对象的稳定节点/连线 ID。更新 `revision`、源码清单、片段摘要和指纹。最终回应写入 JSON 数组：

```json
[
  { "commentId": "原批注 ID", "body": "实际修改、验证结果与剩余限制。\n保留必要换行。" }
]
```

调用 `revise_review`，`base_round` 使用本次实际审阅的轮次：

```json
{
  "session_id": "SESSION_ID",
  "review_file": "/path/to/updated.logic-margin.json",
  "source_root": "/path/to/source-workspace",
  "base_round": 1,
  "summary": "更新结算条件与流程说明",
  "replies_file": "/path/to/replies.json"
}
```

`base_round` 与 `summary` 必填；流程逻辑未变时另填 `unchanged_reason`，包括仅更新依据、格式或说明。来源或发布基线不符时拒绝发布；先读取最新状态重新核对，不能仅改轮次数字重发旧草稿。

新版图、最终回应与发布记录原子保存后才开启下一轮。失败保留上一份完整发布。临时回复使任务处于处理中，待新版发布后再由人确认解决或通过。发布成功后将链接交给用户，继续 `wait_review`。

网页支持修改前/当前对比、字段变化与来源依据更新。代码对照仅使用固定 B/R 已保存的源码片段，不补读当前工作区；统一/并排共用单一竖向滚动入口，可逐次展开上下文。文本差异始终可读，结构重点辅助核对支持语法中的改动，明确移动且修改的块可与原位置局部对照；失败、预算耗尽或不确定时保留文本回退。这不使用 SemanticDiff 引擎，也不证明通用语义等价，详见 [结构 diff](structural-diff.md)。历史图只读，目标移除后的批注仍可回到原轮次查看；最终解决与批准由评审者在当前图确认。

## 中断和恢复

服务端保存评审状态。优雅停服向未完成 MCP 请求返回明确错误；强制退出后的发现速度取决于客户端断线处理和超时。连接错误、超时或取消都不等于通过，也不应触发新建替代任务。

原 Agent 收到 MCP 错误后，通过宿主的通用终端工具检查：

```sh
"$LM_CLI" server status
```

后台健康且兼容时重连 MCP；没有登记或确认进程已退出时用 `server start` 拉起；进程仍在但不健康、身份不符、端口冲突时保留现场并诊断，避免另起写入实例。版本不匹配时，经身份核验 `server stop` 并确认旧进程退出后再启动新版，保留实际会话目录和原 session ID。升级停服、备份与重连步骤见 [升级与数据连续性](agent-plugin.md#升级与数据连续性)。CLI 不依赖失效的 MCP 服务，恢复保持原端口和会话目录。

重连后调用 `get_review`，核对目的、上下文、来源工程、固定提交和当前轮次。需要定位任务时用 `list_reviews` 的 `context` 与 `state: "all"`。领取过但尚未完成处理的意见从历史补做；继续等待可给 `wait_review` 传 `after_submission`，使用最后实际处理的固定提交 ID。

游标会排除指定提交及之前的记录。未知游标报错；期间多次提交时，反馈结果同时核对 `earlierSubmissions`；通过结果按需用 `earlierSubmissionIds` 补查。新版发布后默认等待跳过旧轮次。恢复不改变原 session ID，避免旧草稿覆盖新一轮。

托管服务默认数据目录为 `~/.logic-margin/sessions`；开发服务使用工程内 `.logic-margin/sessions`，自定义 `LOGIC_MARGIN_DATA_DIR` 时备份实际目录。MCP 仅接受本机连接，即使网页/API 按授权范围监听局域网或 Tailscale。浏览器草稿、待同步操作及独立文件模式数据仍留在对应浏览器和访问地址。远程 MCP、账号、权限及多人协作尚未实现。

## 查询、归档与删除

`list_reviews` 默认列出活动任务，也支持 `state: "archived"` 或 `"all"`。列表只返回概要；先核对目的与 session ID，再操作具体任务。

`cleanup_review` 默认归档已通过任务，保留完整图、批注与历史。`get_review` 可读取归档，继续修改前用 `restore_review` 恢复同一 ID。用户明确要求清理未完成任务时才传 `force: true`；永久删除还须明确授权，并传 `mode: "delete"`，无法从服务端恢复。一次操作只针对一个已确认 ID，不默认批量删除。

通过记录的 round、revision 和 fingerprint 应与当前待评审快照一致；旧轮批准不能代替新版批准。`start_review` 的 `cleanup_on_approval: true` 保存用户已授权的通过后归档策略。MCP 等待返回最终 `approved: true` 且 `cleanupPending: true` 后，Agent 实际读到结果再调用 `cleanup_review`；浏览器确认通过或通知送达本身不触发归档。归档期间有新修改时拒绝旧版本清理，保留数据；归档失败不改变已取得的批准结果。

评审轮次、批注和历史无固定业务条数上限，保留每条内容与单次请求的格式、长度、引用及资源校验。评审与最终回应 JSON 各保留单次 10 MB 文件边界，不是累计历史限制；已有批注由服务端合并保留，不必回写进新图文件。

## CLI 兼容入口

已有脚本和明确使用远端评审 API 的流程仍可使用 CLI。显式 `--url` / `LOGIC_MARGIN_URL` 只连接原地址；它不会把远端故障替换成本机新任务。文件参数相对调用时工作目录解析，完整命令见 `--help`。

```sh
"$LM_CLI" start review.logic-margin.json --source-root /path/to/workspace --purpose "实际目的" --wait
"$LM_CLI" wait SESSION_ID --after SUBMISSION_ID --timeout 1800
"$LM_CLI" ack SESSION_ID SUBMISSION_ID
"$LM_CLI" reply SESSION_ID COMMENT_ID --body "临时回应"
"$LM_CLI" cleanup SESSION_ID
"$LM_CLI" restore SESSION_ID
```

CLI `wait` 保留自动领取和已授权策略下输出最终通过结果后归档的行为；MCP `wait_review` 则分开交付、领取与归档。兼容宿主反复返回 CLI 运行句柄时，继续等待仍可能触发模型调用，应明确说明，不能称为已接通 MCP 长等待。
