import { createHash } from 'node:crypto';

import { measurePayload } from './payload.mjs';
import { refreshKnowledgeIndex } from './records.mjs';
import { readTagCatalog, resolveTagId, tagCatalogRevision } from './tags.mjs';
import { resolveProjectStore } from './store.mjs';

const SEARCH_RESPONSE_TOKEN_LIMIT = 500;
const SEARCH_RESULT_LIMIT = 5;
const LOW_INFORMATION_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'use', 'with',
]);

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  const normalized = normalizeSearchText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

function indexFingerprint(index) {
  return createHash('sha256')
    .update(JSON.stringify(index.records.map((entry) => [entry.id, entry.revisionToken])))
    .digest('hex');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value.query !== 'string' || typeof value.index !== 'string' || typeof value.catalog !== 'string'
      || !Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string')
      || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error('invalid');
    return value;
  } catch {
    throw codedError('SEARCH_CURSOR_INVALID', 'Search cursor is invalid.');
  }
}

function cursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function activation(entry, options) {
  if (entry.kind === 'work') {
    return { historical: true, value: entry.imported ? 'imported-history' : 'work-history' };
  }
  if (entry.status !== 'active') return { historical: true, value: 'inactive-history' };
  if (entry.applicability.scope === 'project') return { historical: false, value: 'current-guidance' };
  const matchingWork = options.workId === entry.applicability.workId;
  const matchingRun = entry.applicability.runIds?.includes(options.runId);
  return matchingWork || matchingRun
    ? { historical: false, value: 'current-guidance' }
    : { historical: true, value: 'work-history' };
}

function tagCatalog(storePath) {
  try {
    return readTagCatalog(storePath);
  } catch {
    return { tags: {}, redirects: {} };
  }
}

function tagTerms(entry, catalog) {
  return entry.tags.flatMap((tag) => {
    const resolved = resolveTagId(catalog, tag);
    return resolved
      ? [resolved.id, ...catalog.tags[resolved.id].aliases, catalog.tags[resolved.id].description]
      : [tag];
  });
}

function resolvedTags(catalog, requestedTags) {
  if (requestedTags === undefined) return [];
  if (!Array.isArray(requestedTags) || requestedTags.some((tag) => typeof tag !== 'string')) {
    throw codedError('SEARCH_TAG_INVALID', 'Search tags must be an array of tag IDs.');
  }
  const resolved = requestedTags.map((tag) => resolveTagId(catalog, tag));
  const missing = requestedTags.find((tag, index) => resolved[index] === null);
  if (missing !== undefined) {
    throw codedError('SEARCH_TAG_UNKNOWN', `Search tag does not resolve: ${missing}`);
  }
  return [...new Set(resolved.map(({ id }) => id))].sort();
}

function entryTags(entry, catalog) {
  return new Set(entry.tags.map((tag) => resolveTagId(catalog, tag)?.id || tag));
}

function fieldMatches(values, queryTokens, query) {
  const normalized = values.filter(Boolean).map(normalizeSearchText);
  const available = new Set(normalized.flatMap((value) => value.split(' ')));
  const terms = queryTokens.filter((token) => available.has(token));
  const phrase = query !== '' && normalized.some((value) => ` ${value} `.includes(` ${query} `));
  return { terms: [...new Set(terms)], phrase };
}

