# LogicMargin 代理评审流程

网页批注和“提交本轮”是两个动作。保存批注只更新会话；提交意见或确认通过才让等待中的代理继续。代理回复不会自动把批注标成解决，由评审者在新版上复核。

## 启动服务与发起审查

完整插件会在首次发起时自动启动服务；没有显式 API 地址时默认复用已登记服务，或兼容的本机开发服务。`--url` / `LOGIC_MARGIN_URL` 指向远端时只连接那个地址，失败不另建本机会话。安装与服务管理见 [agent 插件](agent-plugin.md)。以下为从 LogicMargin 源工程运行开发服务的方式：

```sh
npm run dev -- --port 5173 --strictPort
```

代理准备符合 `schemaVersion: 1` 的流程图 JSON，明确源码快照、覆盖范围和依据。发起前可在真实来源工作区校验文件与片段摘要：

```sh
npm run review -- verify /path/to/review.logic-margin.json --source-root /path/to/source-workspace
```

`verify` 只读取并核验，不修改评审文件或创建会话。来源范围优先取 `snapshot.files`；未声明时取图内依据涉及的文件。建议显式列出覆盖的源码和文档，摘要规则见插件内的 [评审格式](../plugins/logic-margin/skills/logic-margin/references/review-format.md)。校验通过后，使用真实需求包发起会话并等待：

```sh
npm run review -- start public/reviews/spirit-sanctum.logic-margin.json \
  --context "实际 thread/workflow 标识" --purpose "魔灵秘境服务端实现复核" \
  --wait --public-url http://100.124.38.121:5173
```

命令在 stderr 打印带 `?session=...` 的审查链接；stdout 只在本轮提交后输出一份 JSON。Tailscale 地址只影响分享链接，代理默认连接本机 `http://127.0.0.1:5173`。跨机运行 CLI 时用 `--url http://100.124.38.121:5173` 指定 API 地址。

每个独立目的使用一次 `start`，即使来自同一个 agent context、复用同一个评审文件，也生成新的 session ID。`--context` 是用于查询归属的实际 thread/workflow 标识，可省略；`--purpose` 说明这次核对什么。两者组成会话 `scope`，会出现在 `get` 及等待结果中。显式指定任一项时新会话清空输入包的旧批注，原 session 保留；仅指定 context 时，purpose 默认取文件说明或标题。插件技能要求明确传入 purpose。同一目的的多轮修改使用原 ID 的 `revise`。

评审者打开链接，在节点、关系或整图上批注，保存后点击“提交本轮”。没有未解决意见时可确认通过。CLI 仅在收到固定快照的提交记录后返回，并将意见标为代理已领取；页面上的普通保存不会唤醒代理处理。

## 处理意见与发布新版

返回结果包含 `sessionId`、`round`、`approved` 和 `submission`。`submission.review` 包含评审 ID、版本、源码快照和本次意见，避免每轮输出整张图。记录这次实际审阅的 `round`，作为新版的 `--base-round`；恢复时先用 `get` 核对轮次、固定意见包和当前图，避免用旧草稿覆盖别人已发布的轮次。完整会话及历史可通过 `get` 读取：

```sh
npm run review -- comments <sessionId>
npm run review -- get <sessionId>
```

新版网页日常仅同步当前图、批注线程及历史目录，查看旧快照或下载固定意见包时按需读取。现有 CLI 完整会话接口、上述命令和完整备份保持不变；会话响应与独立包静态资源自动协商 gzip，无需额外参数。

代理核对每条意见及目标，在原开发工作区修改源码，并重新生成流程图 JSON。相同业务节点沿用稳定 ID；更新 `revision`、快照和依据。LogicMargin API 不执行 shell，也不替代理写入源码。

最终回应写入 JSON 数组，随新版图一次发布；每项使用原批注 ID：

```json
[
  { "commentId": "原批注 ID", "body": "实际修改、验证结果和剩余限制。\n保留必要的换行。" }
]
```

以下以实际处理 R1 为例；`--base-round` 必须换成从 `wait` 或 `get` 核实的那一轮：

```sh
npm run review -- revise <sessionId> /path/to/updated.logic-margin.json \
  --base-round 1 --summary "更新结算条件与流程说明" \
  --source-root /path/to/source-workspace --replies-file /path/to/replies.json \
  --wait --public-url http://100.124.38.121:5173
```

`revise` 必填 `--base-round` 和 `--summary`，会重新核验实际来源，`--source-root` 默认当前工作目录。旧文件摘要、片段摘要、指纹或发布基线不符时拒绝发布；轮次已更新时重新读取并处理新图，不能仅把数字改成当前轮次来交回旧草稿。流程逻辑未变时另加 `--unchanged-reason "原因与覆盖范围"`，包括仅更新依据、格式或补充说明的轮次。摘要核验不能代替代理根据源码更新业务语义。

