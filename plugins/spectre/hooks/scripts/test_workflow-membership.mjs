#!/usr/bin/env node

/**
 * Bounded delivery-membership predicate checks.
 *
 * One check per fixture scenario. The predicate must prove inclusion, exclude reverted or
 * absent work, and fail closed to `ambiguous` instead of guessing. A Git failure must never
 * reach `excluded`, and the range scan must stay lazy and shared.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MEMBERSHIP_SCENARIOS, buildMembershipFixture } from './test_workflow-membership-fixtures.mjs';

/** Loaded per check so each scenario reports its own failure while the predicate is absent. */
function membership() {
  return import('./workflow/membership.mjs');
}

async function evaluate(fixture, receipt = fixture.receipt, projectDir = fixture.repoDir) {
  const { evaluateDeliveryMembership } = await membership();
  return evaluateDeliveryMembership({
    projectDir,
    receipt,
    candidate: fixture.candidate,
  });
}

/** Run one check with an environment variable forced, then put the environment back. */
async function withEnv(overrides, body) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('delivery membership predicate', () => {
  for (const scenario of MEMBERSHIP_SCENARIOS) {
    it(`${scenario} returns its oracle verdict`, async (t) => {
      const fixture = buildMembershipFixture(scenario, t);
      const result = await evaluate(fixture);
      assert.equal(result.verdict, fixture.expected.verdict, `${scenario}: ${result.reason}`);
      assert.equal(result.reason, fixture.expected.reason);
    });
  }

  it('excludes reverted work and unrelated same-branch work', async (t) => {
    for (const scenario of ['full-revert', 'unrelated-same-branch']) {
      const fixture = buildMembershipFixture(scenario, t);
      assert.equal((await evaluate(fixture)).verdict, 'excluded', scenario);
    }
  });

  it('selects rebase-equivalent work from the persisted patch identity alone', async (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent', t);
    const result = await evaluate(fixture);
    assert.equal(result.verdict, 'selected');
    assert.deepEqual(result.evidence.provedByCommitId, []);
    assert.deepEqual(result.evidence.provedByPatchId, fixture.receipt.acceptedCommits);
  });

  it('still selects rebase-equivalent work after the pre-rebase object is collected', async (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent-pruned', t);
    const result = await evaluate(fixture);
    assert.equal(result.verdict, 'selected', result.reason);
    assert.equal(result.reason, 'net-effect-present');
    assert.deepEqual(result.evidence.provedByPatchId, fixture.receipt.acceptedCommits);
    assert.notDeepEqual(
      result.evidence.patchSources,
      fixture.receipt.acceptedCommits,
      'the net-effect patch comes from the matched in-range commit',
    );
  });

  it('reads a rebased patch larger than the default buffer instead of excluding it', async (t) => {
    const fixture = buildMembershipFixture('large-rebased-patch', t);
    assert.ok(fixture.patchBytes > 1024 * 1024, `patch is ${fixture.patchBytes} bytes`);
    const result = await evaluate(fixture);
    assert.equal(result.verdict, 'selected', result.reason);
    assert.deepEqual(result.evidence.provedByPatchId, fixture.receipt.acceptedCommits);
  });

  it('proves the multi-commit shape without trusting receipt order', async (t) => {
    const fixture = buildMembershipFixture('multi-commit-sequence', t);
    assert.equal(fixture.receipt.acceptedCommits.length, 2);
    const forward = await evaluate(fixture);
    assert.equal(forward.verdict, 'selected', forward.reason);
    const reversed = {
      ...fixture.receipt,
      acceptedCommits: [...fixture.receipt.acceptedCommits].reverse(),
      acceptedPatchIds: [...fixture.receipt.acceptedPatchIds].reverse(),
    };
    const backward = await evaluate(fixture, reversed);
    assert.equal(backward.verdict, 'selected', backward.reason);
    assert.deepEqual(backward.evidence.patchSources, forward.evidence.patchSources);
  });

  it('returns ambiguous, never a boolean, for missing objects and unprovable overlap', async (t) => {
    for (const scenario of ['missing-objects', 'overlapping-later-edits']) {
      const result = await evaluate(buildMembershipFixture(scenario, t));
      assert.equal(result.verdict, 'ambiguous', scenario);
      assert.notEqual(typeof result.verdict, 'boolean');
    }
  });

  it('rejects a patch id that no longer matches the commit it claims', async (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent', t);
    const stale = { ...fixture.receipt, acceptedPatchIds: ['0'.repeat(40)] };
    const result = await evaluate(fixture, stale);
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'patch-id-mismatch');
  });

  it('never excludes on a patch id it cannot verify', async (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent-pruned', t);
    const stale = { ...fixture.receipt, acceptedPatchIds: ['0'.repeat(40)] };
    const result = await evaluate(fixture, stale);
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'accepted-objects-missing');
  });

  it('fails closed to ambiguous for a start-only receipt', async (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const startOnly = {
      runId: fixture.receipt.runId,
      branch: fixture.receipt.branch,
      startHead: fixture.receipt.startHead,
      acceptedCommits: [],
      acceptedPatchIds: [],
    };
    const result = await evaluate(fixture, startOnly);
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'receipt-incomplete');
  });

  it('never selects on branch ancestry alone', async (t) => {
    const fixture = buildMembershipFixture('unrelated-same-branch', t);
    const branchOnly = { ...fixture.receipt, acceptedCommits: [], acceptedPatchIds: [] };
    const result = await evaluate(fixture, branchOnly);
    assert.notEqual(result.verdict, 'selected');
  });

  it('returns a verdict instead of throwing when the scratch index cannot be made', async (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const unwritable = path.join(os.tmpdir(), 'spectre-membership-absent-tmpdir', 'nope');
    const result = await withEnv({ TMPDIR: unwritable, TMP: unwritable, TEMP: unwritable }, () => evaluate(fixture));
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'net-effect-unreadable');
  });

  it('returns a verdict instead of throwing outside a repository', async (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-nonrepo-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const result = await evaluate(fixture, fixture.receipt, outside);
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'repo-unreadable');
  });

  it('evaluates the project repository, not an ambient GIT_DIR', async (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const foreign = buildMembershipFixture('full-revert', t);
    const result = await withEnv(
      { GIT_DIR: path.join(foreign.repoDir, '.git'), GIT_WORK_TREE: foreign.repoDir },
      () => evaluate(fixture),
    );
    assert.equal(result.verdict, 'selected', result.reason);
  });

  it('evaluates from a subdirectory of the repository', async (t) => {
    const fixture = buildMembershipFixture('sequential-runs', t);
    const nested = path.join(fixture.repoDir, 'packages', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const result = await evaluate(fixture, fixture.receipt, nested);
    assert.equal(result.verdict, 'selected', result.reason);
  });

  it('scans range patch ids only when a commit id did not already prove membership', async (t) => {
    const { clearMembershipCaches, readMembershipDiagnostics } = await membership();
    const proved = buildMembershipFixture('sequential-runs', t);
    clearMembershipCaches();
    assert.equal((await evaluate(proved)).verdict, 'selected');
    assert.equal(readMembershipDiagnostics().rangeScans, 0);

    const rebased = buildMembershipFixture('rebased-equivalent', t);
    clearMembershipCaches();
    assert.equal((await evaluate(rebased)).verdict, 'selected');
    const afterFirst = readMembershipDiagnostics();
    assert.equal(afterFirst.rangeScans, 1);

    assert.equal((await evaluate(rebased)).verdict, 'selected');
    const afterSecond = readMembershipDiagnostics();
    assert.equal(afterSecond.rangeScans, 1, 'the range scan is memoized per candidate');
    assert.ok(afterSecond.gitCalls > afterFirst.gitCalls, 'the second evaluation still ran');
  });

  it('names exactly the fields the receipt must persist', async () => {
    const { DELIVERY_RECEIPT_FIELDS } = await membership();
    assert.deepEqual(DELIVERY_RECEIPT_FIELDS.required, [
      'runId',
      'branch',
      'terminalHead',
      'acceptedCommits',
      'acceptedPatchIds',
    ]);
    assert.deepEqual(DELIVERY_RECEIPT_FIELDS.optional, ['startHead']);
    for (const field of [...DELIVERY_RECEIPT_FIELDS.required, ...DELIVERY_RECEIPT_FIELDS.optional]) {
      assert.ok(DELIVERY_RECEIPT_FIELDS.roles[field], `${field} states its role`);
    }
  });

  it('answers only from the closed reason vocabulary', async (t) => {
    const { DELIVERY_MEMBERSHIP_REASONS } = await membership();
    for (const scenario of MEMBERSHIP_SCENARIOS) {
      const result = await evaluate(buildMembershipFixture(scenario, t));
      assert.equal(
        DELIVERY_MEMBERSHIP_REASONS[result.reason],
        result.verdict,
        `${scenario}: ${result.reason} carries ${result.verdict}`,
      );
    }
    for (const verdict of Object.values(DELIVERY_MEMBERSHIP_REASONS)) {
      assert.ok(['selected', 'excluded', 'ambiguous'].includes(verdict), verdict);
    }
  });

  it('keeps the candidate range decision out of reach of a broken git call', async (t) => {
    const fixture = buildMembershipFixture('rebased-equivalent', t);
    const { clearMembershipCaches, evaluateDeliveryMembership } = await membership();
    clearMembershipCaches();
    // A git that fails every call must never produce `excluded`.
    const brokenGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-brokengit-'));
    t.after(() => fs.rmSync(brokenGitDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(brokenGitDir, 'git'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const result = await withEnv({ PATH: `${brokenGitDir}${path.delimiter}${process.env.PATH}` }, () =>
      evaluateDeliveryMembership({
        projectDir: fixture.repoDir,
        receipt: fixture.receipt,
        candidate: fixture.candidate,
      }));
    assert.equal(result.verdict, 'ambiguous');
    assert.equal(result.reason, 'repo-unreadable');
    clearMembershipCaches();
  });
});
