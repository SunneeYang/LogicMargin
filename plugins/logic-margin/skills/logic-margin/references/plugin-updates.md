# 插件安装与更新

适用于具备本地命令执行能力的 Codex。0.9.0 默认运行 Go 原生程序，用户无需安装 Node.js、Go、Bun 或 npm。Git marketplace 需要 Git，首次启动需要联网；macOS/Linux 下载启动器还需要 `curl`、`unzip` 与 `shasum` 或 `sha256sum`，Windows 使用 PowerShell。用户已要求更新时直接执行。其他 Agent 可使用平台 ZIP 内的 CLI 或受支持的 HTTP MCP 客户端，ZIP 本身不会把 MCP 注册到其他宿主。

## 首次安装或从本地目录迁移

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin --json
codex plugin add logic-margin@logic-margin-local --json
```

同名本地 marketplace 会切换到 Git 来源，原源码或解压目录保留。此路径包含 `scripts/logic-margin.sh` / `scripts/logic-margin.ps1`，按插件固定版本从官方 GitHub Release 下载本平台 ZIP 并校验 SHA-256，再运行原生程序；不在用户机器编译，不追随浮动 latest。

无需 Git 时，从 [Release v0.9.0](https://github.com/SunneeYang/LogicMargin/releases/tag/v0.9.0) 选择 `logic-margin-agent-0.9.0-TARGET.zip` 和 `.zip.sha256`。TARGET 为 `darwin-arm64`（macOS Apple Silicon）、`darwin-x64`（macOS Intel）、`linux-arm64`、`linux-x64` 或 `win32-x64`（Windows x64）。校验 SHA-256 后解压到持久位置，以 ZIP 顶层目录执行 `codex plugin marketplace add /absolute/path/to/logic-margin-agent-0.9.0-TARGET`，再添加插件。ZIP 内直接使用 `scripts/logic-margin` / `scripts/logic-margin.exe`；PowerShell 用 `& $LM_CLI` 调用实际入口。

## 检查与更新

只检查时不停止服务。用户要求更新已有安装时，先按下一节识别并停止旧受管实例、备份实际数据，再替换插件文件：

```sh
codex plugin marketplace upgrade logic-margin-local --json
codex plugin list --json
```

核对 `upgrade.errors` 为空；非空则报告具体错误并保留现有安装。`plugin list` 的 installed 与 available 可用于核对已安装和可用版本。用户仅要求检查时，到此报告实际版本；用户要求更新时，继续：

```sh
codex plugin add logic-margin@logic-margin-local --json
```

核对成功返回的 `version` 和 `installedPath`，报告实际安装版本与路径。Git marketplace 跟随注册的 ref；固定 tag 时不会自动跳到更高 tag。仍是本地目录来源时，按“首次安装”切换，或按用户指定的新 ZIP 路径重新注册。

## 更新后使用

1. 记录实际会话目录，用当前入口的 `server status` 核对受管实例的身份、健康、版本与端口。默认数据是 `~/.logic-margin/sessions`，自定义时沿用原 `LOGIC_MARGIN_HOME` / `LOGIC_MARGIN_DATA_DIR`。
2. 用 `server stop` 停止经身份核验的旧实例，确认进程退出后备份实际会话目录，再更新插件。新版原生 CLI 也可检查和停止登记的旧实例。进程仍在但身份不匹配或不健康时保留现场诊断，不按端口强杀、不删登记或会话文件。Node 与 Go 不能同时写同一目录。
3. Codex 会移除旧版本缓存；通过原宿主重新加载技能并按新版 `installedPath` 定位 `LM_CLI`，保留原 home、端口、数据和 session ID。旧路径可能失效，文件下载不代表后台或在途等待已切换。
4. 用新版入口 `server start` 启动并检查 `server status`。首次连接或修复 MCP 注册时用 `server setup`，它只通过短暂的 Codex 配置进程写入当前 home 的 `logic_margin` 地址与长工具超时；不新增常驻 stdio 服务。
5. 按 `reloadRequired` 在原宿主重载/重连 MCP，核实工具可用，用 `get_review` 核对原 session ID、目的、轮次与尚未处理的反馈，再继续正常评审。更新不代表评审通过。

插件缓存独立于会话数据，升级不删除 `sessions` 或归档。安装版本、后台版本和 MCP 工具加载分别报告；连接与故障处理见 [MCP 工作流](mcp-workflow.md)。旧 Node 入口仅作开发兼容 oracle，不是正常安装路径。
