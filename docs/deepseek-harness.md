# DeepSeek Harness 适配

LogicMargin 的 DSH 插件启动或复用原生 Go 服务，接入 DSH 官方 MCP Client，并注册 `logic-margin` 技能。流程图、源码核验、固定 B/R、意见领取与多轮复核沿用同一后端。

当前兼容基线为 **DSH `0.2.2-rc.1`、LogicMargin `0.9.15`**。当前 master 文档中的 `mcpManager` 不存在于该发布包；本适配使用双方共有的异步插件接口，不能据此承诺其他 DSH 版本兼容。

`agent-tmp-run` 是开发机可选的临时文件 harness，不是公共依赖；以下命令可从仓库根目录执行。有本地 AGENTS 强制要求时仍须使用本地 harness 包裹命令。

## 生成与安装

在 LogicMargin 源码根目录用 Node.js/npm 生成制品：

```sh
npm run package:dsh
```

生成 `artifacts/dsh-plugin-logicmargin-0.9.15.tgz` 和同名 `.sha256`。它包含入口、bundle patch、中英元数据、技能、MIT 许可和固定版本下载启动器，不含另一份 DSH、Go 编译器或原生程序。不要直接安装 `plugins/deepseek-harness` 源码目录：随包资源由打包脚本生成。

正式发行流水线将它与五个平台的原生 ZIP 一起构建，核对包内版本和许可，写入统一 `SHA256SUMS` 后上传到对应 GitHub Release。该流程不自动发布 npm 或提交市场收录；已发布的 `v0.9.6` Release 不会因修改流水线而自动增加附件。

从 [v0.9.15 Release](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.15) 下载 `dsh-plugin-logicmargin-0.9.15.tgz` 与同名 `.sha256`，核验后按下文安装。GitHub Release 是本包的直接分发入口；npm 与社区 Discover 收录另行发布，不能把 Release 下载等同于已上架市场。

安装到实际使用的 profile：

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-logicmargin-0.9.15.tgz
```

重载该插件/profile，核对技能 `logic-margin` 和 `mcp__logic_margin__start_review`、`mcp__logic_margin__wait_review` 工具。让 Agent 在待评审工程中使用 `logic-margin` 技能，读取真实来源、整理评审并给出页面链接。安装成功、技能被发现、MCP 可调用需要分别确认。

Web profile 可用 `dsh --profile YOUR_PROFILE --host 127.0.0.1 --port 0 --no-open` 启动，宿主打印的登录链接带临时令牌，只供本机使用。DSH 的 `desktop` 是 Electron 保留 profile，CLI 不允许用它初始化或启动；Desktop 应用内的实际加载尚需单独验收。

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

已安装 DSH 时，可将 tgz 安装到临时 profile，用真实 CLI 的 `runProfile` 启动完整默认 Web 组合进行验证。测试不提交模型提示词，临时 HOME 中没有真实账号配置，不需要 DeepSeek 登录：

```sh
env \
  LOGIC_MARGIN_DSH_ROOT=/absolute/path/to/node_modules/@deepseek-ai/dsh \
  node scripts/dsh-integration.mjs \
  artifacts/dsh-plugin-logicmargin-0.9.15.tgz \
  .scratch/dsh-web-integration.json
