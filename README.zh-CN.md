<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="src/assets/logo.svg" width="88" height="88" alt="LogicMargin Logo" />
</p>

<h1 align="center">LogicMargin · 逻辑旁批</h1>

<p align="center">
  <strong>供人与 Agent 协作的本地业务流程评审工具。</strong>
</p>

<p align="center">
  在流程图上确认业务规则，跟踪每轮修改与评审意见。
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.6.0-2563eb?style=flat-square" alt="版本 0.6.0" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Node.js-22.18%2B-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="需要 Node.js 22.18 或更高版本" /></a>
  <a href="docs/agent-workflow.md"><img src="https://img.shields.io/badge/review-human--in--the--loop-7c3aed?style=flat-square" alt="人工评审与 Agent 协作" /></a>
</p>

<p align="center">
  <a href="#这是什么">项目简介</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档">文档</a>
</p>

## 这是什么

LogicMargin 是一个本地运行的逻辑评审工具，供策划、产品和开发者检查功能的执行流程、判断条件、异常分支与状态变化。它把流程图、源码依据和讨论放在同一处，让不同角色可以围绕同一份业务逻辑进行评审。

与 Agent 协作时，Agent 从实际代码或文档整理流程图，你直接在图上圈选对象并批注。明确提交本轮后，Agent 修改实现、更新流程图并回复原意见，再由你对照前后变化复核。读源、改代码和生成流程图由 Agent 完成，LogicMargin 提供评审界面与记录。

## 解决什么问题

- **只看代码 diff，难以判断业务行为。** 将成功条件、失败出口和状态变更放进流程图，方便核对“什么时候扣费”“失败后会留下什么状态”等具体规则。
- **意见散落在聊天中，容易脱离上下文。** 将批注挂到具体节点、连线或一组对象上，保留原意见、回复和来源版本。
- **Agent 回复已修改，却难以确认改了哪里。** 每轮同步发布新版图与回应，支持前后对比；原节点移除后，也能回到历史位置核对，最终由人确认解决。

**适合谁：** 策划与产品可核对规则和边界条件，开发者可结合源码检查分支与数据变化，使用 Agent 开发的团队可完成“提意见 → 修改 → 再复核”的协作流程。

## 界面预览

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/review-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/review-light.png" />
  <img src="docs/images/review-light.png" alt="LogicMargin 实际界面：左侧切换流程场景，中间查看订单提交和失败分支，右侧在同一条批注中查看原意见与 Agent 回应。" width="1440" />
</picture>

<p align="center">
  图上批注 · 原线程回应 · 人工复核<br />
  <a href="docs/images/review-light.png">查看明亮主题</a> ·
  <a href="docs/images/review-dark.png">查看深色主题</a> ·
  <a href="docs/examples/order-review.logic-margin.json">下载订单演示数据</a>
</p>

截图来自当前应用，使用虚构的订单演示数据；不包含真实业务会话，也不代表源码核验结果。

## 核心能力

| 能力 | 你可以做什么 |
| --- | --- |
| **直接在图上评审** | 对节点、连线、多个对象、整个场景或整张图留下意见，讨论始终带着流程上下文。 |
| **保留源码依据** | 查看步骤的规则、输入输出、源码引用与快照信息，明确这次评审覆盖什么。 |
| **看见每轮变化** | 切换修改前与当前图，核对字段差异；节点移除后，原意见仍可回到历史位置查看。 |
| **与 Agent 完成闭环** | 明确提交本轮意见，Agent 等待、修改、回应并发布新图，再由人确认解决或通过。 |
| **按目的隔离任务** | 同一段对话可关联多个独立评审；不同目的的批注、草稿与轮次分别保留。 |
| **掌握数据的去留** | JSON 导入导出、完整备份、可恢复归档与显式永久删除；支持完成后自动归档。 |

界面跟随系统明暗主题，支持桌面与手机浏览。流程图优先占用画布空间，详情和讨论按需打开。

## 快速开始

需要 **Node.js 22.18+**，推荐 24+。Codex 在线安装还需要 Git；无需手动克隆仓库、安装本工程的 npm 依赖或构建插件。

### 交给 Agent 使用

