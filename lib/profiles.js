/**
 * Agent profiles: validation, model-facing prompts, and tool-policy resolution.
 *
 * A profile is the plugin's portable definition of a delegated agent: identity,
 * role, capabilities, available tools, optional model route, and retry bounds.
 * This module has no DSH imports so it can be tested in isolation.
 */

import { CrewError, isRecord, slugify } from './util.js'

/** Tool names reserved for the lead's orchestration surface. */
export const CREW_TOOLS = Object.freeze([
  'crew_agent_create',
  'crew_agent_list',
  'crew_agent_delete',
  'crew_agent_memory',
  'crew_run_create',
  'crew_task_add',
  'crew_task_dispatch',
  'crew_run_start',
  'crew_run_status',
  'crew_task_retry',
  'crew_run_cancel',
])

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Delegation backends a profile may name.
 *
 * `spawn` is the in-process DSH child: it gets this plugin's tool policy, its
 * own memory tool, and follow-up messages. `codex` runs a real Codex thread
 * instead — a different permission model with no local Agent, so the policy and
 * the memory tool do not apply to it; only the prompt does.
 */
export const RUNTIMES = Object.freeze(['spawn', 'codex'])

/** Runtimes that create a local DSH Agent the plugin can shape. */
export const LOCAL_RUNTIMES = Object.freeze(['spawn'])

/** The fallback backend when a profile names none. */
export const DEFAULT_RUNTIME = 'spawn'
const TOOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/
const MAX_INSTRUCTIONS = 8000

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} instructions
 * @property {string[]} capabilities
 * @property {string[]} tools
 * @property {string} [llmProvider]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {number} [maxTokens]
 * @property {number} [maxAttempts]
 * @property {number} [timeoutMs]
 * @property {string[]} [tags]
 * @property {'store'|'config'} source
 * @property {string} createdAt
 * @property {string} updatedAt
 */

function text(value, field, { max = 400, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" is required.`)
    return ''
  }
  if (typeof value !== 'string') {
    throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must be a string.`)
  }
  const trimmed = value.trim()
  if (required && !trimmed) {
    throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must not be empty.`)
  }
  if (trimmed.length > max) {
    throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must be at most ${max} characters.`)
  }
  return trimmed
}

function stringList(value, field, { maxItems = 32, maxLength = 64, pattern } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must be an array of strings.`)
  }
  const result = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must contain only strings.`)
    }
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > maxLength) {
      throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" has an entry longer than ${maxLength} characters.`)
    }
    if (pattern && !pattern.test(trimmed)) {
      throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" has an invalid entry "${trimmed}".`)
    }
    if (!result.includes(trimmed)) result.push(trimmed)
    if (result.length > maxItems) {
      throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" accepts at most ${maxItems} entries.`)
    }
  }
  return result
}

function integer(value, field, { min, max, fallback } = {}) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new CrewError('PROFILE_INVALID', `Agent profile field "${field}" must be an integer from ${min} to ${max}.`)
  }
  return number
}

/**
 * Validate and normalize one profile declaration.
 * @param {unknown} input
 * @param {{ source?: 'store'|'config', now?: string }} [options]
 * @returns {Profile}
 */
