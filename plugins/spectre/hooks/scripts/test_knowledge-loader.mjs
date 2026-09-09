#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADER_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'loader.mjs');
const RECORD_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'records.mjs');
const SEARCH_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'search.mjs');
const STORE_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'store.mjs');
const execFileAsync = promisify(execFile);

function makeTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-loader-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

async function loadModules() {
  const [loader, records, search, store] = await Promise.all([
    import(pathToFileURL(LOADER_MODULE).href),
    import(pathToFileURL(RECORD_MODULE).href),
    import(pathToFileURL(SEARCH_MODULE).href),
    import(pathToFileURL(STORE_MODULE).href),
  ]);
  return { ...loader, ...records, ...search, ...store };
}

function knowledgeRecord(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: 'knowledge',
    title: `Guidance for ${id}`,
    summary: `Use when working with ${id}.`,
    tags: ['auth'],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [],
    category: 'pattern',
    useWhen: `Changing ${id} behavior.`,
    content: 'Exact canonical guidance.',
    evidence: 'Verified by rerunning the failing command.',
    status: 'active',
    ...overrides,
  };
}

function workRecord(id) {
  return {
    schemaVersion: 1,
    id,
    kind: 'work',
    title: `Work account for ${id}`,
    summary: 'Historical account of the imported work.',
    tags: [],
    applicability: { scope: 'work', workId: id },
    provenance: { origin: 'legacy-import', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'Unknown from the imported source.',
      scope: 'Unknown from the imported source.',
      actualChanges: 'Unknown from the imported source.',
      reasons: 'Unknown from the imported source.',
      discoveries: 'Unknown from the imported source.',
      verification: 'Unknown from the imported source.',
      remainingWork: 'Unknown from the imported source.',
      relatedContext: 'Unknown from the imported source.',
      execution: { state: 'unknown' },
      verificationState: { state: 'unknown' },
      pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: ['legacy-run'], pullRequestIds: ['legacy-pr'], candidates: [] },
    },
    importedSource: {
      body: 'Imported historical source.',
      useWhen: 'Reviewing the imported work.',
      cues: ['imported work'],
      category: 'historical',
      status: 'unreviewed',
      version: '1',
    },
  };
}

async function fixture(t) {
  const tmp = makeTmp(t);
  const projectDir = path.join(tmp, 'project');
  const spectreHome = path.join(tmp, 'spectre-home');
  fs.mkdirSync(projectDir, { recursive: true });
  const { resolveProjectStore } = await loadModules();
  const { storePath } = await resolveProjectStore(projectDir, { spectreHome });
  return { tmp, projectDir, spectreHome, storePath };
}

function writeRecord(storePath, id, record = knowledgeRecord(id), options = {}) {
  const recordDirectory = path.join(storePath, 'knowledge', id);
  fs.mkdirSync(recordDirectory, { recursive: true });
  const recordPath = path.join(recordDirectory, options.fileName ?? 'record.json');
  fs.writeFileSync(recordPath, options.raw ?? `${JSON.stringify(record, null, 2)}\n`);
  return { record, recordDirectory, recordPath };
}

function assertLoadError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    for (const leaked of ['content', 'body', 'record', 'rendered']) {
      assert.equal(Object.hasOwn(error || {}, leaked), false, leaked);
    }
    return true;
  };
}

function readActivity(storePath) {
  const activityPath = path.join(storePath, 'activity.json');
  return fs.existsSync(activityPath)
    ? JSON.parse(fs.readFileSync(activityPath, 'utf8'))
    : null;
}

