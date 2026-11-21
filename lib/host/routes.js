/**
 * The plugin's own JSON routes, mounted as one prefix on the host web server:
 *
 *   GET  /workflow-orchestrator/api/state?refresh=1
 *   GET  /workflow-orchestrator/api/run?runId=...
 *   GET  /workflow-orchestrator/api/periodic
 *   GET  /workflow-orchestrator/api/tasks
 *   POST /workflow-orchestrator/api/create    { name, workspaceId? }
 *   POST /workflow-orchestrator/api/save      { workflow }
 *   POST /workflow-orchestrator/api/delete    { workflowId }
 *   POST /workflow-orchestrator/api/active    { workflowId }
 *   POST /workflow-orchestrator/api/run       { workflowId, workflow?, startNodeId? }
 *   POST /workflow-orchestrator/api/stop      { runId?, cancelTasks? }
 *
 * Every route passes the host's own browser-trust/admission fence first, so the
 * panel never needs a second authentication scheme.
 */
import { errorMessage } from './util.js'

export const ROUTE_PREFIX = '/workflow-orchestrator'
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Write one JSON response. */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read one bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/** Assemble the complete state the panel bootstraps from. */
async function buildState({ store, engine, catalogs }, { refresh = false } = {}) {
  await store.ready()
  const optionCatalog = await catalogs.get({ force: refresh }).catch((error) => ({
    workspaces: [],
    agentPresets: [],
    permissions: [],
    modelProviders: [],
    modelFailures: [],
    defaults: {},
    problems: [{ section: 'catalogs', message: errorMessage(error) }],
    fetchedAt: Date.now(),
  }))
  return {
    workflows: store.workflows(),
    activeWorkflowId: store.activeWorkflowId,
    catalogs: optionCatalog,
    engine: engine.snapshot(),
  }
}

/** One route handler for the whole prefix. */
export function createRouteHandler({ store, engine, catalogs, connection }) {
  return async function handle(req, res) {
    let rejection
    try {
      rejection = connection?.requestRejection?.(req)
    } catch (error) {
      rejection = error
    }
    if (rejection !== undefined) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request rejected by the host connection policy' } })
      return
    }

    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const subpath = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (subpath === '/api/health' && method === 'GET') {
        writeJson(res, 200, { ok: true, value: { pid: process.pid, version: 1 } })
        return
      }
      if (subpath === '/api/state' && method === 'GET') {
        const refresh = url.searchParams.get('refresh') === '1'
        writeJson(res, 200, { ok: true, value: await buildState({ store, engine, catalogs }, { refresh }) })
        return
      }
      if (subpath === '/api/run' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? undefined
        const run = runId === undefined ? engine.snapshotRuns().slice(-1)[0] : engine.getRun(runId)
        writeJson(res, 200, { ok: true, value: { run: run ?? null, engine: engine.snapshot() } })
        return
      }
      if (subpath === '/api/periodic' && method === 'GET') {
        // Recompute from the current store so the sidebar badge and banner see
        // edits immediately instead of waiting for the next scheduler tick.
        if (typeof engine.refreshSchedulerSummary === 'function') await engine.refreshSchedulerSummary()
        const summary = typeof engine.schedulerSnapshot === 'function' ? engine.schedulerSnapshot() : {}
        writeJson(res, 200, { ok: true, value: summary })
        return
      }
      if (subpath === '/api/tasks' && method === 'GET') {
        const tasks = typeof engine.listWaitCandidates === 'function' ? await engine.listWaitCandidates() : []
        writeJson(res, 200, { ok: true, value: { tasks } })
        return
      }
      const GET_ONLY_ROUTES = new Set(['/api/health', '/api/state', '/api/periodic', '/api/tasks'])
      if (GET_ONLY_ROUTES.has(subpath)) {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const POST_ROUTES = new Set([
        '/api/create',
        '/api/save',
        '/api/delete',
        '/api/active',
        '/api/run',
        '/api/stop',
      ])
      if (!POST_ROUTES.has(subpath)) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${subpath}` } })
        return
      }
      if (method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }

      const body = await readJsonBody(req)
      if (subpath === '/api/create') {
        await store.ready()
        const optionCatalog = await catalogs.get().catch(() => undefined)
        const workspaceId =
          typeof body.workspaceId === 'string' && body.workspaceId !== ''
            ? body.workspaceId
            : optionCatalog?.defaults?.workspaceId
        const workflow = store.save({
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '未命名工作流',
          nodes: [],
          edges: [],
          settings: typeof workspaceId === 'string' && workspaceId !== '' ? { defaultWorkspaceId: workspaceId } : {},
        })
        store.setActive(workflow.id)
        writeJson(res, 200, { ok: true, value: { workflow, activeWorkflowId: store.activeWorkflowId } })
        return
      }
      if (subpath === '/api/save') {
        await store.ready()
        const workflow = store.save(body.workflow)
        writeJson(res, 200, { ok: true, value: { workflow } })
        return
      }
      if (subpath === '/api/delete') {
        await store.ready()
        if (typeof body.workflowId !== 'string') throw new Error('缺少 workflowId')
        const removed = store.remove(body.workflowId)
        writeJson(res, 200, { ok: true, value: { removed, activeWorkflowId: store.activeWorkflowId } })
        return
      }
      if (subpath === '/api/active') {
        await store.ready()
        if (typeof body.workflowId !== 'string') throw new Error('缺少 workflowId')
        store.setActive(body.workflowId)
        writeJson(res, 200, { ok: true, value: { activeWorkflowId: store.activeWorkflowId } })
        return
      }
      if (subpath === '/api/run') {
        await store.ready()
        if (typeof body.workflowId !== 'string' && body.workflow === undefined) throw new Error('缺少 workflowId')
        let startNodeId
        if (body.startNodeId !== undefined && body.startNodeId !== null) {
          if (typeof body.startNodeId !== 'string') throw new Error('起始节点 ID 无效')
          startNodeId = body.startNodeId
        }
        const run = await engine.start(body.workflowId, body.workflow, { startNodeId })
        writeJson(res, 200, { ok: true, value: { run, engine: engine.snapshot() } })
        return
      }
      if (subpath === '/api/stop') {
        const run = engine.stop(
          typeof body.runId === 'string' ? body.runId : undefined,
          { cancelTasks: body.cancelTasks === true },
        )
        writeJson(res, 200, { ok: true, value: { run, engine: engine.snapshot() } })
        return
      }
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${subpath}` } })
    } catch (error) {
      writeJson(res, 400, { ok: false, error: { code: 'workflow-error', message: errorMessage(error) } })
    }
  }
}
