/**
 * Full end-to-end verification of dsh-workflow-orchestrator against a REAL,
 * isolated DSH web host.
 *
 *   node tools/e2e-full.cjs [--port 58611] [--keep-server]
 *
 * The script is repeatable: it bootstraps an isolated DSH home/profile under
 * `.e2e-home/`, links the workspace plugin into that profile, starts its own
 * `dsh web` process (never the user's GUI, never ports 58398/58422), drives a
 * real Chromium through Playwright, writes screenshots + assertion logs to
 * `.e2e/`, and stops the host again unless --keep-server is passed.
 *
 * It never modifies lib/, package.json or README; everything it writes lives
 * under .e2e-home/, .e2e/ and tools/.
 *
 * 本机相关配置全部通过环境变量提供（都不提交进仓库）：
 *
 *   DSH_BIN                   @deepseek-ai/dsh/lib/bin.js 的绝对路径（默认按模块解析）
 *   DSH_E2E_PLAYWRIGHT_CORE   playwright-core 包目录（默认按模块名解析）
 *   CHROME_PATH               Chromium/Chrome 可执行文件（默认使用 Playwright 自带浏览器）
 *   DSH_E2E_PROVIDER          模型 provider id（默认 e2e）
 *   DSH_E2E_PROVIDER_DISPLAY  模型 provider 显示名（默认 E2E）
 *   DSH_E2E_MODEL             模型 id（默认 e2e-model）
 *   DSH_E2E_BASE_URL          模型网关 baseURL（默认 https://api.example.com/v1）
 *   DSH_E2E_API_KEY_ENV       API Key 所在环境变量名（默认 DSH_E2E_API_KEY）
 *   DSH_E2E_CREDENTIALS       可选：复制进隔离 home 的 .credentials.yaml 路径
 */
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')

/** 从模块名或 DSH_E2E_PLAYWRIGHT_CORE 解析 playwright-core。 */
function loadPlaywright() {
  const candidates = [process.env.DSH_E2E_PLAYWRIGHT_CORE, 'playwright-core', 'playwright']
  const errors = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      return require(candidate)
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`)
    }
  }
  throw new Error(`无法加载 playwright-core：请先安装，或用 DSH_E2E_PLAYWRIGHT_CORE 指定包路径。\n${errors.join('\n')}`)
}

const { chromium } = loadPlaywright()

const ROOT = path.resolve(__dirname, '..')
const HOME = path.join(ROOT, '.e2e-home')
const OUT = path.join(ROOT, '.e2e')
const PROFILE = path.join(HOME, 'profiles', 'web')
const PLUGIN_SRC = ROOT
const CHROME = process.env.CHROME_PATH || undefined
const E2E_PROVIDER = process.env.DSH_E2E_PROVIDER || 'e2e'
const E2E_PROVIDER_DISPLAY = process.env.DSH_E2E_PROVIDER_DISPLAY || 'E2E'
const E2E_MODEL = process.env.DSH_E2E_MODEL || 'e2e-model'
const E2E_BASE_URL = process.env.DSH_E2E_BASE_URL || 'https://api.example.com/v1'
const E2E_API_KEY_ENV = process.env.DSH_E2E_API_KEY_ENV || 'DSH_E2E_API_KEY'
const PROMPT_SHORT = '只回复两个字：完成'

/** 解析 DSH CLI 入口；延迟到真正启动时再要求环境，方便先看用法。 */
let cachedDshBin
function dshBin() {
  if (cachedDshBin !== undefined) return cachedDshBin
  const configured = process.env.DSH_BIN
  if (typeof configured === 'string' && configured !== '') {
    cachedDshBin = configured
    return cachedDshBin
  }
  try {
    cachedDshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    try {
      const packageFile = require.resolve('@deepseek-ai/dsh/package.json')
      cachedDshBin = path.join(path.dirname(packageFile), 'lib', 'bin.js')
      if (!fs.existsSync(cachedDshBin)) throw new Error('lib/bin.js not found')
    } catch {
      throw new Error('找不到 DSH CLI：请设置 DSH_BIN 指向 @deepseek-ai/dsh/lib/bin.js。')
    }
  }
  return cachedDshBin
}

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const KEEP_SERVER = argv.includes('--keep-server')
const PREFERRED_PORT = Number(argValue('--port', '58611'))

const checks = []
const consoleErrors = []
const pageErrors = []
const artifacts = []
let serverProcess = null
let serverPort = null
let browser = null
let page = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nowIso = () => new Date().toISOString()

function check(group, name, pass, detail) {
  checks.push({ group, name, pass: !!pass, detail: detail === undefined ? null : detail })
  const mark = pass ? 'PASS' : 'FAIL'
  const line = `[${mark}] ${group}: ${name}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`
  console.log(line)
  try {
    fs.appendFileSync(path.join(OUT, 'e2e-run.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* logging is best effort */
  }
  return !!pass
}

function step(name) {
  const line = `${new Date().toISOString()} STEP ${name}`
  console.log(`--- ${line}`)
  try {
    fs.appendFileSync(path.join(OUT, 'e2e-run.log'), `${line}\n`, 'utf8')
  } catch {
    /* logging is best effort */
  }
}

function writeText(name, text) {
  const file = path.join(OUT, name)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  artifacts.push(file)
  return file
}

function writeEvidence(name, value) {
  return writeText(name.endsWith('.txt') ? name : `${name}.txt`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

function sessionFiles() {
  return walkFiles(path.join(HOME, 'sessions')).filter((file) => /session\.v\d+\.jsonl\.zstd$/.test(file))
}

function removeLink(link) {
  try {
    const stat = fs.lstatSync(link)
    if (stat.isSymbolicLink()) fs.unlinkSync(link)
    else fs.rmSync(link, { recursive: true, force: true })
  } catch {
    /* absent */
  }
}

function ensureJunction(link, target) {
  if (fs.existsSync(link)) {
    const stat = fs.lstatSync(link)
    if (stat.isSymbolicLink()) {
      try {
        if (path.resolve(fs.readlinkSync(link)) === path.resolve(target)) return
      } catch {
        /* re-create below */
      }
      fs.unlinkSync(link)
    } else {
      fs.rmSync(link, { recursive: true, force: true })
    }
  }
  const created = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
  if (created.status !== 0) throw new Error(`mklink failed for ${link}: ${created.stderr || created.stdout}`)
}

const PROFILE_PATCH = `# E2E isolated profile patch (managed by tools/e2e-full.cjs; do not reuse).
- id: llm-pi-ai
  config:
    providers:
      ${E2E_PROVIDER}:
        displayName: ${E2E_PROVIDER_DISPLAY}
        api: openai-completions
        baseURL: ${E2E_BASE_URL}
        apiKeyEnv: ${E2E_API_KEY_ENV}
        models:
          - id: ${E2E_MODEL}
            name: ${E2E_MODEL}
- id: agent-default-model
  config:
    provider: ${E2E_PROVIDER}
    model: ${E2E_MODEL}
- id: permission
  config:
    defaultPreset: danger-full-access
`

const PROFILE_PACKAGE = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-workflow-orchestrator'] } },
}

function bootstrapEnvironment() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'e2e-run.log'), '', 'utf8')
  const log = []
  log.push(`time: ${nowIso()}`)
  log.push(`root: ${ROOT}`)
  log.push(`home: ${HOME}`)

  const credentials = path.join(HOME, '.credentials.yaml')
  const credentialsSource = process.env.DSH_E2E_CREDENTIALS
  if (!fs.existsSync(credentials)) {
    if (typeof credentialsSource === 'string' && credentialsSource !== '' && fs.existsSync(credentialsSource)) {
      fs.copyFileSync(credentialsSource, credentials)
      log.push('credentials: copied from DSH_E2E_CREDENTIALS (content not read)')
    } else {
      log.push('credentials: not provided; relying on DSH_E2E_* env or ambient credentials')
    }
  } else {
    log.push('credentials: already present in isolated home')
  }

  if (!fs.existsSync(path.join(PROFILE, 'package.json'))) {
    log.push('profile: bootstrapping template via --dump-config')
    const result = spawnSync(process.execPath, [dshBin(), '--profile', 'web', '--dump-config'], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: HOME, DSH_PROFILE_DIR: PROFILE },
      encoding: 'utf8',
      timeout: 180000,
    })
    if (result.status !== 0) throw new Error(`dump-config failed: ${result.stderr || result.stdout}`)
    log.push('profile: template initialized')
  } else {
    log.push('profile: already initialized')
  }

  fs.writeFileSync(path.join(PROFILE, 'cordis.patch.yml'), PROFILE_PATCH, 'utf8')
  fs.writeFileSync(path.join(PROFILE, 'package.json'), JSON.stringify(PROFILE_PACKAGE, null, 2) + '\n', 'utf8')
  log.push('profile: patch + bundle entry written')

  fs.mkdirSync(path.join(PROFILE, 'node_modules'), { recursive: true })
  ensureJunction(path.join(PROFILE, 'node_modules', 'dsh-workflow-orchestrator'), PLUGIN_SRC)
  removeLink(path.join(PROFILE, 'node_modules', 'e2e-diag-exec'))
  removeLink(path.join(PROFILE, 'node_modules', 'e2e-compat-shim'))
  log.push('profile: plugin junction ready (diagnostics junctions removed)')

  const stateFile = path.join(HOME, 'workflow-orchestrator', 'workflows.json')
  if (fs.existsSync(stateFile)) fs.rmSync(stateFile)
  fs.rmSync(path.join(HOME, 'shim-calls.log'), { force: true })
  log.push('state: workflow store cleared for a repeatable run')
  writeText('00-setup.txt', log.join('\n') + '\n')
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 40; port += 1) {
    if (await checkPortFree(port)) return port
  }
  throw new Error('no free port found')
}

function stopServer() {
  if (serverProcess === null) {
    const pidFile = path.join(HOME, 'web.pid')
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (Number.isFinite(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    }
    return
  }
  try {
    spawnSync('taskkill', ['/PID', String(serverProcess.pid), '/T', '/F'], { encoding: 'utf8' })
  } catch {
    /* best effort */
  }
  serverProcess = null
}

async function startServer() {
  stopServer()
  await sleep(1500)
  serverPort = await pickPort()
  const stdout = path.join(HOME, 'web-stdout.log')
  const stderr = path.join(HOME, 'web-stderr.log')
  fs.rmSync(stdout, { force: true })
  fs.rmSync(stderr, { force: true })
  const out = fs.openSync(stdout, 'a')
  const err = fs.openSync(stderr, 'a')
  serverProcess = spawn(process.execPath, [dshBin(), '--profile', 'web', '--port', String(serverPort), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME, DSH_PROFILE_DIR: PROFILE },
    stdio: ['ignore', out, err],
    windowsHide: true,
  })
  fs.writeFileSync(path.join(HOME, 'web.pid'), String(serverProcess.pid), 'ascii')

  let url = null
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await sleep(1000)
    const text = `${fs.existsSync(stdout) ? fs.readFileSync(stdout, 'utf8') : ''}\n${fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8') : ''}`
    const found = text.match(/https?:\/\/\S+token=\S+/)
    if (found) {
      url = found[0].trim()
      break
    }
    if (serverProcess.exitCode !== null) {
      throw new Error(`dsh web exited early (code ${serverProcess.exitCode}): ${text.slice(-2000)}`)
    }
  }
  if (url === null) throw new Error(`dsh web did not print a token URL: ${fs.readFileSync(stderr, 'utf8').slice(-2000)}`)
  fs.writeFileSync(path.join(HOME, 'web-url.txt'), url, 'utf8')
  fs.appendFileSync(path.join(OUT, '00-setup.txt'), `server: pid=${serverProcess.pid} port=${serverPort}\nurl: ${url}\n`, 'utf8')
  return url
}

