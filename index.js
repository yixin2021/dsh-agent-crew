/**
 * dsh-agent-crew — standard multi-agent collaboration for DeepSeek Harness.
 *
 * The plugin owns three things:
 *
 * 1. **Agent registry.** Reusable specialist profiles (role, instructions,
 *    capabilities, tool allow-list, optional model route, retry bound) stored in
 *    one durable JSON document, seeded from `Config.profiles`.
 * 2. **Lead orchestration.** A run is a task DAG. The lead decomposes work with
 *    `crew_task_add`, then `crew_run_start` executes ready tasks in waves through
 *    `ctx.subagents`, aggregates every result, blocks dependents of failures, and
 *    retries retryable failures with backoff.
 * 3. **Policy enforcement.** Every delegated child receives its role and task as
 *    a standalone prompt, and its tool surface is narrowed with
 *    `ctx.tools.restrict()` on that child's own agent scope.
 *
 * All delegation goes through the public `ctx.subagents` seam, so crew members
 * are ordinary DSH subagents: they appear in the session tree, can be inspected,
 * and inherit the runtime's admission, cancellation, and teardown behavior.
 *
 * @module @local/dsh-agent-crew
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createOrchestrator, resolveLimits } from './lib/orchestrator.js'
import { toolAllowed } from './lib/profiles.js'
import { createManagementRoute, dispatchManagement, isMatchableRoutePath, ROUTE } from './lib/management.js'
import { normalizeProfile, publicProfile } from './lib/profiles.js'
import { CrewStore } from './lib/store.js'
import { CrewError, errorInfo, sleep, textOfBlocks } from './lib/util.js'

/** Plugin name. */
export const name = 'agent-crew'

/** The delegation seam and the tool registry are hard requirements. */
export const inject = ['tools', 'subagents']

/** Default store directory when `dataDir` is empty. */
const DEFAULT_DATA_DIR = path.join(homedir(), '.dsh', 'agent-crew')

/** Upper bound for the time we wait for an interrupted child to settle. */
const SETTLE_GRACE_MS = 15_000

/** Plugin configuration. */
export const Config = z.object({
  /** Directory for the durable agent-crew state; empty uses `~/.dsh/agent-crew`. */
  dataDir: z.string().default(''),
  /** Registered `ctx.subagents` provider used for specialists on the local runtime. */
  provider: z.string().default('spawn'),
  /** Registered provider used for specialists whose runtime is `codex`. */
  codexProvider: z.string().default('codex'),
  /** Attempts per task when neither the profile nor the run sets a bound. */
  defaultMaxAttempts: z.natural().min(1).max(5).default(2),
  /** Tasks executed concurrently inside one run. */
  maxParallel: z.natural().min(1).max(16).default(3),
  /** Per-attempt wall-clock limit; 0 disables the limit. */
  taskTimeoutMs: z.natural().default(600_000),
  /** Base delay between retries; the attempt number multiplies it. */
  retryBackoffMs: z.natural().default(750),
  /** Result text kept per task (the prefix is used for previews). */
  maxResultChars: z.natural().default(12_000),
  /** Tasks accepted per run. */
  maxTasksPerRun: z.natural().min(1).max(256).default(64),
  /** Settled runs kept in the state document. */
  maxRuns: z.natural().min(1).max(500).default(50),
  /** Let delegated specialist agents orchestrate their own crews. */
  allowNestedOrchestration: z.boolean().default(false),
  /** Specialist profiles seeded at activation; state records take precedence. */
  profiles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.string(),
        instructions: z.string(),
        capabilities: z.array(z.string()),
        tools: z.array(z.string()),
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string(),
        maxTokens: z.natural(),
        maxAttempts: z.natural(),
        timeoutMs: z.natural(),
        tags: z.array(z.string()),
      }),
    )
    .default([]),
})

/** JSON renderer shared by every tool result. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** An open object node for a run/task/profile view. */
const OBJECT_NODE = { type: 'object', additionalProperties: true }

/** Output contract for tools that return one run. */
const RUN_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      run: { ...OBJECT_NODE, required: true },
    },
  },
  render: renderJson,
}

/** Output contract for tools that return the profile registry. */
const PROFILE_LIST_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      total: { type: 'integer', required: true },
      profiles: { type: 'array', items: OBJECT_NODE, required: true },
    },
  },
  render: renderJson,
}

/**
 * Resolve the effective plugin configuration.
 * @param {Record<string, unknown>} [config]
 */
