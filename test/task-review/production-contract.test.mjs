import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const canonicalSkillDir = join(
  repositoryRoot,
  "plugins",
  "spectre",
  "skills",
  "spectre-task_review",
);
const taskReview = readFileSync(join(canonicalSkillDir, "SKILL.md"), "utf8");

test("production task review owns safety, semantic review, and deterministic closure", () => {
  const orderedContract = [
    "helper's `preflight`",
    "available opposite runtime",
    "Write all findings before edits",
    "helper `validate-report`",
    "runs `validate-pair`",
  ];
  let previousIndex = -1;
  for (const phrase of orderedContract) {
    const index = taskReview.indexOf(phrase, previousIndex + 1);
    assert.ok(index > previousIndex, `${phrase} must appear in orchestration order`);
    previousIndex = index;
  }

  assert.match(taskReview, /Hard failures stop; advisories inform the semantic reviewer/);
  assert.doesNotMatch(taskReview, /Index Alignment Summary/);
  assert.match(taskReview, /Allow up to 20 minutes; quiet output alone is not failure/);
  assert.match(taskReview, /primary may repair mechanical report\/schema metadata/i);
  assert.match(taskReview, /attempt is `complete`/);
});

test("task review runs one authorized review while recovering incomplete routes", () => {
  assert.match(taskReview, /one semantic review per authorized round/i);
  assert.match(taskReview, /--review-again/);
  assert.match(taskReview, /task_review_attempt\.json/);
  assert.match(taskReview, /A completed report ends the round/);
  assert.match(taskReview, /fallback under the same ledger\/report/);
  assert.match(taskReview, /Resume incomplete or `report_ready` state instead of starting another review/);
  assert.match(taskReview, /do not use its retired `impact` operation/);
  assert.match(taskReview, /unresolved\|applied\|skipped\|scope-change/);
  assert.match(taskReview, /pre\/post task hashes/);
  assert.doesNotMatch(taskReview, /task_review_state\.json|task-review-state\/v1/);
  assert.doesNotMatch(taskReview, /IMPACT_JSON|Rerun Parents:|Reused Findings:/);
});

test("production task review gives broad guidance without limiting reviewer judgment", () => {
  assert.match(taskReview, /goal is not checklist completion/i);
  assert.match(taskReview, /correctly and completely translates the reviewed plan/i);
  assert.match(taskReview, /guidance, not an exhaustive taxonomy or a limit/i);
  assert.match(taskReview, /Coverage:/);
  assert.match(taskReview, /Executability:/);
  assert.match(taskReview, /Integration graph:/);
  assert.match(taskReview, /Reference quality:/);
  assert.match(taskReview, /any evidence-backed translation risk/i);
  assert.match(taskReview, /without avoidable rework/i);
  assert.match(taskReview, /Canonical scope and `plan\.md` remain immutable/);
  assert.match(taskReview, /reviewer owns `TASKS_JSON` and `REVIEW_REPORT`/i);
  assert.match(taskReview, /may not invent findings, reinterpret them, or perform semantic task edits/i);
  assert.doesNotMatch(taskReview, /claude -p|codex exec|REVIEW_PROMPT/);
  assert.deepEqual(
    readdirSync(join(canonicalSkillDir, "scripts")).sort(),
    ["task-review-safety.mjs"],
    "production must not gain a reviewer-launcher CLI",
  );
});

