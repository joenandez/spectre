#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { invokeKnowledgeHost } from './knowledge-evaluation-hosts.mjs';
import { blockKnowledgeRegistration, readSessionStartMeasurement, snapshotKnowledgeCell, stageKnowledgeCell as stagePreparedKnowledgeCell } from './knowledge-evaluation-staging.mjs';
import { baselineRuntimeFacts } from './knowledge-evaluation-baseline-metrics.mjs';
import { detectTraceBypass, readEvaluationTrace } from '../plugins/spectre/hooks/scripts/knowledge/evaluation-trace.mjs';

const BASELINE = '1cd1f035a253e9d7ef5086693ab9f1d0b11d360b';
const CONDITIONS = ['no-knowledge', 'baseline', 'candidate'];
const HOSTS = ['claude', 'codex'];
const NATIVE_PIPELINE_INPUTS = [
  new URL('./knowledge-evaluation-hosts.mjs', import.meta.url),
  new URL('./knowledge-evaluation-staging.mjs', import.meta.url),
  new URL('./knowledge-host-probe-hook.mjs', import.meta.url),
  new URL('./verify-knowledge-hosts.mjs', import.meta.url),
  new URL('../plugins/spectre/hooks/scripts/knowledge/evaluation-trace.mjs', import.meta.url),
  new URL('../plugins/spectre/hooks/scripts/knowledge/payload.mjs', import.meta.url),
];
const ACCEPTANCE_THRESHOLDS = Object.freeze({
  requiredRecall: 1,
  unnecessaryHistoryLoads: 0,
  redundantSameContextLoads: 0,
  routineIrrelevantLoadedBodyRate: 0.05,
});

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function nativePipelineInputsHash() {
  return hash(JSON.stringify(NATIVE_PIPELINE_INPUTS.map((url) => [url.pathname, hash(fs.readFileSync(url))])));
}

function filesHash(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push([path.relative(root, target), hash(fs.readFileSync(target))]);
    }
  };
  visit(root);
  return hash(JSON.stringify(files.sort(([left], [right]) => left.localeCompare(right))));
}

