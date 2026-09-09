#!/usr/bin/env node
/**
 * Gate 4 — Real-CLI behavioral validation.
 *
 * This is the gate that actually matters. Unit tests exercise functions; users
 * exercise the installed CLI and the hooks Claude/Codex fire at session start.
 * Those are different things, and the gap between them is where this project's
 * real bugs have lived (a registry handler missing from the generated runtime,
 * or exact retrieval being unreachable from an installed bundle).
 *
 * Everything runs in throwaway temp dirs with a fresh CODEX_HOME. Nothing here
 * touches the user's real state.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gate, REPO, run } from './lib.mjs';
import { refreshKnowledgeIndex } from '../../../../plugins/spectre/hooks/scripts/knowledge/records.mjs';
import { resolveProjectStore } from '../../../../plugins/spectre/hooks/scripts/knowledge/store.mjs';

const g = new Gate('4 real-cli');
const PLUGIN = path.join(REPO, 'plugins', 'spectre');
const CODEX_PLUGIN = path.join(REPO, 'plugins', 'spectre-codex');
const HOOKS = path.join(PLUGIN, 'hooks', 'scripts');
const CODEX_HOOKS = path.join(CODEX_PLUGIN, 'hooks', 'scripts');
const CLI = path.join(REPO, 'bin', 'spectre.js');
const ENSURE_CODEX_AGENTS = path.join(
  CODEX_PLUGIN,
  'skills',
  'spectre-scope',
  'scripts',
  'ensure-codex-agents.mjs',
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-verify-'));
const CODEX_HOME = path.join(ROOT, 'codex-home');
const SPECTRE_HOME = path.join(ROOT, 'spectre-home');
const FEATURE_HOST_EVIDENCE = process.env.SPECTRE_GATE4_EVIDENCE_DIR ||
  path.join(ROOT, 'feature-host-evidence');
const FEATURE_HOST_SOURCE_MISMATCHES = [];
fs.mkdirSync(CODEX_HOME, { recursive: true });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A disposable project. `seeded` gives it the knowledge surface the hook gates on. */
function makeProject(name, { seeded = false, legacyMarkers = false } = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-b', 'main'], { cwd: dir });

  if (seeded) {
    fs.mkdirSync(path.join(dir, '.spectre'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.spectre', 'manifest.json'), JSON.stringify({ scope: 'project' }));
  }
  if (legacyMarkers) {
    fs.writeFileSync(path.join(dir, 'AGENTS.override.md'),
      '<!-- caspar-knowledge:start -->\nstale fork block\n<!-- caspar-knowledge:end -->\n');
  }
  return dir;
}

// isolated: true strips the ambient harness env, so this suite is the only
// thing writing to these projects' AGENTS.override.md. See cleanEnv() in lib.
const hook = (script, projectDir) => run('node', [path.join(HOOKS, script)], {
  env: {
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    SPECTRE_HOME,
  },
  cwd: projectDir,
  isolated: true,
});

const hookEvent = (script, projectDir, input, host = 'claude') =>
  run('node', [path.join(HOOKS, script), '--host', host], {
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: PLUGIN,
      SPECTRE_HOME,
    },
    cwd: projectDir,
    isolated: true,
    input: JSON.stringify(input),
  });

const knowledgeCli = (args, projectDir) => run(
  'node',
  [path.join(HOOKS, 'knowledge-cli.mjs'), ...args, '--project-dir', projectDir, '--json'],
  {
    env: { SPECTRE_HOME, HOME: ROOT },
    cwd: projectDir,
    isolated: true,
  },
);

const codexKnowledgeCli = (args, projectDir) => run(
  path.join(CODEX_HOOKS, 'knowledge-cli.mjs'),
  [...args, '--project-dir', projectDir, '--json'],
  {
    env: { CODEX_HOME, PLUGIN_ROOT: CODEX_PLUGIN, SPECTRE_HOME, HOME: ROOT },
    cwd: projectDir,
    isolated: true,
  },
);

const cli = (args, projectDir) => run('node', [CLI, ...args], {
  env: { CODEX_HOME, SPECTRE_HOME, HOME: ROOT },
  cwd: projectDir || REPO,
  isolated: true,
});

const codexPluginScript = (script, args = [], projectDir = REPO) =>
  run('node', [path.join(CODEX_HOOKS, script), ...args], {
    env: {
      CODEX_HOME,
      PLUGIN_ROOT: CODEX_PLUGIN,
      SPECTRE_HOME,
      HOME: ROOT,
    },
    cwd: projectDir,
    isolated: true,
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: projectDir,
      session_id: `gate4-codex-${script}`,
    }),
  });

const managedAgents = (args, projectDir = REPO) =>
  run('node', [ENSURE_CODEX_AGENTS, ...args, '--json'], {
    env: {
      CODEX_HOME,
      PLUGIN_ROOT: CODEX_PLUGIN,
      SPECTRE_HOME,
      HOME: ROOT,
    },
    cwd: projectDir,
    isolated: true,
  });

