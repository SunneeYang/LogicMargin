# 虚构演示 · 任务流水线

本文件是为 LogicMargin 原创的虚构规则，用来演示阅读、批注与版本复核。
没有真实客户、服务、业务工程或运行结果；数值和状态均为演示设定。
各场景独立开始，不代表同一个请求连续执行。

## enter-request：提交文档处理任务

为虚构工作区提交一份演示文档。
请求包含任务类型与输入摘要，不包含真实文档正文。
输入：任务类型、输入摘要
输出：进入提交资格检查

## enter-eligibility：工作区允许提交吗？

维护或只读工作区拒绝提交。
工作区必须处于可写状态且流水线可用，才继续读取模板。
输入：工作区状态、流水线状态
输出：允许时继续，否则拒绝

## enter-config：任务模板是否可用？

模板需存在且已发布。
演示目录中的模板必须有输入格式与输出格式；草稿模板不能运行。
输入：模板键、模板目录
输出：可用时继续，否则拒绝

## enter-limits：输入格式与大小合规吗？

不合规的输入在排队前拒绝。
比较输入摘要声明的格式与演示大小限制，不读取任何外部文件。
输入：输入摘要、模板限制
输出：合规时继续，否则拒绝

## enter-room：创建候选队列项

先准备候选项，不覆盖旧任务。
为当前请求构造演示队列项；构造失败时保留工作区之前的任务记录。
输入：合法输入、模板
输出：候选队列项或失败

## enter-ticket：是否还有执行额度？

排队前检查工作区额度。
候选项有效后比较可用额度，至少一个单位才允许加入队列；此处不消耗额度。
输入：候选项、工作区额度
输出：有额度时排队，否则拒绝

## enter-start：任务进入等待队列

等待执行时保持原有结果。
保存候选队列项并标记等待状态，旧任务的输出记录继续保留。
输入：候选队列项
输出：等待中的新任务

## enter-rejected：拒绝提交，保留记录

失败请求不进入队列。
资格、输入、候选项或额度检查失败时返回原因，不删除原任务和输出。
输入：校验失败原因
输出：原任务与输出

## enter-placeholder：拒绝未发布模板

模板不合规时不创建队列项。
缺失、草稿或格式声明不完整的模板都不能启动任务，可修改模板后重新提交。
输入：无效模板
输出：模板错误结果

## battle-progress：执行文档转换步骤

工作器按模板生成演示结果。
工作器从队列领取任务，更新演示进度；该说明不实现真实文档转换。
输入：等待任务、模板
输出：处理中进度

## battle-boss：所有步骤是否成功？

任一步失败进入失败出口。
当模板要求的步骤均成功时继续检查任务期限；失败或用户取消则停止当前处理。
输入：步骤状态、取消状态
输出：成功时继续，否则失败

## battle-time：任务令牌与期限有效吗？

只接受当前且未过期的执行。
工作区保存的任务令牌必须匹配，且完成时间在演示期限内，避免旧工作器覆盖新任务。
输入：任务令牌、演示期限
输出：有效时继续，否则失败

## battle-first-pass：是否需要额外审核？

带外发标记的任务等待审核。
纯本地预览可立即进入保存检查；需要外发的任务生成审核请求。
输入：模板的外发标记
输出：本地预览或审核分支

## battle-repeat：准备本地预览

本地任务直接准备输出。
保留演示输出摘要，进入最终配额与容量校验，不向外部地址发送任何内容。
输入：本地输出摘要
输出：待保存的结果

## battle-report：创建审核请求

外发任务先等待模拟审核。
记录任务令牌和输出摘要，交由演示审核器；无法创建请求则不保存最终输出。
输入：任务令牌、输出摘要
输出：待审核请求或失败

## battle-envelope：审核回执是否完整且匹配？

只接受对应任务的同意回执。
审核令牌必须匹配当前任务，字段齐全且结论为同意；拒绝或旧回执不生成输出。
输入：模拟审核回执、当前任务
输出：匹配同意时继续，否则不保存

