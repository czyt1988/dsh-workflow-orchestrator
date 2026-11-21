/**
 * Durable workflow storage.
 *
 * The canvas (workflow definitions) and the most recent run records live in one
 * lossless-JSON file under the DSH home so they survive a page refresh, an
 * application restart and a profile reload:
 *
 *   $DSH_HOME/workflow-orchestrator/workflows.json
 *
 * Writes are serialized through one promise chain and committed atomically
 * (temporary file + rename), so a concurrent read never observes a torn file
 * and a crash never leaves a half-written document behind.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { newId, clampNumber, nonEmpty, truncate, cloneJson } from './util.js'
import { TIMER_MODES, formatClockTime } from './recurrence.js'
import { ACTION_KINDS } from './actions.js'

const STATE_VERSION = 1
const MAX_WORKFLOWS = 80
const MAX_NODES = 200
const MAX_EDGES = 400
const MAX_PROMPT_CHARS = 200_000
const MAX_RUNS = 20
const MAX_WORKSPACE_COLORS = 40
const MAX_CONTROL_REASON_CHARS = 500
const MAX_ACTION_MESSAGE_CHARS = 200
const MAX_ACTION_TEXT_CHARS = 500
const MAX_ACTION_URL_CHARS = 2000
const MAX_ACTION_PATH_CHARS = 2000
const MAX_ACTION_COMMAND_CHARS = 2000
const MAX_ACTION_BODY_CHARS = 10_000
const MAX_WAIT_TARGETS = 30
const MAX_WAIT_TITLE_CHARS = 120
const MAX_TIMER_EPOCH_MS = 4_102_444_800_000 // 2100-01-01T00:00:00Z
const NODE_TYPES = new Set(['parallel', 'judge', 'terminate', 'timer', 'action', 'wait'])

/** Resolve the plugin's data file without depending on optional services. */
function resolveDataFile(ctx) {
  let home
  try {
    const dshHomePath = ctx.get('dshHomePath')
    if (typeof dshHomePath === 'function') home = dshHomePath()
  } catch {
    home = undefined
  }
  if (typeof home !== 'string' || home === '') {
    const configured = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : undefined
    home = configured ?? join(homedir(), '.dsh')
  }
  return join(home, 'workflow-orchestrator', 'workflows.json')
}

/** Normalize a model selection or drop it. */
function sanitizeModel(model) {
  if (model === null || typeof model !== 'object') return undefined
  const provider = nonEmpty(model.provider)
  const id = nonEmpty(model.model)
  if (provider === undefined || id === undefined) return undefined
  const result = { provider, model: id }
  const effort = nonEmpty(model.reasoningEffort)
  if (effort !== undefined) result.reasoningEffort = effort
  return result
}

/** Normalize a user-chosen workspace background color to lowercase #rrggbb. */
function sanitizeColor(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text)
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : undefined
}

/** Normalize the per-workflow workspace color overrides; invalid entries drop. */
function sanitizeWorkspaceColors(colors) {
  const result = {}
  if (colors === null || typeof colors !== 'object' || Array.isArray(colors)) return result
  for (const [key, value] of Object.entries(colors)) {
    if (Object.keys(result).length >= MAX_WORKSPACE_COLORS) break
    const workspaceId = nonEmpty(key)
    const color = sanitizeColor(value)
    if (workspaceId === undefined || color === undefined) continue
    result[workspaceId] = color
  }
  return result
}

/** Normalize one task node payload. */
function sanitizeTask(task) {
  const source = task !== null && typeof task === 'object' ? task : {}
  const contextMode = source.contextMode
  const payload = {
    prompt: typeof source.prompt === 'string' ? truncate(source.prompt, MAX_PROMPT_CHARS) : '',
    contextMode: contextMode === 'none' || contextMode === 'summary' ? contextMode : 'full',
  }
  const workspaceId = nonEmpty(source.workspaceId)
  if (workspaceId !== undefined) payload.workspaceId = workspaceId
  const agentPreset = nonEmpty(source.agentPreset)
  if (agentPreset !== undefined) payload.agentPreset = agentPreset
  const permissionPreset = nonEmpty(source.permissionPreset)
  if (permissionPreset !== undefined) payload.permissionPreset = permissionPreset
  const model = sanitizeModel(source.model)
  if (model !== undefined) payload.model = model
  return payload
}

/** Normalize the control payload of judge and terminate nodes. */
function sanitizeControl(control, type) {
  const source = control !== null && typeof control === 'object' ? control : {}
  const result = { stopPolicy: source.stopPolicy === 'cancel-tasks' ? 'cancel-tasks' : 'detach' }
  if (type === 'judge') result.onInvalid = source.onInvalid === 'stop' ? 'stop' : 'continue'
  if (typeof source.reason === 'string') {
    const reason = source.reason.trim()
    if (reason !== '') result.reason = truncate(reason, MAX_CONTROL_REASON_CHARS)
  }
  return result
}

