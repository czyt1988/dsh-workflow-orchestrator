<p align="center">
  <img src="icon.svg" width="72" height="72" alt="dsh-workflow-orchestrator 图标" />
</p>

<h1 align="center">dsh-workflow-orchestrator</h1>

<p align="center">
  <strong>把多个 DSH 任务会话编排成可执行的工作流</strong><br />
  DeepSeek Harness 可视化工作流编排插件 · 拖拽画布 · 并行网关 · 真实任务会话 · 运行日志
</p>

<p align="center">
  <a href="https://github.com/czyt1988/dsh-workflow-orchestrator/actions/workflows/ci.yml"><img src="https://github.com/czyt1988/dsh-workflow-orchestrator/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >= 20" /></a>
  <a href="docs/user/getting-started.md"><img src="https://img.shields.io/badge/DSH-%E6%8F%92%E4%BB%B6-4c8bf5" alt="DSH 插件" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
</p>

> **一句话**：在 DeepSeek Harness（DSH）左侧栏新增一级页面「工作流编排」——在画布上拖入任务节点、连线、点「执行」，每个任务节点都会在指定工作区里**新建一个真实的 DSH 任务会话**，串行、并行与汇合都由连线决定，执行过程实时写进底部消息窗口。

---

## 目录

- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [架构](#架构)
- [安装](#安装)
- [快速开始](#快速开始)
- [执行语义](#执行语义)
- [文档导航](#文档导航)
- [目录结构](#目录结构)
- [本地开发与测试](#本地开发与测试)
- [已知限制](#已知限制)
- [Roadmap](#roadmap)
- [参与贡献](#参与贡献)
- [License](#license)
- [English overview](#english-overview)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 🧩 可视化画布 | 左侧节点面板拖拽（或单击）添加节点，拖动节点、拖动圆点连线，`Delete` 删除选中节点或连线 |
| 🤖 真实任务会话 | 每个任务节点在启动时通过 `sessionController.create` 创建**真实 DSH 任务会话**，出现在对应工作区的任务列表里，可一键跳转 |
| 🔀 四类拓扑 | 不连线 = 同时启动；`A → B` = 串行；`A、B → 并行网关 → C` = 等所有分支完成后汇合；`A → 判断/终止节点` = 评估后提前结束 |
| 🛑 提前终止 | 判断节点用真实会话评估上游输出，判定「继续 / 终止」；终止节点到达即结束。后续节点不再执行，未启动节点标记「已跳过」，运行记录保留提前终止信息 |
| 🎛️ 完整属性面板 | 提示词、上游上下文（完整输出 / 摘要 / 不传）、工作区、Agent 模式、权限预设、模型，全部来自宿主实时目录 |
| 🎨 跨工作区配色 | 任务节点卡片显示所属工作区；同一工作流跨多个工作区时显示提示条，不同工作区的卡片用不同浅色背景区分，颜色可在属性区逐个调整，卡片边框仍只表示运行状态 |
| ▶️ 从任意节点开始执行 | 选中任务节点点属性区顶部的「从此节点开始执行」，只运行该节点及其下游，前置与无关节点标记为「未执行」且不创建任务会话 |
| 💾 自动保存与持久化 | 画布改动自动保存到 `$DSH_HOME/workflow-orchestrator/workflows.json`，刷新、重启后仍在；最近 20 次运行记录一并保留 |
| 📜 运行日志 | 底部消息窗口按节点输出 INFO / WARN / ERROR，包含会话 ID、耗时与失败原因 |
| ⏹️ 两种终止方式 | 「仅停止工作流」让运行中的任务跑完；「停止并终止任务」同时取消正在运行的任务会话 |
| 🧪 可测试 | 引擎/存储/路由有 `node:test` 单元测试；另有隔离 `DSH_HOME` + Playwright 的全链路 E2E |

## 界面预览

![工作流编排界面总览：左侧节点面板、中间画布、底部消息窗口、右侧属性区](docs/assets/images/panel-overview.png)

*图 1：一级页面「工作流编排」的三栏布局——左侧节点面板、中间画布、底部消息窗口、右侧属性区，顶部是工作流管理与执行工具栏。*

![选中任务节点后的属性面板：提示词、上游上下文、工作区、模式、权限、模型](docs/assets/images/inspector.png)

*图 2：选中节点后在右侧编辑属性。提示词输入框内 `Enter` 只换行，不会触发执行；所有改动自动保存。*

![并行网关工作流执行完成：A、B 汇合到并行网关后触发 C](docs/assets/images/gateway-run.png)

*图 3：`A、B → 并行网关 → C` 执行完成。网关在两条分支都完成后汇合，随后启动 C，每个节点都关联了真实的任务会话。*

更多界面截图见[用户文档](docs/user/README.md)与[界面导览](docs/user/interface.md)。

## 架构

```mermaid
flowchart LR
  subgraph Browser["浏览器半区 · lib/client.js"]
    Panel["工作流编排页面<br/>画布 / 属性区 / 消息窗口"]
  end

  subgraph Host["宿主半区 · lib/index.js（Cordis 插件）"]
    Routes["JSON 路由<br/>/workflow-orchestrator/api/*"]
    Engine["执行引擎<br/>WorkflowEngine"]
    Store["持久化<br/>WorkflowStore"]
    Catalogs["选项目录<br/>CatalogService"]
  end

  subgraph DSH["DSH 宿主服务"]
    WebServer["webServer / connection"]
    WorkspaceSvc["workspaceRegistry / agentPresets / permissionPresets"]
    Sessions["sessions / agents"]
    SessionController["sessionController"]
  end

  Panel -- "fetch 轮询 / 提交" --> Routes
  Routes --> Store
  Routes --> Engine
  Routes --> Catalogs
  Store --> Data[("workflows.json<br/>$DSH_HOME/workflow-orchestrator")]
  Catalogs --> WorkspaceSvc
  Catalogs --> SessionController
  Engine --> SessionController
  Engine --> Sessions
  Routes -. "挂载" .-> WebServer
```

插件刻意分成两个半区、**运行时零第三方依赖**：

- **宿主半区**（`lib/index.js` + `lib/host/*`）是一个普通 Cordis 插件，通过 `inject` 使用 `webServer`、`connection`、`sessions`、`agents`、`sessionController` 等服务，挂载 `/workflow-orchestrator` 下的 JSON API，并通过 `sessionController` 创建与驱动真实任务会话。
- **浏览器半区**（`lib/client.js`）通过 DSH 的 `window.__ModuleLoader__` 加载，`react` 复用壳层自带副本，注册一级页面与左侧栏入口。
- 选项目录（工作区/模式/权限/模型）不硬编码，每次从正在运行的宿主读取并缓存 60 秒。

实现细节见[开发文档 · 架构](docs/dev/architecture.md)与[执行引擎](docs/dev/execution-engine.md)。

## 安装

**前置条件**：已安装 DeepSeek Harness 桌面端（Node.js ≥ 20 仅用于本地开发）。

### 方式一：插件管理器安装（推荐）

1. 打开 DSH 的 **设置 → 插件**（或左侧「插件」页）。
2. 点击 **添加插件**，选择本地目录（本仓库根目录）。
3. 插件会以 `link:` 方式写入当前 profile 并自动启用。
4. 刷新页面，左侧栏出现 **「工作流编排」** 一级入口。

### 方式二：手动挂载

1. 把本仓库链接进 profile 的 `node_modules`（以 Windows 默认 profile `desktop` 为例）：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workflow-orchestrator" `
     -Target "D:\path\to\dsh-workflow-orchestrator"
   ```

2. 在 profile 的 `package.json` 中，把包名追加到 `dsh.profile.bundles`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-workflow-orchestrator"
         ]
       }
     }
   }
   ```

3. 刷新页面；若 profile 未开启 HMR，重启 DSH 后生效。

### 验证安装

- 左侧栏出现「工作流编排」，页面能加载出三栏布局即成功。
- 宿主半区激活标记：`$DSH_HOME/workflow-orchestrator/host-loaded.json` 中会写入 `loadedAt`。
- 详细步骤与排障见[快速开始](docs/user/getting-started.md)与 [FAQ](docs/user/data-and-faq.md)。

## 快速开始

1. **打开页面**：左侧栏点击 **工作流编排**。
2. **建节点**：把 **任务节点** 拖到画布（或单击节点卡添加）。
3. **写提示词**：选中节点，在右侧填写提示词，并按需选择工作区、模式、权限、模型。`Enter` 只换行。
4. **连线条**：从节点右侧圆点拖到另一个节点左侧圆点。
   - 不连线 → 同时启动
   - `A → B` → A 完成后启动 B
   - `A、B → 并行网关 → C` → A、B 都完成后启动 C
   - `A → 判断节点 → B` → 判断节点评估 A 的输出，判定终止则整次工作流提前结束；`A → 终止节点` 到达即结束
5. **执行**：点击顶部 **执行**（全量执行），底部消息窗口实时输出每个节点的启动、会话 ID、完成与错误。只想跑后半段时，选中某个任务节点，点属性区顶部的 **从此节点开始执行**，前置与无关节点会标记为「未执行」。
6. **查看会话**：节点属性区的「打开任务会话」可跳到工作区里真实创建的任务会话。

## 执行语义

```mermaid
flowchart LR
  subgraph Parallel["并行：不连线"]
    P1["任务 A"] ~~~ P2["任务 B"]
  end

  subgraph Chain["串行：A → B"]
    C1["任务 A"] --> C2["任务 B"]
  end

  subgraph Join["汇合：A、B → 并行网关 → C"]
    J1["任务 A"] --> G["并行网关"]
    J2["任务 B"] --> G
    G --> J3["任务 C"]
  end
```

| 规则 | 行为 |
| --- | --- |
| 工作流必须是 DAG | 存在环路时拒绝执行并给出提示 |
| 节点启动条件 | 所有直接前序节点都 `completed` 才启动；无前序节点视为可立即启动 |
| 并行网关 | 不创建任务会话，只做汇合与扇出；必须至少一条输入、一条输出连线 |
| 前序失败/取消/跳过 | 下游节点标记 `skipped`，只沿失败分支级联，不相关分支继续跑完 |
| 任务节点完成判定 | 最后一个回合以 `completed` 结束且会话静默（Agent 空闲、没有仍可汇合的后台子代理）；模型报错、被取消、上下文耗尽等记为 `failed` |
| 从节点开始执行 | 只执行该节点及其通过有向边可达的下游；其余节点记为 `not-run`（未执行），不创建任务会话，也不计入失败 |
| 判断节点 | 创建真实会话评估上游输出；判定 `STOP` 时整次运行提前结束。判定文本对下游透明，无效判定按 `continue` 降级 |
| 终止节点 | 不创建会话；到达即提前结束整次运行。可配置终止原因与在途任务策略 |
| 提前终止 | 未启动节点 `skipped`（「工作流已提前终止」），不计入失败；在途任务默认跑完或按配置取消；终止前已有失败则整体仍 `failed` |
| 跨工作区 | 每个任务节点的有效工作区独立解析（节点指定 → 工作流默认 → 宿主默认）；跨工作区只影响卡片配色与提示，不改变调度 |
| 运行状态 | 任一任务失败 → 整体 `failed`；收到手动终止 → 整体 `cancelled`；提前终止 → 终止前有失败则 `failed`，否则 `completed`；否则 `completed` |
| 并发与超时 | 同时最多 8 个任务执行；单任务默认 6 小时超时（超时后请求取消会话） |
| 上游上下文 | 默认把上游任务的最终回复附在提示词后；可改为只带会话摘要或完全不传 |

节点与运行的状态机、失败级联细节见[用户文档 · 执行与监控](docs/user/running-and-monitoring.md)、[终止与错误](docs/user/stopping-and-errors.md)和[开发文档 · 执行引擎](docs/dev/execution-engine.md)。

## 文档导航

文档分为**应用文档**（面向使用者）与**开发文档**（面向贡献者），入口见 [docs/README.md](docs/README.md)。

### 应用文档

| 文档 | 内容 |
| --- | --- |
| [快速开始](docs/user/getting-started.md) | 安装、打开入口、创建并运行第一个工作流 |
| [界面导览](docs/user/interface.md) | 工具栏、节点面板、画布、消息窗口、属性区的每一块 |
| [搭建工作流](docs/user/building-workflows.md) | 节点类型、连线规则、属性字段、校验限制 |
| [执行与监控](docs/user/running-and-monitoring.md) | 四类拓扑、判断/终止节点的提前结束、状态与日志、并发与超时、真实任务会话 |
| [终止与错误处理](docs/user/stopping-and-errors.md) | 两种终止方式、失败/跳过/取消的级联与排查 |
| [数据与 FAQ](docs/user/data-and-faq.md) | 数据文件、容量上限、备份迁移、常见问题与已知限制 |

### 开发文档

| 文档 | 内容 |
| --- | --- |
| [架构](docs/dev/architecture.md) | 两半区结构、Cordis 服务、请求与加载链路 |
| [执行引擎](docs/dev/execution-engine.md) | DAG 调度算法、网关汇合、停止模式、会话驱动 |
| [数据模型](docs/dev/data-model.md) | `workflows.json` 结构、清洗规则、原子写与容量上限 |
| [HTTP API](docs/dev/http-api.md) | 全部 JSON 路由、请求/响应、错误码与准入栅栏 |
| [开发指南](docs/dev/development.md) | 环境、目录、命令、本地联调、编码与提交约定 |
| [测试](docs/dev/testing.md) | 单元测试、E2E 全链路、证据采集与 CI 边界 |
| [打包与发布](docs/dev/packaging-and-release.md) | 插件清单、安装方式、版本与 GitHub 发布流程 |

## 目录结构

```text
dsh-workflow-orchestrator/
├── .github/                  # CI、Dependabot、Issue/PR 模板
├── docs/
│   ├── README.md             # 文档总索引
│   ├── user/                 # 应用文档（面向使用者）
│   ├── dev/                  # 开发文档（面向贡献者）
│   └── assets/images/        # 文档界面截图
├── lib/
│   ├── index.js              # 宿主半区入口（Cordis 插件）
│   ├── client.js             # 浏览器半区入口（ModuleLoader 模块）
│   └── host/                 # 存储、执行引擎、路由、选项目录
├── locale/                   # 插件管理器/设置页的中英文标题与描述
├── test/                     # node:test 单元测试
├── tools/                    # 全链路 E2E 脚本、包结构自检
├── AGENTS.md                 # AI 编码代理的项目指引
├── CHANGELOG.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── LICENSE                   # MIT
├── README.md
├── cordis.patch.yml          # bundle patch：向 profile 插入 loader 行
├── icon.svg                  # 插件图标
└── package.json              # DSH 清单 + npm 元数据
```

> `.e2e/`（E2E 产物）、`internal/`（本地排障材料）、`.probe/` 等目录已被 `.gitignore` 忽略，不属于仓库内容。

## 本地开发与测试

```powershell
# 单元测试（不需要启动 DSH，零依赖）
npm test

# 包结构与文档自检（CI 同款）
npm run check

# 全链路 E2E（需要 DSH 桌面端 + Playwright + 模型凭据）
npm run test:e2e
```

E2E 会在隔离的 `DSH_HOME` 中启动 `dsh --profile web`，用 Playwright 驱动真实浏览器并调用真实模型，证据（截图/JSON/日志）输出到 `.e2e/`，报告为 `.e2e/e2e-report.md`。它耗时且依赖本机环境，因此**不进入 CI**。

## 已知限制

- 并行网关只有汇合与扇出；判断节点只能「继续 / 全局终止」，不能按判定结果走不同分支（没有排他网关、条件分支）。
- 判断节点依赖模型按契约输出 `WOF_DECISION: CONTINUE|STOP`；无法识别时按配置降级（默认继续），不会静默丢节点。
- 每个任务节点与判断节点**只执行一次**：不支持循环、重试、定时触发。
- 「从此节点开始执行」只缩小本次运行范围，不做断点续跑：未执行的节点不会自动补跑，下一次「执行」仍会全量执行。
- 工作流运行期间可以继续编辑画布，但本次运行使用**启动时的快照**。
- 提示词为空的任务节点与判断节点不允许执行（「从此节点开始执行」只校验本次执行范围内的节点，范围外的空提示词不阻塞）。
- 并行网关必须至少一条输入与一条输出连线；判断节点必须至少一条输入且上游有任务，终止节点必须至少一条输入且不能有输出连线。
- 会话标题由 DSH 根据提示词自动生成，插件不会重命名任务。
- 已在 DSH 桌面端的 `desktop` / `web` profile 上验证；未声明对 DSH 版本的 peer 依赖，升级 DSH 后请重跑 E2E。

## Roadmap

以下方向欢迎通过 [Issue](https://github.com/czyt1988/dsh-workflow-orchestrator/issues) 讨论或认领（**计划中，不代表承诺**）：

- 条件分支 / 排他网关：让判断结果路由到不同分支，而不是只能全局继续或终止。
- 节点级重试、循环与定时触发。
- 运行历史面板（按时间回看与对比多次运行）。
- 工作流导出 / 导入（JSON 文件），便于团队共享模板。
- 界面文案 i18n（当前 UI 为简体中文，`locale/en.json` 已提供插件元数据英文）。

## 参与贡献

欢迎 Issue、PR 与文档改进：

1. 阅读 [CONTRIBUTING.md](CONTRIBUTING.md)（开发环境、编码约定、提交规范）。
2. 行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
3. 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开开 Issue。
4. 提交前请跑通 `npm test` 与 `npm run check`；涉及执行语义或 UI 的改动请同步更新文档与 `CHANGELOG.md`。

## License

[MIT](LICENSE) © 2026 czyt1988

---

## English overview

**dsh-workflow-orchestrator** is a visual workflow plugin for [DeepSeek Harness](https://github.com/deepseek-ai). It adds a first-level "Workflow" page: drag task nodes onto a canvas, connect them (sequential, parallel, or joined by a parallel gateway), and run the graph. Every task node creates a **real DSH task session** in the selected workspace; progress and errors stream into a run log. Task cards show which workspace each node belongs to and use distinct background colors across workspaces, while card borders keep expressing run status. A run can also start from any task node, executing only that node and its downstream nodes (the rest are marked "not run" without creating sessions). A **judge node** creates a session to evaluate its upstream output and can end the whole run early (`WOF_DECISION: CONTINUE|STOP`); a **terminate node** ends the run as soon as it is reached. Nodes that never started are marked "skipped" and do not count as failures. Workflows persist to `$DSH_HOME/workflow-orchestrator/workflows.json`. Zero runtime dependencies, Node.js ≥ 20.

- Install: add this repository folder through the DSH plugin manager, or link it into the profile's `node_modules` and `dsh.profile.bundles`.
- Test: `npm test` (unit) and `npm run check` (package manifest + docs lint); E2E requires the DSH desktop app, Playwright and model credentials.
- Docs: [user guide](docs/user/README.md) · [developer guide](docs/dev/README.md) (Chinese).
