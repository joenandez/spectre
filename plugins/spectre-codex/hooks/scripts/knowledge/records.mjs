import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson } from './store.mjs';

const RECORD_FILE_NAME = 'record.json';
const RECORD_SCHEMA_VERSION = 1;
const INDEX_SCHEMA_VERSION = 2;
const RECORD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TITLE_LIMIT = 200;
const SUMMARY_LIMIT = 500;

const KINDS = new Set(['knowledge', 'work']);
const CATEGORIES = new Set(['decision', 'pattern', 'gotcha', 'blocker']);
const STATUSES = new Set(['active', 'disputed', 'superseded', 'archived']);
const APPLICABILITY_SCOPES = new Set(['project', 'work']);
const PROVENANCE_ORIGINS = new Set(['captured', 'legacy-import']);
const LEGACY_IMPORT_ORIGIN = 'legacy-import';

const COMMON_FIELDS = new Set([
  'schemaVersion',
  'id',
  'kind',
  'title',
  'summary',
  'tags',
  'applicability',
  'provenance',
  'relatedRecordIds',
]);
const KNOWLEDGE_FIELDS = new Set([
  'category',
  'useWhen',
  'content',
  'evidence',
  'status',
  'blocker',
]);
const WORK_FIELDS = new Set(['work', 'importedSource']);
const WORK_SECTION_FIELDS = [
  'requestedOutcome',
  'scope',
  'actualChanges',
  'reasons',
  'discoveries',
  'verification',
  'remainingWork',
  'relatedContext',
];
const EXECUTION_STATES = new Set([
  'unknown',
  'in-progress',
  'implementation-ready',
  'acceptance-pending',
  'blocked',
]);
const VERIFICATION_STATES = new Set(['unknown', 'not-run', 'checked', 'passed', 'failed']);
const PULL_REQUEST_STATES = new Set(['unknown', 'none', 'draft-open', 'closed', 'merged']);
const AGENT_SKILLS_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