describe('verified exact-ID typed knowledge loader', () => {
  it('requires an explicit expansion for a complete body over the routine allowance', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'expansion-record';
    writeRecord(storePath, id, knowledgeRecord(id, { content: 'verified guidance '.repeat(800) }));
    const { loadKnowledgeById } = await loadModules();

    const result = await loadKnowledgeById({ projectDir, spectreHome, id, allowanceTokens: 10 });

    assert.deepEqual(result, {
      ok: true,
      status: 'expansion-needed',
      id,
      kind: 'knowledge',
      applicability: { scope: 'project' },
      revisionToken: result.revisionToken,
      estimatedTokens: result.estimatedTokens,
      historical: false,
      activation: 'current-guidance',
      allowanceTokens: 10,
      reason: 'complete-record-exceeds-allowance',
    });
    assert.match(result.revisionToken, /^sha256:[a-f0-9]{64}$/);
    assert.ok(result.estimatedTokens > result.allowanceTokens);
    for (const bodyField of ['record', 'rendered', 'resources', 'recordPath', 'recordDirectory']) {
      assert.equal(Object.hasOwn(result, bodyField), false, bodyField);
    }
    assert.equal(readActivity(storePath), null);
  });

  it('keeps unrelated work-scoped guidance historical and out of current activation', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'other-work-guidance';
    writeRecord(storePath, id, knowledgeRecord(id, {
      applicability: { scope: 'work', workId: 'originating-work' },
    }));
    const { loadKnowledgeById } = await loadModules();

    const result = await loadKnowledgeById({
      projectDir,
      spectreHome,
      id,
      workId: 'unrelated-work',
    });

    assert.equal(result.historical, true);
    assert.equal(result.activation, 'historical');
    assert.deepEqual(result.applicability, { scope: 'work', workId: 'originating-work' });
    assert.equal(readActivity(storePath), null);
  });

  it('rejects an on-disk tamper after a search refresh without releasing a body', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'persisted-integrity-record';
    const written = writeRecord(storePath, id);
    const { loadKnowledgeById, refreshKnowledgeIndex } = await loadModules();
    refreshKnowledgeIndex(storePath);
    fs.writeFileSync(written.recordPath, JSON.stringify({
      ...written.record,
      content: 'Tampered after the registered revision was indexed.',
    }, null, 2));

    refreshKnowledgeIndex(storePath);
    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id }),
      assertLoadError('KNOWLEDGE_CHANGED_DURING_READ'),
    );
    assert.equal(readActivity(storePath), null);
  });

  it('recovers an interrupted replacement before verifying a load', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'recoverable-load-record';
    const written = writeRecord(storePath, id);
    fs.renameSync(
      written.recordDirectory,
      `${written.recordDirectory}.previous-${process.pid}-${Date.now()}`,
    );
    const { loadKnowledgeById } = await loadModules();

    const result = await loadKnowledgeById({ projectDir, spectreHome, id });

    assert.equal(result.record.content, 'Exact canonical guidance.');
    assert.equal(fs.existsSync(written.recordDirectory), true);
  });

  it('returns the rendered typed record, safe resources, and one committed load', async (t) => {
    const { projectDir, spectreHome, storePath, tmp } = await fixture(t);
    const id = 'exact-loader-record';
    const written = writeRecord(storePath, id);
    fs.mkdirSync(path.join(written.recordDirectory, 'references', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(written.recordDirectory, 'references', 'guide.md'), 'guide\n');
    fs.writeFileSync(
      path.join(written.recordDirectory, 'references', 'nested', 'raw.bin'),
      Buffer.from([0, 10, 13, 255, 42]),
    );
    const outside = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outside, 'outside\n');
    fs.symlinkSync(outside, path.join(written.recordDirectory, 'references', 'escape.txt'));
    fs.symlinkSync(
      path.join(written.recordDirectory, 'references', 'guide.md'),
      path.join(written.recordDirectory, 'references', 'guide-link.md'),
    );

    const { loadKnowledgeById } = await loadModules();
    const result = await loadKnowledgeById({
      projectDir,
      spectreHome,
      id,
      now: () => Date.parse('2026-07-22T20:00:00.000Z'),
    });

    const { rendered, ...rest } = result;
    assert.deepEqual(rest, {
      ok: true,
      status: 'loaded',
      id,
      kind: 'knowledge',
      applicability: { scope: 'project' },
      revisionToken: rest.revisionToken,
      estimatedTokens: rest.estimatedTokens,
      historical: false,
      activation: 'current-guidance',
      record: written.record,
      recordPath: written.recordPath,
      recordDirectory: written.recordDirectory,
      resources: [
        {
          relativePath: 'references/guide.md',
          absolutePath: path.join(written.recordDirectory, 'references', 'guide.md'),
        },
        {
          relativePath: path.join('references', 'nested', 'raw.bin'),
          absolutePath: path.join(written.recordDirectory, 'references', 'nested', 'raw.bin'),
        },
      ],
      activity: {
        successfulLoads: 1,
        lastLoadedAt: '2026-07-22T20:00:00.000Z',
      },
    });
    assert.match(rendered, /^# Guidance for exact-loader-record\n/);
    assert.match(rendered, /Exact canonical guidance\./);
    assert.match(rendered, /## Use when/);
    assert.equal(rendered.includes('"schemaVersion"'), false);
    assert.equal(result.resources.some(({ absolutePath }) => absolutePath === outside), false);
    assert.equal(
      result.resources.some(({ relativePath }) => relativePath === 'record.json'),
      false,
    );
    assert.equal(readActivity(storePath).records[id].revisions[result.revisionToken].successfulLoads, 1);
  });

  it('loads a work record as labeled historical evidence', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'work-imported-account';
    writeRecord(storePath, id, workRecord(id));
    const { loadKnowledgeById } = await loadModules();

    const result = await loadKnowledgeById({ projectDir, spectreHome, id });

    assert.equal(result.kind, 'work');
    assert.match(result.rendered, /historical evidence/i);
    assert.equal(result.historical, true);
    assert.equal(readActivity(storePath), null);
  });

  it('keeps project and matching-work work records historical evidence', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const projectId = 'project-work-account';
    const matchingId = 'matching-work-account';
    writeRecord(storePath, projectId, {
      ...workRecord(projectId),
      applicability: { scope: 'project' },
    });
    writeRecord(storePath, matchingId, workRecord(matchingId));
    const { loadKnowledgeById } = await loadModules();

    const [projectWork, matchingWork] = await Promise.all([
      loadKnowledgeById({ projectDir, spectreHome, id: projectId }),
      loadKnowledgeById({ projectDir, spectreHome, id: matchingId, workId: matchingId }),
    ]);

    for (const result of [projectWork, matchingWork]) {
      assert.equal(result.historical, true);
      assert.equal(result.activation, 'historical');
      assert.match(result.rendered, /Historical work record: historical evidence only/);
    }
    assert.equal(readActivity(storePath), null);
  });

  it('increments the exact record activity exactly once per invocation', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'repeat-load-record';
    writeRecord(storePath, id, knowledgeRecord(id, { category: 'decision' }));
    const { loadKnowledgeById } = await loadModules();

    await loadKnowledgeById({ projectDir, spectreHome, id });
    const second = await loadKnowledgeById({ projectDir, spectreHome, id });

    assert.equal(second.activity.successfulLoads, 2);
    assert.equal(readActivity(storePath).records[id].revisions[second.revisionToken].successfulLoads, 2);
  });

  it('serializes concurrent exact loads without losing increments', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'concurrent-load-record';
    writeRecord(storePath, id, knowledgeRecord(id, { category: 'gotcha' }));
    const loaderUrl = pathToFileURL(LOADER_MODULE).href;
    const worker = [
      `import { loadKnowledgeById } from ${JSON.stringify(loaderUrl)};`,
      'const [projectDir, spectreHome, id] = process.argv.slice(1);',
      'await loadKnowledgeById({ projectDir, spectreHome, id });',
    ].join('\n');
    const invocations = 12;

    await Promise.all(Array.from({ length: invocations }, () => execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', worker, projectDir, spectreHome, id],
      { timeout: 15_000 },
    )));

    assert.equal(
      Object.values(readActivity(storePath).records[id].revisions)[0].successfulLoads,
      invocations,
    );
  });

  it('distinguishes unknown, inactive, retired, and invalid records without content', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    writeRecord(
      storePath,
      'inactive-record',
      knowledgeRecord('inactive-record', { status: 'archived' }),
    );
    writeRecord(storePath, 'invalid-record', null, {
      raw: JSON.stringify({ schemaVersion: 3, id: 'invalid-record' }),
    });
    writeRecord(storePath, 'retired-skill-record', null, {
      fileName: 'SKILL.md',
      raw: '---\nname: retired-skill-record\n---\nretired\n',
    });
    const { loadKnowledgeById } = await loadModules();

    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id: 'missing-record' }),
      assertLoadError('KNOWLEDGE_NOT_FOUND'),
    );
    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id: 'inactive-record' }),
      assertLoadError('KNOWLEDGE_NOT_ACTIVE'),
    );
    const inspected = await loadKnowledgeById({
      projectDir,
      spectreHome,
      id: 'inactive-record',
      inspectHistorical: true,
    });
    assert.equal(inspected.historical, true);
    assert.equal(inspected.activation, 'historical');
    assert.equal(readActivity(storePath), null);
    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id: 'invalid-record' }),
      assertLoadError('KNOWLEDGE_INVALID'),
    );
    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id: 'retired-skill-record' }),
      (error) => assertLoadError('KNOWLEDGE_INVALID')(error) && /migrat/i.test(error.message),
    );
    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id: '../record-escape' }),
      assertLoadError('KNOWLEDGE_INVALID'),
    );
    assert.equal(readActivity(storePath), null);
  });

  it('returns no body and no activity when the typed package is tampered with', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'tampered-record';
    const written = writeRecord(storePath, id);
    const tampered = JSON.stringify(
      { ...written.record, content: 'Tampered guidance.' },
      null,
      2,
    );
    const { loadKnowledgeById } = await loadModules();

    await assert.rejects(
      loadKnowledgeById({
        projectDir,
        spectreHome,
        id,
        recordReadOptions: { readFile: () => tampered },
      }),
      assertLoadError('KNOWLEDGE_CHANGED_DURING_READ'),
    );
    assert.equal(readActivity(storePath), null);
  });

  it('rejects a queued resource directory swapped to an external symlink before traversal', async (t) => {
    const { projectDir, spectreHome, storePath, tmp } = await fixture(t);
    const id = 'resource-directory-swap';
    const written = writeRecord(storePath, id);
    const referencesDirectory = path.join(written.recordDirectory, 'references');
    fs.mkdirSync(referencesDirectory, { recursive: true });
    fs.writeFileSync(path.join(referencesDirectory, 'inside.md'), 'inside\n');
    const outsideDirectory = path.join(tmp, 'outside-resources');
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, 'secret.md'), 'external secret\n');
    const originalReaddirSync = fs.readdirSync;
    let recordDirectoryReads = 0;
    fs.readdirSync = function injectedDirectorySwap(currentPath, options) {
      const entries = originalReaddirSync.call(this, currentPath, options);
      if (path.resolve(currentPath) === written.recordDirectory) {
        recordDirectoryReads += 1;
        if (recordDirectoryReads === 2) {
          fs.rmSync(referencesDirectory, { recursive: true, force: true });
          fs.symlinkSync(outsideDirectory, referencesDirectory, 'dir');
        }
      }
      return entries;
    };

    const { loadKnowledgeById } = await loadModules();
    try {
      await assert.rejects(
        loadKnowledgeById({ projectDir, spectreHome, id }),
        (error) =>
          ['KNOWLEDGE_CHANGED_DURING_READ', 'KNOWLEDGE_INVALID'].includes(error?.code)
          && assertLoadError(error.code)(error),
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    assert.equal(recordDirectoryReads, 2);
    assert.equal(readActivity(storePath), null);
  });

  it('preserves corrupt activity bytes and returns no body', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'corrupt-activity-record';
    writeRecord(storePath, id);
    const activityPath = path.join(storePath, 'activity.json');
    const corrupt = '{not valid activity}\n';
    fs.writeFileSync(activityPath, corrupt);
    const { loadKnowledgeById } = await loadModules();

    await assert.rejects(
      loadKnowledgeById({ projectDir, spectreHome, id }),
      assertLoadError('KNOWLEDGE_ACTIVITY_CORRUPT'),
    );
    assert.equal(fs.readFileSync(activityPath, 'utf8'), corrupt);
  });

  it('maps store lock timeout without returning content or changing activity', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'locked-load-record';
    writeRecord(storePath, id);
    fs.writeFileSync(path.join(storePath, '.spectre.lock'), JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      operation: 'other-operation',
    }));
    const { loadKnowledgeById } = await loadModules();

    await assert.rejects(
      loadKnowledgeById({
        projectDir,
        spectreHome,
        id,
        lockOptions: { timeoutMs: 5, retryDelayMs: 1, staleMs: 60_000 },
      }),
      assertLoadError('KNOWLEDGE_LOCK_TIMEOUT'),
    );
    assert.equal(readActivity(storePath), null);
  });

  it('maps atomic activity write failure and never releases prepared content', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'write-failure-record';
    writeRecord(storePath, id);
    const { loadKnowledgeById } = await loadModules();
    await loadKnowledgeById({ projectDir, spectreHome, id });

    await assert.rejects(
      loadKnowledgeById({
        projectDir,
        spectreHome,
        id,
        activityWriteOptions: {
          atomicWriteOptions: {
            beforeRename() {
              throw new Error('injected activity rename failure');
            },
          },
        },
      }),
      assertLoadError('KNOWLEDGE_ACTIVITY_WRITE_FAILED'),
    );
    const activity = readActivity(storePath).records[id].revisions;
    assert.equal(Object.values(activity)[0].successfulLoads, 1);
  });

  it('renders the human load output from the typed record', async (t) => {
    const { projectDir, spectreHome, storePath } = await fixture(t);
    const id = 'human-output-record';
    const written = writeRecord(storePath, id);
    fs.writeFileSync(path.join(written.recordDirectory, 'guide.md'), 'guide\n');
    const { formatKnowledgeLoadHuman, loadKnowledgeById } = await loadModules();

    const output = formatKnowledgeLoadHuman(
      await loadKnowledgeById({ projectDir, spectreHome, id }),
    );

    assert.match(output, /^# Guidance for human-output-record\n/);
    assert.match(output, /Exact canonical guidance\./);
    assert.match(output, /SPECTRE_KNOWLEDGE_RESOURCE_LOCATIONS=\{/);
    assert.equal(output.includes('"schemaVersion"'), false);
  });
});
