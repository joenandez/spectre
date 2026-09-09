import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { aggregate, attachNativeUsage, cohortReport, compactSnapshot, evaluateKnowledge, evaluationActorContext, evaluationQualityReport, freeze, judgeCell, knowledgeBypassEvidence, limitsForFixture, mergeHostRuns, noKnowledgeRuntimeFacts, normalizeUsage, pairedReport, primaryJudgmentReport, promptContract, replayCachedRuntime, runCells, selectFrozenCells, thresholdReport, traceRuntimeFacts, traceWithOperationCrosscheck } from './evaluate-knowledge.mjs';

test('knowledge evaluation freezes twelve hidden-oracle cases and matched host cells', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-'));
  const fixtures = path.join(root, 'fixtures'); fs.mkdirSync(fixtures);
  const cases = Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}` }));
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), JSON.stringify({ artifactPath: 'artifacts/decision.md', cases }));
  const oracle = path.join(root, 'oracle.json'); fs.writeFileSync(oracle, JSON.stringify({ 'case-0': 'gold-label' }));
  const output = path.join(root, 'freeze.json');
  const frozen = freeze(fixtures, oracle, output);
  assert.equal(frozen.cells.length, 12 * 3 * 2 * 2);
  assert.ok(frozen.cells.every((cell) => cell.artifactPath === 'artifacts/decision.md' && !cell.artifactPath.includes(cell.caseId)));
  assert.deepEqual(frozen.concurrency, { total: 4, perHost: 2 });
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), JSON.stringify({ artifactPath: 'artifacts/decision.md', cases, leaked: 'gold-label' }));
  assert.throws(() => freeze(fixtures, oracle, output), /leaked/);
});

test('usage normalization preserves missing native fields as unknown and aggregates runtime separately', () => {
  assert.deepEqual(normalizeUsage({ input: 4, output: 3 }), { input: 4, cache: 'unknown', cacheWrite: 'unknown', output: 3, reasoning: 'unknown' });
  const report = aggregate([{ runtime: { injectedTokens: 3, previewTokens: 4, loadedBodyTokens: 5, redundantTokens: 0, totalTokens: 12 }, judged: { required: true, recalled: true } }]);
  assert.equal(report.runtime.totalTokens.median, 12);
  assert.equal(report.judged.requiredRecall, true);
});

test('freeze binds configuration and candidate content, while missing oracle judgments cannot pass', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-freeze-'));
  const fixtures = path.join(root, 'fixtures'); const candidate = path.join(root, 'candidate');
  fs.mkdirSync(fixtures); fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), JSON.stringify({ artifactPath: 'artifacts/decision.md', cases: Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}`, task: `Task ${index}` })) }));
  const oracle = path.join(root, 'oracle.json'); fs.writeFileSync(oracle, JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`case-${index}`, { requiredPhrases: [`answer-${index}`] }]))));
  const configuration = path.join(root, 'config.json'); fs.writeFileSync(configuration, JSON.stringify({ model: 'test-model', effort: 'medium' }));
  fs.writeFileSync(path.join(candidate, 'plugin.txt'), 'candidate-v1');
  const frozen = freeze(fixtures, oracle, path.join(root, 'freeze.json'), { configurationPath: configuration, candidatePath: candidate });
  assert.match(frozen.hashes.configuration, /^sha256:/);
  assert.match(frozen.hashes.candidate, /^sha256:/);
  const cells = await runCells(frozen, path.join(root, 'cells'), async () => ({ status: 'completed', textFinalAnswers: ['answer-0'], deliverable: { exists: true, bytes: 1 }, trace: { availability: 'available', events: [] } }));
  assert.equal(cells.cells.find((cell) => cell.caseId === 'case-0').judged.recalled, true);
  assert.equal(cells.cells.find((cell) => cell.caseId === 'case-1').status, 'invalid');
  assert.deepEqual(judgeCell({ caseId: 'case-1' }, { status: 'completed', textFinalAnswers: [] }, null), {
    valid: false, recalled: false, reason: 'oracle judgment is missing',
  });
});

test('freeze invalidates native cache inputs when the canonical payload estimator changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-payload-hash-'));
  const fixtures = path.join(root, 'fixtures'); fs.mkdirSync(fixtures);
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), JSON.stringify({
    artifactPath: 'artifacts/decision.md', cases: Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}` })),
  }));
  const oracle = path.join(root, 'oracle.json');
  fs.writeFileSync(oracle, JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`case-${index}`, {}]))));
  const payloadPath = path.resolve('plugins/spectre/hooks/scripts/knowledge/payload.mjs');
  const original = fs.readFileSync(payloadPath);
  try {
    const before = freeze(fixtures, oracle, path.join(root, 'before.json'));
    fs.writeFileSync(payloadPath, `${original}\n// evaluation payload hash regression\n`);
    const after = freeze(fixtures, oracle, path.join(root, 'after.json'));
    assert.notEqual(after.hashes.nativePipelineInputs, before.hashes.nativePipelineInputs);
  } finally {
    fs.writeFileSync(payloadPath, original);
  }
});

test('runCells honors total and per-host concurrency limits', async () => {
  const cells = [
    { id: 'a', caseId: 'a', host: 'claude' }, { id: 'b', caseId: 'b', host: 'claude' },
    { id: 'c', caseId: 'c', host: 'claude' }, { id: 'd', caseId: 'd', host: 'codex' },
  ];
  let active = 0; let claude = 0; let maximum = 0; let maximumClaude = 0;
  await runCells({ cells, concurrency: { total: 2, perHost: 1 }, oracle: {} }, os.tmpdir(), async (cell) => {
    active += 1; if (cell.host === 'claude') claude += 1;
    maximum = Math.max(maximum, active); maximumClaude = Math.max(maximumClaude, claude);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1; if (cell.host === 'claude') claude -= 1;
    return { status: 'completed', textFinalAnswers: [] };
  });
  assert.equal(maximum, 2);
  assert.equal(maximumClaude, 1);
});

