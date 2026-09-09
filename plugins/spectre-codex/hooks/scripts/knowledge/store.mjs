import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let temporaryFileSequence = 0;

function canonicalPath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}

function defaultGitRunner(args, options) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  }).trim();
}

function resolveGitPath(value, basePath) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return canonicalPath(path.resolve(basePath, value.trim()));
}

export function resolveProjectIdentity(projectDir, options = {}) {
  const canonicalProjectRoot = canonicalPath(projectDir);
  const gitRunner = options.gitRunner || defaultGitRunner;

  try {
    const repositoryOutput = gitRunner(
      ['rev-parse', '--show-toplevel'],
      { cwd: canonicalProjectRoot },
    );
    const gitRepositoryRoot = resolveGitPath(repositoryOutput, canonicalProjectRoot);
    if (!gitRepositoryRoot) throw new Error('malformed Git repository root');

    const commonOutput = gitRunner(
      ['rev-parse', '--git-common-dir'],
      { cwd: canonicalProjectRoot },
    );
    const gitCommonDir = resolveGitPath(commonOutput, canonicalProjectRoot);
    if (!gitCommonDir) throw new Error('malformed Git common directory');

    return { canonicalProjectRoot, gitRepositoryRoot, gitCommonDir };
  } catch {
    return { canonicalProjectRoot };
  }
}

export function resolveSpectreHome(spectreHome) {
  return path.resolve(spectreHome || process.env.SPECTRE_HOME || path.join(os.homedir(), '.spectre'));
}

function readProjectMetadata(metadataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!parsed || typeof parsed.canonicalProjectRoot !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function findProjectMetadata(projectsDir) {
  if (!fs.existsSync(projectsDir)) return [];

  const found = [];
  const pending = [projectsDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const metadata = readProjectMetadata(path.join(currentDir, 'project.json'));
    if (metadata) {
      found.push({ storePath: currentDir, metadata });
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return found;
}

function findMatchingProjectMetadata(projectsDir, identity) {
  const candidates = findProjectMetadata(projectsDir);
  if (identity.gitCommonDir) {
    const commonDirectoryMatch = candidates.find(({ metadata }) =>
      typeof metadata.gitCommonDir === 'string'
      && canonicalPath(metadata.gitCommonDir) === identity.gitCommonDir,
    );
    if (commonDirectoryMatch) return commonDirectoryMatch;
  }

  return candidates.find(({ metadata }) =>
    canonicalPath(metadata.canonicalProjectRoot) === identity.canonicalProjectRoot,
  );
}

function readableSegments(canonicalProjectRoot) {
  const root = path.parse(canonicalProjectRoot).root;
  return canonicalProjectRoot
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean);
}

function readableIdentityRoot(identity) {
  if (identity.gitCommonDir && path.basename(identity.gitCommonDir) === '.git') {
    return path.dirname(identity.gitCommonDir);
  }
  return identity.canonicalProjectRoot;
}

function allocateReadableStorePath(projectsDir, identity) {
  const identityRoot = readableIdentityRoot(identity);
  const segments = readableSegments(identityRoot);
  if (segments.length < 1) {
    throw new Error(`Project path needs a readable project segment: ${identityRoot}`);
  }

  for (let count = 1; count <= segments.length; count += 1) {
    const candidate = path.join(projectsDir, ...segments.slice(-count));
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No unclaimed readable store path for ${identityRoot}`);
}

function timestamp(options) {
  const value = typeof options.now === 'function' ? options.now() : Date.now();
  return new Date(value).toISOString();
}

function nowMilliseconds(options) {
  const value = typeof options.now === 'function' ? options.now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function fsyncDirectory(dirPath) {
  let directoryFd;
  try {
    directoryFd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(directoryFd);
  } catch {
    // Some platforms and filesystems do not permit fsync on directories.
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

export function atomicWriteFile(filePath, content, options = {}) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  temporaryFileSequence += 1;
  const temporaryPath = path.join(
    parentDir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${temporaryFileSequence}`,
  );

  let fileFd;
  try {
    fileFd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fileFd, content, 'utf8');
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = undefined;
    if (options.beforeRename) options.beforeRename(temporaryPath, filePath);
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(parentDir);
  } catch (error) {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function atomicWriteJson(filePath, value, options = {}) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return { raw: null, owner: null };
  }
  try {
    return { raw, owner: JSON.parse(raw) };
  } catch {
    return { raw, owner: null };
  }
}

function staleLockOwner(lockPath, options) {
  const { raw, owner } = readLock(lockPath);
  if (raw === null) return null;
  if (!owner) {
    let modifiedAt;
    try {
      modifiedAt = fs.statSync(lockPath).mtimeMs;
    } catch {
      return null;
    }
    return Number.isFinite(modifiedAt)
      && nowMilliseconds(options) - modifiedAt > options.staleMs
      ? raw
      : null;
  }
  // Age alone cannot prove a writer is gone: long registrations may still be
  // between durable steps. A dead owner is the only safe recovery condition.
  return options.isProcessAlive(owner.pid) ? null : raw;
}

function createLock(lockPath, operation, options) {
  const owner = {
    pid: options.pid,
    timestamp: new Date(nowMilliseconds(options)).toISOString(),
    operation,
  };
  const raw = JSON.stringify(owner);
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(lockFd, raw, 'utf8');
    fs.fsyncSync(lockFd);
    fs.closeSync(lockFd);
    return raw;
  } catch (error) {
    if (lockFd !== undefined) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // The descriptor may already have been closed.
      }
    }
    if (error.code !== 'EEXIST') fs.rmSync(lockPath, { force: true });
    throw error;
  }
}

