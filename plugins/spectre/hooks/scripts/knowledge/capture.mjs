import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  estimateRenderedRecordTokens,
  parseKnowledgeRecord,
  revisionTokenFor,
  validateKnowledgeRecord,
} from './records.mjs';
import { registerCanonicalKnowledge } from './registration.mjs';
import { resolveProjectStore } from './store.mjs';
import { ensureTags, loadTagCatalog, resolveTagId } from './tags.mjs';
import { resolveOrAllocateWorkIdentity, resolveWorkIdentity } from './work.mjs';

const INPUT_VERSION = 1;
const WORK_FIELDS = [
  'requestedOutcome', 'scope', 'actualChanges', 'reasons', 'discoveries',
  'verification', 'remainingWork', 'relatedContext',
];
const KNOWLEDGE_FIELDS = new Set([
  'inputVersion', 'id', 'title', 'summary', 'category', 'useWhen', 'content',
  'evidence', 'tags', 'status', 'blocker', 'relatedRecordIds', 'applicability',
]);
const WORK_INPUT_FIELDS = new Set([
  'inputVersion', 'title', 'summary', ...WORK_FIELDS, 'tags', 'execution',
  'verificationState', 'pullRequest', 'relatedRecordIds',
]);
const PLACEHOLDER = /^(?:<[^>]+>|{{[^}]+}}|TODO|REPLACE[_ -]?ME)$/i;
const UNKNOWN_STATE = { state: 'unknown' };
const WORK_RECORD_TOKEN_LIMIT = 2_000;

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

function readInput(inputPath) {
  if (!inputPath) throw codedError('CAPTURE_INPUT_INVALID', 'Missing required --input <json>.');
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('must be a JSON object');
    return parsed;
  } catch (error) {
    if (error?.code === 'CAPTURE_INPUT_INVALID') throw error;
    throw codedError('CAPTURE_INPUT_INVALID', `Cannot read semantic capture input ${inputPath}: ${error.message}`);
  }
}