test('deterministic freeze gates native calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-stage-'));
  const fixtures = path.join(root, 'fixtures'); fs.mkdirSync(fixtures);
  fs.writeFileSync(path.join(fixtures, 'manifest.json'), JSON.stringify({ artifactPath: 'artifacts/decision.md', cases: Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}` })) }));
  const oracle = path.join(root, 'oracle.json'); fs.writeFileSync(oracle, JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`case-${index}`, { requiredPhrases: [] }]))));
  const frozen = freeze(fixtures, oracle, path.join(root, 'freeze.json'));
  await assert.rejects(() => evaluateKnowledge(frozen, { fixtureRoot: fixtures }), /allowNative/);
});

test('native qualification selects only named frozen cells', () => {
  const frozen = { cells: [{ id: 'critical:candidate:claude:1' }, { id: 'critical:candidate:codex:1' }] };
  assert.deepEqual(selectFrozenCells(frozen, ['critical:candidate:codex:1']).cells, [{ id: 'critical:candidate:codex:1' }]);
  assert.throws(() => selectFrozenCells(frozen, ['not-frozen']), /unknown frozen cell/);
});

test('a frozen cell result resumes only when its freeze hash matches', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-resume-'));
  const manifest = {
    hashes: { fixtures: 'fixture-hash', oracle: 'oracle-hash' }, cells: [{ id: 'case:baseline:claude:1', caseId: 'case', host: 'claude' }],
    concurrency: { total: 1, perHost: 1 }, oracle: { case: { requiredPhrases: ['answer'] } },
  };
  let calls = 0;
  const invoke = async () => { calls += 1; return { status: 'completed', textFinalAnswers: ['answer'], deliverable: { exists: true, bytes: 1 } }; };
  await runCells(manifest, output, invoke);
  await runCells(manifest, output, invoke);
  await runCells({ ...manifest, cells: [{ ...manifest.cells[0], promptHash: 'changed-prompt' }] }, output, invoke);
  await runCells({ ...manifest, hashes: { fixtures: 'changed', oracle: 'oracle-hash' } }, output, invoke);
  assert.equal(calls, 3);
});

test('candidate-only plugin changes reuse frozen controls while pipeline and prompt changes invalidate their cells', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-condition-cache-'));
  const cells = ['candidate', 'baseline', 'no-knowledge'].map((condition) => ({
    id: `case:${condition}:claude:1`, caseId: 'case', condition, host: 'claude', promptHash: `prompt-${condition}`,
  }));
  const manifest = {
    hashes: { fixtures: 'fixture-hash', oracle: 'oracle-hash', configuration: 'config-hash', candidate: 'candidate-v1', nativePipelineInputs: 'pipeline-v1' },
    baseline: 'baseline-pinned-sha', cells, concurrency: { total: 3, perHost: 3 }, oracle: { case: { requiredPhrases: ['answer'] } },
  };
  const calls = [];
  const invoke = async (cell) => {
    calls.push(cell.condition);
    return { status: 'completed', textFinalAnswers: ['answer'], deliverable: { exists: true, bytes: 1 } };
  };
  await runCells(manifest, output, invoke);
  await runCells({ ...manifest, hashes: { ...manifest.hashes, candidate: 'candidate-v2' } }, output, invoke);
  assert.deepEqual(calls, ['candidate', 'baseline', 'no-knowledge', 'candidate']);
  await runCells({ ...manifest, hashes: { ...manifest.hashes, candidate: 'candidate-v2', nativePipelineInputs: 'pipeline-v2' } }, output, invoke);
  assert.equal(calls.length, 7);
  await runCells({ ...manifest, hashes: { ...manifest.hashes, candidate: 'candidate-v2', nativePipelineInputs: 'pipeline-v2' }, cells: cells.map((cell) =>
    cell.condition === 'baseline' ? { ...cell, promptHash: 'prompt-baseline-v2' } : cell
  ) }, output, invoke);
  assert.deepEqual(calls.slice(-1), ['baseline']);
});

test('a thrown cell is persisted as failed while other frozen cells continue', async () => {
  const result = await runCells({
    cells: [{ id: 'first', caseId: 'case', host: 'claude' }, { id: 'second', caseId: 'case', host: 'codex' }],
    concurrency: { total: 2, perHost: 1 }, oracle: { case: { requiredPhrases: [] } },
  }, fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-cell-error-')), async (cell) => {
    if (cell.id === 'first') throw new Error('fixture setup unavailable');
    return { status: 'completed', textFinalAnswers: [], deliverable: { exists: true, bytes: 1 } };
  });
  assert.equal(result.cells.find((cell) => cell.id === 'first').runtime.status, 'launch_failed');
  assert.equal(result.cells.find((cell) => cell.id === 'second').status, 'completed');
});

test('lifecycle prompts use user transport only where the plugin exists', () => {
  const entry = { id: 'lifecycle-identity', workflowCommandSession: 0, longitudinalSteps: [
    'Start a fresh session. As the user-requested workflow command, run {EXECUTE_COMMAND} --orchestrated --finalization-owner parent --review-profile final-only for the staged feature. Do work.',
    'Learn the work.',
    'Start a fresh session. As the user-requested workflow command, run {SHIP_COMMAND}: refresh the work.',
  ] };
  assert.match(promptContract(entry, 'artifacts/decision.md', 'claude', 'candidate')[0], /^\/spectre:spectre-execute \.spectre\/features\/evaluation-cell\/specs\/execute\.md /);
  assert.match(promptContract(entry, 'artifacts/decision.md', 'codex', 'candidate')[2], /^spectre-ship \.spectre\/features\/evaluation-cell\n/);
  assert.match(promptContract(entry, 'artifacts/decision.md', 'claude', 'candidate')[0], /--finalization-owner parent/);
  assert.doesNotMatch(promptContract(entry, 'artifacts/decision.md', 'claude', 'candidate')[2], /\nspectre-ship:/);
  assert.doesNotMatch(promptContract(entry, 'artifacts/decision.md', 'claude', 'no-knowledge')[2], /spectre:|spectre-ship/);
  const accepted = { id: 'accepted-decision', workflowCommandSession: 1, longitudinalSteps: ['Learn without evidence.', 'Review accepted evidence.'] };
  const verified = { id: 'verified-gotcha', workflowCommandSession: 0, longitudinalSteps: ['Review verified evidence.'] };
  assert.match(promptContract(accepted, 'artifacts/decision.md', 'claude', 'candidate')[1], /^\/spectre:spectre-execute \.spectre\/features\/evaluation-cell\/specs\/execute\.md /);
  assert.match(promptContract(verified, 'artifacts/decision.md', 'codex', 'candidate')[0], /^spectre-execute \.spectre\/features\/evaluation-cell\/specs\/execute\.md /);
  const learn = { id: 'accepted-decision', userLearnSessions: [0], longitudinalSteps: ['Invoke Learn without evidence.'] };
  assert.match(promptContract(learn, 'artifacts/decision.md', 'claude', 'candidate')[0], /^\/spectre:spectre-learn\n/);
  assert.match(promptContract(learn, 'artifacts/decision.md', 'codex', 'candidate')[0], /^spectre-learn\n/);
  assert.doesNotMatch(promptContract(learn, 'artifacts/decision.md', 'claude', 'no-knowledge')[0], /^\/spectre:|^spectre-learn/);
});

test('longitudinal correction table keeps ordinary evidence identical while only candidates invoke Learn', () => {
  const fixtures = JSON.parse(fs.readFileSync('scripts/knowledge-evaluation-fixtures/manifest.json', 'utf8'));
  const correction = fixtures.cases.find((entry) => entry.id === 'longitudinal-correction');
  for (const { host, learnCommand } of [
    { host: 'claude', learnCommand: '/spectre:spectre-learn' },
    { host: 'codex', learnCommand: 'spectre-learn' },
  ]) {
    const candidate = promptContract(correction, fixtures.artifactPath, host, 'candidate');
    const noKnowledge = promptContract(correction, fixtures.artifactPath, host, 'no-knowledge');
    const command = new RegExp(`^${learnCommand.replace('/', '\\/')}(?:\\s|$)`);
    const withoutCandidateCommand = candidate.map((prompt) => prompt.replace(new RegExp(`^${learnCommand.replace('/', '\\/')}\\n`), ''));

    assert.equal(candidate.filter((prompt) => command.test(prompt)).length, 2, host);
    assert.doesNotMatch(noKnowledge.join('\n'), /learn|spectre-learn|missing workflow command/i, host);
    assert.deepEqual(withoutCandidateCommand, noKnowledge, host);
    assert.match(noKnowledge[0], /retry-ceiling is five/, host);
    assert.match(noKnowledge[2], /current ceiling is three/, host);
    assert.doesNotMatch(noKnowledge.at(-1), /three attempts|five attempts/, host);
    assert.doesNotMatch(candidate.at(-1), /three attempts|five attempts/, host);
  }
});

test('selected cells reject a re-derived prompt hash mismatch before host invocation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-prompt-hash-'));
  const fixtures = path.resolve('scripts/knowledge-evaluation-fixtures');
  const oracle = path.resolve('scripts/knowledge-evaluation-oracle.json');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ hosts: { claude: { model: 'fake', effort: 'low' } } }));
  const frozen = freeze(fixtures, oracle, path.join(root, 'freeze.json'), {
    configurationPath: config,
    candidatePath: path.resolve('plugins/spectre'),
  });
  const cell = frozen.cells.find((entry) => entry.id === 'longitudinal-correction:no-knowledge:claude:1');
  frozen.cells = [{ ...cell, promptHash: 'sha256:tampered' }];
  let hostCalls = 0;

  await assert.rejects(() => evaluateKnowledge(frozen, {
    allowNative: true,
    fixtureRoot: fixtures,
    configuration: JSON.parse(fs.readFileSync(config, 'utf8')),
    repositoryRoot: process.cwd(),
    outputDir: path.join(root, 'output'),
    temporaryRoot: root,
    cellIds: [cell.id],
    invokeHost: async () => { hostCalls += 1; throw new Error('host must not run'); },
  }), /prompt hash.*longitudinal-correction:no-knowledge:claude:1/i);
  assert.equal(hostCalls, 0);
});

test('selected cells reject a re-derived fixture hash mismatch before host invocation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-fixture-hash-'));
  const sourceFixtures = path.resolve('scripts/knowledge-evaluation-fixtures');
  const fixtures = path.join(root, 'fixtures-copy');
  const oracle = path.resolve('scripts/knowledge-evaluation-oracle.json');
  const config = path.join(root, 'config.json');
  fs.cpSync(sourceFixtures, fixtures, { recursive: true });
  const manifestPath = path.join(fixtures, 'manifest.json');
  const copiedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  copiedManifest.cases.find((entry) => entry.id === 'irrelevant-task').initialFacts[0].content = 'Warehouse snapshots are retained for ninety-one days.';
  fs.writeFileSync(manifestPath, `${JSON.stringify(copiedManifest, null, 2)}\n`);
  fs.writeFileSync(config, JSON.stringify({ hosts: { claude: { model: 'fake', effort: 'low' } } }));
  const frozen = freeze(sourceFixtures, oracle, path.join(root, 'freeze.json'), {
    configurationPath: config,
    candidatePath: path.resolve('plugins/spectre'),
  });
  const cell = frozen.cells.find((entry) => entry.id === 'irrelevant-task:no-knowledge:claude:1');
  frozen.cells = [cell];
  let hostCalls = 0;

  await assert.rejects(() => evaluateKnowledge(frozen, {
    allowNative: true,
    fixtureRoot: fixtures,
    configuration: JSON.parse(fs.readFileSync(config, 'utf8')),
    repositoryRoot: process.cwd(),
    outputDir: path.join(root, 'output'),
    temporaryRoot: root,
    cellIds: [cell.id],
    invokeHost: async () => { hostCalls += 1; throw new Error('host must not run'); },
  }), /fixture hash.*irrelevant-task:no-knowledge:claude:1/i);
  assert.equal(hostCalls, 0);
});

test('workflow fixtures receive the frozen extended timeout without changing ordinary tasks', () => {
  const limits = { ordinary: { timeoutMs: 600000 }, workflow: { timeoutMs: 1200000 } };
  assert.deepEqual(limitsForFixture({ cohort: 'chat' }, limits), limits.ordinary);
  assert.deepEqual(limitsForFixture({ cohort: 'workflow' }, limits), limits.workflow);
  assert.deepEqual(limitsForFixture({ longitudinal: true, cohort: 'chat' }, limits), limits.workflow);
});

test('merged workflow failures retain the failed session exit rather than a later successful exit', () => {
  const merged = mergeHostRuns([
    { status: 'timed_out', exit: { exitCode: null, signal: 'SIGKILL', timedOut: true }, traceUnavailable: true },
    { status: 'completed', exit: { exitCode: 0, signal: null, timedOut: false }, traceUnavailable: false },
  ]);
  assert.equal(merged.status, 'timed_out');
  assert.deepEqual(merged.exit, { exitCode: null, signal: 'SIGKILL', timedOut: true });
  assert.equal(merged.traceUnavailable, true);
});

test('native actor and context inputs are opaque to fixture labels', () => {
  const values = evaluationActorContext({ caseId: 'critical-old-constraint', host: 'claude', condition: 'candidate', repeat: 1 }, 2);
  assert.match(values.actorId, /^evaluation-[a-f0-9]+$/);
  assert.match(values.contextId, /^evaluation-[a-f0-9]+$/);
  assert.doesNotMatch(`${values.actorId}:${values.contextId}`, /critical|constraint|candidate|claude/);
});

test('manual semantic adjudication remains pending rather than an invalid host run', async () => {
  const result = await runCells({
    cells: [{ id: 'case:candidate:claude:1', caseId: 'case', condition: 'candidate', host: 'claude' }],
    concurrency: { total: 1, perHost: 1 }, oracle: { case: { requiredRecordHashes: [], manualRubric: 'review' } },
  }, fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evaluation-pending-')), async () => ({
    status: 'completed', deliverablePath: 'artifact.md', deliverable: { exists: true, bytes: 1 },
    toolOperations: [{ name: 'Write', status: 'completed', eventOrdinal: 1, input: { file_path: 'artifact.md' } }], trace: { availability: 'available', events: [] }, bypass: [],
  }));
  assert.equal(result.cells[0].status, 'pending');
});

test('primary judgments bind a reviewed conclusion to the persisted artifact hash', () => {
  const cells = [{ id: 'critical:candidate:claude:1', condition: 'candidate', critical: true, runtime: { deliverable: { hash: 'sha256:artifact' } } }];
  const accepted = primaryJudgmentReport(cells, [{
    cellId: cells[0].id, artifactHash: 'sha256:artifact', artifactEvidence: 'sha256:artifact',
    correct: true, relevant: true, requiredRecallBeforeDecision: true, irrelevantTokens: 0, unnecessaryHistoryLoads: 0, justifiedExpansions: [],
  }]);
  assert.equal(accepted.status, 'reviewed');
  assert.equal(primaryJudgmentReport(cells, [{ ...accepted.reviewed[0], cellId: cells[0].id, artifactHash: 'sha256:wrong', artifactEvidence: 'sha256:wrong' }]).status, 'invalid');
});

test('quality report keeps incomplete controls and unreviewed artifacts pending', () => {
  const cells = [{
    id: 'critical:candidate:claude:1', condition: 'candidate', host: 'claude', critical: true,
    runtime: { status: 'completed', trace: { availability: 'available' }, nativeFullCycleUsage: { coverage: 'complete' }, deliverable: { hash: 'sha256:artifact' } },
    judged: { structuralValid: true, recalled: null },
  }];
  const quality = evaluationQualityReport(cells, []);
  assert.equal(quality.status, 'pending');
  assert.equal(quality.observedSamples, 1);
  assert.equal(quality.controls.candidate.nativeFullCycleUsage.known, 1);
  assert.equal(quality.controls.candidate.trace.available, 1);
  assert.equal(quality.controls.baseline.postHocPayloadMetrics.available, 0);
});

test('a proven no-knowledge isolation reports zero knowledge delivery without zeroing native task usage', () => {
  const result = noKnowledgeRuntimeFacts({ usage: { primary: { input: 8 }, fullCycle: { coverage: 'complete', total: { input: 8, output: 3 } }, sessionStartMeasurement: { availability: 'none' } } }, true);
  assert.deepEqual({
    injectedTokens: result.injectedTokens, previewTokens: result.previewTokens, loadedBodyTokens: result.loadedBodyTokens,
    resourceTokens: result.resourceTokens, redundantTokens: result.redundantTokens, totalTokens: result.totalTokens,
  }, { injectedTokens: 0, previewTokens: 0, loadedBodyTokens: 0, resourceTokens: 0, redundantTokens: 0, totalTokens: 0 });
  assert.deepEqual(result.nativeFullCycleUsage, { coverage: 'complete', total: { input: 8, output: 3 } });
  assert.equal(noKnowledgeRuntimeFacts({}, false).loadedBodyTokens, null);
});

test('post-hoc baseline facts retain native usage reported by the host', () => {
  const usage = { primary: { input: 10 }, fullCycle: { coverage: 'complete', total: { input: 10, output: 2 } } };
  assert.deepEqual(attachNativeUsage({ loadedBodyTokens: 7, nativePrimaryUsage: null, nativeFullCycleUsage: null }, { usage }), {
    loadedBodyTokens: 7, nativePrimaryUsage: usage.primary, nativeFullCycleUsage: usage.fullCycle,
  });
});

test('thresholds use hash-bound manual outcomes, bounded trace metrics, and quality-gated benefit pairs', () => {
  const usage = { coverage: 'complete', total: { input: 10, cache: 0, cacheWrite: 0, output: 5, reasoning: null } };
  const runtime = (condition, hash) => ({
    nativeFullCycleUsage: usage, deliverable: { hash }, loadedBodyTokens: condition === 'candidate' ? 100 : 0,
    redundantTokens: 0, sessionStartMeasurement: condition === 'no-knowledge' ? { availability: 'none' } : { availability: 'available' },
    usage: { sessions: [{ sessionStartMeasurement: { availability: 'available', injectedTokens: 200 } }] },
    trace: condition === 'candidate' ? { availability: 'available', events: [
      { type: 'search', responseTokens: 300 }, { type: 'load', loadedTokens: 100 },
    ] } : { availability: 'unavailable', events: [] },
  });
  const cells = ['baseline', 'candidate', 'no-knowledge'].map((condition) => ({
    id: `case:${condition}:claude:1`, caseId: 'case', condition, host: 'claude', repeat: 1, cohort: 'chat', critical: condition === 'candidate',
    runtime: runtime(condition, `sha256:${condition}`), judged: { structuralValid: true, recalled: null },
  }));
  cells[1].runtime.trace.events.push({ type: 'history-read', subtype: 'history-body', loadedTokens: 10 });
  const judgments = cells.map((cell) => ({ cellId: cell.id, artifactHash: cell.runtime.deliverable.hash, artifactEvidence: cell.runtime.deliverable.hash,
    correct: true, relevant: true, requiredRecallBeforeDecision: true, irrelevantTokens: cell.condition === 'candidate' ? 4 : 0, unnecessaryHistoryLoads: 0 }));
  const oracle = { case: { requiredRecordHashes: ['sha256:record'] } };
  const paired = pairedReport(cells, oracle, judgments);
  const report = thresholdReport(cells, paired, oracle, judgments);
  assert.equal(report.requiredRecall, 'pass');
  assert.equal(report.efficiency.startupTokens.status, 'pass');
  assert.equal(report.efficiency.searchPreviewTokens.status, 'pass');
  assert.equal(report.efficiency.routineIrrelevantLoadedBodyRate, .04);
  assert.equal(report.efficiency.criticalHistoryLoads, 0);
  assert.equal(report.pairedEfficiency.qualityEligiblePairs, 1);
  assert.equal(report.correctnessVsBothControls.status, 'pass');
  assert.equal(report.status, 'pending');
});

test('paired reporting flags a regression against either control and never selects cheap failed pairs', () => {
  const usage = { coverage: 'complete', total: { input: 10, cache: 0, cacheWrite: 0, output: 1, reasoning: null } };
  const cells = ['baseline', 'candidate', 'no-knowledge'].map((condition) => ({
    id: `case:${condition}:claude:1`, caseId: 'case', condition, host: 'claude', repeat: 1, cohort: 'workflow', critical: false,
    runtime: { deliverable: { hash: `sha256:${condition}` }, nativeFullCycleUsage: usage, loadedBodyTokens: 1, redundantTokens: 0,
      usage: { sessions: [{ sessionStartMeasurement: { availability: 'available', injectedTokens: 1 } }] },
      trace: condition === 'candidate' ? { availability: 'available', events: [] } : { availability: 'unavailable', events: [] } },
    judged: { structuralValid: true, recalled: null },
  }));
  const judgments = cells.map((cell) => ({ cellId: cell.id, artifactHash: cell.runtime.deliverable.hash, artifactEvidence: cell.runtime.deliverable.hash,
    correct: cell.condition !== 'candidate', relevant: true, requiredRecallBeforeDecision: true, irrelevantTokens: 0, unnecessaryHistoryLoads: 0 }));
  const oracle = { case: { requiresCapture: true } };
  const paired = pairedReport(cells, oracle, judgments);
  const report = thresholdReport(cells, paired, oracle, judgments);
  assert.equal(paired[0].correctnessVsBothControls, 'regression');
  assert.equal(report.correctnessVsBothControls.status, 'fail');
  assert.equal(report.pairedEfficiency.failedQualityPairs, 1);
  assert.equal(report.pairedEfficiency.hypothesis, 'unknown');
  const improvedJudgments = judgments.map((judgment) => ({ ...judgment, correct: judgment.cellId.includes(':candidate:') || judgment.cellId.includes(':baseline:') }));
  const improvedPairs = pairedReport(cells, oracle, improvedJudgments);
  assert.equal(primaryJudgmentReport(cells, improvedJudgments).status, 'reviewed');
  assert.equal(improvedPairs[0].qualityGate, true);
  assert.equal(improvedPairs[0].correctnessVsBothControls, 'no-regression');
  const incomplete = thresholdReport(cells, paired, oracle, judgments.map((judgment) => ({ ...judgment, irrelevantTokens: undefined })));
  assert.equal(incomplete.efficiency.routineIrrelevantLoadedBodyRate, 'unknown');
});

test('report gates every candidate journey while retaining incorrect controls as reviewed comparison evidence', () => {
  const cells = ['first', 'second'].flatMap((caseId) => ['baseline', 'candidate', 'no-knowledge'].map((condition) => ({
    id: `${caseId}:${condition}:claude:1`, caseId, condition, host: 'claude', cohort: 'workflow', critical: false,
    runtime: { status: 'completed', deliverable: { hash: `sha256:${caseId}:${condition}` }, nativeFullCycleUsage: { coverage: 'complete', total: { input: 1, cache: 0, cacheWrite: 0, output: 1, reasoning: null } }, trace: { availability: condition === 'candidate' ? 'available' : 'unavailable', events: [] } },
    judged: { structuralValid: !(caseId === 'second' && condition === 'candidate'), recalled: caseId === 'second' && condition === 'candidate' ? false : null },
  })));
  const judgments = cells.map((cell) => ({
    cellId: cell.id, artifactHash: cell.runtime.deliverable.hash, artifactEvidence: cell.runtime.deliverable.hash,
    correct: cell.condition === 'candidate' && cell.caseId === 'first', relevant: true, requiredRecallBeforeDecision: true,
    irrelevantTokens: 0, unnecessaryHistoryLoads: 0,
  }));
  const quality = evaluationQualityReport(cells, judgments);
  const thresholds = thresholdReport(cells, pairedReport(cells, {}, judgments), {}, judgments);
  assert.equal(quality.manual.status, 'reviewed');
  assert.equal(quality.status, 'fail');
  assert.equal(thresholds.allCandidateDelivery.structural, 'fail');
  assert.equal(thresholds.allCandidateDelivery.semantic, 'fail');
});

test('cohorts retain measured retrieval totals alongside native full-cycle dimensions', () => {
  const cells = [10, 20].map((injectedTokens, index) => ({
    id: `case:candidate:claude:${index + 1}`, caseId: 'case', condition: 'candidate', host: 'claude', cohort: 'chat', status: 'pending',
    runtime: {
      sessions: [{ status: 'completed' }], textFinalAnswers: ['answer'], snapshots: { after: { history: [] } },
      injectedTokens, previewTokens: injectedTokens + 1, loadedBodyTokens: injectedTokens + 2, redundantTokens: 0, totalTokens: injectedTokens + 3,
      nativeFullCycleUsage: { coverage: 'complete', total: { input: 1, cache: 2, cacheWrite: 3, output: 4, reasoning: null } },
    }, judged: { structuralValid: true, recalled: null },
  }));
  const cohort = cohortReport(cells)['candidate:claude:chat'];
  assert.equal(cohort.injectedTokens.median, 10);
  assert.equal(cohort.previewTokens.p95, 21);
  assert.equal(cohort.redundantTokens.median, 0);
  assert.equal(cohort.totalTokens.median, 13);
  assert.equal(cohort.nativePrimaryPlusWorkerTokens.total.median, 10);
});

test('longitudinal snapshots retain captured records and history after an unchanged fresh session', () => {
  const original = { records: [{ id: 'retry-ceiling-evidence', revisionToken: 'source' }], history: [], workRecords: [] };
  const captured = { records: [...original.records, { id: 'retry-ceiling', revisionToken: 'v1' }], history: [{ id: 'retry-ceiling', revisionToken: 'v1' }], workRecords: [] };
  const firstAfter = compactSnapshot(captured, ['retry-ceiling-evidence'], original);
  const laterAfter = compactSnapshot(captured, ['retry-ceiling-evidence', ...firstAfter.records.map((record) => record.id)], captured);
  assert.deepEqual(firstAfter.records.map((record) => record.id), ['retry-ceiling-evidence', 'retry-ceiling']);
  assert.deepEqual(laterAfter.records.map((record) => record.id), ['retry-ceiling-evidence', 'retry-ceiling']);
  assert.deepEqual(laterAfter.history.map((entry) => entry.id), ['retry-ceiling']);
});

test('judging requires an exact successful load and a later persisted decision artifact', () => {
  const recordId = 'payments-dual-settlement';
  const recordHash = `sha256:${createHash('sha256').update(recordId).digest('hex')}`;
  const cell = { caseId: 'case', condition: 'candidate' };
  const oracle = { case: { requiredRecordHashes: [recordHash], manualRubric: 'manual review' } };
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/case.md', deliverable: { exists: true, bytes: 21 },
    toolOperations: [
      { id: 'load-1', name: 'exec', status: 'completed', eventOrdinal: 4, input: { command: `node knowledge-cli.mjs load ${recordId}` } },
      { id: 'write-1', name: 'Write', status: 'completed', eventOrdinal: 8, input: { file_path: 'artifacts/case.md' } },
    ],
    toolResults: [{ toolUseId: 'load-1', eventOrdinal: 5, content: JSON.stringify({ id: recordId, revisionToken: 'rev-1' }) }],
    trace: { availability: 'available', events: [{ type: 'load', id: recordId, revisionToken: 'rev-1' }] },
    snapshots: { before: { records: [{ id: recordId, revisionToken: 'rev-1' }] } }, bypass: [],
  };
  assert.equal(judgeCell(cell, { ...runtime, deliverable: { exists: false, bytes: null } }, oracle).recalled, false);
  assert.equal(judgeCell(cell, { ...runtime, toolOperations: [runtime.toolOperations[0]] }, oracle).recalled, false);
  const pending = judgeCell(cell, runtime, oracle);
  assert.deepEqual(pending, { valid: false, recalled: null, reason: 'manual semantic adjudication pending', structuralValid: true, manualRubric: 'manual review' });
  const quoted = judgeCell(cell, {
    ...runtime,
    toolOperations: [
      { ...runtime.toolOperations[0], input: { command: `CLI='/fixture/knowledge-cli.mjs'; "$CLI" load '${recordId}'` } }, runtime.toolOperations[1],
    ],
  }, oracle);
  assert.equal(quoted.recalled, null);
  assert.equal(judgeCell(cell, { ...runtime, toolOperations: [
    { ...runtime.toolOperations[0], input: { command: `"$CLI" load '${recordId}'` } }, runtime.toolOperations[1],
  ] }, oracle).recalled, false);
  const codexCounterexample = judgeCell(cell, {
    ...runtime,
    toolOperations: [
      { ...runtime.toolOperations[0], name: 'exec', input: { command: `node knowledge-cli.mjs load ${recordId} && rg --files -g '!artifacts/case.md'` } },
      { id: 'change-1', type: 'file_change', name: 'file_change', status: 'completed', eventOrdinal: 8, input: { changes: [{ path: 'artifacts/case.md' }] } },
    ],
  }, oracle);
  assert.equal(codexCounterexample.recalled, null);
  assert.equal(judgeCell(cell, { ...runtime, toolOperations: [
    { ...runtime.toolOperations[0], eventOrdinal: 9 }, runtime.toolOperations[1],
  ], toolResults: [{ ...runtime.toolResults[0], eventOrdinal: 9 }] }, oracle).recalled, false);
  const control = judgeCell({ ...cell, condition: 'no-knowledge' }, {
    ...runtime, toolOperations: [runtime.toolOperations[1]], toolResults: [], trace: { availability: 'unavailable', events: [] },
  }, oracle);
  assert.equal(control.recalled, null);
  const baselineInspect = judgeCell({ ...cell, condition: 'baseline' }, {
    ...runtime, toolOperations: [
      { ...runtime.toolOperations[0], input: { command: `node knowledge-cli.mjs load ${recordId}` } }, runtime.toolOperations[1],
    ], trace: { availability: 'unavailable', events: [] },
  }, { case: { ...oracle.case, requiredReadCommand: 'inspect' } });
  assert.equal(baselineInspect.structuralValid, true);
  assert.equal(judgeCell(cell, runtime, { case: { requiredRecordHashes: [], allowedLoads: 0, manualRubric: 'manual review' } }).recalled, false);
});

test('historical inspection accepts a successful inspect-historical load and ignores an earlier refused load', () => {
  const recordId = 'notification-batch-history';
  const recordHash = `sha256:${createHash('sha256').update(recordId).digest('hex')}`;
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [
      { id: 'refused', name: 'exec', status: 'failed', eventOrdinal: 1, input: { command: `node knowledge-cli.mjs load ${recordId}` } },
      { id: 'historical', name: 'exec', status: 'completed', eventOrdinal: 3, input: { command: `node knowledge-cli.mjs load ${recordId} --inspect-historical --json` } },
      { id: 'artifact', name: 'Write', status: 'completed', eventOrdinal: 5, input: { file_path: 'artifacts/decision.md' } },
    ],
    toolResults: [
      { toolUseId: 'refused', eventOrdinal: 2, isError: true, content: 'Knowledge record is not active' },
      { toolUseId: 'historical', eventOrdinal: 4, isError: false, content: JSON.stringify({ id: recordId, revisionToken: 'historic-revision' }) },
    ],
    snapshots: { before: { records: [{ id: recordId, revisionToken: 'historic-revision' }] } },
    trace: { availability: 'available', events: [{ type: 'history-read', subtype: 'history-body', id: recordId, revisionToken: 'historic-revision' }] },
  };
  const oracle = { history: { requiredRecordHashes: [recordHash], requiredReadCommand: 'inspect', manualRubric: 'review' } };
  assert.equal(judgeCell({ caseId: 'history', condition: 'candidate' }, runtime, oracle).structuralValid, true);
  assert.equal(traceWithOperationCrosscheck(runtime.trace, runtime.toolOperations, runtime.toolResults).availability, 'available');
});

test('trace crosscheck classifies a successful historical work load from native response metadata', () => {
  const workId = 'evaluation-cell-cache-rotation-procedure';
  const operation = { id: 'historical-work', name: 'exec', status: 'completed', eventOrdinal: 3, input: {
    command: `node knowledge-cli.mjs load ${workId} --source-run-id run-1 --project-dir . --json`,
  } };
  const result = { toolUseId: 'historical-work', eventOrdinal: 4, isError: false, content: JSON.stringify({
    ok: true, status: 'loaded', id: workId, kind: 'work', historical: true, activation: 'historical', revisionToken: 'historic-revision',
  }) };
  const trace = { availability: 'available', events: [{ type: 'history-read', subtype: 'history-body', id: workId, revisionToken: 'historic-revision', contextHash: 'context' }] };
  const session = [{ contextHash: 'context', before: { records: [{ id: workId, revisionToken: 'historic-revision' }] } }];
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [result], session).availability, 'available');
  const currentResult = { ...result, content: JSON.stringify({
    ok: true, status: 'loaded', id: workId, kind: 'work', historical: false, activation: 'current-guidance', revisionToken: 'current-revision',
  }) };
  const currentTrace = { availability: 'available', events: [{ type: 'load', id: workId, revisionToken: 'current-revision', contextHash: 'context' }] };
  assert.equal(traceWithOperationCrosscheck(currentTrace, [{ ...operation, input: {
    command: `node knowledge-cli.mjs load ${workId} --inspect-historical --json`,
  } }], [currentResult], session).availability, 'available');
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [currentResult], session).availability, 'unavailable');
});

test('verified capture cases require a successful persisted capture without a pre-session load', () => {
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [{ name: 'Write', status: 'completed', eventOrdinal: 2, input: { file_path: 'artifacts/decision.md' } }],
    trace: { availability: 'available', events: [{ type: 'capture', id: 'document-export-resolution', revisionToken: 'captured-revision', outcome: 'created' }] },
    snapshots: { before: { records: [] }, after: { records: [{ id: 'document-export-resolution', revisionToken: 'captured-revision', recordHash: 'sha256:record' }] } },
  };
  const oracle = { blocker: { requiredRecordHashes: [], requiresCapture: true, requiredStates: ['blocker-resolution-capture'], manualRubric: 'review' } };
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, runtime, oracle).structuralValid, true);
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, { ...runtime, trace: { availability: 'available', events: [] } }, oracle).reason, 'successful capture trace evidence is missing');
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, {
    ...runtime, trace: { availability: 'available', events: [{ type: 'capture', id: 'document-export-resolution', outcome: 'failed' }] },
  }, oracle).reason, 'successful capture trace evidence is missing');
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, {
    ...runtime, snapshots: { before: { records: [] }, after: { records: [] } },
  }, oracle).reason, 'successful capture was not persisted in snapshot evidence');
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, {
    ...runtime, snapshots: { before: { records: [{ id: 'document-export-resolution', revisionToken: 'old-revision' }] }, after: { records: [{ id: 'document-export-resolution', revisionToken: 'other-revision', recordHash: 'sha256:record' }] } },
  }, oracle).reason, 'successful capture was not persisted in snapshot evidence');
  assert.equal(judgeCell({ caseId: 'blocker', condition: 'candidate' }, {
    ...runtime,
    trace: { availability: 'available', events: [{ type: 'capture', id: 'document-export-resolution', revisionToken: 'updated-revision', outcome: 'updated' }] },
    snapshots: { before: { records: [{ id: 'document-export-resolution', revisionToken: 'old-revision' }] }, after: { records: [{ id: 'document-export-resolution', revisionToken: 'updated-revision', recordHash: 'sha256:record' }] } },
  }, oracle).structuralValid, true);
});

test('cached native evidence reruns only stale derived trace checks and preserves real trace failures', () => {
  const runtime = {
    trace: { availability: 'unavailable', reason: 'trace lacks native load event evidence', events: [{ type: 'load', id: 'record', loadedTokens: 3, loadedBytes: 12 }] },
    toolOperations: [{ id: 'load', status: 'completed', input: { command: 'node knowledge-cli.mjs load record' } }],
    toolResults: [{ toolUseId: 'load', isError: false, content: JSON.stringify({ id: 'record' }) }],
    sessionStartMeasurement: { availability: 'available', injectedTokens: 2, injectedBytes: 8 },
    usage: { primary: { input: 3 }, fullCycle: { coverage: 'complete', total: { input: 3, output: 1 } } },
  };
  const replayed = replayCachedRuntime({ condition: 'candidate' }, runtime);
  assert.equal(replayed.trace.availability, 'available');
  assert.equal(replayed.loadedBodyTokens, 3);
  assert.deepEqual(replayed.nativeFullCycleUsage, runtime.usage.fullCycle);
  assert.equal(replayCachedRuntime({ condition: 'candidate' }, { ...runtime, traceUnavailable: true }).trace.availability, 'unavailable');
  const refusedLoad = replayCachedRuntime({ condition: 'candidate' }, {
    ...runtime,
    trace: { availability: 'unavailable', reason: 'trace lacks native load event evidence', events: [{ type: 'search', responseTokens: 7, responseBytes: 28 }] },
    toolOperations: [
      { id: 'search', status: 'completed', input: { command: 'node knowledge-cli.mjs search record' } },
      { id: 'load', status: 'failed', input: { command: 'node knowledge-cli.mjs load record' } },
    ],
    toolResults: [{ toolUseId: 'search', content: 'record' }, { toolUseId: 'load', content: 'Knowledge record is not active' }],
  });
  assert.equal(refusedLoad.trace.availability, 'available');
  assert.equal(refusedLoad.previewTokens, 7);
  assert.equal(refusedLoad.loadedBodyTokens, 0);
});

test('dynamic canonical records make direct reads and mutations invalid in fresh and replayed evidence', () => {
  const storePath = '/isolated/lifecycle-store';
  const recordPath = `${storePath}/knowledge/captured-work/record.json`;
  const evidence = knowledgeBypassEvidence({
    projectDir: '/isolated/project', storePath, knownPaths: [],
  }, [
    { records: [], history: [] },
    { records: [{ id: 'captured-work', revisionToken: 'captured-revision', record: { id: 'captured-work' } }], history: [] },
  ]);
  assert.ok(evidence.knownPaths.includes(recordPath));
  assert.ok(evidence.canonicalRoots.includes(`${storePath}/knowledge`));

  const runtime = {
    status: 'completed', trace: { availability: 'available', events: [] },
    deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 },
    snapshots: { before: { records: [] }, after: { records: [{ id: 'captured-work', revisionToken: 'captured-revision' }] } },
    bypassEvidence: evidence,
    toolOperations: [
      { name: 'exec', input: { command: `cat '${recordPath}'` } },
      { name: 'exec', input: { command: `cp /tmp/proposal.json '${recordPath}'` } },
      { name: 'Write', input: { file_path: recordPath } },
      { name: 'Edit', input: { file_path: recordPath } },
      { name: 'exec', input: { command: `python3 -c \"open('${recordPath}', 'w').write('replacement')\"` } },
      { name: 'Write', input: { file_path: '/tmp/proposal/record.json' } },
      { name: 'exec', input: { command: 'node knowledge-cli.mjs load captured-work' } },
    ],
  };
  const replayed = replayCachedRuntime({ condition: 'candidate' }, runtime);
  assert.deepEqual(replayed.bypass.map((entry) => entry.reason), [
    'shell-read', 'shell-write', 'direct-write', 'direct-write', 'shell-write',
  ]);
  assert.equal(judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, replayed, {
    lifecycle: { requiredRecordHashes: [] },
  }).reason, 'direct knowledge-store bypass detected');
});

