import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseKnowledgeRecord,
  refreshKnowledgeIndex,
} from './records.mjs';
import {
  findImportReceipt,
  readImportReceipts,
  withImportReceipt,
} from './receipts.mjs';
import {
  atomicWriteJson,
  resolveProjectStore,
  withStoreLock,
} from './store.mjs';

const LEGACY_ROOTS = [
  { nativeRoot: '.claude', recallName: 'spectre-recall' },
  { nativeRoot: '.agents', recallName: 'spectre-recall' },
  { nativeRoot: '.claude', recallName: 'spectre-find' },
  { nativeRoot: '.agents', recallName: 'spectre-find' },
];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MANAGED_LEGACY_ORIGIN = 'legacy-spectre-learning';

function recoverable(message) {
  const error = new Error(message);
  error.code = 'RECOVERABLE_FAILURE';
  return error;
}

function packageEntries(root) {
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw recoverable(`${entryPath}: symlinks cannot be imported`);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) entries.push({
        relativePath: path.relative(root, entryPath).split(path.sep).join('/'),
        sourcePath: entryPath,
      });
      else throw recoverable(`${entryPath}: unsupported source entry`);
    }
  }
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function sourcePackageDigest(sourceDir) {
  const hash = createHash('sha256');
  for (const entry of packageEntries(sourceDir)) {
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(entry.sourcePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function copyPackage(sourceDir, destinationDir) {
  for (const entry of packageEntries(sourceDir)) {
    const destination = path.join(destinationDir, entry.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.sourcePath, destination);
  }
}

function legacyRows(projectDir) {
  const rows = [];
  for (const root of LEGACY_ROOTS) {
    const registryPath = path.join(
      projectDir, root.nativeRoot, 'skills', root.recallName, 'references', 'registry.toon',
    );
    if (!fs.existsSync(registryPath)) continue;
    for (const line of fs.readFileSync(registryPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [id, category, rawCues, ...descriptionParts] = line.split('|');
      rows.push({
        id: id?.trim() || '',
        category: category?.trim() || '',
        cues: rawCues?.trim() || '',
        description: descriptionParts.join('|').trim(),
        registryPath,
        sourceDir: path.join(projectDir, root.nativeRoot, 'skills', id?.trim() || ''),
      });
    }
  }
  return rows;
}

function storeResidentLegacyRows(storePath) {
  const knowledgeDir = path.join(storePath, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sourceDir = path.join(knowledgeDir, entry.name);
    // A typed package is already authoritative even if it retains an old SKILL.md
    // as an imported resource. Only packages without record.json are legacy sources.
    if (
      !fs.existsSync(path.join(sourceDir, 'SKILL.md'))
      || fs.existsSync(path.join(sourceDir, 'record.json'))
    ) continue;
    rows.push({
      id: entry.name,
      category: '',
      cues: '',
      description: '',
      sourceDir,
      storeResident: true,
    });
  }
  return rows;
}

function parseLegacySource(sourceDir, expectedId, row) {
  const sourcePath = path.join(sourceDir, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    throw recoverable(`${sourcePath}: missing legacy SKILL.md source`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw recoverable(`${sourcePath}: legacy source is missing frontmatter`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0 || /^\s/.test(line)) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ''));
  }
  const id = fields.get('name');
  const description = fields.get('description');
  if (id !== expectedId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id || '')) {
    throw recoverable(`${sourcePath}: legacy name must match its canonical directory ID`);
  }
  if (!description) throw recoverable(`${sourcePath}: legacy description is required`);
  return {
    title: id,
    summary: description.replace(/\s+TRIGGER when:.*$/i, '').trim(),
    body: text.slice(match[0].length),
    useWhen: description.replace(/\s+TRIGGER when:.*$/i, '').trim(),
    cues: row.cues.split(',').map((cue) => cue.trim()).filter(Boolean),
    category: fields.get('spectre-category') || row.category || 'unknown — imported record',
    status: fields.get('spectre-status') || 'unknown — imported record',
    version: fields.get('spectre-version') || 'unknown — imported record',
  };
}

function sourceArchivePath(storePath, sourceDigest) {
  return path.join(storePath, 'knowledge-history', 'imported-sources', sourceDigest.replace(':', '-'));
}

function verifiedImportedSource(storePath, sourceDigest) {
  const receipt = findImportReceipt(storePath, sourceDigest);
  if (!receipt) return { ok: false, message: 'No migration receipt exists for this source package.' };
  const archivePath = sourceArchivePath(storePath, sourceDigest);
  try {
    if (!fs.existsSync(archivePath) || sourcePackageDigest(archivePath) !== sourceDigest) {
      return { ok: false, message: 'The byte-exact source archive is missing or no longer matches its digest.' };
    }
    const parsed = parseKnowledgeRecord(path.join(storePath, 'knowledge', receipt.recordId, 'record.json'));
    if (
      parsed.revisionToken !== receipt.revisionToken
      || parsed.record.provenance.origin !== 'legacy-import'
      || parsed.record.provenance.sourceFingerprint !== sourceDigest
    ) {
      return { ok: false, message: 'The receipted imported destination no longer matches this source package.' };
    }
    return { ok: true, receipt, parsed };
  } catch {
    return { ok: false, message: 'The receipted imported destination is missing or unreadable.' };
  }
}

function managedLegacyCopies(projectDir) {
  const copies = [];
  const visitedRoots = new Set();
  for (const root of LEGACY_ROOTS) {
    if (visitedRoots.has(root.nativeRoot)) continue;
    visitedRoots.add(root.nativeRoot);
    const skillsDir = path.join(projectDir, root.nativeRoot, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === root.recallName) continue;
      const sourceDir = path.join(skillsDir, entry.name);
      const skillPath = path.join(sourceDir, 'SKILL.md');
      let source;
      try {
        source = fs.readFileSync(skillPath, 'utf8');
      } catch {
        continue;
      }
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
      if (!frontmatter) continue;
      const marker = /^\s{2}spectre-migration-origin:\s*["']?([^"'\s]+)["']?\s*$/m.exec(frontmatter);
      if (marker?.[1] === MANAGED_LEGACY_ORIGIN) {
        copies.push({ id: entry.name, sourceDir });
      }
    }
  }
  return copies;
}

/** Remove only copies carrying the explicit managed migration marker after every durable proof exists. */
export function retireManagedLegacyCopies({ projectDir, storePath }) {
  const results = [];
  for (const copy of managedLegacyCopies(path.resolve(projectDir))) {
    let sourceDigest;
    try {
      sourceDigest = sourcePackageDigest(copy.sourceDir);
    } catch (error) {
      results.push({ id: copy.id, code: 'PRESERVED', message: `Could not verify source package: ${error.message}` });
      continue;
    }
    const verification = verifiedImportedSource(storePath, sourceDigest);
    if (!verification.ok) {
      results.push({
        id: copy.id,
        code: 'PRESERVED',
        message: 'Managed copy preserved: verified import, byte-exact archive, and receipt are required before retirement.',
      });
      continue;
    }
    fs.rmSync(copy.sourceDir, { recursive: true, force: true });
    results.push({ id: copy.id, code: 'RETIRED', recordId: verification.receipt.recordId, sourceDigest });
  }
  return results;
}

function workRecord(id, source, sourceDigest, now) {
  return {
    schemaVersion: 1,
    id,
    kind: 'work',
    title: source.title,
    summary: source.summary,
    tags: [],
    applicability: { scope: 'project' },
    provenance: {
      origin: 'legacy-import',
      capturedAt: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
      sourceFingerprint: sourceDigest,
    },
    relatedRecordIds: [],
    work: {
      requestedOutcome: 'unknown — imported record',
      scope: 'unknown — imported record',
      actualChanges: 'unknown — imported record',
      reasons: 'unknown — imported record',
      discoveries: 'unknown — imported record',
      verification: 'unknown — imported record',
      remainingWork: 'unknown — imported record',
      relatedContext: 'unknown — imported record',
      execution: { state: 'unknown' },
      verificationState: { state: 'unknown' },
      pullRequest: { state: 'unknown' },
      associations: { sourceRunIds: [], pullRequestIds: [], candidates: [] },
    },
    importedSource: {
      body: source.body,
      useWhen: source.useWhen,
      cues: source.cues,
      category: source.category,
      status: source.status,
      version: source.version,
    },
  };
}

function destinationId(storePath, sourceId, sourceDigest, sourceDir) {
  const primary = path.join(storePath, 'knowledge', sourceId);
  if (!fs.existsSync(primary)) return sourceId;
  if (
    path.resolve(sourceDir) === path.resolve(primary)
    && !fs.existsSync(path.join(primary, 'record.json'))
  ) return sourceId;
  try {
    const parsed = parseKnowledgeRecord(path.join(primary, 'record.json'));
    if (
      parsed.record.provenance.origin === 'legacy-import'
      && parsed.record.provenance.sourceFingerprint === sourceDigest
    ) return sourceId;
  } catch {
    // An unreadable package is never an unsafe replacement target.
  }
  const suffix = `-imported-${sourceDigest.slice(7, 15)}`;
  return `${sourceId.slice(0, 64 - suffix.length)}${suffix}`;
}

function receiptEntry(sourceDigest, recordId, revisionToken, now) {
  return {
    sourceDigest,
    recordId,
    revisionToken,
    importedAt: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
  };
}

function removeRegistryRows(rows) {
  const byPath = new Map();
  for (const row of rows) {
    if (!byPath.has(row.registryPath)) byPath.set(row.registryPath, new Set());
    byPath.get(row.registryPath).add(row.id);
  }
  for (const [registryPath, ids] of byPath) {
    const retained = fs.readFileSync(registryPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !ids.has(line.split('|')[0]?.trim()))
      .join('\n');
    fs.writeFileSync(registryPath, retained);
  }
}

function importOne(storePath, row, options) {
  const sourceDigest = sourcePackageDigest(row.sourceDir);
  const receipt = findImportReceipt(storePath, sourceDigest);
  if (receipt) {
    const verification = verifiedImportedSource(storePath, sourceDigest);
    if (!verification.ok) {
      return {
        id: row.id,
        code: 'RECOVERABLE_FAILURE',
        sourceDigest,
        message: `Stale receipt preserved for recovery: ${verification.message}`,
      };
    }
    return { id: row.id, code: 'NOOP', sourceDigest, recordId: receipt.recordId };
  }

  const archivePath = sourceArchivePath(storePath, sourceDigest);
  if (!fs.existsSync(archivePath)) {
    const stage = `${archivePath}.stage-${process.pid}-${Date.now()}`;
    copyPackage(row.sourceDir, stage);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.renameSync(stage, archivePath);
  }

  let source;
  try {
    source = parseLegacySource(row.sourceDir, row.id, row);
  } catch (error) {
    return { id: row.id, code: 'RECOVERABLE_FAILURE', sourceDigest, message: error.message };
  }
  const id = destinationId(storePath, row.id, sourceDigest, row.sourceDir);
  const destination = path.join(storePath, 'knowledge', id);
  if (fs.existsSync(destination)) {
    const canReplaceStoreResidentSource = (
      row.storeResident
      && path.resolve(row.sourceDir) === path.resolve(destination)
      && !fs.existsSync(path.join(destination, 'record.json'))
    );
    if (!canReplaceStoreResidentSource) {
      const parsed = parseKnowledgeRecord(path.join(destination, 'record.json'));
      if (parsed.record.provenance.sourceFingerprint === sourceDigest) {
        atomicWriteJson(path.join(storePath, 'import-receipts.json'), withImportReceipt(
          readImportReceipts(storePath), receiptEntry(sourceDigest, id, parsed.revisionToken, options.now),
        ));
        return { id: row.id, code: 'NOOP', sourceDigest, recordId: id };
      }
      throw recoverable(`${destination}: import redirect collision is not recoverable automatically`);
    }
  }
  const stageRoot = path.join(storePath, `.migration-stage-${process.pid}-${Date.now()}`);
  const stage = path.join(stageRoot, id);
  copyPackage(row.sourceDir, path.join(stage, 'imported-source'));
  atomicWriteJson(path.join(stage, 'record.json'), workRecord(id, source, sourceDigest, options.now));
  const parsed = parseKnowledgeRecord(path.join(stage, 'record.json'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const sourceBackup = `${destination}.migration-source-${process.pid}-${Date.now()}`;
    fs.renameSync(destination, sourceBackup);
    try {
      fs.renameSync(stage, destination);
    } catch (error) {
      fs.renameSync(sourceBackup, destination);
      throw error;
    }
    fs.rmSync(sourceBackup, { recursive: true, force: true });
  } else {
    fs.renameSync(stage, destination);
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });
  atomicWriteJson(path.join(storePath, 'import-receipts.json'), withImportReceipt(
    readImportReceipts(storePath), receiptEntry(sourceDigest, id, parsed.revisionToken, options.now),
  ));
  return { id: row.id, code: 'IMPORTED', sourceDigest, recordId: id };
}

export async function migrateLegacyKnowledge(options) {
  const projectDir = path.resolve(options.projectDir);
  const projectRows = legacyRows(projectDir);
  let storePath = options.storePath ? path.resolve(options.storePath) : null;
  if (!storePath) {
    const resolved = await resolveProjectStore(projectDir, {
      spectreHome: options.spectreHome,
      gitRunner: options.gitRunner,
      readOnly: projectRows.length === 0,
      allocationLockOptions: options.allocationLockOptions,
    });
    storePath = resolved.storePath;
  }
  if (!storePath) return { schemaVersion: 1, entries: [] };
  const rows = [...projectRows, ...storeResidentLegacyRows(storePath)];

  return withStoreLock(storePath, 'migrate-legacy-knowledge', async () => {
    if (rows.length === 0) {
      return {
        schemaVersion: 1,
        entries: readImportReceipts(storePath).receipts.map((receipt) => ({
          id: receipt.recordId,
          code: 'NOOP',
          sourceDigest: receipt.sourceDigest,
          recordId: receipt.recordId,
        })),
        retirement: retireManagedLegacyCopies({ projectDir, storePath }),
      };
    }
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push(row);
    }
    const entries = [];
    for (const [id, sources] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      try {
        const digests = sources.map((row) => sourcePackageDigest(row.sourceDir));
        if (new Set(digests).size !== 1) {
          entries.push({
            id,
            code: 'RECOVERABLE_FAILURE',
            message: `Legacy sources for ${id} differ and require a deliberate recovery choice.`,
          });
          continue;
        }
        entries.push(importOne(
          storePath,
          sources.find((source) => source.storeResident) || sources[0],
          options,
        ));
      } catch (error) {
        entries.push({ id, code: 'RECOVERABLE_FAILURE', message: error.message });
      }
    }
    refreshKnowledgeIndex(storePath);
    const verifiedRows = rows.filter((row) => {
      try {
        const sourceDigest = sourcePackageDigest(row.sourceDir);
        const entry = entries.find((candidate) => candidate.id === row.id);
        return (
          (entry?.code === 'IMPORTED' || entry?.code === 'NOOP')
          && entry.sourceDigest === sourceDigest
          && verifiedImportedSource(storePath, sourceDigest).ok
        );
      } catch {
        return false;
      }
    });
    removeRegistryRows(verifiedRows.filter((row) => row.registryPath));
    return {
      schemaVersion: 1,
      entries,
      retirement: retireManagedLegacyCopies({ projectDir, storePath }),
    };
  }, options.lockOptions);
}