function goldStrings(value, key = null) {
  if (typeof value === 'string') {
    const structural = new Set(['requiredRecordHashes', 'requiredStates', 'requiredReadCommand', 'allowedLoads', 'allowedHistoryLoads', 'requiredBeforeDecision', 'requiresCapture', 'requiresSameWorkId', 'minimumPrCreates', 'forbiddenLegacyExposure']);
    return structural.has(key) ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => goldStrings(entry, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([entryKey, entry]) => goldStrings(entry, entryKey));
  return [];
}

function usage() {
  return 'Usage: evaluate-knowledge.mjs freeze --fixtures <dir> --oracle <file> --output <file> [--config <file> --candidate <dir>]\n       evaluate-knowledge.mjs run --freeze <file> --fixtures <dir> --config <file> --baseline-plugin <dir> (--candidate-plugin <plugins-dir> | --candidate-claude-plugin <dir> --candidate-codex-plugin <dir>) --output <dir> --report <file> --allow-native [--cell <frozen-cell-id>]\n';
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function argumentsNamed(argv, name) {
  return argv.flatMap((value, index) => value === name && typeof argv[index + 1] === 'string' ? [argv[index + 1]] : []);
}

function promptContract(entry, artifactPath, host = 'claude', condition = 'candidate') {
  const commands = condition === 'no-knowledge'
    ? { EXECUTE_COMMAND: 'the Execute workflow step', SHIP_COMMAND: 'the Ship workflow step' }
    : host === 'claude'
    ? { EXECUTE_COMMAND: '/spectre:spectre-execute', SHIP_COMMAND: '/spectre:spectre-ship', LEARN_COMMAND: '/spectre:spectre-learn' }
    : { EXECUTE_COMMAND: 'spectre-execute', SHIP_COMMAND: 'spectre-ship', LEARN_COMMAND: 'spectre-learn' };
  const featureRoot = '.spectre/features/evaluation-cell';
  const executeSource = `${featureRoot}/specs/execute.md`;
  const prompts = entry.longitudinalSteps ?? [[
    entry.task,
    entry.workflow ?? 'Use the installed Spectre workflow to complete the task.',
  ].join('\n')];
  return prompts.map((prompt, index) => {
    let resolved = (index === prompts.length - 1
    ? `${prompt}\nWrite the decision artifact to ${artifactPath}, then write evaluation-result.json with recordIds and actions arrays describing the evidence you used.`
    : prompt).replaceAll('{EXECUTE_COMMAND}', commands.EXECUTE_COMMAND).replaceAll('{SHIP_COMMAND}', commands.SHIP_COMMAND);
    if (Number.isInteger(entry.workflowCommandSession) && condition !== 'no-knowledge' && index === entry.workflowCommandSession) {
      resolved = `${commands.EXECUTE_COMMAND} ${executeSource} --orchestrated --finalization-owner parent --review-profile final-only\n${resolved.replace(/^Start a fresh session\. As the user-requested workflow command, run .*? for the staged feature\.\s*/, '')}`;
    }
    if (entry.id === 'lifecycle-identity' && condition !== 'no-knowledge' && index === 2) {
      resolved = `${commands.SHIP_COMMAND} ${featureRoot}\n${resolved.replace(/^Start a fresh session\. As the user-requested workflow command, run \S+:\s*/, '')}`;
    }
    if (entry.userLearnSessions?.includes(index)) {
      resolved = resolved.replace(/\b(?:Invoke|Use) Learn\b/gi, 'Record the supplied project evidence');
      if (condition !== 'no-knowledge') resolved = `${commands.LEARN_COMMAND}\n${resolved}`;
    }
    return resolved;
  });
}

export function evaluationActorContext(cell, sessionOrdinal) {
  const opaque = hash(JSON.stringify({ host: cell.host, condition: cell.condition, repeat: cell.repeat, sessionOrdinal }));
  const suffix = opaque.slice('sha256:'.length);
  return { actorId: `evaluation-${suffix.slice(0, 24)}`, contextId: `evaluation-${suffix.slice(24, 48)}` };
}

export function selectFrozenCells(freezeManifest, cellIds = []) {
  if (!Array.isArray(cellIds) || cellIds.length === 0) return freezeManifest;
  const selected = freezeManifest.cells.filter((cell) => cellIds.includes(cell.id));
  if (selected.length !== cellIds.length) {
    const found = new Set(selected.map((cell) => cell.id));
    throw new Error(`unknown frozen cell: ${cellIds.find((id) => !found.has(id))}`);
  }
  return { ...freezeManifest, cells: selected };
}

function freeze(fixtures, oracle, output, options = {}) {
  const manifest = readJson(path.join(fixtures, 'manifest.json'));
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 12) throw new Error('fixture manifest must contain exactly 12 cases');
  const artifactPath = manifest.artifactPath;
  if (typeof artifactPath !== 'string' || !/^artifacts\/[a-z0-9-]+\.md$/.test(artifactPath)) throw new Error('fixture manifest must provide a neutral relative artifactPath');
  const fixtureBytes = fs.readFileSync(path.join(fixtures, 'manifest.json'));
  const oracleBytes = fs.readFileSync(oracle);
  for (const value of goldStrings(readJson(oracle))) {
    if (value && fixtureBytes.includes(value)) throw new Error('gold oracle value leaked into agent-readable fixture');
  }
  const configurationPath = options.configurationPath ? path.resolve(options.configurationPath) : null;
  const candidatePath = options.candidatePath ? path.resolve(options.candidatePath) : null;
  if (configurationPath && !fs.statSync(configurationPath).isFile()) throw new Error('configurationPath must identify a file');
  if (candidatePath && !fs.statSync(candidatePath).isDirectory()) throw new Error('candidatePath must identify a directory');
  const cells = manifest.cases.flatMap(entry => CONDITIONS.flatMap(condition =>
    HOSTS.flatMap(host => [1, 2].map(repeat => ({
      id: `${entry.id}:${condition}:${host}:${repeat}`,
      caseId: entry.id,
      condition,
      host,
      repeat,
      longitudinal: Boolean(entry.longitudinal),
      cohort: entry.longitudinal ? 'longitudinal' : entry.cohort ?? 'workflow',
      critical: entry.critical === true,
      artifactPath,
      promptHash: hash(JSON.stringify(promptContract(entry, artifactPath, host, condition))),
      fixtureHash: hash(JSON.stringify({ entry, artifactPath })),
    })))
  ));
  const result = {
    schemaVersion: 2, baseline: BASELINE, fixtureHash: hash(fixtureBytes), oracleHash: hash(oracleBytes),
    hashes: {
      fixtures: filesHash(fixtures), oracle: hash(oracleBytes),
      configuration: configurationPath ? hash(fs.readFileSync(configurationPath)) : null,
      candidate: candidatePath ? filesHash(candidatePath) : null,
      nativePipelineInputs: nativePipelineInputsHash(),
    },
    fixtureRoot: path.resolve(fixtures), oraclePath: path.resolve(oracle), configurationPath, candidatePath, cells,
    concurrency: { total: 4, perHost: 2 }, freshStores: true, longitudinalSequential: true,
    usage: 'unknown-until-native-host-reports',
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function normalizeUsage(raw = {}) {
  const pick = key => Number.isFinite(raw[key]) ? raw[key] : 'unknown';
  return { input: pick('input'), cache: pick('cache'), cacheWrite: pick('cacheWrite'), output: pick('output'), reasoning: pick('reasoning') };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 'unknown';
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function eventPrecedes(left, right) {
  if (!Number.isInteger(left?.eventOrdinal) || !Number.isInteger(right?.eventOrdinal)) return false;
  const leftSession = left.sessionOrdinal ?? 0;
  const rightSession = right.sessionOrdinal ?? 0;
  return leftSession < rightSession || (leftSession === rightSession && left.eventOrdinal < right.eventOrdinal);
}

function isArtifactWrite(operation, deliverablePath) {
  const input = operation?.input ?? {};
  const serialized = JSON.stringify(input);
  if ((operation.name === 'Write' || operation.name === 'Edit' || operation.type === 'file_change') && serialized.includes(deliverablePath)) return true;
  if (operation.name !== 'exec') return false;
  const command = input.command;
  if (typeof command !== 'string' || !command.includes(deliverablePath)) return false;
  const escaped = deliverablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:>|>>)\\s*['\"]?${escaped}|\\btee(?:\\s+[^|;&]+)*\\s+['\"]?${escaped}|\\bapply_patch\b`).test(command);
}

function withoutNodeEvalPayloads(command) {
  let output = '';
  let cursor = 0;
  const nodeEval = /\bnode\s+-e\s+/;
  while (true) {
    const match = nodeEval.exec(command.slice(cursor));
    if (!match) return output + command.slice(cursor);
    const start = cursor + match.index;
    let index = start + match[0].length;
    const quote = command[index];
    if (quote !== "'" && quote !== '"') {
      output += command.slice(cursor, index);
      cursor = index;
      continue;
    }
    index += 1;
    while (index < command.length) {
      if (quote === "'" && command.startsWith(`'"'"'`, index)) {
        index += 5;
        continue;
      }
      if (command[index] === '\\') {
        index += 2;
        continue;
      }
      if (command[index] === quote) {
        index += 1;
        break;
      }
      index += 1;
    }
    if (index > command.length || command[index - 1] !== quote) return output + command.slice(cursor);
    output += `${command.slice(cursor, start)}node -e <script>`;
    cursor = index;
  }
}

function classifyKnowledgeCommands(toolOperations = []) {
  const actions = new Map();
  const variables = new Map();
  const ordered = [...toolOperations].sort((left, right) =>
    (left.sessionOrdinal ?? 0) - (right.sessionOrdinal ?? 0) || (left.eventOrdinal ?? 0) - (right.eventOrdinal ?? 0)
  );
  for (const operation of ordered) {
    const command = operation?.input?.command;
    if (typeof command !== 'string') continue;
    // Tool output can quote CLI examples inside a Node evaluation payload. That prose is not an invocation.
    const executable = withoutNodeEvalPayloads(command);
    const session = operation.sessionOrdinal ?? 0;
    const available = variables.get(session) ?? new Set();
    for (const match of executable.matchAll(/\b([A-Z][A-Z0-9_]*)=(?:['"])?[^\s;'"]*knowledge-cli\.mjs/g)) available.add(match[1]);
    variables.set(session, available);
    const found = new Set();
    for (const action of ['search', 'load', 'resource', 'history', 'inspect', 'register', 'capture', 'learn']) {
      const direct = new RegExp(`knowledge-cli\\.mjs['\"]?\\s+${action}\\b`).test(executable);
      const variable = [...executable.matchAll(new RegExp(`(?:['\"])?\\$\\{?([A-Z][A-Z0-9_]*)\\}?(?:['\"])?\\s+${action}\\b`, 'g'))]
        .some((match) => available.has(match[1]));
      if (direct || variable) found.add(action);
    }
    actions.set(operation, found);
  }
  return actions;
}

export function aggregate(cells = []) {
  const required = cells.filter(cell => cell.judged != null);
  const metric = name => cells.map(cell => cell.runtime?.[name]);
  const summary = values => ({ known: values.filter(Number.isFinite).length, missing: values.filter(value => !Number.isFinite(value)).length, median: percentile(values, .5), p95: percentile(values, .95) });
  return {
    runtime: Object.fromEntries(['injectedTokens', 'previewTokens', 'loadedBodyTokens', 'redundantTokens', 'totalTokens'].map(name => [name, summary(metric(name))])),
    judged: {
      requiredRecall: required.some(cell => cell.judged?.recalled === false) ? false
        : required.length > 0 && required.every(cell => cell.judged?.recalled === true) ? true : 'unknown',
      irrelevantLoadedTokens: cells.some(cell => !Number.isFinite(cell.judged?.irrelevantLoadedTokens)) ? 'unknown' : cells.reduce((sum, cell) => sum + cell.judged.irrelevantLoadedTokens, 0),
    },
    samples: cells.length,
  };
}

export function judgeCell(cell, runtime, oracle) {
  const expected = oracle?.[cell.caseId];
  if (!expected) return { valid: false, recalled: false, reason: 'oracle judgment is missing' };
  if (cell.condition === 'candidate' && runtime?.trace?.availability === 'unavailable') return { valid: false, recalled: false, reason: 'candidate evaluation trace is unavailable' };
  if (runtime?.status !== 'completed') return { valid: false, recalled: false, reason: `host status is ${runtime?.status ?? 'missing'}` };
  if (runtime?.bypass?.length > 0) return { valid: false, recalled: false, reason: 'direct knowledge-store bypass detected' };
  if (runtime?.deliverable?.exists !== true) return { valid: false, recalled: false, reason: 'decision artifact was not persisted' };
  if (cell.condition === 'candidate' && expected.requiresCapture === true) {
    const captures = (runtime.trace?.events ?? []).filter((event) => event.type === 'capture' &&
      (event.outcome === 'created' || event.outcome === 'updated') && typeof event.id === 'string' && typeof event.revisionToken === 'string');
    if (captures.length === 0) return { valid: false, recalled: false, reason: 'successful capture trace evidence is missing' };
    const snapshots = [runtime.snapshots?.after, ...(runtime.sessionSnapshots ?? []).map((session) => session.after)].filter(Boolean);
    const persisted = captures.some((capture) => snapshots.some((snapshot) => (snapshot.records ?? []).some((record) =>
      record.id === capture.id && record.revisionToken === capture.revisionToken
    )));
    if (!persisted) return { valid: false, recalled: false, reason: 'successful capture was not persisted in snapshot evidence' };
  }
  if (Array.isArray(expected.requiredRecordHashes)) {
    const commandActions = classifyKnowledgeCommands(runtime.toolOperations);
    const expectedHashes = new Set(expected.requiredRecordHashes);
    const readCommand = cell.condition === 'baseline' && expected.requiredReadCommand === 'inspect' ? 'load'
      : expected.requiredReadCommand === 'inspect' ? 'inspect' : 'load';
    const loadOperations = (runtime.toolOperations ?? []).filter((operation) => {
      const command = operation?.input?.command ?? '';
      const historicalLoad = readCommand === 'inspect' && commandActions.get(operation)?.has('load') && /--inspect-historical\b/.test(command);
      return (commandActions.get(operation)?.has(readCommand) || historicalLoad) &&
        [...command.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)].some((match) => expectedHashes.has(hash(match[0]))) &&
        (operation.status === null || operation.status === 'completed');
    });
    const matchedResults = (runtime.toolResults ?? []).flatMap((result) =>
      loadOperations.filter((operation) => operation.id !== null && operation.id === result.toolUseId &&
        (operation.sessionOrdinal ?? 0) === (result.sessionOrdinal ?? 0)).flatMap((operation) =>
        result.isError !== true && typeof result.content === 'string' && [...result.content.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)]
          .some((match) => expectedHashes.has(hash(match[0]))) ? [{ operation, result }] : []
      )
    );
    const artifactWrite = (runtime.toolOperations ?? []).find((operation) =>
      isArtifactWrite(operation, runtime.deliverablePath) && (operation.status === null || operation.status === 'completed')
    );
    if (!artifactWrite) return { valid: false, recalled: false, reason: 'native decision-artifact write evidence is missing' };
    const orderedLoad = matchedResults.some(({ result }) =>
      eventPrecedes(result, artifactWrite)
    );
    const tracedLoad = matchedResults.some(({ operation }) => {
      const session = runtime.sessionSnapshots?.[operation.sessionOrdinal ?? 0];
      const stagedRevisions = new Map((session?.before?.records ?? runtime.snapshots?.before?.records ?? []).map((record) => [record.id, record.revisionToken]));
      return runtime.trace?.events?.some((event) =>
        (readCommand === 'inspect' ? event.type === 'history-read' && event.subtype === 'history-body' : event.type === 'load') &&
        expectedHashes.has(hash(event.id ?? '')) && event.revisionToken === stagedRevisions.get(event.id) &&
        (!session?.contextHash || event.contextHash === session.contextHash)
      );
    });
    if (cell.condition !== 'no-knowledge' && expectedHashes.size > 0 && (!orderedLoad || (cell.condition === 'candidate' && !tracedLoad))) {
      return { valid: false, recalled: false, reason: 'native load-before-artifact evidence is missing' };
    }
    if (cell.condition === 'candidate' && Array.isArray(expected.requiredStates)) {
      const captureOutcomes = (runtime.trace?.events ?? []).filter((event) => event.type === 'capture').map((event) => event.outcome);
      const snapshots = runtime.sessionSnapshots ?? [];
      const unchangedSession = snapshots.some((session) => JSON.stringify(session.before?.records ?? []) === JSON.stringify(session.after?.records ?? []) &&
        JSON.stringify(session.before?.history ?? []) === JSON.stringify(session.after?.history ?? []));
      if (expected.requiredStates.some((state) => /(?:accepted-decision|blocker-resolution|^capture$)/.test(state)) &&
        !captureOutcomes.some((outcome) => outcome === 'created' || outcome === 'updated')) {
        return { valid: false, recalled: false, reason: 'required primary capture outcome is missing' };
      }
      if (expected.requiredStates.some((state) => /noop/.test(state)) && !unchangedSession) {
        return { valid: false, recalled: false, reason: 'required unchanged capture evidence is missing' };
      }
      if (expected.requiredStates.some((state) => /noop/.test(state))) {
        const unchangedSessions = new Set(snapshots.flatMap((session, index) =>
          JSON.stringify(session.before?.records ?? []) === JSON.stringify(session.after?.records ?? []) &&
          JSON.stringify(session.before?.history ?? []) === JSON.stringify(session.after?.history ?? []) ? [index] : []
        ));
        const operationSucceeded = (operation) => operation.status !== 'failed' && (runtime.toolResults ?? []).some((result) =>
          result.toolUseId === operation.id && (result.sessionOrdinal ?? 0) === (operation.sessionOrdinal ?? 0) && result.isError !== true
        );
        const explicitNoopInvocation = (runtime.toolOperations ?? []).some((operation) =>
          unchangedSessions.has(operation.sessionOrdinal ?? 0) && operationSucceeded(operation) && (operation.name === 'Learn' ||
            operation.name === 'Skill' && /(?:spectre[-:]learn|\blearn\b|\bcapture\b)/i.test(JSON.stringify(operation.input ?? {})) ||
            /spectre[-/](?:learn|capture)(?:[/.]|\b)/i.test(operation.input?.command ?? ''))
        ) || [...unchangedSessions].some((sessionOrdinal) => runtime.explicitLearnSessions?.includes(sessionOrdinal) && runtime.sessions?.[sessionOrdinal]?.status === 'completed');
        if (!explicitNoopInvocation) return { valid: false, recalled: false, reason: 'explicit no-op invocation evidence is missing' };
      }
      const faultContext = snapshots.at(-1)?.contextHash;
      const faultFailure = (runtime.trace?.events ?? []).some((event) => event.type === 'capture' && event.outcome === 'failed' &&
        typeof faultContext === 'string' && event.contextHash === faultContext);
      if (expected.requiredStates.includes('save-failure') && !faultFailure) {
        if (runtime.lifecycleEvidence?.registrationFault && runtime.lifecycleEvidence.registrationFault !== 'armed') {
          return { valid: false, recalled: false, reason: 'lifecycle registration-fault setup was unavailable' };
        }
        return { valid: false, recalled: false, reason: 'required knowledge save-failure evidence is missing' };
      }
    }
    if (cell.condition === 'candidate' && expected.requiresExecuteAutoCapture === true) {
      const executeSession = runtime.sessionSnapshots?.[0];
      const automaticCapture = (runtime.trace?.events ?? []).some((event) => event.type === 'capture' &&
        event.contextHash === executeSession?.contextHash && (event.outcome === 'created' || event.outcome === 'updated'));
      const explicitCaptureDuringExecute = (runtime.toolOperations ?? []).some((operation) =>
        (operation.sessionOrdinal ?? 0) === 0 && (operation.name === 'Learn' ||
          operation.name === 'Skill' && /(?:spectre[-:]learn|\blearn\b)/i.test(JSON.stringify(operation.input ?? {})))
      );
      if (!automaticCapture || explicitCaptureDuringExecute) {
        return { valid: false, recalled: false, reason: 'automatic Execute capture evidence is missing' };
      }
    }
    if (cell.condition === 'candidate' && expected.requiresFreshExtractedReuse === true) {
      const importedHashes = new Set(expected.importedRecordHashes ?? []);
      const importedReads = (runtime.toolOperations ?? []).filter((operation) => {
        const command = operation?.input?.command ?? '';
        return ['inspect', 'load'].some((action) => commandActions.get(operation)?.has(action)) &&
          [...command.matchAll(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g)].some((match) => importedHashes.has(hash(match[0])));
      });
      const freshSession = runtime.sessionSnapshots?.[1];
      const freshLoadedExtract = (runtime.trace?.events ?? []).some((event) =>
        event.type === 'load' && event.contextHash === freshSession?.contextHash &&
        !importedHashes.has(hash(event.id ?? '')) && (freshSession?.before?.records ?? []).some((record) => record.id === event.id)
      );
      const captureOutcomes = (runtime.trace?.events ?? []).filter((event) => event.type === 'capture').map((event) => event.outcome);
      if (!importedReads.some((operation) => (operation.sessionOrdinal ?? 0) === 0) ||
        importedReads.some((operation) => (operation.sessionOrdinal ?? 0) > 0) ||
        !captureOutcomes.some((outcome) => outcome === 'created' || outcome === 'updated') || !freshLoadedExtract) {
        return { valid: false, recalled: false, reason: 'fresh extracted-import reuse evidence is missing' };
      }
    }
    const captureOperations = (runtime.toolOperations ?? []).filter((operation) =>
      operation.name === 'Learn' || ['register', 'capture', 'learn'].some((action) => commandActions.get(operation)?.has(action))
    );
    if (expected.requiresCapture === true && captureOperations.some((operation) => operation.actorRole === 'worker')) {
      return { valid: false, recalled: false, reason: 'worker-owned knowledge capture is not primary evidence' };
    }
    const bodyLoads = (runtime.toolOperations ?? []).filter((operation) => commandActions.get(operation)?.has('load')).length;
    const historyLoads = (runtime.toolOperations ?? []).filter((operation) => commandActions.get(operation)?.has('history') || commandActions.get(operation)?.has('inspect')).length;
    if (Number.isInteger(expected.allowedLoads) && bodyLoads > expected.allowedLoads) {
      return { valid: false, recalled: false, reason: 'unnecessary knowledge body load evidence is present' };
    }
    if (Number.isInteger(expected.allowedHistoryLoads) && historyLoads > expected.allowedHistoryLoads) {
      return { valid: false, recalled: false, reason: 'unnecessary history load evidence is present' };
    }
    const ghCommands = runtime.workflowEvidence?.ghCommands ?? [];
    if (cell.condition === 'candidate' && Number.isInteger(expected.minimumPrCreates) && ghCommands.filter((command) => /^pr create\b/.test(command)).length < expected.minimumPrCreates) {
      return { valid: false, recalled: false, reason: 'direct PR fallback evidence is missing' };
    }
    if (cell.condition === 'candidate' && expected.requiresSameWorkId === true) {
      const workRecords = runtime.snapshots?.after?.workRecords ?? [];
      if (workRecords.length !== 1 || !workRecords[0].id || !workRecords[0].revisionToken ||
        !workRecords[0].execution || !workRecords[0].verification || !workRecords[0].pullRequest) {
        return { valid: false, recalled: false, reason: 'same work identity evidence is missing' };
      }
    }
    if (expected.requiresPrView === true && !ghCommands.some((command) => /^pr view\b/.test(command))) {
      return { valid: false, recalled: false, reason: 'repeat/noop PR evidence is missing' };
    }
    if (expected.requiresPrView === true) {
      const drafts = runtime.workflowEvidence?.ghState?.pullRequests ?? [];
      const openDrafts = drafts.filter((draft) => draft.state === 'OPEN' && draft.isDraft === true && draft.url);
      if (openDrafts.length !== 1) {
        return { valid: false, recalled: false, reason: 'existing draft survival evidence is missing' };
      }
      if (expected.requiresDraftReplacement === true) {
        const closed = drafts.find((draft) => draft.state === 'CLOSED' && draft.number === runtime.lifecycleEvidence?.closedDraftNumber);
        if (runtime.lifecycleEvidence?.draftClosure !== 'closed' || !closed || closed.headRefName !== openDrafts[0].headRefName) {
          return { valid: false, recalled: false, reason: 'replacement draft evidence is missing' };
        }
      }
    }
    return expected.manualRubric
      ? { valid: false, recalled: null, reason: 'manual semantic adjudication pending', structuralValid: true, manualRubric: expected.manualRubric }
      : { valid: true, recalled: true, reason: null };
  }
  const answer = (runtime.textFinalAnswers ?? []).join('\n').toLocaleLowerCase();
  const required = Array.isArray(expected.requiredPhrases) ? expected.requiredPhrases : [];
  const missing = required.filter(phrase => !answer.includes(String(phrase).toLocaleLowerCase()));
  if (missing.length > 0) return { valid: false, recalled: false, reason: 'required oracle phrase was not found' };
  return { valid: true, recalled: true, reason: null };
}

function cellStatus(runtime, judged) {
  if (runtime?.status !== 'completed') return runtime?.status ?? 'invalid';
  if (judged.valid) return 'completed';
  return judged.structuralValid === true && judged.recalled === null ? 'pending' : 'invalid';
}

export async function runCells(freezeManifest, outputDir, invoke) {
  const oracle = freezeManifest.oraclePath ? readJson(freezeManifest.oraclePath) : freezeManifest.oracle;
  fs.mkdirSync(outputDir, { recursive: true });
  const cacheKeyFor = (cell) => hash(JSON.stringify({
    fixture: cell.fixtureHash ?? freezeManifest.hashes?.fixtures,
    prompt: cell.promptHash ?? null,
    artifactPath: cell.artifactPath ?? null,
    configuration: freezeManifest.hashes.configuration,
    plugin: cell.condition === 'candidate'
      ? { source: 'candidate', hash: freezeManifest.hashes.candidate }
      : cell.condition === 'baseline'
        ? { source: 'baseline', revision: freezeManifest.baseline }
        : null,
    nativePipelineInputs: freezeManifest.hashes.nativePipelineInputs,
  }));
  const resumeEnabled = Boolean(freezeManifest.hashes);
  const cacheDirectory = path.join(outputDir, '.knowledge-evaluation-cells');
  if (resumeEnabled) fs.mkdirSync(cacheDirectory, { recursive: true });
  const results = [];
  const pending = [...freezeManifest.cells];
  const activeByHost = new Map(HOSTS.map(host => [host, 0]));
  const total = freezeManifest.concurrency?.total ?? 4;
  const perHost = freezeManifest.concurrency?.perHost ?? 2;
  const next = async () => {
    for (;;) {
      const index = pending.findIndex(cell => activeByHost.get(cell.host) < perHost);
      if (index === -1) return;
      const cell = pending.splice(index, 1)[0];
      activeByHost.set(cell.host, activeByHost.get(cell.host) + 1);
      try {
        const freezeKey = resumeEnabled ? cacheKeyFor(cell) : null;
        const cachePath = freezeKey ? path.join(cacheDirectory, `${hash(cell.id).slice('sha256:'.length)}.json`) : null;
        if (cachePath && fs.existsSync(cachePath)) {
          try {
            const cached = readJson(cachePath);
            if (cached.freezeKey === freezeKey && cached.cell?.id === cell.id) {
              const runtime = replayCachedRuntime(cell, cached.cell.runtime);
              const judged = judgeCell(cell, runtime, oracle);
              const result = {
                ...cached.cell,
                status: cellStatus(runtime, judged),
                runtime,
                judged,
              };
              const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
              fs.writeFileSync(temporary, `${JSON.stringify({ freezeKey, cell: result }, null, 2)}\n`);
              fs.renameSync(temporary, cachePath);
              results.push(result);
              continue;
            }
          } catch {
            // A partial cell artifact is never reused.
          }
        }
        const cellDir = fs.mkdtempSync(path.join(outputDir, `${cell.host}-${cell.condition}-`));
        let runtime;
        try {
          runtime = await invoke({ ...cell, cellDir });
        } catch (error) {
          runtime = {
            status: 'launch_failed',
            exit: { exitCode: null, signal: null, timedOut: false, outputLimited: false, error: error instanceof Error ? error.message : String(error) },
            toolOperations: [], toolResults: [], textFinalAnswers: [],
            trace: { availability: 'unavailable', reason: 'cell invocation threw before native evidence was complete', events: [] },
            cellError: error instanceof Error ? error.message : String(error),
          };
        }
        const judged = judgeCell(cell, runtime, oracle);
        const result = {
          ...cell,
          status: cellStatus(runtime, judged),
          runtime: {
            ...runtime,
            usage: { ...(runtime?.usage ?? {}), primary: normalizeUsage(runtime?.usage?.primary ?? runtime?.usage) },
          },
          judged,
        };
        if (cachePath) {
          const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
          fs.writeFileSync(temporary, `${JSON.stringify({ freezeKey, cell: result }, null, 2)}\n`);
          fs.renameSync(temporary, cachePath);
        }
        results.push(result);
      } finally {
        activeByHost.set(cell.host, activeByHost.get(cell.host) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: total }, next));
  results.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 2, baseline: BASELINE, cells: results, aggregate: aggregate(results) };
}

function cohortReport(cells) {
  const cohorts = {};
  for (const cell of cells) {
    const key = `${cell.condition}:${cell.host}:${cell.cohort ?? 'workflow'}`;
    const cohort = cohorts[key] ?? {
      samples: 0, completed: 0, pending: 0, invalid: 0, recalled: 0, manualPending: 0,
      sessions: [], messages: [], workflowOperations: [], historyEntries: [],
      injectedTokens: [], previewTokens: [], loadedBodyTokens: [], redundantTokens: [], totalTokens: [],
      nativeInput: [], nativeCache: [], nativeCacheWrite: [], nativeOutput: [], nativeReasoning: [], nativeTotal: [],
    };
    cohort.samples += 1;
    if (cell.status === 'completed') cohort.completed += 1;
    if (cell.status === 'pending') cohort.pending += 1;
    if (cell.status === 'invalid') cohort.invalid += 1;
    if (cell.judged?.recalled === true) cohort.recalled += 1;
    if (cell.judged?.structuralValid === true) cohort.manualPending += 1;
    cohort.sessions.push(cell.runtime?.sessions?.length ?? 1);
    cohort.messages.push(cell.runtime?.textFinalAnswers?.length ?? 0);
    cohort.workflowOperations.push((cell.runtime?.toolOperations ?? []).filter((operation) => ['Skill', 'Task', 'Plan', 'Execute', 'Ship', 'CreatePR'].includes(operation.name)).length);
    cohort.historyEntries.push(cell.runtime?.snapshots?.after?.history?.length ?? null);
    cohort.injectedTokens.push(cell.runtime?.injectedTokens ?? null);
    cohort.previewTokens.push(cell.runtime?.previewTokens ?? null);
    cohort.loadedBodyTokens.push(cell.runtime?.loadedBodyTokens ?? null);
    cohort.redundantTokens.push(cell.runtime?.redundantTokens ?? null);
    cohort.totalTokens.push(cell.runtime?.totalTokens ?? null);
    const native = cell.runtime?.nativeFullCycleUsage?.coverage === 'complete'
      ? cell.runtime.nativeFullCycleUsage.total : null;
    cohort.nativeInput.push(native?.input ?? null);
    cohort.nativeCache.push(native?.cache ?? null);
    cohort.nativeCacheWrite.push(native?.cacheWrite ?? null);
    cohort.nativeOutput.push(native?.output ?? null);
    cohort.nativeReasoning.push(native?.reasoning ?? null);
    cohort.nativeTotal.push(nativeUsageTokenTotal(cell.host, native));
    cohorts[key] = cohort;
  }
  return Object.fromEntries(Object.entries(cohorts).map(([key, cohort]) => [key, {
    ...cohort,
    sessions: metricSummary(cohort.sessions),
    messages: metricSummary(cohort.messages),
    workflowOperations: metricSummary(cohort.workflowOperations),
    historyEntries: metricSummary(cohort.historyEntries),
    injectedTokens: metricSummary(cohort.injectedTokens),
    previewTokens: metricSummary(cohort.previewTokens),
    loadedBodyTokens: metricSummary(cohort.loadedBodyTokens),
    redundantTokens: metricSummary(cohort.redundantTokens),
    totalTokens: metricSummary(cohort.totalTokens),
    nativePrimaryPlusWorkerTokens: {
      input: metricSummary(cohort.nativeInput), cache: metricSummary(cohort.nativeCache), cacheWrite: metricSummary(cohort.nativeCacheWrite),
      output: metricSummary(cohort.nativeOutput), reasoning: metricSummary(cohort.nativeReasoning), total: metricSummary(cohort.nativeTotal),
    },
  }]));
}

function metricSummary(values) {
  return { known: values.filter(Number.isFinite).length, missing: values.filter((value) => !Number.isFinite(value)).length, median: percentile(values, .5), p95: percentile(values, .95) };
}

function nativeUsageTokenTotal(host, value) {
  if (!value || !Number.isFinite(value.input) || !Number.isFinite(value.output)) return null;
  // Claude modelUsage separates ordinary and cache input; Codex input already includes its cache dimensions.
  if (host === 'codex') return value.input + value.output;
  return Number.isFinite(value.cache) && Number.isFinite(value.cacheWrite)
    ? value.input + value.cache + value.cacheWrite + value.output : null;
}

function semanticOutcome(judgment) {
  if (!judgment?.artifactHashMatches) return null;
  const values = [judgment.correct, judgment.relevant, judgment.requiredRecallBeforeDecision];
  return values.some((value) => value === false) ? false : values.every((value) => value === true) ? true : null;
}

function knowledgeBenefitCase(expected = {}) {
  return (expected.requiredRecordHashes?.length ?? 0) > 0 || expected.requiresCapture === true ||
    expected.requiredReadCommand === 'inspect' || expected.requiresFreshExtractedReuse === true;
}

function pairedReport(cells, oracle = {}, primaryJudgments = []) {
  const manual = new Map(primaryJudgmentReport(cells, primaryJudgments).reviewed.map((judgment) => [judgment.cellId, judgment]));
  const grouped = new Map();
  for (const cell of cells) {
    const key = `${cell.caseId}:${cell.host}:${cell.repeat}`;
    const group = grouped.get(key) ?? {};
    group[cell.condition] = cell;
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([id, group]) => {
    const candidateSemantic = semanticOutcome(manual.get(group.candidate?.id));
    const baselineSemantic = semanticOutcome(manual.get(group.baseline?.id));
    const noKnowledgeSemantic = semanticOutcome(manual.get(group['no-knowledge']?.id));
    const eitherControlCorrect = baselineSemantic === true || noKnowledgeSemantic === true;
    const structural = group.candidate?.judged?.structuralValid === true;
    return {
      id,
      caseId: group.candidate?.caseId ?? group.baseline?.caseId ?? group['no-knowledge']?.caseId ?? null,
      baseline: group.baseline?.judged?.recalled ?? null,
      candidate: group.candidate?.judged?.recalled ?? null,
      noKnowledge: group['no-knowledge']?.judged?.recalled ?? null,
      comparable: Boolean(group.baseline && group.candidate && group['no-knowledge']),
      knowledgeBenefit: knowledgeBenefitCase(oracle[group.candidate?.caseId ?? group.baseline?.caseId ?? group['no-knowledge']?.caseId] ?? {}),
      semantic: { candidate: candidateSemantic, baseline: baselineSemantic, noKnowledge: noKnowledgeSemantic },
      correctnessVsBothControls: candidateSemantic === false && eitherControlCorrect ? 'regression'
        : candidateSemantic === true ? 'no-regression'
          : candidateSemantic === null || baselineSemantic === null || noKnowledgeSemantic === null ? 'unknown' : 'not-comparable',
      qualityGate: structural && candidateSemantic === true && baselineSemantic !== null && noKnowledgeSemantic !== null,
      loadedBodyTokenDelta: Number.isFinite(group.candidate?.runtime?.loadedBodyTokens) && Number.isFinite(group.baseline?.runtime?.loadedBodyTokens)
        ? group.candidate.runtime.loadedBodyTokens - group.baseline.runtime.loadedBodyTokens : null,
      nativeFullCycleTokenDelta: pairedDelta(group.candidate, group.baseline),
      noKnowledgeNativeOverhead: pairedDelta(group.candidate, group['no-knowledge']),
      baselineNativeOverhead: pairedDelta(group.baseline, group['no-knowledge']),
    };
  });
}

function repeatInstabilityReport(cells) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.caseId}:${cell.condition}:${cell.host}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([id, group]) => {
    const values = group.map((cell) => nativeUsageTokenTotal(cell.host, cell.runtime?.nativeFullCycleUsage?.coverage === 'complete' ? cell.runtime.nativeFullCycleUsage.total : null));
    const known = values.filter(Number.isFinite);
    return {
      id, repeats: group.length,
      nativeFullCycleTokenRange: known.length === group.length && known.length > 0 ? Math.max(...known) - Math.min(...known) : null,
      structuralOutcomes: group.map((cell) => cell.judged?.structuralValid === true ? 'valid' : cell.judged?.recalled === false ? 'invalid' : 'unknown'),
    };
  });
}

function pairedDelta(left, right) {
  const leftUsage = left?.runtime?.nativeFullCycleUsage;
  const rightUsage = right?.runtime?.nativeFullCycleUsage;
  if (leftUsage?.coverage !== 'complete' || rightUsage?.coverage !== 'complete') return null;
  const leftValue = nativeUsageTokenTotal(left?.host, leftUsage.total);
  const rightValue = nativeUsageTokenTotal(right?.host, rightUsage.total);
  return Number.isFinite(leftValue) && Number.isFinite(rightValue) ? leftValue - rightValue : null;
}

export function primaryJudgmentReport(cells, primaryJudgments = []) {
  const judgments = new Map(primaryJudgments.filter((judgment) => judgment?.cellId).map((judgment) => [judgment.cellId, judgment]));
  const reviewed = cells.filter((cell) => judgments.has(cell.id)).map((cell) => {
    const judgment = judgments.get(cell.id);
    const artifactHashMatches = typeof judgment.artifactHash === 'string' && judgment.artifactHash === cell.runtime?.deliverable?.hash &&
      judgment.artifactEvidence === judgment.artifactHash;
    return {
      cellId: cell.id, artifactHashMatches,
      correct: judgment.correct === true ? true : judgment.correct === false ? false : null,
      relevant: judgment.relevant === true ? true : judgment.relevant === false ? false : null,
      requiredRecallBeforeDecision: judgment.requiredRecallBeforeDecision === true ? true : judgment.requiredRecallBeforeDecision === false ? false : null,
      irrelevantTokens: Number.isFinite(judgment.irrelevantTokens) ? judgment.irrelevantTokens : null,
      unnecessaryHistoryLoads: Number.isFinite(judgment.unnecessaryHistoryLoads) ? judgment.unnecessaryHistoryLoads : null,
      justifiedExpansions: Array.isArray(judgment.justifiedExpansions) ? judgment.justifiedExpansions.length : null,
    };
  });
  const invalid = reviewed.some((judgment) => !judgment.artifactHashMatches);
  const pending = cells.some((cell) => !judgments.has(cell.id)) ||
    reviewed.some((judgment) => judgment.correct === null || judgment.relevant === null || judgment.requiredRecallBeforeDecision === null);
  return {
    reviewed,
    semanticFailures: reviewed.filter((judgment) => judgment.correct === false || judgment.relevant === false || judgment.requiredRecallBeforeDecision === false).map((judgment) => judgment.cellId),
    status: invalid ? 'invalid' : pending ? 'pending' : 'reviewed',
  };
}

export function evaluationQualityReport(cells, primaryJudgments = []) {
  const manual = primaryJudgmentReport(cells, primaryJudgments);
  const byCondition = Object.fromEntries(CONDITIONS.map((condition) => {
    const samples = cells.filter((cell) => cell.condition === condition);
    const runtime = samples.map((cell) => cell.runtime ?? {});
    const completeUsage = runtime.filter((value) => value.nativeFullCycleUsage?.coverage === 'complete').length;
    const traceAvailable = condition === 'candidate'
      ? runtime.filter((value) => value.trace?.availability === 'available').length : null;
    const verifiedNoKnowledgeHook = condition === 'no-knowledge'
      ? runtime.filter((value) => value.sessionStartMeasurement?.availability === 'none').length : null;
    const baselineMetrics = condition === 'baseline'
      ? runtime.filter((value) => Number.isFinite(value.loadedBodyTokens) || Number.isFinite(value.previewTokens)).length : null;
    return [condition, {
      samples: samples.length,
      hostCompleted: samples.filter((cell) => cell.runtime?.status === 'completed').length,
      structuralValid: samples.filter((cell) => cell.judged?.structuralValid === true).length,
      invalid: samples.filter((cell) => cell.judged?.recalled === false).length,
      manualPending: samples.filter((cell) => cell.judged?.recalled === null).length,
      nativeFullCycleUsage: { known: completeUsage, missing: samples.length - completeUsage },
      ...(condition === 'candidate' ? { trace: { available: traceAvailable, unavailable: samples.length - traceAvailable } } : {}),
      ...(condition === 'baseline' ? { postHocPayloadMetrics: { available: baselineMetrics, unavailable: samples.length - baselineMetrics } } : {}),
      ...(condition === 'no-knowledge' ? { sessionStart: { verifiedNone: verifiedNoKnowledgeHook, unavailable: samples.length - verifiedNoKnowledgeHook } } : {}),
    }];
  }));
  const candidateStructuralFailures = cells.filter((cell) => cell.condition === 'candidate' && cell.judged?.recalled === false).length;
  const expected = 12 * CONDITIONS.length * HOSTS.length * 2;
  return {
    expectedSamples: expected,
    observedSamples: cells.length,
    missingSamples: Math.max(0, expected - cells.length),
    controls: byCondition,
    manual,
    candidateStructuralFailures,
    status: candidateStructuralFailures > 0 || manual.status === 'invalid' ? 'fail'
      : cells.length === expected && manual.status === 'reviewed' ? 'reviewed' : 'pending',
    note: 'Unknown native usage, unavailable trace, unavailable baseline payload metrics, and unreviewed artifacts remain explicit gaps and cannot establish a pass.',
  };
}

function cappedMeasurements(values, limit) {
  const known = values.filter(Number.isFinite);
  return {
    limit, known: known.length, missing: values.length - known.length,
    max: known.length > 0 ? Math.max(...known) : 'unknown',
    status: values.length === 0 || known.length !== values.length ? 'unknown' : known.every((value) => value <= limit) ? 'pass' : 'fail',
  };
}

function knowledgeEfficiencyReport(cells, oracle, primaryJudgments = []) {
  const candidates = cells.filter((cell) => cell.condition === 'candidate');
  const candidateEvents = candidates.map((cell) => ({ cell, events: cell.runtime?.trace?.availability === 'available' ? cell.runtime.trace.events ?? [] : null }));
  const sessionStart = candidates.flatMap((cell) => {
    const sessions = cell.runtime?.usage?.sessions ?? [];
    const measured = sessions.map((session) => session.sessionStartMeasurement?.availability === 'available' ? session.sessionStartMeasurement.injectedTokens : null);
    if (measured.length === 1 && measured[0] === null && cell.runtime?.sessionStartMeasurement?.availability === 'available') {
      return [cell.runtime.sessionStartMeasurement.injectedTokens];
    }
    return measured;
  });
  const searchResponses = candidateEvents.flatMap(({ events }) => events === null ? [null] : events.filter((event) => event.type === 'search').map((event) => event.responseTokens));
  const initialBodies = candidateEvents.flatMap(({ events }) => events === null ? [null] : events.filter((event) => event.type === 'load' && event.expanded !== true).map((event) => event.loadedTokens));
  const expansions = candidateEvents.flatMap(({ events }) => events === null ? [{ known: false }] : events.filter((event) => event.type === 'expansion'));
  const manual = new Map(primaryJudgmentReport(cells, primaryJudgments).reviewed.map((judgment) => [judgment.cellId, judgment]));
  const routine = candidates.filter((cell) => cell.cohort === 'chat' || cell.cohort === 'workflow');
  const completeRoutine = routine.every((cell) => Number.isFinite(cell.runtime?.loadedBodyTokens) && Number.isFinite(manual.get(cell.id)?.irrelevantTokens));
  const routineIrrelevant = completeRoutine ? routine.reduce((total, cell) => total + manual.get(cell.id).irrelevantTokens, 0) : null;
  const routineLoaded = completeRoutine ? routine.reduce((total, cell) => total + cell.runtime.loadedBodyTokens, 0) : null;
  const critical = candidates.filter((cell) => cell.critical === true);
  const criticalHistory = critical.map((cell) => manual.get(cell.id)?.unnecessaryHistoryLoads);
  const criticalRedundant = critical.map((cell) => cell.runtime?.redundantTokens);
  return {
    startupTokens: cappedMeasurements(sessionStart, 300),
    searchPreviewTokens: cappedMeasurements(searchResponses, 500),
    initialLoadTokens: cappedMeasurements(initialBodies, 1500),
    expansions: {
      observed: expansions.length,
      unknown: expansions.filter((event) => event.known === false).length,
      overAllowance: expansions.filter((event) => event.deliveredOverAllowance === true).length,
      status: expansions.some((event) => event.known === false) ? 'unknown' : expansions.some((event) => event.deliveredOverAllowance === true) ? 'fail' : 'pass',
    },
    routineIrrelevantLoadedBodyRate: routineIrrelevant === null || routineLoaded === null ? 'unknown'
      : routineLoaded === 0 ? 0 : routineIrrelevant / routineLoaded,
    routineIrrelevantLoadedBodyRateStatus: routineIrrelevant === null || routineLoaded === null ? 'unknown'
      : routineLoaded === 0 || routineIrrelevant / routineLoaded <= ACCEPTANCE_THRESHOLDS.routineIrrelevantLoadedBodyRate ? 'pass' : 'fail',
    criticalHistoryLoads: criticalHistory.every(Number.isFinite) ? criticalHistory.reduce((total, value) => total + value, 0) : 'unknown',
    criticalRedundantTokens: criticalRedundant.every(Number.isFinite) ? criticalRedundant.reduce((total, value) => total + value, 0) : 'unknown',
  };
}

function thresholdStatus(values) {
  return values.includes('fail') ? 'fail' : values.every((value) => value === 'pass') ? 'pass' : 'pending';
}

function thresholdReport(cells, paired, oracle = {}, primaryJudgments = []) {
  const manual = primaryJudgmentReport(cells, primaryJudgments);
  const manualByCell = new Map(manual.reviewed.map((judgment) => [judgment.cellId, judgment]));
  const candidateCells = cells.filter((cell) => cell.condition === 'candidate');
  const candidateStructural = candidateCells.length > 0 && candidateCells.every((cell) => cell.judged?.structuralValid === true) ? 'pass'
    : candidateCells.some((cell) => cell.judged?.recalled === false) ? 'fail' : 'unknown';
  const candidateSemantic = candidateCells.length > 0 && candidateCells.every((cell) => semanticOutcome(manualByCell.get(cell.id)) === true) ? 'pass'
    : candidateCells.some((cell) => semanticOutcome(manualByCell.get(cell.id)) === false) ? 'fail' : 'unknown';
  const required = cells.filter((cell) => cell.condition === 'candidate' && cell.critical === true);
  const requiredRecall = required.length > 0 && required.every((cell) => cell.judged?.structuralValid === true && semanticOutcome(manualByCell.get(cell.id)) === true)
    ? 'pass' : required.some((cell) => cell.judged?.recalled === false || semanticOutcome(manualByCell.get(cell.id)) === false) ? 'fail' : 'unknown';
  const efficiency = knowledgeEfficiencyReport(cells, oracle, primaryJudgments);
  const benefitPairs = paired.filter((pair) => pair.knowledgeBenefit);
  const eligible = benefitPairs.filter((pair) => pair.qualityGate === true);
  const failedQualityPairs = benefitPairs.filter((pair) => pair.qualityGate === false);
  const unknownQualityPairs = benefitPairs.filter((pair) => pair.qualityGate !== true && pair.qualityGate !== false);
  const pairedCosts = eligible.map((pair) => pair.nativeFullCycleTokenDelta).filter(Number.isFinite);
  const regressions = paired.filter((pair) => pair.correctnessVsBothControls === 'regression').length;
  const unknownComparisons = paired.filter((pair) => pair.knowledgeBenefit && pair.correctnessVsBothControls === 'unknown').length;
  const historyStatus = efficiency.criticalHistoryLoads === 'unknown' ? 'unknown' : efficiency.criticalHistoryLoads === 0 ? 'pass' : 'fail';
  const redundantStatus = efficiency.criticalRedundantTokens === 'unknown' ? 'unknown' : efficiency.criticalRedundantTokens === 0 ? 'pass' : 'fail';
  const correctnessStatus = regressions > 0 ? 'fail' : unknownComparisons > 0 ? 'unknown' : 'pass';
  return {
    thresholds: ACCEPTANCE_THRESHOLDS,
    allCandidateDelivery: { structural: candidateStructural, semantic: candidateSemantic },
    requiredRecall,
    correctnessVsBothControls: { regressions, unknown: unknownComparisons, status: correctnessStatus },
    efficiency,
    pairedEfficiency: {
      knowledgeBenefitPairs: benefitPairs.length,
      qualityEligiblePairs: eligible.length,
      failedQualityPairs: failedQualityPairs.length,
      unknownQualityPairs: unknownQualityPairs.length,
      knownCostPairs: pairedCosts.length,
      medianDelta: pairedCosts.length > 0 ? percentile(pairedCosts, .5) : 'unknown',
      hypothesis: benefitPairs.length === 0 || failedQualityPairs.length > 0 || unknownQualityPairs.length > 0 || pairedCosts.length !== benefitPairs.length ? 'unknown'
        : percentile(pairedCosts, .5) < 0 ? 'supported' : 'not-supported',
    },
    manual,
    status: cells.length < 144 || manual.status !== 'reviewed' ? 'pending' : thresholdStatus([
      requiredRecall, correctnessStatus, historyStatus, redundantStatus,
      candidateStructural, candidateSemantic,
      efficiency.startupTokens.status, efficiency.searchPreviewTokens.status, efficiency.initialLoadTokens.status,
      efficiency.expansions.status, efficiency.routineIrrelevantLoadedBodyRateStatus,
    ]),
    note: 'A pass requires complete native samples, hash-bound manual correctness and relevance for every artifact, and complete metric evidence.',
  };
}

function readArtifact(projectDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'evaluation-result.json'), 'utf8'));
    return Array.isArray(parsed?.recordIds) && Array.isArray(parsed?.actions) ? parsed : null;
  } catch {
    return null;
  }
}