## battle-verified：回执是否尚未消费？

重复回执不能重复保存。
演示状态需仍为等待审核，且回执序号未被处理；检查成功后进入最终保存校验。
输入：回执序号、任务状态
输出：首次处理或忽略

## battle-assets：额度与输出空间仍充足吗？

保存前重新检查当前资源。
比较工作区当前额度和输出槽位，不依赖排队时的旧值；不足则结束本次处理。
输入：当前额度、输出槽位
输出：充足时保存，否则不保存

## battle-reward：保存输出并完成任务

单步更新演示状态。
消耗一个演示额度、保存输出摘要并标记任务完成；这不是外部存储事务的实现证明。
输入：合法输出、足够额度与槽位
输出：完成任务与输出记录

## battle-no-award：本次不保存最终输出

无效回执或资源不足均不产出。
保留原输出记录，当前请求记录失败原因；重复回执不会生成第二份结果。
输入：处理失败原因
输出：原输出记录

## battle-fail：任务失败或取消

停止本次处理并记录原因。
步骤失败、取消或期限无效时标记当前任务失败，保留其他任务的输出和可用额度。
输入：失败或取消信号
输出：失败任务记录

## sweep-request：请求重试历史任务

为失败任务创建新的运行。
选择工作区内的历史失败任务，仅引用输入摘要，不复用旧工作器令牌。
输入：历史任务键
输出：进入重试资格检查

## sweep-eligibility：重试权限是否满足？

演示需允许重试且工作区可写。
工作区、流水线与重试开关均有效时继续；不使用任何付费权益判断。
输入：工作区与重试开关
输出：满足时继续，否则拒绝

## sweep-selected：目标任务属于本工作区吗？

仅可重试仍保留的失败任务。
任务存在、归属匹配且状态为失败，避免引用其他工作区或已删除的记录。
输入：任务键、历史记录
输出：有效时继续，否则拒绝

## sweep-limit：输入摘要仍可使用吗？

重试需要可用的输入摘要。
摘要格式与当前模板兼容，且未被用户移除；不自动补造丢失输入。
输入：历史输入摘要、当前模板
输出：可用时继续，否则拒绝

## sweep-refresh：刷新重试计数视图

读取当前工作区的重试次数。
刷新演示统计，统计只用于此工作区，不改变其他工作区状态。
输入：工作区统计
输出：当前重试次数

## sweep-highest：重试上限与额度通过吗？

每个任务有固定演示重试上限。
检查该任务未达上限，且当前工作区有执行额度和队列槽位。
输入：重试次数、额度、槽位
输出：满足时排队，否则拒绝

## sweep-reward：创建新的重试任务

新任务使用独立运行令牌。
增加重试计数并生成等待任务；实际执行额度仍在保存输出时消耗。
输入：历史输入摘要、可用槽位
输出：新的等待任务

## sweep-rejected：拒绝重试，保留历史

无效请求不会覆盖失败记录。
归属、状态、输入或资源检查失败时保留历史任务，不增加重试计数。
输入：检查失败原因
输出：原任务记录

## tickets-trigger：打开工作区额度视图

按需刷新演示额度。
进入工作区或打开额度页时读取演示周期状态，不触发后台定时任务。
输入：工作区、当前演示周期
输出：进入额度功能检查

## tickets-toggle：额度演示是否开启？

未开启时不调整额度。
只有演示开关打开才读取当前工作区的额度记录。
输入：额度演示开关
输出：开启时继续，否则跳过

## tickets-wallet：读取工作区额度记录

额度按工作区独立保存。
读取该工作区的余额与最后周期键，不查询真实用户、账号或钱包。
输入：工作区键
输出：余额、最后周期键

## tickets-days：是否进入新的演示周期？

同一周期不会重复刷新。
首次使用或周期键变化时重置演示额度，同一周期重复打开只读状态。
输入：当前周期键、最后周期键
输出：新周期或跳过

## tickets-grant：按周期重置演示额度

