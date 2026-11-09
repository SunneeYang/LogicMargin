# Keyboard shortcuts / 快捷键

LogicMargin 0.9.6 的“设置”是居中窗口，分为“界面”“快捷键”“版本与更新”。主题、明暗、语言和代码布局沿用原偏好；切换设置页不会清空评审草稿。

打开“设置 → 快捷键”，点击某项当前键位，再按希望使用的组合键即可立即应用。重复键位和浏览器保留键会提示错误，原绑定继续有效。每项可以停用、恢复默认，也可以一次恢复所有默认键位。录制时按 Escape 取消，Tab 继续正常移动焦点。Escape 关闭窗口并返回设置入口；录制时第一次 Escape 只取消录制。

键位保存在当前浏览器的当前站点地址下，与外观和代码布局一样跨刷新保留。回环地址与 Tailscale 地址属于不同站点，偏好分别保存；不会上传到评审会话或同步到其他设备。浏览器禁止持久存储时，本次页面内仍可改键。

`Mod` 在 macOS 表示 Command，其他平台表示 Ctrl。

| 操作 | 默认键位 |
| --- | --- |
| 打开设置 | Mod + , |
| 展开或收起场景导航 | B |
| 展开或收起评审面板 | Shift + B |
| 上一个 / 下一个场景 | Alt + ↑ / Alt + ↓ |
| 浏览 / 框选模式 | H / V |
| 显示完整流程 / 恢复阅读视图 | Shift + 1 / Shift + 2 |
| 放大 / 缩小 | Shift + = / - |
| 专注画布 | F |
| 定位当前选择 | L |
| 添加批注 | N |
| 查看讨论 / 详情 / 代码 diff | D / I / C |
| 切换并排 / 统一代码布局 | U |
| 下一处 / 上一处差异 | F8 / Shift + F8 |
| 展开全文 / 折叠未变 | E |
| 保存当前批注或回复 | Mod + Enter |
| 进入本轮审查或确认入口 | Mod + Shift + Enter |
| 打开评审任务 | T |

文字输入、输入法组合、设置或任务弹窗打开时，不触发全局快捷操作。批注保存快捷键仅作用于当前批注或回复输入框，必须包含 Ctrl、Command 或 Alt，不触发整轮提交。只读代码编辑器中可使用差异导航、全文展开与布局切换；其搜索输入框仍按普通输入处理。代码操作优先作用于当前聚焦的对照，否则选择当前可见的第一处对照，不会同时展开所有文件。

快捷键复用已有操作的只读、轮次与可用性限制。进入本轮审查不会直接提交、确认通过、更新插件或删除任务；这些动作继续使用原确认步骤。

## English

Settings opens in a centered dialog with **Interface**, **Keyboard shortcuts**, and **Version and updates** tabs. Existing theme, color mode, language, and code-layout preferences are retained.

In **Keyboard shortcuts**, select a binding and press its replacement. Changes apply immediately. Conflicts and reserved browser keys leave the previous binding intact. Disable or reset individual bindings, or restore all defaults. Escape cancels recording; outside recording it closes Settings and returns focus to the trigger. Tab retains normal focus navigation.

Bindings persist in this browser for the current site address. Loopback and Tailscale addresses have separate preferences. They are not added to review data or synchronized across devices. When browser storage is unavailable, changes remain usable for the current page.

The defaults are listed above; **Mod** means Command on macOS and Ctrl elsewhere. Global shortcuts pause while typing, composing input, or using a modal dialog. The save shortcut applies only to the focused comment/reply input and requires Ctrl, Command, or Alt. It does not submit a review round. Read-only code views support difference navigation, expansion, and layout switching; code search fields remain ordinary text inputs. Code actions target the focused comparison, or the first visible comparison.

Shortcuts respect existing read-only and availability rules. The review shortcut opens the existing review/confirmation entry; it does not submit feedback, approve a round, install an update, or delete a task.
