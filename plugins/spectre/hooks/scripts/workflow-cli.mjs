#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupProjectWorkflow,
  maybeCleanupProjectWorkflow,
  purgeProjectWorkflow,
} from './workflow/retention.mjs';
import {
  matchPlanTelemetry,
  recordPlanTelemetry,
  startPlanTelemetry,
} from './workflow/plan-telemetry.mjs';
import {
  finishExecuteMeasurement,
  finishExecuteWorkerMeasurement,
  finishMeasurement,
  persistShipMeasurement,
  startExecuteMeasurement,
  startMeasurement,
  summarizeMeasurement,
} from './workflow/measurement.mjs';
import {
  codedError,
  readWorkflowRun,
  recordWorkflowEvents,
  startWorkflowRun,
} from './workflow/store.mjs';

// Resume reads one bit: is this task accepted, or must it be redone? `assigned`,
// `in_progress`, and `submitted` collapse so a submission — which is never
// acceptance without a passing gate — can never read as done.
const REPORTED_TASK_STATUS = {
  pending: 'pending',
  assigned: 'in_progress',
  in_progress: 'in_progress',
  submitted: 'in_progress',
  blocked: 'blocked',
  completed: 'completed',
  skipped: 'skipped',
};

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(value, true);
      continue;
    }
    flags.set(value, next);
    index += 1;
  }
  return { positional, flags };
}

function usage() {
  return [
    'Usage:',
    '  spectre-workflow run start --source <tasks.json|plan.md|bug-report.md> [--origin plan|fix] [--owner self|parent] [--provider <id> --model <id> --effort <id>] [--project-dir <path>] --json',
    '  spectre-workflow run status --run-id <id> [--project-dir <path>] --json',
    '  spectre-workflow run finish --run-id <id> --actor-id <id> --status <status> --json',
    '  spectre-workflow stage|phase|wave start|finish --run-id <id> --actor-id <id> --id <value> --json',
    '  spectre-workflow agent dispatch|start|finish|measure --run-id <id> --actor-id <id> --json',
    '  spectre-workflow task assign|start|submit|complete|block|skip --run-id <id> --task-id <id> --actor-id <id> --json',
    '  spectre-workflow gate record --run-id <id> --actor-id <id> --kind verification|review|proof --status pass|fail [--tasks <ids>] [--checks <ids>] [--evidence <paths>] --json',
    '  spectre-workflow human-input require|resolve --run-id <id> --actor-id <id> --json',
    '  spectre-workflow plan start --feature-root <path> --scope-hash <sha256>|--scope <relative-path> --classification <XS|S|M|L|XL> --shape <ATOMIC|DIRECT|STRUCTURED> --uncertainty <LOW|MODERATE|HIGH> --evidence <SUFFICIENT|PROBE_REQUIRED|PROBED> --task-graph-risk <LOW|HIGH> --route <route> --design-authority-required <true|false> --probe-used <true|false> --probe-sufficient <true|false> --reason-codes <codes> [--protected-boundaries-json <json>] [--plan-hash <sha256>] [--project-dir <path>] [--json]',
    '  spectre-workflow plan record --plan-run-id <id> --event-type <type> --feature-root <path> --scope-hash <sha256> [--project-dir <path>] [--json]',
    '  spectre-workflow plan match --feature-root <path> --artifact-hash <sha256> [--project-dir <path>] [--json]',
    '    plan.reclassified: --previous-classification <size> --classification <size> --shape <ATOMIC|DIRECT|STRUCTURED> --uncertainty <LOW|MODERATE|HIGH> --evidence <SUFFICIENT|PROBE_REQUIRED|PROBED> --task-graph-risk <LOW|HIGH> --route <route> --design-authority-required <true|false> --regret-direction <NONE|SMALLER|LARGER> --reason-codes <codes> [--protected-boundaries-json <json>] --plan-hash <sha256>',
    '    plan.review_completed: --review-kind <correctness|simplification|task> --finding-count <n> --applied-count <n> --structure-before <n> --structure-after <n>',
    '    plan.gate_completed: --gate-kind <design|final> --gate-outcome <approved|feedback|declined> --change-category <none|scope_preserving|scope_change>',
    '    plan.completed: --artifact-count <n> --artifact-hashes <sha256,...> --planning-elapsed-ms <n> --continuation <execute|goal|pause|cancelled>',
    '    plan.execution_outcome: --execution-run-id <id> --plan-hash <sha256> --outcome-status <status> --workstream-count <n> --task-count <n> --wave-count <n> --proof-result <PASS|FAIL|PARTIAL|SKIPPED> --execution-review-result <CLEAN|FINDINGS|SKIPPED> --surprise-codes <codes>',
    '  spectre-workflow cleanup [--project-dir <path>] [--dry-run] --json',
    '  spectre-workflow purge [--project-dir <path>] --yes --json',
    '  spectre-workflow measure start --label <Ship|Prune|Test|Sweep|Rebase|"Full suite"|"Create PR"> --json',
    '  spectre-workflow measure finish --snapshot <json> [--child-agent-id <host:id|id>] --json',
    '  spectre-workflow measure summary --rows <json> --outer-snapshot <json> [--persist --project-dir <path> --feature-root <relative-path> --base-sha <sha> --head-sha <sha> --diff-sha256 <sha>] --json',
    '',
  ].join('\n');
}

