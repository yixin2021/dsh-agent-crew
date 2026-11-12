# 验证记录

环境：DSH `0.2.2-rc.2`，profile `desktop`，Web GUI `http://127.0.0.1:59658`。
插件目录：`dsh-agent-crew/`，安装方式 `plugin_manager` → `install_bundle`（本地目录 link）。

## 1. 安装

| 项目 | 结果 |
|---|---|
| `install_bundle` | `application: "applied"`，`warnings: []` |
| Bundle 行 | `include:agent-crew` → `@local/dsh-agent-crew@1.0.0` |
| Config schema | 通过 `cordis_inspect_query`（`Config.listConfigs`, entry `include:agent-crew`）读到完整 JSON Schema，`status: "schema"`、`acceptsMissing: true` |
| 工具注册 | `Tool.listTools` 中可见全部 10 个 `crew_*` 工具及其参数 schema |

安装过程中修复的两个真实缺陷（均由装载日志暴露，非推测）：

1. `cannot get property "systemPrompt" without inject` → 提示词段落是可选能力，改用 `ctx.get('systemPrompt')`，缺少该服务时插件照常提供全部工具。
2. `TypeError: Invalid effect` → Cordis 不允许 `apply()` 返回非 disposer 值；去掉 `return service`，改为 `ctx.provide()` + `ctx.effect()`。

## 2. 单元测试

```sh
node --test test/
# tests 13, pass 13, fail 0
```

覆盖：Profile 校验与默认值、工具策略求交与 guard 判定、提示词内容、子智能体名称语法、依赖拓扑执行、并发上限、失败传播（failed → blocked）、可重试失败恢复、人工 `retryTask`、依赖校验（未知引用 / 环 / 未知 profile）、取消打断、重启持久化与 config 种子优先级、损坏状态文档保留。

## 3. 端到端实测（真实子智能体）

### 3.1 基本委派与状态（7/7 通过）

由独立验证子智能体执行：`crew_agent_create` → `crew_agent_list` → `crew_task_dispatch` → `crew_run_status` → 读 `state.json` → `crew_task_retry`（应拒绝）→ `crew_agent_delete`。

- 子智能体名称 `crew-smoke/greeter-11zw2`，耗时 4424 ms。
- 结果原文：`PONG acknowledged — the count is 42.`
- 运行状态 `completed`，counts `{total:1, completed:1}`，`attempt: 1`。
- `crew_task_retry` 正确拒绝：`Task "task-1" is completed; only failed, blocked, or cancelled tasks can be retried.`
- 该轮暴露的两个小问题已修复：`crew_run_status` 单运行模式下多余的空 `runs: []`；状态文档中未被使用的 `counters` 字段。

### 3.2 超时 + 重试 + 依赖阻塞（单次运行内同时验证）

| 任务 | 配置 | 实测结果 |
|---|---|---|
| task-1 `Will time out` | `timeout_ms: 1`，`max_attempts: 2` | `failed`，2 次尝试，错误 `TIMEOUT` / `The delegated agent exceeded its 1ms limit.` |
| task-2 `Needs the slow task` | `depends_on: ["slow"]` | `blocked`，`DEPENDENCY_FAILED` / `Blocked by task-1.` |
| task-3 `Independent task` | 无依赖 | `completed`，结果 `READY: ...`，耗时 1968 ms |

run 汇总：`1/3 completed, 1 failed, 1 blocked, 0 cancelled, 0 open`，run 状态 `failed`。

该轮发现并修复：超时最初被归类为下游取消码 `FS_ABORTED`；现在 start 阶段因本插件 deadline 或运行取消而失败时，上报 `TIMEOUT` / `ABORTED`。

### 3.3 工具允许清单强制（真实负向测试）

第一轮**失败**（重要发现）：profile `tools: ["read"]` 的子智能体仍能执行 `bash`。根因是本版本大多数工具注册在 **Agent preset 作用域**，插件根上下文的 `ctx.tools.definitions()` 读不到它们，策略被解析成 “no tools” 并提前跳过注册；而 `tools.restrict()` 只覆盖全局注册的工具。

修复后同一条负向测试通过：

| 测试 | profile | 实测结果 |
|---|---|---|
| 允许清单 | `tools: ["read"]` | 子智能体`bash` **完全不可见**（"I cannot see or call a bash tool at all"），`read` 正常读取 `package.json` 并返回 `@local/dsh-agent-crew` |
| 默认拒绝嵌套编排 | `tools: ["*"]` | `crew_run_start` / `crew_run_status` / `crew_agent_create` 在 schema 中 **ABSENT**；`bash` / `read` 正常 |

