import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { measurePayload } from './knowledge/payload.mjs';
import { searchKnowledge } from './knowledge/search.mjs';
import { resolveProjectStore } from './knowledge/store.mjs';
import { ensureTags, loadTagCatalog, mergeTags } from './knowledge/tags.mjs';

function noGit() { throw new Error('not a Git project'); }

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const spectreHome = path.join(root, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome, gitRunner: noGit });
  return { projectDir, spectreHome, storePath };
}

function knowledge(id, overrides = {}) {
  return {
    schemaVersion: 1, id, kind: 'knowledge', title: id, summary: 'Maintained guidance.', tags: [],
    applicability: { scope: 'project' }, provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [], category: 'pattern', useWhen: 'Use for routine changes.',
    content: 'Verified current guidance.', evidence: 'A test verified this.', status: 'active', ...overrides,
  };
}

function importedWork(id, overrides = {}) {
  const { importedSource = {}, work = {}, ...record } = overrides;
  return {
    schemaVersion: 1, id, kind: 'work', title: id, summary: 'Historical imported source.', tags: [],
    applicability: { scope: 'work', workId: id }, provenance: { origin: 'legacy-import', capturedAt: '2026-07-19T00:00:00.000Z' }, relatedRecordIds: [],
    work: { requestedOutcome: 'unknown — imported record', scope: 'unknown — imported record', actualChanges: 'unknown — imported record', reasons: 'unknown — imported record', discoveries: 'unknown — imported record', verification: 'unknown — imported record', remainingWork: 'unknown — imported record', relatedContext: 'unknown — imported record', execution: { state: 'unknown' }, verificationState: { state: 'unknown' }, pullRequest: { state: 'unknown' }, associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] }, ...work },
    importedSource: { body: 'Historical source body.', useWhen: 'Use for historical context.', cues: ['legacy'], category: 'pattern', status: 'active', version: '1', ...importedSource },
    ...record,
  };
}

function write(storePath, record) {
  const target = path.join(storePath, 'knowledge', record.id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'record.json'), `${JSON.stringify(record)}\n`);
}

function options(value, extra = {}) {
  return { projectDir: value.projectDir, spectreHome: value.spectreHome, gitRunner: noGit, ...extra };
}

test('unique imported constraints outrank weak maintained matches and untagged cross-cutting work stays discoverable', async (t) => {
  const value = await fixture(t);
  write(value.storePath, knowledge('weak-knowledge', { useWhen: 'Use for auth work.' }));
  write(value.storePath, importedWork('legacy-constraint', {
    importedSource: { body: 'The payment gateway requires idempotency keys before retry.', useWhen: 'Changing gateway retry behavior.', cues: ['gateway idempotency'], category: 'gotcha', status: 'active', version: '4' },
  }));
  const found = await searchKnowledge(options(value, { query: 'gateway idempotency retry', paths: ['payments/gateway.js'] }));
  assert.deepEqual(found.results.map(({ id }) => id), ['legacy-constraint']);
  assert.equal(found.results[0].activation, 'imported-history');
});

test('ranks applicability metadata and tag descriptions above generic imported-body overlap', async (t) => {
  const value = await fixture(t);
  await ensureTags({ ...options(value), tags: [
    { id: 'daemon-architecture', description: 'Daemon reconnect and service startup behavior.' },
  ] });
  write(value.storePath, knowledge('daemon-reconnect-guidance', {
    tags: ['daemon-architecture'], useWhen: 'Repair daemon reconnect behavior after startup.',
  }));
  write(value.storePath, importedWork('generic-daemon-history', {
    importedSource: {
      body: 'Daemon daemon daemon startup startup startup architecture architecture.',
      useWhen: 'Review prior deployment work.', cues: ['legacy'], category: 'pattern', status: 'active', version: '1',
    },
  }));

  const found = await searchKnowledge(options(value, { query: 'daemon reconnect' }));

  assert.equal(found.results[0].id, 'daemon-reconnect-guidance');
  assert.deepEqual(found.results[0].tags, ['daemon-architecture']);
  assert.match(found.results[0].matchedSignals.join(' '), /use-when:daemon|tag:reconnect/);
  assert.equal(found.results[1].id, 'generic-daemon-history');
  assert.match(found.results[1].matchedSignals.join(' '), /body:daemon/);
});

