/**
 * Action node catalog and executor.
 *
 * An action node owns no task session. When the run reaches it the engine calls
 * `executeActionReal`, which performs exactly one OS/network side effect:
 *
 *   - shutdown / restart / sleep / lock: power and session control, with a
 *     configurable grace delay so a mistaken run can still be cancelled;
 *   - cancel-shutdown: cancels a pending shutdown/restart (`shutdown /a`);
 *   - open-url / open-path: opens a browser URL or a file/folder;
 *   - run-command: runs a user command through the platform shell;
 *   - http-request: sends one HTTP request and records the response status;
 *   - log: writes the configured line to the run log (a safe placeholder).
 *
 * Every action is `dryRun`-able: when `dryRun` is true the executor performs no
 * side effect at all, only reporting what it would do. New action nodes default
 * to `dryRun: true`, so a user must deliberately disable it before a workflow
 * can shut down the machine.
 */
import { spawn } from 'node:child_process'

/** Kinds the action node understands, in the order the inspector lists them. */
export const ACTION_KINDS = Object.freeze([
  'shutdown',
  'restart',
  'sleep',
  'lock',
  'cancel-shutdown',
  'open-url',
  'open-path',
  'run-command',
  'http-request',
  'log',
])

/** Labels rendered by the inspector select and the node card. */
const ACTION_LABELS = Object.freeze({
  shutdown: '自动关机',
  restart: '自动重启',
  sleep: '进入睡眠',
  lock: '锁定屏幕',
  'cancel-shutdown': '取消已计划的关机/重启',
  'open-url': '打开网址',
  'open-path': '打开文件或文件夹',
  'run-command': '运行自定义命令',
  'http-request': '发送 HTTP 请求',
  log: '只写一条日志（安全占位）',
})

/** Short label for one action kind. */
function kindLabel(kind) {
  return ACTION_LABELS[kind] ?? '未知动作'
}

/** Format a millisecond delay as a whole number of seconds. */
function delaySeconds(action) {
  const value = Number(action?.delaySeconds)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 60
}

/** Clip one text value for display. */
function clip(text, max) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * One human-readable description used by logs, the node card and the run
 * history summary.
 * @param {object} action - sanitized action payload.
 * @returns {string} simplified Chinese description.
 */
export function describeAction(action) {
  const source = action !== null && typeof action === 'object' ? action : {}
  const kind = source.kind
  switch (kind) {
    case 'shutdown':
      return `自动关机（${delaySeconds(source)} 秒后）`
    case 'restart':
      return `自动重启（${delaySeconds(source)} 秒后）`
    case 'sleep':
      return '进入睡眠'
    case 'lock':
      return '锁定屏幕'
    case 'cancel-shutdown':
      return '取消已计划的关机/重启'
    case 'open-url':
      return `打开网址 ${clip(source.url, 80) || '（未填写）'}`
    case 'open-path':
      return `打开 ${clip(source.path, 80) || '（未填写路径）'}`
    case 'run-command':
      return `运行命令 ${clip(source.command, 60) || '（未填写）'}`
    case 'http-request':
      return `发送 ${source.method ?? 'GET'} 请求 ${clip(source.url, 80) || '（未填写）'}`
    case 'log':
      return `写入日志：${clip(source.text, 60) || '动作节点已执行'}`
    default:
      return '未知动作'
  }
}

/** Whether one URL is an absolute http(s) URL. */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate one sanitized action payload; returns human-readable problems.
 * @param {object} action - sanitized action payload.
 * @returns {string[]} problems for `validateWorkflow`.
 */
export function actionValidationProblems(action) {
  if (action === null || typeof action !== 'object') return ['动作配置缺失']
  if (!ACTION_KINDS.includes(action.kind)) return ['未知的动作类型']
  const problems = []
  if (action.kind === 'open-url' || action.kind === 'http-request') {
    if (!isHttpUrl(action.url)) problems.push('需要填写以 http:// 或 https:// 开头的有效网址')
  }
  if (action.kind === 'open-path' && (typeof action.path !== 'string' || action.path.trim() === '')) {
    problems.push('需要填写要打开的文件或文件夹路径')
  }
  if (action.kind === 'run-command' && (typeof action.command !== 'string' || action.command.trim() === '')) {
    problems.push('需要填写要运行的命令')
  }
  if (action.kind === 'http-request' && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(action.method)) {
    problems.push('HTTP 方法只能是 GET / POST / PUT / PATCH / DELETE')
  }
  if (action.kind === 'http-request' && action.method === 'GET' && typeof action.body === 'string' && action.body.trim() !== '') {
    problems.push('GET 请求不能带请求体，请改用 POST/PUT/PATCH')
  }
  if ((action.kind === 'shutdown' || action.kind === 'restart') && !(delaySeconds(action) >= 10)) {
    problems.push('关机/重启的缓冲时间至少 10 秒')
  }
  return problems
}

/** One promise-friendly wait that honours an abort signal. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(finish, Math.max(0, ms))
    if (typeof timer.unref === 'function') timer.unref()
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/**
 * Run one child process, capture its bounded output and settle on exit.
 * @param {string} command - executable name.
 * @param {string[]} args - argv style arguments.
 * @param {{ signal?: AbortSignal, cwd?: string, timeoutMs?: number }} options - execution limits.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} process outcome.
 */
