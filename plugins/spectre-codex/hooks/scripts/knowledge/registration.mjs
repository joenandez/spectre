import fs from 'node:fs';
import path from 'node:path';

import {
  RECORD_FILE_NAME,
  parseKnowledgeRecord,
  readRecordRevision,
  refreshKnowledgeIndex,
  revisionDirectoryName,
} from './records.mjs';
import {
  findImportReceipt,
  importReceiptsPath,
  readImportReceipts,
  validateImportReceipt,
  withImportReceipt,
} from './receipts.mjs';
import {
  atomicWriteFile,
  atomicWriteJson,
  resolveProjectStore,
  withStoreLock,
} from './store.mjs';
import { assertWorkRecordAssociations } from './work.mjs';

const RETIRED_NATIVE_RECORD_IDS = new Set(['spectre-recall', 'spectre-find']);

function codedError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function proposalRecordDir(recordPath) {
  if (!recordPath) {
    throw codedError('MISSING_RECORD', 'Missing required --record <path>.');
  }
  const absolutePath = path.resolve(recordPath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    throw codedError('MISSING_RECORD', `Record path does not exist: ${absolutePath}`);
  }
  return stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
}

function validateSourcePackage(sourceDir) {
  const recordPath = path.join(sourceDir, RECORD_FILE_NAME);
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(sourceDir);
  } catch {
    throw codedError('KNOWLEDGE_RECORD_INVALID', `Typed record package must contain ${RECORD_FILE_NAME}: ${sourceDir}`);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw codedError('KNOWLEDGE_RECORD_INVALID', `Typed record package is not a safe directory: ${sourceDir}`);
  }
  let recordStat;
  try {
    recordStat = fs.lstatSync(recordPath);
  } catch {
    if (fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      throw codedError(
        'KNOWLEDGE_LEGACY_WRITE_RETIRED',
        'Legacy SKILL.md packages are retired. Run `node "${PLUGIN_ROOT}/hooks/scripts/knowledge-cli.mjs" migrate` to preserve the source, then update the typed record.',
      );
    }
    throw codedError('KNOWLEDGE_RECORD_INVALID', `Typed record package must contain ${RECORD_FILE_NAME}: ${sourceDir}`);
  }
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw codedError('KNOWLEDGE_RECORD_INVALID', `Typed record package is not a safe directory: ${sourceDir}`);
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch {
    throw codedError('KNOWLEDGE_RECORD_INVALID', `Typed record package has malformed ${RECORD_FILE_NAME}: ${sourceDir}`);
  }
  if (!record || typeof record.id !== 'string' || path.basename(sourceDir) !== record.id) {
    throw codedError(
      'KNOWLEDGE_RECORD_INVALID',
      `Typed record package must use <exact-id>/${RECORD_FILE_NAME}; expected ${record?.id || '<record-id>'}/${RECORD_FILE_NAME}.`,
    );
  }
}

function sourceContainsStore(sourceDir, storePath) {
  const source = fs.realpathSync.native(sourceDir);
  const store = fs.realpathSync.native(storePath);
  return store === source || store.startsWith(`${source}${path.sep}`);
}

function sourceIsInsideStore(sourceDir, storePath) {
  const source = fs.realpathSync.native(sourceDir);
  const store = fs.realpathSync.native(storePath);
  return source === store || source.startsWith(`${store}${path.sep}`);
}

function indexedRevision(storePath, id) {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(storePath, 'index.json'), 'utf8'));
    const entry = Array.isArray(index?.records) ? index.records.find((record) => record?.id === id) : null;
    return typeof entry?.revisionToken === 'string' ? entry.revisionToken : null;
  } catch {
    return null;
  }
}

function copyDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw codedError('KNOWLEDGE_RECORD_INVALID', `${sourcePath}: symlinks are not supported`);
    }
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      throw codedError('KNOWLEDGE_RECORD_INVALID', `${sourcePath}: unsupported filesystem entry`);
    }
  }
}

function removeRegistrationStages(storePath) {
  for (const entry of fs.readdirSync(storePath, { withFileTypes: true })) {
    if (entry.name.startsWith('.registration-stage-') && entry.isDirectory()) {
      const match = /^\.registration-stage-(\d+)-\d+$/.exec(entry.name);
      const pid = Number(match?.[1]);
      let alive = false;
      try {
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
        alive = Number.isInteger(pid) && pid > 0;
      } catch {
        // A stage whose owner no longer exists is safe to remove.
      }
      if (!alive) fs.rmSync(path.join(storePath, entry.name), { recursive: true, force: true });
    }
  }
}