test('exact tag filters mixed records while tag descriptions contribute natural-language relevance', async (t) => {
  const value = await fixture(t);
  await ensureTags({ ...options(value), tags: [
    { id: 'daemon-architecture', description: 'Daemon reconnect and service startup behavior.' },
  ] });
  write(value.storePath, knowledge('tagged-daemon-guidance', { tags: ['daemon-architecture'] }));
  write(value.storePath, importedWork('tagged-daemon-history', { tags: ['daemon-architecture'] }));
  write(value.storePath, knowledge('untagged-daemon-guidance', { useWhen: 'Use for daemon reconnect behavior.' }));

  const natural = await searchKnowledge(options(value, { query: 'service reconnect' }));
  const exact = await searchKnowledge(options(value, { query: '', tags: ['daemon-architecture'] }));

  assert.equal(natural.results[0].id, 'tagged-daemon-guidance');
  assert.match(natural.results[0].matchedSignals.join(' '), /tag:reconnect/);
  assert.deepEqual(exact.results.map(({ id }) => id), ['tagged-daemon-guidance', 'tagged-daemon-history']);
  assert.ok(exact.results.some(({ kind, historical }) => kind === 'work' && historical));
});

test('filters guidance by explicit work/run context while keeping inactive and work records inspectable', async (t) => {
  const value = await fixture(t);
  write(value.storePath, knowledge('project-guidance', { useWhen: 'Use for deployment changes.' }));
  write(value.storePath, knowledge('work-guidance', { applicability: { scope: 'work', workId: 'work-a', runIds: ['run-a'] }, useWhen: 'Use for work-only deployment changes.' }));
  write(value.storePath, knowledge('superseded-guidance', { status: 'superseded', useWhen: 'Use for deployment changes.' }));
  write(value.storePath, importedWork('historical-work', { importedSource: { body: 'deployment history', useWhen: 'Use for deployment changes.', cues: ['deployment'], category: 'pattern', status: 'archived', version: '1' } }));
  const normal = await searchKnowledge(options(value, { query: 'deployment changes' }));
  assert.equal(normal.results[0].activation, 'current-guidance');
  const inactive = await searchKnowledge(options(value, { query: 'superseded guidance' }));
  assert.equal(inactive.results[0].activation, 'inactive-history');
  const historical = await searchKnowledge(options(value, { query: 'deployment history' }));
  assert.equal(historical.results[0].activation, 'imported-history');
  const contextual = await searchKnowledge(options(value, { query: 'work-only deployment', workId: 'work-a' }));
  assert.equal(contextual.results[0].activation, 'current-guidance');
});

test('matches a record tag retained through a merge when searching the surviving canonical tag', async (t) => {
  const value = await fixture(t);
  await ensureTags({ ...options(value), tags: [
    { id: 'auth-tokens', description: 'Token refresh and session authentication.' },
    { id: 'authentication', description: 'Login identity.' },
  ] });
  write(value.storePath, knowledge('retired-tag-record', {
    tags: ['authentication'], useWhen: 'Use for retained authentication constraints.',
  }));
  const before = await loadTagCatalog(options(value));
  await mergeTags({ ...options(value), from: ['authentication'], into: 'auth-tokens', expectedRevision: before.revision });

  const found = await searchKnowledge(options(value, { query: 'auth tokens' }));
  assert.deepEqual(found.results.map(({ id }) => id), ['retired-tag-record']);

  write(value.storePath, knowledge('untagged-auth-record', {
    useWhen: 'Use for untagged auth tokens constraints.',
  }));
  const filtered = await searchKnowledge(options(value, {
    query: 'auth tokens', tags: ['auth-tokens'],
  }));
  assert.deepEqual(filtered.results.map(({ id }) => id), ['retired-tag-record']);
  await assert.rejects(
    () => searchKnowledge(options(value, { query: 'auth tokens', tags: ['unknown-tag'] })),
    (error) => error.code === 'SEARCH_TAG_UNKNOWN',
  );
});

