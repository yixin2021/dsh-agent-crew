/**
 * Durable plugin-owned state for Agent Crew.
 *
 * The store keeps profiles, runs, and task attempts in one small JSON document.
 * Every mutation is serialized, applied to a draft, persisted atomically, and
 * only then published to readers. A failed write leaves the previous state
 * intact. The document is plugin state, not session history: the DSH session
 * log remains the authority for what the model saw.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CrewError, cloneJson, nowIso } from './util.js'

/** Current on-disk document version. */
export const STATE_VERSION = 1

/**
 * @typedef {object} CrewState
 * @property {number} version
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Record<string, any>} profiles
 * @property {string[]} profileOrder
 * @property {Record<string, any>} runs
 * @property {string[]} runOrder
 */

/** @returns {CrewState} */
export function emptyState() {
  const time = nowIso()
  return {
    version: STATE_VERSION,
    createdAt: time,
    updatedAt: time,
    profiles: {},
    profileOrder: [],
    runs: {},
    runOrder: [],
  }
}

/**
 * Accept only the shape this version understands; unknown fields are dropped by
 * rebuilding the top level, while records stay as stored for forward tolerance.
 * @param {unknown} raw
 * @returns {CrewState}
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CrewError('STATE_INVALID', 'The agent-crew state document is not an object.')
  }
  const input = /** @type {Record<string, any>} */ (raw)
  if (input.version !== STATE_VERSION) {
    throw new CrewError(
      'STATE_VERSION_UNSUPPORTED',
      `Agent-crew state version ${String(input.version)} is not supported (expected ${STATE_VERSION}).`,
    )
  }
  const state = emptyState()
  state.createdAt = typeof input.createdAt === 'string' ? input.createdAt : state.createdAt
  state.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : state.updatedAt
  state.profiles = input.profiles && typeof input.profiles === 'object' && !Array.isArray(input.profiles) ? input.profiles : {}
  state.runs = input.runs && typeof input.runs === 'object' && !Array.isArray(input.runs) ? input.runs : {}
  state.profileOrder = Array.isArray(input.profileOrder)
    ? input.profileOrder.filter((id) => typeof id === 'string' && id in state.profiles)
    : Object.keys(state.profiles)
  state.runOrder = Array.isArray(input.runOrder)
    ? input.runOrder.filter((id) => typeof id === 'string' && id in state.runs)
    : Object.keys(state.runs)
  return state
}

/**
 * Trim the oldest settled runs beyond the configured history bound.
 * @param {CrewState} state
 * @param {number} maxRuns
 */
function pruneRuns(state, maxRuns) {
  while (state.runOrder.length > maxRuns) {
    const index = state.runOrder.findIndex((id) => state.runs[id]?.status !== 'running')
    if (index < 0) break
    const [id] = state.runOrder.splice(index, 1)
    delete state.runs[id]
  }
}

export class CrewStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir directory that holds the state file
   * @param {string} [options.fileName]
   * @param {number} [options.maxRuns]
   * @param {{ warn?: (message: string) => void }} [options.logger]
   */
  constructor({ dataDir, fileName = 'state.json', maxRuns = 50, logger } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) {
      throw new CrewError('STATE_DIR_MISSING', 'Agent-crew requires a data directory.')
    }
    this.dataDir = dataDir
    this.fileName = fileName
    this.filePath = path.join(dataDir, fileName)
    this.maxRuns = Math.max(1, Number(maxRuns) || 50)
    this.logger = logger
    /** @type {CrewState} */
    this.state = emptyState()
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
    /** @type {string | undefined} */
    this.loadWarning = undefined
    this.loaded = false
  }

  /**
   * Load the document. Missing files start empty; a corrupt or unsupported file
   * is preserved beside the state file and reported through `loadWarning`.
   * @returns {Promise<{ warning?: string }>}
   */
  async load() {
    if (this.loaded) return { warning: this.loadWarning }
    this.loaded = true
    try {
      const text = await readFile(this.filePath, 'utf8')
      this.state = normalizeState(JSON.parse(text))
      pruneRuns(this.state, this.maxRuns)
    } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'ENOENT') {
        this.state = emptyState()
        return {}
      }
      const suffix = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = `${this.filePath}.corrupt-${suffix}`
      try {
        await rename(this.filePath, backup)
      } catch {
        // Keep the original in place when moving is impossible; the warning
        // still tells the user where the unreadable document lives.
      }
      this.state = emptyState()
      this.loadWarning =
        `Agent-crew state at ${this.filePath} could not be loaded (${error && typeof error === 'object' && 'message' in error ? error.message : String(error)}). ` +
        `A fresh state was started; the previous document is preserved at ${backup}.`
      this.logger?.warn?.(this.loadWarning)
    }
    return { warning: this.loadWarning }
  }

  /**
   * Read a derived value synchronously from the published state.
   * @template T
   * @param {(state: CrewState) => T} reader
   * @returns {T}
   */
  read(reader) {
    return reader(this.state)
  }

  /**
   * Apply one mutation and publish it only after the durable write succeeds.
   * Mutations run one at a time in call order.
   * @template T
   * @param {(draft: CrewState) => T} mutator
   * @returns {Promise<T>}
   */
  update(mutator) {
    const run = async () => {
      const draft = cloneJson(this.state)
      const value = mutator(draft)
      pruneRuns(draft, this.maxRuns)
      draft.updatedAt = nowIso()
      await this.#persist(draft)
      this.state = draft
      return value
    }
    const next = this.queue.then(run, run)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Persist a draft through a same-directory temporary file and rename.
   * @param {CrewState} draft
   */
  async #persist(draft) {
    await mkdir(this.dataDir, { recursive: true })
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        await rename(temporary, this.filePath)
      } catch (error) {
        const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
        if (code !== 'EEXIST' && code !== 'EPERM') throw error
        await rm(this.filePath, { force: true })
        await rename(temporary, this.filePath)
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw new CrewError(
        'STATE_WRITE_FAILED',
        `Agent-crew could not persist its state to ${this.filePath}: ${error && typeof error === 'object' && 'message' in error ? error.message : String(error)}`,
      )
    }
  }
}
