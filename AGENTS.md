# AGENTS.md

> 本文件面向在此仓库中工作的 **AI 编码代理**（DSH 内置 Agent、Claude Code、Codex、Copilot 等）。
> 人类贡献者请优先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；产品使用说明见 [README.md](README.md)。

## 1. 项目定位

`dsh-workflow-orchestrator` 是 **DeepSeek Harness（DSH）** 的可视化工作流编排插件：

- 在 DSH 左侧栏注册一级页面「工作流编排」，提供画布、节点属性区与运行日志。
- 任务节点在运行时通过 `sessionController` 创建**真实 DSH 任务会话**；并行网关只做汇合与扇出。
- 画布与运行记录持久化到 `$DSH_HOME/workflow-orchestrator/workflows.json`。
- **运行时零第三方依赖**：宿主半区只用 Cordis 服务；浏览器半区的 `react` 复用壳层模块表；无构建步骤。

当前版本 `0.4.0`，MIT。仓库按 GitHub 开源项目组织，发布流程见 [docs/dev/packaging-and-release.md](docs/dev/packaging-and-release.md)。

## 2. 开始之前（必读顺序）

1. [docs/dev/architecture.md](docs/dev/architecture.md) —— 两半区结构、服务注入、页面加载链路。
2. [docs/dev/execution-engine.md](docs/dev/execution-engine.md) —— DAG 调度、网关汇合、失败级联、两种停止模式。
3. [docs/dev/data-model.md](docs/dev/data-model.md) 与 [docs/dev/http-api.md](docs/dev/http-api.md) —— 持久化结构与接口契约。
4. [CONTRIBUTING.md](CONTRIBUTING.md) —— 编码约定与提交规范。

改代码前先 grep 现有实现，不要凭猜测新增服务或字段；插件对 DSH 宿主服务的依赖都是**可选读取 + 降级**的，保持这个风格。

## 3. 常用命令

```powershell
npm test          # 引擎 + 存储/路由 + 发布工具单元测试（node:test，无需 DSH）
npm run check     # 包结构与文档自检（CI 同款）
npm run test:e2e  # 全链路 E2E（需要 DSH 桌面端 + Playwright + 模型凭据；耗时，谨慎使用）
npm run release:prepare -- 0.3.0  # 归档 CHANGELOG、升版本、同步文档里的版本描述
npm run release:check             # 发布门禁：版本 / engines.dsh / CHANGELOG / tag
```

- `npm test` 必须全绿；改执行语义时**必须**补 `test/engine.test.mjs` 用例。
- 改 `package.json`、`cordis.patch.yml`、`exports`、`files`、locale 或新增仓库文件后，跑 `npm run check`。
- 不要自行安装依赖来跑测试；项目刻意保持零依赖。

## 4. 架构速查

```text
浏览器半区  lib/client.js   ModuleLoader 模块，注册一级页面 + 侧栏入口；轮询 JSON API
宿主半区    lib/index.js    Cordis 插件：Web 路由 + 引擎 + 存储 + 选项目录
            lib/host/       store.js（原子写 JSON）/ engine.js（DAG 调度）
                            routes.js（/workflow-orchestrator/api/*）/ catalogs.js（宿主目录）
```

关键契约：

- 宿主入口导出 `name`、`inject = ['webServer','connection','sessions','agents','sessionController']`、`apply(ctx)`；包名与 loader id 必须保持一致（`dsh-workflow-orchestrator` / `workflow-orchestrator`）。
- 浏览器半区必须用 `window.__ModuleLoader__.load({ id, factory })` 注册，通过 `factory(require)` 取 `react`；**不要**引入自己的 React、打包器或全局样式冲突。
- 所有 API 响应统一 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`；请求体上限 2 MB。
- 路由先过 `connection.requestRejection(req)` 准入栅栏，**不要**移除或绕过。
- 状态文件写入必须保持「临时文件 + rename」的原子写与串行写链；损坏文件改名 `.corrupt-*` 后重建。
- 选项目录（工作区/模式/权限/模型）每次从宿主读取并缓存 60 s，不要硬编码 id 或模型名。

## 5. 目录与写入边界

| 路径 | 归属 | 代理可改？ |
| --- | --- | --- |
| `lib/`、`locale/`、`cordis.patch.yml`、`package.json` | 插件本体 | 可以，保持零依赖 |
| `test/`、`tools/` | 单元测试、E2E、包自检 | 可以 |
| `docs/user/`、`docs/dev/`、`docs/README.md` | 用户/开发文档 | 可以，遵守下方文档规则 |
| `docs/assets/images/` | 文档截图（PNG） | 替换/新增可以，命名见第 8 节 |
| `README.md`、`README.en.md`、`AGENTS.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`.github/` | 社区与发布文件 | 按需修改，改版本/发布流程需同步 |
| `.e2e/`、`.e2e-home/`、`.probe/`、`internal/` | 本地证据与排障材料（**已 gitignore**） | 不要提交，不要手工伪造结果 |
| `node_modules/`、`package-lock.json` 等 | 依赖产物 | 不要提交 |

