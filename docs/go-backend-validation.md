# Go 迁移与 0.9.2 发行验收

## 0.9.0 发行前平台门禁

2026-11-09，运行时源码 `566cc96` 的[多平台预发布 CI](https://github.com/SunneeYang/LogicMargin/actions/runs/42564138282) 全部通过：

| 验证 | 结果与范围 |
| --- | --- |
| macOS、Linux、Windows 原生 | Node 单元测试、类型检查与网页构建、版本/打包检查、两个 bundle 校验、Go 普通与 race 测试、原生插件测试、Node/Go 兼容对照均通过 |
| Windows 启动器 | PowerShell 5.1 参数、空参数/引号/反斜杠、中文输出、物理工作目录、摘要校验、缓存复用与损坏包拒绝通过；摘要直接使用 .NET，不依赖 `Get-FileHash` 自动加载 |
| Windows 并发启动 | 独占句柄下限时等待/取消、陈旧锁恢复、单写入者，以及五个原生进程同时启动和崩溃恢复通过 |
| Linux 网页验收 | 74 项 Chromium 用例通过，包含三种代码视图、结构重点、移动局部对照、上下文扩展、总览、语言与状态保留 |
| 五目标发行构建 | `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-x64` 的 ZIP 与同名 SHA-256 文件全部生成 |

正式分发以 [v0.9.2 Release](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.2) 和标签触发的发行门禁为准。三系统 CI 原生运行不等于五种架构都经过实体设备验收；Safari/Firefox、实体手机、真实 Tailscale 与长期多人负载仍未覆盖。

## 0.9.1 兼容缓存修正

`v0.9.0` 的标签门禁随后捕获旧 Node 兼容实现的 Windows 元数据碰撞：同一 inode、长度与时间戳下的外部等长改写可能复用旧缓存。Go 在缺少 change-time 的平台已保守回读；Node 兼容实现也采用相同策略。保留原标签，后续候选使用 `v0.9.1`；Go 功能、数据格式和界面不变，双语截图继续准确标为未变的 0.9.0 界面。最终结果以对应版本标签的发行 CI 为准。

## 0.9.2 截止测试稳定性修正

`cf8324d` 的[0.9.1 预发布门禁](https://github.com/SunneeYang/LogicMargin/actions/runs/42569726947)三系统、五目标全部成功，但标签门禁随后在 macOS 捕获测试调度假设：1 微秒定时器取消回调可能晚于计算完成，`ctx.Err()` 此时允许为 nil。限制单核运行与异步抢占后，旧测试 40 轮均复现；测试改为等待 `ctx.Done()` 后检查截止错误，运行中取消仍由四组计数用例覆盖。生产计算、取消预算与界面不变；保留旧标签，正式分发使用 `0.9.2`，最终结果以其发行门禁为准。

## 历史迁移候选记录

下面各阶段保留迁移时的程序、环境、测量和平台缺口，不代表 0.9.2 当前发行状态；旧 ZIP 与旧性能样本不能替代上面的平台门禁。

日期：2026-11-09。工作分支 `arch/go-backend`，基线 `73890315827d0c335f360fcf467c33049fdb17cf` / 0.8.7。以下结果来自 Apple M4 Pro、macOS 27.0、Go 1.27.3、Node 26.13.0。验收时尚未提交、推送或发布；主线插件和正式会话服务未修改。

## 已交付的行为

Go 程序包含 HTTP API、官方 Go MCP SDK、评审命令、源码核验、后台管理和嵌入网页；React/TypeScript、React Flow、CodeMirror、主题、语言与交互继续使用现有前端。

按会话互斥维护读取—版本/轮次检查—修改—原子落盘事务，不同会话独立处理。等待使用 channel 和 context，断线或取消不领取意见；MCP 等待和明确领取仍分离。JSON/gzip 历史、固定 B、各轮快照、批注和回复保持既有格式。源码核验用受限 worker 和统一读取预算，成功后一次性更新保存片段。原生发行使用 `CGO_ENABLED=0`，仅开发和前端构建需要 Node。

进程锁携带 owner 原子公布且不覆盖已有目录，回收与释放绑定目录身份。Codex 配置进程使用 Unix 进程组或 Windows Job，限制清理等待并回收包装器子进程。

多人同时审查是后续规划，本轮只保留隔离和并发边界；账号、权限、在线状态与协作协议尚未实现。代码 diff 与流程图的后端预计算已在本候选接入，单独验收如下。

## 验证结果

| 验证 | 结果与范围 |
| --- | --- |
| 原 Node 单元测试 | 204 项：202 通过、2 跳过、0 失败 |
| Go 全量测试 | `go test -race ./... -count=1` 通过；包含 TS 固定向量、生命周期、并发冲突、旧 archive、取消与停机 |
| Go 静态检查 | `go vet ./...` 通过 |
| 来源/模型固定向量 | 453 组模型固定向量，另有 4 组来源核验向量；保留 UTF-16 长度、排序、精确指纹和作者内容 |
| Node/Go HTTP 对照 | 通过：创建、批注幂等、提交、领取、原子修订、current/快照/记录、通过、归档/恢复/删除；原 Node JSON 和 gzip 可直接读取 |
| 无 JS 运行时的 ZIP 闭环 | 6 项通过；从仓库之外执行，PATH 不含 Node/Bun/Deno，覆盖源码核验、CLI、自动启动、网页、HTTP MCP、多客户端、断线及重启恢复 |
| Go 服务上的 Chrome E2E | 43 项通过：`session`、`baseline-review`、`session-lifecycle`、`round-finish`、`code-context`、`code-overview`；包含模拟手机视口 |
| 前端/版本基线 | `npm run build` 与 `npm run test:release` 通过 |
| 五目标构建 | darwin-arm64、darwin-x64、linux-arm64、linux-x64、win32-x64 均编译成功，构建信息确认 `CGO_ENABLED=0` |

只有 darwin-arm64 实际运行。其他系统、Safari/Firefox、实体手机、真实宿主的数小时 MCP 等待及云端 CI 尚未验收。Chrome 用例选择的是可发行功能；依赖私有演示包的开发样例用例不在这次 Go 服务验证范围。

## 基础测量

对同一份 R10、200 条批注、9 条固定意见包、约 1.1 MB 的已保存 JSON 和相同网页资源，交错启动 Node 与 Go 各 5 次。每次启动后先预热 5 次，再采集 25 次顺序 `?view=current` 请求，共每个后端 125 个热读取样本。两侧响应均为 148140 字节，使用 identity 编码。

| 场景 | Node 中位数 | Go 中位数 | 计时边界 |
| --- | ---: | ---: | --- |
| 新进程就绪 | 206.53 ms | 23.65 ms | 启动进程到 `_serve` 输出已就绪，含内嵌资源准备与后台初始化 |
| 热读取 current | 0.794 ms | 0.867 ms | HTTP 请求至响应体接收完成，不含 JSON 解析 |

当前测量的明显收益在启动；热读取耗时接近。未清理系统文件缓存，启动只有每侧 5 个样本；没有测量 CPU/RSS、写入/发布、并发吞吐、diff 预计算、浏览器渲染、手机或其他系统，不据此推断整体负载表现。

`13e5150` 保留了 `node scripts/benchmark-go.mjs` 的删除前脚本（当前已移除该迁移对照器）。该快照不等于原始测量基线，在那里运行会产生当时输入和实现的新样本，不能直接复现上述原值。本机原始样本位于 `.scratch/go-migration-benchmark.json`；构建信息在 `.scratch/go-cross-results.json`，测试日志在 `.scratch/go-*.log`。这些为本地忽略文件，不随 Git 提交。

## 第二阶段：后端预计算验收

Go 原生行级 Myers＋字符细分输出 UTF-16 范围，并排、短统一和长统一三种 CodeMirror 视图直接使用后端范围。此预计算基线尚不含结构移动识别；后续结构增强见 [结构 diff](structural-diff.md)，不能将本节旧测量视为新功能的验收。流程图在 authored 坐标可用时使用 Go 原生正交路由，其他情况回退到 Goja 内的既有 Dagre；不启动 JavaScript 外部进程。协议、资源预算及固定 ID 排序变化见 [后端预计算](backend-precompute.md)。

- Node 测试更新为 217 项：215 通过、2 跳过；类型检查与前端生产构建通过。
- 完整 Go `-race` 与 `go vet` 通过；另复跑布局 race，涵盖 22＋50 组 V8 几何案例、ID 顺序、端口/标签与取消恢复。新增快照引用、缓存去重/重启、写盘失败、预热工作量、临时文件归属与防御性复制回归。
- 最终 Go 程序上的 Chrome 通过 67 项：原 56 项与新增 11 项。新增测试除检查请求外，还注入不同的有效范围/坐标，确认三种视图和画布确实消费后端结果；覆盖批注、滚动/局部展开/语言保留、迟到结果、本地导入不上传及 404/503/离线回退。旧 Node 用 404 契约模拟；离线用例在编辑器模块已加载后断流，首次断网打开尚未加载的代码模块仍可能失败。
- 新程序再次通过 3 项 Node/Go 对照与 6 项无 JavaScript 运行时的 ZIP 闭环。最终五目标均 `CGO_ENABLED=0` 编译成功，只有 macOS arm64 实际执行；新增 CI 定义尚未在云端运行。

### API 测量

以下为最终二进制、Apple M4 Pro/macOS arm64、本机顺序回环 HTTP，计时从 fetch 到接收完整 identity 响应体，包括快照解析、调度、计算/缓存和响应序列化，不含请求 JSON 编码、响应 JSON 解析或浏览器绘制。每组首次 miss 和重启后 disk 各 1 次，memory 为 10 次中位数；没有清空操作系统文件缓存，不能据此推断真实跨机/手机速度或并发吞吐。

| 操作 | 固定输入 | 首次 miss ms | 内存中位 ms | 重启后 disk ms |
| --- | --- | ---: | ---: | ---: |
| 代码 diff | 194 行 / 12 节点 | 7.58 | 0.47 | 3.69 |
| 流程图布局 | 194 行 / 12 节点 | 5.25 | 0.37 | 0.76 |
| 代码 diff | 1998 行 / 48 节点 | 6.96 | 0.32 | 2.44 |
| 流程图布局 | 1998 行 / 48 节点 | 7.47 | 0.63 | 0.73 |
| 代码 diff | 1998 行 / 96 节点 | 9.56 | 0.42 | 4.28 |
| 流程图布局 | 1998 行 / 96 节点 | 23.01 | 0.93 | 1.16 |

三组均验证首次 miss、连续 memory、重启 disk、批注/回复不改变 key、尺寸改变生成新 key。Go 进程 PATH 为空目录，不含 Node/Bun/Deno。驱动与种子构造使用开发环境 Node，不属于发行包运行依赖。脚本为 `scripts/precompute-benchmark.mjs`，原始记录位于本机 `.scratch/backend-precompute-benchmark.json`，包含实际二进制摘要与输入摘要。

另对同一份 45 节点/40 边 authored 图运行算法微基准三轮，Goja 后备路径中位 263.52 ms/112.29 MB 累计分配，原生路径 1.20 ms/0.519 MB 累计分配。该对比用于选择后端路由实现，不是旧 Node 页面与新页面的整体速度对比；累计分配也不是峰值 RSS。原始输出为 `.scratch/precompute-layout-benchmark-final.log`。

最终本机二进制约 19.92 MB，ZIP 约 7.25 MB；引入 Goja 后备增加了发行体积。ZIP 内程序 SHA-256 与实际测试程序一致。未测服务 CPU/峰值 RSS、浏览器首次显示耗时、多人负载、Safari/Firefox、实体手机或 Windows/Linux 原生运行。

## 已知兼容边界

- 现用 `2025-11-25` 单请求 MCP 流程和 TS SDK 客户端已验证。官方 Go SDK v1.8.0 不支持 `2024-10-07`，也拒绝 `2025-06-18+` 下旧 TS SDK 仍接受的批量扩展。需要这类客户端时应先增加协议验收和适配，当前候选不作完整旧协议兼容承诺。
- 正常 ISO 日期和固定向量内的旧格式已覆盖，V8 所有非标准 `Date.parse` 输入未穷尽。
- 不成对的 UTF-16 surrogate 和无效 UTF-8 JSON 会明确报错，避免解码替换后污染历史。旧损坏文件保留且不能被修改，修复原文件后重试。
- 没有暴露 ctime 的平台保守回读文件，缓存性能需在目标系统单独测量。
- 当前仍是单进程、单数据目录写入设计。不要让 Node 和 Go 同时写同一数据目录；用独立 `LOGIC_MARGIN_HOME` 作对照。

本机已生成 `artifacts/logic-margin-agent-0.8.7-darwin-arm64.zip` 及同名 `.sha256`，只含对应平台程序和插件材料。试用方式见 [Go 插件说明](go-agent-plugin.md)。默认发布与 Git marketplace 的切换留待迁移候选确认后处理。

## 后续性能对照

上述结果是优化前迁移基线的验收记录。2026-11-09 用户要求将该候选固定为后续对照基线，再与 Node 版及优化版进行比较。冻结对象、独立预热调度改进、最新测量状态见 [三版性能对照](performance-go-comparison.md)；不要将本页的旧测量或旧 ZIP 自动视为后续优化程序的验收结果。


## 第三阶段：独立结构重点

2026-11-09 进一步接入 Go/Lezer 解析、结构重点与移动局部对照。它与普通 diff 独立计算、独立缓存，默认文本首开不等待结构结果。74 项 Chrome、Go race/vet、Node/Go 兼容及无 Node 发行闭环通过；TS 大输入的冷计算与预算回退仍有明确限制。最新具体输入、二进制摘要、14 个浏览器样本及 6 组 API 数据见 [结构 diff 联合验收](structural-diff.md)。本页较早的程序与 ZIP 继续作为历史基线保留。

旧 Node 专属 `perf-server.ts`、`perf-cli.ts` 与迁移时 `benchmark-go.mjs` 已移除；如需复现历史结果，请使用 [13e5150 历史脚本](https://github.com/SunneeYang/LogicMargin/tree/13e5150631dcfcedec9182b1de221815a8257d71/scripts)。当前 Go 脚本为 `precompute-benchmark.mjs`、`structure-diff-benchmark.mjs` 和浏览器 benchmark；历史数据未改写为 Go 结果。
