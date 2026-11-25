/**
 * Scheduling tests for the workflow engine, using the executor test seam so no
 * DSH host is needed: the graph semantics (parallel start, sequential edges,
 * gateway join, failure cascade, the two stop modes) are what is verified.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowEngine, validateWorkflow, composePrompt, upstreamTaskNodes, parseJudgeDecision, pendingUserQuestions, rootTimerNodes } from '../lib/host/engine.js'
import {
  nextOccurrence,
  describeTimer,
  formatDateTime,
  timerIsPeriodic,
  timerValidationProblems,
} from '../lib/host/recurrence.js'
import { actionValidationProblems, describeAction, executeActionReal } from '../lib/host/actions.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = check()
    if (value) return value
    await delay(5)
  }
  throw new Error('condition not reached in time')
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness({ executeTask }) {
  const recorded = []
  const cancels = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'dshHomePath') return () => '.'
      return undefined
    },
    sessionController: {
      cancel(payload) {
        cancels.push(payload.sessionId)
        return { accepted: true }
      },
    },
  }
  const store = {
    runs() {
      return recorded.slice()
    },
    recordRun(run) {
      recorded.push(run)
    },
    ready() {
      return Promise.resolve()
    },
    get() {
      return undefined
    },
    save(workflow) {
      return workflow
    },
  }
  const catalogs = {
    async get() {
      return { defaults: {} }
    },
  }
  const engine = new WorkflowEngine(ctx, store, catalogs, { executeTask })
  return { engine, recorded, cancels }
}

function task(id, title, prompt = `do ${id}`) {
  return { id, type: 'task', title, x: 0, y: 0, task: { prompt, contextMode: 'full' } }
}

function gateway(id, title = '并行网关') {
  return { id, type: 'parallel', title, x: 0, y: 0 }
}

function judge(id, title = '判断节点', prompt = `judge ${id}`, control) {
  return { id, type: 'judge', title, x: 0, y: 0, task: { prompt, contextMode: 'full' }, ...(control ? { control } : {}) }
}

function terminate(id, title = '终止节点', control) {
  return { id, type: 'terminate', title, x: 0, y: 0, ...(control ? { control } : {}) }
}

function workflow(nodes, edges) {
  return {
    id: 'wf-test',
    name: '测试工作流',
    nodes,
    edges: edges.map(([from, to], index) => ({ id: `e${index}`, from, to })),
    settings: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

test('two unconnected tasks start together', async () => {
  const gates = new Map()
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, workflow([task('a', '任务 A'), task('b', '任务 B')], []))
  await waitFor(() => started.length === 2)
  assert.deepEqual(started.sort(), ['a', 'b'])
  gates.get('a').resolve({ sessionId: 's-a', output: 'A done' })
  gates.get('b').resolve({ sessionId: 's-b', output: 'B done' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.a.status, 'completed')
  assert.equal(recorded[0].nodes.b.status, 'completed')
})

test('a chained task waits for its predecessor', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      await delay(15)
      return { sessionId: `s-${node.id}`, output: `${node.id} output` }
    },
  })
  await engine.start(undefined, workflow([task('a', '任务 A'), task('b', '任务 B')], [['a', 'b']]))
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(recorded[0].status, 'completed')
})

test('parallel gateway waits for every incoming branch', async () => {
  const started = []
  const gates = new Map()
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), gateway('gw'), task('c', '任务 C')],
    [
      ['a', 'gw'],
      ['b', 'gw'],
      ['gw', 'c'],
    ],
  )
  await engine.start(undefined, definition)
  await waitFor(() => started.length === 2)
  // C must not start while the gateway has only one completed branch.
  gates.get('a').resolve({ sessionId: 's-a', output: 'A' })
  await delay(40)
  assert.deepEqual(started, ['a', 'b'])
  assert.equal(recorded.length, 0)
  gates.get('b').resolve({ sessionId: 's-b', output: 'B' })
  await waitFor(() => started.includes('c'))
  gates.get('c').resolve({ sessionId: 's-c', output: 'C' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.gw.status, 'completed')
})

test('a failed task skips its downstream branch but lets independent work finish', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      await delay(10)
      if (node.id === 'a') throw new Error('boom')
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), task('c', '独立任务 C')],
    [['a', 'b']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.a.status, 'failed')
  assert.equal(run.nodes.b.status, 'skipped')
  assert.equal(run.nodes.c.status, 'completed')
  assert.deepEqual(started.sort(), ['a', 'c'])
})

test('detach stop stops scheduling but lets running tasks finish', async () => {
  const started = []
  const gate = deferred()
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      if (node.id === 'a') return gate.promise
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const value = await engine.start(undefined, workflow([task('a', '任务 A'), task('b', '任务 B')], [['a', 'b']]))
  await waitFor(() => started.includes('a'))
  engine.stop(value.id, { cancelTasks: false })
  gate.resolve({ sessionId: 's-a', output: 'done' })
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'cancelled')
  assert.equal(run.nodes.a.status, 'completed')
  assert.equal(run.nodes.b.status, 'cancelled')
  assert.deepEqual(started, ['a'])
})

test('cancel-tasks stop cancels every running task session', async () => {
  const started = []
  const { engine, recorded, cancels } = createHarness({
    executeTask: async ({ run, node }) => {
      started.push(node.id)
      run.nodes[node.id].sessionId = `s-${node.id}`
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (cancels.includes(`s-${node.id}`)) {
            clearInterval(timer)
            reject(new Error('aborted'))
          }
        }, 5)
        timer.unref?.()
      })
      return { sessionId: `s-${node.id}`, output: 'never' }
    },
  })
  const value = await engine.start(undefined, workflow([task('a', '任务 A'), task('b', '任务 B')], []))
  await waitFor(() => started.length === 2)
  engine.stop(value.id, { cancelTasks: true })
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(cancels.sort(), ['s-a', 's-b'])
  assert.equal(recorded[0].status, 'cancelled')
})

test('validation rejects cycles, empty prompts and dangling gateways', () => {
  const cyclic = workflow(
    [task('a', 'A'), task('b', 'B')],
    [
      ['a', 'b'],
      ['b', 'a'],
    ],
  )
  assert.match(validateWorkflow(cyclic).join(';'), /环路/)
  const emptyPrompt = workflow([task('a', 'A', '')], [])
  assert.match(validateWorkflow(emptyPrompt).join(';'), /提示词/)
  const dangling = workflow([gateway('gw')], [])
  assert.match(validateWorkflow(dangling).join(';'), /缺少输入连线/)
  const valid = workflow([task('a', 'A'), task('b', 'B')], [['a', 'b']])
  assert.deepEqual(validateWorkflow(valid), [])
})

test('upstream context resolves through gateways and honours the mode', () => {
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), gateway('gw'), task('c', '任务 C')],
    [
      ['a', 'gw'],
      ['b', 'gw'],
      ['gw', 'c'],
    ],
  )
  const upstream = upstreamTaskNodes(definition, 'c').map((node) => node.id)
  assert.deepEqual(upstream.sort(), ['a', 'b'])
  const states = [
    { node: { title: '任务 A' }, state: { sessionId: 's-a', output: 'alpha' } },
    { node: { title: '任务 B' }, state: { sessionId: 's-b', output: 'beta' } },
  ]
  const full = composePrompt({ task: { prompt: '审查以上内容', contextMode: 'full' } }, states, 'full')
  assert.match(full, /审查以上内容/)
  assert.match(full, /alpha/)
  assert.match(full, /beta/)
  const summary = composePrompt({ task: { prompt: '审查', contextMode: 'summary' } }, states, 'summary')
  assert.match(summary, /会话 s-a/)
  assert.match(summary, /alpha/)
  assert.match(summary, /会话 s-b/)
  assert.match(summary, /beta/)
  assert.doesNotMatch(summary, /【上游任务输出】/)
  const none = composePrompt({ task: { prompt: '仅自己的提示词', contextMode: 'none' } }, states, 'none')
  assert.equal(none, '仅自己的提示词')
  assert.equal(composePrompt({ task: { prompt: 'x', contextMode: 'full' } }, [], 'full'), 'x')
})

test('run from a middle node executes only its downstream scope', async () => {
  const started = []
  const upstreamIds = new Map()
  const { engine, recorded } = createHarness({
    executeTask: async ({ node, upstream }) => {
      started.push(node.id)
      upstreamIds.set(
        node.id,
        upstream.map((entry) => entry.node.id),
      )
      await delay(5)
      return { sessionId: `s-${node.id}`, output: `${node.id} output` }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), task('c', '任务 C'), task('d', '独立任务 D')],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
  )
  const snapshot = await engine.start(undefined, definition, { startNodeId: 'b' })
  assert.equal(snapshot.startNodeId, 'b')
  assert.equal(snapshot.nodes.a.status, 'not-run')
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.deepEqual(started, ['b', 'c'])
  assert.equal(run.nodes.a.status, 'not-run')
  assert.equal(run.nodes.d.status, 'not-run')
  assert.equal(run.nodes.b.status, 'completed')
  assert.equal(run.nodes.c.status, 'completed')
  // The pruned predecessor must not leak into the downstream prompt context.
  assert.deepEqual(upstreamIds.get('b'), [])
  assert.deepEqual(upstreamIds.get('c'), ['b'])
  const logText = run.log.map((entry) => entry.message).join('\n')
  assert.match(logText, /从节点「任务 B」开始执行：跳过 2 个不在下游范围内的节点/)
})

test('run from one branch ignores pruned gateway inputs', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      await delay(5)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), gateway('gw'), task('c', '任务 C')],
    [
      ['a', 'gw'],
      ['b', 'gw'],
      ['gw', 'c'],
    ],
  )
  await engine.start(undefined, definition, { startNodeId: 'a' })
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.deepEqual(started, ['a', 'c'])
  assert.equal(run.nodes.b.status, 'not-run')
  assert.equal(run.nodes.gw.status, 'completed')
  assert.equal(run.nodes.c.status, 'completed')
})

test('run from a gateway fans out without waiting for absent inputs', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      await delay(5)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), gateway('gw'), task('c', '任务 C')],
    [['gw', 'c']],
  )
  assert.deepEqual(validateWorkflow(definition, { startNodeId: 'gw' }), [])
  await engine.start(undefined, definition, { startNodeId: 'gw' })
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.deepEqual(started, ['c'])
  assert.equal(run.nodes.a.status, 'not-run')
  assert.equal(run.nodes.gw.status, 'completed')
})

test('scoped validation only checks the reachable subgraph', () => {
  const definition = workflow(
    [task('a', '任务 A', ''), task('b', '任务 B'), task('c', '任务 C')],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
  )
  assert.match(validateWorkflow(definition).join(';'), /还没有填写提示词/)
  assert.deepEqual(validateWorkflow(definition, { startNodeId: 'b' }), [])
  assert.match(validateWorkflow(definition, { startNodeId: 'missing' }).join(';'), /起始节点不存在/)
  const emptyStart = workflow([task('a', '任务 A', '')], [])
  assert.match(validateWorkflow(emptyStart, { startNodeId: 'a' }).join(';'), /还没有填写提示词/)
})

test('judge verdict parsing takes the last decision token', () => {
  assert.equal(parseJudgeDecision('分析完成\nWOF_DECISION: CONTINUE'), 'CONTINUE')
  assert.equal(parseJudgeDecision('WOF_DECISION：STOP'), 'STOP')
  assert.equal(parseJudgeDecision('WOF_DECISION: CONTINUE\nWOF_DECISION: STOP'), 'STOP')
  assert.equal(parseJudgeDecision('没有任何判定'), undefined)
  assert.equal(parseJudgeDecision(undefined), undefined)
})

test('a judge continues and keeps its upstream output as downstream context', async () => {
  const started = []
  const upstreamIds = new Map()
  const { engine, recorded } = createHarness({
    executeTask: async ({ node, upstream }) => {
      started.push(node.id)
      upstreamIds.set(
        node.id,
        upstream.map((entry) => entry.node.id),
      )
      await delay(5)
      if (node.type === 'judge') return { sessionId: 's-j', output: '评估完成\nWOF_DECISION: CONTINUE' }
      return { sessionId: `s-${node.id}`, output: `${node.id} output` }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), judge('j', '判断是否继续'), task('b', '任务 B')],
    [
      ['a', 'j'],
      ['j', 'b'],
    ],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.equal(run.terminated, false)
  assert.equal(run.nodes.j.status, 'completed')
  assert.equal(run.nodes.j.decision, 'CONTINUE')
  assert.equal(run.nodes.b.status, 'completed')
  assert.deepEqual(started, ['a', 'j', 'b'])
  // The judge is transparent: downstream tasks still receive the upstream task output.
  assert.deepEqual(upstreamIds.get('j'), ['a'])
  assert.deepEqual(upstreamIds.get('b'), ['a'])
  assert.match(run.log.map((entry) => entry.message).join('\n'), /判断节点「判断是否继续」判定：继续/)
})

test('a STOP verdict terminates the run early and skips downstream nodes', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      await delay(5)
      if (node.type === 'judge') return { sessionId: 's-j', output: '没有继续价值\nWOF_DECISION: STOP' }
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), judge('j', '判断是否继续'), task('b', '任务 B')],
    [
      ['a', 'j'],
      ['j', 'b'],
    ],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.equal(run.terminated, true)
  assert.equal(run.terminatedBy.nodeId, 'j')
  assert.match(run.terminatedReason, /判断节点「判断是否继续」/)
  assert.equal(run.nodes.j.status, 'completed')
  assert.equal(run.nodes.j.decision, 'STOP')
  assert.equal(run.nodes.b.status, 'skipped')
  assert.match(run.nodes.b.error, /工作流已提前终止/)
  assert.deepEqual(started, ['a', 'j'])
  assert.match(run.log.map((entry) => entry.message).join('\n'), /工作流提前结束/)
})

test('an unrecognised verdict continues by default and can stop when configured', async () => {
  const runOnce = async (control) => {
    const started = []
    const { engine, recorded } = createHarness({
      executeTask: async ({ node }) => {
        started.push(node.id)
        await delay(5)
        if (node.type === 'judge') return { sessionId: 's-j', output: '这次没有按格式输出' }
        return { sessionId: `s-${node.id}`, output: 'ok' }
      },
    })
    const definition = workflow(
      [task('a', '任务 A'), judge('j', '判断', 'judge prompt', control), task('b', '任务 B')],
      [
        ['a', 'j'],
        ['j', 'b'],
      ],
    )
    await engine.start(undefined, definition)
    await waitFor(() => recorded.length === 1)
    return { run: recorded[0], started }
  }
  const fallback = await runOnce(undefined)
  assert.equal(fallback.run.status, 'completed')
  assert.equal(fallback.run.terminated, false)
  assert.equal(fallback.run.nodes.b.status, 'completed')
  assert.deepEqual(fallback.started, ['a', 'j', 'b'])
  assert.match(fallback.run.log.map((entry) => entry.message).join('\n'), /没有识别到 WOF_DECISION 判定/)

  const stopping = await runOnce({ onInvalid: 'stop' })
  assert.equal(stopping.run.status, 'completed')
  assert.equal(stopping.run.terminated, true)
  assert.equal(stopping.run.nodes.b.status, 'skipped')
  assert.deepEqual(stopping.started, ['a', 'j'])
})

test('a terminate node ends the run, skips unstarted nodes and lets in-flight tasks finish', async () => {
  const started = []
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      if (node.id === 'slow') {
        await delay(80)
        return { sessionId: 's-slow', output: 'slow done' }
      }
      await delay(5)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), terminate('t', '到此为止', { reason: '结果已足够' }), task('b', '任务 B'), task('slow', '在途任务')],
    [
      ['a', 't'],
      ['a', 'b'],
    ],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.status, 'completed')
  assert.equal(run.terminated, true)
  assert.equal(run.terminatedBy.nodeId, 't')
  assert.equal(run.terminatedReason, '结果已足够')
  assert.equal(run.nodes.t.status, 'completed')
  assert.equal(run.nodes.b.status, 'skipped')
  assert.match(run.nodes.b.error, /工作流已提前终止/)
  // The already running unrelated task keeps running and still completes.
  assert.equal(run.nodes.slow.status, 'completed')
  assert.deepEqual(started.sort(), ['a', 'slow'])
})

test('a terminate node can cancel in-flight task sessions', async () => {
  const started = []
  const { engine, recorded, cancels } = createHarness({
    executeTask: async ({ run, node }) => {
      started.push(node.id)
      if (node.id === 'long') {
        run.nodes[node.id].sessionId = 's-long'
        await new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            if (cancels.includes('s-long')) {
              clearInterval(timer)
              reject(new Error('aborted'))
            }
          }, 5)
          timer.unref?.()
        })
        return { sessionId: 's-long', output: 'never' }
      }
      await delay(5)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), terminate('t', '立即终止', { stopPolicy: 'cancel-tasks' }), task('long', '在途任务')],
    [['a', 't']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.deepEqual(cancels, ['s-long'])
  assert.equal(run.status, 'completed')
  assert.equal(run.terminated, true)
  assert.equal(run.terminatedPolicy, 'cancel-tasks')
  assert.equal(run.nodes.long.status, 'cancelled')
  assert.deepEqual(started.sort(), ['a', 'long'])
})

test('a failure before termination still marks the run as failed', async () => {
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      await delay(node.id === 'failer' ? 2 : 20)
      if (node.id === 'failer') throw new Error('boom')
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('failer', '失败任务'), task('a', '任务 A'), terminate('t', '终止')],
    [['a', 't']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.terminated, true)
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.failer.status, 'failed')
  assert.equal(run.nodes.t.status, 'completed')
})

test('a failure after termination does not flip the completed run', async () => {
  const { engine, recorded } = createHarness({
    executeTask: async ({ node }) => {
      await delay(node.id === 'late' ? 60 : 5)
      if (node.id === 'late') throw new Error('late boom')
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), terminate('t', '终止'), task('late', '迟到失败任务')],
    [['a', 't']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  const run = recorded[0]
  assert.equal(run.terminated, true)
  assert.equal(run.status, 'completed')
  assert.equal(run.nodes.late.status, 'failed')
})

test('validation checks judge and terminate wiring', () => {
  const emptyJudgePrompt = workflow([task('a', 'A'), judge('j', 'J', '')], [['a', 'j']])
  assert.match(validateWorkflow(emptyJudgePrompt).join(';'), /判断节点「J」还没有填写提示词/)

  const noContext = workflow([task('a', 'A'), judge('j', 'J')], [['a', 'j']])
  noContext.nodes[1].task.contextMode = 'none'
  assert.match(validateWorkflow(noContext).join(';'), /上游上下文不能选择「完全不传」/)

  const judgeNoInput = workflow([judge('j', 'J')], [])
  assert.match(validateWorkflow(judgeNoInput).join(';'), /判断节点「J」缺少输入连线/)

  const judgeNoTask = workflow([judge('j0', 'J0'), judge('j', 'J')], [['j0', 'j']])
  assert.match(validateWorkflow(judgeNoTask).join(';'), /判断节点「J」的上游没有可评估的任务/)

  const terminateNoInput = workflow([terminate('t', 'T')], [])
  assert.match(validateWorkflow(terminateNoInput).join(';'), /终止节点「T」缺少输入连线/)

  const terminateWithOutput = workflow([task('a', 'A'), terminate('t', 'T'), task('b', 'B')], [
    ['a', 't'],
    ['t', 'b'],
  ])
  assert.match(validateWorkflow(terminateWithOutput).join(';'), /终止节点「T」不应有输出连线/)

  const valid = workflow([task('a', 'A'), judge('j', 'J'), terminate('t', 'T')], [
    ['a', 'j'],
    ['a', 't'],
  ])
  assert.deepEqual(validateWorkflow(valid), [])
})

test('upstream context and scope walk through judge nodes', () => {
  const definition = workflow(
    [task('a', '任务 A'), judge('j', '判断'), task('b', '任务 B')],
    [
      ['a', 'j'],
      ['j', 'b'],
    ],
  )
  assert.deepEqual(
    upstreamTaskNodes(definition, 'j').map((node) => node.id),
    ['a'],
  )
  assert.deepEqual(
    upstreamTaskNodes(definition, 'b').map((node) => node.id),
    ['a'],
  )
})

// ---------------------------------------------------------------------------
// waitForTurn：任务完成的判定
// ---------------------------------------------------------------------------

function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** A live-session double: `push()` appends an event and advances `seq`. */
function fakeSession(id) {
  const events = []
  const session = {
    id,
    seq: 0,
    deriveMessages() {
      return events.filter((event) => event.type === 'assistant/message').map((event) => event.data.message)
    },
    snapshotEvents() {
      return events.slice()
    },
    push(type, data) {
      const event = { type, seq: session.seq, time: Date.now(), ...(data === undefined ? {} : { data }) }
      events.push(event)
      session.seq += 1
      return event
    },
  }
  return session
}

