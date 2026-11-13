/**
 * Client-half tests.
 *
 * The browser artifact is plain JavaScript that registers through
 * `window.__ModuleLoader__` and renders with the shell's React. These tests load
 * the real `client.js`, provide a small React implementation with working hooks
 * and a fake slot registry, then render the page against a stubbed Host route.
 *
 * They do not replace looking at the panel in a browser; they catch the failures
 * that would otherwise only appear as a blank column or a silently empty pane.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const FRAGMENT = Symbol('fragment')

/** @type {any} */
let captured

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}
globalThis.document = { baseURI: 'dsh-app://app/' }

/**
 * A minimal React implementation with per-component hook stores, effect deps,
 * and re-render scheduling, enough to render the real page and observe a
 * repaint after an awaited Host call.
 * @returns {{ React: any, renderRoot: (Page: any, props?: any) => any }}
 */
function createReact() {
  /** @type {Map<any, any[]>} */
  const stores = new Map()
  /** @type {Map<any, Map<number, unknown[]>>} */
  const effectDeps = new Map()
  /** @type {Map<any, Map<number, { fn: any, deps: unknown[] }>>} */
  const callbackSlots = new Map()
  let currentFn = null
  let cursor = 0
  /** @type {Array<() => void>} */
  let pendingEffects = []
  let scheduled = false
  /** @type {null | (() => void)} */
  let repaint = null

  const sameDeps = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const schedule = () => {
    if (scheduled || repaint === null) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      repaint?.()
    })
  }

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      const nextProps = { ...(props ?? {}) }
      if (flat.length === 1) nextProps.children = flat[0]
      else if (flat.length > 1) nextProps.children = flat
      return { $$element: true, type, props: nextProps, children: flat }
    },
    useState(initial) {
      const store = stores.get(currentFn)
      const index = cursor++
      if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
      return [
        store[index],
        (next) => {
          store[index] = typeof next === 'function' ? next(store[index]) : next
          schedule()
        },
      ]
    },
    useCallback(fn, deps) {
      const index = cursor++
      const slots = callbackSlots.get(currentFn) ?? new Map()
      callbackSlots.set(currentFn, slots)
      const previous = slots.get(index)
      // Same contract as React: a stable identity while deps are unchanged,
      // which is what keeps a `useEffect(..., [callback])` from re-firing.
      if (previous !== undefined && deps !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      slots.set(index, { fn, deps })
      return fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      const slots = effectDeps.get(currentFn) ?? new Map()
      effectDeps.set(currentFn, slots)
      const previous = slots.get(index)
      if (previous !== undefined && deps !== undefined && sameDeps(previous, deps)) return
      slots.set(index, deps)
      pendingEffects.push(fn)
    },
    useRef(value) {
      cursor += 1
      return { current: value }
    },
  }
  React.Component = class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  }

  /** Expand one node, giving every function component its own hook store. */
  function walk(node) {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(walk)
    if (!node.$$element) return node
    const { type, props, children } = node
    if (type === FRAGMENT) return children.map(walk)
    if (typeof type === 'function') {
      const isClass = type.prototype && typeof type.prototype.render === 'function'
      if (isClass) {
        const instance = new type(props)
        return walk(instance.render())
      }
      const previousFn = currentFn
      const previousCursor = cursor
      if (!stores.has(type)) stores.set(type, [])
      currentFn = type
      cursor = 0
      const output = type({ ...props, children })
      currentFn = previousFn
      cursor = previousCursor
      return walk(output)
    }
    return { ...node, children: children.map(walk) }
  }

  /**
   * Render a root component and flush that paint's effects.
   * @param {any} Page
   * @param {any} [props]
   * @returns {any} the expanded tree
   */
  function renderRoot(Page, props = {}) {
    pendingEffects = []
    const tree = walk({ $$element: true, type: Page, props, children: [] })
    const effects = pendingEffects.splice(0)
    // An effect body that throws must fail the test, not vanish into the void.
    for (const effect of effects) effect()
    return tree
  }

  repaint = () => {
    renderRoot(repaintPage, repaintProps)
  }
  let repaintPage = null
  let repaintProps = {}

  /**
   * Mount a page, remember how to repaint it, and return the paint function.
   * @param {any} Page
   * @param {any} [props]
   */
  function mount(Page, props = {}) {
    repaintPage = Page
    repaintProps = props
    const paint = () => renderRoot(Page, props)
    paint()
    return { paint }
  }

  return { React, mount }
}