export function resolveConfig(config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : DEFAULT_DATA_DIR
  return {
    dataDir,
    provider: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'spawn',
    codexProvider:
      typeof config.codexProvider === 'string' && config.codexProvider.trim() ? config.codexProvider.trim() : 'codex',
    profiles: Array.isArray(config.profiles) ? config.profiles : [],
    maxRuns: Number(config.maxRuns) || 50,
    limits: resolveLimits(config),
  }
}

/**
 * Enforce one child's tool policy inside that child's own agent scope.
 *
 * Enforcement is a `tools.guard()`: a guard is checked on every dispatch for the
 * calling scope and denies by name regardless of which scope registered the
 * tool, which is what makes an allow-list reliable here — most tools in this
 * profile come from the Agent preset composition, not the global registry, so
 * `tools.restrict()` alone cannot express the policy. `restrict()` is still
 * attempted for an allow-list so the denied tools also disappear from the
 * child's schema; it is best-effort because it rejects names it does not know.
 *
 * @param {any} agent exact child agent
 * @param {any} policy resolved policy from `resolveToolPolicy`
 * @param {{ warn?: (message: string) => void }} logger
 */
export function mountChildPolicy(agent, policy, logger) {
  if (policy.mode === 'all' && policy.deny.length === 0) return
  const deny = new Set(policy.deny)
  const allow = new Set(policy.allow)
  try {
    agent.ctx.effect(
      () =>
        agent.ctx.tools.guard((execution) => {
          const toolName = execution?.name
          const permitted = policy.mode === 'all' ? !deny.has(toolName) : policy.mode === 'allow' && allow.has(toolName)
          if (permitted) return undefined
          return {
            reason: `tool "${String(toolName)}" is outside this agent's tool policy (${policy.description})`,
            info: { name: 'AgentCrewToolPolicyError', code: 'CREW_TOOL_DENIED' },
          }
        }),
      'agent-crew tool policy',
    )
  } catch (error) {
    logger?.warn?.(
      `agent-crew could not install the tool policy for child ${String(agent.id)}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  // Second layer: make the presentation match enforcement so the model is not
  // tempted by tools it cannot call. Restrictions only cover globally registered
  // tools, so this stays best-effort.
  const filter = policy.mode === 'allow' ? { allow: [...policy.allow] } : { deny: [...policy.deny] }
  if ((filter.allow ?? filter.deny ?? []).length === 0) return
  try {
    agent.ctx.effect(() => agent.ctx.tools.restrict(filter), 'agent-crew tool presentation')
  } catch {
    // The guard above remains authoritative for tools it cannot name.
  }
}

/**
 * Link an outer signal into a derived controller.
 * @param {AbortSignal | undefined} outer
 * @param {AbortController} controller
 * @returns {() => void}
 */
function linkAbort(outer, controller) {
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
 * Mount the plugin.
 * @param {any} ctx Host context.
 * @param {ReturnType<typeof Config>} config Validated row configuration.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {})
  const logger = ctx.logger
  const store = new CrewStore({
    dataDir: resolved.dataDir,
    maxRuns: resolved.maxRuns,
    logger,
  })
  const { warning: storeWarning } = await store.load()
  if (storeWarning) logger?.warn?.(storeWarning)

  /**
   * Tool names visible to one agent. Most tools in a preset-based profile are
   * registered inside the Agent's composition, so the plugin's own root scope
   * sees none of them; resolving against the delegating agent is what makes the
   * catalog and the resulting policy describe the tools the child will have.
   * @param {any} [agent]
   * @returns {string[]}
   */
  const toolNamesFor = (agent) => {
    try {
      const names = ctx.tools.definitions(agent).map((definition) => definition.name)
      // The specialist memory tool is registered per child, after this catalog
      // is read, so it is advertised here once: a profile that allows it gets
      // it, everyone else keeps the plain list.
      return names.includes('crew_memory_note') ? names : [...names, 'crew_memory_note', 'crew_memory_read']
    } catch {
      return []
    }
  }

  // A run left `running` by a previous process owns no live activation here, so
  // close it before anything can try to start it again.
  try {
    await orchestrator.recoverStaleRuns()
  } catch (error) {
    logger?.warn?.(`agent-crew could not recover stale runs: ${errorInfo(error).message}`)
  }

  /** Policies waiting for their child's creation announcement. */
  const pendingPolicies = new Map()

  const orchestrator = createOrchestrator({
    store,
    toolNames: toolNamesFor,
    limits: resolved.limits,
    logger,
    delegate: async ({ parent, profile, name, label, prompt, policy, timeoutMs, signal }) => {
      // The runtime decides the whole delegation shape. A local child is
      // created under a reserved id so the plugin can shape it on
      // `agent/created`; an external backend runs its own process and takes a
      // fresh run per task, with neither capability.
      const local = profile.runtime !== 'codex'
      const childId = randomUUID()
      const controller = new AbortController()
      const unlink = linkAbort(signal, controller)
      // Never run unbounded: `0` and a missing value both fall back to the
      // configured default, because a delegation that never returns reads as a
      // frozen session and leaves the run `running` forever.
      const deadline = Number(timeoutMs) > 0 ? Number(timeoutMs) : resolved.limits.taskTimeoutMs
      let timedOut = false
      const timer = deadline > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, deadline)
        : undefined

      const interruptChild = () => {
        // Only a local child has the reserved session id this seam addresses.
        // An external backend is cancelled through its activation signal alone.
        if (!local) return
        try {
          ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
        } catch {
          // An interrupted-but-unknown target is an accepted no-op.
        }
      }

      if (local) pendingPolicies.set(childId, { policy, profileId: profile.id })
      try {
        let activation
        try {
          const agentOptions = profile.llmProvider
            ? {
                provider: profile.llmProvider,
                model: profile.model,
                ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
                ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
              }
            : undefined
          const providerName = local
            ? resolved.provider
            : (profile.codexProvider || resolved.codexProvider)
          if (!local && ctx.subagents.getProvider(providerName) === undefined) {
            return {
              childId: null,
              name,
              stopReason: 'error',
              text: '',
              errorCode: 'CODEX_PROVIDER_MISSING',
              errorMessage:
                `No codex provider named "${providerName}" is registered. Add a row to the profile's cordis.patch.yml:\n`
                + `- id: subagent-${providerName}\n  name: '@deepseek-ai/dsh-subagent-codex'\n  config:\n    providerName: ${providerName}\n    model: <model>`,
            }
          }
          activation = await ctx.subagents.startActivation({
            provider: providerName,
            label,
            ...(local ? { name, childId } : {}),
            prompt: [{ type: 'text', text: `${policy.rolePrompt}\n\n---\n\n${prompt}` }],
            parent,
            signal: controller.signal,
            delivery: 'caller',
            // A local child may be routed to a different model; an external
            // backend owns its own configuration.
            ...(local && agentOptions ? { agentOptions } : {}),
          })
        } catch (error) {
          // A start that fails because our own deadline or the caller aborted
          // reports that reason, not the downstream cancellation code.
          const info = errorInfo(error)
          return {
            childId: null,
            name,
            stopReason: 'error',
            text: '',
            errorCode: timedOut ? 'TIMEOUT' : signal?.aborted ? 'ABORTED' : info.code,
            errorMessage: timedOut
              ? `The delegated agent exceeded its ${deadline}ms limit.`
              : signal?.aborted
                ? 'The run was cancelled.'
                : info.message,
          }
        }

        if (controller.signal.aborted) interruptChild()

        let result
        let failure
        try {
          result = await activation.result
        } catch (error) {
          failure = errorInfo(error)
        }
        // Release this activation's capacity and subtree; a stuck cleanup must
        // not block the run's remaining tasks.
        await Promise.race([
          activation.dispose().catch(() => {}),
          sleep(SETTLE_GRACE_MS),
        ])

        if (failure) {
          return {
            childId: activation.childId,
            name: activation.name,
            stopReason: 'error',
            text: '',
            errorCode: timedOut ? 'TIMEOUT' : signal?.aborted ? 'ABORTED' : failure.code,
            errorMessage: timedOut
              ? `The delegated agent exceeded its ${deadline}ms limit.`
              : signal?.aborted
                ? 'The run was cancelled.'
                : failure.message,
          }
        }

        const stopReason = String(result?.stopReason ?? 'error')
        const text = textOfBlocks(result?.output)
        const synthetic = timedOut ? 'TIMEOUT' : signal?.aborted ? 'ABORTED' : undefined
        return {
          childId: activation.childId,
          name: activation.name,
          stopReason: synthetic ? 'aborted' : stopReason,
          text,
          ...(result?.structured === undefined ? {} : { structured: result.structured }),
          ...(result?.diagnostic ? { diagnostic: String(result.diagnostic) } : {}),
          ...(synthetic
            ? {
                errorCode: synthetic,
                errorMessage:
                  synthetic === 'TIMEOUT'
                    ? `The delegated agent exceeded its ${deadline}ms limit.`
                    : 'The run was cancelled.',
              }
            : {}),
        }
      } finally {
        if (timer) clearTimeout(timer)
        unlink()
        if (local) pendingPolicies.delete(childId)
      }
    },
  })

  // Seed configured profiles before any run can reference them. Stored records
  // win over configuration seeds so runtime edits survive a restart.
  for (const profile of resolved.profiles) {
    try {
      await orchestrator.defineProfile(profile, { source: 'config' })
    } catch (error) {
      logger?.warn?.(`agent-crew ignored configured profile: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Attach each crew child's tool policy in its own scope before its first step.
  ctx.on('agent/created', (payload) => {
    const entry = pendingPolicies.get(payload?.agent?.id)
    if (!entry) return
    pendingPolicies.delete(payload.agent.id)
    mountChildPolicy(payload.agent, entry.policy, logger)
    // The specialist's own memory writer is registered in ITS scope, so the
    // lead's tool list stays clean and the child cannot reach another profile.
    if (toolAllowed(entry.policy, 'crew_memory_note')) {
      registerChildMemoryTool(payload.agent, entry.profileId, orchestrator, logger)
      registerChildMemoryReader(payload.agent, entry.profileId, orchestrator, logger)
    }
  })

  const service = {
    dataDir: resolved.dataDir,
    provider: resolved.provider,
    limits: orchestrator.limits,
    storeWarning,
    defineProfile: (input) => orchestrator.defineProfile(input, { source: 'store' }),
    listProfiles: (options) => orchestrator.listProfiles(options),
    removeProfile: (profileId) => orchestrator.removeProfile(profileId),
    createRun: (input) => orchestrator.createRun(input),
    addTasks: (runId, tasks) => orchestrator.addTasks(runId, tasks),
    startRun: (runId, options) => orchestrator.startRun(runId, options),
    dispatchOne: (input, options) => orchestrator.dispatchOne(input, options),
    retryTask: (runId, taskId, options) => orchestrator.retryTask(runId, taskId, options),
    cancelRun: (runId) => orchestrator.cancelRun(runId),
    removeRun: (runId) => orchestrator.removeRun(runId),
    getRun: (runId, options) => orchestrator.getRun(runId, options),
    listRuns: (limit) => orchestrator.listRuns(limit),
    store,
    /** Resolve a registered subagent provider, so the panel can report readiness. */
    getProvider: (name) => ctx.subagents.getProvider(name),
  }
  ctx.provide('agentCrew', service)

  // Prompt text is optional: a headless composition without the system-prompt
  // service still gets every tool. `ctx.get` avoids a hard `inject` dependency.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    let sectionOrder = 520
    try {
      const order = systemPrompt.getSectionOrder?.('TOOL_AGENT_CREW')
      if (typeof order === 'number') sectionOrder = order
    } catch {
      // Unknown section names fall back to the fixed order.
    }
    systemPrompt.section({
      name: 'tool:agent-crew',
      order: sectionOrder,
      text: GUIDANCE,
    })
  }

  registerTools(ctx, { orchestrator, service })

  mountManagementRoute(ctx, { orchestrator, service })

  ctx.effect(() => () => orchestrator.shutdown(), 'agent-crew teardown')
}

/**
 * Give one delegated specialist a scoped tool that appends to its own memory.
 *
 * Registered on `agent.ctx` so it disappears with the child and cannot address
 * another profile: the profile id is captured here, never taken from arguments.
 *
 * @param {any} agent the exact child agent
 * @param {string} profileId the profile this child was started for
 * @param {any} orchestrator the run engine
 * @param {{ warn?: (message: string) => void }} logger
 */
function registerChildMemoryTool(agent, profileId, orchestrator, logger) {
  try {
    agent.ctx.effect(
      () =>
        agent.ctx.tools.register(
          defineTool({
            name: 'crew_memory_note',
            description:
              'Keep one durable note in your own memory for future jobs. Use it for conventions, hazards, decisions, and paths worth remembering — not for this task\'s working detail.',
            parameters: {
              text: { type: 'string', required: true, description: 'The note, written so it stands alone later.' },
              kind: {
                type: 'string',
                enum: ['note', 'lesson'],
                description: '`lesson` for something you got wrong and would do differently; `note` for context worth keeping.',
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  saved: { type: 'boolean', required: true },
                  total: { type: 'integer', required: true },
                  duplicate: { type: 'boolean' },
                },
              },
              render: renderJson,
            },
            async execute(args) {
              const result = await orchestrator.manageMemory({
                profileId,
                action: 'add',
                text: args.text,
                kind: args.kind ?? 'note',
              })
              return {
                saved: true,
                total: result.total,
                ...(result.duplicate ? { duplicate: true } : {}),
              }
            },
          }),
        ),
      'agent-crew: specialist memory',
    )
  } catch (error) {
    logger?.warn?.(
      `agent-crew could not give ${profileId} its memory tool: ${errorInfo(error).message}`,
    )
  }
}

/**
 * Mount the HTTP route behind the sidebar management page.
 *
 * The route is the browser's only authority: the page never touches the state
 * file or the orchestrator directly. It is registered only when a connection
 * service exists (desktop and web), so a headless host keeps every tool without
 * an unused route.
 *
 * @param {any} ctx Host context.
 * @param {{ orchestrator: any, service: any }} deps
 */
function mountManagementRoute(ctx, { orchestrator, service }) {
  if (typeof ctx.inject !== 'function') return
  const route = createManagementRoute({ orchestrator, service })
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(
      () => scoped.connection.fetch.register(route),
      'agent-crew: management route',
    )
  })
}

/** Model-facing guidance for the lead collaborator. */
const GUIDANCE = `# Agent crew

You can staff a team of specialist agents and run a dependency graph of tasks.

- \`crew_agent_list\` / \`crew_agent_create\` define reusable specialists: role, instructions, capabilities, and the exact tools each one may use. \`crew_agent_delete\` removes one.
- \`crew_run_create\` opens a run for one objective, \`crew_task_add\` adds tasks with \`dependsOn\` edges, and \`crew_run_start\` executes the graph and returns the aggregated report. \`crew_task_dispatch\` is the shortcut for one self-contained task.
- A message containing a mention — the wire form is \`@[display name](dsh-agent:profile-id)\` — means that specialist owns the request. **Dispatch first**: call \`crew_task_dispatch\` (or open a run) before reading the referenced files. Reading a long plan, scanning a repository, and tracing code are the specialist's job; a lead that researches first burns the turn without delegating. Read the request, then hand over.
- A plan document is a pointer, not a briefing: pass its path, the acceptance criteria, and the constraints in the task description. Do not summarise a 1000-line plan yourself before delegating.
- Each specialist keeps its own memory across runs. Read it with \`crew_agent_memory\` \`list\` before a demanding task, and \`add\` a note when the user states a durable preference the specialist should carry.
- Tasks whose dependencies are incomplete never start. A failed task blocks its dependents; \`crew_task_retry\` retries it after the cause is fixed.
- Every specialist works only from the prompt it receives. State the deliverable and acceptance criteria in each task description, and put shared context in the run objective.
- Prefer a few well-scoped tasks over many tiny ones; tasks in one wave run concurrently.
- Read the returned \`summary\`, per-task \`resultPreview\`, and any \`error.code\` before reporting success.`

/**
 * Give one delegated specialist read access to its own memory tiers.
 *
 * Registered next to the writer and bound to the same profile id, so a
 * specialist can consult its own history without ever naming another profile.
 *
 * @param {any} agent the exact child agent
 * @param {string} profileId the profile this child was started for
 * @param {any} orchestrator the run engine
 * @param {{ warn?: (message: string) => void }} logger
 */
function registerChildMemoryReader(agent, profileId, orchestrator, logger) {
  try {
    agent.ctx.effect(
      () =>
        agent.ctx.tools.register(
          defineTool({
            name: 'crew_memory_read',
            description:
              'Read your own memory on demand. Without a kind you get an overview: topic titles and how much history exists. Ask for `topic` with a title, or `run` for recent log lines.',
            parameters: {
              kind: {
                type: 'string',
                enum: ['topic', 'run', 'note', 'lesson'],
                description: 'Which tier to read. Omit for an overview.',
              },
              title: { type: 'string', description: 'Topic title or substring, for kind `topic`.' },
              query: { type: 'string', description: 'Optional substring filter.' },
              limit: { type: 'number', description: 'Rows to return (1–50, default 20).' },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string' },
                  total: { type: 'integer', required: true },
                  rows: { type: 'array', items: OBJECT_NODE },
                  topics: { type: 'array', items: OBJECT_NODE },
                  counts: OBJECT_NODE,
                },
              },
              render: renderJson,
            },
            execute(args) {
              return orchestrator.manageMemory({
                profileId,
                action: 'read',
                kind: args.kind,
                title: args.title,
                query: args.query,
                limit: args.limit,
              })
            },
          }),
        ),
      'agent-crew: specialist memory reader',
    )
  } catch (error) {
    logger?.warn?.(`agent-crew could not give ${profileId} its memory reader: ${errorInfo(error).message}`)
  }
}

/**
 * Register the lead-facing tools.
 * @param {any} ctx
 * @param {{ orchestrator: any, service: any }} deps
 */
function registerTools(ctx, { orchestrator, service }) {
  const tool = (definition) => ctx.tools.register(defineTool(definition))

  tool({
    name: 'crew_agent_create',
    description:
      'Create or replace a reusable specialist agent profile: its role, operating instructions, capabilities, and the exact tools it may call. Profiles persist across sessions.',
    parameters: {
      id: {
        type: 'string',
        description: 'Stable profile id (lower-case letters, digits, hyphens; start with a letter). Defaults to a slug of the name.',
      },
      name: { type: 'string', required: true, description: 'Display name of the specialist.' },
      role: { type: 'string', description: 'One-line role, such as "security reviewer". Defaults to the id.' },
      instructions: {
        type: 'string',
        description: 'Standing operating instructions injected into every task this specialist receives (at most 8000 characters).',
      },
      capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short capability statements shown in the specialist prompt.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Tool names this specialist may call. Default ["*"] exposes every session tool except the lead-only crew tools. "*" cannot be combined with explicit names. Unknown names are ignored.',
      },
      runtime: {
        type: 'string',
        enum: ['spawn', 'codex'],
        description:
          'Delegation backend. `spawn` (default) is an in-process DSH subagent that obeys the tool allow-list and keeps its own memory. `codex` runs a native Codex thread with its own sandbox and approvals: the tool allow-list and memory tool do NOT apply, only the prompt.',
      },
      provider: { type: 'string', description: 'LLM provider id for this specialist; requires model.' },
      model: { type: 'string', description: 'LLM model id for this specialist; requires provider.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort for the specialist route.' },
      maxTokens: { type: 'number', description: 'Output-token limit for the specialist.' },
      maxAttempts: { type: 'number', description: 'Default attempt bound (1-5) for tasks assigned to this specialist.' },
      timeoutMs: {
        type: 'number',
        description: 'Default per-attempt time limit in milliseconds. Omit for the run default (10 minutes); 0 means no limit is recorded.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels for organizing profiles.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { ...OBJECT_NODE, required: true },
          replaced: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const before = orchestrator.listProfiles({ includeInstructions: true })
      const profile = await orchestrator.defineProfile(args, { source: 'store' })
      const replaced = before.some((existing) => existing.id === profile.id)
      return { profile, replaced }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Define agent ${typeof args?.name === 'string' ? args.name : ''}`.trim(),
      kind: 'other',
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Agent profile',
      content: [
        {
          type: 'text',
          text: `Specialist ${result.profile.name} (${result.profile.id}) — ${result.profile.role}\nTools: ${result.profile.tools.join(', ')}`,
        },
      ],
    }),
  })

  tool({
    name: 'crew_agent_list',
    description:
      'List the specialist agent profiles available for delegation, including each profile\'s tools and model route. A message may contain a mention written as `@[display name](dsh-agent:profile-id)`; that id is the profile to delegate to, and it is always already listed here — no lookup is needed before dispatching.',
    parameters: {},
    output: PROFILE_LIST_OUTPUT,
    execute() {
      const profiles = orchestrator.listProfiles()
      return { total: profiles.length, profiles }
    },
    presentCall: () => ({ card: 'generic', title: 'List agent crew', kind: 'read' }),
  })

  tool({
    name: 'crew_agent_delete',
    description: 'Delete a specialist profile. Existing runs keep their history; new tasks cannot reference the profile.',
    parameters: {
      id: { type: 'string', required: true, description: 'Profile id to delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const profile = await orchestrator.removeProfile(args.id)
      return { id: profile.id, removed: true }
    },
    presentCall: (args) => ({ card: 'generic', title: `Delete agent ${args?.id ?? ''}`.trim(), kind: 'delete' }),
  })

  tool({
    name: 'crew_agent_memory',
    description:
      "Read or curate one specialist's own memory: notes it keeps across runs and sessions. Use `list` to see what it knows, `add` to teach it something, `forget` to drop one note, `clear` to reset.",
    parameters: {
      profile_id: { type: 'string', required: true, description: 'Specialist profile id.' },
      action: {
        type: 'string',
        enum: ['list', 'read', 'add', 'forget', 'clear'],
        description:
          'list shows the whole memory with tier stats; read returns one tier on demand; add appends one note; forget needs id; clear empties it.',
      },
      text: { type: 'string', description: 'Note text for `add`; write it so it stands alone later.' },
      kind: {
        type: 'string',
        enum: ['note', 'lesson', 'topic', 'run'],
        description:
          '`note`/`lesson` are injected into every task; `topic` is long material read on demand; `run` is the automatic log. Read `topic` or `run` with action `read`.',
      },
      title: { type: 'string', description: 'Title for a `topic` note (defaults to its first line).' },
      query: { type: 'string', description: 'Optional substring filter for action `read`.' },
      limit: { type: 'number', description: 'Rows returned by action `read` (1–50, default 20).' },
      id: { type: 'string', description: 'Note id to drop with `forget`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profileId: { type: 'string', required: true },
          action: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          notes: { type: 'array', items: OBJECT_NODE },
          note: OBJECT_NODE,
          rows: { type: 'array', items: OBJECT_NODE },
          topics: { type: 'array', items: OBJECT_NODE },
          counts: OBJECT_NODE,
          stats: OBJECT_NODE,
          removed: { type: 'boolean' },
          cleared: { type: 'integer' },
          duplicate: { type: 'boolean' },
          kind: { type: 'string' },
        },
      },
      render: renderJson,
    },
    execute(args) {
      return orchestrator.manageMemory({
        profileId: args.profile_id,
        action: args.action ?? 'list',
        text: args.text,
        kind: args.kind,
        title: args.title,
        query: args.query,
        limit: args.limit,
        id: args.id,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Memory ${typeof args?.action === 'string' ? args.action : 'list'} · ${args?.profile_id ?? ''}`.trim(),
      kind: args?.action === 'list' ? 'read' : 'other',
    }),
  })

  tool({
    name: 'crew_run_create',
    description:
      'Open a crew run for one objective. Add tasks with crew_task_add, then execute the graph with crew_run_start.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short run title.' },
      objective: { type: 'string', description: 'Shared context every specialist receives: goal, constraints, and acceptance criteria.' },
      cwd: { type: 'string', description: 'Working directory for every task in the run; defaults to the session directory.' },
      maxParallel: { type: 'number', description: 'Maximum concurrent tasks in this run.' },
      maxAttempts: { type: 'number', description: 'Default attempt bound (1-5) for tasks in this run.' },
    },
    output: RUN_OUTPUT,
    async execute(args, exec) {
      const execAgentId = exec.agent?.id ?? null
      const run = await orchestrator.createRun({
        title: args.title,
        objective: args.objective,
        cwd: args.cwd,
        maxParallel: args.maxParallel,
        maxAttempts: args.maxAttempts,
        lead: { id: execAgentId, name: null },
      })
      return { run }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Create crew run ${typeof args?.title === 'string' ? args.title : ''}`.trim(),
      kind: 'other',
    }),
  })

  tool({
    name: 'crew_task_add',
    description:
      'Add one or more tasks to a run that has not started. Dependencies reference earlier task ids or the optional task keys; a task starts only after every dependency completes.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id returned by crew_run_create.' },
      tasks: {
        type: 'array',
        required: true,
        description: 'Tasks to append. Add dependencies only on tasks that already exist in this run.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profile_id: { type: 'string', required: true, description: 'Specialist profile id.' },
            subject: { type: 'string', required: true, description: 'Short task title.' },
            description: {
              type: 'string',
              description: 'Complete instructions and acceptance criteria; the specialist sees only this.',
            },
            key: { type: 'string', description: 'Optional short alias used by later tasks in depends_on.' },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task ids or keys that must complete first.',
            },
            write_scopes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Advisory workspace-relative paths this task may modify.',
            },
            max_attempts: { type: 'number', description: 'Attempt bound for this task (1-5).' },
            timeout_ms: {
        type: 'number',
        description: 'Time limit in milliseconds for one attempt. Omit to use the default (10 minutes); a value of 0 is treated as omitted, because an unbounded delegation can hang the run.',
      },
            cwd: { type: 'string', description: 'Working directory for this task only.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          run: { ...OBJECT_NODE, required: true },
          added: { type: 'array', items: OBJECT_NODE, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const inputs = (args.tasks ?? []).map((task) => ({
        profileId: task.profile_id,
        subject: task.subject,
        description: task.description,
        key: task.key,
        dependsOn: task.depends_on,
        writeScopes: task.write_scopes,
        maxAttempts: task.max_attempts,
        timeoutMs: task.timeout_ms,
        cwd: task.cwd,
      }))
      const { run, added } = await orchestrator.addTasks(args.run_id, inputs)
      return { run, added }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Add ${Array.isArray(args?.tasks) ? args.tasks.length : 0} task(s)`,
      kind: 'other',
    }),
  })

  tool({
    name: 'crew_run_start',
    description:
      'Execute a run: every task whose dependencies are complete is delegated to its specialist, results are collected, failures retried up to the attempt bound, and dependents of failed tasks are blocked. Returns only when the run settles.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id returned by crew_run_create.' },
      include_results: {
        type: 'boolean',
        description: 'Include each completed task\'s full result text and attempt history in the response.',
      },
    },
    output: RUN_OUTPUT,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new CrewError('NO_CALLER', 'crew_run_start must be called by a lead agent.')
      const run = await orchestrator.startRun(args.run_id, { parent, signal: exec.signal })
      return { run: orchestrator.getRun(run.id, { includeResults: args.include_results === true }) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Run crew ${args?.run_id ?? ''}`.trim(),
      kind: 'execute',
    }),
  })

  tool({
    name: 'crew_run_status',
    description: 'Read one run: status, task states, per-task errors, attempt history, and the aggregated summary.',
    parameters: {
      run_id: { type: 'string', description: 'Run id; omit to list recent runs.' },
      task_id: { type: 'string', description: 'Limit the response to one task.' },
      include_results: { type: 'boolean', description: 'Include full result text and attempt history.' },
      limit: { type: 'number', description: 'Maximum recent runs to list when run_id is omitted (1-100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runs: { type: 'array', items: OBJECT_NODE },
          run: OBJECT_NODE,
        },
      },
      render: renderJson,
    },
    execute(args) {
      if (!args.run_id) {
        return { runs: orchestrator.listRuns(args.limit ?? 10) }
      }
      return {
        run: orchestrator.getRun(args.run_id, {
          taskId: args.task_id,
          includeResults: args.include_results === true,
        }),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.run_id ? `Crew status ${args.run_id}` : 'Recent crew runs',
      kind: 'read',
    }),
  })

  tool({
    name: 'crew_task_dispatch',
    description:
      'Delegate one self-contained task to a specialist, without creating a run explicitly. Call this FIRST when the request @-mentions a specialist: the specialist can read the plan or the repository itself, so do not investigate before delegating. By default it waits for the result; pass `background: true` for long work (a multi-file implementation, a full test run) and poll `crew_run_status` instead of blocking.',
    parameters: {
      profile_id: { type: 'string', required: true, description: 'Specialist profile id.' },
      subject: { type: 'string', required: true, description: 'Short task title.' },
      description: { type: 'string', description: 'Complete instructions; the specialist sees only this.' },
      cwd: { type: 'string', description: 'Working directory for the delegated agent.' },
      max_attempts: { type: 'number', description: 'Attempt bound (1-5).' },
      timeout_ms: {
        type: 'number',
        description: 'Time limit in milliseconds for one attempt. Omit to use the default (10 minutes); a value of 0 is treated as omitted, because an unbounded delegation can hang the run.',
      },
      background: {
        type: 'boolean',
        description: 'Return the run id immediately and let it settle in the background. Use it for long work, then poll crew_run_status.',
      },
    },
    output: RUN_OUTPUT,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new CrewError('NO_CALLER', 'crew_task_dispatch must be called by a lead agent.')
      const request = {
        profileId: args.profile_id,
        subject: args.subject,
        description: args.description,
        cwd: args.cwd,
        maxAttempts: args.max_attempts,
        timeoutMs: args.timeout_ms,
      }
      const run = args.background === true
        ? await orchestrator.dispatchOneInBackground(request, { parent, signal: exec.signal })
        : await orchestrator.dispatchOne(request, { parent, signal: exec.signal })
      return { run }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Dispatch ${args?.profile_id ?? 'agent'}`,
      kind: 'execute',
    }),
  })

  tool({
    name: 'crew_task_retry',
    description:
      'Retry one failed, blocked, or cancelled task now, after its dependencies are complete. Uses the task\'s existing attempt budget plus one.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id.' },
      task_id: { type: 'string', required: true, description: 'Task id to retry.' },
    },
    output: RUN_OUTPUT,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new CrewError('NO_CALLER', 'crew_task_retry must be called by a lead agent.')
      const run = await orchestrator.retryTask(args.run_id, args.task_id, { parent, signal: exec.signal })
      return { run: orchestrator.getRun(run.id, { includeResults: true }) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Retry ${args?.task_id ?? 'task'}`,
      kind: 'execute',
    }),
  })

  tool({
    name: 'crew_run_cancel',
    description: 'Cancel a run: in-flight delegated agents are interrupted and unfinished tasks become cancelled.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Run id.' },
    },
    output: RUN_OUTPUT,
    async execute(args) {
      const run = await orchestrator.cancelRun(args.run_id)
      return { run }
    },
    presentCall: (args) => ({ card: 'generic', title: `Cancel crew ${args?.run_id ?? ''}`.trim(), kind: 'other' }),
  })
}

export { ROUTE }

/** Exported for tests and other plugins that want the same primitives. */
export const internals = {
  resolveConfig,
  mountChildPolicy,
  normalizeProfile,
  publicProfile,
}