function createTurnHarness({ session, agent, subagents, sessionProjections }) {
  const listeners = new Set()
  const cancelled = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'sessionProjections') return sessionProjections
      return undefined
    },
    on(name, handler) {
      if (name !== 'session/event') return () => {}
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    agents: {
      get(id) {
        return id === agent.id ? agent : undefined
      },
    },
    sessionController: {
      cancel(request) {
        cancelled.push(request.sessionId)
        return { accepted: true }
      },
    },
  }
  const store = {
    runs() {
      return []
    },
    recordRun() {},
    ready() {
      return Promise.resolve()
    },
    get() {
      return undefined
    },
    save(value) {
      return value
    },
  }
  const catalogs = {
    async get() {
      return { defaults: {} }
    },
  }
  const engine = new WorkflowEngine(ctx, store, catalogs)
  return { engine, cancelled, emit: (event) => listeners.forEach((handler) => handler(session, event)) }
}

test('a turn closing while background subagents run does not complete the task', { timeout: 10000 }, async () => {
  const agent = { id: 's-turn', status: 'idle', session: undefined }
  const session = fakeSession(agent.id)
  agent.session = session
  const childWork = deferred()
  let childrenCalls = 0
  const subagents = {
    waitForChildren() {
      childrenCalls += 1
      return childrenCalls === 1 ? childWork.promise : Promise.resolve(false)
    },
    drainDescendants() {
      return Promise.resolve()
    },
  }
  const { engine, emit } = createTurnHarness({ session, agent, subagents })

  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('preliminary answer') })
  const firstTurnEnd = session.push('turn/end', { reason: { kind: 'completed' } })

  let settled = false
  let outcome
  const pending = engine.waitForTurn(session, agent.id, 0, undefined)
  pending.then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )

  // The event path (not the poll fallback) must start waiting for children.
  emit(firstTurnEnd)
  await waitFor(() => childrenCalls === 1)
  assert.equal(settled, false)

  // A child settles and wakes the parent into a second turn.
  agent.status = 'running'
  session.push('turn/start')
  childWork.resolve(true)

  session.push('assistant/message', { message: assistantMessage('final review answer') })
  const finalTurnEnd = session.push('turn/end', { reason: { kind: 'completed' } })
  agent.status = 'idle'
  emit(finalTurnEnd)

  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, 'final review answer')
})

