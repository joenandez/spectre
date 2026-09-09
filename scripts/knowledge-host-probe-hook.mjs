#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimatePayloadTokens, measurePayload } from '../plugins/spectre/hooks/scripts/knowledge/payload.mjs';

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function parseArgs(argv) {
  const runtimePath = valueAfter(argv, '--runtime');
  const host = valueAfter(argv, '--host');
  const evidencePath = valueAfter(argv, '--evidence');
  const expectedId = valueAfter(argv, '--expected-id');
  const coreSentinel = valueAfter(argv, '--core-sentinel');
  const resourceSentinel = valueAfter(argv, '--resource-sentinel');
  if (
    !runtimePath
    || !['claude', 'codex'].includes(host)
    || !evidencePath
    || !expectedId
    || !coreSentinel
    || !resourceSentinel
  ) {
    throw new Error(
      'Usage: knowledge-host-probe-hook.mjs --runtime <load-knowledge.mjs> ' +
      '--host <claude|codex> --evidence <path> --expected-id <id> ' +
      '--core-sentinel <value> --resource-sentinel <value>',
    );
  }
  return {
    runtimePath: path.resolve(runtimePath),
    host,
    evidencePath: path.resolve(evidencePath),
    expectedId,
    coreSentinel,
    resourceSentinel,
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function observeFrame(args, input, stdout, stderr, exitCode) {
  let parsed = null;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    // The observation records invalid JSON explicitly; stdout is still forwarded.
  }
  const additionalContext = parsed?.hookSpecificOutput?.additionalContext;
  const serializedFrame = parsed ? JSON.stringify(parsed) : stdout;
  const measurement = measurePayload(args.host, serializedFrame);
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    host: args.host,
    runtimePath: args.runtimePath,
    hookEventName: input?.hook_event_name ?? null,
    source: input?.source ?? null,
    exitCode,
    stderr: stderr.trim(),
    validJson: parsed !== null,
    frameCharacters: serializedFrame.length,
    additionalContextCharacters:
      typeof additionalContext === 'string' ? additionalContext.length : null,
    additionalContextBytes:
      typeof additionalContext === 'string' ? Buffer.byteLength(additionalContext, 'utf8') : null,
    additionalContextTokens:
      typeof additionalContext === 'string' ? estimatePayloadTokens(additionalContext) : null,
    measurement,
    hookEventMatches:
      parsed?.hookSpecificOutput?.hookEventName === 'SessionStart',
    hasTopLevelSystemMessage: parsed?.systemMessage !== undefined,
    hasHookSystemMessage: parsed?.hookSpecificOutput?.systemMessage !== undefined,
    hasPreview:
      parsed?.preview !== undefined || parsed?.hookSpecificOutput?.preview !== undefined,
    hasFallbackFile:
      parsed?.filePath !== undefined ||
      parsed?.savedFilePath !== undefined ||
      parsed?.hookSpecificOutput?.filePath !== undefined ||
      parsed?.hookSpecificOutput?.savedFilePath !== undefined,
    expectedIdVisible:
      typeof additionalContext === 'string' && additionalContext.includes(args.expectedId),
    coreSentinelVisible:
      typeof additionalContext === 'string' && additionalContext.includes(args.coreSentinel),
    resourceSentinelVisible:
      typeof additionalContext === 'string' && additionalContext.includes(args.resourceSentinel),
    omittedCount: Number(
      typeof additionalContext === 'string'
        ? additionalContext.match(/Omitted active records:\s*(\d+)/)?.[1] ?? Number.NaN
        : Number.NaN,
    ),
  };
}

function main(argv = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8')) {
  const args = parseArgs(argv);
  let input = null;
  try {
    input = JSON.parse(stdin);
  } catch {
    // The real runtime remains authoritative for malformed-input behavior.
  }
  const result = spawnSync(process.execPath, [args.runtimePath, '--host', args.host], {
    cwd: process.cwd(),
    env: process.env,
    input: stdin,
    encoding: 'utf8',
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  atomicWriteJson(
    args.evidencePath,
    observeFrame(args, input, stdout, stderr, exitCode),
  );
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  return exitCode;
}

const isDirect = process.argv[1]
  && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isDirect) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`knowledge host probe failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { main, observeFrame, parseArgs };