test('imported work requires a captured extraction and a fresh reuse without reloading the import', () => {
  const importedId = 'acquisition-deploy-boundary';
  const importedHash = `sha256:${createHash('sha256').update(importedId).digest('hex')}`;
  const extractedId = 'maintained-import-boundary';
  const imported = { id: importedId, revisionToken: 'import-rev' };
  const extracted = { id: extractedId, revisionToken: 'maintained-rev' };
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/imported-work.md', deliverable: { exists: true, bytes: 24 }, bypass: [],
    toolOperations: [
      { id: 'inspect-import', name: 'exec', status: 'completed', sessionOrdinal: 0, eventOrdinal: 2, input: { command: `node knowledge-cli.mjs inspect ${importedId}` } },
      { id: 'capture-extract', name: 'exec', status: 'completed', sessionOrdinal: 0, eventOrdinal: 4, input: { command: `node knowledge-cli.mjs register ${extractedId}` } },
      { id: 'load-extract', name: 'exec', status: 'completed', sessionOrdinal: 1, eventOrdinal: 2, input: { command: `node knowledge-cli.mjs load ${extractedId}` } },
      { id: 'write-artifact', name: 'Write', status: 'completed', sessionOrdinal: 1, eventOrdinal: 5, input: { file_path: 'artifacts/imported-work.md' } },
    ],
    toolResults: [{ toolUseId: 'inspect-import', sessionOrdinal: 0, eventOrdinal: 3, content: JSON.stringify(imported) }],
    trace: { availability: 'available', events: [
      { type: 'history-read', subtype: 'history-body', id: importedId, revisionToken: 'import-rev', contextHash: 'first' },
      { type: 'capture', id: extractedId, outcome: 'created', contextHash: 'first' },
      { type: 'load', id: extractedId, revisionToken: 'maintained-rev', contextHash: 'fresh' },
    ] },
    sessionSnapshots: [
      { contextHash: 'first', before: { records: [imported] } },
      { contextHash: 'fresh', before: { records: [imported, extracted] } },
    ],
  };
  const oracle = { imported: {
    requiredRecordHashes: [importedHash], requiredReadCommand: 'inspect', importedRecordHashes: [importedHash],
    requiresFreshExtractedReuse: true, manualRubric: 'manual review',
  } };
  assert.equal(judgeCell({ caseId: 'imported', condition: 'candidate' }, runtime, oracle).structuralValid, true);
  const reloadedImport = {
    ...runtime,
    toolOperations: [...runtime.toolOperations, { id: 'reload-import', name: 'exec', status: 'completed', sessionOrdinal: 1, eventOrdinal: 3, input: { command: `node knowledge-cli.mjs load ${importedId}` } }],
  };
  assert.equal(judgeCell({ caseId: 'imported', condition: 'candidate' }, reloadedImport, oracle).reason, 'fresh extracted-import reuse evidence is missing');
});

