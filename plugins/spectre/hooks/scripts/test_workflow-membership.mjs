#!/usr/bin/env node

/**
 * Bounded delivery-membership predicate checks.
 *
 * One check per required fixture scenario. The predicate must prove inclusion, exclude
 * reverted or absent work, and fail closed to `ambiguous` instead of guessing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEMBERSHIP_SCENARIOS, buildMembershipFixture } from './test_workflow-membership-fixtures.mjs';

/** Loaded per check so each scenario reports its own failure while the predicate is absent. */
function membership() {
  return import('./workflow/membership.mjs');
}

async function evaluate(fixture, receipt = fixture.receipt) {
  const { evaluateDeliveryMembership } = await membership();
  return evaluateDeliveryMembership({
    projectDir: fixture.repoDir,
    receipt,
    candidate: fixture.candidate,
  });
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

  it('returns ambiguous, never a boolean, for missing objects and unprovable overlap', async (t) => {
    for (const scenario of ['missing-objects', 'overlapping-later-edits']) {
      const result = await evaluate(buildMembershipFixture(scenario, t));
      assert.equal(result.verdict, 'ambiguous', scenario);
      assert.notEqual(typeof result.verdict, 'boolean');
    }
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

  it('names exactly the fields the receipt must persist', async () => {
    const { DELIVERY_RECEIPT_FIELDS } = await membership();
    assert.deepEqual(DELIVERY_RECEIPT_FIELDS.required, [
      'runId',
      'branch',
      'startHead',
      'terminalHead',
      'acceptedCommits',
      'acceptedPatchIds',
    ]);
  });
});
