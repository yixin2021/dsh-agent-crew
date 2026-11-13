# Agent crew

A DSH plugin that turns one assistant into a staffed team.

You define reusable **specialists** — role, standing instructions, capabilities,
and the exact tools each may call. A **lead** agent then decomposes a goal into a
dependency graph, delegates every task to the right specialist, aggregates the
results, retries what is worth retrying, and reports once at the end.

Each specialist runs on its own runtime, keeps its own three-tier memory across
sessions, and appears as a clickable mention in the conversation.

```
you ──▶ lead ──▶ task graph ──▶ specialists (spawn | codex)
                 │                    │
                 └── results ◀────────┘
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Where to find it](#where-to-find-it)
- [Specialists](#specialists)
- [Runtimes](#runtimes)
- [Producing a run](#producing-a-run)
- [Memory](#memory)
- [Mentioning a specialist](#mentioning-a-specialist)
- [Inspecting a run](#inspecting-a-run)
- [Tools](#tools)
- [Configuration](#configuration)
- [Examples](#examples)
- [How it integrates](#how-it-integrates)
- [Limitations](#limitations)

## Install

Enable **Agent crew** in the DSH **Plugins** page, or install the bundle:

```
plugin_manager install_bundle github:yixin2021/dsh-agent-crew
```

Restart when the installer reports that one is required. The plugin needs no
credentials: profiles never store secrets, and its state file is `0600`.

## Quick start

Define one specialist and give it one job.

```jsonc
// 1. Define a specialist
crew_agent_create({
  "id": "reviewer",
  "name": "Code reviewer",
  "role": "security-focused code reviewer",
  "instructions": "Find authorization gaps. Cite file:line for every finding.",
  "capabilities": ["diff review", "threat modeling"],
  "tools": ["read", "grep", "glob"]
})

// 2. Delegate one task (asynchronous by default)
crew_task_dispatch({
  "profile_id": "reviewer",
  "subject": "Review the login change",
  "description": "Review src/auth/login.ts for missing permission checks. List every unguarded entry point with file:line. Do not modify files."
})
// → { run: { id: "run_mc4x1k_ab12cd", status: "ready" } }

// 3. Read the result when it settles
crew_run_status({ "run_id": "run_mc4x1k_ab12cd", "include_results": true })
```

A completion notice arrives on its own when the run settles, so step 3 is only
needed when you want the detail inline.

## Where to find it

An **Agent crew** row appears in the left sidebar, between **Schedules** and
**Skills**. It opens a management page:

| Area | What it shows |
|---|---|
| **Specialists** | Searchable roster on the left; sectioned detail on the right — role, instructions, capabilities, tools, runtime, model route, memory, related runs |
| **Runs** | Segmented progress per run (completed / failed / blocked / cancelled), expandable into per-task history |
| **Task detail** | Every attempt with its runtime, stop reason, duration, the prompt it received, and a **transcript link** for local specialists |

You can create, edit, and delete specialists here without typing a tool call.
Starting a run still happens in a conversation, where a lead Agent exists to
delegate to.

## Specialists

A specialist is a durable definition, not a live process.

| Field | Meaning |
|---|---|
| `id` | Stable identity, `^[a-z][a-z0-9-]{0,31}$`, cannot change after saving |
| `name` / `role` | Display name and one-line role |
| `instructions` | Standing operating instructions, up to 8000 characters, injected into every task |
| `capabilities` | Short statements shown in the specialist's prompt, so it knows its own scope |
| `tools` | Tool allow-list; `["*"]` means every session tool **except** the lead-only crew tools |
| `runtime` | `spawn` (default) or `codex` — see [Runtimes](#runtimes) |
| `provider` / `model` | Optional model route for `spawn`; must be set together |
| `codexProvider` | Provider row name for `codex`; the model comes from that row |
| `maxAttempts` | Default attempt bound for its tasks (1–5) |
| `timeoutMs` | Default per-attempt limit |

Tool policy is enforced in two layers inside the child's own agent scope: a
`tools.guard()` denies out-of-policy calls at dispatch, and `tools.restrict()`
removes them from the child's schema. Memory writing is implicit — a specialist
that may act at all may also record what it learned.

## Runtimes

| Runtime | What runs | Tool allow-list | Memory | Model |
|---|---|---|---|---|
| **DSH subagent** (default) | in-process DSH child | enforced | enforced | `provider` + `model` on the profile |
| **Codex** | native Codex thread | not applicable | not applicable | taken from the **codex provider row** |

A Codex thread reads its model from the provider instance at start time — its
request has no model field — so to run Codex on a particular model, add a row to
the profile patch and name it:

```yaml
- id: subagent-codex-sol
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-sol   # the name a specialist puts in `codexProvider`
    model: gpt-6.1-sol
