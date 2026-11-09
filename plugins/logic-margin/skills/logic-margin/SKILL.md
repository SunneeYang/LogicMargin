---
name: logic-margin
description: 用 LogicMargin 将业务逻辑整理为可批注流程图，发起人工评审，并在收到意见后修改、回复和发布新版；用于逻辑图评审、恢复会话或安装更新 LogicMargin 插件。
---

# LogicMargin 逻辑评审

在当前开发工程工作。LogicMargin 的一个后台进程同时提供 HTTP MCP、评审 API 和网页；源码修改、测试和 Git 操作仍由原 Agent 在授权工作区完成。

用户要求安装、检查或更新插件时，读取 [插件安装与更新](references/plugin-updates.md)，核对实际安装结果后报告。首次连接、工具缺失或连接故障时，读取 [连接、恢复与 CLI 兼容](references/mcp-workflow.md)。

## 建立连接

将本技能目录下 `scripts/` 中实际入口的绝对路径记为 `LM_CLI`：平台 ZIP 直接使用 `logic-margin`（Windows 为 `logic-margin.exe`）；Git marketplace 使用 `logic-margin.sh`（macOS/Linux）或 `logic-margin.ps1`（Windows）。启动器首次从官方 GitHub Release 下载与插件固定版本一致的本平台原生 ZIP，校验 SHA-256 后运行。0.9.2 默认运行 Go 程序，用户无需安装 Node.js 或 Go。PowerShell 将下文 `"$LM_CLI"` 换成 `& $LM_CLI`，带空格的路径同样适用。

```sh
"$LM_CLI" server start
```

核对返回的 `mcpUrl`，复用已运行的兼容后台。正常评审使用 `logic_margin` MCP 工具；首次尚未注册时执行 `server setup`，它只更新当前 Codex home 下的 LogicMargin MCP 地址和工具超时。返回 `reloadRequired: true` 后，在原宿主重载或重连 MCP，并核实工具已可用。仅启动后台或写入配置，不代表当前会话已加载工具；未加载时先报告连接状态，不以反复 CLI 等待冒充 MCP 等待。

MCP 只接受本机连接。用户要求 Tailscale/局域网网页访问时，按已授权范围设置 HTTP 监听和 `public_url`；这不开放远程 MCP。需要调整监听、处理旧版本或连接失败时按连接参考执行。

## 发起审查

用户给出 session ID 或带 `?session=...` 的链接并要求继续时，转到“恢复会话”。每个独立目的分别调用 `start_review`，取得独立 session ID；同一目的的多轮修改沿原 session 发布新版。`context` 填已知的实际 thread/workflow 标识，没有时省略；相同 context 或评审文件 ID 不代表复用会话。

读取目标源码和工作区状态，明确本次覆盖范围与尚未验证部分。生成 JSON 前读取 [评审格式](references/review-format.md)，按实际来源整理场景、规则、输入输出和源码依据，沿用仍代表同一业务对象的稳定节点/连线 ID。

