# Go 后端迁移与 0.9.2 发行

迁移始于 2026-11-08 的 `arch/go-backend`，已通过合并提交 `62dcc38` 进入主线。**0.9.2 默认发行切换为 Go 原生程序，包含代码 diff、结构重点/移动局部对照与流程图预计算；用户无需安装 Node.js 或 Go。** 本文保留迁移阶段的基线与决策，历史测试数字及其边界见 [迁移验收](go-backend-validation.md) 和 [结构 diff 验收](structural-diff.md)。切换发行入口不证明实际插件、运行服务或云端 Release 已更新，须分别检查。

`agent-tmp-run` 是开发机可选的临时文件 harness，不是公共依赖；以下命令可从仓库根目录执行。有本地 AGENTS 强制要求时仍须使用本地 harness 包裹命令。

## 迁移阶段的固定基线与工作方式（历史）

- 对照提交：`73890315827d0c335f360fcf467c33049fdb17cf`，LogicMargin 0.8.7。
- 当时的原主线：`<repository-root>`，保留 `main` 和既有未提交调研材料。
- 当时的迁移 worktree：`<migration-worktree>`，由根 agent 独占写入并负责集成；会话存储、HTTP/MCP、评审命令在各自的独立 worktree 实现，完成后只复制各自负责的文件。
- 首先完成行为等价的 Go 迁移，再增加结构 diff 预计算；两阶段分别记录验证与性能，避免混淆语言迁移和新算法的收益。
- 创建分支/worktree不包含提交、推送、发布或修改真实评审服务的授权。后续按用户要求交付，合并时保留 `--no-ff` 历史。

迁移时的主线基线记录位于原 worktree 的 `.scratch/go-migration-baseline/`：`baseline.json` 保存提交、Node 版本、锁文件摘要及既有调研文档摘要；`node-tests.tap` 保存该阶段 Node 测试输出。该阶段 Node 测试退出码为 0：204 项中 202 通过、2 跳过、0 失败。这些是本机材料，不会自动随分支提交。沙箱内首次尝试因禁止监听本地端口失败，日志单独保留，不计作产品失败；迁移后应复跑相同用例。

## 技术决策

采用 Go 后端、官方 Go MCP SDK、现有 React/TypeScript 页面和嵌入式静态资源发行；见 [ADR-0001](adr/0001-go-backend.md)。优先使用标准库和明确需要的依赖；多语言结构解析器须单独验证兼容性及构建依赖，不预先承诺 Tree-sitter/Cgo 的跨平台行为。

前端继续保留外观、中英文、流程图、节点窗口/侧栏、代码页、上下文扩展与差异总览。用户运行程序无需安装 Node/Go；开发与 CI 中的前端构建工具不属于用户运行时依赖。

## 第一阶段：行为等价迁移

