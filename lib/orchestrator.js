/**
 * Agent Crew orchestration engine.
 *
 * The lead delegate creates a run, adds tasks with dependencies, and starts the
 * run. The engine executes ready tasks in waves, delegates each attempt through
 * an injected `delegate` function (the DSH subagent seam), retries retryable
 * failures, blocks dependents of failed tasks, and publishes a deterministic
 * run summary. It owns no agents and imports no DSH packages.
 */

import {
  CrewError,
  childName,
  cloneJson,
  createId,
  errorInfo,
  isRecord,
  nowIso,
  sleep,
  textOfBlocks,
  truncate,
} from './util.js'
import {
  DEFAULT_RUNTIME,
  LOCAL_RUNTIMES,
  buildRolePrompt,
  buildTaskPrompt,
  normalizeProfile,
  publicProfile,
  resolveToolPolicy,
} from './profiles.js'
import { appendNote, memoryStats, promptMemory, readMemory, removeNote, runNoteText } from './memory.js'

/** Characters of the dispatched prompt kept for the run record. */
const PROMPT_PREVIEW_CHARS = 2000

/** Memory kind labels used inside the task prompt. */
const MEMORY_LABELS = Object.freeze({
  en: (kind) => ({ note: 'note', lesson: 'lesson', run: 'earlier job' })[kind] ?? 'note',
  zh: (kind) => ({ note: '记录', lesson: '经验', run: '此前任务' })[kind] ?? '记录',
})

const RUN_STATUSES = new Set(['planning', 'ready', 'running', 'completed', 'failed', 'cancelled'])
const RETRYABLE_STOP_REASONS = new Set(['error', 'max-tokens'])
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled'])

/**
 * @typedef {object} CrewLimits
 * @property {number} defaultMaxAttempts
 * @property {number} maxParallel
 * @property {number} taskTimeoutMs
 * @property {number} retryBackoffMs
 * @property {number} maxResultChars
 * @property {number} maxTasksPerRun
 * @property {number} previewChars
 * @property {boolean} allowNestedOrchestration
 */

/**
 * @param {Record<string, unknown>} [config]
 * @returns {CrewLimits}
 */
export function resolveLimits(config = {}) {
  const clamp = (value, min, max, fallback) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }
  return {
    defaultMaxAttempts: clamp(config.defaultMaxAttempts, 1, 5, 2),
    maxParallel: clamp(config.maxParallel, 1, 16, 3),
    taskTimeoutMs: clamp(config.taskTimeoutMs, 0, 86_400_000, 600_000),
    retryBackoffMs: clamp(config.retryBackoffMs, 0, 60_000, 750),
    maxResultChars: clamp(config.maxResultChars, 500, 200_000, 12_000),
    maxTasksPerRun: clamp(config.maxTasksPerRun, 1, 256, 64),
    previewChars: clamp(config.previewChars, 120, 4_000, 600),
    allowNestedOrchestration: config.allowNestedOrchestration === true,
  }
}

/** @param {any} run */
function tasksOf(run) {
  return run.taskOrder.map((id) => run.tasks[id]).filter(Boolean)
}

/** @param {any} run */
function countsOf(run) {
  const counts = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 }
  for (const task of tasksOf(run)) {
    counts.total += 1
    if (task.status in counts) counts[task.status] += 1
  }
  return counts
}

/** @param {any} run */
function summarize(run) {
  const counts = countsOf(run)
  const lines = [
    `Crew run ${run.id} — ${run.status}`,
    `${counts.completed}/${counts.total} completed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.cancelled} cancelled, ${counts.pending + counts.running} open`,
  ]
  if (run.title) lines.push(`Title: ${run.title}`)
  for (const task of tasksOf(run)) {
    const error = task.error?.code ? ` — ${task.error.code}` : ''
    lines.push(`- [${task.status}] ${task.profileId}: ${task.subject}${error}`)
  }
  return lines.join('\n')
}

/** @param {any} run */
function assertAcyclic(run) {
  const visiting = new Set()
  const done = new Set()
  /** @param {string} id */
  const visit = (id) => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      throw new CrewError('DEPENDENCY_CYCLE', `Task dependency cycle detected at ${id}.`)
    }
    const task = run.tasks[id]
    if (!task) throw new CrewError('TASK_NOT_FOUND', `Task ${id} does not exist.`)
    visiting.add(id)
    for (const dependency of task.dependsOn) visit(dependency)
    visiting.delete(id)
    done.add(id)
  }
  for (const id of run.taskOrder) visit(id)
}

