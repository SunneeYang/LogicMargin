# 后端预计算协议与实施范围

2026-11-09，`arch/go-backend`。迁移补测已完成：修复 Windows 原子写重命名前未关闭句柄的问题，全量 race、3 项 Node/Go 对照（含并发启动/强制崩溃恢复）、6 项无 Node 发行闭环通过。本机仍只在 macOS 实际运行，Windows/Linux 原生运行和真实宿主长等待保留待验收。

当前候选实现普通代码 diff、独立的结构重点，以及流程图布局/路由。批注、选中、流光、视口变化不使计算缓存失效。结果存储在独立的派生缓存，不改变评审或历史 JSON，不读取当前工作区补充历史源码。

## HTTP 契约

- `GET /api/precompute`：`{schemaVersion:1,diffAlgorithm:string,layoutAlgorithm:string,structureAlgorithm?:string,coordinate:'utf16'}`。旧 Node 不提供该接口；客户端在旧服务、本地导入、离线或计算失败时保留原本地算法。
- `POST /api/review-sessions/{id}/precompute/diff`：只提交以下引用，服务读取该会话已保存的原文。`beforeSnapshot/afterSnapshot` 是 `{kind:'baseline'}` 或 `{kind:'round',round:number}`；使用真实存储轮次，不使用显示的 R 编号。`before/after` 各为 `{path,symbol,startLine,endLine,digest}`。代码页的上一轮是 `activeRound-1`，不能误用最新轮次的 publication.baseRound。
- `POST /api/review-sessions/{id}/precompute/structure`：与 `/diff` 使用相同的保存快照/证据引用，另行返回语法 token 重点、明确的作用域移动及移动切片对照。文本先显示，读者显式切到结构重点；协议和保守回退见 [结构 diff](structural-diff.md)。
- `POST /api/review-sessions/{id}/precompute/layout`：布局输入见下；只发送布局实际使用的节点字段、连线和尺寸，不发送证据源码或批注。当前会话、本轮/历史与比较图选择由调用方提供的实际图数据确定。

这些 POST 使用原有同源检查、JSON/请求大小校验及取消传播。响应头 `X-Logic-Margin-Cache` 标识计算命中情况，供验收使用。界面不显示实现细节。非会话本地导入不会自动上传到后端。

## diff 结果

```ts
interface ComputedDiff {
  schemaVersion: 1
  algorithm: string
  key: string
  language: string
  coordinate: 'utf16'
  before: { digest: string; length: number }
  after: { digest: string; length: number }
  precise: boolean
  changes: { fromA: number; toA: number; fromB: number; toB: number }[]
}
```

范围从 0 开始、结束不包含，按 UTF-16 单元计数；有序、不交叠、不切断 surrogate pair，未变间隙与尾部必须相同。算法有预算限制，超限回退为正确但较粗的范围并返回 `precise:false`。普通 diff 不承担移动识别；结构增强使用独立结果，不能替换全文对齐范围，也不宣称与 SemanticDiff 等价。

三条视图均在异步结果就绪后，通过 CodeMirror `DiffConfig.override` 使用范围，不能先运行本地 diff 再覆盖。override 每次返回新的 `Change[]`，避免 CodeMirror 展示整理修改缓存。精度取后端值；长统一视图的 `Chunk.build` 也必须使用 override。折叠、总览、语法着色和像素滚动继续由浏览器处理。

## 布局输入与结果

```ts
type PlanNode = { id:string; kind:'action'|'decision'|'result'|'failure';
  position:{x:number;y:number}; title:string; summary:string }
type PlanEdge = { id:string; source:string; target:string; label:string }
type LayoutInput = { nodes:PlanNode[]; edges:PlanEdge[];
  reference?:{nodes:PlanNode[];edges:PlanEdge[]};
  sizes:{id:string;width:number;height:number}[] }
type ComputedLayout = { schemaVersion:1; algorithm:string;key:string;
  nodes:Record<string,LayoutNode>;edges:Record<string,LayoutEdge>;
  usesAuthoredPositions:boolean }
```

