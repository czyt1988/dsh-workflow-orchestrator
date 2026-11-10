/**
 * Host half of dsh-workflow-orchestrator.
 *
 * Mounts the JSON API under /workflow-orchestrator, owns the durable workflow
 * store, and runs workflows by creating real DSH task sessions through the
 * composed Session Controller. Only Cordis services are imported, so the
 * package carries no runtime dependency on the DSH packages it drives.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { WorkflowStore } from './host/store.js'
import { CatalogService } from './host/catalogs.js'
import { WorkflowEngine } from './host/engine.js'
import { createRouteHandler, ROUTE_PREFIX } from './host/routes.js'

/** Cordis plugin identity (kept equal to the package name). */
export const name = 'dsh-workflow-orchestrator'

/** Services the host half cannot work without. */
export const inject = ['webServer', 'connection', 'sessions', 'agents', 'sessionController']

/** Best-effort activation marker used by diagnostics and the install check. */
async function writeActivationMarker(ctx) {
  try {
    let home
    const dshHomePath = ctx.get('dshHomePath')
    if (typeof dshHomePath === 'function') home = dshHomePath()
    if (typeof home !== 'string' || home === '') {
      home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME.trim()
        : join(homedir(), '.dsh')
    }
    const file = join(home, 'workflow-orchestrator', 'host-loaded.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, plugin: name, loadedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    /* diagnostics only */
  }
}

/** Plugin entry. */
export function apply(ctx) {
  const store = new WorkflowStore(ctx)
  const catalogs = new CatalogService(ctx)
  const engine = new WorkflowEngine(ctx, store, catalogs)
  const handler = createRouteHandler({
    store,
    engine,
    catalogs,
    connection: ctx.connection,
  })

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    return () => {
      try {
        dispose()
      } catch {
        /* the web server may already be gone */
      }
    }
  }, 'workflow-orchestrator: JSON routes')

  ctx.effect(() => () => engine.dispose(), 'workflow-orchestrator: engine lifecycle')

  void writeActivationMarker(ctx)
  ctx.logger?.info?.(`workflow-orchestrator: mounted (${ROUTE_PREFIX})`)
}