// ---------------------------------------------------------------------------
// browser helpers
// ---------------------------------------------------------------------------
async function api(method, name, body) {
  const result = await page.evaluate(async ({ method, name, body }) => {
    const response = await fetch(`workflow-orchestrator/api/${name}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    return { status: response.status, payload }
  }, { method, name, body })
  if (result.status !== 200 || result.payload?.ok !== true) {
    throw new Error(`API ${method} ${name} -> ${result.status} ${JSON.stringify(result.payload)}`)
  }
  return result.payload.value
}

async function apiState() {
  return api('GET', 'state')
}

async function screenshot(name) {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  artifacts.push(file)
  return file
}

async function openPanel() {
  if (await page.locator('.wfo-root').count()) {
    await page.waitForSelector('.wfo-root .wfo-toolbar', { timeout: 30000 })
    return
  }
  const clicked = await page.evaluate(() => {
    const leaves = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent.trim() === '工作流编排' && el.closest('.wfo-root') === null,
    )
    const target = leaves[0]
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  if (!clicked) {
    await page.getByText('工作流编排', { exact: true }).first().click({ timeout: 15000 })
  }
  await page.waitForSelector('.wfo-root', { timeout: 30000 })
  await page.waitForSelector('.wfo-root .wfo-toolbar', { timeout: 30000 })
}

async function waitPastResumePrompt() {
  for (const label of ['继续', '继续使用', 'Continue']) {
    const locator = page.getByRole('button', { name: label, exact: false })
    if ((await locator.count()) > 0) {
      try {
        await locator.first().click({ timeout: 1500 })
        await page.waitForTimeout(1000)
      } catch {
        /* no resume dialog */
      }
    }
  }
}

async function waitFor(fn, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = error
    }
    await page.waitForTimeout(intervalMs)
  }
  throw new Error(`timeout waiting for ${label} (last=${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

async function activeWorkflowId() {
  return page.evaluate(() => {
    const select = document.querySelector('.wfo-toolbar select')
    return select === null ? null : select.value
  })
}

async function workflowState(workflowId) {
  const state = await apiState()
  return state.workflows.find((workflow) => workflow.id === workflowId) ?? null
}

async function waitSaved(workflowId, predicate, label) {
  return waitFor(async () => {
    const workflow = await workflowState(workflowId)
    return workflow !== null && predicate(workflow) ? workflow : null
  }, 20000, 300, `autosave ${label}`)
}

async function getRun(workflowId) {
  const state = await apiState()
  const runs = (state.engine?.runs ?? []).filter((run) => run.workflowId === workflowId)
  return runs.length === 0 ? null : runs[runs.length - 1]
}

async function waitTerminalRun(workflowId, timeoutMs = 300000) {
  return waitFor(async () => {
    const run = await getRun(workflowId)
    if (run === null) return null
    return run.status !== 'running' ? run : null
  }, timeoutMs, 400, 'run terminal state')
}

async function logText() {
  return page.evaluate(() => document.querySelector('.wfo-log')?.innerText ?? '')
}

async function canvasNodes() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.wfo-node')].map((node) => ({
      cls: node.className,
      left: Number.parseFloat(node.style.left),
      top: Number.parseFloat(node.style.top),
      title: node.querySelector('.wfo-node-title')?.textContent ?? '',
      status: node.querySelector('.wfo-node-status')?.textContent ?? '',
      text: node.innerText,
    })),
  )
}

async function clickNode(index) {
  await page.locator('.wfo-node').nth(index).click({ position: { x: 90, y: 22 }, timeout: 15000 })
  await page.waitForTimeout(400)
}

async function setPromptForNode(index, text) {
  await clickNode(index)
  const textarea = page.locator('.wfo-inspector textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 15000 })
  await textarea.fill(text)
  await page.waitForTimeout(700)
}

async function dragPaletteTo(index, point) {
  const item = page.locator('.wfo-pal-item').nth(index)
  const itemBox = await item.boundingBox()
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2)
  await page.mouse.down()
  const steps = 14
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    await page.mouse.move(
      itemBox.x + itemBox.width / 2 + (point.x - (itemBox.x + itemBox.width / 2)) * t,
      itemBox.y + itemBox.height / 2 + (point.y - (itemBox.y + itemBox.height / 2)) * t,
    )
    await page.waitForTimeout(35)
  }
  await page.mouse.up()
  await page.waitForTimeout(900)
}

/** Drag one palette card onto the canvas and verify the node count grew. */
async function dragPaletteAndVerify(index, point) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = await page.locator('.wfo-node').count()
    await dragPaletteTo(index, point)
    await page.waitForTimeout(400)
    const after = await page.locator('.wfo-node').count()
    if (after === before + 1) return after
    step(`palette drag retry ${attempt} (before=${before}, after=${after})`)
    await page.waitForTimeout(600)
  }
  throw new Error(`palette drag #${index} did not add a node after 4 attempts`)
}

async function canvasPoint(fx, fy) {
  const box = await page.locator('.wfo-canvas-wrap').boundingBox()
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

async function connectNodes(fromIndex, toIndex) {
  const outPort = page.locator('.wfo-node').nth(fromIndex).locator('.wfo-port.out')
  const inPort = page.locator('.wfo-node').nth(toIndex).locator('.wfo-port.in')
  const a = await outPort.boundingBox()
  const b = await inPort.boundingBox()
  if (a === null || b === null) throw new Error(`missing ports for connect ${fromIndex}->${toIndex}`)
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let step = 0; step <= 18; step += 1) {
    const t = step / 18
    await page.mouse.move(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t)
    await page.waitForTimeout(25)
  }
  await page.mouse.up()
  await page.waitForTimeout(900)
}

