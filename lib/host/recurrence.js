/**
 * Recurrence helpers for timer nodes.
 *
 * A timer node carries one of four modes:
 *
 *   - `once`:     one absolute instant (`at`, epoch milliseconds);
 *   - `daily`:    one local wall-clock time per day (`time`, `"HH:mm"`);
 *   - `weekly`:   one local wall-clock time on selected weekdays
 *                 (`weekdays`, ISO 1 = Monday … 7 = Sunday);
 *   - `interval`: a fixed number of minutes after the previous trigger
 *                 (`intervalMinutes`).
 *
 * All computations use the host machine's local time zone, exactly like the
 * user's `datetime-local` inputs in the panel, so a "daily 03:00" timer fires
 * at 03:00 local time across DST changes. Pure functions only, so the engine,
 * the scheduler and the unit tests share one definition of "next trigger".
 */

/** Modes accepted by a timer payload. */
export const TIMER_MODES = Object.freeze(['once', 'daily', 'weekly', 'interval'])

/** Local weekday label used by logs and descriptions (ISO: 1 = Monday). */
const WEEKDAY_LABELS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])

/** Minutes in one day. */
const MINUTES_PER_DAY = 24 * 60

/** Milliseconds in one day. */
const MS_PER_MINUTE = 60 * 1000

/**
 * Parse one `"HH:mm"` wall-clock value.
 * @param {unknown} value - candidate text.
 * @returns {{ hours: number, minutes: number } | undefined} parsed time.
 */
export function parseClockTime(value) {
  if (typeof value !== 'string') return undefined
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (match === null) return undefined
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/** Format a wall-clock time as `"HH:mm"`, falling back to `"03:00"`. */
export function formatClockTime(value) {
  const parsed = parseClockTime(value)
  if (parsed === undefined) return '03:00'
  return `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`
}

/** Minutes since local midnight for one parsed clock time. */
function clockMinutes(time) {
  return time.hours * 60 + time.minutes
}

/** Local weekday of one timestamp, ISO style (1 = Monday … 7 = Sunday). */
export function isoWeekday(timestamp) {
  const day = new Date(timestamp).getDay()
  return day === 0 ? 7 : day
}

/**
 * The next local-midnight-based occurrence of a wall clock after `from`.
 * @param {number} from - reference instant (ms).
 * @param {string} time - `"HH:mm"`.
 * @returns {number | undefined} the next instant strictly after `from`.
 */
function nextDailyOccurrence(from, time) {
  const parsed = parseClockTime(time)
  if (parsed === undefined) return undefined
  const candidate = new Date(from)
  candidate.setHours(parsed.hours, parsed.minutes, 0, 0)
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * The next occurrence of a weekly timer after `from`.
 * @param {number} from - reference instant (ms).
 * @param {string} time - `"HH:mm"`.
 * @param {number[]} weekdays - ISO weekdays, 1 = Monday … 7 = Sunday.
 * @returns {number | undefined} the next instant strictly after `from`.
 */
function nextWeeklyOccurrence(from, time, weekdays) {
  const parsed = parseClockTime(time)
  if (parsed === undefined) return undefined
  const days = Array.isArray(weekdays) && weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5, 6, 7]
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(parsed.hours, parsed.minutes, 0, 0)
    if (candidate.getTime() <= from) continue
    if (!days.includes(isoWeekday(candidate.getTime()))) continue
    return candidate.getTime()
  }
  return undefined
}

/**
 * The next trigger instant of one timer payload after `from`.
 *
 * `interval` counts from `from` (the previous trigger or the moment the node
 * started waiting); the other modes are wall-clock aligned.
 * @param {object} timer - sanitized timer payload.
 * @param {number} from - reference instant (ms).
 * @returns {number | undefined} next trigger instant, or undefined when the
 *   payload cannot be scheduled (invalid time, or a one-shot without `at`).
 */