```

Then set that specialist's **Codex provider** to `codex-sol`. The form reports
whether the row is registered and which model it carries. Naming an unregistered
provider fails with `CODEX_PROVIDER_MISSING` and the exact row to add, instead of
starting a run that cannot work.

> **Codex runs are ephemeral.** They have no DSH session, so the panel says
> *external run · no local transcript* rather than offering a link. The prompt it
> received is still recorded.

## Producing a run

Two shapes, depending on the size of the job.

### One task: `crew_task_dispatch`

Asynchronous by default, like the native subagent tool: it returns the run id and
the run settles in the background. Pass `wait: true` for a quick job you want the
answer from inline.

```jsonc
crew_task_dispatch({
  "profile_id": "tester",
  "subject": "Add regression tests",
  "description": "Cover the unguarded entry points listed in the review. Use PHPUnit. Report the command you ran and its output.",
  "timeout_ms": 1200000   // 20 minutes for a slower job
})
```

### Many tasks: a graph

Build the graph first, then execute it. Tasks reference each other by `key`.

```jsonc
crew_run_create({
  "title": "Harden the login module",
  "objective": "Remove the authorization gaps in src/auth and prove it with tests.",
  "maxParallel": 3
})
// → { run: { id: "run_…" } }

crew_task_add({
  "run_id": "run_…",
  "tasks": [
    { "profile_id": "reviewer", "subject": "Audit src/auth", "key": "audit",
      "description": "List every unguarded entry point with file:line. Do not change files." },

    { "profile_id": "engineer", "subject": "Fix the gaps", "depends_on": ["audit"],
      "write_scopes": ["src/auth"],
      "description": "Add the missing permission checks listed by the audit. Keep the diff minimal." },

    { "profile_id": "tester",   "subject": "Regression tests", "depends_on": ["audit"],
      "description": "Cover each gap with a test that fails without the fix." },

    { "profile_id": "writer",   "subject": "Release note", "depends_on": ["fix", "tests"],
      "description": "Two paragraphs for developers: what changed and why it matters." }
  ]
})

crew_run_start({ "run_id": "run_…" })
```

`engineer` and `tester` run **concurrently** because both depend only on
`audit`. `writer` waits for both.

#### How execution proceeds

1. A task starts only when every `dependsOn` task is `completed`.
2. Ready tasks run in waves of up to `maxParallel`.
3. A retryable failure is retried with backoff, up to the attempt bound.
4. A failed task blocks its dependents with `DEPENDENCY_FAILED`.
5. The run settles as `completed`, `failed`, or `cancelled`, with one summary.

#### Statuses you will see

| Run | Task |
|---|---|
| `planning` → `ready` → `running` → `completed` / `failed` / `cancelled` | `pending` → `running` → `completed` / `failed` / `blocked` / `cancelled` |

## Memory

Each specialist keeps its own notes across runs and sessions. Memory is split by
*how the text is used*, not by topic:

| Tier | `kind` | Enters the prompt | Reached by |
|---|---|---|---|
| **Index** | `note`, `lesson` | **every task**, bounded to 2400 chars | automatic |
| **Topics** | `topic` | never | on demand by title, up to 6000 chars each |
| **Log** | `run` | never | on demand, newest first |

The separation matters: a specialist that has merely run forty jobs would
otherwise push its own hand-written knowledge out of the prompt. History now
cannot crowd out what matters.

```jsonc
// See what a specialist knows
crew_agent_memory({ "profile_id": "reviewer", "action": "list" })
// → { total: 4, stats: { indexCount: 2, topicCount: 1, logCount: 1 }, notes: [...] }

// Teach it something durable
crew_agent_memory({
  "profile_id": "reviewer",
  "action": "add",
  "kind": "lesson",
  "text": "Authz lives in middleware/auth.ts; the controllers never check it themselves."
})

