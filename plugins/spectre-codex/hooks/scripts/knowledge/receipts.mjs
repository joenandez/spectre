import fs from 'node:fs';
import path from 'node:path';

export const IMPORT_RECEIPTS_FILE_NAME = 'import-receipts.json';
export const IMPORT_RECEIPTS_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function importReceiptsPath(storePath) {
  return path.join(storePath, IMPORT_RECEIPTS_FILE_NAME);
}

export function readImportReceipts(storePath) {
  const empty = { schemaVersion: IMPORT_RECEIPTS_SCHEMA_VERSION, receipts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(importReceiptsPath(storePath), 'utf8'));
    if (parsed?.schemaVersion !== IMPORT_RECEIPTS_SCHEMA_VERSION || !Array.isArray(parsed.receipts)) {
      return empty;
    }
    return parsed;
  } catch {
    return empty;
  }
}

/** A rerun of an already-imported source is a no-op; the importer looks it up here first. */
export function findImportReceipt(storePath, sourceDigest) {
  return readImportReceipts(storePath).receipts
    .find((receipt) => receipt.sourceDigest === sourceDigest) || null;
}

export function validateImportReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('An import receipt must be an object.');
  }
  for (const key of Object.keys(receipt)) {
    if (!['sourceDigest', 'sourcePath', 'recordId', 'revisionToken', 'importedAt'].includes(key)) {
      throw new Error(`Unknown import receipt field ${key}.`);
    }
  }
  if (!DIGEST_PATTERN.test(receipt.sourceDigest)) {
    throw new Error('An import receipt requires a sha256 sourceDigest of the imported source.');
  }
  if (receipt.sourcePath !== undefined && typeof receipt.sourcePath !== 'string') {
    throw new Error('An import receipt sourcePath must be a string.');
  }
  if (receipt.recordId !== undefined && typeof receipt.recordId !== 'string') {
    throw new Error('An import receipt recordId must be a string.');
  }
  if (receipt.revisionToken !== undefined && !REVISION_PATTERN.test(receipt.revisionToken)) {
    throw new Error('An import receipt revisionToken must be a sha256 revision token.');
  }
  if (receipt.importedAt !== undefined && typeof receipt.importedAt !== 'string') {
    throw new Error('An import receipt importedAt must be an ISO timestamp.');
  }
  return receipt;
}

/** Pure: the receipts document that maps one source digest to its destination revision. */
export function withImportReceipt(receipts, receipt) {
  const next = receipts.receipts.filter(
    (existing) => existing.sourceDigest !== receipt.sourceDigest,
  );
  next.push(receipt);
  next.sort((left, right) => left.sourceDigest.localeCompare(right.sourceDigest));
  return { schemaVersion: IMPORT_RECEIPTS_SCHEMA_VERSION, receipts: next };
}
