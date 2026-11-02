# 魔灵秘境真实评审包来源

本包将当前真实服务端需求和实现转换成 LogicMargin 可批注的流程，共 5 个场景、42 个节点、50 条连线。它不是自动从代码推导出的完整控制流，不包含模拟用户意见，也不是线上或真实战斗验收报告。

## 固定快照

- 只读来源工作区：`/Users/hcm-b0677/Documents/work/miwu/vast-spirit-sanctum`。
- 分支：`feat/spirit-sanctum`。
- HEAD：`15ee338eb7f512e64f7fc2d6fa3143e2d6b37607`。该 HEAD 只是基线；魔灵功能仍包含已修改和未跟踪文件，不能称为此功能的已提交版本。
- 捕获时间：`2026-11-02T15:35:26Z`。
- `snapshot.dirty = true`；捕获前后逐文件字节与 HEAD/分支保持一致。未修改、生成、提交、合并或推送源工程。
- 评审身份：`vast-spirit-sanctum`。
- 评审版本：`worktree-15ee338eb-250b8a044982`。
- 文件清单指纹：`250b8a044982e88c51fd438fb49266cb333b9e288622ec75651358823d0aff44`。
- 评审 JSON：[spirit-sanctum.logic-margin.json](../public/reviews/spirit-sanctum.logic-margin.json)。

总指纹计算为 `sha256(UTF-8(JSON(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':'))))`。下面每项值为该文件完整原始字节 SHA-256；节点 `evidence.digest` 则单独对 `startLine` 至 `endLine`（含端点）的原始行字节、保留原换行计算 SHA-256。源码路径相对上述工作区。只保存业务说明、位置与摘要，不复制 Vast 源码正文。

| 文件 | 完整字节 SHA-256 |
| --- | --- |
| `docs/features/spirit-sanctum.md` | `d3e1cd14f2b5b3849dc0608a1fc55b1bc0c69243b00c7c886b90d3464dfdc3aa` |
| `server/entry/entry/Configuration.json` | `68bca24023d7fe6178edd3f1cf1d7aa910530bd6105d5abec526eee371417613` |
| `server/entry/entry/Money.json` | `8fb069cc51eed28df6a9b1e7ebc28007f9c42a0962b04cede98a680a6697f7cb` |
| `server/entry/entry/SpiritSanctum.json` | `08000eaa236ad98faaa483191b16d5b53e66926a52c1089333a32a60a92c7ed3` |
| `server/entry/entry/Stage.json` | `4e800ad92a358dd6cb28b4beabf3cc6e5de4ef78be7678c32cac9cfe75320320` |
| `server/entry/extends/spirit_sanctum.go` | `33f4539a70b31d0eabb249e4dffdcbdfbbd8b5e6c58e266a10c8caaf534d1d56` |
| `server/handlers/game/game_handler_spirit_sanctum.go` | `0d1b5cdec7910fecb160b12f0917145de1b8006a18f3c44defbfaca3bf4e1b6b` |
| `server/servers/game/role/build.go` | `fe81c8097c94787ea8bbe3acb45d12bfeacd8224b456924ef38af7472f304ae0` |
| `server/servers/game/role/money.go` | `0810bb14df954a5429f4641a54be0d01a08fbc58db27bc9db725c278ce9a18dc` |
| `server/servers/game/role/persona.go` | `c30e8bb8fc2d860f281550fef49091419fb04934ea2a1db6b8dbe20ed8a8fda6` |
| `server/servers/game/role/psychic_potion.go` | `f40a3cf896d9b93c06855e90b3c1400b2a400a50b6a59f4102bc9438a6f88aaa` |
| `server/servers/game/role/reenact.go` | `580adc8001ecf3eebc56e64a529d7c13c8d6825b4bbf5318240ed27de15fd220` |
| `server/servers/game/role/role.go` | `c446e8bd351390fef5312dc0e24a3bb7c122f34c7b90415166c42d5fb998a71f` |
| `server/servers/game/role/stage.go` | `5963ac5e797e8a0cd96fabf574bbbecc8297b09cfd9d09664b25fe08fb236634` |
| `server/servers/game/role/stage_loadout.go` | `4e43280e86db96edaff81663959816feed27b228324fc70aeb7629436a3144df` |
| `server/servers/game/role/stage_spirit_sanctum.go` | `59515c7af226246c20283245c9fa0b331607726ac72684dcc43f0e99dca2a79e` |
| `server/servers/game/role/stage_spirit_sanctum_test.go` | `e05b59f7e251a462db1d5f9fc3b26eb06424ab6afc36d6ab7518d867632629fa` |
| `server/servers/game/role/stage_style_sanctum.go` | `05db936307cc3661d2523e6baffe372cc5668c3c182d0365195f17a2f56877cc` |

