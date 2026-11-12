/**
 * Per-specialist memory tests.
 *
 * Memory is what makes a specialist more than a fresh prompt, so these tests
 * pin the tier contract: the curated index enters the prompt, history never
 * does, and no profile can read another's.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendNote,
  INDEX_KINDS,
  MEMORY_LIMITS,
  memoryStats,
  normalizeNote,
  promptMemory,
  readMemory,
  removeNote,
  runNoteText,
} from '../lib/memory.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { buildRolePrompt, buildTaskPrompt, normalizeProfile, RUNTIMES, resolveToolPolicy } from '../lib/profiles.js'
import { CrewStore } from '../lib/store.js'
import { CrewError } from '../lib/util.js'

const LABELS = (kind) => ({ note: 'note', lesson: 'lesson', topic: 'topic', run: 'log' })[kind] ?? 'note'

test('a note is trimmed, capped by its tier, and rejected when empty', () => {
  const note = normalizeNote('  middleware owns authz  ')
  assert.equal(note.text, 'middleware owns authz')
  assert.equal(note.kind, 'note')
  assert.match(note.id, /^mem_/)

  assert.equal(normalizeNote('x'.repeat(2000)).text.length, MEMORY_LIMITS.maxChars)
  // A topic is allowed to be much longer than an injected note.
  const topic = normalizeNote({ kind: 'topic', title: 'Auth', text: 'y'.repeat(9000) })
  assert.equal(topic.text.length, MEMORY_LIMITS.maxTopicChars)
  assert.equal(topic.title, 'Auth')

  assert.throws(() => normalizeNote('   '), (error) => error instanceof CrewError && error.code === 'MEMORY_INVALID')
  assert.equal(normalizeNote({ text: 'a', kind: 'nonsense' }).kind, 'note')
})

test('memory has three tiers with different prompt behaviour', () => {
  let entries = []
  entries = appendNote(entries, { text: 'authz lives in middleware' }).entries
  entries = appendNote(entries, { text: 'never trust the client tenant id', kind: 'lesson' }).entries
  entries = appendNote(entries, { kind: 'topic', title: 'Deploy', text: 'long deploy runbook' }).entries
  entries = appendNote(entries, { text: 'Handled "audit" (1 attempt).', kind: 'run' }).entries

  const block = promptMemory(entries, LABELS)
  // Only the curated index is injected.
  assert.ok(block.includes('authz lives in middleware'))
  assert.ok(block.includes('never trust the client tenant id'))
  assert.ok(!block.includes('long deploy runbook'), 'topics stay on demand')
  assert.ok(!block.includes('Handled "audit"'), 'the log stays out of the prompt')
  assert.ok(block.split('\n').filter((line) => line.startsWith('- (')).length === 2)
  assert.deepEqual([...INDEX_KINDS], ['note', 'lesson'])
})

test('a long history cannot push the curated index out of the prompt', () => {
  let entries = appendNote([], { text: 'the one fact that matters' }).entries
  for (let index = 0; index < 40; index += 1) {
    entries = appendNote(entries, { text: `Handled "job ${index}" (1 attempt).`, kind: 'run' }).entries
    entries = appendNote(entries, { kind: 'topic', title: `Topic ${index}`, text: 'z'.repeat(500) }).entries
  }
  const block = promptMemory(entries, LABELS)
  assert.ok(block.includes('the one fact that matters'))
  // And the total is bounded rather than growing with history.
  assert.ok(block.length <= MEMORY_LIMITS.maxIndexChars + 400, `block too long: ${block.length}`)
})

test('duplicate curated notes are not stored twice, log lines always append', () => {
  const first = appendNote([], { text: 'authz lives in middleware' })
  const again = appendNote(first.entries, { text: 'authz lives in middleware' })
  assert.equal(again.entries.length, 1)
  assert.equal(again.duplicate, true)

  const runs = appendNote(again.entries, { text: 'Handled "x".', kind: 'run' })
  const runs2 = appendNote(runs.entries, { text: 'Handled "x".', kind: 'run' })
  assert.equal(runs2.entries.length, 3)
})

test('eviction drops log, then topics, and never the newest note', () => {
  let entries = []
  for (let index = 0; index < MEMORY_LIMITS.maxEntries; index += 1) {
    entries = appendNote(entries, { text: `curated ${index}` }).entries
  }
  entries = appendNote(entries, { text: 'a log line', kind: 'run' }).entries
  entries = appendNote(entries, { kind: 'topic', title: 'T', text: 'topic body' }).entries
  assert.equal(entries.length, MEMORY_LIMITS.maxEntries)
  assert.equal(entries.at(-1).kind, 'topic')
  assert.ok(entries.some((entry) => entry.text.startsWith('curated')), 'curated notes survive longest')
})

test('on-demand read returns one tier at a time', () => {
  let entries = []
  entries = appendNote(entries, { text: 'indexed' }).entries
  entries = appendNote(entries, { kind: 'topic', title: 'Deploy', text: 'deploy steps' }).entries
  for (let index = 0; index < 5; index += 1) {
    entries = appendNote(entries, { text: `log ${index}`, kind: 'run' }).entries
  }

  const overview = readMemory(entries)
  assert.equal(overview.total, 7)
  assert.equal(overview.topics.length, 1)
  assert.equal(overview.topics[0].title, 'Deploy')
  assert.equal(overview.counts.run, 5)

  const log = readMemory(entries, { kind: 'run', limit: 2 })
  assert.equal(log.total, 5)
  assert.equal(log.rows.length, 2)
  assert.equal(log.rows[0].text, 'log 4', 'newest first')

  const topics = readMemory(entries, { kind: 'topic', title: 'deploy' })
  assert.equal(topics.rows.length, 1)
  assert.equal(topics.rows[0].text, 'deploy steps')

  assert.throws(() => readMemory(entries, { kind: 'nope' }), (error) => error.code === 'MEMORY_INVALID')
})

test('forget removes exactly one note and stats describe the tiers', () => {
  const first = appendNote([], { text: 'keep me' })
  const second = appendNote(first.entries, { text: 'drop me' })
  const removed = removeNote(second.entries, second.note.id)
  assert.equal(removed.removed, true)
  assert.equal(removed.entries.length, 1)
  assert.equal(removeNote(removed.entries, 'mem_missing').removed, false)
  assert.throws(() => removeNote(removed.entries, ''), (error) => error.code === 'MEMORY_INVALID')

  const stats = memoryStats(second.entries)
  assert.equal(stats.indexCount, 2)
  assert.equal(stats.logCount, 0)
  assert.ok(stats.indexChars > 0 && stats.indexChars <= stats.indexLimit)
})

test('the run note records the outcome without dumping the transcript', () => {
  assert.match(runNoteText({ subject: 'review', ok: true, attempts: 1, resultPreview: 'found two gaps' }), /found two gaps/)
  assert.match(
    runNoteText({ subject: 'review', ok: false, attempts: 2, errorCode: 'TIMEOUT' }),
    /Failed "review" after 2 attempts \(TIMEOUT\)/,
  )
  assert.ok(runNoteText({ subject: 's', ok: true, attempts: 1, resultPreview: 'y'.repeat(900) }).length < 300)
})

test('the injected index reaches the task prompt', () => {
  const profile = normalizeProfile({
    name: 'Reviewer',
    tools: ['read'],
    memory: [
      { id: 'mem_1', kind: 'note', text: 'authz lives in middleware', ts: '2026-01-01T00:00:00.000Z' },
      { id: 'mem_2', kind: 'run', text: 'Handled "old job"', ts: '2026-01-02T00:00:00.000Z' },
    ],
  })
  const policy = resolveToolPolicy(profile, ['read', 'crew_memory_note'])
  const prompt = buildTaskPrompt({
    profile,
    run: { id: 'run_1', title: 'T' },
    task: { id: 'task-1', subject: 'Check login', description: 'Do it' },
    attempt: 1,
    maxAttempts: 1,
    toolPolicy: policy,
    memory: promptMemory(profile.memory, LABELS),
  })
  assert.match(prompt, /What you already know/)
  assert.match(prompt, /authz lives in middleware/)
  assert.ok(!prompt.includes('Handled "old job"'), 'the log never enters the prompt')
  // Memory survives a profile edit round-trip.
  assert.equal(normalizeProfile({ ...profile, role: 'changed' }).memory.length, 2)
})

test('a runtime is validated and defaults to the in-process backend', () => {
  assert.deepEqual([...RUNTIMES], ['spawn', 'codex'])
  assert.equal(normalizeProfile({ name: 'A' }).runtime, 'spawn')
  assert.equal(normalizeProfile({ name: 'A', runtime: 'codex' }).runtime, 'codex')
  // The older spelling of the same external backend is accepted.
  assert.equal(normalizeProfile({ name: 'A', runtime: 'acp' }).runtime, 'codex')
  assert.throws(
    () => normalizeProfile({ name: 'A', runtime: 'some-other' }),
    (error) => error instanceof CrewError && error.code === 'PROFILE_INVALID',
  )
  // A codex specialist may not promise a memory tool it cannot have, and the
  // role prompt must name the backend it is actually running on.
  const codex = normalizeProfile({ name: 'C', runtime: 'codex', tools: ['read'] })
  const local = normalizeProfile({ name: 'L', runtime: 'spawn', tools: ['read'] })
  const codexPolicy = resolveToolPolicy(codex, ['read', 'crew_memory_note'])
  // The engine widens a local allow-list with the memory tool; mirror that here
  // so the role prompt is built from the policy the child actually receives.
  const localPolicy = resolveToolPolicy(local, ['read', 'crew_memory_note'])
  const widened = {
    ...localPolicy,
    allow: [...localPolicy.allow, 'crew_memory_note'],
    allowed: [...localPolicy.allowed, 'crew_memory_note'],
  }

  const codexRole = buildRolePrompt(codex, { toolPolicy: codexPolicy, runTitle: 't' })
  const localRole = buildRolePrompt(local, { toolPolicy: widened, runTitle: 't' })
  assert.match(codexRole, /Runtime: codex \(native Codex thread/)
  assert.ok(!codexRole.includes('crew_memory_note'), 'the external backend has no memory tool')
  assert.match(localRole, /Runtime: spawn \(in-process DSH subagent\)/)
  assert.match(localRole, /crew_memory_note/)
})

test('one specialist cannot read another specialist memory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-mem-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  const orchestrator = createOrchestrator({
    store,
    toolNames: () => ['read'],
    delegate: async (call) => ({ childId: 'c', name: call.name, stopReason: 'completed', text: 'ok' }),
  })
  try {
    await orchestrator.defineProfile({ id: 'a', name: 'A', tools: ['read'] })
    await orchestrator.defineProfile({ id: 'b', name: 'B', tools: ['read'] })
    await orchestrator.manageMemory({ profileId: 'a', action: 'add', text: 'secret of A' })

    assert.equal((await orchestrator.manageMemory({ profileId: 'a', action: 'list' })).total, 1)
    assert.equal((await orchestrator.manageMemory({ profileId: 'b', action: 'list' })).total, 0)

    await assert.rejects(
      orchestrator.manageMemory({ profileId: 'ghost', action: 'list' }),
      (error) => error instanceof CrewError && error.code === 'PROFILE_NOT_FOUND',
    )
    await assert.rejects(
      orchestrator.manageMemory({ profileId: 'a', action: 'nonsense' }),
      (error) => error.code === 'MEMORY_INVALID',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a finished task writes one log line, and memory survives a restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-mem2-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  const orchestrator = createOrchestrator({
    store,
    toolNames: () => ['read'],
    limits: { retryBackoffMs: 1 },
    delegate: async (call) => ({ childId: 'c', name: call.name, stopReason: 'completed', text: 'learned something' }),
  })
  try {
    await orchestrator.defineProfile({ id: 'rev', name: 'Rev', tools: ['read'] })
    const run = await orchestrator.createRun({ title: 'M', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'rev', subject: 'Audit' }])
    await orchestrator.startRun(run.id, { parent: { id: 'lead' } })

    const memory = await orchestrator.manageMemory({ profileId: 'rev', action: 'list' })
    assert.equal(memory.total, 1)
    assert.equal(memory.notes[0].kind, 'run')
    assert.match(memory.notes[0].text, /Handled "Audit"/)
    assert.equal(memory.notes[0].runId, run.id)
    assert.equal(memory.stats.logCount, 1)
    assert.equal(memory.stats.indexCount, 0)

    const reopened = new CrewStore({ dataDir: dir })
    await reopened.load()
    const second = createOrchestrator({ store: reopened, delegate: async () => ({}) })
    assert.equal((await second.manageMemory({ profileId: 'rev', action: 'list' })).total, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed task records the failure code, and clearing empties memory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-mem3-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  const orchestrator = createOrchestrator({
    store,
    toolNames: () => ['read'],
    limits: { retryBackoffMs: 1, defaultMaxAttempts: 1 },
    delegate: async (call) => ({ childId: 'c', name: call.name, stopReason: 'error', text: '', errorCode: 'BOOM', errorMessage: 'nope' }),
  })
  try {
    await orchestrator.defineProfile({ id: 'rev', name: 'Rev', tools: ['read'], maxAttempts: 1 })
    await orchestrator.manageMemory({ profileId: 'rev', action: 'add', text: 'curated' })
    const run = await orchestrator.createRun({ title: 'F', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'rev', subject: 'Break' }])
    await orchestrator.startRun(run.id, { parent: { id: 'lead' } })

    const memory = await orchestrator.manageMemory({ profileId: 'rev', action: 'list' })
    assert.equal(memory.total, 2)
    const failureNote = memory.notes.find((note) => note.kind === 'run')
    assert.match(failureNote.text, /Failed "Break"/)
    assert.match(failureNote.text, /BOOM/)

    const cleared = await orchestrator.manageMemory({ profileId: 'rev', action: 'clear' })
    assert.equal(cleared.cleared, 2)
    assert.equal((await orchestrator.manageMemory({ profileId: 'rev', action: 'list' })).total, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a profile written before memory existed still works', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-mem4-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  await store.update((state) => {
    state.profiles.rev = {
      id: 'rev',
      name: 'Rev',
      role: 'r',
      instructions: '',
      capabilities: [],
      tools: ['read'],
      source: 'store',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    state.profileOrder = ['rev']
  })
  const orchestrator = createOrchestrator({ store, delegate: async () => ({}) })
  try {
    assert.equal((await orchestrator.manageMemory({ profileId: 'rev', action: 'list' })).total, 0)
    assert.equal((await orchestrator.manageMemory({ profileId: 'rev', action: 'add', text: 'first note' })).total, 1)
    assert.equal(orchestrator.listProfiles()[0].memoryCount, 1)
    // A record without a runtime is treated as the local backend.
    assert.equal(orchestrator.listProfiles()[0].runtime, 'spawn')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a codex specialist names a provider instance instead of a model', () => {
  // The codex provider reads its model from the instance config at start time;
  // a per-request model is not part of its contract, so the profile must not
  // pretend to set one.
  const codex = normalizeProfile({ name: 'C', runtime: 'codex', codexProvider: 'codex-sol' })
  assert.equal(codex.codexProvider, 'codex-sol')
  // `normalizeProfile` keeps the route as `llmProvider`; `publicProfile` is
  // what renames it to `provider` on the wire.
  assert.equal(codex.llmProvider, undefined)
  assert.equal(codex.model, undefined)

  // Naming a local LLM route on a codex profile is a mistake, not a no-op.
  assert.throws(
    () => normalizeProfile({ name: 'C', runtime: 'codex', provider: 'kk', model: 'deepseek-v4.1-flash' }),
    (error) => error instanceof CrewError && error.code === 'PROFILE_INVALID',
  )

  // A local specialist keeps its model route and ignores codexProvider.
  const local = normalizeProfile({ name: 'L', runtime: 'spawn', provider: 'kk', model: 'm', codexProvider: 'x' })
  assert.equal(local.llmProvider, 'kk')
  assert.equal(local.codexProvider, undefined, 'the field is codex-only')
})

test('memory notes and codex settings do not leak across profiles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-rt-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  const orchestrator = createOrchestrator({ store, delegate: async () => ({}) })
  try {
    await orchestrator.defineProfile({ id: 'a', name: 'A', runtime: 'codex', codexProvider: 'codex-sol' })
    await orchestrator.defineProfile({ id: 'b', name: 'B', runtime: 'spawn', tools: ['read'] })
    const [a, b] = orchestrator.listProfiles()
    assert.equal(a.runtime, 'codex')
    assert.equal(a.codexProvider, 'codex-sol')
    assert.equal(b.runtime, 'spawn')
    assert.equal(b.codexProvider, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