已有代码改动待审时，先根据明确的 Git 基线在独立旧树中读取修改前源码，生成固定基线 B，再根据当前代码生成 R1。先讨论原系统改造时，从当前真实原版 B 发起评审，收到意见后再修改源码并发布 R1。两条流程都沿用同一评审 ID 和仍代表同一对象的节点/连线 ID，材料与核验要求见 [固定基线 B](references/review-format.md#固定基线-b)。

调用 `start_review`，参数使用本机绝对路径：

```json
{
  "review_file": "/path/to/review.logic-margin.json",
  "source_root": "/path/to/source-workspace",
  "baseline_file": "/path/to/before.logic-margin.json",
  "baseline_source_root": "/path/to/baseline-workspace",
  "purpose": "本次实际核对的行为"
}
```

它在创建前核验真实来源，失败时修正流程和依据后重试。`context`、分享链接 `public_url` 可按实际需要传入；用户要求通过后归档时设 `cleanup_on_approval: true`。`verify_review` 可用于只核验来源，不创建任务。

基线已嵌入 `review_file` 的 `baseline` 字段时，传 `baseline_source_root` 核验旧树即可。B 在后续 R2、R3 中保持固定；`base_round` 继续填写实际处理的评审轮次。

代码对照仅使用固定 B/R 保存的源码片段；历史缺失时说明缺失，不补读当前工作区。结构重点和明确移动块的原位置局部对照是阅读辅助，移动时又修改的内容也需核对；不支持、配对不确定或预算耗尽时保留文本差异，不据此判断通用语义等价。

从原系统 B 开始收集改造意见时，`review_file` 提供原版图，`source_root` 指向其真实源码，设置 `baseline_review: true`，省略独立的基线文件与目录。工具核验原版一次并固定为 B，页面先显示 B，第一次实现发布后显示 R1。

创建成功后立即把完整审查链接给用户，再调用 `wait_review`，传入 `session_id`。工具内部持续等待，保存单条批注不会返回；只有人工明确提交、确认通过或出现终态错误才交回控制权。正常等待期间保持这一调用，不另行反复 `get_review` 检查。

## 处理反馈并发布新版

读取 `wait_review` 返回的固定提交。反馈及 `earlierSubmissions` 保留意见内容，需逐份核对；记录 session ID、实际审阅的 `round`、revision 和提交 ID。等待工具不领取、不归档，取消或断线后仍可重取原提交。

通过结果使用精简摘要与 `sessionId`、`submission.id` 索引，提供 `resolvedCommentCount`，不带批注、回复或源码文件清单。通过结果的 `submission.review.snapshot` 只保留 repository、commit、fingerprint、capturedAt 和 dirty；更早未领取反馈以 `earlierSubmissionIds` 列出。需要补查这些旧反馈或完整来源时，用 `get_review` 读取完整历史；该工具也能读取归档。

反馈结果 `approved: false`：先实际读取意见，再调用 `acknowledge_review`，传入 `session_id`，并将返回的 `submission.id` 作为 `submission_id`。领取只证明已取回意见，不代表修改完成。需要完整图或历史时用 `get_review`；临时回复用 `reply_review`，沿用原 comment ID。

逐条核对意见，在授权工作区修改并验证。更新评审文件的 `revision`、来源快照、指纹和依据；最终回应写入 `[{"commentId":"原批注 ID","body":"实际修改、验证与剩余限制"}]` 的 JSON 文件。

从 B 收到的改造意见带 `basis: "baseline"`。按意见实际修改源码、验证后，再生成实现图并用 `revise_review` 发布；`base_round` 始终取工具返回的实际 `round`，B/R1/R2 是页面版本名称。改造后的图与固定 B 一起保留，供人工核对实际实现。

调用 `revise_review`，使用本次实际处理的轮次：

```json
{
  "session_id": "SESSION_ID",
  "review_file": "/path/to/updated.logic-margin.json",
  "source_root": "/path/to/source-workspace",
  "base_round": 1,
  "summary": "本轮实际变化",
  "replies_file": "/path/to/replies.json"
}
```

流程逻辑未变时填写 `unchanged_reason`，说明原因与覆盖范围。来源摘要只核验文件版本，业务语义仍需据源码整理。出现版本或轮次冲突时读取最新状态并重新核对，不能只改轮次数字重发旧草稿。

新版图、最终回应与发布记录原子保存后开启下一轮。将审查链接给用户，继续 `wait_review`；需要明确游标时，`after_submission` 使用最后实际处理的固定提交 ID。临时回复不会替人确认解决；代理不能自行解决批注或批准评审。

结果 `approved: true` 表示人已确认返回的快照通过；核对 round、revision 和 fingerprint 属于当前待评审快照后，结束评审循环，旧轮批准不能代替新版批准。若已授权通过后清理，并且结果返回 `cleanupPending: true`，在实际读到结果后调用 `cleanup_review` 归档；归档失败时保留通过结果和服务端数据，再核对最新状态。是否提交、推送或部署仍按原任务授权。

## 恢复会话与清理

按用户提供的原 session ID 调用 `get_review`，核对目的、上下文、来源工程、固定提交、轮次和已做回复。需要查找时用 `list_reviews` 的实际 `context` 与 `state: "all"`，确认目标后继续，不另建任务跳过旧意见。已归档任务可读取；需要继续修改时用 `restore_review` 恢复同一 ID。

旧会话需要前后对比而缺少 B 时，先按真实任务起点生成并核验原版图，再调用 `attach_review_baseline`，传原 `session_id`、`baseline_file` 和修改前树的 `source_root`。补录沿用当前轮次和批注，版本冲突时重新读取原会话后核对。

上下文中断后，从固定历史恢复尚未处理的意见。完成处理后再发布新版；继续等待时用已核实的 `after_submission` 游标。超时、中断或连接失败都不等于通过；服务故障按连接参考检查和恢复原后台。

`cleanup_review` 默认只归档已通过评审，完整图、批注和历史可恢复。清理未完成任务须有用户明确要求，并设置 `force: true`；永久删除还须有明确删除授权并设置 `mode: "delete"`。一次操作针对一个已确认的 session ID，context 查询不触发批量清理。
