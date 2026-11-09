# 结构感知 diff 实施契约

本阶段在 `arch/go-backend` 上独立实现，参考已观察到的 SemanticDiff 阅读收益；不调用或复制其闭源引擎。保留完整文本差异，结构结果不改评审/历史 JSON，也不补读工作区源码。

## 接口

`GET /api/precompute` 新增可选 `structureAlgorithm`。`POST /api/review-sessions/{id}/precompute/structure` 与 `/diff` 使用完全相同的保存快照/证据引用请求。两接口独立、可并行；文本先显示，结构到达后提供重点模式。旧服务或任何结构错误保留文本阅读。

响应（UTF-16 坐标，结束不包含）：

```ts
type Range = { from:number; to:number }
type Highlights = { before:Range[]; after:Range[] }
type ScopePair = { id:string; kind:string; name:string; before:Range; after:Range }
type Move = ScopePair & { modified:boolean; highlights:Highlights; comparison:ComputedDiff }
type StructureResult = {
 schemaVersion:1; algorithm:string; key:string; language:string; coordinate:'utf16';
 before:{digest:string;length:number}; after:{digest:string;length:number};
 mode:'structural'|'text';
 reason?:'unsupported-language'|'invalid-syntax'|'budget'|'syntax-boundary';
 parsedAs?:{before:string;after:string}; formattingOnly:boolean;
 highlights:Highlights; scopes:ScopePair[]; moves:Move[];
}
```

`ComputedDiff` 为现有普通 diff DTO，移动比较只包含两侧保存范围的切片及其文本 diff，不再向服务上传切片。Move.highlights 相对移动块切片；顶层 highlights 相对完整保存片段。结构高亮不要求未变间隙文本相同，不能直接拿它替换 CodeMirror 全文对齐的 Change[]。完整文本 diff 仍负责行号、折叠和对齐，结构只改变强调方式和补充移动/作用域信息。

## 语言适配与安全边界

内部 `structure.Parse(ctx,source,language) (Document,error)` 返回 Token（From/To/Key/Boundary）、非重叠有名 Scope（Kind/Name/From/To/Shape）、全树 Shape 与 ParsedAs。Key 保留字符串、正则、模板、注释、标识符、数字、操作符和类型文本；只规范化能安全忽略的空白。Go 使用标准 scanner/parser；JS/TS/JSX/TSX 使用已有 Lezer grammar 在 Goja 中执行，无 Node/CGo 运行时。

Go 可在受限虚拟 package/函数中解析保存片段，ParsedAs 必须区分 file/declarations/statements，所有坐标映射回原文，不能输出虚构父函数作用域。Go 自动分号、JS restricted-production 换行与 ++/-- 等敏感边界须保守保留；无法安全归一化时用文本模式。相同 token 流但结构不同不能称为仅排版。

解析器必须检查错误恢复节点、token 覆盖/非重叠、UTF-16 边界与上下文取消，不能把未覆盖的语法字符当空白丢掉。预算用尽或解析失败明确回退。作用域先按唯一 kind/name 配对；只对相对次序确实变化的明确配对标移动，普通行号偏移不是移动。重复定义、重复正文和不确定配对不强行输出移动。

后端保留既有有限 worker、缓存、在途去重和独立订阅取消；结构 key 单独绑定解析/匹配算法与输入摘要。前端不能因结构结果晚到而丢失展开、滚动、选择或草稿。


## 阅读方式与保守边界

默认显示完整文本差异，结构结果就绪后显式点击“结构重点”；可以随时切回“文本差异”。结构结果只重配高亮、总览标记及导航，不重建 CodeMirror、不修改原文对齐或读者已经展开的范围。移动代码提供“与原位置对照”，内容来自两个固定保存片段，行号换算回各自原文件；不会上传切片或读取工作区补全。

作用域仅提取 Go 顶层函数/方法、JS/TS 文件级具名函数及安全具名类方法。导出函数包括完整 export 包装，避免导出标记改挂到其他函数时漏报；控制流内函数、命名表达式、ambient/装饰器/计算方法不参与移动配对。重复名称或重复正文保留文本强调，单纯行号偏移不算移动。字符串、正则、模板、JSX 文本、注释及类型变更都保留。Go 在完整解析和原文覆盖校验后只规范化 `)` / `}` 前可省略的分号，其他敏感边界变更继续使用文本模式。

适配器每侧约 750ms，组合分析最多 3s；匹配最多 40000 token、256 个作用域、32 个明确移动，超出返回 `mode:text, reason:budget`，不能截断移动列表后隐藏剩余变化。语法无效、截断片段、不支持语言和不确定的语法边界也保留文本。结果与回退结果都按算法/源码独立缓存；同一输入的预算回退不会在每次打开时重复重算。它是语法结构阅读辅助，不做类型检查、调用绑定或通用语义等价判定。

Go 原生 scanner/parser；JS/TS/JSX/TSX 复用既有 MIT Lezer grammar，在 Goja 中运行。构建时生成独立 bundle 并校验摘要，发行运行时无需 Node/CGo。解析器的边界测试和微基准见 [adapter README](../internal/structure/README.md)。


## 本机联合验收与开销