function recordError(recordPath, message) {
  return new Error(`${recordPath}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isUniqueStringArray(value, pattern) {
  return Array.isArray(value)
    && value.every((entry) => isNonEmptyString(entry) && (!pattern || pattern.test(entry)))
    && new Set(value).size === value.length;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/**
 * Deterministic bytes for one typed record, independent of stored key order or spacing.
 * Task 1.2 builds `revisionToken` on top of these bytes plus sorted resource hashes.
 */
export function canonicalRecordBytes(record) {
  return JSON.stringify(canonicalize(record));
}

export function canonicalRecordDigest(record) {
  return `sha256:${createHash('sha256').update(canonicalRecordBytes(record)).digest('hex')}`;
}

const REVISION_TOKEN_PATTERN = /^sha256:[a-f0-9]{64}$/;

function sha256Token(input) {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * Whole-package revision token: canonical record bytes plus sorted resource path and
 * content hashes, so a resource-only edit changes the token that guards a replacement.
 */
export function revisionTokenFor(record, resourceDigests = []) {
  const resources = [...resourceDigests]
    .map(({ path: resourcePath, digest }) => [resourcePath, digest])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256Token(JSON.stringify([canonicalRecordBytes(record), resources]));
}

/** History directories address a revision by token; `:` is not portable in a path. */
export function revisionDirectoryName(revisionToken) {
  if (typeof revisionToken !== 'string' || !REVISION_TOKEN_PATTERN.test(revisionToken)) {
    throw new Error(`Not a canonical revision token: ${JSON.stringify(revisionToken)}`);
  }
  return revisionToken.replace(':', '-');
}

export function revisionTokenFromDirectoryName(directoryName) {
  const token = String(directoryName).replace('-', ':');
  return REVISION_TOKEN_PATTERN.test(token) ? token : null;
}

function digestResources(recordDir, relativePaths) {
  return relativePaths.map((relativePath) => {
    const resourcePath = path.join(recordDir, relativePath);
    let bytes;
    try {
      bytes = fs.readFileSync(resourcePath);
    } catch {
      throw recordError(resourcePath, 'resource changed during discovery');
    }
    return { path: relativePath.split(path.sep).join('/'), digest: sha256Token(bytes) };
  });
}

function allowedFields(kind) {
  return kind === 'knowledge'
    ? new Set([...COMMON_FIELDS, ...KNOWLEDGE_FIELDS])
    : new Set([...COMMON_FIELDS, ...WORK_FIELDS]);
}

function validateNoForeignFields(record, recordPath) {
  const allowed = allowedFields(record.kind);
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    if (AGENT_SKILLS_FIELDS.has(key)) {
      throw recordError(
        recordPath,
        `AgentSkills frontmatter field ${key} is not part of the typed record schema`,
      );
    }
    if (KNOWLEDGE_FIELDS.has(key) || WORK_FIELDS.has(key)) {
      throw recordError(recordPath, `field ${key} is not allowed on a ${record.kind} record`);
    }
    throw recordError(recordPath, `unknown field ${key}`);
  }
}

function validateIdentity(record, recordPath, expectedId) {
  if (
    typeof record.id !== 'string'
    || record.id.length > 64
    || !RECORD_ID_PATTERN.test(record.id)
  ) {
    throw recordError(recordPath, 'id must be a canonical lowercase hyphenated record ID');
  }
  if (record.id !== (expectedId || path.basename(path.dirname(path.resolve(recordPath))))) {
    throw recordError(recordPath, 'id must match its parent record directory');
  }
}

function validateApplicability(record, recordPath) {
  const applicability = record.applicability;
  if (!isPlainObject(applicability)) {
    throw recordError(recordPath, 'applicability must be an object');
  }
  for (const key of Object.keys(applicability)) {
    if (!['scope', 'workId', 'runIds'].includes(key)) {
      throw recordError(recordPath, `unknown field applicability.${key}`);
    }
  }
  if (!APPLICABILITY_SCOPES.has(applicability.scope)) {
    throw recordError(recordPath, `unknown applicability.scope ${applicability.scope}`);
  }
  if (applicability.scope === 'work') {
    if (!isNonEmptyString(applicability.workId) || !RECORD_ID_PATTERN.test(applicability.workId)) {
      throw recordError(
        recordPath,
        'applicability.workId is required for work-scoped applicability',
      );
    }
  } else if (applicability.workId !== undefined) {
    throw recordError(recordPath, 'applicability.workId requires the work scope');
  }
  if (applicability.runIds !== undefined && !isUniqueStringArray(applicability.runIds)) {
    throw recordError(recordPath, 'applicability.runIds must be a unique non-empty string array');
  }
}

function validateProvenance(record, recordPath) {
  const provenance = record.provenance;
  if (!isPlainObject(provenance)) {
    throw recordError(recordPath, 'provenance must be an object');
  }
  const optionalStrings = ['sourceCommit', 'sourceBranch', 'sourceFingerprint'];
  for (const key of Object.keys(provenance)) {
    if (!['origin', 'capturedAt', 'sourceRunIds', ...optionalStrings].includes(key)) {
      throw recordError(recordPath, `unknown field provenance.${key}`);
    }
  }
  if (!PROVENANCE_ORIGINS.has(provenance.origin)) {
    throw recordError(recordPath, `unknown provenance.origin ${provenance.origin}`);
  }
  if (!isCanonicalTimestamp(provenance.capturedAt)) {
    throw recordError(recordPath, 'provenance.capturedAt must be an ISO-8601 timestamp');
  }
  if (provenance.sourceRunIds !== undefined && !isUniqueStringArray(provenance.sourceRunIds)) {
    throw recordError(recordPath, 'provenance.sourceRunIds must be a unique non-empty string array');
  }
  for (const key of optionalStrings) {
    if (provenance[key] !== undefined && !isNonEmptyString(provenance[key])) {
      throw recordError(recordPath, `provenance.${key} must be a non-empty string`);
    }
  }
}

function validateBlocker(record, recordPath) {
  if (record.category !== 'blocker') {
    if (record.blocker !== undefined) {
      throw recordError(recordPath, 'blocker is only allowed when category is blocker');
    }
    return;
  }
  if (!isPlainObject(record.blocker)) {
    throw recordError(
      recordPath,
      'blocker.condition and blocker.resolutionCriterion are required for a blocker record',
    );
  }
  for (const key of Object.keys(record.blocker)) {
    if (!['condition', 'resolutionCriterion'].includes(key)) {
      throw recordError(recordPath, `unknown field blocker.${key}`);
    }
  }
  if (!isNonEmptyString(record.blocker.condition)) {
    throw recordError(recordPath, 'blocker.condition must state the observed blocking condition');
  }
  if (!isNonEmptyString(record.blocker.resolutionCriterion)) {
    throw recordError(
      recordPath,
      'blocker.resolutionCriterion must state what resolves the blocker',
    );
  }
}

function validateKnowledgeFields(record, recordPath) {
  if (!CATEGORIES.has(record.category)) {
    throw recordError(recordPath, `unknown category ${record.category}`);
  }
  if (!STATUSES.has(record.status)) {
    throw recordError(recordPath, `unknown status ${record.status}`);
  }
  for (const key of ['useWhen', 'content', 'evidence']) {
    if (!isNonEmptyString(record[key])) {
      throw recordError(recordPath, `${key} must be a non-empty string`);
    }
  }
  validateBlocker(record, recordPath);
}

/**
 * Work records currently carry the common fields only. The templated work body and
 * lifecycle fields extend this one authority; they never become a second format.
 */
function validateState(value, allowedStates, field, recordPath, optional = []) {
  if (!isPlainObject(value)) {
    throw recordError(recordPath, `${field} must be an object`);
  }
  const allowed = new Set(['state', ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw recordError(recordPath, `unknown field ${field}`);
  }
  if (!allowedStates.has(value.state)) {
    throw recordError(recordPath, `unknown ${field}.state ${value.state}`);
  }
  for (const key of optional) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) {
      throw recordError(recordPath, `${field}.${key} must be a non-empty string`);
    }
  }
}

function validateCandidate(candidate, recordPath) {
  if (!isPlainObject(candidate) || Object.keys(candidate).some((key) =>
    !['repository', 'base', 'head', 'diff'].includes(key))) {
    throw recordError(recordPath, 'work.associations.candidates must use exact candidate fields');
  }
  for (const field of ['repository', 'base', 'head', 'diff']) {
    if (!isNonEmptyString(candidate[field])) {
      throw recordError(recordPath, `work.associations.candidates.${field} must be a non-empty string`);
    }
  }
}

function validateImportedSource(record, recordPath) {
  if (record.provenance.origin !== LEGACY_IMPORT_ORIGIN) {
    if (record.importedSource !== undefined) {
      throw recordError(recordPath, 'importedSource requires legacy-import provenance');
    }
    return;
  }
  const source = record.importedSource;
  const fields = ['body', 'useWhen', 'cues', 'category', 'status', 'version'];
  if (!isPlainObject(source) || Object.keys(source).some((key) => !fields.includes(key))) {
    throw recordError(recordPath, 'legacy-import work records require importedSource metadata');
  }
  for (const field of ['body', 'useWhen', 'category', 'status', 'version']) {
    if (!isNonEmptyString(source[field])) {
      throw recordError(recordPath, `importedSource.${field} must be a non-empty string`);
    }
  }
  if (!isUniqueStringArray(source.cues)) {
    throw recordError(recordPath, 'importedSource.cues must be a unique non-empty string array');
  }
}

function validateWorkFields(record, recordPath) {
  const work = record.work;
  const allowed = new Set([
    ...WORK_SECTION_FIELDS,
    'execution',
    'verificationState',
    'pullRequest',
    'associations',
  ]);
  if (!isPlainObject(work) || Object.keys(work).some((key) => !allowed.has(key))) {
    throw recordError(recordPath, 'work must contain only the work template and lifecycle fields');
  }
  for (const field of WORK_SECTION_FIELDS) {
    if (!isNonEmptyString(work[field])) {
      throw recordError(recordPath, `work.${field} must be a non-empty explicit statement`);
    }
  }
  validateState(work.execution, EXECUTION_STATES, 'work.execution', recordPath);
  validateState(work.verificationState, VERIFICATION_STATES, 'work.verificationState', recordPath, ['evidenceRef']);
  validateState(work.pullRequest, PULL_REQUEST_STATES, 'work.pullRequest', recordPath, ['identity', 'url']);
  if (!isPlainObject(work.associations)
    || Object.keys(work.associations).some((key) => !['sourceRunIds', 'pullRequestIds', 'candidates'].includes(key))
    || !isUniqueStringArray(work.associations.sourceRunIds)
    || !isUniqueStringArray(work.associations.pullRequestIds)
    || !Array.isArray(work.associations.candidates)) {
    throw recordError(recordPath, 'work.associations must contain exact source run, PR, and candidate arrays');
  }
  for (const candidate of work.associations.candidates) validateCandidate(candidate, recordPath);
  validateImportedSource(record, recordPath);
}

export function validateKnowledgeRecord(record, recordPath, options = {}) {
  if (!isPlainObject(record)) {
    throw recordError(recordPath, 'record must be a JSON object');
  }
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw recordError(
      recordPath,
      `unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}`,
    );
  }
  if (!KINDS.has(record.kind)) {
    throw recordError(recordPath, `unknown kind ${JSON.stringify(record.kind)}`);
  }
  validateNoForeignFields(record, recordPath);
  validateIdentity(record, recordPath, options.expectedId);
  if (!isNonEmptyString(record.title) || record.title.length > TITLE_LIMIT) {
    throw recordError(recordPath, `title must contain 1-${TITLE_LIMIT} characters`);
  }
  if (!isNonEmptyString(record.summary) || record.summary.length > SUMMARY_LIMIT) {
    throw recordError(recordPath, `summary must contain 1-${SUMMARY_LIMIT} characters`);
  }
  if (!isUniqueStringArray(record.tags, TAG_ID_PATTERN)) {
    throw recordError(recordPath, 'tags must be a unique array of canonical tag IDs');
  }
  validateApplicability(record, recordPath);
  validateProvenance(record, recordPath);
  if (
    !isUniqueStringArray(record.relatedRecordIds, RECORD_ID_PATTERN)
    || record.relatedRecordIds.includes(record.id)
  ) {
    throw recordError(recordPath, 'relatedRecordIds must be unique canonical record IDs');
  }
  if (record.kind === 'knowledge') validateKnowledgeFields(record, recordPath);
  else validateWorkFields(record, recordPath);
  return record;
}

const HISTORICAL_WORK_NOTICE =
  'Historical work record: historical evidence only, not active guidance.';

function applicabilityLabel(applicability) {
  if (applicability.scope !== 'work') return applicability.scope;
  const runs = applicability.runIds?.length ? `; runs: ${applicability.runIds.join(', ')}` : '';
  return `work (${applicability.workId}${runs})`;
}

function provenanceLines(provenance) {
  const optional = [
    ['Source commit', provenance.sourceCommit],
    ['Source branch', provenance.sourceBranch],
    ['Source runs', provenance.sourceRunIds?.join(', ')],
    ['Source fingerprint', provenance.sourceFingerprint],
  ];
  return [
    `- Provenance: ${provenance.origin} at ${provenance.capturedAt}`,
    ...optional
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([label, value]) => `- ${label}: ${value}`),
  ];
}

function section(heading, body) {
  return [`## ${heading}`, '', body, ''];
}

