import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertRenderedWorkRecordTokenLimit,
  parseKnowledgeRecord,
  revisionTokenFor,
  validateKnowledgeRecord,
} from './records.mjs';
import { registerCanonicalKnowledge } from './registration.mjs';
import { resolveProjectStore } from './store.mjs';
import { ensureTags, loadTagCatalog, normalizeTagId, resolveTagId } from './tags.mjs';
import { resolveOrAllocateWorkIdentity, resolveWorkIdentity } from './work.mjs';
import { readWorkflowRun } from '../workflow/store.mjs';

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
  'verificationState', 'pullRequest', 'relatedRecordIds', 'deliveryReceipt',
]);
const PLACEHOLDER = /^(?:<[^>]+>|{{[^}]+}}|TODO|REPLACE[_ -]?ME)$/i;
const UNKNOWN_STATE = { state: 'unknown' };

// `remainingWork` states residual IMPLEMENTATION work. Review, CI, PR readiness, merge, and
// closure are verification and pull-request facts, so a record that reports them as remaining
// work makes delivered work read as unfinished implementation.
//
// This is a natural-language heuristic, which is why it gates capture input here and not record
// validation: prose can never make a stored record unreadable or unrepairable. It is tuned for
// precision over recall — a missed lifecycle clause is a worse-worded record, while a false
// rejection blocks a truthful one.
const LIFECYCLE_CLAIM = '(?:review(?:er)?s?|approvals?|ci(?:\\s+checks?)?|readiness'
  + '|ready\\s+for\\s+review|merges?|merging|closure|closing)';
const LIFECYCLE_TRIGGER = '(?:awaiting|awaits?|waiting\\s+(?:on|for)|pending|needs?|requires?|blocked\\s+on)';
const LIFECYCLE_STATE = '(?:pending|outstanding|open|unresolved|awaited|blocked|in\\s+review)';
// Up to three words may sit between the trigger and the claim, so "Blocked on code review" and
// "Awaiting PR review" both match while "Needs a follow-up refactor of the merge helper" does not.
const LIFECYCLE_FILLER = '(?:[\\w\\u2019\'/-]+\\s+){0,3}?';
// The claim must end its clause. "Needs merge." is a lifecycle claim; "Needs merge conflict
// handling in the rebase path." continues into implementation work and is truthful.
// `of` is deliberately absent: it introduces the object the work acts on, so "Needs a merge of the
// two config loaders." names implementation work rather than the pull request's merge.
const LIFECYCLE_CLAUSE_END = '(?=\\s*[.,;:!?)\\]]|\\s*$|\\s+(?:to|before|after|from|by|on|in|is'
  + '|are|was|were|and|or|then|plus|so|because|which|that|but|until|prior|per|still|remains?)\\b)';
const DELIVERY_LIFECYCLE_REMAINING_WORK = [
  // "Waiting on CI to pass." / "Blocked on code review." / "The PR needs review before merge."
  new RegExp(`\\b${LIFECYCLE_TRIGGER}\\s+${LIFECYCLE_FILLER}${LIFECYCLE_CLAIM}\\b${LIFECYCLE_CLAUSE_END}`, 'i'),
  // The inverted form: "CI is pending; ..."
  new RegExp(`\\b${LIFECYCLE_CLAIM}\\s+(?:is|are|was|were|remains?|stays?)\\s+(?:still\\s+)?${LIFECYCLE_STATE}\\b${LIFECYCLE_CLAUSE_END}`, 'i'),
  // A pull request as the subject of the outstanding work: "Draft PR ... still needs ...". The
  // gap may not cross a connector or a comma, so "... squash-merged as PR #1085 and needs a
  // rebase ..." stays truthful branch work rather than a pull-request claim.
  new RegExp('\\b(?:draft\\s+)?(?:prs?|pull\\s+requests?)\\b'
    + '(?:(?!\\b(?:and|or|but|then|so)\\b)[^.;!?,]){0,40}?'
    + '\\b(?:still\\s+)?(?:needs?|requires?|awaits?|is\\s+(?:still\\s+)?(?:waiting|pending|blocked))\\b', 'i'),
];

function assertImplementationRemainingWork(remainingWork) {
  const value = remainingWork.trim();
  if (!DELIVERY_LIFECYCLE_REMAINING_WORK.some((pattern) => pattern.test(value))) return;
  throw codedError(
    'CAPTURE_INPUT_INVALID',
    'Capture input remainingWork must state implementation work; review, CI, readiness, merge,'
    + ' and closure are verification and pull-request facts.',
  );
}

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
  if (kind === 'work') assertImplementationRemainingWork(input.remainingWork);
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