function deliverableEvidence(projectDir, deliverablePath) {
  try {
    const target = path.join(projectDir, deliverablePath);
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { exists: false, bytes: null, hash: null, content: null, truncated: false };
    const content = fs.readFileSync(target, 'utf8');
    const limit = 64 * 1024;
    return {
      exists: true, bytes: stat.size, hash: hash(content),
      content: content.slice(0, limit), truncated: Buffer.byteLength(content, 'utf8') > limit,
    };
  } catch {
    return { exists: false, bytes: null, hash: null, content: null, truncated: false };
  }
}

function changedProjectEvidence(projectDir) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' });
  if (result.status !== 0) return { availability: 'unavailable', changed: [] };
  const changed = result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const relative = line.slice(3).trim();
    if (!relative || path.isAbsolute(relative) || relative.includes('..')) return [];
    const target = path.join(projectDir, relative);
    try {
      const content = fs.readFileSync(target, 'utf8');
      const limit = 16 * 1024;
      return [{ path: relative, hash: hash(content), content: content.slice(0, limit), truncated: Buffer.byteLength(content, 'utf8') > limit }];
    } catch {
      return [{ path: relative, hash: null, content: null, truncated: false }];
    }
  });
  return { availability: 'available', changed };
}

function compactSnapshot(snapshot, relevantIds, previous = null) {
  const retain = new Set(relevantIds);
  if (previous) {
    const before = new Map((previous.records ?? []).map((record) => [record.id, record.revisionToken ?? record.sourceFingerprint ?? null]));
    for (const record of snapshot.records ?? []) {
      const token = record.revisionToken ?? record.sourceFingerprint ?? null;
      if (!before.has(record.id) || before.get(record.id) !== token) retain.add(record.id);
    }
  }
  const records = (snapshot.records ?? []).filter((record) => retain.has(record.id));
  const history = (snapshot.history ?? []).filter((entry) => retain.has(entry.id));
  const activity = snapshot.activity ? {
    ...snapshot.activity,
    records: Object.fromEntries(Object.entries(snapshot.activity.records ?? {}).filter(([id]) => retain.has(id))),
    search: {
      ...snapshot.activity.search,
      recordMatches: Object.fromEntries(Object.entries(snapshot.activity.search?.recordMatches ?? {}).filter(([id]) => retain.has(id))),
    },
  } : null;
  return {
    records, history, activity,
    workRecords: (snapshot.workRecords ?? []).filter((record) => retain.has(record.id)),
  };
}

