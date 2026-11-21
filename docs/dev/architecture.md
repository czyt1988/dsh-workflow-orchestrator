[文档首页](../README.md) / [开发文档](README.md)

# 架构总览

`dsh-workflow-orchestrator` 是一个同时包含**宿主半区**与**浏览器半区**的 DSH 插件：

- **宿主半区**是一个普通 Cordis 插件（[`lib/index.js`](../../lib/index.js)），在 DSH 进程内挂载 JSON API、持有工作流存储并驱动执行引擎。
- **浏览器半区**是一个 `window.__ModuleLoader__` 模块（[`lib/client.js`](../../lib/client.js)），在 Web 壳层里注册一级页面「工作流编排」与左侧栏入口。

两半区之间只通过 `/workflow-orchestrator/api/*` 的 JSON 通信，不共享模块、不互相 import，也没有构建产物。

## 1. 两半区与外部依赖

```mermaid
flowchart TB
  subgraph BROWSER["浏览器半区 · Web 壳层"]
    C1["lib/client.js · __ModuleLoader__.load"] --> C2["slots.main 面板组件"]
    C1 --> C3["slots.sidebar.panellist 侧栏入口"]
    C2 --> C4["call() · fetch /workflow-orchestrator/api/*"]
    C2 -.-> C5["uiWorkspace.openSession 可选"]
  end
  subgraph HOST["宿主半区 · Cordis 插件"]
    H1["lib/index.js · apply(ctx)"] --> H2["WorkflowStore"]
    H1 --> H3["CatalogService"]
    H1 --> H4["WorkflowEngine"]
    H1 --> H5["createRouteHandler"]
    H5 --> H4
    H5 --> H2
    H4 --> H2
    H4 --> H3
  end
  subgraph SVC["DSH 宿主服务"]
    S1["webServer"]
    S2["connection"]
    S3["sessions"]
    S4["agents"]
    S5["sessionController"]
    S6["workspaceRegistry / agentPresets / permissionPresets / dshHomePath"]
  end
  subgraph DISK["文件系统 · $DSH_HOME"]
    D1["workflow-orchestrator/workflows.json"]
    D2["workflow-orchestrator/host-loaded.json"]
  end
  C4 -->|"HTTP JSON"| H5
  H1 -.->|"inject"| S1
  H1 -.->|"inject"| S2
  H4 -.->|"实时会话操作"| S3
  H4 -.->|"状态与取消"| S4
  H4 -.->|"创建 / 选择模型 / 发提示词 / 取消"| S5
  H3 -.->|"按需读取"| S6
  H2 -->|"原子写"| D1
  H1 -->|"激活标记"| D2
```

