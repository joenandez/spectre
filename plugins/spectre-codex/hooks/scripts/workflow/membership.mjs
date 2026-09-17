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
 *   2. Net effect in the candidate head tree. The patches of the proved in-range commits
 *      are checked against a scratch index read from `candidate.headSha`. A clean reverse
 *      apply proves the work is present; a clean forward apply proves it is absent
 *      (reverted). Anything else is unprovable.
 *
 * Both facts must agree. Missing objects, an incomplete receipt, partial range membership,
 * or contradictory apply results fail closed to `ambiguous` for explicit correction.
 *
 * A Git failure is never a fact. Every Git call reports whether it ran separately from what
 * it printed, so a timeout, a spawn error, a `maxBuffer` overflow, or a fatal exit can only
 * produce an `ambiguous` verdict. Only a command that ran to completion may produce
 * `excluded`.
 *
 * Once an accepted commit is proved by patch id its own object is never needed again: the
 * patch comes from the matched in-range commit, so the predicate still answers after the
 * pre-rebase commit is garbage-collected. That is the reason the receipt persists patch
 * ids at all.
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
    'terminalHead',
    'acceptedCommits',
    'acceptedPatchIds',
  ]),
  optional: Object.freeze(['startHead']),
  roles: Object.freeze({
    runId: 'Exact Execute run identity that owns this record.',
    branch: 'Branch the run executed on; membership evidence, never a selector.',
    terminalHead: 'HEAD at the terminal or blocked capture; absent marks a start-only receipt, which is never complete evidence.',
    acceptedCommits: 'Accepted task commit ids from the Execute event log. Array order is evidence only: apply order is derived from `git rev-list --topo-order`, never from this field.',
    acceptedPatchIds: 'Stable `git patch-id --stable` per accepted commit, index-aligned. Recomputed and compared whenever the accepted object still resolves locally.',
    startHead: 'HEAD at run start; bounded recovery context, never a decision input.',
  }),
  verdicts: Object.freeze(['selected', 'excluded', 'ambiguous']),
});

/** The closed reason vocabulary, each mapped to the one verdict it can carry. */
export const DELIVERY_MEMBERSHIP_REASONS = Object.freeze({
  'receipt-incomplete': 'ambiguous',
  'repo-unreadable': 'ambiguous',
  'candidate-objects-missing': 'ambiguous',
  'range-unreadable': 'ambiguous',
  'patch-id-unreadable': 'ambiguous',
  'patch-id-mismatch': 'ambiguous',
  'accepted-objects-missing': 'ambiguous',
  'partial-range-membership': 'ambiguous',
  'patch-unreadable': 'ambiguous',
  'no-patch-evidence': 'ambiguous',
  'net-effect-unprovable': 'ambiguous',
  'net-effect-unreadable': 'ambiguous',
  'evaluation-failed': 'ambiguous',
  'not-in-candidate-range': 'excluded',
  'net-effect-absent': 'excluded',
  'net-effect-present': 'selected',
});

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** A generated file or a lockfile makes a multi-megabyte commit patch routine. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** One frozen candidate is evaluated against many records, so the range scan is shared. */
const RANGE_INDEX_CACHE = new Map();
const RANGE_INDEX_CACHE_LIMIT = 8;

let gitCalls = 0;
let rangeScans = 0;

function debugLog(event, fields) {
  if (!process.env.SPECTRE_DEBUG) return;
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

/**
 * Run one Git command and report whether it ran separately from what it printed.
 *
 * @returns {{ok: boolean, stdout: string, status: number|null, failure: string|null}}
 */
function git(cwd, args, { input, env } = {}) {
  gitCalls += 1;
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      // An ambient GIT_DIR or GIT_WORK_TREE would redirect evaluation to another repository.
      env: { ...process.env, ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      ...(input === undefined ? {} : { input }),
    });
    return { ok: true, stdout, status: 0, failure: null };
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : null;
    const failure = error?.code || (error?.signal ? `signal:${error.signal}` : 'git-failed');
    debugLog('membership.git_failed', { command: args[0], status, failure });
    return { ok: false, stdout: '', status, failure };
  }
}

/** Evaluate from the repository root, not from an arbitrary subdirectory of it. */
function repoRootOf(projectDir) {
  const result = git(projectDir, ['rev-parse', '--show-toplevel']);
  const root = result.stdout.trim();
  return result.ok && root ? root : null;
}

