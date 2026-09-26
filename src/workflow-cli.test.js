import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectStore } from '../plugins/spectre/hooks/scripts/knowledge/store.mjs';
import {
  readWorkflowRun,
  recordWorkflowEvents,
  startWorkflowRun,
  summaryFor,
} from '../plugins/spectre/hooks/scripts/workflow/store.mjs';
import {
  finishExecuteMeasurement,
  finishExecuteWorkerMeasurement,
  startExecuteMeasurement,
} from '../plugins/spectre/hooks/scripts/workflow/measurement.mjs';

const CLI_PATH = path.resolve('bin/spectre.js');
const BUNDLED_CLI_PATH = path.resolve('plugins/spectre/hooks/scripts/workflow-cli.mjs');

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-workflow-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  const sourcePath = path.join(projectDir, '.spectre', 'features', 'cli', 'specs', 'tasks.json');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({
    meta: { schema_version: 1, feature_root: '.spectre/features/cli' },
    phases: [{
      id: '1',
      parents: [{
        id: '1.1',
        subtasks: [{ id: '1.1.1' }],
      }],
    }],
  }));
  return { root, projectDir, spectreHome, sourcePath };
}

function invoke(script, args, value, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, ...env },
    encoding: 'utf8',
  });
}

async function finishFailed(value, run) {
  await recordWorkflowEvents({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
    idempotencyKey: `test:failed:${run.runId}`,
    events: [{ type: 'run.failed', actorId: run.primaryActorId, payload: {} }],
  });
}

async function dispatchWorker(value, run) {
  const workerActorId = `actor_${crypto.randomUUID()}`;
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  await recordWorkflowEvents({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
    idempotencyKey: `test:dispatch:${run.runId}`,
    events: [
      {
        type: 'agent.dispatched',
        actorId: run.primaryActorId,
        assignmentId,
        attempt: 1,
        payload: {
          workerActorId,
          provider: null,
          model: null,
          effort: null,
        },
      },
      {
        type: 'task.assigned',
        actorId: run.primaryActorId,
        taskId: '1.1',
        assignmentId,
        attempt: 1,
        payload: { assignedActorId: workerActorId },
      },
    ],
  });
  return { workerActorId, assignmentId };
}

test('top-level and bundled workflow CLIs share stable JSON commands', (t) => {
  const value = makeFixture(t);
  const started = invoke(CLI_PATH, [
    'workflow',
    'run',
    'start',
    '--source',
    value.sourcePath,
    '--project-dir',
    value.projectDir,
    '--json',
  ], value);
  assert.equal(started.status, 0, started.stderr);
  const run = JSON.parse(started.stdout);
  assert.equal(run.ok, true);
  assert.match(run.runId, /^run_/);
  assert.match(run.primaryActorId, /^actor_/);

  const stage = invoke(BUNDLED_CLI_PATH, [
    'stage',
    'start',
    '--run-id',
    run.runId,
    '--actor-id',
    run.primaryActorId,
    '--id',
    'execute',
    '--project-dir',
    value.projectDir,
    '--json',
  ], value);
  assert.equal(stage.status, 0, stage.stderr);
  const stageResult = JSON.parse(stage.stdout);
  assert.equal(stageResult.ok, true);
  assert.match(stageResult.eventId, /^evt_/);
  assert.deepEqual(Object.keys(stageResult).sort(), ['eventId', 'ok']);
});

test('Execute runs retain explicit provenance and privacy-safe measurement defaults', async (t) => {
  const value = makeFixture(t);
  const bugRoot = path.join(value.projectDir, '.spectre', 'bugs', 'cli-bug');
  const bugReport = path.join(bugRoot, 'bug-report.md');
  const directPlan = path.join(value.projectDir, '.spectre', 'features', 'cli', 'specs', 'plan.md');
  fs.mkdirSync(bugRoot, { recursive: true });
  fs.writeFileSync(bugReport, '# Approved bug report\n');
  fs.writeFileSync(directPlan, '# Direct plan\n');

  const cases = [
    { source: value.sourcePath, origin: 'plan', category: 'plan', shape: 'structured', featureRoot: '.spectre/features/cli' },
    { source: directPlan, origin: 'plan', category: 'plan-direct', shape: 'direct', featureRoot: '.spectre/features/cli' },
    { source: bugReport, origin: 'fix', category: 'fix', shape: 'direct', featureRoot: '.spectre/bugs/cli-bug' },
  ];

  for (const item of cases) {
    const run = await startWorkflowRun({
      projectDir: value.projectDir,
      spectreHome: value.spectreHome,
      source: item.source,
      origin: item.origin,
      resume: false,
    });
    const { state } = await readWorkflowRun({
      projectDir: value.projectDir,
      spectreHome: value.spectreHome,
      runId: run.runId,
    });
    assert.deepEqual(state.provenance, {
      category: item.category,
      originWorkflow: item.origin,
      executionShape: item.shape,
    });
    assert.equal(state.featureRoot, item.featureRoot);
    assert.deepEqual(state.measurement, {
      elapsedMs: 'unavailable',
      elapsedStatus: 'unavailable',
      totalTokens: 'unavailable',
      primaryTokens: 'unavailable',
      workerTokens: 'unavailable',
      tokenStatus: 'unavailable',
      reconciliationStatus: 'unavailable',
    });
  }

  const legacy = summaryFor({
    schemaVersion: 1,
    runId: 'run_00000000-0000-4000-8000-000000000000',
    workflow: 'execute',
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    lastEventAt: '2026-01-01T00:01:00.000Z',
    tasks: {},
    actors: {},
    contractHash: 'a'.repeat(64),
    sourceDefinitionHash: 'b'.repeat(64),
  }, []);
  assert.equal(legacy.provenance.category, 'unknown');
  assert.equal(legacy.measurement.totalTokens, 'unavailable');
  assert.doesNotMatch(JSON.stringify(legacy), /session|hostCounters|prompt|transcript|command/i);
});

