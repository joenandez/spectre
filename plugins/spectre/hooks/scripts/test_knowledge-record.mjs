#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECORD_MODULE = path.join(SCRIPT_DIR, 'knowledge', 'records.mjs');

function makeTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-record-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

async function loadRecordModule() {
  assert.equal(
    fs.existsSync(RECORD_MODULE),
    true,
    'knowledge/records.mjs must provide canonical typed record and index behavior',
  );
  return import(pathToFileURL(RECORD_MODULE).href);
}

function knowledgeRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'auth-token-refresh',
    kind: 'knowledge',
    title: 'Refresh expired auth tokens before retrying',
    summary: 'Expired access tokens surface as a 401 on the retried request.',
    tags: ['auth', 'http'],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-19T00:00:00.000Z' },
    relatedRecordIds: [],
    category: 'pattern',
    useWhen: 'Changing retry behavior around authenticated requests.',
    content: 'Refresh the token, then retry the request exactly once.',
    evidence: 'Reproduced the 401 twice, then verified the refresh-then-retry fix.',
    status: 'active',
    ...overrides,
  };
}

function workRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'work-auth-retry',
    kind: 'work',
    title: 'Auth retry hardening',
    summary: 'Historical account of the auth retry work.',
    tags: ['auth'],
    applicability: { scope: 'work', workId: 'work-auth-retry' },
    provenance: {
      origin: 'legacy-import',
      capturedAt: '2026-07-19T00:00:00.000Z',
      sourceFingerprint: 'sha256:0123456789abcdef',
    },
    relatedRecordIds: ['auth-token-refresh'],
    work: {
      requestedOutcome: 'unknown — imported record',
      scope: 'unknown — imported record',
      actualChanges: 'unknown — imported record',
      reasons: 'unknown — imported record',
      discoveries: 'unknown — imported record',
      verification: 'unknown — imported record',
      remainingWork: 'unknown — imported record',
      relatedContext: 'unknown — imported record',
      execution: { state: 'unknown' },
      verificationState: { state: 'unknown' },
      pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
    },
    importedSource: {
      body: 'Original legacy guidance is retained as historical source material.',
      useWhen: 'Investigating the historical auth retry work.',
      cues: ['auth retry', 'token refresh'],
      category: 'pattern',
      status: 'active',
      version: '1',
    },
    ...overrides,
  };
}

