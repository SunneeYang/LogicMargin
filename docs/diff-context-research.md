# Diff 上下文局部展开：主流工具与 LogicMargin

## 范围

2026-11-07 核对官方文档及官方源码，GitLab、Gerrit 通过隔离调研核对；GitHub Desktop 与 VS Code 由集成阶段补充。未登录、打开真实评审、操作浏览器或运行候选代码。源码快照：GitLab [`a186442025b6dce8288ae4556470a5ab3c6201aa`][gl-sha]；Gerrit [`f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f`][ge-sha]。结论限定这些实现，不代表所有部署版本。

## GitLab

官方[用户文档][gl-doc]明确：左侧 gutter 的 Previous / Next 每次显示 20 行。下表以当前源码中的 **Rapid Diffs** 为准，官方[开发文档][gl-rapid]确认其通过 hunk header 展开上下文。

| 核实项 | 结果与证据 |
| --- | --- |
| 按钮位置 | 位于缺口的独立 hunk header 行左侧 gutter。文件头、尾缺口分别接可见代码上沿、下沿；块间缺口共用一行，可同时有上下方向键。不是窗口上下沿的固定工具栏。[模板][gl-template]、[方向生成][gl-header] |
| 行数、重复点击 | 单方向请求 20 行，向文件起点截断；新 HTML 按最新相邻可见行生成下一次请求，因此有剩余即可继续点击；请求期间禁用。[请求范围][gl-request]、[更新过程][gl-adapter] |
| 剩余量与消失 | 两端都有可见行且缺口剩余 **1–20 行**时，方向键换为整段键；全部展开时请求 `unfold:false`，不再返回 header。首尾展开到文件边界也停止生成占位行。[阈值][gl-header]、[请求][gl-request]、[边界判断][gl-unfold] |
| 整段展开 | 有：上述小缺口显示 Show hidden lines，取两端之间全部行。长缺口的 header 仍给方向键，未见独立整段键；整文件菜单不在本轮核实范围。[按钮文案][gl-buttons]、[条件][gl-header] |
| 阅读位置 | 插入后，向上展开聚焦紧邻原边界的最后一个新行号；向下／整段展开聚焦第一个新行号，再删除旧 header。这里是焦点接续，源码未显示像素位移补偿，不能据此保证视口完全不动。[焦点与插入][gl-adapter] |

当前仍保留旧 Vue 实现，其整段键条件是缺口 **小于20** 行，与 Rapid Diffs 的“≤20”有差异，不应混用。[旧组件][gl-legacy]

## Gerrit

官方[评审 UI 文档][ge-doc]同时说明“展开整个跳过块”和两侧各加 10 行；源码补足下列细节。

| 核实项 | 结果与证据 |
| --- | --- |
| 按钮位置 | 控件位于折叠区的 divider 行，横向居中；两枚局部按钮分居分隔线上下，整段按钮居中。首尾缺口仅显示靠可见代码一侧的局部按钮。因此是缺口占位控件，并非附着整个代码窗口上／下沿。[结构][ge-section]、[布局][ge-layout]、[方向][ge-directions] |
| 行数、重复点击 | 局部按钮通常为 **+10**，仅剩余量大于10时显示；点击把原折叠组替换为已展开行与剩余折叠组，可再次展开。[按钮逻辑][ge-partial]、[组替换][ge-model] |
| 剩余量与消失 | 剩余4–10行时仅保留整段按钮；一次局部展开后若只余≤3行，辅助函数直接显示余行，不再建立折叠组，所以最后一次可能露出11–13行。[小余量规则][ge-group]、[局部按钮条件][ge-partial] |
| 整段展开 | 普通缺口始终有显示剩余行数的整段按钮。服务器因文件过大而省略内容时另走加载事件；该快照修正为仅给整段加载键，不给无效的+10。[整段按钮][ge-all]、[加载事件][ge-partial]、[官方修复说明][ge-sha] |
| 阅读位置 | **未核实像素锚定保证**。已读路径只确认替换局部组，渲染按 group id 复用其余区段；没有足够证据断言采用旧行坐标补偿，也不能把 DOM 复用当成不跳动的实测结论。[事件处理][ge-diff]、[渲染][ge-element] |