export function normalizeProfile(input, { source = 'store', now = new Date().toISOString() } = {}) {
  if (!isRecord(input)) {
    throw new CrewError('PROFILE_INVALID', 'An agent profile must be an object.')
  }
  const rawName = text(input.name, 'name', { max: 80, required: true })
  const id = input.id === undefined || input.id === null ? slugify(rawName, 'agent') : text(input.id, 'id', { max: 32, required: true })
  if (!ID_PATTERN.test(id)) {
    throw new CrewError(
      'PROFILE_INVALID',
      `Agent profile id "${id}" must match ${ID_PATTERN} (lower-case letters, digits, and hyphens; start with a letter).`,
    )
  }
  if (id === 'lead') {
    throw new CrewError('PROFILE_INVALID', 'Agent profile id "lead" is reserved for the root collaborator.')
  }
  const role = text(input.role, 'role', { max: 200 }) || id
  const instructions = text(input.instructions, 'instructions', { max: MAX_INSTRUCTIONS })
  const rawRuntime = text(input.runtime, 'runtime', { max: 32 }) || DEFAULT_RUNTIME
  const runtime = rawRuntime === 'acp' ? 'codex' : rawRuntime
  if (!RUNTIMES.includes(runtime)) {
    throw new CrewError(
      'PROFILE_INVALID',
      `Agent profile runtime ${JSON.stringify(rawRuntime)} is not supported; use one of ${RUNTIMES.join(', ')}.`,
    )
  }
  const capabilities = stringList(input.capabilities, 'capabilities', { maxItems: 24, maxLength: 80 })
  let tools = stringList(input.tools, 'tools', { maxItems: 40, maxLength: 64, pattern: TOOL_PATTERN })
  if (tools.length === 0) tools = ['*']
  if (tools.includes('*') && tools.length > 1) {
    throw new CrewError('PROFILE_INVALID', 'Agent profile "tools" cannot combine "*" with explicit names.')
  }
  const llmProvider = text(input.provider, 'provider', { max: 80 }) || undefined
  const model = text(input.model, 'model', { max: 160 }) || undefined
  if ((llmProvider && !model) || (!llmProvider && model)) {
    throw new CrewError('PROFILE_INVALID', 'Agent profile must set both "provider" and "model", or neither.')
  }
  if (runtime === 'codex' && (llmProvider || model)) {
    throw new CrewError(
      'PROFILE_INVALID',
      'A codex specialist takes its model from the codex provider instance; clear provider/model and set codexProvider instead.',
    )
  }
  // Codex threads take their model from the provider instance, never from a
  // request, so a codex specialist names the instance instead of a model.
  const codexProvider = text(input.codexProvider, 'codexProvider', { max: 80 }) || undefined
  const reasoningEffort = text(input.reasoningEffort, 'reasoningEffort', { max: 40 }) || undefined
  const maxTokens = integer(input.maxTokens, 'maxTokens', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: undefined,
  })
  const maxAttempts = integer(input.maxAttempts, 'maxAttempts', { min: 1, max: 5, fallback: undefined })
  const timeoutMs = integer(input.timeoutMs, 'timeoutMs', { min: 0, max: 86_400_000, fallback: undefined })
  const tags = stringList(input.tags, 'tags', { maxItems: 12, maxLength: 40 })

  return {
    id,
    name: rawName,
    role,
    instructions,
    capabilities,
    tools,
    ...(llmProvider ? { llmProvider, model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    runtime,
    ...(runtime === 'codex' && codexProvider ? { codexProvider } : {}),
    ...(tags.length ? { tags } : {}),
    // Memory survives an edit: a profile rewrite must not erase what the
    // specialist has learned, so an incoming list is carried through as-is.
    memory: Array.isArray(input.memory) ? input.memory : [],
    source,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  }
}

/**
 * Project a profile into the tool-facing shape.
 * @param {Profile} profile
 * @returns {Record<string, unknown>}
 */
export function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    capabilities: [...profile.capabilities],
    tools: [...profile.tools],
    ...(profile.llmProvider ? { provider: profile.llmProvider, model: profile.model } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
    maxAttempts: profile.maxAttempts ?? null,
    timeoutMs: profile.timeoutMs ?? null,
    ...(profile.tags?.length ? { tags: [...profile.tags] } : {}),
    instructions: profile.instructions,
    runtime: profile.runtime ?? DEFAULT_RUNTIME,
    ...(profile.codexProvider ? { codexProvider: profile.codexProvider } : {}),
    memoryCount: Array.isArray(profile.memory) ? profile.memory.length : 0,
    source: profile.source,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

/**
 * Resolve which inherited tools a child may call. Explicit profile names are
 * intersected with the live global tool catalog; `*` keeps everything except
 * the lead-only orchestration tools (unless nesting is explicitly allowed).
 * @param {Profile} profile
 * @param {readonly string[]} allToolNames
 * @param {{ allowNestedOrchestration?: boolean }} [options]
 * @returns {{
 *   mode: 'all'|'allow'|'none',
 *   allow: string[],
 *   deny: string[],
 *   allowed: string[],
 *   missing: string[],
 *   description: string,
 * }}
 */
export function resolveToolPolicy(profile, allToolNames, { allowNestedOrchestration = false } = {}) {
  const all = [...new Set(allToolNames.filter((name) => typeof name === 'string' && name))].sort()
  const allSet = new Set(all)
  const blocked = new Set(allowNestedOrchestration ? [] : CREW_TOOLS)
  const wantsAll = profile.tools.includes('*')

  if (wantsAll) {
    const denied = [...blocked].filter((name) => allSet.has(name))
    return {
      mode: 'all',
      allow: [],
      deny: denied,
      allowed: all.filter((name) => !blocked.has(name)),
      missing: [],
      description: allowNestedOrchestration
        ? 'all tools available in this session'
        : 'all session tools except the lead-only agent-crew orchestration tools',
    }
  }

  const requested = profile.tools.filter((name) => name !== '*')
  const missing = requested.filter((name) => !allSet.has(name))
  const allowed = requested.filter((name) => allSet.has(name) && !blocked.has(name))
  if (allowed.length === 0) {
    return {
      mode: 'none',
      allow: [],
      deny: [],
      allowed: [],
      missing,
      description: 'no tools at all',
    }
  }
  return {
    mode: 'allow',
    allow: allowed,
    deny: [],
    allowed,
    missing,
    description: allowed.join(', '),
  }
}

/**
 * Decide whether one tool call is permitted by a resolved policy. This is the
 * single enforcement predicate used by the child-scope guard.
 * @param {ReturnType<typeof resolveToolPolicy>} policy
 * @param {string} toolName
 * @returns {boolean}
 */
export function toolAllowed(policy, toolName) {
  if (typeof toolName !== 'string' || !toolName) return false
  if (policy.mode === 'all') return !policy.deny.includes(toolName)
  if (policy.mode === 'allow') return policy.allow.includes(toolName)
  return false
}

/**
 * System-prompt text installed into one delegated child before its first step.
 * @param {Profile} profile
 * @param {{ toolPolicy: ReturnType<typeof resolveToolPolicy>, runTitle?: string }} context
 * @returns {string}
 */
export function buildRolePrompt(profile, { toolPolicy, runTitle } = {}) {
  const local = (profile.runtime ?? DEFAULT_RUNTIME) === 'spawn'
  const lines = [
    `# Agent Crew role: ${profile.name}`,
    '',
    `You are a delegated specialist working for the lead collaborator${runTitle ? ` on "${runTitle}"` : ''}.`,
    `Role: ${profile.role}`,
    `Runtime: ${profile.runtime ?? DEFAULT_RUNTIME}${local ? ' (in-process DSH subagent)' : ' (native Codex thread; your own sandbox and approvals apply)'}`,
  ]
  if (profile.capabilities.length) {
    lines.push('', 'Capabilities:', ...profile.capabilities.map((item) => `- ${item}`))
  }
  if (profile.instructions) {
    lines.push('', 'Operating instructions:', profile.instructions)
  }
  lines.push(
    '',
    'Rules:',
    ...(local && toolPolicy && toolAllowed(toolPolicy, 'crew_memory_note')
      ? ['- You carry your own memory: earlier notes about this work appear under "What you already know". Add a durable note with `crew_memory_note` when you learn something worth keeping (a convention, a hazard, a path that matters); skip task-local detail.']
      : []),
    '- Work only on the task assigned in your prompt. You cannot ask the user questions; approval-required operations are rejected, so report the limitation instead of retrying.',
    '- Use only the tools listed below. A tool call outside this set is denied.',
    `- Available tools: ${toolPolicy?.description ?? 'none'}.`,
    '- Do not start or manage other agents. Report findings, evidence, changed files, risks, and any remaining work in your final message; the lead reads that message, not your transcript.',
    '- Your final message is delivered to the lead verbatim. End with a short, self-contained report.',
  )
  return lines.join('\n')
}

/**
 * Build the standalone task prompt for one child attempt.
 * @param {object} input
 * @param {Profile} input.profile
 * @param {{ id: string, title?: string, objective?: string }} input.run
 * @param {{ id: string, subject: string, description: string, writeScopes?: string[], dependsOn?: string[], cwd?: string }} input.task
 * @param {number} input.attempt
 * @param {number} input.maxAttempts
 * @param {ReturnType<typeof resolveToolPolicy>} input.toolPolicy
 * @param {string} [input.workingDirectory]
 * @returns {string}
 */
export function buildTaskPrompt({ profile, run, task, attempt, maxAttempts, toolPolicy, workingDirectory, memory }) {
  const lines = [
    `# Assigned task: ${task.subject}`,
    '',
    `Run: ${run.title || run.id} (${run.id})`,
    `Task: ${task.id}`,
    `Attempt: ${attempt} of ${maxAttempts}`,
    `Your profile: ${profile.name} (${profile.role})`,
  ]
  if (memory) lines.push('', memory)
  if (run.objective) lines.push('', `Overall objective: ${run.objective}`)
  lines.push('', 'Task details:', task.description || '(no additional details)')
  if (task.dependsOn?.length) {
    lines.push('', `This task was unblocked by completed task(s): ${task.dependsOn.join(', ')}.`)
  }
  if (task.writeScopes?.length) {
    lines.push('', 'Advisory write scopes (workspace-relative):', ...task.writeScopes.map((scope) => `- ${scope}`))
  }
  if (workingDirectory) lines.push('', `Working directory: ${workingDirectory}`)
  lines.push(
    '',
    'Available tools:',
    toolPolicy.description,
    '',
    'Deliverable:',
    '- Do the work described above and verify the result.',
    '- Finish with a concise report: what you did, evidence (paths, commands, outputs), files changed, risks, and anything the lead must decide.',
    '- Do not ask questions and do not wait for further input; the lead will retry or reassign the task if needed.',
  )
  return lines.join('\n')
}
