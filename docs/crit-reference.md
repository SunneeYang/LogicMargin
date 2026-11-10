# Crit 参考：从逻辑批注到评审反馈闭环

## 核对范围与固定来源

- 核对日期：2026-11-02；只核对公开主源，不安装、运行或发布 Crit。
- 上游：[tomasz-tomczyk/crit](https://github.com/tomasz-tomczyk/crit)；官网入口 [crit.md](https://crit.md)，本轮未另行检查线上服务。
- 本次查询 `main` 得到固定 SHA：[`4458cced170c23dde92070c12758f5942048359a`](https://github.com/tomasz-tomczyk/crit/commit/4458cced170c23dde92070c12758f5942048359a)。以下源码链接均固定到该版本。
- 共 8 次上游定向读取：分支元数据、目录树，以及 README、LICENSE、review_file.go、session.go、web/app.js、Codex crit-cli 接口文档。
- 远程仓库没有本地索引，本轮以有界源码阅读核对；不宣称完成全仓审计或图谱覆盖。
- 本文保留初次上游核对记录；下方“本轮实现”补记当前接入情况，旧的差距与顺序描述为初次核对时状态。

## 本轮实现：代理等待与共享会话（2026-11-03）

进一步阅读了固定 SHA 的官方 [交互式评审技能](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit/SKILL.md)。它要求代理启动命令并等到 Finish Review，再读取反馈、修改源文件、逐条回复，最后启动下一轮；代理未经明确要求不应 resolve。这是公开接口约定的核实，本轮仍未运行 Crit 或审计其全部服务端实现。

LogicMargin 现已实现对应闭环：

- 本机服务端持久保存 review session、固定提交包、每轮快照和原批注。重启服务后可按同一会话 ID 恢复。
- `start --wait` 发起并等待；普通批注保存只同步数据，只有“提交本轮”或人工确认通过才返回固定记录。`wait/resume` 可以恢复等待游标，代理实际领取后才显示已接收。
- 代理在原工作区修改代码/规则并整理新版流程；`reply` 将回应挂回原评论，`revise --wait` 发布新版并进入下一轮，页面同步接收。
- 原意见、来源版本与回复保留；语义或源码快照变化、新代理回复要求人工复核，代理不会自动解决意见。人工可重新打开已解决批注。
- 按增量操作同步，重复追加幂等；状态与整轮提交校验版本，避免确认未看过的更新。待同步操作独立保存；旧源冲突保留操作供备份，不猜测重挂目标。
- 原有独立文件模式继续可用。浏览器草稿仍是本机数据，会话不执行任意 shell，也不负责自动从源码提炼图。

使用方式与边界见 [代理评审流程](agent-workflow.md)，实现见 [会话存储](../server/session-store.ts)、[前端桥接](../src/useReviewSession.ts)、[代理 CLI](../bin/logic-margin.ts)。这是机制借鉴，自行实现，未复制 Crit 源码。

## 已核实的 Crit 机制

### 评论、回复与解决状态

- Crit 的入口包括文档、Git diff、运行中的网页和静态 HTML；README 将它定位为给代理输出做浏览器评审的本地工具。[README](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/README.md#L8-L23)
- 代码评审可以点行号或拖选范围批注；接口文档区分行级、文件级、评审级三种评论。[README](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/README.md#L167-L169)、[CLI 文档](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L11-L17)
- `Comment` 包含正文、作者、行范围、引用、文本锚点、解决状态、轮次与 `replies`；`Reply` 有自己的 ID、正文、作者、时间与轮次。[模型](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L71-L100)、[Comment](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L128-L179)
- 网页保存评论立即请求评论 API；回复另走 replies API。保存单条评论不是 Finish Review。[保存](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L5356-L5404)、[回复](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L6651-L6666)
- resolve/unresolve 是独立操作，网页显式提交 `resolved` 布尔值；接口文档说明只有 `true` 才算已解决。[网页操作](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L5997-L6024)、[字段规则](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L90-L95)
- 官方代理接口要求仅在人明确要求时使用 `--resolve`；不能把“代理已回复/已改代码”直接解释为问题已解决。[接口约束](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L118-L124)
- 已看到网页评论编辑器的草稿保存/恢复代码：使用 localStorage，恢复时丢弃超过 24 小时的草稿；这只证明该编辑器路径，不保证所有模式或多端同步。[草稿代码](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L5454-L5525)

### Finish Review、交付与代理接口

- 网页有未解决评论时按钮为 `Finish Review`，零未解决评论时为 `Approve`；完成后有等待状态。[按钮与状态](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L7274-L7302)
- 完成入口委托共享 `runFinishReview`，分别处理 approved/waiting 回调；本轮未继续读取共享实现及服务端 finish handler。[完成入口](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L7309-L7340)
- 官方 CLI 文档规定评审轮完成后读取 stdout 反馈提示，并从 stderr 检查 `approved: true/false`；可用 `crit comments --json` 单独读取评论。[读取反馈](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L19-L33)
- CLI 支持 `crit comment --reply-to <id>`；发布到 PR/MR 是独立的 `crit push`，具有 comment/approve/request-changes 事件。因此不要把本地完成按钮写成已发布远端评审。[回复接口](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L97-L115)、[远端接口](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/integrations/codex/skills/crit-cli/SKILL.md#L185-L195)
- README 另述实验性的 `Send now`：配置 `agent_cmd` 后，将评论上下文送入代理 stdin，把 stdout 作为回复；live thread 可继续传递对话。这是文档确认的可选机制，本轮未运行验证。[代理机制](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/README.md#L271-L311)

### 轮次、版本与快照对应性

- 评审数据包含 `branch`、`base_ref`、`review_round`；每个文件有 `file_hash`。这些分别描述评审上下文、轮次与文件内容标识。[评审数据](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L570-L585)、[文件数据](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L712-L717)
- 评论有 `review_round`、`resolved_round`；部分焦点评论有 `head_sha`，源码明确工作区评论和旧评论可为空。轮次不能直接当作 Git commit。[评论字段](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L149-L179)
- v4 将 `review.json` 与 `snapshots.json` 放在同一评审目录；后者保存按文件、轮次组织的内容快照映射，由服务端读写。[快照存储](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/review/review_file.go#L271-L300)、[内存对应](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L476-L482)
- 恢复会读回轮次和快照；`SignalRoundComplete` 说明轮次递增延后到 watcher 携带评论之后。本轮没有审计完整的快照捕获与跨轮锚点迁移算法。[恢复](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L2723-L2769)、[轮次信号](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L2357-L2388)

## 锚点映射：借反馈机制，保持逻辑对象边界

| Crit 已核实机制 | LogicMargin 对应或建议 |
| --- | --- |
| 文件路径＋行范围＋文本锚点（[模型](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L128-L147)） | 已有 `Target={kind:'node'|'edge',id}`，直接锚定业务节点/关系；不把屏幕坐标变成语义锚点。 |
| 一条评论带回复、作者和解决状态（[模型](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/session/session.go#L144-L159)） | 已有多目标评论和人工状态；建议补同一评论下的代理回应，保留原意见。 |
| Finish Review 与单条保存分开（[网页](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L5356-L5404)、[完成入口](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/web/app.js#L7309-L7340)） | 建议增加“提交本轮意见包”，让用户有明确的交付边界。 |
| 评审轮次与文件快照分离存储（[源码](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/internal/review/review_file.go#L271-L300)） | 沿用已有 snapshot 与 revision，明确每次意见针对哪版逻辑；具体提交包是我们的新增设计。 |

## 初次核对时的能力与差距（2026-11-02）

以下是已核对的本地源码事实：

- [types.ts](../src/types.ts)：`ReviewComment` 只有 id/body/targets/status/createdAt/revision；状态为 open/resolved/needs-review。
- [types.ts](../src/types.ts)：`ReviewDocument` 已有 snapshot(commit/fingerprint/capturedAt/dirty)、scenes/nodes/edges/comments。
- [model.ts](../src/model.ts)：`addComment` 立即加入本地记录；`setCommentStatus` 是人工状态操作。
- [model.ts](../src/model.ts)：`rebaseReview` 保留本机意见；revision 或 fingerprint 变化会使旧意见待复核，坐标变化不算语义变化；同 ID 正文/目标冲突拒绝合并。
- [App.tsx](../src/App.tsx)：图内弹窗、节点按钮、连线右键与框选批注已实现；localStorage 保存、JSON 导入导出已实现。
- 当前缺少 reply、author、review-session、submission，也没有后端、CLI、插件或提交评审流程。
- 因此，“评论已保存”目前只代表本地记录；“已交给代理、代理已回应、哪版待人复核”还没有完整表达。
- 核验依据为 Tier 2 图谱与源码；相关文件及 README 的 coverage 无记录缺口，图谱结果不等同于运行验收。

## 初次建议的最小实现顺序

以下全部是 LogicMargin 建议，不是已实现功能，也不是 Crit 数据格式的照搬。

1. **先做一次明确的意见包提交。** 在已有 JSON 导出上增加“提交本轮意见”，固定 submission ID、时间、源 snapshot、所选评论及目标上下文；先通过文件交给代理即可。
2. 提交时固定该包内容；后续本地增改不悄悄改写旧包，避免代理处理的意见与人当前看到的内容混淆。
3. **再接同一评论的回应。** 最小回应包用 submission ID＋comment ID 关联，保存作者、正文与时间；代理说明修改或异议，不覆盖原评论、不默认 resolved。
4. **接上新版复核。** 代理改代码并给出新版逻辑 JSON，沿用已有 rebase/needs-review；保留意见的来源版本，让人核查改动后的目标语义。
5. **由人确认关闭。** 看过回应和新逻辑后设 resolved，未满足则继续 open；是否接受一轮评审与单条评论状态分开表达。
6. 文件闭环走通后再决定 CLI/插件；本轮不先扩展后端、在线共享、完整代码 diff UI 或 Crit 的所有评审模式。

优先事项只有一件：把已有图评论变成**针对固定快照、可交给代理的一次意见包**，再逐步接回回应与复核。

## 初次提出的验收例子

这是待实现闭环的验收方案，使用虚构订阅工作区测试夹具，不代表任何真实系统存在以下问题：

1. 在 snapshot A 的“启用演示集成”节点及后续连线上批注：“这里只启用集成，保留套餐与通知渠道”；刷新后仍可看到本地意见。
2. 点击一次“提交本轮意见”，得到包 S1，包含 A 的 fingerprint/revision、目标 ID、意见正文和 submission ID；普通保存不会产生提交记录。
3. 代理读取 S1，修正夹具中的集成启用行为，并按原 comment ID 回应：“已保留套餐与通知渠道，附改动依据”；界面仍保留原意见，状态不因这条回复自动解决。
4. 导入新版逻辑 B；旧意见依据已有规则进入 needs-review，能对照来源 A 和当前 B；仅拖动节点不产生语义变化。
5. 人核对 B 中“集成集合新增、套餐保持、通知渠道保持”后手动 resolved；行为仍错就继续 open，并可再次提交后续意见。
6. 重复导入同一回应不重复生成回复；同 ID 冲突必须报错。目标在 B 消失时保留可追溯提示，不按位置猜测替代目标。

## 许可证与尚未核实事项

- 固定版本根 LICENSE 为 **MIT License**，版权为 **Copyright (c) 2026 Tomasz Tomczyk**；若复用源码，在副本或实质性部分中保留版权及许可声明。本文只借鉴机制，未复用源码。[LICENSE 全文](https://github.com/tomasz-tomczyk/crit/blob/4458cced170c23dde92070c12758f5942048359a/LICENSE)
- 未检查 Crit 线上共享服务、多端并发冲突与同步保证；不声称它具备多端实时协作。
- 已核实文本锚点、drifted 字段和快照存储，但未核实自动追踪/重挂算法的适用范围、正确性和失败策略。
- 未核实独立不可变 submission 实体、所有模式的快照时点、每条评论与唯一 commit 的对应性；这些不能由 review_round 推出。
- 未完整追踪服务端 Finish Review、清理和持久化事务；本文对完成动作的结论限于已读 UI 和官方接口文档。
- 本轮未运行 Crit 或 LogicMargin 的集成测试；本文是有边界的参考核对，不是产品行为验收。
