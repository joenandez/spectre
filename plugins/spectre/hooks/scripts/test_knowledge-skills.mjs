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

  assert.match(description(capture), /project must still know next week[\s\S]*immediately and unasked/i);
  assert.match(description(capture), /decision made, reaffirmed, or reversed[\s\S]*correction[\s\S]*gotcha, root cause, version pin, constraint, or convention/i);
  assert.match(description(capture), /disproved[\s\S]*persistent blocker/i);
  assert.match(description(capture), /user’s word alone is sufficient authority[\s\S]*never wait for repo evidence or an explicit save request/i);
  assert.match(description(capture), /not for work records or routine progress/i);
  assert.match(capture, /knowledge-capture-input\.json/);
  assert.match(capture, /capture --kind knowledge --input -/);
  assert.match(capture, /recordPath/);
  assert.match(capture, /recoveryInput[\s\S]*manual|manual[\s\S]*recoveryInput/i);
  assert.doesNotMatch(capture, /work-capture-input\.json|capture --kind knowledge\|work/);

  assert.match(description(workRecord), /Execute start[\s\S]*blocked[\s\S]*completion/i);
  assert.match(description(workRecord), /Ship[\s\S]*Create PR[\s\S]*snapshot[\s\S]*correction/i);
  assert.match(description(workRecord), /not for reusable guidance, routine progress, or orchestrated Create PR/i);
  assert.match(workRecord, /work-capture-input\.json/);
  assert.match(workRecord, /Execute start[\s\S]*None yet\.[\s\S]*never use[\s\S]*TODO[\s\S]*REPLACE_ME/i);
  assert.match(workRecord, /capture --kind work --input -/);
  assert.match(workRecord, /recordPath/);
  assert.match(workRecord, /recoveryInput[\s\S]*manual|manual[\s\S]*recoveryInput/i);
  assert.match(workRecord, /2,000[\s\S]*non-blocking/i);
  assert.match(workRecord, /gh pr view[\s\S]*--branch-pr-state[\s\S]*merged[\s\S]*closed/i);
  assert.match(workRecord, /git rev-parse --abbrev-ref HEAD[\s\S]*(?:skip|recovery)/i);
  assert.match(workRecord, /unavailable[\s\S]*(?:skip|recovery)[\s\S]*does not block/i);

  assert.match(execute, /exact run[\s\S]*Skill\(spectre-work-record\)[\s\S]*start/i);
  assert.match(execute, /meaningful blocked[\s\S]*resolved[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /terminal completion[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /accepted batch[\s\S]*Skill\(spectre-capture\)[\s\S]*qualifying reusable knowledge/i);
  assert.match(execute, /capture failure[\s\S]*does not block/i);
  assert.match(execute, /IMPLEMENTATION_READY[\s\S]*ACCEPTANCE_PENDING/);

  assert.doesNotMatch(ship, /pre-PR[\s\S]*work/i);
  assert.match(ship, /PR[\s\S]*first[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(ship, /neither stages\/commits/i);
  assert.match(ship, /relay compact paths\/checks and repair\/route cross-boundary needs unless `NEEDS_AUTHORITY`/i);
  assert.match(ship, /failure[\s\S]*does not block/i);
  assert.match(createPr, /orchestrated[\s\S]*does not[\s\S]*work record/i);
  assert.doesNotMatch(createPr, /pending[\s\S]*attaches PR to work ID/i);
  assert.match(createPr, /pending[\s\S]*returns its PR identity\/URL[\s\S]*Ship to associate/i);
  assert.match(createPr, /standalone[\s\S]*Skill\(spectre-work-record\)[\s\S]*terminal/i);
  assert.match(learn, /maintained knowledge[\s\S]*Skill\(spectre-capture\)/i);
  assert.match(learn, /work summar|snapshot|historical correction/i);
  assert.match(learn, /Skill\(spectre-work-record\)/);
  assert.match(learn, /spectre-work-record\/references\/work-capture-input\.json/);
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
    assert.match(content, /reuse current-request knowledge results\/loads/i);
    assert.match(content, /follow Project knowledge routing/i);
    assert.match(content, /refine only for an unresolved question or new subject/i);
    assert.match(content, /exact[ -]load[\s\S]*applicable/i);
    assert.match(content, /id[\s\S]*revision/i);
    assert.match(content, /preview-only|unloaded candidate/i);
    assert.match(content, /(?:unchanged revision[\s\S]*(?:not|never)[\s\S]*reload|(?:not|never)[\s\S]*reload[\s\S]*unchanged revision)/i);
    assert.match(content, /compact[\s\S]*provenance/i);
    assert.match(content, /actual task[\s\S]*mixed.*knowledge.*work|mixed.*knowledge.*work[\s\S]*actual task/i);
    assert.match(content, /#tag[\s\S]*exact[\s\S]*preview[\s\S]*applicable/i);
  }
  assert.match(registry, /actual task[\s\S]*search '<task>'/i);
  assert.match(registry, /Discovery is per question, not skill/i);
  assert.match(registry, /refine only for an unresolved question or new subject/i);
  assert.match(registry, /never repeat an equivalent query/i);
  assert.match(registry, /Unrelated chat: load nothing/i);
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