test('the last closed turn decides the task outcome', { timeout: 10000 }, async () => {
  const session = fakeSession()
  const agent = { id: 's-last', status: 'idle', session }
  const childWork = deferred()
  let childrenCalls = 0
  const subagents = {
    waitForChildren() {
      childrenCalls += 1
      return childrenCalls === 1 ? childWork.promise : Promise.resolve(false)
    },
  }
  const { engine } = createTurnHarness({ session, agent, subagents })

  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('preliminary answer') })
  session.push('turn/end', { reason: { kind: 'completed' } })
  let settled = false
  let outcome
  const pending = engine.waitForTurn(session, agent.id, 0, undefined)
  pending.then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )

  await delay(400)
  agent.status = 'running'
  session.push('turn/start')
  childWork.resolve(true)
  await delay(300)

  session.push('turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
  agent.status = 'idle'

  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'aborted')
  assert.match(outcome.message, /user/)
})

test('waitForTurn degrades to the first closed turn without the subagents service', { timeout: 5000 }, async () => {
  const session = fakeSession()
  const agent = { id: 's-fallback', status: 'idle', session }
  const { engine } = createTurnHarness({ session, agent, subagents: undefined })

  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('single turn answer') })
  session.push('turn/end', { reason: { kind: 'completed' } })

  let settled = false
  let outcome
  engine.waitForTurn(session, agent.id, 0, undefined).then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )
  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, 'single turn answer')
})

test('a failing waitForChildren degrades instead of blocking completion', { timeout: 5000 }, async () => {
  const session = fakeSession()
  const agent = { id: 's-broken-service', status: 'idle', session }
  const subagents = {
    waitForChildren() {
      throw new Error('manager unavailable')
    },
  }
  const { engine } = createTurnHarness({ session, agent, subagents })

  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('answer with broken service') })
  session.push('turn/end', { reason: { kind: 'completed' } })

  let settled = false
  let outcome
  engine.waitForTurn(session, agent.id, 0, undefined).then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )
  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, 'answer with broken service')
})

test('cancel-tasks rejects a task waiting for background subagents', { timeout: 5000 }, async () => {
  const session = fakeSession()
  const agent = { id: 's-cancel', status: 'idle', session }
  const drained = []
  const subagents = {
    waitForChildren() {
      return new Promise(() => {})
    },
    drainDescendants(agents) {
      drained.push(...agents.map((item) => item.id))
      return Promise.resolve()
    },
  }
  const { engine, cancelled } = createTurnHarness({ session, agent, subagents })

  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('preliminary answer') })
  session.push('turn/end', { reason: { kind: 'completed' } })

  const run = { stopRequested: false, stopMode: null, terminated: false, terminatedPolicy: null }
  let settled = false
  let failure
  engine.waitForTurn(session, agent.id, 0, run).then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      failure = error
    },
  )
  await delay(300)
  run.stopRequested = true
  run.stopMode = 'cancel-tasks'

  await waitFor(() => settled)
  assert.match(failure.message, /任务已被终止/)
  assert.deepEqual(cancelled, [agent.id])
  assert.deepEqual(drained, [agent.id])
})

// ---------------------------------------------------------------------------
// waitForTurn：等待用户回复
// ---------------------------------------------------------------------------

/** One ask_user_question tool call event with a single-question batch. */
function askCallEvent(callId, question) {
  return {
    callId,
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question, header: '确认', options: [{ label: 'A' }, { label: 'B' }] }] }),
  }
}

