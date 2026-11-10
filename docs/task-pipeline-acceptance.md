# 公开演示测试说明

本页描述虚构演示的回归要求，不是生产业务验收记录，也不继承此前夹具的测试结果。当前运行结果应以实际测试日志为准。

## 自动化断言

- `src/public-examples.test.ts`：两份评审可由 `parseReview` 导入，图形规模保持 3/24/27 与 5/42/50，全部证据只指仓库 `examples`，文档行号、段落摘要、文件摘要和快照指纹一致；布局原型内嵌内容与可选 JSON 相同。
- `tests/task-pipeline.spec.ts`：深链加载、无 `randomUUID` 环境下批注、回复、提交意见、导入代理回应、人工复核和整轮通过。
- 同一测试文件继续覆盖本地批注与草稿保留、下载失败后的现有评审保留、手机重试入口、导入新版后刷新不降级。
- 本地存储隔离测试使用另一个虚构文档 ID，确认打开新演示不合并其他评审的批注或草稿，也不删除其数据。
- 既有布局、视角、基线、跨轮、讨论与主题用例继续使用稳定节点锚点。

## 复现

在仓库根目录安装项目所需依赖后执行：

```sh
node --test src/model.test.ts src/workspace.test.ts src/public-examples.test.ts
npx tsc --noEmit
npm run build
npx playwright test tests/task-pipeline.spec.ts --workers=1
```

`agent-tmp-run` 是部分开发机安装的可选临时文件 harness；若本地 AGENTS 规定必须使用它，应将上述命令交给本地 harness 运行。它不属于公共安装依赖。浏览器运行使用隔离的本地测试数据目录，不写真实会话或安装 profile。

这里没有记录实体手机、跨设备、其他操作系统或真实外部服务的验收。公开截图是独立的虚构订单演示，不表示此流水线已在生产运行。