function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    const cap = (current, chunk) => (current.length >= 4000 ? current : (current + String(chunk)).slice(0, 4000))
    child.stdout?.on('data', (chunk) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = cap(stderr, chunk)
    })
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000
    // A timeout of 0 means "no process deadline": power transitions (sleep /
    // lock) can block for as long as the machine is suspended.
    const timer = options.timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/**
 * Throw when a process failed, carrying its stderr for the run log.
 * @param {{ code: number | null, stdout: string, stderr: string }} result - process outcome.
 * @param {string} label - action label for the message.
 */
function ensureSucceeded(result, label) {
  if (result.code === 0) return
  const detail = result.stderr || result.stdout || `退出码 ${result.code}`
  throw new Error(`${label}失败：${detail}`)
}

/** Run one shell command through the platform's default shell. */
async function runShellCommand(action, signal) {
  const command = typeof action.command === 'string' ? action.command.trim() : ''
  const timeoutMs = Number(action.timeoutSeconds) * 1000
  const cwd = typeof action.cwd === 'string' && action.cwd.trim() !== '' ? action.cwd.trim() : undefined
  const result = process.platform === 'win32'
    ? await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, signal, timeoutMs })
    : await runProcess(process.env.SHELL ?? 'bash', ['-lc', command], { cwd, signal, timeoutMs })
  ensureSucceeded(result, '运行命令')
  return result.stdout === '' ? '命令执行成功（无输出）' : `命令输出：${result.stdout}`
}

/**
 * Read at most `maxChars` of a response body. The action must never buffer an
 * unbounded response (a misconfigured URL can stream gigabytes) so the body
 * stream is cancelled once enough text is collected.
 * @param {Response} response - fetch response.
 * @param {number} maxChars - stop threshold.
 * @returns {Promise<string>} bounded response text.
 */
async function readBoundedText(response, maxChars = 4000) {
  const body = response.body
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : undefined
    let text = ''
    try {
      while (text.length < maxChars) {
        const chunk = await reader.read()
        if (chunk.done === true) break
        const piece = decoder === undefined ? String(chunk.value) : decoder.decode(chunk.value, { stream: true })
        text += piece
      }
    } catch {
      /* a broken stream still yields the text read so far */
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* already closed */
      }
    }
    return text.length > maxChars ? text.slice(0, maxChars) : text
  }
  const text = await response.text().catch(() => '')
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** One HTTP request through the built-in fetch. */
async function runHttpRequest(action, signal) {
  const url = typeof action.url === 'string' ? action.url.trim() : ''
  const method = typeof action.method === 'string' ? action.method : 'GET'
  const timeoutMs = Math.max(1, Number(action.timeoutSeconds) || 60) * 1000
  const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  const signals = [signal, timeoutSignal].filter((entry) => entry !== undefined)
  const combined = typeof AbortSignal.any === 'function' && signals.length > 0 ? AbortSignal.any(signals) : signals[0]
  const init = { method, signal: combined, headers: {} }
  const canHaveBody = method !== 'GET' && method !== 'HEAD'
  if (canHaveBody && typeof action.body === 'string' && action.body !== '') {
    init.body = action.body
    init.headers['content-type'] = 'application/json; charset=utf-8'
  }
  const response = await fetch(url, init)
  const clipped = clip(await readBoundedText(response), 2000)
  if (!response.ok) throw new Error(`HTTP 请求失败：${response.status} ${response.statusText}${clipped === '' ? '' : `：${clipped}`}`)
  return `HTTP ${response.status}${clipped === '' ? '' : `：${clipped}`}`
}