/** A minimal run + node pair so waitForTurn can write its waiting bookkeeping. */
function waitingRunFixture() {
  const run = {
    id: 'run-wait',
    workflowName: '测试工作流',
    log: [],
    nodes: {
      n1: { id: 'n1', title: '任务 A', type: 'task', status: 'running', sessionId: null, waitingForUser: null },
    },
  }
  const node = { id: 'n1', title: '任务 A', type: 'task' }
  return { run, node }
}

test('pendingUserQuestions tracks open ask calls and projected questions', () => {
  const session = fakeSession('s-q')
  session.push('turn/start')
  session.push('tool/call', askCallEvent('c1', '选择哪种方案？'))
  let projectionState
  const projections = {
    stateOf(target, key) {
      return key === 'userQuestions' ? projectionState : undefined
    },
  }

  // An ask call without its tool result is a foreground wait on the user.
  let waiting = pendingUserQuestions(session, 0, projections)
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].callId, 'c1')
  assert.equal(waiting[0].state, 'open')
  assert.equal(waiting[0].questions[0].question, '选择哪种方案？')
  assert.equal(waiting[0].questions[0].header, '确认')
  assert.deepEqual(waiting[0].questions[0].options, ['A', 'B'])

  // A projected row for the same call is deduplicated against the open call.
  projectionState = { questions: { active: [{ callId: 'c1', questions: [{ id: 'q1', question: '选择哪种方案？' }], state: 'continued' }] } }
  waiting = pendingUserQuestions(session, 0, projections)
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].state, 'open')

  // The tool result closes the foreground wait; the continued row stays answerable.
  session.push('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"pending":true,"callId":"c1"}' }] } })
  waiting = pendingUserQuestions(session, 0, projections)
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].state, 'continued')

  // Once the projection settles, the session waits on nothing.
  projectionState = { questions: { active: [] } }
  waiting = pendingUserQuestions(session, 0, projections)
  assert.equal(waiting.length, 0)
})

test('a blocking user question suspends completion until the user answers', { timeout: 10000 }, async () => {
  const agent = { id: 's-ask', status: 'running', session: undefined }
  const session = fakeSession(agent.id)
  agent.session = session
  const { engine, emit } = createTurnHarness({ session, agent, subagents: {} })
  const { run, node } = waitingRunFixture()

  session.push('turn/start')
  session.push('tool/call', askCallEvent('c1', '用哪个标题？'))

  let settled = false
  let outcome
  engine.waitForTurn(session, agent.id, 0, run, node).then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )

  await waitFor(() => run.nodes.n1.waitingForUser !== null)
  assert.equal(settled, false)
  assert.equal(run.nodes.n1.waitingForUser.questions[0].question, '用哪个标题？')
  assert.ok(run.log.some((entry) => entry.message.includes('等待用户回复')))

  // The user answers in the task session: the tool result lands and the turn closes.
  session.push('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"answers":[]}' }] } })
  session.push('assistant/message', { message: assistantMessage('标题已确定，继续执行') })
  const turnEnd = session.push('turn/end', { reason: { kind: 'completed' } })
  agent.status = 'idle'
  emit(turnEnd)

  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, '标题已确定，继续执行')
  assert.equal(run.nodes.n1.waitingForUser, null)
  assert.ok(run.log.some((entry) => entry.message.includes('用户已回复')))
})

test('an expired timed question keeps the node waiting for the late reply', { timeout: 10000 }, async () => {
  const agent = { id: 's-timed', status: 'idle', session: undefined }
  const session = fakeSession(agent.id)
  agent.session = session
  const projectionState = { questions: { active: [] } }
  const sessionProjections = {
    stateOf(target, key) {
      return key === 'userQuestions' ? projectionState : undefined
    },
  }
  const { engine, emit } = createTurnHarness({ session, agent, subagents: {}, sessionProjections })
  const { run, node } = waitingRunFixture()

  session.push('turn/start')
  session.push('tool/call', askCallEvent('c9', '继续吗？'))
  session.push('tool/result', { message: { toolCallId: 'c9', content: [{ type: 'text', text: '{"pending":true,"callId":"c9"}' }] } })
  session.push('assistant/message', { message: assistantMessage('我先等你的回复') })
  const firstTurnEnd = session.push('turn/end', { reason: { kind: 'completed' } })
  projectionState.questions.active = [{ callId: 'c9', questions: [{ id: 'q1', question: '继续吗？' }], state: 'continued' }]

  let settled = false
  let outcome
  engine.waitForTurn(session, agent.id, 0, run, node).then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )

  emit(firstTurnEnd)
  await waitFor(() => run.nodes.n1.waitingForUser !== null)
  assert.equal(settled, false)

  // The user answers later: the waking agent claims the reply, the question
  // settles in the projection, and a fresh turn produces the real result.
  agent.status = 'running'
  projectionState.questions.active = []
  session.push('user/message', { source: { kind: 'user-question-reply', callId: 'c9' } })
  session.push('turn/start')
  session.push('assistant/message', { message: assistantMessage('收到回复，最终结论') })
  const finalTurnEnd = session.push('turn/end', { reason: { kind: 'completed' } })
  agent.status = 'idle'
  emit(finalTurnEnd)

  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, '收到回复，最终结论')
  assert.equal(run.nodes.n1.waitingForUser, null)
})

test('without the projection service an expired timed question no longer blocks completion', { timeout: 5000 }, async () => {
  const agent = { id: 's-noproj', status: 'idle', session: undefined }
  const session = fakeSession(agent.id)
  agent.session = session
  const { engine, emit } = createTurnHarness({ session, agent, subagents: {} })
  const { run, node } = waitingRunFixture()

  session.push('turn/start')
  session.push('tool/call', askCallEvent('c2', '继续吗？'))
  session.push('tool/result', { message: { toolCallId: 'c2', content: [{ type: 'text', text: '{"pending":true,"callId":"c2"}' }] } })
  session.push('assistant/message', { message: assistantMessage('我先等你的回复') })
  const firstTurnEnd = session.push('turn/end', { reason: { kind: 'completed' } })

  let settled = false
  let outcome
  engine.waitForTurn(session, agent.id, 0, run, node).then(
    (value) => {
      settled = true
      outcome = value
    },
    () => {
      settled = true
    },
  )

  emit(firstTurnEnd)
  await waitFor(() => settled)
  assert.equal(outcome.reasonKind, 'completed')
  assert.equal(outcome.output, '我先等你的回复')
  assert.ok(run.log.some((entry) => entry.message.includes('会话投影服务不可用')))
})

test('cancel-tasks while waiting for the user clears the waiting state', { timeout: 5000 }, async () => {
  const agent = { id: 's-wcancel', status: 'running', session: undefined }
  const session = fakeSession(agent.id)
  agent.session = session
  const { engine, cancelled } = createTurnHarness({ session, agent, subagents: {} })
  const { run, node } = waitingRunFixture()
  run.stopRequested = false
  run.stopMode = null
  run.terminated = false
  run.terminatedPolicy = null

  session.push('turn/start')
  session.push('tool/call', askCallEvent('c3', '用哪个标题？'))

  let settled = false
  let failure
  engine.waitForTurn(session, agent.id, 0, run, node).then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      failure = error
    },
  )
  await waitFor(() => run.nodes.n1.waitingForUser !== null)
  run.stopRequested = true
  run.stopMode = 'cancel-tasks'

  await waitFor(() => settled)
  assert.match(failure.message, /任务已被终止/)
  assert.equal(run.nodes.n1.waitingForUser, null)
  assert.deepEqual(cancelled, [agent.id])
})

// ---------------------------------------------------------------------------
// 定时节点 / 动作节点 / 等待任务完成节点
// ---------------------------------------------------------------------------

function timerNode(id, title, timer) {
  return { id, type: 'timer', title, x: 0, y: 0, timer }
}

function actionNode(id, title, action) {
  return { id, type: 'action', title, x: 0, y: 0, action }
}

function waitNode(id, title, targets) {
  return { id, type: 'wait', title, x: 0, y: 0, wait: { targets } }
}

/** Control-node harness: real ctx shape with injectable sessions/agents. */
function createControlHarness({
  executeTask,
  executeAction,
  sessions = new Map(),
  agents = new Map(),
  subagents,
  sessionProjections,
  engineOptions = {},
  workflows = [],
}) {
  const recorded = []
  const cancels = []
  const listeners = new Set()
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'sessionProjections') return sessionProjections
      if (name === 'dshHomePath') return () => '.'
      return undefined
    },
    on(name, handler) {
      if (name !== 'session/event') return () => {}
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
      list() {
        return [...agents.values()]
      },
    },
    sessionController: {
      cancel(payload) {
        cancels.push(payload.sessionId)
        return { accepted: true }
      },
    },
  }
  const store = {
    runs() {
      return [...storedRuns, ...recorded]
    },
    recordRun(run) {
      recorded.push(run)
    },
    ready() {
      return Promise.resolve()
    },
    get(id) {
      return workflows.find((workflow) => workflow.id === id)
    },
    workflows() {
      return workflows.slice()
    },
    save(workflow) {
      return workflow
    },
  }
  const catalogs = {
    async get() {
      return { defaults: {} }
    },
  }
  const engine = new WorkflowEngine(ctx, store, catalogs, {
    schedulerEnabled: false,
    ...(executeTask === undefined ? {} : { executeTask }),
    ...(executeAction === undefined ? {} : { executeAction }),
    ...engineOptions,
  })
  return { engine, recorded, cancels, ctx, emit: (session, event) => listeners.forEach((handler) => handler(session, event)) }
}

