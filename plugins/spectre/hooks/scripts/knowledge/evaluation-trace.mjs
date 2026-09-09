import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const EVENT_TYPES = new Set(['search', 'load', 'resource-read', 'history-read', 'expansion', 'capture', 'bypass']);
const RECORD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_TOKEN = /^sha256:[a-f0-9]{64}$/;
const OUTCOMES = new Set(['created', 'updated', 'noop', 'merged', 'loaded', 'failed', 'unknown']);
const HISTORY_SUBTYPES = new Set(['history-preview', 'history-body']);
const TRACE_LOCK_ATTEMPTS = 200;
const TRACE_LOCK_DELAY_MS = 5;

function hash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeRecord(id, revisionToken) {
  if (typeof id !== 'string' || !RECORD_ID.test(id)) return null;
  return {
    id,
    ...(typeof revisionToken === 'string' && REVISION_TOKEN.test(revisionToken) ? { revisionToken } : {}),
  };
}

function safeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map((result) => safeRecord(result?.id, result?.revisionToken)).filter(Boolean);
}

function safeEvent(event, defaults = {}) {
  if (!EVENT_TYPES.has(event?.type)) throw new Error(`Unsupported evaluation trace event: ${event?.type}`);
  const result = { type: event.type, at: new Date(event.at || Date.now()).toISOString() };
  const actorId = event.actorId ?? defaults.actorId;
  const contextId = event.contextId ?? defaults.contextId;
  if (event.query !== undefined) result.queryHash = hash(event.query);
  if (actorId !== undefined) result.actorHash = hash(actorId);
  if (contextId !== undefined) result.contextHash = hash(contextId);

  const record = safeRecord(event.id, event.revisionToken);
  if (record) Object.assign(result, record);
  const results = safeResults(event.results);
  if (results.length > 0) result.results = results;
  for (const field of ['responseBytes', 'loadedBytes', 'responseTokens', 'loadedTokens', 'requiredTokens', 'allowanceTokens']) {
    const value = safeInteger(event[field]);
    if (value !== undefined) result[field] = value;
  }
  if (OUTCOMES.has(event.outcome)) result.outcome = event.outcome;
  if (HISTORY_SUBTYPES.has(event.subtype)) result.subtype = event.subtype;
  for (const field of ['expansionRequested', 'deliveredOverAllowance', 'expanded']) {
    if (typeof event[field] === 'boolean') result[field] = event[field];
  }
  if (event.type === 'bypass') {
    result.reason = event.reason === 'shell-read' ? 'shell-read' : 'direct-read';
    result.evidence = event.evidence === 'detected' ? 'detected' : 'suspected';
    if (typeof event.target === 'string') result.targetHash = hash(event.target);
  }
  return result;
}

/** Reads append-only trace evidence without converting malformed input into an empty trace. */
export function readEvaluationTrace(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { availability: 'unavailable', reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable', events: [] };
  }
  if (!raw.trim()) return { availability: 'unavailable', reason: 'empty', events: [] };
  const events = [];
  for (const line of raw.trimEnd().split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.schemaVersion !== SCHEMA_VERSION || !EVENT_TYPES.has(event.type)) throw new Error('invalid event');
      events.push(event);
    } catch {
      return { availability: 'unavailable', reason: 'corrupt', events: [] };
    }
  }
  return { availability: 'available', events };
}

function waitForTraceLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRACE_LOCK_DELAY_MS);
}