export function renderKnowledgeRecord(record) {
  const isKnowledge = record.kind === 'knowledge';
  const lines = [
    `# ${record.title}`,
    '',
    `- ID: ${record.id}`,
    `- Kind: ${record.kind}`,
    ...(isKnowledge ? [`- Category: ${record.category}`, `- Status: ${record.status}`] : []),
    ...(!isKnowledge ? [
      `- Execution state: ${record.work.execution.state}`,
      `- Verification state: ${record.work.verificationState.state}`,
      `- Pull request state: ${record.work.pullRequest.state}`,
    ] : []),
    `- Applicability: ${applicabilityLabel(record.applicability)}`,
    ...(record.tags.length > 0 ? [`- Tags: ${record.tags.join(', ')}`] : []),
    ...(record.relatedRecordIds.length > 0
      ? [`- Related records: ${record.relatedRecordIds.join(', ')}`]
      : []),
    ...provenanceLines(record.provenance),
    '',
    ...(isKnowledge ? [] : [HISTORICAL_WORK_NOTICE, '']),
    ...section('Summary', record.summary),
    ...(isKnowledge
      ? [
        ...section('Use when', record.useWhen),
        ...section('Guidance', record.content),
        ...section('Evidence', record.evidence),
        ...(record.category === 'blocker'
          ? [
            ...section('Blocking condition', record.blocker.condition),
            ...section('Resolution criterion', record.blocker.resolutionCriterion),
          ]
          : []),
      ]
      : []),
    ...(!isKnowledge
      ? [
        ...section('Requested outcome and scope', [
          record.work.requestedOutcome,
          '',
          `Scope: ${record.work.scope}`,
        ].join('\n')),
        ...section('Actual changes and affected components', record.work.actualChanges),
        ...section('Reasons and accepted decisions', record.work.reasons),
        ...section('Discoveries and approaches tried', record.work.discoveries),
        ...section('Verification performed', record.work.verification),
        ...section('Remaining work, limitations, and unknowns', record.work.remainingWork),
        ...section('Related knowledge and source context', record.work.relatedContext),
        ...(record.importedSource
          ? [
            ...section('Imported source', record.importedSource.body),
            ...section('Use when', record.importedSource.useWhen),
            ...section('Discovery cues', record.importedSource.cues.join(', ')),
            ...section('Imported source metadata', [
              `- Category: ${record.importedSource.category}`,
              `- Status: ${record.importedSource.status}`,
              `- Version: ${record.importedSource.version}`,
            ].join('\n')),
          ]
          : []),
      ]
      : []),
  ];
  return lines.join('\n');
}