test('recurrence helpers compute the next trigger of every timer mode', () => {
  const from = new Date(2026, 10, 22, 1, 30, 0, 0).getTime()
  assert.equal(nextOccurrence({ mode: 'daily', time: '03:00' }, from), new Date(2026, 10, 22, 3, 0, 0, 0).getTime())
  assert.equal(nextOccurrence({ mode: 'daily', time: '01:00' }, from), new Date(2026, 10, 23, 1, 0, 0, 0).getTime())
  assert.equal(nextOccurrence({ mode: 'interval', intervalMinutes: 30 }, from), from + 30 * 60000)
  const once = from + 120000
  assert.equal(nextOccurrence({ mode: 'once', at: once }, from), once)
  const weekly = nextOccurrence({ mode: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5, 6, 7] }, from)
  assert.ok(weekly > from)
  assert.equal(describeTimer({ mode: 'daily', time: '03:00' }), '每天 03:00')
  assert.match(describeTimer({ mode: 'weekly', time: '09:00', weekdays: [1, 3] }), /每周 周一、周三 09:00/)
  assert.match(describeTimer({ mode: 'interval', intervalMinutes: 120 }), /每 2 小时/)
  assert.equal(timerIsPeriodic({ mode: 'daily', time: '03:00' }), true)
  assert.equal(timerIsPeriodic({ mode: 'once', at: once }), false)
  assert.match(formatDateTime(once), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.match(timerValidationProblems({ mode: 'once', at: from - 3600000 }, from).join(';'), /已过去/)
  assert.match(timerValidationProblems({ mode: 'weekly', time: '09:00', weekdays: [] }, from).join(';'), /至少选择一天/)
  assert.match(timerValidationProblems({ mode: 'interval', intervalMinutes: 0 }, from).join(';'), /大于 0/)
})

test('action helpers describe and validate every action kind', () => {
  assert.match(describeAction({ kind: 'shutdown', delaySeconds: 60 }), /自动关机（60 秒后）/)
  assert.match(describeAction({ kind: 'http-request', method: 'POST', url: 'https://example.com/hook' }), /POST 请求/)
  assert.match(describeAction({ kind: 'log', text: '完成' }), /写入日志/)
  assert.deepEqual(actionValidationProblems({ kind: 'log' }), [])
  assert.match(actionValidationProblems({ kind: 'open-url', url: 'not-a-url' }).join(';'), /http/)
  assert.match(actionValidationProblems({ kind: 'run-command', command: '  ' }).join(';'), /命令/)
  assert.match(actionValidationProblems({ kind: 'http-request', url: 'https://example.com', method: 'TRACE' }).join(';'), /HTTP 方法/)
  assert.match(actionValidationProblems({ kind: 'bogus' }).join(';'), /未知的动作类型/)
})

test('validation covers timer, action and wait wiring', () => {
  const definition = workflow(
    [
      timerNode('t', '定时', { mode: 'weekly', time: '03:00', weekdays: [] }),
      actionNode('a', '动作', { kind: 'open-url', url: 'nope' }),
      waitNode('w', '等待', []),
      task('b', '任务 B'),
    ],
    [
      ['t', 'a'],
      ['a', 'w'],
      ['w', 'b'],
    ],
  )
  const text = validateWorkflow(definition).join(';')
  assert.match(text, /定时节点「定时」每周触发需要至少选择一天/)
  assert.match(text, /动作节点「动作」需要填写以 http/)
  assert.match(text, /等待任务完成节点「等待」还没有选择要等待的任务/)
  const noOutput = workflow([timerNode('t2', '孤立定时', { mode: 'daily', time: '03:00' })], [])
  assert.match(validateWorkflow(noOutput).join(';'), /缺少输出连线/)
  const danglingWait = workflow([waitNode('w2', '孤立等待', [{ id: 's-1', title: 'x' }])], [])
  assert.match(validateWorkflow(danglingWait).join(';'), /缺少输出连线/)
  const pastOnce = workflow([timerNode('t3', '过期定时', { mode: 'once', at: Date.now() - 3600000 }), task('b3', 'B')], [['t3', 'b3']])
  assert.match(validateWorkflow(pastOnce).join(';'), /一次性触发时间已过去/)
})

test('a mid-flow timer waits for its instant and then releases downstream nodes', { timeout: 5000 }, async () => {
  const started = []
  const fireAt = Date.now() + 180
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: `${node.id} done` }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), timerNode('t', '定时', { mode: 'once', at: fireAt }), task('b', '任务 B')],
    [
      ['a', 't'],
      ['t', 'b'],
    ],
  )
  await engine.start(undefined, definition)
  await waitFor(() => started.includes('a'))
  await delay(80)
  assert.equal(started.includes('b'), false)
  await waitFor(() => started.includes('b'), 3000)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.t.status, 'completed')
  assert.ok(recorded[0].nodes.t.timerState.firedAt > 0)
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('定时节点「定时」触发')))
})

test('a root timer node fires immediately on a manual run', { timeout: 5000 }, async () => {
  const started = []
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  const definition = workflow(
    [timerNode('t', '定时', { mode: 'once', at: Date.now() + 3600000 }), task('b', '任务 B')],
    [['t', 'b']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(started, ['b'])
  assert.equal(recorded[0].status, 'completed')
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('起始节点立即触发')))
})

test('stopping a run cancels a pending timer wait instead of pinning the run', { timeout: 5000 }, async () => {
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
  })
  const definition = workflow(
    [task('a', '任务 A'), timerNode('t', '定时', { mode: 'once', at: Date.now() + 60000 }), task('b', '任务 B')],
    [
      ['a', 't'],
      ['t', 'b'],
    ],
  )
  const run = await engine.start(undefined, definition)
  await waitFor(() => engine.getRun(run.id)?.nodes?.t?.status === 'running', 3000)
  engine.stop(run.id, { cancelTasks: false })
  await waitFor(() => recorded.length === 1, 3000)
  assert.equal(recorded[0].status, 'cancelled')
  assert.equal(recorded[0].nodes.t.status, 'cancelled')
  assert.equal(recorded[0].nodes.b.status, 'cancelled')
})

test('an action node runs the injected executor and records its summary', { timeout: 5000 }, async () => {
  const executed = []
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: '任务完成' }),
    executeAction: async ({ node, action }) => {
      executed.push({ nodeId: node.id, action })
      return { summary: '已计划 60 秒后关机' }
    },
  })
  const definition = workflow(
    [task('a', '任务 A'), actionNode('x', '关机', { kind: 'shutdown', dryRun: false, delaySeconds: 60 })],
    [['a', 'x']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(executed.length, 1)
  assert.equal(executed[0].action.kind, 'shutdown')
  assert.equal(recorded[0].nodes.x.status, 'completed')
  assert.equal(recorded[0].nodes.x.output, '已计划 60 秒后关机')
})

test('a failing action node fails the run', { timeout: 5000 }, async () => {
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
    executeAction: async () => {
      throw new Error('命令退出码 1')
    },
  })
  const definition = workflow(
    [actionNode('x', '动作', { kind: 'run-command', dryRun: false, command: 'false' }), task('b', '后续')],
    [['x', 'b']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'failed')
  assert.equal(recorded[0].nodes.x.status, 'failed')
  assert.match(recorded[0].nodes.x.error, /命令退出码 1/)
  assert.equal(recorded[0].nodes.b.status, 'skipped')
})

test('a wait node blocks until the selected task is really quiescent', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-1')
  const targetAgent = { id: 'ext-1', status: 'running', session: targetSession }
  const started = []
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-1', targetSession]]),
    agents: new Map([['ext-1', targetAgent]]),
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'downstream done' }
    },
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待外部任务', [{ id: 'ext-1', title: '外部任务' }]), task('b', '后续任务')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  await engine.start(undefined, definition)
  await delay(120)
  assert.deepEqual(started, [])
  targetAgent.status = 'idle'
  targetSession.push('assistant/message', { message: assistantMessage('外部任务完成') })
  targetSession.push('turn/end', { reason: { kind: 'completed' } })
  await waitFor(() => started.includes('b'), 5000)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.w.status, 'completed')
  assert.equal(recorded[0].nodes.w.waitState.targets[0].status, 'completed')
})

