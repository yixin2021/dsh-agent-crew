/**
 * Small dependency-free helpers shared by the agent-crew plugin and its tests.
 * No DSH imports live here, so the orchestration core stays unit-testable.
 */

import { randomUUID } from 'node:crypto'

/** Stable error shape carried through tool results. */
export class CrewError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details] optional structured details
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'CrewError'
    this.code = code
    this.details = details
  }
}

/** @returns {string} an ISO timestamp */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Create a readable, collision-resistant id such as `run_mc4x1k_ab12cd`.
 * @param {string} prefix
 * @returns {string}
 */
export function createId(prefix) {
  const time = Date.now().toString(36)
  const random = randomUUID().replaceAll('-', '').slice(0, 8)
  return `${prefix}_${time}_${random}`
}

/**
 * Turn arbitrary text into a model-facing agent name segment.
 * Activation names must match /^[a-z][a-z0-9-]{0,31}$/ and must not be `lead`.
 * @param {string} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(text, fallback = 'agent') {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 24)
  if (!slug || !/^[a-z]/.test(slug) || slug === 'lead') return fallback
  return slug
}

/**
 * Build a unique child name for one dispatch attempt. The subagent runtime keeps
 * names for the lifetime of a creator, so every attempt needs a fresh suffix.
 * @param {string} base
 * @param {number} counter
 * @returns {string}
 */
export function childName(base, counter) {
  const stem = slugify(base, 'agent')
  const token = `${counter}${Math.random().toString(36).slice(2, 6)}`
  const suffix = `-${token}`
  return `${stem.slice(0, 32 - suffix.length)}${suffix}`
}

/**
 * Truncate without splitting a surrogate pair.
 * @param {string} text
 * @param {number} max
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncate(text, max) {
  const value = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) {
    return { text: value, truncated: false }
  }
  return { text: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

/**
 * Normalize an unknown thrown value for structured results and logs.
 * @param {unknown} error
 * @returns {{ code: string, message: string, details?: unknown }}
 */
export function errorInfo(error) {
  if (error instanceof CrewError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  if (error && typeof error === 'object') {
    const value = /** @type {{ code?: unknown, message?: unknown, name?: unknown }} */ (error)
    return {
      code: typeof value.code === 'string' && value.code ? value.code : 'INTERNAL_ERROR',
      message:
        typeof value.message === 'string' && value.message
          ? value.message
          : 'Unknown error',
    }
  }
  return { code: 'INTERNAL_ERROR', message: String(error) }
}

/**
 * Sleep cooperatively; resolves early when the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Join text content blocks from a subagent result.
 * @param {readonly unknown[] | undefined} blocks
 * @returns {string}
 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Return a structured clone of a JSON value.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  return structuredClone(value)
}

/**
 * Whether a value is a non-array object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