export function recoverInterruptedRecordReplacements(storePath) {
  const knowledgeDir = path.join(storePath, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return [];

  const backupsByDestination = new Map();
  for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const match = /^(.*)\.previous-(\d+)-(\d+)$/.exec(entry.name);
    if (!match || match[1] === '') continue;
    const destinationPath = path.join(knowledgeDir, match[1]);
    const backups = backupsByDestination.get(destinationPath) || [];
    backups.push({
      backupPath: path.join(knowledgeDir, entry.name),
      timestamp: Number(match[3]),
    });
    backupsByDestination.set(destinationPath, backups);
  }

  const recoveredIds = [];
  for (const [destinationPath, backups] of backupsByDestination) {
    backups.sort(
      (left, right) =>
        right.timestamp - left.timestamp
        || left.backupPath.localeCompare(right.backupPath),
    );
    if (!fs.existsSync(destinationPath)) {
      fs.renameSync(backups[0].backupPath, destinationPath);
      backups.shift();
    }
    for (const { backupPath } of backups) {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
    recoveredIds.push(path.basename(destinationPath));
  }
  return recoveredIds;
}

function beginRecordDirectoryReplacement(destinationPath, stagePath) {
  const backupPath = `${destinationPath}.previous-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    if (fs.existsSync(destinationPath)) {
      fs.renameSync(destinationPath, backupPath);
      backedUp = true;
    }
    fs.renameSync(stagePath, destinationPath);
  } catch (error) {
    if (backedUp) fs.rmSync(destinationPath, { recursive: true, force: true });
    if (backedUp && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, destinationPath);
    }
    throw error;
  }
  return {
    commit() {
      if (backedUp) fs.rmSync(backupPath, { recursive: true, force: true });
    },
    rollback() {
      fs.rmSync(destinationPath, { recursive: true, force: true });
      if (backedUp && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, destinationPath);
      }
    },
  };
}

function validateStagedRecord(stagePath) {
  if (
    !fs.existsSync(path.join(stagePath, RECORD_FILE_NAME))
    && fs.existsSync(path.join(stagePath, 'SKILL.md'))
  ) {
    throw codedError(
      'KNOWLEDGE_LEGACY_WRITE_RETIRED',
      'Legacy SKILL.md packages are retired. Run `node "${PLUGIN_ROOT}/hooks/scripts/knowledge-cli.mjs" migrate` to preserve the source, then update the typed record.',
    );
  }
  let parsed;
  try {
    parsed = parseKnowledgeRecord(path.join(stagePath, RECORD_FILE_NAME));
  } catch (error) {
    throw codedError(
      'KNOWLEDGE_RECORD_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (RETIRED_NATIVE_RECORD_IDS.has(parsed.record.id)) {
    throw codedError(
      'KNOWLEDGE_RECORD_INVALID',
      `${parsed.record.id} is a retired generated recall surface, not learned knowledge`,
    );
  }
  return parsed;
}

/**
 * Compare-and-swap over the whole package: a create requires absence, a replacement
 * requires the caller's expected token, and identical content never rewrites the store.
 */
function resolveRegistrationOutcome({ id, destinationPath, expectedRevision, stagedRevision, indexedCurrentRevision }) {
  const exists = fs.existsSync(destinationPath);
  const currentRevision = exists ? readRecordRevision(destinationPath) : null;
  if (!exists) {
    if (expectedRevision) {
      throw codedError(
        'KNOWLEDGE_REVISION_CONFLICT',
        `Expected revision ${expectedRevision} for ${id}, but no record exists to replace.`,
        { status: 'conflict', expectedRevision, currentRevision: null },
      );
    }
    return { status: 'created', currentRevision: null };
  }
  if (currentRevision === null) {
    throw codedError(
      'KNOWLEDGE_CURRENT_RECORD_UNREADABLE',
      `Current record ${id} is unreadable. Preserve or recover its package before retrying; migration cannot replace an unreadable typed record.`,
      { status: 'conflict', currentRevision: null },
    );
  }
  if (indexedCurrentRevision && indexedCurrentRevision !== currentRevision) {
    throw codedError(
      'KNOWLEDGE_CURRENT_RECORD_MISMATCH',
      `Current record ${id} differs from its persisted index revision. Preserve or recover the package before retrying.`,
      { status: 'conflict', currentRevision, indexedRevision: indexedCurrentRevision },
    );
  }
  if (currentRevision === stagedRevision) {
    return { status: 'noop', currentRevision };
  }
  if (!expectedRevision) {
    throw codedError(
      'KNOWLEDGE_REVISION_REQUIRED',
      `Replacing ${id} requires --expected-revision ${currentRevision ?? '<unreadable current package>'}.`,
      { status: 'conflict', currentRevision },
    );
  }
  if (expectedRevision !== currentRevision) {
    throw codedError(
      'KNOWLEDGE_REVISION_CONFLICT',
      `Expected revision ${expectedRevision} for ${id}, but the current revision is `
        + `${currentRevision ?? '<unreadable current package>'}.`,
      { status: 'conflict', expectedRevision, currentRevision },
    );
  }
  return { status: 'updated', currentRevision };
}

/**
 * Archive first: the complete prior package is published immutably under
 * knowledge-history/<id>/<revisionToken>/ before the destination is replaced.
 */
function archivePriorRevision(storePath, id, destinationPath, currentRevision, stageRoot) {
  const directoryName = revisionDirectoryName(currentRevision);
  const historyPath = path.join(storePath, 'knowledge-history', id, directoryName);
  if (fs.existsSync(historyPath)) return { historyPath, published: false };
  const stagedHistory = path.join(stageRoot, 'history', directoryName);
  copyDirectory(destinationPath, stagedHistory);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.renameSync(stagedHistory, historyPath);
  return { historyPath, published: true };
}

function commitImportReceipt(storePath, receipt, recordId, revisionToken, now) {
  const receiptsPath = importReceiptsPath(storePath);
  const priorBytes = fs.existsSync(receiptsPath) ? fs.readFileSync(receiptsPath) : null;
  const entry = {
    sourceDigest: receipt.sourceDigest,
    ...(receipt.sourcePath === undefined ? {} : { sourcePath: receipt.sourcePath }),
    recordId,
    revisionToken,
    importedAt: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
  };
  atomicWriteJson(receiptsPath, withImportReceipt(readImportReceipts(storePath), entry));
  return { receiptsPath, priorBytes, entry };
}

function restoreBytes(filePath, priorBytes) {
  if (priorBytes === null) fs.rmSync(filePath, { force: true });
  else atomicWriteFile(filePath, priorBytes);
}

export async function registerCanonicalKnowledge(options) {
  const projectDir = path.resolve(options.projectDir || options.projectRoot || process.cwd());
  const sourceDir = proposalRecordDir(options.recordPath || options.record);
  validateSourcePackage(sourceDir);
  let importReceipt = null;
  if (options.importReceipt) {
    try {
      importReceipt = validateImportReceipt(options.importReceipt);
    } catch (error) {
      throw codedError('KNOWLEDGE_IMPORT_RECEIPT_INVALID', error.message);
    }
  }
  const resolved = await resolveProjectStore(projectDir, {
    spectreHome: options.spectreHome,
    gitRunner: options.gitRunner,
    allocationLockOptions: options.allocationLockOptions,
  });
  const storePath = resolved.storePath;
  if (sourceContainsStore(sourceDir, storePath)) {
    throw codedError(
      'KNOWLEDGE_RECORD_INVALID',
      `Typed record package contains the knowledge store and cannot be registered: ${sourceDir}`,
    );
  }
  if (sourceIsInsideStore(sourceDir, storePath)) {
    throw codedError(
      'KNOWLEDGE_RECORD_INVALID',
      `Typed record package is inside the knowledge store and cannot be registered: ${sourceDir}`,
    );
  }

  return withStoreLock(
    storePath,
    'register-knowledge',
    async () => {
      removeRegistrationStages(storePath);
      const recoveredRecordIds = recoverInterruptedRecordReplacements(storePath);
      if (recoveredRecordIds.length > 0) {
        refreshKnowledgeIndex(storePath, { trustedRecordIds: recoveredRecordIds });
      }
      const stageRoot = path.join(storePath, `.registration-stage-${process.pid}-${Date.now()}`);
      fs.mkdirSync(stageRoot, { recursive: true });
      try {
        const stagedRecordDir = path.join(stageRoot, path.basename(sourceDir));
        copyDirectory(sourceDir, stagedRecordDir);
        const parsed = validateStagedRecord(stagedRecordDir);
        assertWorkRecordAssociations(storePath, parsed.record);
        const destinationPath = path.join(storePath, 'knowledge', parsed.record.id);
        const indexPath = path.join(storePath, 'index.json');
        const outcome = resolveRegistrationOutcome({
          id: parsed.record.id,
          destinationPath,
          expectedRevision: options.expectedRevision,
          stagedRevision: parsed.revisionToken,
          indexedCurrentRevision: indexedRevision(storePath, parsed.record.id),
        });
        if (outcome.status === 'noop') {
          const recorded = importReceipt
            ? findImportReceipt(storePath, importReceipt.sourceDigest)
            : null;
          const receipt = importReceipt && recorded?.revisionToken !== parsed.revisionToken
            ? commitImportReceipt(
              storePath,
              importReceipt,
              parsed.record.id,
              parsed.revisionToken,
              options.now,
            ).entry
            : recorded;
          return {
            ok: true,
            status: 'noop',
            id: parsed.record.id,
            storePath,
            recordPath: path.join(destinationPath, RECORD_FILE_NAME),
            indexPath,
            revisionToken: parsed.revisionToken,
            previousRevisionToken: outcome.currentRevision,
            historyPath: null,
            importReceipt: receipt || null,
          };
        }
        const priorIndexBytes = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const archive = outcome.status === 'updated'
          ? archivePriorRevision(
            storePath,
            parsed.record.id,
            destinationPath,
            outcome.currentRevision,
            stageRoot,
          )
          : { historyPath: null, published: false };
        if (options.afterHistoryArchive) options.afterHistoryArchive();
        const replacement = beginRecordDirectoryReplacement(destinationPath, stagedRecordDir);
        let receiptCommit = null;
        try {
          if (options.afterRecordSwap) options.afterRecordSwap();
          if (importReceipt) {
            receiptCommit = commitImportReceipt(
              storePath,
              importReceipt,
              parsed.record.id,
              parsed.revisionToken,
              options.now,
            );
          }
          refreshKnowledgeIndex(storePath, { trustedRecordIds: [parsed.record.id] });
          if (options.afterIndexRefresh) options.afterIndexRefresh();
          replacement.commit();
        } catch (error) {
          const recoveryErrors = [];
          try {
            replacement.rollback();
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
          try {
            if (receiptCommit) restoreBytes(receiptCommit.receiptsPath, receiptCommit.priorBytes);
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
          try {
            restoreBytes(indexPath, priorIndexBytes);
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
          try {
            if (archive.published) fs.rmSync(archive.historyPath, { recursive: true, force: true });
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
          if (recoveryErrors.length > 0 && error && typeof error === 'object') {
            try {
              error.registrationRecoveryErrors = recoveryErrors;
            } catch {
              // Preserve the original failure even when it cannot carry diagnostics.
            }
          }
          throw error;
        }
        return {
          ok: true,
          status: outcome.status,
          id: parsed.record.id,
          storePath,
          recordPath: path.join(destinationPath, RECORD_FILE_NAME),
          indexPath,
          revisionToken: parsed.revisionToken,
          previousRevisionToken: outcome.currentRevision,
          historyPath: archive.historyPath,
          importReceipt: receiptCommit?.entry || null,
        };
      } catch (error) {
        if (error?.code) throw error;
        const failure = codedError(
          'KNOWLEDGE_REGISTRATION_FAILED',
          error instanceof Error ? error.message : String(error),
        );
        if (Array.isArray(error?.registrationRecoveryErrors)) {
          failure.registrationRecoveryErrors = error.registrationRecoveryErrors;
        }
        throw failure;
      } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
      }
    },
    options.lockOptions,
  );
}

export function serializeKnowledgeError(error) {
  const code = error?.code || 'KNOWLEDGE_REGISTRATION_FAILED';
  return {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.expectedRevision ? { expectedRevision: error.expectedRevision } : {}),
    ...(error && Object.hasOwn(error, 'currentRevision')
      ? { currentRevision: error.currentRevision }
      : {}),
  };
}