/** Normalize the timer payload of a timer node. */
function sanitizeTimer(timer) {
  const source = timer !== null && typeof timer === 'object' ? timer : {}
  const mode = TIMER_MODES.includes(source.mode) ? source.mode : 'daily'
  if (mode === 'once') {
    const at = Number(source.at)
    if (!Number.isFinite(at) || at <= 0) return { mode }
    return { mode, at: Math.min(MAX_TIMER_EPOCH_MS, Math.round(at)) }
  }
  if (mode === 'weekly') {
    const weekdays = []
    if (Array.isArray(source.weekdays)) {
      for (const raw of source.weekdays) {
        const day = Number(raw)
        if (!Number.isInteger(day) || day < 1 || day > 7 || weekdays.includes(day)) continue
        weekdays.push(day)
        if (weekdays.length >= 7) break
      }
    }
    weekdays.sort((left, right) => left - right)
    return { mode, time: formatClockTime(source.time), weekdays }
  }
  if (mode === 'interval') {
    return { mode, intervalMinutes: Math.round(clampNumber(source.intervalMinutes, 1, 10_080, 60)) }
  }
  return { mode: 'daily', time: formatClockTime(source.time) }
}

/** Normalize the action payload of an action node. */
function sanitizeAction(action) {
  const source = action !== null && typeof action === 'object' ? action : {}
  const kind = ACTION_KINDS.includes(source.kind) ? source.kind : 'log'
  // Missing dryRun means "safe": only an explicit false enables a real side effect.
  const result = { kind, dryRun: source.dryRun !== false }
  if (kind === 'shutdown' || kind === 'restart') {
    result.delaySeconds = Math.round(clampNumber(source.delaySeconds, 10, 3600, 60))
  }
  if (kind === 'shutdown' || kind === 'restart') {
    const message = nonEmpty(source.message)
    if (message !== undefined) result.message = truncate(message.trim(), MAX_ACTION_MESSAGE_CHARS)
  }
  if (kind === 'log') {
    const text = nonEmpty(source.text)
    result.text = truncate(text === undefined ? '动作节点已执行' : text.trim(), MAX_ACTION_TEXT_CHARS)
  }
  if (kind === 'open-url' || kind === 'http-request') {
    const url = nonEmpty(source.url)
    if (url !== undefined) result.url = truncate(url.trim(), MAX_ACTION_URL_CHARS)
  }
  if (kind === 'http-request') {
    const method = typeof source.method === 'string' ? source.method.toUpperCase() : 'GET'
    result.method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'GET'
    const body = typeof source.body === 'string' ? source.body : ''
    if (body !== '') result.body = truncate(body, MAX_ACTION_BODY_CHARS)
  }
  if (kind === 'open-path') {
    const path = nonEmpty(source.path)
    if (path !== undefined) result.path = truncate(path.trim(), MAX_ACTION_PATH_CHARS)
  }
  if (kind === 'run-command') {
    const command = nonEmpty(source.command)
    if (command !== undefined) result.command = truncate(command.trim(), MAX_ACTION_COMMAND_CHARS)
    const cwd = nonEmpty(source.cwd)
    if (cwd !== undefined) result.cwd = truncate(cwd.trim(), MAX_ACTION_PATH_CHARS)
  }
  if (kind === 'run-command' || kind === 'http-request') {
    result.timeoutSeconds = Math.round(clampNumber(source.timeoutSeconds, 1, 600, 60))
  }
  return result
}

/** Normalize the wait payload of a wait node: unique non-empty target sessions. */
function sanitizeWait(wait) {
  const source = wait !== null && typeof wait === 'object' ? wait : {}
  const targets = []
  const seen = new Set()
  if (Array.isArray(source.targets)) {
    for (const row of source.targets) {
      const rawId = typeof row === 'string' ? row : row?.id
      const id = nonEmpty(rawId)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      const rawTitle = typeof row === 'string' ? row : row?.title
      const title = nonEmpty(rawTitle) ?? id
      targets.push({ id, title: truncate(title, MAX_WAIT_TITLE_CHARS) })
      if (targets.length >= MAX_WAIT_TARGETS) break
    }
  }
  return { targets }
}

