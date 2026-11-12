# DeepSeek Harness 适配

LogicMargin 的 DSH 插件启动或复用原生 Go 服务，接入 DSH 官方 MCP Client，并注册 `logic-margin` 技能。流程图、源码核验、固定 B/R、意见领取与多轮复核沿用同一后端。

当前兼容基线为 **DSH `0.2.2-rc.1`、LogicMargin `0.9.18`**。当前 master 文档中的 `mcpManager` 不存在于该发布包；本适配使用双方共有的异步插件接口，不能据此承诺其他 DSH 版本兼容。

## 从 npm 安装（推荐）

[`dsh-plugin-logicmargin@0.9.18`](https://www.npmjs.com/package/dsh-plugin-logicmargin/v/0.9.18) 已公开发布。使用 DSH 支持的 Node.js 环境，并确保 `pnpm` 在 PATH 中；`dsh plugin` 会把包管理命令转发给 pnpm，命令形式见 [DSH 官方 CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

将 `YOUR_PROFILE` 换成实际使用的 profile：

```sh
dsh plugin --profile YOUR_PROFILE add dsh-plugin-logicmargin@0.9.18 --save-exact --registry=https://registry.npmjs.org
```

命令从官方 npm registry 安装固定版本。安装公开包无需 npm 发布账号或 DeepSeek 模型账号登录，也无需克隆或构建 LogicMargin。

重载该插件/profile，核对技能 `logic-margin`，再实际调用只读 `mcp__logic_margin__list_reviews` 确认 MCP 链路可用。之后在待评审工程中使用技能读取真实来源、整理评审并给出页面链接。安装成功、技能被发现、MCP 可调用需要分别确认。

Web profile 可用 `dsh --profile YOUR_PROFILE --host 127.0.0.1 --port 0 --no-open` 启动，宿主打印的登录链接带临时令牌，只供本机使用。DSH 的 `desktop` 是 Electron 保留 profile，CLI 不允许用它初始化或启动；Desktop 应用内的实际加载尚需单独验收。

第一次激活通过既有 `.sh`/`.ps1` 启动器下载官方同版平台 ZIP，先核对 SHA-256 再运行。macOS/Linux 需要 `curl`、`unzip` 以及 `shasum` 或 `sha256sum`；Windows 使用 PowerShell。五个平台与 Go 原生发行包一致，用户不需要安装 Go。

## GitHub tgz 安装（备用）

从 [v0.9.18 Release](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.18) 下载 `dsh-plugin-logicmargin-0.9.18.tgz` 与同名 `.sha256`，核验后安装到同一个目标 profile：

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-logicmargin-0.9.18.tgz
```

安装后执行相同的重载、技能发现和只读 MCP 检查。直接安装 `plugins/deepseek-harness` 源码目录缺少打包时生成的资源，应使用 npm 包或完整 tgz。

## 服务、数据与更新

- 默认复用当前用户已有的兼容本机服务。版本或端口不兼容时明确失败，不自动停止、覆盖或更新旧服务。
- 可选配置 `home` 为绝对路径，`port` 为 0–65535；0 表示可用端口。独立 home 隔离服务登记，默认数据位于 `<home>/sessions`。宿主显式传入 `LOGIC_MARGIN_DATA_DIR` 时沿用该值；已运行服务保留其登记的数据目录。变更目录前必须核对实际服务，不能只改环境变量就认为完成迁移。
- DSH 使用 `server start`，**不要运行 Codex 专用 `server setup`**。不修改 Codex 的 MCP 配置。
- 插件卸载撤销其工具、连接与技能，保留可能由其他宿主使用的后台及评审数据。
- 更新 DSH 包时，在同一 profile 再执行上述 npm `add` 命令，把版本换成准备采用的已发布兼容版本，再重载。它也可将原 tgz 安装切换到 npm 来源；`--save-exact` 保持版本固定。网页一键更新目前针对 Codex，不能用它更新 DSH 包。升级原生服务前备份数据并核对实例，沿用原 home、端口与 session ID；不能由一个宿主擅自关闭其他宿主正在使用的服务。

本适配面向本机执行。MCP 与源码工程必须同机；Tailscale/局域网可分享网页，不能把远程 provider 的文件当成本机文件，也不开放远程 MCP。

## 等待与恢复

官方 MCP Client 的默认单次工具期限为 60 秒；本插件把自己的连接设为 **24 小时**，使正常人工评审可超过一分钟。该值是单次预算，不保证无限或持久执行，也不覆盖上层宿主额外设置的期限。

`wait_review` 等待固定意见提交或人工通过。保存一条批注不会完成等待；等待返回后由 Agent 实际阅读，再显式 `acknowledge_review` 领取。取消、断线或卸载不领取、不归档。重连后读取原 session，核对未处理历史并使用最后实际处理的 `after_submission` 继续；旧的在途调用不会自动续接。

## 源码打包与开发验证

维护者可在仓库根目录运行：

```sh
npm run package:dsh
```

生成 `artifacts/dsh-plugin-logicmargin-0.9.18.tgz` 和同名 `.sha256`，包含入口、bundle patch、中英元数据、技能、MIT 许可和固定版本下载启动器，不含另一份 DSH、Go 编译器或原生程序。正式发行流水线将它与五个平台原生 ZIP 一起构建、核对版本和许可，生成 `SHA256SUMS` 后上传 GitHub Release；npm 发布和市场投稿仍分别执行。

`agent-tmp-run` 是开发机的临时文件 harness，不是公共安装依赖；有本地 AGENTS 要求时按其规则包裹命令。

轻量边界、打包与真实子进程测试：

```sh
npm run test:dsh
```

已安装 DSH 时，可将 tgz 安装到临时 profile，用真实 CLI 的 `runProfile` 启动完整默认 Web 组合进行验证。测试不提交模型提示词，临时 HOME 中没有真实账号配置，不需要 DeepSeek 登录：

```sh
env \
  LOGIC_MARGIN_DSH_ROOT=/absolute/path/to/node_modules/@deepseek-ai/dsh \
  node scripts/dsh-integration.mjs \
  artifacts/dsh-plugin-logicmargin-0.9.18.tgz \
  .scratch/dsh-web-integration.json
```

`agent-tmp-run` 是本开发环境的临时目录管理器；其他环境可提供同等独立的 `CODEX_AGENT_TMP` 并在结束后回收。脚本要求该变量，隔离 HOME、DSH profile、包缓存、LogicMargin home 和会话目录。测试需要网络下载和本机监听权限，包含一次超过 60 秒的真实等待；不使用正式服务或数据。

兼容验收必须区分：本机默认 Web Host 的 HTTP/API/MCP/技能验证、浏览器界面、Desktop、实际模型按技能执行、Windows/Linux 原生运行。源码契约与早期 fixture 验证见[接口核查报告](deepseek-harness-adaptation-plan.md)；它们不能替代真实 tgz 联调。

### 0.9.18 发行验收

2026-11-12，公开 [v0.9.18 Release](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.18) 的 13 个附件通过匿名下载、摘要、版本和许可校验。真实隔离 DSH `0.2.2-rc.1` 在 macOS ARM64 上调用全部 11 个工具；等待 **65.355 秒**，保存批注不结束等待，提交、领取、修订、批准、归档、恢复、取消及卸载重载通过。

已发布 npm 包的匿名下载结果与该 GitHub tgz 逐字节一致，SHA1、SHA256、SHA512 以及 17 份文件的路径、权限和内容均匹配。此次 npm 验收未重复安装 DSH；它与上述运行验收使用同一份包。

### 早期适配验收（0.9.6）

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

1. **npm 分发**：[`dsh-plugin-logicmargin@0.9.18`](https://www.npmjs.com/package/dsh-plugin-logicmargin/v/0.9.18) 已发布，采用 [MIT](../LICENSE)。用户按本文安装命令即可使用公开包；npm 账号和发布权限由维护者在发布时使用。
2. **社区目录**：按 [awesome-dsh-plugin 投稿规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)维护条目，核对 npm 包与源码仓库的关联；npm 发布不会自动完成目录收录。
3. **Discover**：以实际配置的索引、条目和安装结果为准，不能用 npm 已发布代替指定 Discover 来源可发现、可安装的验收。
4. **Official 清单 / GitHub topic**：都是独立入口，不等同于 npm 发布或社区审核。DeepSeek 模型账号登录用于模型鉴权，与这些分发入口独立。

市场协议与早期调查来源见[接口核查报告](deepseek-harness-adaptation-plan.md#4-发布与社区收录只读复核)，其中带日期的发布前观察保留其历史含义。

### 维护者发布

GitHub 发行流水线不会自动向 npm 发布。维护者使用已公开下载并核验的 GitHub Release tgz，替换下面的路径和 `X.Y.Z`：

```sh
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm publish /absolute/path/dsh-plugin-logicmargin-X.Y.Z.tgz --dry-run --ignore-scripts --access public --registry https://registry.npmjs.org
npm publish /absolute/path/dsh-plugin-logicmargin-X.Y.Z.tgz --ignore-scripts --access public --tag latest --registry https://registry.npmjs.org
```

先核对 dry-run 的文件、版本与许可，再按项目发布授权执行正式发布。npm 可能分别要求 CLI 登录和本次发布的浏览器/安全密钥确认；凭据保存在用户环境中，不写入仓库或插件。发布结果不明时先查 registry，避免重复上传。Registry 提示处理中时，等固定版本与 `latest` 公开可见，再匿名下载 tarball，与已验收包核对摘要和文件内容。

更新社区目录或 Discover 条目前，按其当前协议核对仓库地址、npm 关联和实际安装目标；沿用已存在的条目，不因新版本重复投稿。没有 npm 映射的渠道仍可使用固定版本 GitHub tgz；不向目录 YAML 擅加协议未定义的 `npm` 字段。
