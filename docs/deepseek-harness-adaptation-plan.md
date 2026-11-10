# LogicMargin → DeepSeek Harness：实现阻塞核查

日期：2026-11-09。供 `feat/deepseek-harness@8891e79` 实施；本文唯一产品仓库写入，不含提交、推送、账号登录、模型推理或发布。

`agent-tmp-run` 是开发机可选的临时文件 harness，不是公共依赖；以下命令可从仓库根目录执行。有本地 AGENTS 强制要求时仍须使用本地 harness 包裹命令。

## 结论与版本边界

**最小实现：原生 namespace 插件异步执行现有 launcher 的 `server start`，校验 JSON 中的 `mcpUrl`，先 await 官方 MCP client，再挂官方 filesystem skill provider。** 不写 MCP 桥、不写技能解析器、不调用 Codex 专用 `server setup`；携带现有 launcher/plugin.json 布局，native 版本固定 `0.9.6`。DSH 安装/更新由宿主包管理承担，技能及说明避开当前仅支持 Codex 的网页更新入口。

一手源码锁定 DeepSeek Harness **`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`**，通过该 SHA 的 GitHub archive 读取；下列 `[S*]` 链接均固定该提交。图谱不可用、coverage unknown，全部依据定向源码 read/rg；没有再调用 Context7。

**必须区分源码与发布制品：本机真实 `dsh@0.2.2-rc.1` 并不包含该 master SHA 的全部功能。** 本机包根为 `<global-node-modules>/@deepseek-ai/dsh`，启动器 `dsh` 使用 Homebrew Node 24。本次读取其 JS/types 并实跑无模型测试：

| 默认组合 | 锁定源码的 skills / mcpManager | 本机发布包 |
|---|---|---|
| web | 有 registry；manager 有 | 有 registry；manager **无** |
| desktop | 基于 Web bundle，registry 与 manager 均有 | 未运行 Desktop；不外推安装态 |
| headless | registry 有；manager 无 | registry 有；manager 无 |

源码的 Web/Desktop 将默认 host filesystem provider 禁用，改由各 agent preset 挂本地发现；registry 仍在 host 层。独立插件挂的 provider 进入 global 层，所以无需改 preset。headless 从 base 继承 registry/provider。Desktop 的 `createPluginProfile()` 使用 Web profile bundles。[S3][S7][S12]

本机 `dsh-mcp-client` 有异步 apply、长工具预算、取消与重连；却没有 master 的 `connectionStatusOf`、`probeServer` 导出及 `startupTimeoutMs`/`closeTimeoutMs` 配置。**面向当前真实安装包只使用双方共有 API**，不要把同一个版本号当作源码等价证明。此次读取的 `dsh-mcp-client/lib/index.js` SHA-256 为 `64dfc9127a47d9d453d72022b47d3b8d8a5c82cad756ac1114b09faf1a956120`。

## 1. 技能注册的完整类型与随包目录

`@deepseek-ai/dsh-skill` 的原始定义是 `Omit<SkillDefinition, 'invocation' | 'provider'> & { invocation?: SkillInvocationPolicy; provider?: string }`。展开如下；字段均 readonly：[S1]

```ts
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime'
  | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})
type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }
type SkillInvocationPolicy = { modelInvocable: boolean; userInvocable: boolean }
type SkillRegistration = {
  name: string
  description: string
  source: SkillSource
  content: string
  path?: string
  whenToUse?: string
  resourceBase?: SkillResourceBase
  metadata?: Readonly<Record<string, unknown>>
  invocation?: SkillInvocationPolicy
  provider?: string
}
```

- `source` 不是对象；`resourceBase` 也不是裸路径。`path` 是可选的绝对指令文件路径元数据，**不会让 register 自动读取或解析该文件**。`content` 是去除 frontmatter 后的 Markdown 正文。省略 invocation 表示 model/user 均允许；provider 默认 `runtime`；`register()` 返回 `() => void`，自动绑定调用插件生命周期。[S1]
- registry 只提供 `list/get`，不提供通用 `readResource`。`renderSkillContent()` 输出资源基址提示：directory 资源按其绝对 base 拼接相对路径，再用宿主已有文件工具读取；URL 按 base URL 解析。它不改变 shell cwd、不自动把路径加入沙箱许可。本次资源自检使用 Node 只读 I/O，并非模型文件工具权限验收。[S1][S2]
- Office 实现的 `resourceBase` 为 `{kind:'directory',path:directory.split(sep).join('/')}`，`locator` 是 SKILL.md 路径，provider 在 get 时重新读取并去 frontmatter；它确有私有 parser，**不需要复制这个 parser**。[S4]

