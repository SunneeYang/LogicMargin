# 网页检查与本机更新 / Web release checks and local updates

网页“设置 → 版本与更新”内的 LogicMargin 版本由运行中 Go 服务的 `Options.Version` 返回，不取前端包版本。点击“检查新版”只读取官方 [SunneeYang/LogicMargin Releases](https://github.com/SunneeYang/LogicMargin/releases)，不停止服务；只接受稳定的 `vX.Y.Z`，跳过预发布与草稿。网络、版本或平台错误明确返回，不自动执行其他下载地址。旧 Node 开发后端没有此安装端点。

The settings panel shows the version of the running Go backend under “Version and updates”, independent of the loaded frontend bundle. “Check for updates” reads the official GitHub release only. Checking is manual, read-only, and shared across hosts; installation is currently supported only for an existing enabled Codex `logic-margin@logic-margin-local` installation.

## 一键操作与信任边界

在服务本机以 `http://127.0.0.1:PORT`、`http://localhost:PORT` 或 IPv6 回环地址打开原评审链接，检查新版后点击“一键更新本机插件与服务”。远程局域网/Tailscale 页面可以检查发行版本，但不能安装；请在服务机器打开同一端口与 session 链接的回环地址。反向代理也不能用转发头取得安装权限。

安装与取消要求真实回环 peer、回环 Host、相同 HTTP Origin 和独立 CSRF token。token 只交给可信本机页面，不复用或暴露 daemon 的 shutdown token。不接受客户端 URL、命令、安装路径、home 或 dataDir。`GET /api/runtime` 返回真实版本和本机能力，`GET /api/releases/latest` 检查新版；本机的 `GET /api/update/status` 和带 CSRF 的 `POST /api/update/start`、`POST /api/update/cancel` 承载状态与受控操作。start 请求只含 `{ "version": "X.Y.Z" }`。

Installation and cancellation require a real loopback peer and Host, matching HTTP Origin, and a separate CSRF token. Forwarded requests are rejected. Remote review access never grants installation execution. The only source is the official repository; the requested stable version is pinned, and the platform ZIP must match its exact named SHA-256 file before any downloaded executable runs.

## 后台步骤与连续性

1. 将当前原生程序复制到真实 daemon home 的 `updates/<job-id>/`，从这里启动独立 worker。它继承当前 Codex home，工作目录独立于旧插件缓存；Codex 删除旧 `installedPath` 不会删除 worker、下载、备份或恢复入口。
2. 核对已有 Codex 插件，验证固定版本官方 Release，下载当前平台 ZIP 与 SHA-256，检查解压路径和程序 `--version`。支持现有五个发行目标；未支持平台返回 error，不换包、不编译。
3. 停服前按真实路径检查数据、更新目录与 Codex 插件/临时目录；符号链接别名造成重叠，或数据/恢复入口位于可能被清理的插件源内时拒绝。随后持有 daemon `start.lock`，核对正在运行实例的登记身份，再停止并确认退出。持有原 dataDir 的 `.service-lock`，完整备份实际数据目录，随后才更改插件。会话、B/R、评论、归档与 session ID 不迁移、不清理；dataDir 内含符号链接时拒绝备份。
4. 先读取并验证当前 marketplace 根目录，将目录快照保存到本次任务的 `marketplace-backup/`。Codex 将不同 Git ref 视为不同来源，因此更换 ref 前先移除旧来源注册，再执行固定官方 ref 的注册、refresh 和实际安装：

   ```sh
   codex plugin marketplace remove logic-margin-local --json
   codex plugin marketplace add SunneeYang/LogicMargin --ref vX.Y.Z --sparse .agents/plugins --sparse plugins/logic-margin --json
   codex plugin marketplace upgrade logic-margin-local --json
   codex plugin add logic-margin@logic-margin-local --json
   ```

   移除和注册结果必须对应 `logic-margin-local`。移除后插件缓存保留，但暂时不在清单中；注册失败或移除已生效后收到取消时，用独立有界恢复过程从旧目录快照重新注册，再恢复旧服务。备份来源包含本次备份目标时拒绝，避免递归复制。恢复目录快照会将该 marketplace 暂时注册为本地来源，下次成功更新再切到官方固定 tag；不会覆盖其他 marketplace。refresh 的 `errors` 必须为空；插件安装返回的 `version`、`installedPath` 与磁盘 `plugin.json` 都须核实。命令零退出码不等于成功。原本的本地 ZIP marketplace 会切换到该官方固定 Git tag，后续网页更新会再次明确固定所选版本。
5. 用已校验、位于持久更新目录内的新原生程序启动服务。复用实际 home、dataDir、Host 与端口；通过真实 readiness 和 HTTP health 核实新 PID、实例身份及版本。只在验证完成后记录 completed；前端还比较重连后台的真实版本。

The worker survives deletion of the old Codex plugin cache. The daemon startup lock spans stop, backup, plugin operations, and restart; the data writer lock protects backup and restoration. Download failures keep the old service running. Failures after stopping restart the copied old executable. If a failed new service wrote data, its files are retained under `failed-data/` and the complete backup is restored before the old service starts. A surviving writer blocks recovery instead of allowing a second writer.

## 状态、取消与故障恢复

网页显示下载、校验、停服、备份、插件操作、重启与核实状态。旧服务停止后网页会暂时断线，显示正在重连和“结果尚未确认”，恢复后读取持久状态与真实版本；安装期间状态文件仍由独立 worker 更新。不要把 HTTP 中断或命令退出当作更新成功。取消是合作式操作，若已停旧服务，worker 会先尝试恢复；没有运行中的 HTTP 服务时取消按钮不可用。

完成后 MCP 连接可能需要宿主重连/重载。监听地址没有变，因此更新流程不改 Codex MCP 配置；在原宿主核实工具已重新连接，然后按原 session ID 继续评审。更新不代表评审通过。

每次任务的状态在实际 home 的 `updates/status.json`，日志在 `updates/<job-id>/worker.log`，备份在 `updates/<job-id>/backup/`，旧程序与新程序都保留在该任务目录。不要读取或粘贴 `daemon.json` 中的关闭令牌。错误中的 `old_service_restored` 表示旧服务已通过启动健康检查；`rollback_blocked`、`restore_failed`、`codex_marketplace_restore_failed`、`rollback_failed` 或 `update_worker_interrupted` 需要本机诊断。插件可能已更新但服务恢复到旧版本，网页会分别显示失败与当前真实服务版本，不能据安装成功继续声称整体更新成功。

硬断电、worker 被强杀或磁盘故障不能保证自动恢复。先用保留的原生程序执行 `server status`，核对实例与进程；确认没有其他 writer 后使用持久目录中的旧入口 `server start --host ORIGINAL_HOST --port ORIGINAL_PORT` 恢复。应保留原 `LOGIC_MARGIN_HOME`；自定义数据目录使用 `LOGIC_MARGIN_DATA_DIR` 环境变量，`server start` 不支持 `--data-dir`。不要按端口强杀、删除锁或清空会话绕过保护；存在备份恢复错误时先检查备份和 `failed-data`，不要直接覆盖原数据。备份与旧程序不会自动清理。

MCP may require reconnection after success. A canceled or failed job is not a completed update. Power loss, forced worker termination, disk failures, or an incompatible Codex CLI can require manual recovery using the preserved executable and backup. Other hosts have release checks only; their installation adapters have not been implemented.

## 验证与演示

开发验证使用临时 home、自定义 dataDir、假官方发行传输与假 Codex 子进程，覆盖稳定版/平台/恶意 ZIP/校验和、分别 refresh/install、旧缓存被删除、取消、重启失败恢复、端口和全部示例数据保留。生产没有可配置的假源或任意命令后门。运行测试：

```sh
/Users/hcm-b0677/.codex/bin/agent-tmp-run env GOWORK=off go test ./internal/update ./internal/service ./internal/daemon ./internal/mcpconfig -count=1
```

`tests/update-settings.spec.ts` 的浏览器路由模拟验证双语页面、只手动检查、受控请求、重启后的真实版本、远程禁用和错误重试；它不更新真实 Codex。正式发行前仍须在目标 OS 的隔离 Codex home 做原生安装演练，且该演练须另行授权。交叉构建不等于 Windows/Linux 原生安装已验收。

Codex 命令与 JSON 契约核对自 [官方 Developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)：marketplace refresh 与 plugin add 是不同步骤。宿主 CLI 不支持或返回无法核实的结果时保持 error，不回退成教程冒充完成。

版本检查优先使用官方 GitHub Release API；匿名 API 被限流（403／429）时，改读同仓库官方最新发行页的 JSON，并核对最终 tag 地址、稳定版本及指定更新版本。不会使用第三方镜像或用户凭据；网站格式变化或仍无法访问时停止检查并显示可重试的错误。