function workflowEvidence(staged) {
  try {
    return { ghCommands: fs.readFileSync(staged.ghLogPath, 'utf8').split(/\r?\n/).filter(Boolean), ghState: readGhState(staged) };
  } catch {
    return { ghCommands: [], ghState: null };
  }
}

function closeLifecycleDraft(staged) {
  const before = readGhState(staged);
  const draft = before?.pullRequests?.find((pullRequest) => pullRequest.state === 'OPEN' && pullRequest.isDraft === true);
  if (!draft?.number) return { draftClosure: 'unavailable', closedDraftNumber: null, error: 'no open local draft was available to close' };
  const environment = { ...process.env, ...(staged.environment ?? {}) };
  const close = spawnSync('gh', ['pr', 'close', String(draft.number)], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });
  if (close.status !== 0) return { draftClosure: 'failed', closedDraftNumber: draft.number, error: 'local draft close failed' };
  const view = spawnSync('gh', ['pr', 'view', String(draft.number), '--json', 'url', '--jq', '.url'], { cwd: staged.projectDir, env: environment, encoding: 'utf8' });
  if (view.status !== 0) return { draftClosure: 'failed', closedDraftNumber: draft.number, error: 'closed local draft could not be queried by ID' };
  const closed = readGhState(staged)?.pullRequests?.find((pullRequest) => pullRequest.number === draft.number && pullRequest.state === 'CLOSED');
  return closed ? { draftClosure: 'closed', closedDraftNumber: draft.number, error: null } :
    { draftClosure: 'failed', closedDraftNumber: draft.number, error: 'local draft state did not become closed' };
}

