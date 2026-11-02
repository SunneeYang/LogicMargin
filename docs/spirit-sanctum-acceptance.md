# 魔灵秘境真实需求试用记录

日期：2026-11-02。目标是在 LogicMargin 中承载实际已开发的服务端需求，验证阅读、批注、提交与复核；不以工具交互成功代替游戏功能联调。

## 评审入口与快照

- [Tailscale 直达](http://100.124.38.121:5173/?review=spirit-sanctum)。同一 Tailnet 的设备可使用此地址；本次浏览器验证是在服务所在机器访问该 Tailscale IP，未从另一台设备实连。
- [固定评审 JSON](../public/reviews/spirit-sanctum.logic-margin.json)：5 场景、42 节点、50 连线；初始 `comments=[]`。
- [完整来源](spirit-sanctum-source.md)：`feat/spirit-sanctum` 的未提交工作区，HEAD 基线 `15ee338eb7f512e64f7fc2d6fa3143e2d6b37607`，捕获时间 `2026-11-02T15:35:26Z`。
- 版本 `worktree-15ee338eb-250b8a044982`；总指纹 `250b8a044982e88c51fd438fb49266cb333b9e288622ec75651358823d0aff44`。主任务独立重算并核对 18 个完整文件摘要及 80 条源码行摘要，全部匹配。

## LogicMargin 验证

- 29 项模型/存储契约测试、24 项 Chrome 浏览器测试通过，TypeScript 与生产构建通过。
- 新包专项覆盖：直达载入、真实节点批注、原线程回复、固定意见包下载、回执导入后待复核、单独整轮通过、刷新保留本机意见；新旧评审切换保留草稿；加载失败保留当前文档并可重试；手工导入新版和已有新版缓存不被直达入口降级。
- 既有回归包含图内与侧栏同一编辑器/光标、精确框选、系统主题、320/375/414/768px、损坏存储备份与配额失败。
- 真实 Tailscale HTTP 地址验证时，`isSecureContext=false`、`crypto.randomUUID` 不存在而 `crypto.getRandomValues` 可用。已把评论、回复和固定记录的 UUID 统一改为基于 `getRandomValues` 的 UUID v4，并验证完整交互链路，无页面异常。
- 固定地址加载仅允许本站已知评审路径，手工导入会取消迟到加载。已保留通灵样例入口及原文件交换方式。

本机诊断记录位于忽略目录 `.scratch/`：`spirit-sanctum-tailscale.png`、`spirit-sanctum-tailscale-feedback.json`、`spirit-sanctum-tailscale-approval.json`。这些是隔离浏览器中的交互验收数据，评论和代理回执明确标记为测试；不写入发布评审包，不代表真实代理已经执行修改或用户已通过整轮。

## 服务端定向验证

源工程只读，使用 Go 1.26.10 及 `agent-tmp-run`，未运行生成、部署或全 module 检查，未接真实 Redis/MongoDB。验证前后源 HEAD 与已有 dirty 状态未改变。

- `servers/game/role`：16 个魔灵/门票/配装顶层用例通过，覆盖非法入场保留旧战斗、跳层、最高层扫荡与失败不扣费、突破/重复结算、合法胜利回执、无票和超帧、乱序结算、化身隔离、禁掉落、Devil/魔灵各 41 项装配拒绝零副作用。
- `servers/reenact`：2 个魔灵参数、最高成绩及普通回执用例通过，无需真实 JS 运行时。
- `entry/extends`：`TestValidateSpiritSanctumStageRejectsOldAndIncompleteStages` 单独运行在测试第 10 行因 `entry.GetConfig()==nil` 而 panic。加入既有 `TestProfessionGrowthCheckBlessingPositions/matched` 做本地配置初始化后，9 个非法关卡子例通过。这个测试隔离缺口未修改，不能把首次定向检查描述为全绿。
- 合计 19 个魔灵相关顶层用例通过，另有 1 个初始化辅助顶层用例；没有跳过。首次独立配置测试失败及后续通过均保留在 `.scratch/spirit-sanctum-source-tests.log`。
- 每日 05:00 的规则由 `date.CalculateDayDifference(last, now, 5)` 源码确认；现有测试验证离线补票、容量与化身隔离，没有固定时钟的 04:59→05:00 专项断言。

## 继续真实业务验收时的边界

当前 50 层仍引用 Stage 2–51 的 180 秒占位关卡，正式魔灵规则要求独立 60 秒关卡；运行时会拒绝不合法占位。客户端与 combat mode 11 的新验算 JavaScript 尚未接入，未验证真实战斗、外部存储及跨进程故障恢复。以上边界已保留在评审包及图的拒绝路径中。

本次未修改 Vast、Design、客户端或 Admin，未提交或推送任何工程。Safari、触控真机和另一台 Tailscale 设备实连未验收；当时的文件模式意见包需人工交给代理。

## 代理共享会话补验（2026-11-03）

- 新增持久会话 API、代理 CLI、浏览器增量同步；49 项单元测试、38 项 Chrome 端到端测试与生产构建通过。服务重启恢复、保存与 Finish 分离、并发追加、未看过的回复不能确认解决、跨轮游标、重复请求和损坏文件均有对应检查。
- 浏览器验证完整往返：发起会话→图上批注→提交→代理领取/回复→发布新版→刷新/另一浏览器恢复→人工确认→整轮通过→重新打开意见。断线队列、提交失败重试不重复批注、旧源冲突先备份再恢复也已验证。
- 使用现有真实评审包新建会话，服务端保存 `comments=[]`，没有混入测试意见或假装修改游戏逻辑。真实入口为 [魔灵秘境共享会话](http://100.124.38.121:5173/?session=b51db21a-dfb1-4aa4-9373-9ba55b2b3b51)。旧文件入口仍可使用，缓存互不覆盖。
- 服务所在机器通过实际 Tailscale HTTP 地址读取会话并打开页面；1440×900、375×812 的画布高度分别为 783、646px，没有横向溢出或页面脚本异常，`isSecureContext=false`。仍未从另一台 Tailscale 设备实连。
- 本轮未重跑游戏源码测试，也未修改或重新提取魔灵秘境逻辑；沿用上述固定评审包与已记载的游戏联调边界。新会话须备份 `.logic-margin/` 才能迁移机器；草稿仍保存在当前浏览器。