function parseRecordJson(text, recordPath, options) {
  if (text.startsWith('---')) {
    throw recordError(recordPath, 'AgentSkills frontmatter is not a typed record package');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw recordError(recordPath, `malformed record JSON: ${error.message}`);
  }
  return validateKnowledgeRecord(parsed, recordPath, options);
}

function pathIsWithin(rootPath, candidatePath) {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function filesystemTypeMatches(dirent, stat) {
  return (
    (dirent.isDirectory() && stat.isDirectory())
    || (dirent.isFile() && stat.isFile())
    || (dirent.isSymbolicLink() && stat.isSymbolicLink())
  );
}

function listResources(recordDir) {
  const absoluteRecordDir = path.resolve(recordDir);
  let canonicalRecordDir;
  try {
    const rootStat = fs.lstatSync(absoluteRecordDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw recordError(absoluteRecordDir, 'record directory is not a safe canonical directory');
    }
    canonicalRecordDir = fs.realpathSync.native(absoluteRecordDir);
  } catch (error) {
    if (error?.message?.startsWith(absoluteRecordDir)) throw error;
    throw recordError(absoluteRecordDir, 'record directory changed during resource discovery');
  }

  const resources = [];
  const pending = [{ directoryPath: absoluteRecordDir, canonicalPath: canonicalRecordDir }];
  while (pending.length > 0) {
    const current = pending.pop();
    let currentStat;
    let currentCanonicalPath;
    try {
      currentStat = fs.lstatSync(current.directoryPath);
      currentCanonicalPath = fs.realpathSync.native(current.directoryPath);
    } catch {
      throw recordError(
        current.directoryPath,
        'resource directory changed during discovery',
      );
    }
    if (
      !currentStat.isDirectory()
      || currentStat.isSymbolicLink()
      || currentCanonicalPath !== current.canonicalPath
      || !pathIsWithin(canonicalRecordDir, currentCanonicalPath)
    ) {
      throw recordError(current.directoryPath, 'resource directory changed during discovery');
    }

    for (const entry of fs.readdirSync(current.directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(current.directoryPath, entry.name);
      let entryStat;
      try {
        entryStat = fs.lstatSync(entryPath);
      } catch {
        throw recordError(entryPath, 'resource changed during discovery');
      }
      if (entryStat.isSymbolicLink()) {
        if (entry.isSymbolicLink()) continue;
        throw recordError(entryPath, 'resource changed to a symlink during discovery');
      }
      if (!filesystemTypeMatches(entry, entryStat)) {
        throw recordError(entryPath, 'resource type changed during discovery');
      }

      let canonicalEntryPath;
      try {
        canonicalEntryPath = fs.realpathSync.native(entryPath);
      } catch {
        throw recordError(entryPath, 'resource changed during discovery');
      }
      if (!pathIsWithin(canonicalRecordDir, canonicalEntryPath)) {
        throw recordError(entryPath, 'resource escapes its canonical record directory');
      }
      if (entryStat.isDirectory()) {
        pending.push({ directoryPath: entryPath, canonicalPath: canonicalEntryPath });
      } else if (
        entryStat.isFile()
        && entryPath !== path.join(absoluteRecordDir, RECORD_FILE_NAME)
      ) {
        resources.push(path.relative(absoluteRecordDir, entryPath));
      }
    }
  }
  return resources.sort();
}

function parseKnowledgeContent(text, recordPath, resources = [], options) {
  const record = parseRecordJson(text, recordPath, options);
  const resourceDigests = digestResources(path.dirname(recordPath), resources);
  return {
    record,
    resources,
    resourceDigests,
    revisionToken: revisionTokenFor(record, resourceDigests),
  };
}

export function parseKnowledgeRecord(recordPath) {
  if (path.basename(recordPath) !== RECORD_FILE_NAME) {
    throw recordError(recordPath, `a typed record package must be named ${RECORD_FILE_NAME}`);
  }
  const text = fs.readFileSync(recordPath, 'utf8');
  return parseKnowledgeContent(text, recordPath, listResources(path.dirname(recordPath)));
}

/** Parse a verified archive package whose parent directory is its revision token. */
export function parseHistoricalKnowledgeRecord(recordPath, expectedId) {
  if (path.basename(recordPath) !== RECORD_FILE_NAME) {
    throw recordError(recordPath, `a typed record package must be named ${RECORD_FILE_NAME}`);
  }
  const text = fs.readFileSync(recordPath, 'utf8');
  return parseKnowledgeContent(text, recordPath, listResources(path.dirname(recordPath)), { expectedId });
}

/** Current revision of a stored package, or null when it is absent or unreadable. */
export function readRecordRevision(recordDir) {
  const recordPath = path.join(recordDir, RECORD_FILE_NAME);
  if (!fs.existsSync(recordPath)) return null;
  try {
    return parseKnowledgeRecord(recordPath).revisionToken;
  } catch {
    return null;
  }
}

function indexEntry(storePath, recordPath, parsed) {
  const stat = fs.statSync(recordPath);
  const { record } = parsed;
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    summary: record.summary,
    tags: [...record.tags],
    applicability: canonicalize(record.applicability),
    ...(record.kind === 'knowledge'
      ? { category: record.category, useWhen: record.useWhen, status: record.status }
      : {
        historical: true,
        imported: record.provenance.origin === LEGACY_IMPORT_ORIGIN,
        useWhen: record.importedSource?.useWhen,
        cues: record.importedSource?.cues || [],
        sourceBody: record.importedSource?.body,
        category: record.importedSource?.category,
        status: record.importedSource?.status,
        version: record.importedSource?.version,
      }),
    recordPath: path.relative(storePath, recordPath),
    revisionToken: parsed.revisionToken,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
  };
}

function readExistingIndex(indexPath) {
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (index?.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(index.records)) return null;
    return index;
  } catch {
    return null;
  }
}

