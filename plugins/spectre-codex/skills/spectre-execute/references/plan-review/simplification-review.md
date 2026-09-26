# Simplification Review

Produce smallest plan equivalent to corrected plan and Scope; both bind. Apply user decisions first; they may add detail.

With a Plan-origin `## Minimum Solution Selection`, make the first trace compare the corrected plan to it. Undeclared owned complexity is `High`: delete, or require minimum-solution reselection if removal fails a requirement. Without a selection, retain current review behavior.

Trace each mechanism, surface, phase, artifact, and test to a requirement, constraint, prerequisite, or verified fact and removal failure. Delete, collapse, reuse, or defer when absent or an established path suffices.

Retain a new complexity boundary only with:

`required now by | simpler local option | why it fails now | removal failure`

Keep one representative happy-path and primary-failure test per distinct required behavior. This pass may add only the minimum replacement detail needed by a larger net reduction.

Use `High` for untraceable complexity or an invalid exception, `Medium` for a material safe reduction, and `Scope Change Required` where reduction changes approved behavior.

Finding schema:

`# | Severity | Action | Location | Finding | Why Safe | Suggested Edit`

Write report first; authorized selected-plan edits only. Report hashes, delete/reuse/defer, exceptions/tests, findings/dispositions, Before → After. Emit receipt: post-write `REPORT_SHA256`/`PLAN_SHA256`.

DONE when decisions are applied, the plan is smaller or every retained boundary proves no safe reduction, and behavior, constraints, hashes, and write bounds survive.
