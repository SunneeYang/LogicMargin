# 评审 JSON 格式

生成或更新流程图时使用本页。以下字段对应 LogicMargin 的 `schemaVersion: 1`；CLI 会在发起或发布前校验文件。所有字段均必填，除非标注可选。正文为普通文本，网页不会执行其中代码。

## 文档与源码快照

```ts
type ReviewDocument = {
  schemaVersion: 1
  id: string
  title: string
  description: string
  revision: string
  snapshot: {
    repository: string
    commit: string
    fingerprint: string
    capturedAt: string
    dirty: boolean
    files?: { path: string; sha256: string }[]
  }
  coverage: { included: string[]; excluded: string[]; note: string }
  scenes: Scene[]
  nodes: Node[]
  edges: Edge[]
  comments: Comment[]
  baseline?: Omit<ReviewDocument, 'baseline'>
}
type Scene = { id: string; title: string; description: string }
```

- `id` 标识同一评审，跨轮保持；`revision` 标识当前逻辑内容，修改后更新，不能把轮次当作 Git commit。
- `snapshot.repository` 写真实来源仓库或工作区；`commit` 写当前 HEAD。无版本库时明确标注 `unversioned`，并在 `coverage.note` 解释来源。
- `capturedAt` 使用 ISO 日期；`dirty` 根据当前工作区事实填写，指纹必须包含本次覆盖的未提交内容。
- `snapshot.files` 建议显式列出受覆盖源码和文档，使用规范的工作区相对路径和文件原始字节的 SHA-256。将 `{path, sha256}[]` 按路径排序，对其 `JSON.stringify` 的 UTF-8 字节计算 SHA-256，作为 `snapshot.fingerprint`；CLI 固定采用 `sha256-path-content-v1`。未提供 `files` 时，以图内依据涉及的文件为清单；至少需要一个实际来源文件，设计评审也可列出真实设计文档。
- `coverage.included` 列出实际展示的行为；`excluded` 列出未覆盖路径和依赖；`note` 说明数据来源、摘要规则、未运行的验证等限制。展示成功不等于业务验收通过。
- 新评审的 `comments` 使用 `[]`。CLI `start --purpose TEXT [--context ID]` 将目的和上下文作为会话的 `scope` 保存，并清空输入包的旧批注；每次 start 生成独立 session ID。同一 `ReviewDocument.id` 可用于不同目的的独立评审，批注按 session 隔离。旧会话继续使用 `revise`，服务端会合并已有评论；保留从 `get` 取得的评论也可以，但不要自行重写原意见、回复 ID 或人工状态。

## 固定基线 B

B 保存本任务开始前的完整流程图，R1 保存本次修改后的第一次评审图。后续 R2、R3 继续相对 B 展示本任务的全部变化，也可相对上一轮评审核对新变化。B 与评审轮次分别保存。

已有改动时，准备 B 与当前实现两份图，从 R1 开始审查。需要先基于原系统讨论改造时，用原版图执行 `start before.logic-margin.json --source-root /workspace/original --baseline-review --purpose "在原系统上提出改造"`。此模式核验原版一次后自动固定为 B，并保存会话选项 `baselineReview: true`。它与独立 `--baseline-file` / `--baseline-source-root` 互斥，输入图从空批注开始。B 上保存的意见带 `basis: 'baseline'`，固定 B 图本身的 `comments` 仍为空。

基线评审模式的首个持久化轮次用于 B，第一次 `revise` 后的持久化轮次用于页面 R1，随后对应 R2、R3。CLI/MCP 的 `round` / `base_round` 始终使用服务返回的持久化轮次，响应保留 `baselineReview` 标识。Agent 收到 B 的意见后，先实际修改和验证业务源码，再核验并发布实现图。

生成代码改动评审时，先确定每个来源仓库的 Git 基线及本次覆盖范围，在独立旧树中实际读取原版代码，生成 B 的场景、规则、失败出口和源码依据，再从当前树生成 R1。多仓库任务分别冻结各仓库版本，在 `coverage.note` 记录基线和来源根目录的对应关系。文件摘要和补丁哈希用于核验材料身份，旧规则须据原版源码生成。

