# Agent crew

A DSH plugin that turns one assistant into a staffed team. You define reusable specialist agents — role, instructions, capabilities, and the exact tools each may call — then let the lead agent decompose a goal into a task graph, delegate every task, aggregate the results, and retry failures.

## Where to find it

After installation, an **Agent crew** row appears in the left sidebar, between **Schedules** and **Skills**. It opens a management page in the same shape as a bot workspace: a searchable specialist roster on the left, a sectioned detail pane on the right (role, standing instructions, capabilities, tools, model route, related runs), a **Runs** tab with segmented progress and per-task history, and create/edit/delete controls. Starting a crew still happens in a conversation, where a lead Agent exists to delegate to.

## What it adds

- **Specialist profiles** — persistent definitions with a validated id, role, standing instructions, capability list, tool allow-list, optional model route, default attempt/time limits, and a **runtime**: `spawn` (in-process DSH child, tool list and memory enforced) or `codex` (native Codex thread with its own sandbox).
- **Enforced tool policy** — an allow-list is enforced twice: a `tools.guard()` denies out-of-policy calls at dispatch, and `tools.restrict()` removes them from the child's schema. Lead-only crew tools are withheld by default.
- **Three-tier memory** — each specialist keeps its own notes. The curated **index** (`note`, `lesson`) is injected into every task prompt; **topics** and the automatic **log** stay out of the prompt and are read on demand, so history never crowds out what matters.
- **Lead orchestration** — `crew_run_create` opens a run, `crew_task_add` adds tasks with `dependsOn` edges and advisory write scopes, `crew_run_start` executes ready tasks in waves and returns one aggregated report.
- **Bounded execution** — per-attempt time limits, retry with backoff, dependency-failure propagation (`blocked`), capacity-safe disposal, and run cancellation that interrupts in-flight children.
- **Auditable state** — every attempt keeps its child id, name, duration, stop reason, and error code in `~/.dsh/agent-crew/state.json`.
- **Sidebar management page** — one row in the left navigation lists specialists and runs, and lets you create, edit, and delete specialists without typing a tool call. The page reads the Host route `api/agent-crew`; the browser has no filesystem authority.

## Tools

| Tool | Purpose |
|---|---|
| `crew_agent_create` / `crew_agent_list` / `crew_agent_delete` | Manage specialist profiles |
| `crew_run_create` / `crew_task_add` | Plan a run and its dependency graph |
| `crew_run_start` | Execute to completion and return the summary |
| `crew_run_status` | Read runs, tasks, attempts, and errors |
| `crew_task_dispatch` | Delegate one task without an explicit run |
| `crew_task_retry` / `crew_run_cancel` | Recover a failed task / stop a run |

## How it integrates

Crew members are ordinary DSH subagents: delegation goes through `ctx.subagents.startActivation()` with `delivery: 'caller'`, so the plugin aggregates results instead of flooding the lead with completion notices. An `agent/created` listener installs each child's tool policy inside that child's own agent scope, before its first step. Profiles never carry credentials; the state file is `0600` and written atomically.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, data model, sequence diagrams, dispatch/aggregation/retry flows, and the comparison with `subagent`, `agentTeams`, and `workflow`.

## Runtimes

A specialist runs on one of two backends, chosen per profile:

| Runtime | What runs | Tool allow-list | Memory | Model |
|---|---|---|---|---|
| `DSH subagent` (default) | in-process DSH child | enforced | enforced | `provider` + `model` on the profile |
| `Codex` | native Codex thread | not applicable | not applicable | taken from the **codex provider row**, not the profile |

A Codex thread reads its model from the provider instance at start time, so to
run Codex on a particular model add a row to the profile patch and name it:

```yaml
- id: subagent-codex-sol
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-sol   # the name a specialist puts in `codexProvider`
    model: gpt-6.1-sol
```

Then set that specialist's **Codex provider** to `codex-sol`. The form reports
whether the named row is registered and which model it carries. A specialist
naming an unregistered provider fails with `CODEX_PROVIDER_MISSING` and the exact
row to add, rather than starting a run that cannot work.

## Configuration

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
        name: Code reviewer
        role: security-focused code reviewer
        instructions: Review the diff for authorization gaps and cite file:line.
        tools: [read, grep, glob]
```

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.dsh/agent-crew` | State directory |
| `provider` | `spawn` | Subagent provider used for delegation |
| `defaultMaxAttempts` | `2` | Attempts per task (1–5) |
| `maxParallel` | `3` | Concurrent tasks per run (1–16) |
| `taskTimeoutMs` | `600000` | Per-attempt limit; `0` disables it |
| `retryBackoffMs` | `750` | Base delay, multiplied by the attempt number |
| `maxResultChars` | `12000` | Result text retained per task |
| `maxTasksPerRun` | `64` | Task bound per run |
| `maxRuns` | `50` | Settled runs retained |
| `allowNestedOrchestration` | `false` | Let specialists run their own crews |

## Limitations

- `crew_run_start` runs synchronously; a long run occupies the lead's turn.
- State is a single-process JSON document; there is no cross-process coordination.
- Role enforcement combines a standalone role prompt with tool restriction; it does not pin an Agent Preset.
- No Web UI yet; read state through `crew_run_status` or the `ctx.agentCrew` service.
- `writeScopes` is advisory, matching the built-in Team semantics.