// Read one tier on demand
crew_agent_memory({ "profile_id": "reviewer", "action": "read", "kind": "run", "limit": 5 })
```

Specialists also write their own notes (`crew_memory_note`) and read their own
history (`crew_memory_read`) — scoped to themselves, with the profile id bound at
registration so one cannot address another.

## Mentioning a specialist

Type `@` in the composer. A **Specialists** group lists every profile by name,
role, and memory count. A pick inserts a real reference chip:

- the composer shows it highlighted and atomic;
- the sent message renders it as a clickable chip;
- clicking that chip opens the crew panel on that specialist.

The wire form is `@[display name](dsh-agent:profile-id)`. When a message contains
one, the lead is told to **dispatch first** — reading a long plan is the
specialist's job, not the lead's.

## Inspecting a run

```jsonc
// Recent runs
crew_run_status({ "limit": 5 })

// One run, with each task's attempts
crew_run_status({ "run_id": "run_…" })

// Full result text
crew_run_status({ "run_id": "run_…", "include_results": true })
```

Every attempt records its runtime, child id, duration, stop reason, error code,
and the prompt the specialist received. A local specialist owns a real DSH
session, so the panel offers **Open transcript**; a Codex run is ephemeral and
says so.

State lives in `~/.dsh/agent-crew/state.json` — one durable JSON document, written
atomically, readable and exportable.

## Tools

| Tool | Purpose |
|---|---|
| `crew_agent_create` | Create or replace a specialist |
| `crew_agent_list` | List specialists, their tools, runtime, and memory count |
| `crew_agent_delete` | Remove a specialist (existing runs keep their history) |
| `crew_agent_memory` | Read or curate a specialist's memory: `list` / `read` / `add` / `forget` / `clear` |
| `crew_run_create` | Open a run |
| `crew_task_add` | Append tasks with `dependsOn` edges |
| `crew_run_start` | Execute the graph to settlement |
| `crew_run_status` | Read runs, tasks, attempts, and errors |
| `crew_task_dispatch` | Delegate one task without an explicit run |
| `crew_task_retry` | Retry a failed, blocked, or cancelled task |
| `crew_run_cancel` | Interrupt in-flight specialists and cancel the run |
| `crew_memory_note` | *(specialist side)* record a note in its own memory |
| `crew_memory_read` | *(specialist side)* read its own memory tiers |

Typed errors carry stable codes: `PROFILE_INVALID`, `PROFILE_NOT_FOUND`,
`RUN_NOT_FOUND`, `RUN_BUSY`, `RUN_CLOSED`, `RUN_EMPTY`, `TASK_NOT_FOUND`,
`TASK_INVALID`, `TASK_LIMIT_REACHED`, `TASK_NOT_RETRYABLE`,
`DEPENDENCY_UNKNOWN`, `DEPENDENCY_CYCLE`, `DEPENDENCIES_UNMET`,
`CODEX_PROVIDER_MISSING`, `MEMORY_INVALID`, `NO_CALLER`.

## Configuration

Written into the profile's `cordis.patch.yml`:

```yaml
- id: agent-crew
  name: '@local/dsh-agent-crew'
  config:
    maxParallel: 3
    defaultMaxAttempts: 2
    taskTimeoutMs: 900000
    profiles:
      - id: reviewer
        name: Code reviewer
        role: security-focused code reviewer
        instructions: Find authorization gaps. Cite file:line for every finding.
        tools: [read, grep, glob]
```

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.dsh/agent-crew` | State directory |
| `provider` | `spawn` | Provider used for local specialists |
| `codexProvider` | `codex` | Provider used for Codex specialists |
| `defaultMaxAttempts` | `2` | Attempts per task (1–5) |
| `maxParallel` | `3` | Concurrent tasks per run (1–16) |
| `taskTimeoutMs` | `600000` | Per-attempt limit (10 minutes) |
| `retryBackoffMs` | `750` | Base delay, multiplied by the attempt number |
| `maxResultChars` | `12000` | Result text retained per task |
| `maxTasksPerRun` | `64` | Task bound per run (1–256) |
| `maxRuns` | `50` | Settled runs retained |
| `allowNestedOrchestration` | `false` | Let specialists run their own crews |