async function clickToolbar(label) {
  const button = page.locator('.wfo-toolbar button').filter({ hasText: label }).first()
  await button.waitFor({ state: 'visible', timeout: 15000 })
  await button.click()
  await page.waitForTimeout(500)
}

/** Create a new workflow and wait until its empty canvas is the rendered one. */
async function createNewWorkflow() {
  const previousId = await activeWorkflowId()
  await clickToolbar('新建')
  const activeId = await waitFor(async () => {
    const currentId = await activeWorkflowId()
    if (currentId === null || currentId === previousId) return null
    const workflow = await workflowState(currentId)
    if (workflow === null || workflow.nodes.length !== 0) return null
    const rendered = await page.locator('.wfo-node').count()
    return rendered === 0 ? currentId : null
  }, 25000, 300, 'new empty workflow')
  await page.waitForTimeout(600)
  return activeId
}

async function inspectorState() {
  return page.evaluate(() => {
    const inspector = document.querySelector('.wfo-inspector')
    if (inspector === null) return null
    const fields = [...inspector.querySelectorAll('.wfo-field')].map((fieldWrap) => {
      const label = fieldWrap.querySelector('label')?.innerText ?? ''
      const select = fieldWrap.querySelector('select')
      if (select !== null) {
        return {
          label,
          type: 'select',
          value: select.value,
          selectedText: select.selectedOptions[0]?.text ?? '',
          optgroups: [...select.querySelectorAll('optgroup')].map((group) => ({
            label: group.label,
            options: [...group.querySelectorAll('option')].map((option) => ({ value: option.value, text: option.text })),
          })),
          options: [...select.options].map((option) => ({ value: option.value, text: option.text })),
        }
      }
      const textarea = fieldWrap.querySelector('textarea')
      if (textarea !== null) return { label, type: 'textarea', value: textarea.value }
      const input = fieldWrap.querySelector('input')
      if (input !== null) return { label, type: 'input', value: input.value }
      return { label, type: 'other' }
    })
    return { fields, text: inspector.innerText }
  })
}

async function sessionSidebarLines() {
  return page.evaluate(() => document.body.innerText.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
}

/** Workspace task-list rows as shown in the DSH left sidebar. */
async function sessionRowTexts() {
  return page.evaluate(() =>
    [...document.querySelectorAll('[class*="sessionRow"]')].map((row) => row.innerText.trim()).filter((text) => text !== ''),
  )
}

function multisetDiff(before, after) {
  const counts = new Map()
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added = []
  for (const line of after) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(line)
  }
  return added
}

async function stopDialogOptions() {
  return page.evaluate(() => {
    const modal = document.querySelector('.wfo-modal')
    if (modal === null) return null
    return {
      title: modal.querySelector('h3')?.innerText ?? '',
      options: [...modal.querySelectorAll('.wfo-modal-btn')].map((button) => ({
        title: button.querySelector('b')?.innerText ?? '',
        description: button.querySelector('span')?.innerText ?? '',
      })),
      footer: [...modal.querySelectorAll('.wfo-modal-foot button')].map((button) => button.innerText),
    }
  })
}

/** Default canvas palette defined by the design contract (client side). */
const PANEL_PALETTE = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#dc2626']

