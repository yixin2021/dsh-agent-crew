/**
 * Management dispatch tests.
 *
 * The browser page talks to the Host only through this function, so its
 * contract — action names, response shape, and error codes — is what the page
 * actually depends on.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createManagementRoute, dispatchManagement, isMatchableRoutePath, ROUTE, ROUTE_RELATIVE } from '../lib/management.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { CrewStore } from '../lib/store.js'

/** Build a real orchestrator over a temporary store. */
async function makeDeps(delegate = async (call) => ({ childId: 'c1', name: call.name, stopReason: 'completed', text: 'done' })) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-crew-mgmt-'))
  const store = new CrewStore({ dataDir: dir })
  await store.load()
  const orchestrator = createOrchestrator({
    store,
    toolNames: () => ['read'],
    limits: { retryBackoffMs: 1 },
    delegate,
  })
  const service = { dataDir: dir, provider: 'spawn', limits: orchestrator.limits, storeWarning: undefined }
  return { deps: { orchestrator, service }, dir, orchestrator }
}

test('the host route matches the exact pathname the browser requests', () => {
  // `connection.fetch` matches `new URL(request.url).pathname` exactly, and a
  // pathname always starts with a slash; registering without one silently 404s.
  assert.equal(ROUTE, '/api/agent-crew')
  assert.ok(ROUTE.startsWith('/'), 'the registered path must be absolute')
  // The browser resolves a relative reference against the page origin.
  assert.equal(ROUTE_RELATIVE, 'api/agent-crew')
  assert.ok(!ROUTE_RELATIVE.startsWith('/'), 'a leading slash would drop a deployment prefix')
  // The desktop shell loads the page from its own scheme; `dsh web` serves the
  // origin root. Both resolve the relative reference to the registered path.
  assert.equal(new URL(ROUTE_RELATIVE, 'dsh-app://app/').pathname, ROUTE)
  assert.equal(new URL(ROUTE_RELATIVE, 'http://127.0.0.1:60533/').pathname, ROUTE)
  assert.equal(isMatchableRoutePath(ROUTE), true)
  // The regression this test exists for: a relative registration never matches.
  assert.equal(isMatchableRoutePath(ROUTE_RELATIVE), false)
  assert.equal(isMatchableRoutePath(''), false)
  assert.equal(isMatchableRoutePath('/api/agent-crew/'), false)
})