`LayoutNode/LayoutEdge` 与 `src/graph-layout.ts` 一致。比较图调用现有 `comparisonLayout(nodes,edges,reference.nodes,reference.edges,sizes)`，保留 canonical union、共同槽位与重定向连线身份。实际尺寸变化重新请求精确布局；正常 Go 路径不先运行本地 Dagre。鼠标抬升时真实 handle 的首尾点修正与圆角路径仍在浏览器完成。

布局优先使用 Go 原生端口/正交路由实现，保留 authored 坐标、比较图 canonical union 和现有标签/返回/异常连线规则；坐标不可用或单节点时回退到 Goja 中的原 Dagre 与路由。Goja 执行构建时生成的无 DOM bundle，不启动 Node/Bun。Program 共享，每次后备任务创建独立 Runtime，并用 context Interrupt 限时。原生和 V8 固定向量同时比较位置、端口、标签、数组顺序与错误，避免仅比较截图。

内部 ID 的 tie-break 改用固定 UTF-16 字典序，而非依赖系统 locale/ICU 版本的 localeCompare。新 emoji 在 V8 与 Goja 的旧 Unicode 排序表中曾导致不同槽位；这项明确的排序变化消除了跨运行时漂移，特殊 ID 的同分排列可能与旧主线不同。用户可见文字排序不受影响。

构建入口会更新 bundle；CI 的 `--check` 拒绝陈旧产物。算法 key 绑定 TS bundle、原生路由源码摘要和 Goja 固定版本。Goja 要求 Go 1.26，因此开发/CI 最低 Go 版本提高到 1.26；用户只运行独立程序。

## 缓存与预热

key 绑定 schema、算法版本、原文摘要/语言或实际几何输入及参数；布局算法版本包含 bundle、原生源码与后备运行时指纹。LRU、磁盘缓存、在途去重和有限 worker 防止无界堆积。同一任务的一个订阅取消不取消其他订阅；服务关闭取消计算。派生文件损坏可重新计算，缓存写失败不影响有效结果或评审保存。

创建、发布、补基线及旧会话首次读取后，后台预热常用 B→当前、上一轮→当前的唯一片段组合以及各场景的默认尺寸布局。选中目标才可唯一配对的片段、阅读子图和真实尺寸按需计算并复用缓存。普通批注变化不重复预热。预热在独立 goroutine 执行；独立文本 diff/结构/布局任务最多由 3 个后台调用者并发派发到原有计算池，CPU 配额较小时降低并发，常规四 worker 配置保留交互容量。基线/记录读取只在锁内复制所需对象，避免完整历史克隆。引用收集最多访问 4096 项，配对最多执行 65536 步且可取消；超出时跳过可选预热，按需接口保持可用。预计算仍有实际 CPU、内存和首个结果延迟。

资源限制为最多 4 worker、32 个排队任务、64 MiB 在途输入，单任务 4 秒；内存 LRU 为 32 MiB/64 项，磁盘为 128 MiB/1024 项，单结果最多 8 MiB。源码两侧各最多 2000 行/100000 UTF-16 单元；布局两侧合计最多 512 节点、1024 边，并受 `节点×边×(节点+边)≤8000000` 工作量上限限制。后备 VM 没有独立进程级内存硬限制。

缓存只回收严格命名、已确认 owner 进程退出的临时文件；活动进程和无法确认归属的文件保留；它们不计入最终缓存文件的 128 MiB 预算。正常缓存损坏重算，缓存不可写也返回有效计算结果。客户端能力探测 2 秒、计算 HTTP 8 秒超时后回退；服务恢复后，能力探测失败的页面需刷新才重新探测。

最新完成状态、实际测量及未验收范围见 [迁移验收](go-backend-validation.md)。