/** `#rrggbb` -> the `rgb(r, g, b)` form Chrome uses when serializing computed colors. */
function rgbCss(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`
}

/** Task/gateway cards: workspace row, inline colors, status classes and computed colors. */
async function canvasNodeDetails() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.wfo-node')].map((node) => {
      const row = node.querySelector('.wfo-node-workspace')
      const dot = node.querySelector('.wfo-node-ws-dot')
      const tag = node.querySelector('.wfo-node-ws-tag')
      const computed = getComputedStyle(node)
      return {
        cls: node.className,
        isGateway: node.classList.contains('gateway'),
        hasWorkspaceRow: row !== null,
        emptyRow: row === null ? null : row.classList.contains('empty'),
        workspaceName: row?.querySelector('.wfo-node-ws-name')?.textContent ?? null,
        workspaceDot: dot === null ? null : getComputedStyle(dot).backgroundColor,
        workspaceTag: tag?.textContent ?? null,
        workspaceTitle: row?.getAttribute('title') ?? null,
        background: computed.backgroundColor,
        borderColor: computed.borderTopColor,
        borderStyle: computed.borderTopStyle,
        opacity: computed.opacity,
        status: node.querySelector('.wfo-node-status')?.textContent ?? '',
      }
    }),
  )
}

/** The inspector's 「节点工作区配色」 rows. */
async function workspaceColorRows() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.wfo-ws-colors .wfo-ws-color-row')].map((row) => ({
      dot: getComputedStyle(row.querySelector('.wfo-ws-color-dot')).backgroundColor,
      name: row.querySelector('.wfo-ws-color-name')?.textContent ?? '',
      count: row.querySelector('.wfo-ws-count')?.textContent ?? '',
      inputValue: row.querySelector('input[type=color]')?.value ?? null,
      hasReset: [...row.querySelectorAll('button')].some((button) => button.innerText.trim() === '恢复默认'),
    })),
  )
}

/** Every banner (notice / cross-workspace warning / catalog error). */
async function bannerTexts() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.wfo-banner')].map((banner) => ({ cls: banner.className, text: banner.innerText })),
  )
}

/** Deselect the current node by clicking an empty spot of the canvas. */
async function clickBlankCanvas() {
  const box = await page.locator('.wfo-canvas-wrap').boundingBox()
  await page.mouse.click(box.x + 14, box.y + 14)
  await page.waitForTimeout(500)
}

/** Move the pointer off interactive controls so screenshots show resting styles. */
async function parkMouse() {
  await page.mouse.move(4, 4)
  await page.waitForTimeout(350)
}

/** Drive the native color input like a user would (Playwright fill, DOM fallback). */
async function setWorkspaceColorInput(index, hex) {
  const input = page.locator('.wfo-ws-colors .wfo-ws-color-row input[type=color]').nth(index)
  await input.waitFor({ state: 'visible', timeout: 10000 })
  try {
    await input.fill(hex, { timeout: 3000 })
  } catch {
    await input.evaluate((element, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      descriptor.set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, hex)
  }
  await page.waitForTimeout(600)
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
async function scenarioPanelAndPalette(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(6000)
  await waitPastResumePrompt()
  global.__baselineSidebar = await sessionSidebarLines()
  global.__baselineRows = await sessionRowTexts()
  writeEvidence('00-baseline-sidebar', { lines: global.__baselineSidebar, sessionRows: global.__baselineRows })
  await openPanel()
  await page.waitForTimeout(1500)

  const structure = await page.evaluate(() => ({
    palette: [...document.querySelectorAll('.wfo-pal-item')].map((item) => item.innerText),
    paletteTitles: [...document.querySelectorAll('.wfo-pal-head')].map((head) => head.innerText),
    hasCanvas: document.querySelector('.wfo-canvas-wrap') !== null,
    hasCenter: document.querySelector('.wfo-center') !== null,
    hasInspector: document.querySelector('.wfo-inspector') !== null,
    hasLog: document.querySelector('.wfo-log') !== null,
    logParentClass: document.querySelector('.wfo-log')?.parentElement?.className ?? null,
    toolbarButtons: [...document.querySelectorAll('.wfo-toolbar button')].map((button) => button.innerText),
    canvasHint: document.querySelector('.wfo-inner-hint')?.innerText ?? null,
    bodyText: document.body.innerText.slice(0, 4000),
  }))
  await screenshot('10-panel')
  writeEvidence('10-panel', structure)

  check('1-page', '侧栏入口「工作流编排」存在', structure.bodyText.includes('工作流编排'), structure.bodyText.slice(0, 300))
  check('1-page', '打开三栏页面（节点栏/画布/属性栏/消息窗口）',
    structure.palette.length > 0 && structure.hasCanvas && structure.hasInspector && structure.hasLog,
    { hasCanvas: structure.hasCanvas, hasInspector: structure.hasInspector, hasLog: structure.hasLog })
  check('1-page', '消息窗口位于中间列（画布下方）', structure.hasCenter && structure.logParentClass === 'wfo-center', structure.logParentClass)
  check('2-palette', '左侧提供任务、并行网关、判断、终止、定时、动作、等待任务完成七种节点卡',
    structure.paletteTitles.length === 7 &&
      ['任务节点', '并行网关', '判断节点', '终止节点', '定时节点', '动作节点', '等待任务完成'].every((label) =>
        structure.paletteTitles.some((title) => title.includes(label)),
      ),
    structure.paletteTitles)

  const before = await apiState()
  const sessionsBefore = sessionFiles()
  return { catalogs: before.catalogs, sessionsBefore }
}

async function scenarioNodeAndInspector() {
  await page.locator('.wfo-pal-item').nth(0).click()
  await page.waitForTimeout(1200)
  await screenshot('11-node')
  const nodes = await canvasNodes()
  const inspector = await inspectorState()
  writeEvidence('11-node', { nodes, inspector })
  check('3-node', '点击任务节点卡在画布创建节点', nodes.length === 1 && nodes[0].text.includes('任务'), nodes.length)
  check('3-node', '选中节点后属性栏出现提示词 textarea', inspector?.fields?.some((field) => field.label === '提示词' && field.type === 'textarea') === true, inspector?.fields?.map((field) => `${field.label}:${field.type}`))

  const find = (label) => inspector.fields.find((field) => field.label === label)
  const mode = find('模式')
  const permission = find('权限')
  const model = find('模型')
  const workspace = find('工作区')
  check('3-inspector', '模式默认值是中文「标准模式」（不是 standard）',
    mode?.value === 'standard' && mode?.selectedText === '标准模式',
    { value: mode?.value, selectedText: mode?.selectedText })
  check('3-inspector', '权限默认值是中文「完全权限」（不是 danger-full-access）',
    permission?.value === 'danger-full-access' && permission?.selectedText === '完全权限',
    { value: permission?.value, selectedText: permission?.selectedText })
  const modelGroup = model?.optgroups?.find((group) => group.label === E2E_PROVIDER_DISPLAY)
  check('3-inspector', `模型下拉包含 ${E2E_PROVIDER_DISPLAY} 模型组`,
    modelGroup !== undefined && modelGroup.options.length >= 1 &&
      modelGroup.options.some((option) => option.text === E2E_MODEL),
    model?.optgroups)
  check('3-inspector', `模型下拉含默认项 + 默认选中 ${E2E_PROVIDER}/${E2E_MODEL}`,
    model?.options?.[0]?.text === '使用默认模型' && model?.value === `${E2E_PROVIDER}::${E2E_MODEL}`,
    { first: model?.options?.[0], value: model?.value })
  check('3-inspector', '工作区下拉含默认工作区',
    workspace?.selectedText === 'default-workspace' && workspace?.options?.some((option) => option.text === 'default-workspace'),
    workspace?.selectedText)
  check('3-inspector', '属性栏字段齐全（名称/提示词/上游上下文/工作区/模式/权限/模型）',
    ['节点名称', '提示词', '上游上下文', '工作区', '模式', '权限', '模型'].every((label) => find(label) !== undefined),
    inspector?.fields?.map((field) => field.label))

  const point = await canvasPoint(0.62, 0.72)
  await dragPaletteAndVerify(0, point)
  const afterDrag = await canvasNodes()
  const dx = afterDrag.length === 2 ? Math.abs(afterDrag[0].left - afterDrag[1].left) + Math.abs(afterDrag[0].top - afterDrag[1].top) : 0
  check('3-node', '拖放任务节点到画布（HTML5 拖拽）', afterDrag.length === 2 && dx > 100, { nodes: afterDrag.map((node) => ({ left: node.left, top: node.top })), distance: dx })
  await screenshot('12-inspector')
  return { afterDrag }
}

async function scenarioEnterNoRun(sessionsBefore) {
  await clickNode(0)
  const textarea = page.locator('.wfo-inspector textarea').first()
  await textarea.click()
  await page.keyboard.type('第一行')
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('Enter')
  await page.keyboard.type('最后一行')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const value = await textarea.inputValue()
  const runState = await apiState()
  const activeId = await activeWorkflowId()
  const runs = (runState.engine?.runs ?? []).filter((run) => run.workflowId === activeId)
  const log = await logText()
  const stopDisabled = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.wfo-toolbar button')].find((entry) => entry.innerText.trim() === '终止')
    return button === undefined ? null : button.disabled
  })
  const sessionsAfter = sessionFiles()
  await screenshot('13-enter-no-run')
  writeEvidence('13-enter-no-run', { value, log, stopDisabled, runs: runs.length, sessionsBefore: sessionsBefore.length, sessionsAfter: sessionsAfter.length })
  check('4-enter', '提示词 textarea 内 Enter 产生多行换行',
    value.split('\n').length >= 5 && value.includes('第一行') && value.includes('最后一行'),
    JSON.stringify(value))
  check('4-enter', 'Enter 未触发执行（无运行记录）', runs.length === 0, runs.length)
  check('4-enter', 'Enter 未触发执行（消息窗口仍为空）', log.includes('暂无执行日志'), log.slice(0, 200))
  check('4-enter', 'Enter 未触发执行（终止按钮仍禁用）', stopDisabled === true, stopDisabled)
  check('4-enter', 'Enter 未触发执行（未创建任务会话）', sessionsAfter.length === sessionsBefore.length, { before: sessionsBefore.length, after: sessionsAfter.length })

  await setPromptForNode(0, PROMPT_SHORT)
  await setPromptForNode(1, PROMPT_SHORT)
  const activeId2 = await activeWorkflowId()
  const saved = await waitSaved(activeId2, (workflow) =>
    workflow.nodes.length === 2 && workflow.nodes.every((node) => node.task?.prompt === PROMPT_SHORT), 'prompts')
  check('5-save', '属性面板修改自动保存（无需点保存按钮）', saved.nodes.length === 2, saved.nodes.map((node) => node.task?.prompt))
  return { activeId: activeId2 }
}

async function scenarioConnectAndPersist(activeId) {
  await connectNodes(0, 1)
  const workflow = await waitSaved(activeId, (state) => state.edges.length === 1, 'edge')
  const edge = workflow.edges[0]
  const svg = await page.evaluate(() =>
    [...document.querySelectorAll('.wfo-edge')].map((element) => ({ cls: element.getAttribute('class'), d: element.getAttribute('d'), markerEnd: element.getAttribute('marker-end') })),
  )
  await screenshot('13-edge')
  writeEvidence('13-edge', { edge, svg, workflow })
  check('6-edge', '从右侧圆点拖到左侧圆点成功创建边', workflow.edges.length === 1 && edge.from === workflow.nodes[0].id && edge.to === workflow.nodes[1].id, edge)
  check('6-edge', '连线渲染为带箭头的 SVG 边（A→B）',
    svg.length === 1 && svg[0].markerEnd === 'url(#wfo-arrow)' && typeof svg[0].d === 'string' && svg[0].d.startsWith('M'), svg)

  const beforeReload = { nodes: workflow.nodes, edges: workflow.edges }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(6000)
  await openPanel()
  await page.waitForTimeout(1500)
  const nodes = await canvasNodes()
  const afterState = await apiState()
  const afterWorkflow = afterState.workflows.find((entry) => entry.id === activeId)
  const log = await logText()
  await screenshot('14-persistence')
  writeEvidence('14-persistence', { beforeReload, afterReload: afterWorkflow, canvasNodes: nodes, log })
  check('5-persist', '刷新页面后画布仍有 2 个节点', nodes.length === 2, nodes.length)
  check('5-persist', '刷新页面后连线仍在', afterWorkflow?.edges?.length === 1, afterWorkflow?.edges?.length)
  check('5-persist', '刷新页面后提示词仍在',
    afterWorkflow?.nodes?.every((node) => node.task?.prompt === PROMPT_SHORT) === true,
    afterWorkflow?.nodes?.map((node) => node.task?.prompt))
  check('5-persist', '刷新页面后消息窗口为空（执行记录未伪造）', log.includes('暂无执行日志'), log.slice(0, 120))
  return { workflow: afterWorkflow }
}

async function scenarioChainRun(activeId, sessionsBefore) {
  await clickToolbar('执行')
  const run = await waitTerminalRun(activeId, 300000)
  await page.waitForTimeout(1600)
  const states = Object.values(run.nodes ?? {})
  const a = states[0]
  const b = states[1]
  const sessionsAfter = sessionFiles()
  const newSessions = sessionsAfter.filter((file) => !sessionsBefore.includes(file))
  const log = await logText()
  const logLines = await page.evaluate(() => [...document.querySelectorAll('.wfo-log-row')].map((row) => row.innerText))
  const nodes = await canvasNodes()
  await screenshot('15-chain-run')
  writeEvidence('15-chain-run', {
    run,
    states: states.map((state) => ({ title: state.title, status: state.status, sessionId: state.sessionId, startedAt: state.startedAt, endedAt: state.endedAt })),
    log,
    logLines,
    canvasNodes: nodes,
    newSessions,
  })
  check('7-chain', 'A→B 串行执行完成（工作流状态 completed）', run.status === 'completed', run.status)
  check('7-chain', '两个任务节点状态均为「已完成」',
    states.length === 2 && states.every((state) => state.status === 'completed') && nodes.every((node) => node.status === '已完成'),
    { api: states.map((state) => state.status), ui: nodes.map((node) => node.status) })
  check('7-chain', 'A 完成后才启动 B（A.endedAt <= B.startedAt）', a?.endedAt !== null && b?.startedAt !== null && a.endedAt <= b.startedAt, { aEndedAt: a?.endedAt, bStartedAt: b?.startedAt })
  check('7-chain', '每个节点创建了真实任务会话（sessionId 存在）',
    states.every((state) => typeof state.sessionId === 'string' && state.sessionId.startsWith('session-')),
    states.map((state) => state.sessionId))
  check('7-chain', '消息窗口出现会话 ID 与完成记录',
    log.includes('已为任务「任务 1」创建会话') && log.includes('完成（会话') && log.includes('工作流执行完成'),
    logLines.slice(0, 8))
  check('7-chain', '隔离 home 的 sessions 目录出现新的 session 文件', newSessions.length >= 2, newSessions.map((file) => path.relative(HOME, file)))

  // Live task list: without reloading, the workspace session list should already
  // contain the two sessions the workflow just created.
  const liveDeadline = Date.now() + 20000
  let liveRows = await sessionRowTexts()
  let liveAdded = multisetDiff(global.__baselineRows ?? [], liveRows)
  let liveTitled = liveAdded.filter((row) => row.includes('完成'))
  while (Date.now() < liveDeadline && (liveAdded.length < 2 || liveTitled.length < 1)) {
    await page.waitForTimeout(1500)
    liveRows = await sessionRowTexts()
    liveAdded = multisetDiff(global.__baselineRows ?? [], liveRows)
    liveTitled = liveAdded.filter((row) => row.includes('完成'))
  }
  writeEvidence('15b-workspace-live', { before: global.__baselineRows ?? [], after: liveRows, added: liveAdded, titled: liveTitled })
  check('7-chain', '未刷新页面时工作区任务列表即时新增工作流会话条目',
    liveAdded.length >= 2 && liveTitled.length >= 1,
    { added: liveAdded.slice(0, 8), titled: liveTitled })

  // Workspace task list: reload to the home page and diff the sidebar.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(6000)
  const deadline = Date.now() + 25000
  let sidebarLines = await sessionSidebarLines()
  let added = multisetDiff(global.__baselineSidebar ?? [], sidebarLines)
  while (Date.now() < deadline && added.filter((line) => line.length > 1).length < 2) {
    await page.waitForTimeout(1500)
    sidebarLines = await sessionSidebarLines()
    added = multisetDiff(global.__baselineSidebar ?? [], sidebarLines)
  }
  const ignored = new Set(['新会话', '更多', '工作区', '插件', '自动化任务', '工作流编排', '探索未至之境', '预览版', '完全权限', '标准模式', '默认工作区'])
  const meaningful = added.filter((line) => !ignored.has(line) && line.length > 1)
  const titled = meaningful.filter((line) => line.includes('完成'))
  const reloadedRows = await sessionRowTexts()
  const reloadedAdded = multisetDiff(global.__baselineRows ?? [], reloadedRows)
  writeEvidence('16-workspace-sessions', { before: global.__baselineSidebar ?? [], added, meaningful, titled, sessionRowsBefore: global.__baselineRows ?? [], sessionRowsAfter: reloadedRows, sessionRowsAdded: reloadedAdded })
  await screenshot('16-workspace-sessions')
  check('7-chain', '刷新后工作区任务列表包含工作流创建的会话',
    meaningful.length >= 2 && titled.length >= 1 && reloadedAdded.length >= 2,
    { meaningful: meaningful.slice(0, 8), titled, sessionRowsAdded: reloadedAdded.slice(0, 8) })

  await openPanel()
  await page.waitForTimeout(1000)
  return { run }
}

async function scenarioParallelGateway() {
  const activeId = await createNewWorkflow()
  const nodesCount = await page.locator('.wfo-node').count()
  check('8-gateway', '新建工作流后画布为空', nodesCount === 0, nodesCount)

  await dragPaletteAndVerify(0, await canvasPoint(0.13, 0.16))
  await dragPaletteAndVerify(0, await canvasPoint(0.13, 0.68))
  await dragPaletteAndVerify(1, await canvasPoint(0.58, 0.42))
  await dragPaletteAndVerify(0, await canvasPoint(0.93, 0.42))
  const nodes = await canvasNodes()
  const gwIndex = nodes.findIndex((node) => node.cls.includes('gateway'))
  const taskIndexes = nodes.map((node, index) => (node.cls.includes('gateway') ? -1 : index)).filter((index) => index >= 0)
  await setPromptForNode(taskIndexes[0], PROMPT_SHORT)
  await setPromptForNode(taskIndexes[1], PROMPT_SHORT)
  await setPromptForNode(taskIndexes[2], PROMPT_SHORT)
  await connectNodes(taskIndexes[0], gwIndex)
  await connectNodes(taskIndexes[1], gwIndex)
  await connectNodes(gwIndex, taskIndexes[2])
  const workflow = await waitSaved(activeId, (state) => state.nodes.length === 4 && state.edges.length === 3, 'gateway graph')
  await screenshot('17-gateway-graph')
  writeEvidence('17-gateway-graph', { nodes, edges: workflow.edges, workflow })
  check('8-gateway', '并行网关画布：2 个任务接入网关，网关再连 C',
    workflow.nodes.length === 4 && workflow.edges.length === 3 &&
      workflow.nodes.filter((node) => node.type === 'parallel').length === 1,
    { nodes: workflow.nodes.length, edges: workflow.edges.length })

  await clickToolbar('执行')
  const run = await waitTerminalRun(activeId, 300000)
  await page.waitForTimeout(1600)
  const states = Object.values(run.nodes ?? {})
  const log = await logText()
  const canvas = await canvasNodes()
  await screenshot('18-gateway-run')
  writeEvidence('18-gateway-run', { run, states, log, canvas })
  const taskStates = states.filter((state) => state.type === 'task')
  const gatewayState = states.find((state) => state.type === 'parallel')
  const completedTasks = taskStates.filter((state) => state.status === 'completed')
  const sortedByStart = [...taskStates].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
  const c = sortedByStart[sortedByStart.length - 1]
  const branches = sortedByStart.slice(0, 2)
  check('8-gateway', '并行网关工作流整体完成', run.status === 'completed', run.status)
  check('8-gateway', 'A、B、网关、C 全部完成',
    completedTasks.length === 3 && gatewayState?.status === 'completed' && canvas.every((node) => node.status === '已完成'),
    { tasks: taskStates.map((state) => state.status), gateway: gatewayState?.status, ui: canvas.map((node) => node.status) })
  check('8-gateway', 'C 开始时间 >= A、B 结束时间（汇合语义）',
    c?.startedAt !== null && branches.every((state) => state.endedAt !== null && c.startedAt >= state.endedAt),
    { branches: branches.map((state) => state.endedAt), cStartedAt: c?.startedAt })
  check('8-gateway', '消息窗口记录网关汇合（2 条分支）', /已汇合（2 条分支）/.test(log), log.split('\n').filter((line) => line.includes('汇合')))
  return { activeId }
}

async function runSlowTaskWorkflow(prompt) {
  const activeId = await createNewWorkflow()
  await dragPaletteAndVerify(0, await canvasPoint(0.4, 0.45))
  await setPromptForNode(0, prompt)
  await waitSaved(activeId, (state) => state.nodes.length === 1 && state.nodes[0].task?.prompt === prompt, 'slow prompt')
  return { activeId }
}

async function triggerStopDialog() {
  await clickToolbar('终止')
  await page.waitForSelector('.wfo-modal', { timeout: 10000 })
  return stopDialogOptions()
}

async function scenarioStopDetach() {
  const prompt = '请逐行输出数字 1 到 120，每行一个数字，不要省略，不要合并；最后单独一行回复：完成'
  const { activeId } = await runSlowTaskWorkflow(prompt)
  await clickToolbar('执行')
  await waitFor(async () => {
    const run = await getRun(activeId)
    const node = run === null ? null : Object.values(run.nodes ?? {})[0]
    return run !== null && run.status === 'running' && node?.status === 'running' && typeof node.sessionId === 'string' ? run : null
  }, 60000, 150, 'slow task running')
  const dialog = await triggerStopDialog()
  await screenshot('19-stop-dialog')
  writeEvidence('19-stop-dialog', dialog)
  check('9-stop', '终止弹出两种选项',
    dialog !== null && dialog.options.length === 2 &&
      dialog.options[0].title === '仅停止工作流' &&
      dialog.options[1].title === '停止工作流并终止正在运行的任务',
    dialog)

  await page.locator('.wfo-modal-btn').nth(0).click()
  const noticeAfter = await waitFor(async () => {
    const text = await page.evaluate(() => document.querySelector('.wfo-banner')?.innerText ?? '')
    return /继续执行/.test(text) ? text : null
  }, 20000, 250, 'detach stop notice')
  const stopMode = await waitFor(async () => {
    const run = await getRun(activeId)
    return run?.stopMode === 'detach' ? run : null
  }, 15000, 200, 'stopMode detach')
  const run = await waitTerminalRun(activeId, 300000)
  await page.waitForTimeout(1600)
  const node = Object.values(run.nodes ?? {})[0]
  const log = await logText()
  const canvas = await canvasNodes()
  await screenshot('20-stop-detach')
  writeEvidence('20-stop-detach', { noticeAfter, stopMode: stopMode?.stopMode, status: run.status, node, log, canvas })
  check('9-stop', '「仅停止工作流」：提示运行中的任务将继续执行', /继续执行/.test(noticeAfter), noticeAfter)
  check('9-stop', '「仅停止工作流」：运行中任务未被取消（状态 completed）', node?.status === 'completed', node?.status)
  check('9-stop', '「仅停止工作流」：工作流整体标记为已停止（cancelled）', run.status === 'cancelled' && run.stopMode === 'detach', { status: run.status, stopMode: run.stopMode })
  check('9-stop', '「仅停止工作流」：日志记录停止原因', /已停止（正在运行的任务继续执行）/.test(log), log.split('\n').filter((line) => line.includes('停止')))
}

async function scenarioStopCancel() {
  const prompt = '请逐行输出数字 1 到 300，每行一个数字，不要省略，不要合并；最后单独一行回复：完成'
  const { activeId } = await runSlowTaskWorkflow(prompt)
  await clickToolbar('执行')
  await waitFor(async () => {
    const run = await getRun(activeId)
    const node = run === null ? null : Object.values(run.nodes ?? {})[0]
    return run !== null && run.status === 'running' && node?.status === 'running' && typeof node.sessionId === 'string' ? run : null
  }, 60000, 150, 'slow task running (cancel case)')
  const dialog = await triggerStopDialog()
  writeEvidence('21-stop-cancel-dialog', dialog)
  await page.locator('.wfo-modal-btn').nth(1).click()
  await page.waitForTimeout(1000)
  const run = await waitTerminalRun(activeId, 180000)
  await page.waitForTimeout(1600)
  const node = Object.values(run.nodes ?? {})[0]
  const log = await logText()
  const canvas = await canvasNodes()
  await screenshot('21-stop-cancel')
  writeEvidence('21-stop-cancel', { stopMode: run.stopMode, status: run.status, node, log, canvas })
  check('9-stop', '「终止正在运行的任务」：节点变为已取消', node?.status === 'cancelled' && canvas.some((entry) => entry.status === '已取消'), { api: node?.status, ui: canvas.map((entry) => entry.status) })
  check('9-stop', '「终止正在运行的任务」：工作流标记 cancelled 且 stopMode=cancel-tasks', run.status === 'cancelled' && run.stopMode === 'cancel-tasks', { status: run.status, stopMode: run.stopMode })
  check('9-stop', '「终止正在运行的任务」：日志记录终止请求与会话取消',
    /已请求终止任务/.test(log) && /已取消/.test(log),
    log.split('\n').filter((line) => line.includes('终止') || line.includes('取消')))
}

async function scenarioFailure() {
  const activeId = await createNewWorkflow()
  await dragPaletteAndVerify(0, await canvasPoint(0.4, 0.45))
  await setPromptForNode(0, PROMPT_SHORT)
  const savedWorkflow = await waitSaved(activeId, (state) => state.nodes.length === 1 && state.nodes[0].task?.prompt === PROMPT_SHORT, 'failure prompt')
  const broken = JSON.parse(JSON.stringify(savedWorkflow))
  broken.nodes[0].task.agentPreset = 'definitely-not-a-preset'
  await api('POST', 'save', { workflow: broken })
  await clickToolbar('刷新')
  await page.waitForTimeout(1500)
  await clickToolbar('执行')
  const run = await waitTerminalRun(activeId, 120000)
  await page.waitForTimeout(1600)
  const node = Object.values(run.nodes ?? {})[0]
  const log = await logText()
  const logRows = await page.evaluate(() =>
    [...document.querySelectorAll('.wfo-log-row')].map((row) => ({ level: row.querySelector('.wfo-log-level')?.innerText ?? '', text: row.innerText })),
  )
  const pill = await page.evaluate(() => document.querySelector('.wfo-log .wfo-pill')?.innerText ?? '')
  const canvas = await canvasNodes()
  await screenshot('22-failure')
  writeEvidence('22-failure', { run, node, log, logRows, pill, canvas })
  check('10-failure', '失败节点状态为「失败」', node?.status === 'failed' && canvas.some((entry) => entry.status === '失败'), { api: node?.status, ui: canvas.map((entry) => entry.status) })
  check('10-failure', '节点错误信息记录在运行记录中', typeof node?.error === 'string' && /agent-preset\/not-found/.test(node.error), node?.error)
  check('10-failure', '底部日志出现 error 级错误信息', logRows.some((row) => row.level === 'ERROR') && log.includes('执行失败'), logRows.filter((row) => row.level === 'ERROR').slice(0, 3))
  check('10-failure', '工作流整体标记为失败', run.status === 'failed' && pill === '失败', { status: run.status, pill })
}

async function scenarioWorkspaceColors() {
  const activeId = await createNewWorkflow()
  await dragPaletteAndVerify(0, await canvasPoint(0.16, 0.18))
  await dragPaletteAndVerify(0, await canvasPoint(0.16, 0.66))
  await setPromptForNode(0, PROMPT_SHORT)
  await setPromptForNode(1, PROMPT_SHORT)
  let workflow = await waitSaved(
    activeId,
    (state) => state.nodes.length === 2 && state.nodes.every((node) => node.task?.prompt === PROMPT_SHORT),
    'workspace prompts',
  )

  const state = await apiState()
  const catalogs = state.catalogs ?? {}
  const workspaces = Array.isArray(catalogs.workspaces) ? catalogs.workspaces : []
  const defaultWorkspaceId = catalogs.defaults?.workspaceId ?? workflow.settings?.defaultWorkspaceId ?? null
  const hostSecond = workspaces.find((workspace) => workspace.id !== defaultWorkspaceId) ?? null
  // The isolated host may only expose the default workspace. In that case the
  // second id is synthetic and the report must say so; it is still written and
  // read through the real store/API and rendered by the real UI.
  const realHostWorkspace = hostSecond !== null
  const secondWorkspaceId = hostSecond !== null ? hostSecond.id : 'e2e-workspace-2'
  const secondWorkspaceTitle =
    hostSecond !== null ? hostSecond.title || hostSecond.path || hostSecond.id : secondWorkspaceId

  // Write the explicit workspace id through the real save API, then refresh.
  // Newly created task nodes carry the catalog default as an explicit
  // workspaceId; drop it on the first node so it exercises the inherited case.
  workflow = JSON.parse(JSON.stringify(workflow))
  delete workflow.nodes[0].task.workspaceId
  workflow.nodes[1].task = { ...(workflow.nodes[1].task ?? {}), workspaceId: secondWorkspaceId }
  const savedWorkflow = (await api('POST', 'save', { workflow })).workflow
  check('12-workspace', '通过保存 API 写入第二个节点工作区 id（隔离宿主可用工作区不足时为合成 id）',
    savedWorkflow.nodes[1].task.workspaceId === secondWorkspaceId,
    { realHostWorkspace, secondWorkspaceId, availableWorkspaces: workspaces.map((workspace) => workspace.id) })
  await clickToolbar('刷新')
  // The refresh GET can resolve late under load; wait until the cards really
  // render the two distinct workspace ids instead of relying on a fixed sleep.
  await waitFor(async () => {
    const snapshot = await canvasNodeDetails()
    const rendered = snapshot.filter((entry) => !entry.isGateway)
    const names = new Set(rendered.map((entry) => entry.workspaceName))
    return rendered.length === 2 && names.size === 2 && names.has(secondWorkspaceId) ? snapshot : null
  }, 30000, 300, 'panel refresh with two workspace ids')
  await clickBlankCanvas()
  const details = await canvasNodeDetails()

  const tasks = details.filter((entry) => !entry.isGateway)
  check('12-workspace', '默认工作区节点卡片出现工作区行与颜色块',
    tasks.length === 2 && tasks[0].hasWorkspaceRow && tasks[0].emptyRow === false &&
      tasks[0].workspaceName !== null && tasks[0].workspaceDot !== null,
    { tasks: tasks.map((entry) => ({ name: entry.workspaceName, dot: entry.workspaceDot })) })
  check('12-workspace', '继承工作流默认工作区的节点显示「默认」标记，显式指定节点不显示',
    tasks[0].workspaceTag === '默认' && tasks[1].workspaceTag === null,
    { first: tasks[0].workspaceTag, second: tasks[1].workspaceTag })
  check('12-workspace', '工作区行 title 说明「继承工作流默认」与「节点指定」',
    /工作区：.*（继承工作流默认）/.test(tasks[0].workspaceTitle ?? '') &&
      /工作区：.*（节点指定）/.test(tasks[1].workspaceTitle ?? ''),
    [tasks[0].workspaceTitle, tasks[1].workspaceTitle])
  check('12-workspace', '两个工作区颜色块使用不同默认调色板颜色',
    tasks[0].workspaceDot === rgbCss(PANEL_PALETTE[0]) && tasks[1].workspaceDot === rgbCss(PANEL_PALETTE[1]),
    { first: tasks[0].workspaceDot, second: tasks[1].workspaceDot, palette: PANEL_PALETTE.slice(0, 2) })
  check('12-workspace', '节点卡片背景色按工作区区分（不同且非透明）',
    tasks[0].background !== tasks[1].background &&
      tasks[0].background !== 'rgba(0, 0, 0, 0)' && tasks[1].background !== 'rgba(0, 0, 0, 0)',
    { first: tasks[0].background, second: tasks[1].background })
  check('12-workspace', '卡片边框颜色不随工作区变化（边框仍只表达运行状态）',
    tasks[0].borderColor === tasks[1].borderColor && tasks[0].borderStyle === 'solid',
    { first: { color: tasks[0].borderColor, style: tasks[0].borderStyle }, second: { color: tasks[1].borderColor, style: tasks[1].borderStyle } })

  const banners = await bannerTexts()
  const warn = banners.find((entry) => entry.cls.includes('warn'))
  check('12-workspace', '工具栏下方出现跨工作区 warn 提示条',
    warn !== undefined && warn.text.includes('当前工作流跨 2 个工作区') &&
      warn.text.includes('节点卡片已用不同背景色区分') && warn.text.includes(secondWorkspaceTitle),
    warn)
  check('12-workspace', '跨工作区提示条不阻塞执行（执行按钮仍可用）',
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.wfo-toolbar button')].find((entry) => entry.innerText.trim() === '执行')
      return button !== undefined && button.disabled === false
    }),
    'toolbar 执行 enabled')

  const colorRows = await workspaceColorRows()
  const inspectorText = await page.evaluate(() => document.querySelector('.wfo-inspector')?.innerText ?? '')
  check('12-workspace', '属性区「节点工作区配色」列出两个工作区（颜色块 + 标题 + 节点数 + 取色器）',
    colorRows.length === 2 && colorRows.every((row) => row.inputValue !== null) &&
      colorRows[0].count === '1 个节点' && colorRows[1].count === '1 个节点',
    colorRows)
  check('12-workspace', '工作区配色 hint 说明背景色只用于区分、边框仍表示运行状态',
    inspectorText.includes('节点工作区配色') &&
      inspectorText.includes('背景色仅用于画布区分，不改变任务会话所属工作区；卡片边框仍表示运行状态。'),
    inspectorText.slice(0, 600))

  const beforeOverrideBackground = tasks[1].background
  await setWorkspaceColorInput(1, '#123456')
  const persisted = await waitSaved(
    activeId,
    (entry) => entry.settings?.workspaceColors?.[secondWorkspaceId] === '#123456',
    'workspace color override',
  )
  const afterOverride = (await canvasNodeDetails()).filter((entry) => !entry.isGateway)
  const colorRowsAfter = await workspaceColorRows()
  check('12-workspace', '修改工作区配色后自动保存并持久化 #123456',
    persisted.settings.workspaceColors[secondWorkspaceId] === '#123456',
    persisted.settings.workspaceColors)
  check('12-workspace', '修改后卡片背景色与颜色块即时更新，未修改的工作区保持原色',
    afterOverride[1].workspaceDot === rgbCss('#123456') &&
      afterOverride[1].background !== beforeOverrideBackground &&
      afterOverride[0].background === tasks[0].background,
    { changed: afterOverride[1].background, unchanged: afterOverride[0].background, dot: afterOverride[1].workspaceDot })
  check('12-workspace', '已覆盖的工作区显示「恢复默认」按钮，未覆盖的不显示',
    colorRowsAfter[1].hasReset === true && colorRowsAfter[0].hasReset === false,
    colorRowsAfter)
  await parkMouse()
  await screenshot('23-workspace-colors')
  writeEvidence('23-workspace-colors', { realHostWorkspace, secondWorkspaceId, details, colorRowsAfter, banners, persisted: persisted.settings })

  // Selecting a task shows the cross-workspace sentence in the 工作区 field hint.
  await clickNode(1)
  const inspectorTaskText = await page.evaluate(() => document.querySelector('.wfo-inspector')?.innerText ?? '')
  check('12-workspace', '选中任务节点时「工作区」hint 追加跨工作区说明',
    inspectorTaskText.includes('当前工作流涉及 2 个工作区，卡片背景色用于区分。'),
    inspectorTaskText.split('\n').filter((line) => line.includes('工作区')).slice(0, 6))

  // Reset the override and confirm the palette color comes back.
  await clickBlankCanvas()
  const resetRow = (await workspaceColorRows()).findIndex((row) => row.hasReset)
  await page.locator('.wfo-ws-colors .wfo-ws-color-row').nth(resetRow).getByRole('button', { name: '恢复默认' }).click()
  await waitSaved(
    activeId,
    (entry) => entry.settings?.workspaceColors === undefined || entry.settings.workspaceColors[secondWorkspaceId] === undefined,
    'workspace color reset',
  )
  await page.waitForTimeout(700)
  const resetRows = await workspaceColorRows()
  const resetDetails = (await canvasNodeDetails()).filter((entry) => !entry.isGateway)
  check('12-workspace', '「恢复默认」删除覆盖并回到默认调色板颜色',
    resetRows.every((row) => row.hasReset === false) &&
      resetDetails[1].workspaceDot === rgbCss(PANEL_PALETTE[1]) &&
      resetDetails[1].background !== afterOverride[1].background,
    { rows: resetRows, dot: resetDetails[1].workspaceDot })
  return { activeId, realHostWorkspace, secondWorkspaceId, workspaceCount: workspaces.length }
}

async function scenarioRunFromNode() {
  const activeId = await createNewWorkflow()
  await dragPaletteAndVerify(0, await canvasPoint(0.14, 0.16))
  await dragPaletteAndVerify(0, await canvasPoint(0.45, 0.44))
  await dragPaletteAndVerify(0, await canvasPoint(0.78, 0.72))
  await connectNodes(0, 1)
  await connectNodes(1, 2)
  let workflow = await waitSaved(activeId, (state) => state.nodes.length === 3 && state.edges.length === 2, 'range chain')

  // With an empty prompt the "run from this node" button must be disabled.
  await clickNode(0)
  const emptyButton = await page
    .locator('.wfo-inspector .wfo-start-here button')
    .evaluate((element) => ({ text: element.innerText.trim(), disabled: element.disabled, title: element.title }))
  check('13-run-from-node', '提示词为空时「从此节点开始执行」禁用并说明原因',
    emptyButton.text === '从此节点开始执行' && emptyButton.disabled === true &&
      emptyButton.title.includes('还没有填写提示词'),
    emptyButton)

  await setPromptForNode(0, PROMPT_SHORT)
  await setPromptForNode(1, PROMPT_SHORT)
  await setPromptForNode(2, PROMPT_SHORT)
  workflow = await waitSaved(
    activeId,
    (state) => state.nodes.length === 3 && state.nodes.every((node) => node.task?.prompt === PROMPT_SHORT),
    'range prompts',
  )
  const nodeIds = workflow.nodes.map((node) => node.id)

  await clickNode(1)
  const button = page.locator('.wfo-inspector .wfo-start-here button')
  await button.waitFor({ state: 'visible', timeout: 10000 })
  const buttonState = await button.evaluate((element) => ({
    text: element.innerText.trim(),
    disabled: element.disabled,
    title: element.title,
  }))
  const inspectorOrder = await page.evaluate(() => {
    const inspector = document.querySelector('.wfo-inspector')
    return [...inspector.children].map((child) => child.className)
  })
  check('13-run-from-node', '属性区最顶部（标题行下方、节点名称之前）出现「从此节点开始执行」按钮',
    buttonState.text === '从此节点开始执行' && buttonState.disabled === false &&
      /跳过该节点之前的所有节点，从该节点及其下游开始执行/.test(buttonState.title) &&
      inspectorOrder[0] === 'wfo-insp-head' && inspectorOrder[1] === 'wfo-start-here',
    { buttonState, inspectorOrder: inspectorOrder.slice(0, 5) })

  const sessionsBefore = sessionFiles()
  await button.click()
  const startNotice = await waitFor(async () => {
    const banners = await bannerTexts()
    return banners.find((entry) => entry.text.includes(`已从「${workflow.nodes[1].title}」开始执行`)) ?? null
  }, 20000, 200, 'run-from-node notice')
  check('13-run-from-node', '点击后提示「已从「任务 2」开始执行」', startNotice !== null, startNotice)

  const run = await waitTerminalRun(activeId, 300000)
  await page.waitForTimeout(1800)
  const sessionsAfter = sessionFiles()
  const newSessions = sessionsAfter.filter((file) => !sessionsBefore.includes(file))
  const log = await logText()
  const canvas = await canvasNodes()
  const details = await canvasNodeDetails()
  const inspectorText = await page.evaluate(() => document.querySelector('.wfo-inspector')?.innerText ?? '')
  await parkMouse()
  await screenshot('24-run-from-node')
  writeEvidence('24-run-from-node', {
    run,
    log,
    canvas,
    details,
    inspectorText,
    newSessions: newSessions.map((file) => path.relative(HOME, file)),
    startNotice,
    buttonState,
  })

  const stateOf = (id) => run.nodes?.[id]
  const a = stateOf(nodeIds[0])
  const b = stateOf(nodeIds[1])
  const c = stateOf(nodeIds[2])
  check('13-run-from-node', '运行记录带 startNodeId，且只执行 B、C（A 未执行）',
    run.startNodeId === nodeIds[1] && a?.status === 'not-run' && b?.status === 'completed' && c?.status === 'completed',
    { startNodeId: run.startNodeId, statuses: { a: a?.status, b: b?.status, c: c?.status } })
  check('13-run-from-node', '画布状态：A 显示「未执行」，B/C 显示「已完成」',
    canvas.length === 3 && canvas[0].status === '未执行' && canvas[1].status === '已完成' && canvas[2].status === '已完成',
    canvas.map((node) => ({ status: node.status, cls: node.cls })))
  check('13-run-from-node', '未执行卡片虚线边框并弱化显示',
    details[0].borderStyle === 'dashed' && Number(details[0].opacity) < 0.7 && details[1].borderStyle !== 'dashed',
    { a: { borderStyle: details[0].borderStyle, opacity: details[0].opacity }, b: { borderStyle: details[1].borderStyle, opacity: details[1].opacity } })
  check('13-run-from-node', '未执行节点没有创建任务会话（只有 B、C 两个新会话）',
    a?.sessionId === null && newSessions.length === 2,
    { aSessionId: a?.sessionId, newSessions: newSessions.map((file) => path.relative(HOME, file)) })
  check('13-run-from-node', '启动日志记录从节点开始执行及跳过数量',
    log.includes(`从节点「${workflow.nodes[1].title}」开始执行：跳过 1 个不在下游范围内的节点`),
    log.split('\n').filter((line) => line.includes('从节点')))
  check('13-run-from-node', '运行卡片「执行范围」显示从起始节点开始（跳过 1 个节点）',
    inspectorText.includes('执行范围') && inspectorText.includes(`从「${workflow.nodes[1].title}」开始（跳过 1 个节点）`),
    inspectorText.split('\n').filter((line) => line.includes('执行范围') || line.includes('跳过')).slice(0, 6))
  check('13-run-from-node', '范围运行整体 completed，A 没有开始/结束时间',
    run.status === 'completed' && a?.startedAt === null && a?.endedAt === null,
    { status: run.status, aStartedAt: a?.startedAt, aEndedAt: a?.endedAt })
  return { activeId, run }
}

async function scenarioConsole() {
  writeText('99-console.txt', JSON.stringify({ pageErrors, consoleErrors }, null, 2))
  check('11-console', '无 pageerror', pageErrors.length === 0, pageErrors)
  check('11-console', '无 console.error', consoleErrors.length === 0, consoleErrors)
  await screenshot('99-final')
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function renderReport(extra) {
  const failed = checks.filter((entry) => !entry.pass)
  const summary = {
    generatedAt: nowIso(),
    environment: {
      home: HOME,
      profile: PROFILE,
      serverPort,
      url: extra.url ?? null,
      plugin: 'dsh-workflow-orchestrator',
      // Transparency: the isolated host may only expose the default workspace.
      // The multi-workspace scenario then uses a synthetic workspace id written
      // through the real save API — reported here, never passed off as a real host workspace.
      workspaceScenario: extra.workspaceScenario ?? null,
    },
    totals: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
    failures: failed,
    checks,
    consoleErrors,
    pageErrors,
    artifacts,
  }
  fs.writeFileSync(path.join(OUT, 'e2e-report.json'), JSON.stringify(summary, null, 2), 'utf8')
  const lines = []
  lines.push('# dsh-workflow-orchestrator E2E 验证报告')
  lines.push('')
  lines.push(`- 生成时间：${summary.generatedAt}`)
  lines.push(`- 隔离 home：\`${HOME}\``)
  lines.push(`- 测试 host：\`dsh --profile web --port ${serverPort}\`（由脚本管理生命周期）`)
  lines.push(`- 断言：${summary.totals.passed}/${summary.totals.checks} 通过，${summary.totals.failed} 失败`)
  if (extra.workspaceScenario !== undefined && extra.workspaceScenario !== null) {
    const space = extra.workspaceScenario
    lines.push(
      `- 多工作区场景：隔离宿主可用工作区 ${space.workspaceCount} 个；第二个工作区 id \`${space.secondWorkspaceId}\` ${
        space.realHostWorkspace
          ? '是真实宿主工作区'
          : '是合成 id（通过真实保存 API 写入、由真实 UI 渲染与持久化，但并非宿主真实工作区）'
      }。`,
    )
  }
  lines.push('')
  lines.push('## 逐项结果')
  lines.push('')
  lines.push('| 组 | 断言 | 结果 | 证据/详情 |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of checks) {
    const detail = entry.detail === null ? '' : String(typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)).replace(/\|/g, '\\|').slice(0, 300)
    lines.push(`| ${entry.group} | ${entry.name} | ${entry.pass ? 'PASS' : '**FAIL**'} | ${detail} |`)
  }
  if (failed.length > 0) {
    lines.push('')
    lines.push('## 失败明细')
    for (const entry of failed) lines.push(`- **${entry.group} / ${entry.name}**：${JSON.stringify(entry.detail)}`)
  }
  lines.push('')
  lines.push('## 证据文件')
  lines.push('')
  for (const file of artifacts) lines.push(`- \`${file}\``)
  fs.writeFileSync(path.join(OUT, 'e2e-report.md'), lines.join('\n') + '\n', 'utf8')
  return summary
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
;(async () => {
  let url = null
  try {
    bootstrapEnvironment()
    url = await startServer()
    console.log(`server: ${url}`)

    browser = await chromium.launch({ ...(CHROME === undefined ? {} : { executablePath: CHROME }), headless: true })
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    const initial = await scenarioPanelAndPalette(url)
    step('node+inspector')
    await scenarioNodeAndInspector()
    step('enter-no-run')
    const { activeId } = await scenarioEnterNoRun(initial.sessionsBefore)
    step('connect+persist')
    await scenarioConnectAndPersist(activeId)
    step('chain-run')
    await scenarioChainRun(activeId, initial.sessionsBefore)
    step('parallel-gateway')
    await scenarioParallelGateway()
    step('stop-detach')
    await scenarioStopDetach()
    step('stop-cancel')
    await scenarioStopCancel()
    step('failure')
    await scenarioFailure()
    step('workspace-colors')
    const workspaceScenario = await scenarioWorkspaceColors()
    step('run-from-node')
    await scenarioRunFromNode()
    step('console')
    await scenarioConsole()

    const summary = renderReport({ url, workspaceScenario })
    console.log(`\nE2E done: ${summary.totals.passed}/${summary.totals.checks} checks passed, ${summary.totals.failed} failed`)
    console.log(`report: ${path.join(OUT, 'e2e-report.md')}`)
    for (const failure of summary.failures) console.log(`FAILED: ${failure.group} / ${failure.name} :: ${JSON.stringify(failure.detail)}`)
    if (summary.totals.failed > 0) process.exitCode = 2
  } catch (error) {
    console.error('E2E RUN FAILED:', error)
    writeText('99-run-error.txt', String(error?.stack ?? error))
    try {
      renderReport({ url })
    } catch {
      /* report best effort */
    }
    process.exitCode = 1
  } finally {
    if (browser !== null) await browser.close().catch(() => {})
    if (!KEEP_SERVER) stopServer()
  }
})()