## 本次直接核对的行为

- 入场：功能开关、单人、层与独立关卡契约、本层条件、背包、入口房间和门票检查均先于替换旧场次。入场只查票，成功结算才扣票；正常门票补发可能在入场拒绝前发生，不承诺整个失败请求零状态变化。
- 战斗：真实击杀进度满后的首领才进入 `Success`；成功完成时才比较当前最高层、写入突破标记。突破先加风险后等待既有验算流程，重复通关按既有整数秒边界即时结算。成功战报入口匹配当前层、真实关卡、seed、结束状态、进度及总帧数，非法提前上报不清除正常录制。
- 回写：直接读取 `persona.go` 的 `DealAsyncModify`，确认完整回执、当前职业及 `m.Win` 是魔灵结算的共同前置。专用回写还检查突破标记、真实关卡、验算成功和原始帧数，再查当前条件、票和奖励容量。最高层只取 `max`，不重新要求回执层大于当前最高层，也不覆盖当前挑战或录制。直接读取乱序回执回归用例作为源码约束；定向回归由主任务补验，见[本次验收记录](spirit-sanctum-acceptance.md)。
- 扫荡：校验所选层配置及 `0 < selectedID <= HighestId`、所选层条件后，使用 HighestId 进入通用结算，最高层自身条件也要满足。允许战斗中扫荡；它不会清场，之后挑战成功可能因扫荡已耗票而无奖。购卡只是扫荡资格，不翻倍发奖。
- 门票：直接读取 Money[16] 的 `shared=0`、容量 2，以及日发配置 2；钱包路由到当前 Persona，TicketTime 也位于其魔灵状态。05:00 跨日补发后按容量截断，超额部分不留待领；切换化身不共享票与发放时间。旧记录中“角色共享门票”的早期设想不适用于本次快照。
- 配装：直接核对共用锁和 BuildApply、PsychicPotionLineUp 的前置调用，以及 BuildSave 的保留行为。功能文档给出了完整操作范围，但本包没有穷尽追踪所有装配入口；喝药行为依据当前功能契约展示，未据此声称完成所有消费者验收。

## 当前阻碍与未验证范围

捕获时层表有 50 行，id 1–50 分别引用 Stage 2–51；直接解析当前导出 Stage 后，全部引用的 duration 都为 180 秒。`ValidateSpiritSanctumStage` 要求独立魔灵玩法与 60 秒等完整契约，因此这些占位内容不能直接用于正式挑战。图中“入场与配置校验”单独保留了占位拒绝出口，工作台覆盖范围也明示此限制。

当前功能文档说明客户端及 combat mode 11 的新验算 JavaScript 尚未接入；本轮未构建或运行客户端/验算 JS，不将文档记录冒充真实回放证明。服务端源文件、配置和已有用例能够用于 LogicMargin 的真实需求评审，但不能代替正式关卡与战报的集成验收。

本包的数据整理阶段只读源文件，未自行运行 Go。主任务另行补做源工程定向测试，具体命令、结果、配置隔离限制与验收边界见[本次验收记录](spirit-sanctum-acceptance.md)；已有功能文档中的历史记录未冒充本次重跑结果。未完成真实战斗、真实 Redis/MongoDB、跨进程故障恢复或部署验收。没有补设超出现有异步设施的永久去重或原子性保证；转职、专家死亡、跨服与赛季继承没有完整展开。

