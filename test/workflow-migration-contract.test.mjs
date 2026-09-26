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

test('Execute routes parent and self acceptance through candidate-bound Proof after Validate', () => {
  const execute = readSkill('spectre-execute');
  const proof = readReference('spectre-execute', 'proof');

  assert.match(execute, /self[\s\S]*references\/proof\.md/i);
  assert.match(execute, /parent[\s\S]*references\/proof\.md/i);
  assert.match(execute, /references\/task-review\.md/i);
  assert.match(proof, /Skill\(spectre-validate\)/);
  assert.match(proof, /BASE_SHA[\s\S]*HEAD_SHA[\s\S]*DIFF_SHA256/);
  assert.match(
    proof,
    /Before selecting or observing journeys, invoke `Skill\(spectre-validate\)`[\s\S]*same authoritative source[\s\S]*BASE_SHA[\s\S]*HEAD_SHA[\s\S]*DIFF_SHA256/i,
  );
  assert.match(proof, /Partial[\s\S]*Dead Code[\s\S]*Missing/);
  assert.match(proof, /non-PASS|not PASS|PASS[\s\S]*gap/i);
});

test('Validate accepts fix reports and requires one to eight real requirement areas', () => {
  const validate = readSkill('spectre-validate');

  assert.match(validate, /fix report|bug report/i);
  assert.match(validate, /1\s*(?:to|[-–])\s*8|one to eight/i);
  assert.match(validate, /real requirement areas|non-empty requirement areas|areas[\s\S]*source requirement/i);
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
