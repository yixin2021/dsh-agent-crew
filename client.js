/**
 * Agent Crew — Client half.
 *
 * One surface: the **Agent crew** row in the left navigation
 * (`sidebar.panellist`), whose label is localized, and the management page it
 * opens (`main`, keyed by the same id).
 *
 * The page layout follows the roster-and-detail shape a bot workspace uses:
 * a scrollable specialist list on the left, a sectioned detail pane on the
 * right, a Runs tab with progress and per-task history, and a header that keeps
 * search, refresh, and creation reachable without scrolling.
 *
 * The page never touches the state file: every fact comes from this package's
 * own Host route, so the browser holds no filesystem authority. Starting a crew
 * still happens in a conversation, where a lead Agent exists to delegate to.
 *
 * Three deliberate constraints, all learned from earlier empty-panel failures:
 *   - No `locale` registration option. The injected `t` seat only exists for
 *     namespaces merged into `LocaleNamespaceMap`, which a third-party plugin is
 *     not, so this half binds its own dictionaries.
 *   - No `useSyncExternalStore`. `useState` + `useEffect` work on every React
 *     the shell may ship.
 *   - The Host route path is registered with a leading slash and requested as a
 *     relative reference; `connection.fetch` matches the exact pathname.
 *
 * @module @local/dsh-agent-crew/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-crew',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The one id that ties the navigation row to the panel it opens. */
    const PANEL_ID = 'agent-crew'

    /** Authenticated Host route, relative to the page origin. */
    const ROUTE = 'api/agent-crew'

    /** @type {Record<string, string>} */
    const EN = {
      title: 'Agent crew',
      subtitle: '{profiles} specialists · {runs} runs',
      subtitleLoading: 'Reading agent crew state…',
      tabProfiles: 'Specialists',
      tabRuns: 'Runs',
      search: 'Search specialists',
      searchRuns: 'Search runs',
      actionRefresh: 'Refresh',
      actionRefreshing: 'Refreshing…',
      actionNew: 'New specialist',
      actionEdit: 'Edit',
      actionDelete: 'Delete',
      actionCancel: 'Cancel',
      actionSave: 'Save',
      actionSaving: 'Saving…',
      actionExpand: 'Show tasks',
      actionCollapse: 'Hide tasks',
      actionDeleteRun: 'Delete run',
      actionOpen: 'Open',
      emptyProfiles: 'No specialists yet',
      emptyProfilesBody: 'Create one here, or ask the assistant to define one with crew_agent_create.',
      emptySelection: 'Select a specialist',
      emptySelectionBody: 'Pick a name on the left to read its role, tools, and runs.',
      emptyRuns: 'No runs yet',
      emptyRunsBody: 'Runs appear here after a lead agent executes a task graph in a conversation.',
      emptySearch: 'Nothing matches that search.',
      loading: 'Reading agent crew state…',
      newTitle: 'New specialist',
      editTitle: 'Edit {name}',
      sectionAbout: 'What this specialist does',
      sectionInstructions: 'Standing instructions',
      sectionCapabilities: 'Capabilities',
      sectionTools: 'Tools it may use',
      sectionRoute: 'Model route',
      sectionMemory: 'Memory',
      memoryEmpty: 'Nothing kept yet. The specialist adds a note after each job it handles.',
      sectionRuns: 'Runs with this specialist',
      none: 'None',
      noneYet: 'None yet',
      toolsAll: 'Every session tool except the crew orchestration tools',
      toolsNone: 'No tools — this specialist cannot act',
      toolsMissing: 'Not available in this session: {names}',
      roleLabel: 'Role',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      attemptsLabel: 'Attempts',
      timeoutLabel: 'Timeout',
      sourceLabel: 'Source',
      sourceStore: 'edited here',
      sourceConfig: 'from config',
      unset: '—',
      noRoute: 'Follows the conversation route',
      runProgress: '{completed} of {total} complete',
      runFailedExtra: '{failed} failed · {blocked} blocked',
      runCancelledExtra: '{cancelled} cancelled',
      taskAttempt: 'attempt {attempt}/{max}',
      taskDeps: 'after {names}',
      labelName: 'Name',
      labelId: 'Id',
      labelRole: 'Role',
      labelInstructions: 'Instructions',
      labelCapabilities: 'Capabilities',
      labelTools: 'Tools',
      labelProvider: 'Provider',
      labelModel: 'Model',
      labelAttempts: 'Attempts',
      labelTimeout: 'Timeout (ms)',
      hintTools: 'Comma separated, e.g. read, grep, bash. Use * for every session tool except the crew tools. Memory writing is always allowed.',
      hintId: 'Lower-case letters, digits, and hyphens. Cannot change after saving.',
      hintAttempts: '1–5. Leave empty to inherit the run default.',
      hintTimeout: 'Per-attempt limit. Leave empty for the default (10 minutes); 0 disables it.',
      hintCapabilities: 'Comma separated, shows in the specialist prompt.',
      hintProvider: 'Both or neither. Leave both empty to follow the conversation model.',
      formToolsExample: 'read, grep, bash',
      formSections: 'Basics · Tools · Model route · Limits',
      formNewBlurb: 'A specialist is a reusable role: the lead delegates a task to it and reads its report.',
      confirmProfile: 'Delete {name}? Tasks in existing runs keep their history.',
      confirmRun: 'Delete run {id}? Its record is removed from the history.',
      errorLoad: 'Could not read agent crew state:',
      errorRender: 'This panel failed to render:',
      warningStore: 'The state file could not be read and was replaced; the previous copy was preserved.',
      statusPlanning: 'planning',
      statusReady: 'ready',
      statusRunning: 'running',
      statusCompleted: 'completed',
      statusFailed: 'failed',
      statusCancelled: 'cancelled',
      statusPending: 'pending',
      statusBlocked: 'blocked',
      savingFailed: 'Save failed:',
      deletingFailed: 'Delete failed:',
      errName: 'Enter a name.',
      errInstructions: 'Instructions are limited to 8000 characters.',
      errAttempts: 'Attempts must be 1–5.',
      errTimeout: 'Timeout must be a whole number of milliseconds.',
      errProviderPair: 'Set both provider and model, or neither.',
      unitMs: 'ms',
      unitSec: 's',
      unitMin: 'min',
      mentionGroup: 'Specialists',
      mentionSection: 'Agent crew',
      mentionHint: 'delegate to this specialist',
      mentionMemory: '{count} notes',
      mentionNone: 'No specialist matches',
      labelRuntime: 'Runtime',
      hintRuntime: '`DSH subagent` runs in-process and obeys the tool list plus its own memory. `Codex` runs a native Codex thread with its own sandbox; the tool list and memory do not apply.',
      runtimeSpawn: 'DSH subagent',
      runtimeCodex: 'Codex',
      runtimeSpawnShort: 'in-process',
      runtimeCodexShort: 'codex',
      sectionRuntime: 'Runtime',
      runtimeNoteSpawn: 'In-process DSH child: the tool list below is enforced, and it keeps its own memory across runs.',
      runtimeNoteCodex: 'Native Codex thread: it runs under Codex\'s own sandbox and approvals. The tool list and memory below do not apply — only the role and the task prompt reach it.',
      memoryIndex: 'Index · injected every task',
      memoryTopics: 'Topics · read on demand',
      memoryLog: 'Log · automatic, never injected',
      memoryCapacity: '{used} / {limit} characters of index',
      memoryEmpty: 'Nothing kept yet.',
      attemptOpenSession: 'Open transcript',
      attemptNoSession: 'External run · no local transcript',
      attemptPrompt: 'What it was asked',
      attemptShowPrompt: 'Show the dispatched prompt',
      attemptHidePrompt: 'Hide the prompt',
      attemptResult: 'Reported',
      memoryNone: 'None yet.',
      memoryNoTopics: 'No topics.',
      memoryNoLog: 'No log entries.',
      memoryHint: 'The index enters every task prompt. Topics and the log stay on demand, so history never crowds out what matters.',
      actionClearMemory: 'Clear memory',
      confirmClearMemory: 'Clear all {count} memory entries for {name}?',
      formGroupBasics: 'Basics',
      formGroupWork: 'How it works',
      formGroupLimits: 'Limits',
      labelCodexProvider: 'Codex provider',
      hintCodexProvider: 'A Codex thread takes its model from the provider row, not from a task. Leave empty to use the default `codex` row.',
      codexProviderReady: 'Registered · model {model}',
      codexProviderNoModel: 'Registered · native default model',
      codexProviderMissing: 'Not registered — the task will refuse to run',
      codexProviderHelp: 'To use another model, add a row to the profile patch:',
      codexToolsNote: 'A Codex thread runs with its own sandbox and tool policy; the tool list does not apply.',
      advanced: 'Advanced',
    }

    /** @type {Record<string, string>} */
    const ZH = {
      title: '智能体团队',
      subtitle: '{profiles} 个专家 · {runs} 个运行',
      subtitleLoading: '正在读取智能体团队状态…',
      tabProfiles: '专家',
      tabRuns: '运行',
      search: '搜索专家',
      searchRuns: '搜索运行',
      actionRefresh: '刷新',
      actionRefreshing: '刷新中…',
      actionNew: '新建专家',
      actionEdit: '编辑',
      actionDelete: '删除',
      actionCancel: '取消',
      actionSave: '保存',
      actionSaving: '保存中…',
      actionExpand: '查看任务',
      actionCollapse: '收起任务',
      actionDeleteRun: '删除运行',
      actionOpen: '查看',
      emptyProfiles: '还没有专家',
      emptyProfilesBody: '在这里新建，或让助手用 crew_agent_create 定义。',
      emptySelection: '选择一个专家',
      emptySelectionBody: '在左侧点一个名字，查看它的角色、可用工具与运行记录。',
      emptyRuns: '还没有运行记录',
      emptyRunsBody: '主协作人在对话里执行任务图后，运行会出现在这里。',
      emptySearch: '没有匹配的结果。',
      loading: '正在读取智能体团队状态…',
      newTitle: '新建专家',
      editTitle: '编辑 {name}',
      sectionAbout: '这个专家做什么',
      sectionInstructions: '常驻指令',
      sectionCapabilities: '能力',
      sectionTools: '可用工具',
      sectionRoute: '模型路由',
      sectionMemory: '记忆',
      memoryEmpty: '还没有保留任何记录。专家每完成一次任务会写入一条。',
      sectionRuns: '与这个专家相关的运行',
      none: '无',
      noneYet: '还没有',
      toolsAll: '除 crew 编排工具外的全部会话工具',
      toolsNone: '没有工具，无法执行操作',
      toolsMissing: '本次会话中不存在：{names}',
      roleLabel: '角色',
      providerLabel: 'Provider',
      modelLabel: '模型',
      attemptsLabel: '尝试次数',
      timeoutLabel: '单次时限',
      sourceLabel: '来源',
      sourceStore: '在此编辑',
      sourceConfig: '来自配置',
      unset: '—',
      noRoute: '跟随会话路由',
      runProgress: '已完成 {completed}/{total}',
      runFailedExtra: '{failed} 失败 · {blocked} 阻塞',
      runCancelledExtra: '{cancelled} 已取消',
      taskAttempt: '第 {attempt}/{max} 次',
      taskDeps: '依赖 {names}',
      labelName: '名称',
      labelId: '标识',
      labelRole: '角色',
      labelInstructions: '指令',
      labelCapabilities: '能力',
      labelTools: '可用工具',
      labelProvider: 'Provider',
      labelModel: '模型',
      labelAttempts: '尝试次数',
      labelTimeout: '单次时限（毫秒）',
      hintTools: '逗号分隔，例如 read, grep, bash。用 * 表示除 crew 编排工具外的全部会话工具。写记忆始终允许。',
      hintId: '小写字母、数字和连字符，保存后不可修改。',
      hintAttempts: '1–5，留空则继承运行默认值。',
      hintTimeout: '单次尝试上限。留空用默认（10 分钟）；0 表示不限制。',
      hintCapabilities: '逗号分隔，会出现在专家提示词里。',
      hintProvider: '两项要么都填，要么都留空。都留空则跟随当前会话模型。',
      formToolsExample: 'read, grep, bash',
      formSections: '基本信息 · 工具 · 模型路由 · 限制',
      formNewBlurb: '专家是可复用的角色：主协作人把任务委派给它，再读它的报告。',
      confirmProfile: '删除{name}？已有运行中的任务会保留历史。',
      confirmRun: '删除运行 {id}？该记录会从历史中移除。',
      errorLoad: '读取智能体团队状态失败：',
      errorRender: '这个面板渲染失败：',
      warningStore: '状态文件无法读取，已重建；原文件已备份保留。',
      statusPlanning: '规划中',
      statusReady: '待运行',
      statusRunning: '运行中',
      statusCompleted: '已完成',
      statusFailed: '失败',
      statusCancelled: '已取消',
      statusPending: '等待',
      statusBlocked: '阻塞',
      savingFailed: '保存失败：',
      deletingFailed: '删除失败：',
      errName: '请填写名称。',
      errInstructions: '指令最多 8000 字符。',
      errAttempts: '尝试次数必须是 1–5。',
      errTimeout: '时限必须是整数毫秒。',
      errProviderPair: 'Provider 与模型必须同时填写，或同时留空。',
      unitMs: '毫秒',
      unitSec: '秒',
      unitMin: '分钟',
      mentionGroup: '专家',
      mentionSection: '智能体团队',
      mentionHint: '委派给这个专家',
      mentionMemory: '{count} 条记忆',
      mentionNone: '没有匹配的专家',
      labelRuntime: '运行后端',
      hintRuntime: '「DSH 子智能体」在进程内运行，遵守下方工具列表，并有自己的记忆；「Codex」运行原生 Codex 线程，用它自己的沙箱与授权，下方工具列表与记忆不生效。',
      runtimeSpawn: 'DSH 子智能体',
      runtimeCodex: 'Codex',
      runtimeSpawnShort: '进程内',
      runtimeCodexShort: 'codex',
      sectionRuntime: '运行后端',
      runtimeNoteSpawn: '进程内 DSH 子智能体：下方工具列表会被强制，而且它跨运行保留自己的记忆。',
      runtimeNoteCodex: '原生 Codex 线程：使用 Codex 自己的沙箱与授权。下方工具列表与记忆不生效——只有角色与任务提示词会传给它。',
      memoryIndex: '索引 · 每次任务都注入',
      memoryTopics: '专题 · 按需读取',
      memoryLog: '日志 · 自动记录，从不注入',
      memoryCapacity: '索引已用 {used} / {limit} 字符',
      memoryEmpty: '还没有保留任何内容。',
      attemptOpenSession: '查看会话',
      attemptNoSession: '外部运行 · 无本地会话记录',
      attemptPrompt: '收到的任务',
      attemptShowPrompt: '展开下发的提示词',
      attemptHidePrompt: '收起提示词',
      attemptResult: '汇报',
      memoryNone: '暂无。',
      memoryNoTopics: '暂无专题。',
      memoryNoLog: '暂无日志。',
      memoryHint: '索引会进入每次任务的提示词；专题与日志按需读取，所以历史不会挤占真正重要的内容。',
      actionClearMemory: '清空记忆',
      confirmClearMemory: '清空 {name} 的全部 {count} 条记忆？',
      formGroupBasics: '基本信息',
      formGroupWork: '工作方式',
      formGroupLimits: '限制',
      labelCodexProvider: 'Codex 提供方',
      hintCodexProvider: 'Codex 线程的模型取自提供方那一行，不能按任务覆盖。留空则使用默认的 `codex` 行。',
      codexProviderReady: '已注册 · 模型 {model}',
      codexProviderNoModel: '已注册 · 使用 Codex 原生默认模型',
      codexProviderMissing: '未注册 —— 任务会拒绝执行',
      codexProviderHelp: '要换模型，在 profile 的 patch 里加一行：',
      codexToolsNote: 'Codex 线程用它自己的沙箱与工具策略运行，下方工具列表不生效。',
      advanced: '高级',
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template
     * @param {Record<string, unknown>} [params]
     * @returns {string}
     */
    function fill(template, params) {
      const text = typeof template === 'string' ? template : ''
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
      )
    }

    /**
     * Read the active locale id from the Client locale service.
     *
     * The published `LocaleSnapshot` carries the id on `active`; older or
     * partial shapes may expose `id`, so both are accepted. Reading the wrong
     * field silently falls back to English for the whole panel, which is why
     * this is a named function with its own test.
     * @param {any} locale Client locale service.
     * @returns {string} the active locale id, or an empty string when unknown.
     */
    function activeLocaleId(locale) {
      try {
        const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.()
        if (typeof snapshot?.active === 'string') return snapshot.active
        if (typeof snapshot?.id === 'string') return snapshot.id
        return ''
      } catch {
        return ''
      }
    }

    /**
     * Pick the dictionary for the active locale.
     * @param {any} locale Client locale service.
     * @returns {Record<string, string>}
     */
    function dictionaryFor(locale) {
      const id = activeLocaleId(locale)
      return id.toLowerCase().startsWith('zh') ? ZH : EN
    }

    /** A locale-change counter, so the page repaints with the other dictionary. */
    function createLocaleTick() {
      let value = 0
      const listeners = new Set()
      return {
        current: () => value,
        bump: () => {
          value += 1
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * Resolve the route against the page base, keeping any deployment prefix.
     * @returns {string}
     */
    function routeUrl() {
      const base = typeof document === 'undefined' ? undefined : document.baseURI
      if (typeof base !== 'string' || base.length === 0) return `/${ROUTE}`
      try {
        const url = new URL(base)
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(ROUTE, url.href).href
      } catch {
        return `/${ROUTE}`
      }
    }

    /**
     * Call the Host route; never throws.
     * @param {Record<string, unknown>} body
     * @returns {Promise<{ ok: boolean, data?: any, error?: { code: string, message: string } }>}
     */
    async function callHost(body) {
      let response
      try {
        response = await fetch(routeUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: { code: 'NETWORK', message: String(error) } }
      }
      let decoded
      try {
        decoded = await response.json()
      } catch {
        decoded = undefined
      }
      if (decoded === null || typeof decoded !== 'object') {
        return { ok: false, error: { code: 'HTTP', message: `HTTP ${response.status} · ${routeUrl()}` } }
      }
      return decoded
    }

    /** Format an ISO stamp for the local zone; unparsable input yields ''. */
    function formatStamp(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Last path segment, for the state directory label. */
    function baseName(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      const parts = value.split(/[/\\]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : value
    }

    /** Split a comma-separated field into trimmed entries. */
    function splitList(value) {
      return String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }

    /** Capitalize the first letter, so `failed` maps to `statusFailed`. */
    function cap(value) {
      const text = String(value ?? '')
      return text.length ? text[0].toUpperCase() + text.slice(1) : ''
    }

    /** Initials for the avatar: first letters of up to two words. */
    function initials(name, id) {
      const source = String(name || id || '?').trim()
      const words = source.split(/[\s_-]+/).filter(Boolean)
      if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
      return source.slice(0, 2).toUpperCase()
    }

    /**
     * A stable hue per identity, so each specialist reads as a distinct person
     * without storing a color.
     * @param {string} seed
     * @returns {number}
     */
    function hueOf(seed) {
      let hash = 0
      const text = String(seed ?? '')
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) % 360
      }
      return hash
    }

    /**
     * Milliseconds as a short localized duration.
     * @param {number} ms
     * @param {(key: string) => string} t Dictionary lookup, so units follow the locale.
     * @returns {string}
     */
    function formatDuration(ms, t) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1000) return `${Math.round(value)} ${t('unitMs')}`
      if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} ${t('unitSec')}`
      return `${Math.round(value / 60_000)} ${t('unitMin')}`
    }

    /**
     * Build the components once per plugin activation.
     * @param {() => string} t
     * @param {{ current: () => number, subscribe: (fn: () => void) => () => void }} tick
     */
    function createUi(t, tick, navigation) {
      /** A throwing child renders one readable line instead of a blank column. */
      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        render() {
          if (this.state.error) {
            return h(
              'div',
              { className: 'dac-page' },
              h('style', null, stylesheet()),
              h('h2', { className: 'dac-title' }, t('title')),
              h(
                'div',
                { className: 'dac-note dac-note-error', role: 'alert' },
                `${t('errorRender')} ${String(this.state.error?.message ?? this.state.error)}`,
              ),
            )
          }
          return this.props.children
        }
      }

      /** Circular initials avatar with a per-identity hue. */
      function Avatar({ name, id, size = 32 }) {
        const hue = hueOf(id || name)
        return h(
          'span',
          {
            className: 'dac-avatar',
            style: {
              width: `${size}px`,
              height: `${size}px`,
              fontSize: `${Math.max(10, Math.round(size * 0.36))}px`,
              background: `hsl(${hue} 62% 52% / 0.16)`,
              color: `hsl(${hue} 58% 38%)`,
            },
            'aria-hidden': 'true',
          },
          initials(name, id),
        )
      }

      /** A status pill; `tone` picks the accent. */
      function Badge({ status, label }) {
        return h('span', { className: `dac-badge dac-badge-${status}` }, label ?? t(`status${cap(status)}`))
      }

      /** A thin progress bar for a run's task counts. */
      function Progress({ counts }) {
        const total = Number(counts?.total) || 0
        const completed = Number(counts?.completed) || 0
        const failed = (Number(counts?.failed) || 0) + (Number(counts?.blocked) || 0)
        const cancelled = Number(counts?.cancelled) || 0
        const open = Math.max(0, total - completed - failed - cancelled)
        const segment = (value, tone) =>
          value > 0
            ? h('span', { className: `dac-bar-seg dac-bar-${tone}`, style: { flexGrow: value } })
            : null
        return h(
          'div',
          { className: 'dac-bar', role: 'img', 'aria-label': fill(t('runProgress'), { completed, total }) },
          total === 0
            ? h('span', { className: 'dac-bar-seg dac-bar-open', style: { flexGrow: 1 } })
            : [segment(completed, 'done'), segment(failed, 'failed'), segment(cancelled, 'cancelled'), segment(open, 'open')],
        )
      }

      /** The management page. */
      function AgentCrewPage() {
        const [snapshot, setSnapshot] = React.useState({ status: 'idle', data: null, error: null })
        const [busy, setBusy] = React.useState(false)
        const [tab, setTab] = React.useState('profiles')
        const [selectedId, setSelectedId] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [confirming, setConfirming] = React.useState(null)
        const [expanded, setExpanded] = React.useState(() => new Set())
        const [formError, setFormError] = React.useState('')
        const [codexRows, setCodexRows] = React.useState({})
        const [query, setQuery] = React.useState('')
        const [, setLocaleVersion] = React.useState(() => tick.current())

        React.useEffect(() => tick.subscribe(() => setLocaleVersion(tick.current())), [])

        /** Read the whole state from the Host route. */
        const load = React.useCallback(async () => {
          setBusy(true)
          setSnapshot((current) => ({ ...current, status: current.data ? 'ready' : 'loading' }))
          // Ask which codex provider instances the Host can actually reach, so
          // the form can state the model instead of guessing it.
          const providers = await callHost({ action: 'codexProviders' })
          if (providers.ok) {
            const map = {}
            for (const row of providers.data?.providers ?? []) map[row.name] = row
            setCodexRows(map)
          }
          const answer = await callHost({ action: 'list', limitRuns: 20 })
          if (answer.ok) {
            setSnapshot({ status: 'ready', data: answer.data, error: null })
          } else {
            setSnapshot((current) => ({
              status: current.data ? 'ready' : 'error',
              data: current.data,
              error: answer.error?.message ?? 'unknown error',
            }))
          }
          setBusy(false)
        }, [])

        React.useEffect(() => {
          void load()
        }, [load])

        // Opening a specialist from the transcript: consume the request once.
        React.useEffect(() => {
          const wanted = navigation?.takeSelection?.()
          if (!wanted) return
          setTab('profiles')
          setSelectedId(wanted)
          setDraft(null)
          setConfirming(null)
        })

        const data = snapshot.data
        const profiles = Array.isArray(data?.profiles) ? data.profiles : []
        const runs = Array.isArray(data?.runs) ? data.runs : []
        const needle = query.trim().toLowerCase()
        const matches = (value) => !needle || String(value ?? '').toLowerCase().includes(needle)
        const shownProfiles = profiles.filter(
          (profile) => matches(profile.name) || matches(profile.id) || matches(profile.role),
        )
        const shownRuns = runs.filter((run) => matches(run.title) || matches(run.id))
        const selected = profiles.find((profile) => profile.id === selectedId) ?? null
        const runsOfSelected = selected
          ? runs.filter((run) => (run.tasks ?? []).some((task) => task.profileId === selected.id))
          : []

        /** Persist the draft, then reload. */
        async function saveDraft() {
          if (!draft) return
          const name = String(draft.name ?? '').trim()
          if (!name) {
            setFormError(t('errName'))
            return
          }
          if (String(draft.instructions ?? '').length > 8000) {
            setFormError(t('errInstructions'))
            return
          }
          const attempts = draft.maxAttempts === '' ? undefined : Number(draft.maxAttempts)
          if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 5)) {
            setFormError(t('errAttempts'))
            return
          }
          const timeout = draft.timeoutMs === '' ? undefined : Number(draft.timeoutMs)
          if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0)) {
            setFormError(t('errTimeout'))
            return
          }
          const isCodexDraft = (draft.runtime ?? 'spawn') === 'codex'
          const provider = isCodexDraft ? '' : String(draft.provider ?? '').trim()
          const model = isCodexDraft ? '' : String(draft.model ?? '').trim()
          if ((provider && !model) || (!provider && model)) {
            setFormError(t('errProviderPair'))
            return
          }
          setFormError('')
          setBusy(true)
          const answer = await callHost({
            action: 'saveProfile',
            profile: {
              ...(draft.id ? { id: draft.id } : {}),
              name,
              role: String(draft.role ?? '').trim(),
              instructions: String(draft.instructions ?? '').trim(),
              capabilities: splitList(draft.capabilities),
              tools: splitList(draft.tools),
              runtime: draft.runtime || 'spawn',
              ...(isCodexDraft && String(draft.codexProvider ?? '').trim()
                ? { codexProvider: String(draft.codexProvider).trim() }
                : {}),
              ...(provider ? { provider, model } : {}),
              ...(attempts === undefined ? {} : { maxAttempts: attempts }),
              ...(timeout === undefined ? {} : { timeoutMs: timeout }),
            },
          })
          setBusy(false)
          if (!answer.ok) {
            setFormError(`${t('savingFailed')} ${answer.error?.message ?? ''}`)
            return
          }
          setDraft(null)
          setSelectedId(answer.data?.profile?.id ?? draft.id ?? null)
          await load()
        }

        /** Delete one profile. */
        async function deleteProfile(id) {
          setBusy(true)
          const answer = await callHost({ action: 'deleteProfile', id })
          setBusy(false)
          setConfirming(null)
          if (!answer.ok) {
            setSnapshot((current) => ({ ...current, error: `${t('deletingFailed')} ${answer.error?.message ?? ''}` }))
            return
          }
          setSelectedId(null)
          await load()
        }

        /** Empty one specialist's memory. */
        async function clearMemory(id) {
          setBusy(true)
          const answer = await callHost({ action: 'memoryClear', id })
          setBusy(false)
          setConfirming(null)
          if (!answer.ok) {
            setSnapshot((current) => ({ ...current, error: `${t('deletingFailed')} ${answer.error?.message ?? ''}` }))
            return
          }
          await load()
        }

        /** Delete one settled run record. */
        async function deleteRun(id) {
          setBusy(true)
          const answer = await callHost({ action: 'deleteRun', id })
          setBusy(false)
          setConfirming(null)
          if (!answer.ok) {
            setSnapshot((current) => ({ ...current, error: `${t('deletingFailed')} ${answer.error?.message ?? ''}` }))
            return
          }
          await load()
        }

        /** Toggle one run's task list. */
        function toggleRun(id) {
          setExpanded((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }

        /** Start a new draft, or edit an existing profile. */
        function startEdit(profile) {
          setFormError('')
          setConfirming(null)
          setTab('profiles')
          setDraft(
            profile
              ? {
                  id: profile.id,
                  name: profile.name ?? '',
                  role: profile.role ?? '',
                  instructions: profile.instructions ?? '',
                  capabilities: (profile.capabilities ?? []).join(', '),
                  tools: (profile.tools ?? []).join(', '),
                  provider: profile.provider ?? '',
                  model: profile.model ?? '',
                  maxAttempts: profile.maxAttempts ?? '',
                  timeoutMs: profile.timeoutMs ?? '',
                  runtime: profile.runtime ?? 'spawn',
                  codexProvider: profile.codexProvider ?? '',
                  editing: true,
                }
              : {
                  id: '',
                  name: '',
                  role: '',
                  instructions: '',
                  capabilities: '',
                  tools: '*',
                  provider: '',
                  model: '',
                  maxAttempts: '',
                  timeoutMs: '',
                  runtime: 'spawn',
                  codexProvider: '',
                  editing: false,
                },
          )
        }

        // ---------------------------------------------------------------- shell

        return h(
          'div',
          { className: 'dac-page' },
          h('style', null, stylesheet()),
          h(
            'header',
            { className: 'dac-header' },
            h(
              'div',
              { className: 'dac-headerText' },
              h('h2', { className: 'dac-title' }, t('title')),
              h(
                'p',
                { className: 'dac-subtitle' },
                snapshot.status === 'ready'
                  ? fill(t('subtitle'), { profiles: profiles.length, runs: runs.length })
                  : t('subtitleLoading'),
                data?.dir ? h('span', { className: 'dac-dir', title: data.dir }, ` · ${baseName(data.dir)}`) : null,
              ),
            ),
            h(
              'div',
              { className: 'dac-headerActions' },
              h('input', {
                className: 'dac-search',
                type: 'search',
                value: query,
                placeholder: tab === 'runs' ? t('searchRuns') : t('search'),
                'aria-label': tab === 'runs' ? t('searchRuns') : t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
              h(
                'button',
                { type: 'button', className: 'dac-btn', onClick: () => void load(), disabled: busy },
                busy ? t('actionRefreshing') : t('actionRefresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dac-btn dac-btn-primary',
                  onClick: () => startEdit(null),
                  disabled: busy || draft !== null,
                },
                t('actionNew'),
              ),
            ),
          ),
          h(
            'nav',
            { className: 'dac-tabs', role: 'tablist' },
            tabButton('profiles', fill(t('tabProfiles'), {}), profiles.length),
            tabButton('runs', t('tabRuns'), runs.length),
          ),
          data?.warning ? h('div', { className: 'dac-note dac-note-warn', role: 'status' }, t('warningStore')) : null,
          snapshot.error
            ? h('div', { className: 'dac-note dac-note-error', role: 'alert' }, `${t('errorLoad')} ${snapshot.error}`)
            : null,
          tab === 'profiles' ? renderProfilesTab() : renderRunsTab(),
        )

        /** One tab control. */
        function tabButton(id, label, count) {
          return h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': tab === id,
              className: `dac-tab${tab === id ? ' dac-tab-on' : ''}`,
              onClick: () => setTab(id),
            },
            label,
            h('span', { className: 'dac-tabCount' }, String(count)),
          )
        }

        // ------------------------------------------------------------- profiles

        function renderProfilesTab() {
          if (draft) return h('div', { className: 'dac-pane dac-pane-single' }, renderForm())
          return h(
            'div',
            { className: 'dac-pane' },
            h(
              'aside',
              { className: 'dac-list', 'aria-label': t('tabProfiles') },
              profiles.length === 0
                ? emptyCard(t('emptyProfiles'), t('emptyProfilesBody'))
                : shownProfiles.length === 0
                  ? h('div', { className: 'dac-note' }, t('emptySearch'))
                  : shownProfiles.map(renderListItem),
            ),
            h('section', { className: 'dac-detail' }, renderDetail()),
          )
        }

        /** One row in the specialist list. */
        function renderListItem(profile) {
          const tools = Array.isArray(profile.tools) ? profile.tools : []
          const on = profile.id === selectedId
          return h(
            'button',
            {
              type: 'button',
              className: `dac-item${on ? ' dac-item-on' : ''}`,
              'aria-current': on ? 'true' : undefined,
              onClick: () => {
                setSelectedId(profile.id)
                setConfirming(null)
              },
            },
            h(Avatar, { name: profile.name, id: profile.id, size: 30 }),
            h(
              'span',
              { className: 'dac-itemText' },
              h(
                'span',
                { className: 'dac-itemName' },
                profile.name,
                profile.source === 'config' ? h('span', { className: 'dac-dotConfig', title: t('sourceConfig') }) : null,
              ),
              h('span', { className: 'dac-itemRole' }, profile.role || t('unset')),
              h(
                'span',
                { className: 'dac-itemMeta' },
                tools.includes('*') ? t('toolsAll') : tools.length ? tools.join(', ') : t('none'),
              ),
            ),
          )
        }

        /** The right-hand detail pane. */
        function renderDetail() {
          if (profiles.length === 0) return emptyCard(t('emptyProfiles'), t('emptyProfilesBody'), true)
          if (!selected) return emptyCard(t('emptySelection'), t('emptySelectionBody'), true)
          const tools = Array.isArray(selected.tools) ? selected.tools : []
          const capabilities = Array.isArray(selected.capabilities) ? selected.capabilities : []
          const pendingDelete = confirming?.kind === 'profile' && confirming.id === selected.id
          return h(
            'article',
            { className: 'dac-card dac-detailCard' },
            h(
              'div',
              { className: 'dac-detailHead' },
              h(Avatar, { name: selected.name, id: selected.id, size: 44 }),
              h(
                'div',
                { className: 'dac-detailTitle' },
                h('h3', { className: 'dac-detailName' }, selected.name),
                h(
                  'div',
                  { className: 'dac-detailMeta' },
                  h('code', { className: 'dac-id' }, selected.id),
                  h('span', { className: 'dac-chip' }, t(selected.source === 'config' ? 'sourceConfig' : 'sourceStore')),
                ),
              ),
              h(
                'div',
                { className: 'dac-detailActions' },
                pendingDelete
                  ? h(
                      'span',
                      { className: 'dac-confirm' },
                      h('span', null, fill(t('confirmProfile'), { name: selected.name })),
                      h(
                        'button',
                        { type: 'button', className: 'dac-btn', onClick: () => setConfirming(null), disabled: busy },
                        t('actionCancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-danger',
                          onClick: () => void deleteProfile(selected.id),
                          disabled: busy,
                        },
                        t('actionDelete'),
                      ),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn',
                          onClick: () => startEdit(selected),
                          disabled: busy,
                        },
                        t('actionEdit'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-dangerText',
                          onClick: () => setConfirming({ kind: 'profile', id: selected.id }),
                          disabled: busy,
                        },
                        t('actionDelete'),
                      ),
                    ),
              ),
            ),
            section(t('sectionAbout'), h('p', { className: 'dac-prose' }, selected.role || t('unset'))),
            section(
              t('sectionInstructions'),
              selected.instructions
                ? h('pre', { className: 'dac-pre' }, selected.instructions)
                : h('p', { className: 'dac-muted' }, t('none')),
            ),
            section(
              t('sectionCapabilities'),
              h(
                'div',
                { className: 'dac-chips' },
                ...(capabilities.length
                  ? capabilities.map((item, index) => h('span', { className: 'dac-chip', key: `c${index}` }, item))
                  : [h('span', { className: 'dac-muted' }, t('none'))]),
              ),
            ),
            section(
              t('sectionTools'),
              tools.includes('*')
                ? h('p', { className: 'dac-prose' }, t('toolsAll'))
                : tools.length === 0
                  ? h('p', { className: 'dac-warnText' }, t('toolsNone'))
                  : h(
                      'div',
                      { className: 'dac-chips' },
                      ...tools.map((tool) =>
                        h('span', { className: 'dac-chip dac-chip-mono', key: tool }, tool),
                      ),
                    ),
            ),
            section(
              t('sectionRuntime'),
              h(
                'div',
                { className: 'dac-runtime' },
                h(
                  'span',
                  { className: `dac-runtimeChip dac-runtime-${selected.runtime ?? 'spawn'}` },
                  (selected.runtime ?? 'spawn') === 'codex' ? t('runtimeCodex') : t('runtimeSpawn'),
                ),
                h(
                  'p',
                  { className: 'dac-muted' },
                  (selected.runtime ?? 'spawn') === 'codex' ? t('runtimeNoteCodex') : t('runtimeNoteSpawn'),
                ),
              ),
            ),
            section(
              t('sectionRoute'),
              h(
                'dl',
                { className: 'dac-facts' },
                fact(t('providerLabel'), selected.provider || t('noRoute')),
                fact(t('modelLabel'), selected.model || t('unset')),
                fact(t('attemptsLabel'), selected.maxAttempts == null ? t('unset') : String(selected.maxAttempts)),
                fact(
                  t('timeoutLabel'),
                  selected.timeoutMs == null ? t('unset') : formatDuration(selected.timeoutMs, t),
                ),
              ),
            ),
            section(t('sectionMemory'), renderMemory()),
            section(
              t('sectionRuns'),
              runsOfSelected.length === 0
                ? h('p', { className: 'dac-muted' }, t('noneYet'))
                : h('ul', { className: 'dac-miniRuns' }, ...runsOfSelected.map(renderMiniRun)),
            ),
          )
        }

        /** The three memory tiers, each with its own placement rule. */
        function renderMemory() {
          const memory = Array.isArray(selected.memory) ? selected.memory : []
          const index = memory.filter((entry) => entry.kind === 'note' || entry.kind === 'lesson')
          const topics = memory.filter((entry) => entry.kind === 'topic')
          const log = memory.filter((entry) => entry.kind === 'run')
          const used = index.reduce((sum, entry) => sum + entry.text.length, 0)
          const clearing = confirming?.kind === 'memory' && confirming.id === selected.id
          const tier = (title, body, count) =>
            h(
              'div',
              { className: 'dac-tier' },
              h(
                'div',
                { className: 'dac-tierHead' },
                h('span', { className: 'dac-tierTitle' }, title),
                h('span', { className: 'dac-tierCount' }, String(count)),
              ),
              body,
            )
          const rows = (entries, empty, limit) =>
            entries.length === 0
              ? h('p', { className: 'dac-muted' }, empty)
              : h(
                  'ul',
                  { className: 'dac-tierList' },
                  ...entries
                    .slice(-limit)
                    .reverse()
                    .map((entry) =>
                      h(
                        'li',
                        { className: 'dac-tierRow', key: entry.id },
                        h('span', { className: `dac-kindDot dac-kind-${entry.kind}`, 'aria-hidden': 'true' }),
                        h('span', { className: 'dac-tierText' }, entry.title ? `${entry.title} — ${entry.text}` : entry.text),
                        h('span', { className: 'dac-tierTime' }, formatStamp(entry.ts)),
                      ),
                    ),
                )
          return h(
            'div',
            { className: 'dac-memory' },
            h('p', { className: 'dac-muted' }, t('memoryHint')),
            h(
              'p',
              { className: 'dac-capacity' },
              fill(t('memoryCapacity'), { used, limit: 2400 }),
            ),
            tier(t('memoryIndex'), rows(index, t('memoryEmpty'), 12), index.length),
            tier(t('memoryTopics'), rows(topics, t('memoryNoTopics'), 6), topics.length),
            tier(t('memoryLog'), rows(log, t('memoryNoLog'), 6), log.length),
            memory.length > 0
              ? h(
                  'div',
                  { className: 'dac-memoryActions' },
                  clearing
                    ? h(
                        'span',
                        { className: 'dac-confirm' },
                        h('span', null, fill(t('confirmClearMemory'), { count: memory.length, name: selected.name })),
                        h(
                          'button',
                          { type: 'button', className: 'dac-btn', onClick: () => setConfirming(null), disabled: busy },
                          t('actionCancel'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dac-btn dac-btn-danger',
                            onClick: () => void clearMemory(selected.id),
                            disabled: busy,
                          },
                          t('actionClearMemory'),
                        ),
                      )
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-ghost dac-btn-dangerText',
                          onClick: () => setConfirming({ kind: 'memory', id: selected.id }),
                          disabled: busy,
                        },
                        t('actionClearMemory'),
                      ),
                )
              : null,
          )
        }

        /** One run row inside the detail pane. */
        function renderMiniRun(run) {
          return h(
            'li',
            { className: 'dac-miniRun', key: run.id },
            h('div', { className: 'dac-miniRunTop' }, h('span', { className: 'dac-miniRunTitle' }, run.title || run.id)),
            h(
              'div',
              { className: 'dac-miniRunMeta' },
              h(Badge, { status: run.status }),
              h(
                'span',
                null,
                fill(t('runProgress'), {
                  completed: run.counts?.completed ?? 0,
                  total: run.counts?.total ?? (run.tasks ?? []).length,
                }),
              ),
              run.finishedAt ? h('span', { className: 'dac-time' }, formatStamp(run.finishedAt)) : null,
            ),
          )
        }

        /** One label/value row. */
        function fact(label, value) {
          return h(
            'div',
            { className: 'dac-fact' },
            h('dt', null, label),
            h('dd', null, value),
          )
        }

        /** A titled block. */
        function section(title, body) {
          return h(
            'section',
            { className: 'dac-section' },
            h('h4', { className: 'dac-sectionTitle' }, title),
            body,
          )
        }

        /** The empty-state card. */
        function emptyCard(title, body, fill_) {
          return h(
            'div',
            { className: `dac-empty${fill_ ? ' dac-empty-fill' : ''}` },
            h('div', { className: 'dac-emptyTitle' }, title),
            h('div', { className: 'dac-emptyBody' }, body),
          )
        }

        // ----------------------------------------------------------------- form

        /**
         * What the Host says about the named codex provider: whether it is
         * registered, and which model its instance carries.
         *
         * A Codex thread reads its model from the provider row at start time,
         * so this line is the only truthful place to learn it.
         *
         * @returns {any} one status line, or null while the name is empty
         */
        function codexStatus() {
          const name = String(draft?.codexProvider ?? '').trim()
          if (!name) return null
          const row = codexRows[name]
          if (row === undefined || !row.ready) {
            return h(
              'p',
              { className: 'dac-fieldNote dac-warnText dac-field-wide', key: 'codexStatus' },
              t('codexProviderMissing'),
            )
          }
          return h(
            'p',
            { className: 'dac-fieldNote dac-field-wide', key: 'codexStatus' },
            row.model ? fill(t('codexProviderReady'), { model: row.model }) : t('codexProviderNoModel'),
          )
        }

        function renderForm() {
          const title = draft.editing ? fill(t('editTitle'), { name: draft.name || draft.id }) : t('newTitle')
          const field = (key, label, options = {}) => {
            const control = options.select
              ? h(
                  'select',
                  {
                    className: 'dac-input dac-select',
                    value: draft[key],
                    onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
                  },
                  ...options.select.map((choice) =>
                    h('option', { value: choice.value, key: choice.value }, choice.label),
                  ),
                )
              : options.textarea
                ? h('textarea', {
                    className: 'dac-input dac-textarea',
                    value: draft[key],
                    rows: 5,
                    onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
                  })
                : h('input', {
                    className: 'dac-input',
                    value: draft[key],
                    inputMode: options.numeric ? 'numeric' : undefined,
                    disabled: options.disabled === true,
                    onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
                  })
            return h(
              'label',
              { className: `dac-field${options.wide ? ' dac-field-wide' : ''}`, key },
              h('span', { className: 'dac-label' }, label),
              control,
              options.hint ? h('span', { className: 'dac-hint' }, options.hint) : null,
            )
          }
          const isCodex = (draft.runtime ?? 'spawn') === 'codex'
          const group = (heading, ...children) =>
            h(
              'section',
              { className: 'dac-formGroup' },
              h('h4', { className: 'dac-formGroupTitle' }, heading),
              h('div', { className: 'dac-grid' }, ...children),
            )
          return h(
            'article',
            { className: 'dac-card dac-form', 'aria-label': title },
            h(
              'div',
              { className: 'dac-detailHead' },
              h(Avatar, { name: draft.name || '?', id: draft.id || draft.name, size: 44 }),
              h(
                'div',
                { className: 'dac-detailTitle' },
                h('h3', { className: 'dac-detailName' }, title),
                h('p', { className: 'dac-muted' }, t('formNewBlurb')),
              ),
            ),
            // Grouped so the form reads in three short blocks instead of one
            // long column, and so a runtime shows only the settings it uses.
            group(
              t('formGroupBasics'),
              field('name', t('labelName')),
              field('id', t('labelId'), { disabled: draft.editing, hint: t('hintId') }),
              field('role', t('labelRole')),
              field('runtime', t('labelRuntime'), {
                select: [
                  { value: 'spawn', label: t('runtimeSpawn') },
                  { value: 'codex', label: t('runtimeCodex') },
                ],
              }),
            ),
            group(
              t('formGroupWork'),
              field('instructions', t('labelInstructions'), { textarea: true, wide: true }),
              field('capabilities', t('labelCapabilities'), { hint: t('hintCapabilities') }),
              ...(isCodex
                ? [
                    field('codexProvider', t('labelCodexProvider'), { hint: t('hintCodexProvider') }),
                    codexStatus(),
                    h('p', { className: 'dac-fieldNote dac-field-wide', key: 'codexTools' }, t('codexToolsNote')),
                  ]
                : [
                    field('tools', t('labelTools'), { hint: t('hintTools') }),
                    field('provider', t('labelProvider'), { hint: t('hintProvider') }),
                    field('model', t('labelModel')),
                  ]),
            ),
            group(
              t('formGroupLimits'),
              field('maxAttempts', t('labelAttempts'), { numeric: true, hint: t('hintAttempts') }),
              field('timeoutMs', t('labelTimeout'), { numeric: true, hint: t('hintTimeout') }),
            ),
            formError ? h('p', { className: 'dac-note dac-note-error', role: 'alert' }, formError) : null,
            h(
              'div',
              { className: 'dac-formActions' },
              h(
                'button',
                { type: 'button', className: 'dac-btn', onClick: () => setDraft(null), disabled: busy },
                t('actionCancel'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dac-btn dac-btn-primary',
                  onClick: () => void saveDraft(),
                  disabled: busy,
                },
                busy ? t('actionSaving') : t('actionSave'),
              ),
            ),
          )
        }

        // ----------------------------------------------------------------- runs

        function renderRunsTab() {
          if (runs.length === 0) {
            return h('div', { className: 'dac-pane dac-pane-single' }, emptyCard(t('emptyRuns'), t('emptyRunsBody'), true))
          }
          if (shownRuns.length === 0) {
            return h('div', { className: 'dac-pane dac-pane-single' }, h('div', { className: 'dac-note' }, t('emptySearch')))
          }
          return h(
            'div',
            { className: 'dac-pane dac-pane-single dac-runs' },
            ...shownRuns.map(renderRun),
          )
        }

        /** One run card with its progress and tasks. */
        function renderRun(run) {
          const counts = run.counts ?? {}
          const tasks = Array.isArray(run.tasks) ? run.tasks : []
          const open = expanded.has(run.id)
          const pendingDelete = confirming?.kind === 'run' && confirming.id === run.id
          const settled = run.status !== 'running'
          const extra = []
          if ((counts.failed ?? 0) + (counts.blocked ?? 0) > 0) {
            extra.push(fill(t('runFailedExtra'), { failed: counts.failed ?? 0, blocked: counts.blocked ?? 0 }))
          }
          if ((counts.cancelled ?? 0) > 0) extra.push(fill(t('runCancelledExtra'), { cancelled: counts.cancelled }))
          return h(
            'article',
            { className: 'dac-card dac-runCard', key: run.id },
            h(
              'div',
              { className: 'dac-runHead' },
              h(
                'div',
                { className: 'dac-runTitle' },
                h('span', { className: 'dac-name' }, run.title || run.id),
                h(Badge, { status: run.status }),
              ),
              h(
                'div',
                { className: 'dac-runActions' },
                tasks.length > 0
                  ? h(
                      'button',
                      { type: 'button', className: 'dac-btn dac-btn-ghost', onClick: () => toggleRun(run.id) },
                      open ? t('actionCollapse') : t('actionExpand'),
                    )
                  : null,
                pendingDelete
                  ? h(
                      'span',
                      { className: 'dac-confirm' },
                      h('span', null, fill(t('confirmRun'), { id: run.id })),
                      h(
                        'button',
                        { type: 'button', className: 'dac-btn', onClick: () => setConfirming(null), disabled: busy },
                        t('actionCancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-danger',
                          onClick: () => void deleteRun(run.id),
                          disabled: busy,
                        },
                        t('actionDelete'),
                      ),
                    )
                  : settled
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-ghost dac-btn-dangerText',
                          onClick: () => setConfirming({ kind: 'run', id: run.id }),
                          disabled: busy,
                        },
                        t('actionDeleteRun'),
                      )
                    : null,
              ),
            ),
            h(Progress, { counts }),
            h(
              'div',
              { className: 'dac-runMeta' },
              h(
                'span',
                null,
                fill(t('runProgress'), { completed: counts.completed ?? 0, total: counts.total ?? tasks.length }),
              ),
              ...extra.map((line) => h('span', { className: 'dac-runExtra', key: line }, line)),
              h('code', { className: 'dac-id' }, run.id),
              run.finishedAt ? h('span', { className: 'dac-time' }, formatStamp(run.finishedAt)) : null,
            ),
            open ? renderTasks(tasks) : null,
          )
        }

        /** Task rows inside one run. */
        function renderTasks(tasks) {
          return h(
            'ul',
            { className: 'dac-tasks' },
            ...tasks.map((task) =>
              h(
                'li',
                { className: 'dac-task', key: task.id },
                h(
                  'div',
                  { className: 'dac-taskHead' },
                  h(Badge, { status: task.status }),
                  h('span', { className: 'dac-taskSubject' }, task.subject),
                  h(Avatar, { name: task.profileId, id: task.profileId, size: 20 }),
                  h('code', { className: 'dac-id' }, task.profileId),
                  h(
                    'span',
                    { className: 'dac-taskAttempt' },
                    fill(t('taskAttempt'), { attempt: task.attempt ?? 0, max: task.maxAttempts ?? 1 }),
                  ),
                ),
                (task.dependsOn ?? []).length > 0
                  ? h(
                      'div',
                      { className: 'dac-taskDeps' },
                      fill(t('taskDeps'), { names: task.dependsOn.join(', ') }),
                    )
                  : null,
                task.error
                  ? h('div', { className: 'dac-taskError' }, `${task.error.code}: ${task.error.message}`)
                  : null,
                task.resultPreview
                  ? h('div', { className: 'dac-taskResult' }, task.resultPreview)
                  : null,
                renderAttempts(task),
              ),
            ),
          )
        }

        /**
         * One attempt's record: the runtime, its transcript link or the reason
         * there is none, and the prompt it received.
         */
        function renderAttempts(task) {
          const attempts = Array.isArray(task.attempts) ? task.attempts : []
          if (attempts.length === 0) return null
          return h(
            'ul',
            { className: 'dac-attempts' },
            ...attempts.map((attempt) =>
              h(
                'li',
                { className: 'dac-attempt', key: `a${attempt.attempt}` },
                h(
                  'div',
                  { className: 'dac-attemptHead' },
                  h('span', { className: 'dac-attemptNo' }, `#${attempt.attempt}`),
                  h(
                    'span',
                    { className: `dac-chip dac-chip-mono` },
                    attempt.runtime === 'codex' ? t('runtimeCodex') : t('runtimeSpawn'),
                  ),
                  h('span', { className: 'dac-attemptStop' }, attempt.stopReason ?? ''),
                  attempt.durationMs ? h('span', { className: 'dac-attemptTime' }, formatDuration(attempt.durationMs, t)) : null,
                  attempt.sessionAvailable && attempt.childId
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dac-btn dac-btn-ghost dac-attemptOpen',
                          onClick: () => openTranscript(attempt.childId),
                        },
                        t('attemptOpenSession'),
                      )
                    : h('span', { className: 'dac-attemptNoSession' }, t('attemptNoSession')),
                ),
                attempt.errorCode
                  ? h('div', { className: 'dac-taskError' }, attempt.errorCode)
                  : null,
                attempt.promptPreview
                  ? h(
                      'details',
                      { className: 'dac-attemptPrompt' },
                      h('summary', null, t('attemptShowPrompt')),
                      h('pre', { className: 'dac-pre' }, attempt.promptPreview),
                    )
                  : null,
              ),
            ),
          )
        }

        /** Reopen a local child's DSH session; an external run has none. */
        function openTranscript(sessionId) {
          navigation?.openSession?.(sessionId)
        }
      }

      /** The navigation row's icon. */
      function SidebarIcon(props) {
        const size = props?.size ?? 16
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 36 36',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            d: 'M18 15v3.2M11 26.6v-3.4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3.4',
            stroke: 'currentColor',
            strokeOpacity: 0.55,
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('circle', { cx: 18, cy: 10.5, r: 4.6, fill: 'currentColor' }),
          h('circle', { cx: 7.8, cy: 27.4, r: 3.5, fill: 'currentColor', fillOpacity: 0.55 }),
          h('circle', { cx: 18, cy: 28.6, r: 3.5, fill: 'currentColor', fillOpacity: 0.55 }),
          h('circle', { cx: 28.2, cy: 27.4, r: 3.5, fill: 'currentColor', fillOpacity: 0.55 }),
        )
      }

      return { AgentCrewPage: () => h(PanelBoundary, null, h(AgentCrewPage)), SidebarIcon }
    }

    /**
     * The page stylesheet. Every color is a theme token with a fallback so a
     * renamed token degrades instead of breaking; the page never scrolls and
     * each pane owns its own scroll region.
     * @returns {string}
     */
    function stylesheet() {
      return [
        '.dac-page{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary,currentColor);font-family:inherit;font-size:13px;line-height:20px;padding:20px 24px 18px}',
        '.dac-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
        '.dac-headerText{display:flex;flex-direction:column;gap:3px;min-width:0}',
        '.dac-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.01em}',
        '.dac-subtitle{margin:0;color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:18px}',
        '.dac-dir{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
        '.dac-headerActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dac-search{box-sizing:border-box;height:30px;width:180px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12px}',
        '.dac-search:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dac-tabs{display:flex;align-items:center;gap:4px;border-bottom:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));padding-bottom:0}',
        '.dac-tab{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:0;border-bottom:2px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:13px;cursor:pointer;margin-bottom:-1px}',
        '.dac-tab:hover{color:var(--dsw-alias-label-primary,currentColor)}',
        '.dac-tab-on{color:var(--dsw-alias-label-primary,currentColor);border-bottom-color:var(--dsw-alias-state-business-primary,#4d6bfe);font-weight:600}',
        '.dac-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px;border-radius:6px}',
        '.dac-tabCount{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-variant-numeric:tabular-nums}',
        '.dac-pane{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:14px}',
        '.dac-pane-single{grid-template-columns:minmax(0,1fr)}',
        '.dac-list{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:2px 2px 8px}',
        '.dac-item{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;padding:9px 10px;border:0.5px solid transparent;border-radius:10px;background:0 0;color:inherit;font:inherit;text-align:start;cursor:pointer}',
        '.dac-item:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1)))}',
        '.dac-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}',
        '.dac-item-on{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.28))}',
        '.dac-itemText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
        '.dac-itemName{display:flex;align-items:center;gap:5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dac-dotConfig{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe);flex:none}',
        '.dac-itemRole{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,currentColor);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dac-itemMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dac-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;font-weight:650;letter-spacing:.02em}',
        '.dac-detail{min-height:0;overflow:auto;padding:2px 2px 12px}',
        '.dac-runs{overflow:auto;display:flex;flex-direction:column;gap:10px;padding:2px 2px 12px}',
        '.dac-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}',
        '.dac-detailCard{min-height:100%}',
        '.dac-detailHead{display:flex;align-items:flex-start;gap:12px}',
        '.dac-detailTitle{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}',
        '.dac-detailName{margin:0;font-size:16px;line-height:24px;font-weight:600}',
        '.dac-detailMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dac-detailActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.dac-section{display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24))}',
        '.dac-sectionTitle{margin:0;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-prose{margin:0;overflow-wrap:anywhere}',
        '.dac-pre{margin:0;padding:10px 12px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));font:inherit;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}',
        '.dac-muted{margin:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-size:12px}',
        '.dac-warnText{margin:0;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary,currentColor));font-size:12px}',
        '.dac-chips{display:flex;gap:6px;flex-wrap:wrap}',
        '.dac-chip{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,currentColor);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dac-chip-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dac-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;margin:0}',
        '.dac-fact{display:contents}',
        '.dac-facts dt{color:var(--dsw-alias-label-secondary,currentColor);font-size:12px}',
        '.dac-facts dd{margin:0;font-size:12px;overflow-wrap:anywhere}',
        '.dac-miniRuns{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
        '.dac-miniRun{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}',
        '.dac-miniRunTop{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dac-miniRunTitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dac-miniRunMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-btn{box-sizing:border-box;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dac-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)))}',
        '.dac-btn:disabled{opacity:.5;cursor:default}',
        '.dac-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
        '.dac-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}',
        '.dac-btn-danger{color:var(--dsw-alias-state-error-primary,#d64545);border-color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-btn-dangerText{color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-confirm{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-badge{padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;border:0.5px solid transparent;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14));white-space:nowrap}',
        '.dac-badge-completed{color:var(--dsw-alias-state-success-primary,#1a7f45);border-color:var(--dsw-alias-state-success-primary,#1a7f45)}',
        '.dac-badge-failed,.dac-badge-blocked{color:var(--dsw-alias-state-error-primary,#d64545);border-color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-badge-running{color:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dac-badge-cancelled{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-bar{display:flex;align-items:stretch;gap:2px;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}',
        '.dac-bar-seg{display:block;min-width:3px;border-radius:999px}',
        '.dac-bar-done{background:var(--dsw-alias-state-success-primary,#1a7f45)}',
        '.dac-bar-failed{background:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-bar-cancelled{background:var(--dsw-alias-label-tertiary,#9aa4b2)}',
        '.dac-bar-open{background:var(--dsw-alias-border-l3,rgba(128,128,128,.4))}',
        '.dac-runCard{gap:10px}',
        '.dac-runHead{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
        '.dac-runTitle{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 200px}',
        '.dac-name{font-weight:600;overflow-wrap:anywhere}',
        '.dac-runActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
        '.dac-runMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-runExtra{color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-time{font-variant-numeric:tabular-nums}',
        '.dac-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis;max-width:46%;white-space:nowrap}',
        '.dac-tasks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));padding-top:10px}',
        '.dac-task{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}',
        '.dac-taskHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dac-taskSubject{font-weight:500;overflow-wrap:anywhere}',
        '.dac-taskAttempt{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-variant-numeric:tabular-nums;margin-left:auto}',
        '.dac-taskDeps{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-taskError{font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary,#d64545);overflow-wrap:anywhere}',
        '.dac-taskResult{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor);white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}',
        '.dac-note{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,currentColor);font-size:12px;line-height:18px}',
        '.dac-note-error{color:var(--dsw-alias-state-error-primary,#d64545)}',
        '.dac-note-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-primary,currentColor));border:0.5px solid var(--dsw-alias-state-warn-secondary,currentColor)}',
        '.dac-empty{display:flex;flex-direction:column;gap:4px;padding:20px;align-items:flex-start;border:0.5px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:10px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-empty-fill{margin:auto;max-width:460px;align-items:center;text-align:center}',
        '.dac-emptyTitle{color:var(--dsw-alias-label-primary,currentColor);font-weight:600}',
        '.dac-emptyBody{font-size:12px;max-width:460px}',
        '.dac-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 14px}',
        '.dac-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.dac-field-wide{grid-column:1/-1}',
        '.dac-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-input{box-sizing:border-box;height:30px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:8px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,transparent));color:inherit;font:inherit;font-size:12px;min-width:0}',
        '.dac-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dac-input:disabled{opacity:.6}',
        '.dac-textarea{height:auto;padding:8px 10px;line-height:18px;resize:vertical;font-family:inherit}',
        '.dac-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-formActions{display:flex;justify-content:flex-end;gap:8px}',
        '.dac-select{cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary,currentColor) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary,currentColor) 50%,transparent 50%);background-position:calc(100% - 16px) 13px,calc(100% - 11px) 13px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:30px}',
        '.dac-runtime{display:flex;flex-direction:column;gap:6px}',
        '.dac-runtimeChip{align-self:flex-start;padding:1px 9px;border-radius:999px;font-size:11px;line-height:17px;font-weight:600;border:0.5px solid transparent}',
        '.dac-runtime-spawn{color:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dac-runtime-codex{color:var(--dsw-alias-state-success-primary,#1a7f45);border-color:var(--dsw-alias-state-success-primary,#1a7f45)}',
        '.dac-memory{display:flex;flex-direction:column;gap:10px}',
        '.dac-capacity{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-variant-numeric:tabular-nums}',
        '.dac-tier{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07))}',
        '.dac-tierHead{display:flex;align-items:baseline;gap:8px}',
        '.dac-tierTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-tierCount{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-variant-numeric:tabular-nums}',
        '.dac-tierList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
        '.dac-tierRow{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:18px;min-width:0}',
        '.dac-kindDot{width:6px;height:6px;border-radius:50%;flex:none;align-self:center;background:var(--dsw-alias-label-tertiary,#9aa4b2)}',
        '.dac-kind-note{background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
        '.dac-kind-lesson{background:var(--dsw-alias-state-warn-label,#c47f17)}',
        '.dac-kind-topic{background:var(--dsw-alias-state-success-primary,#1a7f45)}',
        '.dac-tierText{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
        '.dac-tierTime{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));font-variant-numeric:tabular-nums}',
        '.dac-memoryActions{display:flex;justify-content:flex-end}',
        '.dac-attempts{list-style:none;margin:0;padding:6px 0 0;display:flex;flex-direction:column;gap:4px}',
        '.dac-attempt{display:flex;flex-direction:column;gap:3px;padding:5px 8px;border-radius:6px;background:color-mix(in srgb,currentColor 4%,transparent)}',
        '.dac-attemptHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,currentColor)}',
        '.dac-attemptNo{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,currentColor)}',
        '.dac-attemptStop{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dac-attemptTime{font-variant-numeric:tabular-nums}',
        '.dac-attemptOpen{margin-left:auto;height:22px;padding:0 8px;font-size:11px}',
        '.dac-attemptNoSession{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,currentColor)}',
        '.dac-attemptPrompt{margin:2px 0 0;font-size:11px;line-height:16px}',
        '.dac-attemptPrompt summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,currentColor)}',
        '.dac-form{gap:14px}',
        '.dac-formGroup{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22))}',
        '.dac-formGroup:first-of-type{border-top:none;padding-top:0}',
        '.dac-formGroupTitle{margin:0;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-fieldNote{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor))}',
        '.dac-select{max-width:100%}',
        '@media (max-width: 720px){.dac-pane{grid-template-columns:minmax(0,1fr)}.dac-list{max-height:200px;border-bottom:0.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));padding-bottom:8px}}',
      ].join('\n')
    }

    /**
     * A tiny person-and-team glyph, shared by the `@` menu row and the
     * transcript chip so a specialist reads the same everywhere.
     * @param {{ size?: number }} [props]
     */
    function AgentGlyph({ size = 14 } = {}) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M18 15v3.2M11 26.6v-3.4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3.4',
          stroke: 'currentColor',
          strokeOpacity: 0.5,
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 18, cy: 10.5, r: 4.8, fill: 'currentColor' }),
        h('circle', { cx: 7.8, cy: 27.4, r: 3.6, fill: 'currentColor', fillOpacity: 0.5 }),
        h('circle', { cx: 18, cy: 28.6, r: 3.6, fill: 'currentColor', fillOpacity: 0.5 }),
        h('circle', { cx: 28.2, cy: 27.4, r: 3.6, fill: 'currentColor', fillOpacity: 0.5 }),
      )
    }

    /**
     * Install the transcript chip stylesheet once, in the document head.
     *
     * The page renders its `<style>` inside its own component, so nothing styles
     * a chip painted in the Conversation. Without this the `<button>` keeps the
     * browser's default chrome and reads as a stray input box.
     *
     * @param {any} ctx Client root context.
     */
    function installMentionStyles(ctx) {
      const MARK = 'agent-crew/mention.css'
      const CSS = [
        // Mirrors the composer's own reference chip: a light business-tinted
        // pill, brand-colored text, no icon, inheriting the sentence's type.
        // Colors come from theme tokens, so light and dark both work.
        '.dac-mention{display:inline;box-sizing:border-box;',
        'padding:0 4px;border:0;border-radius:var(--dsw-radius-sm,6px);',
        'background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12));',
        'color:var(--dsw-alias-state-business-primary,#4d6bfe);',
        'font:inherit;font-size:inherit;line-height:inherit;letter-spacing:inherit;',
        'text-transform:none;vertical-align:baseline;',
        '-webkit-box-decoration-break:clone;box-decoration-break:clone;',
        'appearance:none;-webkit-appearance:none;',
        'word-break:break-word;overflow-wrap:anywhere}',
        '.dac-mentionLabel{text-decoration:none}',
        '.dac-mentionAction{cursor:pointer;font:inherit;line-height:inherit;text-align:inherit}',
        '.dac-mentionAction:hover{background:var(--dsw-alias-state-business-secondary,rgba(77,107,254,.2))}',
        '.dac-mentionAction:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);',
        'outline-offset:1px}',
      ].join('')
      try {
        ctx.effect(() => {
          // Read `document` at effect time: a client plugin may activate before
          // the page is ready in a test or a non-browser host.
          const doc = globalThis.document
          if (doc === undefined || doc?.head == null) return () => {}
          if (typeof doc.querySelector === 'function' && doc.querySelector(`style[data-plugin-css="${MARK}"]`) !== null) {
            return () => {}
          }
          const element = doc.createElement('style')
          element.dataset.plugin = 'agent-crew'
          element.dataset.pluginCss = MARK
          element.textContent = CSS
          doc.head.appendChild(element)
          return () => {
            element.remove()
          }
        }, 'agent-crew: mention styles')
      } catch (error) {
        ctx.logger?.warn?.(`agent-crew could not install mention styles: ${String(error?.message ?? error)}`)
      }
    }

    /**
     * Teach the transcript how to read a specialist mention.
     *
     * Two halves are required: a text rule that finds `@[label](dsh-agent:id)`
     * in the sent message, and the keyed renderer that paints it as a chip. The
     * rule sits at order 20 so it wins over the file rule at 30 for the same
     * start position — the wire form is unambiguous, a file mention never looks
     * like this.
     *
     * @param {any} ctx Client root context.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     */
    function registerMentionRendering(ctx, navigation) {
      const rule = {
        id: 'agentCrewMention',
        order: 20,
        match(text, from) {
          const wire = /@\[([^\]\n]+)\]\(dsh-agent:([^)\s]+)\)/uy
          for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
            wire.lastIndex = start
            const found = wire.exec(text)
            if (found !== null) {
              return {
                id: 'agentCrewMention',
                start,
                end: start + found[0].length,
                data: { label: found[1], profileId: found[2] },
              }
            }
          }
          return undefined
        },
      }

      /**
       * The chip shown in a sent message.
       *
       * Rendered as a button when the transcript is interactive, so a reader can
       * open the specialist instead of being left with a dead label.
       */
      function AgentMentionChip(props) {
        const data = props?.node?.data ?? {}
        const label = String(data.label ?? '')
        const profileId = String(data.profileId ?? '')
        const interactive = props?.interactive === true
        const open = () => {
          if (profileId) navigation.openProfile(profileId)
        }
        // No glyph: the composer's own reference chip is text-only, and an icon
        // here made the chip taller and busier than the sentence around it.
        const content = [h('span', { className: 'dac-mentionLabel', key: 'label' }, label)]
        if (!interactive) {
          return h('span', { className: 'dac-mention', title: profileId ? `${label} · ${profileId}` : label }, ...content)
        }
        return h(
          'button',
          {
            type: 'button',
            className: 'dac-mention dac-mentionAction',
            title: `${label} · ${profileId}`,
            onClick: open,
          },
          ...content,
        )
      }

      // The rule needs the conversation registry; the node slot is registered on
      // the ROOT `ctx.slots`, exactly like the reference and skill packages, so
      // the keyed child resolves against the factory that declares it.
      ctx.inject(['uiConversation'], (scoped) => {
        scoped.effect(
          () => scoped.uiConversation.userText.register(rule),
          'agent-crew: mention rule',
        )
      })
      ctx.slots.inject('conversation.user.text.node', () =>
        ctx.slots.register(
          {
            name: 'conversation.user.text.node',
            key: 'agentCrewMention',
            priority: 100,
            inject: () => ({ openProfile: (id) => navigation.openProfile(id) }),
          },
          AgentMentionChip,
        ),
      )
    }

    /**
     * The `@` source: type `@` in the composer to address a specialist.
     *
     * A pick inserts the specialist's `@id` token into the draft. The token is
     * plain text on purpose: the lead reads it from the message and decides how
     * to delegate, so a half-typed or hand-edited mention can never start work
     * the user did not ask for.
     *
     * Registration is optional — a profile without the input-trigger plugin
     * simply keeps the panel and the tools.
     *
     * @param {any} ctx Client root context.
     * @param {(key: string, params?: Record<string, unknown>) => string} t
     */
    function registerMentionSource(ctx, t) {
      /** @type {{ at: number, rows: any[] } | null} */
      let cache = null
      const CACHE_MS = 4000

      /** Read the roster; a failed read yields an empty menu, never a throw. */
      async function roster(signal) {
        const now = Date.now()
        if (cache && now - cache.at < CACHE_MS) return cache.rows
        const answer = await callHost({ action: 'mentionables' })
        if (signal?.aborted) return []
        const rows = answer.ok && Array.isArray(answer.data?.profiles) ? answer.data.profiles : []
        cache = { at: now, rows }
        return rows
      }

      // The wire spelling mirrors the session reference convention, so the
      // transcript rule below can recognize a specialist without any facts.
      const WIRE = (id, label) => `@[${label}](dsh-agent:${id})`
      /** Encode `id` and label together: a codec only receives the ref string. */
      const encode = (id, label) => `${id}\u001f${label}`
      const decode = (ref) => {
        const at = String(ref).indexOf('\u001f')
        return at < 0 ? { id: String(ref), label: String(ref) } : { id: ref.slice(0, at), label: ref.slice(at + 1) }
      }

      const source = {
        trigger: '@',
        name: 'agentCrew',
        order: -5,
        showGroupTitle: true,
        /**
         * A pick inserts a real reference, not text: the composer renders it as
         * a chip (so it is highlighted and atomic), and submit runs the codec.
         */
        onPick({ candidate }) {
          const id = String(candidate.value ?? candidate.name)
          const label = String(candidate.label ?? id)
          return {
            insert: {
              source: 'agentCrew',
              ref: encode(id, label),
              label: `@${label}`,
              // `session` is the non-file chip appearance; `file` would render a
              // file glyph and offer to open a path that does not exist.
              appearance: 'session',
              clipboardText: `@${label}`,
            },
          }
        },
        codec: {
          clipboardText: (ref) => {
            const { label } = decode(ref)
            return `@${label}`
          },
          serialize: (ref) => Promise.resolve(WIRE(decode(ref).id, decode(ref).label)),
        },
        // There is nothing to open for a specialist, so the editor gesture is
        // left alone rather than failing on a fabricated path.
        openReference: () => false,
        async candidates(_session, req) {
          const rows = await roster(req.signal)
          const needle = String(req.query ?? '').trim().toLowerCase()
          return rows
            .filter(
              (row) =>
                !needle ||
                String(row.id).toLowerCase().includes(needle) ||
                String(row.name).toLowerCase().includes(needle) ||
                String(row.role ?? '').toLowerCase().includes(needle),
            )
            .map((row) => ({
              // `name` is the identity and the exact-match key; `value` is the
              // payload handed back on pick.
              name: row.id,
              label: row.name,
              description: row.role,
              value: row.id,
              icon: AgentGlyph,
              section: t('mentionSection'),
              hint: `${t('mentionHint')}${row.memoryCount ? ` · ${fill(t('mentionMemory'), { count: row.memoryCount })}` : ''}`,
            }))
        },
      }

      // `ctx.inject` resolves the service whenever it arrives, so a slower
      // client plugin never silently drops the @ menu.
      ctx.inject(['inputTriggers'], (scoped) => {
        scoped.effect(
          () => scoped.inputTriggers.registerSource(source),
          'agent-crew: @ specialist source',
        )
      })
    }

    return {
      // `inputTriggers` is optional: the @ menu is a bonus, the panel is not.
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        const t = (key, params) => fill((dictionaryFor(locale)[key] ?? EN[key] ?? key), params)
        const tick = createLocaleTick()
        /** A specialist the transcript asked to open, consumed by the page. */
        let pendingSelection = null
        // One navigation face: the transcript chip and the page use the same
        // route to a specialist. `layout.selectPanel` is the supported way to
        // switch the main column without touching the DOM.
        const navigation = {
          openProfile: (profileId) => {
            try {
              const layout = ctx.get?.('layout')
              layout?.selectPanel?.(PANEL_ID)
              pendingSelection = profileId
              tick.bump()
            } catch {
              // A profile without the layout service keeps the chip inert.
            }
          },
          takeSelection: () => {
            const value = pendingSelection
            pendingSelection = null
            return value
          },
          /**
           * Reopen a child's own transcript. A local specialist owns a real DSH
           * Session; an external Codex run is ephemeral and has none.
           */
          openSession: (sessionId) => {
            try {
              ctx.get?.('uiWorkspace')?.openSession?.(sessionId)
            } catch {
              // A profile without the workspace UI keeps the row inert.
            }
          },
        }
        const { AgentCrewPage, SidebarIcon } = createUi(t, tick, navigation)
        // The Host notifies every namespace on a language switch.
        ctx.on('locale/change', () => tick.bump())

        registerMentionSource(ctx, t)

        // The transcript half: without these, a specialist mention falls through
        // to the file-reference rule, which draws a file glyph and offers to open
        // a path that does not exist.
        installMentionStyles(ctx)
        registerMentionRendering(ctx, navigation)

        // One id ties the navigation row to the page it opens. Order 15 sits
        // between Schedules (10) and Skills (20).
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => t('title') },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, AgentCrewPage),
        )
      },
    }
  },
})
