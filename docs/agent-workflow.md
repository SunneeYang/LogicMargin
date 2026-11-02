# LogicMargin 代理评审流程

网页批注和“提交本轮”是两个动作。保存批注只更新会话；提交意见或确认通过才让等待中的代理继续。代理回复不会自动把批注标成解决，由评审者在新版上复核。

## 启动服务与发起审查

完整插件会在首次发起时自动启动服务；没有显式 API 地址时默认复用已登记服务，或兼容的本机开发服务。`--url` / `LOGIC_MARGIN_URL` 指向远端时只连接那个地址，失败不另建本机会话。安装与服务管理见 [agent 插件](agent-plugin.md)。以下为从 LogicMargin 源工程运行开发服务的方式：

```sh
npm run dev -- --port 5173 --strictPort
```

代理准备符合 `schemaVersion: 1` 的流程图 JSON，明确源码快照、覆盖范围和依据。使用真实需求包发起会话并等待：

```sh
npm run review -- start public/reviews/spirit-sanctum.logic-margin.json --wait --public-url http://100.124.38.121:5173
```

命令在 stderr 打印带 `?session=...` 的审查链接；stdout 只在本轮提交后输出一份 JSON。Tailscale 地址只影响分享链接，代理默认连接本机 `http://127.0.0.1:5173`。跨机运行 CLI 时用 `--url http://100.124.38.121:5173` 指定 API 地址。

评审者打开链接，在节点、关系或整图上批注，保存后点击“提交本轮”。没有未解决意见时可确认通过。CLI 仅在收到固定快照的提交记录后返回，并将意见标为代理已领取；页面上的普通保存不会唤醒代理处理。

## 处理意见与发布新版

返回结果包含 `sessionId`、`round`、`approved` 和 `submission`。`submission.review` 包含评审 ID、版本、源码快照和本次意见，避免每轮输出整张图。完整会话及历史可通过 `get` 读取：

```sh
npm run review -- comments <sessionId>
npm run review -- get <sessionId>
```

代理核对每条意见及目标，在原开发工作区修改源码，并重新生成流程图 JSON。相同业务节点沿用稳定 ID；更新 `revision`、快照和依据。LogicMargin API 不执行 shell，也不替代理写入源码。

将回应写入文本文件，保留实际换行，再发布回复：

```sh
npm run review -- reply <sessionId> <commentId> --body-file /path/to/reply.txt
npm run review -- revise <sessionId> /path/to/updated.logic-margin.json --wait --public-url http://100.124.38.121:5173
```

新版须沿用原评审 ID。服务端合并原批注和回复，保留原意见对应的版本，并开启下一轮。源码或语义发生变化的批注进入待复核；旧锚点消失时保留批注供人工核对。代理不能用回复代替人工确认解决。

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