function releaseOwnedLock(lockPath, ownerRaw) {
  const current = readLock(lockPath);
  if (current.raw === ownerRaw) fs.rmSync(lockPath, { force: true });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withStoreLock(storePath, operation, fn, options = {}) {
  const lockOptions = {
    timeoutMs: options.timeoutMs ?? 5_000,
    retryDelayMs: options.retryDelayMs ?? 25,
    staleMs: options.staleMs ?? 60_000,
    isProcessAlive: options.isProcessAlive || processIsAlive,
    pid: options.pid ?? process.pid,
    now: options.now,
  };
  fs.mkdirSync(storePath, { recursive: true });
  const lockPath = path.join(storePath, '.spectre.lock');
  const waitStartedAt = Date.now();
  let staleRecoveryAttempted = false;
  let ownerRaw;

  while (ownerRaw === undefined) {
    try {
      ownerRaw = createLock(lockPath, operation, lockOptions);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const staleOwnerRaw = staleLockOwner(lockPath, lockOptions);
      if (!staleRecoveryAttempted && staleOwnerRaw !== null) {
        staleRecoveryAttempted = true;
        releaseOwnedLock(lockPath, staleOwnerRaw);
        continue;
      }
      if (Date.now() - waitStartedAt >= lockOptions.timeoutMs) {
        const timeoutError = new Error(
          `Timed out waiting for ${operation} lock at ${lockPath}`,
        );
        timeoutError.code = 'LOCK_TIMEOUT';
        throw timeoutError;
      }
      await delay(lockOptions.retryDelayMs);
    }
  }

  try {
    return await fn();
  } finally {
    releaseOwnedLock(lockPath, ownerRaw);
  }
}

export async function resolveProjectStore(projectDir, options = {}) {
  const identity = resolveProjectIdentity(projectDir, options);
  const spectreHome = resolveSpectreHome(options.spectreHome);
  const projectsDir = path.join(spectreHome, 'projects');
  const existing = findMatchingProjectMetadata(projectsDir, identity);

  if (existing) {
    return {
      storePath: existing.storePath,
      metadata: existing.metadata,
      created: false,
    };
  }
  if (options.readOnly) {
    return { storePath: null, metadata: identity, created: false };
  }

  fs.mkdirSync(projectsDir, { recursive: true });
  return withStoreLock(
    projectsDir,
    'allocate-project-store',
    async () => {
      const concurrentExisting = findMatchingProjectMetadata(projectsDir, identity);
      if (concurrentExisting) {
        return {
          storePath: concurrentExisting.storePath,
          metadata: concurrentExisting.metadata,
          created: false,
        };
      }

      const storePath = allocateReadableStorePath(projectsDir, identity);
      const metadata = {
        schemaVersion: 1,
        ...identity,
        createdAt: timestamp(options),
      };
      fs.mkdirSync(storePath, { recursive: true });
      try {
        atomicWriteJson(
          path.join(storePath, 'project.json'),
          metadata,
          options.atomicWriteOptions,
        );
      } catch (error) {
        fs.rmSync(storePath, { recursive: true, force: true });
        throw error;
      }
      return { storePath, metadata, created: true };
    },
    options.allocationLockOptions,
  );
}