`profiles` seeds definitions at activation. A specialist edited in the panel keeps
its stored revision, so a seed never overwrites your changes.

## Examples

### A three-stage review pipeline

```jsonc
crew_run_create({ "title": "Release review", "objective": "Ship 1.4 with evidence." })
crew_task_add({ "run_id": "run_…", "tasks": [
  { "profile_id": "reviewer", "subject": "Review the diff", "key": "rev",
    "description": "Review the diff against main. Group findings by severity. Cite file:line." },
  { "profile_id": "tester", "subject": "Run the suite", "key": "test", "depends_on": ["rev"],
    "description": "Run the test suite. Report failures with the exact command and output." },
  { "profile_id": "writer", "subject": "Draft the note", "depends_on": ["rev", "test"],
    "description": "Write the release note for developers. Under 200 words." }
]})
crew_run_start({ "run_id": "run_…" })
```

### Parallel auditing with different specialists

```jsonc
crew_task_add({ "run_id": "run_…", "tasks": [
  { "profile_id": "security", "subject": "Authorization audit", "key": "authz",
    "write_scopes": ["report/authz.md"], "description": "List every unguarded route." },
  { "profile_id": "perf", "subject": "Query audit", "key": "perf",
    "write_scopes": ["report/perf.md"], "description": "Find N+1 queries in the card service." },
  { "profile_id": "writer", "subject": "Merge the reports", "depends_on": ["authz", "perf"],
    "description": "Merge both reports into one summary ordered by risk." }
]})
```

The two audits run together; the merge waits for both. Write scopes keep them off
each other's files.

### A Codex specialist for a long implementation

```jsonc
crew_agent_create({
  "id": "impl",
  "name": "Implementer",
  "role": "implements a written plan end to end",
  "runtime": "codex",
  "codexProvider": "codex-sol",
  "instructions": "Follow the plan document. Run the tests before reporting. Never commit."
})

crew_task_dispatch({
  "profile_id": "impl",
  "subject": "Implement the export plan",
  "description": "Read docs/export-plan.md and implement it. Run the checks the plan lists and paste the output.",
  "timeout_ms": 1800000,   // 30 minutes: a plan this size takes a while
  "wait": true
})
```

### Teaching a specialist what it learned

```jsonc
// After a run, keep the durable part
crew_agent_memory({
  "profile_id": "reviewer",
  "action": "add",
  "kind": "lesson",
  "text": "This repo hides authz in middleware/auth.ts; controllers never check it."
})

// The next task's prompt now starts with it
crew_task_dispatch({ "profile_id": "reviewer", "subject": "Review PR 812", "description": "…" })
```

## How it integrates

Crew members are ordinary DSH subagents. Delegation goes through
`ctx.subagents.startActivation()` with `delivery: 'parent'`, the same path the
native subagent tool uses, so a settled run delivers a completion notice and
wakes an idle lead. An `agent/created` listener installs each child's tool policy
inside that child's own agent scope, before its first step.

| You need | Use |
|---|---|
| One-off delegation, no reusable role | the built-in `subagent` tool |
| Reusable roles, tool policy, memory, retries | **Agent crew** |
| A shared board members claim work from | `agentTeams` |
| Scripted fan-out across dozens of similar tasks | the `workflow` tool |

The run state is plugin data, not session history: it is not written into the
Session log, so it does not affect Session format versions or replay.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, sequence
diagrams, and the full dispatch/aggregation/retry design. Read
[docs/VERIFICATION.md](docs/VERIFICATION.md) for what was tested and how.

## Limitations

- `crew_run_start` executes synchronously; a long graph occupies the lead's turn.
  Prefer `crew_task_dispatch` with `timeout_ms` for a single long job.
- State is one JSON document in a single process; there is no cross-process
  coordination.
- Role enforcement is a standalone role prompt plus tool restriction; it does not
  pin an Agent Preset.
- Codex runs are ephemeral: no session, so no tool policy, no memory, and no
  transcript to reopen.
- A run left `running` by a dead process is closed as `cancelled` with
  `INTERRUPTED` on the next activation.
- `writeScopes` is advisory, matching the built-in Team semantics.

## License

MIT © 2026 ligudian
