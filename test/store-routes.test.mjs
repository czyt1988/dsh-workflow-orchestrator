/**
 * Store and route smoke tests: durable round-trip, input sanitization, the
 * admission fence, and every JSON endpoint the panel uses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore, sanitizeWorkflow } from '../lib/host/store.js'
import { createRouteHandler } from '../lib/host/routes.js'

function fakeCtx(dir) {
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'dshHomePath') return () => dir
      return undefined
    },
  }
}

function fakeRes() {
  const result = { status: 0, headers: {}, body: '' }
  return {
    result,
    writeHead(status, headers) {
      result.status = status
      result.headers = headers ?? {}
    },
    end(body) {
      result.body = body ?? ''
    },
  }
}

function fakeReq(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'wfo-test-'))
  try {
    return await run(dir)
  } finally {
    // Store writes are queued promises; give the last atomic write a chance to
    // settle before removing the directory on Windows.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
  }
}

test('workflow definitions persist and reload', async () => {
  await withTempDir(async (dir) => {
    const store = new WorkflowStore(fakeCtx(dir))
    await store.ready()
    const saved = store.save({
      name: '阶段流水线',
      nodes: [
        { id: 'a', type: 'task', title: '阶段1', x: 40, y: 60, task: { prompt: '做阶段1', contextMode: 'full' } },
        { id: 'gw', type: 'parallel', title: '并行网关', x: 300, y: 60 },
        { id: 'c', type: 'task', title: '阶段2', x: 560, y: 60, task: { prompt: '做阶段2', contextMode: 'summary' } },
      ],
      edges: [
        { from: 'a', to: 'gw' },
        { from: 'gw', to: 'c' },
        { from: 'a', to: 'missing' },
        { from: 'a', to: 'a' },
      ],
      settings: { defaultWorkspaceId: 'ws-1' },
    })
    assert.equal(saved.nodes.length, 3)
    assert.equal(saved.edges.length, 2)
    await store.persist()
    const persisted = JSON.parse(await readFile(join(dir, 'workflow-orchestrator', 'workflows.json'), 'utf8'))
    assert.equal(persisted.workflows.length, 1)

    const reloaded = new WorkflowStore(fakeCtx(dir))
    await reloaded.ready()
    const workflow = reloaded.get(saved.id)
    assert.equal(workflow.name, '阶段流水线')
    assert.equal(workflow.nodes[0].task.prompt, '做阶段1')
    assert.equal(workflow.settings.defaultWorkspaceId, 'ws-1')
    assert.equal(reloaded.activeWorkflowId, saved.id)

    reloaded.recordRun({
      id: 'run-1',
      workflowId: saved.id,
      workflowName: saved.name,
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      nodes: { a: { id: 'a', title: '阶段1', type: 'task', status: 'completed', output: '结果', sessionId: 's-1' } },
      log: [{ time: 1, level: 'info', message: 'ok' }],
    })
    await reloaded.persist()
    const again = new WorkflowStore(fakeCtx(dir))
    await again.ready()
    assert.equal(again.runs()[0].nodes.a.output, '结果')
    assert.equal(again.remove(saved.id), true)
    assert.equal(again.workflows().length, 0)
  })
})

test('sanitizeWorkflow repairs hostile input', () => {
  const workflow = sanitizeWorkflow({
    id: 'wf',
    name: '   ',
    nodes: [
      { id: 'n1', type: 'task', title: '', x: 'not-a-number', y: 20, task: { prompt: 'x', contextMode: 'bogus' } },
      { id: 'n1', type: 'also-bogus' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    settings: { defaultWorkspaceId: 42 },
  })
  assert.equal(workflow.name, '未命名工作流')
  assert.equal(workflow.nodes[0].x, 0)
  assert.equal(workflow.nodes[0].task.contextMode, 'full')
  assert.notEqual(workflow.nodes[1].id, 'n1')
  assert.equal(workflow.edges.length, 0)
  assert.deepEqual(workflow.settings, {})
})

test('sanitizeWorkflow keeps valid workspace colors and drops hostile entries', () => {
  const workflow = sanitizeWorkflow({
    id: 'wf-colors',
    name: '配色',
    nodes: [],
    edges: [],
    settings: {
      defaultWorkspaceId: 'ws-1',
      workspaceColors: {
        'ws-1': '#ABCDEF',
        'ws-2': '#0f0',
        'ws-bad': 'red',
        '': '#123456',
        'ws-3': 42,
        'ws-4': '#1234567',
      },
    },
  })
  assert.deepEqual(workflow.settings, {
    defaultWorkspaceId: 'ws-1',
    workspaceColors: { 'ws-1': '#abcdef', 'ws-2': '#00ff00' },
  })
  const many = {}
  for (let index = 0; index < 50; index += 1) many[`ws-${index}`] = '#112233'
  const limited = sanitizeWorkflow({ name: '上限', settings: { workspaceColors: many } })
  assert.equal(Object.keys(limited.settings.workspaceColors).length, 40)
})

test('run history keeps the start node and not-run statuses', async () => {
  await withTempDir(async (dir) => {
    const store = new WorkflowStore(fakeCtx(dir))
    await store.ready()
    const saved = store.save({
      name: '范围运行',
      nodes: [
        { id: 'a', type: 'task', title: '任务 A', x: 0, y: 0, task: { prompt: 'a' } },
        { id: 'b', type: 'task', title: '任务 B', x: 200, y: 0, task: { prompt: 'b' } },
      ],
      edges: [],
    })
    store.recordRun({
      id: 'run-scope',
      workflowId: saved.id,
      workflowName: saved.name,
      startNodeId: 'b',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      nodes: {
        a: { id: 'a', title: '任务 A', type: 'task', status: 'not-run' },
        b: { id: 'b', title: '任务 B', type: 'task', status: 'completed', output: 'ok' },
      },
      log: [],
    })
    await store.persist()
    const reloaded = new WorkflowStore(fakeCtx(dir))
    await reloaded.ready()
    const run = reloaded.runs()[0]
    assert.equal(run.startNodeId, 'b')
    assert.equal(run.nodes.a.status, 'not-run')
    assert.equal(run.nodes.b.status, 'completed')
  })
})

test('routes answer state, create, save, run, stop and enforce admission', async () => {
  await withTempDir(async (dir) => {
    const store = new WorkflowStore(fakeCtx(dir))
    await store.ready()
    let rejection
    const connection = {
      requestRejection() {
        return rejection
      },
    }
    const started = []
    const engine = {
      snapshot() {
        return { running: [], runs: [] }
      },
      snapshotRuns() {
        return []
      },
      getRun() {
        return undefined
      },
      async start(workflowId, workflow, options) {
        started.push({ workflowId, workflow, options })
        return { id: 'run-x', workflowId, status: 'running', startNodeId: options?.startNodeId ?? null, log: [], nodes: {} }
      },
      stop() {
        return { id: 'run-x', workflowId: 'wf', status: 'cancelled', log: [], nodes: {} }
      },
    }
    const catalogs = {
      async get() {
        return {
          workspaces: [{ id: 'ws-1', title: '项目', path: 'C:/project' }],
          agentPresets: [{ id: 'standard', name: '标准', isDefault: true }],
          permissions: [{ value: 'danger-full-access', name: '完全权限' }],
          modelProviders: [],
          modelFailures: [],
          defaults: { workspaceId: 'ws-1', agentPreset: 'standard', permissionPreset: 'danger-full-access' },
          problems: [],
        }
      },
    }
    const handler = createRouteHandler({ store, engine, catalogs, connection })

    const call = async (method, path, body) => {
      const res = fakeRes()
      await handler(fakeReq(method, `/workflow-orchestrator${path}`, body), res)
      return { status: res.result.status, payload: res.result.body === '' ? undefined : JSON.parse(res.result.body) }
    }

    rejection = { status: 401 }
    const forbidden = await call('GET', '/api/state')
    assert.equal(forbidden.status, 403)
    rejection = undefined

    const empty = await call('GET', '/api/state')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.payload.value.workflows, [])
    assert.equal(empty.payload.value.catalogs.defaults.workspaceId, 'ws-1')

    const created = await call('POST', '/api/create', { name: '我的工作流' })
    assert.equal(created.status, 200)
    const workflowId = created.payload.value.workflow.id
    assert.equal(created.payload.value.workflow.settings.defaultWorkspaceId, 'ws-1')

    const saved = await call('POST', '/api/save', {
      workflow: {
        id: workflowId,
        name: '我的工作流',
        nodes: [{ id: 'a', type: 'task', title: '任务 1', x: 10, y: 10, task: { prompt: 'hello' } }],
        edges: [],
      },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.value.workflow.nodes.length, 1)

    const run = await call('POST', '/api/run', { workflowId })
    assert.equal(run.status, 200)
    assert.equal(run.payload.value.run.id, 'run-x')
    assert.equal(started.length, 1)
    assert.equal(started[0].workflowId, workflowId)
    assert.equal(started[0].options?.startNodeId, undefined)

    const scoped = await call('POST', '/api/run', { workflowId, startNodeId: 'node-a' })
    assert.equal(scoped.status, 200)
    assert.equal(scoped.payload.value.run.startNodeId, 'node-a')
    assert.equal(started[1].options.startNodeId, 'node-a')
    const invalidStart = await call('POST', '/api/run', { workflowId, startNodeId: 42 })
    assert.equal(invalidStart.status, 400)
    assert.match(invalidStart.payload.error.message, /起始节点 ID 无效/)
    assert.equal(started.length, 2)

    const stop = await call('POST', '/api/stop', { runId: 'run-x', cancelTasks: true })
    assert.equal(stop.status, 200)

    const unknown = await call('GET', '/api/nope')
    assert.equal(unknown.status, 404)
    const badMethod = await call('PUT', '/api/state')
    assert.equal(badMethod.status, 405)
  })
})
