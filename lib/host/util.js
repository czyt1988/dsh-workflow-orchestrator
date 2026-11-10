/**
 * Small dependency-free helpers shared by the host half.
 *
 * The host half deliberately imports nothing from the DSH packages at runtime:
 * every capability is reached through Cordis services on the plugin context, so
 * the package stays loadable in any composed profile without its own peer
 * dependency tree.
 */
import { randomUUID } from 'node:crypto'

/** Create a short opaque identifier for workflows, nodes and runs. */
export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/** Return `value` when it is a non-empty trimmed string, otherwise undefined. */
export function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Clamp one finite number into [min, max]; non-finite values fall back. */
export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Truncate one string to at most `max` characters, appending an ellipsis. */
export function truncate(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Deep-clone a JSON-shaped value (state is always lossless JSON here). */
export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Serialize an unknown error into a stable human-readable message. */
export function errorMessage(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
    return `${code}${error.message || error.name}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** One line of the run log, bounded by the caller. */
export function logLine(level, message, extra = {}) {
  return { time: Date.now(), level, message, ...extra }
}
