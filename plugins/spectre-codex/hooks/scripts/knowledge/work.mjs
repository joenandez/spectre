import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateDeliveryMembership } from '../workflow/membership.mjs';
import {
  classifyDeliveryReceipt,
  parseKnowledgeRecord,
  readRecordRevision,
  readVerifiedIndexedRecord,
  refreshKnowledgeIndex,
} from './records.mjs';
import { atomicWriteJson, resolveProjectStore, withStoreLock } from './store.mjs';

const WORK_ASSOCIATION_FILE_NAME = 'work-associations.json';
const WORK_ASSOCIATION_SCHEMA_VERSION = 1;
const WORK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** One exact Execute run is the only singular identity key; PR and candidate keys are plural delivery evidence. */
const IDENTITY_ASSOCIATION_TYPES = ['sourceRuns'];

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function emptyAssociationIndex() {
  return {
    schemaVersion: WORK_ASSOCIATION_SCHEMA_VERSION,
    sourceRuns: {},
    pullRequests: {},
    candidates: {},
    branches: {},
    redirects: {},
  };
}

export function workAssociationPath(storePath) {
  return path.join(storePath, WORK_ASSOCIATION_FILE_NAME);
}

function validateWorkId(workId) {
  if (!isNonEmptyString(workId) || !WORK_ID_PATTERN.test(workId)) {
    throw codedError('WORK_ID_INVALID', `Not a canonical work id: ${JSON.stringify(workId)}`);
  }
  return workId;
}

function validateCandidate(candidate) {
  if (!isPlainObject(candidate) || Object.keys(candidate).some((key) =>
    !['repository', 'base', 'head', 'diff'].includes(key))) {
    throw codedError('WORK_CANDIDATE_INVALID', 'A candidate needs only repository, base, head, and diff.');
  }
  for (const field of ['repository', 'base', 'head', 'diff']) {
    if (!isNonEmptyString(candidate[field])) {
      throw codedError('WORK_CANDIDATE_INVALID', `candidate.${field} must be a non-empty string.`);
    }
  }
  return {
    repository: candidate.repository,
    base: candidate.base,
    head: candidate.head,
    diff: candidate.diff,
  };
}

export function candidateAssociationKey(candidate) {
  const normalized = validateCandidate(candidate);
  return JSON.stringify([normalized.repository, normalized.base, normalized.head, normalized.diff]);
}

function requestedAssociations(options) {
  const associations = [];
  if (options.sourceRunId !== undefined) {
    if (!isNonEmptyString(options.sourceRunId)) {
      throw codedError('WORK_ASSOCIATION_INVALID', 'sourceRunId must be a non-empty string.');
    }
    associations.push(['sourceRuns', options.sourceRunId]);
  }
  if (options.pullRequestId !== undefined) {
    if (!isNonEmptyString(options.pullRequestId)) {
      throw codedError('WORK_ASSOCIATION_INVALID', 'pullRequestId must be a non-empty string.');
    }
    associations.push(['pullRequests', options.pullRequestId]);
  }
  if (options.candidate !== undefined) {
    associations.push(['candidates', candidateAssociationKey(options.candidate)]);
  }
  return associations;
}

/** Branch is queryable evidence only; identity resolution never takes a branch key. */
function requestedQueryAssociations(options) {
  const associations = requestedAssociations(options);
  if (options.branch !== undefined) {
    if (!isNonEmptyString(options.branch)) {
      throw codedError('WORK_ASSOCIATION_INVALID', 'branch must be a non-empty string.');
    }
    associations.push(['branches', options.branch]);
  }
  return associations;
}

function validateAssociationIndex(value, indexPath) {
  if (!isPlainObject(value) || value.schemaVersion !== WORK_ASSOCIATION_SCHEMA_VERSION) {
    throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: unsupported work association index`);
  }
  for (const type of ['sourceRuns', 'pullRequests', 'candidates', 'branches', 'redirects']) {
    if (value[type] === undefined && (type === 'branches' || type === 'redirects')) continue;
    if (!isPlainObject(value[type])) {
      throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: ${type} must be an object`);
    }
    for (const workId of Object.values(value[type])) validateWorkId(workId);
  }
  for (const [oldWorkId, canonicalWorkId] of Object.entries(value.redirects || {})) {
    validateWorkId(oldWorkId);
    if (value.redirects[canonicalWorkId] !== undefined) {
      throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: redirects must be one hop`);
    }
  }
  return value;
}

function readAssociationIndex(storePath) {
  const indexPath = workAssociationPath(storePath);
  if (!fs.existsSync(indexPath)) return emptyAssociationIndex();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: malformed JSON: ${error.message}`);
  }
  return validateAssociationIndex(parsed, indexPath);
}