function isCurrentRecord(record) {
  return true;
}

export function refreshKnowledgeIndex(storePath, options = {}) {
  const knowledgeDir = path.join(storePath, 'knowledge');
  const discoveredRecords = [];
  const errors = [];
  if (fs.existsSync(knowledgeDir)) {
    const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const recordPath = path.join(knowledgeDir, entry.name, RECORD_FILE_NAME);
      if (!fs.existsSync(recordPath)) continue;
      try {
        const parsed = parseKnowledgeRecord(recordPath);
        if (isCurrentRecord(parsed.record)) {
          discoveredRecords.push(indexEntry(storePath, recordPath, parsed));
        }
      } catch (error) {
        errors.push({ path: recordPath, message: error.message });
      }
    }
  }

  const indexPath = path.join(storePath, 'index.json');
  const existing = readExistingIndex(indexPath);
  const trustedRecordIds = new Set(options.trustedRecordIds || []);
  const existingById = new Map((existing?.records || []).map((entry) => [entry.id, entry]));
  const records = [];
  for (const discovered of discoveredRecords) {
    const persisted = existingById.get(discovered.id);
    if (
      persisted
      && persisted.revisionToken !== discovered.revisionToken
      && !trustedRecordIds.has(discovered.id)
    ) {
      errors.push({
        path: path.resolve(storePath, discovered.recordPath),
        message: `current record revision differs from persisted revision for ${discovered.id}`,
      });
      records.push(persisted);
    } else {
      records.push(discovered);
    }
    existingById.delete(discovered.id);
  }
  for (const persisted of existingById.values()) {
    errors.push({
      path: path.resolve(storePath, persisted.recordPath),
      message: `persisted record is missing from the current store: ${persisted.id}`,
    });
    records.push(persisted);
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  const unchanged =
    existing !== null &&
    JSON.stringify(existing.records) === JSON.stringify(records);
  if (unchanged) {
    return { index: existing, rebuilt: false, errors };
  }

  const nowValue = typeof options.now === 'function' ? options.now() : Date.now();
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAt: new Date(nowValue).toISOString(),
    records,
  };
  if (options.persist !== false) atomicWriteJson(indexPath, index);
  return { index, rebuilt: true, errors };
}

export function readVerifiedIndexedRecord(storePath, entry, options = {}) {
  const absoluteStore = path.resolve(storePath);
  const recordPath = path.resolve(absoluteStore, entry.recordPath);
  if (!recordPath.startsWith(`${absoluteStore}${path.sep}`)) return null;
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text;
    try {
      text = readFile(recordPath);
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = parseKnowledgeContent(text, recordPath, listResources(path.dirname(recordPath)));
    } catch {
      return null;
    }
    if (parsed.revisionToken !== entry.revisionToken) continue;
    return parsed;
  }
  return null;
}

export {
  APPLICABILITY_SCOPES,
  CATEGORIES,
  INDEX_SCHEMA_VERSION,
  KINDS,
  LEGACY_IMPORT_ORIGIN,
  PROVENANCE_ORIGINS,
  RECORD_FILE_NAME,
  RECORD_SCHEMA_VERSION,
  STATUSES,
};
