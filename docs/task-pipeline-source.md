# 虚构任务流水线演示来源

可选评审 `demo-task-pipeline-v1` 完全依据本仓库原创的 [任务流水线规则](../examples/task-pipeline.md)。五个场景分别说明提交、执行与模拟审核、历史任务重试、额度周期刷新和设置修改限制。全部状态、额度与模板均为虚构。

- 评审包：[task-pipeline.logic-margin.json](../public/reviews/task-pipeline.logic-margin.json)。
- 网页入口：开发服务器的 `/?review=task-pipeline`，或文件菜单“打开任务流水线评审”。
- 布局比较：[layout-prototype.html](../public/layout-prototype.html)，内嵌同一公开演示；不连接批注存储。
- 形状：5 个场景、42 个节点、50 条连线；初始批注为空。普通稳定 ID 和坐标用于保持图形测试形状，不表达真实系统的实现身份。

节点证据指向 `examples/task-pipeline.md` 的有效规则行。digest 对含首尾行、以 LF 连接且不含末行换行的 UTF-8 字节计算 SHA-256；`snapshot.files` 对整个文档计算 SHA-256，fingerprint 对紧凑 `JSON.stringify(files)` 计算 SHA-256。`synthetic-v1` 不是源代码提交，时间只是演示材料编写日期。

普通 Vite 构建会复制 `public`，因而包含此 JSON 与布局原型。Go 的 UI 构建使用 `publicDir:false`，不提供这两个静态文件；默认订阅演示仍随 App 打包。原生发行的菜单不会提供不存在的可选演示入口。

新文档 ID 与其他评审隔离，不把旧批注或草稿搬到虚构内容上，也不删除任何旧本地数据或真实会话。证据和原型同步由 [公开样例检查](../src/public-examples.test.ts) 验证，交互范围见 [测试说明](task-pipeline-acceptance.md)。这些材料没有真实执行器、外部投递、生产存储或线上验收结论。