function score(entry, query, queryTokens, catalog, paths, requestedTags) {
  const fields = [
    ['use-when', [entry.useWhen]],
    ['summary', [entry.summary]],
    ['cue', entry.cues || []],
    ['title', [entry.id, entry.title]],
    ['tag', tagTerms(entry, catalog)],
    ['body', [entry.sourceBody]],
  ];
  const pathTokens = [...new Set(paths.flatMap(tokens).filter((token) => !LOW_INFORMATION_TOKENS.has(token)))];
  const matches = fields.map(([field, values]) => ({ field, ...fieldMatches(values, queryTokens, query) }));
  const metadata = matches.filter(({ field }) => field !== 'body');
  const body = matches.find(({ field }) => field === 'body');
  const pathMatches = metadata.flatMap(({ field }) => fieldMatches(
    fields.find(([name]) => name === field)[1], pathTokens, '',
  ).terms.map((term) => `path:${term}`));
  const metadataSignals = metadata.flatMap(({ field, terms, phrase }) => [
    ...(phrase ? [`${field}:phrase`] : []), ...terms.map((term) => `${field}:${term}`),
  ]);
  const bodySignals = body ? [
    ...(body.phrase ? ['body:phrase'] : []), ...body.terms.map((term) => `body:${term}`),
  ] : [];
  const tagFilterSignals = queryTokens.length === 0
    ? requestedTags.map((tag) => `tag:${tag}`)
    : [];
  const signals = [...new Set([...pathMatches, ...metadataSignals, ...bodySignals, ...tagFilterSignals])].slice(0, 4);
  const metadataCoverage = new Set(metadata.flatMap(({ terms }) => terms)).size;
  const bodyCoverage = new Set(body?.terms || []).size;
  return {
    tier: pathMatches.length > 0 ? 4 : metadataCoverage > 0 || tagFilterSignals.length > 0 ? 3 : bodyCoverage > 0 ? 1 : 0,
    coverage: Math.max(metadataCoverage, bodyCoverage) + pathMatches.length,
    signals,
  };
}

function compare(left, right) {
  if (left.tier !== right.tier) return right.tier - left.tier;
  if (left.coverage !== right.coverage) return right.coverage - left.coverage;
  if (left.current !== right.current) return left.current ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function preview(entry, match, state) {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.kind === 'knowledge' ? { useWhen: entry.useWhen } : { summary: entry.summary }),
    tags: entry.tags,
    matchedSignals: match.signals,
    applicability: entry.applicability,
    activation: state.value,
    historical: state.historical,
    revisionToken: entry.revisionToken,
    estimatedLoadTokens: Math.ceil(entry.sourceSize / 4),
    loadCommand: `knowledge-cli.mjs load ${entry.id}${state.historical ? ' --inspect-historical' : ''} --project-dir <project-dir>`,
  };
}