```

`agent-tmp-run` 是本开发环境的临时目录管理器；其他环境可提供同等独立的 `CODEX_AGENT_TMP` 并在结束后回收。脚本要求该变量，隔离 HOME、DSH profile、包缓存、LogicMargin home 和会话目录。测试需要网络下载和本机监听权限，包含一次超过 60 秒的真实等待；不使用正式服务或数据。

兼容验收必须区分：本机默认 Web Host 的 HTTP/API/MCP/技能验证、浏览器界面、Desktop、实际模型按技能执行、Windows/Linux 原生运行。源码契约与早期 fixture 验证见[接口核查报告](deepseek-harness-adaptation-plan.md)；它们不能替代真实 tgz 联调。

### 本轮实际验收

2026-11-09，macOS ARM64、Node `26.13.0`、真实 DSH `0.2.2-rc.1`：

- 临时 profile 实际安装 tgz，以宿主 `PluginPackages` 和 Loader 加载入口，官方 peers 共享安装实例；未加载模型、账号插件或 Agent runner。
- 固定 `0.9.6` 原生启动器使用空的隔离缓存，从官方 Release 下载、校验并启动；技能正文、相对资源及全部 11 个 MCP 工具可用且均实际调用。
- `wait_review` 持续 **约 65.4 秒**，保存批注不返回，提交后交付固定意见，不自动领取或归档；显式领取、回复、源码修订、模拟人工通过、归档与恢复完成闭环。
- 调用方取消在本轮两次验证中均于 10 毫秒内返回错误，未改变领取记录或归档状态；**没有给远端 Go handler 加观测，不能据此断言它已退出**。
- 卸载撤销工具和技能，原隔离后台保持运行；停止并重启隔离后台、显式重载插件后，读取同一 session，材料完全一致。没有将此结果当作旧在途等待自动恢复的证据。
- 测试结束停止隔离后台，harness 回收测试 profile、数据和缓存；未改真实 DSH/Codex profile 或正式服务。

以上最小 Loader 验证的原始报告为 `.scratch/dsh-integration.json`。后续完整默认 Web profile 验证在 `.scratch/dsh-web-integration.json`，两者包含各自制品及原生程序 SHA-256：

- 真实 Web 默认组合启动，认证 HTTP 插件清单确认 LogicMargin 为 active；会话技能接口可发现 `logic-margin`。该步骤创建一个临时 Agent 会话，未提交模型提示词。
- 同一完整宿主上的全部 11 个 MCP 工具、65 秒等待、显式领取、多轮修订与归档恢复、卸载和重启重载均通过。
- 宿主停机失败的故障注入确认：DSH 强制退出时使用非零状态，失败报告已保存，隔离 Go 后台已提前退出；证据在 `.scratch/dsh-cleanup-fault-check.json`。
- 适配和发行校验共 29 项通过；五个平台 ZIP 与 DSH tgz 实际构建并通过统一校验，所有候选包携带 MIT。共 13 个分发文件，包括 6 个归档、6 个 SHA-256 文件和 `SHA256SUMS`。

Desktop、浏览器交互、模型实际执行技能、Windows/Linux 本机运行及其他 DSH 版本尚未验收。交叉构建成功不代替目标系统运行验证。

## 市场与账号

本地 tgz 安装无需 DeepSeek 模型账号登录。模型登录只解决模型鉴权，与插件市场收录独立。

1. **npm 分发**：项目已采用 [MIT](../LICENSE)，DSH 包携带同一许可。确认包名和 npm 发布权限，审阅生成的 tgz 后再发布；DSH 的模型登录不能代替 npm 账号的发布权限。
2. **社区目录**：按 [awesome-dsh-plugin 投稿规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)提交独立收录请求；npm 发布并不自动被收录。
3. **Discover**：官方 Discover 默认没有索引源；选择的索引需要包含该包。社区目录条目与其 npm 关联、市场索引导出也需分别核对。
4. **Official 清单 / GitHub topic**：都是独立入口，不等于 npm 发布或社区审核通过。

本轮只准备可安装制品和验证路径，不执行 npm 发布、市场投稿、GitHub topic 修改或真实 profile 安装。MIT 选择已确认，最终外部发布动作需另行授权。市场事实的一手资料与固定来源见[接口核查报告](deepseek-harness-adaptation-plan.md#4-发布与社区收录只读复核)。

### 登录与发布入口

npm 需要 npm 账号，社区投稿使用 GitHub 账号，Discover 安装不要求存在一个统一的“市场登录”。以下是公开发行时的操作顺序，当前未执行登录或实际发布：

```sh
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm publish /absolute/path/dsh-plugin-logicmargin-X.Y.Z.tgz --dry-run --ignore-scripts --access public
```

先检查 dry-run 的文件、版本和许可；获得发布授权后，再去掉 `--dry-run` 发布**生成的 tgz**，不要从缺少生成资源的源码子目录直接发布。npm 登录可能要求浏览器认证和账号的双因素验证，凭据不放进仓库或插件。

本轮使用空的临时 npm 配置完成了真实 `npm publish --dry-run`，文件与 MIT 许可检查通过；它不证明某个账号已登录或具备最终发布权限。

社区目录的待投内容如下，目标文件名为 `data/plugins/SunneeYang__LogicMargin--plugins-deepseek-harness.yml`。投稿前先让代码在 `main` 可见，并把 `X.Y.Z` 替换为实际已发布、具有该 tgz 附件的版本；历史 `v0.9.6` 没有此附件，不能把本地候选包当作已发布下载地址。

```yaml
url: https://github.com/SunneeYang/LogicMargin/tree/main/plugins/deepseek-harness
name: SunneeYang/LogicMargin#deepseek-harness
category: workflow
description:
  en: Source-backed logic reviews with diagrams, code diffs, and resumable human feedback.
  zh: 用有源码依据的流程图和代码差异开展人工评审，保留批注、回复与多轮修订。
tarball: https://github.com/SunneeYang/LogicMargin/releases/download/vX.Y.Z/dsh-plugin-logicmargin-X.Y.Z.tgz
```

源码目录依赖打包时生成资源，不能直接安装，所以在 npm 映射可用前应提供有效 `tarball`。使用固定 tag 配合带版本文件名，避免 `latest/download` 在下一版指向不存在的旧文件名。不手改社区生成的 README，也不在条目中加入其协议未定义的 `npm` 字段；合并收录后再核对所用 Discover 索引与实际安装结果。