function readGhState(staged) {
  try {
    const state = readJson(staged.ghStatePath);
    return {
      nextNumber: Number.isInteger(state.nextNumber) ? state.nextNumber : null,
      pullRequests: Array.isArray(state.pullRequests) ? state.pullRequests.map(({ number, url, state: status, isDraft, headRefName, baseRefName }) =>
        ({ number, url, state: status, isDraft, headRefName, baseRefName })) : [],
    };
  } catch {
    return null;
  }
}

function hostConfiguration(configuration, host) {
  const selected = configuration?.hosts?.[host] ?? configuration;
  if (typeof selected?.model !== 'string' || typeof selected?.effort !== 'string') {
    throw new Error(`configuration must provide model and effort for ${host}`);
  }
  return selected;
}

export function limitsForFixture(fixtureCase, limits = {}) {
  return fixtureCase?.longitudinal === true || fixtureCase?.cohort === 'workflow'
    ? limits.workflow ?? limits.ordinary ?? undefined
    : limits.ordinary ?? undefined;
}

function candidatePluginRoots(options = {}) {
  if (options.candidatePluginRoots) return options.candidatePluginRoots;
  const root = options.candidatePluginRoot;
  if (!root) return undefined;
  const claude = path.join(root, 'spectre');
  const codex = path.join(root, 'spectre-codex');
  if (!fs.existsSync(claude) || !fs.existsSync(codex)) {
    throw new Error('candidate plugin root must contain both spectre and spectre-codex; pass host-specific roots otherwise');
  }
  return { claude, codex };
}

export function mergeHostRuns(runs) {
  const completed = runs.every((run) => run.status === 'completed');
  const failed = runs.find((run) => run.status !== 'completed');
  return {
    ...runs.at(-1),
    status: completed ? 'completed' : runs.find((run) => run.status !== 'completed').status,
    exit: failed?.exit ?? runs.at(-1)?.exit ?? null,
    traceUnavailable: runs.some((run) => run.traceUnavailable === true),
    usage: {
      primary: runs.at(-1)?.usage?.primary ?? null,
      workers: runs.at(-1)?.usage?.workers ?? null,
      fullCycle: nativeFullCycleUsage(runs),
      sessionStartMeasurement: sessionStartMeasurement(runs),
      sessions: runs.map((run) => ({ ...(run.usage ?? {}), sessionStartMeasurement: run.sessionStartMeasurement ?? null })),
    },
    toolOperations: runs.flatMap((run, sessionOrdinal) =>
      (run.toolOperations ?? []).map((operation) => ({ ...operation, sessionOrdinal }))
    ),
    toolResults: runs.flatMap((run, sessionOrdinal) =>
      (run.toolResults ?? []).map((result) => ({ ...result, sessionOrdinal }))
    ),
    textFinalAnswers: runs.flatMap((run) => run.textFinalAnswers ?? []),
    sessions: runs.map((run) => ({ status: run.status, exit: run.exit ?? null })),
  };
}

