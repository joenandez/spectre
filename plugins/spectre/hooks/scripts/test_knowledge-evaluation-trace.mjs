import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { estimatePayloadTokens } from './knowledge/payload.mjs';
import { refreshKnowledgeIndex, renderKnowledgeRecord, revisionDirectoryName, revisionTokenFor } from './knowledge/records.mjs';
import { createEvaluationTrace, detectTraceBypass } from './knowledge/evaluation-trace.mjs';
import { resolveProjectStore } from './knowledge/store.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_CLI = path.join(SCRIPT_DIR, 'knowledge-cli.mjs');
const TRACE_MODULE_URL = pathToFileURL(path.join(SCRIPT_DIR, 'knowledge', 'evaluation-trace.mjs')).href;

function record(id, content = 'SPECTRE_TRACE_RECORD_BODY') {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: 'Trace fixture',
    summary: 'Trace real public knowledge operations.', tags: ['trace'], applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-09-06T00:00:00.000Z' }, relatedRecordIds: [],
    category: 'pattern', useWhen: 'Use when handling secret query text through the public knowledge CLI.', content,
    evidence: 'A runtime trace fixture.', status: 'active',
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-evaluation-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  const id = 'trace-record';
  const value = record(id);
  const recordPath = path.join(storePath, 'knowledge', id, 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(value, null, 2)}\n`);
  const revisionToken = revisionTokenFor(value);
  const historicalDirectory = path.join(storePath, 'knowledge-history', id, revisionDirectoryName(revisionToken));
  fs.mkdirSync(historicalDirectory, { recursive: true });
  fs.writeFileSync(path.join(historicalDirectory, 'record.json'), `${JSON.stringify(value, null, 2)}\n`);
  refreshKnowledgeIndex(storePath);
  return { root, projectDir, spectreHome, storePath, id, revisionToken };
}

function run(value, tracePath, args, { json = true } = {}) {
  return spawnSync(process.execPath, [KNOWLEDGE_CLI, ...args, '--project-dir', value.projectDir, ...(json ? ['--json'] : [])], {
    cwd: value.projectDir,
    env: { ...process.env, SPECTRE_HOME: value.spectreHome, SPECTRE_KNOWLEDGE_EVALUATION_TRACE: tracePath, SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID: 'trace-context' },
    encoding: 'utf8',
  });
}

function traceEvents(tracePath) {
  const raw = fs.readFileSync(tracePath, 'utf8').trim();
  assert.equal(raw.startsWith('{"schemaVersion":1,"type":'), true, 'trace must append one compact JSONL event per write');
  return raw.split('\n').map((line) => JSON.parse(line));
}

function runTraceWriter(tracePath, contextId) {
  const code = `import { createEvaluationTrace } from ${JSON.stringify(TRACE_MODULE_URL)}; const trace = createEvaluationTrace({ enabled: true, filePath: process.argv[1] }); if (trace.record({ type: 'search', query: process.argv[2], contextId: process.argv[2] }) === null || trace.status().availability !== 'available') process.exit(1);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, tracePath, contextId], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (status) => status === 0 ? resolve() : reject(new Error(`writer exited ${status}`)));
  });
}

