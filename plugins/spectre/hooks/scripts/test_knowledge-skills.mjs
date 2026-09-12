import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const TEMPLATE_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'spectre-learn',
  'references',
  'recall-template.md',
);

function skill(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

function description(content) {
  return content.match(/^---\n[\s\S]*?^description: "([^"]+)"/m)?.[1] || '';
}

test('knowledge and work-record skills have separate self-sufficient routing contracts', () => {
  const execute = skill('spectre-execute');
  const ship = skill('spectre-ship');
  const createPr = skill('spectre-create_pr');
  const learn = skill('spectre-learn');
  const capture = skill('spectre-capture');
  const workRecord = skill('spectre-work-record');

  assert.match(description(capture), /lasting decision[\s\S]*correction[\s\S]*reusable/i);
  assert.match(description(capture), /disproved[\s\S]*persistent blocker/i);
  assert.match(description(capture), /not[\s\S]*work summar|progress|task completion/i);
  assert.match(capture, /knowledge-capture-input\.json/);
  assert.match(capture, /capture --kind knowledge/);
  assert.doesNotMatch(capture, /work-capture-input\.json|capture --kind knowledge\|work/);

  assert.match(description(workRecord), /Execute start[\s\S]*blocked[\s\S]*completion/i);
  assert.match(description(workRecord), /Ship[\s\S]*Create PR[\s\S]*snapshot[\s\S]*correction/i);
  assert.match(description(workRecord), /not[\s\S]*routine progress[\s\S]*check[\s\S]*commit/i);
  assert.match(workRecord, /work-capture-input\.json/);
  assert.match(workRecord, /capture --kind work/);
  assert.match(workRecord, /2,000[\s\S]*non-blocking/i);

  assert.match(execute, /exact run[\s\S]*Skill\(spectre-work-record\)[\s\S]*start/i);
  assert.match(execute, /meaningful blocked[\s\S]*resolved[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /terminal completion[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /accepted batch[\s\S]*Skill\(spectre-capture\)[\s\S]*qualifying reusable knowledge/i);
  assert.match(execute, /capture failure[\s\S]*does not block/i);
  assert.match(execute, /IMPLEMENTATION_READY[\s\S]*ACCEPTANCE_PENDING/);

  assert.doesNotMatch(ship, /pre-PR[\s\S]*work/i);
  assert.match(ship, /PR[\s\S]*first[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(ship, /failure[\s\S]*does not block/i);
  assert.match(createPr, /orchestrated[\s\S]*does not[\s\S]*work record/i);
  assert.match(createPr, /standalone[\s\S]*Skill\(spectre-work-record\)[\s\S]*terminal/i);
  assert.match(learn, /maintained knowledge[\s\S]*Skill\(spectre-capture\)/i);
  assert.match(learn, /work summar|snapshot|historical correction/i);
  assert.match(learn, /Skill\(spectre-work-record\)/);
});

test('Learn delegates capture and planning retains only loaded knowledge provenance', () => {
  const learn = skill('spectre-learn');
  const capture = skill('spectre-capture');
  const workRecord = skill('spectre-work-record');
  const scope = skill('spectre-scope');
  const plan = skill('spectre-plan');
  const createPlan = skill('spectre-create_plan');
  const registry = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'knowledge', 'registry.mjs'),
    'utf8',
  );

  assert.match(learn, /bare[\s\S]*no-op/i);
  assert.match(learn, /insight|correction/i);
  assert.match(learn, /Skill\(spectre-capture\)/);
  assert.match(learn, /User-invoked front door for durable capture/);
  assert.match(learn, /Learn owns user intent and routing[\s\S]*owns knowledge persistence/i);
  assert.match(learn, /Spectre feature root is not required/i);
  assert.match(learn, /knowledge-capture-input\.json/);
  assert.match(learn, /Skill\(spectre-work-record\)/);
  assert.match(learn, /disable-model-invocation: true/);
  assert.match(learn, /explicit user statement[\s\S]*accepted authoritative evidence/i);
  assert.match(learn, /do not seek independent corroboration or reconfirmation/i);
  assert.match(learn, /absence of repository corroboration is not missing evidence/i);
  assert.match(capture, /explicit user statement[\s\S]*accepted authoritative evidence/i);
  assert.match(capture, /absence of corroborating repository evidence does not block the save or require reconfirmation/i);
  assert.match(capture, /disagreeing repository statements as stale or historical context/i);
  assert.match(capture, /Proactively preserve consequential project knowledge/);
  assert.match(capture, /without waiting for a user request/i);
  assert.match(capture, /not a Spectre feature root/i);
  assert.match(capture, /maintained knowledge[\s\S]*requires no workflow, feature, run, or PR association/i);
  assert.match(workRecord, /exact run, PR, or repository\/base\/head\/diff association/i);
  assert.match(capture, /user-invocable: false/);
  assert.doesNotMatch(learn, /stop and wait for the user/i);
  assert.doesNotMatch(learn, /feature dossier/i);

  for (const content of [scope, plan, createPlan]) {
    assert.match(content, /search[\s\S]*actual task/i);
    assert.match(content, /exact[ -]load[\s\S]*applicable/i);
    assert.match(content, /id[\s\S]*revision/i);
    assert.match(content, /preview-only|unloaded candidate/i);
    assert.match(content, /(?:unchanged revision[\s\S]*(?:not|never)[\s\S]*reload|(?:not|never)[\s\S]*reload[\s\S]*unchanged revision)/i);
    assert.match(content, /compact[\s\S]*provenance/i);
  }
  assert.match(registry, /substantive task[\s\S]*search[\s\S]*assess applicability[\s\S]*exact-load/i);
  assert.match(registry, /unrelated general conversation[\s\S]*load nothing/i);
});

test('active spectre-recall surface is retired', () => {
  assert.equal(
    fs.existsSync(path.join(PLUGIN_ROOT, 'skills', 'spectre-recall', 'SKILL.md')),
    false,
  );
});

test('legacy recall template is retired after npm-side readers are removed', () => {
  assert.equal(fs.existsSync(TEMPLATE_PATH), false);
});