test('a wait node does not complete while the task waits on a user question', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-2')
  const targetAgent = { id: 'ext-2', status: 'idle', session: targetSession }
  const started = []
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-2', targetSession]]),
    agents: new Map([['ext-2', targetAgent]]),
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待外部任务', [{ id: 'ext-2', title: '外部任务' }]), task('b', '后续任务')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  targetSession.push('tool/call', {
    name: 'ask_user_question',
    callId: 'ask-1',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: '用哪个标题？' }] }),
  })
  targetSession.push('turn/end', { reason: { kind: 'completed' } })
  await engine.start(undefined, definition)
  await delay(220)
  assert.deepEqual(started, [])
  // The user answers: the question settles and a new turn completes.
  targetSession.push('tool/result', { message: { toolCallId: 'ask-1' } })
  targetSession.push('turn/start')
  targetSession.push('assistant/message', { message: assistantMessage('外部任务完成') })
  targetSession.push('turn/end', { reason: { kind: 'completed' } })
  await waitFor(() => started.includes('b'), 5000)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
})

test('a wait node does not complete while child subagent work can still join', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-3')
  const targetAgent = { id: 'ext-3', status: 'idle', session: targetSession }
  let hasChildren = true
  const started = []
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-3', targetSession]]),
    agents: new Map([['ext-3', targetAgent]]),
    subagents: {
      waitForChildren() {
        return Promise.resolve(hasChildren)
      },
    },
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待外部任务', [{ id: 'ext-3', title: '外部任务' }]), task('b', '后续任务')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  targetSession.push('assistant/message', { message: assistantMessage('阶段性回复') })
  targetSession.push('turn/end', { reason: { kind: 'completed' } })
  await engine.start(undefined, definition)
  await delay(220)
  assert.deepEqual(started, [])
  hasChildren = false
  await waitFor(() => started.includes('b'), 5000)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
})

test('a wait node fails when a selected task failed, and does not start downstream nodes', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-4')
  const targetAgent = { id: 'ext-4', status: 'idle', session: targetSession }
  const started = []
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-4', targetSession]]),
    agents: new Map([['ext-4', targetAgent]]),
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待外部任务', [{ id: 'ext-4', title: '外部任务' }]), task('b', '后续任务')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  targetSession.push('turn/end', { reason: { kind: 'error', error: { code: 'BOOM', message: '任务崩了' } } })
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'failed')
  assert.equal(recorded[0].nodes.w.status, 'failed')
  assert.match(recorded[0].nodes.w.error, /外部任务.*未成功完成/)
  assert.equal(recorded[0].nodes.b.status, 'skipped')
  assert.deepEqual(started, [])
})

test('stopping cancels a wait node instead of waiting for external tasks', { timeout: 5000 }, async () => {
  const targetSession = fakeSession('ext-5')
  const targetAgent = { id: 'ext-5', status: 'running', session: targetSession }
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-5', targetSession]]),
    agents: new Map([['ext-5', targetAgent]]),
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待外部任务', [{ id: 'ext-5', title: '外部任务' }]), task('b', '后续任务')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  const run = await engine.start(undefined, definition)
  await delay(80)
  engine.stop(run.id, { cancelTasks: false })
  await waitFor(() => recorded.length === 1, 3000)
  assert.equal(recorded[0].status, 'cancelled')
  assert.equal(recorded[0].nodes.w.status, 'cancelled')
  assert.equal(recorded[0].nodes.b.status, 'cancelled')
})

test('listWaitCandidates reports live non-subagent tasks', { timeout: 5000 }, async () => {
  const liveSession = fakeSession('s-live')
  const liveAgent = { id: 's-live', status: 'running', session: { ...liveSession, header: { origin: undefined } } }
  const childSession = fakeSession('s-child')
  const childAgent = { id: 's-child', status: 'running', session: { ...childSession, header: { origin: 'subagent', delegationDepth: 1 } } }
  const { engine } = createControlHarness({
    agents: new Map([
      ['s-live', liveAgent],
      ['s-child', childAgent],
    ]),
  })
  const tasks = await engine.listWaitCandidates()
  assert.deepEqual(tasks.map((task) => task.sessionId), ['s-live'])
  assert.equal(tasks[0].status, 'running')
})

// ---------------------------------------------------------------------------
// 定时调度器：自动启动工作流
// ---------------------------------------------------------------------------

function createScheduleHarness({ workflows, nowRef, executeTask, storedRuns = [] }) {
  const recorded = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
    sessionController: { cancel() {} },
  }
  const store = {
    runs() {
      return [...storedRuns, ...recorded]
    },
    recordRun(run) {
      recorded.push(run)
    },
    ready() {
      return Promise.resolve()
    },
    get(id) {
      return workflows.find((workflow) => workflow.id === id)
    },
    workflows() {
      return workflows.slice()
    },
    save(workflow) {
      return workflow
    },
  }
  const catalogs = {
    async get() {
      return { defaults: {} }
    },
  }
  const engine = new WorkflowEngine(ctx, store, catalogs, {
    schedulerEnabled: false,
    now: () => nowRef.value,
    executeTask: executeTask ?? (async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'scheduled ok' })),
  })
  return { engine, recorded }
}