**推荐挂官方 filesystem provider 的独立 bundled root：** 根指向 `skills/`，不要指向单个 `skills/logic-margin/`。它只发现根下 `<name>/SKILL.md` 或 `<name>.md`。`bundledSkillDir` 的 source=`bundled`、rank=600；`customSkillDirs` 则 source=`custom`、rank=300。bundled root 读取技能正文使用 trusted host 文件 I/O，适合随包资源。[S2]

```ts
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
await ctx.plugin(SkillFilesystem, {
  providerName: 'logic-margin-bundled', // 与默认 filesystem 区分
  includeDefaultRoots: false,
  bundledSkillDir: fileURLToPath(new URL('../plugins/logic-margin/skills/', import.meta.url)),
  watch: false, // npm 制品不可变；更新由宿主重载
})
```

URL 相对于编译后入口的位置计算，父按最终 layout 调整这一处。`includeDefaultRoots:false` 不扫描用户/项目/环境默认根；`bundledSkillDir` 显式值仍有效。官方 provider 负责 frontmatter、资源基址、注销和缓存失效，无须额外 YAML dependency。[S2]

## 2. 原生入口、MCP 顺序与生命周期

推荐接口示意；`startExistingNativeServer` 仅代表父复用现有跨平台 launcher 的执行与 JSON 校验，不是新宿主 API：

```ts
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { fileURLToPath } from 'node:url'

export const name = 'logicmargin'
export const inject = ['tools', 'skills']
export async function apply(ctx: Context): Promise<void> {
  const { mcpUrl } = await startExistingNativeServer() // launcher server start
  await ctx.plugin(McpClient, {
    serverName: 'logic_margin',
    transport: 'streamable-http',
    url: mcpUrl,
    toolCallTimeoutMs: 86_400_000,
    failOnStartupError: true,
  })
  await ctx.plugin(SkillFilesystem, {
    providerName: 'logic-margin-bundled',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../plugins/logic-margin/skills/', import.meta.url)),
    watch: false,
  })
}
```

`McpClient` 是 **namespace plugin，无 default export**；不能 default-import 或只传 `McpClient.apply`，否则丢失 inject/Config。它 inject `tools`，其异步 apply 等连接和初始工具发现；`failOnStartupError:true` 才保证初次失败会拒绝激活，而非仅日志后重试。父入口也须显式 `async function`，不要普通 function 返回 Promise——Cordis 可将有 prototype 的普通函数当 constructor。[S5][S6]

`ctx.plugin(...)` 返回可 await 的 Fiber handle，也可 `await handle.await()`；激活后可以断言 `ctx.tools.get(...)`。子插件 effect 属于父生命周期；`await handle.dispose()`/父卸载会等待清理、撤销工具、释放 namespace，并注销 skill provider。不要自行再维护一组重复 disposer。已复用的 Go daemon 是共享后台，不能因为一个 DSH 插件卸载就无条件 `server stop`。[S5][S6]

工具命名为 `mcp__logic_margin__<rawName>`，rawName 若字符非法或全名超过 64 字符，会规范化并追加 hash，不应自行拼接任意长名。本次 fixture 的短名得到 `mcp__logic_margin__ping`。调用预算 `86_400_000` 毫秒由 client 转交 SDK `callTool`，取消 signal 与 connection generation signal 合并；不会自动恢复断线前的 in-flight wait。[S13]

**manager 路径仅作为源码事实，不推荐当前依赖：**

```ts
import type {} from '@deepseek-ai/dsh-mcp-manager'
// 所属插件应 inject ['mcpManager', 'skills']。
ctx.mcpManager.register('logic_margin', {
  transport: 'streamable-http', url: mcpUrl, toolCallTimeoutMs: 86_400_000,
})
```

该 `register(name, McpServerRegistration)` 返回幂等 `() => void`，不返回 ready Promise；注册仅排队 reconcile。需要严格等待时要读 `list()` 或订阅 `watch(signal)`，直到目标 `status.state === 'connected'`，失败另行处理。manager 自己以 `ctx.plugin(McpClient, config)` 挂客户端；注册 effect 属于贡献者，卸载会等待撤销连接。不要对同一 `serverName` 同时注册 manager 和直接 client。[S8]

薄插件实际 runtime imports 的 peers 用 `@deepseek-ai/cordis:~4.1.0`、`@deepseek-ai/dsh-mcp-client:0.2.2-rc.1`、`@deepseek-ai/dsh-skill-filesystem:0.2.2-rc.1`；TS 若直接 import registry/tools 类型，也声明对应 peers。devDependencies 镜像供本地类型检查。**不要把上述官方包打进自己的 JS bundle**，以免出现第二份宿主实例。目标 `engines.dsh` 先钉 `0.2.2-rc.1`，不要先宣称宽泛兼容。[S5][S9]