test('Execute rejects Delegate origin for new starts while retaining historical Delegate provenance reads', async (t) => {
  const value = makeFixture(t);
  const common = ['--project-dir', value.projectDir, '--json'];

  await assert.rejects(startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
    origin: 'delegate',
  }), { code: 'INVALID_EXECUTE_ORIGIN' });

  for (const { script, prefix } of [
    { script: CLI_PATH, prefix: ['workflow'] },
    { script: BUNDLED_CLI_PATH, prefix: [] },
  ]) {
    const invalid = invoke(script, [
      ...prefix, 'run', 'start', '--source', value.sourcePath, '--origin', 'delegate', ...common,
    ], value);
    assert.notEqual(invalid.status, 0, script);
    assert.deepEqual(JSON.parse(invalid.stdout), {
      ok: false,
      code: 'INVALID_EXECUTE_ORIGIN',
      message: 'Execute origin must be plan, fix, or unknown',
    });
  }

  const run = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
    origin: 'plan',
  });
  const { paths } = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
  });
  const historical = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  historical.provenance = {
    category: 'delegate',
    originWorkflow: 'delegate',
    executionShape: 'structured',
  };
  fs.writeFileSync(paths.statePath, JSON.stringify(historical));

  const read = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
  });
  assert.deepEqual(read.state.provenance, historical.provenance);
  const status = invoke(BUNDLED_CLI_PATH, [
    'run', 'status', '--run-id', run.runId, ...common,
  ], value);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'active');
});

test('Execute resumes legacy or origin-unknown runs without weakening explicit origin matching', async (t) => {
  const value = makeFixture(t);
  const started = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
    origin: 'plan',
  });
  const omittedOrigin = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
  });
  assert.equal(omittedOrigin.resumed, true);
  assert.equal(omittedOrigin.runId, started.runId);
  await finishFailed(value, started);

  const explicitFix = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
    origin: 'fix',
  });
  assert.notEqual(explicitFix.runId, started.runId);

  const { paths } = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: explicitFix.runId,
  });
  const legacy = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  delete legacy.provenance;
  fs.writeFileSync(paths.statePath, JSON.stringify(legacy));
  const legacyResume = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
  });
  assert.equal(legacyResume.resumed, true);
  assert.equal(legacyResume.runId, explicitFix.runId);
});

