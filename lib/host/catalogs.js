/**
 * Live option catalogs for the inspector.
 *
 * The right-hand property panel mirrors the DSH new-task composer: workspace,
 * agent preset ("mode"), permission preset and model are all read from the
 * running Host instead of being hard-coded here. One short-lived cache keeps a
 * polling panel from probing the model registry on every tick.
 */
const CACHE_TTL_MS = 60_000

/** Human-friendly fallbacks for the shipped permission preset keys. */
const PERMISSION_LABELS = {
  'danger-full-access': '完全权限',
  'workspace-write': '工作区写入',
  'read-only': '只读',
  auto: '自动审查',
  custom: '自定义',
}

/** Human-friendly fallbacks for the shipped agent preset ids. */
const AGENT_PRESET_LABELS = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  creator: '创作模式',
  cordis: 'Cordis 模式',
}

/** Read one service method without letting a missing peer break the catalog. */
async function readSection(problems, name, read, fallback) {
  try {
    const value = await read()
    if (value === undefined || value === null) throw new Error('service unavailable')
    return value
  } catch (error) {
    problems.push({ section: name, message: String(error?.message ?? error) })
    return fallback
  }
}

/** Normalize the workspace registry rows. */
function workspaceRows(registry) {
  const list = typeof registry?.list === 'function' ? registry.list() : []
  return (Array.isArray(list) ? list : []).map((workspace) => ({
    id: String(workspace.id),
    title: typeof workspace.title === 'string' ? workspace.title : String(workspace.id),
    path: typeof workspace.path === 'string' ? workspace.path : '',
  }))
}

/** Normalize the agent-preset roster rows. */
function presetRows(roster) {
  const rows = Array.isArray(roster?.presets) ? roster.presets : []
  return rows
    .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && !row.broken)
    .map((row) => {
      const fallbackName = AGENT_PRESET_LABELS[row.id]
      const published = typeof row.name === 'string' && row.name !== '' && row.name !== row.id ? row.name : undefined
      return {
        id: row.id,
        name: published ?? fallbackName ?? row.id,
        description: typeof row.description === 'string' ? row.description : undefined,
        isDefault: row.isDefault === true,
      }
    })
}

/** Normalize the permission-preset catalog. */
function permissionRows(catalog) {
  const options = Array.isArray(catalog?.options) ? catalog.options : []
  return {
    options: options
      .filter((option) => option !== null && typeof option === 'object' && typeof option.value === 'string')
      .map((option) => {
        const published = typeof option.name === 'string' && option.name !== '' && option.name !== option.value ? option.name : undefined
        return {
          value: option.value,
          name: published ?? PERMISSION_LABELS[option.value] ?? option.value,
          description: typeof option.description === 'string' ? option.description : undefined,
        }
      }),
    defaultPreset: typeof catalog?.defaultPreset === 'string' ? catalog.defaultPreset : undefined,
  }
}

/** Normalize the model catalog into provider groups with one flat lookup. */
function modelRows(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const providers = groups
    .filter((group) => group !== null && typeof group === 'object' && Array.isArray(group.models))
    .map((group) => ({
      id: String(group.id),
      name: typeof group.name === 'string' && group.name !== '' ? group.name : String(group.id),
      models: group.models
        .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string')
        .map((model) => ({
          id: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          reasoningEfforts: Array.isArray(model.reasoning?.efforts)
            ? model.reasoning.efforts
                .filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string')
                .map((effort) => ({ id: effort.id, name: typeof effort.name === 'string' ? effort.name : effort.id }))
            : [],
          defaultEffort: typeof model.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : undefined,
        })),
    }))
  const defaults = catalog?.default
  return {
    providers,
    default:
      defaults !== null && typeof defaults === 'object' && typeof defaults.provider === 'string' && typeof defaults.model === 'string'
        ? { provider: defaults.provider, model: defaults.model }
        : undefined,
    failures: Array.isArray(catalog?.failures)
      ? catalog.failures.map((failure) => ({
          id: String(failure?.id ?? ''),
          name: String(failure?.name ?? failure?.id ?? ''),
          message: String(failure?.message ?? ''),
        }))
      : [],
  }
}

/** One catalog snapshot served to the panel. */
export class CatalogService {
  constructor(ctx) {
    this.ctx = ctx
    this.cached = undefined
    this.cachedAt = 0
    this.pending = undefined
  }

  /** Build (or reuse) the complete option snapshot. */
  async get({ force = false } = {}) {
    const fresh = this.cached !== undefined && Date.now() - this.cachedAt < CACHE_TTL_MS
    if (fresh && !force) return this.cached
    if (this.pending !== undefined) return this.pending
    this.pending = this.build().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  async build() {
    const problems = []
    const workspaceRegistry = this.ctx.get('workspaceRegistry')
    const agentPresets = this.ctx.get('agentPresets')
    const permissionPresets = this.ctx.get('permissionPresets')
    const sessionController = this.ctx.get('sessionController')

    const workspaceResult = await readSection(
      problems,
      'workspaces',
      async () => workspaceRows(workspaceRegistry),
      [],
    )
    const presetResult = await readSection(
      problems,
      'agentPresets',
      async () => presetRows(await agentPresets.remoteExportList()),
      [],
    )
    const permissionResult = await readSection(
      problems,
      'permissions',
      async () => permissionRows(permissionPresets.catalog()),
      { options: [] },
    )
    const modelResult = await readSection(
      problems,
      'models',
      async () => modelRows(await sessionController.modelCatalog()),
      { providers: [], failures: [] },
    )

    const defaultWorkspaceId = workspaceResult[0]?.id
    const defaultAgentPreset = presetResult.find((preset) => preset.isDefault)?.id ?? presetResult[0]?.id
    const fullAccess = permissionResult.options.find((option) => option.value === 'danger-full-access')
    const defaultPermissionPreset = fullAccess?.value ?? permissionResult.defaultPreset ?? permissionResult.options[0]?.value
    const defaultModel = modelResult.default

    this.cached = {
      workspaces: workspaceResult,
      agentPresets: presetResult,
      permissions: permissionResult.options,
      modelProviders: modelResult.providers,
      modelFailures: modelResult.failures,
      defaults: {
        workspaceId: defaultWorkspaceId,
        agentPreset: defaultAgentPreset,
        permissionPreset: defaultPermissionPreset,
        model: defaultModel,
      },
      problems,
      fetchedAt: Date.now(),
    }
    this.cachedAt = Date.now()
    return this.cached
  }
}