test("review gates retain their route-specific models and efforts", () => {
  const planReview = readFileSync(
    join(
      repositoryRoot,
      "plugins",
      "spectre",
      "skills",
      "spectre-plan_review",
      "SKILL.md",
    ),
    "utf8",
  );
  const codeReview = readFileSync(
    join(
      repositoryRoot,
      "plugins",
      "spectre",
      "skills",
      "spectre-code_review",
      "SKILL.md",
    ),
    "utf8",
  );
  const knowledge = readFileSync(
    join(
      repositoryRoot,
      ".agents",
      "skills",
      "feature-codex-spectre-implementation",
      "SKILL.md",
    ),
    "utf8",
  );

  assert.match(planReview, /high effort \(20-minute limit\)/);
  assert.match(planReview, /Codex (?:→|->) Claude Code `opus`/);
  assert.match(planReview, /Claude Code (?:→|->) Codex `gpt-5\.6-sol`/);
  assert.match(planReview, /claude -p --model opus --effort high/);
  assert.match(planReview, /codex exec -C "\$PWD" -m gpt-5\.6-sol -c 'model_reasoning_effort="high"'/);
  assert.match(planReview, /missing, non-zero, absent\/malformed completion receipt, hash mismatch, or out-of-bounds/i);
  assert.match(planReview, /record.*failure.*before one.*same-runtime CLI fallback/i);
  assert.match(planReview, /reviewer writes its report before selected-plan edits/i);
  assert.match(planReview, /primary never writes reviewer findings or plan edits/i);
  assert.match(codeReview, /claude -p --model opus --effort high/);
  assert.match(
    codeReview,
    /-m gpt-5\.6-sol -c 'model_reasoning_effort="high"'/,
  );
  assert.match(
    knowledge,
    /`spectre-task_review`[^\n]*`--model opus --effort medium`[^\n]*model_reasoning_effort="medium"/,
  );
  assert.match(taskReview, /pinned medium effort/);
  assert.match(taskReview, /Codex → Claude `opus`/);
  assert.match(taskReview, /Claude → Codex `gpt-5\.6-sol`/);
  assert.match(taskReview, /no other canonical artifact may change/i);
  assert.match(
    knowledge,
    /`spectre-code_review`[^\n]*`--model opus --effort high`[^\n]*model_reasoning_effort="high"/,
  );
});

test("Plan Review requires a direct-write completion receipt for both external stages", () => {
  const planReviewDir = join(
    repositoryRoot,
    "plugins",
    "spectre",
    "skills",
    "spectre-plan_review",
  );
  const planReview = readFileSync(join(planReviewDir, "SKILL.md"), "utf8");
  const receipt =
    "REVIEW_COMPLETE\\nROUTE <stage|runtime|model|effort>\\nREPORT_SHA256 sha256:<hex>\\nPLAN_SHA256 sha256:<hex>\\nDISPOSITION <updated|no-op>\\nPLAN_REVIEW_<STAGE>_OK";

  assert.match(planReview, new RegExp(receipt.replace(/[|()[\]<>]/g, "\\$&")));
  assert.match(planReview, /2\. \*\*Correctness\.\*\*[\s\S]*inject direct-write receipt below into `REVIEW_PROMPT`/);
  assert.match(planReview, /3\. \*\*Simplification\.\*\*[\s\S]*inject direct-write receipt below into `REVIEW_PROMPT`/);
  for (const name of ["correctness-review.md", "simplification-review.md"]) {
    const prompt = readFileSync(join(planReviewDir, "references", name), "utf8");
    assert.match(prompt, /receipt.*REPORT_SHA256/i);
  }
});

test("Plan Review validates bounded direct reviewer writeback", () => {
  const planReviewDir = join(
    repositoryRoot,
    "plugins",
    "spectre",
    "skills",
    "spectre-plan_review",
  );
  const planReview = readFileSync(join(planReviewDir, "SKILL.md"), "utf8");
  const execute = readFileSync(
    join(repositoryRoot, "plugins", "spectre", "skills", "spectre-execute", "SKILL.md"),
    "utf8",
  );

  assert.match(planReview, /--allowedTools "Read,Grep,Glob,LS,Write,Edit,Bash\(shasum -a 256 \*\)"/);
  assert.match(planReview, /--allowedTools "Read,Grep,Glob,LS,Write,Edit,Bash\(shasum -a 256 \*\)" --output-format text "\$REVIEW_PROMPT"/);
  assert.match(planReview, /-s workspace-write/);
  assert.match(planReview, /external attempt.*launch route\/status.*failure class.*fallback-used/i);
  assert.match(planReview, /reviewer writes its report before selected-plan edits/i);
  assert.match(planReview, /validates completed route, report, hashes\/disposition\/bounds/i);
  assert.match(planReview, /only reports and selected plan may change/i);
  assert.match(planReview, /all else immutable/i);
  assert.match(planReview, /Quiet output is not failure/);
  assert.match(execute, /resume hash-valid partial correctness/i);
  for (const name of ["correctness-review.md", "simplification-review.md"]) {
    const prompt = readFileSync(join(planReviewDir, "references", name), "utf8");
    assert.match(prompt, /Write report first.*authorized selected-plan edits/i);
    assert.match(prompt, /PLAN_SHA256/i);
  }
});

