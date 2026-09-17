'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agents = require('./translators/agents.cjs');
const hooks = require('./translators/hooks.cjs');
const skills = require('./translators/skills.cjs');
const { runSync } = require('./sync-codex.cjs');

test('knowledge translators retain every public operation', () => {
  const operations = ['search', 'tags', 'load', 'register', 'capture', 'work', 'history', 'inspect', 'registry', 'migrate'];
  const source = operations.map(operation => `spectre knowledge ${operation} fixture`).join('\n');
  for (const rewrite of [hooks.rewriteRuntimeScript, skills.rewriteTextForCodex]) {
    const translated = rewrite(source);
    for (const operation of operations) {
      assert.match(translated, new RegExp(`knowledge-cli\\.mjs" ${operation} fixture`));
    }
  }
});

test('skill command translator emits plugin-qualified Codex invocations and rejects legacy shorthand', () => {
  assert.equal(
    skills.rewriteCodexCommandRefs('/spectre:spectre-execute path/to/plan.md --origin plan'),
    '$spectre:spectre-execute path/to/plan.md --origin plan',
  );
  assert.throws(
    () => skills.rewriteCodexCommandRefs('/spectre:execute path/to/plan.md'),
    /Legacy Spectre command reference "\/spectre:execute"; use \/spectre:spectre-execute/,
  );
  assert.equal(
    hooks.rewriteRuntimeScript('Continue with /spectre:spectre-handoff.'),
    'Continue with $spectre:spectre-handoff.',
  );
});

test('agent translator rewrites user-facing workflow commands for Codex', () => {
  const source = `---
name: sync
description: Called by /spectre:spectre-handoff.
model: claude-sonnet-5
---

Resume with /spectre:spectre-execute.
`;
  const fields = agents.parseToml(agents.buildAgentToml(source, 'sync.md'));
  assert.equal(fields.description, 'Called by $spectre:spectre-handoff.');
  assert.equal(fields.developer_instructions, 'Resume with $spectre:spectre-execute.');
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spectre-sync-test-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function repositoryTokenCount(repoRoot, filePath) {
  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'count-tokens.js'), filePath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const match = output.match(/^Tokens: ([\d,]+)$/m);
  assert.ok(match, `missing exact token count for ${filePath}`);
  return Number(match[1].replaceAll(',', ''));
}

const USER_HANDOFF_SKILLS = [
  'spectre-clean', 'spectre-code_review', 'spectre-create_plan', 'spectre-create_pr',
  'spectre-create_tasks', 'spectre-create_test_guide', 'spectre-delegate', 'spectre-execute',
  'spectre-fix', 'spectre-goal', 'spectre-handoff', 'spectre-kickoff', 'spectre-learn',
  'spectre-plan', 'spectre-plan_review', 'spectre-prototype', 'spectre-prove', 'spectre-prune',
  'spectre-rebase', 'spectre-research', 'spectre-scope', 'spectre-ship', 'spectre-sweep',
  'spectre-task_review', 'spectre-tdd', 'spectre-test', 'spectre-ux', 'spectre-validate',
];
const INTERNAL_HANDOFF_SKILLS = [
  'spectre-feature-root', 'spectre-fix-core', 'spectre-plan-route',
];

function handoffSection(source) {
  return source.match(/^## Handoff\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || '';
}

function markdownFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(root, filePath));
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.relative(root, filePath));
  }
  return files.sort();
}

function createFixture(root) {
  const canonicalRoot = path.join(root, 'plugins', 'spectre');
  const codexRoot = path.join(root, 'plugins', 'spectre-codex');
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@codename_inc/spectre',
      version: '6.0.0',
      description: 'Fixture Spectre package.',
      homepage: 'https://github.com/joenandez/spectre#readme',
      repository: {
        type: 'git',
        url: 'git+https://github.com/joenandez/spectre.git',
      },
      license: 'MIT',
      keywords: ['workflow'],
    }, null, 2),
  );

  writeFile(
    path.join(canonicalRoot, 'agents', 'dev.md'),
    `---
name: dev
description: Implementation specialist.
model: claude-sonnet-5
---

Write code carefully.
`,
  );
  writeFile(
    path.join(canonicalRoot, 'agents', 'tester.md'),
    `---
name: tester
description: Test specialist.
model: claude-sonnet-5
---

Write tests carefully.
`,
  );

  writeFile(
    path.join(canonicalRoot, 'skills', 'spectre-plan', 'SKILL.md'),
    `---
name: spectre-plan
description: "\\ud83d\\udc7b | Create implementation plans after /spectre:spectre-scope."
---

Read .claude/skills/example/SKILL.md, then invoke /spectre:spectre-create_tasks.
Load @skill-spectre:spectre-tdd and dispatch @spectre:tester plus @dev.
Record lifecycle markers with spectre-workflow task start.
`,
  );

  writeFile(
    path.join(canonicalRoot, 'hooks', 'scripts', 'register_learning.mjs'),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({}) + '\\n');
`,
  );

  return { canonicalRoot, codexRoot };
}

test('agent translator emits the expected Codex TOML shape', () => {
  const source = `---
name: finder
description: Locate files.
model: claude-haiku-4-5-20251001
---

Find relevant files.
`;

  const toml = agents.buildAgentToml(source, 'finder.md');
  const fields = agents.parseToml(toml);

  assert.deepEqual(Object.keys(fields), [
    'name',
    'description',
    'model',
    'model_reasoning_effort',
    'sandbox_mode',
    'developer_instructions',
  ]);
  assert.equal(fields.name, 'spectre_finder');
  assert.equal(fields.description, 'Locate files.');
  assert.equal(fields.model, 'gpt-5.6-terra');
  assert.equal(fields.model_reasoning_effort, 'xhigh');
  assert.equal(fields.sandbox_mode, 'read-only');
  assert.equal(fields.developer_instructions, 'Find relevant files.');
});

test('agent translator replaces Luna with Terra while preserving the Sol reviewer tier', () => {
  const cases = [
    ['claude-sonnet-5', 'gpt-5.6-terra', 'high'],
    ['claude-opus-5', 'gpt-5.6-sol', 'xhigh'],
    ['claude-haiku-4-5-20251001', 'gpt-5.6-terra', 'xhigh'],
  ];

  for (const [claudeModel, codexModel, effort] of cases) {
    const source = `---
name: reviewer
description: Review changes.
model: ${claudeModel}
---

Review carefully.
`;
    const fields = agents.parseToml(agents.buildAgentToml(source, 'reviewer.md'));
    assert.equal(fields.model, codexModel);
    assert.equal(fields.model_reasoning_effort, effort);
  }
});

test('sync generates agents, rewrites skills, and rewrites hook roots', () => {
  const root = tempRoot();
  try {
    const { canonicalRoot, codexRoot } = createFixture(root);
    const result = runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true });

    assert.equal(result.ok, true);

    const agentFields = agents.parseToml(
      fs.readFileSync(path.join(codexRoot, 'agents', 'spectre_dev.toml'), 'utf8'),
    );
    assert.equal(agentFields.name, 'spectre_dev');
    assert.equal(agentFields.model, 'gpt-5.6-terra');
    assert.equal(agentFields.model_reasoning_effort, 'high');
    assert.equal(agentFields.sandbox_mode, 'workspace-write');

    const skill = fs.readFileSync(
      path.join(codexRoot, 'skills', 'spectre-plan', 'SKILL.md'),
      'utf8',
    );
    const { frontmatter } = skills.parseFrontmatter(skill, 'spectre-plan/SKILL.md');
    assert.equal(frontmatter.description, '👻 | Create implementation plans after $spectre:spectre-scope.');
    assert.match(skill, /^description: "👻 \| Create implementation plans after \$spectre:spectre-scope\."/m);
    assert.doesNotMatch(skill, /\\ud83d/);
    assert.match(skill, /\.agents\/skills\/example\/SKILL\.md/);
    assert.match(skill, /invoke \$spectre:spectre-create_tasks\./);
    assert.match(skill, /Skill\(spectre-tdd\)/);
    assert.match(skill, /@spectre_tester/);
    assert.match(skill, /@spectre_dev/);
    assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/hooks\/scripts\/workflow-cli\.mjs" task start/);
    assert.doesNotMatch(skill, /\bspectre-workflow\b/);
    assert.doesNotMatch(skill, /Codex Agent Preflight|ensure-codex-agents\.mjs|start a new Codex session before dispatching/);
    assert.doesNotMatch(skill, /\.claude\/skills\//);
    assert.doesNotMatch(skill, /\/spectre:spectre-create_tasks/);
    assert.doesNotMatch(skill, /@skill-spectre:/);
    assert.doesNotMatch(skill, /@spectre:/);
    assert.doesNotMatch(skill, /(?<![\w:-])@dev\b/);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(codexRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'spectre');
    assert.equal(manifest.version, '6.0.0');
    assert.equal('skills' in manifest, false);
    assert.equal('agents' in manifest, false);
    assert.deepEqual(manifest.interface.defaultPrompt, [
      'Use $spectre:spectre-scope to define a new feature, then continue through the Spectre workflow.',
    ]);

    assert.equal(
      fs.existsSync(path.join(codexRoot, 'hooks', 'scripts', 'register_learning.mjs')),
      true,
    );
    assert.equal(fs.existsSync(path.join(codexRoot, 'hooks', 'hooks.json')), false);
    const generatedText = Array.from(collectGeneratedText(codexRoot)).join('\n');
    assert.doesNotMatch(generatedText, /spectre knowledge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync emits an openai.yaml invocation-policy sidecar only for skills that disable model invocation', () => {
  const root = tempRoot();
  try {
    const { canonicalRoot, codexRoot } = createFixture(root);

    // Skill that opts out of model invocation -> Codex needs the policy sidecar.
    writeFile(
      path.join(canonicalRoot, 'skills', 'spectre-kickoff', 'SKILL.md'),
      `---
name: spectre-kickoff
description: "User-only kickoff workflow."
user-invocable: true
disable-model-invocation: true
---

Kickoff body.
`,
    );

    runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true });

    const sidecarPath = path.join(codexRoot, 'skills', 'spectre-kickoff', 'agents', 'openai.yaml');
    assert.equal(fs.existsSync(sidecarPath), true, 'expected sidecar for skill that disables model invocation');
    assert.match(
      fs.readFileSync(sidecarPath, 'utf8'),
      /policy:\s*\n\s*allow_implicit_invocation:\s*false/,
    );

    // Control: the fixture's spectre-plan skill has no flag -> must not get a sidecar.
    assert.equal(
      fs.existsSync(path.join(codexRoot, 'skills', 'spectre-plan', 'agents', 'openai.yaml')),
      false,
      'skill without disable-model-invocation must not get a sidecar',
    );

    // Removing the flag prunes the previously-emitted sidecar on re-sync.
    writeFile(
      path.join(canonicalRoot, 'skills', 'spectre-kickoff', 'SKILL.md'),
      `---
name: spectre-kickoff
description: "User-only kickoff workflow."
user-invocable: true
---