强制机制（三层）：

1. **Guard**（权威）：`agent.ctx.tools.guard()` 对每次调用按名称判定，越权返回 `CREW_TOOL_DENIED`。实测拒绝原文：`tool "crew_run_status" is outside this agent's tool policy (all session tools except the lead-only agent-crew orchestration tools)`。
2. **Restrict**（展示层）：`agent.ctx.tools.restrict()` 让越权工具从子智能体 schema 中消失（实测 ABSENT）。
3. **提示词**（可解释）：角色提示词写明可用工具面，即使前两层被环境限制，子智能体也知道边界。


## 4. 侧边栏入口与管理页（Client 半部）

### 4.1 已修复：管理页 404

用户报告：`Could not read agent crew state: HTTP 404 · dsh-app://app/api/agent-crew`。

根因（读 `dsh-client-connection/src/rpc-host.ts` 确认）：`createSharedFetchHandler` 用
`this.fetchRoutes.get(new URL(request.url).pathname)` 做**精确匹配**，而 `pathname` 永远以
`/` 开头。原实现把路径注册成 `api/agent-crew`（无前导斜杠），于是永远命中不到，落进兜底的
`return new Response('not found', { status: 404 })`。

修复：
- Host 侧注册路径改为 `/api/agent-crew`。
- 浏览器侧仍用相对引用 `api/agent-crew`，靠 `document.baseURI` 解析，因此部署前缀与桌面
  `dsh-app://app/` 两种来源都能落到同一个 pathname。
- 抽出 `isMatchableRoutePath()` 在挂载时校验，非法路径直接抛 `ROUTE_INVALID` 而不是静默 404。
- 抽出 `createManagementRoute()`，把「注册的路径 + 请求解码」变成可脱离运行时的纯对象。

回归测试 `test/management.test.mjs` 有 3 个用例锁住这条链路：路径契约、
`fetchRoutes.get(pathname)` 的真实查找、以及旧的不带斜杠写法必须查不到。

### 4.1b 已修复：界面未汉化

用户报告：「界面很多地方都还没汉化」。

排查顺序：
1. 对比中英字典 key 集合 —— 91 : 91，**完全一致**，不是漏翻。
2. 扫描字典外的字符串字面量 —— 只剩 `POST` / `NETWORK` / `HTTP` / 一条 SVG path，都是技术常量。
3. 检查 locale 服务的快照形状 —— 找到根因。

根因：`dsh-client-locale` 的 `LocaleSnapshot` 把当前语言放在 **`active`** 字段
（`src/client/index.ts` 里 `interface LocaleSnapshot { active: LocaleId ... }`，
宿主自身也是 `bridge.onChange(locale.getSnapshot().active)`）。插件读的是 `.id`，
永远 `undefined`，于是 `dictionaryFor()` 恒回退英文 —— 整页英文，只有头像首字母、
专家名等数据本身是中文。

修复：
- 抽出 `activeLocaleId()`，按 `active` → `id` 的顺序读取，读不到返回空串。
- 时长单位 `ms / s / min` 原本硬编码英文，改为字典项 `unitMs / unitSec / unitMin`（毫秒/秒/分钟）。

回归测试（`test/client.test.mjs`，新增 2 条）：
- 「中文 locale 渲染有数据页面」：用真实快照形状 `{ active: 'zh' }`，断言
  `2 个专家 · 1 个运行`、`刷新`、`新建专家`、`搜索专家`（在 `placeholder` 属性上）、
  详情分区标题、`10 分钟`、`已完成 1/3`、`1 失败 · 1 阻塞`，并断言
  `Agent crew` / `Specialists` / `Refresh` / `New specialist` / `Select a specialist`
  **不出现**。
- 「两份字典 key 一致」：锁住未来漏翻。

**测试有效性经过突变验证**：把 `activeLocaleId()` 改回只读 `.id`，上述 2 条测试立刻失败；
恢复修复后全绿。

同时修正了测试本身的缺陷：原先的假 context 用 `{ id: 'en' }`，与真实快照形状不符，
这正是它没能提前发现该 bug 的原因；现在统一使用 `{ active: 'en' }`。