test('list returns profiles and runs with task previews', async () => {
  const { deps, dir, orchestrator } = await makeDeps()
  try {
    await orchestrator.defineProfile({ name: 'Reviewer', role: 'reviewer', tools: ['read'] })
    const run = await orchestrator.createRun({ title: 'Demo', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'reviewer', subject: 'Work' }])
    await orchestrator.startRun(run.id, { parent: { id: 'lead' } })

    const answer = await dispatchManagement(deps, { action: 'list', limitRuns: 5 })
    assert.equal(answer.ok, true)
    assert.equal(answer.data.provider, 'spawn')
    assert.equal(answer.data.dir, dir)
    assert.equal(answer.data.profiles.length, 1)
    // The page edits profiles, so instructions always come back.
    assert.equal(answer.data.profiles[0].instructions, '')
    assert.equal(answer.data.runs.length, 1)
    const [task] = answer.data.runs[0].tasks
    assert.equal(task.status, 'completed')
    assert.equal(task.resultPreview, 'done')
    assert.equal(answer.data.warning, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveProfile writes through the same validation as the tool', async () => {
  const { deps, dir } = await makeDeps()
  try {
    const saved = await dispatchManagement(deps, {
      action: 'saveProfile',
      profile: { id: 'writer', name: 'Writer', role: 'docs', tools: ['read'], instructions: 'Be brief.' },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.data.profile.id, 'writer')
    assert.equal(saved.data.profile.source, 'store')

    const rejected = await dispatchManagement(deps, {
      action: 'saveProfile',
      profile: { id: 'Bad Id', name: 'Bad' },
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'PROFILE_INVALID')

    const missing = await dispatchManagement(deps, { action: 'saveProfile', profile: { name: '' } })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'PROFILE_INVALID')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteProfile and deleteRun report stable errors', async () => {
  const { deps, dir, orchestrator } = await makeDeps()
  try {
    await orchestrator.defineProfile({ name: 'Temp', tools: ['read'] })
    const removed = await dispatchManagement(deps, { action: 'deleteProfile', id: 'temp' })
    assert.equal(removed.ok, true)
    assert.equal(removed.data.removed, true)

    const missing = await dispatchManagement(deps, { action: 'deleteProfile', id: 'temp' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'PROFILE_NOT_FOUND')

    const noRun = await dispatchManagement(deps, { action: 'deleteRun', id: 'run_missing' })
    assert.equal(noRun.ok, false)
    assert.equal(noRun.error.code, 'RUN_NOT_FOUND')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running run cannot be deleted, and a settled one can', async () => {
  // A delegate that only settles on abort keeps the run genuinely in flight.
  const hanging = (call) =>
    new Promise((resolve) => {
      call.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', text: '' }), { once: true })
    })
  const { deps, dir, orchestrator } = await makeDeps(hanging)
  try {
    await orchestrator.defineProfile({ name: 'Slow', tools: ['read'] })
    const run = await orchestrator.createRun({ title: 'Live', lead: { id: 'lead' } })
    await orchestrator.addTasks(run.id, [{ profileId: 'slow', subject: 'Work' }])
    const running = orchestrator.startRun(run.id, { parent: { id: 'lead' } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const blockedByStatus = await dispatchManagement(deps, { action: 'deleteRun', id: run.id })
    assert.equal(blockedByStatus.ok, false)
    assert.equal(blockedByStatus.error.code, 'RUN_BUSY')

    await orchestrator.cancelRun(run.id)
    await running
    const removed = await dispatchManagement(deps, { action: 'deleteRun', id: run.id })
    assert.equal(removed.ok, true)
    assert.equal(orchestrator.listRuns(5).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown and malformed requests answer with typed errors', async () => {
  const { deps, dir } = await makeDeps()
  try {
    const unknown = await dispatchManagement(deps, { action: 'nope' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'UNKNOWN_ACTION')

    for (const body of [null, undefined, 'text', 42, []]) {
      const answer = await dispatchManagement(deps, body)
      assert.equal(answer.ok, false)
      assert.equal(answer.error.code, 'UNKNOWN_ACTION')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the registered route answers the browser with a typed envelope', async () => {
  const { deps, dir, orchestrator } = await makeDeps()
  try {
    await orchestrator.defineProfile({ name: 'Reviewer', tools: ['read'] })
    const route = createManagementRoute(deps)
    // The path is what `connection.fetch` matches against `URL.pathname`.
    assert.equal(route.path, '/api/agent-crew')
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')

    const answer = await route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    }))
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('cache-control'), 'no-store')
    const decoded = await answer.json()
    assert.equal(decoded.ok, true)
    assert.equal(decoded.data.profiles.length, 1)

    // A malformed body is a 400 with the same envelope shape, never a throw.
    const bad = await route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST',
      body: 'not json',
    }))
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error.code, 'BAD_REQUEST')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a browser request reaches the route through the connection lookup', async () => {
  const { deps, dir, orchestrator } = await makeDeps()
  try {
    await orchestrator.defineProfile({ name: 'Reviewer', tools: ['read'] })
    const route = createManagementRoute(deps)

    // Reproduce the Host's exact lookup: `fetchRoutes.get(new URL(url).pathname)`.
    // This is the shape of the bug that shipped: the route was registered
    // without a leading slash, so every browser call fell through to 404.
    const fetchRoutes = new Map([[route.path, route]])
    const requestedByBrowser = new URL(ROUTE_RELATIVE, 'dsh-app://app/').href
    const pathname = new URL(requestedByBrowser).pathname
    assert.equal(pathname, '/api/agent-crew')
    assert.ok(fetchRoutes.has(pathname), `no route registered for ${pathname}`)

    const answer = await fetchRoutes.get(pathname).fetch(new Request(requestedByBrowser, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    }))
    assert.equal(answer.status, 200)
    const decoded = await answer.json()
    assert.equal(decoded.ok, true)
    assert.equal(decoded.data.profiles[0].id, 'reviewer')

    // The old, broken registration is kept here as the counter-example.
    assert.equal(fetchRoutes.has('api/agent-crew'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