Kickoff body.
`,
    );
    runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true });
    assert.equal(fs.existsSync(sidecarPath), false, 'sidecar must be pruned when the flag is removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function* collectGeneratedText(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* collectGeneratedText(fullPath);
    } else if (entry.isFile()) {
      yield fs.readFileSync(fullPath, 'utf8');
    }
  }
}

test('hooks translator rewrites legacy command extensions to Codex mjs paths', () => {
  assert.equal(
    hooks.rewriteHookCommand('node ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/register_learning.cjs'),
    'node ${PLUGIN_ROOT}/hooks/scripts/register_learning.mjs',
  );
});

test('hooks translator recursively copies runtime modules and rewrites Codex host arguments', () => {
  const root = tempRoot();
  try {
    const { canonicalRoot, codexRoot } = createFixture(root);
    writeFile(
      path.join(canonicalRoot, 'hooks', 'scripts', 'knowledge', 'records.mjs'),
      'export const schemaVersion = 1;\n',
    );
    writeFile(
      path.join(canonicalRoot, 'hooks', 'hooks.json'),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'node ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-knowledge.mjs --host claude',
                },
              ],
            },
          ],
        },
      }, null, 2)}\n`,
    );
    writeFile(
      path.join(canonicalRoot, 'hooks', 'scripts', 'load-knowledge.mjs'),
      'const command = `spectre knowledge search "${id}"`; process.stdout.write(command);\n',
    );
    const canonicalCli = path.join(canonicalRoot, 'hooks', 'scripts', 'knowledge-cli.mjs');
    writeFile(canonicalCli, '#!/usr/bin/env node\n');
    fs.chmodSync(canonicalCli, 0o755);
    writeFile(
      path.join(codexRoot, 'hooks', 'scripts', 'user-prompt-submit.mjs'),
      'stale prompt runtime\n',
    );

    const result = runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true });
    assert.equal(result.ok, true);
    const generatedRecordPath = path.join(
      codexRoot,
      'hooks',
      'scripts',
      'knowledge',
      'records.mjs',
    );
    assert.equal(fs.existsSync(generatedRecordPath), true);
    assert.equal(
      fs.readFileSync(generatedRecordPath, 'utf8'),
      'export const schemaVersion = 1;\n',
    );
    const generatedHooks = JSON.parse(
      fs.readFileSync(path.join(codexRoot, 'hooks', 'hooks.json'), 'utf8'),
    );
    assert.equal(
      generatedHooks.hooks.SessionStart[0].hooks[0].command,
      'node ${PLUGIN_ROOT}/hooks/scripts/load-knowledge.mjs --host codex',
    );
    assert.match(
      fs.readFileSync(path.join(codexRoot, 'hooks', 'scripts', 'load-knowledge.mjs'), 'utf8'),
      /knowledge-cli\.mjs" search/,
    );
    assert.notEqual(
      fs.statSync(path.join(codexRoot, 'hooks', 'scripts', 'knowledge-cli.mjs')).mode & 0o111,
      0,
    );
    assert.equal(
      fs.existsSync(path.join(codexRoot, 'hooks', 'scripts', 'user-prompt-submit.mjs')),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hooks translator excludes nested tests and removes stale nested runtime files', () => {
  const root = tempRoot();
  try {
    const { canonicalRoot, codexRoot } = createFixture(root);
    writeFile(
      path.join(canonicalRoot, 'hooks', 'scripts', 'knowledge', 'store.mjs'),
      'export const store = true;\n',
    );
    writeFile(
      path.join(canonicalRoot, 'hooks', 'scripts', 'knowledge', 'test_store.mjs'),
      'throw new Error("must not ship");\n',
    );
    writeFile(
      path.join(codexRoot, 'hooks', 'scripts', 'knowledge', 'stale.mjs'),
      'stale\n',
    );

    const result = runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true });
    assert.equal(result.ok, true);
    assert.equal(
      fs.existsSync(path.join(codexRoot, 'hooks', 'scripts', 'knowledge', 'store.mjs')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(codexRoot, 'hooks', 'scripts', 'knowledge', 'test_store.mjs')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(codexRoot, 'hooks', 'scripts', 'knowledge', 'stale.mjs')),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('check mode detects drift and passes after regeneration', () => {
  const root = tempRoot();
  try {
    const { canonicalRoot, codexRoot } = createFixture(root);
    assert.equal(runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true }).ok, true);
    assert.equal(
      runSync({ repoRoot: root, canonicalRoot, codexRoot, check: true, quiet: true }).ok,
      true,
    );

    fs.appendFileSync(path.join(codexRoot, 'skills', 'spectre-plan', 'SKILL.md'), '\nstale\n');
    const drift = runSync({ repoRoot: root, canonicalRoot, codexRoot, check: true, quiet: true });
    assert.equal(drift.ok, false);
    assert.match(drift.errors.join('\n'), /changed: plugins\/spectre-codex\/skills\/spectre-plan\/SKILL\.md/);

    assert.equal(runSync({ repoRoot: root, canonicalRoot, codexRoot, quiet: true }).ok, true);
    assert.equal(
      runSync({ repoRoot: root, canonicalRoot, codexRoot, check: true, quiet: true }).ok,
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readExecuteContract = (repoRoot, rootName) => {
  const skillRoot = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-execute');
  const referencesRoot = path.join(skillRoot, 'references');
  const references = fs.existsSync(referencesRoot)
    ? fs.readdirSync(referencesRoot)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => fs.readFileSync(path.join(referencesRoot, name), 'utf8'))
    : [];
  return [fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'), ...references].join('\n');
};

test('spectre-execute preserves affected verification, risk-triggered review routing, and finalization gates', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const contract = readExecuteContract(repoRoot, rootName);
    assert.match(contract, /primary independently runs affected lint\/typecheck\/build/);
    assert.match(contract, /Never run a repository baseline\/root suite/);
    assert.match(contract, /Every source-owned workstream, including single\/sequential work, goes to `@spectre(?::|_)dev`/);
    assert.match(contract, /primary only orchestrates, verifies, accepts, and records state; it never implements planned work/i);
    assert.match(contract, /no primary-authored planned work/i);
    assert.match(contract, /`@spectre(?::|_)dev` owns repairs/);
    assert.match(contract, /adds no behavior, acceptance criterion, dependency, or workstream/);
    assert.match(contract, /planned work always has a worker actor/);
    assert.doesNotMatch(contract, /primary may implement/i);
    assert.doesNotMatch(contract, /Primary-direct work/i);
    assert.match(contract, /`branch-caused`:[\s\S]*`unrelated`:[\s\S]*`indeterminate`:/);
    assert.match(contract, /failed repair leaves third-party cause unclear/i);
    assert.match(
      contract,
      /@spectre(?::|_)web(?:-|_)research[^\n]*pinned docs\/code\/issues[^\n]*analogs[^\n]*hypothesis \+ RED before mutation/,
    );
    assert.match(contract, /Route intermediate review by compounding risk/);
    assert.match(contract, /phase may be reviewed only after all source-owned tasks\/workstreams[\s\S]*`done\|skipped`/);
    assert.match(contract, /completion alone is not a trigger/);
    assert.match(contract, /independently implemented batches converg(?:e|ing) on a shared contract\/consumer/);
    assert.match(contract, /downstream dependency on a changed interface\/state whose defect would compound/);
    assert.match(contract, /auth\/trust, persistence\/migration, concurrency\/order\/retry/);
    assert.match(contract, /concrete wiring\/correctness risk[\s\S]*E2E `Gap\|Adaptation`/);
    assert.match(contract, /Subagent\/wave\/phase completion, agent count, and diff size alone are not triggers/);
    assert.match(contract, /trigger at final completion belongs to `Skill\(spectre-code_review\)`/);
    assert.match(contract, /never run both reviews over the final surface/i);
    assert.match(contract, /Each triggered intermediate or final review runs once/);
    assert.match(contract, /one consolidated root-cause repair pass/);
    assert.match(contract, /Never dispatch a reviewer solely to validate a repair/);
    assert.match(contract, /later risk-triggered intermediate or final review may independently rediscover the issue/);
    assert.match(contract, /there is no global lifetime cap across distinct scheduled reviews/);
    assert.match(contract, /Run only stale or uncovered checks/);
    assert.match(contract, /local workflow store is the sole lifecycle\/progress authority/i);
    assert.match(contract, /Never mutate source task\/plan artifacts for lifecycle state/i);
    assert.match(contract, /run status --run-id/);
    assert.match(contract, /redo-or-verify/i);
    assert.match(contract, /INVALID_TASK_TRANSITION/);
    assert.match(contract, /Never run a repository baseline\/root suite, full app harness, benchmark, or broad qualification here/);
    assert.match(contract, /one run per hash/);
    assert.match(contract, /never create a phase\/wave review file/i);
    assert.match(contract, /`IMPLEMENTATION_READY` \+ `ACCEPTANCE_PENDING`/);
    assert.match(contract, /--review-profile final-only/);
    assert.match(contract, /valid only with `--orchestrated --finalization-owner parent`/);
    assert.match(contract, /requires the orchestrating caller to invoke `Skill\(spectre-code_review\)` exactly once/);
    assert.match(contract, /caller owns sequencing, never semantic review/);
    assert.match(contract, /record each verified completed phase as `final-only` without loading review routing or dispatching a reviewer/);
    assert.match(contract, /`FINAL_REVIEW_PENDING`/);
    assert.match(contract, /Skill\(spectre-code_review\)`[^\n]*exactly once, high effort/);
    assert.match(contract, /never (?:rerun or replace|dispatch a reviewer to validate the repair or rerun) the comprehensive review/i);
    assert.match(contract, /Proof is always the last acceptance gate/);
    assert.match(contract, /Non-PASS follows the repair policy/);
    assert.match(
      contract,
      /do not terminalize until aggregate `PASS` or every remainder is `NEEDS_AUTHORITY`/,
    );
    assert.match(contract, /Classify each non-PASS as `repairable\|needs-authority\|unrelated`/);
    assert.match(contract, /continue independent work and repeat plan-backed repair/);
    assert.match(
      contract,
      /Stop only at aggregate `PASS` or when every remainder is `NEEDS_AUTHORITY`/,
    );
    assert.doesNotMatch(contract, /one behavior-repair pass|persistent failure instead of looping/);
    assert.doesNotMatch(contract, /focused phase\/boundary review|reopened phases require fresh[\s\S]*phase review/);
    assert.doesNotMatch(contract, /one review per completed phase|send all newly completed phases/);
    assert.doesNotMatch(contract, /Skill\(spectre-create_test_guide\)|Skill\(spectre-validate\)/);
    assert.doesNotMatch(contract, /Dual clean-room review|dispatch two .*reviewer|risk checkpoint/);
    assert.doesNotMatch(contract, /at least 20 minutes/i);
  }
});

test('spectre-code_review is one final falsification-first review with launcher-only timing', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillDir = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-code_review');
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const prompt = fs.readFileSync(
      path.join(skillDir, 'references', 'adversarial-review.md'),
      'utf8',
    );

    assert.match(skill, /final adversarial review/);
    assert.match(skill, /final boundary to falsify correctness, safety, production readiness, and requirement delivery/);
    assert.match(skill, /Try to prove the work wrong, unsafe, unreachable, or unable to meet requirements/);
    assert.match(skill, /references\/adversarial-review\.md/);
    assert.match(skill, /send it verbatim to one fresh reviewer/i);
    assert.match(skill, /followed only by structured context/i);
    assert.match(skill, /primary does not paraphrase or augment the template/i);
    assert.match(prompt, /Try to prove the completed work wrong, unsafe, unreachable, or unable to meet the supplied requirements/);
    assert.match(prompt, /Actively seek counterexamples, broken invariants, failure paths, false-positive tests, unreachable outcomes/);
    assert.match(skill, /--effort high/);
    assert.match(skill, /20-minute launcher-side poll limit/);
    assert.match(skill, /do not pass duration guidance to the reviewer/i);
    assert.match(skill, /Quiet output is not failure/);
    assert.match(skill, /A usable review ends semantic review/);
    assert.doesNotMatch(`${skill}\n${prompt}`, /at least 20 minutes|--checkpoint|REVIEW_MODE = checkpoint/i);
    assert.match(prompt, /requirement reachability/i);
    assert.match(prompt, /finding_fingerprint\s*=\s*sha256/);
    assert.match(prompt, /invariant_family\s*=\s*sha256/);
    assert.match(prompt, /Requirement Delivery Coverage/);
    assert.match(prompt, /Requirement\/AC \| Status \| Consumer\/outcome evidence \| Gap\/Finding/);
    assert.match(prompt, /Scope and Dead-Path Audit/);
    assert.match(skill, /every requirement\/AC has one evidence-backed status/);
    assert.ok(
      repositoryTokenCount(
        repoRoot,
        `plugins/${rootName}/skills/spectre-code_review/SKILL.md`,
      ) <= 1500,
      `${rootName} code-review orchestration should remain compact`,
    );
    assert.ok(
      repositoryTokenCount(
        repoRoot,
        `plugins/${rootName}/skills/spectre-code_review/references/adversarial-review.md`,
      ) <= 1000,
      `${rootName} adversarial prompt should remain compact`,
    );
  }
});

const fixedWorkstreamCapPattern =
  /(?:\b(?:at most|up to|no more than|max(?:imum)?(?: of)?|limited to)\s+|<=\s*)(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+workstreams?\b/i;
test('plan-direct fixed-workstream guard rejects representative cap forms', () => {
  for (const forbiddenContract of [
    'Maximum of 4 workstreams may be dispatched.',
    'At most four workstreams may be dispatched.',
  ]) {
    assert.match(forbiddenContract, fixedWorkstreamCapPattern);
  }

  assert.doesNotMatch('No fixed workstream count is imposed.', fixedWorkstreamCapPattern);
});

test('execute resolves explicit plans through one authorized preparation path', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const execute = readExecuteContract(repoRoot, rootName).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const planDirect = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-execute', 'references', 'plan-direct.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const structuredMode = execute.indexOf('`structured`');
    const planDirectMode = execute.indexOf('`plan-direct`');

    assert.match(
      execute,
      /`structured`:[^\n]*execute index[^\n]*resolvable `tasks\.json`/i,
    );
    assert.match(execute, /`plan-direct`:[^\n]*explicit readable plan/i);
    assert.ok(structuredMode !== -1);
    assert.ok(planDirectMode > structuredMode);
    assert.match(execute, /No path:[^\n]*same-run source evidence first/i);
    assert.doesNotMatch(execute, /default `docs\/tasks\/\{branch\}/i);
    assert.match(execute, /explicit supplied plan wins over ambient task artifacts/i);
    assert.match(execute, /For any selected readable plan \(explicit or no-path-resolved\)/i);
    assert.doesNotMatch(execute, /For any explicit readable plan, resolve root/i);
    assert.match(execute, /`--preflight-plan <depth>` remains a preparation-depth hint/i);
    assert.match(execute, /depth hint must not create authority pause/i);
    assert.match(execute, /`Execution Mode: direct` is a legacy coordination hint/i);
    assert.match(
      execute,
      /Hash-bound observed size, never depth, decides Plan Review/i,
    );
    assert.match(execute, /XS\/S record `review:not-required:<size>` and skip/i);
    assert.match(execute, /M\+ reuse a closed correctness\+simplification chain only/i);
    assert.match(execute, /Review-worthy risk reclassifies M\+/i);
    assert.match(execute, /no hidden XS\/S exception/i);
    assert.match(execute, /No selected readable plan needs a completeness\/header ceremony/i);
    assert.doesNotMatch(execute, /explicit readable plan needs no ceremonial completeness\/header gate/i);
    assert.match(execute, /No path:[^\n]*use existing same-run source evidence first/i);
    assert.match(
      execute,
      /same-run source evidence first[^\n]*then a plan at the confirmed root[^\n]*then structured-only fallback/i,
    );
    assert.doesNotMatch(execute, /same-run source evidence first[^\n]*execute\.md[^\n]*then plan-direct/i);
    assert.doesNotMatch(execute, /never rewrite, approve, or route it through `spectre-create_tasks`/);
    assert.doesNotMatch(execute, /marked plan recording `Execution Mode: direct` is rejected before review/i);
    assert.doesNotMatch(planDirect, /hard-stop signal[\s\S]*recommend routing the plan through `spectre-create_tasks`/i);
    assert.match(planDirect, /risk-responsive investigation/i);
    assert.match(planDirect, /continue independent authorized work/i);
    assert.doesNotMatch(
      execute,
      /Required default artifact:[^\n]*If absent\s*→\s*stop,\s*route to `spectre-create_tasks`/i,
    );
  }
});

test('execute detects bug reports by source shape and loads only their preparation delta', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillsRoot = path.join(repoRoot, 'plugins', rootName, 'skills');
    const execute = fs.readFileSync(
      path.join(skillsRoot, 'spectre-execute', 'SKILL.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const fixSource = fs.readFileSync(
      path.join(skillsRoot, 'spectre-execute', 'references', 'fix-source.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const planDirect = fs.readFileSync(
      path.join(skillsRoot, 'spectre-execute', 'references', 'plan-direct.md'),
      'utf8',
    );
    const createTasks = fs.readFileSync(
      path.join(skillsRoot, 'spectre-create_tasks', 'SKILL.md'),
      'utf8',
    );

    assert.match(execute, /`fix-source`:[^\n]*bug-report path\/root or identifying content/i);
    assert.match(execute, /not `--origin`[^\n]*selects `fix`/i);
    assert.match(execute, /load `references\/fix-source\.md`, not Plan preparation/i);
    assert.match(execute, /`plan-direct`:[^\n]*explicit readable plan/i);

    assert.match(fixSource, /bug-report path\/root or content identifying `Bug`[^\n]*verification wins source resolution/i);
    assert.match(fixSource, /`PLAN_SOURCE` as `FIX_SOURCE`[^\n]*`FEATURE_ROOT` as `BUG_ROOT`/i);
    assert.match(fixSource, /Execute owns every other step/i);
    assert.match(fixSource, /Never invoke `spectre-plan_review`/i);
    assert.match(fixSource, /ATOMIC\/DIRECT[^\n]*existing coarse-map path/i);
    assert.match(fixSource, /STRUCTURED[^\n]*existing task-generation path/i);
    assert.match(fixSource, /without Plan Review evidence or Task Review/i);
    assert.match(fixSource, /Return `PREPARATION_READY`/i);
    assert.doesNotMatch(fixSource, /Skill\(spectre-(?:execute|create_tasks|code_review|prove)\)/);
    assert.ok(fixSource.split(/\s+/).length <= 100, `${rootName} fix-source delta should stay thin`);

    assert.match(createTasks, /plans require closed-review evidence/i);
    assert.match(createTasks, /Fix: `\{FEATURE_ROOT\}` = `BUG_ROOT`/i);
    assert.match(createTasks, /Fixes need no Plan Review/i);
  }
});

test('execute preflight reuses observed assessment and proportionally creates tasks', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const plan = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan', 'SKILL.md'),
      'utf8',
    );
    const route = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan-route', 'SKILL.md'),
      'utf8',
    );
    const planReview = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan_review', 'SKILL.md'),
      'utf8',
    );
    const createTasks = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-create_tasks', 'SKILL.md'),
      'utf8',
    );
    const execute = readExecuteContract(repoRoot, rootName).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const planDirect = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-execute', 'references', 'plan-direct.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const reviewIndex = execute.indexOf('Skill(spectre-plan_review) --auto-apply scope-safe --orchestrated');
    const assessmentIndex = execute.toLowerCase().indexOf('reuse applicable');
    const taskIndex = execute.indexOf('STRUCTURED invokes existing `Skill(spectre-create_tasks) --orchestrated`');
    const dispatchIndex = execute.indexOf('3. **Batch and dispatch.**');

    const handoff = rootName === 'spectre'
      ? /\/spectre:spectre-execute/
      : /\$spectre:spectre-execute/;
    assert.match(plan, handoff);
    assert.match(plan, /<repo-relative plan\.md> --origin plan --preflight-plan <xs\|light\|standard\|comprehensive>/);
    assert.match(plan, /XS → `Skill\(spectre-create_plan\) --depth light --no-review --execution structured`/);
    assert.match(plan, /XS → xs; S → light; M\/L → standard; XL → comprehensive/);
    assert.match(plan, /requested outcome.*material decisions.*Scope\/anti-scope boundaries.*credible risks.*verification intent/i);
    assert.match(plan, /Immediately before Execute[\s\S]*Trade-offs verbatim/i);
    assert.match(plan, /Execute accepts them[\s\S]*feedback revises the draft/i);
    assert.doesNotMatch(plan, /spectre-plan_review|spectre-create_tasks|spectre-task_review/);
    assert.match(plan, /observed record[\s\S]*task_context\.md[\s\S]*raw-byte hash[\s\S]*authority hash/i);
    assert.match(route, /Plan-or-Execute|Plan or Execute/i);
    assert.match(route, /Classify only/i);
    assert.match(route, /plan-routing\/v1/);
    assert.ok(reviewIndex >= 0);
    assert.ok(assessmentIndex >= 0);
    assert.ok(taskIndex > assessmentIndex);
    assert.ok(reviewIndex < dispatchIndex);
    assert.match(execute, /No-path selected plans receive this preparation before dispatch/i);
    assert.match(execute, /first selected readable-plan use\/resume[^\n]*read `references\/plan-direct\.md` for preparation state/i);
    assert.match(planDirect, /Use for selected-plan preparation\/resume\/reconciliation/i);
    assert.match(
      planDirect,
      /STRUCTURED outcomes use only source\/preparation bindings[^\n]*JSON task events remain governed by structured telemetry/i,
    );
    assert.match(planDirect, /Before task generation or implementation dispatch[^\n]*finalized assessment\/review bindings[^\n]*coarse map[^\n]*includes plan-origin STRUCTURED/i);
    assert.match(planDirect, /For Markdown event sources[^\n]*with `--source "\$PLAN_SOURCE"`/i);
    assert.match(execute, /reuse applicable/i);
    assert.match(execute, /reroute only if absent or material observations invalidate it/i);
    assert.match(execute, /scope-safe byte-only review edits[\s\S]*mechanically rebind/i);
    assert.match(execute, /topology\/uncertainty is unchanged/i);
    assert.doesNotMatch(execute, /Re-bind routing to finalized plan/i);
    assert.match(execute, /Missing assessment dispatches `Skill\(spectre-plan-route\)` to a fresh child agent/i);
    assert.match(execute, /consume child DONE inside the same Execute run before proceeding/i);
    assert.doesNotMatch(execute, /Return recordonly/i);
    assert.match(execute, /ATOMIC\/DIRECT use the bounded local workstream\/Active Wave pattern/i);
    assert.match(execute, /dispatch `Skill\(spectre-plan_review\) --auto-apply scope-safe --orchestrated` once to fresh child/i);
    assert.match(execute, /STRUCTURED invokes existing `Skill\(spectre-create_tasks\) --orchestrated` by fresh child-agent dispatch/i);
    assert.match(execute, /L → standard, XL → comprehensive/i);
    assert.match(execute, /No automatic task review/i);
    assert.match(execute, /Scope\/explicit-design changes remain withheld/i);
    assert.match(planReview, /selected plan/i);
    assert.match(planReview, /exact selected plan path/i);
    assert.match(planReview, /authority sources/i);
    assert.match(execute, /finalized plan path\/hash[\s\S]*closed review evidence[\s\S]*Skill\(spectre-create_tasks\)/i);
    assert.match(createTasks, /plans require closed-review evidence/i);
    assert.match(createTasks, /Execution Mode: direct/);
    assert.doesNotMatch(createTasks, /authorized Execute caller/i);
    assert.match(planDirect, /selected\/final plan\+authority hashes/i);
    assert.match(planDirect, /refresh applicable byte-only bindings before run creation\/dispatch/i);
    assert.match(planDirect, /Plan Review state \(`not-required:<XS\|S>\|closed`\)/i);
    assert.match(planDirect, /Before task generation or implementation dispatch[^\n]*finalized assessment\/review bindings[^\n]*coarse map/i);
    assert.match(planDirect, /Before implementation dispatch[^\n]*resulting pair bindings[^\n]*resolved event source\/run identity[^\n]*bounded Active Wave/i);
    assert.match(planDirect, /assessment/i);
    assert.match(planDirect, /review paths\/hashes/i);
    assert.match(planDirect, /derived pair paths\/hashes/i);
    assert.match(execute, /telemetry[\s\S]*degraded[\s\S]*never blocks/i);
    assert.doesNotMatch(
      execute,
      /selected plan\/authority\/review\/pair binding[^\n]*(?:older|unrelated|unprovable)[^\n]*NEEDS_AUTHORITY/i,
    );
    assert.doesNotMatch(execute, /depth hint is invalid[^\n]*NEEDS_AUTHORITY/i);
    assert.match(execute, /Never escalate solely[^\n]*unavailable\/red baseline/i);
    assert.match(
      fs.readFileSync(path.join(repoRoot, 'Architecture.md'), 'utf8'),
      /Execute.*reuses applicable plan-routing records.*classifies once when absent/i,
    );
  }
});