### 4.1c 路由校验的补充确认

`assertFetchRoute()` 要求精确路由满足 `endpointFromPath('/api', path) !== undefined`，
即路径必须以 `/api/` 开头。原先的相对路径会在这里抛错，但异常发生在
`ctx.inject(['connection'], cb)` 的回调里被吞掉，表现为「插件加载 applied、路由没注册、访问 404」。
现在 `createManagementRoute()` 在 `ctx.inject` **之前**校验，非法路径在 apply 阶段显式失败。

### 4.2 注册状态（来自运行中的页面）

用 `cordis_inspect_query`（Client `Slots.listSubTree`）在真实运行的 Web 页面上读取：

| 槽位 | 实测内容 |
|---|---|
| `sidebar.panellist` | occupants 含 `agent-crew`，`order: 15`、`active: true`，位于 `schedules(10)` 与 `dsh-skills(20)` 之间 |
| `main`（keyed） | occupants 含 `key: 'agent-crew'`、`active: true` |

### 4.3 界面结构（参照本机 OpenMausBot 的信息架构）

原版只有一张单列表，太单薄。参照本机 `/Applications/OpenMausBot.app` 里 `botPanel.*`
的分区方式（花名册 + 详情分区 + 运行历史 + 状态徽章）重做为：

- **头部**：标题、`N 个专家 · M 个运行`、状态目录；右侧搜索框、刷新、新建。
- **两个 Tab**：专家 / 运行，带数量徽章。
- **专家 Tab 两栏**：左侧可滚动花名册（头像、名称、角色、工具摘要、配置来源圆点），
  右侧详情分区 —— 角色、常驻指令、能力、可用工具、模型路由（Provider/模型/尝试次数/时限）、
  与该专家相关的运行。
- **运行 Tab**：每张卡有状态徽章、分段进度条（完成/失败/取消/未完成）、
  `已完成 1/3` 摘要与失败/阻塞附加信息；展开后是任务行（状态、主题、执行者头像、
  `第 n/m 次`、依赖、错误码、结果预览）。
- 专家头像按 id 稳定取色，不依赖存储。
- 只读 `--dsw-alias-*` 主题变量并带兜底值；`@media (max-width:720px)` 下两栏折叠为单栏。

### 4.4 自动检查

- `node --check client.js` 通过。
- 客户端 6 个用例，用一个带**真实 hooks 语义**的 React 桩（每个组件独立 hook 槽、
  `useCallback` 按依赖记忆化、`useEffect` 依赖比对、异步后可由 `setState` 触发重绘）：
  1. 注册 id 一致，标签随 locale 在 `Agent crew` ⇄ `智能体团队` 之间切换；
  2. 图标输出带尺寸的 svg 且继承 `currentColor`；
  3. 空态渲染出两个 Tab、搜索框与两个按钮，加载文案正确；
  4. **英文有数据页面**：断言 `2 specialists · 1 runs`、两名专家与其角色、选中后的六个分区、
     `Cite file:line`、`diff review`、切到运行 Tab 后 `1 of 3 complete` 与
     `1 failed · 1 blocked`、进度条两段（完成 + 失败）、展开任务后的
     `Review login flow` / `TIMEOUT` / `attempt 2/2` / `after task-1`；
  5. **中文有数据页面**：见 4.1b，含英文泄漏断言；
  6. **两份字典 key 一致**。
- 管理路由 8 个用例：路径契约、`list`、`saveProfile`、`deleteProfile`/`deleteRun` 错误码、
  运行中拒绝删除、畸形请求、路由响应信封（含 400）、以及上述 404 回归。
- 全量 `node --test test/`：**27/27 通过**。

### 4.5 未验证项（重要）

- **浏览器里的实际像素未经确认**：本会话没有浏览器控制能力。4.4 的渲染测试证明的是
  「组件树里这些文字与控件确实存在、状态切换正确」，不是「看起来对」。
- 页面与 Host 的真实往返：`fetchRoutes.get(pathname)` 的真实查找已用单测复现，
  但「浏览器里点一下、数据真的回来」需要你刷新页面确认。

## 5. 其余未验证项

- 插件管理页里的图标与本地化标题/描述渲染：`locale/en.json`、`locale/zh.json`、`icon.svg`、`docs/DETAIL*.md` 已按清单导出，但**未被浏览器确认**。
- `provider: 'fork'`、外部后端（ACP/SDK/Codex）路径：这些 provider 的 `agentOptions` 能力位不同，未逐一实测。
- 跨进程并发写：当前状态文档为单进程模型，未做跨进程验证。

