<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="src/assets/logo.svg" width="88" height="88" alt="LogicMargin Logo" />
</p>

<h1 align="center">LogicMargin</h1>

<p align="center">
  <strong>Build with AI. Understand what it builds.</strong>
</p>

<p align="center">
  A local logic review tool: follow the flow, inspect the code, leave feedback, and verify each revision.
</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.8.5-2563eb?style=flat-square" alt="Version 0.8.5" /></a>
  <a href="#quickstart"><img src="https://img.shields.io/badge/Node.js-22.18%2B-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Requires Node.js 22.18 or later" /></a>
  <a href="docs/agent-workflow.md"><img src="https://img.shields.io/badge/review-human--in--the--loop-7c3aed?style=flat-square" alt="Human review with coding agents" /></a>
</p>

<p align="center">
  <a href="#why-logicmargin">Why LogicMargin?</a> ·
  <a href="#about">About</a> ·
  <a href="#preview">Preview</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#documentation">Documentation</a>
</p>

## Why LogicMargin?

AI is helping more people write more code, but understanding and reviewing that code has not become equally fast.

- **For developers, faster output means more code to review.** An agent can change many files and generate substantial code in one pass. Developers still need to understand call relationships, conditions, failure handling, and state changes. A line-by-line diff makes it difficult to reconstruct the full business flow and spot omissions or side effects.
- **For people without a programming background, AI makes building possible while the code can remain a black box.** Product managers, designers, and domain experts can describe a requirement and get a working feature, yet struggle to tell how it executes, what happens on failure, or whether it matches their intent. A working screen and the AI's explanation offer limited evidence of correctness.

“Can a failed operation still charge a fee?” “Could a repeated claim grant the reward twice?” “Does cancellation restore the previous state?” Answering these questions requires understanding the system's actual behavior and checking it again after a change.

## About

LogicMargin brings flowcharts, related code, and review discussions into one local interface for people and coding agents. People without a programming background can start with flows and business rules; developers can open the corresponding source and diffs. Both can review the behavior of the same implementation.

An agent reads the actual code or documents and prepares a flowchart. You annotate specific nodes, edges, or groups of objects. After you submit a round, the agent changes the implementation, updates the diagram, and replies to the original feedback. You compare the revision with the fixed baseline and decide whether the issue is resolved. Feedback, replies, and versions stay together across rounds.

Agent-prepared diagrams still need to be checked against the source. LogicMargin provides tools for reading, discussing, and verifying the work; people make the final judgment.

## Preview

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/review-dark-en.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/review-light-en.png" />
  <img src="docs/images/review-light-en.png" alt="English LogicMargin interface: baseline comparison, modified steps, and node discussion." width="1440" />
</picture>

<p align="center">
  Fixed baseline · Changes on the diagram · Node discussions<br />
  <a href="docs/images/review-light-en.png">Light theme</a> ·
  <a href="docs/images/review-dark-en.png">Dark theme</a> ·
  <a href="docs/examples/order-review.en.logic-margin.json">Download the English demo</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/code-diff-dark-en.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/code-diff-light-en.png" />
  <img src="docs/images/code-diff-light-en.png" alt="The node's Code diff tab in a widened sidebar, comparing saved baseline and revised source." width="1440" />
</picture>

<p align="center">
  Discussion, Details, and Code diff · Resizable sidebar · Side-by-side source comparison<br />
  <a href="docs/images/code-diff-light-en.png">Light code view</a> ·
  <a href="docs/images/code-diff-dark-en.png">Dark code view</a>
</p>

Captured from the 0.8.5 source build using fictional order data and sample code. The downloadable demo includes a fixed baseline and saved code snippets; it contains no real review sessions and does not demonstrate production source verification.

## Features

| Capability | What you can do |
| --- | --- |
| **Review directly on the diagram** | Comment on nodes, edges, multiple objects, a whole scenario, or the entire review, with the relevant flow in view. |
| **Read beside a node** | Switch between Discussion, Details, and Code diff in one window to inspect discussion history, rules, inputs, outputs, and source evidence. Keep it beside the node or dock it in the right sidebar. |
| **Inspect related code changes** | Use unified or side-by-side diffs of saved node source snippets, with line numbers, syntax highlighting, change navigation, and unchanged-region folding. |
| **See changes across rounds** | Compare the first review revision R1 and later rounds against the fixed original baseline B, see additions, removals, and modifications on the diagram, or inspect field changes against the previous round. Return to the original location of a removed target. |
| **Plan changes on the original system** | Annotate baseline B with redesign requirements, then review the agent's implementation in R1 alongside the original diagram and comments. |
| **Work with a coding agent** | Submit a round explicitly, let the agent wait, revise, reply, and publish a new diagram, then verify or approve the result yourself. |
| **Separate review purposes** | Associate multiple independent reviews with one agent conversation while keeping their comments, drafts, and rounds separate. |
| **Control your data** | Import and export JSON, download full backups, archive and restore reviews, or explicitly delete them. Optional automatic archival follows approval. |