function emptyAssociationView() {
  return {
    sourceRuns: new Map(),
    pullRequests: new Map(),
    candidates: new Map(),
    branches: new Map(),
    legacyBranches: new Map(),
    verifiedWorkIds: new Set(),
    verifiedWorkRecords: new Map(),
    unverifiedWorkIds: new Set(),
    unverifiedAssociations: {
      sourceRuns: new Map(),
      pullRequests: new Map(),
      candidates: new Map(),
      branches: new Map(),
    },
  };
}

function canonicalWorkId(index, workId) {
  const redirected = index.redirects?.[workId];
  return redirected || workId;
}

function associationWorkId(index, type, workId) {
  return type === 'sourceRuns' || type === 'branches' ? canonicalWorkId(index, workId) : workId;
}

function addAssociation(view, type, key, workId, target = view) {
  const values = target[type].get(key) || new Set();
  values.add(workId);
  target[type].set(key, values);
}

function recordPathForEntry(storePath, entry) {
  const absoluteStore = path.resolve(storePath);
  const recordPath = path.resolve(absoluteStore, entry.recordPath || '');
  if (!recordPath.startsWith(`${absoluteStore}${path.sep}`)) return null;
  try {
    const canonicalStore = fs.realpathSync.native(absoluteStore);
    const canonicalRecord = fs.realpathSync.native(recordPath);
    return canonicalRecord.startsWith(`${canonicalStore}${path.sep}`) ? canonicalRecord : null;
  } catch {
    return null;
  }
}

function addRecordAssociations(view, record, target = view, sourceWorkId = record.id) {
  if (record.kind !== 'work') return;
  for (const sourceRunId of record.work.associations.sourceRunIds) {
    addAssociation(view, 'sourceRuns', sourceRunId, sourceWorkId, target);
  }
  for (const pullRequestId of record.work.associations.pullRequestIds) {
    addAssociation(view, 'pullRequests', pullRequestId, record.id, target);
  }
  for (const candidate of record.work.associations.candidates) {
    addAssociation(view, 'candidates', candidateAssociationKey(candidate), record.id, target);
  }
  if (isNonEmptyString(record.provenance?.sourceBranch)) {
    addAssociation(view, 'branches', record.provenance.sourceBranch, sourceWorkId, target);
  }
}

/**
 * Typed work packages are the durable association authority. The small sidecar remains
 * only for an allocation made before its record exists, so a successful registration
 * cannot be invisible to a fresh resolver. Its scalar branch entries are legacy-only
 * evidence: readable for old aggregates, never forward branch authority.
 */
function associationView(storePath) {
  const view = emptyAssociationView();
  const pending = readAssociationIndex(storePath);
  pending.branches ||= {};
  pending.redirects ||= {};
  for (const type of ['sourceRuns', 'pullRequests', 'candidates']) {
    for (const [key, workId] of Object.entries(pending[type])) {
      addAssociation(view, type, key, associationWorkId(pending, type, workId));
    }
  }
  for (const [branch, workId] of Object.entries(pending.branches)) {
    addAssociation(view, 'legacyBranches', branch, associationWorkId(pending, 'branches', workId));
  }

  const { index } = refreshKnowledgeIndex(storePath, { persist: false });
  for (const entry of index.records.filter((candidate) => candidate.kind === 'work')) {
    const verified = readVerifiedIndexedRecord(storePath, entry);
    if (verified?.record.kind === 'work') {
      view.verifiedWorkIds.add(verified.record.id);
      view.verifiedWorkRecords.set(verified.record.id, verified.record);
      addRecordAssociations(view, verified.record, view, canonicalWorkId(pending, verified.record.id));
      continue;
    }

    view.unverifiedWorkIds.add(entry.id);
    const recordPath = recordPathForEntry(storePath, entry);
    if (!recordPath) continue;
    try {
      const parsed = parseKnowledgeRecord(recordPath);
      if (parsed.record.kind === 'work') {
        addRecordAssociations(view, parsed.record, view.unverifiedAssociations, canonicalWorkId(pending, parsed.record.id));
      }
    } catch {
      // An unreadable package cannot safely establish an exact association.
    }
  }
  return { view, pending };
}