2026-11-09，Apple M4 Pro/macOS arm64、Go 1.27.3、Chrome 156.0.8078.75。Go 全量 race/vet、TypeScript、bundle 一致性检查通过；Node 230 项测试中 228 通过、2 项按配置跳过；74 项 Chrome 验收通过（73 项组合回归，另 1 项模拟缺少 crypto.subtle）。覆盖保存来源绑定、三种视图消费不同的合法结构高亮、移动局部原行号、跨节点迟到、语言/滚动/选区/多次展开保留、总览焦点，以及旧能力/503/不支持语言/无效语法/预算回退。长视图状态用例使用合成注释填充，密集语法的成本由下表独立测量。

6 项无 Node 发行闭环、3 项 Node/Go 兼容通过；5 个目标均 CGO_ENABLED=0 编译，只有 macOS arm64 实际执行。独立候选 ZIP 位于 `artifacts/structural-candidate/`，未安装到正式插件或服务。

### 独立结构接口

冻结的旧 Go 程序不提供结构能力，记录为 unsupported；新旧普通文本 diff 均保留。下列为完整 identity HTTP 响应耗时，包含保存片段解析、调度、计算/缓存和序列化，不包括浏览器绘制或响应 JSON 解析。每格 miss/disk 各 1 次，memory 为 10 次中位数；OS 缓存未清空。结构请求在普通 diff 之后顺序测量，保存会话读取缓存已受前一请求影响；不能相加作为页面等待时间，也不能当成 Go CPU。

| 输入（UTF-16 单元，函数数） | 结构首次 miss ms | memory 中位 ms | 重启 disk ms | 实际结果 |
| --- | ---: | ---: | ---: | --- |
| go 841，3 | 5.81 | 0.26 | 0.70 | 结构＋移动并修改 |
| go 12216，43 | 12.89 | 0.27 | 0.38 | 结构＋移动并修改 |
| go 95049，80 | 26.59 | 0.42 | 0.51 | 结构＋移动并修改 |
| ts 955，3 | 111.94 | 0.30 | 0.31 | 结构＋移动并修改 |
| ts 12110，37 | 564.10 | 0.30 | 0.34 | 结构＋移动并修改 |
| ts 96061，78 | 758.24 | 0.38 | 0.40 | 文本回退：budget |

六组中五组得到完整结构结果，TS 近 100k 组达到解析预算，明确算作回退。Go 原生解析在这批输入下开销较低；Goja+Lezer 的 TS 冷计算明显更贵，尚不能说任意大文件都能获得结构结果。缓存与后台预热降低重复阅读成本，没有消除首次 CPU/内存消耗。普通 diff 的首次 HTTP 样本旧版约 3.70–8.20ms，新版约 3.55–8.13ms；每格只有单次 miss，不据此宣称加速。

### 默认文本阅读是否变慢

使用之前同一份 1,504,100 字节固定评审（SHA-256 `103032fc51882b208eb58cd624f12cc93ab7441f8ff449660cb31f7a08a9d0eb`），每版 7 轮、轮换顺序、串行空载采样。1440×1000、中文、纸页浅色、reduced motion；既有样片含两个场景与实际历史 App.tsx 保存片段。此对照只证明默认文本、画布和切换阶段的成本，结构准确性由上面的专用用例验证。

| 页面指标，中位 ms（p95） | 旧文本基线 | 结构候选 |
| --- | ---: | ---: |
| 首次画布 | 194.2（216.5） | 189.8（211.7） |
| 重载 | 128.7（130.6） | 127.6（128.5） |
| 首次切场景 | 98.2（100.0） | 98.8（99.1） |
| 统一 diff 首开 | 98.1（100.1） | 98.9（99.9） |
| 切并排 diff | 81.7（83.2） | 81.1（82.3） |

14 个样本全部通过，未观察到默认文本首开的明显回退；7 样本 p95 实际为该组最大值。diff 首开浏览器 ScriptDuration 中位约 35.96→35.63ms，不能据此推断服务 CPU。TS 结构结果首开数百毫秒与默认文本约 99ms 是两个不同的完成条件。

本轮未测 Go 服务 CPU/峰值 RSS、多人负载、真实手机/Tailscale HTTP、普通动效、Safari/Firefox 或 Windows/Linux 原生运行。缺少 crypto.subtle 的浏览器用例是条件模拟，不是跨机网络验收。

原始样本、固定输入摘要与二进制清单位于 [性能材料](../artifacts/performance/structural-diff-20261109/)。复现脚本为 `scripts/structure-diff-benchmark.mjs`（显式传 LOGIC_MARGIN_GO_BASELINE_BINARY / LOGIC_MARGIN_GO_BINARY）和既有 `scripts/benchmark-review-browser.mjs`；均只测量、不构建，须用 agent-tmp-run 包裹。

旧程序 SHA-256：`d1d05f00e9d12317b1fff139fc354e388e33ab6ed0aca2dbded44db6c3ac06e4`。新程序：`3e3767ff432dbebb10c8281fe24d35f72316dcb878a417638ca5ab7a4355479a`。采样时工作区尚未提交，未推送、发布或修改正式服务。