function required(flags, flag) {
  const value = flags.get(flag);
  if (value === undefined || value === true || value === '') {
    throw codedError('MISSING_ARGUMENT', `${flag} is required`);
  }
  return value;
}

function listFlag(flags, flag) {
  const value = flags.get(flag);
  if (!value || value === true) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function integerFlag(flags, flag, fallback) {
  const value = flags.get(flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw codedError('INVALID_ARGUMENT', `${flag} must be a positive integer`);
  }
  return parsed;
}

function commonOptions(flags) {
  return {
    projectDir: path.resolve(flags.get('--project-dir') || process.cwd()),
    spectreHome: flags.get('--spectre-home') || process.env.SPECTRE_HOME,
  };
}

// Recorded events keep full fidelity in the run log for consumers; stdout
// returns only the confirmation fields downstream commands actually need.
function confirmation(resource, action, result) {
  if (!result || result.ok === false) return result;
  if (resource === 'measure') return result;
  if (resource === 'cleanup' || resource === 'purge') return result;
  if (resource === 'plan' && action === 'match') return result;
  if (resource === 'plan') {
    return { ok: true, planRunId: result.planRunId, eventId: result.eventId };
  }
  if (resource === 'run' && action === 'status') return result;
  if (resource === 'run' && action === 'start') {
    return {
      ok: true,
      resumed: Boolean(result.resumed),
      runId: result.runId,
      primaryActorId: result.primaryActorId,
      status: result.status,
      measurementSnapshot: result.measurementSnapshot || null,
    };
  }
  const compact = { ok: true };
  if (result.idempotent) compact.idempotent = true;
  const eventId = result.events?.[0]?.eventId;
  if (eventId) compact.eventId = eventId;
  if (resource === 'run' && action === 'finish') compact.status = result.status;
  if (resource === 'agent' && action === 'dispatch') {
    compact.workerActorId = result.workerActorId;
    compact.assignmentId = result.assignmentId;
    compact.taskIds = result.taskIds;
    compact.measurementSnapshot = result.measurementSnapshot || null;
  }
  return compact;
}

function outputResult(result, compact, flags, output = process.stdout) {
  if (flags.get('--json')) {
    output.write(`${JSON.stringify(compact)}\n`);
    return;
  }
  const event = result.events?.at(-1);
  if (event) {
    output.write(`${event.type} ${event.eventId} (${result.runId})\n`);
    return;
  }
  output.write(`${JSON.stringify(compact, null, 2)}\n`);
}

function idempotencyKey(flags, fallback) {
  const explicit = flags.get('--idempotency-key');
  return explicit && explicit !== true ? String(explicit) : fallback;
}

function measurementSnapshot(flags) {
  const value = flags.get('--measurement-snapshot');
  if (value === undefined || value === true || value === '') return null;
  try {
    const snapshot = JSON.parse(value);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('not an object');
    }
    return snapshot;
  } catch {
    throw codedError('INVALID_MEASUREMENT_SNAPSHOT', '--measurement-snapshot must be a JSON object');
  }
}