上游 client 的必需 peers 为 cordis、attachment、llm、scope、subprocess、timeout、tools；mcp-resources/system-prompt/credentials 在锁定 master 为 optional peers（本机 artifact 尚无 credentials peer）。filesystem provider 的 peers 为 cordis、fs、home-paths、skill。薄插件不必重列所有传递依赖；应在真实 profile 安装后验证解析身份。[S14][S2]

## 3. 不登录、不推理的加载与验证

### 已实跑的证据

隔离 `$DSH_HOME`/`$DSH_AGENTS_HOME`、临时 HTTP fixture；Node `v24.22.2`。DSH 取本机真实已安装包，fixture 用官方 `@modelcontextprotocol/server@2.2.0`、`@modelcontextprotocol/node@2.0.0`、`zod@4.4.3`。临时下载/运行均经 `agent-tmp-run`；临时端口结束关闭。没有启动真实 LogicMargin 服务。

通过 `@deepseek-ai/dsh-app-boot.boot()` + 真 Loader builtins 挂最小 root 和测试 namespace 入口，**未挂任何 LLM provider、Agent runner 或用户 profile**。该入口按上一节顺序挂官方 client/provider；结果：

```json
{"loaderBoot":true,"skillListLoad":true,"relativeResourceRead":true,
 "mcpListCall":true,"callCancellation":true,"disposal":true,"modelsLoaded":0}
```

实际注册本仓库 `plugins/logic-margin/skills`，验证 list 有 `logic-margin`、get 正文去 frontmatter、source=`bundled`、resourceBase 为 directory，并从 base 只读 `references/mcp-workflow.md`。这里只证明已有技能可解析，**原正文仍包含 Codex setup/update 指令，父必须生成/携带 DSH 专用内容后再验收**。

MCP fixture 的 ping 调用成功；等待调用启动后 abort，Harness 返回 `isError:true`，错误含 `research cancellation`；卸载父 fiber 后 tools 与 skill 都消失。**fixture 的远端 handler signal 没观察到 abort**：此次仅证明调用方取消，不证明线上通知或 Go wait 已退出。父仍须做真实 Go 服务 >60 秒等待、取消/重启、数据保留联调。

### 父可直接使用的编程入口

官方导出的是 `Context`，不是一个名为 `CordisHost` 的类；若测试用这个名称，应 `import { Context as CordisHost } from '@deepseek-ai/cordis'`。最小 host 无须引入 agent/model：

```ts
import { Context as CordisHost } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LogicMargin from './lib/index.js'

const ctx = new CordisHost()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(SkillRegistry)
  const plugin = await ctx.plugin(LogicMargin) // 按真实 Config 传隔离 native home
  const catalog = await ctx.skills.list()
  const skill = await ctx.skills.get('logic-margin')
  const schemas = ctx.tools.schemas() // list 能力；不是 ctx.tools.list()
  const controller = new AbortController()
  const result = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('lm-test-1'),
      name: 'mcp__logic_margin__<实际工具名>', arguments: JSON.stringify({}) }],
    signal: controller.signal,
  })
  // 真等待调用：保存 pending，确认服务收到后 controller.abort()，再 await pending。
  // 校验 result.results[0].result；无 agent/log 参数就不会启动模型或写模型步骤。
  await plugin.dispose()
} finally { await ctx.fiber.dispose() }
```

进一步测 **真实 bundle patch/Loader**：创建内容为 `[]` 的临时绝对 root；使用 `boot('lm-test', root, patches, prepare)`。`prepare` 中向 `ctx.loader.builtins` 绑定上述官方 namespace/class 和实际 LogicMargin namespace，patch rows 使用 `name:'cordis:<builtin-key>'`；这就是本次实跑的加载路线。父也可 `loadOverlayPatches('lm-test', absoluteBundlePatchPath)` 读取 tgz 解包后的 `cordis.patch.yml`（会把相对入口 rebasing 为 file URL），保持所有 Config/inject 信息，再与最小核心 rows 一起交给 boot；不要挂整套默认模型配置冒充无模型测试。[S6][S10]

上游已有可直接借鉴的 fixtures：

- `packages/mcp/mcp-client/tests/http-fixture.ts`：`startHttpMcpFixture()` 返回 `{url,calls,authorization,close}`，官方 SDK、loopback、keyless ping。
- `packages/mcp/mcp-client/tests/mcp-client.e2e.ts`：真 HTTP/stdio list/call；`executeToolFixture(ctx,{callId,name,arguments,signal})` 是仓内 testkit helper，不需要真实 LLM；外部包可直接用上面的 `ctx.tools.execute`，不必增加 testkit runtime dependency。
- `apps/cli/tests/memory-mcp-configs.spec.ts`：`boot + loader.builtins` 测真实 Loader；`apps/cli/tests/fixtures/dsh-badge/snapshot.ts`：skill list/get 与 skill 工具的无模型入口。后者为了 agent 事件使用 testkit unsupported model/inbox，当前适配不需要照搬整个 agent。[S10][S11]