| 半区 | 运行位置 | 入口 | 职责 |
| --- | --- | --- | --- |
| 宿主半区 | DSH 桌面端 / `dsh web` 进程 | [`apply(ctx)`](../../lib/index.js#L47) | 路由、存储、DAG 调度、真实会话驱动 |
| 浏览器半区 | 渲染进程的 Web 页面 | [`window.__ModuleLoader__.load`](../../lib/client.js#L12) | 画布编辑、属性面板、日志显示、轮询运行状态 |

清单里两半区各自有明确开关：

- 宿主半区：`dsh.bundle.patch` 指向 [`cordis.patch.yml`](../../cordis.patch.yml)，`main` 指向 [`lib/index.js`](../../package.json#L6)。
- 浏览器半区：`dsh.client.platform = "web"`，并通过 `exports["./client"]` 暴露 [`lib/client.js`](../../package.json#L11)。两处声明见 [`package.json:29`](../../package.json#L29)。

## 2. 宿主半区：Cordis 插件

### 2.1 插件契约

宿主入口导出三个符号（[`lib/index.js`](../../lib/index.js)）：

| 导出 | 值 | 作用 |
| --- | --- | --- |
| `name` | `dsh-workflow-orchestrator` | Cordis 插件身份，与包名一致（[`lib/index.js:18`](../../lib/index.js#L18)） |
| `inject` | `webServer`、`connection`、`sessions`、`agents`、`sessionController` | 缺失则插件不激活（[`lib/index.js:21`](../../lib/index.js#L21)） |
| `apply` | 函数 | 装配依赖并注册效应（[`lib/index.js:47`](../../lib/index.js#L47)） |

`apply` 内部的装配顺序是固定的：

1. 创建 `WorkflowStore`、`CatalogService`、`WorkflowEngine`、`createRouteHandler`（[`lib/index.js:48`](../../lib/index.js#L48)）。
2. 把路由以**前缀**方式注册到宿主 Web 服务器：`ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })`（[`lib/index.js:58`](../../lib/index.js#L58)）。
3. 注册引擎生命周期效应，插件卸载时调用 `engine.dispose()`（[`lib/index.js:69`](../../lib/index.js#L69)）。
4. 写诊断用激活标记 `host-loaded.json`，失败静默（[`lib/index.js:24`](../../lib/index.js#L24)）；随后输出一条 `workflow-orchestrator: mounted (...)` 日志（[`lib/index.js:72`](../../lib/index.js#L72)）。

### 2.2 注入的 5 个服务

| 服务 | 使用点 | 用途 |
| --- | --- | --- |
| `webServer` | [`lib/index.js:59`](../../lib/index.js#L59) | 以前缀方式挂载 `/workflow-orchestrator`，返回 `dispose` |
| `connection` | [`lib/host/routes.js:77`](../../lib/host/routes.js#L77) | `requestRejection(req)` 准入栅栏，复用宿主的浏览器信任判定 |
| `sessions` | [`lib/host/engine.js:1993`](../../lib/host/engine.js#L1993) | 按会话 ID 取实时会话，读取事件与消息 |
| `agents` | [`lib/host/engine.js:2264`](../../lib/host/engine.js#L2264) | 读取 Agent 运行状态，判断「空闲」、轮次边界与超时 |
| `sessionController` | [`lib/host/engine.js:1986`](../../lib/host/engine.js#L1986)、[`:1932`](../../lib/host/engine.js#L2014)、[`:1945`](../../lib/host/engine.js#L2027)、[`:2101`](../../lib/host/engine.js#L2183) | 创建真实任务会话、选择模型、投递提示词、取消会话 |

### 2.2.1 定时调度器

`WorkflowEngine` 内部还有一个每 10 秒运行一次的定时调度器（`setInterval` + `unref`，`dispose()` 清理）：它读取存储中的工作流定义，只把**入口定时节点**（`timer` 且没有入边）当作自动触发来源，到点后用内部 `start(workflowId, undefined, { trigger })` 启动一次完整运行，并把触发来源写进运行记录。调度结果（周期工作流数量、下次触发时间、校验状态）通过 `engine.snapshot().periodic` 与 `GET /api/periodic` 暴露给面板顶部警告条与左侧栏徽标。周期触发在工作流已运行时跳过而不是排队；应用重启后从重启时刻重新计算，停机期间错过的一次性触发只在计划时间后 10 分钟窗口内补触发，睡眠唤醒后周期触发最多补触发一次。

动作节点与等待任务完成节点由同一次 `schedule()` 驱动：动作节点调用 [`lib/host/actions.js`](../../lib/host/actions.js) 的平台执行器；等待节点通过可选宿主服务（`agents`、`sessions`、`subagents`、`sessionProjections`、`sessionTitle`）轮询外部任务，任务候选由 `GET /api/tasks` 提供给属性区。

### 2.3 按需读取的服务

这些服务**不写进 `inject`**，而是运行时 `ctx.get(...)` 读取并逐项降级——缺失时只有对应功能降级，不会让插件整体挂掉：

| 服务 | 读取点 | 缺失时的行为 |
| --- | --- | --- |
| `permissionPresets` | [`lib/host/engine.js:1996`](../../lib/host/engine.js#L1996)、[`lib/host/catalogs.js:148`](../../lib/host/catalogs.js#L148) | 应用权限预设失败只记 `warn`，沿用会话默认权限 |
| `subagents` | [`lib/host/engine.js`](../../lib/host/engine.js) 的 `checkChildWork()` | 不等待后台子代理，完成判定退化为「第一个结束轮次」；`waitForChildren` / `waitForTreeWork` 抛错时同样降级并记 `WARN`。两种 API 的返回语义相反：旧 API 返回「仍有工作」，新 API 返回「已汇合、需重新检查」 |
| `sessionProjections` | [`lib/host/engine.js:497`](../../lib/host/engine.js#L497) | 感知不到限时提问超时后「仍可回答」的提问，等待用户回复的判定只剩前台等待信号，节点可能在用户回答前提前完成；记 `WARN`（每个节点一次） |
| `sessionTitle` | [`lib/host/engine.js`](../../lib/host/engine.js) 的 `listWaitCandidates()` | 插件自己运行中的任务仍显示「工作流 / 节点」名，其它存活任务只能用会话 ID 作标题，列表可读性下降 |
| `dshHomePath` | [`lib/index.js:27`](../../lib/index.js#L27)、[`lib/host/store.js:42`](../../lib/host/store.js#L42) | 回退到环境变量 `DSH_HOME`，再回退到 `~/.dsh` |
| `workspaceRegistry` | [`lib/host/catalogs.js:146`](../../lib/host/catalogs.js#L146) | 工作区列表为空，`problems` 里记录 `workspaces` 失败 |
| `agentPresets` | [`lib/host/catalogs.js:147`](../../lib/host/catalogs.js#L147) | 「模式」下拉为空，默认模式缺失 |
| `sessionController.modelCatalog()` | [`lib/host/catalogs.js:172`](../../lib/host/catalogs.js#L172) | 模型目录为空，`modelFailures` 记录失败项 |
| `uiWorkspace`（浏览器半区） | [`lib/client.js:1495`](../../lib/client.js#L1495) | 「打开任务会话」退化为复制会话 ID 到剪贴板 |
| `slots`（浏览器半区） | [`lib/client.js:3039`](../../lib/client.js#L3039) | 无法注册页面，面板不出现 |

`CatalogService` 把四类目录聚合成一个快照，单项失败写入 `problems`，并缓存 60 秒（[`lib/host/catalogs.js:9`](../../lib/host/catalogs.js#L9)、[`:134`](../../lib/host/catalogs.js#L134)）。

## 3. 浏览器半区：ModuleLoader 模块

浏览器半区不是 npm 依赖，也不是 IIFE 包，而是壳层模块表的注册项（[`lib/client.js:12`](../../lib/client.js#L12)）：

- `factory(require)` 里的 `react` 由壳层模块表提供（[`lib/client.js:15`](../../lib/client.js#L15)），所以文件里没有 React 副本、没有 JSX、没有打包步骤。
- 插件对象导出 `{ name, inject: ['slots'], apply }`（[`lib/client.js:3039`](../../lib/client.js#L3039)）。
- `apply(ctx)` 先注入一份 `<style id="dsh-workflow-orchestrator-style">`（[`lib/client.js:3043`](../../lib/client.js#L3043)），再把同一个面板组件注册到两个 slot：
  - `slots.main`，key 为 `workflow-orchestrator`（[`lib/client.js:3053`](../../lib/client.js#L3053)）；
  - `slots.sidebar.panellist`，`order: 40`，标签函数返回「工作流编排」（[`lib/client.js:3056`](../../lib/client.js#L3056)）。
- 卸载时两个 slot 声明与样式都会被清理（[`lib/client.js:3067`](../../lib/client.js#L3067)）。

面板自身是三栏布局加底部日志（[`lib/client.js:175`](../../lib/client.js#L175) 的 CSS 网格；[`lib/client.js:2962`](../../lib/client.js#L2962) 的渲染树）：左侧节点卡片、中间画布 + 消息窗口、右侧属性区。

### 3.1 API 调用方式

```js
const API_ROOT = 'workflow-orchestrator/api'   // lib/client.js:23
fetch(apiUrl(`${API_ROOT}/${name}`), { ... })  // lib/client.js:317
```

- `apiUrl()` 以页面 `document.baseURI` 为基准解析相对路径，因此插件不假设自己挂在站点根目录（[`lib/client.js:307`](../../lib/client.js#L307)）。
- `call()` 统一 `credentials: 'same-origin'`，并把非 `{ ok: true }` 的响应转成 `Error`（[`lib/client.js:316`](../../lib/client.js#L316)）。

## 4. 安装与加载链路

```mermaid
sequenceDiagram
  autonumber
  participant DSH as DSH 启动器
  participant PROFILE as profile 组合层
  participant HALF as 宿主半区
  participant WEB as Web 壳层
  participant PANEL as 编排面板
  participant API as 路由与引擎
  participant DISK as $DSH_HOME
  DSH->>PROFILE: 读取 dsh.profile.bundles
  PROFILE->>PROFILE: 合并 bundle patch 的 insert 行
  PROFILE->>HALF: 加载 dsh-workflow-orchestrator 的 main
  HALF->>HALF: apply(ctx) 装配 store / catalogs / engine / routes
  HALF->>DISK: 写 host-loaded.json
  WEB->>HALF: 页面加载后请求 client 子路径导出
  WEB->>PANEL: 执行 __ModuleLoader__ 注册并挂载 slots
  PANEL->>API: GET /api/state
  API-->>PANEL: workflows + activeWorkflowId + catalogs + engine
  loop 每 1000 ms
    PANEL->>API: GET /api/run
    API-->>PANEL: 最新运行快照
  end
```

加载链路的三个关键点：

1. **profile 组合**：插件以包名加入 profile 的 `dsh.profile.bundles`（或由插件管理器以 `link:` 安装），DSH 组合 bundle patch 时把 [`cordis.patch.yml`](../../cordis.patch.yml) 的 `insert` 行插进 Loader 配置。行 `id` 是 `workflow-orchestrator`，`name` 是包名 `dsh-workflow-orchestrator`。
2. **宿主先于页面**：宿主半区随 DSH 进程启动；如果宿主没加载，页面上的 `/api/*` 全部 404，日志里也不会有 `workflow-orchestrator: mounted`。
3. **页面按需挂载**：侧栏出现「工作流编排」后，点击才真正渲染面板组件；面板首次渲染时 `GET /api/state`，若存储里一个工作流都没有，会立刻 `POST /api/create` 建一个「工作流 1」（[`lib/client.js:996`](../../lib/client.js#L996)）。

## 5. 数据与控制流

### 5.1 编辑与保存

- 画布、节点、属性区的每次修改都走 `updateWorkflow()`（[`lib/client.js:1056`](../../lib/client.js#L1056)），只改内存并调用 `scheduleSave()`。
- `scheduleSave()` 做 **600 ms 防抖**（[`lib/client.js:977`](../../lib/client.js#L977)），随后 `POST /api/save`（[`lib/client.js:964`](../../lib/client.js#L964)）。
- 切换工作流前先 `flushSave()`，再 `POST /api/active` 记住当前视图（[`lib/client.js:1065`](../../lib/client.js#L1065)）。

### 5.2 执行

- 点击「执行」：先 `flushSave()`，再 `POST /api/run`，请求体同时带 `workflowId` 与当前画布快照 `workflow`（[`lib/client.js:1501`](../../lib/client.js#L1501)）。
- 点击「从此节点开始执行」：走同一个 `startRun()`，请求体额外带 `startNodeId`（[`lib/client.js:1501`](../../lib/client.js#L1501)）；宿主只调度该节点及其下游可达子图，范围外节点在调度开始前写为 `not-run`（[`lib/host/engine.js:1257`](../../lib/host/engine.js#L1257)、[`:705`](../../lib/host/engine.js#L1508)）。
- 宿主侧 `engine.start()` 会**用提交的覆盖版本先保存一次**，然后校验、建运行记录、异步调度（[`lib/host/engine.js:1257`](../../lib/host/engine.js#L1257)）。
- 终止：`POST /api/stop`，带 `runId` 与 `cancelTasks`（[`lib/client.js:1525`](../../lib/client.js#L1525)）。

### 5.3 轮询

- 面板只轮询**运行状态**，从不轮询可编辑的工作流定义（源码注释见 [`lib/client.js:1029`](../../lib/client.js#L1029)）；间隔固定 1000 ms（[`lib/client.js:1040`](../../lib/client.js#L1040)）。
- 每次 `GET /api/run` 返回 `{ run, engine }`，面板用 `engine` 整体替换本地运行视图（[`lib/client.js:1034`](../../lib/client.js#L1034)）。
- 运行状态里的 `log` 是**内存中最近日志的切片**；持久化记录是更小的 compact 版本，两者差异见 [数据模型](data-model.md)。

### 5.4 持久化

- 所有工作流定义与最近运行记录都在一个文件里：`$DSH_HOME/workflow-orchestrator/workflows.json`（[`lib/host/store.js:39`](../../lib/host/store.js#L39)）。
- 写入串行化并原子提交：临时文件 + `rename`（[`lib/host/store.js:444`](../../lib/host/store.js#L444)）。
- 同一个 `DSH_HOME` 被两个 DSH 实例同时使用时没有跨进程锁，属于**最后写入者胜**；这是当前实现的明确边界。

## 6. 生命周期与错误边界

| 场景 | 行为 |
| --- | --- |
| 插件卸载 | 注销 Web 路由（[`lib/index.js:58`](../../lib/index.js#L58)）；`engine.dispose()` 停止定时调度、对未停止的运行发起 `cancel-tasks` 停止（[`lib/host/engine.js:1387`](../../lib/host/engine.js#L1387)） |
| 页面关闭 / 组件卸载 | 清除保存定时器、轮询定时器；槽位声明由插件效应统一释放（[`lib/client.js:3067`](../../lib/client.js#L3067)） |
| 路由内业务异常 | 统一 `400 workflow-error`（[`lib/host/routes.js:201`](../../lib/host/routes.js#L201)） |
| 选项目录失败 | `buildState` 用空目录 + `problems` 兜底（[`lib/host/routes.js:54`](../../lib/host/routes.js#L54)）；面板在无工作区时显示横幅提示（[`lib/client.js:2985`](../../lib/client.js#L2985)） |
| 状态文件损坏 | 改名 `.corrupt-<时间戳>` 后以空状态启动（[`lib/host/store.js:370`](../../lib/host/store.js#L370)） |

## 7. 待按 DSH 版本确认的契约

仓库没有声明 DSH 版本或 `peerDependencies`，以下属于**宿主侧契约**，跨 DSH 版本可能变化：

- `ctx.webServer.register({ kind: 'prefix', ... })` 的返回是否始终可调用。
- `connection.requestRejection(req)` 的签名与返回值语义。
- `sessionController.create / selectModel / prompt / cancel` 的参数形状；其中 `prompt` 使用 `mode: 'queue'` 与 `AbortSignal`（[`lib/host/engine.js:2027`](../../lib/host/engine.js#L2027)）。
- 会话事件 `turn/start`、`turn/end` 与 `turn/end.data.reason` 的结构（[`lib/host/engine.js:560`](../../lib/host/engine.js#L560)）；后台子代理依赖的可选服务 `subagents.waitForChildren(agent)`（旧版）/ `subagents.waitForTreeWork(agent)`（现版本）/ `drainDescendants(agents)` 也属于宿主契约，缺失时自动降级。
- Web 壳层 slot 名称 `main` 与 `sidebar.panellist`（[`lib/client.js:3053`](../../lib/client.js#L3053)）。

遇到升级后行为异常，先核对以上几处，再检查宿主日志里是否有 `workflow-orchestrator:` 前缀的输出。

## 相关文档

- 下一步：[执行引擎](execution-engine.md)
- 数据格式：[数据模型](data-model.md)
- 接口契约：[HTTP API](http-api.md)
- 本地联调与排障：[开发环境](development.md)
