#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveKnowledgeProjectDir } from './knowledge/cli-arguments.mjs';
import { runtimeEvaluationTrace } from './knowledge/evaluation-trace.mjs';
import { estimatePayloadTokens } from './knowledge/payload.mjs';
import { inspectKnowledgeRevision, listKnowledgeHistory } from './knowledge/history.mjs';
import { formatKnowledgeLoadHuman, loadKnowledgeById, ROUTINE_LOAD_ALLOWANCE_TOKENS, serializeKnowledgeLoadError } from './knowledge/loader.mjs';
import { migrateLegacyKnowledge } from './knowledge/migration.mjs';
import { previewKnowledgeRegistry } from './knowledge/preview.mjs';
import { registerCanonicalKnowledge, serializeKnowledgeError } from './knowledge/registration.mjs';
import { formatKnowledgeSearchHuman, formatKnowledgeSearchWarningsHuman, searchKnowledge } from './knowledge/search.mjs';
import { applyTagOperationFile, ensureTags, mergeTags, readTagOperationFile, searchTags, serializeTagError } from './knowledge/tags.mjs';
import { resolveWorkIdentity } from './knowledge/work.mjs';

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

function usage() {
  return [
    'Usage:',
    '  knowledge-cli.mjs search [query] [--tag <tag>] [--path <path>] [--work-id <id>] [--run-id <id>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags search [query] --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags ensure --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags merge --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs tags apply --input <json> --project-dir <path> [--json]',
    '  knowledge-cli.mjs load <id> [--work-id <id>] [--run-id <id>] [--allowance-tokens <n>] [--inspect-historical] --project-dir <path> [--json]',
    '  knowledge-cli.mjs history <id> --project-dir <path> [--json]',
    '  knowledge-cli.mjs inspect <id> --revision <token> --project-dir <path> [--json]',
    '  knowledge-cli.mjs work resolve [--work-id <id>] [--source-run-id <id>] [--pull-request-id <id>] --project-dir <path> [--json]',
    '  knowledge-cli.mjs registry [--host claude|codex] --project-dir <path> [--json]',
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
    try {
      const candidate = flags.get('--candidate') ? JSON.parse(flags.get('--candidate')) : undefined;
      writeResult(await resolveWorkIdentity({ projectDir: projectDir(flags), workId: flags.get('--work-id'), sourceRunId: sourceRunId(flags), pullRequestId: flags.get('--pull-request-id'), candidate, lockOptions: lockOptions(flags) }), flags);
    } catch (error) { throw codedError(error?.code || 'WORK_RESOLUTION_FAILED', error instanceof Error ? error.message : String(error)); }
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
    for (const field of ['status', 'expectedRevision', 'currentRevision', 'inspectionCommand']) {
      if (error[field] !== undefined) payload[field] = error[field];
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename)) {
  main().catch((error) => writeCliError(error));
}
