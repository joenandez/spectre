import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RETIRED_SKILLS, SHARED_SKILLS, WORKFLOW_PROBE_SKILLS } from '../src/lib/constants.js';

const root = process.cwd();
const skillsRoot = path.join(root, 'plugins/spectre/skills');
const readSkill = (name) => fs.readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
const readReference = (owner, name) => fs.readFileSync(
  path.join(skillsRoot, owner, 'references', `${name}.md`),
  'utf8',
);
function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(fullPath) : entry.name.endsWith('.md') ? [fullPath] : [];
  });
}

test('canonical entry points retain only the reviewed workflow and utility inventory', () => {
  const names = fs.readdirSync(skillsRoot)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();

  assert.deepEqual(names, [
    'spectre-capture', 'spectre-code_review', 'spectre-create_pr', 'spectre-execute',
    'spectre-feature-root', 'spectre-fix', 'spectre-fix-core', 'spectre-forget',
    'spectre-handoff', 'spectre-learn', 'spectre-plan', 'spectre-plan-route',
    'spectre-prototype', 'spectre-research', 'spectre-ship', 'spectre-validate',
    'spectre-ux', 'spectre-work-record',
  ].sort());
});

test('moved phase guidance lives under its owning surviving workflow only', () => {
  const moved = {
    'spectre-plan': ['scope', 'create-plan'],
    'spectre-execute': ['plan-review', 'create-tasks', 'task-review', 'tdd', 'proof'],
    'spectre-ship': ['prune', 'test', 'sweep', 'rebase'],
  };
  const retiredEntryPoints = [
    'spectre-clean', 'spectre-create_test_guide', 'spectre-delegate', 'spectre-goal',
    'spectre-kickoff', 'spectre-prove',
    'spectre-scope', 'spectre-create_plan', 'spectre-plan_review', 'spectre-create_tasks',
    'spectre-task_review', 'spectre-tdd', 'spectre-proof', 'spectre-prune', 'spectre-test',
    'spectre-sweep', 'spectre-rebase',
  ];

  for (const [owner, references] of Object.entries(moved)) {
    for (const name of references) {
      assert.ok(fs.existsSync(path.join(skillsRoot, owner, 'references', `${name}.md`)), `${owner}/${name}`);
    }
  }
  for (const name of retiredEntryPoints) {
    assert.equal(fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')), false, `${name} remains a live entry point`);
  }
});

test('Execute Finalization keeps parent, self review, and proof instructions as sibling bullets', () => {
  const execute = readSkill('spectre-execute');
  const finalization = execute.split('## Finalization')[1].split('## Handoff')[0];

  assert.match(finalization, /^- `parent`:/m);
  assert.match(finalization, /^- `self`:/m);
  assert.match(finalization, /^- After review dispositions are recorded,/m);
  assert.doesNotMatch(finalization, /^  - (?:`self`|After review dispositions)/m);
  assert.match(finalization, /`parent`:[\s\S]*manifest names `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/spectre-execute\/references\/proof\.md` and its tuple-bound Validate step/);
  assert.match(execute, /Missing\/malformed structured index\/task detail → rerun `\/spectre:spectre-execute <resolved-plan\.md>` from the original readable plan/);
});

test('Execute passes orchestrated ownership and candidate tuple to Validate before Proof', () => {
  const execute = readSkill('spectre-execute');
  const proof = readReference('spectre-execute', 'proof');

  const finalization = execute.split('## Finalization')[1].split('## Handoff')[0];
  assert.match(finalization, /^- `self`:[\s\S]*^- After review dispositions are recorded,/m);
  assert.match(finalization, /Parent `ACCEPTANCE_PENDING` names this Proof reference and tuple-bound validation/);
  assert.match(execute, /references\/task-review\.md/i);
  assert.match(proof, /invoke `Skill\(spectre-validate\)` with `--orchestrated`[\s\S]*resolved `FEATURE_ROOT`[\s\S]*BASE_SHA[\s\S]*HEAD_SHA[\s\S]*DIFF_SHA256/);
  assert.match(
    proof,
    /Before selecting or observing journeys, invoke `Skill\(spectre-validate\)`[\s\S]*same authoritative source[\s\S]*BASE_SHA[\s\S]*HEAD_SHA[\s\S]*DIFF_SHA256/i,
  );
  assert.match(proof, /Partial[\s\S]*Dead Code[\s\S]*Missing/);
  assert.match(proof, /Persist the report path, `Complete` status, and exact tuple/);
  assert.match(proof, /aggregate `PASS` means every row passes and validation status is `Complete` for the exact candidate tuple/);
  assert.match(proof, /Validation section \(report, status, tuple\)/);
});

test('every explicit reference path in live skills and owner references resolves', () => {
  const pathPattern = /`([^`]*references\/[A-Za-z0-9_./-]+\.(?:md|json|mjs))`/g;
  const unresolved = [];

  for (const markdownPath of markdownFiles(skillsRoot)) {
    const source = fs.readFileSync(markdownPath, 'utf8');
    const skillDirectory = markdownPath.slice(skillsRoot.length + 1).split(path.sep)[0];
    for (const match of source.matchAll(pathPattern)) {
      let reference = match[1];
      if (reference.startsWith('${CLAUDE_PLUGIN_ROOT}/skills/')) {
        reference = reference.slice('${CLAUDE_PLUGIN_ROOT}/skills/'.length);
        if (!fs.existsSync(path.join(skillsRoot, reference))) unresolved.push(`${markdownPath}: ${match[1]}`);
        continue;
      }
      if (reference.startsWith('references/')) {
        const candidates = [
          path.join(skillsRoot, skillDirectory, reference),
          path.join(path.dirname(markdownPath), reference),
        ];
        if (!candidates.some((candidate) => fs.existsSync(candidate))) unresolved.push(`${markdownPath}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
});

