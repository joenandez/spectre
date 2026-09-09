import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseHistoricalKnowledgeRecord,
  renderKnowledgeRecord,
  revisionDirectoryName,
  revisionTokenFromDirectoryName,
  RECORD_FILE_NAME,
} from './records.mjs';
import { resolveProjectStore, withStoreLock } from './store.mjs';

const RECORD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HISTORY_PREVIEW_LIMIT = 5;
const HISTORY_PREVIEW_TOKEN_BUDGET = 500;

function historyError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function validateExactId(id) {
  if (typeof id !== 'string' || !RECORD_ID_PATTERN.test(id)) {
    throw historyError('KNOWLEDGE_INVALID', 'Knowledge ID must be an exact canonical record ID.');
  }
}

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
}

function historyFingerprint(revisions) {
  return createHash('sha256').update(JSON.stringify(revisions)).digest('hex');
}

function encodeHistoryCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeHistoryCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed || typeof parsed.id !== 'string' || typeof parsed.revisions !== 'string'
      || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
    ) throw new Error('invalid');
    return parsed;
  } catch {
    throw historyError('KNOWLEDGE_HISTORY_CURSOR_INVALID', 'Knowledge history cursor is invalid.');
  }
}

function historyDirectory(storePath, id) {
  return path.join(storePath, 'knowledge-history', id);
}

function readHistoricalPackage(storePath, id, revisionToken) {
  const directoryName = revisionDirectoryName(revisionToken);
  const recordDirectory = path.resolve(historyDirectory(storePath, id), directoryName);
  const expectedRoot = `${path.resolve(historyDirectory(storePath, id))}${path.sep}`;
  if (!recordDirectory.startsWith(expectedRoot)) {
    throw historyError('KNOWLEDGE_INVALID', 'Knowledge revision escapes its history directory.');
  }
  const recordPath = path.join(recordDirectory, RECORD_FILE_NAME);
  let directoryStat;
  let recordStat;
  try {
    directoryStat = fs.lstatSync(recordDirectory);
    recordStat = fs.lstatSync(recordPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw historyError('KNOWLEDGE_REVISION_NOT_FOUND', `Knowledge revision not found: ${id} ${revisionToken}`);
    }
    throw historyError('KNOWLEDGE_INVALID', `Knowledge revision could not be inspected: ${id}`, { cause: error });
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw historyError('KNOWLEDGE_INVALID', `Knowledge revision is not a safe canonical package: ${id}`);
  }
  let parsed;
  try {
    parsed = parseHistoricalKnowledgeRecord(recordPath, id);
  } catch (error) {
    throw historyError('KNOWLEDGE_INVALID', error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (parsed.record.id !== id || parsed.revisionToken !== revisionToken) {
    throw historyError('KNOWLEDGE_CHANGED_DURING_READ', `Knowledge revision did not verify: ${id} ${revisionToken}`);
  }
  return { recordDirectory, recordPath, parsed };
}

export async function inspectKnowledgeRevision(options = {}) {
  validateExactId(options.id);
  const revisionToken = options.revisionToken ?? options.revision;
  try { revisionDirectoryName(revisionToken); } catch (error) {
    throw historyError('KNOWLEDGE_INVALID', error instanceof Error ? error.message : String(error));
  }
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const resolved = await resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    readOnly: true,
  });
  if (!resolved.storePath) throw historyError('KNOWLEDGE_NOT_FOUND', `Knowledge record not found: ${options.id}`);
  return withStoreLock(resolved.storePath, 'inspect-knowledge-history', async () => {
    const { recordDirectory, recordPath, parsed } = readHistoricalPackage(resolved.storePath, options.id, revisionToken);
    return {
      ok: true,
      status: 'loaded',
      id: parsed.record.id,
      kind: parsed.record.kind,
      applicability: parsed.record.applicability,
      revisionToken: parsed.revisionToken,
      historical: true,
      activation: 'historical',
      record: parsed.record,
      rendered: renderKnowledgeRecord(parsed.record),
      recordPath,
      recordDirectory,
      resources: [...parsed.resources],
    };
  }, options.lockOptions);
}

export async function listKnowledgeHistory(options = {}) {
  validateExactId(options.id);
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const resolved = await resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    readOnly: true,
  });
  if (!resolved.storePath) return { ok: true, id: options.id, entries: [], cursor: null };
  return withStoreLock(resolved.storePath, 'list-knowledge-history', async () => {
    const root = historyDirectory(resolved.storePath, options.id);
    let directories;
    try {
      directories = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, id: options.id, entries: [], cursor: null };
      throw historyError('KNOWLEDGE_INVALID', `Knowledge history could not be read: ${options.id}`, { cause: error });
    }
    const revisions = directories
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => revisionTokenFromDirectoryName(entry.name))
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left));
    const revisionsFingerprint = historyFingerprint(revisions);
    const pageCursor = decodeHistoryCursor(options.cursor);
    if (
      pageCursor
      && (pageCursor.id !== options.id || pageCursor.revisions !== revisionsFingerprint)
    ) {
      throw historyError('KNOWLEDGE_HISTORY_CURSOR_STALE', 'Knowledge history changed; restart the listing.');
    }
    const offset = pageCursor?.offset || 0;
    const entries = [];
    for (let position = offset; position < revisions.length && entries.length < HISTORY_PREVIEW_LIMIT; position += 1) {
      const revisionToken = revisions[position];
      const { parsed } = readHistoricalPackage(resolved.storePath, options.id, revisionToken);
      const entry = {
        id: parsed.record.id,
        kind: parsed.record.kind,
        summary: parsed.record.summary,
        applicability: parsed.record.applicability,
        revisionToken,
        historical: true,
      };
      const candidate = [...entries, entry];
      const next = offset + candidate.length;
      const page = {
        ok: true,
        id: options.id,
        entries: candidate,
        cursor: next < revisions.length
          ? encodeHistoryCursor({ id: options.id, revisions: revisionsFingerprint, offset: next })
          : null,
      };
      if (estimateTokens(page) > HISTORY_PREVIEW_TOKEN_BUDGET) break;
      entries.push(entry);
    }
    const next = offset + entries.length;
    return {
      ok: true,
      id: options.id,
      entries,
      cursor: next < revisions.length
        ? encodeHistoryCursor({ id: options.id, revisions: revisionsFingerprint, offset: next })
        : null,
    };
  }, options.lockOptions);
}

export { HISTORY_PREVIEW_LIMIT, HISTORY_PREVIEW_TOKEN_BUDGET };