async function record(flags, events, fallbackKey) {
  const common = commonOptions(flags);
  await maybeCleanupProjectWorkflow(common);
  return recordWorkflowEvents({
    ...common,
    runId: required(flags, '--run-id'),
    idempotencyKey: idempotencyKey(flags, fallbackKey),
    events,
  });
}

async function runCommand(action, flags) {
  if (action === 'start') {
    const common = commonOptions(flags);
    await maybeCleanupProjectWorkflow(common);
    const result = await startWorkflowRun({
      ...common,
      source: required(flags, '--source'),
      owner: flags.get('--owner') || 'self',
      provider: flags.get('--provider') || null,
      model: flags.get('--model') || null,
      effort: flags.get('--effort') || null,
      origin: typeof flags.get('--origin') === 'string' ? flags.get('--origin') : null,
      resume: flags.get('--no-resume') ? false : true,
    });
    return {
      ...result,
      measurementSnapshot: result.resumed ? null : startExecuteMeasurement(),
    };
  }
  if (action === 'status') {
    const { state } = await readWorkflowRun({
      ...commonOptions(flags),
      runId: required(flags, '--run-id'),
    });
    const tasks = {};
    for (const [taskId, task] of Object.entries(state.tasks)) {
      tasks[taskId] = REPORTED_TASK_STATUS[task.state] || task.state;
    }
    return { ok: true, runId: state.runId, status: state.status, tasks };
  }
  if (action !== 'finish') throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown run command ${action}`);
  const status = required(flags, '--status');
  const type = {
    implementation_ready: 'run.implementation_ready',
    passed: 'run.completed',
    failed: 'run.failed',
    blocked: 'run.blocked',
    interrupted: 'run.interrupted',
  }[status];
  if (!type) throw codedError('INVALID_RUN_STATUS', `Invalid run status ${status}`);
  const snapshot = measurementSnapshot(flags);
  const measurement = snapshot
    ? finishExecuteMeasurement({ primarySnapshot: snapshot })
    : undefined;
  const result = await record(flags, [{
    type,
    actorId: required(flags, '--actor-id'),
    payload: {
      reasonCode: flags.get('--reason') || null,
      ...(measurement ? { measurement } : {}),
    },
  }], `run:finish:${required(flags, '--run-id')}:${status}`);
  return result;
}

async function boundaryCommand(kind, action, flags) {
  const id = kind === 'stage'
    ? (flags.get('--id') || 'execute')
    : required(flags, '--id');
  const status = action === 'start' ? 'started' : (flags.get('--status') || 'completed');
  if (!['started', 'completed', 'failed'].includes(status)) {
    throw codedError('INVALID_BOUNDARY_STATUS', `${kind} cannot finish as ${status}`);
  }
  const event = {
    type: `${kind}.${status}`,
    actorId: required(flags, '--actor-id'),
    ...(kind === 'stage' ? { stage: id } : {}),
    ...(kind === 'phase' ? { phaseId: id } : {}),
    ...(kind === 'wave' ? { waveId: id } : {}),
    payload: { reasonCode: flags.get('--reason') || null },
  };
  return record(
    flags,
    [event],
    `${kind}:${status}:${required(flags, '--run-id')}:${id}`,
  );
}

async function agentCommand(action, flags) {
  const runId = required(flags, '--run-id');
  if (action === 'dispatch') {
    const workerActorId = `actor_${crypto.randomUUID()}`;
    const assignmentId = `assignment_${crypto.randomUUID()}`;
    const taskIds = listFlag(flags, '--tasks');
    if (taskIds.length === 0) throw codedError('MISSING_ARGUMENT', '--tasks is required');
    const events = [{
      type: 'agent.dispatched',
      actorId: required(flags, '--actor-id'),
      assignmentId,
      attempt: integerFlag(flags, '--attempt', 1),
      payload: {
        workerActorId,
        provider: flags.get('--provider') || null,
        model: flags.get('--model') || null,
        effort: flags.get('--effort') || null,
        taskDefinitions: taskIds.map((id) => ({ id })),
      },
    }, ...taskIds.map((taskId) => ({
      type: 'task.assigned',
      actorId: required(flags, '--actor-id'),
      taskId,
      assignmentId,
      attempt: integerFlag(flags, '--attempt', 1),
      payload: { assignedActorId: workerActorId },
    }))];
    const result = await record(
      flags,
      events,
      idempotencyKey(flags, `agent:dispatch:${runId}:${taskIds.join(',')}`),
    );
    const dispatched = result.events[0];
    return {
      ...result,
      workerActorId: dispatched?.payload?.workerActorId || workerActorId,
      assignmentId: dispatched?.assignmentId || assignmentId,
      taskIds,
      measurementSnapshot: startExecuteMeasurement(),
    };
  }
  if (action === 'measure') {
    const actorId = required(flags, '--actor-id');
    const workerActorId = required(flags, '--worker-actor-id');
    const tokens = finishExecuteWorkerMeasurement({
      snapshot: measurementSnapshot(flags),
      childAgentId: required(flags, '--child-agent-id'),
    });
    return record(flags, [{
      type: 'agent.measured',
      actorId,
      payload: { workerActorId, measurement: { tokens } },
    }], `agent:measure:${runId}:${actorId}:${workerActorId}`);
  }
  if (!['start', 'finish'].includes(action)) {
    throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown agent command ${action}`);
  }
  const actorId = required(flags, '--actor-id');
  const result = await record(flags, [{
    type: action === 'start' ? 'agent.started' : 'agent.completed',
    actorId,
    assignmentId: flags.get('--assignment-id') || undefined,
    payload: {
      result: flags.get('--result') || null,
    },
  }], `agent:${action}:${runId}:${actorId}`);
  return result;
}

