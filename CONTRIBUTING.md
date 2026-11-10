# 贡献指南

感谢你愿意为 `dsh-workflow-orchestrator` 做贡献！这是 DeepSeek Harness（DSH）的可视化工作流编排插件：把多个任务会话串成可执行的工作流，任务节点会在运行时创建真实的 DSH 任务会话，并行网关负责汇合分支。

无论是报告 bug、提功能建议、改文档、补翻译，还是直接提交代码，都欢迎。请在参与前先阅读 [行为准则](CODE_OF_CONDUCT.md)，本项目所有社区空间都适用该准则。使用 AI 编码代理参与贡献时，请让代理同时遵循 [AGENTS.md](AGENTS.md)。

## 可以贡献什么

| 方向 | 说明 | 入口 |
| --- | --- | --- |
| 报告 bug | 按模板填写复现步骤、DSH 与插件版本、日志；崩溃与执行语义错误优先 | [Bug 报告](https://github.com/czyt1988/dsh-workflow-orchestrator/issues/new?template=bug_report.yml) |
| 功能建议 | 说明使用场景、期望行为与替代方案；大改动请先开 issue 对齐思路 | [功能请求](https://github.com/czyt1988/dsh-workflow-orchestrator/issues/new?template=feature_request.yml) |
| 实现功能 / 修 bug | 从带 `good first issue`、`help wanted` 标签的 issue 入手；自己开工前先在 issue 里说明 | [Pull Request](https://github.com/czyt1988/dsh-workflow-orchestrator/pulls) |
| 文档 | 修正 README、`docs/` 下的说明与截图，补充使用示例与排障记录 | 附 PR 说明修改意图 |
| 翻译 | 维护 `locale/zh.json`、`locale/en.json` 的界面文案，以及文档的中英文对应 | 保证中英文 key 结构一致 |

**安全漏洞不要开公开 issue**，请按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

## 开发环境

- **Node.js >= 20**（`package.json` 的 `engines` 要求；仓库 `.nvmrc` 推荐 22，CI 覆盖 20 与 22）。
- **无需 `npm install`**：插件运行时零依赖，仓库没有 lockfile，也没有构建步骤。`lib/` 里的文件就是发布产物。
- 仓库用 `.editorconfig` / `.gitattributes` 约束格式：**UTF-8、LF 换行、2 空格缩进**（`*.ps1` 除外），提交前请让编辑器遵循这些配置。
- 修改浏览器半区（`lib/client.js`）或做手工验证，需要本机安装 DSH 桌面端，并把本仓库以本地目录方式装进 profile（见 [README.md](README.md) 的「安装」）。
- 跑全链路 E2E 还需要：`playwright-core`、本机 Chrome、可用的真实模型。E2E 不进 CI。

```powershell
git clone https://github.com/czyt1988/dsh-workflow-orchestrator.git
cd dsh-workflow-orchestrator
node --version   # 应为 v20 或更高
```

## 如何运行测试

```powershell
# 单元测试（node:test；不需要启动 DSH）——CI 跑的就是这条
npm test
# 等价于：
node --test test/engine.test.mjs test/store-routes.test.mjs

# 开发时自动重跑
npm run test:watch

# 插件包结构校验（package.json 的 dsh 声明、cordis.patch.yml、入口文件与导出是否齐全）
npm run check
```

```powershell
# 隔离环境全链路 E2E（需 DSH + Playwright + Chrome + 真实模型；会自动创建临时 DSH_HOME 与 dsh web 进程）
npm run test:e2e
# 等价于：node tools/e2e-full.cjs
```

E2E 耗时较长且依赖真实模型凭据，**不进 CI**；涉及真实会话行为的改动，请在 PR 里说明验证方式。

E2E 脚本把本机路径（DSH 安装位置、Chrome、Playwright）写成文件顶部的常量；在其他机器上运行时请先按实际环境修改这些常量。脚本产物写在 `.e2e-home/`、`.e2e/`，不要提交本地产物（见 `.gitignore`）。

新增或修改行为时请补测试：

- 引擎调度（启动时机、汇合、失败级联、终止模式）→ `test/engine.test.mjs`，用引擎的 executor 测试缝，不启动 DSH。
- 存储与 JSON 路由 → `test/store-routes.test.mjs`，用临时目录 + 伪造请求/响应对象。

## 代码约定

### 模块与依赖

- **ESM**：`lib/` 下全部使用 `import` / `export`，不要用 `require`。唯一例外是 `tools/e2e-full.cjs`（CommonJS 脚本，保持现状）。
- **运行时零依赖**：不要往 `dependencies` 里加包。需要 DSH 能力时，通过插件 context 上的 Cordis 服务获取，例如 `ctx.webServer`、`ctx.connection`、`ctx.sessions`、`ctx.agents`、`ctx.sessionController`；宿主半区只 import `node:` 内置模块和相对路径文件。
- **无构建步骤**：不要引入打包 / 转译 / 生成流程；改 `lib/` 就是改发布产物。
- **客户端半区通过模块加载器加载**：`lib/client.js` 必须用 `window.__ModuleLoader__.load({ id, factory })` 暴露，框架依赖从 `factory(require)` 里取宿主的 React（`require('react')`），不要自带框架或全局变量。
- **数据目录**：运行期产物只能写入 `$DSH_HOME/workflow-orchestrator/`；测试与脚本的临时文件写到系统临时目录或 `.e2e-home/`。

### 代码风格

- **2 空格缩进、无分号、单引号**、对象/数组尾逗号，LF 换行（与现有 `lib/`、`test/` 文件保持一致）。
- **JSDoc**：每个导出函数 / 类写一行 `/** ... */` 摘要。按 [AGENTS.md](AGENTS.md) 的约定，`lib/` 内沿用现有英文 JSDoc 风格；面向用户的 UI 文案与文档用简体中文——**同一文件内不要混用中英文注释风格**。
- 不要留下调试用的 `console.log`；运行日志请走引擎的日志结构与 `ctx.logger`。

```js
/**
 * Seconds between two timestamps; a missing end time means "now".
 */
export function elapsedSeconds(startedAt, endedAt) {
  const end = typeof endedAt === 'number' ? endedAt : Date.now()
  return Math.max(0, Math.round((end - startedAt) / 1000))
}
```

```js
// 浏览器半区：交给 DSH 客户端模块加载器，React 用宿主自带的那一份
window.__ModuleLoader__.load({
  id: 'dsh-workflow-orchestrator',
  factory: (require) => {
    const React = require('react')
    // ...
  },
})
```

### 前端与文案

- 界面文案走 `locale/zh.json` 与 `locale/en.json`，两边 key 必须一一对应。
- 新增用户可见功能后，同步更新 `README.md`、相关文档与截图。

## 提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```text
<type>(<scope>): <subject>

<body>

<footer>
```

- `scope` 建议用模块名：`engine`、`store`、`routes`、`catalogs`、`client`、`docs`、`ci`。
- `subject` 中英文均可，简洁描述「做了什么」，不加句号。
- 破坏性变更用 `!` 标记（如 `feat(client)!: 调整节点数据结构`），并在 footer 写 `BREAKING CHANGE: ...`。

| 类型 | 用途 | 示例 |
| --- | --- | --- |
| `feat` | 新增用户可见能力 | `feat(client): 节点属性面板支持上游上下文三档` |
| `fix` | 修复缺陷 | `fix(engine): 分支失败时不再启动下游节点` |
| `docs` | 文档 | `docs(readme): 补充终止两种模式的区别` |
| `style` | 不影响行为的格式调整 | `style(client): 统一缩进` |
| `refactor` | 重构，不改变行为 | `refactor(store): 抽出 sanitizeWorkflow` |
| `perf` | 性能优化 | `perf(engine): 减少运行快照的深拷贝` |
| `test` | 测试 | `test(engine): 覆盖失败级联与跳过` |
| `build` | 依赖 / 构建相关 | `build: 提升 Node 版本要求到 20` |
| `ci` | CI 配置 | `ci: 增加 Node 22 矩阵` |
| `chore` | 杂项 | `chore: 更新 .gitignore` |
| `revert` | 回滚提交 | `revert: feat(client): ...` |

### DCO 签名

本项目采用 [DCO 1.1](https://developercertificate.org/)，**不需要 CLA**。请为每个提交加签名：

```powershell
git commit -s -m "feat(client): 节点属性面板支持上游上下文三档"
```

签名行形如 `Signed-off-by: 你的名字 <you@example.com>`，表示你有权以 [MIT 许可证](LICENSE) 提交该贡献。未签名的 PR 会被要求补签（可 `git commit --amend -s` 后更新分支）。

## 分支与 PR 流程

1. 从 `main` 切出分支，命名建议：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`、`ci/<简述>`。
2. 在新分支上提交（遵守上面的提交规范并签名 DCO）。
3. 保持分支与 `main` 同步（推荐 `git rebase origin/main`），不要对 `main` 强制推送。
4. 向 `main` 发起 PR，并完整填写 PR 模板：变更类型、关联 issue、测试证明、文档与 CHANGELOG 勾选。
5. 等待 CI 变绿（ubuntu / windows × Node 20 / 22 的 `npm test` 与 `npm run check`）并至少一位维护者 review；必要时按 review 意见追加提交。
6. 合并使用 **squash merge**，PR 标题作为最终提交信息（仍需符合 Conventional Commits）。

小修小补（错别字、注释、文档）也欢迎直接开 PR；涉及行为或接口变更时，请先在 issue 中讨论。

## Issue 要求

- 先搜索已有 issue，避免重复。
- Bug 报告请用模板，并尽量包含：DSH 版本、插件版本、操作系统、复现步骤、期望 / 实际结果、相关日志与截图。
- 功能请求请说明使用场景、期望方案、替代方案，以及对用户 / 开发者 / 文档的影响。
- **不要**在 issue 里粘贴 token、API Key、完整会话内容或其他敏感信息；日志请先脱敏（可把 session id 的后半段打码）。
- 安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，不要公开。

## 文档同步要求

改动涉及以下内容时，必须在同一个 PR 里同步文档与 [CHANGELOG.md](CHANGELOG.md)：

- 用户可见行为、界面、配置项、安装方式 → 更新 `README.md`；新增功能在 CHANGELOG 的 `[Unreleased]` 下补 `### Added` / `### Changed` / `### Fixed` 条目。
- JSON API 路由（前缀 `/workflow-orchestrator`）、存储结构、运行记录格式 → 更新 `docs/` 下对应开发文档，并在 CHANGELOG 记录。
- `package.json` 的 `dsh` 声明、`cordis.patch.yml`、入口与导出映射 → 同步更新文档，确保 `npm run check` 仍通过。
- 界面文案 → 同时更新 `locale/zh.json` 与 `locale/en.json`。
- 截图相关改动 → 更新 `docs/assets/images/` 下的图片，避免文档里的截图与界面不符。

## 许可证

本项目使用 [MIT 许可证](LICENSE)。提交 contribution 即表示你同意以 MIT 许可证发布你的贡献；版权归贡献者所有，无需签署 CLA。

再次感谢你的参与！