// --- Bounded delivery receipt ---------------------------------------------------------------
//
// The receipt is derived from one exact Execute run's own durable event log and from nothing
// else. There is deliberately no branch walk and no `startHead` ancestry walk: a commit that
// merely sits on the branch is not evidence that this run produced it. Evidence the log cannot
// prove stays ABSENT, so `classifyDeliveryReceipt` reports `start-only` and the membership
// evaluator fails closed instead of reading an invented value.

const RECEIPT_RUN_ID_PATTERN = /^run_[0-9a-f-]{36}$/;
const RECEIPT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
// The run store stamps these when Git cannot answer. They are the absence of evidence.
const RECEIPT_SENTINELS = new Set(['unknown', 'unavailable']);
const RUN_BOUNDARY_EVENTS = new Set([
  'run.implementation_ready', 'run.completed', 'run.failed', 'run.blocked', 'run.interrupted',
]);
const GIT_TIMEOUT_MS = 30_000;
// A generated file or a lockfile makes a multi-megabyte commit patch routine.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function debugLog(event, fields) {
  if (!process.env.SPECTRE_DEBUG) return;
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

/** Reports whether Git ran separately from what it printed: a failure is never a fact. */
function git(cwd, args, input) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      // An ambient GIT_DIR or GIT_WORK_TREE would read another repository.
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      ...(input === undefined ? {} : { input }),
    });
    return { ok: true, stdout };
  } catch (error) {
    debugLog('capture.git_failed', { args: args[0], message: error?.message });
    return { ok: false, stdout: '' };
  }
}

/**
 * The patch id persisted for one accepted commit, computed here because the pre-rebase object
 * can be garbage-collected long before anything reads the receipt.
 *
 * The argument list is byte-identical to the patch `workflow/membership.mjs` rebuilds at
 * evaluation time; the two ids are compared, so it is copied deliberately and never shortened.
 *
 * @returns {{ok: boolean, id: string|null}} `ok: false` means Git failed; `ok: true` with a
 * `null` id means the commit genuinely has no patch (a merge or an empty commit).
 */
function patchIdOf(repoRoot, sha) {
  const patch = git(repoRoot, [
    'diff-tree', '-p', '--no-color', '--root', '--full-index', '--binary',
    '--no-ext-diff', '--no-textconv', sha,
  ]);
  if (!patch.ok) return { ok: false, id: null };
  if (!patch.stdout.trim()) return { ok: true, id: null };
  const output = git(repoRoot, ['patch-id', '--stable'], patch.stdout);
  if (!output.ok) return { ok: false, id: null };
  const [id] = output.stdout.trim().split(/\s+/);
  return { ok: true, id: id || null };
}

function receiptToken(value) {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  if (!token || /\s/.test(token) || RECEIPT_SENTINELS.has(token.toLowerCase())) return undefined;
  return token;
}

function receiptSha(value) {
  const token = receiptToken(value);
  return token && RECEIPT_SHA_PATTERN.test(token) ? token : undefined;
}

/**
 * Accepted means the primary completed the task behind a passing gate, not merely submitted.
 *
 * One task may submit several times: a failing batch gate blocks it, the repair redispatches it,
 * and the amended commit is submitted again. Only the submission that `task.completed` accepted is
 * evidence; the superseded shas no longer exist as patches and would make the run unprovable.
 */
function acceptedCommits(events) {
  const latest = new Map();
  const commits = [];
  for (const event of events) {
    if (event.type === 'task.submitted') {
      latest.set(event.taskId, receiptSha(event.payload?.commit));
      continue;
    }
    if (event.type !== 'task.completed') continue;
    const commit = latest.get(event.taskId);
    if (commit && !commits.includes(commit)) commits.push(commit);
  }
  return commits;
}

/**
 * Terminal evidence, or nothing.
 *
 * The head and the accepted pair are ONE fact. A head published without the pair it belongs to
 * would re-pair with an older stored list, so a later run's commits would be missing from a
 * receipt that still classifies `complete` — a false `selected`. Withholding the head instead
 * leaves the stored receipt's own consistent triple in place until a capture can prove all three.
 */
