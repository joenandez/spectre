import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, withStoreLock } from './store.mjs';

const ACTIVITY_SCHEMA_VERSION = 2;
const LEGACY_ACTIVITY_SCHEMA_VERSION = 1;
const ACTIVITY_FILE_NAME = 'activity.json';
const RECORD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_TOKEN_PATTERN = /^sha256:[a-f0-9]{64}$/;

function emptyKnowledgeActivity() {
  return { schemaVersion: ACTIVITY_SCHEMA_VERSION, records: {}, search: { matches: 0, misses: 0, recordMatches: {} } };
}

function activityError(activityPath, detail, cause) {
  const error = new Error(`${activityPath}: ${detail}`, cause ? { cause } : undefined);
  error.code = 'KNOWLEDGE_ACTIVITY_CORRUPT';
  return error;
}

function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasOnlyKeys(value, allowedKeys) { return Object.keys(value).every((key) => allowedKeys.has(key)); }
function isNonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function isPositiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function validateRecordId(id) { return typeof id === 'string' && RECORD_ID_PATTERN.test(id); }
function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateRevisionAggregate(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['successfulLoads', 'lastLoadedAt']))
    && isPositiveInteger(value.successfulLoads)
    && isCanonicalTimestamp(value.lastLoadedAt);
}

function validateRecordActivity(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['revisions']))
    && isPlainObject(value.revisions)
    && Object.entries(value.revisions).every(([revisionToken, aggregate]) =>
      REVISION_TOKEN_PATTERN.test(revisionToken) && validateRevisionAggregate(aggregate));
}

function validateRecordMatch(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['count', 'lastMatchedAt']))
    && isPositiveInteger(value.count)
    && isCanonicalTimestamp(value.lastMatchedAt);
}

function validateSearchActivity(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['matches', 'misses', 'lastMatchAt', 'lastMissAt', 'recordMatches']))
    && isNonNegativeInteger(value.matches)
    && isNonNegativeInteger(value.misses)
    && isPlainObject(value.recordMatches)
    && (value.lastMatchAt === undefined || isCanonicalTimestamp(value.lastMatchAt))
    && (value.lastMissAt === undefined || isCanonicalTimestamp(value.lastMissAt))
    && Object.entries(value.recordMatches).every(([id, aggregate]) => validateRecordId(id) && validateRecordMatch(aggregate));
}

function validateKnowledgeActivity(value, activityPath) {
  if (
    !isPlainObject(value)
    || !hasOnlyKeys(value, new Set(['schemaVersion', 'records', 'search']))
    || value.schemaVersion !== ACTIVITY_SCHEMA_VERSION
    || !isPlainObject(value.records)
    || !validateSearchActivity(value.search)
    || !Object.entries(value.records).every(([id, aggregate]) => validateRecordId(id) && validateRecordActivity(aggregate))
  ) throw activityError(activityPath, 'invalid or unsupported knowledge activity schema');
  return value;
}

function isLegacyKnowledgeActivity(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, new Set(['schemaVersion', 'records', 'search']))
    && value.schemaVersion === LEGACY_ACTIVITY_SCHEMA_VERSION
    && isPlainObject(value.records)
    && validateSearchActivity(value.search)
    && Object.entries(value.records).every(([id, aggregate]) =>
      validateRecordId(id)
      && isPlainObject(aggregate)
      && hasOnlyKeys(aggregate, new Set(['versions']))
      && isPlainObject(aggregate.versions)
      && Object.entries(aggregate.versions).every(([version, entry]) => /^[1-9]\d*$/.test(version) && validateRevisionAggregate(entry)));
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('now must resolve to a valid timestamp');
  return new Date(milliseconds).toISOString();
}

function validateMutationIdentity(id, revisionToken) {
  if (!validateRecordId(id)) throw new TypeError('id must be a canonical knowledge record ID');
  if (typeof revisionToken !== 'string' || !REVISION_TOKEN_PATTERN.test(revisionToken)) {
    throw new TypeError('revisionToken must be a canonical typed-record revision token');
  }
}

