---
name: spectre-stages
description: Track and display SPECTRE workflow stage transitions. Use at session start, handoff, and whenever transitioning between major workflow phases. Shows where we are and what's next.
---

# SPECTRE Stage Tracker

Renders the current position in the SPECTRE workflow and announces stage transitions. Use this to maintain orientation across sessions and make handoffs crystal clear.

## The SPECTRE Flow

```
S ── Scope          Research, kickoff, scope definition, requirements
P ── Plan           Implementation plan, task breakdown, architecture
E ── Execute        Build it — wave-based implementation with code review
C ── Clean          Lint, format, inspect, fix — code hygiene pass
T ── Test           Risk-aware test coverage, verify it works
R ── Rebase         Sync with main, resolve conflicts, prepare for merge
E ── End            PR, merge, Linear status, proof of work
```

Each stage has a natural entry skill:

| Stage | Entry Skill | Produces |
|-------|-------------|----------|
| **S** | `/spectre:kickoff` or `/spectre:scope` | Kickoff doc, scope doc |
| **P** | `/spectre:create_plan` → `/spectre:create_tasks` | Plan, task list |
| **E** | `/spectre:execute` | Working code |
| **C** | `/spectre:clean` | Clean codebase |
| **T** | `/spectre:test` | Test coverage |
| **R** | `/spectre:rebase` | Clean branch ready for PR |
| **E** | `/pr` + `/proof` | PR, proof of work, Linear update |

## When to Use This Skill

### 1. Session Start
Show the current stage based on what exists:
- Has kickoff/scope docs but no plan? → **S complete, entering P**
- Has plan + tasks but no code? → **P complete, entering E**
- Has code but tests failing? → **E complete, entering T**
- Fresh start? → **Entering S**

### 2. Stage Transitions
When completing a stage and moving to the next, announce it:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPECTRE ── S → P
 Scope complete. Transitioning to Plan.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 3. Handoffs
Include the stage indicator in every handoff. Format:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPECTRE ── [S] [P]  E   C   T   R   E
                     ▲
              you are here
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Completed stages get brackets. Current stage gets the arrow.

## How to Render

### Stage Bar (compact)

For inline use during conversation:

```
SPECTRE: [S] [P] ▶E  C  T  R  E
```

- `[X]` = completed
- `▶X` = current (in progress)
- ` X` = upcoming

### Stage Transition (full)

When moving between stages:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPECTRE ── P → E
 Plan approved. 7 phases, 4 breakpoints.
 Entering Execute — first wave: scaffold + creative direction.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Handoff Block (for session handoffs)

Append to handoff JSON as `spectre_stage`:

```json
{
  "spectre_stage": {
    "current": "P",
    "completed": ["S"],
    "next": "E",
    "transition_note": "Plan approved. Next session starts with create_tasks → execute."
  }
}
```

And render visually in the handoff message:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPECTRE ── [S] [P]  E   C   T   R   E
                     ▲
              next session starts here
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Stage Detection Logic

To determine the current stage, check for artifacts:

```
S: docs/tasks/{name}/kickoff/ OR docs/tasks/{name}/scope/ exists
P: docs/tasks/{name}/specs/plan.md exists
E: Source files modified since plan creation
C: spectre:clean has been run (check git log for clean commits)
T: spectre:test has been run (check for test coverage commits)
R: Branch is rebased on latest main (git merge-base --is-ancestor)
E: PR exists (gh pr view succeeds)
```

## Non-Linear Flow

SPECTRE is the **default** progression, but stages can be revisited:

- Bug found in T? Jump back to E (fix), then C, T again.
- Scope change during E? Jump back to S, re-plan P, resume E.
- Rebase conflicts in R? May need E (fix conflicts) then C, T, R again.

When jumping back, announce it:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SPECTRE ── [S] [P] [E] [C]  T → E
 Test failures found. Jumping back to Execute to fix.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Integration with Other Skills

### spectre:handoff
When `/spectre:handoff` runs, it should invoke this skill to:
1. Detect the current stage
2. Add `spectre_stage` to the handoff JSON
3. Render the visual stage bar in the handoff message

### spectre:execute
At the start of execute, render:
```
SPECTRE: [S] [P] ▶E  C  T  R  E
```

### spectre:clean / spectre:test / spectre:rebase
Each should render its stage position on entry.

### /pr
On PR creation, render the final stage:
```
SPECTRE: [S] [P] [E] [C] [T] [R] ▶E
```

## Rules

- Always show the stage bar when transitioning or handing off
- Never skip announcing a transition — it's the whole point of this skill
- Completed stages stay bracketed even if we jump back (shows history)
- The handoff JSON should always include `spectre_stage` when this skill is loaded