/** Platform-specific immediate shutdown/restart/sleep/lock command. */
async function runPowerAction(action, signal) {
  const kind = action.kind
  const seconds = delaySeconds(action)
  const message = typeof action.message === 'string' && action.message.trim() !== ''
    ? clip(action.message, 200)
    : 'DSH 工作流编排：任务已完成'
  const platform = process.platform
  if (platform === 'win32') {
    if (kind === 'shutdown') {
      const result = await runProcess('shutdown.exe', ['/s', '/t', String(seconds), '/c', message], { signal, timeoutMs: 15_000 })
      ensureSucceeded(result, '计划关机')
      return `已请求在 ${seconds} 秒后关机（可用「取消已计划的关机/重启」动作或 shutdown /a 取消）`
    }
    if (kind === 'restart') {
      const result = await runProcess('shutdown.exe', ['/r', '/t', String(seconds), '/c', message], { signal, timeoutMs: 15_000 })
      ensureSucceeded(result, '计划重启')
      return `已请求在 ${seconds} 秒后重启（可用「取消已计划的关机/重启」动作或 shutdown /a 取消）`
    }
    if (kind === 'sleep') {
      const result = await runProcess('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { signal, timeoutMs: 0 })
      ensureSucceeded(result, '进入睡眠')
      return '已请求进入睡眠'
    }
    const result = await runProcess('rundll32.exe', ['user32.dll,LockWorkStation'], { signal, timeoutMs: 0 })
    ensureSucceeded(result, '锁定屏幕')
    return '已锁定屏幕'
  }
  // Non-Windows hosts honour the grace delay locally, then run the immediate command.
  if (kind === 'shutdown' || kind === 'restart') await wait(seconds * 1000, signal)
  if (signal?.aborted === true) throw new Error('动作已取消')
  if (platform === 'darwin') {
    if (kind === 'shutdown') {
      ensureSucceeded(await runProcess('osascript', ['-e', 'tell application "System Events" to shut down'], { signal }), '关机')
      return '已请求关机'
    }
    if (kind === 'restart') {
      ensureSucceeded(await runProcess('osascript', ['-e', 'tell application "System Events" to restart'], { signal }), '重启')
      return '已请求重启'
    }
    if (kind === 'sleep') {
      ensureSucceeded(await runProcess('pmset', ['sleepnow'], { signal }), '进入睡眠')
      return '已请求进入睡眠'
    }
    ensureSucceeded(await runProcess('pmset', ['displaysleepnow'], { signal }), '锁定屏幕')
    return '已请求关闭显示器（macOS 的锁屏等价操作）'
  }
  if (kind === 'shutdown') {
    ensureSucceeded(await runProcess('systemctl', ['poweroff'], { signal }), '关机')
    return '已请求关机'
  }
  if (kind === 'restart') {
    ensureSucceeded(await runProcess('systemctl', ['reboot'], { signal }), '重启')
    return '已请求重启'
  }
  if (kind === 'sleep') {
    ensureSucceeded(await runProcess('systemctl', ['suspend'], { signal }), '进入睡眠')
    return '已请求进入睡眠'
  }
  ensureSucceeded(await runProcess('loginctl', ['lock-session'], { signal }), '锁定屏幕')
  return '已请求锁定屏幕'
}

/** Cancel a pending shutdown/restart where the platform supports it. */
async function cancelPendingPowerAction(signal) {
  if (process.platform === 'win32') {
    const result = await runProcess('shutdown.exe', ['/a'], { signal, timeoutMs: 15_000 })
    ensureSucceeded(result, '取消关机')
    return '已取消已计划的关机/重启'
  }
  if (process.platform === 'darwin') {
    const result = await runProcess('killall', ['shutdown'], { signal, timeoutMs: 15_000 })
    // No pending shutdown means killall reports "no matching process"; treat it as success.
    return result.code === 0 ? '已取消已计划的关机/重启' : '没有待取消的关机任务'
  }
  const result = await runProcess('shutdown', ['-c'], { signal, timeoutMs: 15_000 })
  return result.code === 0 ? '已取消已计划的关机/重启' : '没有待取消的关机任务'
}

/**
 * Execute one action for real.
 * @param {{ action: object, signal?: AbortSignal }} request - action payload and cancellation signal.
 * @returns {Promise<{ summary: string }>} a short result summary for the run log.
 */
export async function executeActionReal({ action, signal }) {
  const source = action !== null && typeof action === 'object' ? action : {}
  const kind = ACTION_KINDS.includes(source.kind) ? source.kind : 'log'
  const description = describeAction(source)
  if (source.dryRun !== false) return { summary: `试运行，未执行实际动作：${description}` }
  if (kind === 'log') {
    return { summary: `动作节点日志：${typeof source.text === 'string' && source.text.trim() !== '' ? clip(source.text, 500) : '动作节点已执行'}` }
  }
  if (kind === 'shutdown' || kind === 'restart' || kind === 'sleep' || kind === 'lock') {
    return { summary: await runPowerAction(source, signal) }
  }
  if (kind === 'cancel-shutdown') return { summary: await cancelPendingPowerAction(signal) }
  if (kind === 'open-url') {
    const url = source.url.trim()
    if (process.platform === 'win32') {
      ensureSucceeded(await runProcess('rundll32.exe', ['url.dll,FileProtocolHandler', url], { signal }), '打开网址')
    } else if (process.platform === 'darwin') {
      ensureSucceeded(await runProcess('open', [url], { signal }), '打开网址')
    } else {
      ensureSucceeded(await runProcess('xdg-open', [url], { signal }), '打开网址')
    }
    return `已请求打开网址 ${url}`
  }
  if (kind === 'open-path') {
    const target = source.path.trim()
    if (process.platform === 'win32') {
      // explorer.exe exits non-zero even on success; only spawn failure matters.
      await runProcess('explorer.exe', [target], { signal, timeoutMs: 15_000 }).catch((error) => {
        throw new Error(`打开路径失败：${error?.message ?? error}`)
      })
    } else if (process.platform === 'darwin') {
      ensureSucceeded(await runProcess('open', [target], { signal }), '打开路径')
    } else {
      ensureSucceeded(await runProcess('xdg-open', [target], { signal }), '打开路径')
    }
    return `已请求打开 ${target}`
  }
  if (kind === 'run-command') return { summary: await runShellCommand(source, signal) }
  if (kind === 'http-request') return { summary: await runHttpRequest(source, signal) }
  return { summary: `${kindLabel(kind)}：没有可执行的具体动作` }
}