export function nextOccurrence(timer, from) {
  if (timer === null || typeof timer !== 'object') return undefined
  const reference = Number.isFinite(from) ? from : Date.now()
  if (timer.mode === 'once') {
    return Number.isFinite(timer.at) ? timer.at : undefined
  }
  if (timer.mode === 'interval') {
    const minutes = Number(timer.intervalMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return undefined
    return reference + minutes * MS_PER_MINUTE
  }
  if (timer.mode === 'weekly') {
    return nextWeeklyOccurrence(reference, timer.time, timer.weekdays)
  }
  return nextDailyOccurrence(reference, timer.time)
}

/**
 * One `"YYYY-MM-DD HH:mm"` rendering of a local instant, used by run logs and
 * the panel's "next trigger" hints.
 * @param {number} timestamp - epoch milliseconds.
 * @returns {string} local date and time, or `"未知时间"` when invalid.
 */
export function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '未知时间'
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Whether a timer repeats forever. Periodic timers are the ones the panel
 * warns about: a workflow whose entry timer is periodic starts itself again
 * and again, and each run costs tokens.
 * @param {object} timer - sanitized timer payload.
 * @returns {boolean} true for daily/weekly/interval timers.
 */
export function timerIsPeriodic(timer) {
  return timer !== null && typeof timer === 'object' && timer.mode !== 'once'
}

/**
 * Human readable timer description used in logs and the node cards.
 * @param {object} timer - sanitized timer payload.
 * @returns {string} simplified Chinese description.
 */
export function describeTimer(timer) {
  if (timer === null || typeof timer !== 'object') return '定时节点'
  if (timer.mode === 'once') {
    return Number.isFinite(timer.at) ? `一次性 · ${formatDateTime(timer.at)}` : '一次性 · 时间未设置'
  }
  if (timer.mode === 'interval') {
    const minutes = Number(timer.intervalMinutes)
    if (minutes >= 60 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`
    return `每 ${Number.isFinite(minutes) ? minutes : 60} 分钟`
  }
  const clock = formatClockTime(timer.time)
  if (timer.mode === 'weekly') {
    const days = Array.isArray(timer.weekdays) && timer.weekdays.length > 0
      ? [...timer.weekdays].sort((left, right) => left - right).map((day) => WEEKDAY_LABELS[day - 1] ?? '').join('、')
      : '未选择星期'
    return `每周 ${days} ${clock}`
  }
  return `每天 ${clock}`
}

/**
 * Validate one sanitized timer payload; returns human-readable problems.
 * @param {object} timer - sanitized timer payload.
 * @param {number} now - current instant, used to reject a one-shot in the past.
 * @param {{ allowPastOnce?: boolean }} [options] - the scheduler accepts a
 *   one-shot whose instant just passed (it is inside the catch-up window), so
 *   it validates with `allowPastOnce: true`.
 * @returns {string[]} problems for `validateWorkflow`.
 */
export function timerValidationProblems(timer, now = Date.now(), options = {}) {
  const problems = []
  if (timer === null || typeof timer !== 'object') return ['定时配置缺失']
  if (timer.mode === 'once') {
    if (!Number.isFinite(timer.at)) problems.push('一次性触发时间未设置')
    else if (options.allowPastOnce !== true && timer.at <= now - 60 * 1000) {
      problems.push('一次性触发时间已过去，请改为未来的时间或切换为周期重复')
    }
  } else if (timer.mode === 'daily') {
    if (parseClockTime(timer.time) === undefined) problems.push('每日触发时间格式无效（应为 HH:mm）')
  } else if (timer.mode === 'weekly') {
    if (parseClockTime(timer.time) === undefined) problems.push('每周触发时间格式无效（应为 HH:mm）')
    if (!Array.isArray(timer.weekdays) || timer.weekdays.length === 0) problems.push('每周触发需要至少选择一天')
  } else if (timer.mode === 'interval') {
    const minutes = Number(timer.intervalMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) problems.push('重复间隔必须大于 0 分钟')
    else if (minutes > 7 * MINUTES_PER_DAY) problems.push('重复间隔不能超过 7 天')
  } else {
    problems.push('未知的定时模式')
  }
  return problems
}
