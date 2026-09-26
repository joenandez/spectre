# Execute workflow events

Load for structured `tasks.json` and plan-direct execution. Plan-direct passes its plan as `--source`, uses stable `ws-<n>` ids, and emits workstream events only. Source artifacts are immutable; the workflow store owns lifecycle/progress.

## Start or resume

Run once after resolving source (`TASKS_JSON`, or `PLAN_SOURCE`), `FEATURE_ROOT`, and caller-owned `ORIGIN` (`plan` or `fix`). Omit unknown origin:

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" run start --source "$TASKS_JSON" --owner "$FINALIZATION_OWNER" --project-dir "$PROJECT_ROOT" --json
```

Append `--origin "$ORIGIN"` only when known. Keep returned `runId` as `RUN_ID`, `primaryActorId` as `PRIMARY_ACTOR_ID`, and transient `measurementSnapshot` only in caller memory; pass it to terminal `run finish`. Start `execute`, phases, and waves with stable idempotency keys from run + boundary/task/attempt.

When routing is known, append `--provider "<provider>" --model "<primary-model>" --effort "<effort>"`. Omit unknowns. Retain only origin, execution shape, category, elapsed time, aggregate token totals, and primary/worker reconciliation; no host ids, raw counters, prompts, transcripts, commands, code, or child output. Missing snapshots leave token fields `unavailable`.

Telemetry is supporting state, not acceptance truth. On operational/lock/write failure, set `TELEMETRY_STATUS=degraded`, continue from source plus verified context, and report the coded failure. Telemetry failure is degraded and never blocks delivery.

For the optional Plan join, hash the full source artifact and run:

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" plan match --feature-root "$FEATURE_ROOT" --artifact-hash "$PLAN_SOURCE_HASH" --project-dir "$PROJECT_ROOT" --json
```

It returns exactly one matching `plan.completed` event by feature root plus artifact/source hash; retain `planRunId` and `scopeHash`. Zero or multiple matches degrade only the join; never guess from recency, branch, lifecycle, or summaries.

## Resume after compaction

Recover progress from the store, never memory or the working tree:

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" run start --source "$TASKS_JSON" --project-dir "$PROJECT_ROOT" --json
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" run status --run-id "$RUN_ID" --project-dir "$PROJECT_ROOT" --json
```

A matching active/blocked run returns `resumed: true` with the same `runId` and `primaryActorId`; `run status` reports one status per task id.

| Reported | Trust rule |
|---|---|
| `completed` | Accepted against a passing verification gate. Do not redo. |
| `skipped` | Terminally excluded with a recorded reason. Do not redo. |
| `blocked` | A real blocker was recorded. Resolve or escalate; never treat as done. |
| `in_progress` | Dispatched, started, or submitted—**not** accepted. Assume nothing landed; re-dispatch. |
| `pending` | Never dispatched. Normal frontier work. |

Everything outside `completed` and `skipped` is redo-or-verify. A worker submission is never acceptance without a passing gate. On `INVALID_TASK_TRANSITION`, re-read and continue; never force the event.

## Dispatch and worker ownership

Emit dispatch; the store moves selected tasks to `in_progress`. Never hand-write status.

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" agent dispatch --run-id "$RUN_ID" --actor-id "$PRIMARY_ACTOR_ID" --tasks "<comma-separated parent+subtask ids>" --attempt <N> --idempotency-key "dispatch:$RUN_ID:<batch>:<N>" --project-dir "$PROJECT_ROOT" --json
```

When routing is known, append `--provider "<provider>" --model "<worker-model>" --effort "<effort>"`. Retain transient `measurementSnapshot` and host child identity only in primary memory. Pass returned `workerActorId`, `assignmentId`, exact task ids/attempt, provider/model/effort, project root, and command name `node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs"` inside `<workflow_telemetry>`. Omit unknowns. The worker:

1. emits `agent start`;
2. emits `task start` immediately before each assigned parent/subtask;
3. emits `task submit` after implementation and focused checks are ready;
4. emits `task block` for a genuine blocked assignment;
5. emits `agent finish` before its Completion Report.

After the Completion Report, the primary emits one observation-only aggregate measurement:

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" agent measure --run-id "$RUN_ID" --actor-id "$PRIMARY_ACTOR_ID" --worker-actor-id "$WORKER_ACTOR_ID" --child-agent-id "$CHILD_AGENT_ID" --measurement-snapshot '<dispatch returned JSON>' --project-dir "$PROJECT_ROOT" --json
```

`CHILD_AGENT_ID` is transient host identity, never a workflow actor id. This may record `unavailable` and never blocks delivery. Do not ask the worker to persist/report snapshots, child ids, raw counters, host counters, prompts, output, or commands. Retain only aggregate tokens.

Only a `repair-policy.md` follow-up may use `task start`/`task submit` with `PRIMARY_ACTOR_ID`; planned work always has a worker actor. Missing worker submission may be reconciled only from returned evidence with `--source-kind primary-reconciliation`.

## Verification and acceptance

Start/finish waves and phases with typed commands. After affected checks, record one verification gate with task ids and stable check ids; HEAD SHA is automatic:

```bash
node "${PLUGIN_ROOT}/hooks/scripts/workflow-cli.mjs" gate record --run-id "$RUN_ID" --actor-id "$PRIMARY_ACTOR_ID" --kind verification --status pass --tasks "<ids>" --checks "<stable-check-ids>" --wave-id "<wave>" --project-dir "$PROJECT_ROOT" --json
```

Emit `task complete` leaf-first using the passing gate event id; emit `task skip` with its source-owned reason. Never write status to `tasks.json` or a plan. Failed checks get a failed gate, then repair and a fresh gate.

Record intermediate/final review and proof as `gate record --kind review|proof`. `--evidence` may reference only an existing canonical review/proof or product-owned test artifact; never create one merely to satisfy a gate. For authority waits, emit `human-input require`, then `resolve`.

## Finish

- Parent-owned: finish the run as `implementation_ready` only after every task is completed/skipped and wave gates are current.
- Self-owned: finish as `passed` only after every task is completed/skipped and a passing proof gate exists.
- Use `failed`, `blocked`, or `interrupted` honestly for terminal/error state; never manufacture a pass because telemetry is degraded.

Only after authoritative execution status, record one joined `plan.execution_outcome` for the Plan run with artifact/source hash and `RUN_ID`. Structured mode records actual parent workstreams, accepted parent+child task count, and completed wave count; plan-direct records coarse-map workstreams, zero synthetic tasks, and executed wave count. Record outcome, proof/review result (`SKIPPED` when omitted), and planning-surprise codes (`NONE` when empty). Verification, review, proof, and completion authority remain unchanged. A telemetry failure is degraded and never blocks delivery or changes terminal status.

Include `RUN_ID`, event status (`complete|degraded`), and any reconciliation/degradation in the Execute handoff.