/** Normalize one node of a workflow definition. */
function sanitizeNode(node, index, usedIds) {
  const source = node !== null && typeof node === 'object' ? node : {}
  let id = nonEmpty(source.id)
  if (id === undefined || usedIds.has(id)) id = newId('node')
  usedIds.add(id)
  const type = NODE_TYPES.has(source.type) ? source.type : 'task'
  const defaultTitle =
    type === 'parallel'
      ? '并行网关'
      : type === 'judge'
        ? '判断节点'
        : type === 'terminate'
          ? '终止节点'
          : type === 'timer'
            ? '定时节点'
            : type === 'action'
              ? '动作节点'
              : type === 'wait'
                ? '等待任务完成'
                : `任务 ${index + 1}`
  const title = nonEmpty(source.title) ?? defaultTitle
  const result = {
    id,
    type,
    title: truncate(title, 80),
    x: clampNumber(source.x, -20000, 20000, index * 240),
    y: clampNumber(source.y, -20000, 20000, 80),
  }
  if (type === 'task' || type === 'judge') result.task = sanitizeTask(source.task)
  if (type === 'judge' || type === 'terminate') result.control = sanitizeControl(source.control, type)
  if (type === 'timer') result.timer = sanitizeTimer(source.timer)
  if (type === 'action') result.action = sanitizeAction(source.action)
  if (type === 'wait') result.wait = sanitizeWait(source.wait)
  return result
}