test('unarmed lifecycle registration fault becomes cell evidence instead of a lost run', () => {
  const result = judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [{ name: 'Write', status: 'completed', eventOrdinal: 1, input: { file_path: 'artifacts/decision.md' } }],
    trace: { availability: 'available', events: [] }, lifecycleEvidence: { registrationFault: 'not-armed', error: 'ENOENT' },
  }, { lifecycle: { requiredRecordHashes: [], requiredStates: ['save-failure'] } });
  assert.equal(result.reason, 'lifecycle registration-fault setup was unavailable');
});

test('lifecycle requires Execute capture before a later explicit work summary', () => {
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [{ name: 'Write', status: 'completed', sessionOrdinal: 1, eventOrdinal: 2, input: { file_path: 'artifacts/decision.md' } }],
    trace: { availability: 'available', events: [{ type: 'capture', contextHash: 'execute', outcome: 'created' }] },
    sessionSnapshots: [{ contextHash: 'execute' }],
  };
  const oracle = { lifecycle: { requiredRecordHashes: [], requiresExecuteAutoCapture: true } };
  assert.equal(judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, runtime, oracle).valid, true);
  assert.equal(judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, {
    ...runtime, toolOperations: [{ name: 'Learn', sessionOrdinal: 0, eventOrdinal: 1, input: {} }, ...runtime.toolOperations],
  }, oracle).reason, 'automatic Execute capture evidence is missing');
});

