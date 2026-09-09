import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalRecordBytes } from './records.mjs';
import { measurePayload } from './payload.mjs';
import { atomicWriteJson, resolveProjectStore, withStoreLock } from './store.mjs';

const TAG_CATALOG_FILE_NAME = 'tags.json';
const TAG_CATALOG_SCHEMA_VERSION = 1;
const TAG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_ID_LIMIT = 64;
const TAG_DESCRIPTION_LIMIT = 200;
const DEFAULT_TAG_SEARCH_LIMIT = 5;
const MAX_TAG_SEARCH_LIMIT = 5;
const TAG_SEARCH_TOKEN_LIMIT = 500;

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One tag identity per area: compatibility forms, case, and any separator run all
 * collapse to the same lowercase hyphenated id that records already store.
 */
export function normalizeTagId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0 || normalized.length > TAG_ID_LIMIT) return null;
  return TAG_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeDescription(value) {
  if (typeof value !== 'string') return null;
  const description = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (description === '' || description.length > TAG_DESCRIPTION_LIMIT) return null;
  return description;
}

export function tagCatalogPath(storePath) {
  return path.join(storePath, TAG_CATALOG_FILE_NAME);
}

function emptyCatalog() {
  return { schemaVersion: TAG_CATALOG_SCHEMA_VERSION, tags: {}, redirects: {} };
}

/** Sorted keys keep the persisted bytes and the derived revision deterministic. */
function sortedCatalog(catalog) {
  const tags = {};
  for (const id of Object.keys(catalog.tags).sort()) {
    tags[id] = {
      description: catalog.tags[id].description,
      aliases: [...catalog.tags[id].aliases].sort(),
    };
  }
  const redirects = {};
  for (const from of Object.keys(catalog.redirects).sort()) {
    redirects[from] = catalog.redirects[from];
  }
  return { schemaVersion: TAG_CATALOG_SCHEMA_VERSION, tags, redirects };
}