test('plan-direct execute preserves source-plan authority without a completeness gate', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const execute = readExecuteContract(repoRoot, rootName).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');

    assert.match(execute, /The source plan is the sole requirements authority/);
    assert.doesNotMatch(execute, /must carry its seven spine sections/i);
    assert.doesNotMatch(execute, /Legacy unmarked plans start without a quality\/completeness gate/i);
    assert.doesNotMatch(execute, /legacy headers or missing headers waive/i);
    assert.match(execute, /Never rewrite it or durably copy its prose/i);
    assert.doesNotMatch(
      execute,
      /(?:in )?plan-direct mode,?\s+(?:requires?|runs?|routes?)[^\n]*(?:plan completeness|plan approval|plan review|task review)/i,
    );
  }
});

test('plan-direct execute creates compact local execution state before dispatch', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const requiredSections = [
    'Source Plan',
    'Runtime Status',
    'Workstream Map',
    'Active Wave',
    'Verification Ledger',
    'Plan-Backed Adaptations',
    'Final Quality State',
  ];

  for (const rootName of ['spectre', 'spectre-codex']) {
    const execute = readExecuteContract(repoRoot, rootName);

    assert.match(execute, /execution_state\.md/);
    assert.match(execute, /compact local\/gitignored resume state/i);
    for (const section of requiredSections) {
      assert.match(execute, new RegExp(section));
    }
    assert.match(execute, /Before task generation or implementation dispatch[^\n]*finalized assessment\/review bindings[^\n]*coarse map/i);
    assert.match(execute, /Before implementation dispatch[^\n]*resulting pair bindings[^\n]*resolved event source\/run identity[^\n]*bounded Active Wave/i);
    assert.match(execute, /update after dispatch, gate, review-routing, review, or adaptation/i);
    assert.match(execute, /one coarse row per plan-native/i);
    assert.match(execute, /Active Wave[^\n]*only currently dispatchable bounded assignments/i);
    assert.match(execute, /full-byte SHA-256/);
    assert.match(execute, /byte length/);
    assert.match(execute, /selected plan\/authority hashes/i);
    assert.match(execute, /finalized plan hash/i);
    assert.match(execute, /resolved event source\/run identity/i);
    assert.match(execute, /generated pair is reusable only when.*both artifact hashes.*finalized plan.*closed review chain/i);
    assert.match(execute, /Filename, feature-root coincidence, and `generated_at` alone are insufficient/i);
    assert.match(execute, /If binding is absent and cannot be established[\s\S]*preserve the pair[\s\S]*regenerate only necessary preparation/i);
    assert.match(execute, /For an existing direct run, preserve its Markdown event source and stable workstream IDs/i);
    assert.match(execute, /Existing JSON runs retain their source and accepted IDs/i);
    assert.match(execute, /Fresh structured selection persists its resolved JSON event source/i);
    assert.match(execute, /Before task generation or implementation dispatch[^\n]*finalized assessment\/review bindings[^\n]*coarse map[^\n]*includes plan-origin STRUCTURED/i);
    assert.match(execute, /JSON runs add derivative work only through source-required definition repair/i);
    assert.match(execute, /Do not mutate historical completion events or clear accepted state/i);
    assert.match(execute, /No raw output or report prose/);
    assert.doesNotMatch(execute, fixedWorkstreamCapPattern);
    assert.doesNotMatch(
      execute,
      /(?:in )?plan-direct mode,?\s+(?:creates?|generates?|requires?)[^\n]*(?:complete|exhaustive)[^\n]*(?:task graph|subtasks|acceptance criteria)/i,
    );
  }
});

test('autonomous plan execution instruction envelope stays token-neutral', () => {
  // Structured-handoff tokens are reallocated inside the fixed 28-skill aggregate ceiling below.
  const repoRoot = path.resolve(__dirname, '..');
  const files = [
    'spectre-execute/SKILL.md',
    'spectre-execute/references/plan-direct.md',
    'spectre-execute/references/telemetry.md',
    'spectre-execute/references/repair-policy.md',
    'spectre-execute/references/review-routing.md',
    'spectre-plan/SKILL.md',
    'spectre-plan-route/SKILL.md',
    'spectre-plan_review/SKILL.md',
    'spectre-create_tasks/SKILL.md',
  ];
  const totals = {
    spectre: files.reduce(
      (sum, file) => sum + repositoryTokenCount(repoRoot, `plugins/spectre/skills/${file}`),
      0,
    ),
    'spectre-codex': files.reduce(
      (sum, file) => sum + repositoryTokenCount(repoRoot, `plugins/spectre-codex/skills/${file}`),
      0,
    ),
  };

  assert.ok(totals.spectre <= 12_651, `canonical envelope exceeded: ${totals.spectre} > 12,651`);
  assert.ok(
    totals['spectre-codex'] <= 12_747,
    `Codex envelope exceeded: ${totals['spectre-codex']} > 12,747`,
  );
});

test('plan-direct quality gates use the explicit plan and derivative execution evidence', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const readSkill = (skillName) => fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    const execute = readExecuteContract(repoRoot, rootName);
    const codeReview = readSkill('spectre-code_review');
    const validate = readSkill('spectre-validate');
    const proof = readSkill('spectre-prove');

    assert.match(execute, /transient verbatim plan text only for active workstreams/i);
    assert.match(
      execute,
      /plan-direct passes `PLAN_SOURCE` plus relevant `EXECUTION_STATE` evidence/i,
    );
    assert.match(codeReview, /explicit(?:ly passed)? source-plan path/i);
    assert.match(
      codeReview,
      /explicit(?:ly passed)? source-plan path[^\n]*(?:ahead of|before)[^\n]*`plan\.md`/i,
    );
    assert.match(validate, /explicit arbitrary plan as a requirement source/i);
    assert.match(validate, /plan as authoritative when passed/i);
    assert.match(proof, /explicitly passed source plan[^\n]*acceptance source/i);
    assert.match(execute, /never create one merely to satisfy a gate/i);
    assert.doesNotMatch(execute, /Skill\(spectre-create_test_guide\)/);
  }
});

test('plan-direct goal composition lets execute own proof closure from durable state', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const goal = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-goal', 'SKILL.md'),
      'utf8',
    );
    const executeIndex = goal.indexOf('Skill(spectre-execute)');

    assert.match(goal, /source plan plus (?:its )?`execution_state\.md`/i);
    assert.match(goal, /plan-direct mode from `execution_state\.md`/i);
    assert.match(
      goal,
      /authority persists beyond the first step[^\n]*plan-direct mode passes the source-plan path/i,
    );
    assert.match(goal, /every continuation\/resume invokes\/reloads `Skill\(spectre-execute\)` before implementation/i);
    assert.match(goal, /execute owns single-pass proof invocation plus repair\/reinvoke closure/i);
    assert.match(goal, /only readable plan\/runtime inputs/i);
    assert.ok(executeIndex !== -1);
    assert.doesNotMatch(goal, /Skill\(spectre-prove\)/);
    assert.doesNotMatch(
      goal,
      /(?:in )?plan-direct mode,?\s+(?:requires?|validates?)[^\n]*(?:complete|approved|reviewed)[^\n]*plan/i,
    );
  }
});

test('prove contract is one reviewed evidence pass that owns its proof path', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    assert.equal(fs.existsSync(path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-proof',
    )), false);
    const skillPath = path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-prove',
      'SKILL.md',
    );
    const skill = fs.readFileSync(skillPath, 'utf8');

    assert.match(skill, /name: "spectre-prove"/);
    assert.match(skill, /# prove/);
    assert.match(skill, /PASS`, `PARTIAL`, `DIAGNOSTIC_ONLY`, or `FAIL/);
    assert.match(skill, /including fail-closed outcomes/);
    assert.match(skill, /capture, inspect, and embed/);
    assert.match(skill, /Pixels overrule assertions/);
    assert.match(skill, /Each invocation is exactly one proof pass/);
    assert.match(skill, /Repair the proof path, never the verdict/);
    assert.match(skill, /fix broken or misconfigured proof tooling/i);
    assert.match(skill, /never terminal and never the sole basis for `PARTIAL`/);
    assert.match(skill, /Never modify product code to influence an outcome/);
    assert.match(skill, /harness changes/);
    assert.doesNotMatch(skill, /never installs, writes, or repairs it/);
    assert.doesNotMatch(skill, /Never modify product\/proof infrastructure/);
    assert.match(skill, /PROOF_RESULT/);
    assert.match(skill, /--profile focused/);
    assert.match(skill, /PROOF_TOOLING_UNAVAILABLE/);
    assert.match(skill, /focused profile records affected rows `PARTIAL`/);
    assert.match(skill, /without research or a user gate/);
    assert.match(skill, /DONE means the pass completed, regardless of status/);
    assert.match(skill, /proof status alone never gates `(?:\/|\$)spectre:spectre-ship`/);
    assert.doesNotMatch(skill, /Skill\(spectre-tdd\)/);
    assert.doesNotMatch(skill, /@spectre(?::|_)dev/);
    assert.doesNotMatch(skill, /BASE_SHA.*HEAD_SHA.*DIFF_SHA256/);
    assert.doesNotMatch(skill, /PR_CANDIDATE_STALE|CANDIDATE_CHANGED/);
    assert.match(skill, /proof\/proof\.json/);
    assert.match(skill, /proof\/proof\.html/);
    assert.match(skill, /proof\/proof\.html` - \*\*required\*\*/i);
    assert.match(skill, /For visual work \(including TUI\), load `references\/proof-html\.md`/);
    assert.match(skill, /embed in `proof\.html` actual screenshots and video/);
    assert.match(skill, /paths, links, hashes, manifests, and prose are provenance only/);
    assert.match(skill, /required displayed media/);
    assert.match(skill, /proof embeds review renditions/);
    assert.match(skill, /HTML satisfies the proof-HTML contract/);
    assert.match(skill, /one run per candidate key/);
    assert.match(skill, /Never embed raw harness output or accumulating run history/);
    assert.doesNotMatch(skill, /subspace-app-harness/i);

    const proofHtml = fs.readFileSync(path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-prove',
      'references',
      'proof-html.md',
    ), 'utf8');
    assert.match(proofHtml, /<img>/);
    assert.match(proofHtml, /<video controls>/);
    assert.match(proofHtml, /textual paths, links, manifests, hashes, thumbnails, or unavailable sources do not qualify/i);
    assert.match(proofHtml, /PROOF_MEDIA_NOT_PRESENTED/);
    assert.match(proofHtml, /validate-proof-html\.mjs/);
  }
});

test('goal prompts preserve execute-owned proof closure', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const goalPath = path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-goal',
      'SKILL.md',
    );
    const goal = fs.readFileSync(goalPath, 'utf8');
    const executeIndex = goal.indexOf('Skill(spectre-execute)');
    const promptTemplate = goal.match(/```markdown\n([\s\S]*?)\n```/)?.[1] || '';
    const requiredSections = [
      '## Outcome',
      '## Verification',
      '## Constraints (must not)',
      '## Scope',
      '## Iteration',
      '## Stop',
    ];

    assert.match(goal, /goal-prompts\.md/);
    assert.match(goal, /contains exactly one copy-ready goal prompt/);
    assert.match(goal, /no title, preamble, manifest, selection note, rationale, or compact alternative/i);
    assert.ok(promptTemplate.startsWith('/goal '));
    for (const section of requiredSections) {
      assert.match(promptTemplate, new RegExp(`\\n\\n${section.replace(/[()]/g, '\\$&')}\\n\\n`));
    }
    for (let i = 1; i < requiredSections.length; i += 1) {
      assert.ok(promptTemplate.indexOf(requiredSections[i]) > promptTemplate.indexOf(requiredSections[i - 1]));
    }
    assert.ok(executeIndex !== -1);
    assert.match(
      promptTemplate,
      /^\/goal [^\n]*Persistent execution authority:[^\n]*before implementation on initial entry and every continuation\/resume[^\n]*including after compaction[^\n]*YOU MUST invoke\/reload Skill\(spectre-execute\)[^\n]*--orchestrated[^\n]*follow it through DONE/i,
    );
    assert.match(goal, /authority persists beyond the first step/i);
    assert.match(goal, /every continuation\/resume invokes\/reloads `Skill\(spectre-execute\)` before implementation/i);
    assert.match(promptTemplate, /Do not implement directly or substitute another workflow\./);
    assert.doesNotMatch(goal, /Skill\(spectre-prove\)/);
    assert.match(goal, /aggregate proof `PASS`/);
    assert.match(promptTemplate, /through DONE, including aggregate proof PASS/);
    assert.match(goal, /transcript/i);
    assert.doesNotMatch(goal, /Portable strict|Structured prompt|Compact prompt/);
    assert.match(goal, /cap or visible 40-turn default is a durable checkpoint/);
    assert.match(goal, /resume when the platform permits/);
    assert.doesNotMatch(goal, /stop at the explicit cap/);
    assert.doesNotMatch(goal, /execute-only/i);
  }
});

test('planning hands off directly to execute without goal-prompt generation', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skills = path.join(repoRoot, 'plugins', rootName, 'skills');
    const readSkill = (name) => fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    const plan = readSkill('spectre-plan');
    const execute = readSkill('spectre-execute');
    const goal = readSkill('spectre-goal');
    const createTasks = readSkill('spectre-create_tasks');
    const taskReview = readSkill('spectre-task_review');

    assert.doesNotMatch(plan, /spectre-goal/);
    assert.doesNotMatch(plan, /goal-prompts\.md/);
    assert.match(plan, /Never generate a goal prompt/i);
    assert.match(plan, /exactly one copy-ready fenced command/);
    assert.match(
      plan,
      rootName === 'spectre'
        ? /\/spectre:spectre-execute <repo-relative plan\.md> --origin plan/
        : /\$spectre:spectre-execute <repo-relative plan\.md> --origin plan/,
    );
    assert.match(plan, /--preflight-plan <xs\|light\|standard\|comprehensive>/);
    assert.match(plan, /Never pass `--orchestrated`/);

    assert.match(
      execute,
      /Persistent execution authority[^\n]*every continuation\/resume, including after compaction[^\n]*reload this contract/i,
    );
    assert.match(execute, /never implement from memory or substitute another workflow/i);

    assert.match(goal, /disable-model-invocation: true/);
    assert.match(goal, /explicit utility outside the default Plan → Execute route/i);
    assert.match(goal, /`spectre-plan` never invokes it/i);
    assert.doesNotMatch(createTasks, /spectre-goal|goal-prompts/i);
    assert.doesNotMatch(taskReview, /spectre-goal|goal-prompts/i);
  }
});

test('Plan and Execute emit one non-authoritative calibration lifecycle', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const normalize = (value) => value
    .replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-')
    .replace(/node "\$\{PLUGIN_ROOT\}\/hooks\/scripts\/workflow-cli\.mjs"/g, 'spectre-workflow');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const plan = normalize(fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan', 'SKILL.md'),
      'utf8',
    ));
    const execute = normalize(readExecuteContract(repoRoot, rootName));
    const executeTelemetry = normalize(fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-execute', 'references', 'telemetry.md'),
      'utf8',
    ));

    const initialRoute = plan.indexOf('Skill(spectre-plan-route)` in `initial` mode');
    const planStart = plan.indexOf('spectre-workflow plan start');
    const observedRoute = plan.indexOf('Skill(spectre-plan-route)` in `observed` mode');
    const reclassified = plan.indexOf('plan.reclassified');
    assert.ok(initialRoute !== -1 && planStart > initialRoute);
    assert.ok(observedRoute > planStart && reclassified > observedRoute);
    for (const eventType of [
      'plan.started',
      'plan.reclassified',
      'plan.completed',
    ]) assert.match(plan, new RegExp(eventType.replace('.', '\\.')));
    assert.match(plan, /probe flags|probe_used/);
    assert.doesNotMatch(plan, /plan\.review_completed/);
    assert.match(plan, /artifact hashes|artifact_hashes/);
    assert.match(plan, /planning elapsed|planning_elapsed_ms/);
    assert.match(plan, /telemetry failure[^\n]*(?:continue|never blocks|degraded)/i);

    assert.match(execute, /plan\.execution_outcome/);
    assert.match(executeTelemetry, /spectre-workflow plan match/);
    assert.doesNotMatch(executeTelemetry, /read `\.spectre\/telemetry\/plan-classification\.jsonl` directly/);
    assert.match(executeTelemetry, /matching `plan\.completed` event[^\n]*feature root[^\n]*(?:artifact|source) hash/i);
    assert.match(executeTelemetry, /only after authoritative execution status/i);
    assert.match(executeTelemetry, /workstream[^\n]*task[^\n]*wave count/i);
    assert.match(executeTelemetry, /proof[^\n]*review result/i);
    assert.match(executeTelemetry, /planning-surprise codes/i);
    assert.match(executeTelemetry, /verification, review, proof, and completion authority remain unchanged/i);
    assert.match(executeTelemetry, /telemetry failure[^\n]*degraded[^\n]*never blocks/i);
  }
});

