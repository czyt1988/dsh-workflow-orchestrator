/**
 * The workflow execution engine.
 *
 * Semantics
 * ---------
 * A workflow is a directed acyclic graph of *task* nodes and *parallel
 * gateways*. A task node owns one real DSH session (one "task" in the
 * workspace) and starts when every incoming edge has settled:
 *
 *   - all predecessors completed  -> the task starts;
 *   - any predecessor did not complete (failed / cancelled / skipped)
 *                                 -> the task is skipped, which keeps cascading
 *                                    down the failing branch only;
 *   - unconnected nodes have no predecessors and therefore start together.
 *
 * A parallel gateway starts no session. It joins every incoming branch: it is
 * activated only after all of them completed, and then its outgoing branches
 * become ready. This is the only gateway kind the UI offers.
 *
 * Two control nodes can end a run early:
 *
 *   - judge:     owns one task session and evaluates its upstream output. The
 *                prompt carries a machine-readable verdict contract; a STOP
 *                verdict terminates the run;
 *   - terminate: owns no session; reaching it terminates the run.
 *
 * Early termination stops scheduling new nodes, marks every node that never
 * started as `skipped` with a termination reason, and closes the run as
 * `completed` unless a real failure had already happened. In-flight tasks keep
 * running by default; a node can opt into cancelling them instead.
 *
 * A run may also start at one node ("run from this node"): only that node and
 * its downstream descendants execute; every other node is settled as `not-run`
 * up front, is never waited for, and does not count as a failure.
 *
 * A task node is complete only when its session is quiescent: the turn that
 * produced the final answer is closed, the agent is idle, no background
 * subagent work can still join, and the session is not waiting on a human
 * answer (see `waitForTurn`). A preliminary reply that launches background
 * subagents and closes its turn is therefore not treated as the task's final
 * answer, and neither is a turn that closes while an `ask_user_question`
 * call is still pending: the node enters a "waiting for user" sub-state, the
 * machine-side timeouts stay suspended, and the user's later reply opens a
 * new turn whose outcome becomes the task's result.
 *
 * When a run starts, independent branches execute concurrently (bounded by
 * MAX_CONCURRENT_TASKS). A failure stops scheduling on the failing branch but
 * lets unrelated running branches finish. Stopping a run has two modes:
 *
 *   - "detach":      no new node starts; already running task sessions keep
 *                    running to completion (the run is reported cancelled);
 *   - "cancel-tasks": additionally cancel every running task's session.
 */
import { randomUUID } from 'node:crypto'
import { newId, truncate, errorMessage, cloneJson } from './util.js'

const MAX_LOG_LINES = 800
const MAX_CONCURRENT_TASKS = 8
const NODE_TIMEOUT_MS = 6 * 60 * 60 * 1000
const START_GRACE_MS = 8_000
const MAX_CONTEXT_OUTPUT_CHARS = 30_000
const MAX_WAITING_QUESTIONS = 10
const MAX_WAITING_QUESTION_CHARS = 500
const VERDICT_TOKEN = 'WOF_DECISION'
const VERDICT_CONTRACT = `\n\n---\n【判定输出要求】\n完成评估后，最后单独一行只输出 ${VERDICT_TOKEN}: CONTINUE（继续）或 ${VERDICT_TOKEN}: STOP（不再继续），不要输出其他内容。\n`
const TERMINATED_SKIP_REASON = '工作流已提前终止'

/** User-facing label for a node kind. */
function nodeKindLabel(node) {
  if (node?.type === 'judge') return '判断节点'
  if (node?.type === 'terminate') return '终止节点'
  if (node?.type === 'parallel') return '并行网关'
  return '任务'
}

/** Parse the last `WOF_DECISION: CONTINUE|STOP` verdict from model output. */
export function parseJudgeDecision(output) {
  if (typeof output !== 'string') return undefined
  let decision
  for (const match of output.matchAll(/WOF_DECISION\s*[:：]\s*(CONTINUE|STOP)\b/gi)) {
    decision = match[1].toUpperCase()
  }
  return decision
}

/** Build the adjacency maps of one workflow definition. */
export function buildGraph(workflow) {
  const nodeById = new Map()
  const predecessors = new Map()
  const successors = new Map()
  for (const node of workflow.nodes ?? []) {
    nodeById.set(node.id, node)
    predecessors.set(node.id, [])
    successors.set(node.id, [])
  }
  for (const edge of workflow.edges ?? []) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue
    successors.get(edge.from).push(edge.to)
    predecessors.get(edge.to).push(edge.from)
  }
  return { nodeById, predecessors, successors }
}

/** Every node reachable from `startNodeId` through outgoing edges, including itself. */
export function executionScope(workflow, startNodeId) {
  const graph = buildGraph(workflow)
  const scope = new Set()
  if (!graph.nodeById.has(startNodeId)) return scope
  scope.add(startNodeId)
  const queue = [startNodeId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const next of graph.successors.get(id) ?? []) {
      if (scope.has(next)) continue
      scope.add(next)
      queue.push(next)
    }
  }
  return scope
}