async function taskCommand(action, flags) {
  const runId = required(flags, '--run-id');
  const actorId = required(flags, '--actor-id');
  const taskId = required(flags, '--task-id');
  const attempt = integerFlag(flags, '--attempt', 1);
  const common = {
    actorId,
    taskId,
    assignmentId: flags.get('--assignment-id') || undefined,
    attempt,
    evidence: listFlag(flags, '--evidence'),
  };
  let event;
  if (action === 'assign') {
    event = {
      ...common,
      type: 'task.assigned',
      payload: { assignedActorId: flags.get('--assigned-actor-id') || actorId },
    };
  } else if (action === 'start') {
    event = { ...common, type: 'task.started', payload: {} };
  } else if (action === 'submit') {
    event = {
      ...common,
      type: 'task.submitted',
      payload: {
        commit: flags.get('--commit') || null,
        source: flags.get('--source-kind') || 'worker',
      },
    };
  } else if (action === 'complete') {
    event = {
      ...common,
      type: 'task.completed',
      payload: { gateEventId: required(flags, '--gate-event-id') },
    };
  } else if (action === 'block') {
    event = {
      ...common,
      type: 'task.blocked',
      payload: { reasonCode: required(flags, '--reason') },
    };
  } else if (action === 'skip') {
    event = {
      ...common,
      type: 'task.skipped',
      payload: { reasonCode: required(flags, '--reason') },
    };
  } else {
    throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown task command ${action}`);
  }
  return record(flags, [event], `task:${action}:${runId}:${taskId}:${attempt}`);
}

async function gateCommand(action, flags) {
  if (action !== 'record') throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown gate command ${action}`);
  const kind = required(flags, '--kind');
  const status = required(flags, '--status');
  if (!['verification', 'review', 'proof'].includes(kind)) {
    throw codedError('INVALID_GATE_KIND', `Invalid gate kind ${kind}`);
  }
  if (!['pass', 'fail'].includes(status)) {
    throw codedError('INVALID_GATE_STATUS', `Invalid gate status ${status}`);
  }
  const taskIds = listFlag(flags, '--tasks');
  const checkIds = listFlag(flags, '--checks');
  return record(flags, [{
    type: 'gate.recorded',
    actorId: required(flags, '--actor-id'),
    phaseId: flags.get('--phase-id') || undefined,
    waveId: flags.get('--wave-id') || undefined,
    evidence: listFlag(flags, '--evidence'),
    payload: { kind, status, taskIds, checkIds },
  }], idempotencyKey(
    flags,
    `gate:${kind}:${status}:${required(flags, '--run-id')}:${flags.get('--wave-id') || flags.get('--phase-id') || taskIds.join(',')}:${checkIds.join(',')}`,
  ));
}