`baseline` 为可选的完整 `ReviewDocument`，其 `id` 与当前评审相同，`comments` 使用 `[]`，其中不含另一个 `baseline`。修改前后同一业务对象沿用同一节点和连线 ID。CLI 的 `start` 与 `verify` 可以分别读取两份图和两棵源码树。

```sh
start current.logic-margin.json --source-root /workspace/current --baseline-file before.logic-margin.json --baseline-source-root /workspace/before --purpose "核对本次修改"
verify current.logic-margin.json --source-root /workspace/current --baseline-file before.logic-margin.json --baseline-source-root /workspace/before
```

外部 `--baseline-file` 必须配合 `--baseline-source-root`。图中已嵌入 B 时，只需显式提供 `--baseline-source-root`。两份图分别核验文件字节、源码片段和指纹，任一核验失败均停止创建。合并后的评审文件仍受 10 MB 总大小限制。`verify` 的输出在当前图核验结果外增加 `baseline` 核验结果。正常 `revise` 省略 B 即继承固定基线，若携带 B，内容须与已保存的 B 相同。

旧会话缺 B 时，使用 `baseline SESSION_ID before.logic-margin.json --source-root /workspace/before`，或 MCP `attach_review_baseline`。它先核验旧树，再以已读版本补录到原会话，保留当前轮次；相同 B 可重复提交，其他 B 会产生冲突。补录前的旧固定意见包仍记录其提交时的材料。网页对缺 B 的旧会话显示“未提供修改前基线”。

## 步骤、状态和连线

```ts
type Node = {
  id: string
  sceneId: string
  title: string
  kind: 'action' | 'decision' | 'result' | 'failure'
  summary: string
  detail: string
  input: string
  output: string
  position: { x: number; y: number }
  evidence: {
    path: string
    symbol: string
    startLine: number
    endLine: number
    digest: string
    code?: string
  }[]
}
type Edge = {
  id: string
  sceneId: string
  source: string
  target: string
  label: string
  detail: string
}
```

- 每种对象内的 ID 唯一；`sceneId` 必须引用现有场景，连线两端必须是同一场景内现有节点。业务对象改名或重排仍保留 ID，新的业务对象才新增 ID。
- `summary` 简述该步；`detail` 写规则与条件；`input/output` 写执行前后数据或资格变化。判断的分支在连线中标明条件，拒绝、失败和无副作用出口也应展示。
- 布局建议每个场景从上向下排列，普通相邻节点纵向间距约 180–240；分支横向错开。坐标仅用于排版，批注锚定 ID。
- `evidence.path` 使用来源工作区相对路径，且属于 `snapshot.files`；`symbol` 写真实函数或符号。行号从 1 开始且包含两端，`digest` 使用 UTF-8 片段的 SHA-256：将 CRLF 统一为 LF，按 `split('\n').slice(startLine - 1, endLine).join('\n')` 取片段后计算，不额外加入末尾换行。节点跨多个实现点时分别列依据。
- `evidence.code` 可选，保存上述行号范围的原文，用于节点内的代码对照。CLI 在来源核验全部成功后，从同一份已核验字节自动捕获，随基线或轮次快照保存；不要另行编写或概括代码。每段最多 100,000 字符、2,000 行，超限时保留源码位置和摘要但不嵌入文本。提供文本时必须有对应 `snapshot.files`，其行数和 SHA-256 必须匹配依据。旧文件缺少文本仍可导入，界面明确提示缺少快照，不读取当前工作区替代历史代码。
- 尚无源码的设计节点可用空 `evidence`，但应在节点说明和覆盖范围标明“设计/待实现”，不能伪造源码位置或摘要。

## 来源核验与新版发布