function writeRecordPackage(root, record, options = {}) {
  const id = options.directoryName ?? record.id;
  const recordPath = path.join(root, 'knowledge', id, options.fileName ?? 'record.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, options.raw ?? `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

describe('typed knowledge record packages', () => {
  it('round-trips both kinds, every knowledge category, and every status', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    const work = workRecord();
    const parsedWork = parseKnowledgeRecord(writeRecordPackage(tmp, work));
    assert.deepEqual(parsedWork.record, work);
    assert.match(parsedWork.revisionToken, /^sha256:[a-f0-9]{64}$/);

    for (const category of ['decision', 'pattern', 'gotcha', 'blocker']) {
      for (const status of ['active', 'disputed', 'superseded', 'archived']) {
        const record = knowledgeRecord({
          id: `${category}-${status}`,
          category,
          status,
          ...(category === 'blocker'
            ? {
              blocker: {
                condition: 'The staging deploy rejects the refreshed token.',
                resolutionCriterion: 'A staging deploy accepts a refreshed token.',
              },
            }
            : {}),
        });
        const parsed = parseKnowledgeRecord(writeRecordPackage(tmp, record));
        assert.deepEqual(parsed.record, record);
      }
    }
  });

  it('rejects a blocker without an observed condition and a resolution criterion', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'blocker-missing-package',
        category: 'blocker',
      }))),
      /blocker/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'blocker-missing-condition',
        category: 'blocker',
        blocker: { resolutionCriterion: 'A staging deploy accepts a refreshed token.' },
      }))),
      /blocker\.condition/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'blocker-missing-resolution',
        category: 'blocker',
        blocker: { condition: 'The staging deploy rejects the refreshed token.' },
      }))),
      /blocker\.resolutionCriterion/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'pattern-with-blocker',
        blocker: {
          condition: 'The staging deploy rejects the refreshed token.',
          resolutionCriterion: 'A staging deploy accepts a refreshed token.',
        },
      }))),
      /blocker/,
    );
  });

  it('names the offending field for AgentSkills frontmatter and unknown schema versions', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, null, {
        directoryName: 'legacy-frontmatter',
        raw: [
          '---',
          'name: legacy-frontmatter',
          'description: Use when reading a retired skill package.',
          '---',
          '# Legacy',
        ].join('\n'),
      })),
      /frontmatter/i,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, {
        ...knowledgeRecord({ id: 'legacy-metadata' }),
        metadata: { 'spectre-category': 'feature' },
      })),
      /metadata/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, {
        ...knowledgeRecord({ id: 'legacy-name-field' }),
        name: 'legacy-name-field',
      })),
      /name/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'unsupported-schema-version',
        schemaVersion: 2,
      }))),
      /schemaVersion/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, knowledgeRecord({
        id: 'legacy-skill-file',
      }), { fileName: 'SKILL.md' })),
      /record\.json/,
    );
  });

  it('enforces canonical identity, enumerations, and required typed fields', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    const invalid = [
      ['directory mismatch', knowledgeRecord({ id: 'auth-token-refresh' }), { directoryName: 'other-directory' }, /directory/i],
      ['uppercase id', knowledgeRecord({ id: 'Auth-Token' }), {}, /id/],
      ['unknown kind', knowledgeRecord({ id: 'unknown-kind', kind: 'note' }), {}, /kind/],
      ['unknown category', knowledgeRecord({ id: 'unknown-category', category: 'feature' }), {}, /category/],
      ['unknown status', knowledgeRecord({ id: 'unknown-status', status: 'reviewing' }), {}, /status/],
      ['empty summary', knowledgeRecord({ id: 'empty-summary', summary: '' }), {}, /summary/],
      ['missing use-when', (() => {
        const record = knowledgeRecord({ id: 'missing-use-when' });
        delete record.useWhen;
        return record;
      })(), {}, /useWhen/],
      ['missing evidence', (() => {
        const record = knowledgeRecord({ id: 'missing-evidence' });
        delete record.evidence;
        return record;
      })(), {}, /evidence/],
      ['duplicate tags', knowledgeRecord({ id: 'duplicate-tags', tags: ['auth', 'auth'] }), {}, /tags/],
      ['non-canonical tag', knowledgeRecord({ id: 'bad-tag', tags: ['Auth Flow'] }), {}, /tags/],
      ['unknown applicability scope', knowledgeRecord({
        id: 'bad-scope',
        applicability: { scope: 'global' },
      }), {}, /applicability/],
      ['work scope without work identity', knowledgeRecord({
        id: 'missing-work-id',
        applicability: { scope: 'work' },
      }), {}, /workId/],
      ['unknown provenance origin', knowledgeRecord({
        id: 'bad-origin',
        provenance: { origin: 'guessed', capturedAt: '2026-07-19T00:00:00.000Z' },
      }), {}, /origin/],
      ['related id is not canonical', knowledgeRecord({
        id: 'bad-related',
        relatedRecordIds: ['Not Canonical'],
      }), {}, /relatedRecordIds/],
      ['knowledge fields on a work record', {
        ...workRecord({ id: 'work-with-status' }),
        status: 'active',
      }, {}, /status/],
      ['malformed JSON', null, { directoryName: 'malformed-json', raw: '{ not json' }, /JSON/i],
    ];

    for (const [label, record, options, expected] of invalid) {
      assert.throws(
        () => parseKnowledgeRecord(writeRecordPackage(tmp, record, options)),
        expected,
        label,
      );
    }
  });

  it('digests canonical field values independently of stored key order and spacing', async (t) => {
    const tmp = makeTmp(t);
    const { canonicalRecordBytes, canonicalRecordDigest, parseKnowledgeRecord, revisionTokenFor } =
      await loadRecordModule();

    const record = knowledgeRecord({ id: 'canonical-digest' });
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    const compactPath = writeRecordPackage(tmp, reordered, {
      directoryName: 'canonical-digest',
      raw: JSON.stringify(reordered),
    });

    assert.equal(canonicalRecordBytes(record), canonicalRecordBytes(reordered));
    assert.equal(
      parseKnowledgeRecord(compactPath).revisionToken,
      revisionTokenFor(record, []),
    );
    assert.notEqual(
      canonicalRecordDigest(record),
      canonicalRecordDigest({ ...record, summary: 'Changed summary.' }),
    );
  });
});