function terminalEvidence(projectDir, state, events) {
  // A boundary event survives a resume, so a still-active run would otherwise publish a stale head
  // beside a partial accepted list.
  if (state?.status === 'active') return {};
  const boundary = [...events].reverse().find((event) => RUN_BOUNDARY_EVENTS.has(event.type));
  const terminalHead = receiptSha(boundary?.git?.headSha);
  if (!terminalHead) return {};
  const commits = acceptedCommits(events);
  // A run that accepted nothing has a complete fact: the head, and no accepted work.
  if (commits.length === 0) return { terminalHead };
  const root = git(projectDir, ['rev-parse', '--show-toplevel']);
  const repoRoot = root.ok ? root.stdout.trim() : '';
  if (!repoRoot) return {};
  const patchIds = [];
  for (const commit of commits) {
    const { ok, id } = patchIdOf(repoRoot, commit);
    // An unreadable patch is not an empty patch. Persisting `null` here would tell the
    // evaluator the commit has no patch, so the whole fact is withheld and the receipt keeps
    // whatever it already proved until a capture can prove the full set.
    if (!ok) {
      debugLog('capture.receipt_patch_unreadable', { commit });
      return {};
    }
    patchIds.push(id);
  }
  return { terminalHead, acceptedCommits: commits, acceptedPatchIds: patchIds };
}

/** Read one exact run's receipt evidence. Work capture is never a delivery authority, so an
 * unreadable or unknown run yields no receipt rather than an error. */
async function deliveryReceiptFromRun({ projectDir, spectreHome, sourceRunId }) {
  if (typeof sourceRunId !== 'string' || !RECEIPT_RUN_ID_PATTERN.test(sourceRunId)) return undefined;
  let loaded;
  try {
    loaded = await readWorkflowRun({ projectDir, spectreHome, runId: sourceRunId });
  } catch (error) {
    debugLog('capture.receipt_run_unreadable', { runId: sourceRunId, code: error?.code || 'UNKNOWN' });
    return undefined;
  }
  const { state, events } = loaded;
  const branch = receiptToken(state?.branch);
  const startHead = receiptSha(events.find((event) => event.type === 'run.started')?.git?.headSha);
  if (!branch || !startHead) {
    debugLog('capture.receipt_start_unprovable', {
      runId: sourceRunId, branch: Boolean(branch), startHead: Boolean(startHead),
    });
    return undefined;
  }
  const receipt = { runId: sourceRunId, branch, startHead, ...terminalEvidence(projectDir, state, events) };
  debugLog('capture.receipt_derived', {
    runId: sourceRunId,
    terminal: Boolean(receipt.terminalHead),
    acceptedCommits: receipt.acceptedCommits?.length || 0,
  });
  return receipt;
}

const START_ONLY_RECEIPT_FIELDS = ['runId', 'branch', 'startHead'];

/**
 * The start-only fallback a caller may supply when the run's own log is unreadable.
 *
 * Terminal evidence has exactly ONE source, the run's durable event log. A caller-supplied
 * `terminalHead` or accepted list would let any capture input hand-write proven delivery for
 * commits the run never produced, so those fields are dropped rather than rejected — capture is
 * never a blocking delivery authority.
 *
 * The three start fields are one fact, like the accepted commit and patch lists: all three or
 * none. A partial set would reach record validation as an invalid receipt and fail the whole
 * capture, which is the one outcome this fallback exists to avoid.
 */
function startOnlyReceipt(value) {
  if (!isPlainObject(value)) return undefined;
  if (!START_ONLY_RECEIPT_FIELDS.every((field) => isNonEmptyString(value[field]))) {
    debugLog('capture.receipt_input_incomplete', {
      present: START_ONLY_RECEIPT_FIELDS.filter((field) => isNonEmptyString(value[field])),
    });
    return undefined;
  }
  const receipt = Object.fromEntries(START_ONLY_RECEIPT_FIELDS.map((field) => [field, value[field]]));
  debugLog('capture.receipt_input_narrowed', {
    runId: receipt.runId,
    dropped: Object.keys(value).filter((key) => !Object.hasOwn(receipt, key)),
  });
  return receipt;
}

/** A work record belongs to one exact run: another run's evidence never overwrites it. */
function receiptForStoredRun(stored, derived) {
  if (!derived || !isPlainObject(stored) || !stored.runId || stored.runId === derived.runId) return derived;
  debugLog('capture.receipt_run_mismatch', { stored: stored.runId, derived: derived.runId });
  return undefined;
}

/**
 * Carry the stored receipt forward and let newer evidence only ADD to it. A capture that
 * learns nothing about delivery must never erase a completed receipt: that would silently
 * downgrade a `complete` record to `legacy` and destroy the run's only delivery evidence.
 */