新版须沿用原评审 ID。服务端将图、最终回应和发布记录原子保存后才开启下一轮；失败不会留下新回复配旧图的半轮结果。原意见、回复与提出轮次保留，相关意见进入待复核。`reply <sessionId> <commentId> --body-file /path/to/reply.txt` 仍可用于处理中交流，但页面明确显示“新版尚未发布”，并禁止确认解决和整轮通过，直到 `revise` 成功。

评审者可在同一画布切换“修改前 / 当前”，用“本轮变化”核对节点、连线及字段前后值；源码依据更新单独展示，纯排版不算逻辑变化。历史图只读，原目标移除或部分移除的批注仍在列表中，可回到提出时轮次查看原位置，即使它早于本轮修改前快照。返回当前图后再确认解决。

评审者查看新版及回复，将意见确认解决，或重新打开并补充意见，然后再次提交。`approved: true` 表示人工确认通过，代理此时结束评审循环；后续提交、推送或部署仍按原任务授权执行。

## 中断和恢复

会话由本机服务端保存，使用相同 session 链接恢复图、批注、回复、状态和轮次。服务重启后仍可继续：

```sh
npm run review -- resume <sessionId> --wait
```

`resume --wait` 从当前轮次的起点与已领取意见中较晚的位置继续等待，本轮尚未领取的意见会立即返回。已发布新版时，不会重新返回上一轮的通过或意见记录。轮次起点按提交 ID 保存，即使新版沿用同一源码版本、发布时间相同，也能区分。`resume` 不带 `--wait` 只查询会话并重印链接。可明确指定提交游标及等待秒数：

```sh
npm run review -- wait <sessionId> --after <submissionId> --timeout 1800
```

`--after` 排除指定记录及之前的提交，返回其后最新的一份记录；如果期间有多次提交，`earlierSubmissions` 还会附上其余未领取记录，代理应逐份核对对应快照和意见。所有提交均保留在 `get` 的历史中。未知记录会报错。超时退出码为 1，服务端数据保留。等待期间中断 CLI 不会删除会话。`revise --wait` 默认跳过发布新版前的提交，等待新一轮意见。

当前服务面向受信任的本机或 Tailscale 网络，未加入登录和权限管理。服务可达的设备能够读取和修改会话；请使用私有网络限制访问。恢复依赖运行服务机器上的实际会话目录：托管服务默认 `~/.logic-margin/sessions`，开发服务默认工程内 `.logic-margin/sessions`，自定义 `LOGIC_MARGIN_DATA_DIR` 时备份其实际目录。浏览器独立文件模式仍使用原来的本地保存及导入导出流程。

## 查询、归档与删除

查询当前上下文的活动评审或完整目录：

```sh
npm run review -- list --context "实际上下文标识"
npm run review -- list --context "实际上下文标识" --state all
```

默认 `state` 是 `active`，也支持 `archived`。列表只包含会话概要，不拉取整图；先核对目的和 ID，再操作具体会话。

```sh
npm run review -- cleanup <sessionId>
npm run review -- get <sessionId>
npm run review -- restore <sessionId>
```

`cleanup` 默认归档，保留完整图、批注和历史，可恢复；原活动链接进入归档状态。`get` 遇到已归档会话会读取归档内容，继续修改前用 `restore` 恢复同一 ID。默认仅允许清理已通过的评审；`--force` 明确允许清理未完成的评审，并不把它标为通过。

永久删除必须显式指定：

```sh
npm run review -- cleanup <sessionId> --mode delete
```

该命令同时删除此 ID 的活动与归档数据，无法恢复；未完成会话仍需 `--force`。没有默认批量删除。清理和恢复均按读到的 `version` 执行，期间有新修改则拒绝操作并保留数据。

需要通过后自动归档时，新建加 `--cleanup-on-approval`，策略随会话持久化；已有会话可在本次 `wait` 或 `resume --wait` 加同一选项。代理等待命令先输出 `approved: true` 的最终结果，确认记录属于当前轮次且会话仍为通过状态后再归档；显式游标取回的旧通过记录不会归档新一轮。单纯点击网页通过尚不清理。自动归档发生冲突时，最终结果已经输出，错误会明确说明归档失败；会话留存，核对最新状态后再清理。

场景、节点、批注、最终回应和轮次不再设固定业务条数上限。仍校验每条内容的格式、长度、引用与发布基线；大评审的处理速度取决于实际数据量与机器资源。

CLI 单次读入的评审 JSON、最终回应 JSON 各保留 10 MB 资源边界，限制的是一次传入的文件，不是服务端累计批注、快照或历史。发布新版可只传新图与新增最终回应；已有批注由服务端合并保留，无需把累计线程写回输入文件。