### tgz 隔离安装命令（本子任务未执行真实 LogicMargin tgz 安装）

早期验证曾在临时目录完成初始化与 dump（输出 12,577 字符、包含 skill row）；下面是移除开发机路径后的可移植示例，本次脱敏未重新执行安装。将归档占位路径替换为实际文件；临时目录在示例结束时清理，需要保留的报告应另存。

```sh
(
  set -eu
  LM_DEMO_TMP=$(mktemp -d)
  trap 'rm -rf "$LM_DEMO_TMP"' EXIT
  export DSH_HOME="$LM_DEMO_TMP/dsh"
  export DSH_AGENTS_HOME="$LM_DEMO_TMP/agents"
  export DSH_TELEMETRY_DISABLED=1
  mkdir -p "$LM_DEMO_TMP/work"
  cd "$LM_DEMO_TMP/work"
  dsh --profile lm-test \
    --from-default-profile headless --dump-config > "$LM_DEMO_TMP/before.yml"
  dsh plugin --profile lm-test add \
    /absolute/path/dsh-plugin-logicmargin-0.9.6.tgz --ignore-scripts \
    --store-dir "$LM_DEMO_TMP/pnpm-store"
  dsh --profile lm-test --dump-config > "$LM_DEMO_TMP/after.yml"
  # 在此运行最小 host 自检；需要保留的报告显式写到临时目录外。
)
```

`--dump-config` 走独立 compose 分支，不启动 profile；`dsh plugin` 走包管理分支，不启动模型。仅启动常规 `headless` 并传 prompt 会跑 Agent，应避免。独立 cwd 避开项目 `.env`；最小 host 完全不挂模型/账号插件，因而无需修改默认 provider、清除用户凭据或登录账户。CLI/profile/Node 依赖仍需真实安装检查，不能以 dump 代替 bundle 激活。Desktop reserved profile 必须由应用初始化，不拿真实 desktop profile 做试验。[S9][S10]

## 4. 发布与社区收录：只读复核

2026-11-09 对 `https://registry.npmjs.org/dsh-plugin-logicmargin` 的只读 GET 返回 **HTTP 404，`{"error":"Not found"}`**。当时未发现已发布包；不构成名称预留、发布权限或最终可发布保证。

官方分发路径仍是预构建 npm 包或 `pnpm pack` tgz，manifest 有 `dsh.bundle.patch`，包内确有编译入口/资源；Git 源码安装则涉及 prepare 与 pnpm build 授权，当前优先预构建制品。[S9]

本次复读社区固定快照：awesome `668c3fa6e759f413da6b90e3f3af9a3e6b0f6ee9`、market `3616c431d751aef6146c7de0c8f65b39d8ef9277`。公开投稿待办，不代投：[C1][C2]

- npm 制品真实安装/验证后，分别申请 npm 发布及社区 PR 授权；发布包准确写 repository、license、engines/peers、展示 metadata，不标 private。
- 仓库加 `dsh-plugin` topic；awesome 添加单个 `data/plugins/<owner>__<repo>.yml`，包含准确 URL/name/category/英文说明，可带中文。monorepo 子包按其子目录格式提交；不手改生成 README。要求真实可用代码、`dsh.bundle`、仓库满一天等。
- `dsh-market/dsh-market` 是市场应用，目录条目投 awesome；该市场优先 repo-verified npm，其后可用 GitHub Release 预构建 tgz。npm mapping 核对包的 repository 回指同一仓库；不要给 YAML 擅加 npm 字段。[C3]
- 无 npm 时可按社区规则提供 GitHub Release HTTPS `.tgz` 的 `tarball`；latest 下载文件名需固定，或显式钉 release tag。
- Discover index 源 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 属社区目录；索引条目/合并、网站可见、指定 DSH Discover 可安装应分别留证。不是 DeepSeek 官方认证；本次没投递、发布或测可见性。

## 来源

[S1]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill/src/index.ts
[S2]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/src/index.ts
[S3]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/web-app/cordis.patch.yml
[S4]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-office/src/index.ts
[S5]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/src/index.ts
[S6]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/registry.ts
[S7]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/tests/profile-mcp.spec.ts
[S8]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-manager/src/index.ts
[S9]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md
[S10]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/index.ts
[S11]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/test-support/tool-testkit/src/index.ts
[S12]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/src/project-manager.ts
[S13]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/src/tools.ts
[S14]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/package.json
[C1]: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/668c3fa6e759f413da6b90e3f3af9a3e6b0f6ee9/contributing.md
[C2]: https://github.com/dsh-market/dsh-market/blob/3616c431d751aef6146c7de0c8f65b39d8ef9277/README.md
[C3]: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/668c3fa6e759f413da6b90e3f3af9a3e6b0f6ee9/scripts/probe-npm.mjs