## 6. 三层记忆与运行后端（实测）

### 6.1 记忆分层

参考本机 `/Applications/OpenMausBot.app` 的记忆布局（`~/.openmausbot/workspaces/<id>/MEMORY.md`
只加载前 200 行，`memory/<topic>.md` 按需读取，`memory/log/<date>.md` **明确不进对话**）重做为三层：

| 层 | kind | 进提示词 | 上限 |
|---|---|---|---|
| 索引 | `note` / `lesson` | 每次都注入 | 2400 字符 |
| 专题 | `topic` | 从不 | 单条 6000 字符 |
| 日志 | `run` | 从不 | 单条 800 字符 |

**修复的缺陷**：旧实现按「最近 12 条」不分层注入。实测复现——1 条人工记录 + 15 条日志后，
人工记录**不再出现在提示词里**（`memoryBlock` 返回 false）。这正是分层的动机。
现在日志再多也进不了提示词，新增回归测试锁住。

同时新增 `crew_memory_read`（专家侧）与 `crew_agent_memory` 的 `read` 动作（主协作人侧），
因为「只写不读」等于半套机制。

实测（`crew_agent_memory read kind=run`）：reviewer 的 3 条日志按最新优先返回，
`note`/`lesson` 不出现在该层。

### 6.2 运行后端

每个 Profile 新增 `runtime` 字段：`spawn`（默认）或 `codex`。

实测 codex 后端（`crew_task_dispatch`，runtime=codex）：

```
run_mwd96quv_e2079b76 → completed
结果：CODEX_DELEGATED validation completed successfully for task 7.
耗时：3319 ms
childName = ac984c07-a9c4-40da-94b7-9ff8725eeb2d（运行时自铸，非我们预留）
```

`childName` 等于会话 id 这一点直接验证了实现假设：codex provider 声明 `NO_START_CAPABILITIES`，
不接受 `childId`/`name`/`agentOptions`，所以外部委派不传这些字段。

三个由能力位决定的实现细节：

1. 不预留 `childId`（外部后端会拒绝）；
2. 不登记 `pendingPolicies`，因为外部后端没有本地 Agent，`agent/created` 不会触发，
   也就无法对其施加工具策略——所以**不承诺**；
3. 不调用 `subagents.interrupt()`（没有可打断的本地会话 id），只靠激活信号取消。

角色提示词据 runtime 区分：实测本地后端提示词含 `crew_memory_note`，codex 后端**不含**
（有 `memory.test.mjs` 的专门用例）。

### 6.3 未验证项

- 面板新增的**运行后端下拉**与**三层记忆展示**只经组件渲染测试（断言文本与分类齐全），
  **未经浏览器目视确认**。
- codex 后端的失败路径（权限拒绝、超时、沙箱阻断）未逐一实测，只验证了成功路径。

## 7. 本轮修复（@ 消失 / codex 选模型 / 表单布局）

### 7.1 回归：@ 菜单消失

根因：`apply` 里用 `ctx.get('inputTriggers')` 读取服务。客户端插件的加载顺序不保证，
服务尚未注册时读到 `undefined`，函数直接 `return` —— **静默不报错**，菜单从此消失。
上一轮它能出现，纯属加载顺序恰好。

修复：改用 `ctx.inject(['inputTriggers'], scoped => ...)`，服务何时就绪何时注册。
新增 2 条测试锁住：
- `client.test.mjs`：断言 `inject` 被调用、source 已注册、候选按 id/名称/角色过滤、
  pick 只插入纯文本 `@reviewer `；
- `wiring.test.mjs`：断言源码使用 `ctx.inject(['inputTriggers']` 且**不再**出现
  `ctx.get?.('inputTriggers')`。

### 7.2 Codex 的模型只能配在提供方实例上

读 `@deepseek-ai/dsh-subagent-codex` 的 `lib/index.js` 确认：`start(request)` 只用
`this.config.model`，**请求里没有模型字段**。这是 provider 契约，不是疏漏。

