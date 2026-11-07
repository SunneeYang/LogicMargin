# 代码 diff 滚动旁总览：三组主源参考

核对日期：2026-11-08。选取 VS Code/Monaco、JetBrains、WinMerge；仅阅读官方文档与固定 SHA 源码，未运行候选、未操作浏览器。下文建议不代表 LogicMargin 已实现或已验收。

## 先区分两种总览

**Minimap** 压缩显示源码形状：VS Code 官方称其为代码轮廓，可点击或拖动阴影区域导航。**差异 overview ruler** 则将差异范围映射成纵向色带，不必绘制源码字符；视口条表示“正在看哪里”，差异色带表示“哪里有变化”，两者应分开。[^minimap][^monaco]

## 已核实对照

| 产品 | 模式、颜色 | 视口标识 | 点击／拖动导航 |
| --- | --- | --- | --- |
| VS Code / Monaco diff overview ruler | 支持并排和内联（统一）；总览开关独立于模式。该源码使用原稿／修改稿两轨，各 15px；原稿差异用删除色，修改稿差异用新增色。配色读取独立主题项 `diffEditorOverview.removedForeground`／`insertedForeground`。[^mode][^monaco][^colors] | 独立 `diffViewport`，按修改稿的滚动位置、可视高度与滚动总高度计算位置和尺寸。[^monaco] | 指针事件委托给修改稿滚动条；支持拖动，轨道点击按滚动条配置定位或翻页，并非点击后必然吸附到差异块。[^monaco][^scrollbar] |
| JetBrains IntelliJ IDEA diff scrollbar markers | 官方支持统一／并排；正文示例为新增绿、修改蓝、删除灰。共享 diff 绘制代码另注册 error stripe 标记，颜色取主题的 `ErrorStripeColor`；正文三色不能直接当作滚动条实色。[^idea][^stripe] | 专用差异视口框未核实。 | 官方确认滚动条悬停可预览屏外代码；本轮未核实标记点击、拖动的具体语义，也不保证两种模式完全相同。[^idea] |
| WinMerge Location pane | 官方描述为并排文件对应两条纵向栏；本轮未核实统一模式。横线位置、粗细表示差异分布和大小，颜色跟随正文差异块；文档示例为金色差异、灰色空差异块。[^winmerge] | 半透明 view area bar 标出当前可视范围；另有双三角指针标出当前选中差异，滚动不会改变该差异指针。[^winmerge] | 点击任意位置跳转到文件对应位置；上下拖动视口条滚动文件。[^winmerge] |

## 适合窄节点窗口的最小建议

采用滚动条旁约 12px 的差异色带，复用当前 diff 的新增／删除主题色；统一视图单轨，并排视图仅在需要区分两侧时分双轨。叠加有边界的半透明视口条，支持点击定位和拖动视口，保留键盘上一处／下一处差异入口。

坐标统一按**当前可滚动 diff** 映射；展开上下文、折叠、换行或节点尺寸变化后重算。仅载入代码片段时标明“当前片段”，避免暗示全文件覆盖。第一版省略源码缩略图、悬停预览和移动块连线；这些是本项目取舍，未做交互实测。

## LogicMargin 的实现取舍

统一与并排视图共用一条竖向滚动轨道，在轨道内用同一列色块标记删除与新增，色块比滑块稍宽，并将阅读范围作为可拖动滑块；底部保留水平滚动条。同一位置的增删按上下分段显示红绿，滑块在色块上层。按当前可滚动 diff 的实际几何映射，包含删除块和并排 spacer；折叠、局部展开及尺寸变化后重算。使用原生纵向 range 承接点击与拖动，保留上下、翻页、Home/End 键及原有差异导航。总览只表示已保存的当前片段，省略源码字符缩略图与悬停代码预览。

[^minimap]: [VS Code：Minimap](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_minimap)。
[^mode]: [Monaco：diff 选项](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.IDiffEditorBaseOptions.html#renderOverviewRuler)；[固定源码：创建总览的条件](https://github.com/microsoft/vscode/blob/b3b6d37d663ccdd998da2b5c1372b0f97d5e4442/src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts#L309-L321)。
[^monaco]: [固定源码：OverviewRulerFeature](https://github.com/microsoft/vscode/blob/b3b6d37d663ccdd998da2b5c1372b0f97d5e4442/src/vs/editor/browser/widget/diffEditor/features/overviewRulerFeature.ts#L24-L170)。
[^colors]: [VS Code：Diff editor colors](https://code.visualstudio.com/api/references/theme-color#diff-editor-colors)。
[^scrollbar]: [固定源码：滚动条指针与拖动处理](https://github.com/microsoft/vscode/blob/b3b6d37d663ccdd998da2b5c1372b0f97d5e4442/src/vs/base/browser/ui/scrollbar/abstractScrollbar.ts#L192-L274)。
[^idea]: [JetBrains：Diff Viewer for files](https://www.jetbrains.com/help/idea/differences-viewer.html)，颜色表、模式切换与 Show code lens on scrollbar hover。
[^stripe]: [固定源码：注册 stripe 高亮](https://github.com/JetBrains/intellij-community/blob/6dd187c1fcd45b1a2f634419d36307d211689438/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java#L599-L638)；[stripe 属性](https://github.com/JetBrains/intellij-community/blob/6dd187c1fcd45b1a2f634419d36307d211689438/platform/diff-impl/src/com/intellij/diff/util/DiffDrawUtil.java#L869-L883)；[主题标记颜色](https://github.com/JetBrains/intellij-community/blob/6dd187c1fcd45b1a2f634419d36307d211689438/platform/diff-impl/src/com/intellij/diff/util/TextDiffTypeFactory.java#L76-L79)。
[^winmerge]: [WinMerge 2.16 官方手册：Comparing and merging text files](https://manual.winmerge.org/en/Compare_files.html)，§2.4 Location pane。
