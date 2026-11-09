# LogicMargin 0.9.1 原生插件

0.9.1 默认使用一个 Go 可执行文件，包含 HTTP MCP、评审 API、会话管理、CLI 和现有 React 网页。用户无需安装 Node.js、Go、Bun 或 npm；Node.js 和 Go 仅用于源码开发与构建。旧 Node 后端仅保留为开发兼容对照。

## 选择并校验 ZIP

从 [GitHub Release v0.9.1](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.1) 下载 `logic-margin-agent-0.9.1-TARGET.zip` 与同名 `.zip.sha256`：

| 平台 | TARGET |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Linux ARM64 | `linux-arm64` |
| Linux x64 | `linux-x64` |
| Windows x64 | `win32-x64` |

macOS 用 `shasum -a 256 -c ZIP文件名.sha256`，Linux 用 `sha256sum -c ZIP文件名.sha256`。PowerShell 用 `certutil -hashfile .\ZIP文件名 SHA256`，与 `.sha256` 中的摘要比较。校验一致后解压到持久位置；每个 ZIP 只含本平台程序，运行时无需再次下载。

将解压后的 ZIP 顶层目录注册为本地 marketplace，例如：

```sh
codex plugin marketplace add /absolute/path/to/logic-margin-agent-0.9.1-darwin-arm64
codex plugin add logic-margin@logic-margin-local
```

Windows 换成实际的 `logic-margin-agent-0.9.1-win32-x64` 目录。安装本身不搬迁评审数据，也不代表当前 Agent 已加载 MCP 工具。

## 原生入口与 MCP

在解压后的 ZIP 顶层目录中，将入口绝对路径记为 `LM_CLI`：

```sh
LM_CLI="$PWD/plugins/logic-margin/skills/logic-margin/scripts/logic-margin"
"$LM_CLI" --help
"$LM_CLI" server setup
"$LM_CLI" server status
```

macOS/Linux 保留程序执行权限。Windows PowerShell 用：

```powershell
$LM_CLI = (Resolve-Path '.\plugins\logic-margin\skills\logic-margin\scripts\logic-margin.exe').Path
& $LM_CLI --help
& $LM_CLI server setup
& $LM_CLI server status
```

`server setup` 启动或复用后台，并通过短暂的 Codex 配置进程注册当前 Codex home 的本机 MCP 地址与长工具超时。按返回的 `reloadRequired` 在原宿主重载/重连，核实 `start_review`、`wait_review` 等工具实际可用后再评审。正常审查通过技能和 HTTP MCP 完成；已有兼容命令由 `--help` 查询。

Git marketplace 安装与此 ZIP 入口不同：它使用 `scripts/logic-margin.sh` / `scripts/logic-margin.ps1`，从官方 Release 下载与插件固定版本一致的本平台 ZIP 并校验 SHA-256，再执行原生程序。ZIP 本身直接使用包内的 `logic-margin` / `logic-margin.exe`。

## 旧数据与升级

默认会话在 `~/.logic-margin/sessions`，独立于插件缓存；自定义时沿用实际的 `LOGIC_MARGIN_HOME` / `LOGIC_MARGIN_DATA_DIR`。旧 Node 与新 Go 不能同时写同一目录。

升级前用 `server status` 核对旧后台登记身份、健康与版本，用 `server stop` 停止确认归属的受管实例，确认退出后备份实际数据目录。身份不明或进程存活但不健康时保留现场诊断，不按端口强杀、不删登记或会话文件绕过保护。校验并注册新版 ZIP 后，重新定位入口，用 `server start` 沿用原端口、数据和 session ID；需要修复 MCP 注册时用 `server setup`，随后重连 MCP 并以 `get_review` 核对原轮次和未处理意见。插件更新不代表评审通过。

网页需局域网/Tailscale 访问时，按授权用 `"$LM_CLI" server start --host 0.0.0.0 --port 5173`；实际地址以返回值为准。`--public-url` 只改变分享链接。MCP 继续只接受本机连接；远程 MCP、账号、权限与多人协作尚未实现。

## 阅读与验收范围

代码对照只使用固定基线 B 与轮次 R 保存的源码片段，不补读当前工作区。统一/并排共用单一竖向滚动入口，可逐次展开上下文。文本差异默认可读；支持语法可切换结构重点，明确移动且修改的块可与原位置局部对照。不支持、无效语法、不确定边界或预算耗尽时保留文本回退。它不使用 SemanticDiff 引擎，也不证明通用语义等价。

五目标交叉编译与各平台原生运行分别验收。历史迁移记录只有 macOS ARM64 实际运行，其他平台和真实手机网络仍需单独验证；不能凭生成 ZIP 声称已通过目标系统验收。详细历史结果见 [Go 迁移验收](https://github.com/SunneeYang/LogicMargin/blob/main/docs/go-backend-validation.md)、[结构 diff](https://github.com/SunneeYang/LogicMargin/blob/main/docs/structural-diff.md) 与 [完整安装说明](https://github.com/SunneeYang/LogicMargin/blob/main/docs/agent-plugin.md)。
