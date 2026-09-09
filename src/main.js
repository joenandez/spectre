import path from 'path';
import readline from 'readline/promises';
import fs from 'fs';
import { runDoctor } from './lib/doctor.js';
import { main as runWorkflowCli } from '../plugins/spectre/hooks/scripts/workflow-cli.mjs';
import { resolveKnowledgeProjectDir } from '../plugins/spectre/hooks/scripts/knowledge/cli-arguments.mjs';
import {
  formatCanonicalKnowledgeLoad,
  formatCanonicalKnowledgeSearch,
  formatCanonicalKnowledgeSearchWarnings,
  loadCanonicalKnowledge,
  listCanonicalKnowledgeHistory,
  inspectCanonicalKnowledgeRevision,
  migrateCanonicalKnowledge,
  previewCanonicalKnowledgeRegistry,
  registerCanonicalKnowledge,
  searchCanonicalKnowledgeTags,
  applyCanonicalKnowledgeTagOperation,
  ensureCanonicalKnowledgeTags,
  mergeCanonicalKnowledgeTags,
  resolveCanonicalKnowledgeWork,
  searchCanonicalKnowledge,
  serializeCanonicalKnowledgeError,
  serializeCanonicalKnowledgeLoadError
} from './lib/knowledge.js';
import { projectCodexHome } from './lib/paths.js';

class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        flags.set(value, true);
        continue;
      }
      flags.set(value, [...(flags.get(value) || []), next]);
      index += 1;
      continue;
    }

    positional.push(value);
  }

  return {
    positional,
    flags: {
      get(name) {
        const value = flags.get(name);
        return Array.isArray(value) ? value.at(-1) : value;
      },
      getAll(name) {
        const value = flags.get(name);
        return Array.isArray(value) ? [...value] : value === undefined ? [] : [value];
      },
      has(name) { return flags.has(name); }
    }
  };
}

function usage() {
  return `Usage:
  spectre install codex
  spectre uninstall codex
  spectre update codex
  spectre doctor codex [--scope user|project] [--project-dir <path>] [--json]
  spectre knowledge search [query] [--project-dir <path>] [--json]
  spectre knowledge tags search [query] [--cursor <token>] [--project-dir <path>] [--json]
  spectre knowledge tags ensure --input <json> [--project-dir <path>] [--json]
  spectre knowledge tags merge --input <json> [--project-dir <path>] [--json]
  spectre knowledge tags apply --input <json> [--project-dir <path>] [--json]
  spectre knowledge load <id> [--project-dir <path>] [--json]
  spectre knowledge history <id> [--cursor <token>] [--project-dir <path>] [--json]
  spectre knowledge inspect <id> --revision <token> [--project-dir <path>] [--json]
  spectre knowledge work resolve [--work-id <id>] [--source-run-id <id>] [--project-dir <path>] [--json]
  spectre knowledge registry [--host claude|codex] [--project-dir <path>] [--json]
  spectre knowledge register --record <path> [--project-dir <path>] [--json]
  spectre knowledge migrate [--project-dir <path>] [--json]
  spectre workflow <run|stage|phase|wave|agent|task|gate|human-input|plan|cleanup|purge> ... [--json]
`;
}

function codexPluginRequiredMessage(command) {
  const update = [
    'Codex native plugin installation is required for Spectre 6.0.0.',
    '',
    'Fresh install:',
    '  codex plugin marketplace add joenandez/spectre',
    '  codex plugin add spectre@spectre',
    '',
    'Update:',
    '  codex plugin marketplace upgrade spectre',
    '  codex plugin remove spectre@spectre',
    '  codex plugin add spectre@spectre',
    '',
    'Uninstall:',
    '  Run the bundled spectre-uninstall-codex skill first to remove managed agents.',
    '  codex plugin remove spectre@spectre',
  ].join('\n');
  return `${command} codex no longer mutates Codex files.\n${update}`;
}

function resolveProjectDir(flags) {
  const projectDir = flags.get('--project-dir');
  return path.resolve(projectDir || process.cwd());
}

function sourceRunId(flags) {
  const sourceRunId = flags.get('--source-run-id');
  const runId = flags.get('--run-id');
  if (sourceRunId !== undefined && runId !== undefined && sourceRunId !== runId) {
    throw new CliError('WORK_SOURCE_RUN_CONFLICT', '--source-run-id and --run-id must match when both are supplied.');
  }
  return sourceRunId ?? runId;
}