test('the scheduler auto-starts a one-shot timer workflow at its instant', { timeout: 8000 }, async () => {
  const nowRef = { value: 1_800_000_000_000 }
  const workflowTarget = {
    ...workflow([timerNode('t', '定时', { mode: 'once', at: nowRef.value + 5000 }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-scheduled',
  }
  const { engine, recorded } = createScheduleHarness({ workflows: [workflowTarget], nowRef })
  await engine.tickSchedules()
  assert.equal(recorded.length, 0)
  assert.equal(engine.active.size, 0)
  nowRef.value += 5001
  await engine.tickSchedules()
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].trigger.kind, 'timer')
  assert.equal(recorded[0].trigger.nodeId, 't')
  assert.equal(recorded[0].trigger.scheduledAt, 1_800_000_005_000)
  // The same one-shot does not fire twice.
  await engine.tickSchedules()
  await delay(50)
  assert.equal(recorded.length, 1)
})

test('the scheduler summary counts periodic workflows and exposes the next trigger', { timeout: 5000 }, async () => {
  const now = new Date(2026, 10, 22, 1, 0, 0, 0).getTime()
  const nowRef = { value: now }
  const definition = {
    ...workflow([timerNode('t', '每天三点', { mode: 'daily', time: '03:00' }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-periodic',
    name: '每日任务',
  }
  const { engine } = createScheduleHarness({ workflows: [definition], nowRef })
  await engine.refreshSchedulerSummary()
  const summary = engine.schedulerSnapshot()
  assert.equal(summary.count, 1)
  assert.equal(summary.workflows[0].workflowName, '每日任务')
  assert.equal(summary.workflows[0].periodic, true)
  assert.equal(summary.workflows[0].nextAt, new Date(2026, 10, 22, 3, 0, 0, 0).getTime())
  assert.equal(summary.workflows[0].valid, true)
})

test('the scheduler skips a due periodic trigger while the workflow is already running', { timeout: 8000 }, async () => {
  const now = new Date(2026, 10, 22, 2, 59, 0, 0).getTime()
  const nowRef = { value: now }
  const gate = deferred()
  let runsStarted = 0
  const definition = {
    ...workflow([timerNode('t', '每天三点', { mode: 'daily', time: '03:00' }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-busy',
    name: '忙工作流',
  }
  const { engine, recorded } = createScheduleHarness({
    workflows: [definition],
    nowRef,
    executeTask: async ({ node }) => {
      runsStarted += 1
      if (runsStarted === 1) await gate.promise
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  nowRef.value = new Date(2026, 10, 22, 3, 0, 1, 0).getTime()
  await engine.tickSchedules()
  await waitFor(() => runsStarted === 1, 5000)
  nowRef.value = new Date(2026, 10, 23, 3, 0, 1, 0).getTime()
  await engine.tickSchedules()
  await delay(80)
  assert.equal(runsStarted, 1)
  gate.resolve()
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'completed')
})

test('a host restart does not replay a one-shot that already fired in its catch-up window', { timeout: 8000 }, async () => {
  const base = Date.now() + 60000
  const nowRef = { value: base }
  const definition = {
    ...workflow([timerNode('t', '重启前触发', { mode: 'once', at: base + 5000 }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-restart-once',
    name: '重启去重',
  }
  const first = createScheduleHarness({ workflows: [definition], nowRef })
  nowRef.value = base + 5001
  await first.engine.tickSchedules()
  await waitFor(() => first.recorded.length === 1, 5000)
  assert.equal(first.recorded[0].trigger.scheduledAt, base + 5000)
  // Restart inside the 10-minute window: a new engine only has the durable run history.
  nowRef.value = base + 5 * 60 * 1000
  const second = createScheduleHarness({ workflows: [definition], nowRef, storedRuns: first.recorded })
  await second.engine.tickSchedules()
  await delay(80)
  assert.equal(second.recorded.length, 0)
  assert.equal(second.engine.schedulerSnapshot().workflows[0].fired, true)
})

test('the scheduler does not start a periodic workflow that fails validation', { timeout: 5000 }, async () => {
  const now = new Date(2026, 10, 22, 2, 59, 0, 0).getTime()
  const nowRef = { value: now }
  let runsStarted = 0
  const definition = {
    ...workflow([timerNode('t', '每天三点', { mode: 'daily', time: '03:00' }), task('b', '任务 B', '')], [['t', 'b']]),
    id: 'wf-invalid',
    name: '未通过校验',
  }
  const { engine, recorded } = createScheduleHarness({
    workflows: [definition],
    nowRef,
    executeTask: async () => {
      runsStarted += 1
      return { sessionId: 's-b', output: 'ok' }
    },
  })
  nowRef.value = new Date(2026, 10, 22, 3, 0, 1, 0).getTime()
  await engine.tickSchedules()
  await delay(80)
  assert.equal(runsStarted, 0)
  assert.equal(recorded.length, 0)
  assert.equal(engine.schedulerSnapshot().workflows[0].valid, false)
})

test('rootTimerNodes only returns entry timers', () => {
  const definition = workflow(
    [timerNode('root', '入口定时', { mode: 'daily', time: '03:00' }), task('a', '任务 A'), timerNode('mid', '流程内定时', { mode: 'daily', time: '04:00' })],
    [
      ['root', 'a'],
      ['a', 'mid'],
    ],
  )
  assert.deepEqual(rootTimerNodes(definition).map((node) => node.id), ['root'])
})

test('dryRun is the safe default and produces no real side effect', async () => {
  const result = await executeActionReal({ action: { kind: 'shutdown', delaySeconds: 60 } })
  assert.match(result.summary, /试运行/)
  assert.match(result.summary, /自动关机/)
  const logResult = await executeActionReal({ action: { kind: 'log', dryRun: false, text: '完成' } })
  assert.match(logResult.summary, /完成/)
  assert.match(actionValidationProblems({ kind: 'http-request', method: 'GET', url: 'https://example.com', body: '{}' }).join(';'), /GET 请求不能带请求体/)
})

test('the scheduler catches up a one-shot inside the 10-minute grace window', { timeout: 8000 }, async () => {
  const base = Date.now() + 60000
  const nowRef = { value: base }
  const definition = {
    ...workflow([timerNode('t', '近未来', { mode: 'once', at: base + 5000 }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-grace',
    name: '补触发窗口',
  }
  const { engine, recorded } = createScheduleHarness({ workflows: [definition], nowRef })
  nowRef.value = base + 5 * 60 * 1000
  await engine.tickSchedules()
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].trigger.scheduledAt, base + 5000)
})

test('the scheduler does not catch up a one-shot older than the grace window', { timeout: 8000 }, async () => {
  const base = Date.now() + 60000
  const nowRef = { value: base }
  const definition = {
    ...workflow([timerNode('t', '过期', { mode: 'once', at: base + 5000 }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-missed',
    name: '错过窗口',
  }
  const { engine, recorded } = createScheduleHarness({ workflows: [definition], nowRef })
  nowRef.value = base + 20 * 60 * 1000
  await engine.tickSchedules()
  await delay(80)
  assert.equal(recorded.length, 0)
  assert.equal(engine.schedulerSnapshot().workflows[0].missed, true)
  await engine.tickSchedules()
  await delay(50)
  assert.equal(recorded.length, 0)
})

test('a long sleep catches a periodic timer up once instead of replaying every missed period', { timeout: 8000 }, async () => {
  const base = new Date(2026, 10, 22, 3, 0, 0, 0).getTime()
  const nowRef = { value: base }
  const definition = {
    ...workflow([timerNode('t', '每分钟', { mode: 'interval', intervalMinutes: 1 }), task('b', '任务 B')], [['t', 'b']]),
    id: 'wf-catchup',
    name: '补触发一次',
  }
  const { engine, recorded } = createScheduleHarness({ workflows: [definition], nowRef })
  nowRef.value = base + 5 * 60 * 1000 + 1000
  await engine.tickSchedules()
  await waitFor(() => recorded.length === 1, 5000)
  await engine.tickSchedules()
  await delay(120)
  assert.equal(recorded.length, 1)
})

test('a wait node times out after twelve hours of waiting', { timeout: 8000 }, async () => {
  const clockRef = { value: Date.now() }
  const targetSession = fakeSession('ext-long')
  const targetAgent = { id: 'ext-long', status: 'running', session: targetSession }
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-long', targetSession]]),
    agents: new Map([['ext-long', targetAgent]]),
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
    engineOptions: { waitPollMs: 15, now: () => clockRef.value },
  })
  const definition = workflow(
    [waitNode('w', '等待超时', [{ id: 'ext-long', title: '长任务' }]), task('b', '后续')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  await engine.start(undefined, definition)
  await delay(80)
  clockRef.value += 12 * 60 * 60 * 1000 + 1000
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'failed')
  assert.match(recorded[0].nodes.w.error, /等待超时/)
})

test('a closed task session fails the wait node instead of silently completing it', { timeout: 8000 }, async () => {
  const { engine, recorded } = createControlHarness({
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
    engineOptions: { waitPollMs: 15 },
  })
  const definition = workflow(
    [waitNode('w', '等不到的任务', [{ id: 'session-gone', title: '已关闭任务' }]), task('b', '后续')],
    [['w', 'b']],
  )
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'failed')
  assert.match(recorded[0].nodes.w.error, /会话已关闭/)
  assert.equal(recorded[0].nodes.b.status, 'skipped')
})

test('a wait node accepts the waitForTreeWork host API', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-tree')
  const targetAgent = { id: 'ext-tree', status: 'idle', session: targetSession }
  let calls = 0
  const started = []
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-tree', targetSession]]),
    agents: new Map([['ext-tree', targetAgent]]),
    subagents: {
      waitForTreeWork() {
        calls += 1
        return Promise.resolve(calls === 1)
      },
    },
    executeTask: async ({ node }) => {
      started.push(node.id)
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
    engineOptions: { waitPollMs: 15 },
  })
  const definition = workflow(
    [waitNode('w', '等待任务', [{ id: 'ext-tree', title: '外部任务' }]), task('b', '后续')],
    [['w', 'b']],
  )
  targetSession.push('turn/start')
  targetSession.push('assistant/message', { message: assistantMessage('done') })
  targetSession.push('turn/end', { reason: { kind: 'completed' } })
  await engine.start(undefined, definition)
  await waitFor(() => started.includes('b'), 5000)
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.ok(calls >= 2)
})

test('terminating the run skips a pending wait node', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-term')
  const targetAgent = { id: 'ext-term', status: 'running', session: targetSession }
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-term', targetSession]]),
    agents: new Map([['ext-term', targetAgent]]),
    executeTask: async ({ node }) => ({ sessionId: `s-${node.id}`, output: 'ok' }),
    engineOptions: { waitPollMs: 20 },
  })
  const definition = workflow(
    [waitNode('w', '等待任务', [{ id: 'ext-term', title: '外部任务' }]), task('b', '后续任务'), task('a', '任务 A'), terminate('t', '终止', { stopPolicy: 'detach' })],
    [['w', 'b'], ['a', 't']],
  )
  targetSession.push('turn/start')
  await engine.start(undefined, definition)
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].nodes.w.status, 'skipped')
  assert.equal(recorded[0].terminated, true)
  assert.equal(recorded[0].status, 'completed')
})

test('a wait failure keeps the run failed even when a terminate node fires later', { timeout: 8000 }, async () => {
  const targetSession = fakeSession('ext-fail-term')
  const targetAgent = { id: 'ext-fail-term', status: 'idle', session: targetSession }
  const gate = deferred()
  const { engine, recorded } = createControlHarness({
    sessions: new Map([['ext-fail-term', targetSession]]),
    agents: new Map([['ext-fail-term', targetAgent]]),
    executeTask: async ({ node }) => {
      if (node.id === 'a') await gate.promise
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
    engineOptions: { waitPollMs: 15 },
  })
  const definition = workflow(
    [waitNode('w', '等待失败任务', [{ id: 'ext-fail-term', title: '崩掉的任务' }]), task('b', '后续任务'), task('a', '任务 A'), terminate('t', '终止', { stopPolicy: 'detach' })],
    [['w', 'b'], ['a', 't']],
  )
  targetSession.push('turn/start')
  targetSession.push('turn/end', { reason: { kind: 'error', error: { code: 'BOOM', message: '崩了' } } })
  await engine.start(undefined, definition)
  await waitFor(() => engine.getRun([...engine.active.keys()][0])?.nodes?.w?.status === 'failed', 5000)
  gate.resolve()
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'failed')
  assert.equal(recorded[0].nodes.w.status, 'failed')
  assert.equal(recorded[0].terminated, true)
})

// ---------------------------------------------------------------------------
// live graph: edits made in the panel while a run is in flight
// ---------------------------------------------------------------------------

/**
 * Harness for live-edit tests. Its store mirrors the real one: it holds the
 * current definition, returns deep copies, and bumps a `revision` on every
 * save, which is what the engine probes before re-reading the graph.
 */
function createLiveHarness({ definition, executeTask, executeAction, engineOptions = {} }) {
  const recorded = []
  let current = definition
  const store = {
    revision: 1,
    runs() {
      return recorded.slice()
    },
    recordRun(run) {
      recorded.push(run)
    },
    ready() {
      return Promise.resolve()
    },
    get(id) {
      return current !== undefined && current.id === id ? structuredClone(current) : undefined
    },
    save(next) {
      current = next
      this.revision += 1
      return structuredClone(next)
    },
  }
  const catalogs = {
    async get() {
      return { defaults: {} }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {
      return () => {}
    },
    get(name) {
      if (name === 'dshHomePath') return () => '.'
      return undefined
    },
    sessionController: {
      cancel() {
        return { accepted: true }
      },
    },
  }
  const engine = new WorkflowEngine(ctx, store, catalogs, {
    schedulerEnabled: false,
    ...(executeTask === undefined ? {} : { executeTask }),
    ...(executeAction === undefined ? {} : { executeAction }),
    ...engineOptions,
  })
  return { engine, store, recorded, edit: (next) => store.save(next) }
}

test('a live edit to a pending node applies when the run reaches it', async () => {
  const prompts = []
  const gates = new Map()
  const base = workflow([task('a', '任务 A', '提示词 A'), task('b', '任务 B', '提示词 B')], [['a', 'b']])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    executeTask: async ({ node }) => {
      prompts.push({ id: node.id, prompt: node.task?.prompt })
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => gates.has('a'))
  // The user rewrites task B's prompt while A is still running, then A ends.
  edit(workflow([task('a', '任务 A', '提示词 A'), task('b', '任务 B', '提示词 B（改）')], [['a', 'b']]))
  gates.get('a').resolve({ sessionId: 's-a', output: 'A 完成' })
  await waitFor(() => gates.has('b'))
  gates.get('b').resolve({ sessionId: 's-b', output: 'B 完成' })
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(
    prompts.map((entry) => entry.prompt),
    ['提示词 A', '提示词 B（改）'],
  )
  assert.equal(recorded[0].status, 'completed')
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('运行中检测到工作流修改')))
})

test('a node appended downstream mid-run executes with the latest graph', async () => {
  const order = []
  const gates = new Map()
  const base = workflow([task('a', '任务 A'), task('b', '任务 B')], [['a', 'b']])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    executeTask: async ({ node }) => {
      order.push(node.id)
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => gates.has('a'))
  edit(
    workflow(
      [task('a', '任务 A'), task('b', '任务 B'), task('c', '任务 C')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    ),
  )
  gates.get('a').resolve({ sessionId: 's-a', output: 'A' })
  await waitFor(() => gates.has('b'))
  gates.get('b').resolve({ sessionId: 's-b', output: 'B' })
  await waitFor(() => gates.has('c'))
  gates.get('c').resolve({ sessionId: 's-c', output: 'C' })
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.c.status, 'completed')
})

test('a pending node deleted mid-run leaves the run instead of blocking it', async () => {
  const gates = new Map()
  const base = workflow([task('a', '任务 A'), task('b', '任务 B'), task('c', '任务 C')], [['a', 'b'], ['a', 'c']])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    engineOptions: { liveGraphRefreshMs: 0 },
    executeTask: async ({ node }) => {
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => gates.has('a'))
  edit(workflow([task('a', '任务 A'), task('b', '任务 B')], [['a', 'b']]))
  gates.get('a').resolve({ sessionId: 's-a', output: 'A' })
  await waitFor(() => gates.has('b'))
  gates.get('b').resolve({ sessionId: 's-b', output: 'B' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.b.status, 'completed')
  assert.equal(recorded[0].nodes.c.status, 'not-run')
  assert.match(recorded[0].nodes.c.error, /删除/)
})

test('an edited node that already started is neither restarted nor re-prompted', async () => {
  const prompts = []
  const gate = deferred()
  const base = workflow([task('a', '任务 A', '原始提示词'), task('b', '任务 B')], [['a', 'b']])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    engineOptions: { liveGraphRefreshMs: 0 },
    executeTask: async ({ node }) => {
      prompts.push({ id: node.id, prompt: node.task?.prompt })
      if (node.id === 'a') await gate.promise
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => prompts.length === 1)
  edit(workflow([task('a', '任务 A', '改过的提示词'), task('b', '任务 B')], [['a', 'b']]))
  await waitFor(() => recorded.length === 0)
  gate.resolve()
  await waitFor(() => recorded.length === 1)
  assert.deepEqual(prompts.filter((entry) => entry.id === 'a').map((entry) => entry.prompt), ['原始提示词'])
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('已开始的节点保持原有设置')))
})

test('a live edit that fails validation is reported once and does not break the run', async () => {
  const gates = new Map()
  const base = workflow([task('a', '任务 A'), task('b', '任务 B')], [['a', 'b']])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    engineOptions: { liveGraphRefreshMs: 0 },
    executeTask: async ({ node }) => {
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => gates.has('a'))
  // A cycle: the definition must not be adopted mid-run.
  edit(
    workflow([task('a', '任务 A'), task('b', '任务 B')], [
      ['a', 'b'],
      ['b', 'a'],
    ]),
  )
  gates.get('a').resolve({ sessionId: 's-a', output: 'A' })
  await waitFor(() => gates.has('b'))
  gates.get('b').resolve({ sessionId: 's-b', output: 'B' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  const warnings = recorded[0].log.filter((entry) => entry.message.includes('未通过校验'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /环路/)
})

test('a delete of a waiting timer node releases the run instead of pinning it', { timeout: 8000 }, async () => {
  const gate = deferred()
  const definition = workflow(
    [task('a', '任务 A'), timerNode('t', '定时', { mode: 'once', at: Date.now() + 3600_000 }), task('b', '任务 B'), task('d', '并行任务 D')],
    [
      ['a', 't'],
      ['t', 'b'],
    ],
  )
  const started = []
  const { engine, recorded, edit } = createLiveHarness({
    definition,
    engineOptions: { liveGraphRefreshMs: 0 },
    executeTask: async ({ node }) => {
      started.push(node.id)
      if (node.id === 'd') await gate.promise
      return { sessionId: `s-${node.id}`, output: 'ok' }
    },
  })
  await engine.start(undefined, definition)
  await waitFor(() => started.includes('a'))
  // Wait until the timer really is waiting (a completed, t has no result yet).
  await waitFor(() => engine.getRun([...engine.active.keys()][0])?.nodes?.t?.timerState?.waitUntil > Date.now())
  edit(
    workflow([task('a', '任务 A'), task('b', '任务 B'), task('d', '并行任务 D')], [['a', 'b']]),
  )
  gate.resolve()
  await waitFor(() => started.includes('b'), 5000)
  await waitFor(() => recorded.length === 1, 5000)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.t.status, 'not-run')
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('已从工作流删除')))
})

test('the live probe starts a newly added node while a long task still runs', { timeout: 8000 }, async () => {
  const gates = new Map()
  const base = workflow([task('a', '任务 A')], [])
  const { engine, recorded, edit } = createLiveHarness({
    definition: base,
    engineOptions: { liveGraphRefreshMs: 10 },
    executeTask: async ({ node }) => {
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, base)
  await waitFor(() => gates.has('a'))
  // No node settles here: only the periodic store probe can notice this edit.
  edit(workflow([task('a', '任务 A'), task('c', '新增任务 C')], []))
  await waitFor(() => gates.has('c'), 5000)
  gates.get('a').resolve({ sessionId: 's-a', output: 'A' })
  gates.get('c').resolve({ sessionId: 's-c', output: 'C' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.c.status, 'completed')
})

test('deleting the start node of a run-from-node run keeps its original scope', { timeout: 8000 }, async () => {
  const gates = new Map()
  const definition = workflow(
    [task('a', '任务 A'), task('b', '任务 B'), task('c', '任务 C')],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
  )
  const { engine, recorded, edit } = createLiveHarness({
    definition,
    engineOptions: { liveGraphRefreshMs: 0 },
    executeTask: async ({ node }) => {
      const gate = deferred()
      gates.set(node.id, gate)
      return gate.promise
    },
  })
  await engine.start(undefined, definition, { startNodeId: 'b' })
  await waitFor(() => gates.has('b'))
  edit(workflow([task('a', '任务 A'), task('c', '任务 C')], [['a', 'c']]))
  gates.get('b').resolve({ sessionId: 's-b', output: 'B' })
  await waitFor(() => gates.has('c'))
  gates.get('c').resolve({ sessionId: 's-c', output: 'C' })
  await waitFor(() => recorded.length === 1)
  assert.equal(recorded[0].status, 'completed')
  assert.equal(recorded[0].nodes.a.status, 'not-run')
  assert.equal(recorded[0].nodes.b.status, 'completed')
  assert.equal(recorded[0].nodes.c.status, 'completed')
  assert.ok(recorded[0].log.some((entry) => entry.message.includes('起始节点已在运行中被删除')))
})