因此设计为：Profile 增加 `codexProvider`（提供方注册名），模型由那一行决定。
- `runtime=codex` 时**禁止**填写 `provider`/`model`（否则报 `PROFILE_INVALID` 并说明该用 `codexProvider`）；
- 提供方未注册时任务直接以 `CODEX_PROVIDER_MISSING` 失败，并附上该补的 YAML 行，而不是启动一个跑不通的运行；
- 面板的「Codex 提供方」字段旁显示 Host 的实况：`已注册 · 模型 xxx` / `已注册 · 使用原生默认模型` / `未注册 —— 任务会拒绝执行`。

本机当前只有一个 codex 行（bundle 自带，`providerName: codex`，未固定模型），
profile 的 `cordis.patch.yml` 里没有自定义行，所以现在只能验证默认行。

### 7.3 表单布局

原来 11 个字段挤在一个网格里，`运行后端` 的提示文字很长，整列被撑高。改为三个分组：

| 分组 | 字段 |
|---|---|
| 基本信息 | 名称、标识、角色、运行后端 |
| 工作方式 | 指令、能力，**按后端切换**：本地 → 工具/Provider/模型；codex → Codex 提供方 + 状态行 |
| 限制 | 尝试次数、单次时限 |

运行后端的说明从字段下方移出，改在详情页的「运行后端」分区里说明，表单里只留下拉框。

### 7.4 测试

全量 **47/47 通过**（新增 @ 源 1 条、codex profile 2 条）。

### 7.5 未验证项

- **@ 菜单是否真的弹出、表单新布局是否好看，都需要你在浏览器确认**——本会话没有浏览器控制能力。
- 自定义 codex 行（换模型）未实测，因为本机没有配置；按读到的 provider 契约推断可行。

### 7.6 已修复：切换 Codex 报 `codexStatus is not defined`

用户报告：切换运行后端到 Codex 时面板报「这个面板渲染失败：codexStatus is not defined」。

根因：上一轮我用脚本给 `renderForm` 插入状态行时，替换锚点是
`/** The create/edit card. */`，但那个注释在实际文件里并不存在（前一轮重构已把它改成
`// ---- form ----` 分隔线）。`str.replace` 找不到锚点时**静默不替换**，
于是 `codexStatus()` 从未被定义，而调用点已经写进 JSX。`codexRows` 状态和
`codexProviders` 请求都插进去了，唯独函数漏了——所以只在切到 codex 分支时才炸
（本地分支不调用它），也因此躲过了当时所有测试。

修复：把 `codexStatus()` 补进页面组件。同时**补上会真正渲染表单的测试**——
之前 8 条客户端测试没有一条打开过表单，这是漏检的直接原因。

新增测试覆盖：打开新建表单 → 本地分支有「工具/Provider/模型」→ 通过 select 的
onChange 切到 codex → 断言不出现 `failed to render`、出现「Codex provider」与沙箱说明、
本地字段消失 → 按 label 定位输入框填入已注册提供方显示模型、填入未注册提供方显示警告。

**突变验证**：临时删除 `codexStatus()` 函数体，该测试立即失败；恢复后通过。

全量测试 **48/48**。

## 8. @ 专家：高亮、图标、会话记录（本轮）

用户报告三件事，实际是同一个根因。

### 8.1 根因

`onPick` 把 `@专家` 当**纯文本**插入（`{ text: '@reviewer ' }`）。于是：

1. 编辑器不把它当引用 → 没有 chip、没有高亮；
2. 菜单候选没有 `icon` 字段 → 列表里没有图标；
3. 发送后，转录层的 `fileReferenceRule`（order 30）把 `@reviewer` 当成**文件路径**匹配 → 渲染成文件图标，点开自然找不到文件。

### 8.2 修复

| 问题 | 修复 |
|---|---|
| 无高亮 | `onPick` 改为返回 `{ insert: ReferenceInsert }`：编辑器把它渲染为原子 chip |
| 无图标 | 候选加 `icon: AgentGlyph`（菜单按 `React.createElement(icon, {size:14})` 渲染） |
| 会话记录显示文件图标 | 新注册 `user-text` 规则 `agentCrewMention`（**order 20**，压过文件的 30）+ 键控渲染器 `AgentMentionChip` |

配套细节：

- **wire 形式** `@[显示名](dsh-agent:id)`，与 DSH 自己的 `@[label](dsh-session:...)` 同构，
  转录规则用正则即可识别，不需要任何 facts 注入；