export function readKnowledgeActivity(storePath) {
  const activityPath = path.join(storePath, ACTIVITY_FILE_NAME);
  let raw;
  try { raw = fs.readFileSync(activityPath, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return emptyKnowledgeActivity();
    throw activityError(activityPath, 'could not read knowledge activity', error);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw activityError(activityPath, 'malformed knowledge activity JSON', error); }
  if (isLegacyKnowledgeActivity(parsed)) {
    return { schemaVersion: ACTIVITY_SCHEMA_VERSION, records: {}, search: parsed.search };
  }
  return validateKnowledgeActivity(parsed, activityPath);
}

export function writeKnowledgeActivity(storePath, activity, options = {}) {
  const activityPath = path.join(storePath, ACTIVITY_FILE_NAME);
  validateKnowledgeActivity(activity, activityPath);
  atomicWriteJson(activityPath, activity, options.atomicWriteOptions);
}

export function incrementKnowledgeLoadActivity(activity, options) {
  const { id, revisionToken } = options;
  validateMutationIdentity(id, revisionToken);
  const revisionActivity = {
    successfulLoads: (activity.records[id]?.revisions[revisionToken]?.successfulLoads || 0) + 1,
    lastLoadedAt: timestamp(options.now),
  };
  return {
    activity: {
      ...activity,
      records: {
        ...activity.records,
        [id]: {
          revisions: {
            ...(activity.records[id]?.revisions || {}),
            [revisionToken]: revisionActivity,
          },
        },
      },
    },
    revisionActivity,
  };
}

export async function recordKnowledgeLoad(options) {
  const { storePath, id, revisionToken } = options;
  validateMutationIdentity(id, revisionToken);
  return withStoreLock(storePath, 'record-knowledge-load', async () => {
    const current = readKnowledgeActivity(storePath);
    const { activity, revisionActivity } = incrementKnowledgeLoadActivity(current, options);
    writeKnowledgeActivity(storePath, activity, options);
    return revisionActivity;
  }, options.lockOptions);
}

export async function recordKnowledgeSearch(options) {
  const { storePath, results } = options;
  if (!Array.isArray(results)) throw new TypeError('results must be an array');
  const matchedIds = [...new Set(results.map((result) => result?.id))];
  if (matchedIds.some((id) => !validateRecordId(id))) throw new TypeError('each search result must have a canonical knowledge record ID');
  return withStoreLock(storePath, 'record-knowledge-search', async () => {
    const current = readKnowledgeActivity(storePath);
    const searchedAt = timestamp(options.now);
    const matched = matchedIds.length > 0;
    const recordMatches = { ...current.search.recordMatches };
    for (const id of matchedIds) {
      recordMatches[id] = { count: (recordMatches[id]?.count || 0) + 1, lastMatchedAt: searchedAt };
    }
    const search = {
      matches: current.search.matches + (matched ? 1 : 0),
      misses: current.search.misses + (matched ? 0 : 1),
      ...(matched ? { lastMatchAt: searchedAt } : current.search.lastMatchAt === undefined ? {} : { lastMatchAt: current.search.lastMatchAt }),
      ...(!matched ? { lastMissAt: searchedAt } : current.search.lastMissAt === undefined ? {} : { lastMissAt: current.search.lastMissAt }),
      recordMatches,
    };
    writeKnowledgeActivity(storePath, { ...current, search }, options);
    return search;
  }, options.lockOptions);
}

export function aggregateKnowledgeRecordActivity(activity, id) {
  if (!validateRecordId(id)) throw new TypeError('id must be a canonical knowledge record ID');
  let successfulLoads = 0;
  let lastLoadedAt;
  for (const aggregate of Object.values(activity.records[id]?.revisions || {})) {
    successfulLoads += aggregate.successfulLoads;
    if (lastLoadedAt === undefined || aggregate.lastLoadedAt > lastLoadedAt) lastLoadedAt = aggregate.lastLoadedAt;
  }
  return { successfulLoads, ...(lastLoadedAt === undefined ? {} : { lastLoadedAt }) };
}

export { ACTIVITY_SCHEMA_VERSION };