function mergeDeliveryReceipt(current, ...updates) {
  let merged = isPlainObject(current) ? { ...current } : undefined;
  for (const update of updates) {
    if (!isPlainObject(update)) continue;
    // Spreading is what carries evidence forward: an update can only add or replace a field.
    const next = { ...(merged || {}), ...update };
    // The two accepted lists are one index-aligned fact, so an update that carries either one
    // replaces both and a stale list can never re-pair with a new one.
    if (update.acceptedCommits !== undefined || update.acceptedPatchIds !== undefined) {
      next.acceptedCommits = update.acceptedCommits;
      next.acceptedPatchIds = update.acceptedPatchIds;
    }
    merged = next;
  }
  return merged;
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

/** Resolve the final record's tag ids without making the catalog writer reachable. */
async function preflightCanonicalTags({ projectDir, tags, existingTags, ...options }) {
  if (tags === undefined) return [...existingTags];
  const loaded = await loadTagCatalog({ projectDir, readOnly: true, ...storeOptions(options) });
  const canonical = [];
  for (const intent of tags) {
    const resolved = resolveTagId(loaded.catalog, intent.id);
    const id = resolved?.id || normalizeTagId(intent.id);
    if (!id) throw codedError('CAPTURE_INPUT_INVALID', `Tag ${intent.id} has an invalid id.`);
    if (!canonical.includes(id)) canonical.push(id);
  }
  return canonical;
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
  const sourceBranch = options.branch === undefined ? provenance.sourceBranch : options.branch;
  const stored = current?.work.deliveryReceipt;
  // The caller-supplied fallback is add-only: once a receipt is stored, only the run's own log
  // may revise it. Otherwise a capture input naming the stored run could rewrite `branch` and
  // `startHead` over evidence the run wrote, and `branch` gates record-level delivery selection.
  const suppliedReceipt = isPlainObject(stored) ? undefined : startOnlyReceipt(input.deliveryReceipt);
  const deliveryReceipt = mergeDeliveryReceipt(
    stored,
    suppliedReceipt,
    receiptForStoredRun(stored, options.deliveryReceipt),
  );
  return {
    schemaVersion: 1,
    id: workId,
    kind: 'work',
    title: input.title,
    summary: input.summary,
    tags,
    applicability: { ...applicability, ...(runIds.length ? { runIds } : {}) },
    provenance: {
      ...provenance,
      ...(sourceRunIds.length ? { sourceRunIds } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
    },
    relatedRecordIds: input.relatedRecordIds || current?.relatedRecordIds || [],
    ...(current?.importedSource ? { importedSource: current.importedSource } : {}),
    work: {
      ...Object.fromEntries(WORK_FIELDS.map((field) => [field, input[field]])),
      execution: input.execution || current?.work.execution || UNKNOWN_STATE,
      verificationState: input.verificationState || current?.work.verificationState || UNKNOWN_STATE,
      pullRequest: input.pullRequest || current?.work.pullRequest || UNKNOWN_STATE,
      associations: mergedAssociations,
      ...(deliveryReceipt ? { deliveryReceipt } : {}),
    },
  };
}

function assertWorkRecordTokenLimit(record) {
  try {
    assertRenderedWorkRecordTokenLimit(record);
  } catch (error) {
    throw codedError(error.code || 'CAPTURE_INPUT_INVALID', error.message, error);
  }
}

/**
 * Exercise the existing typed validator before any tag or identity writer using the ids that
 * the final record will render with. A new work identity has the same canonical UUID shape.
 */
function prevalidateSemanticRecord(input, kind, current, requested, options, tags) {
  const id = kind === 'knowledge'
    ? input.id
    : current?.id || options.workId || 'work-00000000-0000-0000-0000-000000000000';
  const record = kind === 'knowledge'
    ? constructKnowledge(input, current, tags, options)
    : constructWork(input, current, id, tags, requested, options);
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
  if (options.branch !== undefined && !isNonEmptyString(options.branch)) {
    throw codedError('CAPTURE_INPUT_INVALID', '--branch must be a non-empty exact branch name.');
  }
  if (kind === 'knowledge' && options.recordId !== undefined && input.id !== options.recordId) {
    throw codedError('CAPTURE_INPUT_INVALID', '--record-id must match the semantic knowledge input id.');
  }
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const resolved = await resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
  });
  const requested = requestedAssociations(options);
  // Derived before any store lock is taken, because reading the run takes the same store lock.
  const captureOptions = kind === 'work'
    ? {
      ...options,
      deliveryReceipt: await deliveryReceiptFromRun({
        projectDir, spectreHome: options.spectreHome, sourceRunId: options.sourceRunId,
      }),
    }
    : options;
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
    const preflightTags = await preflightCanonicalTags({
      projectDir: options.projectDir, tags: input.tags, existingTags: current?.record.tags || [], ...storeOptions(options),
    });
    prevalidateSemanticRecord(input, kind, current?.record, requested, captureOptions, preflightTags);
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
      : constructWork(input, current?.record, workIdentity.workId, tagResult.tags, requested, captureOptions);
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
        ...(kind === 'work' ? { workLifecycle: {
          execution: record.work.execution.state,
          verification: record.work.verificationState.state,
          pullRequest: record.work.pullRequest.state,
        } } : {}),
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