/**
 * @param {object} options
 * @param {import('./store.js').CrewStore} options.store
 * @param {(input: {
 *   parent: any,
 *   profile: any,
 *   name: string,
 *   label: string,
 *   prompt: string,
 *   policy: any,
 *   timeoutMs: number,
 *   signal: AbortSignal,
 * }) => Promise<{
 *   childId: string,
 *   name: string,
 *   stopReason: string,
 *   text: string,
 *   structured?: unknown,
 *   diagnostic?: string,
 *   durationMs?: number,
 *   errorCode?: string,
 *   errorMessage?: string,
 * }>} options.delegate
 * @param {(agent?: any) => string[]} [options.toolNames]
 * @param {Partial<CrewLimits>} [options.limits]
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 */
export function createOrchestrator({ store, delegate, toolNames = () => [], limits = {}, logger } = {}) {
  if (!store) throw new CrewError('INTERNAL_ERROR', 'The agent-crew orchestrator requires a store.')
  if (typeof delegate !== 'function') throw new CrewError('INTERNAL_ERROR', 'The agent-crew orchestrator requires a delegate.')

  const resolved = { ...resolveLimits(limits) }
  /** @type {Map<string, AbortController>} */
  const activeRuns = new Map()
  let nameCounter = 0

  /** @param {string} runId */
  function requireRun(runId) {
    const run = store.read((state) => state.runs[runId])
    if (!run) throw new CrewError('RUN_NOT_FOUND', `Crew run "${runId}" does not exist.`)
    return run
  }

  /** @param {string} runId @param {string} taskId */
  function requireTask(runId, taskId) {
    const run = requireRun(runId)
    const task = run.tasks[taskId]
    if (!task) throw new CrewError('TASK_NOT_FOUND', `Task "${taskId}" does not exist in run "${runId}".`)
    return { run, task }
  }

  /** @param {string} profileId */
  function requireProfile(profileId) {
    const profile = store.read((state) => state.profiles[profileId])
    if (!profile) {
      throw new CrewError(
        'PROFILE_NOT_FOUND',
        `Agent profile "${profileId}" does not exist. Use crew_agent_list to see available profiles.`,
      )
    }
    // Profiles written before memory existed have no list; treat them as empty
    // so an upgrade never makes an existing specialist unusable.
    return profile.memory === undefined ? { ...profile, memory: [] } : profile
  }

  /** @param {number} requested */
  function parallelFor(requested) {
    const number = Number(requested)
    if (!Number.isFinite(number)) return resolved.maxParallel
    return Math.min(16, Math.max(1, Math.trunc(number)))
  }

  /**
   * Create or replace one profile in plugin state.
   * @param {unknown} input
   * @param {{ source?: 'store'|'config' }} [options]
   */
  async function defineProfile(input, { source = 'store' } = {}) {
    const profile = normalizeProfile(input, { source })
    if (profile.source === 'config') {
      // Config profiles are seeds: a runtime edit keeps the stored revision.
      const existing = store.read((state) => state.profiles[profile.id])
      if (existing && existing.source === 'store') return publicProfile(existing)
    }
    await store.update((state) => {
      const existing = state.profiles[profile.id]
      state.profiles[profile.id] = {
        ...profile,
        createdAt: existing?.createdAt ?? profile.createdAt,
        updatedAt: nowIso(),
      }
      if (!existing) state.profileOrder.push(profile.id)
    })
    return publicProfile(store.read((state) => state.profiles[profile.id]))
  }

  /** @param {{ includeInstructions?: boolean }} [options] */
  function listProfiles({ includeInstructions = false } = {}) {
    return store.read((state) =>
      state.profileOrder
        .map((id) => state.profiles[id])
        .filter(Boolean)
        .map((profile) => {
          const view = publicProfile(profile.memory === undefined ? { ...profile, memory: [] } : profile)
          if (!includeInstructions) delete view.instructions
          return view
        }),
    )
  }

  /** @param {string} profileId */
  async function removeProfile(profileId) {
    const existing = store.read((state) => state.profiles[profileId])
    if (!existing) throw new CrewError('PROFILE_NOT_FOUND', `Agent profile "${profileId}" does not exist.`)
    await store.update((state) => {
      delete state.profiles[profileId]
      state.profileOrder = state.profileOrder.filter((id) => id !== profileId)
    })
    return publicProfile(existing)
  }

  /**
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.objective]
   * @param {string} [input.cwd]
   * @param {number} [input.maxParallel]
   * @param {number} [input.maxAttempts]
   * @param {{ id: string, name?: string }} input.lead
   */
  async function createRun({ title, objective = '', cwd, maxParallel, maxAttempts, lead }) {
    const cleanTitle = String(title ?? '').trim()
    if (!cleanTitle) throw new CrewError('RUN_INVALID', 'A crew run needs a non-empty title.')
    if (cleanTitle.length > 160) throw new CrewError('RUN_INVALID', 'A crew run title must be at most 160 characters.')
    const cleanObjective = String(objective ?? '').trim()
    if (cleanObjective.length > 8000) {
      throw new CrewError('RUN_INVALID', 'A crew run objective must be at most 8000 characters.')
    }
    const runId = createId('run')
    const time = nowIso()
    const run = {
      id: runId,
      title: cleanTitle,
      objective: cleanObjective,
      status: 'planning',
      lead: { id: lead?.id ?? null, name: lead?.name ?? null },
      cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null,
      maxParallel: parallelFor(maxParallel),
      maxAttempts: Math.min(5, Math.max(1, Math.trunc(Number(maxAttempts) || resolved.defaultMaxAttempts))),
      taskOrder: [],
      tasks: {},
      summary: '',
      createdAt: time,
      updatedAt: time,
      startedAt: null,
      finishedAt: null,
    }
    await store.update((state) => {
      state.runs[runId] = run
      state.runOrder.push(runId)
    })
    return getRun(runId)
  }

  /**
   * Add one or more tasks to a run that has not started.
   * @param {string} runId
   * @param {Array<{
   *   profileId: string,
   *   subject: string,
   *   description?: string,
   *   key?: string,
   *   dependsOn?: string[],
   *   writeScopes?: string[],
   *   maxAttempts?: number,
   *   timeoutMs?: number,
   *   cwd?: string,
   * }>} inputs
   */
  async function addTasks(runId, inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new CrewError('TASK_INVALID', 'Provide at least one task.')
    }
    const run = requireRun(runId)
    if (run.status === 'running') throw new CrewError('RUN_BUSY', `Crew run "${runId}" is already running.`)
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
      throw new CrewError('RUN_CLOSED', `Crew run "${runId}" is ${run.status}; add tasks only before the first start.`)
    }

    const prepared = inputs.map((input) => {
      if (!isRecord(input)) throw new CrewError('TASK_INVALID', 'Each task must be an object.')
      const subject = String(input.subject ?? '').trim()
      if (!subject) throw new CrewError('TASK_INVALID', 'Each task needs a non-empty subject.')
      if (subject.length > 200) throw new CrewError('TASK_INVALID', 'A task subject must be at most 200 characters.')
      const description = String(input.description ?? '').trim()
      if (description.length > 12_000) {
        throw new CrewError('TASK_INVALID', 'A task description must be at most 12000 characters.')
      }
      const profileId = String(input.profileId ?? '').trim()
      if (!profileId) throw new CrewError('TASK_INVALID', 'Each task needs a profileId.')
      requireProfile(profileId)
      return {
        profileId,
        subject,
        description,
        key: typeof input.key === 'string' && input.key.trim() ? input.key.trim() : undefined,
        dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map((value) => String(value)) : [],
        writeScopes: Array.isArray(input.writeScopes)
          ? input.writeScopes.map((value) => String(value).trim()).filter(Boolean).slice(0, 20)
          : [],
        maxAttempts:
          input.maxAttempts === undefined
            ? undefined
            : Math.min(5, Math.max(1, Math.trunc(Number(input.maxAttempts) || run.maxAttempts))),
        // `0` is a trap: a delegation with no deadline can hang a run forever
        // and reads as a frozen UI. Treat it as "inherit the default".
        timeoutMs:
          input.timeoutMs === undefined || Number(input.timeoutMs) === 0
            ? undefined
            : Math.min(86_400_000, Math.max(1, Math.trunc(Number(input.timeoutMs)))),
        cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
      }
    })

    const added = await store.update((state) => {
      const draft = state.runs[runId]
      if (!draft) throw new CrewError('RUN_NOT_FOUND', `Crew run "${runId}" does not exist.`)
      if (draft.status !== 'planning' && draft.status !== 'ready') {
        throw new CrewError('RUN_CLOSED', `Crew run "${runId}" is ${draft.status}; add tasks only before the first start.`)
      }
      const existing = tasksOf(draft)
      if (existing.length + prepared.length > resolved.maxTasksPerRun) {
        throw new CrewError(
          'TASK_LIMIT_REACHED',
          `Crew runs accept at most ${resolved.maxTasksPerRun} tasks; ${existing.length} exist and ${prepared.length} were requested.`,
        )
      }
      const aliases = new Map()
      for (const task of existing) {
        aliases.set(task.id, task.id)
        if (task.key) aliases.set(task.key, task.id)
      }
      let next = existing.length + 1
      const created = prepared.map((input) => {
        const id = `task-${next++}`
        if (input.key) {
          if (aliases.has(input.key)) {
            throw new CrewError('TASK_KEY_DUPLICATE', `Task key "${input.key}" is already used in run "${runId}".`)
          }
          aliases.set(input.key, id)
        }
        const time = nowIso()
        return {
          id,
          key: input.key ?? null,
          runId,
          profileId: input.profileId,
          subject: input.subject,
          description: input.description,
          dependsOn: [],
          requestedDependsOn: input.dependsOn,
          writeScopes: input.writeScopes,
          status: 'pending',
          attempt: 0,
          maxAttempts: input.maxAttempts ?? draft.maxAttempts,
          timeoutMs: input.timeoutMs ?? null,
          cwd: input.cwd ?? null,
          childId: null,
          childName: null,
          attempts: [],
          result: null,
          resultPreview: null,
          error: null,
          createdAt: time,
          updatedAt: time,
          startedAt: null,
          finishedAt: null,
        }
      })
      for (const task of created) {
        const deps = []
        for (const reference of task.requestedDependsOn) {
          const dependency = aliases.get(reference)
          if (!dependency) {
            throw new CrewError(
              'DEPENDENCY_UNKNOWN',
              `Task "${task.key ?? task.id}" depends on "${reference}", which is neither a task id nor a key in run "${runId}".`,
            )
          }
          if (dependency === task.id) {
            throw new CrewError('DEPENDENCY_CYCLE', `Task "${task.id}" cannot depend on itself.`)
          }
          if (!deps.includes(dependency)) deps.push(dependency)
        }
        task.dependsOn = deps
        delete task.requestedDependsOn
        draft.tasks[task.id] = task
        draft.taskOrder.push(task.id)
      }
      assertAcyclic(draft)
      draft.status = 'ready'
      draft.updatedAt = nowIso()
      return created.map((task) => ({ id: task.id, key: task.key, subject: task.subject, profileId: task.profileId }))
    })

    return { run: getRun(runId), added }
  }

  /** @param {AbortSignal | undefined} outer @param {AbortController} controller */
  function linkSignal(outer, controller) {
    if (!outer) return () => {}
    if (outer.aborted) {
      controller.abort()
      return () => {}
    }
    const onAbort = () => controller.abort()
    outer.addEventListener('abort', onAbort, { once: true })
    return () => outer.removeEventListener('abort', onAbort)
  }

  /**
   * Mark dependents of failed tasks blocked and return how many changed.
   * @param {string} runId
   */
  async function blockUnreachable(runId) {
    return store.update((state) => {
      const run = state.runs[runId]
      if (!run) return 0
      let changed = 0
      const time = nowIso()
      for (const task of tasksOf(run)) {
        if (task.status !== 'pending') continue
        const failed = task.dependsOn
          .map((id) => run.tasks[id])
          .filter((dependency) => dependency && ['failed', 'blocked', 'cancelled'].includes(dependency.status))
        if (failed.length) {
          task.status = 'blocked'
          task.error = {
            code: 'DEPENDENCY_FAILED',
            message: `Blocked by ${failed.map((dependency) => dependency.id).join(', ')}.`,
          }
          task.finishedAt = time
          task.updatedAt = time
          changed += 1
        }
      }
      return changed
    })
  }

  /**
   * Persist one attempt outcome.
   * @param {string} runId
   * @param {string} taskId
   * @param {object} update
   */
  async function recordAttempt(runId, taskId, update) {
    await store.update((state) => {
      const task = state.runs[runId]?.tasks[taskId]
      if (!task) return
      task.attempts.push(update.attempt)
      task.childId = update.attempt.childId ?? task.childId
      task.childName = update.attempt.name ?? task.childName
      task.updatedAt = nowIso()
      if (update.running) {
        task.status = 'running'
      }
      if (update.result) {
        task.status = 'completed'
        task.result = update.result
        task.resultPreview = update.resultPreview
        task.error = null
        task.finishedAt = update.finishedAt
      } else if (update.error) {
        task.error = update.error
        if (update.final) {
          task.status = update.cancelled ? 'cancelled' : 'failed'
          task.finishedAt = update.finishedAt
        }
      }
    })
  }

  /**
   * Execute one task, including its retry loop.
   * @param {string} runId
   * @param {string} taskId
   * @param {any} parent
   * @param {AbortSignal} signal
   * @param {(event: any) => void} [onProgress]
   */
  async function executeTask(runId, taskId, parent, signal, onProgress) {
    const run = requireRun(runId)
    const initial = run.tasks[taskId]
    if (!initial) throw new CrewError('TASK_NOT_FOUND', `Task "${taskId}" does not exist in run "${runId}".`)
    const profile = requireProfile(initial.profileId)
    const maxAttempts = initial.maxAttempts
    const basePolicy = resolveToolPolicy(profile, toolNames(parent), {
      allowNestedOrchestration: resolved.allowNestedOrchestration,
    })
    // Memory is implicit: every specialist that may act at all may also record
    // what it learned. A profile with no tools keeps no write capability.
    // Memory belongs to the local backend: an external Codex run has no scoped
    // tool registry this plugin can reach, so promising it there would lie.
    const memoryTools = LOCAL_RUNTIMES.includes(profile.runtime ?? DEFAULT_RUNTIME)
      ? ['crew_memory_note', 'crew_memory_read']
      : []
    const withMemory = memoryTools.filter((name) => !basePolicy.allowed.includes(name))
    const toolPolicy = basePolicy.mode === 'none' || withMemory.length === 0
      ? basePolicy
      : basePolicy.mode === 'allow'
        ? {
            ...basePolicy,
            allow: [...basePolicy.allow, ...withMemory],
            allowed: [...basePolicy.allowed, ...withMemory],
            description: [...basePolicy.allowed, ...withMemory].join(', '),
          }
        : basePolicy
    const workingDirectory = initial.cwd || run.cwd || undefined

    while (true) {
      const current = requireTask(runId, taskId).task
      if (current.attempt >= maxAttempts) {
        await store.update((state) => {
          const task = state.runs[runId]?.tasks[taskId]
          if (task && task.status !== 'completed' && task.status !== 'blocked') {
            task.status = signal.aborted ? 'cancelled' : 'failed'
            task.finishedAt = nowIso()
            task.updatedAt = task.finishedAt
          }
        })
        return
      }
      if (signal.aborted) {
        await store.update((state) => {
          const task = state.runs[runId]?.tasks[taskId]
          if (task && !TERMINAL_TASK_STATUSES.has(task.status)) {
            task.status = 'cancelled'
            task.error = { code: 'CANCELLED', message: 'The run was cancelled.' }
            task.finishedAt = nowIso()
            task.updatedAt = task.finishedAt
          }
        })
        return
      }

      const attempt = current.attempt + 1
      const startedAt = nowIso()
      const start = Date.now()
      const timeoutMs = current.timeoutMs ?? profile.timeoutMs ?? resolved.taskTimeoutMs
      const name = childName(profile.id, ++nameCounter)
      onProgress?.({ type: 'task-attempt-start', runId, taskId, attempt, name })
      await store.update((state) => {
        const task = state.runs[runId]?.tasks[taskId]
        if (!task) return
        task.status = 'running'
        task.attempt = attempt
        task.startedAt ??= startedAt
        task.updatedAt = startedAt
        task.error = null
      })

      const taskPrompt = buildTaskPrompt({
        profile,
        run,
        task: current,
        attempt,
        maxAttempts,
        toolPolicy,
        workingDirectory,
        // Only the curated index enters the prompt; history stays on demand.
        memory: promptMemory(profile.memory, MEMORY_LABELS.en),
      })
      let outcome
      try {
        outcome = await delegate({
          parent,
          profile,
          name,
          label: `${run.title}: ${current.subject}`,
          prompt: taskPrompt,
          policy: { ...toolPolicy, profileId: profile.id, rolePrompt: buildRolePrompt(profile, { toolPolicy, runTitle: run.title }) },
          timeoutMs,
          signal,
        })
      } catch (error) {
        const info = errorInfo(error)
        outcome = {
          childId: null,
          name,
          stopReason: 'error',
          text: '',
          diagnostic: info.message,
          errorCode: info.code,
          errorMessage: info.message,
        }
      }

      const finishedAt = nowIso()
      const durationMs = Date.now() - start
      const text = String(outcome.text || textOfBlocks(outcome.output) || '').trim()
      const stopReason = String(outcome.stopReason ?? 'error')
      const ok = stopReason === 'completed' && !outcome.errorCode
      const limited = truncate(text, resolved.maxResultChars)
      const preview = truncate(text, resolved.previewChars)
      const attemptRecord = {
        attempt,
        childId: outcome.childId ?? null,
        name: outcome.name ?? name,
        runtime: profile.runtime ?? 'spawn',
        /** A local child owns a DSH Session that can be reopened; an external one does not. */
        sessionAvailable: (profile.runtime ?? 'spawn') !== 'codex',
        startedAt,
        finishedAt,
        durationMs,
        stopReason,
        resultChars: text.length,
        outputPreview: preview.text,
        // What the specialist was actually asked, so the record explains itself
        // even when the child's own transcript is gone.
        promptPreview: truncate(taskPrompt, PROMPT_PREVIEW_CHARS).text,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      }

      if (ok) {
        await recordAttempt(runId, taskId, {
          attempt: attemptRecord,
          result: {
            text: limited.text,
            truncated: limited.truncated,
            stopReason,
            ...(outcome.structured === undefined ? {} : { structured: outcome.structured }),
            ...(outcome.diagnostic ? { diagnostic: String(outcome.diagnostic) } : {}),
          },
          resultPreview: preview.text,
          finishedAt,
        })
        await rememberRun(profile.id, runId, taskId, current.subject, {
          ok: true,
          attempts: attempt,
          resultPreview: preview.text,
        })
        onProgress?.({ type: 'task-completed', runId, taskId, attempt, durationMs })
        return
      }

      const retryable =
        !signal.aborted &&
        attempt < maxAttempts &&
        (RETRYABLE_STOP_REASONS.has(stopReason) ||
          (stopReason === 'aborted' && (outcome.errorCode === 'TIMEOUT' || outcome.errorCode === 'ABORTED')))
      const error = {
        code: outcome.errorCode ?? stopReason.toUpperCase(),
        message: outcome.errorMessage || outcome.diagnostic || `Delegated agent stopped with "${stopReason}".`,
      }
      await recordAttempt(runId, taskId, {
        attempt: attemptRecord,
        error,
        final: !retryable,
        cancelled: signal.aborted,
        finishedAt,
      })
      if (!retryable) {
        await rememberRun(profile.id, runId, taskId, current.subject, {
          ok: false,
          attempts: attempt,
          errorCode: error.code,
          resultPreview: preview.text,
        })
      }
      onProgress?.({ type: 'task-attempt-failed', runId, taskId, attempt, stopReason, retryable })
      if (!retryable) return
      await sleep(resolved.retryBackoffMs * attempt, signal)
    }
  }

  /**
   * Append one automatic note recording how a task went for this specialist.
   * Failure to write memory must never fail the run.
   * @param {string} profileId
   * @param {string} runId
   * @param {string} taskId
   * @param {string} subject
   * @param {{ ok: boolean, attempts: number, errorCode?: string, resultPreview?: string }} outcome
   */
  async function rememberRun(profileId, runId, taskId, subject, outcome) {
    try {
      await store.update((state) => {
        const profile = state.profiles[profileId]
        if (!profile) return
        const { entries } = appendNote(profile.memory, runNoteText({ subject, ...outcome }), {
          kind: 'run',
          runId,
          taskId,
        })
        profile.memory = entries
        profile.updatedAt = nowIso()
      })
    } catch (error) {
      logger?.warn?.(`agent-crew could not record memory for ${profileId}: ${errorInfo(error).message}`)
    }
  }

  /**
   * Read, add to, or forget one specialist's memory.
   * @param {object} input
   * @param {string} input.profileId
   * @param {'list'|'add'|'forget'|'clear'} [input.action]
   * @param {string} [input.text]
   * @param {string} [input.kind]
   * @param {string} [input.id]
   */
  async function manageMemory({ profileId, action = 'list', text, kind, id, title, query, limit }) {
    requireProfile(profileId)
    if (action === 'list') {
      const profile = requireProfile(profileId)
      return {
        profileId,
        action,
        total: profile.memory.length,
        stats: memoryStats(profile.memory),
        // The panel and the lead read the whole list; the prompt only gets the index.
        notes: profile.memory.map((note) => ({ ...note })),
      }
    }
    if (action === 'read') {
      // On-demand read of one tier, so history never has to enter a prompt.
      const profile = requireProfile(profileId)
      return { profileId, action, ...readMemory(profile.memory, { kind, title, query, limit }) }
    }
    if (action === 'add') {
      const result = await store.update((state) => {
        const profile = state.profiles[profileId]
        if (!profile) throw new CrewError('PROFILE_NOT_FOUND', `Agent profile "${profileId}" does not exist.`)
        const appended = appendNote(profile.memory, { text, kind: kind ?? 'note', ...(title ? { title } : {}) })
        profile.memory = appended.entries
        profile.updatedAt = nowIso()
        return appended
      })
      return {
        profileId,
        action,
        total: result.entries.length,
        note: { ...result.note },
        ...(result.duplicate ? { duplicate: true } : {}),
      }
    }
    if (action === 'forget') {
      const result = await store.update((state) => {
        const profile = state.profiles[profileId]
        if (!profile) throw new CrewError('PROFILE_NOT_FOUND', `Agent profile "${profileId}" does not exist.`)
        const removed = removeNote(profile.memory, id)
        profile.memory = removed.entries
        profile.updatedAt = nowIso()
        return removed
      })
      return { profileId, action, total: requireProfile(profileId).memory.length, removed: result.removed }
    }
    if (action === 'clear') {
      const total = await store.update((state) => {
        const profile = state.profiles[profileId]
        if (!profile) throw new CrewError('PROFILE_NOT_FOUND', `Agent profile "${profileId}" does not exist.`)
        const count = profile.memory.length
        profile.memory = []
        profile.updatedAt = nowIso()
        return count
      })
      return { profileId, action, total: 0, cleared: total }
    }
    throw new CrewError('MEMORY_INVALID', `Unknown memory action ${JSON.stringify(action)}.`)
  }

  /**
   * Close runs left `running` by a previous process.
   *
   * A run's progress lives in memory while it executes, so a restart, a crash,
   * or an aborted turn leaves the record `running` forever — and a run that is
   * already executing refuses to start again. Nothing in this process owns
   * those tasks, so mark them cancelled and say why.
   *
   * @returns {Promise<number>} how many runs were recovered
   */
  async function recoverStaleRuns() {
    const stale = store.read((state) =>
      Object.values(state.runs).filter((run) => run.status === 'running').map((run) => run.id),
    )
    if (stale.length === 0) return 0
    const time = nowIso()
    await store.update((state) => {
      for (const id of stale) {
        const run = state.runs[id]
        if (!run || run.status !== 'running') continue
        for (const task of tasksOf(run)) {
          if (TERMINAL_TASK_STATUSES.has(task.status)) continue
          task.status = 'cancelled'
          task.error = {
            code: 'INTERRUPTED',
            message: 'The process that ran this task ended before it settled.',
          }
          task.finishedAt = time
          task.updatedAt = time
        }
        run.status = 'cancelled'
        run.finishedAt = time
        run.updatedAt = time
        run.summary = summarize(run)
      }
    })
    logger?.warn?.(`agent-crew recovered ${stale.length} run(s) left running by an earlier process`)
    return stale.length
  }

  /** @param {string} runId */
  async function settleRun(runId, { status } = {}) {
    return store.update((state) => {
      const run = state.runs[runId]
      if (!run) return null
      const counts = countsOf(run)
      run.status = status ?? (counts.failed || counts.blocked ? 'failed' : counts.cancelled ? 'cancelled' : 'completed')
      run.finishedAt = nowIso()
      run.updatedAt = run.finishedAt
      run.summary = summarize(run)
      return cloneJson(run)
    })
  }

  /**
   * Start or resume a run. Executes ready tasks in waves until no work remains.
   * @param {string} runId
   * @param {{ parent: any, signal?: AbortSignal, onProgress?: (event: any) => void }} options
   */
  async function startRun(runId, { parent, signal, onProgress } = {}) {
    const run = requireRun(runId)
    if (activeRuns.has(runId)) throw new CrewError('RUN_BUSY', `Crew run "${runId}" is already executing.`)
    if (run.status === 'completed') throw new CrewError('RUN_CLOSED', `Crew run "${runId}" is already completed.`)
    if (run.status === 'cancelled') throw new CrewError('RUN_CANCELLED', `Crew run "${runId}" was cancelled; create a new run.`)
    if (tasksOf(run).length === 0) throw new CrewError('RUN_EMPTY', `Crew run "${runId}" has no tasks.`)

    const controller = new AbortController()
    const unlink = linkSignal(signal, controller)
    activeRuns.set(runId, controller)
    try {
      await store.update((state) => {
        const draft = state.runs[runId]
        if (!draft) throw new CrewError('RUN_NOT_FOUND', `Crew run "${runId}" does not exist.`)
        draft.status = 'running'
        draft.startedAt ??= nowIso()
        draft.updatedAt = nowIso()
      })
      onProgress?.({ type: 'run-start', runId })

      while (true) {
        if (controller.signal.aborted) break
        await blockUnreachable(runId)
        const current = requireRun(runId)
        const pending = tasksOf(current).filter((task) => task.status === 'pending')
        if (pending.length === 0) break
        const ready = pending.filter((task) =>
          task.dependsOn.every((id) => current.tasks[id]?.status === 'completed'),
        )
        if (ready.length === 0) {
          // No active work remains and no task can start: the remaining tasks
          // are unreachable (normally because a dependency failed).
          await store.update((state) => {
            const draft = state.runs[runId]
            const time = nowIso()
            for (const task of tasksOf(draft)) {
              if (task.status !== 'pending') continue
              task.status = 'blocked'
              task.error = { code: 'DEPENDENCY_UNRESOLVED', message: 'No remaining task can satisfy this task\'s dependencies.' }
              task.finishedAt = time
              task.updatedAt = time
            }
          })
          break
        }
        const wave = ready.slice(0, current.maxParallel)
        await Promise.all(
          wave.map((task) => executeTask(runId, task.id, parent, controller.signal, onProgress)),
        )
      }

      if (controller.signal.aborted) {
        await settleRun(runId, { status: 'cancelled' })
        return getRun(runId)
      }
      await settleRun(runId)
      return getRun(runId)
    } catch (error) {
      const info = errorInfo(error)
      await store.update((state) => {
        const draft = state.runs[runId]
        if (!draft) return
        draft.status = controller.signal.aborted ? 'cancelled' : 'failed'
        draft.error = info
        draft.finishedAt = nowIso()
        draft.updatedAt = draft.finishedAt
        draft.summary = summarize(draft)
      }).catch(() => {})
      throw error
    } finally {
      unlink()
      activeRuns.delete(runId)
    }
  }

  /**
   * Start a one-off delegation: a private single-task run.
   * @param {{ profileId: string, subject: string, description?: string, cwd?: string, maxAttempts?: number, timeoutMs?: number }} input
   * @param {{ parent: any, signal?: AbortSignal }} options
   */
  async function dispatchOne(input, { parent, signal } = {}) {
    const run = await createRun({
      title: input.subject,
      objective: input.description ?? '',
      cwd: input.cwd,
      maxAttempts: input.maxAttempts,
      lead: { id: parent?.id ?? null, name: null },
    })
    await addTasks(run.id, [
      {
        profileId: input.profileId,
        subject: input.subject,
        description: input.description,
        maxAttempts: input.maxAttempts,
        timeoutMs: input.timeoutMs,
        cwd: input.cwd,
      },
    ])
    await startRun(run.id, { parent, signal })
    return getRun(run.id, { includeResults: true })
  }

  /**
   * Open a single-task run and start it without awaiting settlement.
   *
   * A synchronous dispatch is the wrong shape for long work: the model waits
   * with nothing to report, and a five-minute job reads as a frozen session.
   * The caller gets the run id immediately and polls `crew_run_status`.
   *
   * @param {object} input same shape as {@link dispatchOne}
   * @param {{ parent: any, signal?: AbortSignal }} options
   * @returns {Promise<any>} the run view in its `running` state
   */
  async function dispatchOneInBackground(input, { parent, signal } = {}) {
    const run = await createRun({
      title: input.subject,
      objective: input.description ?? '',
      cwd: input.cwd,
      maxAttempts: input.maxAttempts,
      lead: { id: parent?.id ?? null, name: null },
    })
    await addTasks(run.id, [
      {
        profileId: input.profileId,
        subject: input.subject,
        description: input.description,
        maxAttempts: input.maxAttempts,
        timeoutMs: input.timeoutMs,
        cwd: input.cwd,
      },
    ])
    // Deliberately not awaited: the run settles itself and the record is the
    // progress surface. A rejection is already recorded on the run.
    void startRun(run.id, { parent, signal }).catch((error) => {
      logger?.warn?.(`agent-crew background run ${run.id} failed: ${errorInfo(error).message}`)
    })
    return getRun(run.id)
  }

  /**
   * Retry one failed, blocked, or cancelled task immediately.
   * @param {string} runId
   * @param {string} taskId
   * @param {{ parent: any, signal?: AbortSignal }} options
   */
  async function retryTask(runId, taskId, { parent, signal } = {}) {
    if (activeRuns.has(runId)) throw new CrewError('RUN_BUSY', `Crew run "${runId}" is executing.`)
    const { run, task } = requireTask(runId, taskId)
    if (!['failed', 'blocked', 'cancelled'].includes(task.status)) {
      throw new CrewError('TASK_NOT_RETRYABLE', `Task "${taskId}" is ${task.status}; only failed, blocked, or cancelled tasks can be retried.`)
    }
    const unmet = task.dependsOn.filter((id) => run.tasks[id]?.status !== 'completed')
    if (unmet.length) {
      throw new CrewError('DEPENDENCIES_UNMET', `Task "${taskId}" still waits on ${unmet.join(', ')}.`)
    }
    requireProfile(task.profileId)
    await store.update((state) => {
      const draft = state.runs[runId]
      const current = draft.tasks[taskId]
      current.status = 'pending'
      current.error = null
      current.finishedAt = null
      current.updatedAt = nowIso()
      current.maxAttempts = Math.max(current.maxAttempts, current.attempt + 1)
      if (draft.status === 'completed' || draft.status === 'failed' || draft.status === 'cancelled') {
        draft.status = 'running'
        draft.finishedAt = null
      }
    })
    const controller = new AbortController()
    const unlink = linkSignal(signal, controller)
    activeRuns.set(runId, controller)
    try {
      await executeTask(runId, taskId, parent, controller.signal)
    } finally {
      unlink()
      activeRuns.delete(runId)
    }
    await settleRun(runId)
    return getRun(runId, { includeResults: true })
  }

  /**
   * Delete one settled run from the history. A running run must be cancelled
   * first so orchestration state never points at a removed record.
   * @param {string} runId
   */
  async function removeRun(runId) {
    const run = requireRun(runId)
    if (activeRuns.has(runId) || run.status === 'running') {
      throw new CrewError('RUN_BUSY', `Crew run "${runId}" is still executing; cancel it first.`)
    }
    await store.update((state) => {
      delete state.runs[runId]
      state.runOrder = state.runOrder.filter((id) => id !== runId)
    })
    return { id: runId, removed: true }
  }

  /** @param {string} runId */
  async function cancelRun(runId) {
    requireRun(runId)
    const controller = activeRuns.get(runId)
    controller?.abort()
    await store.update((state) => {
      const run = state.runs[runId]
      if (!run) return
      const time = nowIso()
      for (const task of tasksOf(run)) {
        if (!TERMINAL_TASK_STATUSES.has(task.status)) {
          task.status = 'cancelled'
          task.error = { code: 'CANCELLED', message: 'The run was cancelled.' }
          task.finishedAt = time
          task.updatedAt = time
        }
      }
      run.status = 'cancelled'
      run.finishedAt = time
      run.updatedAt = time
      run.summary = summarize(run)
    })
    return getRun(runId)
  }

  /**
   * Read one run.
   * @param {string} runId
   * @param {{ includeResults?: boolean, taskId?: string, previewChars?: number }} [options]
   */
  function getRun(runId, { includeResults = false, taskId, previewChars } = {}) {
    const run = requireRun(runId)
    const limit = previewChars ?? resolved.previewChars
    const tasks = tasksOf(run)
      .filter((task) => !taskId || task.id === taskId)
      .map((task) => publicTask(task, { includeResults, previewChars: limit }))
    return {
      id: run.id,
      title: run.title,
      objective: run.objective,
      status: run.status,
      lead: run.lead,
      cwd: run.cwd,
      maxParallel: run.maxParallel,
      maxAttempts: run.maxAttempts,
      counts: countsOf(run),
      summary: run.summary || '',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      ...(run.error ? { error: run.error } : {}),
      tasks,
    }
  }

  /** @param {number} [limit] */
  function listRuns(limit = 10) {
    const size = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 10)))
    return store.read((state) =>
      [...state.runOrder]
        .reverse()
        .slice(0, size)
        .map((id) => state.runs[id])
        .filter(Boolean)
        .map((run) => ({
          id: run.id,
          title: run.title,
          status: run.status,
          counts: countsOf(run),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          finishedAt: run.finishedAt,
        })),
    )
  }

  /** @param {any} task @param {{ includeResults: boolean, previewChars: number }} options */
  function publicTask(task, { includeResults, previewChars }) {
    return {
      id: task.id,
      key: task.key,
      profileId: task.profileId,
      subject: task.subject,
      status: task.status,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      dependsOn: [...task.dependsOn],
      writeScopes: [...task.writeScopes],
      childId: task.childId,
      childName: task.childName,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      ...(task.error ? { error: task.error } : {}),
      resultPreview: includeResults ? task.resultPreview : truncate(task.resultPreview ?? '', previewChars).text,
      // The attempt list is the run record a reader actually needs: which
      // runtime ran, whether its transcript can be reopened, and the prompt it
      // received. Kept in the light projection too, with the prompt shortened.
      attempts: task.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        childId: attempt.childId,
        name: attempt.name,
        runtime: attempt.runtime,
        sessionAvailable: attempt.sessionAvailable,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        durationMs: attempt.durationMs,
        stopReason: attempt.stopReason,
        resultChars: attempt.resultChars,
        ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
        outputPreview: includeResults
          ? attempt.outputPreview
          : truncate(attempt.outputPreview ?? '', previewChars).text,
        ...(attempt.promptPreview
          ? {
              promptPreview: includeResults
                ? attempt.promptPreview
                : truncate(attempt.promptPreview, previewChars).text,
            }
          : {}),
      })),
      ...(includeResults ? { result: task.result } : {}),
    }
  }

  /** Abort every in-flight run; called when the plugin unloads. */
  function shutdown() {
    for (const controller of activeRuns.values()) controller.abort()
  }

  return {
    limits: resolved,
    shutdown,
    defineProfile,
    listProfiles,
    removeProfile,
    createRun,
    addTasks,
    startRun,
    dispatchOne,
    dispatchOneInBackground,
    retryTask,
    cancelRun,
    removeRun,
    manageMemory,
    recoverStaleRuns,
    getRun,
    listRuns,
    /** @internal exposed for tests and diagnostics */
    _requireRun: requireRun,
  }
}
