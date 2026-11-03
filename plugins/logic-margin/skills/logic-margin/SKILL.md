---
name: logic-margin
description: 用 LogicMargin 将业务逻辑整理为可批注流程图，发起人工评审，并在收到意见后修改、回复和发布新版；用于请求逻辑图评审或继续已有 LogicMargin 会话。
---

# LogicMargin 逻辑评审

在当前开发工程工作，用 LogicMargin 承载人工评审。插件带上网页、API 和 CLI；源码修改仍在用户授权的工作区完成。

## 入口与连接

默认包将本技能目录下 `scripts/logic-margin.mjs` 的绝对路径记为 `LM_CLI`，用 Node.js 22.18+ 运行。原生包只有 `scripts/logic-margin`（Windows 为 `.exe`），直接执行；下方示例中的 `node "$LM_CLI"` 换成该程序的调用方式，PowerShell 使用 `&` 调用带空格的程序路径。原生包无需 Node。命令保持当前开发工程的工作目录，文件参数均相对此目录。

```sh
node "$LM_CLI" --help
```

没有指定 API 地址时，命令自动检查并复用已运行的兼容服务，或启动包内服务，等待就绪后继续。显式 `--url` 或 `LOGIC_MARGIN_URL` 时只连接该地址，失败会报错，保留原会话。分享链接依次取 `--public-url`、`LOGIC_MARGIN_PUBLIC_URL`、实际服务地址。

本机默认只监听回环地址。用户要求 Tailscale/局域网访问时，需要服务监听可达接口；`--public-url` 只改变分享链接。可在该机器执行：

```sh
node "$LM_CLI" server start --host 0.0.0.0 --port 5173
```

然后通过 `--public-url` 指定已知 Tailscale 地址；远端 agent 使用 `--url` 连接它。如果已有服务监听其他地址，先核对 `server status`，再按用户已授权的网络范围调整，不能只改分享地址就声称可达。

服务默认将会话保存在 `~/.logic-margin/sessions`，不依赖插件缓存或开发工程目录。`LOGIC_MARGIN_HOME` 可隔离服务与数据，`LOGIC_MARGIN_DATA_DIR` 可显式指定会话目录。插件更新后版本不匹配时，用 `server stop` 停止其管理的旧服务，再重试；命令会保留批注。`server status` 查看状态，`server stop` 只关闭核验过身份的本机托管实例。

## 发起审查

用户已给出 session ID 或带 `?session=...` 的链接并要求继续时，转到“恢复会话”。每次独立评审用 `--purpose` 明确本次目的；同一 agent 上下文中的需求确认、实现复核或另一项功能分别 `start`，取得独立 session ID。`--context` 填已知 thread/workflow 标识，用于查询归属；没有实际标识时省略。同一 `ReviewDocument.id` 或 context 不代表复用会话。

新评审先读取目标源码和当前工作区状态，确定本次目的、覆盖范围与尚未验证的部分。根据已有任务确定目的即可，范围清楚时直接执行。新会话从空批注开始，旧意见留在原 session；同一目的的连续修改使用原 session 的 `revise`。

生成 JSON 时读取 [评审格式](references/review-format.md)。根据实际代码整理场景、步骤、判断、失败出口和状态变化，保留源码位置与摘要；已有评审应沿用稳定对象 ID。用户提供的评审包先核对来源与版本，样例不能代替当前工程的真实逻辑。

准备好文件后，用真实来源工作区核验，再发起并等待：

```sh
node "$LM_CLI" verify path/to/review.logic-margin.json --source-root /path/to/source-workspace
node "$LM_CLI" start path/to/review.logic-margin.json --purpose "本次实际核对的行为" --wait
```

`verify` 只读取来源并核对文件、片段摘要与快照指纹，不改写评审文件。失败时重新核对业务逻辑及依据，修正后再发起。

已知上下文时为 `start` 加 `--context "实际 thread/workflow 标识"`。用户要求通过后自动清理时，加 `--cleanup-on-approval`：代理取得最终通过结果后归档，可恢复；仅在网页确认通过时尚不清理。

命令在 stderr 输出审查地址，立即把完整链接给用户。随后持续等待这个命令完成；单条批注保存不代表人已完成本轮。工具返回运行句柄时，通过该工具的继续等待接口接收最终结果。

## 处理反馈并进入下一轮

