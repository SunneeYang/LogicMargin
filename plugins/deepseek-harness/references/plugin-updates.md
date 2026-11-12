# DeepSeek Harness 安装与更新

当前兼容基线为 DSH `0.2.2-rc.1`，公开 npm 包为 `dsh-plugin-logicmargin`。确认所选版本兼容后，首次安装到实际使用的 profile：

```sh
dsh plugin --profile YOUR_PROFILE add dsh-plugin-logicmargin@0.9.18 --save-exact --registry=https://registry.npmjs.org
```

将 `YOUR_PROFILE` 换成实际名称。`--save-exact` 保持固定版本。DSH 需要其支持的 Node.js 和 PATH 中的 pnpm；安装公开包无需 npm 发布账号。也可从对应 GitHub Release 下载 tgz 和 `.sha256`，核验后用 `dsh plugin --profile YOUR_PROFILE add /absolute/path/dsh-plugin-logicmargin-0.9.18.tgz` 安装。

不要把 Codex 插件缓存、marketplace 或 `server setup` 当作 DSH 的安装入口。

更新前按 `server status` 确认实际原生服务版本、实例与数据目录。保存服务数据备份；保留原 home、端口与 session ID。完成检查与备份后，在同一 profile 再执行上方 npm `add` 命令，把版本换成准备采用的已发布兼容版本；同一命令也可将原 tgz 安装切换到 npm 来源。

宿主替换本包并重载后，按新入口核对后台与 MCP 工具是否已实际切换，并实际调用只读 `mcp__logic_margin__list_reviews`。版本不兼容时按用户授权进行身份确认的停服和重启，保留其他宿主正在使用的共享服务。

当前网页一键更新只处理 Codex 插件，不能用来更新 DSH 包。即使本机同时装有 Codex，DSH 的包版本仍需由 DSH 自己的安装器更新。安装、后台版本、技能发现、MCP 可调用是分别验收的结果。更新不代表评审通过，也不删除会话、B/R 快照、批注或归档。

npm 分发已提供安装入口；社区目录收录、Discover 索引和 DeepSeek 模型账号登录仍是独立事项。核对指定索引和实际安装结果后，才可报告该 Discover 来源可用；不能用 npm 已发布代替市场可发现性验收。
