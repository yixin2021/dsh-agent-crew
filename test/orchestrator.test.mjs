import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createOrchestrator } from '../lib/orchestrator.js'
import { buildRolePrompt, buildTaskPrompt, normalizeProfile, resolveToolPolicy, toolAllowed } from '../lib/profiles.js'
import { CrewStore } from '../lib/store.js'
import { CrewError, childName, truncate } from '../lib/util.js'

/** @returns {Promise<{store: CrewStore, dir: string}>} */
async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-test-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  return { store, dir }
}

/**
 * A delegate stub that records calls and answers from a script.
 * @param {(call: any) => any} [script]
 */
function makeDelegate(script = () => ({ stopReason: 'completed', text: 'done' })) {
  const calls = []
  const delegate = async (call) => {
    calls.push(call)
    const answer = await script(call)
    return {
      childId: `child-${calls.length}`,
      name: call.name,
      ...answer,
    }
  }
  return { delegate, calls }
}

const LEAD = { id: 'session-lead' }
const PROFILE = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'code reviewer',
  instructions: 'Review the diff.',
  tools: ['read', 'grep'],
}

test('profile validation normalizes defaults and rejects bad ids', () => {
  const profile = normalizeProfile({ name: 'Research Bot' })
  assert.equal(profile.id, 'research-bot')
  assert.deepEqual(profile.tools, ['*'])
  assert.equal(profile.role, 'research-bot')
  assert.throws(() => normalizeProfile({ name: 'X', id: 'Bad Id' }), CrewError)
  assert.throws(() => normalizeProfile({ name: 'X', id: 'lead' }), CrewError)
  assert.throws(() => normalizeProfile({ name: 'X', tools: ['*', 'read'] }), CrewError)
  assert.throws(() => normalizeProfile({ name: 'X', provider: 'p' }), CrewError)
  assert.throws(() => normalizeProfile({ name: 'X', maxAttempts: 9 }), CrewError)
})

test('tool policy intersects the catalog and hides lead-only tools', () => {
  const catalog = ['read', 'grep', 'bash', 'crew_run_start', 'crew_agent_list']
  const explicit = resolveToolPolicy(normalizeProfile({ name: 'R', tools: ['read', 'missing', 'crew_run_start'] }), catalog)
  assert.deepEqual(explicit.allowed, ['read'])
  assert.deepEqual(explicit.missing, ['missing'])
  assert.equal(explicit.mode, 'allow')

  const all = resolveToolPolicy(normalizeProfile({ name: 'R' }), catalog)
  assert.equal(all.mode, 'all')
  assert.deepEqual(all.deny, ['crew_agent_list', 'crew_run_start'])
  assert.ok(!all.allowed.includes('crew_run_start'))

  const nested = resolveToolPolicy(normalizeProfile({ name: 'R' }), catalog, { allowNestedOrchestration: true })
  assert.deepEqual(nested.deny, [])

  const none = resolveToolPolicy(normalizeProfile({ name: 'R', tools: ['missing'] }), catalog)
  assert.equal(none.mode, 'none')

  // The guard predicate is the single enforcement point.
  assert.equal(toolAllowed(explicit, 'read'), true)
  assert.equal(toolAllowed(explicit, 'bash'), false)
  assert.equal(toolAllowed(all, 'bash'), true)
  assert.equal(toolAllowed(all, 'crew_run_start'), false)
  assert.equal(toolAllowed(none, 'read'), false)
})

test('prompts carry role, task, attempt, and tool surface', () => {
  const profile = normalizeProfile(PROFILE)
  const policy = resolveToolPolicy(profile, ['read', 'grep'])
  const prompt = buildTaskPrompt({
    profile,
    run: { id: 'run-1', title: 'Audit', objective: 'Check auth' },
    task: { id: 'task-1', subject: 'Review login', description: 'Look at login.ts', writeScopes: ['src/login.ts'], dependsOn: [] },
    attempt: 2,
    maxAttempts: 3,
    toolPolicy: policy,
    workingDirectory: '/work',
  })
  assert.match(prompt, /Review login/)
  assert.match(prompt, /Attempt: 2 of 3/)
  assert.match(prompt, /Check auth/)
  assert.match(prompt, /read, grep/)
  assert.match(prompt, /\/work/)
  const role = buildRolePrompt(profile, { toolPolicy: policy, runTitle: 'Audit' })
  assert.match(role, /Agent Crew role: Reviewer/)
  assert.match(role, /Do not start or manage other agents/)
})