test('Plan router keeps one-owner skill orchestration direct after a locator probe', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const fixtureRoot = path.join(
    repoRoot,
    'test',
    'fixtures',
    'plan-router',
    'owner-skill-orchestration',
  );
  const scope = fs.readFileSync(path.join(fixtureRoot, 'scope.md'), 'utf8');
  const observations = fs.readFileSync(path.join(fixtureRoot, 'observations.md'), 'utf8');
  const oracle = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'oracle.json'), 'utf8'));
  const modelVisibleFixture = `${scope}\n${observations}`;

  assert.doesNotMatch(
    modelVisibleFixture,
    /\b(?:XS_DIRECT|S_DIRECT|M_REVIEWED_DIRECT|L_STRUCTURED|XL_REVIEWED_STRUCTURED)\b/,
  );
  assert.deepEqual(
    {
      shape: oracle.shape,
      uncertainty: oracle.uncertainty,
      evidence: oracle.evidence,
      task_graph_risk: oracle.task_graph_risk,
      design_authority_required: oracle.design_authority_required,
      size: oracle.size,
      route: oracle.route,
      probe_count: oracle.probe_count,
    },
    {
      shape: 'DIRECT',
      uncertainty: 'LOW',
      evidence: 'PROBED',
      task_graph_risk: 'LOW',
      design_authority_required: false,
      size: 'S',
      route: 'S_DIRECT',
      probe_count: 1,
    },
  );

  for (const rootName of ['spectre', 'spectre-codex']) {
    const route = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan-route', 'SKILL.md'),
      'utf8',
    );
    assert.match(route, /STRUCTURED requires multiple independently implementable workstreams/i);
    assert.match(route, /dependencies.*workflow\/acceptance steps.*pilots are not workstreams/i);
    assert.match(route, /HIGH graph risk requires a credible implementation ordering\/coordination\/rollback failure/i);
    assert.match(route, /workflow gates\/state transitions do not qualify/i);
    assert.match(route, /Honor confirmed Scope assumptions/i);
    assert.match(route, /Missing paths\/evidence permit at most the one probe/i);
    assert.match(route, /only unresolved, approach-changing uncertainty affects size/i);
    assert.match(route, /size and routine placement never create it/i);
    assert.match(route, /Never use.*dependency count.*size authority/i);
  }
});

test('Plan delegates one semantic XS-S-M-L-XL classifier and keeps orchestration authority', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const planPath = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan', 'SKILL.md');
    const routePath = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan-route', 'SKILL.md');
    assert.ok(fs.existsSync(routePath), `${rootName} must contain spectre-plan-route`);
    const plan = fs.readFileSync(planPath, 'utf8');
    const route = fs.readFileSync(routePath, 'utf8');
    const routeCalls = plan.match(/Skill\(spectre-plan-route\)/g) || [];

    assert.match(route, /user-invocable: false/);
    assert.match(route, /plan-routing\/v1/);
    assert.match(route, /shipped precedent/);
    assert.match(route, /Two shipped instances of a change-shape/i);
    assert.match(route, /its layers are not workstreams/i);
    assert.match(route, /when Scope mandates an abstraction.*whether it ships/i);
    assert.match(route, /classify the real delta/i);
    assert.match(route, /surface counts/);
    assert.match(route, /render variants of one surface/i);
    assert.match(route, /never let them create workstreams/i);
    for (const field of [
      'shape', 'uncertainty', 'evidence', 'protected_boundaries', 'task_graph_risk',
      'design_authority_required', 'size', 'route', 'rationale',
    ]) assert.match(route, new RegExp(`\\b${field}\\b`));
    for (const size of ['XS', 'S', 'M', 'L', 'XL']) assert.match(route, new RegExp(`\\b${size}\\b`));
    assert.match(route, /ATOMIC[^\n]*LOW[^\n]*XS/);
    assert.match(route, /ATOMIC[^\n]*LOW[^\n]*changed protected boundary[^\n]*OR[^\n]*DIRECT[^\n]*LOW[^\n]*S/);
    assert.match(route, /ATOMIC\/DIRECT[^\n]*MODERATE\/HIGH[^\n]*M/);
    assert.match(route, /STRUCTURED[^\n]*LOW\/MODERATE[^\n]*L/);
    assert.match(route, /STRUCTURED[^\n]*(?:HIGH uncertainty|HIGH task-graph risk)[^\n]*XL/);
    assert.match(route, /threatened_invariant/);
    assert.match(route, /failure_mode/);
    assert.match(route, /floors size at S/);
    assert.match(route, /never creates structure or HIGH graph risk/);
    assert.match(route, /exactly one bounded probe/);
    assert.match(route, /Honor confirmed Scope assumptions/i);
    assert.match(route, /KEEP\|RERUN_SMALLER\|RERUN_LARGER/);
    assert.match(route, /Never plan, write artifacts, emit telemetry, or present gates/i);

    assert.equal(routeCalls.length, 2);
    assert.doesNotMatch(plan, /ATOMIC[^\n]*LOW[^\n]*XS/);
    assert.doesNotMatch(plan, /≤1-file|≤5 files|Hard-stops:|automatic COMPREHENSIVE/i);
    assert.doesNotMatch(route, /≤1-file|≤5 files|Hard-stops:|automatic COMPREHENSIVE/i);
    assert.match(plan, /immutable canonical scope/i);
    assert.match(plan, /user's alignment signal/i);
    assert.match(plan, /--origin plan/);
    assert.match(plan, /aligned draft/i);
    assert.doesNotMatch(plan, /spectre-plan_review|spectre-create_tasks|spectre-task_review/);
    assert.doesNotMatch(plan, /goal-prompts\.md/);
    assert.doesNotMatch(plan, /Skill\(spectre-goal\)/);
    assert.match(plan, /Gather proportional evidence/i);
    assert.match(plan, /draft finalization/i);
    assert.match(plan, /never silently rerun/i);
    assert.match(plan, /plan\.completed/);
    assert.match(plan, /DONE when/i);

    assert.ok(repositoryTokenCount(repoRoot, planPath) < 2000);
    assert.ok(repositoryTokenCount(repoRoot, routePath) < 2000);
  }
});

test('Plan defers design authority to its aligned-draft handoff', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillRoot = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan');
    const plan = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const gatePath = path.join(skillRoot, 'references', 'high-level-design-gate.md');
    assert.ok(fs.existsSync(gatePath), `${rootName} must contain the high-level design gate`);
    const gate = fs.readFileSync(gatePath, 'utf8');

    assert.doesNotMatch(plan, /high-level-design-gate\.md/);
    assert.match(plan, /Scope remains the immutable user contract/i);
    assert.match(plan, /missing irreversible decision.*withhold the handoff/i);
    assert.match(plan, /Launch(?:ing)? that command is the user's alignment signal/i);

    assert.match(gate, /targeting 250–350 words with a hard maximum of 400 words/i);
    for (const section of [
      'Approach',
      'How it works',
      'Decisions for approval',
      'Boundaries',
      'Open questions',
    ]) assert.match(gate, new RegExp(`\\*\\*${section}\\*\\*`));
    assert.match(gate, /at most three material choices/i);
    assert.match(gate, /at most three unresolved user-owned questions/i);
    assert.match(gate, /Feedback is not approval/i);
    assert.match(gate, /re-present the complete revised proposal/i);
    assert.match(gate, /Only `Approved` or an unambiguous affirmative approval/i);
    assert.match(gate, /record the approved proposal verbatim[^\n]*`## Selected Design`/i);
    assert.match(
      gate,
      /High-level design proposed\. Reply `Approved` to continue to detailed planning, or give design feedback\./,
    );
    assert.ok(repositoryTokenCount(repoRoot, gatePath) < 500);
  }
});

test('public guidance and compatibility preserve one adaptive XS-S-M-L-XL route', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const legacyPairs = [
    ['MICRO', 'XS'],
    ['LIGHT', 'S'],
    ['STANDARD-DIRECT', 'M'],
    ['STANDARD', 'L'],
    ['COMPREHENSIVE', 'XL'],
  ];

  assert.match(readme, /All feature work enters through Scope[^\n]*adaptive Plan/i);
  assert.match(readme, /bugs?[^\n]*spectre:spectre-fix/i);
  assert.match(readme, /XS[^\n]*S[^\n]*M[^\n]*L[^\n]*XL/);
  assert.match(readme, /durable[^\n]*artifact/i);
  assert.match(readme, /Wait for your explicit approval before any code changes/i);
  assert.doesNotMatch(readme, /unless the feature is a one line ask/i);
  assert.doesNotMatch(readme, /Tiny or Small[^\n]*prefer[^\n]*(?:Claude Code|Codex)[^\n]*plan mode/i);
  assert.doesNotMatch(readme, /for small, unambiguous features[^\n]*spectre:spectre-delegate/i);
  assert.doesNotMatch(readme, /for COMPREHENSIVE plans/i);

  for (const rootName of ['spectre', 'spectre-codex']) {
    const root = path.join(repoRoot, 'plugins', rootName);
    const routePath = path.join(root, 'skills', 'spectre-plan-route', 'SKILL.md');
    const route = fs.readFileSync(routePath, 'utf8');
    const decisionTable = route.match(/\| Semantic result \| Size · route \|[\s\S]*?(?=\n\n- )/)?.[0] || '';
    const telemetry = fs.readFileSync(
      path.join(root, 'hooks', 'scripts', 'workflow', 'plan-telemetry.mjs'),
      'utf8',
    );
    const goal = fs.readFileSync(
      path.join(root, 'skills', 'spectre-goal', 'SKILL.md'),
      'utf8',
    );

    assert.match(route, /Resume-only legacy size/i);
    for (const [legacy, canonical] of legacyPairs) {
      assert.match(route, new RegExp(legacy.replace('-', '\\-') + '→' + canonical));
      assert.match(
        telemetry,
        new RegExp("\\['" + legacy.replace('-', '\\-') + "', '" + canonical + "'\\]"),
      );
    }
    assert.doesNotMatch(decisionTable, /MICRO|LIGHT|STANDARD-DIRECT|COMPREHENSIVE/);
    assert.doesNotMatch(telemetry, /ATOMIC\s*\+\s*LOW|STRUCTURED\s*\+\s*HIGH|Semantic result/);
    assert.match(goal, /XL also requires completed task review/i);
    assert.doesNotMatch(goal, /COMPREHENSIVE also requires completed task review/i);
    assert.ok(repositoryTokenCount(repoRoot, routePath) < 2000);
    assert.ok(repositoryTokenCount(
      repoRoot,
      path.join(root, 'skills', 'spectre-plan', 'SKILL.md'),
    ) < 2000);
  }
});

test('aligned Plan does not add a separate planning or implementation estimate gate', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillRoot = path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan');
    const plan = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const guidance = fs.readFileSync(
      path.join(skillRoot, 'references', 'estimation-guidance.md'),
      'utf8',
    );

    assert.doesNotMatch(plan, /Estimated remaining planning time|Estimated implementation time/);
    assert.doesNotMatch(plan, /Execution guidance/);
    assert.match(plan, /never delays or blocks the gate/);
    assert.doesNotMatch(plan, /Historical guidance/);
    assert.doesNotMatch(plan, /API-equivalent/);
    assert.doesNotMatch(guidance, /API-equivalent|processed tokens|Typical full .* expenditure/);
    assert.match(guidance, /high-level design gate/i);
    assert.match(guidance, /completed planning handoff presentation/i);
    assert.doesNotMatch(guidance, /final pre-code approval gate/i);
    assert.match(guidance, /L[\s\S]*STANDARD legacy analog/i);
    assert.match(guidance, /XL[\s\S]*COMPREHENSIVE legacy analog/i);
    assert.match(guidance, /XS, S, and M[\s\S]*no shipped seed analog/i);
    assert.doesNotMatch(guidance, /two STANDARD\/COMPREHENSIVE user gates/i);
    assert.doesNotMatch(guidance, /tier-compatible Plan estimate/i);

    const gate1 = guidance.match(
      /## Gate 1 — Remaining planning time([\s\S]*?)## Gate 2 — Implementation time estimate/,
    )?.[1] || '';
    assert.match(
      gate1,
      /\*\*Estimated remaining planning time: about \{rounded duration or range\}, based on completed plans of similar scope\.\*\*/,
    );
    assert.match(gate1, /excludes time waiting for the user's response/);
    assert.doesNotMatch(gate1, /Historical guidance|confidence|tokens|monetary|billing|unavailable/);

    const gate2 = guidance.match(
      /## Gate 2 — Implementation time estimate([\s\S]*?)## Shipped seed prior/,
    )?.[1] || '';
    assert.match(
      gate2,
      /\*\*Estimated implementation time: about \{rounded duration\}, based on completed projects of similar size\.\*\*/,
    );
    assert.doesNotMatch(gate2, /Execution guidance/);
    assert.doesNotMatch(gate2, /Nearest historical analog/);
    assert.doesNotMatch(gate2, /confidence|tokens|monetary|billing|unavailable/);
  }

  assert.ok(!fs.existsSync(
    path.join(repoRoot, '.agents', 'skills', 'spectre-workflow-analysis', 'SKILL.md'),
  ));
  assert.ok(!fs.existsSync(
    path.join(repoRoot, 'plugins', 'spectre', 'skills', 'spectre-workflow-analysis'),
  ));
  assert.ok(!fs.existsSync(
    path.join(repoRoot, 'plugins', 'spectre-codex', 'skills', 'spectre-workflow-analysis'),
  ));
});

test('Scope, UX, and prototype make Plan the canonical repository-change handoff', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const readSkill = (name) => fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', name, 'SKILL.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const scope = readSkill('spectre-scope');
    const ux = readSkill('spectre-ux');
    const prototype = readSkill('spectre-prototype');
    assert.match(scope, /confirmed repository-changing work[^\n]*spectre-plan/i);
    assert.doesNotMatch(scope, /well-understood non-UI work[^\n]*spectre-create_tasks/i);
    assert.match(ux, /confirmed repository-changing work[^\n]*spectre-plan/i);
    assert.doesNotMatch(ux, /spectre-create_tasks|spectre-tdd|genuinely MICRO/i);
    assert.match(prototype, /post-scope[^\n]*validated scope[^\n]*spectre-plan/i);
    assert.doesNotMatch(prototype, /post-scope[^\n]*spectre-create_tasks/i);
  }
});

test('create_plan and create_tasks preserve XS/direct routing contracts', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const createPlan = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-create_plan', 'SKILL.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const createTasks = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-create_tasks', 'SKILL.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const minimumSolution = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-plan', 'references', 'minimum-solution.md'),
      'utf8',
    );

    assert.match(createPlan, /--depth \{xs\|light\|standard\|comprehensive\}/);
    assert.match(createTasks, /--depth xs\|light\|standard\|comprehensive/);
    assert.match(createPlan, /Execution Mode: direct[^\n]*`--depth xs`/i);
    assert.match(createPlan, /one cohesive vertical slice/i);
    assert.match(createPlan, /direct-mode signals are executable/i);
    assert.match(createPlan, /Out-of-Bounds[^\n]*canonical OUT\/ANTI-SCOPE/i);
    assert.match(createPlan, /Every plan contains:/i);
    assert.match(createPlan, /## Routing Observations/);
    for (const field of [
      'workstream count',
      'independent workstreams',
      'dependency sequencing',
      'shared-contract consumers',
      'staged rollout/migration',
      'new abstraction',
      'unresolved material decision',
      'observed uncertainty',
    ]) assert.match(createPlan, new RegExp(field, 'i'));

    assert.match(createPlan, /observations only, never route selection/i);
    assert.match(createPlan, /Approved XS structured override[^\n]*spectre-create_tasks --depth xs/i);
    assert.match(createPlan, /Behavioral scope is binding; implementation means are not/i);
    assert.match(createPlan, /start with zero new owned concepts/i);
    assert.match(minimumSolution, /nothing new → reuse owner\/lifecycle\/state\/operation → extend one boundary and derive state/i);
    assert.match(createPlan, /Addition \| Requirement failing without it \| Repository evidence \| Why reuse\/derivation fails \| Verification/);
    assert.match(minimumSolution, /Future flexibility, optional diagnostics, and hypothetical scale are not evidence/i);
    assert.match(createPlan, /No valid row means delete or defer/i);
    assert.match(createPlan, /Choice \| Simpler option \| Gives up \| Acceptable now because \| Revisit when/);
    assert.match(minimumSolution, /Default to the simpler qualifying option/i);
    assert.match(minimumSolution, /Reject it only when it violates Scope, safety, or correctness/i);
    assert.match(minimumSolution, /Reversible decisions take the local default without research or alternatives/i);
    assert.match(minimumSolution, /compare at most two realistic options/i);
    assert.match(minimumSolution, /bounded spike[^\n]*not production architecture/i);
    assert.doesNotMatch(createPlan, /nothing new → reuse|Future flexibility, optional diagnostics|Default to the simpler qualifying option/i);
    assert.match(createPlan, /For `comprehensive`, add sections only when triggered/i);
    assert.match(createPlan, /Omit untriggered sections; do not emit `N\/A` ceremony/i);
    assert.doesNotMatch(createPlan, /Escalate-If[\s\S]*(?:>3 critical files|new abstraction|data migration|public-API change|tier-reassessment recommendation)/i);
    assert.doesNotMatch(createPlan, /(?:automatic|independently)\s+(?:escalates?|classif(?:y|ies)|selects?)[^\n]*(?:XS|S|M|L|XL|light|standard|comprehensive)/i);

    assert.match(createTasks, /execution slicing only/i);
    assert.match(createTasks, /never (?:classifies|derive|derives|selects?) Plan size/i);
    assert.match(createTasks, /Task definitions are immutable during Execute/i);
    assert.match(createTasks, /file\/LOC size is a warning, never a split by itself/i);
    assert.match(createTasks, /Put RED-before-GREEN in each behavior-changing build subtask/i);
    assert.match(createTasks, /Do not add terminal verification\/E2E tasks/i);
    assert.doesNotMatch(createTasks, /Depth:\s*LIGHT\s*=/);
    assert.doesNotMatch(createTasks, /(?:depth|--depth)[^\n]*(?:Plan classification|classif(?:y|ies)|route size)/i);
  }
});

