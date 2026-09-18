#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveKnowledgeProjectDir } from './knowledge/cli-arguments.mjs';
import { runtimeEvaluationTrace } from './knowledge/evaluation-trace.mjs';
import { estimatePayloadTokens } from './knowledge/payload.mjs';
import { inspectKnowledgeRevision, listKnowledgeHistory } from './knowledge/history.mjs';
import { captureCanonicalKnowledge, serializeCaptureError } from './knowledge/capture.mjs';
import { captureWithInputTransport } from './knowledge/capture-input.mjs';
import { formatKnowledgeLoadHuman, loadKnowledgeById, ROUTINE_LOAD_ALLOWANCE_TOKENS, serializeKnowledgeLoadError } from './knowledge/loader.mjs';
import { migrateLegacyKnowledge } from './knowledge/migration.mjs';
import { previewKnowledgeRegistry } from './knowledge/preview.mjs';
import { registerCanonicalKnowledge, serializeKnowledgeError } from './knowledge/registration.mjs';
import { formatKnowledgeSearchHuman, formatKnowledgeSearchWarningsHuman, searchKnowledge } from './knowledge/search.mjs';
import { applyTagOperationFile, ensureTags, mergeTags, readTagOperationFile, searchTags, serializeTagError } from './knowledge/tags.mjs';
import { associateWorkDelivery, foldWorkIdentities, listDeliveryMembership, resolveWorkIdentity } from './knowledge/work.mjs';

const __filename = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const next = argv[index + 1];
    const parsed = !next || next.startsWith('--') ? true : next;
    if (parsed !== true) index += 1;
    values.set(value, [...(values.get(value) || []), parsed]);
  }
  return {
    positional,
    flags: {
      get(name) { return values.get(name)?.at(-1); },
      getAll(name) { return [...(values.get(name) || [])]; },
      has(name) { return values.has(name); },
    },
  };
}

const RESOLVE_BRANCH_GUIDANCE = 'Resolve by --work-id, --source-run-id, --pull-request-id, or --candidate, or ask work membership for the plural branch and candidate answer.';
const FOLD_BRANCH_GUIDANCE = 'A branch never constrained a fold. Name every id with --canonical-work-id and --old-work-id.';
const CAPTURE_BRANCH_PR_STATE_GUIDANCE = 'capture no longer reads --branch-pr-state. Set the PR state in the capture input under "pullRequest". --branch is still recorded as provenance.sourceBranch.';

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function lockOptions(flags) {
  const timeout = flags.get('--lock-timeout-ms');
  return timeout ? { timeoutMs: Number(timeout), retryDelayMs: 5 } : undefined;
}

function projectDir(flags) {
  return resolveKnowledgeProjectDir(flags.get('--project-dir') || flags.get('--project-root'));
}

function numericFlag(flags, name) {
  const value = flags.get(name);
  return value === undefined ? undefined : Number(value);
}

function jsonFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined || value === true) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw codedError('WORK_DELIVERY_INPUT_INVALID', `${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A branch is no longer a work identity key, so a silent false negative or no-op must not pass. */
function assertRetiredWorkBranchFlag(flags, command, guidance) {
  if (!flags.has('--branch')) return;
  throw codedError('WORK_BRANCH_FLAG_RETIRED', `${command} no longer reads --branch. ${guidance}`);
}

function usage() {
  return [
    'Usage:',
    '  knowledge-cli.mjs search [query] [--tag <tag>] [--path <path>] [--work-id <id>] [--run-id <id>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags search [query] --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags ensure --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags merge --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags apply --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs load <id> [--work-id <id>] [--run-id <id>] [--allowance-tokens <n>] [--inspect-historical] --project-dir <path> [--json]  (work and inactive records require --inspect-historical)',
    '  knowledge-cli.mjs history <id> --project-dir <path> [--json]',
    '  knowledge-cli.mjs inspect <id> --revision <token> --project-dir <path> [--json]',
    '  knowledge-cli.mjs work resolve [--work-id <id>] [--source-run-id <id>] [--pull-request-id <id>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs work membership --branch <exact-branch> --candidate <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs work associate --work-id <id> [--work-id <id>] --pull-request-id <id> --candidate <json> [--pull-request <json>] [--expected-revisions <json>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs work fold --canonical-work-id <id> --old-work-id <id> [--old-work-id <id>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs registry [--host claude|codex] --project-dir <path> [--json]',
    '  knowledge-cli.mjs capture --kind knowledge|work --input <json|-> [--record-id <id>] [--work-id <id>] [--source-run-id <id>|--run-id <id>] [--pull-request-id <id>] [--candidate <json>] [--branch <exact-branch>] [--expected-revision <token>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs register --record <path> [--expected-revision <token>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs migrate --project-dir <path> [--json]',
    '',
  ].join('\n');
}

function renderResult(result, flags, human) {
  return flags.has('--json') ? `${JSON.stringify(result)}\n` : human ? human(result) : `${JSON.stringify(result)}\n`;
}

function writeResult(result, flags, human) {
  process.stdout.write(renderResult(result, flags, human));
}

function responseMetrics(output) {
  return { responseBytes: Buffer.byteLength(output, 'utf8'), responseTokens: estimatePayloadTokens(output) };
}

function recordTrace(trace, event) {
  trace.record(event);
  const status = trace.status();
  if (status.availability === 'unavailable') {
    process.stderr.write(`SPECTRE_EVALUATION_TRACE_UNAVAILABLE reason=${status.reason || 'unknown'}\n`);
  }
}

async function runTagOperation(operation, flags) {
  const { operation: inputOperation, ...request } = readTagOperationFile(flags.get('--input'));
  if (inputOperation !== operation) {
    throw codedError('TAG_INPUT_INVALID', `Input operation ${inputOperation} cannot run as tags ${operation}.`);
  }
  const options = { projectDir: projectDir(flags), ...request, lockOptions: lockOptions(flags) };
  return operation === 'ensure' ? ensureTags(options) : mergeTags(options);
}

function sourceRunId(flags) {
  const sourceRunId = flags.get('--source-run-id');
  const runId = flags.get('--run-id');
  if (sourceRunId !== undefined && runId !== undefined && sourceRunId !== runId) {
    throw codedError('WORK_SOURCE_RUN_CONFLICT', '--source-run-id and --run-id must match when both are supplied.');
  }
  return sourceRunId ?? runId;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command, subcommand] = positional;
  const trace = runtimeEvaluationTrace();
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'search') {
    const query = positional.slice(1).join(' ');
    try {
      const result = await searchKnowledge({
        projectDir: projectDir(flags), query, tags: flags.getAll('--tag'), paths: flags.getAll('--path'),
        workId: flags.get('--work-id'), runId: flags.get('--run-id'), kind: flags.get('--kind'),
        limit: numericFlag(flags, '--limit'), cursor: flags.get('--cursor'),
      });
      const output = { ok: true, query, ...result };
      const selectedOutput = flags.has('--json')
        ? `${JSON.stringify(output)}\n`
        : formatKnowledgeSearchHuman(result, query);
      recordTrace(trace, { type: 'search', query, results: result.results, ...responseMetrics(selectedOutput) });
      process.stdout.write(selectedOutput);
      if (!flags.has('--json')) process.stderr.write(formatKnowledgeSearchWarningsHuman(result.warnings));
    } catch (error) { throw codedError('KNOWLEDGE_SEARCH_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'tags') {
    try {
      const result = subcommand === 'search'
        ? await searchTags({ projectDir: projectDir(flags), query: positional.slice(2).join(' '), limit: numericFlag(flags, '--limit'), cursor: flags.get('--cursor') })
        : subcommand === 'ensure' || subcommand === 'merge'
          ? await runTagOperation(subcommand, flags)
          : subcommand === 'apply'
            ? await applyTagOperationFile({ projectDir: projectDir(flags), inputPath: flags.get('--input'), lockOptions: lockOptions(flags) })
          : null;
      if (!result) throw codedError('UNKNOWN_TAG_COMMAND', `Unknown tags command "${subcommand || ''}".`);
      writeResult(result, flags);
    } catch (error) { const payload = serializeTagError(error); throw codedError(payload.code, payload.message, payload); }
    return;
  }
  if (command === 'load') {
    try {
      const allowanceTokens = numericFlag(flags, '--allowance-tokens') ?? ROUTINE_LOAD_ALLOWANCE_TOKENS;
      const result = await loadKnowledgeById({
        projectDir: projectDir(flags), id: subcommand, lockOptions: lockOptions(flags),
        workId: flags.get('--work-id'), runId: flags.get('--run-id'), allowanceTokens,
        inspectHistorical: flags.has('--inspect-historical'),
      });
      const selectedOutput = renderResult(result, flags, formatKnowledgeLoadHuman);
      recordTrace(trace, result.status === 'expansion-needed'
        ? { type: 'expansion', id: result.id, revisionToken: result.revisionToken, requiredTokens: result.estimatedTokens, loadedTokens: 0, allowanceTokens, expansionRequested: true, deliveredOverAllowance: false, ...responseMetrics(selectedOutput) }
        : { type: result.historical ? 'history-read' : 'load', subtype: result.historical ? 'history-body' : undefined, id: result.id, revisionToken: result.revisionToken, loadedBytes: Buffer.byteLength(result.rendered, 'utf8'), loadedTokens: result.estimatedTokens, allowanceTokens, expanded: allowanceTokens > ROUTINE_LOAD_ALLOWANCE_TOKENS, ...responseMetrics(selectedOutput) });
      process.stdout.write(selectedOutput);
    } catch (error) { const payload = serializeKnowledgeLoadError(error); throw codedError(payload.code, payload.message, payload); }
    return;
  }
  if (command === 'history' || command === 'inspect') {
    try {
      const result = command === 'history'
        ? await listKnowledgeHistory({ projectDir: projectDir(flags), id: subcommand, cursor: flags.get('--cursor'), lockOptions: lockOptions(flags) })
        : await inspectKnowledgeRevision({ projectDir: projectDir(flags), id: subcommand, revisionToken: flags.get('--revision'), lockOptions: lockOptions(flags) });
      const selectedOutput = renderResult(result, flags);
      recordTrace(trace, command === 'history'
        ? { type: 'history-read', subtype: 'history-preview', id: result.id, results: result.entries, ...responseMetrics(selectedOutput) }
        : { type: 'history-read', subtype: 'history-body', id: result.id, revisionToken: result.revisionToken, loadedBytes: Buffer.byteLength(result.rendered, 'utf8'), loadedTokens: estimatePayloadTokens(result.rendered), ...responseMetrics(selectedOutput) });
      process.stdout.write(selectedOutput);
    } catch (error) { throw codedError(error?.code || 'KNOWLEDGE_HISTORY_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'work' && subcommand === 'resolve') {
    assertRetiredWorkBranchFlag(flags, 'work resolve', RESOLVE_BRANCH_GUIDANCE);
    try {
      const candidate = flags.get('--candidate') ? JSON.parse(flags.get('--candidate')) : undefined;
      const result = await resolveWorkIdentity({ projectDir: projectDir(flags), workId: flags.get('--work-id'), sourceRunId: sourceRunId(flags), pullRequestId: flags.get('--pull-request-id'), candidate, lockOptions: lockOptions(flags) });
      writeResult(result.status === 'unresolved' ? {
        ...result,
        nextAction: {
          template: 'skills/spectre-work-record/references/work-capture-input.json',
          command: 'knowledge-cli.mjs capture --kind work --input - --source-run-id <exact-run-id> --project-dir <project-dir> --json',
        },
      } : result, flags);
    } catch (error) { throw codedError(error?.code || 'WORK_RESOLUTION_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'work' && subcommand === 'fold') {
    assertRetiredWorkBranchFlag(flags, 'work fold', FOLD_BRANCH_GUIDANCE);
    try {
      writeResult(await foldWorkIdentities({
        projectDir: projectDir(flags), canonicalWorkId: flags.get('--canonical-work-id'),
        oldWorkIds: flags.getAll('--old-work-id'), lockOptions: lockOptions(flags),
      }), flags);
    } catch (error) { throw codedError(error?.code || 'WORK_FOLD_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'work' && subcommand === 'membership') {
    try {
      writeResult(await listDeliveryMembership({
        projectDir: projectDir(flags), branch: flags.get('--branch'),
        candidate: jsonFlag(flags, '--candidate'), lockOptions: lockOptions(flags),
      }), flags);
    } catch (error) { throw codedError(error?.code || 'WORK_MEMBERSHIP_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'work' && subcommand === 'associate') {
    try {
      // A partial association is reported, never thrown, so `retry` reaches the operator whole.
      const result = await associateWorkDelivery({
        projectDir: projectDir(flags), workIds: flags.getAll('--work-id'),
        pullRequestId: flags.get('--pull-request-id'), candidate: jsonFlag(flags, '--candidate'),
        pullRequest: jsonFlag(flags, '--pull-request'), expectedRevisions: jsonFlag(flags, '--expected-revisions'),
        lockOptions: lockOptions(flags),
      });
      writeResult(result, flags);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { throw codedError(error?.code || 'WORK_ASSOCIATION_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'registry') {
    try {
      const result = await previewKnowledgeRegistry({ host: flags.get('--host') || 'claude', projectDir: projectDir(flags) });
      if (flags.has('--json')) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      else process.stdout.write(result.injected ? `${result.payload.hookSpecificOutput.additionalContext}\n` : 'No SessionStart knowledge payload would be injected.\n');
    } catch (error) { throw codedError('KNOWLEDGE_REGISTRY_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (command === 'capture') {
    if (flags.has('--branch-pr-state')) throw codedError('CAPTURE_BRANCH_PR_STATE_RETIRED', CAPTURE_BRANCH_PR_STATE_GUIDANCE);
    try {
      const candidate = flags.get('--candidate') ? JSON.parse(flags.get('--candidate')) : undefined;
      const result = await captureWithInputTransport({
        projectDir: projectDir(flags), kind: flags.get('--kind'), inputPath: flags.get('--input'),
        recordId: flags.get('--record-id'), workId: flags.get('--work-id'), sourceRunId: sourceRunId(flags),
        pullRequestId: flags.get('--pull-request-id'), candidate, branch: flags.get('--branch'), expectedRevision: flags.get('--expected-revision'),
        lockOptions: lockOptions(flags),
      }, captureCanonicalKnowledge);
      recordTrace(trace, { type: 'capture', id: result.id, revisionToken: result.revisionToken, outcome: result.status, kind: result.kind,
        ...(result.workLifecycle ? { workLifecycle: result.workLifecycle } : {}) });
      writeResult(result, flags, (value) => `Captured ${value.kind} record ${value.id} (${value.status})\n`);
    } catch (error) { recordTrace(trace, { type: 'capture', outcome: 'failed' }); const payload = serializeCaptureError(error); throw codedError(payload.code, payload.message, payload); }
    return;
  }
  if (command === 'register') {
    try {
      const result = await registerCanonicalKnowledge({ projectDir: projectDir(flags), recordPath: flags.get('--record'), expectedRevision: flags.get('--expected-revision'), lockOptions: lockOptions(flags) });
      recordTrace(trace, { type: 'capture', id: result.id, revisionToken: result.revisionToken, outcome: result.status });
      writeResult(result, flags, (value) => `Registered knowledge record ${value.id}\n`);
    } catch (error) { recordTrace(trace, { type: 'capture', outcome: 'failed' }); const payload = serializeKnowledgeError(error); throw codedError(payload.code, payload.message, payload); }
    return;
  }
  if (command === 'migrate') {
    try {
      const report = await migrateLegacyKnowledge({ projectDir: projectDir(flags), lockOptions: lockOptions(flags) });
      writeResult({ ok: true, ...report }, flags, (value) => `Migrated ${value.entries.length} knowledge entries\n`);
    } catch (error) { throw codedError(error?.code || 'KNOWLEDGE_MIGRATION_FAILED', error instanceof Error ? error.message : String(error)); }
    return;
  }
  throw codedError('UNKNOWN_KNOWLEDGE_COMMAND', `Unknown knowledge command "${command}".`);
}

export function writeCliError(error, argv = process.argv.slice(2)) {
  const message = error instanceof Error ? error.message : String(error);
  if (argv.includes('--json') && error?.code) {
    const payload = { ok: false, code: error.code, message };
    for (const field of ['status', 'expectedRevision', 'currentRevision', 'inspectionCommand', 'tags', 'tagOutcomes', 'workId', 'association', 'recoveryInput']) {
      if (error[field] !== undefined) payload[field] = error[field];
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  else process.stderr.write(`${message}${error?.recoveryInput ? `\nRecovery input: ${error.recoveryInput}` : ''}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main().catch((error) => writeCliError(error));
}