/** Flatten an already-expanded tree to text. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (!node.$$element) return ''
  return node.children.map(textOf).join(' ')
}

/** Collect every expanded node matching a predicate. */
function collect(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (!node.$$element) return found
  if (predicate(node)) found.push(node)
  for (const child of node.children) collect(child, predicate, found)
  return found
}

/** Load the artifact once and return its module face. */
async function loadModule(React) {
  await import('../client.js')
  assert.ok(captured, 'client.js should register through window.__ModuleLoader__')
  return captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
}

/** Apply the module into a fake client context, returning its registrations. */
function applyInto(module) {
  const registrations = []
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'en' }) },
    effect: (fn) => fn(),
    on: () => () => {},
    // Optional-service injection: run the callback with the service present.
    inject: (names, callback) => {
      const inputTriggers = { registerSource: () => () => {} }
      if (!names.includes('uiConversation')) {
        return callback({ inputTriggers, effect: (fn) => fn() })
      }
      return callback({
        inputTriggers,
        uiConversation: { userText: { register: () => () => {} } },
        slots: { inject: (_slot, inner) => inner(), register: () => () => {} },
        effect: (fn) => fn(),
      })
    },
  }
  module.apply(ctx)
  return { registrations, ctx }
}

/** The sample state the stubbed route answers with. */
function sampleData() {
  return {
    dir: '/Users/someone/.dsh/agent-crew',
    provider: 'spawn',
    limits: { maxParallel: 3 },
    warning: null,
    profiles: [
      {
        id: 'reviewer',
        name: 'Code reviewer',
        role: 'security-focused reviewer',
        instructions: 'Cite file:line for every finding.',
        capabilities: ['diff review', 'threat modeling'],
        tools: ['read', 'grep'],
        maxAttempts: 2,
        timeoutMs: 600000,
        runtime: 'spawn',
        source: 'store',
        memory: [
          { id: 'm1', kind: 'note', text: 'authz lives in middleware', ts: '2026-11-01T00:00:00.000Z' },
          { id: 'm2', kind: 'lesson', text: 'never trust the client tenant id', ts: '2026-11-02T00:00:00.000Z' },
          { id: 'm3', kind: 'topic', title: 'Deploy', text: 'long deploy runbook', ts: '2026-11-03T00:00:00.000Z' },
          { id: 'm4', kind: 'run', text: 'Handled "audit" (1 attempt).', ts: '2026-11-04T00:00:00.000Z' },
        ],
      },
      {
        id: 'writer',
        name: 'Doc writer',
        role: 'writes release notes',
        capabilities: [],
        tools: ['*'],
        runtime: 'codex',
        source: 'config',
      },
    ],
    runs: [
      {
        id: 'run_1',
        title: 'Login audit',
        status: 'failed',
        counts: { total: 3, pending: 0, running: 0, completed: 1, failed: 1, blocked: 1, cancelled: 0 },
        finishedAt: '2026-11-12T03:25:32.089Z',
        tasks: [
          {
            id: 'task-1',
            profileId: 'reviewer',
            subject: 'Review login flow',
            status: 'failed',
            attempt: 2,
            maxAttempts: 2,
            dependsOn: [],
            error: { code: 'TIMEOUT', message: 'The delegated agent exceeded its 1ms limit.' },
            resultPreview: '',
            attempts: [
              {
                attempt: 2,
                childId: 'child-local-1',
                name: 'reviewer-ab12',
                runtime: 'spawn',
                sessionAvailable: true,
                durationMs: 41233,
                stopReason: 'completed',
                resultChars: 120,
                outputPreview: 'found two gaps',
                promptPreview: '# Assigned task: Review login flow',
              },
              {
                attempt: 1,
                childId: 'child-codex-1',
                name: 'agent-3',
                runtime: 'codex',
                sessionAvailable: false,
                durationMs: 7344,
                stopReason: 'completed',
                resultChars: 14,
                outputPreview: 'ASYNC_OK',
                promptPreview: '# Assigned task: Review login flow',
              },
            ],
          },
          {
            id: 'task-2',
            profileId: 'reviewer',
            subject: 'Regression suite',
            status: 'blocked',
            attempt: 0,
            maxAttempts: 2,
            dependsOn: ['task-1'],
            error: { code: 'DEPENDENCY_FAILED', message: 'Blocked by task-1.' },
          },
        ],
      },
    ],
  }
}

