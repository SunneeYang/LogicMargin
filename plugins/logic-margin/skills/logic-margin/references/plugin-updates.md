# 插件安装与更新

适用于具备本地命令执行能力的 Codex，要求 Node.js 22.18+ 和 Git。用户已要求更新时直接执行，不必再次确认。其他 Agent 可从 [GitHub Releases](https://github.com/SunneeYang/LogicMargin/releases/latest) 下载 Node ZIP，以包内 CLI 或受支持的 HTTP MCP 客户端工作；ZIP 本身不会把 MCP 注册到其他宿主。

## 首次安装或从本地目录迁移

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin --json
codex plugin add logic-margin@logic-margin-local --json
```

同名本地 marketplace 会切换到远程 Git 来源，原源码或解压目录保留。这个路径使用已构建文件，无需 npm install 或构建。

## 检查与更新

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

Codex 会移除旧版本缓存。通过原宿主重新加载技能并定位新版 CLI，不再沿用当前会话记住的旧 `LM_CLI` 路径。宿主要求重新打开会话时，说明这一加载要求；文件下载完成不代表正在运行的等待调用或后台已重启。

评审数据保存在服务数据目录，默认 `~/.logic-margin/sessions`，独立于插件缓存；沿用现有 `LOGIC_MARGIN_HOME` / `LOGIC_MARGIN_DATA_DIR`。新版 CLI 报告服务版本不匹配时，核对 `server status`，用新版 CLI 的 `server stop` 关闭经身份核验的旧实例，再 `server start`；保留原端口、数据和 session ID。核对目的与轮次，更新插件不代表评审通过。

首次连接 MCP 或需要修复注册时，用新版 CLI 的 `server setup`。它通过短暂的 Codex 配置进程，仅写入当前 Codex home 的 `logic_margin` 地址与长工具超时，不新增常驻 stdio 服务。随后按 `reloadRequired` 在原宿主重载或重连 MCP，核实工具实际可用；正常评审再回到技能主流程。安装版本、后台版本和 MCP 工具加载分别报告，连接与故障处理见 [MCP 工作流](mcp-workflow.md)。