- `appearance: 'session'`（非 `file`），否则 chip 会画文件字形；
- `codec`：`clipboardText` 给草稿/剪贴板 `@显示名`，`serialize` 给模型 wire 形式；
- `openReference: () => false`：专家没有可打开的预览目标，把编辑器手势原样交还，
  而不是去打开一个不存在的路径；
- 注册改走 `ctx.inject(['uiConversation','slots'])`，与上一轮 @ 菜单同一类修复——
  探测式 `ctx.get` 会在服务晚到时静默跳过。

ref 用 `id\u001f显示名` 编码：codec 只收到一个 ref 字符串，UI 与 wire 都需要这两个值。

### 8.3 测试

新增 1 条 + 强化 2 条：
- 转录规则：`@[Code reviewer](dsh-agent:reviewer)` 能匹配、取到 label 与 profileId、
  **order < 30**（压过文件规则）、普通 `@src/index.ts` 不匹配、chip 渲染出中文标签与 svg 字形；
- @ 源：pick 返回 `insert` 而非 `text`、`appearance==='session'`、codec 双向正确、
  `openReference` 返回 false；
- wiring：断言源码出现 `insert:` / `appearance: 'session'` / `codec:` / `dsh-agent:` / `openReference`。

**突变验证**：删除转录规则后，9 条客户端测试里 8 条失败；恢复后全绿。

全量 **49/49 通过**。

### 8.4 未验证项

**编辑器的 chip 外观、菜单图标、「发送后」的真实渲染都没有经过浏览器目视确认**——
本会话没有浏览器控制能力。测试证明的是「注册正确、规则能匹配、组件能渲染出字形与标签」，
不是「看起来对不对」。

## 9. 会话记录里的专家 chip：高亮 + 可点击

用户报告：会话记录里专家没有高亮，希望高亮并支持点击查看详情。

### 9.1 上一轮为什么没生效

对照 `dsh-client-ui-reference` 与 `dsh-client-ui-skill` 的注册形态发现两处偏差：

| 项 | 官方形态 | 我原来的写法 |
|---|---|---|
| 节点渲染器注册位置 | 根 `ctx.slots.register(...)`，带 `inject: sessionId => ({...})` | 包在 `ctx.inject(['uiConversation','slots'])` 的作用域里注册 |
| chip 交互 | `inject` 提供会话态动作，渲染成可操作元素 | 纯 `span` + `title`，没有任何动作 |

`conversation.user.text.node` 是 `conversation.user.text` 工厂声明的 keyed 子槽，注册在
scoped context 上不一定能解析到工厂；加上 chip 本身不可点击，所以既不高亮也不可查看详情。

### 9.2 修复

- 节点渲染器改为**根 `ctx.slots` 注册**，并用 `inject: () => ({ openProfile })` 提供打开动作；
- chip 在 `interactive` 时渲染成真正的 `<button>`：悬停有背景与边框变化、文字带下划线、
  有 focus 环；非交互场景仍是 `span`（不给出假的可点击承诺）；
- 点击走 `layout.selectPanel('agent-crew')` 切到团队面板，并把 `profileId` 交给页面；
  页面在下一次绘制时消费该选择（`takeSelection` 一次性语义），直接定位到该专家；
- 用 `ctx.get('layout')` 取服务、失败时 chip 保持惰性，不抛错。

### 9.3 测试

新增 1 条、强化 1 条：
- 交互态 chip 是 `button`、`type="button"`、`title` 含 profileId；
  非交互态没有 button；`inject()` 提供 `openProfile`；
- 点击链路：`rule.match` → `inject('s1')` → 渲染 → `onClick` → 断言
  `layout.selectPanel` 收到 `'agent-crew'`（即真的切到了团队面板）。

**突变验证**：删掉 chip 的 `onClick` 后，第 10 条测试立即失败；恢复后全绿。

全量 **50/50 通过**。

### 9.4 未验证项

chip 的实际视觉（悬停色、下划线、深浅色对比）与「点击后页面是否真的定位到该专家」
**未经浏览器确认**——本会话没有浏览器控制能力。测试覆盖到的是注册形态、
交互元素与调用链路，不是渲染结果。

## 10. 会话记录 chip 样式（本轮）

用户反馈截图：会话记录里的专家 chip 显示成一个**带边框的方框输入框**，与输入框内的样式不一致。

### 10.1 根因

chip 的 CSS 只写在**管理页组件的 `<style>`** 里（`createUi` 内部渲染）。管理页是
`main` 槽的一个面板，那段样式只在该面板挂载时存在于 DOM 中；而**会话记录在
Conversation 树里**，从未拿到这些规则。