test('Validate accepts fix reports and requires one to eight real requirement areas', () => {
  const validate = readSkill('spectre-validate');

  assert.match(validate, /fix report|bug report/i);
  assert.match(validate, /1\s*(?:to|[-–])\s*8|one to eight/i);
  assert.match(validate, /Chunk into 1–8 validation areas/i);
  assert.match(validate, /`--orchestrated`: summary\/gaps only/);
  assert.match(validate, /Standalone `Needs Work`\/`Significant Gaps` → `\/spectre:spectre-fix` then revalidate/);
});

test('Plan discovery and Scope fast path accept settled request context and ask only material questions', () => {
  const plan = readSkill('spectre-plan');
  const scope = fs.readFileSync(path.join(skillsRoot, 'spectre-plan/references/scope.md'), 'utf8');

  assert.match(plan.split('---')[1], /Scope a request[\s\S]*do not use for bug diagnosis/i);
  assert.match(plan, /feature request, established thread decisions, or confirmed Scope/);
  assert.match(scope, /If context already settles boundaries, draft Scope directly/);
  assert.match(scope, /Ask only questions whose answer materially changes the outcome or authority/);
});

test('Fix-core exposes only the reachable diagnose phase and delegates implementation to Execute', () => {
  const fixCore = readSkill('spectre-fix-core');
  assert.match(fixCore, /`PHASE=diagnose`/);
  assert.doesNotMatch(fixCore, /PHASE=full|Delegate supplies|FIX_COMPLETE/);
  assert.match(fixCore, /Execute owns all code changes/);
});

test('Execute origin documentation and CLI usage exclude retired Delegate origin', () => {
  const telemetry = readReference('spectre-execute', 'telemetry');
  const workflowCli = fs.readFileSync(path.join(root, 'plugins/spectre/hooks/scripts/workflow-cli.mjs'), 'utf8');
  assert.match(telemetry, /`ORIGIN` \(`plan` or `fix`\)/i);
  assert.doesNotMatch(telemetry, /ORIGIN[^\n]*delegate/i);
  assert.match(workflowCli, /\[--origin plan\|fix\]/);
  assert.doesNotMatch(workflowCli, /--origin plan\|fix\|delegate/);
});

test('live workflow handoffs target retained Plan, Execute, and Ship entries', () => {
  const prototype = readSkill('spectre-prototype');
  const codeReview = readSkill('spectre-code_review');
  const scope = readReference('spectre-plan', 'scope');
  const proof = readReference('spectre-execute', 'proof');

  assert.match(prototype, /standalone without Scope → `\/spectre:spectre-plan`/);
  assert.doesNotMatch(prototype, /FROM_KICKOFF/);
  assert.doesNotMatch(scope, /FROM_KICKOFF|KICKOFF_DOC/);
  assert.match(codeReview, /uncovered acceptance → Execute and closeout → Ship/);
  assert.doesNotMatch(proof, /Standalone `PASS`/);
  assert.match(proof, /Orchestrated: return proof result to Execute/);
});

test('repository workflow documentation describes current owners and moved TDD reference', () => {
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const architecture = fs.readFileSync(path.join(root, 'Architecture.md'), 'utf8');
  const rewriteSkill = fs.readFileSync(path.join(root, '.agents/skills/spectre-rewrite-skill/SKILL.md'), 'utf8');

  assert.match(claude, /Plan, Execute, and Ship/);
  assert.match(architecture, /Plan-owned Scope/);
  assert.match(architecture, /Execute's Proof reference invokes independent Validate/);
  assert.match(rewriteSkill, /skills\/spectre-execute\/references\/tdd\.md/);
  assert.doesNotMatch(rewriteSkill, /`@skill-spectre:spectre-tdd`/);
});

test('installer lists retire folded phases and expose only surviving shared and probe skills', () => {
  assert.deepEqual([...RETIRED_SKILLS].sort(), [
    'spectre-architecture_review', 'spectre-apply', 'spectre-clean',
    'spectre-create_plan', 'spectre-create_tasks', 'spectre-create_test_guide',
    'spectre-delegate', 'spectre-evaluate', 'spectre-goal', 'spectre-guide',
    'spectre-kickoff', 'spectre-plan_review', 'spectre-prove', 'spectre-prune',
    'spectre-rebase', 'spectre-scope', 'spectre-sweep', 'spectre-task_review',
    'spectre-test', 'spectre-tdd',
  ].sort());
  assert.deepEqual(SHARED_SKILLS, ['spectre-learn']);
  assert.deepEqual(WORKFLOW_PROBE_SKILLS, ['spectre-plan', 'spectre-execute', 'spectre-ship']);
});