test('workflow artifacts keep canonical decisions and proof while lifecycle residue stays local', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillsRoot = path.join(repoRoot, 'plugins', rootName, 'skills');
    const readSkill = (name) => fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const featureRoot = readSkill('spectre-feature-root');
    const clean = readSkill('spectre-clean');
    const prune = readSkill('spectre-prune');
    const testSkill = readSkill('spectre-test');
    const sweep = readSkill('spectre-sweep');
    const delegate = readSkill('spectre-delegate');

    assert.match(featureRoot, /`working_set\.json`, `cleanup_summary\.md`, `execution_state\.md`/);
    assert.match(featureRoot, /under both `features\/\*\*\/` and `bugs\/\*\*\/`/);
    assert.match(featureRoot, /Specs\/research\/decisions\/reviews\/proof stay trackable/);
    assert.match(clean, /write no working-set\/lifecycle artifact/i);
    assert.doesNotMatch(clean, /Write\/update `\{OUT_DIR\}\/working_set\.json`/);
    assert.match(prune, /Write no cleanup\/evidence artifact/);
    assert.doesNotMatch(prune, /`\{OUT_DIR\}\/cleanup_summary\.md`/);
    assert.match(testSkill, /write no working-set artifact/i);
    assert.doesNotMatch(testSkill, /`\{FEATURE_ROOT\}\/working_set\.json`/);
    assert.match(sweep, /required `proof\/proof\.json` \+ `proof\/proof\.html`/);
    assert.match(sweep, /excludes Execute evidence, verification reports, checkpoints, runs, markers/);
    assert.match(delegate, /required review and proof artifacts are committed/i);
    assert.doesNotMatch(delegate, /EVIDENCE_DIRS/);
  }
});

test('Fix persists a complete managed repair plan and returns its Execute handoff immediately', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const fix = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-fix', 'SKILL.md'),
      'utf8',
    ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const repairPlanIndex = fix.search(/self-locating (?:compact )?(?:managed )?repair plan/i);
    const fixExecuteIndex = fix.indexOf('spectre-execute {BUG_REPORT_PATH} --origin fix');
    assert.ok(repairPlanIndex !== -1);
    assert.ok(repairPlanIndex < fixExecuteIndex);
    assert.match(fix, /repair plan[^\n]*before (?:code )?mutation/i);
    assert.match(fix, /scoped name if one already exists/i);
    assert.match(fix, /\{BUG_REPORT_PATH\}/);
    assert.doesNotMatch(fix, /\{FEATURE_ROOT\}/);
    assert.doesNotMatch(fix, /specs\/plan\.md/);
    assert.match(fix, /`KIND=bug`/);
    assert.match(fix, /Never adopt an ambient feature root/);
    assert.match(fix, /explicit `fix` origin/i);
    assert.match(fix, /same response/i);
    assert.match(fix, /invoking Execute is the mutation boundary/i);
    assert.doesNotMatch(fix, /HoldForApproval|approval-gated|After approval|return to (?:the )?approval gate/i);
    assert.doesNotMatch(fix, /PHASE=repair/);

    // The transcript is the decision surface; bug-report.md is the matching record.
    assert.match(fix, /rendered in-thread/i);
    assert.match(fix, /A file path is not a presentation/);
    const presentIndex = fix.indexOf('Present the experience contract first');
    const mirrorIndex = fix.indexOf('Mirror that render into');
    assert.ok(presentIndex !== -1 && mirrorIndex !== -1);
    assert.ok(presentIndex < mirrorIndex);
    assert.ok(mirrorIndex < fixExecuteIndex);
    const readSkill = (skillName) => fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.match(
      readSkill('spectre-fix-core'),
      /`--orchestrated` — withhold user-facing routing, never content\./,
    );
    assert.doesNotMatch(
      readSkill('spectre-fix-core'),
      /post-diagnosis approval pause|unapproved\/out-of-scope collateral change/i,
    );
    const delegate = readSkill('spectre-delegate');
    assert.match(delegate, /Type `fix` initializes `KIND=bug`/);
    assert.match(delegate, /\{FEATURE_ROOT\}\/bug-report\.md/);
    assert.match(readSkill('spectre-sweep'), /Staging includes[^\n]*`bug-report\.md`/);
    assert.doesNotMatch(readSkill('spectre-prove'), /Feature Root: \.spectre\/features/);
  }
});

test('workflow handoffs are task-aware, phase-aware, and orchestration-safe', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const readSkill = (rootName, skillName) => fs.readFileSync(
    path.join(repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md'),
    'utf8',
  ).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const scope = readSkill(rootName, 'spectre-scope');
    const ux = readSkill(rootName, 'spectre-ux');
    const prototype = readSkill(rootName, 'spectre-prototype');
    const plan = readSkill(rootName, 'spectre-plan');
    const createPlan = readSkill(rootName, 'spectre-create_plan');
    const createTasks = readSkill(rootName, 'spectre-create_tasks');
    const execute = readExecuteContract(repoRoot, rootName).replaceAll('/spectre:spectre-', 'spectre-').replaceAll('$spectre:spectre-', 'spectre-');
    const validate = readSkill(rootName, 'spectre-validate');
    const proof = readSkill(rootName, 'spectre-prove');
    const clean = readSkill(rootName, 'spectre-clean');
    const ship = readSkill(rootName, 'spectre-ship');

    const scopeUx = scope.indexOf('journeys, segments, states, copy, or accessibility');
    const scopePrototype = scope.indexOf('interaction/layout/visual validation materially matters');
    const scopePlan = scope.indexOf('confirmed repository-changing work');
    assert.ok(scopeUx !== -1);
    assert.ok(scopePrototype > scopeUx);
    assert.ok(scopePlan > scopePrototype);
    assert.match(scope, /\| ▶️ \*\*Proposed next step\*\* \|/);
    assert.match(scope, /Pause: .*spectre-handoff/);

    assert.match(ux, /interaction, layout, visual validation, or stakeholder review materially matters/);
    assert.match(ux, /otherwise Plan when Scope \+ flows suffice/);
    assert.doesNotMatch(ux, /spectre-create_plan.*spectre-create_tasks.*spectre-tdd/);

    for (const mode of ['explore', 'flows-only ux', 'post-ux', 'post-scope', 'standalone']) {
      assert.ok(prototype.includes(`\`${mode}\``));
    }
    assert.match(prototype, /reclassify as `post-scope`/);

    assert.ok(plan.includes('`ux.md` (preferred) or legacy `specs/ux.md`'));
    assert.match(plan, /exactly one copy-ready fenced command/);
    assert.match(plan, /--preflight-plan <xs\|light\|standard\|comprehensive>/);
    assert.doesNotMatch(plan, /spectre-create_tasks|spectre-task_review/);
    assert.doesNotMatch(plan, /spectre-goal/);

    assert.match(createPlan, /Approved direct.*spectre-execute/i);
    assert.match(createPlan, /Approved light structured.*spectre-create_tasks/i);
    assert.match(createPlan, /Approved standard\/comprehensive.*spectre-plan_review/i);
    assert.match(createTasks, /load-bearing user-facing behavior.*without adequate UX\/prototype acceptance evidence/);
    assert.match(createTasks, /--orchestrated.*(?:without|omits) user-facing Next Steps/);

    assert.match(execute, /After review dispositions are recorded/);
    assert.match(execute, /Skill\(spectre-prove\)/);
    assert.match(execute, /Proof is always the last acceptance gate/);
    assert.match(execute, /Parent:[^\n]*machine[^\n]*no table/i);
    assert.match(validate, /Standalone `Complete`.*spectre-prove/);
    assert.match(proof, /Standalone `PASS`.*spectre-ship/);
    assert.match(proof, /proof status alone never gates .*spectre.*ship/);

    assert.match(clean, /parallel[\s\S]*spectre-prune[\s\S]*spectre-test[\s\S]*spectre-sweep/i);
    assert.match(clean, /CLEANED_THROUGH_SHA/);
    assert.match(ship, /parallel[\s\S]*spectre-prune[\s\S]*spectre-test[\s\S]*spectre-sweep/i);
    assert.doesNotMatch(ship, /Skill\(spectre-clean\)/);
    assert.match(ship, /Skill\(spectre-rebase\)/);
    assert.match(ship, /Skill\(spectre-create_pr\)/);
    assert.match(ship, /\| ▶️ \*\*Proposed next step\*\* \|/);
  }
});

test('UX carries explicit flow approval and a selected continuation through Stage 2', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const ux = fs.readFileSync(path.join(
      repoRoot, 'plugins', rootName, 'skills', 'spectre-ux', 'SKILL.md',
    ), 'utf8');

    assert.match(ux, /every initial or feedback-revised flow presentation ends with the compact handoff table/i);
    assert.match(ux, /Flows approved[\s\S]*complete \{OUT_DIR\}\/ux\.md[\s\S]*Prototype[\s\S]*Plan/i);
    assert.match(ux, /interaction, layout, visual validation, or stakeholder review materially matters[\s\S]*Prototype[\s\S]*otherwise[\s\S]*Plan/i);
    assert.match(ux, /explicit flow approval \+ selected continuation[\s\S]*same run[\s\S]*no second gate/i);
    assert.match(ux, /feedback without approval[\s\S]*revise and re-present/i);
    assert.match(ux, /ambiguous approval or missing route authority[\s\S]*only the unresolved choice/i);
    assert.match(ux, /Never write `\{OUT_DIR\}\/ux\.md` before explicit flow approval \+ selected continuation/i);
  }
});

test('Execute self-owned handoff links proof without contaminating parent delivery', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const execute = fs.readFileSync(path.join(
      repoRoot, 'plugins', rootName, 'skills', 'spectre-execute', 'SKILL.md',
    ), 'utf8');
    const handoff = handoffSection(execute);

    assert.match(
      execute,
      /Self terminal/i,
    );
    assert.match(
      execute,
      /Parent:[\s\S]*machine[\s\S]*`IMPLEMENTATION_READY`[\s\S]*`ACCEPTANCE_PENDING`[\s\S]*no table/i,
    );
    assert.match(handoff, /Complete\/recovery/i);
    assert.match(
      handoff,
      /Delivery\/impact/i,
    );
    assert.match(
      handoff,
      /What was just done[\s\S]*capability[\s\S]*user impact[\s\S]*only[\s\S]*must not include[\s\S]*test\/review\/proof verdicts/i,
    );
    assert.match(
      execute,
      /counts\/coverage\/review\/dispositions\/owner\/RUN_ID\/telemetry[\s\S]*outside the table/i,
    );
    assert.match(handoff, /🔎 \*\*Review proof\*\*/);
    assert.match(
      handoff,
      /Render Markdown \[Review proof\]\(\/absolute\/resolved-feature-root\/proof\/proof\.html\).*substitut(?:e|ing).*absolute FEATURE_ROOT/i,
    );
    assert.match(
      execute,
      /companion.*same resolved local file.*outside.*same clickable link/i,
    );
    assert.doesNotMatch(handoff, /Counts, proof, findings, `RUN_ID`/);
    assert.match(
      execute,
      /Companion opens[\s\S]*same resolved local file[\s\S]*beside conversation/i,
    );
    assert.match(
      execute,
      /outside[\s\S]*same clickable link[\s\S]*no failure/i,
    );
    assert.match(execute, /Never publish\/share proof/i);
    assert.match(
      handoff,
      /High.*Fix[\s\S]*coverage.*Test[\s\S]*spectre[-:]ship/i,
    );
    assert.match(
      handoff,
      /blocked\/failed[\s\S]*same table[\s\S]*exact resolved recovery action/i,
    );
  }
});

test('Execute pre-Handoff contract stays pinned after fix-source preparation', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const execute = fs.readFileSync(path.join(
    repoRoot, 'plugins', 'spectre', 'skills', 'spectre-execute', 'SKILL.md',
  ), 'utf8');
  const beforeHandoff = execute.slice(0, execute.indexOf('## Handoff'));

  assert.equal(
    crypto.createHash('sha256').update(beforeHandoff).digest('hex'),
    'dc6a2c00c3d755c1d6383c50d51c3c3056ccb53ccddf54db2b0ef5292eaa2604',
  );
  assert.match(beforeHandoff, /Keep the invocation checkout/);
  assert.match(
    beforeHandoff,
    /bug-report path\/root or identifying content—not `--origin`—selects `fix`/,
  );
  assert.match(beforeHandoff, /`SCOPE_DOCS`: manifest paths or scope\/UX\/research cited by the plan/);
  assert.match(beforeHandoff, /Maintain compact verification ledger by HEAD, check id, changed\/dependency surface/);
  assert.match(beforeHandoff, /Expensive harness\/performance\/full qualification runs only for the final relevant candidate/);
});

test('user-facing handoffs use the compact table contract without changing internal protocols', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const requiredRows = [
    '| Handoff | Details |',
    '| 🧭 **Current phase** |',
    '| 📦 **What was just done** |',
    '| ▶️ **Proposed next step** |',
  ];

  for (const rootName of ['spectre', 'spectre-codex']) {
    for (const skillName of USER_HANDOFF_SKILLS) {
      const source = fs.readFileSync(path.join(
        repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md',
      ), 'utf8');
      const handoff = handoffSection(source);
      for (const row of requiredRows) {
        assert.ok(handoff.includes(row), `${rootName}/${skillName} is missing ${row}`);
      }
      const proposed = handoff.match(/\| ▶️ \*\*Proposed next step\*\* \|([^\n]*)/)?.[1] || '';
      assert.doesNotMatch(
        proposed,
        /\{[^}]+\}/,
        `${rootName}/${skillName} must not render an unresolved proposed-step value`,
      );
      assert.match(
        proposed,
        /(?:resolve before rendering one action; never placeholders|render (?:one )?resolved action(?:; no placeholders)?)/i,
        `${rootName}/${skillName} must require a fully resolved copy-ready action`,
      );
    }

    for (const skillName of INTERNAL_HANDOFF_SKILLS) {
      const source = fs.readFileSync(path.join(
        repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md',
      ), 'utf8');
      assert.doesNotMatch(handoffSection(source), /🧭 \*\*Current phase\*\*/);
    }
  }

  for (const [rootName, ceiling] of [['spectre', 41_449], ['spectre-codex', 41_439]]) {
    const tokens = USER_HANDOFF_SKILLS.reduce(
      (total, skillName) => total + repositoryTokenCount(
        repoRoot,
        `plugins/${rootName}/skills/${skillName}/SKILL.md`,
      ),
      0,
    );
    assert.ok(tokens <= ceiling, `${rootName} handoff token budget exceeded: ${tokens} > ${ceiling}`);
  }

  const routeRequirements = {
    'spectre-plan': /resolved absolute plan path[\s\S]*--origin plan[\s\S]*resolved preflight depth/i,
    'spectre-fix': /resolved absolute bug-report path[\s\S]*--origin fix/i,
    'spectre-create_tasks': /resolved absolute execute index[\s\S]*--origin plan/i,
    'spectre-task_review': /resolved absolute execute index[\s\S]*--origin plan/i,
    'spectre-kickoff': /resolved kickoff document path[\s\S]*FROM_KICKOFF=true[\s\S]*SKIP_EXPLORATION=true/i,
    'spectre-goal': /resolved goal file path/i,
    'spectre-research': /resolved research document path/i,
  };
  for (const rootName of ['spectre', 'spectre-codex']) {
    for (const [skillName, requirement] of Object.entries(routeRequirements)) {
      const source = fs.readFileSync(path.join(
        repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md',
      ), 'utf8');
      assert.match(source, requirement, `${rootName}/${skillName} omits a required resolved argument`);
    }
  }
});