test('lifecycle requires a replacement draft after the registration fault', () => {
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [
      { id: 'noop-learn', name: 'Learn', sessionOrdinal: 3, eventOrdinal: 1, input: {} },
      { name: 'Write', status: 'completed', sessionOrdinal: 4, eventOrdinal: 2, input: { file_path: 'artifacts/decision.md' } },
    ],
    toolResults: [{ toolUseId: 'noop-learn', sessionOrdinal: 3, eventOrdinal: 1, isError: false, content: 'No durable update was needed.' }],
    trace: { availability: 'available', events: [
      { type: 'capture', contextHash: 'execute', outcome: 'created' }, { type: 'capture', contextHash: 'fault', outcome: 'failed' },
    ] },
    sessionSnapshots: [
      { contextHash: 'execute', before: { records: [] }, after: { records: [] } }, {}, {},
      { before: { records: [{ id: 'work' }], history: [] }, after: { records: [{ id: 'work' }], history: [] } },
      { contextHash: 'fault', before: { records: [{ id: 'work' }], history: [] }, after: { records: [{ id: 'work' }], history: [] } },
    ],
    snapshots: { after: { workRecords: [{ id: 'work', revisionToken: 'rev', execution: {}, verification: {}, pullRequest: {} }] } },
    lifecycleEvidence: { registrationFault: 'armed', draftClosure: 'closed', closedDraftNumber: 1 },
    workflowEvidence: {
      ghCommands: ['pr create --draft', 'pr view 1 --json url --jq .url', 'pr close 1', 'pr view 1 --json url --jq .url', 'pr create --draft'],
      ghState: { pullRequests: [
        { number: 1, url: 'https://example.invalid/1', state: 'CLOSED', isDraft: true, headRefName: 'evaluation/knowledge-cell' },
        { number: 2, url: 'https://example.invalid/2', state: 'OPEN', isDraft: true, headRefName: 'evaluation/knowledge-cell' },
      ] },
    },
  };
  const oracle = { lifecycle: { requiredRecordHashes: [], minimumPrCreates: 2, requiresSameWorkId: true, requiresPrView: true, requiresDraftReplacement: true, requiresExecuteAutoCapture: true, requiredStates: ['capture', 'noop', 'save-failure'], manualRubric: 'review' } };
  assert.equal(judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, runtime, oracle).structuralValid, true);
  assert.equal(judgeCell({ caseId: 'lifecycle', condition: 'candidate' }, { ...runtime, lifecycleEvidence: { ...runtime.lifecycleEvidence, draftClosure: 'failed' } }, oracle).reason, 'replacement draft evidence is missing');
});