test('bounds empty pages, supports deterministic cursor pagination, and rejects a stale index', async (t) => {
  const value = await fixture(t);
  await ensureTags({ ...options(value), tags: [
    { id: 'first-page', description: 'First page records.' },
    { id: 'other-page', description: 'Other page records.' },
  ] });
  for (let index = 0; index < 10; index += 1) {
    write(value.storePath, knowledge(`record-${String(index).padStart(2, '0')}`, {
      tags: index < 6 ? ['first-page'] : ['other-page'],
    }));
  }
  const first = await searchKnowledge(options(value, { query: '' }));
  assert.ok(first.results.length <= 5 && first.results.length > 0);
  assert.ok(first.cursor);
  assert.ok(measurePayload('codex', JSON.stringify(first)).measured <= 500);
  const all = [...first.results];
  let next = first.cursor;
  while (next) {
    const page = await searchKnowledge(options(value, { query: '', cursor: next }));
    all.push(...page.results);
    next = page.cursor;
  }
  assert.deepEqual(all.map(({ id }) => id), Array.from({ length: 10 }, (_, index) => `record-${String(index).padStart(2, '0')}`));
  const filtered = await searchKnowledge(options(value, { query: '', tags: ['first-page'] }));
  assert.ok(filtered.cursor);
  await assert.rejects(
    () => searchKnowledge(options(value, { query: '', tags: ['other-page'], cursor: filtered.cursor })),
    (error) => error.code === 'SEARCH_CURSOR_STALE',
  );
  write(value.storePath, knowledge('record-new'));
  await assert.rejects(() => searchKnowledge(options(value, { query: '', cursor: first.cursor })), (error) => error.code === 'SEARCH_CURSOR_STALE');
});

test('keeps the five-entry and token caps stable at 10, 100, 1000, and 10000 indexed records', async (t) => {
  const value = await fixture(t);
  for (let index = 0; index < 10_000; index += 1) {
    write(value.storePath, knowledge(`scale-${String(index).padStart(5, '0')}`, { useWhen: index === 9_999 ? 'Use for critical scale retrieval.' : 'Use for routine scale retrieval.' }));
  }
  for (const count of [10, 100, 1_000, 10_000]) {
    const result = await searchKnowledge(options(value, { query: 'critical scale retrieval', limit: 5 }));
    assert.ok(result.results.length <= 5, `${count} corpus`);
    assert.ok(measurePayload('codex', JSON.stringify(result)).measured <= 500, `${count} corpus`);
    assert.equal(result.results[0].id, 'scale-09999');
  }
});

test('retains malformed-neighbor diagnostics and succeeds on an empty store', async (t) => {
  const value = await fixture(t);
  write(value.storePath, knowledge('valid', { useWhen: 'Use for queue retries.' }));
  const broken = path.join(value.storePath, 'knowledge', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'record.json'), '{ nope');
  const result = await searchKnowledge(options(value, { query: 'queue retries' }));
  assert.deepEqual(result.results.map(({ id }) => id), ['valid']);
  assert.equal(result.warnings.length, 1);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-empty-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  const empty = await searchKnowledge({ projectDir: emptyRoot, spectreHome: path.join(emptyRoot, 'home'), gitRunner: noGit, query: 'anything' });
  assert.deepEqual(empty, { results: [], warnings: [], cursor: null });
});

test('keeps a decision-bearing minimum preview when the first candidate is oversized', async (t) => {
  const value = await fixture(t);
  write(value.storePath, knowledge('a-oversized-first', {
    useWhen: `Use for oversized pagination ${'metadata '.repeat(3_000)}`,
  }));
  write(value.storePath, knowledge('later-small-result', {
    useWhen: 'Use for the later pagination result.',
  }));

  const first = await searchKnowledge(options(value, { query: '' }));

  assert.equal(first.results[0].id, 'a-oversized-first');
  assert.equal(first.results[0].kind, 'knowledge');
  assert.equal(first.results[0].activation, 'current-guidance');
  assert.deepEqual(first.results[0].tags, []);
  assert.equal(typeof first.results[0].useWhen, 'string');
  assert.ok(first.results[0].useWhen.length < 500);
  assert.ok(first.results[0].estimatedLoadTokens > 0);
  assert.ok(first.results[0].matchedSignals.length > 0);
  assert.ok(measurePayload('codex', JSON.stringify(first)).measured <= 500);
  if (first.cursor) {
    const next = await searchKnowledge(options(value, { query: '', cursor: first.cursor }));
    assert.notDeepEqual(
      { results: next.results, cursor: next.cursor },
      { results: first.results, cursor: first.cursor },
      'a continuation cursor must advance or terminate rather than repeat the same empty page',
    );
  }
});

test('returns fitting results even when malformed-record warnings are too large for the response budget', async (t) => {
  const value = await fixture(t);
  write(value.storePath, knowledge('valid-after-warnings', {
    useWhen: 'Use for warning-tolerant result pagination.',
  }));
  for (let index = 0; index < 40; index += 1) {
    const broken = path.join(value.storePath, 'knowledge', `broken-warning-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'record.json'), `{ malformed ${'diagnostic '.repeat(30)}`);
  }

  const page = await searchKnowledge(options(value, { query: 'warning tolerant result pagination' }));

  assert.deepEqual(page.results.map(({ id }) => id), ['valid-after-warnings']);
  assert.ok(page.warnings.length >= 40);
});