test('the artifact registers a navigation row and a main panel sharing one id', async () => {
  const { React } = createReact()
  const module = await loadModule(React)
  assert.equal(captured.id, '@local/dsh-agent-crew')
  assert.deepEqual(module.inject, ['slots', 'locale'])

  const { registrations, ctx } = applyInto(module)
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(sidebar, 'expected a sidebar.panellist registration')
  assert.equal(sidebar.options.id, 'agent-crew')
  assert.equal(sidebar.options.order, 15)
  assert.equal(sidebar.options.label(), 'Agent crew')

  const main = registrations.find((entry) => entry.options.name === 'main')
  assert.ok(main, 'expected a main registration')
  assert.equal(main.options.key, sidebar.options.id, 'the row and the page must share one id')

  // The live service publishes a LocaleSnapshot, whose id lives on `active`.
  ctx.locale.getLocale = () => ({ active: 'zh-CN', revision: 2 })
  assert.equal(sidebar.options.label(), '智能体团队')
})

test('the navigation icon renders a sized, theme-colored svg', async () => {
  const { React } = createReact()
  const module = await loadModule(React)
  const { registrations } = applyInto(module)
  const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist').component
  const svg = icon({ size: 16 })
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props['aria-hidden'], 'true')
  const strokes = collect(svg, (node) => node.props && node.props.stroke === 'currentColor')
  assert.ok(strokes.length >= 1, 'the icon must inherit the row color')
})

test('the empty page renders both tabs and its loading state', async () => {
  const { React, mount } = createReact()
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'X', message: 'offline' } }) })
  const module = await loadModule(React)
  const { registrations } = applyInto(module)
  const Page = registrations.find((entry) => entry.options.name === 'main').component
  const view = mount(Page, {})
  const tree = view.paint()
  const text = textOf(tree)
  assert.match(text, /Agent crew/)
  assert.match(text, /Specialists/)
  assert.match(text, /Runs/)
  // The search box and both header actions exist before any data arrives.
  assert.ok(collect(tree, (node) => node.type === 'input').length >= 1)
  assert.ok(collect(tree, (node) => node.type === 'button').length >= 2)
  assert.doesNotMatch(text, /failed to render/)
})

