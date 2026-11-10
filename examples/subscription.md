# 虚构演示 · 订阅工作区

本文件是为 LogicMargin 原创的虚构规则，用来演示阅读、批注与版本复核。
没有真实客户、服务、业务工程或运行结果；数值和状态均为演示设定。
各场景独立开始，不代表同一个请求连续执行。

## upgrade-start：发起套餐升级

为虚构工作区申请更高套餐。
演示请求只携带目标套餐名称，尚不写入任何设置。
输入：工作区、当前套餐、目标套餐
输出：进入服务可用性检查

## upgrade-toggle：订阅服务是否可用？

维护期间拒绝新升级。
此虚构规则要求订阅服务可用后才读取套餐目录；不可用时保留工作区原设置。
输入：服务状态
输出：可用时继续，否则拒绝

## upgrade-level：目标套餐可以升级吗？

仅允许目录中更高的套餐。
当前套餐与目标套餐都必须在演示目录中，目标排序必须更高；不处理降级或续期。
输入：当前套餐、目标套餐、演示目录
输出：合法升级或拒绝

## upgrade-cost：演示额度是否足够？

使用虚构点数演示校验。
先比较演示余额与目录中的升级点数。点数没有货币价值，也不接入任何支付服务。
输入：演示余额、升级点数
输出：足够时继续，否则拒绝

## upgrade-apply：扣除点数并保存套餐

确认后只改变套餐与演示余额。
在本演示的单步状态模型中，保存目标套餐并扣除对应点数；集成集合和通知渠道保持原值。
输入：合法目标套餐、足够点数
输出：新套餐、更新后的演示余额

## upgrade-refresh：刷新套餐展示

更新页面使用的套餐摘要。
记录一次展示刷新事件，供演示图说明成功路径；没有真实缓存或外部通知。
输入：已保存的套餐
输出：新的展示摘要

## upgrade-complete：套餐升级完成

集成与通知渠道保持原设置。
显示新套餐名称和剩余演示点数，本场景到此结束。
输入：新套餐、演示余额
输出：升级成功结果

## upgrade-rejected：拒绝升级，保留设置

失败校验不会消耗演示点数。
服务不可用、套餐无效或点数不足时返回对应原因，不改变套餐、集成或通知设置。
输入：校验失败原因
输出：原设置与原余额

## unlock-start：选择要启用的集成

集成是独立于套餐的演示配置。
请求选择一个演示集成，例如日历导出；没有真实账号或外部授权。
输入：工作区、集成键
输出：进入集成资格检查

## unlock-eligible：服务与集成是否有效？

仅允许目录中的集成。
服务必须可用，集成键必须存在，且当前套餐需要支持该集成。
输入：服务状态、集成目录、套餐
输出：有效时继续，否则拒绝

## unlock-duplicate：集成是否尚未启用？

重复请求不能重复扣点。
检查工作区启用集合中是否已包含此集成；已有则拒绝本次重复操作。
输入：集成键、启用集合
输出：首次启用或拒绝

## unlock-cost：启用额度是否足够？

先检查集成所需演示点数。
目录提供一次启用点数，余额不足时不改变启用集合。
输入：演示余额、启用点数
输出：足够时继续，否则拒绝

## unlock-apply：扣除点数并启用集成

只新增一项集成。
本演示在一个状态步骤中扣除点数并将集成键加入集合，不改变套餐与通知渠道。
输入：集成键、足够点数
输出：更新后的启用集合与余额

## unlock-update：记录集成设置

保留当前通知渠道。
记录集成已启用的演示事件，套餐和通知选择继续使用原值。
输入：新的启用集合
输出：集成摘要更新

## unlock-complete：集成启用完成

套餐无需随集成变化。
结果只报告新增集成与剩余演示点数，不执行外部服务调用。
输入：新增集成
输出：启用成功结果

## unlock-rejected：拒绝启用，保留设置

本次请求不扣点。
服务、目录、套餐、重复请求或点数校验失败时，保留全部工作区设置和余额。
输入：校验失败原因
输出：原设置与原余额

## equip-start：选择通知渠道或暂停

通知设置独立于套餐变更。
选择演示邮件、站内消息或暂停通知；界面不会实际发送消息。
输入：工作区、渠道选择
输出：进入通知服务检查

## equip-toggle：通知服务是否可用？

服务不可用时拒绝修改。
演示要求通知服务可用后才允许选择渠道或暂停通知。
输入：通知服务状态
输出：可用时继续，否则拒绝