test('user-facing workflow commands stay platform-qualified across generated skills', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const canonicalRoot = path.join(repoRoot, 'plugins', 'spectre', 'skills');
  const codexRoot = path.join(repoRoot, 'plugins', 'spectre-codex', 'skills');

  for (const relativePath of markdownFiles(canonicalRoot)) {
    const canonical = fs.readFileSync(path.join(canonicalRoot, relativePath), 'utf8');
    const codex = fs.readFileSync(path.join(codexRoot, relativePath), 'utf8');
    const canonicalCommands = [...canonical.matchAll(/\/spectre:(spectre-[A-Za-z0-9_-]+)/g)]
      .map(([, name]) => name);
    const codexCommands = [...codex.matchAll(/\$spectre:(spectre-[A-Za-z0-9_-]+)/g)]
      .map(([, name]) => name);

    assert.doesNotMatch(
      canonical,
      /\/spectre:(?!spectre-)[A-Za-z0-9_-]+/,
      `${relativePath} contains legacy Claude command shorthand`,
    );
    assert.doesNotMatch(
      codex,
      /\/spectre:[A-Za-z0-9_-]+/,
      `${relativePath} contains an untranslated Claude command`,
    );
    assert.deepEqual(
      codexCommands,
      canonicalCommands,
      `${relativePath} does not preserve user-command references in Codex syntax`,
    );
  }

  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\/spectre:(?!spectre-)[A-Za-z0-9_-]+/);
});

test('compact handoff tables retain the pre-table routing contracts', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const retainedRoutes = {
    'spectre-plan_review': /orchestrated.*return[\s\S]*standalone.*spectre[:-]create_tasks[\s\S]*direct.*spectre[:-]execute/i,
    'spectre-create_tasks': /report mode[\s\S]*graph[\s\S]*waves[\s\S]*UX[\s\S]*Prototype[\s\S]*tasks-only[\s\S]*Task Review[\s\S]*origin plan/i,
    'spectre-clean': /NEEDS_AUTHORITY[\s\S]*ordinary (?:test\/lint\/build )?failures[\s\S]*orchestrated[\s\S]*CLEANED_THROUGH_SHA[\s\S]*Standalone[\s\S]*spectre[:-]rebase[\s\S]*alternative.*spectre[:-]prove/i,
    'spectre-code_review': /orchestrated[\s\S]*CRITICAL\/HIGH[\s\S]*no step[\s\S]*Standalone[\s\S]*blockers[\s\S]*Prove\/Test gap\/deferred Clean/i,
    'spectre-create_pr': /PR_CANDIDATE_STALE[\s\S]*orchestrated[\s\S]*no user step[\s\S]*Standalone[\s\S]*review the PR/i,
    'spectre-create_test_guide': /orchestrated[\s\S]*coverage[\s\S]*observable.*Prove[\s\S]*automation gap.*Test[\s\S]*deferred proof.*Clean/i,
    'spectre-prune': /analyzed\/removed\/excluded[\s\S]*manual review[\s\S]*orchestrated[\s\S]*coverage risk[\s\S]*spectre[:-]test[\s\S]*spectre[:-]sweep/i,
    'spectre-rebase': /orchestrated[\s\S]*REBASE_READY[\s\S]*never DONE[\s\S]*Standalone[\s\S]*spectre[:-]create_pr[\s\S]*recovery/i,
    'spectre-ship': /PR_OPENED[\s\S]*CI.*merge-gating[\s\S]*no handoff/i,
    'spectre-sweep': /orchestrated[\s\S]*unproven work.*Prove[\s\S]*merge-prep.*Rebase[\s\S]*current target.*Create PR/i,
    'spectre-task_review': /orchestrated[\s\S]*unresolved Blocker\/High[\s\S]*remediation[\s\S]*origin plan/i,
    'spectre-tdd': /orchestrated[\s\S]*observable.*Prove[\s\S]*coverage gap.*Test[\s\S]*deferred proof.*Clean/i,
  };
  for (const rootName of ['spectre', 'spectre-codex']) {
    for (const [skillName, route] of Object.entries(retainedRoutes)) {
      const source = fs.readFileSync(path.join(
        repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md',
      ), 'utf8');
      assert.match(handoffSection(source), route, `${rootName}/${skillName} lost a legacy handoff route`);
    }
  }
});

test('workflow documentation matches proof-independent shipping', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  const shipSection = readme.match(
    /\*\*\/spectre:spectre-ship\*\*[\s\S]*?(?=\n\n## )/,
  )?.[0];

  assert.match(readme, /every final agent response[^\n]*guides you to what is next/i);
  assert.doesNotMatch(readme, /\/spectre:spectre-proof/);
  assert.doesNotMatch(readme, /\/spectre:spectre-ship-it/);
  assert.ok(shipSection);
  assert.doesNotMatch(shipSection, /proof-status reporting/);
  assert.doesNotMatch(shipSection, /optional proof status/);
  assert.doesNotMatch(shipSection, /--require-proof/);
});

test('Ship/Clean pin one parallel cleanup boundary and a single post-rebase suite', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const readSkill = (rootName, name) => fs.readFileSync(
    path.join(repoRoot, 'plugins', rootName, 'skills', name, 'SKILL.md'),
    'utf8',
  );

  for (const rootName of ['spectre', 'spectre-codex']) {
    const ship = readSkill(rootName, 'spectre-ship');
    const clean = readSkill(rootName, 'spectre-clean');
    const prune = readSkill(rootName, 'spectre-prune');
    const testSkill = readSkill(rootName, 'spectre-test');
    const sweep = readSkill(rootName, 'spectre-sweep');
    const execute = readSkill(rootName, 'spectre-execute');

    const pruneIndex = ship.indexOf('Skill(spectre-prune)');
    const testIndex = ship.indexOf('Skill(spectre-test)');
    const sweepIndex = ship.indexOf('Skill(spectre-sweep)');
    const rebaseIndex = ship.indexOf('Skill(spectre-rebase)');
    assert.equal((ship.match(/one parallel dispatch/g) ?? []).length, 1);
    assert.equal((ship.match(/Skill\(spectre-prune\)/g) ?? []).length, 1);
    assert.equal((ship.match(/Skill\(spectre-test\)/g) ?? []).length, 1);
    assert.ok(pruneIndex !== -1);
    assert.ok(testIndex > pruneIndex);
    assert.ok(sweepIndex > testIndex);
    assert.ok(rebaseIndex > sweepIndex);
    assert.doesNotMatch(ship, /spectre-clean/);
    assert.match(ship, /one test lead[\s\S]*owns batching/i);
    assert.match(ship, /It alone integrates stale\/uncovered checks[\s\S]*commits/i);
    assert.match(clean, /user-invocable: true/);
    assert.match(clean, /CLEANED_THROUGH_SHA/);
    assert.match(clean, /one prune lead[\s\S]*one test lead[\s\S]*Skill\(spectre-sweep\)/i);
    assert.match(prune, /orchestrated[\s\S]*do not edit tests[\s\S]*run no affected suite/i);
    assert.match(testSkill, /orchestrated[\s\S]*tests\/fixtures[\s\S]*never production[\s\S]*do not stage or commit/i);
    assert.match(sweep, /sole pre-rebase commit owner/i);
    assert.match(sweep, /stale\/uncovered/i);
    assert.match(ship, /--verification-owner parent[\s\S]*No checks/i);
    assert.equal((ship.match(/measure start --label "Full suite"/g) ?? []).length, 1);
    assert.match(ship, /one full suite after rebase[\s\S]*In parallel[\s\S]*Skill\(spectre-create_pr\)[\s\S]*--orchestrated[\s\S]*--pr-phase pending/i);
    assert.match(ship, /rerun only failing\/affected checks[\s\S]*never the full suite/i);
    assert.match(execute, /else `(?:\/spectre:spectre-ship|\$spectre:spectre-ship)`/);
  }
});

test('orchestrated create-pr preserves pending/final candidate gates', () => {
  const repoRoot = path.resolve(__dirname, '..');
  for (const rootName of ['spectre', 'spectre-codex']) {
    const createPr = fs.readFileSync(path.join(
      repoRoot, 'plugins', rootName, 'skills', 'spectre-create_pr', 'SKILL.md',
    ), 'utf8');
    const ship = fs.readFileSync(path.join(
      repoRoot, 'plugins', rootName, 'skills', 'spectre-ship', 'SKILL.md',
    ), 'utf8');

    assert.match(createPr, /--orchestrated[\s\S]*--pr-phase pending\|final-update/i);
    assert.match(createPr, /pending[\s\S]*complete candidate tuple[\s\S]*local verification `RUNNING`[\s\S]*URL.*body/i);
    assert.match(createPr, /final-update[\s\S]*FINAL_VERIFICATION_SUMMARY[\s\S]*existing draft[\s\S]*Testing[\s\S]*only/i);
    assert.match(createPr, /clean candidate worktree[\s\S]*PR_CANDIDATE_STALE/i);
    assert.match(createPr, /factual claim is grounded[\s\S]*secret\/credential\/PII/i);
    assert.match(createPr, /repairs changed the tuple[\s\S]*refresh candidate-sensitive claims[\s\S]*freshness[\s\S]*grounding[\s\S]*secret/i);
    assert.match(ship, /EXPECTED_BASE_SHA[\s\S]*EXPECTED_HEAD_SHA[\s\S]*EXPECTED_DIFF_SHA256/i);
    assert.match(ship, /after suite[\s\S]*--orchestrated[\s\S]*--pr-phase final-update[\s\S]*FINAL_VERIFICATION_SUMMARY[\s\S]*Testing only/i);
    assert.match(ship, /PR_CANDIDATE_STALE[\s\S]*refresh and retry/i);
  }
});

test('create-pr final update pushes and rechecks a repaired candidate before Testing-only edit', () => {
  const createPr = fs.readFileSync(path.join(
    path.resolve(__dirname, '..'),
    'plugins', 'spectre', 'skills', 'spectre-create_pr', 'SKILL.md',
  ), 'utf8');

  assert.match(
    createPr,
    /Final-update[\s\S]*clean repaired HEAD[\s\S]*pushes[\s\S]*re-resolves\/rechecks live tuple[\s\S]*only Testing/i,
  );
});