function withTraceLock(filePath, operation) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  let descriptor;
  for (let attempt = 0; attempt < TRACE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      descriptor = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`);
      } catch (error) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      waitForTraceLock();
    }
  }
  if (descriptor === undefined) {
    const error = new Error('Timed out waiting for evaluation trace coordination.');
    error.code = 'TRACE_LOCK_TIMEOUT';
    throw error;
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); }
  }
}

function appendTrace(filePath, event) {
  return withTraceLock(filePath, () => {
    let destination;
    try {
      destination = fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (destination && (!destination.isFile() || destination.isSymbolicLink())) {
      const error = new Error('Evaluation trace destination is not a regular file.');
      error.traceStatus = { availability: 'unavailable', reason: 'unreadable', events: [] };
      throw error;
    }
    let current;
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      current = '';
    }
    if (current.trim()) {
      const existing = readEvaluationTrace(filePath);
      if (existing.availability !== 'available') {
        const error = new Error('Evaluation trace is not valid append-only evidence.');
        error.traceStatus = existing;
        throw error;
      }
    }
    const temporaryPath = `${filePath}.append-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporaryPath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...event })}\n`, 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  });
}

/** Opt-in evaluator-only trace. It deliberately never stores task text or record bodies. */
export function createEvaluationTrace(options = {}) {
  const enabled = options.enabled === true;
  const filePath = enabled && typeof options.filePath === 'string' && options.filePath.trim()
    ? path.resolve(options.filePath)
    : null;
  const events = [];
  const initial = filePath ? readEvaluationTrace(filePath) : null;
  let status = initial?.reason === 'corrupt' || initial?.reason === 'unreadable'
    ? initial
    : { availability: enabled ? 'available' : 'disabled', events: [] };
  return {
    record(event) {
      if (!enabled || status.availability !== 'available') return null;
      const safe = safeEvent(event, options);
      if (filePath) {
        try { appendTrace(filePath, safe); } catch (error) {
          status = error?.traceStatus || { availability: 'unavailable', reason: error?.code === 'TRACE_LOCK_TIMEOUT' ? 'locked' : 'unwritable', events: [] };
          return null;
        }
      }
      events.push(safe);
      return safe;
    },
    events() { return events.map((event) => ({ ...event, results: event.results?.map((result) => ({ ...result })) })); },
    status() { return { availability: status.availability, ...(status.reason ? { reason: status.reason } : {}) }; },
    write(destination = filePath) {
      if (!enabled || !destination || status.availability !== 'available') return false;
      try {
        for (const event of this.events()) appendTrace(path.resolve(destination), event);
        return true;
      } catch (error) {
        status = error?.traceStatus || { availability: 'unavailable', reason: error?.code === 'TRACE_LOCK_TIMEOUT' ? 'locked' : 'unwritable', events: [] };
        return false;
      }
    },
  };
}

export function runtimeEvaluationTrace() {
  const filePath = process.env.SPECTRE_KNOWLEDGE_EVALUATION_TRACE;
  return createEvaluationTrace({
    enabled: typeof filePath === 'string' && filePath.trim() !== '',
    filePath,
    actorId: process.env.SPECTRE_KNOWLEDGE_EVALUATION_ACTOR_ID,
    contextId: process.env.SPECTRE_KNOWLEDGE_EVALUATION_CONTEXT_ID,
  });
}

function knownPaths(paths) {
  return (paths || []).filter((candidate) => typeof candidate === 'string' && candidate).map((candidate) => path.resolve(candidate));
}

function canonicalRoots(roots) {
  return (roots || []).filter((candidate) => typeof candidate === 'string' && candidate).map((candidate) => path.resolve(candidate));
}

function knownPath(value, paths, workingDir) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(workingDir || process.cwd(), value);
  return paths.find((candidate) => candidate === resolved || value.includes(candidate)) ?? null;
}

function relativeKnowledgePath(value, paths) {
  if (typeof value !== 'string') return null;
  return paths.find((candidate) => value.includes(path.relative(path.dirname(path.dirname(path.dirname(candidate))), candidate))) ?? null;
}

function canonicalRootPath(value, roots, workingDir) {
  if (typeof value !== 'string' || !value) return null;
  const resolved = path.resolve(workingDir || process.cwd(), value);
  const directlyMatched = roots.find((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (directlyMatched) return directlyMatched;
  return roots.find((root) => value.includes(`${root}${path.sep}`)) ?? null;
}

function directShellRead(command) {
  return /(?:^|\s)(?:cat|sed|less|head|tail|awk|grep)\b/.test(command)
    || /\b(?:readFileSync|readFile|createReadStream|open)\s*\(/.test(command);
}

function directShellWrite(command) {
  return /(?:^|\s)(?:cp|mv|rm|install|tee)\b/.test(command)
    || /(?:^|[;&|])\s*[^;&|]*\s>>?\s*[^;&|]+/.test(command)
    || /\b(?:writeFileSync|writeFile|appendFile|createWriteStream)\s*\(/.test(command)
    || /\bopen\s*\([^)]*,\s*['\"](?:w|a|x|\+|r\+)['\"]/.test(command)
    || /\b(?:sed|perl)\s+-[^\s]*i\b/.test(command);
}

function fileTarget(operation) {
  return operation?.input?.file_path ?? operation?.input?.filePath ?? operation?.input?.path ?? operation?.path ?? null;
}

function isDirectWrite(operation) {
  return ['Write', 'Edit', 'apply_patch', 'file_change'].includes(operation?.name ?? operation?.type);
}

function commandTarget(command, paths, workingDir) {
  const direct = knownPath(command, paths, workingDir) || relativeKnowledgePath(command, paths);
  if (direct) return direct;
  const changeDirectory = command.match(/(?:^|&&|;)\s*cd\s+(['"]?)([^'";&\s]+)\1/);
  if (!changeDirectory) return null;
  const directory = path.resolve(workingDir || process.cwd(), changeDirectory[2]);
  return paths.find((candidate) => command.includes(path.relative(directory, candidate))) ?? null;
}

/** Classifies only normalized host operations against evaluator-supplied fixture paths. */
export function detectTraceBypass(toolOperations = [], options = {}) {
  const paths = knownPaths(options.knownPaths);
  const roots = canonicalRoots(options.canonicalRoots);
  const workingDir = options.workingDir;
  const findings = [];
  for (const operation of toolOperations) {
    const isRead = operation?.name === 'Read' || operation?.type === 'Read';
    const command = operation?.input?.command ?? operation?.command;
    const isShell = operation?.name === 'Bash' || operation?.name === 'exec' || typeof command === 'string';
    if (isRead) {
      const suppliedPath = fileTarget(operation);
      const target = knownPath(suppliedPath, paths, workingDir) || relativeKnowledgePath(suppliedPath, paths) || canonicalRootPath(suppliedPath, roots, workingDir);
      if (target || suppliedPath == null || /(?:^|\/)knowledge\//.test(suppliedPath || '')) {
        findings.push({
          type: 'bypass', reason: 'direct-read', evidence: target ? 'detected' : 'suspected',
          ...(target ? { targetHash: hash(target) } : {}),
        });
      }
      continue;
    }
    if (isDirectWrite(operation)) {
      const suppliedPath = fileTarget(operation);
      const target = knownPath(suppliedPath, paths, workingDir) || relativeKnowledgePath(suppliedPath, paths) || canonicalRootPath(suppliedPath, roots, workingDir);
      if (target) findings.push({ type: 'bypass', reason: 'direct-write', evidence: 'detected', targetHash: hash(target) });
      continue;
    }
    if (!isShell) continue;
    if (typeof command !== 'string') {
      findings.push({ type: 'bypass', reason: 'shell-read', evidence: 'suspected' });
      continue;
    }
    const target = commandTarget(command, paths, workingDir) || canonicalRootPath(command, roots, workingDir);
    if (!target) continue;
    if (directShellWrite(command)) {
      findings.push({ type: 'bypass', reason: 'shell-write', evidence: 'detected', targetHash: hash(target) });
      continue;
    }
    findings.push({
      type: 'bypass', reason: 'shell-read', evidence: directShellRead(command) ? 'detected' : 'suspected', targetHash: hash(target),
    });
  }
  return findings;
}