describe('rendered typed records', () => {
  it('renders every typed knowledge field as readable sections', async () => {
    const { renderKnowledgeRecord } = await loadRecordModule();
    const record = knowledgeRecord({
      id: 'deploy-token-blocker',
      category: 'blocker',
      status: 'disputed',
      relatedRecordIds: ['work-auth-retry'],
      blocker: {
        condition: 'The staging deploy rejects the refreshed token.',
        resolutionCriterion: 'A staging deploy accepts a refreshed token.',
      },
    });

    assert.equal(renderKnowledgeRecord(record), [
      '# Refresh expired auth tokens before retrying',
      '',
      '- ID: deploy-token-blocker',
      '- Kind: knowledge',
      '- Category: blocker',
      '- Status: disputed',
      '- Applicability: project',
      '- Tags: auth, http',
      '- Related records: work-auth-retry',
      '- Provenance: captured at 2026-07-19T00:00:00.000Z',
      '',
      '## Summary',
      '',
      'Expired access tokens surface as a 401 on the retried request.',
      '',
      '## Use when',
      '',
      'Changing retry behavior around authenticated requests.',
      '',
      '## Guidance',
      '',
      'Refresh the token, then retry the request exactly once.',
      '',
      '## Evidence',
      '',
      'Reproduced the 401 twice, then verified the refresh-then-retry fix.',
      '',
      '## Blocking condition',
      '',
      'The staging deploy rejects the refreshed token.',
      '',
      '## Resolution criterion',
      '',
      'A staging deploy accepts a refreshed token.',
      '',
    ].join('\n'));
  });

  it('labels a work record as historical evidence rather than guidance', async () => {
    const { renderKnowledgeRecord } = await loadRecordModule();
    const rendered = renderKnowledgeRecord(workRecord());

    assert.match(rendered, /- Kind: work/);
    assert.match(rendered, /- Applicability: work \(work-auth-retry\)/);
    assert.match(rendered, /historical evidence/i);
    assert.equal(rendered.includes('## Guidance'), false);
    assert.match(rendered, /Historical account of the auth retry work\./);
    for (const heading of [
      'Requested outcome and scope',
      'Actual changes and affected components',
      'Reasons and accepted decisions',
      'Discoveries and approaches tried',
      'Verification performed',
      'Remaining work, limitations, and unknowns',
      'Related knowledge and source context',
    ]) {
      assert.match(rendered, new RegExp(`## ${heading}`));
    }
    assert.match(rendered, /## Imported source/);
    assert.match(rendered, /Original legacy guidance is retained/);
  });

  it('rejects work lifecycle states that would claim draft-open and merged together', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const record = workRecord({
      work: {
        ...workRecord().work,
        pullRequest: { state: 'draft-open', mergedAt: '2026-07-19T00:00:00.000Z' },
      },
    });

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, record)),
      /pullRequest/,
    );
  });

  it('requires every work template section to state an explicit unknown rather than be empty', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const record = workRecord({
      work: { ...workRecord().work, remainingWork: '' },
    });

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, record)),
      /remainingWork/,
    );
  });
});

