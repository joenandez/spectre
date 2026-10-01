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
const WORK_CAPTURE_INPUT_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'spectre-work-record',
  'references',
  'work-capture-input.json',
);
const TAGGING_POLICY_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'spectre-capture',
  'references',
  'tagging-policy.md',
);

function skill(name) {
  const migrated = {
    'spectre-create_plan': ['spectre-plan', 'references/create-plan.md'],
  }[name];
  if (migrated) {
    return fs.readFileSync(
      path.join(PLUGIN_ROOT, 'skills', migrated[0], migrated[1]),
      'utf8',
    );
  }
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
  assert.equal(fs.existsSync(TAGGING_POLICY_PATH), true);
  const taggingPolicy = fs.readFileSync(TAGGING_POLICY_PATH, 'utf8');

  assert.match(description(capture), /durable project decisions[\s\S]*accepted corrections[\s\S]*verified reusable patterns or gotchas/i);
  assert.match(description(capture), /disproved guidance[\s\S]*persistent blockers/i);
  assert.match(description(capture), /sufficient authority without code corroboration/i);
  assert.match(description(capture), /do not use for routine progress[\s\S]*historical work accounts/i);
  assert.match(capture, /knowledge-capture-input\.json/);
  assert.match(capture, /capture --kind knowledge --input -/);
  assert.match(capture, /recordPath/);
  assert.match(capture, /recoveryInput[\s\S]*manual|manual[\s\S]*recoveryInput/i);
  assert.match(capture, /references\/tagging-policy\.md/);
  assert.doesNotMatch(capture, /work-capture-input\.json|capture --kind knowledge\|work/);
  assert.match(capture, /change a likely future decision[\s\S]*prevent a repeated failure[\s\S]*route to relevant code/i);
  assert.match(capture, /Reuse discovered\/loaded candidates[\s\S]*same future question[\s\S]*do not repeat a broad search/i);
  assert.match(capture, /250–600 rendered tokens as a soft editing target[\s\S]*retain required facts and gates/i);
  assert.match(capture, /rewrite contradictory current guidance and its title, summary, and `useWhen` together/i);
  assert.match(capture, /revision-aware updates, statuses, and `relatedRecordIds`[\s\S]*preserve history/i);
  assert.match(capture, /observed version, date, and configuration[\s\S]*one-session permissions/i);
  assert.match(capture, /observed positive line, and role[\s\S]*specific explanation/i);

  assert.match(description(workRecord), /owned Execute, Ship, standalone Create PR, blocked-handoff, snapshot(?:,)? or correction boundar/i);
  assert.match(description(workRecord), /requires exact ownership/i);
  assert.match(description(workRecord), /not for reusable guidance, routine progress, batches or orchestrated Create PR/i);
  assert.match(workRecord, /work-capture-input\.json/);
  assert.match(workRecord, /Execute start[\s\S]*None yet\.[\s\S]*not placeholders[\s\S]*TODO[\s\S]*REPLACE_ME/i);
  assert.match(workRecord, /capture --kind work --input -/);
  assert.match(workRecord, /recordPath/);
  assert.match(workRecord, /recoveryInput[\s\S]*manual|manual[\s\S]*recoveryInput/i);
  assert.match(workRecord, /under 2,000 estimated rendered tokens[\s\S]*failure\/conflict[\s\S]*without blocking delivery/i);
  assert.match(workRecord, /gh pr view[\s\S]*outside store locks[\s\S]*pass observed `pullRequest`/i);
  assert.doesNotMatch(workRecord, /--branch-pr-state/);
  const workCaptureInput = fs.readFileSync(WORK_CAPTURE_INPUT_PATH, 'utf8');
  assert.doesNotMatch(workRecord, /branch pointer/i);
  assert.match(workRecord, /one record per exact Execute run[\s\S]*resume revises it[\s\S]*distinct runs never fold/i);
  assert.match(workRecord, /Branches\/PRs may reference multiple records/i);
  assert.match(workRecord, /--source-run-id <exact-run>[\s\S]*alongside other identity flags[\s\S]*receipt derivation/i);
  assert.match(workRecord, /`execution\.state: finalized`[\s\S]*`remainingWork: "None\."`/);
  assert.match(workRecord, /blocked\/failed\/interrupted[\s\S]*non-final[\s\S]*residual/i);
  assert.match(workRecord, /CAPTURE_INPUT_INVALID/);
  assert.match(workCaptureInput, /"execution"[\s\S]*"verificationState"[\s\S]*"pullRequest"/);
  assert.match(workCaptureInput, /unknown\|none\|draft-open\|closed\|merged/);
  assert.doesNotMatch(workCaptureInput, /\|open\|/);
  assert.match(workRecord, /`pullRequest`[\s\S]*unknown\|none\|draft-open\|closed\|merged[\s\S]*bare `open` is invalid/i);
  assert.match(workRecord, /git rev-parse --abbrev-ref HEAD[\s\S]*(?:skip|recovery)/i);
  assert.match(workRecord, /return recovery\/skip if unavailable[\s\S]*without guessing/i);
  assert.match(workRecord, /historical corrections[\s\S]*omitting `--branch`/i);
  assert.match(workRecord, /unknown original branch[\s\S]*never backfill from today's checkout/i);
  assert.match(workRecord, /capture never changes delivery, verification or acceptance authority/i);
  assert.match(workRecord, /spectre-capture\/references\/tagging-policy\.md/);
  assert.match(workRecord, /Complementary fields:/i);
  assert.match(workRecord, /`requestedOutcome`: request; `scope`: boundaries/i);
  assert.match(workRecord, /`actualChanges`: delivered behavior\/artifacts; `reasons`: non-obvious rationale\/trade-offs/i);
  assert.match(workRecord, /`discoveries`: findings and maintained-authority links; `relatedContext`: typed entry points and bounded references/i);
  assert.match(workRecord, /`verification`: observed checks; `remainingWork`: residual implementation/i);
  assert.match(workRecord, /Execute start[\s\S]*`None yet\.`[\s\S]*not placeholders[\s\S]*angle brackets/i);
  assert.match(workRecord, /At owned terminal boundaries[\s\S]*only qualified reusable discoveries absent from maintained guidance[\s\S]*No mandatory knowledge record per completion or added scan\/write boundary/i);
  assert.match(workRecord, /New\/current-run writes[\s\S]*require explicit exact branch evidence/i);
  assert.match(workRecord, /compare independent run-start evidence when available[\s\S]*preserve known same-run branch/i);
  assert.match(workRecord, /capture --kind work --input -[\s\S]*New\/current-run writes add `--branch <exact-branch>`/i);
  assert.match(workRecord, /Historical corrections require `--work-id <id> --expected-revision <revision>`/i);

  assert.match(taggingPolicy, /durable, independently browsable product-area wiki pages/i);
  assert.match(taggingPolicy, /user navigation as the altitude test/i);
  assert.match(taggingPolicy, /Several records alone do not justify a narrower area/i);
  assert.match(taggingPolicy, /one primary area and at most one materially connected secondary area/i);
  assert.match(taggingPolicy, /task, branch, bug, internal mechanism, implementation, and individual-record labels/i);
  assert.match(taggingPolicy, /Reuse existing alias resolution/i);
  assert.match(taggingPolicy, /do not invent a closed vocabulary or merge the live Grove catalog/i);

  assert.match(execute, /exact run[\s\S]*Skill\(spectre-work-record\)[\s\S]*start/i);
  assert.match(execute, /meaningful blocked[\s\S]*resolved[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /terminal completion[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /accepted batch[\s\S]*Skill\(spectre-capture\)[\s\S]*qualifying reusable knowledge/i);
  assert.match(execute, /capture failure[\s\S]*does not block/i);
  assert.match(execute, /IMPLEMENTATION_READY[\s\S]*ACCEPTANCE_PENDING/);
  assert.match(execute, /run finish[\s\S]*then[\s\S]*Skill\(spectre-work-record\)/i);
  assert.match(execute, /--source-run-id/);
  assert.match(execute, /finalized[\s\S]*remainingWork[\s\S]*None\.[\s\S]*independent of Ship/i);
  assert.match(execute, /blocked[\s\S]*non-final/i);

  // Ship now legitimately writes work records before the PR exists, so the old `pre-PR` ban
  // no longer states a boundary; pin the real one: candidate-bounded selection, then refresh.
  assert.match(ship, /Before the first PR side effect[\s\S]*work membership[\s\S]*--candidate/i);
  assert.match(ship, /Still before Create PR[\s\S]*per selected record[\s\S]*never finalize it/i);
  assert.match(ship, /Association annotates only: it never confers finality/i);
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
  assert.match(capture, /explicit user statement[\s\S]*is authoritative[\s\S]*Do not wait for repository corroboration or reconfirmation/i);
  assert.match(capture, /user correction remains valid even without a known code location/i);
  assert.match(capture, /No workflow, feature, run, or PR association[\s\S]*maintained knowledge/i);
  assert.match(workRecord, /exact run\/work identity and applicable branch, PR or repository\/base\/head\/diff association/i);
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