function resolvesToCommit(repoRoot, sha) {
  return SHA_PATTERN.test(sha || '') && git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/**
 * The exact patch text both the receipt's patch id and the net-effect check are built from.
 * External diff drivers and textconv filters are refused so the text cannot be rewritten.
 */
function commitPatch(repoRoot, sha) {
  return git(repoRoot, [
    'diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary',
    '--no-ext-diff', '--no-textconv', sha,
  ]);
}

/**
 * @returns {{ok: boolean, id: string|null}} `ok: false` means Git failed; `id: null` with
 * `ok: true` means the commit genuinely has no patch (an empty commit or a merge).
 */
function patchIdOf(repoRoot, sha) {
  const patch = commitPatch(repoRoot, sha);
  if (!patch.ok) return { ok: false, id: null };
  if (!patch.stdout.trim()) return { ok: true, id: null };
  const output = git(repoRoot, ['patch-id', '--stable'], { input: patch.stdout });
  if (!output.ok) return { ok: false, id: null };
  const [id] = output.stdout.trim().split(/\s+/);
  return { ok: true, id: id || null };
}

/**
 * Patch id per in-range commit, computed only when some accepted commit still needs it and
 * memoized per repository and candidate range.
 *
 * @returns {{ok: boolean, byPatchId: Map<string, string>}}
 */
function rangePatchIndex(repoRoot, rangeOrder, cacheKey) {
  const cached = RANGE_INDEX_CACHE.get(cacheKey);
  if (cached) return cached;

  rangeScans += 1;
  debugLog('membership.range_scan', { cacheKey, commits: rangeOrder.length });
  const byPatchId = new Map();
  let ok = true;
  for (const sha of rangeOrder) {
    const { ok: readable, id } = patchIdOf(repoRoot, sha);
    if (!readable) {
      ok = false;
      break;
    }
    if (id && !byPatchId.has(id)) byPatchId.set(id, sha);
  }

  const index = { ok, byPatchId };
  RANGE_INDEX_CACHE.set(cacheKey, index);
  if (RANGE_INDEX_CACHE.size > RANGE_INDEX_CACHE_LIMIT) {
    RANGE_INDEX_CACHE.delete(RANGE_INDEX_CACHE.keys().next().value);
  }
  return index;
}

function verdict(state, reason, evidence) {
  debugLog('membership.evaluated', { verdict: state, reason, ...evidence });
  return { verdict: state, reason, evidence };
}

/** `git apply --check` exits 1 when the patch does not apply and 128 when it cannot judge. */
function applies(result) {
  if (result.ok) return true;
  if (result.status === 1) return false;
  return null;
}

/**
 * Check the proved in-range patches against a scratch index built from the candidate head
 * tree. The working tree is never touched, and no path throws.
 *
 * @returns {'present'|'absent'|'unprovable'|'unreadable'}
 */
function netEffect(repoRoot, headSha, oldestFirstPatches) {
  let scratch = null;
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-membership-index-'));
    const indexFile = path.join(scratch, 'index');
    const withScratchIndex = (args, input) => git(repoRoot, args, { input, env: { GIT_INDEX_FILE: indexFile } });
    if (!withScratchIndex(['read-tree', headSha]).ok) return 'unreadable';

    // `git apply --reverse` reverses the order of the patches it is given, so both the
    // presence check and the absence check read the same oldest-first text.
    const oldestFirst = oldestFirstPatches.join('');
    const present = applies(withScratchIndex(['apply', '--cached', '--check', '--reverse', '-'], oldestFirst));
    const absent = applies(withScratchIndex(['apply', '--cached', '--check', '-'], oldestFirst));
    if (present === null || absent === null) return 'unreadable';
    if (present && !absent) return 'present';
    if (absent && !present) return 'absent';
    return 'unprovable';
  } catch (error) {
    debugLog('membership.net_effect_failed', { failure: error?.code || error?.name, stack: error?.stack });
    return 'unreadable';
  } finally {
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        debugLog('membership.scratch_cleanup_failed', { failure: error?.code || error?.name });
      }
    }
  }
}