test('runtime trace is opt-in and records actual public operations without query or body text', async (t) => {
  const value = await fixture(t);
  const disabled = run(value, '', ['search', 'secret query text']);
  assert.equal(disabled.status, 0, disabled.stderr);

  const tracePath = path.join(value.root, 'trace.jsonl');
  for (const args of [
    ['search', 'secret query text'],
    ['load', value.id],
    ['history', value.id],
    ['inspect', value.id, '--revision', value.revisionToken],
  ]) {
    const result = run(value, tracePath, args);
    assert.equal(result.status, 0, result.stderr);
  }
  const proposal = path.join(value.root, 'proposal', 'trace-created');
  fs.mkdirSync(proposal, { recursive: true });
  fs.writeFileSync(path.join(proposal, 'record.json'), JSON.stringify(record('trace-created', 'SPECTRE_CAPTURE_BODY')));
  const registered = run(value, tracePath, ['register', '--record', proposal]);
  assert.equal(registered.status, 0, registered.stderr);

  const [search, load, historyPreview, historyBody, capture] = traceEvents(tracePath);
  assert.deepEqual([search, load, historyPreview, historyBody, capture].map(({ type }) => type), ['search', 'load', 'history-read', 'history-read', 'capture']);
  assert.match(search.queryHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(search.contextHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(search.results.map(({ id }) => id), [value.id]);
  assert.match(search.results[0].revisionToken, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Number.isSafeInteger(search.responseBytes), true);
  assert.equal(load.id, value.id);
  assert.match(load.revisionToken, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Number.isSafeInteger(load.loadedBytes), true);
  assert.equal(historyPreview.subtype, 'history-preview');
  assert.equal(historyPreview.loadedBytes, undefined);
  assert.equal(historyBody.subtype, 'history-body');
  assert.equal(Number.isSafeInteger(historyBody.loadedBytes), true);
  assert.equal(capture.id, 'trace-created');
  assert.equal(capture.outcome, 'created');
  const serialized = fs.readFileSync(tracePath, 'utf8');
  assert.equal(serialized.includes('secret query text'), false);
  assert.equal(serialized.includes('SPECTRE_TRACE_RECORD_BODY'), false);
  assert.equal(serialized.includes('SPECTRE_CAPTURE_BODY'), false);
});

test('historical inspection traces semantic body sizes for human and JSON output without recording body text', async (t) => {
  const value = await fixture(t);
  const tracePath = path.join(value.root, 'history-body.jsonl');
  const expectedRendered = renderKnowledgeRecord(record(value.id));
  const expectedBytes = Buffer.byteLength(expectedRendered, 'utf8');
  const expectedTokens = estimatePayloadTokens(expectedRendered);

  for (const json of [false, true]) {
    const result = run(value, tracePath, ['inspect', value.id, '--revision', value.revisionToken], { json });
    assert.equal(result.status, 0, result.stderr);
  }

  const events = traceEvents(tracePath);
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.type, 'history-read');
    assert.equal(event.subtype, 'history-body');
    assert.equal(event.loadedBytes, expectedBytes);
    assert.equal(event.loadedTokens, expectedTokens);
  }
  assert.equal(fs.readFileSync(tracePath, 'utf8').includes('SPECTRE_TRACE_RECORD_BODY'), false);
});

test('response measurements match the exact human or JSON wire payload including framing', async (t) => {
  const value = await fixture(t);
  const tracePath = path.join(value.root, 'wire.jsonl');
  const calls = [
    { args: ['search', 'secret query text'], json: false },
    { args: ['search', 'secret query text'], json: true },
    { args: ['load', value.id], json: false },
    { args: ['history', value.id], json: false },
    { args: ['inspect', value.id, '--revision', value.revisionToken], json: true },
  ];
  const outputs = calls.map(({ args, json }) => {
    const result = run(value, tracePath, args, { json });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  const events = traceEvents(tracePath);
  for (const [index, event] of events.entries()) {
    assert.equal(event.responseBytes, Buffer.byteLength(outputs[index], 'utf8'));
    assert.equal(event.responseTokens, estimatePayloadTokens(outputs[index]));
  }
});

test('a valid partial trace keeps prior evidence when append becomes unavailable', async (t) => {
  const value = await fixture(t);
  const tracePath = path.join(value.root, 'partial.jsonl');
  const preservedPath = path.join(value.root, 'partial-preserved.jsonl');
  fs.writeFileSync(tracePath, '{\"schemaVersion\":1,\"type\":\"search\"}\n');
  const trace = createEvaluationTrace({ enabled: true, filePath: tracePath });
  fs.renameSync(tracePath, preservedPath);
  fs.symlinkSync('/dev/full', tracePath);
  trace.record({ type: 'search', query: 'secret' });
  assert.equal(trace.status().availability, 'unavailable');
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), '{\"schemaVersion\":1,\"type\":\"search\"}\n');

  const unavailablePath = path.join(value.root, 'trace-directory');
  fs.mkdirSync(unavailablePath);
  const result = run(value, unavailablePath, ['search', 'secret query text']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /SPECTRE_EVALUATION_TRACE_UNAVAILABLE reason=unreadable/);
});

test('parallel writers preserve every event and corrupt or unwritable artifacts become unavailable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-evaluation-trace-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracePath = path.join(root, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');
  await Promise.all(Array.from({ length: 8 }, (_, index) => runTraceWriter(tracePath, `writer-${index}`)));
  assert.equal(traceEvents(tracePath).length, 8);

  const corruptPath = path.join(root, 'corrupt.jsonl');
  fs.writeFileSync(corruptPath, '{not-json}\n');
  const corrupt = createEvaluationTrace({ enabled: true, filePath: corruptPath });
  corrupt.record({ type: 'search', query: 'secret' });
  assert.equal(corrupt.status().availability, 'unavailable');
  assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{not-json}\n');

  const blockedPath = path.join(root, 'blocked', 'trace.jsonl');
  fs.writeFileSync(path.dirname(blockedPath), 'not a directory');
  const blocked = createEvaluationTrace({ enabled: true, filePath: blockedPath });
  blocked.record({ type: 'search', query: 'secret' });
  assert.equal(blocked.status().availability, 'unavailable');
});

