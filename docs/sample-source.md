# Vast 通灵技能样例来源

样例由实际工作区源码人工整理，覆盖三个入口：系统升级、技能解锁、上阵与卸下。它是 LogicMargin 交互验证用的固定评审包，不是自动生成图或线上行为证明。

## 快照

- 源工作区：`/Users/hcm-b0677/Documents/work/miwu/vast-psycho-system-level`（只读）。
- 分支：`feat/psycho-system-level`。
- HEAD：`4d5c5409a3b72e3ce719f19655d5a700c3836f34`。
- 捕获时间：`2026-11-02T12:12:03Z`。
- 捕获时工作区干净，样例绑定上述提交及文件摘要。
- 评审版本：`worktree-4d5c5409a-887c3c3da061`。
- 文件清单 SHA-256：`887c3c3da0614300d0d12f147ef46778c11c08943918ecacaa539fc5b7100b66`。

文件清单包含下列原始文件的完整字节 SHA-256。总指纹为 `sha256(UTF-8(JSON(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':'))))`。节点 evidence 的 digest 单独对其 `startLine` 至 `endLine`（含端点）的原始字节、保留原换行进行 SHA-256。路径均相对 Vast 根目录。未复制 Vast 源码正文。

| 文件 | SHA-256 |
| --- | --- |
| `server/servers/game/role/psycho_skill.go` | `fe3ebc19967865710ba14dd0b3ee6a5093431ddda85b5a8f43ca2fac5c8dba09` |
| `server/entry/extends/psycho_skill.go` | `ebb862906b5c941cb45aa0febbacd131e059aa8476bdb1f635a561d3bdc7e64d` |
| `server/servers/game/role/role.go` | `7df766dfedc479e2747c432455cb9668836137c2bd88a08031ee7b1ad61d5ead` |
| `server/servers/game/role/role_mgr.go` | `83a9b3e5d037697f35097af0d030d1a68200dd15a4840c61b22fbed15bf0062f` |
| `server/servers/game/role/cost.go` | `9d58f0341df8db500676039f0f214294915ea3f4f277c3eb132fb289c659bc84` |
| `.scratch/psycho-system-level/spec.md` | `8bf7abae42fae26d63521ad84749e0bdcbc019d2e8db3677096e2dc93836f6ec` |

## 实际核对范围

- `server/servers/game/role/psycho_skill.go`：完整读取，确定校验顺序、状态写入、费用处理与效果查询。
- `server/entry/extends/psycho_skill.go`：完整读取，确认等级上限来自升级表最大 ID，效果由技能 ID 与总等级查找。
- `server/servers/game/role/cost.go:14-98`：确认检查资源在扣费之前；未据此宣称跨对象事务或任意失败自动回滚。
- `server/servers/game/role/role.go:858-960` 与 `role_mgr.go:32-68`：确认 `CalcRoleAtt` 只使缓存失效，下次正常读取时重算，并调用通灵效果处理。
- `.scratch/psycho-system-level/spec.md`：对照规则与验收边界；规格中的历史测试记录不算本次重新执行的验证。
- 阅读了完整提交正文 `4d5c5409a`、`b00e2d092` 与 `1930491aa`，并核对当前文件。已提交历史用于理解约束；图中重复解锁、满级业务码、上阵不复查解锁条件、解锁不清缓存等行为以捕获时的工作区版本为准。源工程在本任务只读核对期间由其他开发流程提交了 `4d5c5409a`；本样例捕获其提交后的干净状态。

三个场景不是同一次请求的连续执行，它们从各自的示意状态开始。L 表示系统总等级，U 表示已解锁集合，E 表示原上阵，S 表示请求技能；这些符号不对应实际玩家、技能 ID、资源或线上数值。未放入模拟的用户评论。

## 图谱与证据边界

按 Tier 2 先查询已索引项目 `Users-hcm-b0677-Documents-work-miwu-vast`，索引代次为 `2026-11-02T10:16:27Z`；搜索并追踪了相关入口与属性更新符号。但该索引属于主检出，升级逻辑仍是旧版，不可作为此工作区实现证据。

对所有上述证据文件调用 `check_index_coverage`，实际工作区路径均返回 `outside_project / unavailable`。因此改用实际工作区的直接文件读取及指定行核对。图谱只用于定位文件，不宣称已验证完整调用关系或全工程无遗漏。

本样例不覆盖转职、Build、排行、GM 导入导出、生成协议和客户端/Admin 消费者；不覆盖外层请求入口的完整调用链、并发和跨对象原子性，也不验证线上配置是否存在。未修改 Vast、运行 Go 测试、启动服务、部署或进行真实战斗/存储联调。

## 更新规则

Vast 后续变化不会自动反映到此评审包。更新时必须重新核对说明、分支、行号与源码摘要，保留语义稳定的节点/连线 ID，再导入新版。导入新版会保留原批注，并按当前模型将需要重新确认的意见标为待复核；不能用改图代替用户确认。