## equip-route：是否选择暂停通知？

暂停不需要查询渠道目录。
选择暂停时直接进入保存步骤；选择具体渠道时继续校验目录与权限。
输入：渠道选择
输出：暂停分支或渠道检查

## equip-eligible：渠道是否可用且获准？

具体渠道必须在演示白名单中。
渠道存在、已启用且受当前套餐支持时才允许保存；不读取真实收件地址。
输入：渠道目录、套餐
输出：可用时继续，否则拒绝

## equip-apply：保存通知选择

只保存一个渠道或暂停状态。
用所选渠道覆盖演示通知设置，不改变套餐、集成集合或余额。
输入：合法渠道或暂停
输出：新的通知设置

## equip-refresh：刷新通知预览

展示更新后的通知状态。
生成只在页面阅读的预览描述，不发送邮件、不请求外部服务。
输入：新的通知设置
输出：通知预览

## equip-effect：显示通知预览

预览使用当前保存的选择。
暂停显示无通知，具体渠道显示对应演示标签，本流程没有消息投递承诺。
输入：保存的渠道或暂停
输出：页面预览结果

## equip-rejected：拒绝修改，保留渠道

错误不会覆盖已有选择。
服务不可用或具体渠道未获准时返回原因，保留原通知设置、套餐与集成集合。
输入：校验失败原因
输出：原通知设置

## 分支规则

- `upgrade-start-to-toggle`：`upgrade-start` → `upgrade-toggle`，条件：提交。
- `upgrade-toggle-to-level`：`upgrade-toggle` → `upgrade-level`，条件：服务可用。
- `upgrade-level-to-cost`：`upgrade-level` → `upgrade-cost`，条件：可升级。
- `upgrade-cost-to-apply`：`upgrade-cost` → `upgrade-apply`，条件：额度足够。
- `upgrade-apply-to-refresh`：`upgrade-apply` → `upgrade-refresh`，条件：套餐已保存。
- `upgrade-refresh-to-complete`：`upgrade-refresh` → `upgrade-complete`，条件：展示已刷新。
- `unlock-start-to-eligible`：`unlock-start` → `unlock-eligible`，条件：提交。
- `unlock-eligible-to-duplicate`：`unlock-eligible` → `unlock-duplicate`，条件：服务与集成有效。
- `unlock-duplicate-to-cost`：`unlock-duplicate` → `unlock-cost`，条件：尚未启用。
- `unlock-cost-to-apply`：`unlock-cost` → `unlock-apply`，条件：额度足够。
- `unlock-apply-to-update`：`unlock-apply` → `unlock-update`，条件：集成已保存。
- `unlock-update-to-complete`：`unlock-update` → `unlock-complete`，条件：记录完成。
- `equip-start-to-toggle`：`equip-start` → `equip-toggle`，条件：提交。
- `equip-toggle-to-route`：`equip-toggle` → `equip-route`，条件：服务可用。
- `equip-route-to-eligible`：`equip-route` → `equip-eligible`，条件：选择具体渠道。
- `equip-eligible-to-apply`：`equip-eligible` → `equip-apply`，条件：渠道可用且获准。
- `equip-apply-to-refresh`：`equip-apply` → `equip-refresh`，条件：选择已保存。
- `equip-refresh-to-effect`：`equip-refresh` → `equip-effect`，条件：生成预览。
- `upgrade-toggle-to-rejected`：`upgrade-toggle` → `upgrade-rejected`，条件：服务不可用。
- `upgrade-level-to-rejected`：`upgrade-level` → `upgrade-rejected`，条件：套餐无效。
- `upgrade-cost-to-rejected`：`upgrade-cost` → `upgrade-rejected`，条件：额度不足。
- `unlock-eligible-to-rejected`：`unlock-eligible` → `unlock-rejected`，条件：服务或集成无效。
- `unlock-duplicate-to-rejected`：`unlock-duplicate` → `unlock-rejected`，条件：已经启用。
- `unlock-cost-to-rejected`：`unlock-cost` → `unlock-rejected`，条件：额度不足。
- `equip-toggle-to-rejected`：`equip-toggle` → `equip-rejected`，条件：服务不可用。
- `equip-eligible-to-rejected`：`equip-eligible` → `equip-rejected`，条件：渠道不可用。
- `equip-route-to-apply`：`equip-route` → `equip-apply`，条件：选择暂停。