test('bypass detection resolves relative fixture reads and reports opaque knowledge reads as suspected', () => {
  const storePath = '/isolated/store';
  const knownPath = `${storePath}/knowledge/trace-record/record.json`;
  const events = detectTraceBypass([
    { name: 'Read', input: { file_path: 'knowledge/trace-record/record.json' } },
    { name: 'exec', input: { command: 'cd knowledge/trace-record && cat record.json' } },
    { name: 'exec', input: { command: `node -e "require('node:fs').readFileSync('${knownPath}')"` } },
    { name: 'exec', input: { command: `python3 -c "open('${knownPath}')"` } },
    { name: 'exec', input: { command: 'node report.mjs knowledge/trace-record/record.json' } },
    { name: 'Read', input: { file_path: 'knowledge/trace-record/record.json' } },
    { name: 'Read', input: { file_path: 'README.md' } },
    { name: 'Read', input: {} },
  ], { knownPaths: [knownPath], workingDir: storePath });
  assert.deepEqual(events.map(({ reason, evidence }) => ({ reason, evidence })), [
    { reason: 'direct-read', evidence: 'detected' },
    { reason: 'shell-read', evidence: 'detected' },
    { reason: 'shell-read', evidence: 'detected' },
    { reason: 'shell-read', evidence: 'detected' },
    { reason: 'shell-read', evidence: 'suspected' },
    { reason: 'direct-read', evidence: 'detected' },
    { reason: 'direct-read', evidence: 'suspected' },
  ]);
  assert.equal(JSON.stringify(events).includes(knownPath), false);
});

test('bypass detection rejects direct canonical mutations while permitting external proposals and native CLI calls', () => {
  const storePath = '/isolated/store';
  const knownPath = `${storePath}/knowledge/captured-work/record.json`;
  const events = detectTraceBypass([
    { name: 'exec', input: { command: `cp /tmp/proposal.json '${knownPath}'` } },
    { name: 'Write', input: { file_path: knownPath } },
    { name: 'Edit', input: { file_path: knownPath } },
    { name: 'exec', input: { command: `python3 -c \"open('${knownPath}', 'w').write('replacement')\"` } },
    { name: 'Write', input: { file_path: '/tmp/proposal/record.json' } },
    { name: 'exec', input: { command: 'node knowledge-cli.mjs load captured-work' } },
  ], { knownPaths: [knownPath], canonicalRoots: [`${storePath}/knowledge`], workingDir: '/isolated/project' });
  assert.deepEqual(events.map(({ reason, evidence }) => ({ reason, evidence })), [
    { reason: 'shell-write', evidence: 'detected' },
    { reason: 'direct-write', evidence: 'detected' },
    { reason: 'direct-write', evidence: 'detected' },
    { reason: 'shell-write', evidence: 'detected' },
  ]);
});

test('expansion traces distinguish required size from delivered over-allowance loads', async (t) => {
  const value = await fixture(t);
  const large = record('large-trace-record', 'x '.repeat(4_000));
  const recordPath = path.join(value.storePath, 'knowledge', large.id, 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(large, null, 2)}\n`);
  refreshKnowledgeIndex(value.storePath);
  const tracePath = path.join(value.root, 'expansion.jsonl');
  const initial = run(value, tracePath, ['load', large.id]);
  assert.equal(initial.status, 0, initial.stderr);
  const [expansion] = traceEvents(tracePath);
  assert.equal(expansion.type, 'expansion');
  assert.equal(expansion.loadedTokens, 0);
  assert.equal(Number.isSafeInteger(expansion.requiredTokens), true);
  assert.equal(expansion.expansionRequested, true);
  assert.equal(expansion.deliveredOverAllowance, false);

  const loaded = run(value, tracePath, ['load', large.id, '--allowance-tokens', String(expansion.requiredTokens + 1)]);
  assert.equal(loaded.status, 0, loaded.stderr);
  const [, delivered] = traceEvents(tracePath);
  assert.equal(delivered.type, 'load');
  assert.equal(delivered.expanded, true);
  assert.equal(delivered.allowanceTokens, expansion.requiredTokens + 1);
});
