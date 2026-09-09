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

test('workflow skills make capture primary-owned and preserve delivery lifecycle authority', () => {
  const execute = skill('spectre-execute');
  const ship = skill('spectre-ship');
  const createPr = skill('spectre-create_pr');
  const capture = skill('spectre-capture');

  assert.match(execute, /workers[\s\S]*findings[\s\S]*primary/i);
  assert.match(execute, /accepted batch[\s\S]*capture/i);
  assert.match(execute, /seven[\s\S]*work record/i);
  assert.match(execute, /IMPLEMENTATION_READY[\s\S]*ACCEPTANCE_PENDING/);
  assert.match(execute, /Failed\/incomplete[\s\S]*not[\s\S]*completed/i);

  assert.match(ship, /work ID[\s\S]*before[\s\S]*draft/i);
  assert.match(ship, /same work ID[\s\S]*repairs[\s\S]*URL/i);
  assert.match(ship, /save failure[\s\S]*does not block/i);
  assert.match(createPr, /shared pre-PR capture/i);
  assert.match(createPr, /unchanged candidate[\s\S]*no-op/i);
  assert.match(createPr, /draft[\s\S]*not[\s\S]*merged/i);
  assert.match(capture, /load[\s\S]*--json[\s\S]*revisionToken/i);
  assert.match(capture, /one successful[\s\S]*--json[\s\S]*unchanged revision[\s\S]*context/i);
  assert.match(capture, /reuse[\s\S]*record[\s\S]*revisionToken[\s\S]*no-op[\s\S]*proposal[\s\S]*result/i);
  assert.match(capture, /metadata-only[\s\S]*revision check/i);
  assert.match(capture, /reload only[\s\S]*changed revision[\s\S]*conflict[\s\S]*new context/i);
  assert.match(capture, /allowance[\s\S]*--allowance-tokens[\s\S]*never read canonical files/i);
  assert.match(capture, /outside[\s\S]*knowledge store[\s\S]*expected-revision/i);
  assert.match(capture, /never[\s\S]*canonical[\s\S]*index\.json[\s\S]*history/i);
  assert.match(capture, /pullRequest\.state[\s\S]*draft-open/i);
});

test('Learn delegates capture and planning retains only loaded knowledge provenance', () => {
  const learn = skill('spectre-learn');
  const capture = skill('spectre-capture');
  const scope = skill('spectre-scope');
  const plan = skill('spectre-plan');
  const createPlan = skill('spectre-create_plan');
  const registry = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'knowledge', 'registry.mjs'),
    'utf8',
  );

  assert.match(learn, /bare[\s\S]*no-op/i);
  assert.match(learn, /insight|correction/i);
  assert.match(learn, /work record/i);
  assert.match(learn, /Skill\(spectre-capture\)/);
  assert.match(learn, /User-invoked front door for durable capture/);
  assert.match(learn, /Learn owns user intent and routing[\s\S]*owns persistence/i);
  assert.match(learn, /Spectre feature root is not required/i);
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
  assert.match(capture, /For work records only[\s\S]*exact run, PR, or repository\/base\/head\/diff association/i);
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
