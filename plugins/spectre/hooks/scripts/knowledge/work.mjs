import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseKnowledgeRecord, readVerifiedIndexedRecord, refreshKnowledgeIndex } from './records.mjs';
import { atomicWriteJson, resolveProjectStore, withStoreLock } from './store.mjs';

const WORK_ASSOCIATION_FILE_NAME = 'work-associations.json';
const WORK_ASSOCIATION_SCHEMA_VERSION = 1;
const WORK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function validateAssociationIndex(value, indexPath) {
  if (!isPlainObject(value) || value.schemaVersion !== WORK_ASSOCIATION_SCHEMA_VERSION) {
    throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: unsupported work association index`);
  }
  for (const type of ['sourceRuns', 'pullRequests', 'candidates']) {
    if (!isPlainObject(value[type])) {
      throw codedError('WORK_ASSOCIATION_INDEX_INVALID', `${indexPath}: ${type} must be an object`);
    }
    for (const workId of Object.values(value[type])) validateWorkId(workId);
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
    verifiedWorkIds: new Set(),
    verifiedWorkRecords: new Map(),
    unverifiedWorkIds: new Set(),
    unverifiedAssociations: {
      sourceRuns: new Map(),
      pullRequests: new Map(),
      candidates: new Map(),
    },
  };
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

function addRecordAssociations(view, record, target = view) {
  if (record.kind !== 'work') return;
  for (const sourceRunId of record.work.associations.sourceRunIds) {
    addAssociation(view, 'sourceRuns', sourceRunId, record.id, target);
  }
  for (const pullRequestId of record.work.associations.pullRequestIds) {
    addAssociation(view, 'pullRequests', pullRequestId, record.id, target);
  }
  for (const candidate of record.work.associations.candidates) {
    addAssociation(view, 'candidates', candidateAssociationKey(candidate), record.id, target);
  }
}

/**
 * Typed work packages are the durable association authority. The small sidecar remains
 * only for an allocation made before its record exists, so a successful registration
 * cannot be invisible to a fresh resolver.
 */
function associationView(storePath) {
  const view = emptyAssociationView();
  const pending = readAssociationIndex(storePath);
  for (const type of ['sourceRuns', 'pullRequests', 'candidates']) {
    for (const [key, workId] of Object.entries(pending[type])) {
      addAssociation(view, type, key, workId);
    }
  }

  const { index } = refreshKnowledgeIndex(storePath, { persist: false });
  for (const entry of index.records.filter((candidate) => candidate.kind === 'work')) {
    const verified = readVerifiedIndexedRecord(storePath, entry);
    if (verified?.record.kind === 'work') {
      view.verifiedWorkIds.add(verified.record.id);
      view.verifiedWorkRecords.set(verified.record.id, verified.record);
      addRecordAssociations(view, verified.record);
      continue;
    }

    view.unverifiedWorkIds.add(entry.id);
    const recordPath = recordPathForEntry(storePath, entry);
    if (!recordPath) continue;
    try {
      const parsed = parseKnowledgeRecord(recordPath);
      if (parsed.record.kind === 'work') addRecordAssociations(view, parsed.record, view.unverifiedAssociations);
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

function resolveFromIndex(view, options) {
  const associations = requestedAssociations(options);
  const suppliedWorkId = options.workId === undefined ? null : validateWorkId(options.workId);
  if (suppliedWorkId !== null && view.unverifiedWorkIds.has(suppliedWorkId)) {
    throw codedError(
      'WORK_IDENTITY_UNVERIFIED',
      `Work record ${suppliedWorkId} no longer matches its persisted revision.`,
      { workIds: [suppliedWorkId] },
    );
  }
  const resolvedIds = requestedWorkIds(view, associations);
  if (suppliedWorkId !== null) {
    const conflicts = [...resolvedIds].filter((workId) => workId !== suppliedWorkId);
    if (conflicts.length > 0) {
      throw codedError(
        'WORK_IDENTITY_CONFLICT',
        `Supplied work id ${suppliedWorkId} conflicts with an existing exact association.`,
        { workId: suppliedWorkId, conflictingWorkIds: conflicts },
      );
    }
    return {
      status: resolvedIds.size === 0 && !view.verifiedWorkIds.has(suppliedWorkId) ? 'unresolved' : 'resolved',
      workId: suppliedWorkId,
      associations,
    };
  }
  if (resolvedIds.size > 1) {
    throw codedError(
      'WORK_IDENTITY_AMBIGUOUS',
      'Exact associations resolve to different work ids; identify the work id explicitly.',
      { workIds: [...resolvedIds].sort() },
    );
  }
  if (resolvedIds.size === 1) {
    return { status: 'resolved', workId: [...resolvedIds][0], associations };
  }
  return { status: 'unresolved', workId: null, associations };
}

async function resolveStore(options, readOnly) {
  return resolveProjectStore(path.resolve(options.projectDir || process.cwd()), {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
    readOnly,
  });
}

/** Resolves only exact run, PR, or repository/base/head/diff associations. */
export async function resolveWorkIdentity(options) {
  const resolved = await resolveStore(options, true);
  if (!resolved.storePath) return { status: 'unresolved', workId: null };
  return withStoreLock(resolved.storePath, 'resolve-work-identity', async () => {
    const identity = resolveFromIndex(associationView(resolved.storePath).view, options);
    return { status: identity.status, workId: identity.workId };
  }, options.lockOptions);
}

/**
 * Associates an explicit work id or allocates one once. The lock makes a repeated source
 * run or unchanged candidate converge on one identity without branch or recency guesses.
 */
export async function resolveOrAllocateWorkIdentity(options) {
  const resolved = await resolveStore(options, false);
  return withStoreLock(resolved.storePath, 'resolve-work-identity', async () => {
    const { view, pending } = associationView(resolved.storePath);
    const identity = resolveFromIndex(view, options);
    const workId = identity.workId || `work-${crypto.randomUUID()}`;
    let changed = false;
    for (const [type, key] of identity.associations) {
      const existing = view[type].get(key) || new Set();
      const conflicts = [...existing].filter((current) => current !== workId);
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

/** Reject a registration that would split an exact association across verified work IDs. */
export function assertWorkRecordAssociations(storePath, record) {
  if (record.kind !== 'work') return;
  const { view } = associationView(storePath);
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
      const conflicts = [...(view[type].get(key) || [])].filter((workId) => workId !== record.id);
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