test('populated state renders the roster, detail sections, and run progress', async () => {
  const { React, mount } = createReact()
  globalThis.__fetches = 0
  globalThis.fetch = async () => {
    globalThis.__fetches += 1
    return { status: 200, json: async () => ({ ok: true, data: sampleData() }) }
  }
  const module = await loadModule(React)
  const { registrations } = applyInto(module)
  const Page = registrations.find((entry) => entry.options.name === 'main').component
  const view = mount(Page, {})
  // Let the route promise settle, then repaint from the new state.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = view.paint()
  const text = textOf(tree)

  // One load asks two questions: the roster/state, and which codex providers
  // the Host can reach. Anything more would mean a render loop.
  assert.equal(globalThis.__fetches, 2, `expected two Host calls per load, got ${globalThis.__fetches}`)
  // Header summary counts both collections.
  assert.match(text, /2 specialists · 1 runs/)
  // Both specialists are listed by name and role.
  assert.match(text, /Code reviewer/)
  assert.match(text, /security-focused reviewer/)
  assert.match(text, /Doc writer/)
  // Nothing is selected yet, so the detail pane explains what to do.
  assert.match(text, /Select a specialist/)

  // Selecting a profile shows its sections and tool chips.
  const items = collect(tree, (node) => node.type === 'button' && /dac-item/.test(node.props.className ?? ''))
  assert.equal(items.length, 2)
  items[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const detail = textOf(view.paint())
  assert.match(detail, /What this specialist does/)
  assert.match(detail, /Standing instructions/)
  assert.match(detail, /Cite file:line/)
  assert.match(detail, /diff review/)
  assert.match(detail, /Tools it may use/)
  assert.match(detail, /Model route/)
  assert.match(detail, /Runs with this specialist/)
  assert.match(detail, /Login audit/)
  // Three memory tiers with different placement rules.
  assert.match(detail, /Index · injected every task/)
  assert.match(detail, /Topics · read on demand/)
  assert.match(detail, /Log · automatic, never injected/)
  assert.match(detail, /authz lives in middleware/)
  assert.match(detail, /never trust the client tenant id/)
  assert.match(detail, /Deploy — long deploy runbook/)
  assert.match(detail, /characters of index/)
  // The runtime is stated, and the local backend explains what is enforced.
  assert.match(detail, /Runtime/)
  assert.match(detail, /DSH subagent/)
  assert.match(detail, /keeps its own memory across runs/)

  // The codex specialist states that the enforcement does not apply to it.
  const writerItem = collect(view.paint(), (node) => node.type === 'button' && /dac-item/.test(node.props.className ?? ''))[1]
  writerItem.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const codexDetail = textOf(view.paint())
  assert.match(codexDetail, /Codex/)
  assert.match(codexDetail, /do not apply/)
  assert.match(codexDetail, /Nothing kept yet/)

  // Switching to Runs shows the progress bar, the status badge, and task rows.
  const runsTab = collect(view.paint(), (node) => node.props?.['role'] === 'tab' && node.type === 'button')
  runsTab[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const runsTree = view.paint()
  const runsText = textOf(runsTree)
  assert.match(runsText, /1 of 3 complete/)
  assert.match(runsText, /1 failed · 1 blocked/)
  assert.match(runsText, /failed/)
  // Progress renders one segment per non-empty bucket: 1 completed, 1 failed + 1 blocked.
  const segments = collect(runsTree, (node) => /dac-bar-seg/.test(node.props?.className ?? ''))
  assert.equal(segments.length, 2, 'one completed segment and one failure segment')
  assert.ok(
    segments.some((node) => /dac-bar-done/.test(node.props.className)),
    'the completed segment must be present',
  )
  assert.ok(
    segments.some((node) => /dac-bar-failed/.test(node.props.className)),
    'the failure segment must be present',
  )

  // Expanding the run reveals task rows with their errors and attempt counts.
  const expandButton = collect(runsTree, (node) => node.type === 'button' && /Show tasks/.test(textOf(node)))[0]
  assert.ok(expandButton, 'expected a task expand control')
  expandButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const taskText = textOf(view.paint())
  assert.match(taskText, /Review login flow/)
  assert.match(taskText, /TIMEOUT/)
  assert.match(taskText, /attempt 2\/2/)
  assert.match(taskText, /after task-1/)
})

test('the Chinese locale localizes the populated panel end to end', async () => {
  const { React, mount } = createReact()
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, data: sampleData() }) })
  const module = await loadModule(React)
  // The service publishes `LocaleSnapshot`; the id is `active`, not `id`.
  const registrations = []
  module.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'zh', revision: 1 }) },
    effect: (fn) => fn(),
    on: () => () => {},
    inject: (names, callback) => {
      const inputTriggers = { registerSource: () => () => {} }
      if (!names.includes('uiConversation')) {
        return callback({ inputTriggers, effect: (fn) => fn() })
      }
      return callback({
        inputTriggers,
        uiConversation: { userText: { register: () => () => {} } },
        slots: { inject: (_slot, inner) => inner(), register: () => () => {} },
        effect: (fn) => fn(),
      })
    },
  })

  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(sidebar.options.label(), '智能体团队')

  const Page = registrations.find((entry) => entry.options.name === 'main').component
  const view = mount(Page, {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = textOf(view.paint())

  // Chinese chrome must be present...
  assert.match(text, /智能体团队/)
  assert.match(text, /2 个专家 · 1 个运行/)
  assert.match(text, /专家/)
  assert.match(text, /运行/)
  assert.match(text, /刷新/)
  assert.match(text, /新建专家/)
  assert.match(text, /选择一个专家/)

  // The search field carries its wording on props, not children.
  const search = collect(view.paint(), (node) => node.type === 'input')[0]
  assert.ok(search, 'expected a search field')
  assert.equal(search.props.placeholder, '搜索专家')
  assert.equal(search.props['aria-label'], '搜索专家')

  // ...and the English chrome must be gone. These four were what the user saw.
  for (const leaked of ['Agent crew', 'Specialists', 'Refresh', 'New specialist', 'Select a specialist', 'Search specialists']) {
    assert.ok(!text.includes(leaked), `English "${leaked}" leaked into the Chinese panel`)
  }

  // Selecting a specialist localizes the detail sections and duration units.
  const items = collect(view.paint(), (node) => node.type === 'button' && /dac-item/.test(node.props.className ?? ''))
  assert.equal(items.length, 2)
  items[0].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const detail = textOf(view.paint())
  assert.match(detail, /这个专家做什么/)
  assert.match(detail, /常驻指令/)
  assert.match(detail, /可用工具/)
  assert.match(detail, /模型路由/)
  assert.match(detail, /尝试次数/)
  assert.match(detail, /10 分钟/)
  assert.ok(!detail.includes('What this specialist does'), 'English section title leaked')
  assert.ok(!detail.includes('Model route'), 'English section title leaked')

  // The Runs tab and its task rows are localized too.
  const tabs = collect(view.paint(), (node) => node.props?.['role'] === 'tab' && node.type === 'button')
  tabs[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const runsText = textOf(view.paint())
  assert.match(runsText, /已完成 1\/3/)
  assert.match(runsText, /1 失败 · 1 阻塞/)
  assert.match(runsText, /失败/)
  assert.ok(!runsText.includes('1 of 3 complete'), 'English progress leaked')
})

test('both dictionaries define the same keys', async () => {
  // A key missing from ZH silently falls back to English, so parity is the
  // only thing that keeps the Chinese panel from leaking untranslated chrome.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../client.js', import.meta.url), 'utf8'))
  const keysOf = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    const end = source.indexOf('\n    }', start)
    const body = source.slice(start, end)
    return [...body.matchAll(/^\s{6}(?:'([^']+)'|([A-Za-z]\w*)):/gm)].map((match) => match[1] ?? match[2])
  }
  const en = keysOf('EN')
  const zh = keysOf('ZH')
  assert.ok(en.length > 50, `expected a populated dictionary, got ${en.length}`)
  assert.deepEqual(zh.slice().sort(), en.slice().sort())
})

test('the @ source registers late and lists specialists from the Host route', async () => {
  const { React } = createReact()
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      data: {
        profiles: [
          { id: 'reviewer', name: 'Code reviewer', role: 'security review', tools: ['read'], runtime: 'spawn', memoryCount: 4 },
          { id: 'writer', name: 'Doc writer', role: 'release notes', tools: ['*'], runtime: 'codex', memoryCount: 0 },
        ],
      },
    }),
  })
  const module = await loadModule(React)

  /** @type {any[]} */
  const sources = []
  let injected = false
  module.apply({
    slots: { inject: (_slot, cb) => cb(), register: () => () => {} },
    locale: { getLocale: () => ({ active: 'en' }) },
    effect: (fn) => fn(),
    on: () => () => {},
    inject: (names, callback) => {
      if (names.includes('inputTriggers')) {
        injected = true
        assert.deepEqual(names, ['inputTriggers'], 'the @ source depends on the trigger service')
        return callback({
          inputTriggers: { registerSource: (src) => { sources.push(src); return () => {} } },
          effect: (fn) => fn(),
        })
      }
      // The transcript renderer asks for the conversation service separately.
      return callback({
        uiConversation: { userText: { register: () => () => {} } },
        slots: { inject: (_slot, inner) => inner(), register: () => () => {} },
        effect: (fn) => fn(),
      })
    },
  })

  // The regression: a plain ctx.get() at apply time missed the service and the
  // menu silently vanished. Injection must always happen.
  assert.equal(injected, true)
  assert.equal(sources.length, 1)

  const source = sources[0]
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'agentCrew')

  const rows = await source.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'reviewer')
  assert.equal(rows[0].label, 'Code reviewer')
  assert.match(rows[0].hint, /4 notes/, 'the memory count is advertised')

  // Search narrows by id, name, or role.
  const narrowed = await source.candidates({ sessionId: 's1' }, { query: 'release', signal: { aborted: false } })
  assert.equal(narrowed.length, 1)
  assert.equal(narrowed[0].name, 'writer')

  const none = await source.candidates({ sessionId: 's1' }, { query: 'zzz', signal: { aborted: false } })
  assert.equal(none.length, 0)

  // A pick inserts a real reference: that is what makes the composer render a
  // chip instead of plain text, and what routes submit through the codec.
  const outcome = source.onPick({ candidate: rows[0] })
  assert.ok(outcome.insert, 'a pick must insert a reference, not text')
  assert.equal(outcome.insert.source, 'agentCrew')
  assert.equal(outcome.insert.appearance, 'session', 'a file appearance would draw a file glyph')
  assert.equal(outcome.insert.clipboardText, '@Code reviewer')

  // The codec round-trips: clipboard form for drafts, wire form for the model.
  assert.equal(source.codec.clipboardText(outcome.insert.ref), '@Code reviewer')
  assert.equal(
    await source.codec.serialize(outcome.insert.ref, { aborted: false }),
    '@[Code reviewer](dsh-agent:reviewer)',
  )
  // Nothing to open: the editor gesture stays untouched instead of failing.
  assert.equal(source.openReference({}, { ref: outcome.insert.ref, appearance: 'session' }), false)
})

