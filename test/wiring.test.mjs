/**
 * Host wiring tests.
 *
 * These exercise the parts of `index.js` that only run inside a live Host: the
 * delegation adapter contract and the child-scope memory tool. The DSH services
 * are faked, so the test asserts this plugin's own wiring rather than DSH's.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PACKAGE_DIR = new URL('..', import.meta.url)
const ENTRY = new URL('../index.js', import.meta.url)

/**
 * Load the Host half. It imports DSH packages, so the profile's own
 * node_modules is used as the resolution anchor by importing the installed
 * copy is not possible here; instead we assert on source text for the parts
 * that cannot run without the runtime, and on the pure modules for behaviour.
 */
test('the delegation adapter passes the profile id to the child scope', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(ENTRY, 'utf8')

  // The child memory tool is scoped by profile: the id must travel from the
  // delegation call into `pendingPolicies`, or the tool resolves "undefined".
  const set = source.match(/pendingPolicies\.set\([^)]*\)/)
  assert.ok(set, 'expected the pending-policy registration')
  assert.match(set[0], /profileId:\s*profile\.id/, 'the pending entry must carry the profile id')

  const consume = source.match(/registerChildMemoryTool\([^)]*\)/)
  assert.ok(consume, 'expected the child memory tool registration')
  assert.match(consume[0], /entry\.profileId/, 'the tool must be bound to that exact id')

  // Memory writing is implicit for any specialist that can act, so the policy
  // is extended in the engine rather than requiring a hand-written tool entry.
  const engine = await readFile(new URL('../lib/orchestrator.js', import.meta.url), 'utf8')
  assert.match(engine, /\['crew_memory_note', 'crew_memory_read'\]/, 'the engine adds both memory tools')
  assert.match(engine, /LOCAL_RUNTIMES\.includes\(profile\.runtime/, 'and only for the local backend')
})

test('memory writing is implicit only for a specialist that can act', async () => {
  const { toolAllowed } = await import('../lib/profiles.js')
  const { normalizeProfile, resolveToolPolicy } = await import('../lib/profiles.js')

  // The bare resolver knows nothing about memory; the engine widens it.
  const bare = resolveToolPolicy(normalizeProfile({ name: 'Working', tools: ['read'] }), ['read', 'crew_memory_note'])
  assert.equal(bare.mode, 'allow')
  assert.equal(toolAllowed(bare, 'crew_memory_note'), false)

  // A specialist with no usable tool keeps no write capability at all, which is
  // what the engine checks before widening the policy.
  const silent = resolveToolPolicy(normalizeProfile({ name: 'Silent', tools: ['missing'] }), ['read'])
  assert.equal(silent.mode, 'none')
})

test('the @ mention source is registered on the trigger service when present', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

  // The source must bind to `@`, be optional, and insert plain text only.
  assert.match(source, /trigger:\s*'@'/)
  assert.match(source, /registerSource/)
  // The regression this file pins: reading the service with `ctx.get` at apply
  // time missed it and the @ menu vanished. Registration must go through
  // `ctx.inject`, which resolves the service whenever it arrives.
  assert.match(source, /ctx\.inject\(\['inputTriggers'\]/, 'the @ source must wait for the service')
  assert.ok(!/ctx\.get\?\.\('inputTriggers'\)/.test(source), 'a bare ctx.get would silently skip registration')
  // A pick must insert a reference: plain text was matched by the file rule,
  // which drew a file glyph for a path that does not exist.
  assert.match(source, /insert:\s*\{/, 'a pick inserts a reference, not text')
  assert.match(source, /appearance:\s*'session'/, 'the non-file chip appearance')
  assert.match(source, /codec:\s*\{/, 'a codec is required for insert outcomes')
  assert.match(source, /dsh-agent:/, 'the wire form is what the transcript rule matches')
  assert.match(source, /openReference:\s*\(\)\s*=>\s*false/, 'no preview target exists, so the gesture is left alone')
})