注册远程 marketplace，安装已构建的插件：

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin
codex plugin add logic-margin@logic-margin-local
```

Codex 管理 Git 检出，只展开插件目录。在需要评审的业务工程中新开 Agent 会话：

```text
$logic-margin:logic-margin
为当前功能发起逻辑评审，重点检查失败时是否会扣费，并等待我的批注。
```

Agent 启动一个后台进程，同时提供 HTTP MCP、评审 API 和内嵌网页。首次用 `server setup` 注册本机 MCP 地址和长工具超时，再按宿主提示重载或重连 MCP，核实工具可用后读取来源、整理流程图并给出评审链接。后续评审复用同一后台，业务工程无需安装 LogicMargin 的 npm 依赖。

更新时，可以让 Agent 执行：

```sh
codex plugin marketplace upgrade logic-margin-local
codex plugin add logic-margin@logic-margin-local
```

随后新开会话，加载新版技能和 CLI 路径。评审数据独立于插件缓存保存。这会更新到 `main` 上已构建的版本；评审过程中不会后台轮询升级。

不想依赖 Git 时，可从 [GitHub Releases](https://github.com/SunneeYang/LogicMargin/releases/latest) 下载 Node 小包及 SHA-256 校验文件。ZIP 安装、从本地 marketplace 迁移、服务重启与可选原生包见 [插件安装文档](docs/agent-plugin.md)。

### 在浏览器中体验

进行源码开发时，克隆仓库后在根目录运行：

```sh
npm ci
npm run dev
```

打开 **http://127.0.0.1:5173**。可直接浏览内置样例，或从“文件 → 导入评审”选择 [订单演示 JSON](docs/examples/order-review.logic-margin.json)，体验图上批注、回复和人工复核。

演示数据用于熟悉交互；真实评审应从实际代码或文档生成流程，并补齐来源依据。

## 评审如何进行

| 步骤 | 操作 |
| --- | --- |
| **1 · 发起** | Agent 按一个明确的审查目的生成流程图，记录来源快照，打开独立评审任务并等待。 |
| **2 · 圈选** | 你在图上查看分支、圈选对象、添加批注；长意见可移到侧栏继续编辑。 |
| **3 · 提交** | 点击“提交本轮”，把当前意见固定成提交包，交给等待中的 Agent。 |
| **4 · 修改** | Agent 修改代码或文档，重新核验来源，将新版流程图与最终回应一起发布。 |
| **5 · 复核** | 你对照前后变化，查看原意见与回应，确认解决、补充意见或确认整轮通过。 |

**保存批注与提交本轮是两个动作。** 已保存的会话批注不会因未提交而消失；等待中的 Agent 在收到明确提交后才继续。回复也不会自动解决意见，最终确认由评审者完成。

Agent 负责读源、改代码和整理流程；LogicMargin 负责呈现、讨论、保存与复核。MCP 等待工具持续挂起，直到人工提交、确认通过或终态错误；普通批注保存与连接保活不需要模型反复检查。服务端不执行项目代码或 shell，也没有内置大模型。

## 独立任务与清理

同一目的的修改沿用原任务的轮次；更换审查对象或目的时，新建任务。MCP 用 `context` 关联同一段 Agent 对话，用 `purpose` 明确本次核对什么。以下兼容 CLI 命令供脚本使用，正常 Agent 评审使用对应 MCP 工具。

```sh
# 查询同一上下文中的活动与归档任务
npm run review -- list --context order-checkout --state all

# 默认归档，保留完整图、批注和历史
npm run review -- cleanup <sessionId>

# 恢复归档任务
npm run review -- restore <sessionId>

# 明确永久删除指定任务，无法从服务端恢复
npm run review -- cleanup <sessionId> --mode delete
```

网页“文件 → 管理评审任务”也提供建立、备份、归档、恢复和删除入口。默认仅清理已通过的任务；未完成任务的显式清理、命令参数与并发保护见 [Agent 工作流](docs/agent-workflow.md#查询归档与删除)。

MCP `wait_review` 不领取、不归档；Agent 实际读取意见后用 `acknowledge_review` 领取。设置 `cleanup_on_approval` 后，实际取得最终批准才调用 `cleanup_review`；期间出现新意见会阻止旧版本清理。轮次、批注和历史不设固定业务条数上限，仍保留单条内容及单次请求的资源校验。

<details>
<summary><strong>数据保存在哪里？如何从另一台设备访问？</strong></summary>

- **共享任务**：流程、批注、回复与历史保存在服务所在机器。托管服务默认使用 `~/.logic-margin/sessions`，开发服务使用工程的 `.logic-margin/sessions`；可配置实际目录。
- **浏览器内容**：尚未添加的草稿、待同步操作和独立文件模式的数据保存在当前浏览器、当前访问地址，不会自动出现在其他设备上。
- **私有网络访问**：开发服务默认监听 `0.0.0.0:5173`；局域网设备可使用本机的局域网地址。使用 Tailscale 时，将评审链接地址设置为服务机器的 Tailscale 地址。
- **MCP 访问**：即使网页分享到私有网络，MCP 也只接受本机回环连接，与需核验的源码工作区位于同一机器。
- **使用边界**：评审 API 面向受信任的本机或私有网络，尚未提供账号和权限管理。来源摘要校验也不能代替对流程语义的人工复核。

</details>

## 文档

| 我想了解… | 从这里开始 |
| --- | --- |
| 插件安装、自动启动、分发与跨平台入口 | [Agent 插件](docs/agent-plugin.md) |
| 发起、等待、回复、发布新版和清理 | [Agent 工作流](docs/agent-workflow.md) |
| 流程图 JSON、稳定 ID 与来源摘要 | [评审文件格式](plugins/logic-margin/skills/logic-margin/references/review-format.md) |
| 跨轮对比、批注迁移与原位置 | [跨轮评审设计](docs/revision-review-design.md) |
| 同步、渲染和测量边界 | [性能优化](docs/performance-optimization.md) |
| 内置样例的真实源码与覆盖范围 | [通灵样例](docs/sample-source.md) · [魔灵秘境](docs/spirit-sanctum-source.md) |

<details>
<summary><strong>本地开发与验证</strong></summary>

```sh
npm ci
npm run dev         # 网页与评审 API
npm test            # 模型、客户端、CLI 与服务端测试
npm run build       # TypeScript 检查与生产构建
npm run test:agent  # 分发包集成测试

npx playwright install chromium
npm run test:e2e    # 桌面、移动端与系统明暗主题的交互测试
```

已有 Chrome 时也可运行 `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`。

技术栈：React 19、TypeScript、React Flow、Vite，以及基于 Node.js 的本地 HTTP 服务。默认 Node 分发包不内嵌运行时；可选 Bun 原生包的构建说明见 [插件文档](docs/agent-plugin.md#开发与验证)。

</details>

## 致谢

特别感谢 **[Crit](https://github.com/tomasz-tomczyk/crit)** 为浏览器批注、明确提交与 Agent 等待评审的工作流提供启发。LogicMargin 借鉴这些交互机制，围绕业务流程节点与逻辑关系，自行实现图上批注、跨轮复核与评审任务管理。相关主源与设计取舍记录在 [Crit 参考说明](docs/crit-reference.md)。

感谢 **[React Flow / xyflow](https://github.com/xyflow/xyflow)** 提供流程图画布基础。