function assertAllowedInput(input, kind, { tagsRequired }) {
  const allowed = kind === 'knowledge' ? KNOWLEDGE_FIELDS : WORK_INPUT_FIELDS;
  if (!isPlainObject(input) || input.inputVersion !== INPUT_VERSION) {
    throw codedError('CAPTURE_INPUT_INVALID', `Capture input must use inputVersion ${INPUT_VERSION}.`);
  }
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw codedError('CAPTURE_INPUT_INVALID', `Capture input has unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
  for (const field of ['title', 'summary', ...(kind === 'knowledge'
    ? ['id', 'category', 'useWhen', 'content', 'evidence']
    : WORK_FIELDS)]) {
    if (!isNonEmptyString(input[field])) {
      throw codedError('CAPTURE_INPUT_INVALID', `Capture input requires a non-empty ${field}.`);
    }
  }
  assertNoPlaceholder(input);
  validateTagIntent(input.tags, { required: tagsRequired });
}

function assertNoPlaceholder(value, field = 'input') {
  if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) {
    throw codedError('CAPTURE_INPUT_INVALID', `Capture input contains an unfilled placeholder at ${field}.`);
  }
  if (Array.isArray(value)) value.forEach((item, index) => assertNoPlaceholder(item, `${field}[${index}]`));
  else if (isPlainObject(value)) Object.entries(value).forEach(([key, item]) => assertNoPlaceholder(item, `${field}.${key}`));
}

function validateTagIntent(tags, { required }) {
  if (tags === undefined && !required) return;
  if (!Array.isArray(tags) || tags.length === 0) {
    throw codedError('CAPTURE_INPUT_INVALID', 'Capture input requires a non-empty tags array. Omit tags only when preserving an existing record.');
  }
  for (const tag of tags) {
    if (!isPlainObject(tag) || Object.keys(tag).some((key) => !['id', 'description', 'aliases'].includes(key)) || !isNonEmptyString(tag.id)) {
      throw codedError('CAPTURE_INPUT_INVALID', 'Each tag intent needs id and may contain only description and aliases.');
    }
    if (tag.description !== undefined && !isNonEmptyString(tag.description)) {
      throw codedError('CAPTURE_INPUT_INVALID', `Tag ${tag.id} has an invalid description.`);
    }
    if (tag.aliases !== undefined && (!Array.isArray(tag.aliases) || tag.aliases.some((alias) => !isNonEmptyString(alias)))) {
      throw codedError('CAPTURE_INPUT_INVALID', `Tag ${tag.id} has invalid aliases.`);
    }
  }
}

function requestedAssociations(options) {
  return {
    sourceRunIds: options.sourceRunId === undefined ? [] : [options.sourceRunId],
    pullRequestIds: options.pullRequestId === undefined ? [] : [options.pullRequestId],
    candidates: options.candidate === undefined ? [] : [options.candidate],
  };
}

function hasExactAssociation(associations) {
  return associations.sourceRunIds.length > 0
    || associations.pullRequestIds.length > 0
    || associations.candidates.length > 0;
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...left, ...right])];
}

function mergeCandidates(left = [], right = []) {
  const found = new Map();
  for (const candidate of [...left, ...right]) found.set(JSON.stringify(candidate), candidate);
  return [...found.values()];
}

function existingRecord(storePath, id) {
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return null;
  const recordPath = path.join(storePath, 'knowledge', id, 'record.json');
  if (!fs.existsSync(recordPath)) return null;
  return { ...parseKnowledgeRecord(recordPath), recordDir: path.dirname(recordPath) };
}

function storeOptions(options) {
  return {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
  };
}

function nowIso(options) {
  return new Date(typeof options.now === 'function' ? options.now() : Date.now()).toISOString();
}

async function canonicalTags({ projectDir, tags, existingTags, lockOptions, ...options }) {
  if (tags === undefined) return { tags: [...existingTags], tagOutcomes: [] };
  const loaded = await loadTagCatalog({ projectDir, readOnly: false, ...storeOptions(options) });
  const known = [];
  const unknown = [];
  for (const intent of tags) {
    const resolved = resolveTagId(loaded.catalog, intent.id);
    if (resolved && (!intent.aliases || intent.aliases.length === 0)) known.push({ id: resolved.id, status: 'existing', via: resolved.via });
    else {
      if (!resolved && !isNonEmptyString(intent.description)) {
        throw codedError('TAG_DESCRIPTION_REQUIRED', `Creating tag ${intent.id} requires a short description of its area.`, { tagId: intent.id });
      }
      unknown.push(intent);
    }
  }
  let ensured = [];
  if (unknown.length > 0) {
    const result = await ensureTags({ projectDir, tags: unknown, lockOptions, ...storeOptions(options) });
    ensured = result.tags.map((tag) => ({ id: tag.id, status: tag.status, description: tag.description, aliases: tag.aliases }));
  }
  const refreshed = unknown.length > 0 ? await loadTagCatalog({ projectDir, readOnly: false, ...storeOptions(options) }) : loaded;
  const canonical = [];
  for (const intent of tags) {
    const resolved = resolveTagId(refreshed.catalog, intent.id);
    if (!resolved) throw codedError('TAG_RESOLUTION_FAILED', `Tag ${intent.id} did not resolve after ensure.`, { tagId: intent.id });
    if (!canonical.includes(resolved.id)) canonical.push(resolved.id);
  }
  return { tags: canonical, tagOutcomes: [...known, ...ensured] };
}

function constructKnowledge(input, current, tags, options) {
  const provenance = current?.provenance || {
    origin: 'captured', capturedAt: nowIso(options),
    ...(options.sourceRunId === undefined ? {} : { sourceRunIds: [options.sourceRunId] }),
  };
  return {
    schemaVersion: 1,
    id: input.id,
    kind: 'knowledge',
    title: input.title,
    summary: input.summary,
    tags,
    applicability: input.applicability || current?.applicability || { scope: 'project' },
    provenance,
    relatedRecordIds: input.relatedRecordIds || current?.relatedRecordIds || [],
    category: input.category,
    useWhen: input.useWhen,
    content: input.content,
    evidence: input.evidence,
    status: input.status || current?.status || 'active',
    ...(input.blocker !== undefined || input.category === 'blocker'
      ? { blocker: input.blocker || current?.blocker }
      : {}),
  };
}

function constructWork(input, current, workId, tags, associations, options) {
  const priorAssociations = current?.work.associations || { sourceRunIds: [], pullRequestIds: [], candidates: [] };
  const mergedAssociations = {
    sourceRunIds: mergeUnique(priorAssociations.sourceRunIds, associations.sourceRunIds),
    pullRequestIds: mergeUnique(priorAssociations.pullRequestIds, associations.pullRequestIds),
    candidates: mergeCandidates(priorAssociations.candidates, associations.candidates),
  };
  const sourceRunIds = mergeUnique(current?.provenance.sourceRunIds, associations.sourceRunIds);
  const runIds = mergeUnique(current?.applicability.runIds, sourceRunIds);
  const applicability = current?.applicability || { scope: 'work', workId };
  const provenance = current?.provenance || { origin: 'captured', capturedAt: nowIso(options) };
  return {
    schemaVersion: 1,
    id: workId,
    kind: 'work',
    title: input.title,
    summary: input.summary,
    tags,
    applicability: { ...applicability, ...(runIds.length ? { runIds } : {}) },
    provenance: { ...provenance, ...(sourceRunIds.length ? { sourceRunIds } : {}) },
    relatedRecordIds: input.relatedRecordIds || current?.relatedRecordIds || [],
    work: {
      ...Object.fromEntries(WORK_FIELDS.map((field) => [field, input[field]])),
      execution: input.execution || current?.work.execution || UNKNOWN_STATE,
      verificationState: input.verificationState || current?.work.verificationState || UNKNOWN_STATE,
      pullRequest: input.pullRequest || current?.work.pullRequest || UNKNOWN_STATE,
      associations: mergedAssociations,
    },
  };
}

function assertWorkRecordTokenLimit(record) {
  if (record.kind !== 'work') return;
  const estimatedTokens = estimateRenderedRecordTokens(record);
  if (estimatedTokens > WORK_RECORD_TOKEN_LIMIT) {
    throw codedError(
      'WORK_RECORD_TOO_LARGE',
      `Work record exceeds the ${WORK_RECORD_TOKEN_LIMIT} estimated rendered-token limit (${estimatedTokens}). Compact the seven-section account and retry.`,
      { estimatedTokens, tokenLimit: WORK_RECORD_TOKEN_LIMIT },
    );
  }
}

/**
 * Exercise the existing typed validator before any tag or identity writer. The temporary
 * identity and tag are only schema-valid stand-ins; registration constructs the final record.
 */
function prevalidateSemanticRecord(input, kind, current, requested, options) {
  const id = kind === 'knowledge'
    ? input.id
    : current?.id || options.workId || 'semantic-capture-validation';
  const record = kind === 'knowledge'
    ? constructKnowledge(input, current, current?.tags || ['semantic-capture-validation'], options)
    : constructWork(input, current, id, current?.tags || ['semantic-capture-validation'], requested, options);
  try {
    validateKnowledgeRecord(record, path.join('<semantic-input>', id, 'record.json'), { expectedId: id });
  } catch (error) {
    throw codedError('CAPTURE_INPUT_INVALID', error instanceof Error ? error.message : String(error));
  }
  assertWorkRecordTokenLimit(record);
}

function proposalPath(record, current) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-knowledge-capture-'));
  const directory = path.join(root, record.id);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  for (const resourcePath of current?.resources || []) {
    const destination = path.join(directory, resourcePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(current.recordDir, resourcePath), destination);
  }
  return { root, directory };
}

function recovery(error, details) {
  if (error && typeof error === 'object') Object.assign(error, details);
  return error;
}

/** Construct semantic input above the existing validator and sole registration writer. */
export async function captureCanonicalKnowledge(options) {
  const input = readInput(options.inputPath);
  const kind = options.kind;
  if (kind !== 'knowledge' && kind !== 'work') {
    throw codedError('CAPTURE_INPUT_INVALID', '--kind must be knowledge or work.');
  }
  if (kind === 'work' && options.recordId !== undefined) {
    throw codedError('CAPTURE_INPUT_INVALID', '--record-id is only valid for knowledge capture.');
  }
  if (kind === 'knowledge' && options.recordId !== undefined && input.id !== options.recordId) {
    throw codedError('CAPTURE_INPUT_INVALID', '--record-id must match the semantic knowledge input id.');
  }
  const resolved = await resolveProjectStore(path.resolve(options.projectDir || process.cwd()), {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
  });
  const requested = requestedAssociations(options);
  let current = null;
  let workIdentity = null;
  let tagResult = { tags: [], tagOutcomes: [] };
  let record;

  assertAllowedInput(input, kind, { tagsRequired: false });
  if (kind === 'knowledge') current = existingRecord(resolved.storePath, input.id);
  if (kind === 'work' && options.workId) current = existingRecord(resolved.storePath, options.workId);
  if (kind === 'work' && !current && hasExactAssociation(requested)) {
    const existingIdentity = await resolveWorkIdentity({
      projectDir: options.projectDir, workId: options.workId, sourceRunId: options.sourceRunId,
      pullRequestId: options.pullRequestId, candidate: options.candidate, lockOptions: options.lockOptions,
      ...storeOptions(options),
    });
    if (existingIdentity.status === 'resolved') current = existingRecord(resolved.storePath, existingIdentity.workId);
  }
  if (!current && input.tags === undefined) {
    throw codedError('CAPTURE_INPUT_INVALID', 'New captures require a non-empty tags array.');
  }
  if (current && current.record.kind !== kind) {
    throw codedError('CAPTURE_KIND_CONFLICT', `${current.record.id} is not a ${kind} record.`);
  }
  try {
    prevalidateSemanticRecord(input, kind, current?.record, requested, options);
  } catch (error) {
    throw recovery(error, { recoveryInput: path.resolve(options.inputPath) });
  }
  try {
    tagResult = await canonicalTags({
      projectDir: options.projectDir, tags: input.tags, existingTags: current?.record.tags || [], lockOptions: options.lockOptions, ...storeOptions(options),
    });
    if (kind === 'work') {
      if (!options.workId && !hasExactAssociation(requested)) {
        throw codedError('WORK_IDENTITY_REQUIRED', 'Work capture requires --work-id or one exact --source-run-id, --pull-request-id, or --candidate association.');
      }
      workIdentity = await resolveOrAllocateWorkIdentity({
        projectDir: options.projectDir, workId: options.workId, sourceRunId: options.sourceRunId,
        pullRequestId: options.pullRequestId, candidate: options.candidate, lockOptions: options.lockOptions,
        ...storeOptions(options),
      });
      current = existingRecord(resolved.storePath, workIdentity.workId);
    }
    record = kind === 'knowledge'
      ? constructKnowledge(input, current?.record, tagResult.tags, options)
      : constructWork(input, current?.record, workIdentity.workId, tagResult.tags, requested, options);
    validateKnowledgeRecord(record, path.join('<semantic-capture>', record.id, 'record.json'), { expectedId: record.id });
    assertWorkRecordTokenLimit(record);
    if (current && !options.expectedRevision && current.revisionToken !== revisionTokenFor(record, current.resourceDigests)) {
      throw codedError('KNOWLEDGE_REVISION_REQUIRED', `Updating ${record.id} requires --expected-revision ${current.revisionToken}.`, {
        status: 'conflict', currentRevision: current.revisionToken,
      });
    }
    const proposal = proposalPath(record, current);
    try {
      const registration = await registerCanonicalKnowledge({
        projectDir: options.projectDir, recordPath: proposal.directory, expectedRevision: options.expectedRevision, lockOptions: options.lockOptions,
        ...storeOptions(options), afterIndexRefresh: options.afterIndexRefresh,
      });
      return {
        ok: true, kind, id: registration.id, ...(kind === 'work' ? { workId: registration.id, association: workIdentity } : {}),
        tags: tagResult.tags, tagOutcomes: tagResult.tagOutcomes,
        status: registration.status, revisionToken: registration.revisionToken,
        previousRevisionToken: registration.previousRevisionToken, recordPath: registration.recordPath,
        recoveryInput: path.resolve(options.inputPath),
      };
    } finally {
      fs.rmSync(proposal.root, { recursive: true, force: true });
    }
  } catch (error) {
    throw recovery(error, {
      ...(tagResult.tagOutcomes.length ? { tagOutcomes: tagResult.tagOutcomes, tags: tagResult.tags } : {}),
      ...(workIdentity ? { workId: workIdentity.workId, association: workIdentity } : {}),
      recoveryInput: path.resolve(options.inputPath),
    });
  }
}

export function serializeCaptureError(error) {
  return {
    ok: false,
    code: error?.code || 'KNOWLEDGE_CAPTURE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.expectedRevision ? { expectedRevision: error.expectedRevision } : {}),
    ...(error?.currentRevision ? { currentRevision: error.currentRevision } : {}),
    ...(error?.tags ? { tags: error.tags } : {}),
    ...(error?.tagOutcomes ? { tagOutcomes: error.tagOutcomes } : {}),
    ...(error?.workId ? { workId: error.workId } : {}),
    ...(error?.association ? { association: error.association } : {}),
    ...(error?.recoveryInput ? { recoveryInput: error.recoveryInput } : {}),
  };
}