/** Normalize edges: both endpoints must exist, no self edges, no duplicates. */
function sanitizeEdges(edges, nodeIds) {
  if (!Array.isArray(edges)) return []
  const seen = new Set()
  const result = []
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object') continue
    const from = nonEmpty(edge.from)
    const to = nonEmpty(edge.to)
    if (from === undefined || to === undefined) continue
    if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) continue
    const key = `${from}->${to}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ id: nonEmpty(edge.id) ?? newId('edge'), from, to })
    if (result.length >= MAX_EDGES) break
  }
  return result
}

/** Normalize a whole workflow definition coming from the client. */
export function sanitizeWorkflow(input, previous) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const now = Date.now()
  const nodes = []
  const usedIds = new Set()
  if (Array.isArray(source.nodes)) {
    for (const node of source.nodes.slice(0, MAX_NODES)) nodes.push(sanitizeNode(node, nodes.length, usedIds))
  }
  const edges = sanitizeEdges(source.edges, usedIds)
  const settings = source.settings !== null && typeof source.settings === 'object' ? source.settings : {}
  const defaultWorkspaceId = nonEmpty(settings.defaultWorkspaceId)
  const workspaceColors = sanitizeWorkspaceColors(settings.workspaceColors)
  const sanitizedSettings = {}
  if (defaultWorkspaceId !== undefined) sanitizedSettings.defaultWorkspaceId = defaultWorkspaceId
  if (Object.keys(workspaceColors).length > 0) sanitizedSettings.workspaceColors = workspaceColors
  const result = {
    id: nonEmpty(source.id) ?? nonEmpty(previous?.id) ?? newId('wf'),
    name: truncate(nonEmpty(source.name) ?? nonEmpty(previous?.name) ?? '未命名工作流', 120),
    createdAt: typeof previous?.createdAt === 'number' ? previous.createdAt : typeof source.createdAt === 'number' ? source.createdAt : now,
    updatedAt: now,
    nodes,
    edges,
    settings: sanitizedSettings,
  }
  return result
}

/** Compact the trigger metadata of one automatically started run. */
function compactTrigger(trigger) {
  if (trigger === null || typeof trigger !== 'object') return null
  if (trigger.kind !== 'timer') return null
  const nodeId = nonEmpty(trigger.nodeId)
  if (nodeId === undefined) return null
  return {
    kind: 'timer',
    nodeId,
    nodeTitle: nonEmpty(trigger.nodeTitle) ?? nodeId,
    scheduledAt: typeof trigger.scheduledAt === 'number' ? trigger.scheduledAt : null,
    mode: TIMER_MODES.includes(trigger.mode) ? trigger.mode : null,
  }
}

/** Compact one finished run for durable history. */
function compactRun(run) {
  const nodes = {}
  for (const [nodeId, state] of Object.entries(run.nodes ?? {})) {
    nodes[nodeId] = {
      id: state.id,
      title: state.title,
      type: state.type,
      status: state.status,
      sessionId: state.sessionId ?? null,
      startedAt: state.startedAt ?? null,
      endedAt: state.endedAt ?? null,
      error: state.error === null || state.error === undefined ? null : truncate(String(state.error), 2000),
      output: state.output === null || state.output === undefined ? null : truncate(String(state.output), 4000),
      decision: state.decision ?? null,
    }
  }
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    startNodeId: run.startNodeId ?? null,
    trigger: compactTrigger(run.trigger),
    status: run.status,
    stopMode: run.stopMode ?? null,
    terminated: run.terminated === true,
    terminatedBy: run.terminatedBy ?? null,
    terminatedReason: run.terminatedReason ? truncate(String(run.terminatedReason), 500) : null,
    terminatedAt: run.terminatedAt ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    error: run.error ? truncate(String(run.error), 2000) : null,
    nodes,
    log: Array.isArray(run.log) ? run.log.slice(-400) : [],
  }
}

/** One serialized, atomically written JSON state document. */
export class WorkflowStore {
  constructor(ctx) {
    this.ctx = ctx
    this.file = resolveDataFile(ctx)
    this.state = { version: STATE_VERSION, activeWorkflowId: null, workflows: [], runs: [] }
    this.writeChain = Promise.resolve()
    this.loaded = false
    this.loadPromise = this.load()
  }

  /** Wait for the initial read before serving a request. */
  async ready() {
    await this.loadPromise
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
      const workflows = []
      if (Array.isArray(parsed.workflows)) {
        for (const raw of parsed.workflows.slice(0, MAX_WORKFLOWS)) {
          const workflow = sanitizeWorkflow(raw, raw)
          workflow.createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : workflow.createdAt
          workflow.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : workflow.updatedAt
          workflows.push(workflow)
        }
      }
      const runs = Array.isArray(parsed.runs) ? parsed.runs.filter((run) => run && typeof run === 'object').slice(-MAX_RUNS) : []
      const activeWorkflowId =
        typeof parsed.activeWorkflowId === 'string' && workflows.some((workflow) => workflow.id === parsed.activeWorkflowId)
          ? parsed.activeWorkflowId
          : workflows[0]?.id ?? null
      this.state = { version: STATE_VERSION, activeWorkflowId, workflows, runs }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Keep the unreadable document for post-mortem inspection, then start clean.
        try {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
        } catch {
          /* best effort */
        }
        this.ctx.logger?.warn?.(`workflow-orchestrator: state file unreadable, starting fresh (${String(error?.message ?? error)})`)
      }
      this.state = { version: STATE_VERSION, activeWorkflowId: null, workflows: [], runs: [] }
    }
    this.loaded = true
  }

  /** Every workflow definition in document order (deep copies). */
  workflows() {
    return cloneJson(this.state.workflows)
  }

  /** One workflow or undefined. */
  get(workflowId) {
    const found = this.state.workflows.find((workflow) => workflow.id === workflowId)
    return found === undefined ? undefined : cloneJson(found)
  }

  get activeWorkflowId() {
    return this.state.activeWorkflowId
  }

  /** Remember which workflow the panel was last showing. */
  setActive(workflowId) {
    if (typeof workflowId !== 'string' || workflowId === '') return
    if (!this.state.workflows.some((workflow) => workflow.id === workflowId)) return
    this.state.activeWorkflowId = workflowId
    this.persist()
  }

  /** Insert or replace one workflow definition. */
  save(input) {
    const previous = input && typeof input.id === 'string' ? this.state.workflows.find((workflow) => workflow.id === input.id) : undefined
    const workflow = sanitizeWorkflow(input, previous)
    const index = this.state.workflows.findIndex((entry) => entry.id === workflow.id)
    if (index >= 0) this.state.workflows[index] = workflow
    else this.state.workflows.push(workflow)
    if (this.state.workflows.length > MAX_WORKFLOWS) this.state.workflows.splice(0, this.state.workflows.length - MAX_WORKFLOWS)
    if (this.state.activeWorkflowId === null) this.state.activeWorkflowId = workflow.id
    this.persist()
    return cloneJson(workflow)
  }

  /** Remove one workflow definition together with its durable run records. */
  remove(workflowId) {
    const index = this.state.workflows.findIndex((workflow) => workflow.id === workflowId)
    if (index < 0) return false
    this.state.workflows.splice(index, 1)
    this.state.runs = this.state.runs.filter((run) => run.workflowId !== workflowId)
    if (this.state.activeWorkflowId === workflowId) this.state.activeWorkflowId = this.state.workflows[0]?.id ?? null
    this.persist()
    return true
  }

  /** Append or replace the durable record of one finished run. */
  recordRun(run) {
    const compact = compactRun(run)
    const index = this.state.runs.findIndex((entry) => entry.id === compact.id)
    if (index >= 0) this.state.runs[index] = compact
    else this.state.runs.push(compact)
    if (this.state.runs.length > MAX_RUNS) this.state.runs.splice(0, this.state.runs.length - MAX_RUNS)
    this.persist()
  }

  /** Durable run history, newest last. */
  runs() {
    return cloneJson(this.state.runs)
  }

  /** Queue one atomic write; failures are logged, never thrown at callers. */
  persist() {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        const temporary = `${this.file}.tmp-${process.pid}`
        await writeFile(temporary, snapshot, 'utf8')
        await rename(temporary, this.file)
      })
      .catch((error) => {
        this.ctx.logger?.warn?.(`workflow-orchestrator: state write failed (${String(error?.message ?? error)})`)
      })
    return this.writeChain
  }
}