function sortedAssociationIndex(index) {
  return {
    schemaVersion: WORK_ASSOCIATION_SCHEMA_VERSION,
    sourceRuns: Object.fromEntries(Object.entries(index.sourceRuns).sort(([left], [right]) => left.localeCompare(right))),
    pullRequests: Object.fromEntries(Object.entries(index.pullRequests).sort(([left], [right]) => left.localeCompare(right))),
    candidates: Object.fromEntries(Object.entries(index.candidates).sort(([left], [right]) => left.localeCompare(right))),
    branches: Object.fromEntries(Object.entries(index.branches).sort(([left], [right]) => left.localeCompare(right))),
    redirects: Object.fromEntries(Object.entries(index.redirects).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function requestedWorkIds(view, associations) {
  const workIds = new Set();
  const unverified = new Set();
  for (const [type, key] of associations) {
    for (const workId of view[type].get(key) || []) workIds.add(workId);
    for (const workId of view.unverifiedAssociations[type].get(key) || []) unverified.add(workId);
  }
  if (unverified.size > 0) {
    throw codedError(
      'WORK_IDENTITY_UNVERIFIED',
      'An exact association points to a work package whose bytes no longer match the persisted revision.',
      { workIds: [...unverified].sort() },
    );
  }
  return workIds;
}

function resolveFromIndex(view, pending, options) {
  const associations = requestedAssociations(options);
  const suppliedWorkId = options.workId === undefined ? null : validateWorkId(options.workId);
  const canonicalSuppliedWorkId = suppliedWorkId === null ? null : canonicalWorkId(pending, suppliedWorkId);
  if (canonicalSuppliedWorkId !== null && view.unverifiedWorkIds.has(canonicalSuppliedWorkId)) {
    throw codedError(
      'WORK_IDENTITY_UNVERIFIED',
      `Work record ${canonicalSuppliedWorkId} no longer matches its persisted revision.`,
      { workIds: [canonicalSuppliedWorkId] },
    );
  }
  const identityAssociations = associations.filter(([type]) => IDENTITY_ASSOCIATION_TYPES.includes(type));
  const matchedWorkIds = [...requestedWorkIds(view, associations)].sort();
  const identityIds = requestedWorkIds(view, identityAssociations);
  if (canonicalSuppliedWorkId !== null) {
    const conflicts = [...identityIds].filter((workId) => workId !== canonicalSuppliedWorkId);
    if (conflicts.length > 0) {
      throw codedError(
        'WORK_IDENTITY_CONFLICT',
        `Supplied work id ${canonicalSuppliedWorkId} conflicts with an existing exact association.`,
        { workId: canonicalSuppliedWorkId, conflictingWorkIds: conflicts },
      );
    }
    return {
      status: identityIds.size === 0 && !view.verifiedWorkIds.has(canonicalSuppliedWorkId) && suppliedWorkId === canonicalSuppliedWorkId ? 'unresolved' : 'resolved',
      workId: canonicalSuppliedWorkId,
      associations,
      matchedWorkIds,
      suppliedWorkId: canonicalSuppliedWorkId,
      ...(suppliedWorkId !== canonicalSuppliedWorkId ? { redirectedFrom: suppliedWorkId } : {}),
    };
  }
  if (identityIds.size > 1) {
    throw codedError(
      'WORK_IDENTITY_AMBIGUOUS',
      'Exact source runs resolve to different work ids; identify the work id explicitly.',
      { workIds: [...identityIds].sort() },
    );
  }
  if (identityIds.size === 1) {
    return { status: 'resolved', workId: [...identityIds][0], associations, matchedWorkIds };
  }
  // An exact run that matches no record always starts its own identity; a shared PR or candidate
  // is delivery evidence for many records and never renames the run.
  if (identityAssociations.length > 0) {
    return { status: 'unresolved', workId: null, associations, matchedWorkIds };
  }
  if (matchedWorkIds.length === 1) {
    return { status: 'resolved', workId: matchedWorkIds[0], associations, matchedWorkIds };
  }
  if (matchedWorkIds.length > 1) {
    return { status: 'plural', workId: null, associations, matchedWorkIds };
  }
  return { status: 'unresolved', workId: null, associations, matchedWorkIds };
}

async function resolveStore(options, readOnly) {
  return resolveProjectStore(path.resolve(options.projectDir || process.cwd()), {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
    readOnly,
  });
}

/**
 * Resolves only exact run, PR, or repository/base/head/diff associations. A PR or candidate
 * shared by several records answers `plural` with every matching id instead of guessing one.
 */
export async function resolveWorkIdentity(options) {
  const resolved = await resolveStore(options, true);
  if (!resolved.storePath) return { status: 'unresolved', workId: null };
  return withStoreLock(resolved.storePath, 'resolve-work-identity', async () => {
    const { view, pending } = associationView(resolved.storePath);
    const identity = resolveFromIndex(view, pending, options);
    return {
      status: identity.status,
      workId: identity.workId,
      ...(identity.status === 'plural' ? { workIds: identity.matchedWorkIds } : {}),
      ...(identity.redirectedFrom ? { redirectedFrom: identity.redirectedFrom } : {}),
    };
  }, options.lockOptions);
}

/**
 * Lists every verified work id that carries the requested exact associations. Delivery keys are
 * plural, so this answers with the whole matching set and never picks one by recency. Branch
 * matches come from verified record provenance; a legacy sidecar branch pointer is reported
 * separately so recovery can read it without it becoming selectable evidence.
 */
export async function listWorkIdentities(options) {
  const resolved = await resolveStore(options, true);
  if (!resolved.storePath) return { ok: true, workIds: [], legacyWorkIds: [] };
  return withStoreLock(resolved.storePath, 'list-work-identities', async () => {
    const { view } = associationView(resolved.storePath);
    const associations = requestedQueryAssociations(options);
    if (associations.length === 0) {
      throw codedError(
        'WORK_QUERY_INVALID',
        'A work identity query needs one exact branch, source run, pull request, or candidate.',
      );
    }
    const workIds = [...requestedWorkIds(view, associations)].sort();
    const legacyWorkIds = [...(view.legacyBranches.get(options.branch) || [])]
      .filter((workId) => !workIds.includes(workId))
      .sort();
    return { ok: true, workIds, legacyWorkIds };
  }, options.lockOptions);
}

/**
 * Record-level delivery selection.
 *
 * The bounded membership predicate answers one question about one receipt and one candidate
 * range. It cannot see whether a record was already delivered, whether it belongs to another
 * branch, or whether it predates receipts entirely. Those are record facts, so they are
 * settled here, before any Git call, and each one keeps its own reason.
 *
 * Every non-`selected` verdict names why membership could not be proven. Nothing falls back
 * to branch ancestry, project recency, or the latest run: an unprovable record stays
 * `ambiguous` and waits for a person.
 */
export const DELIVERY_SELECTION_REASONS = Object.freeze({
  'record-unreadable': 'ambiguous',
  'record-unverified': 'ambiguous',
  'pull-request-associated': 'excluded',
  'receipt-absent': 'excluded',
  'receipt-unusable': 'excluded',
  'branch-mismatch': 'excluded',
  'receipt-start-only': 'ambiguous',
});

/** One recovery sentence per reason, record-level first, then the membership vocabulary. */
const SELECTION_RECOVERY = Object.freeze({
  'record-unreadable': 'The package could not be read as a work record, so it carries no membership evidence.',
  'record-unverified': 'The work package no longer matches its persisted revision; re-register it before delivering it.',
  'pull-request-associated': 'The record already names a pull request, so a later delivery never re-selects it.',
  'receipt-absent': 'The record predates delivery receipts; it stays readable history and is never auto-selected.',
  'receipt-unusable': 'The delivery receipt is unusable, so this run froze no membership evidence.',
  'branch-mismatch': 'The receipt names another branch, so this candidate cannot represent that work.',
  'receipt-start-only': 'The run captured only a start receipt, so its accepted work was never frozen.',
  'receipt-incomplete': 'The receipt has no terminal evidence, so membership cannot be computed.',
  'repo-unreadable': 'Git could not be read from the project directory.',
  'candidate-objects-missing': 'The candidate base or head commit is absent from this checkout.',
  'range-unreadable': 'The candidate commit range could not be listed.',
  'patch-id-unreadable': 'A patch identity could not be computed, so range membership stays unproven.',
  'patch-id-mismatch': 'A persisted patch id no longer matches the commit it claims.',
  'accepted-objects-missing': 'Accepted commits are absent from this checkout and cannot be inspected.',
  'partial-range-membership': 'Only part of the accepted work is inside the candidate range.',
  'patch-unreadable': 'A proved commit patch could not be read.',
  'no-patch-evidence': 'A proved commit carries no patch text to check.',
  'net-effect-unprovable': 'Later commits rewrote the same content, so presence cannot be proven.',
  'net-effect-unreadable': 'The candidate head tree could not be checked.',
  'evaluation-failed': 'Membership evaluation failed before it reached a fact.',
  'not-in-candidate-range': 'No accepted commit of that run is inside the candidate range.',
  'net-effect-absent': 'The accepted work is reverted or otherwise absent from the candidate head.',
});

function recoveryDetail(verdict, reason) {
  if (verdict === 'selected') return null;
  return SELECTION_RECOVERY[reason] || `Membership could not be proven: ${reason}.`;
}

function selectionVerdict(workId, verdict, reason, evidence = {}) {
  return { workId, verdict, reason, recovery: recoveryDetail(verdict, reason), evidence };
}

/** A hostile or half-written record must still answer, so every read is guarded. */
function readWorkId(record) {
  try {
    return isNonEmptyString(record?.id) ? record.id : null;
  } catch {
    return null;
  }
}

/** Any PR association is a permanent boundary: that record is already delivered. */
function isPullRequestAssociated(record) {
  const pullRequestIds = record.work?.associations?.pullRequestIds;
  if (Array.isArray(pullRequestIds) && pullRequestIds.length > 0) return true;
  const state = record.work?.pullRequest?.state;
  return isNonEmptyString(state) && !['none', 'unknown'].includes(state);
}

function evaluateRecord(workId, { projectDir, record, branch, candidate }) {
  if (!isPlainObject(record) || record.kind !== 'work' || !isPlainObject(record.work)) {
    return selectionVerdict(workId, 'ambiguous', 'record-unreadable');
  }
  if (isPullRequestAssociated(record)) {
    return selectionVerdict(workId, 'excluded', 'pull-request-associated', {
      pullRequestIds: [...(record.work.associations?.pullRequestIds || [])].sort(),
    });
  }

  const classified = classifyDeliveryReceipt(record);
  if (classified.state === 'legacy') {
    const reason = classified.reason === 'no-receipt' ? 'receipt-absent' : 'receipt-unusable';
    return selectionVerdict(workId, 'excluded', reason, { receiptState: classified.state, receiptReason: classified.reason });
  }

  const receipt = record.work.deliveryReceipt;
  const recordBranch = isNonEmptyString(receipt?.branch) ? receipt.branch : null;
  if (recordBranch === null || !isNonEmptyString(branch) || recordBranch !== branch) {
    return selectionVerdict(workId, 'excluded', 'branch-mismatch', { recordBranch, branch: isNonEmptyString(branch) ? branch : null });
  }
  if (classified.state === 'start-only') {
    return selectionVerdict(workId, 'ambiguous', 'receipt-start-only', {
      runId: isNonEmptyString(receipt.runId) ? receipt.runId : null,
      receiptState: classified.state,
      receiptReason: classified.reason,
    });
  }

  // The candidate tuple bounds the Git question: base and head are the frozen outgoing shas.
  const membership = evaluateDeliveryMembership({
    projectDir,
    receipt,
    candidate: { baseSha: candidate?.base, headSha: candidate?.head },
  });
  return selectionVerdict(workId, membership.verdict, membership.reason, membership.evidence);
}

/**
 * Total per-record membership verdict. Every input, including a malformed or hostile record,
 * returns exactly one of `selected`, `excluded`, or `ambiguous` with a reason. Nothing throws
 * and nothing returns `undefined`, because a thrown evaluator would leave Ship guessing.
 *
 * @returns {{workId: string|null, verdict: 'selected'|'excluded'|'ambiguous', reason: string, recovery: string|null, evidence: object}}
 */
export function evaluateRecordDeliveryMembership(options) {
  const query = isPlainObject(options) ? options : {};
  const workId = readWorkId(query.record);
  try {
    return evaluateRecord(workId, query);
  } catch (error) {
    return selectionVerdict(workId, 'ambiguous', 'record-unreadable', {
      failure: error?.code || error?.name || 'error',
    });
  }
}

function emptySelection(branch, candidateKey) {
  return { ok: true, branch, candidateKey, evaluations: [], selected: [], excluded: [], ambiguous: [] };
}

function selectionOrderKey(evaluation) {
  return typeof evaluation.workId === 'string' ? evaluation.workId : '';
}

/**
 * Evaluates every work record in the store against one branch and one frozen candidate tuple.
 *
 * The answer is ordered by work id, never by index iteration or recency, so repeating the
 * query against the same tuple returns the same ordered set and the same evidence. A record
 * whose bytes no longer match its persisted revision is reported `ambiguous`, never dropped
 * and never selected.
 */
export async function listDeliveryMembership(options = {}) {
  const query = isPlainObject(options) ? options : {};
  if (!isNonEmptyString(query.branch)) {
    throw codedError('WORK_QUERY_INVALID', 'A delivery membership query needs the exact current branch.');
  }
  const candidate = validateCandidate(query.candidate);
  const candidateKey = candidateAssociationKey(candidate);
  const projectDir = path.resolve(query.projectDir || process.cwd());
  const resolved = await resolveStore(query, true);
  if (!resolved.storePath) return emptySelection(query.branch, candidateKey);

  return withStoreLock(resolved.storePath, 'list-delivery-membership', async () => {
    const { view } = associationView(resolved.storePath);
    const evaluations = [];
    for (const record of view.verifiedWorkRecords.values()) {
      evaluations.push(evaluateRecordDeliveryMembership({ projectDir, record, branch: query.branch, candidate }));
    }
    for (const workId of view.unverifiedWorkIds) {
      evaluations.push(selectionVerdict(workId, 'ambiguous', 'record-unverified'));
    }
    evaluations.sort((left, right) => {
      const leftKey = selectionOrderKey(left);
      const rightKey = selectionOrderKey(right);
      if (leftKey < rightKey) return -1;
      return leftKey > rightKey ? 1 : 0;
    });
    const idsFor = (verdict) => evaluations
      .filter((evaluation) => evaluation.verdict === verdict)
      .map((evaluation) => evaluation.workId);
    return {
      ok: true,
      branch: query.branch,
      candidateKey,
      evaluations,
      selected: idsFor('selected'),
      excluded: idsFor('excluded'),
      ambiguous: idsFor('ambiguous'),
    };
  }, query.lockOptions);
}

/**
 * Associates an explicit work id or allocates one once. The lock makes a repeated source
 * run or unchanged candidate converge on one identity without branch or recency guesses.
 * A new exact source run always allocates its own id, so an unrelated run on the same
 * branch can never inherit or overwrite another run's record.
 */
export async function resolveOrAllocateWorkIdentity(options) {
  const resolved = await resolveStore(options, false);
  return withStoreLock(resolved.storePath, 'resolve-work-identity', async () => {
    const { view, pending } = associationView(resolved.storePath);
    const identity = resolveFromIndex(view, pending, options);
    if (identity.status === 'plural') {
      throw codedError(
        'WORK_IDENTITY_AMBIGUOUS',
        'That PR or candidate is shared by several work records; identify the work id or exact source run.',
        { workIds: identity.matchedWorkIds },
      );
    }
    // A PR or candidate is delivery evidence for many runs, so one match is never permission to
    // write this run's account over that record. Only an explicit id or exact run may claim it.
    const deliveryOnly = identity.associations.length > 0
      && !identity.associations.some(([type]) => IDENTITY_ASSOCIATION_TYPES.includes(type));
    if (deliveryOnly && identity.suppliedWorkId === undefined && identity.matchedWorkIds.length > 0) {
      throw codedError(
        'WORK_IDENTITY_REQUIRED',
        `That PR or candidate already names ${identity.matchedWorkIds.join(', ')}; supply --work-id to update it or --source-run-id to record this run.`,
        { workIds: identity.matchedWorkIds },
      );
    }
    const workId = identity.workId || `work-${crypto.randomUUID()}`;
    let changed = false;
    for (const [type, key] of identity.associations) {
      const existing = view[type].get(key) || new Set();
      const conflicts = IDENTITY_ASSOCIATION_TYPES.includes(type)
        ? [...existing].filter((current) => current !== workId)
        : [];
      if (conflicts.length > 0) {
        throw codedError(
          'WORK_IDENTITY_CONFLICT',
          `Exact ${type} association is already assigned to ${conflicts.join(', ')}.`,
          { workId, conflictingWorkIds: conflicts },
        );
      }
      if (!pending[type][key] && existing.size === 0) {
        pending[type][key] = workId;
        changed = true;
      }
    }
    if (changed) atomicWriteJson(workAssociationPath(resolved.storePath), sortedAssociationIndex(pending));
    return {
      ok: true,
      status: identity.status === 'resolved' && !changed ? 'noop' : identity.status === 'resolved' ? 'updated' : 'created',
      workId,
      storePath: resolved.storePath,
      associationPath: workAssociationPath(resolved.storePath),
    };
  }, options.lockOptions);
}

function applyFoldToPending(storePath, canonicalWorkId, oldWorkIds) {
  const pending = readAssociationIndex(storePath);
  pending.branches ||= {};
  pending.redirects ||= {};
  if (pending.redirects[canonicalWorkId] !== undefined) {
    throw codedError('WORK_FOLD_CONFLICT', `Canonical work id ${canonicalWorkId} already redirects elsewhere.`);
  }
  for (const oldWorkId of oldWorkIds) {
    if (pending.redirects[oldWorkId] && pending.redirects[oldWorkId] !== canonicalWorkId) {
      throw codedError('WORK_FOLD_CONFLICT', `Work id ${oldWorkId} already redirects elsewhere.`);
    }
  }
  let changed = false;
  for (const [key, workId] of Object.entries(pending.sourceRuns)) {
    if (oldWorkIds.includes(workId)) {
      pending.sourceRuns[key] = canonicalWorkId;
      changed = true;
    }
  }
  for (const [redirectedWorkId, targetWorkId] of Object.entries(pending.redirects)) {
    if (oldWorkIds.includes(targetWorkId)) {
      pending.redirects[redirectedWorkId] = canonicalWorkId;
      changed = true;
    }
  }
  for (const oldWorkId of oldWorkIds) {
    if (pending.redirects[oldWorkId] !== canonicalWorkId) {
      pending.redirects[oldWorkId] = canonicalWorkId;
      changed = true;
    }
  }
  if (changed) atomicWriteJson(workAssociationPath(storePath), sortedAssociationIndex(pending));
  return changed;
}

/** Fold is duplicate-identity recovery: every folded record must already claim one of the canonical record's exact runs. */
function assertFoldableWorkRecords(view, pending, canonicalWorkId, oldWorkIds) {
  const requestedWorkIds = [canonicalWorkId, ...oldWorkIds];
  const unverifiedWorkIds = requestedWorkIds.filter((workId) => view.unverifiedWorkIds.has(workId));
  if (unverifiedWorkIds.length > 0) {
    throw codedError(
      'WORK_IDENTITY_UNVERIFIED',
      'A named work record no longer matches its persisted revision.',
      { workIds: unverifiedWorkIds.sort() },
    );
  }
  const missingWorkIds = requestedWorkIds.filter((workId) => !view.verifiedWorkRecords.has(workId));
  if (missingWorkIds.length > 0) {
    throw codedError(
      'WORK_FOLD_RECORD_MISSING',
      'Every named work id must resolve to a verified work package before folding.',
      { workIds: missingWorkIds.sort() },
    );
  }
  if (pending.redirects?.[canonicalWorkId] !== undefined) {
    throw codedError('WORK_FOLD_CONFLICT', `Canonical work id ${canonicalWorkId} already redirects elsewhere.`);
  }
  const canonicalSourceRunIds = new Set(
    view.verifiedWorkRecords.get(canonicalWorkId).work.associations.sourceRunIds,
  );
  for (const oldWorkId of oldWorkIds) {
    const record = view.verifiedWorkRecords.get(oldWorkId);
    if (pending.redirects?.[oldWorkId] && pending.redirects[oldWorkId] !== canonicalWorkId) {
      throw codedError('WORK_FOLD_CONFLICT', `Work id ${oldWorkId} already redirects elsewhere.`);
    }
    if (record.work.associations.pullRequestIds.length > 0 ||
      !['none', 'unknown'].includes(record.work.pullRequest.state)) {
      throw codedError(
        'WORK_FOLD_PERMANENT_BOUNDARY',
        `Work id ${oldWorkId} is PR-bound or terminal and cannot be folded.`,
        { workId: oldWorkId },
      );
    }
    if (record.work.associations.candidates.length > 0) {
      throw codedError(
        'WORK_FOLD_CANDIDATE_BOUNDARY',
        `Work id ${oldWorkId} has a candidate association and cannot be folded.`,
        { workId: oldWorkId },
      );
    }
    if (!record.work.associations.sourceRunIds.some((sourceRunId) => canonicalSourceRunIds.has(sourceRunId))) {
      throw codedError(
        'WORK_FOLD_DISTINCT_RUNS',
        `Work id ${oldWorkId} shares no exact source run with ${canonicalWorkId}; fold only recovers duplicate records of one exact run.`,
        { workId: oldWorkId, canonicalWorkId },
      );
    }
  }
}

function foldedWorkRecord(view, canonicalWorkId, oldWorkIds) {
  const canonical = view.verifiedWorkRecords.get(canonicalWorkId);
  if (!canonical) return null;
  const sourceRunIds = new Set(canonical.work.associations.sourceRunIds);
  for (const oldWorkId of oldWorkIds) {
    for (const sourceRunId of view.verifiedWorkRecords.get(oldWorkId)?.work.associations.sourceRunIds || []) {
      sourceRunIds.add(sourceRunId);
    }
  }
  if (sourceRunIds.size === canonical.work.associations.sourceRunIds.length) return null;
  const mergedSourceRunIds = [...sourceRunIds].sort();
  const record = structuredClone(canonical);
  record.work.associations.sourceRunIds = mergedSourceRunIds;
  record.provenance = { ...record.provenance, sourceRunIds: mergedSourceRunIds };
  record.applicability = { ...record.applicability, runIds: mergedSourceRunIds };
  return record;
}

function writeFoldProposal(storePath, record) {
  const sourceDir = path.join(storePath, 'knowledge', record.id);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-work-fold-'));
  const proposal = path.join(root, record.id);
  fs.cpSync(sourceDir, proposal, { recursive: true });
  fs.writeFileSync(path.join(proposal, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { root, proposal };
}

/** Explicit recovery: fold source provenance into a named canonical record, then redirect old ids. */
export async function foldWorkIdentities(options) {
  if (!Array.isArray(options.oldWorkIds) || options.oldWorkIds.length === 0) {
    throw codedError('WORK_FOLD_INVALID', 'oldWorkIds must name at least one provisional work id.');
  }
  const canonicalWorkId = validateWorkId(options.canonicalWorkId);
  const oldWorkIds = [...new Set(options.oldWorkIds.map(validateWorkId))];
  if (oldWorkIds.includes(canonicalWorkId)) {
    throw codedError('WORK_FOLD_INVALID', 'A canonical work id cannot be folded into itself.');
  }
  const resolved = await resolveStore(options, false);
  const prepared = await withStoreLock(resolved.storePath, 'prepare-fold-work-identities', async () => {
    const { view, pending } = associationView(resolved.storePath);
    assertFoldableWorkRecords(view, pending, canonicalWorkId, oldWorkIds);
    return {
      record: foldedWorkRecord(view, canonicalWorkId, oldWorkIds),
      expectedRevision: readRecordRevision(path.join(resolved.storePath, 'knowledge', canonicalWorkId)),
    };
  }, options.lockOptions);
  const { record } = prepared;
  if (!record) {
    return withStoreLock(resolved.storePath, 'fold-work-identities', async () => {
      const { view, pending } = associationView(resolved.storePath);
      assertFoldableWorkRecords(view, pending, canonicalWorkId, oldWorkIds);
      const changed = applyFoldToPending(resolved.storePath, canonicalWorkId, oldWorkIds);
      return { ok: true, status: changed ? 'updated' : 'noop', workId: canonicalWorkId, foldedWorkIds: oldWorkIds };
    }, options.lockOptions);
  }
  const proposal = writeFoldProposal(resolved.storePath, record);
  try {
    const { registerCanonicalKnowledge } = await import('./registration.mjs');
    const registration = await registerCanonicalKnowledge({
      projectDir: options.projectDir,
      spectreHome: options.spectreHome,
      gitRunner: options.gitRunner,
      allocationLockOptions: options.allocationLockOptions,
      recordPath: proposal.proposal,
      expectedRevision: prepared.expectedRevision,
      foldFromWorkIds: oldWorkIds,
      lockOptions: options.lockOptions,
      afterIndexRefresh: () => applyFoldToPending(resolved.storePath, canonicalWorkId, oldWorkIds),
    });
    return { ok: true, status: registration.status, workId: canonicalWorkId, foldedWorkIds: oldWorkIds };
  } finally {
    fs.rmSync(proposal.root, { recursive: true, force: true });
  }
}

/** Reject a registration that would split one exact source run across verified work IDs. */
export function assertWorkRecordAssociations(storePath, record, options = {}) {
  if (record.kind !== 'work') return;
  const { view, pending } = associationView(storePath);
  if (options.foldFromWorkIds?.length > 0) {
    assertFoldableWorkRecords(view, pending, record.id, options.foldFromWorkIds);
  }
  const prior = view.verifiedWorkRecords.get(record.id);
  if (prior) {
    const next = record.work.associations;
    const priorCandidateKeys = new Set(prior.work.associations.candidates.map(candidateAssociationKey));
    const nextCandidateKeys = new Set(next.candidates.map(candidateAssociationKey));
    const missing = [
      ...prior.work.associations.sourceRunIds
        .filter((value) => !next.sourceRunIds.includes(value))
        .map((value) => `source run ${value}`),
      ...prior.work.associations.pullRequestIds
        .filter((value) => !next.pullRequestIds.includes(value))
        .map((value) => `pull request ${value}`),
      ...[...priorCandidateKeys]
        .filter((value) => !nextCandidateKeys.has(value))
        .map(() => 'candidate'),
    ];
    if (missing.length > 0) {
      throw codedError(
        'WORK_IDENTITY_ASSOCIATION_REMOVED',
        `Work record ${record.id} must retain established exact associations: ${missing.join(', ')}.`,
        { workId: record.id },
      );
    }
  }
  const requested = emptyAssociationView();
  addRecordAssociations(requested, record);
  for (const type of ['sourceRuns', 'pullRequests', 'candidates']) {
    for (const [key] of requested[type]) {
      const unverified = view.unverifiedAssociations[type].get(key);
      if (unverified?.size) {
        throw codedError(
          'WORK_IDENTITY_UNVERIFIED',
          'An exact association points to a work package whose bytes no longer match the persisted revision.',
          { workIds: [...unverified].sort() },
        );
      }
      if (!IDENTITY_ASSOCIATION_TYPES.includes(type)) continue;
      const foldFrom = new Set(options.foldFromWorkIds || []);
      const conflicts = [...(view[type].get(key) || [])]
        .filter((workId) => workId !== record.id && !foldFrom.has(workId));
      if (conflicts.length > 0) {
        throw codedError(
          'WORK_IDENTITY_CONFLICT',
          `Exact ${type} association is already assigned to ${conflicts.join(', ')}.`,
          { workId: record.id, conflictingWorkIds: conflicts },
        );
      }
    }
  }
}

export { WORK_ASSOCIATION_FILE_NAME, WORK_ASSOCIATION_SCHEMA_VERSION };