固定重置为十个单位。
将演示可用额度设置为十，不累计错过的周期；写入失败保留旧周期键。
输入：新的周期键
输出：十个单位或写入失败

## tickets-record：记录新的周期键

刷新后保存周期标记。
额度重置成功后记录新周期键，供下次访问判断是否需要刷新。
输入：刷新成功的额度、周期键
输出：已记录的新周期

## tickets-skip：本次跳过额度刷新

开关关闭或周期未变化。
不重复刷新额度，写入失败也不前移周期标记，以便之后重试。
输入：无需刷新或写入失败
输出：原额度与周期键

## loadout-request：申请修改流水线设置

设置修改先查看任务状态。
请求修改工作区的演示模板选择，所有权限检查仍由设置流程自身处理。
输入：新模板选择、工作区
输出：进入活动任务检查

## loadout-active：当前是否仍有运行任务？

运行期间冻结模板选择。
任务处于等待、执行或审核状态时拒绝修改模板，避免同一运行混用设置。
输入：当前任务状态
输出：运行中拒绝，否则继续

## loadout-reject：拒绝本次模板变更

保留运行任务使用的模板。
返回任务仍活动的原因，不覆盖工作区原模板；任务结束后允许重新申请。
输入：活动任务、新模板选择
输出：原模板选择

## loadout-pass：继续设置自身校验

无活动任务时可继续修改。
只解除活动任务这一道限制，模板存在性和编辑权限仍需后续检查。
输入：无活动任务、新模板选择
输出：进入设置流程

## loadout-read：允许只读预览与查看记录

读操作不修改模板选择。
只读预览和历史记录查询可直接进入各自权限检查，不需要等待运行结束。
输入：预览或查询请求
输出：只读流程

## loadout-restore：任务结束后重新申请

状态变化后重新检查限制。
用户在任务完成或取消后再次提出模板变更，重新执行活动任务检查，不自动应用旧请求。
输入：已结束任务、新请求
输出：可重新申请设置变更

## 分支规则

