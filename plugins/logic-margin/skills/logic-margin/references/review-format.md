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
}
type Scene = { id: string; title: string; description: string }
```

- `id` 标识同一评审，跨轮保持；`revision` 标识当前逻辑内容，修改后更新，不能把轮次当作 Git commit。
- `snapshot.repository` 写真实来源仓库或工作区；`commit` 写当前 HEAD。无版本库时明确标注 `unversioned`，并在 `coverage.note` 解释来源。
- `capturedAt` 使用 ISO 日期；`dirty` 根据当前工作区事实填写，指纹必须包含本次覆盖的未提交内容。
- `snapshot.files` 建议显式列出受覆盖源码和文档，使用规范的工作区相对路径和文件原始字节的 SHA-256。将 `{path, sha256}[]` 按路径排序，对其 `JSON.stringify` 的 UTF-8 字节计算 SHA-256，作为 `snapshot.fingerprint`；CLI 固定采用 `sha256-path-content-v1`。未提供 `files` 时，以图内依据涉及的文件为清单；至少需要一个实际来源文件，设计评审也可列出真实设计文档。
- `coverage.included` 列出实际展示的行为；`excluded` 列出未覆盖路径和依赖；`note` 说明数据来源、摘要规则、未运行的验证等限制。展示成功不等于业务验收通过。
- 新评审的 `comments` 使用 `[]`。发布新版时服务端会合并已有评论；保留从 `get` 取得的评论也可以，但不要自行重写原意见、回复 ID 或人工状态。

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
- 尚无源码的设计节点可用空 `evidence`，但应在节点说明和覆盖范围标明“设计/待实现”，不能伪造源码位置或摘要。

## 来源核验与新版发布

`verify <review.json> --source-root <workspace>` 核验实际文件、所有图内片段和指纹；只读，不替代理更新文件或判断业务语义。来源根目录默认当前工作目录；清单路径和符号链接必须留在该目录内，每文件最多 10 MB、总计 64 MB。

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

文件最多 10 MB，至少一个场景；最多 100 场景、1000 节点、2000 连线、2000 批注。ID 为非空文本且最多 200 字符；标题和连线标签最多 200 字符，节点摘要最多 2000，说明、输入输出和批注正文最多 10000。每节点最多 20 处源码依据，每条批注最多 500 个目标和 500 条回复。坐标必须为有限数，绝对值不超过 10000000；源码行号为正整数，结束行不小于起始行。

非法引用、重复 ID、缺字段或超限会拒绝载入；先修正本地评审文件再重试。保持原会话和评论，不通过创建空会话绕过校验。