test('utility helpers stay within the subagent name grammar', () => {
  for (let index = 1; index < 20; index += 1) {
    const name = childName('Review Agent!!', index)
    assert.match(name, /^[a-z][a-z0-9-]{0,31}$/)
    assert.notEqual(name, 'lead')
  }
  assert.equal(truncate('abcdef', 4).truncated, true)
  assert.equal(truncate('abcdef', 10).text, 'abcdef')
})

test('a run executes dependencies in order and aggregates results', async () => {
  const { store, dir } = await makeStore()
  try {
    // The assignment heading, not arbitrary prompt text: injected memory also
    // mentions earlier tasks, so a substring match on "First" would be wrong.
    const { delegate, calls } = makeDelegate((call) => ({
      stopReason: 'completed',
      text: call.prompt.includes('# Assigned task: First') ? 'first result' : 'second result',
    }))
    const orchestrator = createOrchestrator({ store, delegate, toolNames: () => ['read'] })
    await orchestrator.defineProfile(PROFILE, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Pipeline', objective: 'Ship it', lead: LEAD })
    await orchestrator.addTasks(run.id, [
      { profileId: 'reviewer', subject: 'First', key: 'a' },
      { profileId: 'reviewer', subject: 'Second', dependsOn: ['a'] },
    ])
    const settled = await orchestrator.startRun(run.id, { parent: LEAD })
    assert.equal(settled.status, 'completed')
    assert.equal(settled.counts.completed, 2)
    assert.equal(calls.length, 2)
    assert.match(calls[1].prompt, /unblocked by completed task\(s\): task-1/)
    const finished = orchestrator.getRun(run.id, { includeResults: true })
    assert.equal(finished.tasks[0].result.text, 'first result')
    assert.equal(finished.tasks[1].result.text, 'second result')
    assert.match(finished.summary, /2\/2 completed/)
    // Parent identity is forwarded unchanged to every delegation.
    assert.ok(calls.every((call) => call.parent === LEAD))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent wave respects maxParallel and starts only ready tasks', async () => {
  const { store, dir } = await makeStore()
  try {
    /** @type {string[]} */
    const started = []
    let inFlight = 0
    let peak = 0
    const { delegate } = makeDelegate(async (call) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      started.push(call.label)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { stopReason: 'completed', text: 'ok' }
    })
    const orchestrator = createOrchestrator({ store, delegate, toolNames: () => [], limits: { maxParallel: 2 } })
    await orchestrator.defineProfile(PROFILE, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Wide', lead: LEAD, maxParallel: 2 })
    await orchestrator.addTasks(run.id, [
      { profileId: 'reviewer', subject: 'A' },
      { profileId: 'reviewer', subject: 'B' },
      { profileId: 'reviewer', subject: 'C' },
      { profileId: 'reviewer', subject: 'D' },
    ])
    const settled = await orchestrator.startRun(run.id, { parent: LEAD })
    assert.equal(settled.status, 'completed')
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`)
    assert.equal(started.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing task blocks dependents and the run reports failure', async () => {
  const { store, dir } = await makeStore()
  try {
    const { delegate, calls } = makeDelegate((call) => {
      if (call.prompt.includes('Break')) {
        return { stopReason: 'error', text: '', errorCode: 'BOOM', errorMessage: 'exploded' }
      }
      return { stopReason: 'completed', text: 'fine' }
    })
    const orchestrator = createOrchestrator({
      store,
      delegate,
      toolNames: () => [],
      limits: { retryBackoffMs: 1 },
    })
    await orchestrator.defineProfile({ ...PROFILE, maxAttempts: 2 }, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Broken chain', lead: LEAD })
    await orchestrator.addTasks(run.id, [
      { profileId: 'reviewer', subject: 'Break it', key: 'bad' },
      { profileId: 'reviewer', subject: 'Needs it', dependsOn: ['bad'] },
    ])
    const settled = await orchestrator.startRun(run.id, { parent: LEAD })
    assert.equal(settled.status, 'failed')
    assert.equal(settled.counts.failed, 1)
    assert.equal(settled.counts.blocked, 1)
    // Two attempts for the failing task, none for the blocked dependent.
    assert.equal(calls.length, 2)
    const [bad, dependent] = orchestrator.getRun(run.id, { includeResults: true }).tasks
    assert.equal(bad.status, 'failed')
    assert.equal(bad.attempts.length, 2)
    assert.equal(bad.error.code, 'BOOM')
    assert.equal(dependent.status, 'blocked')
    assert.equal(dependent.error.code, 'DEPENDENCY_FAILED')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('transient failures retry and can still complete', async () => {
  const { store, dir } = await makeStore()
  try {
    let attempt = 0
    const { delegate, calls } = makeDelegate(() => {
      attempt += 1
      return attempt === 1
        ? { stopReason: 'error', text: '', errorCode: 'RATE_LIMIT', errorMessage: 'slow down' }
        : { stopReason: 'completed', text: 'recovered' }
    })
    const orchestrator = createOrchestrator({
      store,
      delegate,
      toolNames: () => [],
      limits: { retryBackoffMs: 1 },
    })
    await orchestrator.defineProfile({ ...PROFILE, maxAttempts: 3 }, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Retry', lead: LEAD })
    await orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'Flaky' }])
    const settled = await orchestrator.startRun(run.id, { parent: LEAD })
    assert.equal(settled.status, 'completed')
    assert.equal(calls.length, 2)
    const task = orchestrator.getRun(run.id, { includeResults: true }).tasks[0]
    assert.equal(task.attempt, 2)
    assert.equal(task.result.text, 'recovered')
    // Attempt names are unique so the subagent runtime can reuse a profile.
    assert.notEqual(calls[0].name, calls[1].name)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('retryTask recovers a failed task after the cause is fixed', async () => {
  const { store, dir } = await makeStore()
  try {
    let healthy = false
    const { delegate } = makeDelegate(() =>
      healthy
        ? { stopReason: 'completed', text: 'fixed' }
        : { stopReason: 'error', text: '', errorCode: 'BROKEN', errorMessage: 'nope' },
    )
    const orchestrator = createOrchestrator({
      store,
      delegate,
      toolNames: () => [],
      limits: { retryBackoffMs: 1 },
    })
    await orchestrator.defineProfile({ ...PROFILE, maxAttempts: 1 }, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Manual retry', lead: LEAD })
    await orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'Work' }])
    const failed = await orchestrator.startRun(run.id, { parent: LEAD })
    assert.equal(failed.status, 'failed')
    healthy = true
    const recovered = await orchestrator.retryTask(run.id, 'task-1', { parent: LEAD })
    assert.equal(recovered.status, 'completed')
    assert.equal(orchestrator.getRun(run.id, { includeResults: true }).tasks[0].result.text, 'fixed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dependency validation rejects unknown references and cycles', async () => {
  const { store, dir } = await makeStore()
  try {
    const { delegate } = makeDelegate()
    const orchestrator = createOrchestrator({ store, delegate })
    await orchestrator.defineProfile(PROFILE, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Validation', lead: LEAD })
    await assert.rejects(
      orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'A', dependsOn: ['ghost'] }]),
      (error) => error instanceof CrewError && error.code === 'DEPENDENCY_UNKNOWN',
    )
    await orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'A', key: 'a' }])
    await assert.rejects(
      orchestrator.addTasks(run.id, [
        { profileId: 'reviewer', subject: 'B', key: 'b', dependsOn: ['c'] },
        { profileId: 'reviewer', subject: 'C', key: 'c', dependsOn: ['b'] },
      ]),
      (error) => error instanceof CrewError && error.code === 'DEPENDENCY_CYCLE',
    )
    await assert.rejects(
      orchestrator.addTasks(run.id, [{ profileId: 'ghost', subject: 'C' }]),
      (error) => error instanceof CrewError && error.code === 'PROFILE_NOT_FOUND',
    )
    await assert.rejects(orchestrator.startRun('missing-run', { parent: LEAD }), /does not exist/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling a run interrupts in-flight delegation and marks tasks cancelled', async () => {
  const { store, dir } = await makeStore()
  try {
    /** @type {AbortSignal | undefined} */
    let seen
    const delegate = async (call) => {
      seen = call.signal
      return new Promise((resolve) => {
        call.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }), { once: true })
      })
    }
    const orchestrator = createOrchestrator({ store, delegate, toolNames: () => [] })
    await orchestrator.defineProfile(PROFILE, { source: 'store' })
    const run = await orchestrator.createRun({ title: 'Cancel me', lead: LEAD })
    await orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'Slow' }])
    const running = orchestrator.startRun(run.id, { parent: LEAD })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cancelled = await orchestrator.cancelRun(run.id)
    assert.equal(cancelled.status, 'cancelled')
    const settled = await running
    assert.equal(settled.status, 'cancelled')
    assert.ok(seen?.aborted)
    assert.equal(orchestrator.getRun(run.id).tasks[0].status, 'cancelled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('state survives a restart and runtime profiles beat config seeds', async () => {
  const { store, dir } = await makeStore()
  try {
    const { delegate } = makeDelegate()
    const first = createOrchestrator({ store, delegate })
    await first.defineProfile({ ...PROFILE, role: 'from config' }, { source: 'config' })
    await first.defineProfile({ ...PROFILE, role: 'edited at runtime' }, { source: 'store' })
    await first.defineProfile({ ...PROFILE, role: 'stale config seed' }, { source: 'config' })
    assert.equal(first.listProfiles()[0].role, 'edited at runtime')
    const run = await first.createRun({ title: 'Persisted', lead: LEAD })
    await first.addTasks(run.id, [{ profileId: 'reviewer', subject: 'A' }])
    await first.startRun(run.id, { parent: LEAD })

    const reopened = new CrewStore({ dataDir: dir })
    await reopened.load()
    const second = createOrchestrator({ store: reopened, delegate })
    assert.equal(second.listProfiles()[0].role, 'edited at runtime')
    assert.equal(second.listRuns(1)[0].id, run.id)
    assert.equal(second.getRun(run.id).status, 'completed')
    const document = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
    assert.equal(document.version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt state document is preserved and reported', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-corrupt-'))
  try {
    const file = path.join(dir, 'state.json')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, '{not json'))
    const store = new CrewStore({ dataDir: dir })
    const { warning } = await store.load()
    assert.match(String(warning), /could not be loaded/)
    assert.deepEqual(store.read((state) => state.profiles), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('timeout_ms 0 means "use the default", never "wait forever"', async () => {
  const { store, dir } = await makeStore()
  try {
    let seen
    const delegate = async (call) => {
      seen = call.timeoutMs
      return { childId: 'c', name: call.name, stopReason: 'completed', text: 'ok' }
    }
    const orchestrator = createOrchestrator({ store, delegate, toolNames: () => [], limits: { taskTimeoutMs: 1234 } })
    await orchestrator.defineProfile({ id: 'rev', name: 'R', tools: ['read'] })
    const run = await orchestrator.createRun({ title: 'T', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'rev', subject: 'S', timeoutMs: 0 }])
    await orchestrator.startRun(run.id, { parent: { id: 'lead' } })
    // A zero deadline used to reach the adapter and disable its timer, so a hung
    // delegation left the session looking frozen.
    assert.equal(seen, 1234, 'zero falls back to the configured default')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a run left running by an earlier process is recovered, not stuck', async () => {
  const { store, dir } = await makeStore()
  try {
    const orchestrator = createOrchestrator({ store, delegate: async () => ({}) })
    await orchestrator.defineProfile({ id: 'rev', name: 'R', tools: ['read'] })
    const run = await orchestrator.createRun({ title: 'Orphan', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'rev', subject: 'S' }])
    // Simulate a crash: the record says running, but nothing owns it.
    await store.update((state) => {
      const draft = state.runs[run.id]
      draft.status = 'running'
      draft.tasks['task-1'].status = 'running'
    })
    const recovered = await orchestrator.recoverStaleRuns()
    assert.equal(recovered, 1)
    const view = orchestrator.getRun(run.id)
    assert.equal(view.status, 'cancelled')
    assert.equal(view.tasks[0].status, 'cancelled')
    assert.equal(view.tasks[0].error.code, 'INTERRUPTED')
    // And the recovered run can be retried instead of refusing forever.
    assert.equal((await orchestrator.recoverStaleRuns()), 0, 'recovery is idempotent')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a background dispatch returns before the task settles', async () => {
  const { store, dir } = await makeStore()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const delegate = async (call) => {
      await gate
      return { childId: 'c', name: call.name, stopReason: 'completed', text: 'done' }
    }
    const orchestrator = createOrchestrator({ store, delegate, toolNames: () => [] })
    await orchestrator.defineProfile({ id: 'rev', name: 'R', tools: ['read'] })

    // The point of the mode: this call must not wait for the delegation.
    const view = await orchestrator.dispatchOneInBackground(
      { profileId: 'rev', subject: 'Long job' },
      { parent: { id: 'lead' } },
    )
    // Already opened and started; `startRun` flips the record to `running` a
    // turn later, so `ready` is the honest state at this instant. The point is
    // that the call returned without waiting for the delegation.
    assert.ok(['ready', 'running'].includes(view.status), `unexpected status ${view.status}`)
    assert.equal(view.tasks[0].status, 'pending')

    release()
    // Poll for a terminal state: the run advances on its own after the gate
    // opens, and `ready` may still be the state when the dispatch returned.
    const terminal = new Set(['completed', 'failed', 'cancelled'])
    for (let attempt = 0; attempt < 200 && !terminal.has(orchestrator.getRun(view.id).status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const finished = orchestrator.getRun(view.id, { includeResults: true })
    assert.equal(finished.status, 'completed')
    assert.equal(finished.tasks[0].result.text, 'done')

    // The background run writes its outcome asynchronously; let its store write
    // drain before the temporary directory disappears.
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
