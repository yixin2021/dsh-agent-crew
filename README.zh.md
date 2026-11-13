# 智能体团队（Agent crew）

把「一个助手」变成「一支团队」的 DSH 插件。

你定义可复用的**专家**——角色、常驻指令、能力、每个专家可用的工具。**主协作人**随后把目标拆成依赖图，把每个任务交给对应的专家，汇总结果，对值得重试的失败重试，最后统一汇报。

每个专家跑在自己的**运行后端**上、跨会话保留自己的三层**记忆**，并在对话中以可点击的 `@` 标记出现。

```
你 ──▶ 主协作人 ──▶ 任务图 ──▶ 专家（spawn | codex）
                    │              │
                    └── 结果 ◀─────┘
```

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [在哪里找到它](#在哪里找到它)
- [专家](#专家)
- [运行后端](#运行后端)
- [发起运行](#发起运行)
- [记忆](#记忆)
- [@ 提到专家](#-提到专家)
- [查看运行](#查看运行)
- [工具一览](#工具一览)
- [配置](#配置)
- [示例](#示例)
- [与现有机制的关系](#与现有机制的关系)
- [已知限制](#已知限制)

## 安装

在 DSH 的 **Plugins** 页启用 **Agent crew**，或直接安装：

```
plugin_manager install_bundle github:yixin2021/dsh-agent-crew
```

如果安装器提示需要重启，就重启。插件不需要任何凭据：专家定义中不存密钥，状态文件权限为 `0600`。

## 快速开始

定义一个专家，交给它一件事。

```jsonc
// 1. 定义专家
crew_agent_create({
  "id": "reviewer",
  "name": "代码审查员",
  "role": "关注越权与注入风险的代码审查员",
  "instructions": "找出授权缺口，每条都给 file:line。",
  "capabilities": ["diff 审查", "威胁建模"],
  "tools": ["read", "grep", "glob"]
})

// 2. 派发一个任务（默认异步）
crew_task_dispatch({
  "profile_id": "reviewer",
  "subject": "审查登录改动",
  "description": "审查 src/auth/login.ts 是否缺少权限校验，列出每个未加保护的入口并给 file:line。不要修改文件。"
})
// → { run: { id: "run_mc4x1k_ab12cd", status: "ready" } }

// 3. 等它结束后读结果
crew_run_status({ "run_id": "run_mc4x1k_ab12cd", "include_results": true })
```

运行结束时**完成通知会自动送达**，所以第 3 步只在你需要看细节时才要做。

## 在哪里找到它

左侧边栏会出现 **智能体团队** 入口（位于「计划任务」与「Skills」之间），打开管理页：

| 区域 | 内容 |
|---|---|
| **专家** | 左侧可搜索花名册；右侧分区详情——角色、常驻指令、能力、可用工具、运行后端、模型路由、记忆、相关运行 |
| **运行** | 每次运行的分段进度条（完成/失败/阻塞/取消），可展开为逐任务历史 |
| **任务详情** | 每次尝试的后端、终止原因、耗时、收到的提示词，以及本地专家的**会话链接** |

在这里可以直接新建、编辑、删除专家，不用手写工具调用。**发起运行仍需在对话里**，因为委派必须有一个活着的主协作人。

## 专家

专家是一份持久定义，不是一个常驻进程。

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识，`^[a-z][a-z0-9-]{0,31}$`，保存后不可修改 |
| `name` / `role` | 显示名与一句话角色 |
| `instructions` | 常驻操作指令，最多 8000 字符，会注入每次任务 |
| `capabilities` | 简短能力说明，出现在专家提示词里，让它知道自己的边界 |
| `tools` | 可用工具列表；`["*"]` 表示除主协作人专用 crew 工具外的全部会话工具 |
| `runtime` | `spawn`（默认）或 `codex`——见[运行后端](#运行后端) |
| `provider` / `model` | `spawn` 的可选模型路由，必须成对填写 |
| `codexProvider` | `codex` 使用的提供方行名，模型由那一行决定 |
| `maxAttempts` | 该专家任务的默认尝试上限（1–5） |
| `timeoutMs` | 默认单次时长上限 |

工具策略在**子智能体自己的作用域内**双层强制：`tools.guard()` 在调用时拒绝越权工具，`tools.restrict()` 把它们从子智能体的 schema 中移除。写记忆是隐式权限——只要专家能行动，就能记录学到的东西。

## 运行后端

| 后端 | 实际运行 | 工具白名单 | 记忆 | 模型 |
|---|---|---|---|---|
| **DSH 子智能体**（默认） | 进程内 DSH 子智能体 | 强制 | 强制 | 专家上的 `provider` + `model` |
| **Codex** | 原生 Codex 线程 | 不适用 | 不适用 | 取自 **codex 提供方那一行** |

Codex 线程在启动时从提供方实例读取模型（它的请求里没有模型字段），所以要让 Codex 用某个模型，在 profile 的 patch 里加一行并给它起名：

```yaml
- id: subagent-codex-sol
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-sol   # 专家在 codexProvider 里填这个名字
    model: gpt-6.1-sol
```

然后把该专家的「Codex 提供方」填成 `codex-sol`。表单会显示这一行是否已注册、带的哪个模型。如果专家指向一个未注册的提供方，任务会以 `CODEX_PROVIDER_MISSING` 失败并给出该补的那一行，而不是启动一个注定跑不通的运行。

> **Codex 运行是临时的（ephemeral）。** 它没有 DSH 会话，所以面板显示「外部运行 · 无本地会话记录」而不是给一个点不开的链接。它收到的提示词仍会被记录。

## 发起运行

按任务规模有两种形态。

### 单任务：`crew_task_dispatch`

默认**异步**，与原生 subagent 工具一致：立即返回 run id，运行在后台自行收敛。需要原地拿答案的短任务传 `wait: true`。

```jsonc
crew_task_dispatch({
  "profile_id": "tester",
  "subject": "补回归测试",
  "description": "覆盖审查报告里列出的未加保护入口，用 PHPUnit。报告你执行的命令和输出。",
  "timeout_ms": 1200000   // 20 分钟，慢任务留足时间
})
```

### 多任务：任务图

先建图，再执行。任务之间用 `key` 互相引用。

```jsonc
crew_run_create({
  "title": "登录模块加固",
  "objective": "清掉 src/auth 的越权风险，并用测试证明。",
  "maxParallel": 3
})
// → { run: { id: "run_…" } }

crew_task_add({
  "run_id": "run_…",
  "tasks": [
    { "profile_id": "reviewer", "subject": "审查 src/auth", "key": "audit",
      "description": "列出每个未加保护的入口并给 file:line。不要改文件。" },

    { "profile_id": "engineer", "subject": "修复缺口", "depends_on": ["audit"],
      "write_scopes": ["src/auth"],
      "description": "按审查结论补上缺失的权限校验，保持改动最小。" },

    { "profile_id": "tester",   "subject": "回归测试", "depends_on": ["audit"],
      "description": "为每个缺口写一个测试，要求修复前失败、修复后通过。" },

    { "profile_id": "writer",   "subject": "发布说明", "depends_on": ["fix", "tests"],
      "description": "面向开发者写两段：改了什么、为什么重要。" }
  ]
})

crew_run_start({ "run_id": "run_…" })
```

`engineer` 与 `tester` 会**并发执行**，因为它们都只依赖 `audit`；`writer` 要等两者都完成。

#### 执行过程

1. 任务的每个 `dependsOn` 都 `completed` 之后才会启动。
2. 就绪任务按波次执行，每波最多 `maxParallel` 个。
3. 可重试的失败按退避重试，直到尝试预算耗尽。
4. 失败任务会把下游标记为 `blocked`，错误码 `DEPENDENCY_FAILED`。
5. 运行以 `completed` / `failed` / `cancelled` 收敛，并生成一份汇总。

#### 你会看到的状态

| 运行 | 任务 |
|---|---|
| `planning` → `ready` → `running` → `completed` / `failed` / `cancelled` | `pending` → `running` → `completed` / `failed` / `blocked` / `cancelled` |

## 记忆

每个专家跨运行、跨会话保留自己的笔记。记忆按**这段文字怎么被使用**分层，而不是按主题：

| 层 | `kind` | 是否进入提示词 | 如何读取 |
|---|---|---|---|
| **索引** | `note`、`lesson` | **每次任务都注入**，上限 2400 字符 | 自动 |
| **专题** | `topic` | 从不 | 按标题按需读取，单条上限 6000 字符 |
| **日志** | `run` | 从不 | 按需读取，最新优先 |

这个区分很关键：一个专家只要跑过四十个任务，日志就会把它**亲手写下的知识**挤出提示词。现在历史再多也挤不掉真正重要的内容。

```jsonc
// 看一个专家知道什么
crew_agent_memory({ "profile_id": "reviewer", "action": "list" })
// → { total: 4, stats: { indexCount: 2, topicCount: 1, logCount: 1 }, notes: [...] }

// 教它一条经验
crew_agent_memory({
  "profile_id": "reviewer",
  "action": "add",
  "kind": "lesson",
  "text": "鉴权都在 middleware/auth.ts 里，控制器自己不校验。"
})

// 按层按需读取
crew_agent_memory({ "profile_id": "reviewer", "action": "read", "kind": "run", "limit": 5 })
```

专家自己也能写笔记（`crew_memory_note`）和读历史（`crew_memory_read`）——作用域绑定在自己身上，profile id 在注册时捕获，A 专家无法读到 B 的记忆。

## @ 提到专家

在输入框打 `@`，会出现 **专家** 分组，按名称、角色、记忆条数列出所有专家。选中后插入的是真正的引用 chip：

- 输入框里高亮、原子化；
- 发送后消息里渲染成可点击的 chip；
- 点这个 chip 会打开团队面板并定位到该专家。

wire 形式是 `@[显示名](dsh-agent:profile-id)`。消息里出现它时，主协作人会被要求**先委派**——读长文档是专家的活，不是主协作人的。

## 查看运行

```jsonc
// 最近的运行
crew_run_status({ "limit": 5 })

// 一次运行，含每个任务的尝试记录
crew_run_status({ "run_id": "run_…" })

// 完整结果文本
crew_run_status({ "run_id": "run_…", "include_results": true })
```

每次尝试都会记录运行后端、子会话 id、耗时、终止原因、错误码，以及专家**实际收到的提示词**。本地专家拥有真实 DSH 会话，面板提供**查看会话**；Codex 运行是临时的，会明确说明。

状态存于 `~/.dsh/agent-crew/state.json`——一份持久 JSON 文档，原子写入，可读可导出。

## 工具一览

| 工具 | 用途 |
|---|---|
| `crew_agent_create` | 新建或覆盖一个专家 |
| `crew_agent_list` | 列出专家及其工具、运行后端、记忆条数 |
| `crew_agent_delete` | 删除专家（已有运行保留历史） |
| `crew_agent_memory` | 读取或整理专家记忆：`list` / `read` / `add` / `forget` / `clear` |
| `crew_run_create` | 新建运行 |
| `crew_task_add` | 追加任务与 `dependsOn` 依赖 |
| `crew_run_start` | 执行任务图直到收敛 |
| `crew_run_status` | 查看运行、任务、尝试与错误 |
| `crew_task_dispatch` | 单任务派发，不显式建图 |
| `crew_task_retry` | 重试失败、阻塞或取消的任务 |
| `crew_run_cancel` | 打断在飞专家并取消运行 |
| `crew_memory_note` | *（专家侧）*在自己记忆里写一条 |
| `crew_memory_read` | *（专家侧）*读取自己的记忆分层 |

错误带稳定错误码：`PROFILE_INVALID`、`PROFILE_NOT_FOUND`、`RUN_NOT_FOUND`、`RUN_BUSY`、`RUN_CLOSED`、`RUN_EMPTY`、`TASK_NOT_FOUND`、`TASK_INVALID`、`TASK_LIMIT_REACHED`、`TASK_NOT_RETRYABLE`、`DEPENDENCY_UNKNOWN`、`DEPENDENCY_CYCLE`、`DEPENDENCIES_UNMET`、`CODEX_PROVIDER_MISSING`、`MEMORY_INVALID`、`NO_CALLER`。

## 配置

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: agent-crew
  name: '@local/dsh-agent-crew'
  config:
    maxParallel: 3
    defaultMaxAttempts: 2
    taskTimeoutMs: 900000
    profiles:
      - id: reviewer
        name: 代码审查员
        role: 关注越权与注入风险的代码审查员
        instructions: 找出授权缺口，每条都给 file:line。
        tools: [read, grep, glob]
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `dataDir` | `~/.dsh/agent-crew` | 状态目录 |
| `provider` | `spawn` | 本地专家使用的提供方 |
| `codexProvider` | `codex` | Codex 专家使用的提供方 |
| `defaultMaxAttempts` | `2` | 每任务尝试次数（1–5） |
| `maxParallel` | `3` | 单次运行并发任务数（1–16） |
| `taskTimeoutMs` | `600000` | 单次尝试上限（10 分钟） |
| `retryBackoffMs` | `750` | 退避基数，乘以第几次重试 |
| `maxResultChars` | `12000` | 每任务保留的结果文本上限 |
| `maxTasksPerRun` | `64` | 单运行任务上限（1–256） |
| `maxRuns` | `50` | 保留的已结束运行数 |
| `allowNestedOrchestration` | `false` | 允许专家再建自己的 crew |

`profiles` 在激活时作为种子写入。在面板里编辑过的专家会保留已存储版本，种子不会覆盖你的改动。

## 示例

### 三段式评审流水线

```jsonc
crew_run_create({ "title": "发布前评审", "objective": "带证据地发布 1.4。" })
crew_task_add({ "run_id": "run_…", "tasks": [
  { "profile_id": "reviewer", "subject": "审查 diff", "key": "rev",
    "description": "对照 main 审查改动，按严重程度分组，每条给 file:line。" },
  { "profile_id": "tester", "subject": "跑测试", "key": "test", "depends_on": ["rev"],
    "description": "跑测试套件，失败要给出确切命令和输出。" },
  { "profile_id": "writer", "subject": "起草说明", "depends_on": ["rev", "test"],
    "description": "面向开发者写发布说明，200 字以内。" }
]})
crew_run_start({ "run_id": "run_…" })
```

### 不同专家并行审计

```jsonc
crew_task_add({ "run_id": "run_…", "tasks": [
  { "profile_id": "security", "subject": "越权审计", "key": "authz",
    "write_scopes": ["report/authz.md"], "description": "列出每个未加保护的路由。" },
  { "profile_id": "perf", "subject": "查询审计", "key": "perf",
    "write_scopes": ["report/perf.md"], "description": "找出卡片服务里的 N+1 查询。" },
  { "profile_id": "writer", "subject": "合并报告", "depends_on": ["authz", "perf"],
    "description": "把两份报告合并成一份按风险排序的总结。" }
]})
```

两个审计并行跑，合并等两者都完成。`write_scopes` 保证它们不碰对方的文件。

### 用 Codex 专家跑长时间实现

```jsonc
crew_agent_create({
  "id": "impl",
  "name": "实现者",
  "role": "端到端实现一份书面方案",
  "runtime": "codex",
  "codexProvider": "codex-sol",
  "instructions": "按方案文档实现，汇报前先跑测试。不要提交。"
})

crew_task_dispatch({
  "profile_id": "impl",
  "subject": "实现导出方案",
  "description": "读 docs/export-plan.md 并实现。跑方案里列的检查命令并贴出输出。",
  "timeout_ms": 1800000,   // 30 分钟，这种体量的方案需要时间
  "wait": true
})
```

### 把学到的东西留在专家身上

```jsonc
// 一次运行后，把可复用的部分留下
crew_agent_memory({
  "profile_id": "reviewer",
  "action": "add",
  "kind": "lesson",
  "text": "这个仓库把鉴权藏在 middleware/auth.ts，控制器自己从不校验。"
})

// 下一个任务的提示词开头就会带上它
crew_task_dispatch({ "profile_id": "reviewer", "subject": "审查 PR 812", "description": "…" })
```

## 与现有机制的关系

crew 成员就是普通 DSH subagent。委派走 `ctx.subagents.startActivation()` 且 `delivery: 'parent'`——与原生 subagent 工具同一条路径，所以运行结束会送达完成通知并唤醒空闲的主协作人。`agent/created` 监听器在子智能体**自己的作用域**内、第一步之前装上工具策略。

| 你的需求 | 应当使用 |
|---|---|
| 一次性委派，不需要可复用角色 | 内置 `subagent` 工具 |
| 可复用角色、工具策略、记忆、重试 | **Agent crew** |
| 多成员共享任务板、自行认领 | `agentTeams` |
| 脚本化扇出几十个同构任务 | `workflow` 工具 |

运行状态是插件数据而非会话历史：它**不写入 Session 日志**，因此不影响 Session 格式版本与重放。

完整设计（数据模型、时序图、分发/汇总/重试流程）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；验证记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 已知限制

- `crew_run_start` 同步执行；长任务图会占用主协作人这一轮。单个长任务建议用 `crew_task_dispatch` 并给足 `timeout_ms`。
- 状态是单进程的一份 JSON 文档，不做跨进程协调。
- 角色约束 = 独立角色提示词 + 工具收窄，不绑定 Agent Preset。
- Codex 运行是临时的：没有会话，因此没有工具策略、没有记忆、也没有可打开的会话记录。
- 死进程留下的 `running` 运行会在下次激活时以 `INTERRUPTED` 收敛为 `cancelled`。
- `writeScopes` 仅作提示，与内置 Team 语义一致。

## 许可证

MIT © 2026 ligudian
