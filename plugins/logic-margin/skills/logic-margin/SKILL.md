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

用户已给出 session ID 或带 `?session=...` 的链接时，转到“恢复会话”。新评审先读取目标源码和当前工作区状态，明确本次要核对的行为、覆盖范围与尚未验证的部分。

生成 JSON 时读取 [评审格式](references/review-format.md)。根据实际代码整理场景、步骤、判断、失败出口和状态变化，保留源码位置与摘要；已有评审应沿用稳定对象 ID。用户提供的评审包先核对来源与版本，样例不能代替当前工程的真实逻辑。

准备好文件后发起并等待：

```sh
node "$LM_CLI" start path/to/review.logic-margin.json --wait
```

命令在 stderr 输出审查地址，立即把完整链接给用户。随后持续等待这个命令完成；单条批注保存不代表人已完成本轮。工具返回运行句柄时，通过该工具的继续等待接口接收最终结果。

## 处理反馈并进入下一轮

等待命令成功结束后读取 stdout JSON。`submission` 是本次固定记录；存在 `earlierSubmissions` 时逐份核对它们的源码快照和意见，避免遗漏多次提交。保留 session ID、已处理的 submission ID 和当前 revision，供中断恢复。

`approved: true` 表示人确认该快照通过，结束评审循环；是否提交、推送或部署仍按原任务授权。

收到意见时，用原 comment ID 对应逻辑目标，必要时读取完整图和历史：

```sh
node "$LM_CLI" get SESSION_ID
node "$LM_CLI" comments SESSION_ID
```

在授权工作区逐条处理并运行与改动相称的验证。有异议或受阻时也在原线程说明依据。将回复写入文本文件，保留实际换行，然后发布：

```sh
node "$LM_CLI" reply SESSION_ID COMMENT_ID --body-file path/to/reply.txt
```

回复说明实际改动、验证和剩余限制。由评审者确认解决；代理回复本身只要求人工复核。

重新核对修改后的源码，更新流程、`revision`、指纹与源码依据，保持同一评审 ID 及仍代表同一业务对象的节点/连线 ID。发布并等待下一轮：

```sh
node "$LM_CLI" revise SESSION_ID path/to/updated.logic-margin.json --wait
```

服务端会保留原意见、回复和历史；目标消失也保留旧批注供人核对。将返回的审查链接给用户，再等待明确提交并重复本节。

## 恢复会话

按用户给出的明确 session ID 读取状态，核对评审所属工程、源码快照、历史提交和代理回复：

```sh
node "$LM_CLI" get SESSION_ID
```

“代理已领取”只证明意见已被取回，不证明修改已完成。若上下文中断，先从历史恢复尚未处理的意见；完成它们后再发布新版。需要继续等待本轮尚未领取的提交时：

```sh
node "$LM_CLI" resume SESSION_ID --wait
```

需要从某份已处理提交之后接续时，使用已核实的游标：

```sh
node "$LM_CLI" wait SESSION_ID --after SUBMISSION_ID
```

超时、中断或连接失败都不等于评审通过。保留 session ID，恢复同一会话；版本冲突时重新读取并核对新增内容，再决定回复或发布，避免另建会话丢开旧意见。