function truncatePreviewText(value, limit) {
  const oneLine = String(value ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, Math.max(limit - 1, 0)).trimEnd()}…`;
}

function minimumPreview(entry, descriptionLimit = 160) {
  const description = entry.kind === 'knowledge' ? 'useWhen' : 'summary';
  return {
    id: entry.id,
    kind: entry.kind,
    [description]: truncatePreviewText(entry[description], descriptionLimit),
    tags: entry.tags,
    matchedSignals: entry.matchedSignals.length > 0 ? entry.matchedSignals.slice(0, 2) : ['title:browse'],
    activation: entry.activation,
    historical: entry.historical,
    estimatedLoadTokens: entry.estimatedLoadTokens,
  };
}

function boundedPage(results, base, limit, cursorState, offset) {
  const entries = [];
  const end = Math.min(results.length, offset + limit);
  const responseFor = (candidate) => {
    const next = offset + candidate.length;
    return {
      ...base,
      results: candidate,
      ...(next < results.length ? { cursor: cursor({ ...cursorState, offset: next }) } : { cursor: null }),
    };
  };
  const fits = (candidate) => {
    const { warnings: _warnings, ...resultPage } = responseFor(candidate);
    return measurePayload('codex', JSON.stringify(resultPage)).measured <= SEARCH_RESPONSE_TOKEN_LIMIT;
  };
  for (let position = offset; position < end; position += 1) {
    const candidate = [...entries, results[position]];
    if (!fits(candidate)) {
      const compact = minimumPreview(results[position]);
      if (fits([...entries, compact])) {
        entries.push(compact);
        continue;
      }
      if (entries.length === 0) {
        return {
          ...base,
          results: [],
          cursor: null,
          status: 'page-entry-too-large',
          error: {
            code: 'SEARCH_RESULT_TOO_LARGE',
            limit: SEARCH_RESPONSE_TOKEN_LIMIT,
            message: `No decision-bearing search preview fits the ${SEARCH_RESPONSE_TOKEN_LIMIT}-token response budget.`,
          },
        };
      }
      break;
    }
    entries.push(results[position]);
  }
  return responseFor(entries);
}

export async function searchKnowledge(options = {}) {
  if (!options.projectDir) throw new Error('projectDir is required');
  const resolved = await resolveProjectStore(options.projectDir, {
    spectreHome: options.spectreHome, gitRunner: options.gitRunner, readOnly: true,
  });
  if (!resolved.storePath) {
    if (options.tags?.length) throw codedError('SEARCH_TAG_UNKNOWN', 'Search tags require a known tag catalog.');
    return { results: [], warnings: [], cursor: null };
  }
  const { index, errors } = refreshKnowledgeIndex(resolved.storePath);
  const query = normalizeSearchText(options.query);
  const fingerprint = indexFingerprint(index);
  const kind = options.kind || 'all';
  if (!['all', 'knowledge', 'work'].includes(kind)) {
    throw codedError('SEARCH_KIND_INVALID', `Unsupported search kind: ${kind}`);
  }
  const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : SEARCH_RESULT_LIMIT, 1), SEARCH_RESULT_LIMIT);
  const catalog = tagCatalog(resolved.storePath);
  const catalogRevision = tagCatalogRevision(catalog);
  const requestedTags = resolvedTags(catalog, options.tags);
  const pageCursor = decodeCursor(options.cursor);
  if (pageCursor && (pageCursor.query !== query || pageCursor.index !== fingerprint
    || pageCursor.catalog !== catalogRevision || JSON.stringify(pageCursor.tags) !== JSON.stringify(requestedTags))) {
    throw codedError('SEARCH_CURSOR_STALE', 'Search results changed; restart the query.');
  }
  const queryTokens = tokens(query).filter((token) => !LOW_INFORMATION_TOKENS.has(token));
  const paths = Array.isArray(options.paths) ? options.paths : [];
  const ranked = index.records
    .filter((entry) => kind === 'all' || entry.kind === kind)
    .filter((entry) => requestedTags.length === 0 || requestedTags.some((tag) => entryTags(entry, catalog).has(tag)))
    .map((entry) => {
      const state = activation(entry, options);
      const match = score(entry, query, queryTokens, catalog, paths, requestedTags);
      return { ...preview(entry, match, state), tier: match.tier, coverage: match.coverage, current: !state.historical };
    })
    .filter((entry) => query === '' || entry.tier > 0)
    .sort(compare)
    .map(({ tier, coverage, current, ...entry }) => entry);
  return boundedPage(
    ranked,
    { results: [], warnings: errors, query, index: fingerprint },
    limit,
    { query, index: fingerprint, catalog: catalogRevision, tags: requestedTags },
    pageCursor?.offset || 0,
  );
}

export function formatKnowledgeSearchHuman({ results, error }, query = '') {
  if (error) return `${error.message}\n`;
  if (results.length === 0) return query ? `No knowledge matches "${query}".\n` : 'No knowledge found.\n';
  return `${results.map((result) => `${result.id} [${result.kind}]${result.historical ? ` [historical: ${result.activation}]` : ''}\n  ${result.summary || result.useWhen}\n  tags: ${result.tags.join(', ') || 'none'}; match: ${result.matchedSignals.join(', ') || 'browse'}; load: ${result.estimatedLoadTokens} tokens\n  ${result.loadCommand || `knowledge-cli.mjs load ${result.id}${result.historical ? ' --inspect-historical' : ''} --project-dir <project-dir>`}`).join('\n\n')}\n`;
}

export function formatKnowledgeSearchWarningsHuman(warnings = []) {
  return warnings.map((warning) => `spectre: skipped invalid knowledge record: ${warning.message}\n`).join('');
}

export { normalizeSearchText, SEARCH_RESPONSE_TOKEN_LIMIT, SEARCH_RESULT_LIMIT };