async function humanInputCommand(action, flags) {
  if (!['require', 'resolve'].includes(action)) {
    throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown human-input command ${action}`);
  }
  return record(flags, [{
    type: action === 'require' ? 'human_input.required' : 'human_input.resolved',
    actorId: required(flags, '--actor-id'),
    payload: { reasonCode: flags.get('--reason') || null },
  }], `human-input:${action}:${required(flags, '--run-id')}`);
}

async function planCommand(action, flags) {
  const options = {
    ...commonOptions(flags),
    featureRoot: required(flags, '--feature-root'),
    scope: flags.get('--scope') || null,
    scopeHash: flags.get('--scope-hash') || null,
    classification: flags.get('--classification') || null,
    previousClassification: flags.get('--previous-classification') || null,
    shape: flags.get('--shape') || null,
    uncertainty: flags.get('--uncertainty') || null,
    evidence: flags.get('--evidence') || null,
    taskGraphRisk: flags.get('--task-graph-risk') || null,
    route: flags.get('--route') || null,
    designAuthorityRequired: flags.get('--design-authority-required') || null,
    probeUsed: flags.get('--probe-used') || null,
    probeSufficient: flags.get('--probe-sufficient') || null,
    reasonCodes: flags.get('--reason-codes') || flags.get('--reason-code') || null,
    protectedBoundariesJson: flags.get('--protected-boundaries-json') || null,
    regretDirection: flags.get('--regret-direction') || null,
    reviewKind: flags.get('--review-kind') || null,
    findingCount: flags.get('--finding-count') || null,
    appliedCount: flags.get('--applied-count') || null,
    structureBefore: flags.get('--structure-before') || null,
    structureAfter: flags.get('--structure-after') || null,
    gateKind: flags.get('--gate-kind') || null,
    gateOutcome: flags.get('--gate-outcome') || null,
    changeCategory: flags.get('--change-category') || null,
    artifactCount: flags.get('--artifact-count') || null,
    artifactHashes: flags.get('--artifact-hashes') || null,
    planningElapsedMs: flags.get('--planning-elapsed-ms') || null,
    continuation: flags.get('--continuation') || null,
    outcomeStatus: flags.get('--outcome-status') || null,
    workstreamCount: flags.get('--workstream-count') || null,
    taskCount: flags.get('--task-count') || null,
    waveCount: flags.get('--wave-count') || null,
    proofResult: flags.get('--proof-result') || null,
    executionReviewResult: flags.get('--execution-review-result') || null,
    surpriseCodes: flags.get('--surprise-codes') || null,
    planHash: flags.get('--plan-hash') || null,
    executionRunId: flags.get('--execution-run-id') || null,
    artifactHash: flags.get('--artifact-hash') || null,
    payloadJson: flags.get('--payload-json') || null,
  };
  if (action === 'start') return startPlanTelemetry(options);
  if (action === 'record') {
    return recordPlanTelemetry({
      ...options,
      planRunId: required(flags, '--plan-run-id'),
      eventType: required(flags, '--event-type'),
    });
  }
  if (action === 'match') {
    return matchPlanTelemetry({
      ...options,
      artifactHash: required(flags, '--artifact-hash'),
    });
  }
  throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown plan command ${action}`);
}

