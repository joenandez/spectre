#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVITY_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'activity.mjs');
const REVISION_A = `sha256:${'a'.repeat(64)}`;
const REVISION_B = `sha256:${'b'.repeat(64)}`;

function makeTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-activity-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

async function loadActivityModule() {
  return import(pathToFileURL(ACTIVITY_MODULE).href);
}

describe('knowledge activity schema', () => {
  it('uses revision-keyed zero history without creating an activity file', async (t) => {
    const storePath = makeTmp(t);
    const { readKnowledgeActivity } = await loadActivityModule();

    assert.deepEqual(readKnowledgeActivity(storePath), {
      schemaVersion: 2,
      records: {},
      search: { matches: 0, misses: 0, recordMatches: {} },
    });
    assert.equal(fs.existsSync(path.join(storePath, 'activity.json')), false);
  });

  it('conservatively resets legacy integer counters without crashing a revision-keyed write', async (t) => {
    const storePath = makeTmp(t);
    const activityPath = path.join(storePath, 'activity.json');
    fs.writeFileSync(activityPath, JSON.stringify({
      schemaVersion: 1,
      records: {
        'legacy-record': { versions: { 7: { successfulLoads: 4, lastLoadedAt: '2026-07-22T10:00:00.000Z' } } },
      },
      search: { matches: 2, misses: 1, recordMatches: {} },
    }));
    const { readKnowledgeActivity, recordKnowledgeLoad } = await loadActivityModule();

    assert.deepEqual(readKnowledgeActivity(storePath).records, {});
    await recordKnowledgeLoad({ storePath, id: 'legacy-record', revisionToken: REVISION_A });

    const activity = readKnowledgeActivity(storePath);
    assert.equal(activity.schemaVersion, 2);
    assert.deepEqual(activity.records['legacy-record'].revisions[REVISION_A].successfulLoads, 1);
    assert.equal(Object.hasOwn(activity.records['legacy-record'], 'versions'), false);
    assert.equal(activity.search.matches, 2);
  });

  it('keys counters by the exact revision token and rejects retired integer identity', async (t) => {
    const storePath = makeTmp(t);
    const { aggregateKnowledgeRecordActivity, readKnowledgeActivity, recordKnowledgeLoad } = await loadActivityModule();

    await recordKnowledgeLoad({ storePath, id: 'feature-learning', revisionToken: REVISION_A, now: () => Date.parse('2026-07-22T10:00:00.000Z') });
    await recordKnowledgeLoad({ storePath, id: 'feature-learning', revisionToken: REVISION_B, now: () => Date.parse('2026-07-22T11:00:00.000Z') });
    const current = await recordKnowledgeLoad({ storePath, id: 'feature-learning', revisionToken: REVISION_B, now: () => Date.parse('2026-07-22T12:00:00.000Z') });

    assert.deepEqual(current, { successfulLoads: 2, lastLoadedAt: '2026-07-22T12:00:00.000Z' });
    const activity = readKnowledgeActivity(storePath);
    assert.deepEqual(activity.records['feature-learning'].revisions[REVISION_A], { successfulLoads: 1, lastLoadedAt: '2026-07-22T10:00:00.000Z' });
    assert.deepEqual(activity.records['feature-learning'].revisions[REVISION_B], { successfulLoads: 2, lastLoadedAt: '2026-07-22T12:00:00.000Z' });
    assert.deepEqual(aggregateKnowledgeRecordActivity(activity, 'feature-learning'), { successfulLoads: 3, lastLoadedAt: '2026-07-22T12:00:00.000Z' });
    await assert.rejects(
      recordKnowledgeLoad({ storePath, id: 'feature-learning', version: 7 }),
      /revisionToken must be a canonical typed-record revision token/,
    );
  });

  it('serializes concurrent revision-token updates through one linked-worktree store', async (t) => {
    const tmp = makeTmp(t);
    const storePath = path.join(tmp, 'shared-store');
    const linkedStorePath = path.join(tmp, 'linked-worktree-store');
    fs.mkdirSync(storePath);
    fs.symlinkSync(storePath, linkedStorePath, 'dir');
    const activityUrl = pathToFileURL(ACTIVITY_MODULE).href;
    const invocations = 12;
    const worker = [
      `import { recordKnowledgeLoad } from ${JSON.stringify(activityUrl)};`,
      'const [storePath, revisionToken] = process.argv.slice(1);',
      "await recordKnowledgeLoad({ storePath, id: 'shared-record', revisionToken });",
    ].join('\n');
    await Promise.all(Array.from({ length: invocations }, (_, index) => execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', worker, index % 2 === 0 ? storePath : linkedStorePath, REVISION_A],
      { timeout: 15_000 },
    )));

    const { readKnowledgeActivity } = await loadActivityModule();
    assert.equal(readKnowledgeActivity(storePath).records['shared-record'].revisions[REVISION_A].successfulLoads, invocations);
  });
});