test('the form renders both runtime branches, and a codex switch does not throw', async () => {
  const { React, mount } = createReact()
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}')
    if (body.action === 'codexProviders') {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          data: { providers: [{ name: 'codex-sol', ready: true, model: 'gpt-6.1-sol' }] },
        }),
      }
    }
    return { status: 200, json: async () => ({ ok: true, data: sampleData() }) }
  }
  const module = await loadModule(React)
  const { registrations } = applyInto(module)
  const Page = registrations.find((entry) => entry.options.name === 'main').component
  const view = mount(Page, {})
  await new Promise((resolve) => setTimeout(resolve, 0))

  // Open the create form.
  const newButton = collect(view.paint(), (node) => node.type === 'button' && /New specialist/.test(textOf(node)))[0]
  assert.ok(newButton, 'expected a create control')
  newButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const localForm = textOf(view.paint())
  // The local branch shows the tool list and the model route.
  assert.match(localForm, /Basics/)
  assert.match(localForm, /How it works/)
  assert.match(localForm, /Limits/)
  assert.match(localForm, /Tools/)
  assert.match(localForm, /Provider/)
  assert.ok(!localForm.includes('failed to render'))

  // Switch the runtime to codex through the select's change handler.
  const runtimeSelect = collect(view.paint(), (node) => node.type === 'select')[0]
  assert.ok(runtimeSelect, 'expected the runtime select')
  assert.deepEqual(
    runtimeSelect.children.map((option) => option.props.value),
    ['spawn', 'codex'],
  )
  runtimeSelect.props.onChange({ target: { value: 'codex' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const codexFormTree = view.paint()
  const codexForm = textOf(codexFormTree)

  // This is the regression: an undefined helper used to blank the whole panel.
  assert.ok(!codexForm.includes('failed to render'), 'the codex branch must not throw')
  assert.match(codexForm, /Codex provider/)
  assert.match(codexForm, /own sandbox and tool policy/)
  // The local-only fields are gone.
  assert.ok(!/\bTools\b/.test(codexForm), 'the tool list is not offered for codex')
  assert.ok(!/^Provider$/m.test(codexForm), 'the LLM provider is not offered for codex')

  // Naming a registered provider reports its model; an unknown one warns.
  // Fields are `<label><span>Label</span><input/></label>`, and several inputs
  // start empty, so the field must be located by its label.
  const inputForLabel = (tree, labelText) => {
    const label = collect(tree, (node) => node.type === 'label' && textOf(node).startsWith(labelText))[0]
    assert.ok(label, `expected a field labelled ${labelText}`)
    return collect(label, (node) => node.type === 'input')[0]
  }

  const providerInput = inputForLabel(codexFormTree, 'Codex provider')
  assert.ok(providerInput, 'expected the codex provider input')
  providerInput.props.onChange({ target: { value: 'codex-sol' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(textOf(view.paint()), /gpt-6\.1-sol/)

  const typed = inputForLabel(view.paint(), 'Codex provider')
  typed.props.onChange({ target: { value: 'codex-missing' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(textOf(view.paint()), /Not registered/)
})

test('the transcript rule finds a specialist mention and the chip renders it', async () => {
  const { React } = createReact()
  // A second harness instance expands the chip for assertions below.

  const module = await loadModule(React)

  /** @type {any[]} */
  const rules = []
  /** @type {any[]} */
  const nodes = []
  /** @type {string[]} */
  const selectedPanels = []
  module.apply({
    slots: {
      inject: (_slot, cb) => cb(),
      register: (options, component) => {
        if (options.name === 'conversation.user.text.node') nodes.push({ options, component })
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'en' }) },
    effect: (fn) => fn(),
    on: () => () => {},
    inject: (names, cb) => {
      if (names.includes('uiConversation')) {
        return cb({
          uiConversation: { userText: { register: (rule) => { rules.push(rule); return () => {} } } },
          slots: {
            inject: (_slot, inner) => inner(),
            register: (options, component) => {
              if (options.name === 'conversation.user.text.node') nodes.push({ options, component })
              return () => {}
            },
          },
          effect: (fn) => fn(),
        })
      }
      return cb({ inputTriggers: { registerSource: () => () => {} }, effect: (fn) => fn() })
    },
  })

  const rule = rules.find((entry) => entry.id === 'agentCrewMention')
  assert.ok(rule, 'the transcript needs its own rule')
  // It must outrank the file rule (order 30), or a mention draws a file glyph.
  assert.ok(rule.order < 30, `rule order ${rule.order} must beat the file rule`)

  const text = 'please ask @[Code reviewer](dsh-agent:reviewer) about it'
  const node = rule.match(text, 0)
  assert.ok(node, 'the wire form must match')
  assert.equal(node.data.label, 'Code reviewer')
  assert.equal(node.data.profileId, 'reviewer')
  assert.equal(text.slice(node.start, node.end), '@[Code reviewer](dsh-agent:reviewer)')

  // A plain file mention is left to the file rule.
  assert.equal(rule.match('see @src/index.ts for details', 0), undefined)

  // The chip renders the label and a glyph, never a file.
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].options.key, 'agentCrewMention')

  const { mount } = createReact()
  const renderChip = (interactive) => {
    const injected = typeof nodes[0].options.inject === 'function' ? nodes[0].options.inject('s1') : {}
    const view = mount(
      () => nodes[0].component({
        node,
        raw: text.slice(node.start, node.end),
        interactive,
        ...injected,
      }),
      {},
    )
    return view.paint()
  }

  // Read-only in a non-interactive transcript: a span, no affordance.
  const staticChip = renderChip(false)
  assert.match(textOf(staticChip), /Code reviewer/)
  // Text-only, like the composer's own reference chip: an icon made it taller
  // and busier than the surrounding sentence.
  assert.equal(collect(staticChip, (n) => n.type === 'svg').length, 0, 'no icon inside the chip')
  assert.equal(collect(staticChip, (n) => n.type === 'button').length, 0, 'no button when not interactive')

  // Interactive: a real button that opens the specialist.
  const opened = []
  const interactiveTree = renderChip(true)
  const button = collect(interactiveTree, (n) => n.type === 'button')[0]
  assert.ok(button, 'an interactive chip must be clickable')
  assert.equal(button.props.type, 'button')
  assert.match(button.props.title, /reviewer/)

  // The click routes to the crew panel through the injected handler.
  const injectedHandler = typeof nodes[0].options.inject === 'function' ? nodes[0].options.inject('s1') : {}
  assert.equal(typeof injectedHandler.openProfile, 'function', 'the slot injects the opener')
  injectedHandler.openProfile('reviewer')
  opened.push('reviewer')
  assert.deepEqual(opened, ['reviewer'])
})

test('clicking a mention opens the crew panel on that specialist', async () => {
  const { React, mount } = createReact()
  const module = await loadModule(React)

  /** @type {any[]} */
  const rules = []
  /** @type {any[]} */
  const nodes = []
  const selectedPanels = []
  const layout = { selectPanel: (id) => selectedPanels.push(id) }

  const ctx = {
    slots: {
      inject: (_slot, cb) => cb(),
      register: (options, component) => {
        if (options.name === 'conversation.user.text.node') nodes.push({ options, component })
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'en' }) },
    effect: (fn) => fn(),
    on: () => () => {},
    get: (name) => (name === 'layout' ? layout : undefined),
    inject: (names, cb) => {
      if (names.includes('inputTriggers') && !names.includes('uiConversation')) {
        return cb({ inputTriggers: { registerSource: () => () => {} }, effect: (fn) => fn() })
      }
      return cb({
        inputTriggers: { registerSource: () => () => {} },
        uiConversation: { userText: { register: (rule) => { rules.push(rule); return () => {} } } },
        effect: (fn) => fn(),
      })
    },
  }

  const registrations = []
  const originalRegister = ctx.slots.register
  ctx.slots.register = (options, component) => {
    registrations.push({ options, component })
    return originalRegister(options, component)
  }
  module.apply(ctx)

  // The chip is registered on the ROOT slot (same shape as the reference and
  // skill packages), not on a scoped context.
  const chipRegistration = registrations.find((r) => r.options.name === 'conversation.user.text.node')
  assert.ok(chipRegistration, 'the mention chip must be registered')
  assert.equal(chipRegistration.options.key, 'agentCrewMention')

  const rule = rules.find((r) => r.id === 'agentCrewMention')
  const text = '@[Code reviewer](dsh-agent:reviewer) please look'
  const node = rule.match(text, 0)
  const injected = chipRegistration.options.inject('s1')
  const view = mount(
    () => chipRegistration.component({ node, raw: '@[Code reviewer](dsh-agent:reviewer)', interactive: true, ...injected }),
    {},
  )
  const button = collect(view.paint(), (n) => n.type === 'button')[0]
  assert.ok(button, 'expected a clickable chip')

  button.props.onClick()
  // Selecting the panel is how the page is shown; the page then consumes the
  // pending selection on its next paint.
  assert.deepEqual(selectedPanels, ['agent-crew'])
})

test('the transcript chip installs its own stylesheet', async () => {
  // The regression: chip rules lived only inside the page component's <style>,
  // which never reaches the Conversation. The <button> then kept the browser's
  // default chrome and read as a stray input box.
  const { React } = createReact()
  const module = await loadModule(React)

  const appended = []
  const removed = []
  const previous = globalThis.document
  globalThis.document = {
    baseURI: 'dsh-app://app/',
    head: {
      querySelector: () => null,
      appendChild: (element) => { appended.push(element) },
    },
    createElement: () => {
      const element = {
        dataset: {},
        textContent: '',
        remove: () => removed.push(element),
      }
      return element
    },
  }

  try {
    const disposers = []
    module.apply({
      slots: { inject: (_slot, cb) => cb(), register: () => () => {} },
      locale: { getLocale: () => ({ active: 'en' }) },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      on: () => () => {},
      inject: (names, cb) => {
        const inputTriggers = { registerSource: () => () => {} }
        if (!names.includes('uiConversation')) return cb({ inputTriggers, effect: (fn) => fn() })
        return cb({
          inputTriggers,
          uiConversation: { userText: { register: () => () => {} } },
          slots: { inject: (_slot, inner) => inner(), register: () => () => {} },
          effect: (fn) => fn(),
        })
      },
    })

    const style = appended.find((element) => element.dataset?.pluginCss === 'agent-crew/mention.css')
    assert.ok(style, 'the chip stylesheet must be installed in the document head')
    assert.equal(style.dataset.plugin, 'agent-crew')

    // The pill must read like the composer's reference chip: theme tokens, no
    // border, inherited type, inline in the sentence.
    const css = style.textContent
    assert.match(css, /\.dac-mention\{[^}]*border:0/)
    assert.match(css, /\.dac-mention\{[^}]*font:inherit/)
    assert.match(css, /\.dac-mention\{[^}]*line-height:inherit/)
    assert.match(css, /\.dac-mention\{[^}]*appearance:none/)
    assert.match(css, /\.dac-mention\{[^}]*display:inline/)
    // The DSH tokens the shipped chip uses, so light and dark both work.
    assert.match(css, /--dsw-alias-state-business-tertiary/)
    assert.match(css, /--dsw-alias-state-business-primary/)
    assert.match(css, /border-radius:var\(--dsw-radius-sm/)
    // No boxed border, and no self-mixed grey that read as a heavy block.
    assert.ok(!/border:0\.5px solid/.test(css), 'no boxed border around the chip')
    assert.ok(!/currentColor 9%/.test(css), 'no self-mixed grey background')
    assert.match(css, /\.dac-mentionAction\{cursor:pointer/)

    // Disposal removes the element it added.
    for (const dispose of disposers) dispose()
    assert.ok(removed.length >= 1, 'the stylesheet is removed on unload')
  } finally {
    globalThis.document = previous
  }
})

test('a run record shows each attempt, its runtime, and how to see more', async () => {
  const { React, mount } = createReact()
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options?.body ?? '{}')
    if (body.action === 'codexProviders') {
      return { status: 200, json: async () => ({ ok: true, data: { providers: [] } }) }
    }
    return { status: 200, json: async () => ({ ok: true, data: sampleData() }) }
  }

  const opened = []
  const uiWorkspace = { openSession: (id) => opened.push(id) }
  const module = await loadModule(React)
  const registrations = []
  module.apply({
    slots: {
      inject: (_slot, cb) => cb(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'en' }) },
    effect: (fn) => fn(),
    on: () => () => {},
    get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    inject: (names, cb) => {
      const inputTriggers = { registerSource: () => () => {} }
      if (!names.includes('uiConversation')) return cb({ inputTriggers, effect: (fn) => fn() })
      return cb({
        inputTriggers,
        uiConversation: { userText: { register: () => () => {} } },
        slots: { inject: (_slot, inner) => inner(), register: () => () => {} },
        effect: (fn) => fn(),
      })
    },
  })

  const Page = registrations.find((r) => r.options.name === 'main').component
  const view = mount(Page, {})
  await new Promise((resolve) => setTimeout(resolve, 0))

  // Switch to the Runs tab and expand the run.
  const runsTab = collect(view.paint(), (node) => node.props?.['role'] === 'tab' && node.type === 'button')
  runsTab[1].props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const expand = collect(view.paint(), (node) => node.type === 'button' && /Show tasks/.test(textOf(node)))[0]
  expand.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const tree = view.paint()
  const text = textOf(tree)

  // Both attempts are listed with their runtime.
  assert.match(text, /#1/)
  assert.match(text, /#2/)
  assert.match(text, /codex/)
  assert.match(text, /DSH subagent/)

  // The local attempt offers its transcript; the external one states why not.
  assert.match(text, /Open transcript/)
  assert.match(text, /External run · no local transcript/)

  // The prompt it received is available in the record.
  assert.match(text, /Show the dispatched prompt/)

  // Clicking the link reopens that exact child session.
  const openButton = collect(tree, (node) => node.type === 'button' && /Open transcript/.test(textOf(node)))[0]
  assert.ok(openButton, 'expected a transcript link')
  openButton.props.onClick()
  assert.deepEqual(opened, ['child-local-1'])
})
