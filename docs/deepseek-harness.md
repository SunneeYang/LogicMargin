# DeepSeek Harness 适配

LogicMargin 的 DSH 插件启动或复用原生 Go 服务，接入 DSH 官方 MCP Client，并注册 `logic-margin` 技能。流程图、源码核验、固定 B/R、意见领取与多轮复核沿用同一后端。

当前兼容基线为 **DSH `0.2.2-rc.1`、LogicMargin `0.9.6`**。当前 master 文档中的 `mcpManager` 不存在于该发布包；本适配使用双方共有的异步插件接口，不能据此承诺其他 DSH 版本兼容。

## 生成与安装

在 LogicMargin 源码根目录用 Node.js/npm 生成制品：

```sh
npm run package:dsh
```

生成 `artifacts/dsh-plugin-logicmargin-0.9.6.tgz`。它包含入口、bundle patch、中英元数据、技能和固定版本下载启动器，不含另一份 DSH、Go 编译器或原生程序。不要直接安装 `plugins/deepseek-harness` 源码目录：随包资源由打包脚本生成。

安装到实际使用的 profile：

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-logicmargin-0.9.6.tgz
```

重载该插件/profile，核对技能 `logic-margin` 和 `mcp__logic_margin__start_review`、`mcp__logic_margin__wait_review` 工具。让 Agent 在待评审工程中使用 `logic-margin` 技能，读取真实来源、整理评审并给出页面链接。安装成功、技能被发现、MCP 可调用需要分别确认。

第一次激活通过既有 `.sh`/`.ps1` 启动器下载官方同版平台 ZIP，先核对 SHA-256 再运行。macOS/Linux 需要 `curl`、`unzip` 以及 `shasum` 或 `sha256sum`；Windows 使用 PowerShell。五个平台与 Go 原生发行包一致，用户不需要安装 Go。DSH 本身仍需要其支持的 Node.js 环境。

## 服务、数据与更新

- 默认复用当前用户已有的兼容本机服务。版本或端口不兼容时明确失败，不自动停止、覆盖或更新旧服务。
- 可选配置 `home` 为绝对路径，`port` 为 0–65535；0 表示可用端口。独立 home 隔离服务登记，默认数据位于 `<home>/sessions`。宿主显式传入 `LOGIC_MARGIN_DATA_DIR` 时沿用该值；已运行服务保留其登记的数据目录。变更目录前必须核对实际服务，不能只改环境变量就认为完成迁移。
- DSH 使用 `server start`，**不要运行 Codex 专用 `server setup`**。不修改 Codex 的 MCP 配置。
- 插件卸载撤销其工具、连接与技能，保留可能由其他宿主使用的后台及评审数据。
- 更新 DSH 包使用宿主包管理；网页一键更新目前针对 Codex，不能用它更新 DSH 包。升级原生服务前备份数据并核对实例，沿用原 home、端口与 session ID；不能由一个宿主擅自关闭其他宿主正在使用的服务。

本适配面向本机执行。MCP 与源码工程必须同机；Tailscale/局域网可分享网页，不能把远程 provider 的文件当成本机文件，也不开放远程 MCP。

## 等待与恢复

官方 MCP Client 的默认单次工具期限为 60 秒；本插件把自己的连接设为 **24 小时**，使正常人工评审可超过一分钟。该值是单次预算，不保证无限或持久执行，也不覆盖上层宿主额外设置的期限。

`wait_review` 等待固定意见提交或人工通过。保存一条批注不会完成等待；等待返回后由 Agent 实际阅读，再显式 `acknowledge_review` 领取。取消、断线或卸载不领取、不归档。重连后读取原 session，核对未处理历史并使用最后实际处理的 `after_submission` 继续；旧的在途调用不会自动续接。

## 开发验证

轻量边界、打包与真实子进程测试：

```sh
npm run test:dsh
```

已安装 DSH 时，可用真实 Loader 和安装到临时 profile 的 tgz 验证；不挂模型、账号插件或 Agent runner，不需要 DeepSeek 登录或模型推理：

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run env \
  LOGIC_MARGIN_DSH_ROOT=/absolute/path/to/node_modules/@deepseek-ai/dsh \
  node scripts/dsh-integration.mjs \
  artifacts/dsh-plugin-logicmargin-0.9.6.tgz \
  .scratch/dsh-integration.json
```

`agent-tmp-run` 是本开发环境的临时目录管理器；其他环境可提供同等独立的 `CODEX_AGENT_TMP` 并在结束后回收。脚本要求该变量，隔离 HOME、DSH profile、包缓存、LogicMargin home 和会话目录。测试需要网络下载和本机监听权限，包含一次超过 60 秒的真实等待；不使用正式服务或数据。

兼容验收必须区分：本机真实 DSH Host/MCP/技能验证、Desktop 界面、实际模型按技能执行、Windows/Linux 原生运行。源码契约与早期 fixture 验证见[接口核查报告](deepseek-harness-adaptation-plan.md)；它们不能替代真实 tgz 联调。

### 本轮实际验收

2026-11-09，macOS ARM64、Node `26.13.0`、真实 DSH `0.2.2-rc.1`：

- 临时 profile 实际安装 tgz，以宿主 `PluginPackages` 和 Loader 加载入口，官方 peers 共享安装实例；未加载模型、账号插件或 Agent runner。
- 固定 `0.9.6` 原生启动器使用空的隔离缓存，从官方 Release 下载、校验并启动；技能正文、相对资源及全部 11 个 MCP 工具可用且均实际调用。
- `wait_review` 持续 **约 65.4 秒**，保存批注不返回，提交后交付固定意见，不自动领取或归档；显式领取、回复、源码修订、模拟人工通过、归档与恢复完成闭环。
- 调用方取消在本轮两次验证中均于 10 毫秒内返回错误，未改变领取记录或归档状态；**没有给远端 Go handler 加观测，不能据此断言它已退出**。
- 卸载撤销工具和技能，原隔离后台保持运行；停止并重启隔离后台、显式重载插件后，读取同一 session，材料完全一致。没有将此结果当作旧在途等待自动恢复的证据。
- 测试结束停止隔离后台，harness 回收测试 profile、数据和缓存；未改真实 DSH/Codex profile 或正式服务。

本地原始报告为 `.scratch/dsh-integration.json`，包含制品及原生程序 SHA-256。适配单测与发行校验各 10 项通过。Desktop、模型实际执行技能、Windows/Linux 本机运行及其他 DSH 版本尚未验收。

## 市场与账号

本地 tgz 安装无需 DeepSeek 模型账号登录。模型登录只解决模型鉴权，与插件市场收录独立。

1. **npm 分发**：确认包名和发布权限，明确项目许可，审阅 tgz 后再发布。当前包声明 `UNLICENSED`，不是已决定使用 MIT；仓库尚无项目级许可文件。
2. **社区目录**：按 [awesome-dsh-plugin 投稿规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)提交独立收录请求；npm 发布并不自动被收录。
3. **Discover**：官方 Discover 默认没有索引源；选择的索引需要包含该包。社区目录条目与其 npm 关联、市场索引导出也需分别核对。
4. **Official 清单 / GitHub topic**：都是独立入口，不等于 npm 发布或社区审核通过。

本轮只准备可安装制品和验证路径，不执行 npm 发布、市场投稿、GitHub topic 修改或真实 profile 安装。公开上架之前仍需用户确认许可和最终外部发布动作。市场事实的一手资料与固定来源见[接口核查报告](deepseek-harness-adaptation-plan.md#4-发布与社区收录只读复核)。
