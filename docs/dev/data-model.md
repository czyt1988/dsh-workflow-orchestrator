[文档首页](../README.md) / [开发文档](README.md)

# 数据模型

插件的全部持久化状态都在**一个 JSON 文件**里：

```text
$DSH_HOME/workflow-orchestrator/workflows.json
```

它同时保存工作流画布（定义）与最近若干次运行记录。另有一个独立的诊断文件 `host-loaded.json`（激活标记，不属于业务状态）。本文描述字段、清洗规则、容量上限与写入方式，全部对应 [`lib/host/store.js`](../../lib/host/store.js) 的当前实现。

## 1. 文件位置

`resolveDataFile(ctx)` 按以下顺序确定目录（[`lib/host/store.js:28`](../../lib/host/store.js#L28)）：

1. Cordis 服务 `dshHomePath()`（可选的按需服务，[`lib/host/store.js:31`](../../lib/host/store.js#L31)）；
2. 环境变量 `DSH_HOME`；
3. 用户主目录下的 `.dsh`。

文件名固定为 `workflow-orchestrator/workflows.json`，目录不存在时在首次写入前自动 `mkdir -p`。

诊断文件由宿主入口单独写入：`workflow-orchestrator/host-loaded.json`，内容为 `{ pid, plugin, loadedAt }`，失败静默，仅用于确认宿主半区是否激活（[`lib/index.js:24`](../../lib/index.js#L24)）。

## 2. 实体关系

```mermaid
erDiagram
  WORKFLOW ||--o{ NODE : contains
  WORKFLOW ||--o{ EDGE : contains
  WORKFLOW ||--o| SETTINGS : "settings 可缺省"
  NODE ||--o| TASK : "仅任务节点"
  WORKFLOW ||--o{ RUN : "运行时产生"
  RUN ||--o{ RUN_NODE : "按节点记录"
  RUN ||--o{ LOG_ENTRY : "日志上限 400"

  WORKFLOW {
    string id
    string name
    number createdAt
    number updatedAt
  }
  NODE {
    string id
    string type
    string title
    number x
    number y
  }
  TASK {
    string prompt
    string contextMode
    string workspaceId
    string agentPreset
    string permissionPreset
  }
  EDGE {
    string id
    string from
    string to
  }
  SETTINGS {
    string defaultWorkspaceId
    object workspaceColors
  }
  RUN {
    string id
    string workflowId
    string workflowName
    string startNodeId
    string status
    string stopMode
    number startedAt
    number endedAt
    string error
  }
  RUN_NODE {
    string id
    string title
    string type
    string status
    string sessionId
    number startedAt
    number endedAt
    string error
    string output
  }
  LOG_ENTRY {
    number time
    string level
    string message
    string nodeId
    string nodeTitle
  }
```

`RUN.workflowId` 是逻辑引用：删除工作流时会把它的历史运行一并删掉（[`lib/host/store.js:285`](../../lib/host/store.js#L285)），但文件里没有外键约束。

`RUN_NODE.status` 取 7 种状态之一：`pending` / `running` / `completed` / `failed` / `cancelled` / `skipped` / `not-run`（未执行，仅范围执行时出现）。`SETTINGS.workspaceColors` 是可缺省的对象，最多 40 项。

## 3. 顶层结构

```json
{
  "version": 1,
  "activeWorkflowId": "wf-1a2b3c4d",
  "workflows": [],
  "runs": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | number | 当前常量 `STATE_VERSION = 1`（[`lib/host/store.js:19`](../../lib/host/store.js#L19)）。读取时不校验旧值，写回总是 1，暂无迁移逻辑 |
| `activeWorkflowId` | string \| null | 面板上次显示的工作流；加载时若指向不存在的工作流，回退到第一个或 `null`（[`lib/host/store.js:228`](../../lib/host/store.js#L228)） |
| `workflows` | object[] | 工作流定义数组，文档顺序即面板下拉顺序 |
| `runs` | object[] | 已完成运行的 compact 记录，最旧在前 |

## 4. 工作流定义

### 4.1 完整示例

```json
{
  "version": 1,
  "activeWorkflowId": "wf-1a2b3c4d",
  "workflows": [
    {
      "id": "wf-1a2b3c4d",
      "name": "示例工作流",
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000,
      "nodes": [
        {
          "id": "node-a",
          "type": "task",
          "title": "任务 1",
          "x": 80,
          "y": 120,
          "task": {
            "prompt": "总结这份报告",
            "contextMode": "full",
            "workspaceId": "workspace-1",
            "agentPreset": "standard",
            "permissionPreset": "danger-full-access",
            "model": {
              "provider": "example-provider",
              "model": "example-model",
              "reasoningEffort": "high"
            }
          }
        },
        {
          "id": "gw-1",
          "type": "parallel",
          "title": "并行网关",
          "x": 360,
          "y": 120
        }
      ],
      "edges": [
        { "id": "edge-1", "from": "node-a", "to": "gw-1" }
      ],
      "settings": {
        "defaultWorkspaceId": "workspace-1",
        "workspaceColors": { "workspace-1": "#2563eb", "workspace-2": "#16a34a" }
      }
    }
  ],
  "runs": []
}
```

### 4.2 字段表

**Workflow**

| 字段 | 类型 | 清洗/默认规则 |
| --- | --- | --- |
| `id` | string | 缺失时 `newId('wf')`；保存已有工作流时沿用 previous 的 id（[`lib/host/store.js:155`](../../lib/host/store.js#L155)） |
| `name` | string | 空则「未命名工作流」，截断到 120 字 |
| `createdAt` | number | 优先 previous、其次 source 的数字，否则当前时间 |
| `updatedAt` | number | 每次 save 都刷新为当前时间 |
| `nodes` | Node[] | 最多 200 个，超出部分被丢弃 |
| `edges` | Edge[] | 最多 400 条；非法边被丢弃 |
| `settings` | object | 只保留非空的 `defaultWorkspaceId` 与合法的 `workspaceColors`，否则 `{}`（[`lib/host/store.js:148`](../../lib/host/store.js#L148)） |

**Node**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 缺失或与前面节点重复时重新生成 `newId('node')`（[`lib/host/store.js:102`](../../lib/host/store.js#L102)） |
| `type` | `'task' \| 'parallel'` | 任何非 `parallel` 的值都归一为 `task` |
| `title` | string | 空则「并行网关」/「任务 N」，截断 80 字 |
| `x` / `y` | number | `clampNumber(...)`：x 限制在 -20000..20000，y 限制在 -20000..20000；非数字回退到 `index * 240` / `80`（[`lib/host/store.js:111`](../../lib/host/store.js#L111)） |
| `task` | object | **只有任务节点**才有；并行网关没有该字段 |

**Task**（节点内嵌对象，[`lib/host/store.js:81`](../../lib/host/store.js#L81)）

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `prompt` | string | 默认 `''`，截断到 200 000 字 |
| `contextMode` | `'full' \| 'summary' \| 'none'` | 其它值归一为 `full` |
| `workspaceId` | string | 可选；只接受非空字符串 |
| `agentPreset` | string | 可选；只接受非空字符串 |
| `permissionPreset` | string | 可选；只接受非空字符串 |
| `model` | object | 可选；必须同时有非空 `provider` 与 `model` 字符串，`reasoningEffort` 可选（[`lib/host/store.js:46`](../../lib/host/store.js#L46)） |

**Edge**（[`lib/host/store.js:119`](../../lib/host/store.js#L119)）

- `from` / `to` 必须是非空字符串且都指向已存在的节点；
- 禁止自环（`from === to`）；
- 相同 `from → to` 去重；
- `id` 缺失时生成 `newId('edge')`；
- 到达 400 条后停止接收。

**Settings**

| 字段 | 类型 | 清洗规则 |
| --- | --- | --- |
| `defaultWorkspaceId` | string | 可选；只接受非空字符串，否则整个键不写回（[`lib/host/store.js:149`](../../lib/host/store.js#L149)） |
| `workspaceColors` | object | 可选；键为非空工作区 ID，值为合法的十六进制颜色；`#rgb` 缩写会展开为 `#rrggbb` 并统一小写；最多 40 项，非法项丢弃；空对象不写回（[`lib/host/store.js:67`](../../lib/host/store.js#L67)） |

`settings` 里除这两个字段之外的任何键都会被丢弃。范围执行产生的 `run.startNodeId` 不是工作流定义字段，只存在于运行记录中，因此不经过 `sanitizeWorkflow`。

## 5. 运行记录

### 5.1 内存态与持久态

运行中引擎内部保存完整状态（含 `failureSeen`、`summary`、最新 800 行日志，见 [`lib/host/engine.js:310`](../../lib/host/engine.js#L310)）。运行结束后 `recordRun()` 调用 `compactRun()`（[`lib/host/store.js:167`](../../lib/host/store.js#L167)）写入文件：

| 字段 | 持久化 | 说明 |
| --- | --- | --- |
| `id`、`workflowId`、`workflowName`、`startedAt`、`endedAt` | 是 | 运行标识与终态 |
| `startNodeId` | 是 | `null` = 全量执行；字符串 = 本次「从节点开始执行」的起始节点 ID（[`lib/host/store.js:186`](../../lib/host/store.js#L186)） |
| `status` | 是 | 运行终态；节点 `status` 可能是 `not-run` |
| `stopMode` | 是 | `null` / `detach` / `cancel-tasks` |
| `error` | 是 | 截断 2000 字 |
| `nodes` | 是 | 每个节点保留 `id/title/type/status/sessionId/startedAt/endedAt/error/output`；`not-run` 节点的 `endedAt` 为 `null`、无 `sessionId`；`error` 截断 2000 字，`output` 截断 4000 字（[`lib/host/store.js:178`](../../lib/host/store.js#L178)） |
| `log` | 是 | 只保留最近 400 行 |
| `failureSeen`、`stopRequested`、`active`、节点 `summary` | 否 | 仅内存/接口快照使用 |

此外面板通过 `GET /api/run` 拿到的是 `publicRun()` 视图：补 `active = status === 'running'`，日志截最近 800 行（[`lib/host/engine.js:231`](../../lib/host/engine.js#L231)）。运行快照合并时只返回最近 10 条（[`lib/host/engine.js:253`](../../lib/host/engine.js#L253)）。

### 5.2 运行示例

```json
{
  "id": "run-1a2b3c4d",
  "workflowId": "wf-1a2b3c4d",
  "workflowName": "示例工作流",
  "startNodeId": null,
  "status": "completed",
  "stopMode": null,
  "startedAt": 1760000001000,
  "endedAt": 1760000009000,
  "error": null,
  "nodes": {
    "node-a": {
      "id": "node-a",
      "title": "任务 1",
      "type": "task",
      "status": "completed",
      "sessionId": "session-example",
      "startedAt": 1760000001000,
      "endedAt": 1760000008000,
      "error": null,
      "output": "报告要点如下……"
    },
    "gw-1": {
      "id": "gw-1",
      "title": "并行网关",
      "type": "parallel",
      "status": "completed",
      "sessionId": null,
      "startedAt": null,
      "endedAt": 1760000009000,
      "error": null,
      "output": null
    }
  },
  "log": [
    { "time": 1760000001000, "level": "info", "message": "工作流「示例工作流」开始执行（2 个节点）" },
    { "time": 1760000001000, "level": "info", "message": "任务「任务 1」开始执行", "nodeId": "node-a", "nodeTitle": "任务 1" }
  ]
}
```

「从节点开始执行」的记录把 `startNodeId` 设为起始节点 id，范围外节点状态为 `not-run`，日志第一条是范围说明：

```json
{
  "id": "run-1a2b3c4d",
  "startNodeId": "node-b",
  "status": "completed",
  "nodes": {
    "node-a": { "id": "node-a", "title": "任务 A", "type": "task", "status": "not-run", "sessionId": null, "startedAt": null, "endedAt": null, "error": null, "output": null },
    "node-b": { "id": "node-b", "title": "任务 B", "type": "task", "status": "completed", "sessionId": "session-example", "startedAt": 1760000001000, "endedAt": 1760000006000, "error": null, "output": "……" }
  },
  "log": [
    { "time": 1760000001000, "level": "info", "message": "从节点「任务 B」开始执行：跳过 1 个不在下游范围内的节点" }
  ]
}
```

## 6. 输入清洗

客户端提交的任何内容都视为不可信。`sanitizeWorkflow(input, previous)`（[`lib/host/store.js:139`](../../lib/host/store.js#L139)）是所有写入路径的统一入口：

- `POST /api/save` → `store.save(body.workflow)`；
- `POST /api/create` → 构造空工作流后 `store.save(...)`；
- `POST /api/run` 带 `workflow` 覆盖 → `engine.start()` 内 `store.save(workflowOverride)`；
- 进程启动加载文件 → 对每条 raw workflow 再跑一遍清洗（[`lib/host/store.js:220`](../../lib/host/store.js#L220)）。

因此**手工改坏 JSON 通常不会让插件崩溃**：越界坐标被 clamp、坏边被丢弃、重复 ID 被重生成、缺失名称被补默认值。`settings` 也一样：`defaultWorkspaceId` 只保留非空字符串，`workspaceColors` 只保留「非空工作区 ID → 合法十六进制颜色」的键值对，最多 40 项，非法项直接丢弃。

## 7. 容量上限

| 对象 | 上限 | 实现位置 | 超限行为 |
| --- | --- | --- | --- |
| 工作流 | 80 | [`lib/host/store.js:20`](../../lib/host/store.js#L20) | 保存时删最旧的；加载时只取前 80 个 |
| 每工作流节点 | 200 | [`lib/host/store.js:21`](../../lib/host/store.js#L21) | 超出节点被丢弃 |
| 每工作流连线 | 400 | [`lib/host/store.js:22`](../../lib/host/store.js#L22) | 超出边被丢弃 |
| 单节点提示词 | 200 000 字 | [`lib/host/store.js:23`](../../lib/host/store.js#L23) | 截断并补 `…` |
| 运行记录 | 20 | [`lib/host/store.js:24`](../../lib/host/store.js#L24) | 保存时删最旧的；加载时 `slice(-20)` |
| 工作区自定义颜色 | 40 | [`lib/host/store.js:25`](../../lib/host/store.js#L25) | 超出项被丢弃 |
| 持久化日志 | 400 行 | [`lib/host/store.js:193`](../../lib/host/store.js#L193) | `slice(-400)` |
| 内存日志 | 800 行 | [`lib/host/engine.js:35`](../../lib/host/engine.js#L35) | 追加后裁剪 |
| 接口返回的运行 | 10 条 | [`lib/host/engine.js:253`](../../lib/host/engine.js#L253) | `slice(-10)` |
| 单个错误/输出文本 | 2000 / 4000 字 | [`lib/host/store.js:178`](../../lib/host/store.js#L178) | 截断 |
| 请求体 | 2 MB | [`lib/host/routes.js:19`](../../lib/host/routes.js#L19) | 直接拒绝，返回 400 |

## 8. 原子写与并发

`persist()`（[`lib/host/store.js:311`](../../lib/host/store.js#L311)）的写入模型：

1. 调用时立刻 `JSON.stringify(this.state, null, 2)` 生成快照字符串；
2. 挂到 `writeChain`（一条串行 Promise 链）末尾，保证同一进程内写入顺序；
3. 链上依次 `mkdir` 目录 → 写 `${file}.tmp-${pid}` → `rename` 覆盖正式文件；
4. 任一步失败只记 `warn` 日志，链本身吞掉异常，后续写入继续。

```mermaid
flowchart LR
  A["save / recordRun / setActive"] --> B["persist 生成 JSON 快照"]
  B --> C["追加到 writeChain"]
  C --> D["mkdir 目录"]
  D --> E["写 workflows.json.tmp-PID"]
  E --> F["rename 为 workflows.json"]
  F --> G["请求方继续"]
  H["GET /api/state 或 /api/save"] --> I["store.ready 等首次 load"]
  I --> J["返回 deep clone 的 workflows / runs"]
  K["load 解析失败"] --> L["改名 .corrupt-时间戳"]
  L --> M["空状态继续启动"]
```

注意两点：

- 读取方拿到的都是 `cloneJson` 深拷贝（[`lib/host/store.js:250`](../../lib/host/store.js#L250)），修改返回值不会污染内存状态。
- 没有跨进程文件锁：两个 DSH 实例共享同一个 `DSH_HOME` 时是**最后写入者胜**。

## 9. 损坏文件处理

`load()` 的异常分支（[`lib/host/store.js:213`](../../lib/host/store.js#L213)）：

| 情况 | 行为 |
| --- | --- |
| 文件不存在（`ENOENT`） | 静默使用空状态，不告警 |
| JSON 解析失败 / 顶层不是对象 | 把文件改名为 `workflows.json.corrupt-<时间戳>` 留档，记一条 `warn`，然后用空状态启动 |
| 改名失败 | 忽略（best effort），仍然用空状态启动 |
| 字段缺失或类型错误 | 不视为损坏：逐字段清洗后继续 |

`activeWorkflowId` 在加载后还会再做一次引用校验，避免指向已删除的工作流。

## 10. 与界面/接口的对应关系

| 数据 | 面板读取方式 |
| --- | --- |
| 工作流列表、当前工作流、选项目录 | `GET /api/state` 一次性返回（[`lib/host/routes.js:50`](../../lib/host/routes.js#L50)） |
| 运行状态与日志 | 每 1000 ms `GET /api/run`（[数据流见架构](architecture.md#5-数据与控制流)） |
| 保存 | 画布编辑后 600 ms 防抖 `POST /api/save` |
| 新建/删除/切换 | `POST /api/create`、`/api/delete`、`/api/active` |

## 相关文档

- 调度如何消费这些字段：[执行引擎](execution-engine.md)
- 每个字段对应的接口：[HTTP API](http-api.md)
- 新增字段时要同步的文档：[开发环境](development.md#6-编码约定)
