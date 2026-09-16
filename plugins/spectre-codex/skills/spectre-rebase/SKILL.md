---
name: "spectre-rebase"
description: "👻 | Safe guided git rebase — backup ref, auto-resolve conflicts, and either run affected post-rebase checks or hand advisory verification ownership to an orchestrating parent. Use to rebase the current branch onto a target (e.g. origin/main), especially when conflicts or post-rebase verification are expected. Do NOT use for merges, cherry-picks, interactive history edits, or non-git work."
user-invocable: true
---

# rebase

Rebase the current branch onto a target, resolving conflicts and verifying the result, with a recoverable safety net.

## Inputs
- Target branch from `$ARGUMENTS` (e.g. `origin/main`) and optional `--orchestrated` when a parent workflow owns the next step. If absent, ask which branch to rebase onto.
- Optional `--verification-owner parent`, valid only with `--orchestrated`. It transfers post-rebase verification to the parent; plain `--orchestrated` does not transfer ownership.
- Current branch + working-tree state (read just-in-time via `git status`, never assume).

## Working Set
- The current git branch and its commits ahead of target.
- Project test/lint commands (detect from repo: `npm test`, `pytest`, `cargo test`, `go test`).

## Outputs + DONE
A rebased branch and a **Rebase Summary** returned in-thread (not written to disk):
- Branch `{current} → {target}`; commit count; conflict count; verification result `PASS|QUALIFIED|PARENT_OWNED|NEEDS_AUTHORITY`.
- Per-conflict decision table: `| File | Decision | Rationale |`.
- Smoketest guide grounded in files touched: `{area}: [ ] {behavior to verify}`.
- Safety line: backup ref name + restore command.

**DONE when self-owned:** rebase completes with no remaining conflict markers, commit count validates against expectation, affected verification has no branch-caused failure, unrelated findings are routed, and the summary (including the backup ref + restore command) is delivered.

**REBASE_READY when parent-owned:** rebase completes with no remaining conflict markers, commit count validates against expectation, and the summary records `verification: PARENT_OWNED`. Parent verification is advisory workflow evidence unless its own contract says otherwise; it is not a precondition for PR creation.

## Method / guardrails
1. **Snapshot first.** If the tree is dirty, auto-commit (`git commit -am "chore: snapshot before rebase"`) — no prompt. Then `git fetch origin`.
2. **YOU MUST create a backup ref before rebasing** and surface its restore command in the summary:
   `git branch backup/rebase-$(date +%Y%m%d-%H%M%S)` → restore via `git reset --hard {backup}`. This is the only rollback; never start the rebase without it.
3. Run `git rebase {target}`. For each conflict: resolve favoring the target branch's conventions (no prompts), record `{file}: {decision} — {rationale}`, `git add`, `git rebase --continue`. Repeat until clean.
4. **Verify after resolution** — always confirm commit count and no unexpected changes.
   - Self-owned: run affected lint/typecheck/build plus related tests selected from the rebased diff. Repair branch-caused failures and reverify; record/route unrelated failures; use only a failing focused check at the target SHA for indeterminate attribution. Never run a repository-wide baseline or full suite.
   - `--orchestrated --verification-owner parent`: do not run lint or tests; return `REBASE_READY` with `verification: PARENT_OWNED`.
5. Track every resolution decision as you go (the summary table is a postcondition, not an afterthought).

## Handoff
Return compressed Rebase Summary; `--orchestrated`: no step; parent verification `REBASE_READY`, never DONE.

| Handoff | Details |
|---|---|
| 🧭 **Current phase** | Done |
| 📦 **What was just done** | Result |
| ▶️ **Proposed next step** | Render resolved action. |

Standalone success → `$spectre:spectre-create_pr`; incomplete → exact recovery only.

## Escalate-If
- Conflicts can't be resolved by favoring the target (genuine semantic divergence) → stop, report, leave the rebase in progress for the user.
- A test/lint/build check fails after rebase → keep repairing or route it by attribution; never return a blocker solely because verification is red.
- `--verification-owner parent` is supplied without `--orchestrated`, or the caller does not explicitly accept post-rebase verification ownership → stop before rebase.
- Working tree or target branch state is ambiguous → ask before acting.