test('an explicit bare Learn no-op may skip registration when records remain unchanged', () => {
  const runtime = {
    status: 'completed', deliverablePath: 'artifacts/decision.md', deliverable: { exists: true, bytes: 1 }, bypass: [],
    toolOperations: [
      { id: 'learn', name: 'Learn', sessionOrdinal: 1, eventOrdinal: 1, input: { intent: 'no-op' } },
      { name: 'Write', status: 'completed', sessionOrdinal: 1, eventOrdinal: 2, input: { file_path: 'artifacts/decision.md' } },
    ],
    toolResults: [{ toolUseId: 'learn', sessionOrdinal: 1, eventOrdinal: 1, isError: false, content: 'No durable update was needed.' }],
    trace: { availability: 'available', events: [] },
    sessionSnapshots: [
      { before: { records: [{ id: 'known' }], history: [] }, after: { records: [{ id: 'known' }], history: [] } },
      { before: { records: [{ id: 'known' }], history: [] }, after: { records: [{ id: 'known' }], history: [] } },
    ],
  };
  const oracle = { case: { requiredRecordHashes: [], requiredStates: ['bare-learn-noop'], manualRubric: 'review no-op' } };
  assert.equal(judgeCell({ caseId: 'case', condition: 'candidate' }, runtime, oracle).structuralValid, true);
  assert.equal(judgeCell({ caseId: 'case', condition: 'candidate' }, {
    ...runtime,
    toolOperations: [{ id: 'skill-read', name: 'exec', sessionOrdinal: 1, eventOrdinal: 1, input: { command: 'cat .agents/skills/spectre-learn/SKILL.md' } }, runtime.toolOperations[1]],
    toolResults: [{ toolUseId: 'skill-read', sessionOrdinal: 1, eventOrdinal: 1, content: 'on-demand knowledge capture skill' }],
  }, oracle).structuralValid, true);
  assert.equal(judgeCell({ caseId: 'case', condition: 'candidate' }, { ...runtime, toolOperations: [runtime.toolOperations[1]] }, oracle).reason, 'explicit no-op invocation evidence is missing');
  assert.equal(judgeCell({ caseId: 'case', condition: 'candidate' }, {
    ...runtime, toolOperations: [{ id: 'denied', name: 'Skill', sessionOrdinal: 1, eventOrdinal: 1, input: { skill: 'spectre-learn' } }, runtime.toolOperations[1]],
    toolResults: [{ toolUseId: 'denied', sessionOrdinal: 1, eventOrdinal: 1, isError: true, content: 'disable-model-invocation' }],
  }, oracle).reason, 'explicit no-op invocation evidence is missing');
});