describe('derived current knowledge index', () => {
  it('projects typed records for current guidance and explicit historical inspection', async (t) => {
    const storePath = makeTmp(t);
    const { refreshKnowledgeIndex } = await loadRecordModule();
    writeRecordPackage(storePath, knowledgeRecord({ id: 'active-knowledge' }));
    writeRecordPackage(storePath, knowledgeRecord({
      id: 'archived-knowledge',
      status: 'archived',
    }));
    writeRecordPackage(storePath, knowledgeRecord({
      id: 'superseded-knowledge',
      status: 'superseded',
    }));
    writeRecordPackage(storePath, workRecord());

    const { index, rebuilt, errors } = refreshKnowledgeIndex(storePath, {
      now: () => Date.parse('2026-07-19T00:00:00.000Z'),
    });

    assert.equal(rebuilt, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(index.records.map(({ id }) => id), [
      'active-knowledge', 'archived-knowledge', 'superseded-knowledge', 'work-auth-retry',
    ]);
    const knowledgeEntry = index.records.find(({ id }) => id === 'active-knowledge');
    const workEntry = index.records.find(({ id }) => id === 'work-auth-retry');
    assert.equal(knowledgeEntry.kind, 'knowledge');
    assert.equal(knowledgeEntry.category, 'pattern');
    assert.equal(knowledgeEntry.status, 'active');
    assert.equal(knowledgeEntry.useWhen, 'Changing retry behavior around authenticated requests.');
    assert.deepEqual(knowledgeEntry.tags, ['auth', 'http']);
    assert.deepEqual(knowledgeEntry.applicability, { scope: 'project' });
    assert.equal(knowledgeEntry.recordPath, path.join('knowledge', 'active-knowledge', 'record.json'));
    assert.match(knowledgeEntry.revisionToken, /^sha256:[a-f0-9]{64}$/);
    assert.equal(workEntry.kind, 'work');
    assert.equal(workEntry.historical, true);
    assert.equal(workEntry.imported, true);
    assert.equal(workEntry.useWhen, 'Investigating the historical auth retry work.');
    assert.deepEqual(workEntry.cues, ['auth retry', 'token refresh']);
    assert.equal(workEntry.status, 'active');
    assert.equal(workEntry.version, '1');
    for (const retired of ['description', 'triggers', 'version', 'sourceFingerprint']) {
      assert.equal(Object.hasOwn(knowledgeEntry, retired), false, retired);
    }
    assert.equal(fs.existsSync(path.join(storePath, 'index.json')), true);
  });

  it('never indexes archived revisions and rebuilds a retired index file', async (t) => {
    const storePath = makeTmp(t);
    const { refreshKnowledgeIndex } = await loadRecordModule();
    const record = knowledgeRecord({ id: 'revised-knowledge' });
    writeRecordPackage(storePath, record);
    const historyPath = path.join(
      storePath,
      'knowledge-history',
      'revised-knowledge',
      'sha256-0123456789abcdef',
      'record.json',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify({
      ...record,
      summary: 'Prior revision summary that must never be current guidance.',
    }, null, 2));

    fs.writeFileSync(
      path.join(storePath, 'index.json'),
      JSON.stringify({ schemaVersion: 1, generatedAt: '2026-07-18T00:00:00.000Z', records: [] }),
    );
    const { index, rebuilt, errors } = refreshKnowledgeIndex(storePath);

    assert.equal(rebuilt, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(index.records.map(({ id }) => id), ['revised-knowledge']);
    assert.equal(
      index.records[0].summary,
      'Expired access tokens surface as a 401 on the retried request.',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8')).schemaVersion,
      2,
    );
  });

  it('reports invalid neighbors without dropping valid typed records', async (t) => {
    const storePath = makeTmp(t);
    const { refreshKnowledgeIndex } = await loadRecordModule();
    writeRecordPackage(storePath, knowledgeRecord({ id: 'valid-neighbor' }));
    writeRecordPackage(storePath, null, {
      directoryName: 'invalid-neighbor',
      raw: '---\nname: invalid-neighbor\n---\nretired skill\n',
    });

    const result = refreshKnowledgeIndex(storePath);

    assert.deepEqual(result.index.records.map(({ id }) => id), ['valid-neighbor']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].path, /invalid-neighbor/);
    assert.match(result.errors[0].message, /frontmatter/i);
  });

  it('rereads once on a digest mismatch and returns nothing for a tampered package', async (t) => {
    const storePath = makeTmp(t);
    const { refreshKnowledgeIndex, readVerifiedIndexedRecord } = await loadRecordModule();
    const record = knowledgeRecord({ id: 'raced-knowledge' });
    const recordPath = writeRecordPackage(storePath, record);
    const entry = refreshKnowledgeIndex(storePath).index.records[0];
    const canonical = fs.readFileSync(recordPath, 'utf8');
    const tampered = JSON.stringify({ ...record, content: 'Tampered guidance.' }, null, 2);

    let reads = 0;
    const recovered = readVerifiedIndexedRecord(storePath, entry, {
      readFile() {
        reads += 1;
        return reads === 1 ? tampered : canonical;
      },
    });
    assert.equal(reads, 2);
    assert.equal(recovered.record.id, 'raced-knowledge');

    reads = 0;
    const rejected = readVerifiedIndexedRecord(storePath, entry, {
      readFile() {
        reads += 1;
        return tampered;
      },
    });
    assert.equal(reads, 2);
    assert.equal(rejected, null);
  });
});