等待命令成功结束后读取 stdout JSON。`submission` 是本次固定记录；存在 `earlierSubmissions` 时逐份核对它们的源码快照和意见，避免遗漏多次提交。保留 session ID、已处理的 submission ID、实际审阅的 `round` 和 revision，供发布与中断恢复。`--base-round` 使用这次实际处理的轮次。

`approved: true` 表示人确认该快照通过，结束评审循环；是否提交、推送或部署仍按原任务授权。

收到意见时，用原 comment ID 对应逻辑目标，必要时读取完整图和历史：

```sh
node "$LM_CLI" get SESSION_ID
node "$LM_CLI" comments SESSION_ID
```

在授权工作区逐条处理并运行与改动相称的验证。重新核对修改后的源码或文档，更新流程、`revision`、指纹与源码依据，保持同一评审 ID 及仍代表同一业务对象的节点/连线 ID。最终回应说明实际改动、验证和剩余限制，写入 `[{"commentId":"原批注 ID","body":"回应正文"}]` 的 JSON 文件，随新版图发布。

以下以实际处理 R1 为例，数字替换为从 `wait` 或 `get` 核实的轮次：

```sh
node "$LM_CLI" revise SESSION_ID path/to/updated.logic-margin.json \
  --base-round 1 --summary "本轮实际变化" \
  --source-root /path/to/source-workspace --replies-file path/to/replies.json --wait
```

`revise` 必填 `--base-round` 与 `--summary`，自动核验真实来源；`--source-root` 默认当前工作目录。流程逻辑未变时，加 `--unchanged-reason "原因与覆盖范围"`，包括只改依据、格式或补充说明的情况。来源摘要核验只能证明给定文件版本对应，业务语义仍需按实际源码整理。版本或基线冲突时读取并处理最新内容，不能只修改轮次数字来重发旧草稿。

新版图、最终回应和发布记录原子保存，成功后开启下一轮；校验失败时保留上一份完整发布。临时交流可用 `reply SESSION_ID COMMENT_ID --body-file path/to/reply.txt`，此时仍是处理中，发布新版前禁止确认解决和整轮通过。

服务端保留原意见、回复及提出轮次。页面支持“修改前 / 当前”和字段变化清单；历史图只读，已移除或部分移除目标可从讨论回到提出时轮次查看原位置。由评审者返回当前图确认解决，代理不能自行解决意见。将返回的审查链接给用户，再等待明确提交并重复本节。

## 恢复会话

按用户给出的明确 session ID 读取状态，核对 `scope` 的目的和上下文、所属工程、源码快照、历史提交及代理回复：

```sh
node "$LM_CLI" get SESSION_ID
```

需要查找当前上下文的评审时，用 `list --context "实际上下文标识" --state all` 核对 ID、目的与归档状态，再选用户要继续的那一个。`get` 可读取归档内容；继续修改前执行 `restore SESSION_ID` 恢复。

“代理已领取”只证明意见已被取回，不证明修改已完成。若上下文中断，先从历史恢复尚未处理的意见；完成它们后再发布新版。需要继续等待本轮尚未领取的提交时：

```sh
node "$LM_CLI" resume SESSION_ID --wait
```

需要从某份已处理提交之后接续时，使用已核实的游标：

```sh
node "$LM_CLI" wait SESSION_ID --after SUBMISSION_ID
```

超时、中断或连接失败都不等于评审通过。保留 session ID，恢复同一会话；从 `get` 的快照和历史核对旧草稿所属轮次，再决定基于哪一轮重新修改和发布，避免另建会话丢开旧意见。

## 清理评审

按用户指定的会话执行，完成后报告返回结果。默认清理是可恢复的归档：

```sh
node "$LM_CLI" cleanup SESSION_ID
node "$LM_CLI" restore SESSION_ID
```

默认仅清理已通过评审。用户明确要求清理尚未完成的会话时，加 `--force`；这表示结束当前存放状态，不代表审查通过。永久删除只在用户要求永久删除时用 `cleanup SESSION_ID --mode delete`，未完成会话仍需 `--force`。一次操作仅针对指定 ID；context 查询用于选择，不触发批量删除。

`--cleanup-on-approval` 可在 `start` 持久化，或在本次 `wait` / `resume --wait` 启用。等待先输出完整通过结果，再按已读版本归档；期间有新修改则清理失败并保留数据。此时先处理已取得的通过结果，再核对清理错误，不能把归档失败说成审批失败。手动命令已有明确授权时直接执行，无需再加确认步骤。