test('trace metrics distinguish SessionStart, previews, bodies, resources, and redundant same-context loads', () => {
  const facts = traceRuntimeFacts({ availability: 'available', events: [
    { type: 'search', responseTokens: 7, responseBytes: 70 },
    { type: 'history-read', subtype: 'history-preview', responseTokens: 5, responseBytes: 50 },
    { type: 'load', id: 'record-a', revisionToken: 'rev-a', contextHash: 'ctx', loadedTokens: 11, loadedBytes: 110, responseTokens: 99 },
    { type: 'load', id: 'record-a', revisionToken: 'rev-a', contextHash: 'ctx', loadedTokens: 11, loadedBytes: 110, responseTokens: 99 },
    { type: 'resource-read', id: 'record-a', loadedTokens: 3, loadedBytes: 30, responseTokens: 88 },
  ] }, { sessionStartMeasurement: { injectedTokens: 4, injectedBytes: 40 } });
  assert.deepEqual(facts, {
    injectedTokens: 4, injectedBytes: 40, previewTokens: 12, previewBytes: 120,
    loadedBodyTokens: 22, loadedBodyBytes: 220, resourceTokens: 3, resourceBytes: 30,
    redundantTokens: 11, totalTokens: 41, nativePrimaryUsage: null, nativeFullCycleUsage: null,
  });
  const zero = traceRuntimeFacts({ availability: 'available', events: [] }, { sessionStartMeasurement: { injectedTokens: 0, injectedBytes: 0 } });
  assert.equal(zero.previewTokens, 0);
  assert.equal(zero.loadedBodyTokens, 0);
  assert.equal(zero.redundantTokens, 0);
  assert.equal(zero.totalTokens, 0);
});

test('post-hoc crosscheck ignores quoted Node prose, but requires an exact historical human body event', () => {
  const workId = 'evaluation-cell-cache-rotation-procedure';
  const session = {
    contextHash: 'historical-context',
    before: { records: [{ id: workId, revisionToken: 'historic-revision' }] },
  };
  const humanLoad = {
    id: 'human-history', name: 'exec', status: 'completed', sessionOrdinal: 0, eventOrdinal: 3,
    input: { command: `node knowledge-cli.mjs load '${workId}' --source-run-id run-1` },
  };
  const humanResult = {
    toolUseId: 'human-history', sessionOrdinal: 0, isError: false,
    content: `# ${workId}\n- ID: ${workId}\nHistorical work record: historical evidence only, not active guidance.`,
  };
  const historicalTrace = {
    availability: 'available',
    events: [{ type: 'history-read', subtype: 'history-body', id: workId, revisionToken: 'historic-revision', contextHash: 'historical-context' }],
  };
  assert.equal(traceWithOperationCrosscheck(historicalTrace, [humanLoad], [humanResult], [session]).availability, 'available');
  assert.equal(traceWithOperationCrosscheck(historicalTrace, [humanLoad], [humanResult], [{
    ...session,
    before: { records: [{ id: workId, revisionToken: 'prior-revision' }] },
    after: { records: [{ id: workId, revisionToken: 'historic-revision' }] },
  }]).availability, 'available');
  assert.equal(traceWithOperationCrosscheck({
    ...historicalTrace,
    events: [{ ...historicalTrace.events[0], subtype: 'history-preview' }],
  }, [humanLoad], [humanResult], [session]).availability, 'unavailable');
  assert.equal(traceWithOperationCrosscheck(historicalTrace, [humanLoad], [humanResult], [{ ...session, contextHash: 'other-context' }]).availability, 'unavailable');

  const currentHuman = {
    ...humanResult,
    content: `# ${workId}\n- ID: ${workId}\nHistorical work record: historical evidence only, not active guidance.\n\nCurrent project-scoped work body.\n`,
  };
  const currentSession = [{
    contextHash: 'current-context',
    before: { records: [{ id: workId, revisionToken: 'current-revision', kind: 'work', applicability: { scope: 'project' } }] },
    after: { records: [{ id: workId, revisionToken: 'later-revision', kind: 'work', applicability: { scope: 'project' } }] },
  }];
  const currentTrace = {
    availability: 'available',
    events: [{ type: 'load', id: workId, revisionToken: 'current-revision', contextHash: 'current-context', responseBytes: Buffer.byteLength(currentHuman.content) }],
  };
  assert.equal(traceWithOperationCrosscheck(currentTrace, [humanLoad], [currentHuman], currentSession).availability, 'available');
  assert.equal(traceWithOperationCrosscheck({
    ...currentTrace,
    events: [{ ...currentTrace.events[0], responseBytes: Buffer.byteLength(currentHuman.content) + 1 }],
  }, [humanLoad], [currentHuman], currentSession).availability, 'unavailable');

  const matchingWorkSession = [{
    contextHash: 'matching-work-context',
    before: { records: [{ id: workId, revisionToken: 'matching-work-revision', kind: 'work', applicability: { scope: 'work', workId: 'evaluation-work' } }] },
  }];
  const matchingWorkLoad = { ...humanLoad, input: { command: `node knowledge-cli.mjs load '${workId}' --work-id evaluation-work` } };
  const matchingWorkTrace = {
    availability: 'available',
    events: [{ type: 'load', id: workId, revisionToken: 'matching-work-revision', contextHash: 'matching-work-context', responseBytes: Buffer.byteLength(currentHuman.content) }],
  };
  assert.equal(traceWithOperationCrosscheck(matchingWorkTrace, [matchingWorkLoad], [currentHuman], matchingWorkSession).availability, 'available');

  const prose = {
    id: 'node-prose', name: 'exec', status: 'completed', sessionOrdinal: 0,
    input: { command: `node -e 'const note="it'"'"'s a note"; console.log("knowledge-cli.mjs register ${workId}")'` },
  };
  assert.equal(traceWithOperationCrosscheck({ availability: 'available', events: [] }, [prose], [{ toolUseId: 'node-prose', isError: false, content: 'done' }]).availability, 'available');
});