[gl-sha]: https://gitlab.com/gitlab-org/gitlab/-/commit/a186442025b6dce8288ae4556470a5ab3c6201aa
[gl-doc]: https://docs.gitlab.com/user/project/merge_requests/changes/
[gl-rapid]: https://docs.gitlab.com/development/fe_guide/rapid_diffs/#diff-terminology
[gl-template]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/components/rapid_diffs/viewers/text/inline_hunk_component.html.haml#L1-L11
[gl-header]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/gems/gitlab-diff/lib/gitlab/diff/viewer_hunk.rb#L92-L120
[gl-request]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/assets/javascripts/rapid_diffs/adapters/expand_lines/get_lines.js#L7-L55
[gl-adapter]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/assets/javascripts/rapid_diffs/adapters/expand_lines.js#L15-L67
[gl-unfold]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/presenters/blobs/unfold_presenter.rb#L87-L102
[gl-buttons]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/components/rapid_diffs/viewers/text/hunk_component.rb#L46-L66
[gl-legacy]: https://gitlab.com/gitlab-org/gitlab/-/blob/a186442025b6dce8288ae4556470a5ab3c6201aa/app/assets/javascripts/diffs/components/diff_expansion_cell.vue#L213-L248
[ge-sha]: https://gerrit.googlesource.com/gerrit/+/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f
[ge-doc]: https://gerrit-review.googlesource.com/Documentation/user-review-ui.html#diff-preferences
[ge-section]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-context-controls/gr-context-controls-section.ts#L21-L26
[ge-directions]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-context-controls/gr-context-controls.ts#L61-L116
[ge-layout]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-context-controls/gr-context-controls.ts#L148-L243
[ge-partial]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-context-controls/gr-context-controls.ts#L442-L498
[ge-all]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-context-controls/gr-context-controls.ts#L334-L389
[ge-model]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-diff-model/gr-diff-model.ts#L262-L275
[ge-group]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-diff/gr-diff-group.ts#L34-L111
[ge-diff]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-diff/gr-diff.ts#L736-L742
[ge-element]: https://github.com/GerritCodeReview/gerrit/blob/f6dcb9ffd2b3e7c3da23be9e37fb22e11960ae8f/polygerrit-ui/app/embed/diff/gr-diff/gr-diff-element.ts#L228-L233


## GitHub Desktop / GitHub

GitHub Desktop 当前官方[说明](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop#choosing-how-to-display-diffs)明确：点击行号上方或下方的箭头，显示变更上方或下方的更多代码；整个文件展开是右键菜单中的独立动作。该文档没有明确每次行数，不将其记成固定 20 行。GitHub 网页早期[官方说明](https://github.blog/news-insights/product-news/expanding-context-in-diffs/)也以 gutter 的 unfold 按钮补充上下文；这条历史资料不证明当前网页界面的具体布局。

## VS Code

官方 [1.81 版本说明](https://code.visualstudio.com/updates/v1_81#_collapse-unchanged-regions)明确：可以点击或拖动隐藏区的上下边界来揭示代码。当前[源码](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/diffEditor/features/hideUnchangedRegionsFeature.ts)仍区分边界展开与整段显示。这里借鉴“边界就是操作位置”的表达，不在本轮移植拖拽、面包屑或编辑功能。

## LogicMargin 的落地规则

1. 对前后都有可见代码的缺口：上边界放“向下展开”，接续上一个可见块的末尾；下边界放“向上展开”，接续下一个可见块的开头。隐藏行数及整段展开居中，三种动作分层。
2. 文件片段开头只有“向上展开”，末尾只有“向下展开”；没有隐藏行的方向不显示按钮。
3. 每次最多 20 行，同方向可重复点击；按钮随剩余缺口移动，直到该缺口完全展开才消失。首尾相同规则。
4. 并排视图两侧同步；保留编辑器、源码、行号、语言偏好与虚拟化。上下文只来自评审已保存的源码，不临时读取工作区或补写历史快照。
5. 验收覆盖同一方向连续多次、上下方向交替、剩余不足一步、首尾、相邻块接合、语言切换、并排同步及窄屏按钮范围。流行工具的“一次多少行”不作为本产品必须一致的规格。