test('Ship uses the fixed measurement surface without primary bookkeeping', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const skillNames = [
    'spectre-ship',
    'spectre-clean',
    'spectre-prune',
    'spectre-test',
    'spectre-sweep',
    'spectre-create_pr',
    'spectre-execute',
  ];
  const stageLabels = ['Prune', 'Test', 'Sweep', 'Rebase', 'Full suite', 'Create PR'];

  for (const rootName of ['spectre', 'spectre-codex']) {
    const ship = fs.readFileSync(path.join(
      repoRoot, 'plugins', rootName, 'skills', 'spectre-ship', 'SKILL.md',
    ), 'utf8');
    assert.match(ship, /(?:spectre-workflow|workflow-cli\.mjs") measure start --label Ship/);
    for (const label of stageLabels.filter((label) => label !== 'Prune' && label !== 'Test')) {
      assert.match(ship, new RegExp(`measure start --label "${label}"`));
    }
    assert.match(ship, /measure start` for Prune\/Test/);
    assert.match(ship, /Prune\/Test[\s\S]*measure finish[\s\S]*returned child identity/i);
    assert.match(ship, /Sweep[\s\S]*measure finish[\s\S]*Sweep snapshot/i);
    assert.match(ship, /Rebase[\s\S]*measure finish[\s\S]*Rebase snapshot/i);
    assert.match(ship, /Full suite[\s\S]*measure finish[\s\S]*Create PR[\s\S]*measure finish[\s\S]*measure summary --rows[\s\S]*--outer-snapshot/i);
    assert.match(ship, /measure summary --rows[\s\S]*--outer-snapshot[\s\S]*--persist[\s\S]*--project-dir[\s\S]*--feature-root[\s\S]*--base-sha[\s\S]*--head-sha[\s\S]*--diff-sha256/i);
    assert.match(ship, /table[\s\S]*persistence status[\s\S]*history path/i);
    assert.match(ship, /persistence degradation[\s\S]*never blocks PR completion/i);
    assert.doesNotMatch(ship, /measure (?:history|query|compare|export)\b/i);
    assert.match(ship, /never inspect transcripts, track clocks, or calculate/i);
    assert.match(ship, /one exact parallel-group total[\s\S]*unavailable measurement never blocks Ship/i);
  }

  // Structured-handoff tokens are reallocated inside the fixed 28-skill aggregate ceiling.
  for (const [rootName, ceiling] of [['spectre', 11_011], ['spectre-codex', 11_013]]) {
    const tokens = skillNames.reduce(
      (total, name) => total + repositoryTokenCount(
        repoRoot,
        `plugins/${rootName}/skills/${name}/SKILL.md`,
      ),
      0,
    );
    assert.ok(
      tokens <= ceiling,
      `${rootName} Ship/Clean/Prune/Test/Sweep/Create PR/Execute token budget exceeded: ${tokens} > ${ceiling}`,
    );
  }
});

test('ship composes focused skills without a proof prerequisite', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    assert.equal(fs.existsSync(path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-ship-it',
    )), false);
    const skillPath = path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-ship',
      'SKILL.md',
    );
    const skill = fs.readFileSync(skillPath, 'utf8');
    const pruneIndex = skill.indexOf('Skill(spectre-prune)');
    const testIndex = skill.indexOf('Skill(spectre-test)');
    const sweepIndex = skill.indexOf('Skill(spectre-sweep)');
    const rebaseIndex = skill.indexOf('Skill(spectre-rebase)');
    const createPrIndex = skill.indexOf('Skill(spectre-create_pr)');

    assert.match(skill, /name: "spectre-ship"/);
    assert.match(skill, /# ship/);
    assert.ok(pruneIndex !== -1);
    assert.ok(testIndex > pruneIndex);
    assert.ok(sweepIndex > testIndex);
    assert.ok(rebaseIndex > sweepIndex);
    assert.ok(createPrIndex > rebaseIndex);
    assert.match(skill, /Resolve exact branch -> canonical work ID before Create PR/i);
    assert.match(skill, /quiet[^\n]*no recency/i);
    assert.match(skill, /freeze it for pending, final, work record/i);
    assert.match(skill, /Proof is optional:/);
    assert.match(skill, /do not inspect, infer, invoke, or gate on it/);
    assert.doesNotMatch(skill, /--require-proof/);
    assert.doesNotMatch(skill, /Skill\(spectre-prove\)/);
    assert.doesNotMatch(skill, /PROOF_JSON/);
  }
});

test('feature-root establishment is centralized behind one concise internal skill', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const callers = [
    'spectre-clean',
    'spectre-code_review',
    'spectre-create_plan',
    'spectre-create_tasks',
    'spectre-create_test_guide',
    'spectre-delegate',
    'spectre-execute',
    'spectre-goal',
    'spectre-kickoff',
    'spectre-plan',
    'spectre-plan_review',
    'spectre-prototype',
    'spectre-prove',
    'spectre-prune',
    'spectre-research',
    'spectre-scope',
    'spectre-ship',
    'spectre-task_review',
    'spectre-test',
    'spectre-ux',
    'spectre-validate',
  ];
  const canonicalResolver = 'Reuse a managed `FEATURE_ROOT` only when explicit/current-thread evidence ties it to this work (physical directory wins; never branch/recency/lifecycle/scans); distinct work ignores ambient roots. Otherwise, including on collision, standalone MUST first load and follow `@skill-spectre:spectre-feature-root` through DONE; orchestrated calls escalate. Keep writes beneath it and pass it unchanged.';
  const codexResolver = canonicalResolver.replace(
    '`@skill-spectre:spectre-feature-root`',
    '`Skill(spectre-feature-root)`',
  );

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillsRoot = path.join(repoRoot, 'plugins', rootName, 'skills');
    const readSkill = (name) => fs.readFileSync(
      path.join(skillsRoot, name, 'SKILL.md'),
      'utf8',
    );
    const helper = readSkill('spectre-feature-root');
    const resolver = rootName === 'spectre' ? canonicalResolver : codexResolver;

    assert.match(helper, /name: "spectre-feature-root"/);
    assert.match(helper, /user-invocable: false/);
    assert.match(helper, /Do NOT invoke for existing roots, orchestrated calls missing a root, or direct user requests/);
    assert.ok(helper.length <= 2000, `feature-root helper exceeds 500 estimated tokens: ${helper.length} chars`);
    assert.match(helper, /`KIND=feature\|bug` \(default `feature`\)/);
    assert.match(helper, /first free `\.spectre\/\{features\|bugs\}\/<name>\[-N\]\/` per `KIND`/);
    assert.match(helper, /Never inspect or offer existing roots, ask whether to reuse one, present naming options, or wait for approval/);
    assert.match(helper, /Naming ambiguity or collision never escalates/);
    assert.match(helper, /`schema_version`, `created_at`, `feature`, and repo-relative `feature_root`/);
    assert.match(helper, /`manifest\.json`, `bin\/`, `handoffs\/`, `!features\/`, `!bugs\/`/);
    assert.match(helper, /`evidence\/`, `checkpoints\/`, `runs\/`, `markers\/`/);
    assert.match(helper, /under both `features\/\*\*\/` and `bugs\/\*\*\/`/);
    assert.match(helper, /Specs\/research\/decisions\/reviews\/proof stay trackable/);
    assert.match(helper, /Never edit root `\.gitignore`/);
    assert.doesNotMatch(helper, /docs\/tasks/);
    assert.equal(
      fs.existsSync(path.join(skillsRoot, 'spectre-create_tasks', 'references', 'legacy-continuation.example.json')),
      false,
      `${rootName} must not ship the retired legacy continuation fixture`,
    );

    const fixSkill = readSkill('spectre-fix');
    assert.equal(fixSkill.split(resolver).length - 1, 0, 'fix owns a bug-namespace resolver');
    assert.match(
      fixSkill,
      rootName === 'spectre'
        ? /`@skill-spectre:spectre-feature-root` with `KIND=bug`/
        : /`Skill\(spectre-feature-root\)` with `KIND=bug`/,
    );

    for (const name of callers) {
      const skill = readSkill(name);
      assert.equal(skill.split(resolver).length - 1, 1, `${name} must contain exactly one resolver line`);
      assert.doesNotMatch(skill, /docs\/tasks\/\*\*/);
      assert.doesNotMatch(skill, /Before the first artifact in a new root/);
      assert.doesNotMatch(skill, /Never use branch name, recency, lifecycle state, or directory scanning/);
      assert.doesNotMatch(skill, /Root selection is workflow-owned/);
      assert.doesNotMatch(skill, /ask the user to name, choose, approve, reuse, or disambiguate a root/);
    }

    const scope = readSkill('spectre-scope');
    assert.match(scope, /Existing root\/artifact: context for new work/);
    assert.match(scope, /reuse only for the same scope run[\s\S]*explicit resume\/re-scope/);
    assert.doesNotMatch(scope, /scoped filename if one already exists/);

    const plan = readSkill('spectre-plan');
    assert.match(plan, /confirmed Scope—thread or managed root\/descendant/);
    assert.match(plan, /Immutable canonical Scope:[^\n]*when present, else confirmed thread/);

    const createPlan = readSkill('spectre-create_plan');
    assert.match(createPlan, /confirmed Scope—thread, root, or descendant/);
    assert.match(createPlan, /Treat confirmed IN\/OUT\/ANTI-SCOPE/);

    const research = readSkill('spectre-research');
    assert.match(research, /state the feature name\/root the workflow will use/);
    assert.doesNotMatch(research, /proposed feature name\/root/);
  }
});

test('delegate replaces quick_dev, deliver, and align-and-deliver with compact autonomous delegation', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillsRoot = path.join(repoRoot, 'plugins', rootName, 'skills');
    const readSkill = (name) => fs.readFileSync(
      path.join(skillsRoot, name, 'SKILL.md'),
      'utf8',
    );

    assert.equal(fs.existsSync(path.join(skillsRoot, 'spectre-quick_dev')), false);
    assert.equal(fs.existsSync(path.join(skillsRoot, 'spectre-ship-it')), false);
    assert.equal(fs.existsSync(path.join(skillsRoot, 'spectre-deliver')), false);
    assert.equal(fs.existsSync(path.join(skillsRoot, 'spectre-align-and-deliver')), false);

    const delegate = readSkill('spectre-delegate');
    const scope = readSkill('spectre-scope');
    const fix = readSkill('spectre-fix');
    const fixCore = readSkill('spectre-fix-core');
    const createTasks = readSkill('spectre-create_tasks');
    const codeReview = readSkill('spectre-code_review');
    const validate = readSkill('spectre-validate');
    const rebase = readSkill('spectre-rebase');
    const createPr = readSkill('spectre-create_pr');
    const ship = readSkill('spectre-ship');
    const clean = readSkill('spectre-clean');
    const testSkill = readSkill('spectre-test');
    const sweep = readSkill('spectre-sweep');

    const executeIndex = delegate.indexOf('Skill(spectre-execute)');
    const fixCoreIndex = delegate.indexOf('Skill(spectre-fix-core)');
    const rebaseIndex = delegate.indexOf('Skill(spectre-rebase)');
    const candidatePinIndex = delegate.indexOf('DIFF_SHA256=sha256');
    const codeReviewIndex = delegate.indexOf('Skill(spectre-code_review)', candidatePinIndex);
    const proofIndex = delegate.indexOf('Skill(spectre-prove)');
    const createPrIndex = delegate.indexOf('Skill(spectre-create_pr)');

    assert.match(delegate, /disable-model-invocation: true/);
    assert.match(delegate, /name: "spectre-delegate"/);
    assert.match(delegate, /# delegate/);
    assert.match(delegate, /Delegate one small, unambiguous feature or reproducible bug fix to Spectre's autonomous/);
    assert.ok(executeIndex !== -1);
    assert.ok(fixCoreIndex !== -1);
    assert.ok(rebaseIndex > fixCoreIndex);
    assert.ok(candidatePinIndex > rebaseIndex);
    assert.ok(codeReviewIndex > candidatePinIndex);
    assert.ok(proofIndex > codeReviewIndex);
    assert.ok(createPrIndex > proofIndex);
    assert.match(delegate, /Mini eligibility/);
    assert.match(delegate, /(?:at most two|≤2) dependency-safe workstreams/);
    assert.match(delegate, /--finalization-owner parent/);
    assert.match(delegate, /--review-profile final-only/);
    assert.match(delegate, /plan-direct mode/);
    assert.match(delegate, /RED.before-GREEN TDD/);
    assert.match(delegate, /`IMPLEMENTATION_READY` \+ `ACCEPTANCE_PENDING`/);
    assert.match(delegate, /`ACCEPTANCE_PENDING` \+ `FINAL_REVIEW_PENDING`/);
    assert.match(delegate, /git diff --check/);
    assert.match(delegate, /--verification-owner parent/);
    assert.match(delegate, /Pin and run the final adversarial review/);
    assert.match(delegate, /Do not invoke review until every implementation workstream\/task is complete and current affected checks exist/);
    assert.match(delegate, /Skill\(spectre-code_review\)` exactly once/);
    assert.match(delegate, /external-first contract owns opposite-runtime selection/);
    assert.match(delegate, /native fallback only with its recorded reason/);
    assert.match(delegate, /reviewer runtime\/model\/effort\/route/);
    assert.doesNotMatch(delegate, /@(?:spectre:|spectre_)?reviewer/);
    assert.match(delegate, /Skill\(spectre-prove\)[\s\S]*--profile focused/);
    assert.match(delegate, /Only after review findings are dispositioned and affected checks are current/);
    assert.match(delegate, /≤1 consolidated repair pass/);
    assert.match(delegate, /≤1 behavior-repair pass/);
    assert.match(delegate, /Never rerun or validate the review/);
    assert.match(delegate, /Never rerun the code review/);
    assert.match(delegate, /rerun affected checks, commit repair residue[\s\S]*rerun affected checks, commit repair residue/);
    assert.match(delegate, /reprove only failed\/impact-linked rows/);
    assert.doesNotMatch(delegate, /review(?:er)? asynchronously|review and prove concurrently/i);
    assert.match(delegate, /CI: pending/);
    assert.match(delegate, /VERIFICATION_SUMMARY/);
    assert.match(delegate, /no root-suite run/);
    assert.match(delegate, /git diff --binary --full-index --no-ext-diff --no-color/);
    assert.match(delegate, /collision-safe `QUICK_PLAN_FILE`/i);
    assert.match(delegate, /EXPECTED_BASE_SHA=\{BASE_SHA\}/);
    assert.match(delegate, /PR_CANDIDATE_STALE/);
    assert.match(delegate, /refresh the tuple and retry without a cap/);
    assert.match(delegate, /`--draft`.*`--orchestrated`/s);
    assert.match(delegate, /Non-green status[\s\S]*does not alone prevent a draft PR/);
    assert.match(delegate, /No root suite, cleanup meta-flow, merge, deploy, release, or public proof publication/);
    assert.doesNotMatch(delegate, /Skill\(spectre-create_tasks\)/);
    assert.doesNotMatch(delegate, /Skill\(spectre-clean\)/);
    assert.doesNotMatch(delegate, /Skill\(spectre-test\)/);
    assert.doesNotMatch(delegate, /Skill\(spectre-sweep\)/);
    assert.doesNotMatch(delegate, /Skill\(spectre-prune\)/);
    assert.doesNotMatch(delegate, /Skill\(spectre-validate\)/);
    assert.doesNotMatch(delegate, /repository-authoritative root suite/);
    assert.match(
      delegate,
      /Before any artifact or product write[^\n]*git status --porcelain=v1 --untracked-files=all/,
    );
    assert.match(delegate, /A clean linked worktree stays in place/);
    assert.match(delegate, /dirty linked worktree or any primary\/local checkout[\s\S]*clean sibling worktree[\s\S]*from committed `HEAD`/);
    assert.match(delegate, /never stash, reset, commit, copy, or carry pre-existing changes/);
    assert.match(delegate, /Route without confirmation/);
    assert.match(delegate, /run every child in the selected checkout/);

    assert.match(rebase, /--verification-owner parent/);
    assert.match(rebase, /REBASE_READY/);
    assert.match(rebase, /verification: PARENT_OWNED/);
    assert.match(rebase, /do not run lint or tests/);
    assert.match(rebase, /plain `--orchestrated` does not transfer ownership/i);
    assert.match(rebase, /not a precondition for PR creation/);
    assert.match(rebase, /never return a blocker solely because verification is red/);

    assert.doesNotMatch(delegate, /Skill\(spectre-scope\)/);
    assert.match(delegate, /Alignment: inferred/);
    assert.doesNotMatch(scope, /DELIVERY_ALIGNMENT=one-confirmation/);
    assert.doesNotMatch(scope, /NEEDS_FULL_SCOPE/);

    assert.match(fix, /disable-model-invocation: true/);
    assert.doesNotMatch(fix, /HoldForApproval/);
    assert.match(fix, /Skill\(spectre-fix-core\)/);
    assert.match(fix, /experience contract first in product language/);
    assert.match(fix, /what users do and observe now, what they will do and observe after repair/);
    assert.match(fix, /preserved invariants, and disclosed collateral changes/);
    assert.match(fix, /spectre-execute \{BUG_REPORT_PATH\} --origin fix/);
    assert.match(fix, /same response/i);
    assert.match(fixCore, /user-invocable: false/);
    assert.match(fixCore, /PARENT_AUTHORIZATION/);
    assert.match(fixCore, /AUTHORIZED_SCOPE_SHA256/);
    assert.match(fixCore, /recomputed SHA-256 equals/);
    assert.match(fixCore, /alignment mode is `inferred`/);
    assert.match(fixCore, /PARENT=spectre-delegate/);
    assert.doesNotMatch(fixCore, /spectre-deliver/);
    assert.doesNotMatch(fixCore, /align-and-deliver/);
    assert.doesNotMatch(fixCore, /USER_APPROVED_FIX_CONTRACT=true|PHASE=repair/);
    assert.doesNotMatch(fixCore, /USER_APPROVED_DIAGNOSIS=true/);
    assert.match(fixCore, /Explore product \+ technical impact/);
    assert.match(fixCore, /dispatch ≥1 independent read-only/);
    assert.match(fixCore, /parallelize separable product journeys or technical boundaries/);
    assert.match(fixCore, /user\/operator-observable outcomes/);
    assert.match(
      fixCore,
      /journey\/surface.*current experience.*expected experience.*technical path\/consumer.*intended-change\|preserved-invariant\|collateral-change\|unresolved/,
    );
    assert.match(fixCore, /new or changed experience-contract row or repair boundary returns to authorization/i);
    assert.match(fixCore, /RED-before-GREEN/);
    assert.match(fixCore, /Broad baseline red never blocks/);
    assert.match(fixCore, /failed repair leaves third-party cause unclear/i);
    assert.match(
      fixCore,
      /@spectre(?::|_)web(?:-|_)research[^\n]*pinned docs\/code\/issues[^\n]*analogs[^\n]*hypotheses \+ RED before mutation/,
    );
    assert.match(fixCore, /Never escalate for unrelated red checks/);
    assert.doesNotMatch(fixCore, /deterministic checks remain red/);

    assert.match(
      createTasks,
      /Default pair:[^\n]*\{FEATURE_ROOT\}\/specs\/execute\.md[^\n]*\{FEATURE_ROOT\}\/specs\/tasks\.json/,
    );
    assert.match(createTasks, /same-basename feature-scoped pairs/);
    assert.match(codeReview, /BASE_SHA.*HEAD_SHA.*DIFF_SHA256/);
    assert.match(codeReview, /candidate tuple[\s\S]*before dispatch and after report creation/i);
    assert.match(validate, /BASE_SHA.*HEAD_SHA.*DIFF_SHA256/);
    assert.match(validate, /tuple in the report/);
    assert.match(createPr, /EXPECTED_BASE_SHA.*EXPECTED_HEAD_SHA.*EXPECTED_DIFF_SHA256/);
    assert.match(createPr, /VERIFICATION_SUMMARY/);
    assert.match(createPr, /Testing honestly reflects[\s\S]*never turns advisory non-green into pass/i);
    assert.match(createPr, /PR_CANDIDATE_STALE/);
    assert.match(createPr, /clean candidate worktree[\s\S]*before push, create, or edit/i);
    assert.match(createPr, /fetched tuple is verified[\s\S]*only a draft is opened or updated/i);
    assert.match(createPr, /pending[\s\S]*pushes[\s\S]*creates the draft/i);
    assert.match(createPr, /Final-update[\s\S]*rechecks its tuple\/clean candidate[\s\S]*Testing/i);

    assert.match(createPr, /gh pr create --draft/);
    assert.match(createPr, /only a draft is opened or updated/i);
    assert.doesNotMatch(createPr, /--draft` when requested|--draft` if requested/);
    assert.match(ship, /Observe one full suite after rebase/);
    assert.match(ship, /No duplicate suites/);
    assert.match(ship, /rerun only failing\/affected checks, never the full suite/i);
    assert.match(ship, /Verification is evidence, never a stop condition/);
    assert.match(ship, /PR_OPENED/);
    assert.match(ship, /CI: pending/);
    assert.match(ship, /Never escalate solely for test\/lint\/type\/build failures/);
    assert.match(testSkill, /Never run a repository-wide baseline or full suite from this skill/);
    assert.match(testSkill, /Branch-caused → repair\/reverify/);
    assert.match(testSkill, /other findings are routed without stopping/);
    assert.match(sweep, /Never run a repository-wide baseline or full suite/);
    assert.match(sweep, /ordinary lint\/test failures remain in repair flow/);
    assert.match(clean, /Ordinary test\/lint\/build failures never produce it/);
    assert.match(clean, /repairable findings remain with the owning child/);
    assert.doesNotMatch(createPr, /\(spectre-ship\)/);
    assert.doesNotMatch(ship, /\(spectre-ship\)/);
  }

  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /\/spectre:spectre-delegate/);
  assert.doesNotMatch(readme, /\/spectre:spectre-deliver/);
  assert.doesNotMatch(readme, /\/spectre:spectre-align-and-deliver/);
  assert.doesNotMatch(readme, /\/spectre:spectre-quick_dev/);
  assert.match(readme, /\/spectre:spectre-ship/);
  assert.doesNotMatch(readme, /\/spectre:spectre-ship-it/);
});

test('review gates pin route-specific opposing models and retain native fallback', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const skillNames = ['spectre-plan_review', 'spectre-task_review', 'spectre-code_review'];
  const routes = {
    'spectre-plan_review': {
      claudeModel: 'opus',
      effort: 'high',
    },
    'spectre-task_review': {
      claudeModel: 'opus',
      effort: 'medium',
    },
    'spectre-code_review': {
      claudeModel: 'opus',
      effort: 'high',
    },
  };

  for (const rootName of ['spectre', 'spectre-codex']) {
    for (const skillName of skillNames) {
      const skillPath = path.join(
        repoRoot,
        'plugins',
        rootName,
        'skills',
        skillName,
        'SKILL.md',
      );
      const skill = fs.readFileSync(skillPath, 'utf8');

      const { claudeModel, effort } = routes[skillName];
      if (skillName === 'spectre-plan_review') {
        assert.match(skill, /high effort \(20-minute limit\)/);
        assert.match(skill, /Codex (?:→|->) Claude Code `opus`/);
        assert.match(skill, /Claude Code (?:→|->) Codex `gpt-5\.6-sol`/);
        assert.match(skill, /claude -p --model opus --effort high/);
        assert.match(skill, /codex exec -C "\$PWD" -m gpt-5\.6-sol -c 'model_reasoning_effort="high"'/);
        assert.match(skill, /missing, non-zero, absent\/malformed envelope, hash mismatch, or out-of-bounds/i);
        assert.match(skill, /record.*failure.*before one.*native/i);
        assert.match(skill, /native `@spectre(?::|_)reviewer`/);
        assert.match(skill, /returns.*verbatim report body.*exact unified patch\/no-op/i);
        assert.match(skill, /orchestrator.*persists.*verbatim.*mechanically applies/i);
        assert.doesNotMatch(skill, /at least 20 minutes/);
      } else if (skillName === 'spectre-task_review') {
        assert.match(skill, /pinned medium effort/);
        assert.match(skill, /Codex (?:→|->) Claude(?: Code)? `opus`/);
        assert.match(skill, /Claude(?: Code)? (?:→|->) Codex `gpt-5\.6-sol`/);
        assert.match(skill, /one clean-context `@(?:spectre(?::|_)?)?reviewer`/);
        assert.match(skill, /runtime\/model\/effort\/route/);
      } else {
        assert.match(skill, new RegExp(`claude -p --model ${claudeModel} --effort ${effort}`));
        assert.match(
          skill,
          new RegExp(
            `codex exec -C "\\$PWD" -m gpt-5\\.6-sol -c 'model_reasoning_effort="${effort}"'`,
          ),
        );
        assert.match(skill, /Missing\/non-zero opposing CLI[\s\S]*permits one clean-context `@spectre(?::|_)reviewer`/i);
        assert.match(skill, /Fallback once/);
        assert.match(skill, new RegExp(`Claude Code\\|${claudeModel}\\|${effort}\\|Codex -> Claude Code`));
        assert.match(skill, new RegExp(`Codex\\|gpt-5\\.6-sol\\|${effort}\\|Claude Code -> Codex`));
        assert.match(skill, /native-subagent\|runtime-native\|inherited\|native-fallback/);
      }

      if (skillName === 'spectre-task_review') {
        assert.match(skill, /scripts\/task-review-safety\.mjs/);
        assert.match(skill, /helper's `preflight`/);
        assert.match(skill, /helper `validate-report`/);
        assert.match(skill, /primary may repair mechanical report\/schema metadata/);
        assert.doesNotMatch(skill, /same-route report-only repair/);
        assert.match(skill, /runs `validate-pair`/);
        assert.match(skill, /one semantic review per authorized round/);
        assert.match(skill, /--review-again/);
        assert.match(skill, /task_review_attempt\.json/);
        assert.match(skill, /retired `impact` operation/);
        assert.match(skill, /Adversarial mode reviews the whole graph in one pass/);
        assert.match(skill, /Allow up to 20 minutes; quiet output alone is not failure/);
        assert.match(skill, /guidance, not an exhaustive taxonomy or a limit/);
        assert.match(skill, /without avoidable rework/);
        assert.doesNotMatch(skill, /at least 20 minutes|do not stop early/i);
      }
    }
  }
});