## 6. 编码约定

- ESM（`"type": "module"`）、2 空格缩进、单引号、**行尾不加分号**、LF 换行（`.editorconfig` / `.gitattributes` 已配置）。
- `lib/` 内注释用英文 JSDoc（现有风格），面向用户的 UI 文案用简体中文；不要混用中英文注释风格。
- 不使用 `any` 之外的 TypeScript、不加构建步骤、不引入运行时依赖；共享工具放 `lib/host/util.js`。
- 输入一律视为不可信：新增字段要在 `sanitizeWorkflow` / `sanitizeTask` 中清洗并 clamp；新增路由要限制方法、请求体大小并走准入检查。
- 日志使用 `ctx.logger?.info/warn` 前缀 `workflow-orchestrator:`；运行日志通过 `engine.log()` 写入（有上限）。
- 错误信息面向用户，用简体中文；技术细节（错误码、会话 ID）保留原文。

## 7. 测试与验证要求

| 改动 | 最低验证 |
| --- | --- |
| 执行引擎、校验、prompt 组装 | `npm test`，并在 `test/engine.test.mjs` 增加对应用例 |
| 存储/清洗/路由 | `npm test`，在 `test/store-routes.test.mjs` 增加用例 |
| 包清单、导出、locale、文档文件 | `npm run check` |
| 涉及真实会话行为的改动 | 说明如何在 E2E 覆盖；有条件时跑 `npm run test:e2e` |
| 仅文档/截图 | 校验相对链接与图片存在，跑 `npm run check` |

E2E 的规范：隔离 `DSH_HOME` + 独立端口 + Playwright + 真实模型，证据写入 `.e2e/`，断言必须来自真实行为，**禁止**手工裁剪 JSON 或伪造截图。

## 8. 文档规则

- 文档分 **应用文档**（`docs/user/`，面向使用者）与 **开发文档**（`docs/dev/`，面向贡献者）；新增文档必须加入 [docs/README.md](docs/README.md) 与相关索引。
- 简体中文、GitHub 风格 Markdown；每篇开头有面包屑 `[文档首页](../README.md) / [用户文档](README.md)`（开发文档对应 `[开发文档](README.md)`）。
- 根目录 `README.md` 是默认中文版，`README.en.md` 是对应的英文版；两篇顶部互相链接，安装方式、命令、功能清单等结构性改动必须同步更新两篇。
- README 顶部顺序固定：一句话定位 → **它解决什么问题**（1 句）→ **它提供什么**（4–6 条）→ **三行快速开始**（安装 / 运行 / 第一次结果）。这三块是访客先读到的内容，改功能清单、安装命令或节点类型时一并更新，并保持中英两版对应。
- 嵌入式 Mermaid 图优先；节点文字含括号/冒号/斜杠时必须加双引号（`A["POST /api/run"]`）。
- 截图统一放 `docs/assets/images/`，写作 `![中文 alt](../assets/images/xxx.png)`，下一行配 `*图 N：说明。*`；图号在文档系列内连续编号。新增界面截图必须来自真实运行（E2E 或手工操作），不要使用设计稿冒充实现。
- 文档里不要出现本机绝对路径（如 `D:\Users\...`）、token、Cookie、邮箱或个人会话内容；路径示例用 `D:\path\to\plugin` 这类占位。
- 文档与代码同步矩阵：

