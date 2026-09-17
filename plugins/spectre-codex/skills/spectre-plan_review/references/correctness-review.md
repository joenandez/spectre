# Correctness Review

Decide whether plan delivers approved Scope in the repository. Scope behavior/success/constraints bind; means are revisable. Keep Scope; label boundary changes `Scope Change Required`.

Check:

- Every requirement reaches a planned change, its integration or consumer, and executable verification.
- Paths, patterns, reuse, dependencies, ordering, ownership, assumptions match evidence.
- Verification covers one representative happy path and primary failure per distinct required behavior; additional cases require another requirement, public boundary, credible regression, or materially different present risk.
- Planned safeguards address concrete risks created by the changed boundaries.

A proposed addition requires: `required now by | simpler local option | why it fails now | verification`.

Report evidence-backed `Blocker`, `High`, `Medium`, or `Scope Change Required` findings; zero findings is valid.

Finding schema:

`# | Severity | Category | Location | Finding | Consequence | Suggested Edit`

Include metadata/hashes, evidence, constraints/tests, findings/dispositions/resulting edits, post-plan hash. Return envelope: Use the injected exact envelope. Don't write.

DONE when every finding is disposed, no Blocker/High remains, scope changes are withheld, and hashes/write bounds pass.
