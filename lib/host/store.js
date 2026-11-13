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

const STATE_VERSION = 1
const MAX_WORKFLOWS = 80
const MAX_NODES = 200
const MAX_EDGES = 400
const MAX_PROMPT_CHARS = 200_000
const MAX_RUNS = 20
const MAX_WORKSPACE_COLORS = 40
const MAX_CONTROL_REASON_CHARS = 500
const NODE_TYPES = new Set(['parallel', 'judge', 'terminate'])

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

/** Normalize one node of a workflow definition. */
function sanitizeNode(node, index, usedIds) {
  const source = node !== null && typeof node === 'object' ? node : {}
  let id = nonEmpty(source.id)
  if (id === undefined || usedIds.has(id)) id = newId('node')
  usedIds.add(id)
  const type = NODE_TYPES.has(source.type) ? source.type : 'task'
  const defaultTitle =
    type === 'parallel' ? '并行网关' : type === 'judge' ? '判断节点' : type === 'terminate' ? '终止节点' : `任务 ${index + 1}`
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