function sessionStartMeasurement(runs) {
  const measurements = runs.map((run) => run.sessionStartMeasurement).filter(Boolean);
  if (measurements.length !== runs.length) return { availability: 'unavailable', injectedTokens: null, injectedBytes: null };
  if (measurements.every((measurement) => measurement.availability === 'none')) return { availability: 'none', injectedTokens: 0, injectedBytes: 0 };
  if (!measurements.every((measurement) => measurement.availability === 'available' && Number.isFinite(measurement.injectedTokens) && Number.isFinite(measurement.injectedBytes))) {
    return { availability: 'unavailable', injectedTokens: null, injectedBytes: null };
  }
  return {
    availability: 'available',
    injectedTokens: measurements.reduce((total, measurement) => total + measurement.injectedTokens, 0),
    injectedBytes: measurements.reduce((total, measurement) => total + measurement.injectedBytes, 0),
  };
}

function nativeFullCycleUsage(runs) {
  const sources = runs.map((run) => run.usage?.fullCycle?.total ?? run.usage?.primary).filter(Boolean);
  if (sources.length !== runs.length) return null;
  const total = {};
  for (const field of ['input', 'cache', 'cacheWrite', 'output', 'reasoning']) {
    total[field] = sources.every((value) => Number.isFinite(value[field]))
      ? sources.reduce((sum, value) => sum + value[field], 0) : null;
  }
  return {
    source: runs.every((run) => run.usage?.fullCycle?.total) ? 'inclusive-model-totals' : 'primary-turn-totals',
    coverage: runs.every((run) => run.usage?.fullCycle?.total) ? 'complete' : 'unknown',
    sessions: runs.length,
    total,
  };
}

function jsonPayloads(content) {
  if (typeof content !== 'string') return [];
  const payloads = [];
  try {
    payloads.push(JSON.parse(content));
  } catch {
    for (const line of content.split(/\r?\n/)) {
      try {
        payloads.push(JSON.parse(line));
      } catch {
        // Mixed command output may include one JSON payload per line.
      }
    }
  }
  return payloads;
}

function loadNeedsExpansion(result) {
  if (typeof result?.content !== 'string') return false;
  return /Knowledge load needs expansion:/.test(result.content)
    || jsonPayloads(result.content).some((payload) => payload?.status === 'expansion-needed');
}

function wrappedLoadEvidence(result) {
  if (typeof result?.content !== 'string') return false;
  if (!/(?:^|\n)exit=0(?:\r?\n|$)/.test(result.content)) return false;
  return ['ok', 'status', 'id', 'revisionToken', 'record'].every((field) =>
    new RegExp(`['\"]?${field}['\"]?`).test(result.content)
  );
}

function successfulWorkJsonWrapperEvidence(result, commandId) {
  if (result?.isError === true || typeof result?.content !== 'string' || typeof commandId !== 'string') return false;
  const content = result.content;
  // JSON wrappers often print only parsed field names after the CLI has delivered a body.
  const fieldSummary = ['ok', 'status', 'id', 'kind', 'applicability', 'revisionToken', 'record'].every((field) =>
    new RegExp(`['\"]?${field}['\"]?`).test(content)
  );
  const loadExitSummary = /\bload\s+exit=0\b/.test(content) && /\brevisionToken\s*:/.test(content) && /\bpullRequest\s*:/.test(content);
  const historySummary = /\bprovenance\s*:/.test(content) && /\bapplicability\s*:/.test(content) &&
    content.includes(`\"workId\": \"${commandId}\"`) && jsonPayloads(content).some((payload) =>
      payload?.ok === true && payload.id === commandId && payload.entries?.some((entry) =>
        entry?.id === commandId && entry.historical === true && typeof entry.revisionToken === 'string'
      )
    );
  const registrationSummary = new RegExp(`(?:^|\\n)(?:expected-)?revision:\\s*sha256:[a-f0-9]+`, 'i').test(content) &&
    jsonPayloads(content).some((payload) => payload?.ok === true && payload.id === commandId &&
      ['noop', 'updated'].includes(payload.status) && typeof payload.revisionToken === 'string');
  return fieldSummary || loadExitSummary || historySummary || registrationSummary;
}

function returnedRevision(result) {
  if (typeof result?.content !== 'string') return null;
  return result.content.match(/(?:materialized at revision:|--- current revision ---\s*)(sha256:[a-f0-9]+)/i)?.[1] ?? null;
}

function commandFlag(command, flag) {
  if (typeof command !== 'string') return null;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(new RegExp(`${escaped}\\s+(?:'([^']+)'|\"([^\"]+)\"|([^\\s]+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function legacyCurrentHumanWork(loadResults, commandId, session, operation) {
  if (!commandId || typeof session?.contextHash !== 'string') return [];
  const command = operation.input?.command ?? '';
  const records = [session.before, session.after].flatMap((snapshot) => snapshot?.records ?? []);
  const candidates = new Map(records
    .filter((record) => record?.id === commandId && record.kind === 'work' && typeof record.revisionToken === 'string')
    .filter((record) => record.applicability?.scope === 'project'
      || (record.applicability?.scope === 'work'
        && (record.applicability.workId === commandFlag(command, '--work-id')
          || record.applicability.runIds?.includes(commandFlag(command, '--run-id')))))
    .map((record) => [record.revisionToken, record]));
  if (candidates.size === 0) return [];
  return loadResults.flatMap((result) => typeof result.content === 'string'
    && jsonPayloads(result.content).length === 0
    && result.content.includes(`- ID: ${commandId}`)
    && /Historical work record: historical evidence only/.test(result.content)
    ? [{ id: commandId, revisionTokens: [...candidates.keys()], responseBytes: Buffer.byteLength(result.content, 'utf8') }]
    : []);
}

export function traceWithOperationCrosscheck(trace, toolOperations, toolResults = [], sessionSnapshots = []) {
  if (trace.availability !== 'available') return trace;
  const actions = classifyKnowledgeCommands(toolOperations);
  const expected = new Map();
  const matchedHistoricalEvents = new Set();
  const matchedLoadEvents = new Set();
  const missingHistoricalEvents = [];
  const expect = (type) => expected.set(type, (expected.get(type) ?? 0) + 1);
  for (const operation of toolOperations ?? []) {
    if (operation.status && operation.status !== 'completed') continue;
    const delivered = toolResults.filter((result) => result?.toolUseId === operation.id &&
      (result.sessionOrdinal ?? 0) === (operation.sessionOrdinal ?? 0));
    if (!delivered.some((result) => result.isError !== true)) continue;
    const found = actions.get(operation);
    if (found?.has('search')) expect('search');
    if (found?.has('load')) {
      const loadResults = delivered.filter((result) => !loadNeedsExpansion(result));
      if (loadResults.length === 0) continue;
      const historicalWork = loadResults.flatMap((result) => jsonPayloads(result.content).flatMap((payload) =>
        payload?.ok === true && payload.status === 'loaded' && payload.kind === 'work' && payload.historical === true &&
          payload.activation === 'historical' && typeof payload.id === 'string' && typeof payload.revisionToken === 'string' ? [payload] : []
      ));
      const currentWork = loadResults.flatMap((result) => jsonPayloads(result.content).flatMap((payload) =>
        payload?.ok === true && payload.status === 'loaded' && payload.kind === 'work' && payload.historical === false &&
          payload.activation === 'current-guidance' && typeof payload.id === 'string' && typeof payload.revisionToken === 'string' ? [payload] : []
      ));
      const commandId = (operation.input?.command ?? '').match(/\bload\s+['"]?([a-z0-9]+(?:-[a-z0-9]+)+)['"]?/i)?.[1] ?? null;
      const session = sessionSnapshots[operation.sessionOrdinal ?? 0];
      if (currentWork.length > 0) {
        for (const payload of currentWork) {
          const matchingIndex = trace.events.findIndex((event, index) => !matchedLoadEvents.has(index) &&
            event.type === 'load' && event.contextHash === session?.contextHash &&
            event.id === payload.id && event.revisionToken === payload.revisionToken
          );
          if (matchingIndex === -1) missingHistoricalEvents.push('load');
          else matchedLoadEvents.add(matchingIndex);
        }
        continue;
      }
      const currentHumanWork = legacyCurrentHumanWork(loadResults, commandId, session, operation);
      if (currentHumanWork.length > 0) {
        for (const payload of currentHumanWork) {
          const matchingIndex = trace.events.findIndex((event, index) => !matchedLoadEvents.has(index) &&
            event.type === 'load' && event.contextHash === session?.contextHash &&
            event.id === payload.id && payload.revisionTokens.includes(event.revisionToken) &&
            event.responseBytes === payload.responseBytes
          );
          if (matchingIndex === -1) missingHistoricalEvents.push('load');
          else matchedLoadEvents.add(matchingIndex);
        }
        continue;
      }
      const humanHistorical = commandId && loadResults.some((result) => result.isError !== true &&
        typeof result.content === 'string' && result.content.includes(`- ID: ${commandId}`) && /Historical work record: historical evidence only/.test(result.content));
      const wrappedHistorical = commandId && loadResults.some(wrappedLoadEvidence);
      const workJsonWrapper = commandId && /--json\b/.test(operation.input?.command ?? '') && loadResults.some((result) => successfulWorkJsonWrapperEvidence(result, commandId));
      const reportedRevision = loadResults.map(returnedRevision).find(Boolean);
      const snapshotRevisions = new Set([session?.before, session?.after].flatMap((snapshot) =>
        (snapshot?.records ?? []).filter((record) => record.id === commandId).map((record) => record.revisionToken)
      ).filter((revisionToken) => typeof revisionToken === 'string'));
      for (const event of trace.events) {
        if (event.type === 'capture' && event.id === commandId && event.contextHash === session?.contextHash && typeof event.revisionToken === 'string') {
          snapshotRevisions.add(event.revisionToken);
        }
      }
      const expectedHistorical = historicalWork.length > 0 ? historicalWork
        : (humanHistorical || wrappedHistorical || workJsonWrapper) && typeof session?.contextHash === 'string'
          ? [...snapshotRevisions].map((revisionToken) => ({ id: commandId, revisionToken }))
          : reportedRevision && snapshotRevisions.has(reportedRevision) && typeof session?.contextHash === 'string'
            ? [{ id: commandId, revisionToken: reportedRevision }] : [];
      if (expectedHistorical.length > 0) {
        const matchingIndex = trace.events.findIndex((event, index) => !matchedHistoricalEvents.has(index) &&
          event.type === 'history-read' && event.subtype === 'history-body' && event.contextHash === session?.contextHash &&
          expectedHistorical.some((payload) => event.id === payload.id && event.revisionToken === payload.revisionToken)
        );
        if (matchingIndex === -1) missingHistoricalEvents.push('history-read');
        else matchedHistoricalEvents.add(matchingIndex);
      } else {
        expect(/--inspect-historical\b/.test(operation.input?.command ?? '') ? 'history-read' : 'load');
      }
    }
    if (found?.has('resource')) expect('resource-read');
    if (['register', 'capture', 'learn'].some((action) => found?.has(action))) expect('capture');
  }
  const missing = [...missingHistoricalEvents, ...expected].flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const [type, count] = entry;
    return Array.from({ length: Math.max(0, count - trace.events.filter((event) => event.type === type).length) }, () => type);
  });
  return missing.length === 0
    ? trace
    : { availability: 'unavailable', reason: `trace lacks native ${missing.join(', ')} event evidence`, events: trace.events };
}

export function traceRuntimeFacts(trace, hostResult = {}) {
  const events = trace.availability === 'available' ? trace.events : [];
  const sum = (selected, field) => {
    if (trace.availability !== 'available') return null;
    if (selected.length === 0) return 0;
    return selected.every((event) => Number.isFinite(event[field]))
      ? selected.reduce((total, event) => total + event[field], 0) : null;
  };
  const previews = events.filter((event) => event.type === 'search' || event.subtype === 'history-preview');
  const bodies = events.filter((event) => event.type === 'load' || event.subtype === 'history-body');
  const resources = events.filter((event) => event.type === 'resource-read');
  const duplicates = bodies.filter((event, index) => bodies.some((prior, priorIndex) =>
    priorIndex < index && prior.id === event.id && prior.revisionToken === event.revisionToken && prior.contextHash === event.contextHash
  ));
  const injectedTokens = Number.isFinite(hostResult.sessionStartMeasurement?.injectedTokens)
    ? hostResult.sessionStartMeasurement.injectedTokens : null;
  const previewTokens = sum(previews, 'responseTokens');
  const loadedBodyTokens = sum(bodies, 'loadedTokens');
  const resourceTokens = sum(resources, 'loadedTokens');
  const totalTokens = [injectedTokens, previewTokens, loadedBodyTokens, resourceTokens].every(Number.isFinite)
    ? injectedTokens + previewTokens + loadedBodyTokens + resourceTokens : null;
  return {
    injectedTokens,
    injectedBytes: Number.isFinite(hostResult.sessionStartMeasurement?.injectedBytes) ? hostResult.sessionStartMeasurement.injectedBytes : null,
    previewTokens,
    previewBytes: sum(previews, 'responseBytes'),
    loadedBodyTokens,
    loadedBodyBytes: sum(bodies, 'loadedBytes'),
    resourceTokens,
    resourceBytes: sum(resources, 'loadedBytes'),
    redundantTokens: sum(duplicates, 'loadedTokens'),
    totalTokens,
    nativePrimaryUsage: hostResult.usage?.primary ?? null,
    nativeFullCycleUsage: hostResult.usage?.fullCycle ?? null,
  };
}

export function attachNativeUsage(runtimeFacts = {}, hostResult = {}) {
  return {
    ...runtimeFacts,
    nativePrimaryUsage: runtimeFacts.nativePrimaryUsage ?? hostResult.usage?.primary ?? null,
    nativeFullCycleUsage: runtimeFacts.nativeFullCycleUsage ?? hostResult.usage?.fullCycle ?? null,
  };
}

export function noKnowledgeRuntimeFacts(hostResult = {}, verifiedAbsence = false) {
  const measurement = hostResult.usage?.sessionStartMeasurement;
  const zero = verifiedAbsence === true;
  return {
    injectedTokens: zero && measurement?.availability === 'none' ? 0 : null,
    injectedBytes: zero && measurement?.availability === 'none' ? 0 : null,
    previewTokens: zero ? 0 : null, previewBytes: zero ? 0 : null,
    loadedBodyTokens: zero ? 0 : null, loadedBodyBytes: zero ? 0 : null,
    resourceTokens: zero ? 0 : null, resourceBytes: zero ? 0 : null,
    redundantTokens: zero ? 0 : null, totalTokens: zero ? 0 : null,
    knowledgeAbsence: zero ? 'verified' : 'unknown',
    nativePrimaryUsage: hostResult.usage?.primary ?? null,
    nativeFullCycleUsage: hostResult.usage?.fullCycle ?? null,
  };
}

/** Retain canonical targets seen during staging or capture so cached native evidence can be rechecked. */
export function knowledgeBypassEvidence(staged = {}, snapshots = []) {
  const knownPaths = new Set((staged.knownPaths ?? []).filter((entry) => typeof entry === 'string' && entry));
  const canonicalRoots = [];
  if (typeof staged.storePath === 'string' && staged.storePath) {
    const knowledgeRoot = path.join(staged.storePath, 'knowledge');
    const historyRoot = path.join(staged.storePath, 'knowledge-history');
    canonicalRoots.push(knowledgeRoot, historyRoot);
    for (const snapshot of snapshots.filter(Boolean)) {
      for (const record of snapshot.records ?? []) {
        if (typeof record?.id !== 'string' || !record.id) continue;
        knownPaths.add(path.join(knowledgeRoot, record.id, record.source ? 'SKILL.md' : 'record.json'));
      }
      for (const entry of snapshot.history ?? []) {
        if (typeof entry?.id === 'string' && entry.id) knownPaths.add(path.join(historyRoot, entry.id));
      }
    }
  }
  return {
    workingDir: staged.projectDir,
    knownPaths: [...knownPaths].sort(),
    canonicalRoots: [...new Set(canonicalRoots)].sort(),
  };
}

/** Recompute derivable evidence from a cached native transcript without invoking a host. */
function isMetadataOnlyShellOperation(operation) {
  if (operation?.name !== 'exec' && operation?.type !== 'command_execution') return false;
  const command = operation.input?.command;
  if (typeof command !== 'string') return false;
  const wrapped = /^\/bin\/(?:zsh|bash)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  const shell = (wrapped?.[2] ?? command).trim();
  if (!shell || /(?:[|;`]|\$\(|[<>]|\b(?:cat|cp|mv|node|python|ruby|perl|tee|dd|sed|awk|grep|rg|head|tail)\b)/.test(shell)) return false;
  return shell.split(/\s*&&\s*/).every((part) => /^\s*(?:ls|stat)\b/.test(part));
}