- `enter-request-to-enter-eligibility`：`enter-request` → `enter-eligibility`，条件：检查工作区。
- `enter-eligibility-to-enter-config`：`enter-eligibility` → `enter-config`，条件：允许提交。
- `enter-eligibility-to-enter-rejected`：`enter-eligibility` → `enter-rejected`，条件：维护或只读。
- `enter-config-to-enter-limits`：`enter-config` → `enter-limits`，条件：模板可用。
- `enter-config-to-enter-placeholder`：`enter-config` → `enter-placeholder`，条件：模板未发布或不完整。
- `enter-limits-to-enter-room`：`enter-limits` → `enter-room`，条件：输入合规。
- `enter-limits-to-enter-rejected`：`enter-limits` → `enter-rejected`，条件：输入不合规。
- `enter-room-to-enter-ticket`：`enter-room` → `enter-ticket`，条件：候选项有效。
- `enter-room-to-enter-rejected`：`enter-room` → `enter-rejected`，条件：候选项创建失败。
- `enter-ticket-to-enter-start`：`enter-ticket` → `enter-start`，条件：还有额度。
- `enter-ticket-to-enter-rejected`：`enter-ticket` → `enter-rejected`，条件：额度不足。
- `battle-progress-to-battle-boss`：`battle-progress` → `battle-boss`，条件：步骤执行完成。
- `battle-boss-to-battle-time`：`battle-boss` → `battle-time`，条件：全部成功。
- `battle-boss-to-battle-fail`：`battle-boss` → `battle-fail`，条件：失败或取消。
- `battle-time-to-battle-first-pass`：`battle-time` → `battle-first-pass`，条件：令牌与期限有效。
- `battle-time-to-battle-fail`：`battle-time` → `battle-fail`，条件：令牌失效或过期。
- `battle-first-pass-to-battle-repeat`：`battle-first-pass` → `battle-repeat`，条件：仅本地预览。
- `battle-first-pass-to-battle-report`：`battle-first-pass` → `battle-report`，条件：需要模拟审核。
- `battle-repeat-to-battle-assets`：`battle-repeat` → `battle-assets`，条件：预览已准备。
- `battle-report-to-battle-envelope`：`battle-report` → `battle-envelope`，条件：审核请求已创建。
- `battle-report-to-battle-no-award`：`battle-report` → `battle-no-award`，条件：审核请求创建失败。
- `battle-envelope-to-battle-verified`：`battle-envelope` → `battle-verified`，条件：回执匹配且同意。
- `battle-envelope-to-battle-no-award`：`battle-envelope` → `battle-no-award`，条件：回执无效或拒绝。
- `battle-verified-to-battle-assets`：`battle-verified` → `battle-assets`，条件：首次消费回执。
- `battle-verified-to-battle-no-award`：`battle-verified` → `battle-no-award`，条件：回执已消费或状态无效。
- `battle-assets-to-battle-reward`：`battle-assets` → `battle-reward`，条件：额度与空间充足。
- `battle-assets-to-battle-no-award`：`battle-assets` → `battle-no-award`，条件：额度或空间不足。
- `sweep-request-to-sweep-eligibility`：`sweep-request` → `sweep-eligibility`，条件：提交重试。
- `sweep-eligibility-to-sweep-selected`：`sweep-eligibility` → `sweep-selected`，条件：允许重试。
- `sweep-eligibility-to-sweep-rejected`：`sweep-eligibility` → `sweep-rejected`，条件：无重试权限。
- `sweep-selected-to-sweep-limit`：`sweep-selected` → `sweep-limit`，条件：本工作区失败任务。
- `sweep-selected-to-sweep-rejected`：`sweep-selected` → `sweep-rejected`，条件：任务归属或状态无效。
- `sweep-limit-to-sweep-refresh`：`sweep-limit` → `sweep-refresh`，条件：输入仍可用。
- `sweep-limit-to-sweep-rejected`：`sweep-limit` → `sweep-rejected`，条件：输入不可用。
- `sweep-refresh-to-sweep-highest`：`sweep-refresh` → `sweep-highest`，条件：统计已刷新。
- `sweep-highest-to-sweep-reward`：`sweep-highest` → `sweep-reward`，条件：未达上限且资源充足。
- `sweep-highest-to-sweep-rejected`：`sweep-highest` → `sweep-rejected`，条件：次数或资源不满足。
- `tickets-trigger-to-tickets-toggle`：`tickets-trigger` → `tickets-toggle`，条件：打开额度视图。
- `tickets-toggle-to-tickets-wallet`：`tickets-toggle` → `tickets-wallet`，条件：演示已开启。
- `tickets-toggle-to-tickets-skip`：`tickets-toggle` → `tickets-skip`，条件：演示未开启。
- `tickets-wallet-to-tickets-days`：`tickets-wallet` → `tickets-days`，条件：读取周期键。
- `tickets-days-to-tickets-grant`：`tickets-days` → `tickets-grant`，条件：首次或新周期。
- `tickets-days-to-tickets-skip`：`tickets-days` → `tickets-skip`，条件：同一周期。
- `tickets-grant-to-tickets-record`：`tickets-grant` → `tickets-record`，条件：额度重置成功。
- `tickets-grant-to-tickets-skip`：`tickets-grant` → `tickets-skip`，条件：写入失败。
- `loadout-request-to-loadout-active`：`loadout-request` → `loadout-active`，条件：修改模板请求。
- `loadout-active-to-loadout-reject`：`loadout-active` → `loadout-reject`，条件：仍有运行任务。
- `loadout-active-to-loadout-pass`：`loadout-active` → `loadout-pass`，条件：没有运行任务。
- `loadout-reject-to-loadout-restore`：`loadout-reject` → `loadout-restore`，条件：任务结束后重新申请。
- `loadout-request-to-loadout-read`：`loadout-request` → `loadout-read`，条件：只读预览或查询。