function detectInstalledScope(projectDir) {
  const manifestPath = path.join(projectDir, '.spectre', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.scope === 'project') {
        return 'project';
      }
    } catch {
      // Ignore malformed manifests and fall back to global scope.
    }
  }

  return 'user';
}

async function promptForScope(command, projectDir) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return command === 'install' ? 'project' : detectInstalledScope(projectDir);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = command === 'install'
    ? 'Install scope? [p]roject or [u]ser: '
    : 'Target scope? [p]roject or [u]ser: ';

  try {
    while (true) {
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      if (answer === 'p' || answer === 'project') {
        return 'project';
      }
      if (answer === 'u' || answer === 'user') {
        return 'user';
      }
    }
  } finally {
    rl.close();
  }
}

async function withScopedCodexHome(scope, projectDir, fn) {
  const previous = process.env.CODEX_HOME;
  if (scope === 'project') {
    process.env.CODEX_HOME = projectCodexHome(projectDir);
  } else if (previous == null) {
    delete process.env.CODEX_HOME;
  }

  try {
    return await fn();
  } finally {
    if (previous == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  }
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, target] = positional;

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'knowledge') {
    const knowledgeProjectDir = () => resolveKnowledgeProjectDir(flags.get('--project-dir') || flags.get('--project-root'));
    const lockOptions = () => flags.get('--lock-timeout-ms')
      ? { timeoutMs: Number(flags.get('--lock-timeout-ms')), retryDelayMs: 5 }
      : undefined;
    const numberFlag = name => flags.get(name) === undefined ? undefined : Number(flags.get(name));
    const writeJson = result => process.stdout.write(`${JSON.stringify(result)}\n`);

    if (target === 'search') {
      const query = positional.slice(2).join(' ');
      try {
        const result = await searchCanonicalKnowledge({
          projectDir: knowledgeProjectDir(), query, tags: flags.getAll('--tag'), paths: flags.getAll('--path'),
          workId: flags.get('--work-id'), runId: flags.get('--run-id'), kind: flags.get('--kind'),
          limit: numberFlag('--limit'), cursor: flags.get('--cursor')
        });
        const output = { ok: true, query, ...result };
        if (flags.has('--json')) writeJson(output);
        else { process.stdout.write(formatCanonicalKnowledgeSearch(result, query)); process.stderr.write(formatCanonicalKnowledgeSearchWarnings(result.warnings)); }
      } catch (error) { throw new CliError('KNOWLEDGE_SEARCH_FAILED', error instanceof Error ? error.message : String(error)); }
      return;
    }

    if (target === 'tags') {
      try {
        const operation = positional[2];
        const result = operation === 'search'
          ? await searchCanonicalKnowledgeTags({ projectDir: knowledgeProjectDir(), query: positional.slice(3).join(' '), limit: numberFlag('--limit'), cursor: flags.get('--cursor') })
          : operation === 'ensure'
            ? await ensureCanonicalKnowledgeTags({ projectDir: knowledgeProjectDir(), inputPath: flags.get('--input'), lockOptions: lockOptions() })
            : operation === 'merge'
              ? await mergeCanonicalKnowledgeTags({ projectDir: knowledgeProjectDir(), inputPath: flags.get('--input'), lockOptions: lockOptions() })
              : operation === 'apply'
                ? await applyCanonicalKnowledgeTagOperation({ projectDir: knowledgeProjectDir(), inputPath: flags.get('--input'), lockOptions: lockOptions() })
            : null;
        if (!result) throw new CliError('UNKNOWN_TAG_COMMAND', `Unknown tags command "${operation || ''}".`);
        writeJson(result);
      } catch (error) { throw new CliError(error?.code || 'TAG_OPERATION_FAILED', error instanceof Error ? error.message : String(error)); }
      return;
    }

    if (target === 'load') {
      try {
        const result = await loadCanonicalKnowledge({
          projectDir: knowledgeProjectDir(), id: positional[2], lockOptions: lockOptions(),
          workId: flags.get('--work-id'), runId: flags.get('--run-id'), allowanceTokens: numberFlag('--allowance-tokens'),
          inspectHistorical: flags.has('--inspect-historical')
        });
        if (flags.has('--json')) writeJson(result);
        else process.stdout.write(formatCanonicalKnowledgeLoad(result));
      } catch (error) { const payload = serializeCanonicalKnowledgeLoadError(error); throw new CliError(payload.code, payload.message, payload); }
      return;
    }

    if (target === 'history' || target === 'inspect') {
      try {
        const result = target === 'history'
          ? await listCanonicalKnowledgeHistory({ projectDir: knowledgeProjectDir(), id: positional[2], cursor: flags.get('--cursor'), lockOptions: lockOptions() })
          : await inspectCanonicalKnowledgeRevision({ projectDir: knowledgeProjectDir(), id: positional[2], revisionToken: flags.get('--revision'), lockOptions: lockOptions() });
        writeJson(result);
      } catch (error) { throw new CliError(error?.code || 'KNOWLEDGE_HISTORY_FAILED', error instanceof Error ? error.message : String(error)); }
      return;
    }

    if (target === 'work' && positional[2] === 'resolve') {
      try {
        const candidate = flags.get('--candidate') ? JSON.parse(flags.get('--candidate')) : undefined;
        writeJson(await resolveCanonicalKnowledgeWork({
          projectDir: knowledgeProjectDir(), workId: flags.get('--work-id'), sourceRunId: sourceRunId(flags),
          pullRequestId: flags.get('--pull-request-id'), candidate, lockOptions: lockOptions()
        }));
      } catch (error) { throw new CliError(error?.code || 'WORK_RESOLUTION_FAILED', error instanceof Error ? error.message : String(error)); }
      return;
    }

    if (target === 'registry') {
      let result;
      try { result = await previewCanonicalKnowledgeRegistry({ host: flags.get('--host') || 'claude', projectDir: knowledgeProjectDir() }); }
      catch (error) { throw new CliError('KNOWLEDGE_REGISTRY_FAILED', error instanceof Error ? error.message : String(error)); }
      if (flags.has('--json')) writeJson({ ok: true, ...result });
      else process.stdout.write(result.injected ? `${result.payload.hookSpecificOutput.additionalContext}\n` : 'No SessionStart knowledge payload would be injected.\n');
      return;
    }

    if (target === 'register') {
      try {
        const result = await registerCanonicalKnowledge({ projectDir: knowledgeProjectDir(), recordPath: flags.get('--record'), expectedRevision: flags.get('--expected-revision'), lockOptions: lockOptions() });
        if (flags.has('--json')) writeJson(result); else process.stdout.write(`Registered knowledge record ${result.id}\n`);
      } catch (error) { const payload = serializeCanonicalKnowledgeError(error); throw new CliError(payload.code, payload.message, payload); }
      return;
    }

    if (target === 'migrate') {
      try {
        const report = await migrateCanonicalKnowledge({ projectDir: knowledgeProjectDir(), lockOptions: lockOptions() });
        if (flags.has('--json')) writeJson({ ok: true, ...report }); else process.stdout.write(`Migrated ${report.entries.length} knowledge entries\n`);
      } catch (error) { throw new CliError(error?.code || 'KNOWLEDGE_MIGRATION_FAILED', error instanceof Error ? error.message : String(error)); }
      return;
    }
    throw new CliError('UNKNOWN_KNOWLEDGE_COMMAND', `Unknown knowledge command "${target || ''}".`);
  }

  if (command === 'workflow') {
    try {
      await runWorkflowCli(argv.slice(1));
    } catch (error) {
      if (argv[1] === 'plan' && error?.code) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message })}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (target !== 'codex') {
    throw new Error('Only the Codex target is currently implemented.');
  }

  if (command === 'install' || command === 'uninstall' || command === 'update') {
    throw new CliError('CODEX_PLUGIN_REQUIRED', codexPluginRequiredMessage(command));
  }

  const projectDir = resolveProjectDir(flags);
  const scope = flags.get('--scope') || await promptForScope(command, projectDir);

  if (command === 'doctor') {
    await withScopedCodexHome(scope, projectDir, () => runDoctor({
      verifyHooks: Boolean(flags.get('--verify-hooks')),
      json: Boolean(flags.get('--json')),
      projectDir
    }));
    return;
  }

  throw new Error(`Unknown command "${command}".\n${usage()}`);
}