| 范围 | 迁移前实现 | Go 迁移保留的能力 |
| --- | --- | --- |
| HTTP、静态网页及资源 | `server/runtime.ts`、`server/api.ts` | 路由、错误、响应编码、长轮询、健康检查、受控停止、手机/Tailscale 网页访问 |
| 会话与数据 | `server/session-store.ts`、`server/publication.ts` | 固定 B、R1/R2 快照、批注/回复、提交/领取、归档/恢复、来源校验、原子持久化 |
| MCP | `server/mcp.ts`、`server/mcp-tools.ts` | 现有工具名和参数、HTTP 传输、取消/断线、长时间人工等待、明确领取 |
| CLI 与后台管理 | `bin/main.ts`、`bin/logic-margin.ts`、`server/daemon.ts` | 源码核验、启动/复用/停止、进程身份与锁、配置流程和退出状态 |
| 共享运行时逻辑 | `src/model.ts`、`src/workspace.ts`、`src/revisions.ts`、`src/session-lifecycle.ts` | 数据校验、状态转换、反馈包与通过记录、逻辑身份和轮次规则 |
| 发行与安装 | [历史 Node 打包器](https://github.com/SunneeYang/LogicMargin/blob/13e5150631dcfcedec9182b1de221815a8257d71/scripts/package-agent.mjs)、Release workflow、插件技能入口 | Go 可执行文件、内嵌网页、按 OS/架构选包、校验与版本信息；发行入口不回调 Node |

迁移阶段曾保留 TypeScript 后端和测试作为兼容 oracle；当前已删除旧实现，保留固定历史 JSON/gzip/catalog 契约，开发与测试统一使用 Go。

## 必须保持的兼容语义

1. **等待与领取分开。** MCP `wait_review` 交付固定记录，`acknowledge_review` 才领取；普通 CLI `wait` 的默认领取行为也要分别验收。取消、断线和停机不消费反馈，停机需结束在途请求而非让客户端等待到超时。
2. **同会话更新保持串行。** 读取、校验版本/轮次/指纹、修改和原子落盘属于同一串行操作。保留冲突拒绝、提交幂等、不可变快照、缓存/磁盘一致性和单写后台锁。
3. **保持跨语言字节协议。** JS 长度和源码坐标按 UTF-16 口径处理，不可直接替换为 Go byte/rune 数。源码摘要、来源路径排序、JSON 指纹字节、HTML 转义、可选字段与字段顺序须有中文、emoji、`&<>`、LF/CRLF 等固定向量。
4. **保持历史证据范围。** 0.8.7 明确只展示保存的源码片段，不从当前工作区补取内容混入历史评审；总览定位该片段，统一/并排共用单一竖向滚动入口。
5. **保持数据与入口兼容。** 不通过清理真实会话、重建用户数据或修改现有服务来证明迁移成功。Go 程序需要读写既有格式，协议错误及前端包装文案也要对齐。

迁移以既有测试和固定输入作为行为依据。JSON 可比较结构化业务数据；摘要、来源指纹、源码及明确的字节契约要求字节一致。时间与随机 ID 仅按明确字段归一化，不能宽泛忽略输出差异。

## 第二阶段：服务端代码 diff 与流程图预计算

第一阶段通过后实现独立的派生结果服务，协议与预算见 [后端预计算](backend-precompute.md)：

- 固定源码就绪后预计算常用的 B→当前轮次、上一轮→当前轮次；其他旧会话或比较组合首次按需补算并缓存。
- 当前代码 diff 使用 Go 原生行级 Myers 与字符细分，结果绑定源码摘要、语言和算法版本，输出 UTF-16 范围与精度标记；批注变化不使结果失效。普通 diff 的对齐范围不承担移动识别；后续新增的独立结构重点和移动局部对照见 [结构 diff](structural-diff.md)，其预算与验收单独记录。
- 使用受控后台并行计算，保持会话读写响应。并行可重叠耗时，但不保证发布等待完全不增加。
- 前端的并排、短统一和长统一视图消费同一服务端结果，保留 CodeMirror 的折叠、总览、排版与语法着色；旧服务、离线和计算失败时保留本地回退。
- 流程图后端计算节点位置、正交路由、端口和标签；浏览器测得真实尺寸后重新请求，批注、选中和流光不使几何缓存失效。

此阶段的算法选型不包含复制 SemanticDiff 闭源实现，也未决定采用 OmniDiff。此前调研与阶段性能记录保留在原主线 worktree，不能把其解析参考耗时当成 Go 或完整语义算法的性能承诺。

## 后续规划：多用户同时审查

Go 迁移也为多用户同时审查做准备。2026-11-09 用户明确：本次只需知悉和记录，迁移完成后独立评估；本轮不实现账号、权限、在线状态、多人编辑或协作协议。

迁移保留既有会话 ID 隔离、版本冲突检查、同会话写入串行化和可取消等待。不同会话可并发处理。未来评估需单独覆盖身份/权限、同条批注或轮次提交冲突、事件分发与恢复、多进程写入等；不能将 goroutine 或多个 HTTP 连接作为多人协作已完成的证据。

## 对比与验收

### 功能与运行时

- 对同一套固定输入执行 Node 与 Go：评审创建、补录 B、批注/回复、提交、等待、领取、修订、历史、归档、恢复与清理。
- 覆盖并发冲突、幂等重试、取消/断线、停机重启恢复，以及来源摘要/指纹不一致的拒绝行为。
- MCP 单独验证工具清单、长等待、取消后重新等待、明确领取和停机错误；CLI 与 MCP 的消费语义不混用。
- 从仓库之外运行发行包，在 PATH 不包含 Node/Bun/Deno 的环境中验证 CLI、后台、内嵌网页、HTTP MCP、来源核验和完整评审闭环。Git/宿主 Agent 按实际工作流提供，不把它们误算为 JavaScript 运行时。
- 浏览器对同一数据、同一外观/语言/设备验证功能；跨平台构建成功与目标平台运行结果分别记录。

### 性能

同机、同输入、同并发和冷/热状态分别记录：启动/就绪、发布准备、diff 结果可用、API 延迟、浏览器首次显示、切场景/切节点、进程 CPU/RSS、缓存占用、程序及归档体积。包含小节点片段、真实完整文件和现行源码长度上限附近的控制例。

先比较 Node 与行为等价 Go，再比较 Go 启用/关闭预计算；不将 Node 内存函数、CLI 全程和浏览器渲染时间直接相除。手机实测与 CPU 节流模拟分开，未测项明确列出。

### 运行隔离

对比实例分别使用独立数据目录、临时端口和进程锁，记录真实返回的监听地址。真实会话只在需要时复制到实验目录读取，不让两个实现同时写同一目录，不执行会改动用户全局 MCP 注册或正式服务的步骤。

## 当前状态

- [x] 固定基线并创建 `arch/go-backend` 分支/worktree。
- [x] 记录迁移决策、模块范围及功能/性能对比方法。
- [x] Go 后端、MCP、CLI 与原生发行候选实现。
- [x] 本机 Node/Go 主要业务、现用 MCP 协议与旧数据兼容验收；兼容边界另列。
- [x] 服务端普通 diff、结构重点/明确移动局部对照、流程图预计算，以及三种代码视图和画布适配。
- [x] 本机基础启动/读取测量与五目标交叉构建。
- [x] Node/Go 及结构候选的本机浏览器性能对照，原始样本与范围见验收文档。
- [x] macOS、Linux、Windows 原生 CI、74 项 Linux 网页验收与五目标 ZIP 构建；具体范围见[发行前平台门禁](go-backend-validation.md#090-发行前平台门禁)。
- [ ] 服务 CPU/峰值 RSS、写入/发布负载及其他目标平台实际运行对比。

0.9.2 的正常发行入口为 Go，Git marketplace 通过 `.sh` / `.ps1` 启动器下载并校验与插件固定版本一致的官方原生包；平台 ZIP 直接运行包内程序。旧 Node 入口现已删除。现有安装升级需先识别并停止身份确认的旧后台、备份并保留实际会话目录，再重启与重连 MCP，详见 [升级与数据连续性](agent-plugin.md#升级与数据连续性)。

## 当前开发与发行入口

Go 运行时模块位于 `internal/review`、`internal/agent`、`internal/service`、`internal/daemon`、`internal/mcpconfig`；`cmd/logic-margin` 是唯一程序入口。HTTP/MCP 与 CLI 复用同一套评审操作；后台管理只在终端入口解析，避免 Go 包循环依赖。

开发与构建需要 Node.js 和 Go；发行程序运行不依赖这些工具。`npm test` 覆盖 Go 后端与前端；`npm run review --` 构建当前源码 Go CLI。Node 只负责构建和子进程编排。以下命令用于 Go 路径；本地 AGENTS 要求 harness 时须包裹执行，公共构建本身不依赖该工具：

```sh
npm run build:go
npm run package:agent -- --target linux-x64
env GOWORK=off go test ./... -count=1
npm run test:go:agent
npm run test:go:compat
npm run test:go:e2e -- tests/session.spec.ts tests/baseline-review.spec.ts tests/session-lifecycle.spec.ts tests/round-finish.spec.ts tests/code-context.spec.ts tests/code-overview.spec.ts --workers=4
```

发行 tag 为 `v0.9.2`，五目标 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-x64` 各生成 `logic-margin-agent-0.9.2-TARGET.zip` 及同名 `.zip.sha256`。包内直接运行 `scripts/logic-margin`，Windows 为 `scripts/logic-margin.exe`；PowerShell 用 `& $LM_CLI`。完整使用方式见 [原生插件说明](go-agent-plugin.md)。[发行前平台门禁](go-backend-validation.md#090-发行前平台门禁)已在三类操作系统 CI 执行；五目标交叉构建仍不能替代每种架构与真实设备验收。下面的 macOS ARM64 记录属于迁移阶段的历史范围。

实现过程中修复了两个独立边界：进程锁先在临时目录写好 owner，再以系统不覆盖重命名原子公布，并绑定目录身份进行回收/释放，避免并发回收旧锁产生第二个 Go 写入者；Codex 配置命令由 Unix 进程组或 Windows Job 管理，关闭空闲管道、限制等待并回收包装器的子进程。macOS 的并发锁回收、目录替换释放、包装器超时回归与 race 检查已通过；其他平台的实际运行仍以最终验收记录为准。


## Go-only 开发与测试

从 `13e5150631dcfcedec9182b1de221815a8257d71` 冻结兼容 oracle 后，移除 `server/`、`bin/`、Node/Bun 打包器和 Node 专属 inspector/IPC 性能脚本。唯一后端/CLI 是 `cmd/logic-margin`；前端、DSH JS 适配器、Goja 算法 bundle 和 V8 布局 oracle 保留。

- `npm run dev`：构建当前 Go，前台进程使用私有临时 registry，Vite HMR 同源代理 API/MCP；开发数据仍默认工程 `.logic-margin/sessions`，`LOGIC_MARGIN_DATA_DIR` 可覆盖。Go 编辑后重启。
- `npm run review -- ...`：构建当前源码 Go CLI，参数和退出状态直接转发。连接开发代理时显式 `--url http://127.0.0.1:5173`。
- `npm test`：Go 后端与前端；`npm run test:e2e` 默认真实 Go 内嵌网页，不再选择 Node 后端。
- `npm run test:go:compat`：固定旧 JSON/gzip 与真实进程竞争/崩溃恢复；`npm run test:agent`：无 Node PATH 的原生包闭环。
- `LOGIC_MARGIN_TEST_CODEX_MCP=1 npm run test:codex`：私有 CODEX_HOME 的真实 Codex 发现、崩溃错误、超过 65 秒等待和 TOML 保留，零模型 turn。
- `precompute-benchmark.mjs`、`structure-diff-benchmark.mjs`：独立 Go 进程创建种子，停止后只复制权威 session JSON，计时进程不 create/GET 触发预热；保留 miss/memory/disk 和 fallback 断言。HTTP wall 不是 Go CPU。

历史数字只代表原测量。固定 review oracle/旧 gzip 是已中和并重新生成的样例，不宣称原始 0.8.7 文件字节未变；来源与摘要见 `internal/review/testdata/README.md`。MCP catalog 在删旧代码前由旧 SDK oracle 捕获，见 `internal/service/testdata/README.md`。