test('plan review bounds correctness and enforces subtraction-only simplification', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skillDir = path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-plan_review',
    );
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const correctness = fs.readFileSync(
      path.join(skillDir, 'references', 'correctness-review.md'),
      'utf8',
    );
    const simplification = fs.readFileSync(
      path.join(skillDir, 'references', 'simplification-review.md'),
      'utf8',
    );

    assert.match(skill, /smallest correct plan/);
    assert.ok(skill.indexOf('2. **Correctness.**') < skill.indexOf('3. **Simplification.**'));
    assert.match(skill, /plan_correctness\.md/);
    assert.match(skill, /evidence\/unknowns/i);
    assert.match(skill, /retained constraints/i);
    assert.match(skill, /at most one each `@spectre(?::|_)finder`.*`@spectre(?::|_)analyst`.*`@spectre(?::|_)patterns`/);
    assert.match(skill, /references\/correctness-review\.md/);
    assert.match(skill, /references\/simplification-review\.md/);
    assert.match(skill, /send it verbatim to a fresh reviewer/i);
    assert.match(skill, /plan, Scope, task-context, and report paths\/hashes/i);
    assert.match(skill, /corrected plan, Scope, correctness-report, and output-report paths\/hashes/i);
    assert.doesNotMatch(skill, /REVIEW MANIFEST|ADDITIONAL FOCUS|paraphrase|reorder|weaken|augment/i);
    assert.match(skill, /Stop on unresolved correctness Blocker\/High/);
    assert.match(correctness, /one representative happy path and primary failure per distinct required behavior/i);
    assert.match(correctness, /another requirement, public boundary, credible regression, or materially different present risk/);
    assert.match(correctness, /concrete risks created by the changed boundaries/i);
    assert.match(correctness, /required now by \| simpler local option \| why it fails now \| verification/i);
    assert.match(correctness, /Return envelope/i);
    assert.match(simplification, /delete, collapse, reuse, or defer/i);
    assert.match(simplification, /High` for untraceable complexity or an invalid exception/i);
    assert.match(simplification, /minimum replacement detail needed by a larger net reduction/i);
    assert.match(simplification, /required now by \| simpler local option \| why it fails now \| removal failure/i);
    assert.match(simplification, /Return envelope/i);
    assert.match(skill, /plan smaller or no safe reduction/i);
    assert.match(skill, /Reports are deltas; never restate the plan/i);
    assert.match(skill, /direct-mode Verification is executable/i);
    assert.match(skill, /Run each stage fresh at high effort/);
    assert.match(skill, /correctness.*closes before.*simplification/i);
    assert.doesNotMatch(skill, /Shrinkage is optional/i);
    assert.doesNotMatch(skill, /Completed-review hard stop/i);
    assert.doesNotMatch(skill, /--review-again/);
    assert.doesNotMatch(skill, /plan_review_attempt\.json/);
    assert.doesNotMatch(skill, /round_status/);
    assert.doesNotMatch(skill, /--mode adversarial|--mode full/);
  }

  assert.ok(
    repositoryTokenCount(
      repoRoot,
      'plugins/spectre/skills/spectre-plan_review/SKILL.md',
    ) <= 1300,
    'plan-review orchestration should remain compact',
  );
  for (const reference of ['correctness-review.md', 'simplification-review.md']) {
    assert.ok(
      repositoryTokenCount(
        repoRoot,
        `plugins/spectre/skills/spectre-plan_review/references/${reference}`,
      ) <= 350,
      `${reference} should remain a compact stage prompt`,
    );
  }
});

test('Plan selects and binds the minimum solution before it renders a draft', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skills = path.join(repoRoot, 'plugins', rootName, 'skills');
    const readSkill = (name) => fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    const plan = readSkill('spectre-plan');
    const route = readSkill('spectre-plan-route');
    const createPlan = readSkill('spectre-create_plan');
    const planReview = readSkill('spectre-plan_review');
    const minimumSolution = fs.readFileSync(
      path.join(skills, 'spectre-plan', 'references', 'minimum-solution.md'),
      'utf8',
    );
    const simplification = fs.readFileSync(
      path.join(skills, 'spectre-plan_review', 'references', 'simplification-review.md'),
      'utf8',
    );
    const planReferences = fs.readdirSync(
      path.join(skills, 'spectre-plan', 'references'),
    ).filter((file) => file.endsWith('.md')).sort();

    assert.match(minimumSolution, /incumbent-only delivery path/i);
    assert.match(minimumSolution, /nothing new → reuse owner\/lifecycle\/state\/operation → extend one boundary and derive state → existing platform\/dependency → minimum new mechanism/i);
    assert.match(minimumSolution, /S challenges XS[\s\S]*M challenges S[\s\S]*L challenges M[\s\S]*XL challenges L/i);
    assert.match(minimumSolution, /structural shape[\s\S]*assurance floor/i);
    assert.match(minimumSolution, /XS\/S.*local/i);
    assert.match(minimumSolution, /M.*durable state.*identity.*public contract.*migration.*dependency.*workflow\/lifecycle/i);
    assert.match(minimumSolution, /L\/XL.*same evidence wave/i);
    assert.match(minimumSolution, /simpler qualifying.*wins/i);
    assert.match(minimumSolution, /Future flexibility.*optional diagnostics.*hypothetical scale.*not evidence/i);
    assert.doesNotMatch(minimumSolution, /telemetry event|persistent.*store|evaluation framework/i);

    const initialRoute = plan.indexOf('Skill(spectre-plan-route)` in `initial` mode');
    const challenger = plan.indexOf('fresh evidence-only challenger');
    const persistedEvidence = plan.indexOf('persists accepted evidence');
    const selection = plan.indexOf('## Minimum Solution Selection', initialRoute);
    const observedRoute = plan.indexOf('Skill(spectre-plan-route)` in `observed` mode');
    const draft = plan.indexOf('Draft once with the observed route-mapped depth');
    assert.ok(initialRoute !== -1 && challenger > initialRoute && challenger < persistedEvidence && selection > persistedEvidence && observedRoute > selection && draft > observedRoute);
    assert.match(plan, /read `references\/minimum-solution\.md`/i);
    assert.match(plan, /existing parallel research wave/i);
    assert.match(plan, /reserves one available evidence slot/i);
    assert.match(plan, /task_context\.md[\s\S]*Scope\/authority[\s\S]*accepted evidence/i);
    assert.match(plan, /automatically uses the observed route[\s\S]*no paid rerun.*user tier gate/i);
    assert.match(plan, /conform.*selected record[\s\S]*raw-byte.*authority hash/i);
    assert.equal((plan.match(/Skill\(spectre-plan-route\)/g) || []).length, 2);
    assert.match(plan, /dispatches it with the wave/i);
    assert.deepEqual(planReferences, [
      'estimation-guidance.md',
      'high-level-design-gate.md',
      'minimum-solution.md',
    ]);
    assert.deepEqual(
      [...new Set(plan.match(/\bplan\.(?!md\b)[a-z_]+/g) || [])].sort(),
      ['plan.completed', 'plan.reclassified', 'plan.started'],
    );
    assert.doesNotMatch(plan, /\b(?:selection|solution-shape)\.(?:json|md)\b/i);

    assert.match(route, /observed[\s\S]*completed minimum-solution selection[\s\S]*before drafting/i);
    assert.match(route, /selected structural facts[\s\S]*assurance floor/i);
    assert.match(route, /same routing table.*alone maps/i);

    assert.match(
      createPlan,
      rootName === 'spectre'
        ? /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/spectre-plan\/references\/minimum-solution\.md/
        : /\$\{PLUGIN_ROOT\}\/skills\/spectre-plan\/references\/minimum-solution\.md/,
    );
    assert.match(createPlan, /Plan-origin[\s\S]*Minimum Solution Selection/i);
    assert.match(createPlan, /may add implementation detail but not.*new owner.*persisted fact.*state.*interface.*dependency.*migration.*lifecycle.*workflow/i);
    assert.match(createPlan, /genuine.*insufficiency.*returns to minimum-solution selection/i);
    assert.match(createPlan, /Standalone[\s\S]*same canonical minimum-solution reference locally/i);
    assert.doesNotMatch(createPlan, /\bchallenger\b/i);
    assert.doesNotMatch(createPlan, /Future flexibility.*optional diagnostics.*hypothetical scale/i);

    assert.match(planReview, /selected minimum-solution record/i);
    assert.match(planReview, /Plan-origin selection/i);
    assert.match(simplification, /Minimum Solution Selection[\s\S]*first trace/i);
    assert.match(simplification, /undeclared owned complexity.*High/i);
    assert.match(simplification, /minimum-solution reselection/i);
    assert.match(simplification, /without.*selection.*current review behavior/i);

    assert.match(plan, /requested outcome, approach, material decisions/i);
    assert.match(plan, /observed XS → xs; S → light; M\/L → standard; XL → comprehensive/i);
  }
});

test('TDD uses a risk-proportionate behavioral floor without weakening RED-before-GREEN', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const skill = fs.readFileSync(
      path.join(repoRoot, 'plugins', rootName, 'skills', 'spectre-tdd', 'SKILL.md'),
      'utf8',
    );

    assert.match(skill, /smallest externally meaningful behavior or contract/);
    assert.match(skill, /representative happy-path and one primary-failure test/);
    assert.match(skill, /distinct requirement, public\/contract boundary, credible regression, or materially different risk/);
    assert.match(skill, /every new test was observed failing for the expected reason before satisfying implementation/);
    assert.match(skill, /every new observable behavior or nontrivial exported contract is tested/);
    assert.match(skill, /Private helpers are normally covered through observable behavior/);
    assert.doesNotMatch(skill, /exactly one happy-path and one primary-failure test/);
    assert.doesNotMatch(skill, /every new function has a test/);
  }
});

test('planning artifact ownership confines reviewer-authored scope-safe writeback', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const readSkill = (skillName) =>
      fs.readFileSync(
        path.join(repoRoot, 'plugins', rootName, 'skills', skillName, 'SKILL.md'),
        'utf8',
      );
    const readPlanReviewReference = (fileName) =>
      fs.readFileSync(
        path.join(
          repoRoot,
          'plugins',
          rootName,
          'skills',
          'spectre-plan_review',
          'references',
          fileName,
        ),
        'utf8',
      );
    const plan = readSkill('spectre-plan');
    const createPlan = readSkill('spectre-create_plan');
    const createTasks = readSkill('spectre-create_tasks');
    const planReview = readSkill('spectre-plan_review');
    const planCorrectnessTemplate = readPlanReviewReference('correctness-review.md');
    const planSimplificationTemplate = readPlanReviewReference('simplification-review.md');
    const taskReview = readSkill('spectre-task_review');
    const codeReview = readSkill('spectre-code_review');

    assert.match(plan, /primary owns synthesis, routing, and draft finalization/i);
    assert.match(plan, /Scope remains the immutable user contract/i);
    assert.doesNotMatch(plan, /spectre-plan_review|spectre-create_tasks|spectre-task_review/);
    assert.doesNotMatch(plan, /never write `plan\.md`, `execute\.md`, or `tasks\.json` content yourself/i);

    assert.match(createPlan, /primary owns synthesis and `plan\.md`/i);
    assert.match(createPlan, /Research agents return evidence only/i);
    assert.match(createPlan, /Existing scope\/PRD\/UX and substantive `task_context\.md` research/i);
    assert.match(createPlan, /Orchestrated calls reuse router research; never redispatch it/i);
    assert.match(createTasks, /primary directly writes only the selected canonical artifacts/i);
    assert.match(createTasks, /research agents (?:return|supply) evidence only/i);

    assert.match(planReview, /orchestrator.*persists.*verbatim.*mechanically applies/i);
    assert.match(planReview, /correctness.*closes before.*simplification/i);
    assert.match(planCorrectnessTemplate, /Return envelope/i);
    assert.match(planSimplificationTemplate, /Return envelope/i);
    assert.match(planCorrectnessTemplate, /dispositions\/resulting edits/i);
    assert.doesNotMatch(planReview, /primary directly edits `plan\.md`/i);
    assert.match(planReview, /plan\/protected hashes[\s\S]*pre-hashes\/bounds/i);
    assert.match(planReview, /never invents findings.*semantic edits/i);
    assert.match(planReview, /A usable review is terminal/i);
    assert.doesNotMatch(planReview, /allowedTools "[^"]*Task/);

    assert.match(taskReview, /reviewer owns `TASKS_JSON` and `REVIEW_REPORT`/i);
    assert.match(taskReview, /Write all findings before edits/i);
    assert.match(taskReview, /Resulting Task Edit/i);
    assert.match(taskReview, /primary may repair mechanical report\/schema metadata/i);
    assert.match(taskReview, /may not invent findings, reinterpret them, or perform semantic task edits/i);
    assert.doesNotMatch(taskReview, /same-route report-only repair/i);
    assert.doesNotMatch(taskReview, /primary directly edits `TASKS_JSON`/i);

    assert.match(codeReview, /primary may mechanically normalize report-only/i);
    assert.doesNotMatch(codeReview, /same-route report-only repair/i);
    assert.match(codeReview, /Primary semantic self-review is prohibited/i);
  }
});

test('code review is adversarial and self-finalizing execute delegates the final review gate', () => {
  const repoRoot = path.resolve(__dirname, '..');

  for (const rootName of ['spectre', 'spectre-codex']) {
    const codeReviewDir = path.join(
      repoRoot,
      'plugins',
      rootName,
      'skills',
      'spectre-code_review',
    );
    const codeReview = fs.readFileSync(path.join(codeReviewDir, 'SKILL.md'), 'utf8');
    const adversarialPrompt = fs.readFileSync(
      path.join(codeReviewDir, 'references', 'adversarial-review.md'),
      'utf8',
    );
    assert.match(adversarialPrompt, /Try to prove the completed work wrong/);
    assert.match(adversarialPrompt, /Actively seek counterexamples, broken invariants, failure paths/);
    assert.match(adversarialPrompt, /correctness; regression\/integration; security; performance\/reliability/i);
    assert.match(adversarialPrompt, /materially avoidable overengineering/);
    assert.match(adversarialPrompt, /Evidence \/ Reproduction/);
    assert.doesNotMatch(adversarialPrompt, /Scores \(0(?:-|\u2013)10\)/);
    assert.match(codeReview, /same verbatim template and structured context/i);

    const execute = readExecuteContract(repoRoot, rootName);
    assert.match(execute, /## Finalization/);
    assert.match(execute, /Default owner: `self`/);
    assert.match(execute, /Skill\(spectre-code_review\)/);
    assert.doesNotMatch(execute, /Skill\(spectre-validate\)/);
    assert.doesNotMatch(execute, /Dispatch multi-lens clean-room review/);
  }
});

test('public release invocation requires only release-notes approval', () => {
  const release = fs.readFileSync(
    path.resolve(__dirname, '..', '.agents', 'skills', 'release', 'SKILL.md'),
    'utf8',
  );

  assert.match(release, /valid public invocation authorizes the resolved version bump, commits, local tag creation, pushes, and GitHub release publication/i);
  assert.match(release, /release-notes approval[\s\S]*only user approval gate/i);
  assert.match(release, /Resolve and report `current -> next`; continue without a confirmation gate/);
  assert.match(release, /After changelog approval, create `vX\.Y\.Z` and run/);
  assert.doesNotMatch(release, /confirm `current -> next` with the user/i);
  assert.doesNotMatch(release, /then ask before running/i);
});