## 图谱覆盖与更新

按父任务 Tier 2 定位：Vast 主检出图谱代次 `2026-11-02T12:39:42Z` 未包含本工作区的魔灵实现。对实际 `vast-spirit-sanctum` 文件调用 `check_index_coverage` 返回 `outside_project / unavailable`；因此所有本包说明以实际工作区的直接源码/配置读取为证，未据图谱宣称完整调用链或无遗漏。LogicMargin 的 schema 复用现有 `src/types.ts` 和 `parseReview`。

后续更新应重新读取当前规则、重新捕获文件与行摘要，并保留语义稳定的节点、连线与场景 ID。网页不会实时监测源仓库；不能只更新版本文字就沿用旧证据，也不能以改图自动替代人工解决意见。

<details>
<summary>可复算的规范化文件清单</summary>

```json
{
  "docs/features/spirit-sanctum.md": "d3e1cd14f2b5b3849dc0608a1fc55b1bc0c69243b00c7c886b90d3464dfdc3aa",
  "server/entry/entry/Configuration.json": "68bca24023d7fe6178edd3f1cf1d7aa910530bd6105d5abec526eee371417613",
  "server/entry/entry/Money.json": "8fb069cc51eed28df6a9b1e7ebc28007f9c42a0962b04cede98a680a6697f7cb",
  "server/entry/entry/SpiritSanctum.json": "08000eaa236ad98faaa483191b16d5b53e66926a52c1089333a32a60a92c7ed3",
  "server/entry/entry/Stage.json": "4e800ad92a358dd6cb28b4beabf3cc6e5de4ef78be7678c32cac9cfe75320320",
  "server/entry/extends/spirit_sanctum.go": "33f4539a70b31d0eabb249e4dffdcbdfbbd8b5e6c58e266a10c8caaf534d1d56",
  "server/handlers/game/game_handler_spirit_sanctum.go": "0d1b5cdec7910fecb160b12f0917145de1b8006a18f3c44defbfaca3bf4e1b6b",
  "server/servers/game/role/build.go": "fe81c8097c94787ea8bbe3acb45d12bfeacd8224b456924ef38af7472f304ae0",
  "server/servers/game/role/money.go": "0810bb14df954a5429f4641a54be0d01a08fbc58db27bc9db725c278ce9a18dc",
  "server/servers/game/role/persona.go": "c30e8bb8fc2d860f281550fef49091419fb04934ea2a1db6b8dbe20ed8a8fda6",
  "server/servers/game/role/psychic_potion.go": "f40a3cf896d9b93c06855e90b3c1400b2a400a50b6a59f4102bc9438a6f88aaa",
  "server/servers/game/role/reenact.go": "580adc8001ecf3eebc56e64a529d7c13c8d6825b4bbf5318240ed27de15fd220",
  "server/servers/game/role/role.go": "c446e8bd351390fef5312dc0e24a3bb7c122f34c7b90415166c42d5fb998a71f",
  "server/servers/game/role/stage.go": "5963ac5e797e8a0cd96fabf574bbbecc8297b09cfd9d09664b25fe08fb236634",
  "server/servers/game/role/stage_loadout.go": "4e43280e86db96edaff81663959816feed27b228324fc70aeb7629436a3144df",
  "server/servers/game/role/stage_spirit_sanctum.go": "59515c7af226246c20283245c9fa0b331607726ac72684dcc43f0e99dca2a79e",
  "server/servers/game/role/stage_spirit_sanctum_test.go": "e05b59f7e251a462db1d5f9fc3b26eb06424ab6afc36d6ab7518d867632629fa",
  "server/servers/game/role/stage_style_sanctum.go": "05db936307cc3661d2523e6baffe372cc5668c3c182d0365195f17a2f56877cc"
}
```

</details>