/** Validate one workflow before a run exists; returns human-readable problems. */
export function validateWorkflow(workflow, options = {}) {
  const problems = []
  if (!Array.isArray(workflow?.nodes) || workflow.nodes.length === 0) {
    problems.push('至少需要一个节点')
    return problems
  }
  const graph = buildGraph(workflow)
  const requestedStartNodeId = options?.startNodeId
  const startNodeId =
    typeof requestedStartNodeId === 'string' && requestedStartNodeId !== '' ? requestedStartNodeId : undefined
  if (startNodeId !== undefined && !graph.nodeById.has(startNodeId)) {
    problems.push(`起始节点不存在：${startNodeId}`)
    return problems
  }
  // A "run from this node" run only validates and executes the reachable subgraph.
  const scope = startNodeId === undefined ? undefined : executionScope(workflow, startNodeId)
  const inScope = (nodeId) => scope === undefined || scope.has(nodeId)
  for (const node of workflow.nodes) {
    if (!inScope(node.id)) continue
    const predecessors = (graph.predecessors.get(node.id) ?? []).filter((id) => inScope(id))
    const hasInput = startNodeId === node.id || predecessors.length > 0
    if (node.type === 'parallel') {
      const hasOutput = (graph.successors.get(node.id) ?? []).some((id) => inScope(id))
      if (!hasInput) problems.push(`并行网关「${node.title}」缺少输入连线`)
      if (!hasOutput) problems.push(`并行网关「${node.title}」缺少输出连线`)
    } else if (node.type === 'terminate') {
      if (!hasInput) problems.push(`终止节点「${node.title}」缺少输入连线`)
      if ((graph.successors.get(node.id) ?? []).length > 0) problems.push(`终止节点「${node.title}」不应有输出连线`)
    } else if (node.type === 'judge') {
      if (typeof node.task?.prompt !== 'string' || node.task.prompt.trim() === '') {
        problems.push(`判断节点「${node.title}」还没有填写提示词`)
      }
      if ((node.task?.contextMode ?? 'full') === 'none') {
        problems.push(`判断节点「${node.title}」的上游上下文不能选择「完全不传」`)
      }
      if (!hasInput) {
        problems.push(`判断节点「${node.title}」缺少输入连线`)
      } else if (
        node.id !== startNodeId &&
        !upstreamTaskNodes(workflow, node.id).some((upstream) => inScope(upstream.id))
      ) {
        problems.push(`判断节点「${node.title}」的上游没有可评估的任务`)
      }
    } else if (typeof node.task?.prompt !== 'string' || node.task.prompt.trim() === '') {
      problems.push(`任务「${node.title}」还没有填写提示词`)
    }
  }
  // Kahn topological pass over the in-scope subgraph: a leftover node means a cycle.
  const indegree = new Map()
  for (const node of workflow.nodes) {
    if (!inScope(node.id)) continue
    let degree = 0
    for (const previous of graph.predecessors.get(node.id) ?? []) if (inScope(previous)) degree += 1
    indegree.set(node.id, degree)
  }
  const queue = []
  for (const [id, degree] of indegree) if (degree === 0) queue.push(id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()
    visited += 1
    for (const next of graph.successors.get(id) ?? []) {
      if (!inScope(next)) continue
      const degree = (indegree.get(next) ?? 1) - 1
      indegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }
  if (visited !== indegree.size) problems.push('工作流中存在环路，无法执行')
  return problems
}

/** Nearest task ancestors, walking backwards through gateways and control nodes. */
export function upstreamTaskNodes(workflow, nodeId) {
  const graph = buildGraph(workflow)
  const found = new Set()
  const visitedControls = new Set()
  const visit = (id) => {
    for (const previous of graph.predecessors.get(id) ?? []) {
      const node = graph.nodeById.get(previous)
      if (node === undefined) continue
      if (node.type === 'parallel' || node.type === 'judge' || node.type === 'terminate') {
        if (visitedControls.has(node.id)) continue
        visitedControls.add(node.id)
        visit(node.id)
      } else {
        found.add(node.id)
      }
    }
  }
  visit(nodeId)
  return (workflow.nodes ?? []).filter((node) => found.has(node.id))
}

/** Compose the prompt a task session receives from its own prompt + upstream context. */
export function composePrompt(node, upstreamStates, mode) {
  const own = typeof node.task?.prompt === 'string' ? node.task.prompt.trim() : ''
  const contextMode = mode ?? node.task?.contextMode ?? 'full'
  if (contextMode === 'none' || upstreamStates.length === 0) return own
  const blocks = []
  for (const { node: upstreamNode, state } of upstreamStates) {
    const output = typeof state?.output === 'string' ? state.output : ''
    if (output.trim() === '') continue
    const sessionTag = state?.sessionId ? `（会话 ${state.sessionId}）` : ''
    if (contextMode === 'summary') {
      blocks.push(`- 任务「${upstreamNode.title}」已完成${sessionTag}。摘要：${truncate(output.trim(), 800)}`)
    } else {
      blocks.push(
        `### 任务「${upstreamNode.title}」${sessionTag}\n${truncate(output.trim(), MAX_CONTEXT_OUTPUT_CHARS)}`,
      )
    }
  }
  if (blocks.length === 0) return own
  const heading = contextMode === 'summary' ? '【上游任务会话摘要】' : '【上游任务输出】'
  return `${own}\n\n---\n${heading}\n${blocks.join('\n\n')}\n---\n`
}

/** Extract the final assistant text from a live session's derived history. */
export function lastAssistantText(session) {
  try {
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      const parts = []
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
      }
      if (parts.length > 0) return parts.join('\n')
    }
  } catch {
    /* a session mid-replacement may fail to derive; treat as no output */
  }
  return ''
}

/** Whether any turn closed after `startSeq`, without deriving messages. */
function hasClosedTurn(session, startSeq) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event?.seq !== 'number' || event.seq <= startSeq) break
    if (event.type === 'turn/end') return true
  }
  return false
}

/** Normalize one model-supplied question into the bounded waiting payload. */
function summarizeQuestion(question) {
  const result = {
    id: typeof question?.id === 'string' ? question.id : '',
    question: truncate(typeof question?.question === 'string' ? question.question : '', MAX_WAITING_QUESTION_CHARS),
  }
  if (typeof question?.header === 'string' && question.header !== '') result.header = truncate(question.header, 80)
  const options = Array.isArray(question?.options)
    ? question.options
        .map((option) => (typeof option?.label === 'string' ? option.label : ''))
        .filter((label) => label !== '')
    : []
  if (options.length > 0) result.options = options.slice(0, 8)
  if (question?.multi_select === true) result.multiSelect = true
  return result
}