`verify <review.json> --source-root <workspace>` 核验实际文件、所有图内片段和指纹；只读，不替代理更新文件或判断业务语义。来源根目录默认当前工作目录；清单路径和符号链接必须留在该目录内，每文件最多 10 MB、总计 64 MB。

`start --source-root`、`baseline --source-root` 和 `revise --source-root` 会把已核验的源码片段连同清单保存到会话；`verify` 仅核验并输出清单，不重写输入文件。代码页签比较节点在两份固定快照中关联的片段；新增或取消源码关联不等于源文件中的代码新增或删除。

旧会话的固定基线若未保存 `code`，需从对应版本核验源码，重新发起包含代码快照的评审；重新执行 `baseline` 不能补写或替换已有固定基线。

`revise SESSION_ID <review.json> --base-round NUMBER --summary TEXT` 自动再核验，将核验后的 `files`、发布基线及说明保存到本轮快照。`NUMBER` 必须是代理从 `wait` 或 `get` 核对并实际处理的轮次；当前轮次已变化时重新读图处理，保留旧草稿的真实基线。逻辑未变时必填 `--unchanged-reason TEXT`，明确仅改依据、格式或说明的范围。

最终回应使用 `--replies-file <JSON file>` 随新版原子发布，格式如下；每个 `commentId` 必须引用已有线程：

```json
[
  { "commentId": "原批注 ID", "body": "实际修改、验证结果及剩余限制。" }
]
```

发布失败不会生成下一轮或部分最终回应。独立 `reply` 仅用于处理中交流；新版发布前，人工也不能确认解决或整轮通过。

## 批注由会话维护

```ts
type Comment = {
  id: string
  body: string
  targets: { kind: 'node' | 'edge' | 'scene' | 'review'; id: string }[]
  status: 'open' | 'resolved' | 'needs-review'
  createdAt: string
  revision: string
  reviewedRevision?: string
  originRound?: number
  reviewedRound?: number
  basis?: 'baseline'
  replies?: {
    id: string
    author: 'reviewer' | 'agent'
    body: string
    createdAt: string
    revision: string
    round?: number
  }[]
}
```

旧批注的 `revision` 与 `originRound` 保留提出时版本及轮次，人工复核记录在 `reviewedRevision` / `reviewedRound`，回复的 `round` 记录回应所属发布；这些字段由会话维护。同一 revision 可以有多轮说明或复核，定位以轮次快照为准。Agent 随 `revise` 发布最终回应，评审者在当前图确认解决或重新打开。新版移除目标时保留旧批注，可回到提出时的只读图查看原位置，不按屏幕位置猜测替代目标。

## 容量与校验

至少一个场景；场景、节点、连线、批注、回复及轮次不设固定业务条数上限。ID 为非空文本且最多 200 字符；标题和连线标签最多 200 字符，节点摘要最多 2000，说明、输入输出和批注正文最多 10000。坐标必须为有限数，绝对值不超过 10000000；源码行号为正整数，结束行不小于起始行。轮次为正的安全整数。会话 `scope.context` 为非空文本且最多 1000 字符，`scope.purpose` 为非空文本且最多 10000 字符。

CLI 单次读入的评审 JSON 与最终回应 JSON 各最多 10 MB，作为一次输入的资源边界；服务端累计评论、快照及历史不按此阈值裁剪或停止增长。`revise` 的输入可只包含新图及新增回应，旧线程由会话合并，避免重复传入累计评论。

非法引用、重复 ID、缺字段或超限会拒绝载入；先修正本地评审文件再重试。保持原会话和评论，不通过创建空会话绕过校验。

## 会话生命周期

`scope` 和 `cleanupPolicy` 属于会话，不写进 `ReviewDocument`。默认 `cleanupPolicy: 'manual'`；`start --cleanup-on-approval` 保存 `'archive-on-approval'`，由代理等待命令在输出最终通过结果后归档。归档保存完整图、批注、轮次及历史，可用原 session ID 恢复；永久删除同时移除该 ID 的活动与归档数据。归档、恢复及删除均核对已读 `version`，版本冲突时保留数据。