const override = (dir) => {
  const p = path.join(dir, 'AGENTS.override.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

function snapshotTree(root) {
  if (!fs.existsSync(root)) return {};
  const snapshot = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        snapshot[path.relative(root, absolute)] = fs.readFileSync(absolute).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function featureHostSourceHashes() {
  const files = {
    gate4_cli: path.join(REPO, '.agents', 'skills', 'verify-spectre', 'scripts', 'gate4_cli.mjs'),
    scope_skill: path.join(PLUGIN, 'skills', 'spectre-scope', 'SKILL.md'),
    execute_skill: path.join(PLUGIN, 'skills', 'spectre-execute', 'SKILL.md'),
    handoff_skill: path.join(PLUGIN, 'skills', 'spectre-handoff', 'SKILL.md'),
    session_start_runtime: path.join(HOOKS, 'handoff-resume.mjs'),
    codex_scope_skill: path.join(CODEX_PLUGIN, 'skills', 'spectre-scope', 'SKILL.md'),
    codex_handoff_skill: path.join(CODEX_PLUGIN, 'skills', 'spectre-handoff', 'SKILL.md'),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]),
  );
}

function runClaudeFeatureHost(label, projectDir, prompt, {
  budget = '2.00',
  persist = false,
  resume = null,
  timeout = 600_000,
} = {}) {
  const args = [
    '--plugin-dir', PLUGIN,
    '--setting-sources', 'project',
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Skill,Task',
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--include-hook-events',
    '--verbose',
    '--model', 'sonnet',
    '--effort', 'medium',
    '--max-budget-usd', budget,
    '-p', prompt,
  ];
  if (!persist) args.splice(6, 0, '--no-session-persistence');
  if (resume) args.splice(6, 0, '--resume', resume);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const repositoryHead = run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
  const testedSourceHashes = featureHostSourceHashes();
  const result = run('claude', args, {
    cwd: projectDir,
    env: {
      SPECTRE_HOME: path.join(ROOT, 'feature-host-spectre-home'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    isolated: true,
    timeout,
  });
  const finishedAt = new Date().toISOString();
  const finishedSourceHashes = featureHostSourceHashes();
  const sourceHashesMatch =
    JSON.stringify(testedSourceHashes) === JSON.stringify(finishedSourceHashes);
  if (!sourceHashesMatch) FEATURE_HOST_SOURCE_MISMATCHES.push(label);
  fs.mkdirSync(FEATURE_HOST_EVIDENCE, { recursive: true });
  const stdoutPath = path.join(FEATURE_HOST_EVIDENCE, `${label}.stdout.jsonl`);
  const stderrPath = path.join(FEATURE_HOST_EVIDENCE, `${label}.stderr.txt`);
  const runPath = path.join(FEATURE_HOST_EVIDENCE, `${label}.run.json`);
  fs.writeFileSync(stdoutPath, result.stdout);
  fs.writeFileSync(stderrPath, result.stderr);
  fs.writeFileSync(runPath, `${JSON.stringify({
    label,
    repository_head: repositoryHead,
    tested_source_hashes: testedSourceHashes,
    finished_source_hashes: finishedSourceHashes,
    source_hashes_match: sourceHashesMatch,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - started,
    cwd: projectDir,
    command: `cd ${shellQuote(projectDir)} && SPECTRE_HOME=${shellQuote(path.join(ROOT, 'feature-host-spectre-home'))} claude ${args.map(shellQuote).join(' ')}`,
    binary: 'claude',
    args,
    exit_code: result.code,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  }, null, 2)}\n`);
  return { ...result, runPath, stdoutPath, stderrPath };
}

function claudeSessionId(result) {
  for (const line of result.stdout.split('\n')) {
    try {
      const item = JSON.parse(line);
      if (typeof item.session_id === 'string' && item.session_id) return item.session_id;
    } catch { /* continue */ }
  }
  return null;
}

function commitFixture(projectDir, message) {
  run('git', ['config', 'user.email', 'gate4@spectre.local'], { cwd: projectDir });
  run('git', ['config', 'user.name', 'Spectre Gate 4'], { cwd: projectDir });
  run('git', ['add', '.'], { cwd: projectDir });
  return run('git', ['commit', '-m', message], { cwd: projectDir });
}

async function seedCanonicalRecord(projectDir, {
  id = 'gotchas-hook-timeout',
  trigger = 'hook timeout',
  sentinel = 'SPECTRE_GATE4_CANONICAL_SENTINEL',
  resourceSentinel = 'SPECTRE_GATE4_RESOURCE_SENTINEL',
} = {}) {
  const resolved = await resolveProjectStore(projectDir, { spectreHome: SPECTRE_HOME });
  const recordDirectory = path.join(resolved.storePath, 'knowledge', id);
  const skillPath = path.join(recordDirectory, 'record.json');
  const resourcePath = path.join(recordDirectory, 'references', 'proof.md');
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(skillPath, JSON.stringify({
    schemaVersion: 1, id, kind: 'knowledge', title: id,
    summary: 'Use when diagnosing a hook timeout in the real CLI gate.',
    tags: [trigger.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()],
    applicability: { scope: 'project' },
    provenance: { origin: 'captured', capturedAt: '2026-07-22T00:00:00.000Z' },
    relatedRecordIds: [], category: 'gotcha',
    useWhen: 'Diagnosing a hook timeout in the real CLI gate.',
    content: `${sentinel}\n\nKeep hook diagnostics bounded and deterministic.`,
    evidence: 'Gate fixture.', status: 'active',
  }, null, 2));
  fs.writeFileSync(resourcePath, `${resourceSentinel}\n`);
  fs.writeFileSync(path.join(resolved.storePath, 'tags.json'), JSON.stringify({
    schemaVersion: 1,
    tags: { 'hook-timeout': { description: 'Hook timeout diagnostics.', aliases: [] } },
    redirects: {},
  }, null, 2));
  refreshKnowledgeIndex(resolved.storePath);
  return {
    id,
    sentinel,
    resourceSentinel,
    storePath: resolved.storePath,
    recordDirectory,
    resourcePath,
  };
}

// ---------------------------------------------------------------------------
// A. Non-spectre project guard
// A bare directory has no knowledge surface, so the hook must write nothing.
// Injecting into an unrelated repo would be a genuinely bad bug.
// ---------------------------------------------------------------------------
const bare = makeProject('bare');
const bareRun = hookEvent('load-knowledge.mjs', bare, {
  hook_event_name: 'SessionStart',
  source: 'startup',
  cwd: bare,
  session_id: 'gate4-bare',
});
g.check(bareRun.code === 0, 'load-knowledge exits 0 on a non-spectre project', bareRun.stderr);
g.check(override(bare) === null, 'load-knowledge writes nothing to a non-spectre project',
  'AGENTS.override.md was created in a project with no spectre surface');

// ---------------------------------------------------------------------------
// B. Canonical store — metadata-only SessionStart registry and exact retrieval
// ---------------------------------------------------------------------------
const populated = makeProject('populated', { seeded: true });
const canonical = await seedCanonicalRecord(populated);
const sessionInput = {
  hook_event_name: 'SessionStart',
  source: 'startup',
  cwd: populated,
  session_id: 'gate4-populated',
};
const popRun = hookEvent('load-knowledge.mjs', populated, sessionInput);
g.check(popRun.code === 0, 'load-knowledge exits 0 with a canonical store', popRun.stderr);

g.check(override(populated) === null, 'SessionStart does not write AGENTS.override.md');

let registryOutput = null;
try { registryOutput = JSON.parse(popRun.stdout); } catch { /* handled below */ }
g.check(registryOutput !== null, 'load-knowledge emits valid SessionStart JSON on stdout',
  'Claude Code parses this; malformed JSON silently drops the hook output');
const registry = registryOutput?.hookSpecificOutput?.additionalContext;
g.check(
  typeof registry === 'string' && registry.includes('- hook-timeout:') &&
    registry.includes("load '<id>'"),
  'SessionStart delivers searchable metadata and exact-load guidance',
  `unexpected registry: ${registry}`,
);
g.check(
  typeof registry === 'string' &&
    (registry.match(/search '<task>'/g) || []).length === 2 &&
    (registry.match(/load '<id>'/g) || []).length === 1,
  'SessionStart provides one bounded search and exact-load workflow',
  `unexpected registry: ${registry}`,
);

const knowledgeResumeRun = hookEvent('load-knowledge.mjs', populated, {
  ...sessionInput,
  source: 'resume',
});
g.check(
  knowledgeResumeRun.code === 0 && knowledgeResumeRun.stdout.trim() === '',
  'SessionStart injects no knowledge registry on resume',
  `resume emitted ${knowledgeResumeRun.stdout.length} chars; a resumed transcript already replays the startup injection`,
);
g.check(
  typeof registry === 'string' && !registry.includes(canonical.sentinel) &&
    registry.length < 10_000,
  'SessionStart registry is metadata-only and within the Claude host budget',
);
g.check(
  registryOutput?.systemMessage === undefined &&
    registryOutput?.hookSpecificOutput?.systemMessage === undefined,
  'SessionStart registry emits no visible knowledge system message',
);
g.check(
  !fs.existsSync(path.join(populated, '.agents', 'skills', canonical.id)) &&
    !fs.existsSync(path.join(populated, '.claude', 'skills', canonical.id)),
  'canonical knowledge remains outside repository-native skill roots',
);

const previewActivityPath = path.join(canonical.storePath, 'activity.json');
const previewRun = knowledgeCli(['registry', '--host', 'claude'], populated);
let previewOutput = null;
try { previewOutput = JSON.parse(previewRun.stdout); } catch { /* handled below */ }
g.check(
  previewRun.code === 0 && previewOutput?.injected === true &&
    JSON.stringify(previewOutput.payload) === JSON.stringify(registryOutput),
  'knowledge registry preview returns the exact Claude SessionStart payload',
  previewRun.stderr || previewRun.stdout,
);
g.check(
  previewOutput?.measurement?.ok === true &&
    previewOutput?.includedCount === 1 &&
    !fs.existsSync(previewActivityPath),
  'knowledge registry preview reports budget and inclusion without activity writes',
);

const searchRun = knowledgeCli(['search', 'hook timeout'], populated);
let searchOutput = null;
try { searchOutput = JSON.parse(searchRun.stdout); } catch { /* handled below */ }
g.check(searchRun.code === 0, 'knowledge search exits 0 for a matching query', searchRun.stderr);
g.check(
  searchOutput?.results?.some((record) => record.id === canonical.id),
  'knowledge search returns the canonical record ID',
);
const loadRun = knowledgeCli(['load', canonical.id], populated);
let loadOutput = null;
try { loadOutput = JSON.parse(loadRun.stdout); } catch { /* handled below */ }
g.check(loadRun.code === 0, 'knowledge load exits 0 for an exact ID', loadRun.stderr);
g.check(
  loadOutput?.rendered?.includes(canonical.sentinel),
  'knowledge load returns the complete verified canonical record',
);
g.check(
  loadOutput?.recordDirectory === canonical.recordDirectory &&
    loadOutput?.resources?.length === 1 &&
    loadOutput.resources[0]?.relativePath === 'references/proof.md' &&
    loadOutput.resources[0]?.absolutePath === canonical.resourcePath,
  'knowledge load returns the canonical directory and safe supporting-resource path',
);
g.check(
  loadOutput?.activity?.successfulLoads === 1,
  'one Claude bundled exact-load invocation advances successful-load activity exactly once',
);

// ---------------------------------------------------------------------------
// C. Read-only repeat — SessionStart fires on every startup/clear/compact
// ---------------------------------------------------------------------------
const activityPath = path.join(canonical.storePath, 'activity.json');
const activityBefore = fs.readFileSync(activityPath, 'utf8');
const repeatRegistry = hookEvent('load-knowledge.mjs', populated, sessionInput);
g.check(repeatRegistry.stdout === popRun.stdout, 're-running load-knowledge is byte-identical');
g.check(fs.readFileSync(activityPath, 'utf8') === activityBefore,
  'SessionStart registry delivery does not increment load activity');

// ---------------------------------------------------------------------------
// E. Session memory
// ---------------------------------------------------------------------------
const session = makeProject('session', { seeded: true });
const logs = path.join(session, 'docs', 'tasks', 'main', 'session_logs');
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, '20260714_handoff.json'), JSON.stringify({
  summary: 'Verifying the merge',
  next_steps: ['run gate 4'],
  tasks: [],
}));

const bootRun = hook('bootstrap.mjs', session);
g.check(bootRun.code === 0, 'bootstrap exits 0', bootRun.stderr);

const resumeRun = hook('handoff-resume.mjs', session);
g.check(resumeRun.code === 0, 'handoff-resume exits 0', resumeRun.stderr);
g.check(/handoff|resume|Verifying the merge/i.test(resumeRun.stdout),
  'handoff-resume surfaces the latest handoff',
  'a handoff exists but the resume notice does not mention it — session memory is silently dead');

// ---------------------------------------------------------------------------
// F. Retired CLI install / update / uninstall hard cut
// ---------------------------------------------------------------------------
for (const command of ['install', 'update', 'uninstall']) {
  const proj = makeProject(`hard-cut-${command}`);
  const sentinelDir = path.join(CODEX_HOME, `sentinel-${command}`);
  fs.mkdirSync(sentinelDir, { recursive: true });
  const sentinel = path.join(sentinelDir, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep\n');
  const before = fs.readFileSync(sentinel, 'utf8');
  const result = cli([
    command,
    'codex',
    '--scope',
    'project',
    '--project-dir',
    proj,
    '--json',
  ], proj);
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch { /* handled below */ }
  g.check(result.code !== 0, `${command} codex exits nonzero after native plugin migration`);
  g.check(payload?.code === 'CODEX_PLUGIN_REQUIRED',
    `${command} codex reports CODEX_PLUGIN_REQUIRED`,
    result.stderr || result.stdout);
  g.check(fs.readFileSync(sentinel, 'utf8') === before,
    `${command} codex performs no filesystem mutation`);
}

// ---------------------------------------------------------------------------
// G. Native Codex plugin bootstrap and managed-agent lifecycle
// ---------------------------------------------------------------------------
const codexProject = makeProject('codex-plugin', { seeded: true });
fs.mkdirSync(path.join(CODEX_HOME, 'spectre', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(CODEX_HOME, 'spectre', 'hooks', 'legacy.mjs'), 'legacy\n');
const bootstrapCodex = codexPluginScript('bootstrap.mjs', [], codexProject);
g.check(bootstrapCodex.code === 0, 'native Codex bootstrap exits 0', bootstrapCodex.stderr || bootstrapCodex.stdout);
g.check(
  fs.existsSync(path.join(CODEX_HOME, 'agents', 'spectre_dev.toml')),
  'native Codex bootstrap installs managed spectre_dev agent',
);
g.check(
  fs.readFileSync(path.join(CODEX_HOME, 'agents', 'spectre_dev.toml'), 'utf8')
    .includes('# spectre-managed-codex-agent'),
  'native Codex bootstrap writes managed agent marker',
);
g.check(
  !fs.existsSync(path.join(CODEX_HOME, 'spectre')),
  'native Codex bootstrap removes legacy direct-install runtime',
);

const codexCanonical = await seedCanonicalRecord(codexProject, {
  id: 'gotchas-codex-bundled-load',
  trigger: 'Codex bundled load proof',
  sentinel: 'SPECTRE_GATE4_CODEX_SENTINEL',
  resourceSentinel: 'SPECTRE_GATE4_CODEX_RESOURCE_SENTINEL',
});
const codexRegistryRun = codexPluginScript('load-knowledge.mjs', ['--host', 'codex'], codexProject);
let codexRegistryOutput = null;
try { codexRegistryOutput = JSON.parse(codexRegistryRun.stdout); } catch { /* handled below */ }
const codexRegistry = codexRegistryOutput?.hookSpecificOutput?.additionalContext;
g.check(codexRegistryRun.code === 0 && typeof codexRegistry === 'string',
  'generated Codex SessionStart registry executes through the bundled runtime',
  codexRegistryRun.stderr || codexRegistryRun.stdout);
g.check(
  !codexRegistry?.includes(codexCanonical.sentinel) &&
    codexRegistryOutput?.systemMessage === undefined &&
    codexRegistryOutput?.hookSpecificOutput?.systemMessage === undefined,
  'generated Codex registry is metadata-only with no visible knowledge message',
);
const codexPreviewActivityPath = path.join(codexCanonical.storePath, 'activity.json');
const codexPreviewRun = codexKnowledgeCli(['registry', '--host', 'codex'], codexProject);
let codexPreviewOutput = null;
try { codexPreviewOutput = JSON.parse(codexPreviewRun.stdout); } catch { /* handled below */ }
g.check(
  codexPreviewRun.code === 0 && codexPreviewOutput?.injected === true &&
    JSON.stringify(codexPreviewOutput.payload) === JSON.stringify(codexRegistryOutput),
  'generated Codex registry preview returns the exact SessionStart payload',
  codexPreviewRun.stderr || codexPreviewRun.stdout,
);
g.check(
  codexPreviewOutput?.measurement?.ok === true &&
    codexPreviewOutput?.includedCount === 1 &&
    !fs.existsSync(codexPreviewActivityPath),
  'generated Codex registry preview reports budget and inclusion without activity writes',
);
const codexSearchRun = codexKnowledgeCli(['search', 'Codex bundled load proof'], codexProject);
let codexSearchOutput = null;
try { codexSearchOutput = JSON.parse(codexSearchRun.stdout); } catch { /* handled below */ }
g.check(
  codexSearchRun.code === 0 &&
    codexSearchOutput?.results?.some((record) => record.id === codexCanonical.id),
  'generated Codex bundled search returns the exact canonical ID',
  codexSearchRun.stderr || codexSearchRun.stdout,
);
const codexLoadRun = codexKnowledgeCli(['load', codexCanonical.id], codexProject);
let codexLoadOutput = null;
try { codexLoadOutput = JSON.parse(codexLoadRun.stdout); } catch { /* handled below */ }
g.check(
  codexLoadRun.code === 0 && codexLoadOutput?.rendered?.includes(codexCanonical.sentinel),
  'generated Codex bundled exact load returns the verified full core',
  codexLoadRun.stderr || codexLoadRun.stdout,
);
g.check(
  codexLoadOutput?.recordDirectory === codexCanonical.recordDirectory &&
    codexLoadOutput?.resources?.length === 1 &&
    codexLoadOutput.resources[0]?.relativePath === 'references/proof.md' &&
    codexLoadOutput.resources[0]?.absolutePath === codexCanonical.resourcePath,
  'generated Codex bundled load returns safe supporting-resource paths',
);
g.check(
  codexLoadOutput?.activity?.successfulLoads === 1,
  'one Codex bundled exact-load invocation advances successful-load activity exactly once',
);

const doctor = cli(['doctor', 'codex', '--scope', 'user', '--project-dir', codexProject, '--json'], codexProject);
let report = null;
try { report = JSON.parse(doctor.stdout); } catch { /* handled below */ }
g.check(doctor.code === 0, 'doctor codex passes after native bootstrap', doctor.stderr || doctor.stdout);
g.check(report?.nativePlugin?.generated?.hooksUsePluginRoot === true,
  'doctor reports generated Codex hooks use PLUGIN_ROOT');
g.check(report?.nativePlugin?.agents?.ready === true,
  'doctor reports managed Codex agents ready');

const agentPath = path.join(CODEX_HOME, 'agents', 'spectre_dev.toml');
const originalAgent = fs.readFileSync(agentPath, 'utf8');
fs.writeFileSync(agentPath, originalAgent.replace('workspace-write', 'read-only'));
const repaired = managedAgents(['--ensure'], codexProject);
let repairedPayload = null;
try { repairedPayload = JSON.parse(repaired.stdout); } catch { /* handled below */ }
g.check(repaired.code === 0, 'managed-agent helper repairs stale managed agents', repaired.stderr || repaired.stdout);
g.check(repairedPayload?.updated?.includes('spectre_dev.toml'),
  'managed-agent helper reports updated spectre_dev.toml');
g.check(fs.readFileSync(agentPath, 'utf8') === originalAgent,
  'managed-agent helper restores exact bundled agent bytes');

const collisionPath = path.join(CODEX_HOME, 'agents', 'spectre_tester.toml');
fs.writeFileSync(collisionPath, 'name = "spectre_tester"\n# user-owned\n');
const collision = managedAgents(['--ensure'], codexProject);
let collisionPayload = null;
try { collisionPayload = JSON.parse(collision.stdout); } catch { /* handled below */ }
g.check(collision.code !== 0, 'managed-agent helper rejects unowned collisions');
g.check(collisionPayload?.collisions?.includes(collisionPath),
  'managed-agent helper reports the unowned collision path');
fs.unlinkSync(collisionPath);

const removed = managedAgents(['--remove'], codexProject);
let removedPayload = null;
try { removedPayload = JSON.parse(removed.stdout); } catch { /* handled below */ }
g.check(removed.code === 0, 'managed-agent helper removes managed agents', removed.stderr || removed.stdout);
g.check(removedPayload?.removed?.includes('spectre_dev.toml'),
  'managed-agent helper reports removed spectre_dev.toml');
g.check(!fs.existsSync(agentPath), 'managed-agent helper leaves no spectre_dev TOML after remove');

// ---------------------------------------------------------------------------
// H. Plugin-hosted feature workflows
// These model-backed journeys are opt-in because they require host auth and
// incur model cost. They remain part of Gate 4 so the exact shipped skill
// controls, rather than a fixture-only resolver, own the behavior under test.
// ---------------------------------------------------------------------------
if (process.env.SPECTRE_GATE4_FEATURE_HOST !== '1') {
  g.warn(
    false,
    'plugin-hosted feature workflow journeys were not requested',
    'rerun with SPECTRE_GATE4_FEATURE_HOST=1; set SPECTRE_GATE4_EVIDENCE_DIR to retain transcripts',
  );
} else {
  const creatorProject = makeProject('feature-host-creator');
  fs.writeFileSync(path.join(creatorProject, 'README.md'), '# Disposable host fixture\n');
  commitFixture(creatorProject, 'test: seed creator host fixture');

  const creatorRun = runClaudeFeatureHost(
    'creator',
    creatorProject,
    [
      '/spectre:spectre-scope',
      'Scope a feature whose exact user-facing title is "Hosted Feature Proof".',
      'The problem is that operators cannot export one local report for offline review.',
      'Primary user: local CLI operator. IN: one offline Markdown export.',
      'OUT: cloud sync and scheduled exports. ANTI-SCOPE: collaboration or account management.',
      'Success means an operator can request one export and read it offline.',
      'All boundaries and assumptions in this message are confirmed. There are no blocking questions.',
      'Propose the lowercase kebab feature name in the normal boundary response; I provide no name correction.',
      'Proceed through the existing scope gate without a separate naming-confirmation turn.',
    ].join(' '),
  );
  const creatorRoot = path.join(
    creatorProject,
    '.spectre',
    'features',
    'hosted-feature-proof',
  );
  const creatorManifest = path.join(creatorRoot, 'feature.json');
  const creatorScope = path.join(creatorRoot, 'concepts', 'scope.md');
  g.check(
    creatorRun.code === 0 &&
      fs.existsSync(creatorManifest) &&
      fs.existsSync(creatorScope),
    'feature creator accepts the proposed name without a second naming prompt',
    creatorRun.stderr || `transcript: ${creatorRun.stdoutPath}`,
  );
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(creatorManifest, 'utf8')); } catch { /* checked below */ }
  g.check(
    manifest?.schema_version === 1 &&
      typeof manifest?.created_at === 'string' &&
      manifest?.feature === 'hosted-feature-proof' &&
      manifest?.feature_root === '.spectre/features/hosted-feature-proof',
    'plugin-hosted creator writes feature.json before its first artifact',
    `manifest: ${creatorManifest}`,
  );
  const creatorScopeBody = fs.existsSync(creatorScope)
    ? fs.readFileSync(creatorScope, 'utf8')
    : '';
  g.check(
    /^Feature: hosted-feature-proof$/m.test(creatorScopeBody) &&
      /^Feature Root: \.spectre\/features\/hosted-feature-proof$/m.test(creatorScopeBody),
    'plugin-hosted creator writes Feature and Feature Root metadata on the first artifact',
    `scope: ${creatorScope}`,
  );
  const creatorNestedIgnore = path.join(creatorProject, '.spectre', '.gitignore');
  const creatorNestedIgnoreBody = fs.existsSync(creatorNestedIgnore)
    ? fs.readFileSync(creatorNestedIgnore, 'utf8')
    : '';
  g.check(
    fs.existsSync(creatorNestedIgnore) &&
      /^manifest\.json$/m.test(creatorNestedIgnoreBody) &&
      /^bin\/$/m.test(creatorNestedIgnoreBody) &&
      /^handoffs\/$/m.test(creatorNestedIgnoreBody) &&
      /^!features\/$/m.test(creatorNestedIgnoreBody),
    'plugin-hosted creator initializes the nested local-state ignore policy',
    `nested ignore: ${creatorNestedIgnore}`,
  );
  fs.mkdirSync(path.join(creatorProject, '.spectre', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(creatorProject, '.spectre', 'handoffs', 'main'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(creatorProject, '.spectre', 'manifest.json'), '{}\n');
  fs.writeFileSync(path.join(creatorProject, '.spectre', 'bin', 'spectre'), '#!/bin/sh\n');
  fs.writeFileSync(
    path.join(creatorProject, '.spectre', 'handoffs', 'main', 'one_handoff.json'),
    '{}\n',
  );
  const featureIgnoreCheck = run(
    'git',
    ['check-ignore', '-q', '.spectre/features/hosted-feature-proof/feature.json'],
    { cwd: creatorProject },
  );
  const localIgnoreChecks = [
    '.spectre/manifest.json',
    '.spectre/bin/spectre',
    '.spectre/handoffs/main/one_handoff.json',
  ].map((candidate) => run('git', ['check-ignore', '-q', candidate], {
    cwd: creatorProject,
  }));
  g.check(
    featureIgnoreCheck.code !== 0 &&
      localIgnoreChecks.every((result) => result.code === 0),
    'plugin-hosted creator keeps feature records trackable and local state ignored',
    `feature exit: ${featureIgnoreCheck.code}; local exits: ${localIgnoreChecks.map((result) => result.code).join(',')}`,
  );

  const blanketIgnoreProject = makeProject('feature-host-blanket-ignore');
  const blanketRootIgnore = path.join(blanketIgnoreProject, '.gitignore');
  fs.writeFileSync(
    blanketRootIgnore,
    '# user-owned policy\n.spectre/\n!README.md\n',
  );
  fs.writeFileSync(
    path.join(blanketIgnoreProject, 'README.md'),
    '# Disposable blanket-ignore fixture\n',
  );
  commitFixture(blanketIgnoreProject, 'test: seed blanket-ignore host fixture');
  const blanketRootIgnoreBefore = fs.readFileSync(blanketRootIgnore);
  const blanketRun = runClaudeFeatureHost(
    'creator-blanket-ignore',
    blanketIgnoreProject,
    [
      '/spectre:spectre-scope',
      'Scope a feature whose exact user-facing title is "Blanket Ignore Proof".',
      'The problem is that operators cannot inspect a local archive manifest before export.',
      'Primary user: local CLI operator. IN: one readable archive manifest.',
      'OUT: remote uploads. ANTI-SCOPE: account or collaboration features.',
      'Success means an operator can inspect the manifest before exporting.',
      'All boundaries and assumptions in this message are confirmed. There are no blocking questions.',
      'Propose the lowercase kebab feature name in the normal boundary response; I provide no name correction.',
      'Proceed through the existing scope gate without a separate naming-confirmation turn.',
      'The repository root .gitignore is pre-existing and user-owned; preserve it exactly.',
    ].join(' '),
  );
  const blanketFeatureManifest = path.join(
    blanketIgnoreProject,
    '.spectre',
    'features',
    'blanket-ignore-proof',
    'feature.json',
  );
  const blanketIgnoreCheck = run(
    'git',
    ['check-ignore', '-q', '.spectre/features/blanket-ignore-proof/feature.json'],
    { cwd: blanketIgnoreProject },
  );
  g.check(
    blanketRun.code === 0 &&
      fs.existsSync(blanketFeatureManifest) &&
      Buffer.compare(
        fs.readFileSync(blanketRootIgnore),
        blanketRootIgnoreBefore,
      ) === 0 &&
      !fs.existsSync(path.join(blanketIgnoreProject, '.spectre', '.gitignore')),
    'plugin-hosted creator preserves a blanket root ignore byte-for-byte',
    blanketRun.stderr || `transcript: ${blanketRun.stdoutPath}`,
  );
  g.check(
    blanketIgnoreCheck.code === 0 && /local-only/i.test(blanketRun.stdout),
    'plugin-hosted creator warns that blanket-ignored feature records are local-only',
    `ignore exit: ${blanketIgnoreCheck.code}; transcript: ${blanketRun.stdoutPath}`,
  );

  const standalonePlanProject = makeProject('feature-host-standalone-plan');
  fs.mkdirSync(path.join(standalonePlanProject, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(standalonePlanProject, 'src', 'cli.js'),
    'export function run(args) { return args.length; }\n',
  );
  fs.writeFileSync(
    path.join(standalonePlanProject, 'README.md'),
    '# Disposable standalone plan fixture\n',
  );
  commitFixture(standalonePlanProject, 'test: seed standalone plan fixture');
  const standalonePlanRun = runClaudeFeatureHost(
    'standalone-plan',
    standalonePlanProject,
    [
      '/spectre:spectre-create_plan --depth light',
      'Plan a scoped change that adds a local --health CLI flag returning process status.',
      'IN: the flag and focused tests. OUT: network health endpoints. ANTI-SCOPE: telemetry.',
      'There is deliberately no feature name or root. Derive one, create it, and proceed without asking.',
    ].join(' '),
  );
  const standalonePlanFeatures = path.join(standalonePlanProject, '.spectre', 'features');
  const standalonePlanName = fs.existsSync(standalonePlanFeatures)
    ? fs.readdirSync(standalonePlanFeatures).find((name) =>
      fs.existsSync(path.join(standalonePlanFeatures, name, 'specs', 'plan.md')))
    : undefined;
  g.check(
    standalonePlanRun.code === 0 &&
      Boolean(standalonePlanName) &&
      fs.existsSync(path.join(standalonePlanFeatures, standalonePlanName, 'feature.json')),
    'standalone create-plan derives a feature root and writes without a naming gate',
    standalonePlanRun.stderr || `transcript: ${standalonePlanRun.stdoutPath}`,
  );

  const missingRootProject = makeProject('feature-host-orchestrated-missing-root');
  fs.writeFileSync(
    path.join(missingRootProject, 'README.md'),
    '# Disposable orchestrated missing-root fixture\n',
  );
  commitFixture(missingRootProject, 'test: seed orchestrated missing-root fixture');
  const missingRootRun = runClaudeFeatureHost(
    'orchestrated-missing-root',
    missingRootProject,
    [
      '/spectre:spectre-create_test_guide --orchestrated',
      'No feature root, feature artifact, or current-thread feature exists.',
      'Return the required feature-root escalation without initializing a root,',
      'writing a test guide, or asking for a feature name.',
    ].join(' '),
  );
  g.check(
    missingRootRun.code === 0 &&
      !fs.existsSync(path.join(missingRootProject, '.spectre', 'features')) &&
      /feature root|FEATURE_ROOT/.test(missingRootRun.stdout),
    'orchestrated workflow without a root escalates without allocating one',
    missingRootRun.stderr || `transcript: ${missingRootRun.stdoutPath}`,
  );

  const scopeBeforeRescope = creatorScopeBody;
  const rescopeRun = runClaudeFeatureHost(
    'rescope',
    creatorProject,
    [
      '/spectre:spectre-scope .spectre/features/hosted-feature-proof',
      'Explicitly re-scope this existing managed feature.',
      'The confirmed delta adds encrypted local export as IN and keeps cloud sync OUT.',
      'All other boundaries remain confirmed. Do not ask another question.',
      'Exercise the existing overwrite safeguard: keep concepts/scope.md byte-identical',
      'and write the confirmed delta to a scoped sibling Markdown filename.',
    ].join(' '),
  );
  const conceptFiles = fs.existsSync(path.join(creatorRoot, 'concepts'))
    ? fs.readdirSync(path.join(creatorRoot, 'concepts'))
      .filter((name) => name.endsWith('.md') && name !== 'scope.md')
    : [];
  g.check(
    rescopeRun.code === 0 &&
      fs.existsSync(creatorScope) &&
      fs.readFileSync(creatorScope, 'utf8') === scopeBeforeRescope &&
      conceptFiles.some((name) =>
        /encrypted local export/i.test(
          fs.readFileSync(path.join(creatorRoot, 'concepts', name), 'utf8'),
        )),
    'explicit re-scope preserves the existing scope bytes',
    rescopeRun.stderr || `transcript: ${rescopeRun.stdoutPath}`,
  );

  const collisionProject = makeProject('feature-host-collision');
  fs.writeFileSync(path.join(collisionProject, 'README.md'), '# Disposable collision fixture\n');
  const collisionRoot = path.join(
    collisionProject,
    '.spectre',
    'features',
    'occupied-collision-proof',
  );
  fs.mkdirSync(collisionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(collisionRoot, 'sentinel.bin'),
    Buffer.from([0x00, 0x53, 0x50, 0x45, 0x43, 0x54, 0x52, 0x45, 0xff]),
  );
  commitFixture(collisionProject, 'test: seed collision host fixture');
  const collisionBefore = snapshotTree(collisionRoot);
  const collisionRun = runClaudeFeatureHost(
    'collision',
    collisionProject,
    [
      '/spectre:spectre-scope',
      'Scope a new feature whose exact title is "Occupied Collision Proof".',
      'It adds one local diagnostic report. IN: local report.',
      'OUT: remote upload. ANTI-SCOPE: telemetry.',
      'The boundaries are confirmed and there are no questions.',
      'Use the normal proposal flow; I am not selecting or continuing an existing managed feature.',
      'If the proposed directory is occupied, select the first free suffixed root and proceed without asking.',
    ].join(' '),
  );
  const collisionFeaturesDir = path.join(collisionProject, '.spectre', 'features');
  const collisionFallback = fs.readdirSync(collisionFeaturesDir)
    .find((name) => name.startsWith('occupied-collision-proof-'));
  g.check(
    collisionRun.code === 0 &&
      JSON.stringify(snapshotTree(collisionRoot)) === JSON.stringify(collisionBefore) &&
      Boolean(collisionFallback) &&
      fs.existsSync(path.join(collisionFeaturesDir, collisionFallback, 'feature.json')) &&
      fs.existsSync(path.join(collisionFeaturesDir, collisionFallback, 'concepts', 'scope.md')),
    'occupied proposal remains untouched while a free suffixed root proceeds',
    collisionRun.stderr || `transcript: ${collisionRun.stdoutPath}`,
  );

  const handoffProject = makeProject('feature-host-handoff');
  fs.writeFileSync(path.join(handoffProject, 'README.md'), '# Disposable handoff fixture\n');
  commitFixture(handoffProject, 'test: seed handoff host fixture');
  run('git', ['checkout', '-b', 'feature/foo'], { cwd: handoffProject });
  const legacyHandoffDir = path.join(
    handoffProject,
    'docs',
    'tasks',
    'feature',
    'foo',
    'session_logs',
  );
  fs.mkdirSync(legacyHandoffDir, { recursive: true });
  for (const [index, timestamp] of ['100000', '110000', '120000'].entries()) {
    fs.writeFileSync(
      path.join(legacyHandoffDir, `2026-07-23-${timestamp}_handoff.json`),
      `${JSON.stringify({
        version: '1.1',
        timestamp: `2026-07-23-${timestamp}`,
        branch_name: 'feature/foo',
        task_name: `legacy-${index + 1}`,
        session_number: index + 1,
        progress_update: {
          summary: `legacy-${index + 1}`,
          goal: 'Prove canonical handoff cutover.',
          accomplished: [],
          now: 'Ready for canonical handoff.',
          next_steps: [],
          confidence: 'high',
        },
        working_set: { key_files: [], active_ids: [], recent_commands: [] },
        context: { wip_state: 'clean', last_commit: 'fixture' },
      }, null, 2)}\n`,
    );
  }
  const legacyTodoPath = path.join(
    legacyHandoffDir,
    '2026-07-23-120000_todos.json',
  );
  const legacyTodoHistoryPath = path.join(legacyHandoffDir, 'todos_history.json');
  fs.writeFileSync(legacyTodoPath, '[{"legacy":true}]\n');
  fs.writeFileSync(legacyTodoHistoryPath, '{"sessions":[{"legacy":true}]}\n');
  commitFixture(handoffProject, 'test: seed legacy handoff history');
  const legacyTodoBefore = fs.readFileSync(legacyTodoPath, 'utf8');
  const legacyTodoHistoryBefore = fs.readFileSync(legacyTodoHistoryPath, 'utf8');
  const handoffTodoSeedRun = runClaudeFeatureHost(
    'handoff-todo-seed',
    handoffProject,
    [
      'First use TaskCreate to create one real agent-native task titled',
      '"Verify canonical todo storage", then use TaskUpdate to mark it in_progress.',
      'Stop after the task state is saved; do not invoke another workflow.',
    ].join(' '),
    { budget: '1.00', persist: true },
  );
  const handoffSessionId = claudeSessionId(handoffTodoSeedRun);
  g.check(
    handoffTodoSeedRun.code === 0 && typeof handoffSessionId === 'string',
    'plugin-hosted handoff fixture establishes real agent-native todo state',
    handoffTodoSeedRun.stderr || `transcript: ${handoffTodoSeedRun.stdoutPath}`,
  );
  const handoffRun = runClaudeFeatureHost(
    'handoff-execution',
    handoffProject,
    '/spectre:spectre-handoff feature-artifact-location',
    { budget: '3.00', persist: true, resume: handoffSessionId },
  );
  const canonicalHandoffDir = path.join(
    handoffProject,
    '.spectre',
    'handoffs',
    'feature',
    'foo',
  );
  const canonicalHandoffs = fs.existsSync(canonicalHandoffDir)
    ? fs.readdirSync(canonicalHandoffDir).filter((name) => name.endsWith('_handoff.json'))
    : [];
  const canonicalTodos = fs.existsSync(canonicalHandoffDir)
    ? fs.readdirSync(canonicalHandoffDir).filter((name) => name.endsWith('_todos.json'))
    : [];
  let canonicalHandoff = null;
  if (canonicalHandoffs.length === 1) {
    try {
      canonicalHandoff = JSON.parse(
        fs.readFileSync(path.join(canonicalHandoffDir, canonicalHandoffs[0]), 'utf8'),
      );
    } catch { /* checked below */ }
  }
  g.check(
    handoffRun.code === 0 &&
      canonicalHandoffs.length === 1 &&
      !fs.existsSync(path.join(handoffProject, '.spectre', 'handoffs', 'feature%2Ffoo')) &&
      !fs.existsSync(path.join(handoffProject, '.spectre', 'handoffs', 'feature-foo')),
    'plugin-hosted handoff uses the raw nested branch path',
    handoffRun.stderr || `transcript: ${handoffRun.stdoutPath}`,
  );
  g.check(
    canonicalHandoff?.branch_name === 'feature/foo' &&
      canonicalHandoff?.session_number === 4,
    'plugin-hosted handoff continues legacy numbering',
    `handoff: ${JSON.stringify(canonicalHandoff)}`,
  );
  g.check(
    canonicalTodos.length === 1 &&
      fs.existsSync(path.join(canonicalHandoffDir, 'todos_history.json')) &&
      fs.readFileSync(legacyTodoPath, 'utf8') === legacyTodoBefore &&
      fs.readFileSync(legacyTodoHistoryPath, 'utf8') === legacyTodoHistoryBefore,
    'plugin-hosted todo snapshots write only to the canonical handoff root',
    `canonical todos: ${JSON.stringify(canonicalTodos)}`,
  );

  const renameProject = makeProject('feature-host-renamed');
  const originalRoot = path.join(
    renameProject,
    '.spectre',
    'features',
    'original-low-context',
  );
  const renamedRoot = path.join(
    renameProject,
    '.spectre',
    'features',
    'renamed-low-context',
  );
  const originalPlan = path.join(originalRoot, 'specs', 'plan.md');
  fs.mkdirSync(path.dirname(originalPlan), { recursive: true });
  fs.writeFileSync(
    path.join(originalRoot, 'feature.json'),
    `${JSON.stringify({
      schema_version: 1,
      created_at: '2026-07-23T00:00:00.000Z',
      feature: 'original-low-context',
      feature_root: '.spectre/features/original-low-context',
    }, null, 2)}\n`,
  );
  fs.writeFileSync(originalPlan, [
    '# Plan: Low-Context Export',
    '',
    'Feature: Original Low Context',
    'Feature Root: .spectre/features/original-low-context',
    '',
    '## Objective',
    'Let a CLI operator write one deterministic local export.',
    '',
    '## User Workflow',
    'Run `spectre export --local`, then verify `export.md` exists and contains the report title.',
    '',
    '## Failure Behavior',
    'A read-only destination exits nonzero and preserves existing bytes.',
    '',
  ].join('\n'));
  fs.renameSync(originalRoot, renamedRoot);
  commitFixture(renameProject, 'test: seed physically renamed feature fixture');
  const renamedPlan = path.join(renamedRoot, 'specs', 'plan.md');
  const nestedRun = runClaudeFeatureHost(
    'renamed-nested-artifact',
    renameProject,
    [
      `/spectre:spectre-create_test_guide ${path.relative(renameProject, renamedPlan)} --orchestrated`,
      'The supplied nested plan is the sole feature locator and has sufficient test context.',
      'Use the physical enclosing feature directory as authority, repair touched self-location',
      'metadata before writing, and produce the canonical guide now without questions.',
    ].join(' '),
  );
  const renamedGuide = path.join(renamedRoot, 'testing', 'test_guide.md');
  const repairedPlanBody = fs.readFileSync(renamedPlan, 'utf8');
  const renamedGuideBody = fs.existsSync(renamedGuide)
    ? fs.readFileSync(renamedGuide, 'utf8')
    : '';
  g.check(
    nestedRun.code === 0 && fs.existsSync(renamedGuide),
    'nested artifact alone resolves the renamed physical feature root',
    nestedRun.stderr || `transcript: ${nestedRun.stdoutPath}`,
  );
  g.check(
    /^Feature: Renamed Low Context$/m.test(repairedPlanBody) &&
      /^Feature Root: \.spectre\/features\/renamed-low-context$/m.test(repairedPlanBody) &&
      /^Feature Root: \.spectre\/features\/renamed-low-context$/m.test(renamedGuideBody),
    'touched nested artifact metadata is repaired before the new write',
    `plan: ${renamedPlan}; guide: ${renamedGuide}`,
  );

  g.check(
    FEATURE_HOST_SOURCE_MISMATCHES.length === 0,
    'plugin-hosted journeys use one immutable scoped source state',
    `source mismatches: ${JSON.stringify(FEATURE_HOST_SOURCE_MISMATCHES)}`,
  );
}

g.done();