/** Parse the question batch of one `ask_user_question` call's arguments. */
function parseAskQuestions(argumentsText) {
  let parsed
  try {
    parsed = JSON.parse(typeof argumentsText === 'string' ? argumentsText : '')
  } catch {
    return []
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  return questions.slice(0, MAX_WAITING_QUESTIONS).map(summarizeQuestion)
}

/**
 * Active rows of the host `userQuestions` session projection, when the
 * optional `sessionProjections` service and the projection are available.
 */
function projectedUserQuestions(projections, session) {
  try {
    const active = projections?.stateOf?.(session, 'userQuestions')?.questions?.active
    if (!Array.isArray(active)) return []
    return active
      .filter((row) => row !== null && typeof row === 'object' && typeof row.callId === 'string' && Array.isArray(row.questions))
      .slice(0, MAX_WAITING_QUESTIONS)
      .map((row) => ({
        callId: row.callId,
        state: row.state === 'continued' ? 'continued' : 'open',
        questions: row.questions.slice(0, MAX_WAITING_QUESTIONS).map(summarizeQuestion),
      }))
  } catch {
    return []
  }
}

/**
 * One backward pass over the session log tail after `startSeq`: whether a
 * turn closed, whether any `ask_user_question` call ever happened, and which
 * of those calls are still waiting for their tool result (the foreground
 * wait of a blocking or timed question).
 */
function scanTaskEvents(session, startSeq) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return { hasClosedTurn: false, sawAskCall: false, openAskCalls: new Map() }
  }
  let ended = false
  let sawAskCall = false
  const settled = new Set()
  const openAskCalls = new Map()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event?.seq !== 'number' || event.seq <= startSeq) break
    if (event.type === 'turn/end') ended = true
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
      if (typeof callId === 'string') settled.add(callId)
    } else if (event.type === 'tool/ptc-dispatch' && event.data?.name === 'ask_user_question') {
      if (typeof event.data.rootCallId === 'string') settled.add(event.data.rootCallId)
    } else if (event.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      sawAskCall = true
      const callId = event.data.callId
      if (typeof callId === 'string' && !settled.has(callId) && !openAskCalls.has(callId)) {
        openAskCalls.set(callId, parseAskQuestions(event.data.arguments))
      }
    }
  }
  return { hasClosedTurn: ended, sawAskCall, openAskCalls }
}

/**
 * Questions a task session is currently waiting on, if any.
 *
 * Two independent signals cover both host ask modes:
 *
 *  1. an `ask_user_question` call after `startSeq` without its tool result —
 *     the foreground wait, blocking (legacy) or timed;
 *  2. the host `userQuestions` session projection, which keeps timed
 *     questions answerable after their foreground wait expired.
 */
export function pendingUserQuestions(session, startSeq, projections) {
  return combineWaiting(scanTaskEvents(session, startSeq), projections, session)
}

/** Merge the scan's open ask calls with the projection's answerable rows. */
function combineWaiting(scan, projections, session) {
  const waiting = []
  for (const [callId, questions] of scan.openAskCalls) {
    waiting.push({ callId, state: 'open', questions })
  }
  for (const row of projectedUserQuestions(projections, session)) {
    if (scan.openAskCalls.has(row.callId)) continue
    waiting.push(row)
  }
  return waiting.slice(0, MAX_WAITING_QUESTIONS)
}

/** Read the last closed turn after `startSeq`, with its reason and final output. */
export function readTurnOutcome(session, startSeq) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  let endEvent
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event?.seq !== 'number' || event.seq <= startSeq) break
    if (event.type === 'turn/end') {
      endEvent = event
      break
    }
  }
  if (endEvent === undefined) return undefined
  const reason = endEvent.data?.reason ?? { kind: 'unknown' }
  let message = ''
  if (reason.kind === 'error') {
    const failure = reason.error
    message = typeof failure?.message === 'string' ? failure.message : JSON.stringify(failure ?? {})
    if (typeof failure?.code === 'string' && failure.code !== 'UNKNOWN') message = `${failure.code}: ${message}`
  } else if (reason.kind === 'aborted') {
    message = `已中止（${reason.reason?.kind ?? 'unknown'}）`
  } else if (reason.kind === 'blocked') {
    message = '该轮被拦截（会话已归档或未通过准入）'
  } else if (reason.kind !== 'completed') {
    message = `轮次结束原因：${reason.kind}`
  }
  return { reasonKind: reason.kind, message, output: lastAssistantText(session) }
}

/** The size-capped public view of one run. */
function publicRun(run, logLimit = MAX_LOG_LINES) {
  const copy = cloneJson({ ...run, log: (run.log ?? []).slice(-logLimit) })
  copy.active = run.status === 'running'
  return copy
}

/** Create one engine owned by the plugin fiber. */
export class WorkflowEngine {
  constructor(ctx, store, catalogs, options = {}) {
    this.ctx = ctx
    this.store = store
    this.catalogs = catalogs
    /** Test seam: replace the real DSH task executor. */
    this.executeTask = typeof options.executeTask === 'function' ? options.executeTask : (args) => this.executeTaskReal(args)
    this.active = new Map()
    this.latestByWorkflow = new Map()
    /** Per-node prompt-admission cancellation, keyed by node id. */
    this.promptSignals = new Map()
    this.disposed = false
  }

  /** Every run the panel may show: active ones plus each workflow's latest. */
  snapshotRuns() {
    const merged = new Map()
    for (const stored of this.store.runs()) merged.set(stored.id, stored)
    for (const run of this.latestByWorkflow.values()) merged.set(run.id, publicRun(run))
    for (const run of this.active.values()) merged.set(run.id, publicRun(run))
    return [...merged.values()]
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
      .slice(-10)
  }

  /** Lightweight engine status for the toolbar. */
  snapshot() {
    return {
      running: [...this.active.values()].map((run) => ({
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        startedAt: run.startedAt,
        status: run.status,
      })),
      runs: this.snapshotRuns(),
    }
  }