function jsonFlag(flags, flag) {
  try {
    return JSON.parse(required(flags, flag));
  } catch {
    throw codedError('INVALID_JSON_ARGUMENT', `${flag} must be valid JSON`);
  }
}

async function measureCommand(action, flags) {
  if (action === 'start') {
    return startMeasurement({ label: required(flags, '--label') });
  }
  if (action === 'finish') {
    return finishMeasurement({
      snapshot: jsonFlag(flags, '--snapshot'),
      childAgentId: flags.get('--child-agent-id') || null,
    });
  }
  if (action === 'summary') {
    const summary = summarizeMeasurement({
      rows: jsonFlag(flags, '--rows'),
      outerSnapshot: jsonFlag(flags, '--outer-snapshot'),
    });
    if (flags.get('--persist') !== true) return summary;
    try {
      const options = commonOptions(flags);
      summary.persistence = await persistShipMeasurement({
        summary,
        outerSnapshot: jsonFlag(flags, '--outer-snapshot'),
        projectDir: options.projectDir,
        spectreHome: options.spectreHome,
        featureRoot: required(flags, '--feature-root'),
        candidate: {
          baseSha: required(flags, '--base-sha'),
          headSha: required(flags, '--head-sha'),
          diffSha256: required(flags, '--diff-sha256'),
        },
      });
    } catch (error) {
      summary.persistence = {
        status: 'degraded',
        errorCode: error?.code?.startsWith('INVALID_SHIP_')
          ? error.code
          : 'SHIP_MEASUREMENT_PERSISTENCE_FAILED',
      };
    }
    return summary;
  }
  throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown measure command ${action}`);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const { positional, flags } = parseArgs(argv);
  const [resource, action] = positional;
  if (!resource || resource === 'help' || resource === '--help') {
    stdout.write(usage());
    return;
  }

  let result;
  if (resource === 'run') result = await runCommand(action, flags);
  else if (['stage', 'phase', 'wave'].includes(resource)) {
    result = await boundaryCommand(resource, action, flags);
  } else if (resource === 'agent') result = await agentCommand(action, flags);
  else if (resource === 'task') result = await taskCommand(action, flags);
  else if (resource === 'gate') result = await gateCommand(action, flags);
  else if (resource === 'human-input') result = await humanInputCommand(action, flags);
  else if (resource === 'plan') result = await planCommand(action, flags);
  else if (resource === 'measure') result = await measureCommand(action, flags);
  else if (resource === 'cleanup') {
    result = await cleanupProjectWorkflow({
      ...commonOptions(flags),
      dryRun: Boolean(flags.get('--dry-run')),
    });
  } else if (resource === 'purge') {
    result = await purgeProjectWorkflow({
      ...commonOptions(flags),
      confirm: Boolean(flags.get('--yes')),
    });
  } else {
    throw codedError('UNKNOWN_WORKFLOW_COMMAND', `Unknown workflow command ${resource}`);
  }
  if (resource === 'plan') flags.set('--json', true);
  outputResult(result, confirmation(resource, action, result), flags, stdout);
  return result;
}

function canonicalEntryPath(value) {
  if (!value) return null;
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

const directPath = canonicalEntryPath(process.argv[1]);
if (directPath && directPath === canonicalEntryPath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const directResource = process.argv.slice(2).find((value) => !value.startsWith('--'));
    if ((process.argv.includes('--json') || directResource === 'plan') && error?.code) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  });
}

export { parseArgs, usage };