function evaluate({ projectDir, receipt, candidate }) {
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
    && Boolean(receipt?.terminalHead)
    && accepted.length > 0
    && patchIds.length === accepted.length;
  if (!complete) return verdict('ambiguous', 'receipt-incomplete', base);

  const repoRoot = repoRootOf(projectDir);
  if (!repoRoot) return verdict('ambiguous', 'repo-unreadable', base);

  if (!resolvesToCommit(repoRoot, candidate.baseSha) || !resolvesToCommit(repoRoot, candidate.headSha)) {
    return verdict('ambiguous', 'candidate-objects-missing', base);
  }

  const range = git(repoRoot, ['rev-list', '--topo-order', `${candidate.baseSha}..${candidate.headSha}`]);
  if (!range.ok) return verdict('ambiguous', 'range-unreadable', base);

  // Newest first, so apply order is this order reversed.
  const rangeOrder = range.stdout.split('\n').filter(Boolean);
  const rangePosition = new Map(rangeOrder.map((sha, position) => [sha, position]));

  const patchSourceOf = new Map();
  const provedByCommitId = [];
  const unproved = [];
  accepted.forEach((sha, index) => {
    if (rangePosition.has(sha)) {
      provedByCommitId.push(sha);
      patchSourceOf.set(sha, sha);
      return;
    }
    unproved.push({ sha, claimedPatchId: patchIds[index] });
  });

  const provedByPatchId = [];
  const missingObjects = [];
  if (unproved.length) {
    const cacheKey = `${repoRoot}::${candidate.baseSha}..${candidate.headSha}`;
    const index = rangePatchIndex(repoRoot, rangeOrder, cacheKey);
    if (!index.ok) return verdict('ambiguous', 'patch-id-unreadable', { ...base, provedByCommitId });

    for (const { sha, claimedPatchId } of unproved) {
      const resolvesLocally = resolvesToCommit(repoRoot, sha);
      if (resolvesLocally) {
        // A stale or differently generated id must not be read as an absence of the work.
        const recomputed = patchIdOf(repoRoot, sha);
        if (!recomputed.ok) return verdict('ambiguous', 'patch-id-unreadable', { ...base, commit: sha });
        if (recomputed.id !== claimedPatchId) {
          return verdict('ambiguous', 'patch-id-mismatch', { ...base, commit: sha });
        }
      }
      const match = claimedPatchId ? index.byPatchId.get(claimedPatchId) : undefined;
      if (match) {
        provedByPatchId.push(sha);
        patchSourceOf.set(sha, match);
      } else if (!resolvesLocally) {
        // Unproved and uninspectable: absence cannot be told apart from a stale receipt.
        missingObjects.push(sha);
      }
    }
  }

  const proved = provedByCommitId.length + provedByPatchId.length;
  const identity = { ...base, provedByCommitId, provedByPatchId };
  if (missingObjects.length) {
    return verdict('ambiguous', 'accepted-objects-missing', { ...identity, missingObjects });
  }
  if (proved === 0) return verdict('excluded', 'not-in-candidate-range', identity);
  if (proved < accepted.length) return verdict('ambiguous', 'partial-range-membership', identity);

  const patchSources = [...new Set(accepted.map((sha) => patchSourceOf.get(sha)))]
    .sort((left, right) => rangePosition.get(right) - rangePosition.get(left));
  const sourced = { ...identity, patchSources };

  const patches = patchSources.map((sha) => commitPatch(repoRoot, sha));
  if (patches.some((patch) => !patch.ok)) return verdict('ambiguous', 'patch-unreadable', sourced);
  const patchText = patches.map((patch) => patch.stdout);
  if (patchText.some((patch) => !patch.trim())) return verdict('ambiguous', 'no-patch-evidence', sourced);

  const effect = netEffect(repoRoot, candidate.headSha, patchText);
  const evidence = { ...sourced, netEffect: effect };
  if (effect === 'present') return verdict('selected', 'net-effect-present', evidence);
  if (effect === 'absent') return verdict('excluded', 'net-effect-absent', evidence);
  if (effect === 'unreadable') return verdict('ambiguous', 'net-effect-unreadable', evidence);
  return verdict('ambiguous', 'net-effect-unprovable', evidence);
}

/**
 * Evaluate one delivery receipt against one frozen candidate tuple.
 *
 * @param {{projectDir: string, receipt: object, candidate: {baseSha: string, headSha: string}}} options
 * @returns {{verdict: 'selected'|'excluded'|'ambiguous', reason: string, evidence: object}}
 */
export function evaluateDeliveryMembership({ projectDir, receipt, candidate }) {
  try {
    return evaluate({ projectDir, receipt, candidate });
  } catch (error) {
    const failure = error?.code || error?.name || 'error';
    debugLog('membership.evaluation_failed', { failure, stack: error?.stack });
    return verdict('ambiguous', 'evaluation-failed', {
      runId: receipt?.runId || null,
      baseSha: candidate?.baseSha || null,
      headSha: candidate?.headSha || null,
      failure,
    });
  }
}

/** Spawn and scan counters, so callers can prove the range scan stayed lazy and shared. */
export function readMembershipDiagnostics() {
  return { gitCalls, rangeScans, cachedRanges: RANGE_INDEX_CACHE.size };
}

/** Drop the memoized range scans and reset the counters; a history rewrite invalidates them. */
export function clearMembershipCaches() {
  RANGE_INDEX_CACHE.clear();
  gitCalls = 0;
  rangeScans = 0;
}