function isDigestOnlyShellOperation(operation) {
  if (operation?.name !== 'exec' && operation?.type !== 'command_execution') return false;
  const command = operation.input?.command;
  if (typeof command !== 'string') return false;
  const wrapped = /^\/bin\/(?:zsh|bash)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  const shell = (wrapped?.[2] ?? command).trim();
  if (!shell || /[;&`]|\$\(|[<>]/.test(shell)) return false;
  return shell.split('|').every((stage) =>
    /^\s*shasum\s+-a\s+256(?:\s+(?:'[^']*'|"[^"]*"|[^\s'"-][^\s'"]*))*\s*$/.test(stage)
  );
}

function shellCommand(operation) {
  const command = operation?.input?.command;
  if (typeof command !== 'string') return null;
  const wrapped = /^\/bin\/(?:zsh|bash)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped?.[2] ?? command).trim() || null;
}

function isMetadataWithKnowledgeSearch(operation) {
  if (operation?.name !== 'exec' && operation?.type !== 'command_execution') return false;
  const shell = shellCommand(operation);
  if (!shell || /[;|`]|\$\(|[<>]/.test(shell)) return false;
  const stages = shell.split(/\s*&&\s*/);
  if (stages.length < 2) return false;
  const digest = /^\s*shasum\s+-a\s+256(?:\s+(?:'[^']*'|"[^"]*"|[^\s'"-][^\s'"]*))*\s*$/;
  const metadata = /^\s*(?:ls|stat)\b/;
  const knowledgeSearch = /^\s*node\s+\S*knowledge-cli\.mjs\s+search\b/;
  return stages.some((stage) => knowledgeSearch.test(stage)) && stages.every((stage) =>
    metadata.test(stage) || digest.test(stage) || knowledgeSearch.test(stage)
  );
}