| 代码改动 | 必须同步的文档 |
| --- | --- |
| 新增/重命名路由、错误码 | `docs/dev/http-api.md`、`docs/user/data-and-faq.md`（如影响用户） |
| 字段、上限、文件格式 | `docs/dev/data-model.md`、`docs/user/building-workflows.md` |
| 调度/停止/失败语义 | `docs/dev/execution-engine.md`、`docs/user/running-and-monitoring.md`、`docs/user/stopping-and-errors.md` |
| UI 文案、布局、交互 | `docs/user/interface.md`、相关截图 |
| 安装方式、清单、版本 | `README.md`、`README.en.md`、`docs/dev/packaging-and-release.md`、`CHANGELOG.md` |
| 命令、工具、CI | `README.md`、`README.en.md`、`docs/dev/development.md`、`docs/dev/testing.md` |

## 9. 截图更新流程

E2E 每次运行会在 `.e2e/` 生成 `NN-name.png`。文档引用的截图是复制品，命名映射：

| 文档文件 | 来源 | 内容 |
| --- | --- | --- |
| `panel-overview.png` | `10-panel.png` | 三栏总览 + 空态 |
| `add-node.png` | `11-node.png` | 点击节点卡新增节点 |
| `inspector.png` | `12-inspector.png` | 属性区完整字段 |
| `connect-edge.png` | `13-edge.png` | 节点连线 |
| `enter-no-run.png` | `13-enter-no-run.png` | Enter 只换行 |
| `persistence.png` | `14-persistence.png` | 刷新后仍持久化 |
| `chain-run.png` | `15-chain-run.png` | A→B 串行成功 |
| `gateway-graph.png` | `17-gateway-graph.png` | 网关拓扑 |
| `gateway-run.png` | `18-gateway-run.png` | 网关汇合执行 |
| `stop-dialog.png` | `19-stop-dialog.png` | 终止对话框 |
| `stop-detach.png` | `20-stop-detach.png` | 仅停止工作流 |
| `stop-cancel.png` | `21-stop-cancel.png` | 停止并终止任务 |
| `failure.png` | `22-failure.png` | 失败节点与 ERROR 日志 |
| `workspace-colors.png` | `23-workspace-colors.png` | 跨工作区提示条、任务卡片工作区行与分色、属性区配色设置 |
| `run-from-node.png` | `24-run-from-node.png` | 从节点开始执行后的未执行节点、执行范围与启动日志 |

更新截图时保持 1500×950 的界面比例与中文文案一致；截图变更后检查 README 与 docs 中的图注是否仍准确。

## 10. 提交与发布

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat|fix|docs|test|chore|ci|refactor|perf|build` + 可选 scope（`engine`、`store`、`routes`、`client`、`docs`、`repo`）。
- 一个提交只做一件事；文档与代码必要时可同提交，但不要夹带无关改动。
- 用户可见的变更写入 `CHANGELOG.md` 的 `[Unreleased]`；版本号遵循 SemVer，发版时用 `npm run release:prepare -- <version>` 统一改写（`package.json`、`CHANGELOG.md` 与各文档里的版本描述），不要手工只改一处。
- 发布由 `vX.Y.Z` tag 触发 `.github/workflows/release.yml`（测试 + 自检 → npm provenance 发布 → GitHub Release）；不要在本地手工 `npm publish`。打 tag 前必须跑 `npm run release:check`。
- 发布前清单见 [docs/dev/packaging-and-release.md](docs/dev/packaging-and-release.md)；发布前应确认 `npm test`、`npm run check`、文档链接与截图全部就绪。

## 11. 明确禁止

- ❌ 引入运行时第三方依赖、构建步骤、自建 React 或全局 CSS 覆盖。
- ❌ 绕过 `connection.requestRejection` 准入栅栏、放宽请求体上限或把路由挂到其他前缀。
- ❌ 提交 `.e2e/`、`internal/`、`.probe/`、`node_modules/`、模型凭据、Cookie、token。
- ❌ 伪造测试结果、E2E 证据或界面截图。
- ❌ 改动包名、loader id、API 前缀等对外契约而不更新文档与清单。
- ❌ 在文档/注释中写入本机绝对路径、个人邮箱、真实会话内容。
- ❌ 未经确认就修改 DSH 宿主代码（本仓库只消费宿主服务）。
