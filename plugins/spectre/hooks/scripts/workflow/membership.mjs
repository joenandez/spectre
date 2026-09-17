/**
 * Bounded delivery-membership predicate.
 *
 * Recorded decision of the membership capability gate. It answers one question for one
 * Execute work record: is that run's accepted work represented in the frozen outgoing
 * candidate? The answer is exactly `selected`, `excluded`, or `ambiguous` — never a
 * boolean and never a guess from branch ancestry.
 *
 * The predicate is a conjunction of two independent Git facts, evaluated in order:
 *
 *   1. Candidate-range identity. Every accepted commit must be proved inside
 *      `candidate.baseSha..candidate.headSha`, either by its own commit id or by its
 *      persisted patch id matching an in-range commit. Commit id alone dies at rebase;
 *      patch id alone would also match work that merely sits in the tree. Requiring the
 *      range keeps already-delivered same-branch work out.
 *   2. Net effect in the candidate head tree. The accepted commits' patches are checked
 *      against a scratch index read from `candidate.headSha`. A clean reverse apply proves
 *      the work is present; a clean forward apply proves it is absent (reverted). Anything
 *      else is unprovable.
 *
 * Both facts must agree. Missing objects, an incomplete receipt, partial range membership,
 * or contradictory apply results fail closed to `ambiguous` for explicit correction.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The exact receipt shape this predicate consumes. Hashes and ids only: no patches, logs,
 * or prose, so a completed receipt stays inside the work-record token bound.
 */
export const DELIVERY_RECEIPT_FIELDS = Object.freeze({
  required: Object.freeze([
    'runId',
    'branch',
    'startHead',
    'terminalHead',
    'acceptedCommits',
    'acceptedPatchIds',
  ]),
  roles: Object.freeze({
    runId: 'Exact Execute run identity that owns this record.',
    branch: 'Branch the run executed on; membership evidence, never a selector.',
    startHead: 'HEAD at run start; scopes the run and is never sufficient on its own.',
    terminalHead: 'HEAD at the terminal or blocked capture; absent means start-only.',
    acceptedCommits: 'Accepted task commit ids from the Execute event log.',
    acceptedPatchIds: 'Stable `git patch-id --stable` per accepted commit, index-aligned.',
  }),
  verdicts: Object.freeze(['selected', 'excluded', 'ambiguous']),
});

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

function debugLog(event, fields) {
  if (!process.env.SPECTRE_DEBUG) return;
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function gitOrNull(projectDir, args, { input, env } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    return null;
  }
}

function resolvesToCommit(projectDir, sha) {
  return SHA_PATTERN.test(sha || '') && gitOrNull(projectDir, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

function commitPatch(projectDir, sha) {
  return gitOrNull(projectDir, ['diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary', sha]);
}

function patchIdOf(projectDir, sha) {
  const patch = commitPatch(projectDir, sha);
  if (!patch || !patch.trim()) return null;
  const output = gitOrNull(projectDir, ['patch-id', '--stable'], { input: patch });
  const [id] = (output || '').trim().split(/\s+/);
  return id || null;
}

function verdict(state, reason, evidence) {
  debugLog('membership.evaluated', { verdict: state, reason, ...evidence });
  return { verdict: state, reason, evidence };
}

/**
 * Check the run's accepted patches against a scratch index built from the candidate head
 * tree. The working tree is never touched.
 */
function netEffect(projectDir, headSha, patches) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-index-'));
  const indexFile = path.join(scratch, 'index');
  try {
    const withScratchIndex = (args, input) => gitOrNull(projectDir, args, { input, env: { GIT_INDEX_FILE: indexFile } });
    if (withScratchIndex(['read-tree', headSha]) === null) return 'unprovable';
    const oldestFirst = patches.join('');
    const newestFirst = [...patches].reverse().join('');
    const present = withScratchIndex(['apply', '--cached', '--check', '--reverse', '-'], newestFirst) !== null;
    const absent = withScratchIndex(['apply', '--cached', '--check', '-'], oldestFirst) !== null;
    if (present && !absent) return 'present';
    if (absent && !present) return 'absent';
    return 'unprovable';
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Evaluate one delivery receipt against one frozen candidate tuple.
 *
 * @param {{projectDir: string, receipt: object, candidate: {baseSha: string, headSha: string}}} options
 * @returns {{verdict: 'selected'|'excluded'|'ambiguous', reason: string, evidence: object}}
 */
export function evaluateDeliveryMembership({ projectDir, receipt, candidate }) {
  const runId = receipt?.runId || null;
  const base = { runId, baseSha: candidate?.baseSha || null, headSha: candidate?.headSha || null };
  debugLog('membership.evaluating', {
    ...base,
    branch: receipt?.branch || null,
    acceptedCommits: receipt?.acceptedCommits?.length || 0,
  });

  const accepted = Array.isArray(receipt?.acceptedCommits) ? receipt.acceptedCommits : [];
  const patchIds = Array.isArray(receipt?.acceptedPatchIds) ? receipt.acceptedPatchIds : [];
  const complete = Boolean(runId)
    && Boolean(receipt?.branch)
    && Boolean(receipt?.startHead)
    && Boolean(receipt?.terminalHead)
    && accepted.length > 0
    && patchIds.length === accepted.length;
  if (!complete) return verdict('ambiguous', 'receipt-incomplete', base);

  if (!resolvesToCommit(projectDir, candidate.baseSha) || !resolvesToCommit(projectDir, candidate.headSha)) {
    return verdict('ambiguous', 'candidate-objects-missing', base);
  }

  const missingObjects = [receipt.terminalHead, ...accepted]
    .filter((sha) => !resolvesToCommit(projectDir, sha));
  if (missingObjects.length) {
    return verdict('ambiguous', 'accepted-objects-missing', { ...base, missingObjects });
  }

  const rangeCommits = new Set(
    (gitOrNull(projectDir, ['rev-list', `${candidate.baseSha}..${candidate.headSha}`]) || '')
      .split('\n')
      .filter(Boolean),
  );
  const rangePatchIds = new Set(
    [...rangeCommits].map((sha) => patchIdOf(projectDir, sha)).filter(Boolean),
  );
  const provedByCommitId = accepted.filter((sha) => rangeCommits.has(sha));
  const provedByPatchId = accepted.filter((sha, index) => !rangeCommits.has(sha) && rangePatchIds.has(patchIds[index]));
  const proved = provedByCommitId.length + provedByPatchId.length;
  const identity = { ...base, provedByCommitId, provedByPatchId };

  if (proved === 0) return verdict('excluded', 'not-in-candidate-range', identity);
  if (proved < accepted.length) return verdict('ambiguous', 'partial-range-membership', identity);

  const patches = accepted.map((sha) => commitPatch(projectDir, sha));
  if (patches.some((patch) => !patch || !patch.trim())) {
    return verdict('ambiguous', 'no-patch-evidence', identity);
  }

  const effect = netEffect(projectDir, candidate.headSha, patches);
  const evidence = { ...identity, netEffect: effect };
  if (effect === 'present') return verdict('selected', 'net-effect-present', evidence);
  if (effect === 'absent') return verdict('excluded', 'net-effect-absent', evidence);
  return verdict('ambiguous', 'net-effect-unprovable', evidence);
}
