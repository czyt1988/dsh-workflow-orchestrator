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
 *   - judge:     owns one task session and evaluates its upstream output;
 *   - terminate: owns no session; reaching it terminates the run.
 *
 * Three more control nodes shape *when* a run executes without owning a prompt:
 *
 *   - timer:   waits for its configured instant (or, as the workflow's entry
 *              node, is what the host scheduler auto-starts the whole workflow
 *              for) and then releases its successors;
 *   - action:  performs one OS/network side effect (auto shutdown, open a URL,
 *              run a command, send an HTTP request …) and then completes;
 *   - wait:    polls external DSH tasks until every selected task is really
 *              finished (idle agent, no joinable subagent work, no pending
 *              user question, stable session sequence) and then releases its
 *              successors, or fails when one of them failed.
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
import {
  describeTimer,
  formatDateTime,
  nextOccurrence,
  timerIsPeriodic,
  timerValidationProblems,
} from './recurrence.js'
import { actionValidationProblems, describeAction, executeActionReal } from './actions.js'

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
/** How often the host looks for due timer triggers. */
const SCHEDULER_INTERVAL_MS = 10_000
/** How often a wait node polls the tasks it waits for. */
const WAIT_NODE_POLL_MS = 10_000
/** A wait node gives up after this long, so a stuck task cannot pin a run forever. */
const WAIT_NODE_TIMEOUT_MS = 12 * 60 * 60 * 1000
/** A one-shot timer still fires when its instant was missed by at most this much. */
const ONE_SHOT_GRACE_MS = 10 * 60 * 1000
/** Long timer waits are re-evaluated in chunks so system clock changes apply. */
const TIMER_WAIT_CHUNK_MS = 60 * 60 * 1000
/** How many wait candidates the panel receives. */
const MAX_WAIT_CANDIDATES = 100