test('Execute accepts empty origin, preserves scoped bug roots, and records post-return worker measurements', async (t) => {
  const value = makeFixture(t);
  const common = ['--project-dir', value.projectDir, '--json'];
  const scopedBugRoot = path.join(value.projectDir, '.spectre', 'bugs', 'scoped');
  const scopedBugReport = path.join(scopedBugRoot, 'bug-report-login.md');
  fs.mkdirSync(scopedBugRoot, { recursive: true });
  fs.writeFileSync(scopedBugReport, '# Approved scoped bug report\n');
  const emptyOrigin = invoke(BUNDLED_CLI_PATH, [
    'run', 'start', '--source', scopedBugReport, '--origin', '', ...common,
  ], value);
  assert.equal(emptyOrigin.status, 0, emptyOrigin.stderr);
  const scoped = JSON.parse(emptyOrigin.stdout);
  const scopedState = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: scoped.runId,
  });
  assert.equal(scopedState.state.provenance.originWorkflow, 'unknown');
  assert.equal(scopedState.state.featureRoot, '.spectre/bugs/scoped');
  await finishFailed(value, scoped);
  const scopedFinished = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: scoped.runId,
  });
  const scopedSummary = JSON.parse(fs.readFileSync(scopedFinished.paths.summaryPath, 'utf8'));
  assert.equal(scopedSummary.featureRoot, '.spectre/bugs/scoped');

  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-execute-cli-measurement-'));
  t.after(() => fs.rmSync(sessions, { recursive: true, force: true }));
  const writeUsage = (id, total) => fs.writeFileSync(
    path.join(sessions, `session-${id}.jsonl`),
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } } })}\n`,
  );
  const primaryEnv = { SPECTRE_CODEX_SESSIONS_DIR: sessions, CODEX_SESSION_ID: 'primary' };
  const workerEnv = { SPECTRE_CODEX_SESSIONS_DIR: sessions, CODEX_SESSION_ID: 'worker' };
  writeUsage('primary', 20);
  const run = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'run', 'start', '--source', value.sourcePath, '--origin', 'plan', '--no-resume', ...common,
  ], value, primaryEnv).stdout);
  assert.equal(run.measurementSnapshot.counters.totalTokens, 20);
  writeUsage('primary', 31);
  const dispatch = invoke(BUNDLED_CLI_PATH, [
    'agent', 'dispatch', '--run-id', run.runId, '--actor-id', run.primaryActorId,
    '--tasks', '1.1', '--attempt', '1', ...common,
  ], value, primaryEnv);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  const dispatched = JSON.parse(dispatch.stdout);
  assert.equal(typeof dispatched.measurementSnapshot.epochMs, 'number');
  assert.doesNotMatch(dispatch.stdout, /taskDefinitions|payload|sourceRawHash/);
  writeUsage('worker', 5);
  const workerStart = invoke(BUNDLED_CLI_PATH, [
    'agent', 'start', '--run-id', run.runId, '--actor-id', dispatched.workerActorId,
    '--assignment-id', dispatched.assignmentId, ...common,
  ], value, workerEnv);
  assert.equal(workerStart.status, 0, workerStart.stderr);
  writeUsage('worker', 12);
  const workerFinish = invoke(BUNDLED_CLI_PATH, [
    'agent', 'finish', '--run-id', run.runId, '--actor-id', dispatched.workerActorId,
    '--assignment-id', dispatched.assignmentId, ...common,
  ], value, workerEnv);
  assert.equal(workerFinish.status, 0, workerFinish.stderr);
  assert.equal(finishExecuteWorkerMeasurement({
    snapshot: dispatched.measurementSnapshot,
    childAgentId: 'codex:missing',
    hosts: { codexSessionsDir: sessions },
  }), 'unavailable');
  const measure = invoke(BUNDLED_CLI_PATH, [
    'agent', 'measure', '--run-id', run.runId, '--actor-id', run.primaryActorId,
    '--worker-actor-id', dispatched.workerActorId, '--child-agent-id', 'codex:worker',
    '--measurement-snapshot', JSON.stringify(dispatched.measurementSnapshot), ...common,
  ], value, primaryEnv);
  assert.equal(measure.status, 0, measure.stderr);
  assert.doesNotMatch(measure.stdout, /worker|child|session|hostCounters|raw|snapshot/i);
  const terminal = invoke(BUNDLED_CLI_PATH, [
    'run', 'finish', '--run-id', run.runId, '--actor-id', run.primaryActorId, '--status', 'failed',
    '--measurement-snapshot', JSON.stringify(run.measurementSnapshot), ...common,
  ], value, primaryEnv);
  assert.equal(terminal.status, 0, terminal.stderr);
  const finished = await readWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
  });
  const summary = JSON.parse(fs.readFileSync(finished.paths.summaryPath, 'utf8'));
  assert.deepEqual(summary.measurement, {
    elapsedMs: summary.measurement.elapsedMs,
    elapsedStatus: 'complete',
    totalTokens: 23,
    primaryTokens: 11,
    workerTokens: 12,
    tokenStatus: 'complete',
    reconciliationStatus: 'reconciled',
  });
  assert.doesNotMatch(JSON.stringify(summary), /session|hostCounters|raw|snapshot/i);
  assert.deepEqual(finished.state.workerMeasurements[dispatched.workerActorId], { tokens: 12 });
  const workerMeasurements = finished.events.filter((event) => event.type === 'agent.measured');
  assert.equal(workerMeasurements.length, 1);
  assert.equal(workerMeasurements[0].payload.workerActorId, dispatched.workerActorId);
  assert.deepEqual(workerMeasurements[0].payload.measurement, { tokens: 12 });
  assert.doesNotMatch(JSON.stringify(workerMeasurements), /childAgentId|measurementSnapshot|hostCounters|total_token_usage/i);
  assert.doesNotMatch(JSON.stringify(finished.state.idempotency), /codex:worker|codex:missing/);
  const projectStore = await resolveProjectStore(value.projectDir, { spectreHome: value.spectreHome });
  assert.equal(fs.existsSync(path.join(projectStore.storePath, 'measurements')), false);
  assert.equal(fs.existsSync(path.join(
    projectStore.storePath, 'workflow', 'ship', 'measurements.json',
  )), false);
});

test('Execute measurement reconciles only complete aggregate primary and worker counters', (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-execute-measurement-'));
  t.after(() => fs.rmSync(sessions, { recursive: true, force: true }));
  const hosts = { codexSessionsDir: sessions };
  const writeUsage = (id, total) => fs.writeFileSync(
    path.join(sessions, `session-${id}.jsonl`),
    `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
    })}\n`,
  );
  writeUsage('primary', 20);
  const primary = startExecuteMeasurement({
    now: () => 100,
    env: { CODEX_SESSION_ID: 'primary' },
    hosts,
  });
  writeUsage('primary', 31);
  writeUsage('worker', 9);
  const measurement = finishExecuteMeasurement({
    primarySnapshot: primary,
    workerSnapshots: [{
      epochMs: 120,
      session: { host: 'codex', id: 'worker' },
      counters: { totalTokens: 5 },
    }],
    now: () => 150,
    hosts,
  });
  assert.deepEqual(measurement, {
    elapsedMs: 50,
    elapsedStatus: 'complete',
    totalTokens: 15,
    primaryTokens: 11,
    workerTokens: 4,
    tokenStatus: 'complete',
    reconciliationStatus: 'reconciled',
  });

  const unavailable = finishExecuteMeasurement({ primarySnapshot: null, now: () => 150, hosts });
  assert.equal(unavailable.totalTokens, 'unavailable');
  assert.equal(unavailable.reconciliationStatus, 'unavailable');

  const missingWorker = finishExecuteMeasurement({
    primarySnapshot: primary,
    workersExpected: true,
    now: () => 150,
    hosts,
  });
  assert.equal(missingWorker.workerTokens, 'unavailable');
  assert.equal(missingWorker.totalTokens, 'unavailable');
});

test('post-return worker measurement is primary-owned and worker-targeted', async (t) => {
  const value = makeFixture(t);
  const run = await startWorkflowRun({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    source: value.sourcePath,
    resume: false,
  });
  const worker = await dispatchWorker(value, run);
  const options = (actorId, workerActorId) => ({
    projectDir: value.projectDir,
    spectreHome: value.spectreHome,
    runId: run.runId,
    idempotencyKey: `test:measure:${actorId}:${workerActorId}`,
    events: [{
      type: 'agent.measured',
      actorId,
      payload: { workerActorId, measurement: { tokens: 7 } },
    }],
  });
  await assert.rejects(
    recordWorkflowEvents(options(worker.workerActorId, worker.workerActorId)),
    (error) => error.code === 'PRIMARY_REQUIRED',
  );
  await assert.rejects(
    recordWorkflowEvents(options(run.primaryActorId, run.primaryActorId)),
    (error) => error.code === 'INVALID_MEASUREMENT_TARGET',
  );
});

test('workflow CLI returns minimal confirmations across the task lifecycle', (t) => {
  const value = makeFixture(t);
  const immutableSource = fs.readFileSync(value.sourcePath, 'utf8');
  const common = ['--project-dir', value.projectDir, '--json'];
  const run = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'run', 'start', '--source', value.sourcePath, ...common,
  ], value).stdout);
  assert.deepEqual(
    Object.keys(run).sort(),
    ['measurementSnapshot', 'ok', 'primaryActorId', 'resumed', 'runId', 'status'],
  );
  assert.equal(typeof run.measurementSnapshot.epochMs, 'number');

  const ids = ['--run-id', run.runId, '--actor-id', run.primaryActorId];
  const dispatch = invoke(BUNDLED_CLI_PATH, [
    'agent', 'dispatch', ...ids, '--tasks', '1.1,1.1.1', '--attempt', '1', ...common,
  ], value);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  const dispatched = JSON.parse(dispatch.stdout);
  assert.equal(dispatched.ok, true);
  assert.match(dispatched.workerActorId, /^actor_/);
  assert.match(dispatched.assignmentId, /^assignment_/);
  assert.deepEqual(dispatched.taskIds, ['1.1', '1.1.1']);
  assert.doesNotMatch(dispatch.stdout, /taskDefinitions|payload|sourceRawHash/);

  for (const taskId of ['1.1', '1.1.1']) {
    for (const action of ['start', 'submit']) {
      const step = invoke(BUNDLED_CLI_PATH, [
        'task', action, '--run-id', run.runId,
        '--actor-id', dispatched.workerActorId,
        '--task-id', taskId, ...common,
      ], value);
      assert.equal(step.status, 0, step.stderr);
      const confirmed = JSON.parse(step.stdout);
      assert.deepEqual(Object.keys(confirmed).sort(), ['eventId', 'ok']);
      assert.doesNotMatch(step.stdout, /taskDefinition|sourceStatus/);
    }
  }

  const gate = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'gate', 'record', ...ids, '--kind', 'verification', '--status', 'pass',
    '--tasks', '1.1,1.1.1', '--checks', 'lint:affected,test:focused',
    '--wave-id', '1', ...common,
  ], value).stdout);
  assert.deepEqual(Object.keys(gate).sort(), ['eventId', 'ok']);

  for (const taskId of ['1.1.1', '1.1']) {
    const complete = invoke(BUNDLED_CLI_PATH, [
      'task', 'complete', ...ids, '--task-id', taskId,
      '--gate-event-id', gate.eventId, ...common,
    ], value);
    assert.equal(complete.status, 0, complete.stderr);
    assert.deepEqual(Object.keys(JSON.parse(complete.stdout)).sort(), ['eventId', 'ok']);
  }

  const replay = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'gate', 'record', ...ids, '--kind', 'verification', '--status', 'pass',
    '--tasks', '1.1,1.1.1', '--checks', 'lint:affected,test:focused',
    '--wave-id', '1', ...common,
  ], value).stdout);
  assert.deepEqual(replay, { ok: true, idempotent: true, eventId: gate.eventId });

  const expandedGate = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'gate', 'record', ...ids, '--kind', 'verification', '--status', 'pass',
    '--tasks', '1.1,1.1.1', '--checks', 'lint:affected,test:focused,typecheck:affected',
    '--wave-id', '1', ...common,
  ], value).stdout);
  assert.notEqual(expandedGate.eventId, gate.eventId);
  assert.equal(fs.readFileSync(value.sourcePath, 'utf8'), immutableSource);
});

test('workflow CLI reports stable coded JSON errors', (t) => {
  const value = makeFixture(t);
  const missing = invoke(BUNDLED_CLI_PATH, [
    'task',
    'start',
    '--json',
  ], value);
  assert.notEqual(missing.status, 0);
  assert.deepEqual(JSON.parse(missing.stdout), {
    ok: false,
    code: 'MISSING_ARGUMENT',
    message: '--run-id is required',
  });
  assert.equal(missing.stderr, '');
});

test('workflow CLI records a local plan telemetry lifecycle outside the working tree', async (t) => {
  const value = makeFixture(t);
  const featureRoot = path.join(value.projectDir, '.spectre', 'features', 'cli');
  const scopePath = path.join(featureRoot, 'concepts', 'scope.md');
  const planPath = path.join(featureRoot, 'specs', 'plan.md');
  const scopeContents = '# Scope\n\nPRIVATE_SCOPE_BOUNDARY_MUST_BE_HASHED\n';
  const planContents = '# Plan\n\nRaw bytes are the hash authority.\n';
  fs.mkdirSync(path.dirname(scopePath), { recursive: true });
  fs.writeFileSync(scopePath, scopeContents);
  fs.writeFileSync(planPath, planContents);
  const scopeHash = crypto.createHash('sha256').update(fs.readFileSync(scopePath)).digest('hex');
  const planHash = crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');
  const common = ['--project-dir', value.projectDir, '--json'];
  const started = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'start',
    '--feature-root',
    featureRoot,
    '--scope',
    path.relative(value.projectDir, scopePath),
    '--classification',
    'MICRO',
    '--shape',
    'ATOMIC',
    '--uncertainty',
    'LOW',
    '--evidence',
    'PROBED',
    '--task-graph-risk',
    'LOW',
    '--route',
    'XS_DIRECT',
    '--design-authority-required',
    'false',
    '--probe-used',
    'true',
    '--probe-sufficient',
    'true',
    '--reason-codes',
    'known-pattern',
    '--protected-boundaries-json',
    JSON.stringify([{
      type: 'public-api',
      threatened_invariant: 'PRIVATE_INVARIANT_MUST_BE_HASHED',
      failure_mode: 'PRIVATE_FAILURE_MODE_MUST_BE_HASHED',
    }]),
    '--plan-hash',
    planHash,
    ...common,
  ], value);
  assert.equal(started.status, 0, started.stderr);
  const start = JSON.parse(started.stdout);
  assert.deepEqual(Object.keys(start).sort(), ['eventId', 'ok', 'planRunId']);
  assert.match(start.planRunId, /^plan_run_/);
  assert.match(start.eventId, /^plan_evt_/);

  const reclassified = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'record',
    '--plan-run-id',
    start.planRunId,
    '--event-type',
    'plan.reclassified',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    scopeHash,
    '--classification',
    'STANDARD-DIRECT',
    '--previous-classification',
    'LIGHT',
    '--shape',
    'DIRECT',
    '--uncertainty',
    'MODERATE',
    '--evidence',
    'SUFFICIENT',
    '--task-graph-risk',
    'LOW',
    '--route',
    'M_REVIEWED_DIRECT',
    '--design-authority-required',
    'false',
    '--regret-direction',
    'LARGER',
    '--reason-codes',
    'routing-change',
    '--plan-hash',
    planHash,
    ...common,
  ], value);
  assert.equal(reclassified.status, 0, reclassified.stderr);
  assert.deepEqual(Object.keys(JSON.parse(reclassified.stdout)).sort(), ['eventId', 'ok', 'planRunId']);

  const review = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'record',
    '--plan-run-id',
    start.planRunId,
    '--event-type',
    'plan.review_completed',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    scopeHash,
    '--review-kind',
    'simplification',
    '--finding-count',
    '2',
    '--applied-count',
    '1',
    '--structure-before',
    '5',
    '--structure-after',
    '4',
    ...common,
  ], value);
  assert.equal(review.status, 0, review.stderr);

  const gate = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'record',
    '--plan-run-id',
    start.planRunId,
    '--event-type',
    'plan.gate_completed',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    scopeHash,
    '--gate-kind',
    'final',
    '--gate-outcome',
    'approved',
    '--change-category',
    'none',
    ...common,
  ], value);
  assert.equal(gate.status, 0, gate.stderr);

  const completed = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'record',
    '--plan-run-id',
    start.planRunId,
    '--event-type',
    'plan.completed',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    scopeHash,
    '--artifact-count',
    '2',
    '--artifact-hashes',
    `${planHash},${'d'.repeat(64)}`,
    '--planning-elapsed-ms',
    '1234',
    '--continuation',
    'goal',
    ...common,
  ], value);
  assert.equal(completed.status, 0, completed.stderr);

  const matched = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'match',
    '--feature-root',
    '.spectre/features/cli',
    '--artifact-hash',
    planHash,
    ...common,
  ], value);
  assert.equal(matched.status, 0, matched.stderr);
  assert.deepEqual(JSON.parse(matched.stdout), {
    ok: true,
    planRunId: start.planRunId,
    scopeHash,
    artifactHash: planHash,
  });

  const outcome = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'record',
    '--plan-run-id',
    start.planRunId,
    '--event-type',
    'plan.execution_outcome',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    scopeHash,
    '--execution-run-id',
    'run_11111111-1111-4111-8111-111111111111',
    '--plan-hash',
    planHash,
    '--outcome-status',
    'passed',
    '--workstream-count',
    '3',
    '--task-count',
    '9',
    '--wave-count',
    '2',
    '--proof-result',
    'PASS',
    '--execution-review-result',
    'CLEAN',
    '--surprise-codes',
    'UNPLANNED_DEPENDENCY',
    ...common,
  ], value);
  assert.equal(outcome.status, 0, outcome.stderr);

  const resolved = await resolveProjectStore(value.projectDir, { spectreHome: value.spectreHome });
  const telemetryPath = path.join(resolved.storePath, 'workflow', 'plan', 'events.jsonl');
  const workingTreeTelemetryPath = path.join(
    value.projectDir,
    '.spectre',
    'telemetry',
    'plan-classification.jsonl',
  );
  assert.equal(fs.existsSync(workingTreeTelemetryPath), false);
  const serialized = fs.readFileSync(telemetryPath, 'utf8');
  assert.doesNotMatch(serialized, /PRIVATE_SCOPE_BOUNDARY_MUST_BE_HASHED/);
  assert.doesNotMatch(serialized, /PRIVATE_INVARIANT_MUST_BE_HASHED/);
  assert.doesNotMatch(serialized, /PRIVATE_FAILURE_MODE_MUST_BE_HASHED/);
  const events = serialized.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event_type), [
    'plan.started',
    'plan.reclassified',
    'plan.review_completed',
    'plan.gate_completed',
    'plan.completed',
    'plan.execution_outcome',
  ]);
  for (const event of events) {
    assert.equal(event.schema_version, 1);
    assert.match(event.event_id, /^plan_evt_/);
    assert.equal(event.plan_run_id, start.planRunId);
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(event.feature_root, '.spectre/features/cli');
    assert.equal(event.scope_hash, scopeHash);
  }
  assert.equal(events[0].payload.size, 'XS');
  assert.equal(events[0].payload.shape, 'ATOMIC');
  assert.equal(events[0].payload.probe_used, true);
  assert.equal(events[0].payload.probe_sufficient, true);
  assert.equal(events[0].payload.protected_boundaries.length, 1);
  assert.match(events[0].payload.protected_boundaries[0].invariant_hash, /^[a-f0-9]{64}$/);
  assert.match(events[0].payload.protected_boundaries[0].failure_mode_hash, /^[a-f0-9]{64}$/);
  assert.equal(events[1].payload.observed_size, 'M');
  assert.equal(events[1].payload.initial_size, 'S');
  assert.equal(events[1].payload.regret_direction, 'LARGER');
  assert.equal(events[1].plan_hash, planHash);
  assert.equal(events[2].payload.finding_count, 2);
  assert.equal(events[2].payload.structure_after, 4);
  assert.equal(events[3].payload.gate_kind, 'final');
  assert.equal(events[3].payload.change_category, 'none');
  assert.deepEqual(events[4].payload.artifact_hashes, [planHash, 'd'.repeat(64)]);
  assert.equal(events[4].payload.planning_elapsed_ms, 1234);
  assert.equal(events[5].execution_run_id, 'run_11111111-1111-4111-8111-111111111111');
  assert.equal(events[5].plan_hash, planHash);
  assert.equal(events[5].payload.task_count, 9);
  assert.equal(events[5].payload.proof_result, 'PASS');
  assert.deepEqual(events[5].payload.surprise_codes, ['UNPLANNED_DEPENDENCY']);
  assert.equal(events[5].payload.authoritative, false);
});

test('plan telemetry is discoverable, start is unique, and errors stay coded JSON without --json', (t) => {
  const value = makeFixture(t);
  const scopeHash = 'a'.repeat(64);
  const help = invoke(BUNDLED_CLI_PATH, ['help'], value);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--shape <ATOMIC\|DIRECT\|STRUCTURED>/);
  assert.match(help.stdout, /--probe-used <true\|false>/);
  assert.match(help.stdout, /--previous-classification <size>/);
  assert.match(help.stdout, /--regret-direction <NONE\|SMALLER\|LARGER>/);
  assert.match(help.stdout, /--review-kind <correctness\|simplification\|task>/);
  assert.match(help.stdout, /--finding-count <n>/);
  assert.match(help.stdout, /--gate-kind <design\|final>/);
  assert.match(help.stdout, /--artifact-hashes <sha256,\.\.\.>/);
  assert.match(help.stdout, /--outcome-status <status>/);
  assert.match(help.stdout, /--proof-result <PASS\|FAIL\|PARTIAL\|SKIPPED>/);
  assert.match(help.stdout, /--execution-review-result <CLEAN\|FINDINGS\|SKIPPED>/);
  assert.match(help.stdout, /--surprise-codes <codes>/);
  assert.match(help.stdout, /plan match --feature-root <path> --artifact-hash <sha256>/);

  const started = invoke(BUNDLED_CLI_PATH, [
    'plan', 'start',
    '--feature-root', '.spectre/features/cli',
    '--scope-hash', scopeHash,
    '--classification', 'XS',
    '--shape', 'ATOMIC',
    '--uncertainty', 'LOW',
    '--evidence', 'PROBED',
    '--task-graph-risk', 'LOW',
    '--route', 'XS_DIRECT',
    '--design-authority-required', 'false',
    '--probe-used', 'true',
    '--probe-sufficient', 'true',
    '--reason-codes', 'known-pattern',
    '--project-dir', value.projectDir,
  ], value);
  assert.equal(started.status, 0, started.stderr);
  const start = JSON.parse(started.stdout);

  const duplicate = invoke(BUNDLED_CLI_PATH, [
    'plan', 'record',
    '--plan-run-id', start.planRunId,
    '--event-type', 'plan.started',
    '--feature-root', '.spectre/features/cli',
    '--scope-hash', scopeHash,
    '--project-dir', value.projectDir,
  ], value);
  assert.notEqual(duplicate.status, 0);
  assert.deepEqual(JSON.parse(duplicate.stdout), {
    ok: false,
    code: 'INVALID_PLAN_ENUM',
    message: 'plan.started is only valid through plan start',
  });
  assert.equal(duplicate.stderr, '');

  const invalid = invoke(BUNDLED_CLI_PATH, [
    'plan', 'record',
    '--plan-run-id', start.planRunId,
    '--event-type', 'plan.gate_completed',
    '--feature-root', '.spectre/features/cli',
    '--scope-hash', scopeHash,
    '--gate-kind', 'not-a-gate',
    '--gate-outcome', 'approved',
    '--change-category', 'none',
    '--project-dir', value.projectDir,
  ], value);
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).code, 'INVALID_PLAN_ENUM');
  assert.equal(invalid.stderr, '');

  const topLevelInvalid = invoke(CLI_PATH, [
    'workflow',
    'plan', 'record',
    '--plan-run-id', start.planRunId,
    '--event-type', 'plan.gate_completed',
    '--feature-root', '.spectre/features/cli',
    '--scope-hash', scopeHash,
    '--gate-kind', 'not-a-gate',
    '--gate-outcome', 'approved',
    '--change-category', 'none',
    '--project-dir', value.projectDir,
  ], value);
  assert.notEqual(topLevelInvalid.status, 0);
  assert.equal(JSON.parse(topLevelInvalid.stdout).code, 'INVALID_PLAN_ENUM');
  assert.equal(topLevelInvalid.stderr, '');
});

test('plan telemetry imports a legacy working-tree log without modifying it', async (t) => {
  const value = makeFixture(t);
  const artifactHash = 'b'.repeat(64);
  const scopeHash = 'a'.repeat(64);
  const planRunId = 'plan_run_11111111-1111-4111-8111-111111111111';
  const legacyPath = path.join(
    value.projectDir,
    '.spectre',
    'telemetry',
    'plan-classification.jsonl',
  );
  const legacyEvent = {
    schema_version: 1,
    event_id: 'plan_evt_22222222-2222-4222-8222-222222222222',
    plan_run_id: planRunId,
    timestamp: '2026-08-26T00:00:00.000Z',
    event_type: 'plan.completed',
    feature_root: '.spectre/features/cli',
    scope_hash: scopeHash,
    payload: { artifact_hashes: [artifactHash] },
  };
  const legacyBytes = `${JSON.stringify(legacyEvent)}\n`;
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, legacyBytes);

  const matched = invoke(BUNDLED_CLI_PATH, [
    'plan', 'match',
    '--feature-root', '.spectre/features/cli',
    '--artifact-hash', artifactHash,
    '--project-dir', value.projectDir,
  ], value);
  assert.equal(matched.status, 0, matched.stderr);
  assert.deepEqual(JSON.parse(matched.stdout), {
    ok: true,
    planRunId,
    scopeHash,
    artifactHash,
  });
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyBytes);

  const resolved = await resolveProjectStore(value.projectDir, { spectreHome: value.spectreHome });
  const externalPath = path.join(resolved.storePath, 'workflow', 'plan', 'events.jsonl');
  assert.equal(fs.readFileSync(externalPath, 'utf8'), legacyBytes);
  const migration = JSON.parse(fs.readFileSync(
    path.join(resolved.storePath, 'migrations', 'plan-telemetry-worktree-v1.json'),
    'utf8',
  ));
  assert.equal(migration.importedEventCount, 1);
  assert.equal(migration.result, 'imported');
});

test('plan telemetry migrates the legacy flat external log into the Plan namespace', async (t) => {
  const value = makeFixture(t);
  const artifactHash = 'c'.repeat(64);
  const scopeHash = 'd'.repeat(64);
  const planRunId = 'plan_run_33333333-3333-4333-8333-333333333333';
  const resolved = await resolveProjectStore(value.projectDir, { spectreHome: value.spectreHome });
  const legacyPath = path.join(resolved.storePath, 'workflow', 'plan-classification.jsonl');
  const legacyEvent = {
    schema_version: 1,
    event_id: 'plan_evt_44444444-4444-4444-8444-444444444444',
    plan_run_id: planRunId,
    timestamp: '2026-08-27T00:00:00.000Z',
    event_type: 'plan.completed',
    feature_root: '.spectre/features/cli',
    scope_hash: scopeHash,
    payload: { artifact_hashes: [artifactHash] },
  };
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, `${JSON.stringify(legacyEvent)}\n`);

  const matched = invoke(BUNDLED_CLI_PATH, [
    'plan', 'match',
    '--feature-root', '.spectre/features/cli',
    '--artifact-hash', artifactHash,
    '--project-dir', value.projectDir,
  ], value);
  assert.equal(matched.status, 0, matched.stderr);
  assert.equal(JSON.parse(matched.stdout).planRunId, planRunId);

  const namespacedPath = path.join(resolved.storePath, 'workflow', 'plan', 'events.jsonl');
  assert.equal(fs.readFileSync(namespacedPath, 'utf8'), `${JSON.stringify(legacyEvent)}\n`);
  assert.equal(fs.existsSync(legacyPath), false);
});

test('workflow CLI rejects plan telemetry payload keys outside the allow-list', (t) => {
  const value = makeFixture(t);
  const invalid = invoke(BUNDLED_CLI_PATH, [
    'plan',
    'start',
    '--feature-root',
    '.spectre/features/cli',
    '--scope-hash',
    'a'.repeat(64),
    '--classification',
    'MICRO',
    '--payload-json',
    JSON.stringify({ classification: 'MICRO', private_prose: 'do not persist' }),
    '--project-dir',
    value.projectDir,
    '--json',
  ], value);
  assert.notEqual(invalid.status, 0);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false,
    code: 'INVALID_PLAN_PAYLOAD',
    message: 'plan.started payload contains unsupported key private_prose',
  });
  assert.equal(invalid.stderr, '');
});

test('run status reports the resume frontier without leaking run internals', (t) => {
  const value = makeFixture(t);
  const common = ['--project-dir', value.projectDir, '--json'];
  const run = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'run', 'start', '--source', value.sourcePath, ...common,
  ], value).stdout);
  const ids = ['--run-id', run.runId, '--actor-id', run.primaryActorId];

  const pending = invoke(BUNDLED_CLI_PATH, ['run', 'status', '--run-id', run.runId, ...common], value);
  assert.equal(pending.status, 0, pending.stderr);
  const initial = JSON.parse(pending.stdout);
  assert.deepEqual(Object.keys(initial).sort(), ['ok', 'runId', 'status', 'tasks']);
  assert.equal(initial.ok, true);
  assert.equal(initial.runId, run.runId);
  assert.equal(initial.status, 'active');
  assert.deepEqual(initial.tasks, { '1.1': 'pending', '1.1.1': 'pending' });

  const dispatched = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'agent', 'dispatch', ...ids, '--tasks', '1.1,1.1.1', '--attempt', '1', ...common,
  ], value).stdout);
  for (const taskId of ['1.1', '1.1.1']) {
    invoke(BUNDLED_CLI_PATH, [
      'task', 'start', '--run-id', run.runId,
      '--actor-id', dispatched.workerActorId, '--task-id', taskId, ...common,
    ], value);
  }
  const started = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'run', 'status', '--run-id', run.runId, ...common,
  ], value).stdout);
  assert.deepEqual(started.tasks, { '1.1': 'in_progress', '1.1.1': 'in_progress' });

  const gate = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'gate', 'record', ...ids, '--kind', 'verification', '--status', 'pass',
    '--tasks', '1.1,1.1.1', '--checks', 'test:focused', '--wave-id', '1', ...common,
  ], value).stdout);
  for (const taskId of ['1.1.1', '1.1']) {
    invoke(BUNDLED_CLI_PATH, [
      'task', 'submit', '--run-id', run.runId,
      '--actor-id', dispatched.workerActorId, '--task-id', taskId, ...common,
    ], value);
  }
  invoke(BUNDLED_CLI_PATH, [
    'task', 'complete', ...ids, '--task-id', '1.1.1', '--gate-event-id', gate.eventId, ...common,
  ], value);

  const mixed = invoke(BUNDLED_CLI_PATH, ['run', 'status', '--run-id', run.runId, ...common], value);
  assert.equal(mixed.status, 0, mixed.stderr);
  const frontier = JSON.parse(mixed.stdout);
  assert.equal(frontier.tasks['1.1.1'], 'completed');
  assert.equal(
    frontier.tasks['1.1'],
    'in_progress',
    'a submitted task is not accepted and must never read as completed',
  );
  assert.doesNotMatch(
    mixed.stdout,
    /sourceRawHash|sourceDefinitionHash|taskDefinition|gateEventId|primaryActorId|contractHash|checkoutId/,
  );
});

test('run status is read-only and fails cleanly for an unknown run', (t) => {
  const value = makeFixture(t);
  const common = ['--project-dir', value.projectDir, '--json'];
  const run = JSON.parse(invoke(BUNDLED_CLI_PATH, [
    'run', 'start', '--source', value.sourcePath, ...common,
  ], value).stdout);

  const watched = [
    value.sourcePath,
    path.join(value.spectreHome, 'projects'),
  ];
  const before = watched.map((target) => JSON.stringify(fs.statSync(target).mtimeMs));
  const read = invoke(BUNDLED_CLI_PATH, ['run', 'status', '--run-id', run.runId, ...common], value);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(
    watched.map((target) => JSON.stringify(fs.statSync(target).mtimeMs)),
    before,
    'run status must not write',
  );

  const missing = invoke(BUNDLED_CLI_PATH, [
    'run', 'status', '--run-id', 'run_00000000-0000-4000-8000-000000000000', ...common,
  ], value);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).code, 'RUN_NOT_FOUND');
  assert.equal(missing.stderr, '');
});
