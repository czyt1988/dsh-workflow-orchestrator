/**
 * Scheduling tests for the workflow engine, using the executor test seam so no
 * DSH host is needed: the graph semantics (parallel start, sequential edges,
 * gateway join, failure cascade, the two stop modes) are what is verified.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowEngine, validateWorkflow, composePrompt, upstreamTaskNodes } from '../lib/host/engine.js'

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