于是 `AgentMentionChip` 渲染出的 `<button>` 落回浏览器默认外观——带边框、默认字体、
默认内边距，看起来就像一个输入框。

### 10.2 修复

- 新增 `installMentionStyles(ctx)`：用 `ctx.effect` 在 `document.head` 插入一个
  `<style data-plugin="agent-crew" data-plugin-css="agent-crew/mention.css">`，
  走 DSH 自己的插件样式约定（与 `dsh-context` 的 `data-plugin-css` 写法一致）；卸载时移除。
- chip 样式改为**无边框内联胶囊**：`border:0`、`font:inherit`、`appearance:none`、
  `display:inline-flex`、`line-height:1.45`、`vertical-align:baseline`，
  背景用 `color-mix(in srgb, currentColor 9%, transparent)` 跟随文字色，
  因此深浅色主题自动适配，无需硬编码颜色。
- 删掉页面样式表里的旧 chip 规则（会与全局规则冲突），并去掉一处重复的 `.dac-select`。
- `document` 改为在 effect 执行时读取（`globalThis.document`），
  避免插件在页面就绪前激活时拿到 `undefined`。

### 10.3 测试

新增 1 条「chip 自行安装样式」：
- 断言 `document.head` 收到 `dataset.pluginCss === 'agent-crew/mention.css'` 的 style；
- 断言 CSS 含 `border:0`、`font:inherit`、`appearance:none`、`display:inline-flex`；
- 断言**不含** `border:0.5px solid`（那正是截图里方框的来源）；
- 断言卸载时元素被移除。

**突变验证**：去掉 `installMentionStyles(ctx)` 调用后该测试失败；恢复后全绿。

全量 **51/51 通过**。

### 10.4 未验证项

改后的实际观感（胶囊大小、与正文的基线对齐、悬停色）**未经浏览器确认**——
本会话没有浏览器控制能力。测试锁定的是「样式被安装、形态是无边框内联」，不是渲染结果。

## 11. chip 样式对齐官方引用胶囊（本轮）

用户二次反馈：方框去掉了，但灰底块仍然厚重难看。

### 11.1 根因

从安装包里挖出 DSH **自己**的引用 chip 样式（`dsh-client-ui-conversation` 的
`gxtJRW_reference`）：

```
border-radius: var(--dsw-radius-sm);
line-height: inherit;
vertical-align: baseline;
color: var(--dsw-alias-state-business-primary);
box-decoration-break: clone;
background: 0 0;     /* 常态透明 */
padding: 0 4px;
/* 悬停/激活时才 background: var(--dsw-alias-state-business-tertiary) */
```

对照我上一轮的写法，两个偏差：

1. **底色用自混的灰色** `color-mix(in srgb, currentColor 9%, transparent)` ——
   在深色正文上混出来是一块实心灰，视觉上就成了"厚重方块"。官方用的是品牌色令牌
   `--dsw-alias-state-business-tertiary`，而且**常态是透明的**。
2. **多塞了一个图标**（12px svg）—— 官方 chip 是纯文字；图标把行高撑高，
   与周围文字不对齐，看起来更像控件而不是文中引用。

### 11.2 修复

- 底色/文字色改用官方令牌：`state-business-tertiary` / `state-business-primary`；
- `display:inline` + `line-height:inherit` + `vertical-align:baseline`，
  并对跨行加 `box-decoration-break:clone`；
- 圆角 `var(--dsw-radius-sm)`，内边距 `0 4px`，与官方完全一致；
- **移除图标**，只留文字；悬停时才加深底色，并附 `focus-visible` 环。

### 11.3 测试

更新样式契约测试：
- 断言含 `--dsw-alias-state-business-tertiary` / `--dsw-alias-state-business-primary`
  / `border-radius:var(--dsw-radius-sm`；
- 断言含 `line-height:inherit`、`display:inline`；
- 断言**不含** `currentColor 9%`（自混灰底，上一次的根因）与 `border:0.5px solid`；
- chip 渲染断言**不含 svg**（移除图标）。

全量 **51/51 通过**。

### 11.4 未验证项

仍**未经浏览器确认**。这次的依据是官方 chip 的真实 CSS 而非猜测，但「看起来
是否与输入框内的胶囊一致」只能由你目视判断。
