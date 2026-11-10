# LogicMargin for DeepSeek Harness

Connect source-backed logic diagrams, saved code diffs, and human review feedback to **DSH 0.2.2-rc.1**. This thin host plugin uses DSH's official MCP Client and filesystem skill provider. It starts or reuses LogicMargin's native Go service; users do not install Go or a second Node runtime.

The distributable is generated from the repository with `npm run package:dsh`. It includes the fixed-version native download launchers and a DSH-specific skill generated from the shared review workflow. Installing this source directory directly is not supported.

## Install a built package

For the profile you actually use:

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-logicmargin-0.9.15.tgz
```

Reload the plugin/profile, verify the `logic-margin` skill, and verify `mcp__logic_margin__start_review` and `mcp__logic_margin__wait_review`. Use the skill in the original workspace. Installation alone is not proof that tools are loaded.

The first activation downloads the matching official LogicMargin 0.9.15 release and verifies SHA-256. macOS/Linux need `curl`, `unzip`, and `shasum` or `sha256sum`; Windows uses PowerShell. Git and compilers are not required. Native availability matches the five LogicMargin targets: macOS ARM64/x64, Linux ARM64/x64, Windows x64.

The default reuses the same user's compatible local LogicMargin service. Optional plugin config fields are `home` (an absolute path) and `port` (0–65535). A separate home isolates the daemon registry; its data defaults to `<home>/sessions`, unless the host explicitly supplies `LOGIC_MARGIN_DATA_DIR`. Existing daemons retain their registered data directory. A conflicting or incompatible daemon fails explicitly; this plugin does not stop or replace it.

MCP waits have a 24-hour per-call budget, not a promise of durable or infinite execution. Cancellation and disconnection never acknowledge or archive feedback. Resume the original session using its saved submission cursor. Unloading this plugin withdraws its tools and skill while retaining the shared daemon and data.

## Updates and distribution

Update the DSH package through DSH. The webpage's one-click updater currently updates **Codex**, even if both hosts are present on the machine; it does not upgrade this DSH bundle. Preserve service home, data, port, and session IDs when updating the native service.

This package targets local execution: MCP and the source workspace must be on the same machine. No remote provider, Desktop UI, model inference, or market listing is implied by a local Host test. See the repository's DeepSeek Harness guide for tested and untested paths.

Publishing to npm, adding a GitHub topic, submitting to a community catalog, and showing up in a chosen Discover index are separate actions. No DeepSeek model-account login is required to load this plugin or connect its local MCP.

This package uses the MIT license included in `LICENSE`. Native ZIPs retain their third-party notices. The release workflow prepares the tgz, its SHA-256 file, and the five native ZIPs together; npm publication and market submissions remain separate actions.

## 中文

适配 DSH `0.2.2-rc.1`：加载后启动或复用 Go 后台，接入官方 MCP Client，并注册 `logic-margin` 技能。安装生成的 tgz 后，在实际使用的 profile 重载并核对技能与工具；不要运行 Codex 专用 `server setup`。

等待预算为单次 24 小时；取消不领取、不归档。卸载仅撤销本插件的连接和技能，不停止共享服务。更新 DSH 包使用宿主安装器，网页一键更新当前只更新 Codex。会话数据独立保存，保持原 home、端口和 session ID。