/** User-facing label for a node kind. */
function nodeKindLabel(node) {
  if (node?.type === 'judge') return '判断节点'
  if (node?.type === 'terminate') return '终止节点'
  if (node?.type === 'parallel') return '并行网关'
  if (node?.type === 'timer') return '定时节点'
  if (node?.type === 'action') return '动作节点'
  if (node?.type === 'wait') return '等待任务完成节点'
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

/**
 * Entry timer nodes: the timers the host scheduler may start the whole
 * workflow for. A timer deeper in the graph never starts a run by itself; it
 * only delays an already running one.
 * @param {object} workflow - workflow definition.
 * @returns {object[]} timer nodes with no incoming edges, in document order.
 */
export function rootTimerNodes(workflow) {
  const graph = buildGraph(workflow)
  return (workflow?.nodes ?? []).filter(
    (node) => node.type === 'timer' && (graph.predecessors.get(node.id) ?? []).length === 0,
  )
}

/**
 * Ask the optional host subagent service whether one agent's child work was
 * joined. Supports both the documented legacy `waitForChildren` name (returns
 * "child work still pending") and the current host's `waitForTreeWork` (which
 * awaits the join and returns "something was joined; re-check the root").
 * Either way a true result means the caller must re-check the session instead
 * of treating it as quiescent. A missing or throwing service degrades to
 * "nothing joined" and is reported so the caller can log once.
 * @param {object | undefined} service - `subagents` host service, when mounted.
 * @param {object | undefined} agent - exact live agent.
 * @returns {Promise<{ joinedWork: boolean, degraded?: string }>} join state.
 */
async function checkChildWork(service, agent) {
  if (service === null || service === undefined || agent === undefined) {
    return { joinedWork: false, degraded: 'subagents 服务不可用' }
  }
  const fn =
    typeof service.waitForChildren === 'function'
      ? service.waitForChildren
      : typeof service.waitForTreeWork === 'function'
        ? service.waitForTreeWork
        : undefined
  if (fn === undefined) return { joinedWork: false, degraded: 'waitForChildren / waitForTreeWork 缺失' }
  try {
    return { joinedWork: Boolean(await fn.call(service, agent)) }
  } catch (error) {
    return { joinedWork: false, degraded: errorMessage(error) }
  }
}

/** Resolve one optional service without letting a broken getter break the caller. */
function optionalService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Read one live session without letting a broken store break the caller. */
function liveSession(ctx, sessionId) {
  try {
    return ctx?.sessions?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/** Read one live agent without letting a broken registry break the caller. */
function liveAgent(ctx, sessionId) {
  try {
    return ctx?.agents?.get?.(sessionId)
  } catch {
    return undefined
  }
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
  const now = typeof options?.now === 'number' ? options.now : Date.now()
  const allowPastOnce = options?.allowPastOnce === true
  const allowPastOnceNodeIds = options?.allowPastOnceNodeIds
  for (const node of workflow.nodes) {
    if (!inScope(node.id)) continue
    const allowPastOnceHere = allowPastOnce || (allowPastOnceNodeIds instanceof Set && allowPastOnceNodeIds.has(node.id))
    const predecessors = (graph.predecessors.get(node.id) ?? []).filter((id) => inScope(id))
    const hasInput = startNodeId === node.id || predecessors.length > 0
    const hasOutput = (graph.successors.get(node.id) ?? []).some((id) => inScope(id))
    if (node.type === 'parallel') {
      if (!hasInput) problems.push(`并行网关「${node.title}」缺少输入连线`)
      if (!hasOutput) problems.push(`并行网关「${node.title}」缺少输出连线`)
    } else if (node.type === 'terminate') {
      if (!hasInput) problems.push(`终止节点「${node.title}」缺少输入连线`)
      if ((graph.successors.get(node.id) ?? []).length > 0) problems.push(`终止节点「${node.title}」不应有输出连线`)
    } else if (node.type === 'timer') {
      for (const problem of timerValidationProblems(node.timer, now, { allowPastOnce: allowPastOnceHere })) {
        problems.push(`定时节点「${node.title}」${problem}`)
      }
      if (!hasOutput) problems.push(`定时节点「${node.title}」缺少输出连线`)
    } else if (node.type === 'wait') {
      if (!Array.isArray(node.wait?.targets) || node.wait.targets.length === 0) {
        problems.push(`等待任务完成节点「${node.title}」还没有选择要等待的任务`)
      }
      if (!hasOutput) problems.push(`等待任务完成节点「${node.title}」缺少输出连线`)
    } else if (node.type === 'action') {
      for (const problem of actionValidationProblems(node.action)) {
        problems.push(`动作节点「${node.title}」${problem}`)
      }
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

/** Node kinds that shape execution without contributing prompt context. */
const TRANSPARENT_CONTROL_TYPES = new Set(['parallel', 'judge', 'terminate', 'timer', 'action', 'wait'])

/** Nearest task ancestors, walking backwards through gateways and control nodes. */
export function upstreamTaskNodes(workflow, nodeId) {
  const graph = buildGraph(workflow)
  const found = new Set()
  const visitedControls = new Set()
  const visit = (id) => {
    for (const previous of graph.predecessors.get(id) ?? []) {
      const node = graph.nodeById.get(previous)
      if (node === undefined) continue
      if (TRANSPARENT_CONTROL_TYPES.has(node.type)) {
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

/**
 * Whether a turn started after `startSeq` has not closed yet. Used by the wait
 * node so a session closing mid-turn is never treated as completed.
 * @param {object} session - live session.
 * @param {number} startSeq - exclusive lower event bound.
 * @returns {boolean} true when the newest relevant turn boundary is a start.
 */
function hasOpenTurn(session, startSeq) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event?.seq !== 'number' || event.seq <= startSeq) break
    if (event.type === 'turn/end') return false
    if (event.type === 'turn/start') return true
  }
  return false
}

/**
 * The reason kind of the last closed turn after `startSeq`, without deriving
 * messages. Cheap enough for the wait node's per-poll bookkeeping.
 * @param {object} session - live session.
 * @param {number} startSeq - exclusive lower event bound.
 * @returns {string | undefined} `turn/end` reason kind, or undefined.
 */
function lastTurnEndKind(session, startSeq) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event?.seq !== 'number' || event.seq <= startSeq) break
    if (event.type === 'turn/end') return event.data?.reason?.kind ?? 'unknown'
  }
  return undefined
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
    /** Test seam: replace the real action executor (never shut down the test host). */
    this.executeAction = typeof options.executeAction === 'function' ? options.executeAction : (args) => executeActionReal(args)
    /** Test seam: injected clock, defaults to the system clock. */
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** Wait-node poll interval; tests shorten it. */
    this.waitPollMs = Number.isFinite(options.waitPollMs) && options.waitPollMs > 0 ? options.waitPollMs : WAIT_NODE_POLL_MS
    this.active = new Map()
    this.latestByWorkflow = new Map()
    /** Per-node prompt-admission cancellation, keyed by node id. */
    this.promptSignals = new Map()
    /** Async control-node cancellation callbacks, keyed by run id then node id. */
    this.controlCancels = new Map()
    /** Last trigger instant per `workflowId::nodeId` for periodic timers. */
    this.lastFired = new Map()
    /** Workflow ids with an auto-start in flight. */
    this.startingWorkflows = new Set()
    /** One-shot timers already reported as missed, to avoid repeating the log. */
    this.missedOnceLogged = new Set()
    /** `key@scheduledAt` of due-but-skipped triggers already reported once. */
    this.schedulerSkipLogged = new Set()
    /** Wait nodes that already warned about a degraded subagent service. */
    this.missingSubagentsLogged = new Set()
    this.periodicSummary = { count: 0, onceCount: 0, workflows: [] }
    this.schedulerBase = this.now()
    this.ticking = false
    this.disposed = false
    this.schedulerTimer = null
    if (options.schedulerEnabled !== false) {
      const interval = Number.isFinite(options.schedulerIntervalMs) && options.schedulerIntervalMs > 0
        ? options.schedulerIntervalMs
        : SCHEDULER_INTERVAL_MS
      this.schedulerTimer = setInterval(() => {
        void this.tickSchedules()
      }, interval)
      if (typeof this.schedulerTimer.unref === 'function') this.schedulerTimer.unref()
      void this.tickSchedules()
    }
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
      periodic: this.periodicSummary,
    }
  }

  /** The cached scheduler summary refreshed by every scheduler tick. */
  schedulerSnapshot() {
    return this.periodicSummary
  }

  /** Recompute the scheduler summary without starting anything (panel banner route). */
  async refreshSchedulerSummary() {
    try {
      await this.store.ready()
      this.periodicSummary = this.buildScheduleState(this.now()).summary
    } catch {
      /* keep the previous summary on a transient store failure */
    }
  }

  /**
   * Whether one one-shot timer instant was already consumed by a recorded run.
   *
   * `lastFired` lives in memory; after a host restart it is empty. The durable
   * run history keeps `trigger.scheduledAt`, so a one-shot that already fired
   * just before a restart is not replayed inside the 10-minute catch-up window.
   * @param {string} workflowId - workflow owning the timer.
   * @param {string} nodeId - timer node id.
   * @param {number} scheduledAt - the planned instant.
   * @returns {boolean} true when history proves this instant already ran.
   */
  onceTriggeredInHistory(workflowId, nodeId, scheduledAt) {
    try {
      return this.store.runs().some(
        (run) =>
          run?.workflowId === workflowId &&
          run?.trigger?.kind === 'timer' &&
          run.trigger.nodeId === nodeId &&
          run.trigger.scheduledAt === scheduledAt,
      )
    } catch {
      return false
    }
  }

  /**
   * Compute the current timer schedule: which workflows auto-start, when their
   * next trigger is, and which triggers are due right now.
   *
   * Pure read of the store plus the in-memory last-fired table; the scheduler
   * tick performs the mutation (starting runs and recording fired instants).
   * @param {number} now - reference instant, normally the injected clock.
   * @returns {{ summary: object, due: object[] }} schedule state.
   */
  buildScheduleState(now = this.now()) {
    const summary = { count: 0, onceCount: 0, workflows: [], checkedAt: now }
    const due = []
    let workflows = []
    try {
      workflows = typeof this.store?.workflows === 'function' ? this.store.workflows() : []
    } catch {
      workflows = []
    }
    for (const workflow of workflows) {
      let roots
      try {
        roots = rootTimerNodes(workflow)
      } catch {
        continue
      }
      if (roots.length === 0) continue
      // The scheduler accepts a one-shot whose instant just passed, but only
      // for entry timers that are actually inside their catch-up window (and
      // not already consumed by a recorded run).
      const allowPastOnceNodeIds = new Set()
      for (const node of roots) {
        const timer = node.timer ?? {}
        if (timer.mode !== 'once' || !Number.isFinite(timer.at)) continue
        const key = `${workflow.id}::${node.id}`
        const last = this.lastFired.get(key)
        if (Number.isFinite(last) && last >= timer.at) continue
        if (this.onceTriggeredInHistory(workflow.id, node.id, timer.at)) continue
        const late = now - timer.at
        if (late > ONE_SHOT_GRACE_MS || timer.at < this.schedulerBase - ONE_SHOT_GRACE_MS) continue
        allowPastOnceNodeIds.add(node.id)
      }
      let problems = []
      try {
        problems = validateWorkflow(workflow, { now, allowPastOnceNodeIds })
      } catch {
        problems = ['工作流校验异常']
      }
      const valid = problems.length === 0
      let periodicWorkflow = false
      let onceArmed = false
      for (const node of roots) {
        const timer = node.timer ?? {}
        const key = `${workflow.id}::${node.id}`
        const entryBase = {
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: node.id,
          nodeTitle: node.title,
          mode: timer.mode ?? null,
          valid,
          problems: problems.slice(0, 3),
        }
        const last = this.lastFired.get(key)
        if (timerIsPeriodic(timer)) {
          periodicWorkflow = true
          const nextAt = nextOccurrence(timer, Number.isFinite(last) ? last : this.schedulerBase)
          summary.workflows.push({ ...entryBase, periodic: true, nextAt: Number.isFinite(nextAt) ? nextAt : null })
          if (Number.isFinite(nextAt) && nextAt <= now) {
            due.push({ key, workflow, node, mode: timer.mode, scheduledAt: nextAt, periodic: true, missed: false, valid, problems })
          }
          continue
        }
        const at = Number.isFinite(timer.at) ? timer.at : undefined
        if (at === undefined) {
          summary.workflows.push({ ...entryBase, periodic: false, nextAt: null })
          continue
        }
        if ((Number.isFinite(last) && last >= at) || this.onceTriggeredInHistory(workflow.id, node.id, at)) {
          summary.workflows.push({ ...entryBase, periodic: false, nextAt: null, fired: true })
          this.lastFired.set(key, at)
          continue
        }
        const late = now - at
        if (late > ONE_SHOT_GRACE_MS || at < this.schedulerBase - ONE_SHOT_GRACE_MS) {
          summary.workflows.push({ ...entryBase, periodic: false, nextAt: null, missed: true })
          due.push({ key, workflow, node, mode: 'once', scheduledAt: at, periodic: false, missed: true, valid, problems })
          continue
        }
        if (at > now) {
          onceArmed = true
          summary.workflows.push({ ...entryBase, periodic: false, nextAt: at })
          continue
        }
        summary.workflows.push({ ...entryBase, periodic: false, nextAt: at, due: true })
        due.push({ key, workflow, node, mode: 'once', scheduledAt: at, periodic: false, missed: false, valid, problems })
      }
      if (periodicWorkflow) summary.count += 1
      if (onceArmed) summary.onceCount += 1
    }
    summary.workflows = summary.workflows.slice(0, 30)
    return { summary, due }
  }

  /**
   * One scheduler tick: refresh the summary, then start one run per due timer.
   * A workflow already running keeps its single-run invariant; a periodic
   * occurrence that lands in that window is skipped (and recorded) instead of
   * queued, and a one-shot keeps retrying inside its 10-minute grace window.
   */
  async tickSchedules() {
    if (this.disposed || this.ticking) return
    this.ticking = true
    try {
      await this.store.ready()
      if (typeof this.store?.workflows !== 'function') return
      const now = this.now()
      // Bound the once-per-occurrence bookkeeping; it only exists to avoid
      // repeating a log line, so a full reset is harmless.
      if (this.schedulerSkipLogged.size > 600) this.schedulerSkipLogged.clear()
      if (this.missedOnceLogged.size > 600) this.missedOnceLogged.clear()
      const state = this.buildScheduleState(now)
      this.periodicSummary = state.summary
      const startedThisTick = new Set()
      for (const entry of state.due) {
        if (this.disposed) break
        const workflow = entry.workflow
        const key = entry.key
        if (entry.missed) {
          if (!this.missedOnceLogged.has(key)) {
            this.missedOnceLogged.add(key)
            this.ctx.logger?.warn?.(
              `workflow-orchestrator: 定时节点「${entry.node.title}」的一次性触发时间 ${formatDateTime(entry.scheduledAt)} 已错过，未自动触发（可在面板中改到未来时间，或从该定时节点的下游节点开始执行）`,
            )
          }
          this.lastFired.set(key, entry.scheduledAt)
          continue
        }
        if (!entry.valid) {
          // A workflow that cannot pass validation would fail its start every
          // period; advance the schedule and report the problem once instead.
          const marker = `${key}@${entry.scheduledAt}`
          if (!this.schedulerSkipLogged.has(marker)) {
            this.schedulerSkipLogged.add(marker)
            const detail = Array.isArray(entry.problems) && entry.problems.length > 0 ? `：${entry.problems.join('；')}` : ''
            this.ctx.logger?.warn?.(
              `workflow-orchestrator: 定时节点「${entry.node.title}」到点了，但工作流「${workflow.name}」校验未通过，本次未自动触发${detail}`,
            )
          }
          this.lastFired.set(key, entry.periodic ? Math.max(entry.scheduledAt, now) : entry.scheduledAt)
          continue
        }
        const running = this.runningFor(workflow.id) !== undefined || this.startingWorkflows.has(workflow.id)
        if (running) {
          // Another entry timer of this workflow already started a run in this
          // tick: every entry timer fired immediately inside that run, so this
          // one-shot occurrence is consumed too.
          if (!entry.periodic && startedThisTick.has(workflow.id)) {
            this.lastFired.set(key, entry.scheduledAt)
            continue
          }
          const marker = `${key}@${entry.scheduledAt}`
          if (!this.schedulerSkipLogged.has(marker)) {
            this.schedulerSkipLogged.add(marker)
            this.ctx.logger?.warn?.(
              `workflow-orchestrator: 定时节点「${entry.node.title}」到点了，但工作流「${workflow.name}」正在运行，本次触发已跳过`,
            )
          }
          // A periodic timer that was missed several times only catches up
          // once: jump its anchor to "now" so the next tick computes a future
          // instant instead of replaying every missed period.
          if (entry.periodic) this.lastFired.set(key, Math.max(entry.scheduledAt, now))
          continue
        }
        if (entry.periodic) this.lastFired.set(key, Math.max(entry.scheduledAt, now))
        const trigger = {
          kind: 'timer',
          nodeId: entry.node.id,
          nodeTitle: entry.node.title,
          mode: entry.mode,
          scheduledAt: entry.scheduledAt,
        }
        this.startingWorkflows.add(workflow.id)
        startedThisTick.add(workflow.id)
        void this.start(workflow.id, undefined, { trigger })
          .then(() => {
            // A one-shot is consumed only after a successful start; a failed
            // start keeps it retryable inside the catch-up window.
            if (!entry.periodic) this.lastFired.set(key, entry.scheduledAt)
            this.ctx.logger?.info?.(
              `workflow-orchestrator: 定时节点「${entry.node.title}」自动启动工作流「${workflow.name}」`,
            )
          })
          .catch((error) => {
            this.ctx.logger?.warn?.(
              `workflow-orchestrator: 定时启动工作流「${workflow.name}」失败（${
                entry.periodic ? '下个周期重试' : '将在宽限期内重试'
              }）：${errorMessage(error)}`,
            )
          })
          .finally(() => {
            this.startingWorkflows.delete(workflow.id)
          })
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`workflow-orchestrator: 定时调度失败：${errorMessage(error)}`)
    } finally {
      this.ticking = false
    }
  }

  /**
   * Running DSH tasks the wait node may target, for the inspector's checkbox
   * list. Live agents are the source of truth; the plugin's own task sessions
   * contribute their workflow/node titles, and subagent sessions are excluded.
   * @returns {Promise<object[]>} candidate tasks, running ones first.
   */
  async listWaitCandidates() {
    const candidates = new Map()
    const titleService = optionalService(this.ctx, 'sessionTitle')
    // Workflow-owned sessions get a human title from their node.
    const workflowTitles = new Map()
    for (const run of this.active.values()) {
      for (const state of Object.values(run.nodes ?? {})) {
        if (typeof state.sessionId !== 'string' || state.sessionId === '') continue
        if (state.status !== 'running' && state.status !== 'completed') continue
        workflowTitles.set(state.sessionId, `${run.workflowName} / ${state.title}`)
      }
    }
    let agents = []
    try {
      agents = typeof this.ctx?.agents?.list === 'function' ? this.ctx.agents.list() : []
    } catch {
      agents = []
    }
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') continue
      const session = agent.session
      const header = session?.header
      if (header !== null && typeof header === 'object') {
        if (header.origin === 'subagent') continue
        if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) continue
      }
      const sessionId = agent.id
      let title = workflowTitles.get(sessionId)
      if (title === undefined) {
        try {
          const snapshot = titleService?.get?.(session)
          if (typeof snapshot?.title === 'string' && snapshot.title !== '') title = snapshot.title
        } catch {
          /* optional service */
        }
      }
      if (title === undefined) title = sessionId
      const questions = session !== undefined ? pendingUserQuestions(session, -1, optionalService(this.ctx, 'sessionProjections')) : []
      const status = questions.length > 0 ? 'waiting-user' : agent.status === 'running' ? 'running' : 'idle'
      const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
      candidates.set(sessionId, {
        sessionId,
        title: truncate(String(title), 120),
        status,
        waitingQuestions: questions.length,
        cwd,
      })
    }
    // Fall back to workflow run nodes when the agents registry is unavailable.
    if (candidates.size === 0) {
      for (const run of this.active.values()) {
        for (const state of Object.values(run.nodes ?? {})) {
          if (state.status !== 'running' || typeof state.sessionId !== 'string' || state.sessionId === '') continue
          candidates.set(state.sessionId, {
            sessionId: state.sessionId,
            title: truncate(`${run.workflowName} / ${state.title}`, 120),
            status: 'running',
            waitingQuestions: 0,
            cwd: undefined,
            updatedAt: 0,
          })
        }
      }
    }
    const order = { running: 0, 'waiting-user': 1, idle: 2 }
    return [...candidates.values()]
      .sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9) || left.title.localeCompare(right.title))
      .slice(0, MAX_WAIT_CANDIDATES)
  }

  /**
   * Cancel every async control node waiting in one run. Timer and wait nodes
   * always abort (they would otherwise pin the run for hours after a stop);
   * an action node only aborts when the cancel-tasks policy is in effect.
   * @param {object} run - active run.
   * @param {'stop-detach'|'stop-cancel'|'terminate-detach'|'terminate-cancel'} reason - lifecycle cause.
   */
  cancelControlWaits(run, reason) {
    const map = this.controlCancels.get(run.id)
    if (map === undefined) return
    for (const [, entry] of [...map]) {
      try {
        entry.cancel(reason)
      } catch (error) {
        this.log(run, 'warn', `取消控制节点等待失败：${errorMessage(error)}`)
      }
    }
  }

  /** Drop per-run bookkeeping once the run closes. */
  cleanupRunBookkeeping(run) {
    this.controlCancels.delete(run.id)
    const prefix = `${run.id}::`
    for (const marker of this.missingSubagentsLogged) {
      if (marker.startsWith(prefix)) this.missingSubagentsLogged.delete(marker)
    }
  }

  /** Register one cancellable control-node wait. */
  registerControlCancel(run, nodeId, cancel) {
    let map = this.controlCancels.get(run.id)
    if (map === undefined) {
      map = new Map()
      this.controlCancels.set(run.id, map)
    }
    map.set(nodeId, { cancel })
  }

  /** Remove one control-node wait registration. */
  unregisterControlCancel(run, nodeId) {
    const map = this.controlCancels.get(run.id)
    if (map === undefined) return
    map.delete(nodeId)
    if (map.size === 0) this.controlCancels.delete(run.id)
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

  /** One awaited delay that also resolves early when the signal aborts. */
  delay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, Math.max(0, ms))
      if (typeof timer.unref === 'function') timer.unref()
      signal?.addEventListener?.('abort', finish, { once: true })
    })
  }

  /** Sleep until one wall-clock instant, re-reading the clock every hour. */
  async sleepUntil(target, signal) {
    for (;;) {
      if (signal?.aborted === true) throw new Error('等待已取消')
      const remaining = target - this.now()
      if (remaining <= 0) return
      await this.delay(Math.min(remaining, TIMER_WAIT_CHUNK_MS), signal)
    }
  }

  /**
   * Probe every not-yet-settled wait target exactly once.
   *
   * A target counts as finished only after two consecutive quiet polls with an
   * unchanged session sequence, mirroring the task-completion contract: the
   * agent must be idle, the optional subagent service must not find joinable
   * child work, and the session must not be waiting on a user answer. A failed
   * or aborted last turn fails the whole node immediately.
   * @param {object} run - active run.
   * @param {object} node - wait node definition.
   * @param {object[]} targets - mutable per-target state rows.
   * @param {Map<string, object>} quiet - per-target stability bookkeeping.
   * @param {AbortSignal} signal - wait cancellation signal.
   * @returns {Promise<object>} `{ allDone, failure? }`.
   */
  async evaluateWaitTargets(run, node, targets, quiet, signal) {
    if (signal?.aborted === true) return { allDone: false }
    const projections = optionalService(this.ctx, 'sessionProjections')
    const subagents = optionalService(this.ctx, 'subagents')
    for (const target of targets) {
      if (target.status !== 'waiting') continue
      if (signal?.aborted === true) return { allDone: false }
      const track = quiet.get(target.id) ?? {
        quiet: 0,
        seq: undefined,
        missing: 0,
        startSeq: undefined,
        lastTurnKind: undefined,
        everSeen: false,
      }
      const session = liveSession(this.ctx, target.id)
      const agent = liveAgent(this.ctx, target.id)
      if (session === undefined && agent === undefined) {
        track.missing += 1
        quiet.set(target.id, track)
        if (track.missing >= 2) {
          if (track.lastTurnKind === 'completed' && track.openTurn !== true) {
            target.status = 'completed'
            target.note = '任务会话已关闭（最后一次观测为完成）'
            this.log(run, 'info', `等待的任务「${target.title}」已结束（会话已关闭，最后一次观测为完成）`, node.id, node.title)
            continue
          }
          target.status = 'failed'
          target.note = '任务会话已关闭，无法确认任务已完成'
          return { allDone: false, failure: { title: target.title, message: target.note } }
        }
        continue
      }
      track.everSeen = true
      track.missing = 0
      if (track.startSeq === undefined) {
        // Watermark: only events after the moment this node first observed the
        // task decide its completion. This keeps the poll cheap on long logs
        // and ignores questions that were opened (and maybe expired) earlier.
        track.startSeq = typeof session?.seq === 'number' ? session.seq : -1
        // Seed the last observed outcome from history so a session that closes
        // before the first quiet poll can still be classified correctly.
        if (session !== undefined) {
          const history = readTurnOutcome(session, -1)
          if (history !== undefined) track.lastTurnKind = history.reasonKind
        }
      }
      if (session !== undefined) track.openTurn = hasOpenTurn(session, track.startSeq)
      const waitingQuestions = session !== undefined
        ? pendingUserQuestions(session, -1, projections).filter((row) => row.state === 'open')
        : []
      if (waitingQuestions.length > 0) {
        track.quiet = 0
        quiet.set(target.id, track)
        continue
      }
      if (agent !== undefined && agent.status !== 'idle') {
        track.quiet = 0
        quiet.set(target.id, track)
        continue
      }
      const child = agent === undefined ? { joinedWork: false } : await checkChildWork(subagents, agent)
      if (child.degraded !== undefined) {
        const marker = `${run.id}::${node.id}`
        if (!this.missingSubagentsLogged.has(marker)) {
          this.missingSubagentsLogged.add(marker)
          this.log(
            run,
            'warn',
            `宿主子代理服务不可用，等待任务完成节点无法确认任务是否仍在等待子 Agent：${child.degraded}`,
            node.id,
            node.title,
          )
        }
      }
      if (child.joinedWork) {
        // `waitForTreeWork()` returns true after it joined child work; the host
        // (and this poll) must re-check the session on the next round.
        track.quiet = 0
        quiet.set(target.id, track)
        continue
      }
      if (session !== undefined) {
        const kind = lastTurnEndKind(session, track.startSeq)
        if (kind !== undefined) track.lastTurnKind = kind
      }
      const seq = typeof session?.seq === 'number' ? session.seq : -1
      if (track.seq !== seq) {
        track.seq = seq
        track.quiet = 1
        quiet.set(target.id, track)
        continue
      }
      track.quiet += 1
      quiet.set(target.id, track)
      if (track.quiet < 2) continue
      const outcome = session !== undefined
        ? (readTurnOutcome(session, track.startSeq) ?? readTurnOutcome(session, -1))
        : undefined
      if (outcome === undefined) {
        // A selected task that never produced a closed turn cannot be proven
        // finished; fail after a bounded number of quiet polls instead of
        // silently releasing downstream nodes.
        if (track.quiet >= 6) {
          target.status = 'failed'
          target.note = '任务没有产生可确认的运行轮次'
          return { allDone: false, failure: { title: target.title, message: target.note } }
        }
        continue
      }
      if (outcome.reasonKind !== 'completed') {
        target.status = 'failed'
        target.note = outcome.message || outcome.reasonKind
        return { allDone: false, failure: { title: target.title, message: target.note } }
      }
      track.lastTurnKind = 'completed'
      target.status = 'completed'
      target.note = '已完成'
      this.log(
        run,
        'info',
        `等待的任务「${target.title}」已完成`,
        node.id,
        node.title,
      )
    }
    const allDone = targets.every((target) => target.status !== 'waiting')
    if (!allDone) return { allDone: false }
    const failed = targets.find((target) => target.status === 'failed')
    return failed === undefined ? { allDone: true } : { allDone: false, failure: { title: failed.title, message: failed.note } }
  }

  /** Normalize the trigger metadata of an automatically started run. */
  normalizeTrigger(trigger) {
    if (trigger === null || typeof trigger !== 'object') return null
    if (trigger.kind !== 'timer' || typeof trigger.nodeId !== 'string' || trigger.nodeId === '') return null
    return {
      kind: 'timer',
      nodeId: trigger.nodeId,
      nodeTitle: typeof trigger.nodeTitle === 'string' && trigger.nodeTitle !== '' ? trigger.nodeTitle : trigger.nodeId,
      mode: typeof trigger.mode === 'string' ? trigger.mode : null,
      scheduledAt: Number.isFinite(trigger.scheduledAt) ? trigger.scheduledAt : null,
    }
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
    const problems = validateWorkflow(workflow, {
      startNodeId,
      now: this.now(),
      // A scheduler-triggered run may execute entry one-shot timers that just
      // entered their catch-up window; anything further in the past still
      // fails validation (manual runs always validate strictly).
      allowPastOnceNodeIds:
        options?.trigger?.kind === 'timer'
          ? new Set(
              rootTimerNodes(workflow)
                .filter((node) => Number.isFinite(node.timer?.at))
                .filter((node) => node.timer.at >= this.now() - ONE_SHOT_GRACE_MS)
                .map((node) => node.id),
            )
          : undefined,
    })
    if (problems.length > 0) throw new Error(`工作流校验失败：${problems.join('；')}`)

    const run = {
      id: newId('run'),
      workflowId: workflow.id,
      workflowName: workflow.name,
      startNodeId: startNodeId ?? null,
      trigger: this.normalizeTrigger(options?.trigger),
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
    if (run.trigger !== null) {
      this.log(
        run,
        'info',
        `本次运行由定时节点「${run.trigger.nodeTitle}」自动触发（计划时间 ${
          run.trigger.scheduledAt === null ? '未知' : formatDateTime(run.trigger.scheduledAt)
        }）`,
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
    // Async control waits cannot outlive the stop: a timer would otherwise pin
    // the run until its next instant, and a wait node would keep polling.
    this.cancelControlWaits(run, cancelTasks ? 'stop-cancel' : 'stop-detach')
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
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
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
    this.cleanupRunBookkeeping(run)
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
    // Pending timer/wait control nodes are settled as skipped so the run can
    // close right away instead of waiting for a future instant.
    this.cancelControlWaits(run, run.terminatedPolicy === 'cancel-tasks' ? 'terminate-cancel' : 'terminate-detach')
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

    /**
     * Register one async control node (timer / wait / action) and return its
     * guarded settle function. The guard makes the settle and the cancellation
     * path mutually exclusive, so a stop that lands while an async completion
     * is resolving still closes the node exactly once.
     */
    const registerControlWait = (node, onCancel) => {
      let done = false
      const settle = (status, extra = {}) => {
        if (done) return false
        done = true
        this.unregisterControlCancel(run, node.id)
        finishNode(node, status, extra)
        pump()
        checkDone()
        return true
      }
      this.registerControlCancel(run, node.id, (reason) => {
        if (done) return
        onCancel(reason, settle)
      })
      return settle
    }

    /** Start one timer node; returns true when it completed synchronously. */
    const startTimerNode = (node) => {
      const timer = node.timer ?? {}
      const state = run.nodes[node.id]
      const now = this.now()
      const root = (graph.predecessors.get(node.id) ?? []).length === 0
      const nextAt = root ? now : nextOccurrence(timer, now)
      const fireAt = Number.isFinite(nextAt) ? Math.max(now, nextAt) : now
      state.status = 'running'
      state.startedAt = Date.now()
      if (root || fireAt <= now) {
        const reason = root
          ? run.trigger?.kind === 'timer'
            ? run.trigger.nodeId === node.id
              ? `由计划时间 ${run.trigger.scheduledAt === null ? '' : formatDateTime(run.trigger.scheduledAt)} 自动触发`
              : '同一次定时调度中的其它入口定时节点，立即触发'
            : '起始节点立即触发（手动执行）'
          : '计划的触发时间已到'
        state.timerState = { mode: timer.mode ?? 'once', waitUntil: null, firedAt: now }
        finishNode(node, 'completed', { timerState: state.timerState })
        this.log(run, 'info', `定时节点「${node.title}」触发：${reason}（${describeTimer(timer)}）`, node.id, node.title)
        return true
      }
      const controller = new AbortController()
      const settle = registerControlWait(node, (reason, done) => {
        controller.abort()
        const stopped = reason.startsWith('stop')
        const status = stopped ? 'cancelled' : 'skipped'
        const error = stopped ? '工作流已终止，定时等待已取消' : TERMINATED_SKIP_REASON
        state.timerState = { mode: timer.mode ?? 'once', waitUntil: fireAt, firedAt: null }
        done(status, { error, timerState: state.timerState })
        this.log(run, 'warn', `定时节点「${node.title}」的等待已取消`, node.id, node.title)
      })
      state.timerState = { mode: timer.mode ?? 'once', waitUntil: fireAt, firedAt: null }
      this.log(
        run,
        'info',
        `定时节点「${node.title}」开始等待：将在 ${formatDateTime(fireAt)} 触发（${describeTimer(timer)}）`,
        node.id,
        node.title,
      )
      void (async () => {
        try {
          await this.sleepUntil(fireAt, controller.signal)
        } catch {
          return
        }
        if (controller.signal.aborted) return
        const firedAt = this.now()
        const closed = settle('completed', {
          timerState: { mode: timer.mode ?? 'once', waitUntil: fireAt, firedAt },
        })
        if (closed) this.log(run, 'info', `定时节点「${node.title}」触发：已到计划时间（${describeTimer(timer)}）`, node.id, node.title)
      })()
      return false
    }

    /** Start one action node; the injected executor owns the real side effect. */
    const startActionNode = (node) => {
      const action = node.action ?? {}
      const state = run.nodes[node.id]
      state.status = 'running'
      state.startedAt = Date.now()
      state.actionState = { kind: action.kind ?? 'log', dryRun: action.dryRun !== false }
      const controller = new AbortController()
      const settle = registerControlWait(node, (reason, done) => {
        // A "detach" stop lets an in-flight action finish; only cancel-tasks aborts it.
        if (!reason.endsWith('cancel')) return
        controller.abort()
        done('cancelled', { error: '工作流已终止，动作执行已取消' })
        this.log(run, 'warn', `动作节点「${node.title}」的动作已取消`, node.id, node.title)
      })
      this.log(
        run,
        'info',
        `动作节点「${node.title}」开始执行：${describeAction(action)}${action.dryRun !== false ? '（试运行，不会产生实际动作）' : ''}`,
        node.id,
        node.title,
      )
      Promise.resolve()
        .then(() => this.executeAction({ run, workflow, node, action, signal: controller.signal }))
        .then(
          (result) => {
            const summary = typeof result?.summary === 'string' && result.summary !== '' ? result.summary : '动作已执行'
            const closed = settle('completed', {
              output: summary,
              summary: truncate(summary, 600),
              actionState: { ...state.actionState, result: summary },
            })
            if (closed) this.log(run, 'info', `动作节点「${node.title}」执行完成：${summary}`, node.id, node.title)
          },
          (error) => {
            const cancelled =
              controller.signal.aborted ||
              (run.stopRequested === true && run.stopMode === 'cancel-tasks') ||
              (run.terminated === true && run.terminatedPolicy === 'cancel-tasks')
            if (!cancelled && !run.terminated) run.failureSeen = true
            const closed = settle(cancelled ? 'cancelled' : 'failed', { error: errorMessage(error) })
            if (closed) {
              this.log(
                run,
                cancelled ? 'warn' : 'error',
                `动作节点「${node.title}」${cancelled ? '已取消' : '执行失败'}：${errorMessage(error)}`,
                node.id,
                node.title,
              )
            }
          },
        )
    }

    /** Start one wait node: it polls external DSH tasks until they really finished. */
    const startWaitNode = (node) => {
      const configured = Array.isArray(node.wait?.targets) ? node.wait.targets : []
      const targets = configured.map((target) => ({
        id: String(target.id),
        title: typeof target.title === 'string' && target.title !== '' ? target.title : String(target.id),
        status: 'waiting',
        note: null,
      }))
      const state = run.nodes[node.id]
      state.status = 'running'
      state.startedAt = Date.now()
      state.waitState = { targets: targets.map((target) => ({ ...target })), waiting: targets.length, lastPollAt: null, polls: 0 }
      const quiet = new Map()
      const controller = new AbortController()
      const settle = registerControlWait(node, (reason, done) => {
        controller.abort()
        const stopped = reason.startsWith('stop')
        done(stopped ? 'cancelled' : 'skipped', {
          error: stopped ? '工作流已终止，等待任务已取消' : TERMINATED_SKIP_REASON,
          waitState: { ...state.waitState, lastPollAt: this.now() },
        })
        this.log(run, 'warn', `等待任务完成节点「${node.title}」已取消等待`, node.id, node.title)
      })
      this.log(
        run,
        'info',
        `等待任务完成节点「${node.title}」开始等待 ${targets.length} 个任务：${targets.map((target) => `「${target.title}」`).join('、')}（每 ${Math.round(this.waitPollMs / 1000)} 秒检查一次）`,
        node.id,
        node.title,
      )
      void (async () => {
        const startedAt = this.now()
        let polls = 0
        try {
          while (!controller.signal.aborted) {
            polls += 1
            const verdict = await this.evaluateWaitTargets(run, node, targets, quiet, controller.signal)
            if (controller.signal.aborted) return
            state.waitState = {
              targets: targets.map((target) => ({ ...target })),
              waiting: targets.filter((target) => target.status === 'waiting').length,
              lastPollAt: this.now(),
              polls,
            }
            if (verdict.failure !== undefined) {
              if (!run.terminated) run.failureSeen = true
              settle('failed', {
                error: `等待的任务「${verdict.failure.title}」未成功完成：${verdict.failure.message}`,
                waitState: state.waitState,
              })
              this.log(
                run,
                'error',
                `等待任务完成节点「${node.title}」失败：等待的任务「${verdict.failure.title}」未成功完成`,
                node.id,
                node.title,
              )
              return
            }
            if (verdict.allDone) {
              const names = targets.map((target) => `「${target.title}」`).join('、')
              const output = `等待的任务均已完成：${names}`
              settle('completed', { output, summary: truncate(output, 600), waitState: state.waitState })
              this.log(run, 'info', `等待任务完成节点「${node.title}」完成：${names}均已结束`, node.id, node.title)
              return
            }
            if (this.now() - startedAt > WAIT_NODE_TIMEOUT_MS) {
              if (!run.terminated) run.failureSeen = true
              settle('failed', { error: `等待超时（超过 ${Math.round(WAIT_NODE_TIMEOUT_MS / 3600000)} 小时），等待的任务仍未完成`, waitState: state.waitState })
              this.log(run, 'error', `等待任务完成节点「${node.title}」等待超时`, node.id, node.title)
              return
            }
            if (polls > 1 && polls % 30 === 0) {
              const waiting = targets.filter((target) => target.status === 'waiting')
              this.log(
                run,
                'info',
                `等待任务完成节点「${node.title}」仍在等待 ${waiting.length} 个任务：${waiting.map((target) => `「${target.title}」`).join('、')}`,
                node.id,
                node.title,
              )
            }
            await this.delay(this.waitPollMs, controller.signal)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          if (!run.terminated) run.failureSeen = true
          settle('failed', { error: `等待任务时出错：${errorMessage(error)}` })
          this.log(run, 'error', `等待任务完成节点「${node.title}」出错：${errorMessage(error)}`, node.id, node.title)
        }
      })()
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
            if (node.type === 'timer' || node.type === 'action' || node.type === 'wait') {
              started.add(node.id)
              if (node.type === 'timer') {
                startTimerNode(node)
              } else if (node.type === 'action') {
                startActionNode(node)
              } else {
                startWaitNode(node)
              }
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
    this.cleanupRunBookkeeping(run)

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
          // Accept both host APIs: the documented waitForChildren() and the
          // current host's waitForTreeWork(). A blocking waitForTreeWork returns
          // only after the children settle, so one extra completion check follows.
          const child = await checkChildWork(subagents(), agent)
          joined = child.joinedWork
          if (child.degraded !== undefined) logDegraded(child.degraded)
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
