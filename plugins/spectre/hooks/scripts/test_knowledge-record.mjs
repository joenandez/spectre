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
  it('accepts an explicit finalized execution state without coupling it to the PR dimension', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const finalizedWithoutPr = workRecord({
      id: 'work-finalized-no-pr',
      applicability: { scope: 'work', workId: 'work-finalized-no-pr' },
      work: {
        ...workRecord().work,
        remainingWork: 'None.',
        execution: { state: 'finalized' },
        verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
        pullRequest: { state: 'none' },
      },
    });
    const finalizedInAMergedPr = workRecord({
      id: 'work-finalized-merged-pr',
      applicability: { scope: 'work', workId: 'work-finalized-merged-pr' },
      work: {
        ...finalizedWithoutPr.work,
        pullRequest: { state: 'merged', identity: 'octo/repo#12' },
      },
    });
    const unfinalizedInAnOpenPr = workRecord({
      id: 'work-open-pr-not-final',
      applicability: { scope: 'work', workId: 'work-open-pr-not-final' },
      work: {
        ...workRecord().work,
        execution: { state: 'blocked' },
        verificationState: { state: 'failed' },
        pullRequest: { state: 'draft-open', identity: 'octo/repo#13' },
      },
    });

    for (const record of [finalizedWithoutPr, finalizedInAMergedPr, unfinalizedInAnOpenPr]) {
      assert.deepEqual(parseKnowledgeRecord(writeRecordPackage(tmp, record)).record, record);
    }
  });

  it('leaves a record without explicit finality unknown instead of promoting it to finalized', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const legacyShape = workRecord({
      id: 'work-legacy-unknown-finality',
      applicability: { scope: 'work', workId: 'work-legacy-unknown-finality' },
      work: {
        ...workRecord().work,
        execution: { state: 'unknown' },
        verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
        pullRequest: { state: 'merged', identity: 'octo/repo#9' },
      },
    });

    const parsed = parseKnowledgeRecord(writeRecordPackage(tmp, legacyShape));

    assert.equal(parsed.record.work.execution.state, 'unknown');
    assert.notEqual(parsed.record.work.execution.state, 'finalized');
  });

  it('rejects an execution state outside the closed lifecycle set', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const record = workRecord({
      work: { ...workRecord().work, execution: { state: 'final' } },
    });

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, record)),
      /work.execution.state/,
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

  it('requires canonical None. remaining work once a record is finalized', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const finalizedWork = {
      ...workRecord().work,
      execution: { state: 'finalized' },
      verificationState: { state: 'passed', evidenceRef: 'proof/proof.json' },
      pullRequest: { state: 'draft-open', identity: 'octo/repo#21' },
    };

    for (const remainingWork of [
      'Awaiting PR review and CI before merge.',
      'Waiting on CI.',
      'Pending merge.',
      'Needs review.',
      'Blocked on CI checks.',
      'Requires closure.',
      'unknown — imported record',
    ]) {
      assert.throws(
        () => parseKnowledgeRecord(writeRecordPackage(tmp, workRecord({
          work: { ...finalizedWork, remainingWork },
        }))),
        /remainingWork/,
        remainingWork,
      );
    }

    const accepted = workRecord({
      id: 'work-finalized-after-review',
      applicability: { scope: 'work', workId: 'work-finalized-after-review' },
      work: { ...finalizedWork, remainingWork: 'None.' },
    });
    assert.deepEqual(parseKnowledgeRecord(writeRecordPackage(tmp, accepted)).record, accepted);
  });

  it('rejects delivery lifecycle reported as remaining implementation work on any state', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const blockedWork = {
      ...workRecord().work,
      execution: { state: 'blocked' },
      verificationState: { state: 'failed' },
      pullRequest: { state: 'draft-open', identity: 'octo/repo#22' },
    };

    for (const remainingWork of [
      'Awaiting PR review.',
      'Waiting for approval.',
      'Pending readiness.',
      'Needs merge.',
      'Awaiting PR review, CI, and closure.',
    ]) {
      assert.throws(
        () => parseKnowledgeRecord(writeRecordPackage(tmp, workRecord({
          work: { ...blockedWork, remainingWork },
        }))),
        /remainingWork/,
        remainingWork,
      );
    }
  });

  it('keeps a blocked record non-final with its truthful scoped residual work', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    for (const [id, remainingWork] of [
      ['work-blocked-residual', 'The rebase path still needs a regression test for merge conflicts.'],
      ['work-failed-residual', 'Needs a follow-up refactor of the merge helper before the retry lands.'],
      ['work-interrupted-residual', 'unknown — imported record'],
    ]) {
      const record = workRecord({
        id,
        applicability: { scope: 'work', workId: id },
        work: {
          ...workRecord().work,
          remainingWork,
          execution: { state: 'blocked' },
          verificationState: { state: 'failed' },
          pullRequest: { state: 'draft-open', identity: 'octo/repo#23' },
        },
      });

      const parsed = parseKnowledgeRecord(writeRecordPackage(tmp, record)).record;
      assert.equal(parsed.work.execution.state, 'blocked');
      assert.equal(parsed.work.remainingWork, remainingWork);
    }
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

const RECEIPT_RUN_ID = 'run_4e36f347-b5ba-42a2-9869-892c53a41d43';

function deliveryReceipt(overrides = {}) {
  return {
    runId: RECEIPT_RUN_ID,
    branch: 'feature/work-record-delivery-groups',
    startHead: '0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9',
    terminalHead: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    acceptedCommits: [
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ],
    acceptedPatchIds: [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ],
    ...overrides,
  };
}

function capturedWorkRecord(overrides = {}) {
  const base = workRecord();
  const record = {
    ...base,
    provenance: { origin: 'captured', capturedAt: '2026-09-17T00:00:00.000Z' },
    ...overrides,
  };
  delete record.importedSource;
  return record;
}

function receiptRecord(receiptOverrides = {}, recordOverrides = {}) {
  const base = capturedWorkRecord(recordOverrides);
  return {
    ...base,
    work: { ...base.work, deliveryReceipt: deliveryReceipt(receiptOverrides) },
  };
}

describe('bounded delivery-membership receipt', () => {
  it('round-trips a completed receipt of hashes and ids inside the work-record token limit', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord, assertRenderedWorkRecordTokenLimit } = await loadRecordModule();
    const many = Array.from({ length: 25 }, (unused, index) => index);
    const record = receiptRecord({
      acceptedCommits: many.map((index) => String(index).padStart(2, '0').repeat(20)),
      acceptedPatchIds: many.map((index) => `${String(index).padStart(2, '0').repeat(19)}ff`),
    });

    const parsed = parseKnowledgeRecord(writeRecordPackage(tmp, record)).record;

    assert.deepEqual(parsed.work.deliveryReceipt, record.work.deliveryReceipt);
    assert.doesNotThrow(() => assertRenderedWorkRecordTokenLimit(parsed));
  });

  it('rejects a receipt that omits the exact run id, the branch, or the start HEAD', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    for (const field of ['runId', 'branch', 'startHead']) {
      const receipt = deliveryReceipt();
      delete receipt[field];
      const base = capturedWorkRecord();
      assert.throws(
        () => parseKnowledgeRecord(writeRecordPackage(tmp, {
          ...base,
          work: { ...base.work, deliveryReceipt: receipt },
        })),
        new RegExp(`deliveryReceipt.${field}`),
        field,
      );
    }
  });

  it('accepts a start-only receipt with no terminal evidence yet', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const base = capturedWorkRecord();
    const record = {
      ...base,
      work: {
        ...base.work,
        deliveryReceipt: {
          runId: RECEIPT_RUN_ID,
          branch: 'main',
          startHead: '0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9',
        },
      },
    };

    assert.deepEqual(parseKnowledgeRecord(writeRecordPackage(tmp, record)).record, record);
  });

  it('refuses patch, log, and prose bodies so the receipt stays hashes and ids only', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();
    const patchBody = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';

    for (const [label, overrides] of [
      ['unknown field', { patch: patchBody }],
      ['log body', { log: 'ran npm test' }],
      ['prose branch', { branch: `feature/x ${patchBody}` }],
      ['patch text as a commit id', { acceptedCommits: [patchBody], acceptedPatchIds: [null] }],
      ['prose start head', { startHead: 'HEAD at the start of the run' }],
      ['prose terminal head', { terminalHead: 'the final commit of the run' }],
      ['non-hex patch id', { acceptedPatchIds: ['patch of the retry fix', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] }],
    ]) {
      assert.throws(
        () => parseKnowledgeRecord(writeRecordPackage(tmp, receiptRecord(overrides))),
        /deliveryReceipt/,
        label,
      );
    }
  });

  it('requires one patch id per accepted commit, null only where a commit has no patch', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord } = await loadRecordModule();

    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, receiptRecord({
        acceptedPatchIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      }))),
      /deliveryReceipt.acceptedPatchIds/,
    );
    assert.throws(
      () => parseKnowledgeRecord(writeRecordPackage(tmp, receiptRecord({
        acceptedCommits: [
          '1111111111111111111111111111111111111111',
          '1111111111111111111111111111111111111111',
        ],
      }))),
      /deliveryReceipt.acceptedCommits/,
    );

    // A merge commit is kept as accepted evidence and marked as having no patch, so the
    // membership evaluator fails closed on it instead of never seeing it.
    const mergeRecord = receiptRecord({
      acceptedPatchIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null],
    });
    assert.deepEqual(
      parseKnowledgeRecord(writeRecordPackage(tmp, mergeRecord)).record.work.deliveryReceipt.acceptedPatchIds,
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null],
    );
  });

  it('renders the receipt as bounded metadata without adding an eighth work section', async (t) => {
    const tmp = makeTmp(t);
    const { parseKnowledgeRecord, renderKnowledgeRecord } = await loadRecordModule();
    const record = parseKnowledgeRecord(writeRecordPackage(tmp, receiptRecord())).record;

    const rendered = renderKnowledgeRecord(record);

    assert.match(rendered, new RegExp(`- Delivery receipt: ${RECEIPT_RUN_ID}`));
    assert.match(rendered, /feature\/work-record-delivery-groups/);
    assert.equal((rendered.match(/^## /gm) || []).length, 8);
  });
});

describe('delivery receipt classification', () => {
  it('classifies a legacy branch-aggregated record with no receipt as legacy, never complete', async () => {
    const { classifyDeliveryReceipt } = await loadRecordModule();
    const legacyAggregate = workRecord({
      applicability: {
        scope: 'work',
        workId: 'work-auth-retry',
        runIds: ['run_a', 'run_b', 'run_c'],
      },
    });

    const classified = classifyDeliveryReceipt(legacyAggregate);

    assert.equal(classified.state, 'legacy');
    assert.equal(classified.complete, false);
    assert.equal(classified.reason, 'no-receipt');
  });

  it('classifies a start-only receipt from an in-progress, failed, or interrupted run as incomplete', async () => {
    const { classifyDeliveryReceipt } = await loadRecordModule();
    const startOnly = {
      runId: RECEIPT_RUN_ID,
      branch: 'main',
      startHead: '0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9',
    };

    for (const execution of ['in-progress', 'blocked', 'unknown', 'finalized']) {
      const base = capturedWorkRecord();
      const record = {
        ...base,
        work: {
          ...base.work,
          remainingWork: execution === 'finalized' ? 'None.' : base.work.remainingWork,
          execution: { state: execution },
          deliveryReceipt: startOnly,
        },
      };

      const classified = classifyDeliveryReceipt(record);

      assert.equal(classified.state, 'start-only', execution);
      assert.equal(classified.complete, false, execution);
      assert.equal(classified.reason, 'no-terminal-evidence', execution);
    }
  });

  it('classifies a terminal receipt with index-aligned accepted evidence as complete', async () => {
    const { classifyDeliveryReceipt } = await loadRecordModule();

    const classified = classifyDeliveryReceipt(receiptRecord());

    assert.equal(classified.state, 'complete');
    assert.equal(classified.complete, true);
    assert.equal(classified.reason, 'terminal-evidence-present');
  });

  it('never promotes terminal evidence that cannot decide membership', async () => {
    const { classifyDeliveryReceipt } = await loadRecordModule();

    for (const [label, overrides] of [
      ['no accepted commits', { acceptedCommits: [], acceptedPatchIds: [] }],
      ['no terminal head', { terminalHead: undefined }],
    ]) {
      const classified = classifyDeliveryReceipt(receiptRecord(overrides));

      assert.equal(classified.complete, false, label);
      assert.notEqual(classified.state, 'complete', label);
    }
  });

  it('is total: every input returns one closed state instead of undefined or a throw', async () => {
    const { classifyDeliveryReceipt, DELIVERY_RECEIPT_STATES } = await loadRecordModule();
    const hostileGetter = {};
    Object.defineProperty(hostileGetter, 'work', {
      get() { throw new Error('unreadable record'); },
    });

    const inputs = [
      undefined, null, 0, NaN, true, '', 'work-auth-retry', [], {},
      Object.create(null), hostileGetter,
      knowledgeRecord(), workRecord(), capturedWorkRecord(),
      { work: null }, { work: 'receipt' }, { work: {} },
      { work: { deliveryReceipt: null } },
      { work: { deliveryReceipt: 'run_1 on main' } },
      { work: { deliveryReceipt: [] } },
      { work: { deliveryReceipt: {} } },
      { work: { deliveryReceipt: { runId: RECEIPT_RUN_ID } } },
      { work: { deliveryReceipt: { branch: 'main', startHead: 'abc1234' } } },
      { work: { deliveryReceipt: { ...deliveryReceipt(), acceptedPatchIds: undefined } } },
      { work: { deliveryReceipt: { ...deliveryReceipt(), acceptedCommits: 'abc1234' } } },
    ];

    for (const input of inputs) {
      const classified = classifyDeliveryReceipt(input);
      const label = JSON.stringify(input) ?? String(input);

      assert.ok(classified && typeof classified === 'object', label);
      assert.ok(DELIVERY_RECEIPT_STATES.includes(classified.state), label);
      assert.equal(classified.complete, classified.state === 'complete', label);
      assert.equal(typeof classified.reason, 'string', label);
      assert.notEqual(classified.reason, '', label);
      assert.equal(classified.complete, false, label);
    }
  });

  it('persists more than the membership evaluator requires, on purpose', async () => {
    const { DELIVERY_RECEIPT_SCHEMA } = await loadRecordModule();
    const { DELIVERY_RECEIPT_FIELDS } = await import(pathToFileURL(
      path.join(SCRIPT_DIR, 'workflow', 'membership.mjs'),
    ).href);
    const persisted = [...DELIVERY_RECEIPT_SCHEMA.required, ...DELIVERY_RECEIPT_SCHEMA.terminal];

    // Capture must persist every field the evaluator can read, plus `startHead`.
    for (const field of DELIVERY_RECEIPT_FIELDS.required) assert.ok(persisted.includes(field), field);
    assert.ok(DELIVERY_RECEIPT_SCHEMA.required.includes('startHead'));
    assert.ok(DELIVERY_RECEIPT_FIELDS.optional.includes('startHead'));
    assert.equal(DELIVERY_RECEIPT_FIELDS.required.includes('startHead'), false);
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