  /** Whether this workflow already has a live run. */
  runningFor(workflowId) {
    for (const run of this.active.values()) if (run.workflowId === workflowId) return run
    return undefined
  }

  /** Append one bounded log line to a run. */
  log(run, level, message, nodeId, nodeTitle) {
    const entry = { time: Date.now(), level, message }
    if (nodeId !== undefined && nodeId !== null) {
      entry.nodeId = nodeId
      entry.nodeTitle = nodeTitle
    }
    run.log.push(entry)
    if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES)
    const prefix = nodeTitle ? `[${run.workflowName}/${nodeTitle}] ` : `[${run.workflowName}] `
    if (level === 'error') this.ctx.logger?.warn?.(`workflow-orchestrator: ${prefix}${message}`)
    else this.ctx.logger?.info?.(`workflow-orchestrator: ${prefix}${message}`)
  }

  /** Start one run of a workflow (or of the submitted definition). */
  async start(workflowId, workflowOverride, options = {}) {
    await this.store.ready()
    let workflow = workflowOverride !== undefined ? this.store.save(workflowOverride) : this.store.get(workflowId)
    if (workflow === undefined) throw new Error('工作流不存在')
    const existing = this.runningFor(workflow.id)
    if (existing !== undefined) throw new Error(`该工作流正在运行（run ${existing.id}）`)
    const requestedStartNodeId = options?.startNodeId
    const startNodeId =
      typeof requestedStartNodeId === 'string' && requestedStartNodeId !== '' ? requestedStartNodeId : undefined
    const problems = validateWorkflow(workflow, { startNodeId })
    if (problems.length > 0) throw new Error(`工作流校验失败：${problems.join('；')}`)

    const run = {
      id: newId('run'),
      workflowId: workflow.id,
      workflowName: workflow.name,
      startNodeId: startNodeId ?? null,
      status: 'running',
      stopRequested: false,
      stopMode: null,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      failureSeen: false,
      terminated: false,
      terminatedBy: null,
      terminatedReason: null,
      terminatedAt: null,
      terminatedHadFailure: false,
      terminatedPolicy: null,
      nodes: {},
      log: [],
    }
    for (const node of workflow.nodes) {
      run.nodes[node.id] = {
        id: node.id,
        title: node.title,
        type: node.type,
        status: 'pending',
        sessionId: null,
        startedAt: null,
        endedAt: null,
        error: null,
        output: null,
        summary: null,
        decision: null,
        waitingForUser: null,
      }
    }
    this.active.set(run.id, run)
    this.latestByWorkflow.set(workflow.id, run)
    if (startNodeId === undefined) {
      this.log(run, 'info', `工作流「${workflow.name}」开始执行（${workflow.nodes.length} 个节点）`)
    } else {
      const scope = executionScope(workflow, startNodeId)
      const startNode = workflow.nodes.find((node) => node.id === startNodeId)
      this.log(
        run,
        'info',
        `从节点「${startNode?.title ?? startNodeId}」开始执行：跳过 ${workflow.nodes.length - scope.size} 个不在下游范围内的节点`,
      )
    }

    const catalogs = await this.catalogs.get().catch(() => undefined)
    this.schedule(run, workflow, catalogs, startNodeId).catch((error) => this.abortRun(run, error))
    return publicRun(run)
  }

  /** Request a stop. Returns the run snapshot. */
  stop(runId, { cancelTasks = false } = {}) {
    const run = runId === undefined || runId === null ? [...this.active.values()][0] : this.active.get(runId)
    if (run === undefined) throw new Error('没有正在运行的工作流')
    if (run.stopRequested) {
      return publicRun(run)
    }
    run.stopRequested = true
    run.stopMode = cancelTasks ? 'cancel-tasks' : 'detach'
    this.log(
      run,
      'warn',
      cancelTasks
        ? '收到终止请求：停止后续编排，并终止正在运行的任务会话'
        : '收到终止请求：停止后续编排，正在运行的任务继续执行',
    )
    if (cancelTasks) {
      for (const state of Object.values(run.nodes)) {
        if (state.status !== 'running') continue
        const controller = this.promptSignals.get(`${run.id}::${state.id}`)
        if (controller !== undefined) controller.abort()
        if (typeof state.sessionId !== 'string') continue
        try {
          this.ctx.sessionController.cancel({ sessionId: state.sessionId })
          this.log(run, 'warn', `已请求终止任务「${state.title}」的会话 ${state.sessionId}`, state.id, state.title)
        } catch (error) {
          this.log(run, 'error', `终止任务「${state.title}」失败：${errorMessage(error)}`, state.id, state.title)
        }
      }
    }
    return publicRun(run)
  }

  /** Best-effort cancellation during plugin unload. */
  dispose() {
    this.disposed = true
    for (const run of this.active.values()) {
      if (!run.stopRequested) {
        try {
          this.stop(run.id, { cancelTasks: true })
        } catch {
          /* the host is winding down */
        }
      }
    }
  }

  /** One run by id, from memory or durable history. */
  getRun(runId) {
    for (const run of this.active.values()) if (run.id === runId) return publicRun(run)
    for (const run of this.latestByWorkflow.values()) if (run.id === runId) return publicRun(run)
    const stored = this.store.runs().find((run) => run.id === runId)
    return stored === undefined ? undefined : { ...stored, active: false }
  }

  /** Unexpected scheduling failure: close the run as failed. */
  abortRun(run, error) {
    if (run.status !== 'running') return
    run.status = 'failed'
    run.endedAt = Date.now()
    run.error = errorMessage(error)
    this.log(run, 'error', `工作流执行异常：${run.error}`)
    try {
      this.store.recordRun(run)
    } catch {
      /* storage is best effort here */
    }
    this.active.delete(run.id)
  }

  /**
   * Terminate one run early: stop scheduling, skip unstarted nodes and,
   * according to the node policy, optionally cancel in-flight task sessions.
   */
  terminateRun(run, node, reason) {
    if (run.terminated) return
    run.terminated = true
    run.terminatedBy = { nodeId: node.id, title: node.title }
    run.terminatedReason = typeof reason === 'string' && reason !== '' ? reason : null
    run.terminatedAt = Date.now()
    run.terminatedHadFailure = run.failureSeen === true
    run.terminatedPolicy = node.control?.stopPolicy === 'cancel-tasks' ? 'cancel-tasks' : 'detach'
    this.log(
      run,
      'warn',
      `${nodeKindLabel(node)}「${node.title}」提前结束工作流${run.terminatedReason ? `：${run.terminatedReason}` : ''}`,
      node.id,
      node.title,
    )
    if (run.terminatedPolicy !== 'cancel-tasks') return
    for (const state of Object.values(run.nodes)) {
      if (state.status !== 'running') continue
      const controller = this.promptSignals.get(`${run.id}::${state.id}`)
      if (controller !== undefined) controller.abort()
      if (typeof state.sessionId !== 'string') continue
      try {
        this.ctx.sessionController.cancel({ sessionId: state.sessionId })
        this.log(run, 'warn', `已请求终止任务「${state.title}」的会话 ${state.sessionId}`, state.id, state.title)
      } catch (error) {
        this.log(run, 'error', `终止任务「${state.title}」失败：${errorMessage(error)}`, state.id, state.title)
      }
    }
  }

  /** Interpret one judge verdict, log it and terminate the run on STOP. */
  applyJudgeDecision(run, node, output) {
    const decision = parseJudgeDecision(output)
    const state = run.nodes[node.id]
    if (state !== undefined) state.decision = decision ?? null
    const fallback = node.control?.onInvalid === 'stop' ? 'STOP' : 'CONTINUE'
    const effective = decision ?? fallback
    if (decision === undefined) {
      this.log(
        run,
        'warn',
        `判断节点「${node.title}」输出中没有识别到 ${VERDICT_TOKEN} 判定，按默认「${effective === 'STOP' ? '终止' : '继续'}」处理`,
        node.id,
        node.title,
      )
    }
    this.log(
      run,
      'info',
      `判断节点「${node.title}」判定：${effective === 'STOP' ? '终止工作流' : '继续'}`,
      node.id,
      node.title,
    )
    if (effective === 'STOP') this.terminateRun(run, node, `判断节点「${node.title}」判定不再继续`)
  }

  /** Scheduling core: resolves after every node settled and the run is closed. */
  async schedule(run, workflow, catalogs, startNodeId) {
    const graph = buildGraph(workflow)
    const scope = startNodeId === undefined ? undefined : executionScope(workflow, startNodeId)
    const inScope = (id) => scope === undefined || scope.has(id)
    const statuses = new Map()
    const remaining = new Map()
    for (const node of workflow.nodes) {
      let degree = 0
      if (inScope(node.id)) {
        for (const previous of graph.predecessors.get(node.id) ?? []) if (inScope(previous)) degree += 1
      }
      remaining.set(node.id, degree)
    }
    const started = new Set()
    const running = new Set()
    let settled = 0
    // Out-of-scope nodes never execute. Settle them up front without going
    // through finishNode() so in-scope remaining counts stay exact.
    if (scope !== undefined) {
      for (const node of workflow.nodes) {
        if (inScope(node.id)) continue
        started.add(node.id)
        statuses.set(node.id, 'not-run')
        const state = run.nodes[node.id]
        if (state !== undefined) state.status = 'not-run'
        settled += 1
      }
    }
    let pumping = false
    let resolveDone
    const completion = new Promise((resolve) => {
      resolveDone = resolve
    })
    const checkDone = () => {
      if (settled >= workflow.nodes.length && running.size === 0) resolveDone()
    }

    const finishNode = (node, status, extra = {}) => {
      statuses.set(node.id, status)
      settled += 1
      const state = run.nodes[node.id]
      if (state === undefined) return
      state.status = status
      state.endedAt = Date.now()
      Object.assign(state, extra)
      for (const successor of graph.successors.get(node.id) ?? []) {
        if (!inScope(successor)) continue
        const left = remaining.get(successor)
        if (left !== undefined) remaining.set(successor, Math.max(0, left - 1))
      }
    }

    const settleSkipped = (node, reason) => {
      finishNode(node, 'skipped', { error: reason })
      this.log(run, 'warn', `${nodeKindLabel(node)}「${node.title}」已跳过：${reason}`, node.id, node.title)
    }

    const pump = () => {
      if (pumping) return
      pumping = true
      try {
        let progressed = true
        while (progressed) {
          progressed = false
          for (const node of workflow.nodes) {
            if (started.has(node.id)) continue
            if ((remaining.get(node.id) ?? 0) > 0) continue
            const predecessors = (graph.predecessors.get(node.id) ?? []).filter((id) => inScope(id))
            const predecessorStatuses = predecessors.map((id) => statuses.get(id))

            if (node.type === 'parallel') {
              started.add(node.id)
              if (predecessorStatuses.some((status) => status !== 'completed')) {
                finishNode(node, 'skipped', { error: '前序分支未成功，网关未激活' })
                this.log(run, 'warn', `并行网关「${node.title}」未激活：存在未完成的前序分支`, node.id, node.title)
              } else {
                finishNode(node, 'completed')
                this.log(run, 'info', `并行网关「${node.title}」已汇合（${predecessors.length} 条分支）`, node.id, node.title)
              }
              progressed = true
              continue
            }

            if (run.stopRequested) {
              started.add(node.id)
              finishNode(node, 'cancelled', { error: '工作流已终止，节点未启动' })
              this.log(run, 'warn', `${nodeKindLabel(node)}「${node.title}」未启动：工作流已终止`, node.id, node.title)
              progressed = true
              continue
            }
            if (run.terminated) {
              started.add(node.id)
              finishNode(node, 'skipped', { error: TERMINATED_SKIP_REASON })
              this.log(
                run,
                'info',
                `${nodeKindLabel(node)}「${node.title}」未执行：${TERMINATED_SKIP_REASON}`,
                node.id,
                node.title,
              )
              progressed = true
              continue
            }
            if (node.type === 'terminate') {
              started.add(node.id)
              if (predecessorStatuses.some((status) => status !== 'completed')) {
                finishNode(node, 'skipped', { error: '前序任务未成功完成' })
                this.log(run, 'warn', `终止节点「${node.title}」未激活：存在未完成的前序任务`, node.id, node.title)
              } else {
                finishNode(node, 'completed')
                this.terminateRun(run, node, node.control?.reason)
              }
              progressed = true
              continue
            }
            if (predecessorStatuses.some((status) => status !== 'completed')) {
              started.add(node.id)
              settleSkipped(node, '前序任务未成功完成')
              progressed = true
              continue
            }
            if (running.size >= MAX_CONCURRENT_TASKS) continue

            started.add(node.id)
            running.add(node.id)
            run.nodes[node.id].status = 'running'
            run.nodes[node.id].startedAt = Date.now()
            const upstream = this.upstreamStates(run, workflow, node)
            const kind = nodeKindLabel(node)
            this.log(run, 'info', `${kind}「${node.title}」开始执行`, node.id, node.title)
            Promise.resolve()
              .then(() => this.executeTask({ run, workflow, node, upstream, catalogs }))
              .then(
                (result) => {
                  running.delete(node.id)
                  const output = typeof result?.output === 'string' ? result.output : ''
                  finishNode(node, 'completed', {
                    sessionId: result?.sessionId ?? null,
                    output,
                    summary: typeof result?.summary === 'string' ? result.summary : truncate(output, 600),
                  })
                  if (node.type === 'judge') {
                    this.applyJudgeDecision(run, node, output)
                  } else {
                    this.log(
                      run,
                      'info',
                      `${kind}「${node.title}」完成${result?.sessionId ? `（会话 ${result.sessionId}）` : ''}`,
                      node.id,
                      node.title,
                    )
                  }
                },
                (error) => {
                  running.delete(node.id)
                  const cancelled =
                    (run.stopRequested && run.stopMode === 'cancel-tasks') ||
                    (run.terminated && run.terminatedPolicy === 'cancel-tasks')
                  if (!cancelled && !run.terminated) run.failureSeen = true
                  finishNode(node, cancelled ? 'cancelled' : 'failed', {
                    sessionId: error?.sessionId ?? run.nodes[node.id].sessionId ?? null,
                    error: errorMessage(error),
                  })
                  this.log(
                    run,
                    cancelled ? 'warn' : 'error',
                    `${kind}「${node.title}」${cancelled ? '已取消' : '执行失败'}：${errorMessage(error)}`,
                    node.id,
                    node.title,
                  )
                },
              )
              .then(() => {
                pump()
                checkDone()
              })
            progressed = true
          }
        }
      } finally {
        pumping = false
      }
      checkDone()
    }

    pump()
    await completion

    const states = Object.values(run.nodes)
    const failed = states.filter((state) => state.status === 'failed')
    const hasFailure = failed.length > 0 || run.failureSeen === true
    let status
    if (run.stopRequested) status = 'cancelled'
    else if (run.terminated) status = run.terminatedHadFailure ? 'failed' : 'completed'
    else if (hasFailure || states.some((state) => state.status === 'skipped')) status = 'failed'
    else status = 'completed'
    run.status = status
    run.endedAt = Date.now()
    if (status === 'failed') {
      run.error =
        failed.length > 0 ? failed.map((state) => `${state.title}: ${state.error ?? '失败'}`).join('；') : '工作流未完成'
    } else if (status === 'cancelled') {
      run.error = run.stopMode === 'cancel-tasks' ? '已终止（正在运行的任务已停止）' : '已停止（正在运行的任务继续执行）'
    } else if (run.terminated) {
      run.error = null
    }
    const terminatedNote = run.terminated
      ? `；已由「${run.terminatedBy?.title ?? '节点'}」提前结束${run.terminatedReason ? `（${run.terminatedReason}）` : ''}`
      : ''
    this.log(
      run,
      status === 'completed' ? 'info' : status === 'failed' ? 'error' : 'warn',
      status === 'completed'
        ? run.terminated
          ? `工作流提前结束：由「${run.terminatedBy?.title ?? '节点'}」触发${run.terminatedReason ? `（${run.terminatedReason}）` : ''}`
          : '工作流执行完成'
        : status === 'failed'
          ? `工作流执行失败：${run.error}${terminatedNote}`
          : `工作流已停止：${run.error}`,
    )
    try {
      this.store.recordRun(run)
    } catch {
      /* history is best effort */
    }
    this.active.delete(run.id)
  }

  /** Nearest completed task ancestors, for the downstream prompt context. */
  upstreamStates(run, workflow, node) {
    return upstreamTaskNodes(workflow, node.id)
      .map((upstream) => ({ node: upstream, state: run.nodes[upstream.id] }))
      .filter(({ state }) => state?.status === 'completed')
  }

  /**
   * The real task execution: create a session, apply permission/model, send the
   * prompt, then wait for its first turn to close and report the outcome.
   */
  async executeTaskReal({ run, workflow, node, upstream, catalogs }) {
    const ctx = this.ctx
    const task = node.task ?? {}
    const kind = nodeKindLabel(node)
    const optionCatalog = catalogs ?? (await this.catalogs.get().catch(() => undefined))
    const defaults = optionCatalog?.defaults ?? {}

    const createRequest = {}
    const workspaceId = task.workspaceId ?? workflow.settings?.defaultWorkspaceId ?? defaults.workspaceId
    if (typeof workspaceId === 'string' && workspaceId !== '') createRequest.workspaceId = workspaceId
    const agentPreset = task.agentPreset ?? defaults.agentPreset
    if (typeof agentPreset === 'string' && agentPreset !== '') createRequest.agentPreset = agentPreset

    const created = await ctx.sessionController.create(createRequest)
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('创建任务会话失败：未返回会话 ID')
    const state = run.nodes[node.id]
    if (state !== undefined) state.sessionId = sessionId
    this.log(run, 'info', `已为${kind}「${node.title}」创建会话 ${sessionId}`, node.id, node.title)

    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error(`会话 ${sessionId} 未就绪`)

    const permissionPreset = task.permissionPreset ?? defaults.permissionPreset
    if (typeof permissionPreset === 'string' && permissionPreset !== '') {
      try {
        const permissions = ctx.get('permissionPresets')
        if (typeof permissions?.set === 'function' && typeof permissions.resolve === 'function') {
          permissions.resolve(permissionPreset)
          permissions.set(session, permissionPreset)
        }
      } catch (error) {
        this.log(run, 'warn', `权限预设「${permissionPreset}」应用失败，沿用会话默认权限：${errorMessage(error)}`, node.id, node.title)
      }
    }

    const model = task.model ?? defaults.model
    if (model !== undefined && typeof model.provider === 'string' && typeof model.model === 'string') {
      try {
        const selection = { sessionId, provider: model.provider, model: model.model }
        if (typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '') selection.reasoningEffort = model.reasoningEffort
        await ctx.sessionController.selectModel(selection)
      } catch (error) {
        this.log(run, 'warn', `模型选择失败，沿用默认模型：${errorMessage(error)}`, node.id, node.title)
      }
    }

    const prompt = composePrompt(node, upstream) + (node.type === 'judge' ? VERDICT_CONTRACT : '')
    const startSeq = typeof session.seq === 'number' ? session.seq : 0
    // `prompt` requires an admission signal; aborting it only stops a prompt that
    // has not been admitted yet, and lets a cancel-tasks stop withdraw queued work.
    const promptController = new AbortController()
    this.promptSignals.set(`${run.id}::${node.id}`, promptController)
    try {
      await ctx.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        promptController.signal,
      )
    } finally {
      this.promptSignals.delete(`${run.id}::${node.id}`)
    }
    this.log(run, 'info', `${kind}「${node.title}」提示词已发送（${prompt.length} 字）`, node.id, node.title)

    const outcome = await this.waitForTurn(session, sessionId, startSeq, run, node)
    if (outcome.reasonKind !== 'completed') {
      const failure = new Error(`${kind}未成功完成：${outcome.message || outcome.reasonKind}`)
      failure.sessionId = sessionId
      throw failure
    }
    return { sessionId, output: outcome.output, summary: truncate(outcome.output, 600) }
  }

  /**
   * Wait until the task session reaches a stable, quiescent outcome.
   *
   * The first closed turn after `startSeq` does not prove the task finished: an
   * agent may launch background subagents, answer with a preliminary summary
   * and close its turn while those children still run. DSH then delivers a
   * settlement notice that opens a new turn, so completion follows the same
   * quiescence contract the headless host uses: the session must be idle,
   * `subagents.waitForChildren(agent)` must find no child work to join, and the
   * session sequence must not move while checking. The last closed turn after
   * `startSeq` then decides the outcome and supplies the final output.
   *
   * A closed turn is equally not final while the session waits on a human
   * answer: an `ask_user_question` call blocks its turn until answered, and a
   * timed question stays answerable after its foreground wait expired. While
   * any question is pending the node carries a `waitingForUser` payload, the
   * machine-side timeouts stay suspended, and the wait only settles after the
   * user's reply opened (and closed) a fresh turn.
   *
   * `subagents` and `sessionProjections` are optional host services: without
   * the former the wait degrades to the previous "first closed turn"
   * behavior, without the latter only the foreground wait of a question is
   * detected (a timed question that already expired its wait is not).
   */
  async waitForTurn(session, sessionId, startSeq, run, node) {
    return new Promise((resolve, reject) => {
      let finished = false
      let sawTurnStart = false
      let turnStartedAt = 0
      let checking = false
      let degradedLogged = false
      let projectionsLogged = false
      let waitingLogged = false
      let waitingSince = 0
      let off
      let timer
      const startedAt = Date.now()
      const outcomeNow = () => readTurnOutcome(session, startSeq)
      const subagents = () => (typeof this.ctx.get === 'function' ? this.ctx.get('subagents') : undefined)
      const projections = () => (typeof this.ctx.get === 'function' ? this.ctx.get('sessionProjections') : undefined)
      const hasNode = () => run !== undefined && run !== null && node !== undefined && node !== null
      /** Report once when child-work detection degrades; silence would hide the bug. */
      const logDegraded = (detail) => {
        if (degradedLogged) return
        degradedLogged = true
        if (run === undefined) return
        this.log(run, 'warn', `宿主子代理服务不可用，任务完成判定退回「第一个结束回合」：${detail}`)
      }
      /** Report once when a question was asked but the projection service is missing. */
      const logProjectionsDegraded = () => {
        if (projectionsLogged) return
        projectionsLogged = true
        if (!hasNode()) return
        this.log(
          run,
          'warn',
          `宿主会话投影服务不可用，${nodeKindLabel(node)}「${node.title}」无法感知超时后仍可回答的提问，可能在用户回答前结束`,
          node.id,
          node.title,
        )
      }
      /**
       * Refresh this node's waiting-for-user view: the pending question batch
       * on the run node state plus one log line per waiting episode.
       * @returns the questions the session is currently waiting on.
       */
      const refreshWaiting = () => {
        const scan = scanTaskEvents(session, startSeq)
        if (scan.sawAskCall && projections() === undefined) logProjectionsDegraded()
        const waiting = combineWaiting(scan, projections(), session)
        if (!hasNode()) return waiting
        const state = run.nodes[node.id]
        if (waiting.length > 0) {
          if (!waitingLogged) {
            waitingLogged = true
            waitingSince = Date.now()
            const first = waiting[0]?.questions?.[0]
            this.log(
              run,
              'info',
              `${nodeKindLabel(node)}「${node.title}」等待用户回复${first?.question ? `：${first.question}` : ''}`,
              node.id,
              node.title,
            )
          }
          if (state !== undefined) {
            state.waitingForUser = {
              since: waitingSince,
              questions: waiting.flatMap((row) => row.questions ?? []).slice(0, MAX_WAITING_QUESTIONS),
            }
          }
        } else if (waitingLogged) {
          waitingLogged = false
          if (state !== undefined) state.waitingForUser = null
          this.log(run, 'info', `${nodeKindLabel(node)}「${node.title}」的用户已回复，继续执行`, node.id, node.title)
        }
        return waiting
      }
      // Seed the per-turn clock from a turn/start that fired before this wait
      // registered its listener, so a fast first turn still gets the documented
      // per-turn timeout instead of only the global cap.
      try {
        for (const event of session.snapshotEvents()) {
          if (typeof event?.seq !== 'number' || event.seq <= startSeq) continue
          if (event.type !== 'turn/start') continue
          sawTurnStart = true
          turnStartedAt = typeof event.time === 'number' ? event.time : Date.now()
        }
      } catch {
        /* the poll fallback seeds the clock instead */
      }
      const finish = (callback, value) => {
        if (finished) return
        finished = true
        clearInterval(timer)
        if (hasNode()) {
          const state = run.nodes[node.id]
          if (state !== undefined) state.waitingForUser = null
        }
        try {
          off?.()
        } catch {
          /* listener already gone */
        }
        callback(value)
      }
      const lifecycleCancelled = () =>
        run !== undefined &&
        ((run.stopRequested === true && run.stopMode === 'cancel-tasks') ||
          (run.terminated === true && run.terminatedPolicy === 'cancel-tasks'))
      const stopSession = () => {
        const agent = this.ctx.agents.get(sessionId)
        try {
          this.ctx.sessionController.cancel({ sessionId })
        } catch {
          /* best effort */
        }
        const service = subagents()
        if (agent !== undefined && typeof service?.drainDescendants === 'function') {
          Promise.resolve()
            .then(() => service.drainDescendants([agent]))
            .catch(() => {})
        }
      }
      const cancelWait = () => {
        stopSession()
        finish(reject, new Error('任务已被终止'))
      }
      const checkCompletion = async () => {
        if (finished || checking) return
        const agent = this.ctx.agents.get(sessionId)
        if (agent !== undefined && agent.status !== 'idle') return
        const outcome = outcomeNow()
        if (outcome === undefined) return
        // A failed/aborted turn is final; do not keep waiting for child work
        // that the closed turn will no longer consume. Stop whatever it left
        // running so the failed node does not orphan background descendants.
        if (outcome.reasonKind !== 'completed') {
          stopSession()
          finish(resolve, outcome)
          return
        }
        // A completed turn is not final while the session still waits on the
        // user: the reply opens a new turn whose outcome must replace this
        // one, so keep waiting instead of settling with the interim reply.
        if (refreshWaiting().length > 0) return
        if (agent === undefined) {
          finish(resolve, outcome)
          return
        }
        const observedSeq = session.seq
        checking = true
        let joined = false
        try {
          const service = subagents()
          if (typeof service?.waitForChildren === 'function') joined = await service.waitForChildren(agent)
          else logDegraded('waitForChildren 缺失')
        } catch (error) {
          logDegraded(errorMessage(error))
          joined = false
        } finally {
          checking = false
        }
        if (finished) return
        // A cancel that landed while waitForChildren was pending must win over
        // a child settlement that happens to complete in the same poll window.
        if (lifecycleCancelled()) {
          cancelWait()
          return
        }
        const latest = outcomeNow()
        if (latest === undefined) return
        const live = this.ctx.agents.get(sessionId)
        if (live === undefined || (!joined && live.status === 'idle' && session.seq === observedSeq)) {
          finish(resolve, latest)
        }
      }
      off = this.ctx.on?.('session/event', (eventSession, event) => {
        if (eventSession?.id !== sessionId) return
        if (event?.type === 'turn/start') {
          sawTurnStart = true
          turnStartedAt = Date.now()
        }
        if (event?.type === 'turn/end' && typeof event.seq === 'number' && event.seq > startSeq) {
          void checkCompletion()
        }
      })
      timer = setInterval(() => {
        if (finished) return
        if (lifecycleCancelled()) {
          cancelWait()
          return
        }
        const agent = this.ctx.agents.get(sessionId)
        const idle = agent === undefined || agent.status !== 'running'
        if (!sawTurnStart && agent?.status === 'running') {
          sawTurnStart = true
          turnStartedAt = Date.now()
        }
        const waiting = refreshWaiting()
        const ended = hasClosedTurn(session, startSeq)
        if (!ended && !sawTurnStart && idle && Date.now() - startedAt > START_GRACE_MS) {
          finish(reject, new Error('任务未能开始执行：会话处于空闲状态且没有新的轮次'))
          return
        }
        if (ended) void checkCompletion()
        // While the session waits on the human, the machine-side timeouts
        // stay suspended: only an explicit stop can end the wait.
        if (waiting.length > 0) return
        if (sawTurnStart && idle && turnStartedAt > 0 && Date.now() - turnStartedAt > NODE_TIMEOUT_MS) {
          stopSession()
          finish(reject, new Error(`任务超时（超过 ${Math.round(NODE_TIMEOUT_MS / 60000)} 分钟），已请求终止`))
          return
        }
        if (Date.now() - startedAt > NODE_TIMEOUT_MS + START_GRACE_MS) {
          finish(reject, new Error('任务等待超时'))
        }
      }, 250)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}