Choose from three themes—paper, soft relief, and glass—with light, dark, or system appearance. The interface works on desktop and mobile. On desktop, drag either sidebar's boundary to resize it; the right sidebar can expand over the canvas for longer discussions and side-by-side code.

The interface supports **English and Simplified Chinese**. It initially follows the browser’s supported language; choose **Appearance → Interface language** to save a different preference. Flows, source code, and comments stay in their original language, and switching languages keeps your current selection and drafts.

Code diffs compare related source snippets saved in the review when their correspondence can be established. If a historical snippet is missing or the pairing is ambiguous, the interface shows the available source and an explanation. It does not infer old code from the current workspace or provide a repository-wide diff.

## Quickstart

Requires **Node.js 22.18+**; 24+ is recommended. Online Codex installation also requires Git. You do not need to clone this repository, install its npm dependencies, or build the plugin.

### Use it with an agent

Register the remote marketplace and install the prebuilt plugin:

```sh
codex plugin marketplace add SunneeYang/LogicMargin --ref main --sparse .agents/plugins --sparse plugins/logic-margin
codex plugin add logic-margin@logic-margin-local
```

Codex manages the Git checkout and checks out the plugin directories. Start a new agent session in the project you want to review:

```text
$logic-margin:logic-margin
Start a logic review for the current feature. Focus on whether failures
can still deduct a fee, and wait for my feedback.
```

The agent starts one background process for HTTP MCP, the review API, and the bundled web UI. On first use, `server setup` registers its local MCP address and long tool timeout in Codex; reconnect or reload MCP in your host and verify that its tools are available. The agent then reads the sources, prepares the diagram, and gives you a review link. Later reviews reuse the same process. Your business project does not need LogicMargin's npm dependencies.

To update, ask your agent to run:

```sh
codex plugin marketplace upgrade logic-margin-local
codex plugin add logic-margin@logic-margin-local
```

Then start a new session to load the updated skill and CLI path. Review data is stored separately from the plugin cache. This updates to the prebuilt version on `main`; it does not poll for updates during a review.