test('post-hoc bypass replay ignores outside-store Read paths but retains canonical reads and shell access', () => {
  const storePath = '/isolated/lifecycle-store';
  const recordPath = `${storePath}/knowledge/captured-work/record.json`;
  const runtime = {
    trace: { availability: 'available', events: [] },
    bypassEvidence: {
      workingDir: '/isolated/project',
      canonicalRoots: [`${storePath}/knowledge`, `${storePath}/knowledge-history`],
      knownPaths: [recordPath],
    },
    toolOperations: [
      { id: 'plugin-read', name: 'Read', input: { file_path: '/isolated/plugin/hooks/load-knowledge.mjs' } },
      { id: 'canonical-read', name: 'Read', input: { file_path: recordPath } },
      { id: 'metadata-only', name: 'exec', input: { command: `/bin/zsh -lc "ls -ld ${storePath}/knowledge ${recordPath} && stat -f '%Sp %N' ${storePath}/index.json"` } },
      { id: 'digest-pipeline', name: 'exec', input: { command: `shasum -a 256 '${recordPath}' | shasum -a 256` } },
      { id: 'digest', name: 'exec', input: { command: `shasum -a 256 '${recordPath}'` } },
      { id: 'metadata-with-cli-search', name: 'exec', input: { command: `/bin/zsh -lc "ls -ld ${storePath}/knowledge ${recordPath} && shasum -a 256 ${recordPath} && node /isolated/plugin/knowledge-cli.mjs search 'captured work' --project-dir . --json"` } },
      { id: 'quoted-proposal-node', name: 'Bash', input: { command: `node -e 'const fs=require("fs"); const recordPath="${recordPath}"; const dir="/tmp/proposal/captured-work"; const prior=fs.readFileSync("/tmp/ship-load.json","utf8"); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,"record.json"), prior + recordPath);'` } },
      { id: 'mixed-digest-read', name: 'exec', input: { command: `shasum -a 256 '${recordPath}' | cat` } },
      { id: 'canonical-shell-read', name: 'exec', input: { command: `cat '${recordPath}'` } },
    ],
  };
  const replayed = replayCachedRuntime({ condition: 'candidate' }, runtime);
  assert.deepEqual(replayed.bypass.map((entry) => entry.reason), ['direct-read', 'shell-read', 'shell-read']);

  const aliasStore = '/var/folders/evaluation-store';
  const aliasRecord = `${aliasStore}/knowledge/captured-work/record.json`;
  const aliasRuntime = {
    ...runtime,
    toolOperations: [{ name: 'Read', input: { file_path: `/private${aliasRecord}` } }],
    bypassEvidence: { ...runtime.bypassEvidence, canonicalRoots: [`${aliasStore}/knowledge`], knownPaths: [aliasRecord] },
  };
  assert.deepEqual(replayCachedRuntime({ condition: 'candidate' }, aliasRuntime).bypass.map((entry) => entry.reason), ['direct-read']);
});

test('post-hoc crosscheck binds successful work JSON wrappers to one historical event each', () => {
  const workId = 'evaluation-cell-capture-reconciliation';
  const revision = 'captured-revision';
  const session = [{
    contextHash: 'captured-context',
    before: { records: [{ id: workId, revisionToken: revision }] },
    after: { records: [{ id: workId, revisionToken: revision }] },
  }];
  const operation = {
    id: 'wrapped-work', status: 'completed', sessionOrdinal: 0,
    input: { command: `node knowledge-cli.mjs load ${workId} --work-id ${workId} --allowance-tokens 6000 --json > proposal.json 2>&1; node summarize.js proposal.json` },
  };
  const result = {
    toolUseId: 'wrapped-work', sessionOrdinal: 0, isError: false,
    content: "top keys: ok, status, id, kind, applicability, revisionToken, estimatedTokens, historical, activation, record\nrevisionToken: [REDACTED]\nrecord keys: schemaVersion, id, kind, work",
  };
  const trace = { availability: 'available', events: [{
    type: 'history-read', subtype: 'history-body', id: workId, revisionToken: revision, contextHash: 'captured-context',
  }] };
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [result], session).availability, 'available');
  const historySummary = {
    ...result,
    content: `provenance: { "origin": "captured" }\napplicability: { "scope": "work", "workId": "${workId}" }\n=== HISTORY ===\n${JSON.stringify({ ok: true, id: workId, entries: [{ id: workId, revisionToken: revision, historical: true }] })}`,
  };
  const loadExitSummary = { ...result, content: 'load exit=0\nrevisionToken: [REDACTED]\npullRequest: {"state":"draft-open"}' };
  const registrationSummary = { ...result, content: `expected-revision: sha256:abcdef\n${JSON.stringify({ ok: true, status: 'noop', id: workId, revisionToken: revision })}` };
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [historySummary], session).availability, 'available');
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [loadExitSummary], session).availability, 'available');
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [registrationSummary], session).availability, 'available');
  assert.equal(traceWithOperationCrosscheck({ ...trace, events: [{ ...trace.events[0], id: 'other-work' }] }, [operation], [result], session).availability, 'unavailable');
  assert.equal(traceWithOperationCrosscheck({ ...trace, events: [{ ...trace.events[0], revisionToken: 'other-revision' }] }, [operation], [result], session).availability, 'unavailable');
  assert.equal(traceWithOperationCrosscheck({ ...trace, events: [{ ...trace.events[0], contextHash: 'other-context' }] }, [operation], [result], session).availability, 'unavailable');
  assert.equal(traceWithOperationCrosscheck(trace, [operation], [{ ...result, isError: true }, { toolUseId: 'wrapped-work', sessionOrdinal: 0, isError: false, content: 'wrapper finished' }], session).availability, 'unavailable');
  assert.equal(traceWithOperationCrosscheck(trace, [operation, { ...operation, id: 'second-wrapper' }], [result, { ...result, toolUseId: 'second-wrapper' }], session).availability, 'unavailable');
});

test('post-hoc crosscheck binds only successful wrapped historical loads and ignores expansion preflights', () => {
  const workId = 'evaluation-cell-cache-rotation-procedure';
  const revision = 'historic-revision';
  const session = [{ contextHash: 'historical-context', before: { records: [{ id: workId, revisionToken: revision }] }, after: { records: [{ id: workId, revisionToken: revision }] } }];
  const trace = { availability: 'available', events: [{ type: 'history-read', subtype: 'history-body', id: workId, revisionToken: revision, contextHash: 'historical-context' }] };
  const wrapped = { id: 'wrapped', status: 'completed', sessionOrdinal: 0, input: { command: `node knowledge-cli.mjs load ${workId} --allowance-tokens 4000 --json > /tmp/load.json; echo exit=0` } };
  const wrappedResult = { toolUseId: 'wrapped', sessionOrdinal: 0, isError: false, content: "exit=0\n[ 'ok', 'status', 'id', 'revisionToken', 'record' ]\nrevisionToken= [REDACTED]" };
  assert.equal(traceWithOperationCrosscheck(trace, [wrapped], [wrappedResult], session).availability, 'available');
  assert.equal(traceWithOperationCrosscheck(trace, [wrapped], [{ ...wrappedResult, content: 'exit=0' }], session).availability, 'unavailable');

  const mixed = { id: 'mixed', status: 'completed', sessionOrdinal: 0, input: { command: `node knowledge-cli.mjs work resolve --work-id ${workId}; node knowledge-cli.mjs load ${workId} --json` } };
  const mixedResult = { toolUseId: 'mixed', sessionOrdinal: 0, isError: false, content: `${JSON.stringify({ status: 'unresolved', workId: null })}\n${JSON.stringify({ ok: true, status: 'loaded', id: workId, kind: 'work', historical: true, activation: 'historical', revisionToken: revision })}` };
  assert.equal(traceWithOperationCrosscheck(trace, [mixed], [mixedResult], session).availability, 'available');

  const expansion = { id: 'expansion', status: 'completed', sessionOrdinal: 0, input: { command: `node knowledge-cli.mjs load ${workId}` } };
  const expansionResult = { toolUseId: 'expansion', sessionOrdinal: 0, isError: false, content: `Knowledge load needs expansion: ${workId} requires 1995 estimated tokens (allowance 1500).` };
  assert.equal(traceWithOperationCrosscheck({ availability: 'available', events: [{ type: 'expansion', id: workId, contextHash: 'historical-context' }] }, [expansion], [expansionResult], session).availability, 'available');
});
