# 插件安装与更新

适用于具备本地命令执行能力的 Codex。插件运行 Go 原生程序，用户无需安装 Node.js、Go、Bun 或 npm。Git marketplace 需要 Git，首次启动需要联网；macOS/Linux 自动 MCP 入口使用 `sh`，下载还需要 `curl`、`unzip` 与 `shasum` 或 `sha256sum`。Windows 自动注册使用平台 ZIP，PowerShell 启动器用于 CLI。用户已要求更新时直接执行。其他 Agent 可使用平台 ZIP 内的 CLI 或受支持的 HTTP MCP 客户端，ZIP 本身不会把 MCP 注册到其他宿主。

## 首次安装或从本地目录迁移

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin --json
codex plugin add logic-margin@logic-margin-local --json
```

同名来源或 Git ref 不同时，Codex 可能拒绝直接添加。先记录并备份旧 marketplace 根目录，再用 `codex plugin marketplace remove logic-margin-local --json` 移除该来源注册，然后添加目标来源；原插件缓存保留，但新来源注册前不会出现在插件清单中。添加失败时从目录备份重新注册。不要删除评审数据或直接改写插件缓存。此路径包含 `scripts/logic-margin.sh` / `scripts/logic-margin.ps1`，按插件固定版本从官方 GitHub Release 下载本平台 ZIP 并校验 SHA-256，再运行原生程序；不在用户机器编译，不追随浮动 latest。

无需 Git 时，从 [GitHub Releases](https://github.com/SunneeYang/LogicMargin/releases) 选择所需版本的 `logic-margin-agent-VERSION-TARGET.zip` 和 `.zip.sha256`。随包 MCP 注册从 0.9.19 开始；该版本尚未公开发布时使用对应源码生成的本地 ZIP，旧发行附件不包含本次能力。将 `VERSION` 换成实际版本号。TARGET 为 `darwin-arm64`（macOS Apple Silicon）、`darwin-x64`（macOS Intel）、`linux-arm64`、`linux-x64` 或 `win32-x64`（Windows x64）。校验 SHA-256 后解压到持久位置，以 ZIP 顶层目录执行 `codex plugin marketplace add /absolute/path/to/logic-margin-agent-VERSION-TARGET`，再添加插件。ZIP 内直接使用 `scripts/logic-margin` / `scripts/logic-margin.exe`；PowerShell 用 `& $LM_CLI` 调用实际入口。

## 检查与更新

0.9.6 网页“设置 → 版本与更新”显示当前运行服务版本并手动检查官方新版。已有支持该功能的服务可在本机回环地址点击“一键更新本机插件与服务”；后台固定所选发行 tag、校验平台包、备份原数据、更新已有 Codex 安装并重启核实。兼容清单 `.codex-plugin/plugin.json` 引用根 `mcp.json` 随包注册 stdio MCP，保留 24 小时工具等待；更新后由宿主从新插件根目录解析相对入口，更新器不再创建或迁移全局命令路径。已有 stdio 进程仍需宿主重载，后台重启不会替原会话完成重连。远程页面只能检查，不能安装。更新完成后核对实际插件与服务版本及 MCP 调用。旧版没有此入口时使用下方 CLI 步骤。

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
4. 用新版入口 `server start` 启动并检查 `server status`，沿用原数据与监听。旧版全局 `mcp_servers.logic_margin` 按 [连接与迁移参考](mcp-workflow.md#codex-随包注册与有界恢复) 备份、确认归属后仅移除或禁用该入口，沿用原工具策略；无需注册新的全局绝对路径。
5. 在原宿主重载插件和 MCP，从新安装的插件根目录解析随包相对入口。实际调用只读工具，并用 `get_review` 核对原 session ID、目的、轮次与尚未处理的反馈，再继续正常评审。更新不代表评审通过。

插件缓存独立于会话数据，升级不删除 `sessions` 或归档。安装版本、后台版本和 MCP 工具加载分别报告；连接与故障处理见 [MCP 工作流](mcp-workflow.md)。旧 Node 入口仅作开发兼容 oracle，不是正常安装路径。