For installation without Git, download the small Node ZIP and its SHA-256 file from [GitHub Releases](https://github.com/SunneeYang/LogicMargin/releases/latest). See the [plugin guide](docs/agent-plugin.md) for ZIP installation, migration from a local marketplace, service restarts, and optional native packages. The detailed guides are currently in Chinese.

### Try it in your browser

For source development, clone the repository and run from its root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Browse the built-in examples, or choose “File → Import review” and select the [English order demo JSON](docs/examples/order-review.en.logic-margin.json) to try baseline comparison, node discussions, and code diffs. A [Chinese demo](docs/examples/order-review.logic-margin.json) is also available.

The demo is for learning the interface. A real review should be generated from actual code or documents and include source evidence.

## Review workflow

There are two starting points: **review existing changes** by preparing the original baseline B and the changed revision R1, or **plan a system redesign** by annotating B before the agent implements and publishes R1. Later rounds retain the same baseline for comparison.

| Step | Action |
| --- | --- |
| **1 · Start** | The agent prepares a diagram for one explicit review purpose, records its source snapshot, opens an independent review, and waits. |
| **2 · Annotate** | Inspect branches, select objects, and leave comments on the diagram. Move longer comments to the side panel when needed. |
| **3 · Submit** | Submit the round to freeze the current feedback into a package for the waiting agent. |
| **4 · Revise** | The agent changes the code or documents, verifies the sources again, and publishes the updated diagram and final replies together. |
| **5 · Verify** | Compare the changes, read the original feedback and replies, then confirm resolution, add feedback, or approve the round. |

**Saving a comment and submitting a round are separate actions.** Saved session comments remain available before submission; the waiting agent continues after an explicit submission. A reply does not automatically resolve an issue. The reviewer makes the final decision.

The agent reads sources, changes code, and prepares diagrams. LogicMargin displays, discusses, stores, and tracks the review. Its MCP wait tool holds the request until a submission, approval, or terminal error; ordinary comment saves and connection keep-alives require no model checks. Its server does not execute project code or shell commands, and it has no built-in language model.

## Independent reviews and cleanup

Continue the original review for changes serving the same purpose. Start a new review when the subject or purpose changes. Use MCP `context` to associate reviews with an agent conversation and `purpose` to describe what each review checks. The following compatibility CLI commands remain available for scripts; normal agent reviews use the corresponding MCP tools.

```sh
# List active and archived reviews in one context
npm run review -- list --context order-checkout --state all

# Archive by default, preserving the full diagram, comments, and history
npm run review -- cleanup <sessionId>

# Restore an archived review
npm run review -- restore <sessionId>

# Permanently delete one review; it cannot be restored from the server
npm run review -- cleanup <sessionId> --mode delete
```

“File → Review tasks” also provides creation, backup, archive, restore, and deletion actions. By default, only approved reviews can be cleaned up. See the [agent workflow](docs/agent-workflow.md#查询归档与删除) for explicit cleanup of unfinished reviews, command options, and concurrency checks.

MCP `wait_review` does not claim feedback or archive reviews. After reading feedback, the agent calls `acknowledge_review`. With `cleanup_on_approval`, it calls `cleanup_review` only after receiving final approval; new feedback prevents cleanup using an old version. Rounds, comments, and history have no fixed business count limits; individual content and single-request resource checks still apply.

<details>
<summary><strong>Where is the data stored? How do I access it from another device?</strong></summary>

- **Shared reviews:** diagrams, comments, replies, and history live on the service machine. Managed services default to `~/.logic-margin/sessions`; the development server uses `.logic-margin/sessions` in the repository. The actual directory is configurable.
- **Browser data:** unfinished drafts, pending operations, and standalone file reviews are stored in the current browser for the current origin. They do not automatically appear on other devices.
- **Private network access:** the development server listens on `0.0.0.0:5173` by default. Other LAN devices can use the machine's LAN address. With Tailscale, set the review link's public address to the service machine's Tailscale address.
- **MCP access:** the MCP endpoint accepts loopback connections only, even when the review page is shared over a private network. The MCP service and source workspace are on the same machine.
- **Current boundaries:** the review API is intended for a trusted local machine or private network and has no account or permission management yet. Source digest verification also does not replace human verification of the diagram's meaning.

</details>

## Documentation

The detailed guides below are currently in Chinese.

| Topic | Start here |
| --- | --- |
| Plugin installation, automatic startup, distribution, and platform entry points | [Agent plugin](docs/agent-plugin.md) |
| Starting, waiting, replying, publishing revisions, and cleanup | [Agent workflow](docs/agent-workflow.md) |
| Diagram JSON, stable IDs, and source digests | [Review format](plugins/logic-margin/skills/logic-margin/references/review-format.md) |
| Cross-round comparison, carried comments, and original locations | [Revision review design](docs/revision-review-design.md) |
| Synchronization, rendering, and measurement boundaries | [Performance optimization](docs/performance-optimization.md) |
| Real sources and coverage of the built-in examples | [Psycho-skill example](docs/sample-source.md) · [Spirit Sanctum](docs/spirit-sanctum-source.md) |

<details>
<summary><strong>Local development and validation</strong></summary>

```sh
npm ci
npm run dev         # Web UI and review API
npm test            # Models, client, CLI, and server tests
npm run build       # TypeScript checks and production build
npm run test:agent  # Distribution integration tests

npx playwright install chromium
npm run test:e2e    # Desktop, mobile, and system theme interaction tests
```

If Chrome is already installed, you can also run `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.

Built with React 19, TypeScript, React Flow, Vite, and a local Node.js HTTP service. The default Node distribution does not bundle a runtime. See the [plugin guide](docs/agent-plugin.md#开发与验证) for optional Bun native builds.

</details>

## Acknowledgements

Special thanks to **[Crit](https://github.com/tomasz-tomczyk/crit)** for inspiring the workflow of browser annotations, explicit submissions, and agents waiting for review. LogicMargin draws on these interaction patterns and independently implements diagram annotations, cross-round verification, and review task management around business flows and logical relationships. Primary sources and design decisions are recorded in the [Crit reference notes](docs/crit-reference.md).

Thanks to **[React Flow / xyflow](https://github.com/xyflow/xyflow)** for the diagram canvas foundation.
