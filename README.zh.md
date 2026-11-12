# 智能体团队（Agent crew）

把「一个助手」变成「一支团队」的 DSH 插件。你可以定义可复用的专家智能体（角色、常驻指令、能力、**可用工具**、可选模型路由、重试上限），再由主协作人（Lead）把目标拆成任务图、逐个委派、汇总结果并自动重试失败任务。

## 在哪里找到它

安装后，左侧边栏会出现 **智能体团队** 入口（位于「计划任务」与「Skills」之间）。点开是管理页，布局参照本机 OpenMausBot 的机器人面板：左侧是可搜索的专家花名册，右侧是分区详情（角色、常驻指令、能力、可用工具、模型路由、相关运行），另有 **运行** Tab 展示分段进度条与逐个任务的历史，并支持新建、编辑、删除专家。发起协作仍在对话里完成——那里才有可被委派的主协作人。

## 提供的能力

- **专家档案**：持久化的智能体定义。工具白名单双层强制：`tools.guard()` 在调用时拒绝越权工具，`tools.restrict()` 让其从子智能体 schema 中消失；crew 编排工具默认不下放。每个专家可选**运行后端**：`spawn`（进程内 DSH 子智能体，强制工具与记忆）或 `codex`（原生 Codex 线程，用它自己的沙箱）。
- **三层记忆**：每个专家有自己的笔记。人工整理的**索引**（`note`/`lesson`）每次任务都注入；**专题**与自动**日志**不进提示词、按需读取，所以历史不会挤占真正重要的内容。
- **主协作人编排**：`crew_run_create` 建运行 → `crew_task_add` 加任务与依赖 → `crew_run_start` 按波次执行并返回汇总。
- **受控执行**：单次尝试超时、指数式退避重试、依赖失败自动 `blocked`、取消时打断在飞子智能体、activation 及时释放容量。
- **可审计状态**：`~/.dsh/agent-crew/state.json` 记录每次尝试的子会话 id、耗时、终止原因与错误码。
- **侧边栏管理页**：左侧导航一个入口，列出专家与运行，可直接新建/编辑/删除专家，无需手写工具调用。页面只读插件自己的 Host 路由 `api/agent-crew`，浏览器没有文件系统权限。

## 工具一览

| 工具 | 用途 |
|---|---|
| `crew_agent_create` / `crew_agent_list` / `crew_agent_delete` | 管理专家档案 |
| `crew_run_create` / `crew_task_add` | 规划运行与依赖图 |
| `crew_run_start` | 执行到收敛并返回汇总 |
| `crew_run_status` | 查看运行、任务、尝试与错误 |
| `crew_task_dispatch` | 单任务即时委派 |
| `crew_task_retry` / `crew_run_cancel` | 恢复失败任务 / 取消运行 |

## 与 DSH 的集成方式

所有委派都走 `ctx.subagents.startActivation()`（`delivery: 'caller'`），因此 crew 成员就是普通 subagent：出现在会话树中、可被继续对话、随运行时的容量与清理规则管理。插件在 `agent/created` 事件里用 `tools.restrict()` 把工具白名单注册到该子智能体自己的作用域，第一次步骤装配前即生效。

完整设计（数据模型、时序图、任务分发 / 结果汇总 / 失败重试流程、与 `subagent`、`agentTeams`、`workflow` 的取舍）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 运行后端

每个专家可选一种后端：

| 后端 | 实际运行 | 工具白名单 | 记忆 | 模型 |
|---|---|---|---|---|
| `DSH 子智能体`（默认） | 进程内 DSH 子智能体 | 强制 | 强制 | 专家上的 `provider` + `model` |
| `Codex` | 原生 Codex 线程 | 不适用 | 不适用 | 取自 **codex 提供方那一行**，不是专家本身 |

Codex 线程在启动时从提供方实例读取模型，所以要让 Codex 用某个模型，在 profile 的 patch 里加一行并给它起名：

```yaml
- id: subagent-codex-sol
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-sol   # 专家在 codexProvider 里填这个名字
    model: gpt-6.1-sol
```

然后把该专家的「Codex 提供方」填成 `codex-sol`。表单会显示这一行是否已注册、带的哪个模型。
如果专家指向一个未注册的提供方，任务会以 `CODEX_PROVIDER_MISSING` 失败并给出该补哪一行，
而不是启动一个注定跑不通的运行。

## 配置示例

```yaml
- id: agent-crew
  name: '@local/dsh-agent-crew'
  config:
    provider: spawn
    maxParallel: 3
    defaultMaxAttempts: 2
    taskTimeoutMs: 600000
    retryBackoffMs: 750
    profiles:
      - id: reviewer
        name: 代码审查员
        role: 关注越权与注入风险的代码审查员
        instructions: 审查改动，指出授权缺口并引用 file:line。
        tools: [read, grep, glob]
```

## 已知限制

- `crew_run_start` 同步执行；超长运行会占用主协作人的这一轮。
- 状态是单进程 JSON 文档，不做跨进程协调。
- 角色约束 = 独立角色提示词 + 工具收窄，不绑定 Agent Preset。
- 暂无 Web UI，可通过 `crew_run_status` 或 `ctx.agentCrew` 服务查看。
- `writeScopes` 仅作提示，不阻塞并发写（与内置 Team 语义一致）。