function inlineNodeSource(operation) {
  const command = operation?.input?.command;
  if (typeof command !== 'string') return null;
  const match = /\bnode(?:\s+--[\w-]+(?:=\S+)?)?\s+-e\s+(['"])/.exec(command);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = command.lastIndexOf(match[1]);
  return end > start ? command.slice(start, end) : null;
}

function isExternalProposalNodeOperation(operation, roots, workingDir) {
  if (operation?.name !== 'exec' && operation?.name !== 'Bash' && operation?.type !== 'command_execution') return false;
  const source = inlineNodeSource(operation);
  if (!source) return false;
  const bindings = new Map([...source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2/g)]
    .map((match) => [match[1], match[3]]));
  const calls = [...source.matchAll(/\bfs\.(?:readFileSync|writeFileSync|appendFileSync|mkdirSync)\s*\(\s*/g)];
  if (calls.length === 0) return false;
  const targets = [];
  for (const call of calls) {
    const expression = source.slice(call.index + call[0].length);
    let target = null;
    const literal = /^(['"])([^'"]+)\1/.exec(expression);
    const joined = /^path\.join\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(expression);
    const variable = /^([A-Za-z_$][\w$]*)(?:\s*[,)]|$)/.exec(expression);
    if (literal) target = literal[2];
    else if (joined && bindings.has(joined[1])) target = bindings.get(joined[1]);
    else if (variable && bindings.has(variable[1])) target = bindings.get(variable[1]);
    if (!target) return false;
    targets.push(target);
  }
  return targets.every((target) => equivalentPaths(target, workingDir).every((resolved) =>
    !roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
  ));
}

function equivalentPaths(value, workingDir) {
  const resolved = path.resolve(workingDir ?? process.cwd(), value);
  const equivalents = new Set([resolved]);
  if (resolved.startsWith('/private/var/')) equivalents.add(resolved.replace('/private/var/', '/var/'));
  if (resolved.startsWith('/var/')) equivalents.add(resolved.replace('/var/', '/private/var/'));
  return [...equivalents];
}

function normalizedCanonicalRead(operation, evidence, roots) {
  const supplied = operation?.input?.file_path ?? operation?.input?.filePath ?? operation?.input?.path ?? operation?.path;
  if (typeof supplied !== 'string') return operation;
  const direct = detectTraceBypass([operation], evidence);
  if (direct.some((finding) => finding.reason === 'direct-read' && finding.evidence === 'detected')) return operation;
  const canonical = equivalentPaths(supplied, evidence.workingDir).find((target) => roots.some((root) =>
    target === root || target.startsWith(`${root}${path.sep}`)
  ));
  if (!canonical) return null;
  const input = operation.input ?? {};
  const field = ['file_path', 'filePath', 'path'].find((name) => typeof input[name] === 'string');
  return field ? { ...operation, input: { ...input, [field]: canonical } } : { ...operation, path: canonical };
}

function bypassRelevantOperations(toolOperations = [], evidence = {}) {
  const roots = (evidence.canonicalRoots ?? []).flatMap((entry) => equivalentPaths(entry));
  if (roots.length === 0) return toolOperations.filter((operation) =>
    !isMetadataOnlyShellOperation(operation) && !isDigestOnlyShellOperation(operation) && !isMetadataWithKnowledgeSearch(operation)
  );
  return toolOperations.flatMap((operation) => {
    if (isMetadataOnlyShellOperation(operation) || isDigestOnlyShellOperation(operation) ||
      isMetadataWithKnowledgeSearch(operation) || isExternalProposalNodeOperation(operation, roots, evidence.workingDir)) return [];
    if (operation?.name !== 'Read' && operation?.type !== 'Read') return [operation];
    const normalized = normalizedCanonicalRead(operation, evidence, roots);
    return normalized ? [normalized] : [];
  });
}

export function replayCachedRuntime(cell, runtime = {}) {
  const measurement = runtime.sessionStartMeasurement ?? runtime.usage?.sessionStartMeasurement ?? null;
  const staleCrosscheck = runtime.trace?.availability === 'unavailable' && /^trace lacks native /.test(runtime.trace.reason ?? '');
  const canReplayTrace = runtime.traceUnavailable !== true && (runtime.trace?.availability === 'available' || staleCrosscheck) && Array.isArray(runtime.trace?.events);
  const trace = canReplayTrace
    ? traceWithOperationCrosscheck({ availability: 'available', events: runtime.trace.events }, runtime.toolOperations, runtime.toolResults, runtime.sessionSnapshots)
    : runtime.trace;
  const measured = cell.condition === 'baseline'
    ? baselineRuntimeFacts({
      toolOperations: runtime.toolOperations, toolResults: runtime.toolResults,
      sessionStartMeasurement: measurement,
    })
    : cell.condition === 'no-knowledge'
      ? noKnowledgeRuntimeFacts(runtime, runtime.knowledgeAbsence === 'verified')
      : traceRuntimeFacts(trace ?? { availability: 'unavailable', events: [] }, { ...runtime, sessionStartMeasurement: measurement });
  const bypass = runtime.bypassEvidence
    ? detectTraceBypass(bypassRelevantOperations(runtime.toolOperations, runtime.bypassEvidence), runtime.bypassEvidence)
    : runtime.bypass;
  return {
    ...runtime,
    trace,
    bypass,
    sessionStartMeasurement: measurement,
    ...attachNativeUsage(measured, runtime),
  };
}

function assertFrozenInputs(freezeManifest) {
  const fixtures = freezeManifest.fixtureRoot;
  if (freezeManifest.hashes.fixtures !== filesHash(fixtures)) throw new Error('fixture content changed after freeze');
  if (freezeManifest.hashes.oracle !== hash(fs.readFileSync(freezeManifest.oraclePath))) throw new Error('oracle content changed after freeze');
  if (freezeManifest.configurationPath && freezeManifest.hashes.configuration !== hash(fs.readFileSync(freezeManifest.configurationPath))) throw new Error('configuration changed after freeze');
  if (freezeManifest.candidatePath && freezeManifest.hashes.candidate !== filesHash(freezeManifest.candidatePath)) throw new Error('candidate content changed after freeze');
  if (freezeManifest.hashes.nativePipelineInputs && freezeManifest.hashes.nativePipelineInputs !== nativePipelineInputsHash()) throw new Error('native pipeline input changed after freeze');
}

function assertSelectedPromptHashes(freezeManifest, cases) {
  for (const cell of freezeManifest.cells) {
    const fixtureCase = cases.get(cell.caseId);
    if (!fixtureCase) throw new Error(`selected cell fixture is missing: ${cell.id}`);
    const fixtureHash = hash(JSON.stringify({ entry: fixtureCase, artifactPath: cell.artifactPath }));
    if (fixtureHash !== cell.fixtureHash) throw new Error(`selected cell fixture hash changed after freeze: ${cell.id}`);
    const actual = hash(JSON.stringify(promptContract(fixtureCase, cell.artifactPath, cell.host, cell.condition)));
    if (actual !== cell.promptHash) throw new Error(`selected cell prompt hash changed after freeze: ${cell.id}`);
  }
}

/** Run the frozen native evaluation only after the deterministic hash gate succeeds. */
export async function evaluateKnowledge(freezeManifest, options = {}) {
  assertFrozenInputs(freezeManifest);
  if (options.allowNative !== true) throw new Error('native host calls require allowNative after the deterministic freeze gate');
  const fixtureManifest = readJson(path.join(options.fixtureRoot, 'manifest.json'));
  const cases = new Map(fixtureManifest.cases.map((entry) => [entry.id, entry]));
  const rawLogRoot = path.resolve(options.rawLogRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-evaluation-logs-')));
  const invoke = options.invokeHost ?? invokeKnowledgeHost;
  const selectedFreeze = selectFrozenCells(freezeManifest, options.cellIds);
  assertSelectedPromptHashes(selectedFreeze, cases);
  const result = await runCells(selectedFreeze, options.outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-evaluation-results-')), async (cell) => {
    const staged = await stagePreparedKnowledgeCell(cell, cases.get(cell.caseId), {
      repositoryRoot: options.repositoryRoot ?? process.cwd(),
      temporaryRoot: options.temporaryRoot,
      baselineRef: freezeManifest.baseline,
      baselinePluginRoot: options.baselinePluginRoot,
      candidatePluginRoots: candidatePluginRoots(options),
    });
    try {
      const fixtureCase = cases.get(cell.caseId);
      const hostSettings = hostConfiguration(options.configuration, cell.host);
      const relevantIds = (fixtureCase.initialFacts ?? []).map((fact) => fact.id);
      const retainedIds = new Set(relevantIds);
      const compact = (snapshot, previous = null) => {
        const compacted = compactSnapshot(snapshot, [...retainedIds], previous);
        for (const record of [...compacted.records, ...compacted.history, ...compacted.workRecords]) retainedIds.add(record.id);
        return compacted;
      };
      const rawSnapshotBefore = snapshotKnowledgeCell(staged);
      const rawSnapshots = [rawSnapshotBefore];
      const snapshotBefore = compact(rawSnapshotBefore);
      const deliverablePath = cell.artifactPath;
      const preparedPrompts = promptContract(fixtureCase, deliverablePath, cell.host, cell.condition);
      const explicitLearnSessions = preparedPrompts.flatMap((prompt, sessionOrdinal) =>
        /^(?:\/spectre:spectre-learn|spectre-learn)(?:\s|$)/.test(prompt) ? [sessionOrdinal] : []
      );
      const runs = [];
      const sessionSnapshots = [];
      let registrationFault = null;
      let lifecycleEvidence = fixtureCase.id === 'lifecycle-identity' ? { registrationFault: 'not-reached', error: null } : null;
      try {
        for (const [sessionOrdinal, prompt] of preparedPrompts.entries()) {
          const { actorId, contextId } = evaluationActorContext(cell, sessionOrdinal + 1);
          const rawBeforeSession = snapshotKnowledgeCell(staged);
          rawSnapshots.push(rawBeforeSession);
          const beforeSession = compact(rawBeforeSession, rawSnapshotBefore);
          const ghBeforeSession = readGhState(staged);
          const run = await invoke({
          host: cell.host, model: hostSettings.model, effort: hostSettings.effort,
          prompt,
          preparedFixture: staged, rawLogDirectory: path.join(rawLogRoot, cell.id, `session-${sessionOrdinal + 1}`),
          environment: {
            ...staged.environment,
            ...(staged.tracePath ? { SPECTRE_KNOWLEDGE_EVALUATION_TRACE: staged.tracePath } : {}),
            SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID: actorId,
            SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID: contextId,
          },
          limits: limitsForFixture(fixtureCase, options.limits),
          });
          runs.push({ ...run, sessionStartMeasurement: readSessionStartMeasurement(staged) });
          const rawAfterSession = snapshotKnowledgeCell(staged);
          rawSnapshots.push(rawAfterSession);
          sessionSnapshots.push({ before: beforeSession, after: compact(rawAfterSession, rawBeforeSession), gh: { before: ghBeforeSession, after: readGhState(staged) }, contextHash: hash(contextId) });
          if (fixtureCase.id === 'lifecycle-identity' && cell.condition !== 'no-knowledge' && sessionOrdinal === 3 && runs.at(-1)?.status === 'completed') {
            lifecycleEvidence = { ...lifecycleEvidence, ...closeLifecycleDraft(staged) };
            try {
              registrationFault = blockKnowledgeRegistration(staged);
              lifecycleEvidence = { ...lifecycleEvidence, registrationFault: 'armed', error: null };
            } catch (error) {
              lifecycleEvidence = { ...lifecycleEvidence, registrationFault: 'not-armed', error: error instanceof Error ? error.message : String(error) };
            }
          }
        }
      } finally {
        registrationFault?.restore();
      }
      const hostResult = mergeHostRuns(runs);
      const rawSnapshotAfter = snapshotKnowledgeCell(staged);
      rawSnapshots.push(rawSnapshotAfter);
      const snapshotAfter = compact(rawSnapshotAfter, rawSnapshotBefore);
      const bypassEvidence = knowledgeBypassEvidence(staged, rawSnapshots);
      const trace = !staged.tracePath || hostResult.traceUnavailable === true
        ? { availability: 'unavailable', reason: 'host reported trace collection unavailable', events: [] }
        : traceWithOperationCrosscheck(readEvaluationTrace(staged.tracePath), hostResult.toolOperations, hostResult.toolResults, sessionSnapshots);
      const measuredRuntime = cell.condition === 'baseline'
        ? baselineRuntimeFacts({
          toolOperations: hostResult.toolOperations, toolResults: hostResult.toolResults,
          sessionStartMeasurement: hostResult.usage.sessionStartMeasurement,
          workingDir: staged.projectDir, knownKnowledgePaths: bypassEvidence.knownPaths,
        })
        : cell.condition === 'no-knowledge' ? noKnowledgeRuntimeFacts(hostResult, staged.noKnowledge === true && !staged.storeDir && !staged.pluginDir)
          : traceRuntimeFacts(trace, { ...hostResult, sessionStartMeasurement: hostResult.usage.sessionStartMeasurement });
      return {
        ...hostResult,
        deliverablePath,
        deliverable: deliverableEvidence(staged.projectDir, deliverablePath),
        projectEvidence: changedProjectEvidence(staged.projectDir),
        snapshots: { before: snapshotBefore, after: snapshotAfter },
        sessionSnapshots,
        explicitLearnSessions,
        sessionStartMeasurement: hostResult.usage.sessionStartMeasurement,
        artifact: readArtifact(staged.projectDir),
        workflowEvidence: workflowEvidence(staged),
        lifecycleEvidence,
        trace,
        bypassEvidence,
        ...attachNativeUsage(measuredRuntime, hostResult),
        bypass: [
          ...detectTraceBypass(bypassRelevantOperations(hostResult.toolOperations, bypassEvidence), bypassEvidence),
          ...trace.events.filter((event) => event.type === 'bypass'),
        ],
      };
    } finally {
      fs.rmSync(staged.root, { recursive: true, force: true });
    }
  });
  const primaryJudgments = Array.isArray(options.primaryJudgments) ? options.primaryJudgments : [];
  const oracle = freezeManifest.oraclePath ? readJson(freezeManifest.oraclePath) : freezeManifest.oracle ?? {};
  const paired = pairedReport(result.cells, oracle, primaryJudgments);
  const report = {
    ...result, freeze: { hashes: freezeManifest.hashes, baseline: freezeManifest.baseline },
    cohorts: cohortReport(result.cells), paired, primaryJudgments: primaryJudgmentReport(result.cells, primaryJudgments),
    quality: evaluationQualityReport(result.cells, primaryJudgments),
    thresholds: thresholdReport(result.cells, paired, oracle, primaryJudgments),
    repeatInstability: repeatInstabilityReport(result.cells),
  };
  if (options.reportPath) fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [, , command] = process.argv;
  const fixtures = argument(process.argv, '--fixtures');
  const output = argument(process.argv, '--output');
  if (command === 'freeze') {
    const oracle = argument(process.argv, '--oracle');
    if (!fixtures || !oracle || !output) throw new Error(usage());
    process.stdout.write(`${JSON.stringify(freeze(path.resolve(fixtures), path.resolve(oracle), path.resolve(output), {
      configurationPath: argument(process.argv, '--config'), candidatePath: argument(process.argv, '--candidate'),
    }))}\n`);
  } else if (command === 'run') {
    const freezePath = argument(process.argv, '--freeze');
    const configurationPath = argument(process.argv, '--config');
    const baselinePluginRoot = argument(process.argv, '--baseline-plugin');
    const candidatePluginRoot = argument(process.argv, '--candidate-plugin');
    const candidateClaudePluginRoot = argument(process.argv, '--candidate-claude-plugin');
    const candidateCodexPluginRoot = argument(process.argv, '--candidate-codex-plugin');
    const reportPath = argument(process.argv, '--report');
    const judgmentsPath = argument(process.argv, '--primary-judgments');
    if (!freezePath || !fixtures || !configurationPath || !baselinePluginRoot || (!candidatePluginRoot && !(candidateClaudePluginRoot && candidateCodexPluginRoot)) || !output || !reportPath || !process.argv.includes('--allow-native')) throw new Error(usage());
    const configuration = readJson(path.resolve(configurationPath));
    const report = await evaluateKnowledge(readJson(path.resolve(freezePath)), {
      allowNative: true, fixtureRoot: path.resolve(fixtures), outputDir: path.resolve(output), reportPath: path.resolve(reportPath),
      configuration, limits: configuration.limits, baselinePluginRoot: path.resolve(baselinePluginRoot),
      ...(candidatePluginRoot ? { candidatePluginRoot: path.resolve(candidatePluginRoot) } : { candidatePluginRoots: { claude: path.resolve(candidateClaudePluginRoot), codex: path.resolve(candidateCodexPluginRoot) } }),
      rawLogRoot: argument(process.argv, '--raw-logs') ?? undefined, cellIds: argumentsNamed(process.argv, '--cell'),
      primaryJudgments: judgmentsPath ? readJson(path.resolve(judgmentsPath)) : [],
    });
    process.stdout.write(`${JSON.stringify({ status: 'completed', report: path.resolve(reportPath), samples: report.cells.length })}\n`);
  } else {
    throw new Error(usage());
  }
}

export { BASELINE, CONDITIONS, HOSTS, cohortReport, compactSnapshot, freeze, pairedReport, promptContract, thresholdReport };