/** Same shape as a record revision token, over the whole catalog document. */
export function tagCatalogRevision(catalog) {
  const bytes = canonicalRecordBytes(sortedCatalog(catalog));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validateStoredCatalog(parsed, catalogPath) {
  if (!isPlainObject(parsed) || parsed.schemaVersion !== TAG_CATALOG_SCHEMA_VERSION) {
    throw codedError(
      'TAG_CATALOG_INVALID',
      `${catalogPath}: unsupported tag catalog schemaVersion ${JSON.stringify(parsed?.schemaVersion)}`,
    );
  }
  if (!isPlainObject(parsed.tags) || !isPlainObject(parsed.redirects)) {
    throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: tags and redirects must be objects`);
  }
  const identities = new Map();
  for (const [id, entry] of Object.entries(parsed.tags)) {
    if (normalizeTagId(id) !== id) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: ${id} is not a canonical tag id`);
    }
    if (!isPlainObject(entry) || normalizeDescription(entry.description) === null) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: ${id} needs a short description`);
    }
    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => normalizeTagId(alias) !== alias)) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: ${id} has a non-canonical alias`);
    }
    if (new Set(entry.aliases).size !== entry.aliases.length || entry.aliases.includes(id)) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: ${id} has duplicate or self aliases`);
    }
    identities.set(id, id);
  }
  for (const [id, entry] of Object.entries(parsed.tags)) {
    for (const alias of entry.aliases) {
      if (identities.has(alias)) {
        throw codedError(
          'TAG_CATALOG_INVALID',
          `${catalogPath}: ${alias} collides with the canonical tag ${identities.get(alias)}`,
        );
      }
      identities.set(alias, id);
    }
  }
  for (const [from, target] of Object.entries(parsed.redirects)) {
    if (normalizeTagId(from) !== from || normalizeTagId(target) !== target) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: redirects need canonical tag ids`);
    }
    if (!Object.hasOwn(parsed.tags, target)) {
      throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: ${from} redirects to missing ${target}`);
    }
    if (identities.has(from)) {
      throw codedError(
        'TAG_CATALOG_INVALID',
        `${catalogPath}: redirect ${from} collides with the canonical tag ${identities.get(from)}`,
      );
    }
    identities.set(from, target);
  }
  return sortedCatalog(parsed);
}

export function readTagCatalog(storePath) {
  const catalogPath = tagCatalogPath(storePath);
  if (!fs.existsSync(catalogPath)) return emptyCatalog();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw codedError('TAG_CATALOG_INVALID', `${catalogPath}: malformed catalog JSON: ${error.message}`);
  }
  return validateStoredCatalog(parsed, catalogPath);
}

/**
 * Every reference — canonical id, alias, or an id retired by a merge — resolves to
 * exactly one canonical id, so consolidation never strands an existing record.
 */
export function resolveTagId(catalog, value) {
  const id = normalizeTagId(value);
  if (id === null) return null;
  if (Object.hasOwn(catalog.tags, id)) return { id, via: 'canonical' };
  for (const [canonicalId, entry] of Object.entries(catalog.tags)) {
    if (entry.aliases.includes(id)) return { id: canonicalId, via: 'alias' };
  }
  const redirected = catalog.redirects[id];
  if (redirected && Object.hasOwn(catalog.tags, redirected)) {
    return { id: redirected, via: 'redirect' };
  }
  return null;
}

/**
 * Membership is derived, never stored: counts come from the compact record index so
 * a tag question never loads a record body.
 */
export function deriveTagUsage(storePath, catalog = readTagCatalog(storePath)) {
  const usage = Object.fromEntries(Object.keys(catalog.tags).map((id) => [id, 0]));
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'));
  } catch {
    return usage;
  }
  if (!Array.isArray(index?.records)) return usage;
  for (const entry of index.records) {
    const counted = new Set();
    for (const tag of Array.isArray(entry?.tags) ? entry.tags : []) {
      const resolved = resolveTagId(catalog, tag);
      if (!resolved || counted.has(resolved.id)) continue;
      counted.add(resolved.id);
      usage[resolved.id] += 1;
    }
  }
  return usage;
}

async function resolveStore(options, { readOnly = false } = {}) {
  const projectDir = path.resolve(options.projectDir || options.projectRoot || process.cwd());
  return resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
    readOnly,
  });
}

export async function loadTagCatalog(options) {
  const resolved = await resolveStore(options, { readOnly: options.readOnly !== false });
  if (!resolved.storePath) {
    const catalog = emptyCatalog();
    return { storePath: null, catalogPath: null, catalog, revision: tagCatalogRevision(catalog) };
  }
  const catalog = readTagCatalog(resolved.storePath);
  return {
    storePath: resolved.storePath,
    catalogPath: tagCatalogPath(resolved.storePath),
    catalog,
    revision: tagCatalogRevision(catalog),
  };
}

function requestedTag(input) {
  const id = normalizeTagId(isPlainObject(input) ? input.id : input);
  if (id === null) {
    throw codedError('TAG_ID_INVALID', `Not a usable tag id: ${JSON.stringify(input?.id ?? input)}`);
  }
  const description = normalizeDescription(isPlainObject(input) ? input.description : undefined);
  const aliasSource = isPlainObject(input) && input.aliases !== undefined ? input.aliases : [];
  if (!Array.isArray(aliasSource)) {
    throw codedError('TAG_ID_INVALID', `aliases for ${id} must be an array`, { tagId: id });
  }
  const aliases = [];
  for (const alias of aliasSource) {
    const normalized = normalizeTagId(alias);
    if (normalized === null) {
      throw codedError('TAG_ID_INVALID', `Not a usable tag alias: ${JSON.stringify(alias)}`, { tagId: id });
    }
    if (normalized !== id && !aliases.includes(normalized)) aliases.push(normalized);
  }
  return { id, description, aliases };
}

function mergeRequestedTags(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw codedError('TAG_INPUT_INVALID', 'ensure requires a non-empty tags array.');
  }
  const requested = new Map();
  for (const input of inputs) {
    const tag = requestedTag(input);
    const existing = requested.get(tag.id);
    if (!existing) {
      requested.set(tag.id, tag);
      continue;
    }
    existing.description = existing.description ?? tag.description;
    for (const alias of tag.aliases) {
      if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
  }
  return [...requested.values()];
}

function assertNoCollision(catalog, tag) {
  const resolvedId = resolveTagId(catalog, tag.id);
  if (resolvedId && resolvedId.via !== 'canonical') {
    throw codedError(
      'TAG_ID_COLLISION',
      `${tag.id} already resolves to the canonical tag ${resolvedId.id}; reuse it instead of creating a second identity.`,
      { tagId: tag.id, resolvedId: resolvedId.id, via: resolvedId.via },
    );
  }
  if (!resolvedId && Object.hasOwn(catalog.redirects, tag.id)) {
    throw codedError(
      'TAG_ID_COLLISION',
      `${tag.id} was retired by a merge and redirects to a missing tag.`,
      { tagId: tag.id, resolvedId: catalog.redirects[tag.id], via: 'redirect' },
    );
  }
  for (const alias of tag.aliases) {
    const resolvedAlias = resolveTagId(catalog, alias);
    if (resolvedAlias && resolvedAlias.id !== tag.id) {
      throw codedError(
        'TAG_ALIAS_COLLISION',
        `Alias ${alias} of ${tag.id} already belongs to the canonical tag ${resolvedAlias.id}.`,
        { tagId: tag.id, alias, resolvedId: resolvedAlias.id, via: resolvedAlias.via },
      );
    }
  }
}

function writeCatalog(storePath, catalog, options) {
  const sorted = sortedCatalog(catalog);
  atomicWriteJson(tagCatalogPath(storePath), sorted, options.atomicWriteOptions);
  return { catalog: sorted, revision: tagCatalogRevision(sorted) };
}

export async function ensureTags(options) {
  const requested = mergeRequestedTags(options.tags);
  const resolved = await resolveStore(options);
  const storePath = resolved.storePath;

  return withStoreLock(
    storePath,
    'ensure-tags',
    async () => {
      const catalog = readTagCatalog(storePath);
      const previousRevision = tagCatalogRevision(catalog);
      const results = [];
      let changed = false;

      for (const tag of requested) {
        assertNoCollision(catalog, tag);
        const existing = catalog.tags[tag.id];
        if (!existing) {
          if (tag.description === null) {
            throw codedError(
              'TAG_DESCRIPTION_REQUIRED',
              `Creating tag ${tag.id} requires a short description of its area.`,
              { tagId: tag.id },
            );
          }
          catalog.tags[tag.id] = { description: tag.description, aliases: [...tag.aliases] };
          changed = true;
          results.push({ id: tag.id, status: 'created', ...catalog.tags[tag.id] });
          continue;
        }
        const added = tag.aliases.filter((alias) => !existing.aliases.includes(alias));
        if (added.length > 0) {
          existing.aliases = [...existing.aliases, ...added].sort();
          changed = true;
        }
        results.push({ id: tag.id, status: 'existing', ...existing });
      }

      const written = changed
        ? writeCatalog(storePath, catalog, options)
        : { catalog: sortedCatalog(catalog), revision: previousRevision };
      return {
        ok: true,
        status: changed ? 'updated' : 'noop',
        storePath,
        catalogPath: tagCatalogPath(storePath),
        revision: written.revision,
        previousRevision,
        tags: results,
      };
    },
    options.lockOptions,
  );
}

function mergeSources(from, into) {
  const sources = Array.isArray(from) ? from : [from];
  if (sources.length === 0) throw codedError('TAG_INPUT_INVALID', 'merge requires a non-empty from list.');
  const normalized = [];
  for (const source of sources) {
    const id = normalizeTagId(source);
    if (id === null) {
      throw codedError('TAG_ID_INVALID', `Not a usable tag id: ${JSON.stringify(source)}`);
    }
    if (id === into) {
      throw codedError(
        'TAG_MERGE_TARGET_INVALID',
        `Cannot merge ${id} into itself.`,
        { tagId: id },
      );
    }
    if (!normalized.includes(id)) normalized.push(id);
  }
  return normalized;
}

/**
 * Consolidation is always explicit: the caller names the surviving tag and supplies the
 * catalog revision it read, and the retired ids keep resolving through redirects.
 */
export async function mergeTags(options) {
  const resolved = await resolveStore(options);
  const storePath = resolved.storePath;

  return withStoreLock(
    storePath,
    'merge-tags',
    async () => {
      const catalog = readTagCatalog(storePath);
      const currentRevision = tagCatalogRevision(catalog);
      if (!options.expectedRevision) {
        throw codedError(
          'TAG_CATALOG_REVISION_REQUIRED',
          `Merging tags requires --expected-revision ${currentRevision}.`,
          { status: 'conflict', currentRevision },
        );
      }
      if (options.expectedRevision !== currentRevision) {
        throw codedError(
          'TAG_CATALOG_REVISION_CONFLICT',
          `Expected catalog revision ${options.expectedRevision}, but the current revision is ${currentRevision}.`,
          { status: 'conflict', expectedRevision: options.expectedRevision, currentRevision },
        );
      }

      const targetId = normalizeTagId(options.into);
      if (targetId === null) {
        throw codedError(
          'TAG_MERGE_TARGET_INVALID',
          `Not a usable merge target: ${JSON.stringify(options.into)}`,
        );
      }
      const sources = mergeSources(options.from, targetId);
      const target = resolveTagId(catalog, targetId);
      if (!target) {
        throw codedError(
          'TAG_MERGE_TARGET_UNKNOWN',
          `Merge target ${targetId} is not a canonical tag.`,
          { tagId: targetId },
        );
      }

      const retired = [];
      for (const sourceId of sources) {
        const source = catalog.tags[sourceId];
        if (!source) {
          throw codedError(
            'TAG_MERGE_SOURCE_UNKNOWN',
            `Merge source ${sourceId} is not a canonical tag.`,
            { tagId: sourceId },
          );
        }
        if (sourceId === target.id) {
          throw codedError('TAG_MERGE_TARGET_INVALID', `Cannot merge ${sourceId} into itself.`, {
            tagId: sourceId,
          });
        }
        const survivor = catalog.tags[target.id];
        const aliases = new Set([...survivor.aliases, ...source.aliases]);
        aliases.delete(target.id);
        survivor.aliases = [...aliases].sort();
        delete catalog.tags[sourceId];
        catalog.redirects[sourceId] = target.id;
        retired.push(sourceId);
      }
      // Repoint older redirects so every retired id stays one hop from its canonical tag.
      for (const [from, to] of Object.entries(catalog.redirects)) {
        if (retired.includes(to)) catalog.redirects[from] = target.id;
      }

      const written = writeCatalog(storePath, catalog, options);
      return {
        ok: true,
        status: 'merged',
        storePath,
        catalogPath: tagCatalogPath(storePath),
        target: target.id,
        retired,
        redirects: written.catalog.redirects,
        revision: written.revision,
        previousRevision: currentRevision,
      };
    },
    options.lockOptions,
  );
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTag(id, entry, query) {
  if (query === id) return { rank: 0, matchedVia: 'id' };
  if (entry.aliases.includes(query)) return { rank: 1, matchedVia: 'alias' };
  if (id.replace(/-/g, ' ').includes(query)) return { rank: 2, matchedVia: 'id' };
  if (entry.aliases.some((alias) => alias.replace(/-/g, ' ').includes(query))) {
    return { rank: 3, matchedVia: 'alias' };
  }
  const description = normalizeSearchText(entry.description);
  const matched = query.split(' ').some((token) => ` ${description} `.includes(` ${token} `));
  return matched ? { rank: 4, matchedVia: 'description' } : null;
}

function encodeTagCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeTagCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed || typeof parsed.query !== 'string' || typeof parsed.revision !== 'string'
      || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
    ) throw new Error('invalid');
    return parsed;
  } catch {
    throw codedError('TAG_SEARCH_CURSOR_INVALID', 'Tag search cursor is invalid.');
  }
}

/**
 * Bounded vocabulary answers only: canonical names, descriptions, aliases, and derived
 * counts. Similarity here suggests reuse; it never consolidates anything.
 */
export async function searchTags(options) {
  const limit = Math.min(
    Math.max(Number.isInteger(options.limit) ? options.limit : DEFAULT_TAG_SEARCH_LIMIT, 1),
    MAX_TAG_SEARCH_LIMIT,
  );
  const resolved = await resolveStore(options, { readOnly: true });
  if (!resolved.storePath) return { results: [], total: 0, truncated: false, revision: null, cursor: null };

  const catalog = readTagCatalog(resolved.storePath);
  const usage = deriveTagUsage(resolved.storePath, catalog);
  const query = normalizeSearchText(options.query);
  const normalizedQuery = query === '' ? '' : query.replace(/\s+/g, ' ');
  const revision = tagCatalogRevision(catalog);
  const pageCursor = decodeTagCursor(options.cursor);
  if (pageCursor && (pageCursor.query !== normalizedQuery || pageCursor.revision !== revision)) {
    throw codedError('TAG_SEARCH_CURSOR_STALE', 'Tag catalog changed; restart the query.');
  }

  const matches = [];
  for (const [id, entry] of Object.entries(catalog.tags)) {
    const score = normalizedQuery === ''
      ? { rank: 0, matchedVia: 'catalog' }
      : scoreTag(id, entry, normalizedQuery);
    if (!score) continue;
    matches.push({
      id,
      description: entry.description,
      aliases: [...entry.aliases],
      recordCount: usage[id] ?? 0,
      matchedVia: score.matchedVia,
      rank: score.rank,
    });
  }
  matches.sort((left, right) => left.rank - right.rank || (left.id < right.id ? -1 : 1));

  const results = [];
  const offset = pageCursor?.offset || 0;
  for (let position = offset; position < matches.length && results.length < limit; position += 1) {
    const { rank, ...result } = matches[position];
    const candidate = [...results, result];
    const next = offset + candidate.length;
    const page = {
      results: candidate,
      total: matches.length,
      truncated: next < matches.length,
      revision,
      cursor: next < matches.length ? encodeTagCursor({ query: normalizedQuery, revision, offset: next }) : null,
    };
    if (measurePayload('codex', JSON.stringify(page)).measured > TAG_SEARCH_TOKEN_LIMIT) break;
    results.push(result);
  }

  return {
    results,
    total: matches.length,
    truncated: offset + results.length < matches.length,
    revision,
    cursor: offset + results.length < matches.length
      ? encodeTagCursor({ query: normalizedQuery, revision, offset: offset + results.length })
      : null,
  };
}

const TAG_OPERATIONS = new Set(['ensure', 'merge']);

export function readTagOperationFile(inputPath) {
  if (!inputPath) throw codedError('TAG_INPUT_INVALID', 'Missing required --input <path>.');
  const absolutePath = path.resolve(inputPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw codedError('TAG_INPUT_INVALID', `${absolutePath}: ${error.message}`);
  }
  if (!isPlainObject(parsed) || !TAG_OPERATIONS.has(parsed.operation)) {
    throw codedError(
      'TAG_INPUT_INVALID',
      `${absolutePath}: operation must be one of ${[...TAG_OPERATIONS].join(', ')}.`,
    );
  }
  if (parsed.operation === 'ensure') {
    if (!Array.isArray(parsed.tags) || parsed.tags.length === 0) {
      throw codedError('TAG_INPUT_INVALID', `${absolutePath}: ensure requires a non-empty tags array.`);
    }
    return { operation: 'ensure', tags: parsed.tags };
  }
  if (!Array.isArray(parsed.from) || parsed.from.length === 0 || typeof parsed.into !== 'string') {
    throw codedError('TAG_INPUT_INVALID', `${absolutePath}: merge requires from[] and into.`);
  }
  return {
    operation: 'merge',
    from: parsed.from,
    into: parsed.into,
    expectedRevision: parsed.expectedRevision,
  };
}

export async function applyTagOperationFile(options) {
  const { operation, ...request } = readTagOperationFile(options.inputPath);
  return operation === 'ensure'
    ? ensureTags({ ...options, ...request })
    : mergeTags({ ...options, ...request });
}

export function serializeTagError(error) {
  const code = error?.code || 'TAG_OPERATION_FAILED';
  return {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.tagId ? { tagId: error.tagId } : {}),
    ...(error?.alias ? { alias: error.alias } : {}),
    ...(error?.resolvedId ? { resolvedId: error.resolvedId } : {}),
    ...(error?.expectedRevision ? { expectedRevision: error.expectedRevision } : {}),
    ...(error && Object.hasOwn(error, 'currentRevision')
      ? { currentRevision: error.currentRevision }
      : {}),
  };
}

export {
  DEFAULT_TAG_SEARCH_LIMIT,
  MAX_TAG_SEARCH_LIMIT,
  TAG_SEARCH_TOKEN_LIMIT,
  TAG_CATALOG_FILE_NAME,
  TAG_CATALOG_SCHEMA_VERSION,
};