test("Execute owns unified plan preparation with proportional task creation", () => {
  const plan = readFileSync(
    join(repositoryRoot, "plugins", "spectre", "skills", "spectre-plan", "SKILL.md"),
    "utf8",
  );
  const planReviewDir = join(
    repositoryRoot,
    "plugins",
    "spectre",
    "skills",
    "spectre-plan_review",
  );
  const execute = readFileSync(
    join(repositoryRoot, "plugins", "spectre", "skills", "spectre-execute", "SKILL.md"),
    "utf8",
  );
  const planDirect = readFileSync(
    join(repositoryRoot, "plugins", "spectre", "skills", "spectre-execute", "references", "plan-direct.md"),
    "utf8",
  );
  const fixSource = readFileSync(
    join(repositoryRoot, "plugins", "spectre", "skills", "spectre-execute", "references", "fix-source.md"),
    "utf8",
  );
  const architecture = readFileSync(join(repositoryRoot, "Architecture.md"), "utf8");
  const planReview = readFileSync(
    join(planReviewDir, "SKILL.md"),
    "utf8",
  );
  const correctness = readFileSync(
    join(planReviewDir, "references", "correctness-review.md"),
    "utf8",
  );
  const simplification = readFileSync(
    join(planReviewDir, "references", "simplification-review.md"),
    "utf8",
  );

  assert.match(plan, /aligned draft/i);
  assert.match(plan, /\/spectre:spectre-execute <repo-relative plan\.md> --origin plan --preflight-plan <xs\|light\|standard\|comprehensive>/);
  assert.match(plan, /XS → xs; S → light; M\/L → standard; XL → comprehensive/);
  assert.match(plan, /observed record[\s\S]*task_context\.md[\s\S]*raw-byte hash[\s\S]*authority hash/i);
  assert.doesNotMatch(plan, /spectre-plan_review/);
  assert.doesNotMatch(plan, /spectre-create_tasks/);
  assert.doesNotMatch(plan, /spectre-task_review/);
  assert.doesNotMatch(plan, /spectre-goal/);
  const reviewIndex = execute.indexOf("Skill(spectre-plan_review) --auto-apply scope-safe --orchestrated");
  const assessmentIndex = execute.toLowerCase().indexOf("reuse applicable");
  const tasksIndex = execute.indexOf("STRUCTURED invokes existing `Skill(spectre-create_tasks) --orchestrated`");
  assert.ok(reviewIndex >= 0);
  assert.ok(assessmentIndex >= 0);
  assert.ok(tasksIndex > assessmentIndex);
  const dispatchIndex = execute.indexOf("3. **Batch and dispatch.**");
  assert.ok(reviewIndex < dispatchIndex);
  assert.match(execute, /explicit supplied plan wins over ambient task artifacts/i);
  assert.match(execute, /For selected readable plans, resolve root, plan, Scope, depth\/state/i);
  assert.doesNotMatch(execute, /For any explicit readable plan, resolve root/i);
  assert.match(execute, /No-path selected plans receive this preparation before dispatch/i);
  assert.match(execute, /description: \"Execute tasks\/plans with checks\/reviews\/proof\. Use after planning\/resume\. Not for planning, unplanned fixes, or pruning\.\"/i);
  assert.match(execute, /`--preflight-plan <depth>` remains a preparation-depth hint/i);
  assert.match(execute, /depth hint must not create authority pause/i);
  assert.match(execute, /`Execution Mode: direct` is a legacy coordination hint/i);
  assert.match(
    execute,
    /Hash-bound observed size, never depth, decides Plan Review/i,
  );
  assert.match(execute, /XS\/S record `review:not-required:<size>` and skip/i);
  assert.match(execute, /M\+ reuse a closed correctness\+simplification chain only/i);
  assert.match(execute, /external-attempt\/recorded-failure\+fallback provenance/i);
  assert.match(execute, /Review-worthy risk reclassifies M\+/i);
  assert.match(execute, /no hidden XS\/S exception/i);
  assert.match(execute, /No selected readable plan needs a completeness\/header ceremony/i);
  assert.doesNotMatch(execute, /explicit readable plan needs no ceremonial completeness\/header gate/i);
  assert.match(execute, /first selected readable-plan use\/resume[^\n]*read `references\/plan-direct\.md` for preparation state/i);
  assert.match(execute, /Missing assessment dispatches `Skill\(spectre-plan-route\)` to a fresh child agent/i);
  assert.match(execute, /consume child DONE inside the same Execute run before proceeding/i);
  assert.doesNotMatch(execute, /Return recordonly/i);
  assert.match(execute, /reuse applicable/i);
  assert.match(execute, /reroute only if absent\/materially invalidated/i);
    assert.match(execute, /scope-safe byte-only review edits[\s\S]*rebind/i);
    assert.match(execute, /topology\/uncertainty is unchanged/i);
    assert.doesNotMatch(execute, /Re-bind routing to finalized plan/i);
  assert.match(execute, /ATOMIC\/DIRECT use the bounded local workstream\/Active Wave pattern/i);
  assert.match(execute, /dispatch `Skill\(spectre-plan_review\) --auto-apply scope-safe --orchestrated` once to fresh child/i);
  assert.match(planDirect, /Plan Review state \(`not-required:<XS\|S>\|closed`\).*external-attempt/i);
  assert.match(execute, /STRUCTURED invokes existing `Skill\(spectre-create_tasks\) --orchestrated` by fresh child-agent dispatch/i);
  assert.match(execute, /finalized plan path\/hash[\s\S]*closed review evidence[\s\S]*Skill\(spectre-create_tasks\)/i);
  assert.match(execute, /L → standard, XL → comprehensive/i);
  assert.match(execute, /No automatic task review/i);
  assert.match(execute, /Scope\/explicit-design changes remain withheld/i);
  assert.doesNotMatch(
    execute,
    /selected plan\/authority\/review\/pair binding[^\n]*(?:older|unrelated|unprovable)[^\n]*NEEDS_AUTHORITY/i,
  );
  assert.doesNotMatch(execute, /must carry its seven spine sections/i);
  assert.doesNotMatch(execute, /depth hint is invalid[^\n]*NEEDS_AUTHORITY/i);
  assert.match(execute, /Never escalate solely[^\n]*unavailable\/red baseline/i);
  assert.match(execute, /scope-safe result proceeds without a second user gate/i);
  assert.match(execute, /bug-report path\/root or identifying content—not `--origin`—selects `fix`/i);
  assert.match(execute, /load `references\/fix-source\.md`, not Plan preparation/i);
  assert.match(fixSource, /Never invoke `spectre-plan_review`/i);
  assert.match(fixSource, /ATOMIC\/DIRECT[^\n]*coarse-map path/i);
  assert.match(fixSource, /STRUCTURED[^\n]*task-generation path/i);
  assert.match(architecture, /Execute.*reuses applicable plan-routing records.*classifies once when absent/i);

  assert.match(planReview, /reviews\/plan_correctness\.md/);
  assert.match(planReview, /reviews\/plan_review\.md/);
  assert.match(planReview, /selected plan/i);
  assert.match(planReview, /exact selected-plan path/i);
  assert.match(planReview, /root\/path; sources/i);
  assert.match(planReview, /hashes\/disposition\/bounds/i);
  assert.match(planReview, /references\/correctness-review\.md/);
  assert.match(planReview, /references\/simplification-review\.md/);
  assert.match(planReview, /send it verbatim to a fresh reviewer/i);
  assert.match(planReview, /correctness.*closes before.*simplification/i);
  assert.match(correctness, /direct-write receipt/i);
  assert.match(simplification, /Emit receipt: post-write/i);
  assert.match(planReview, /REPORT_SHA256 sha256:<hex>[\s\S]*PLAN_SHA256 sha256:<hex>/i);
  assert.match(planReview, /addressed.*skipped.*unresolved.*scope-change/is);
  assert.match(correctness, /findings\/dispositions\/edits/i);
  assert.match(planReview, /continue same route/i);
  assert.match(planReview, /failed receipt\/hash\/scope\/bounds/i);
  assert.match(planReview, /primary never writes reviewer findings or plan edits/i);
  assert.match(planReview, /A usable review is terminal/i);
  assert.match(planReview, /Reports are deltas; never restate plan/i);
  assert.match(correctness, /concrete risks created by the changed boundaries/i);
  assert.match(correctness, /required now by \| simpler local option \| why it fails now \| verification/i);
  assert.match(simplification, /delete, collapse, reuse, or defer/i);
  assert.match(simplification, /High` for untraceable complexity or an invalid exception/i);
  assert.match(planReview, /plan smaller or no safe reduction/i);
  assert.doesNotMatch(planReview, /Shrinkage is optional/i);
  assert.doesNotMatch(planReview, /same-route report-only repair/i);
  assert.doesNotMatch(planReview, /primary directly edits `plan\.md`/i);
  assert.doesNotMatch(planReview, /Completed-review hard stop/i);
  assert.doesNotMatch(planReview, /--review-again/);
  assert.doesNotMatch(planReview, /plan_review_attempt\.json/);
  assert.doesNotMatch(planReview, /round_status/);
});

test("usable review reports are normalized by the primary without reviewer repair", () => {
  const skill = (name) =>
    readFileSync(
      join(repositoryRoot, "plugins", "spectre", "skills", name, "SKILL.md"),
      "utf8",
    );

  for (const name of ["spectre-plan_review", "spectre-task_review", "spectre-code_review"]) {
    const review = skill(name);
    if (name === "spectre-plan_review") {
      assert.match(review, /A usable review is terminal/i);
      assert.match(review, /primary never writes reviewer findings or plan edits/i);
      assert.doesNotMatch(review, /same-route report-only repair/i);
      continue;
    } else if (name === "spectre-task_review") {
      assert.match(review, /primary may repair mechanical report\/schema metadata/i);
      assert.match(review, /may not invent findings, reinterpret them, or perform semantic task edits/i);
      assert.doesNotMatch(review, /same-route report-only repair/i);
      continue;
    } else {
      assert.match(review, /A usable review ends semantic review/i);
    }
    assert.match(review, /primary may mechanically normalize report-only/i);
    assert.match(review, /severity enums/i);
    assert.doesNotMatch(review, /same-route report-only repair/i);
  }
});

test("preflight leaves task-review and task-definition contracts unchanged", () => {
  const createTasks = readFileSync(
    join(
      repositoryRoot,
      "plugins",
      "spectre",
      "skills",
      "spectre-create_tasks",
      "SKILL.md",
    ),
    "utf8",
  );
  assert.match(createTasks, /--tasks-only/);
  assert.match(createTasks, /--finalize-index/);
  assert.match(
    createTasks,
    /project only `meta`.*phase ids\/titles.*parent ids\/titles.*subtask ids.*`predecessor`.*`unblocks`.*`risk`/is,
  );
  assert.match(createTasks, /leave JSON byte-for-byte unchanged/i);
  assert.match(createTasks, /Phase 0.*real external dependency or capability precondition/is);
  assert.doesNotMatch(createTasks, /always include for COMPREHENSIVE/);
  assert.doesNotMatch(createTasks, /COMPREHENSIVE = full graph with Phase 0/);
  assert.match(taskReview, /continue the same reviewer route for writeback only/i);
  assert.match(taskReview, /one semantic review per authorized round/i);
});
