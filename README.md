
# SPECTRE: A Workflow for Product Builders

SPECTRE is an Agentic Engineering workflow for Claude Code and Codex designed to help you do ONE THING more, faster, and with higher quality.

**🚀 Ship Product Features**

SPECTRE's workflow covers the complete software development lifecycle - from scoping a feature, finalizing user flows, writing the technical design, generating tasks, executing the tasks, code review, validating and proving the work works, cleaning up, testing, shipping, and generating durable & retrievable knowledge your Agent can find and load when relevant.

It has been tested on brand new codebases and codebases with hundreds of thousands of lines of code. Its been tested building websites, react native apps, native desktop apps, and personal software.

**SPECTRE helps you get higher quality and more consistent results from your coding agent, while they work autonomously for much longer, so 10-100x'ing your typical output feels *easy* and more importantly, *repeatable.***

![SPECTRE — Define it. Build it. Prove it.](./assets/images/spectre-define-it-v1.png)

## ⚡ Quick Start

### Within Claude Code

```bash
# Add marketplace and install
claude plugin marketplace add joenandez/spectre
claude plugin install spectre@spectre
```

Then start building:

```plaintext
/spectre:scope
```

That's it. You just start with 1 command to build features.

### Within Codex

```bash
codex plugin marketplace add joenandez/spectre
codex plugin add spectre@spectre
```

Restart or open a new Codex session after install so managed custom agents can be discovered. Plugin hooks still require Codex trust review.

Then run a Spectre command such as:

```plaintext
$spectre-scope
```

![SPECTRE scope command](./assets/images/spectre-scope.png)

## 🔁 How It Works

All feature work enters through Scope and continues through the adaptive Plan, regardless of the size of the feature.

You really only need to remember `/spectre:scope`; every final agent response guides you to what is next.

Read the "When not to use SPECTRE" below to learn when it isn't the right tool.

### How to use SPECTRE

- run one of the kickoff prompts with your Agent

  - `/spectre:scope` is the primary starting point. It helps you explore the edges of the proposed feature while clarifying what is specifically in, out, future, anti-scope, and maybe. The workflow asks questions to clarify until scope is clear and final.
  - `/spectre:kickoff` is for high ambiguity new features and includes web research to explore what already exists and best practices. use if you have an idea but the exact scope is not clear yet.
  - `/spectre:research` is for highly technical explorations, focused on codebase research "how might we build …” style Qs
  - `/spectre:ux` I usually use after scope, but if the scope is clear from discussion its a good starting point to define user flows, components, and layout for a new feature.

- Your Agent will suggest the most relevant next step in the SPECTRE workflow automatically. For example, `/spectre:ux` if user flows are important, or directly to the full `/spectre:plan` flow to create the implementation plan.

- When context window is full or you reach a natural stopping point, run`/spectre:handoff` to generate a clear summary of the current work, next steps, open Qs, etc. Then start a new session (`/clear`) and your handoff is automatically injected into the next session. You'll see a summary when you start.

  - subsequent `/spectre:handoff` requests will use a subagent to combine to maintain continuity.
  - `/spectre:forget` when you are switching gears and want to clear the handoff context.

- SPECTRE saves canonical feature docs under `.spectre/features/<feature-name>/`, bug reports from `/spectre:fix` under `.spectre/bugs/<bug-name>/`, and `/spectre:handoff` saves branch-keyed session state under `.spectre/handoffs/<branch-name>/`. Keep `.spectre/features/` and `.spectre/bugs/` checked into git so your Agent and teammates can reference durable feature records in the future; handoffs remain local session state.

#### Meta workflows

**Plan → Approve → Execute → Prove → Ship**

Spectre uses "meta skills". Meta Skills are skills that call other skills in one coordinated workflow. Your primary agent manages/orchestrates these workflows while focused subagents handle individual tasks.

| Workflow | What it delivers | When to use it |
| --- | --- | --- |
| `/spectre:plan` | An aligned draft plan and Execute-preflight handoff | Before changing code |
| `/spectre:execute` | Orchestrated implementation, verification, review, and proof | When the plan is ready |
| `/spectre:ship` | Cleanup, testing, rebase, and a pull request | When the feature is ready to check in |

**/spectre:plan** — Scope and right-size the work

`/spectre:plan` classifies the work as XS, S, M, L, or XL based on its semantic shape, uncertainty, available evidence, protected boundaries, and task-graph risk.

It will:

- Create durable Scope and plan artifacts—even for XS changes.
- Add proportional research and create one right-sized aligned draft; Plan owns no review or task pipeline.
- Present a concise alignment brief and a marked Execute handoff for every size.
- Wait for your explicit approval before any code changes.
- Print the exact marked `/spectre:execute` command that starts preflight before any structured work exists.

**/spectre:execute** — Implement, verify, and prove the feature</summary>

`/spectre:execute` guides the primary agent through the full implementation. Run the command that `/spectre:plan` prints when it finishes.

It will:

- For an aligned Plan draft, run the existing scope-safe review, assess safe parallelism, then create and read the normal `execute.md`/`tasks.json` pair.
- Give each `@spectre:dev` subagent in Claude Code—or `@spectre_dev` in Codex—only the context required for its task.
- Run affected verification after every execution wave.
- Add intermediate reviews when the plan records compounding risk.
- Run one opposite-runtime adversarial code review, followed by one consolidated repair pass.
- Finish with `/spectre:prove`, which turns the Scope and UX into explicit acceptance criteria and verifies them through your test harness or another suitable proof tool.
- Capture screenshots or video for visual work, evaluate the evidence and logs, and produce a reviewable `proof.html`.

**/spectre:ship** — Clean up and open the pull request

Run `/spectre:ship` when the feature is ready to check in.

It will:

- Run `/spectre:clean`.
  - `/spectre:prune` removes dead or unreachable code and flags duplication, temporary logs, and generated slop.
  - `/spectre:test` assesses coverage by risk, classifies gaps from P0 through P3, and adds tests for the most important behaviors.
- Run `/spectre:rebase` against the parent branch when one exists.
- Run `/spectre:create_pr` to open the pull request.

## 🛑 When NOT to use SPECTRE

Scope → Plan scales from XS through XL. Use a specialist entry instead in these scenarios:

- XXS changes - copy, layout iteration, styling, etc. These are the one case where the back/forth is by design.
- Read-only diagnosis or review, release operations, and execution of an already-approved artifact do not need a new Scope → Plan cycle.
- Use `/spectre:prototype` for throwaway interaction exploration; repository changes that result from it still return through Scope → Plan.
- For bugs, use `/spectre:fix`; diagnosis remains load-bearing, and any code-changing repair leaves a durable bug report under `.spectre/bugs/<bug-name>/bug-report.md` and waits for approval.
- Massive multi-phase features. SPECTRE is designed for a relatively 'standard' sized feature. If you are building a huge product, and the work needs to be broken up into multiple-phases, typically what I'll do is run one `/spectre:scope` for the complete scope, then work with the agent to break it up into logical phases - saving that doc as `phases.md`. Then I'll run another `/spectre:scope` for the phase I'm building.

## Scenarios where SPECTRE is particularly useful

- Building brand new products. Starting with `/spectre:kickoff` is a great starting point, including web research, identifying existing related products, and creating a high quality kick off document you can then take into `/spectre:scope`.
- Highly ambiguous, highly technical features or questions. `/spectre:research` is excellent for this because it includes usage of the `@spectre:web-research` subagent in Claude Code or `@spectre_web_research` in Codex, which searches the web exhaustively on the topic. The final report is sometimes good enough to jump straight into execution, and is almost always extremely clarifying.
- Building internal developer tools, skills, workflows, personal software. Basically, if you have an idea, and you want to get clear on the scope, the process is generic enough to work for *anything* you want the agent to build.

## 🎯 Core SPECTRE Principles

- Great Inputs → Great Outputs
- Ambiguity is Death
- One Workflow, Every Feature, Any Size, Any Codebase
- Obvious > Clever

## 👻 SPECTRE Purpose

SPECTRE exists because I wanted a consistent, repeatable workflow to get high quality results from Agents.

The more time I spent automating and improving SPECTRE, the faster I could go, the higher quality the results, the less time I spent validating that a feature works at all. My time is now spent 90% on scope/ux planning, big thorny complex problems, dogfooding, and building the machine that builds the machine.

SPECTRE's core premise is actually very simple.

> ### **💀 AMBIGUITY IS DEATH.**

When the scope, ux, and plan are ambiguous, you must rely on the LLM to fill in the blanks. And while sometimes you can get lucky - especially for smaller features - for any *real* technology or product work, ambiguity is how you end up with spaghetti code, conflicts, and AI slop.

Ambiguity is not just about scope. Its also about plans that don't get adversarially reviewed. Code that agents write that doesn't get checked. Agents finishing work without validating that it actually works.

You can get lucky, but in my experience Ambiguity leads to bad products.

Providing the **right** amount of context and specificity can be a lot of work. Just think about the most detailed spec or technical design you’ve ever written. Takes days and sometimes weeks.

BUT --- you can use LLMs to make it EASY to provide that specificity. And that is exactly what SPECTRE does.

### ✅ Workflows = Easy Button

Prompt based workflows that generate canonical docs that you and your Agents are aligned on are how you get the best, highest quality, and most consistent results from AI Coding Agents.

They provide the necessary context, detail, and structure for the agent to ask the right questions, investigate the right details, and generate the right requirements, plans, tasks, code, tests, and more.

They force adversarial reviews, check code quality, teach the agent how to verify that the code *works*, find and clean up mistakes and dead code from dead ends, and more importantly --- they create time & space for you to focus on the most important things.

That the product does exactly what you expected it to do, performantly, securely, and tastefully.

The better your prompt based workflows, the lower the ambiguity, the more AI can take on, the longer AI can work autonomously, the more easily you can multi-task, and suddenly you are 100x'ing your output.

## 📄 Canonical Docs

As a former PM I've lived the value of [Canonical Docs](https://naomi.com/canonical-everything-c85441a84e70) (shout out Naomi Gleit). The reasons they work for Humans are the same reasons they work with AI Agents (see 💀 Ambiguity is Death)

In SPECTRE, the **structured workflows** generate some combination of the following canonical docs under `.spectre/features/<feature-name>/`

- `concepts/scope.md` - what are we building and importantly what are we NOT building
- `ux.md` - the core user flows and components/layouts/interactions
- `specs/plan.md` - aligned technical design and phasing; finalized by Execute preflight before structured work
- `specs/execute.md` - compact execution index generated after Execute preflight
- `specs/tasks.json` - specific parent & sub-tasks generated after Execute preflight
- `execution_state.md` - execution progress tracker when using `/spectre:execute` with a plan SPECTRE did not generate
- `reviews/plan_correctness.md`, `reviews/plan_review.md`, `reviews/task_review.md`, and `reviews/comprehensive_code_review.md` - correctness evidence plus prioritized review feedback
- `validation/validation_gaps.md` - task list of gaps identified from validation
- `proof/proof.json` and `proof/proof.html` - acceptance status and reviewed evidence

Durable project context lives separately in typed record packages under `~/.spectre/projects/.../knowledge/<record-id>/record.json`. Maintained knowledge and work accounts share that revisioned format, so an Agent can discover and verify the relevant context without treating a generated skill file as the source of truth.

### My Workflow Iteration Process

I improve these Skills daily, and I didn't just prompt your Agent to generate these Skills. I iterated over many months, adjusting the prompts based on both the user experience of using them, and the quality of results that I got.

For example:

- I iterated on `/spectre:scope` until I felt like the types of questions actually help me get clear on what I'm building, without asking questions that it could easily get from codebase research
- I iterated on the `/spectre:execute` workflow until it successfully delivered large tasks in a single context window using subagents that deliver completion reports to handoff to the next subagents, use TDD effectively, and autonomously adapt the tasks based on what was discovered DURING development instead of blindly
- I iterated on the `/spectre:clean` and `/spectre:test` workflows until it felt automatic that we were sticking to our linting rules, every new feature was well tested/covered, the commits were grouped logically with the appropriate amount of detail.
- I iterated on the knowledge search/load and capture lifecycle until 1) your Agent reaches for relevant knowledge before an affected decision, 2) the primary captures supported decisions, constraints, corrections, and work outcomes at the workflow boundary, and 3) `/spectre:learn` remains available when I explicitly want to preserve or summarize something.
- I iterated on the `/spectre:handoff` workflow until the status update had the appropriate detail/context, and worked perfectly if I'm working across MANY sessions or just one.
- I added the new `/spectre:prove` workflow when it became clear I was spending far too much time validating the features were built right, and gave the agent a feedback loop to check its own work.
- I iterated on the `/spectre:plan` workflow until I could use it for *everything*. I didn't want to have to make decisions about using native plan mode or Spectre, but I also didn't want a Comprehensive 40m planning workflow for a small feature.

SPECTRE made products like New June and Subspace possible, and it is making it possible for me, an ex-Meta, ex-Amazon Technical Product Manager to build, ship, and iterate on products 100x the complexity of anything I've ever built in the past.

## 🧠 SPECTRE Session Memory

SPECTRE maintains and accumulates context across sessions when you use the /spectre:handoff command. To get the most from SPECTRE's Session Memory, we recommend that you:

1. run /spectre:handoff when you are switching gears or the context window is getting full, and

2. start a new session (`/clear` in Claude Code) so your Agent resumes from the saved context.

### How It Works

When you run /spectre:handoff, a status report will get generated for that session, and automatically loaded into your context window for the next session. You'll see a nice summary when you start the next session (`/clear` in Claude Code).

If you already had previous sessions, a sync subagent (`@spectre:sync` in Claude Code or `@spectre_sync` in Codex) will review the last 3 status updates and merge them into a single continuous session memory.

Voila -- trailing 3 session memory snapshots.

If you want to start fresh — /spectre:forget archives the current branch's active files under `.spectre/handoffs/{branch}/archive/`.

## 🧬 SPECTRE Learn

The more I used SPECTRE and the faster I could build, the more frequently I found myself wanting to reference past work. Debugging sessions, a new architectural pattern, or how a feature works/was built.

SPECTRE keeps durable context in two typed record kinds: maintained **knowledge** and seven-section **work** accounts. A size-bounded startup index exposes only discovery metadata; task-aware search uses canonical tags and paths to find applicable records without loading every body. The primary agent then verifies an exact record load before using it.

### How It Works

The primary captures supported decisions, reusable patterns and constraints, corrections, blockers, and work summaries through the same revision-checked record path. It does this automatically after accepted Execute batches when a capture trigger is present, writes the stable Execute work account at completion, and refreshes that same account before Ship or Create PR opens a draft. Capture never changes acceptance, verification, or PR authority; a save failure is surfaced with recovery input rather than blocking the draft.

`/spectre:learn` is the on-demand route: use it to preserve an evidenced insight or correction, or to request a work summary. A bare invocation can truthfully return a no-op; it does not create a knowledge skill, a startup entry, or a mandatory post-work task.

1. **Bounded discovery** — startup metadata and `knowledge search` return only a relevance-ranked preview: canonical tags, applicability, revision, estimated load size, and an exact load command. Work previews are historical evidence, not active guidance.
2. **Verified retrieval** — when the task subject and a record's use condition match, your Agent uses the neutral knowledge CLI to search and load records, then verifies and loads the full record at that exact revision before relying on it. Linked resources and historical revisions stay opt-in.
3. **Stable work identity** — Execute, Ship, and Create PR carry or resolve the same exact work ID from a run, PR, or candidate association, never from a branch-name guess.

### The Hook + Skill Loop

SPECTRE lets an Agent find applicable context without putting every record body into the conversation.

1. **SessionStart discovery** — every time you start a conversation, SPECTRE supplies a size-bounded metadata index. It names potentially relevant records but does not load their bodies or activate historical claims.

2. **Task-aware search and exact loading** — the Agent narrows by the actual task, canonical tags, and paths; it assesses applicability and verifies the selected record before relying on it. The record's revision token prevents a stale update from silently replacing current guidance.

3. **Workflow capture** — accepted Execute findings are reviewed by the primary for qualifying capture triggers. Execute and Ship maintain a truthful work account across the PR lifecycle, while routine progress, speculation, and duplicate facts remain skips or no-ops.

The result: knowledge compounds across sessions instead of resetting to zero. The more you learn, the faster and more accurate every future session becomes.

### What Gets Captured

| Category | Example |
| --- | --- |
| **Gotchas** | A verified non-obvious constraint, such as a reconnect failure condition |
| **Decisions** | An accepted durable choice with its evidence and applicability |
| **Patterns** | A verified reusable solution, not an incidental code shape |
| **Blockers** | A confirmed blocking condition and its resolution criterion |
| **Work accounts** | Truthful requested outcome, changes, decisions, verification, unknowns, and related context |

## 🤖 Subagents

SPECTRE dispatches specialized subagents for different tasks:

NOTE: You don't even need to know that these subagents exist. The prompts instruct your Agent to call them automatically.

Although I do sometimes use `@spectre:web-research` in Claude Code or `@spectre_web_research` in Codex for web research. It's like mini deep-research.

| Claude Code | Codex | Purpose |
| --- | --- | --- |
| `@spectre:dev` | `@spectre_dev` | Implementation with MVP focus |
| `@spectre:analyst` | `@spectre_analyst` | Understand how code works |
| `@spectre:finder` | `@spectre_finder` | Find where code lives |
| `@spectre:patterns` | `@spectre_patterns` | Find reusable patterns |
| `@spectre:web-research` | `@spectre_web_research` | Web research |
| `@spectre:tester` | `@spectre_tester` | Test automation |
| `@spectre:reviewer` | `@spectre_reviewer` | Independent code review |

## 🛠️ How I Typically use SPECTRE

99.9% of my day is spent using SPECTRE exactly like this.

- start /spectre:scope to get crisp on what's in/out. this is the durable entry for repository-changing work, including one-line changes.

  - if the feature's ux/user flow is unclear to me, or I want to make sure to really nail it, i run /spectre:ux. Its similar to /spectre:scope but focuses on getting clear on the core user flows.

- /spectre:plan to choose the smallest sufficient XS–XL planning path, leave its aligned draft, and review the concise handoff before starting Execute

  - once i have scope/plan, I typically run /spectre:handoff to get a fresh context window with awareness of what we're working on.

- then run /spectre:execute to use parallel subagents to work through the tasks. Execute also runs one final /spectre:code_review and an end-only /spectre:prove pass.

  - side note /spectre:validate is a killer prompt. It breaks down the original tasks and dispatches subagents to verify. find stuff missing all the time with this.

  - when initial execution is complete, i run another /spectre:handoff to get the context window clean for fixes/touch ups.

- for already-approved, tightly bounded autonomous delivery, I use /spectre:delegate as a specialist entry.

- From here — I review the proof and do any additional manual testing and fixing.

  - For bugs, I use `/spectre:fix`; a code-changing repair records the diagnosed work and waits for approval before mutation.

  - If something new comes up, or if the scope is not what I'd hoped, I run a new /spectre:scope cycle from within the project.

  - I liberally use /spectre:handoff here to keep context windows clean as I work through issues, and keep the sessions on track with the progress we're making.

- During the process of manual testing/fixing, I typically accumulate uncommitted changes. /spectre:sweep will get your changes committed, while

  - running and addressing lint
  - running tests and related tests on touched files
  - finding obvious dead code/AI slop, and
  - grouping changes logically with descriptive conventional commits

- Once wrapping up, /spectre:ship is a much deeper cleanup that

  - dispatches subagents to find dead code, duplicates, verifies, lint, commits any stragglers, etc.
  - runs /spectre:test does deep analysis and dispatches subagents to write tests based on a risk-adjusted framework focusing on behavior not implementation details,
  - runs /spectre:rebase to get sync'd up with and address any merge conflicts with the target branch
  - runs /spectre:create_pr to create the final PR.

- Execute and Ship capture qualifying evidence and refresh the same work account automatically. When I have an additional evidenced insight, correction, or work-summary request, I can use `/spectre:learn` on demand; it is not a required post-Ship step.

## 📋 Slash Command Reference

### Core Workflow

| Command | Description |
| --- | --- |
| `/spectre:scope` | Interactive feature scoping |
| `/spectre:plan` | Research codebase, create implementation plan |
| `/spectre:execute` | Wave-based parallel execution with code review |
| `/spectre:delegate` | Autonomous compact flow for already-approved, tightly bounded delivery |
| `/spectre:prove` | User-level acceptance proof with reviewed evidence |
| `/spectre:ship` | Completed-branch closeout: clean, rebase, PR |

### Discovery & Research

| Command | Description |
| --- | --- |
| `/spectre:kickoff` | Deep research for high-ambiguity features |
| `/spectre:research` | Parallel codebase research |

### Session Memory

| Command | Description |
| --- | --- |
| `/spectre:handoff` | Save session state snapshot |
| `/spectre:forget` | Clear memory, archive logs |

### Utilities

These are situational commands.

| Command | Description |
| --- | --- |
| `/spectre:fix` | Diagnose bugs, persist a bug report under `.spectre/bugs/`, and wait for approval before code mutation |
| `/spectre:create_plan` | Internal plan producer used by the adaptive `/spectre:plan` workflow |
| `/spectre:sweep` | Light cleanup pass — lint, test, descriptive commits. Great if i've accumulated a lot of changes and want to check them in while addressing lint/test failures in the process. |
| `/spectre:prototype` | If the UX for a given feature is ambiguous, i live by this Skill. It creates HTML prototypes with your existing design system to get clear on the desired ux and interaction. |
| `/spectre:goal` | Opt-in autonomous goal prompt for a narrowly scoped objective. The core workflow hands off to `/spectre:execute` directly, so use this only when you want an unattended run. |

## 📁 Repository Structure

```plaintext
spectre/
├── .claude-plugin/
│   └── marketplace.json          # Public marketplace catalog
├── plugins/
│   ├── spectre/                   # Canonical plugin source — edit here
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json       # Claude Code plugin manifest
│   │   ├── agents/               # Canonical subagent prompts
│   │   ├── bin/                  # Plugin helper entrypoints
│   │   ├── hooks/                # SessionStart and runtime hooks
│   │   └── skills/               # Canonical workflow skills
│   └── spectre-codex/             # Generated Codex mirror — do not hand-edit
│       ├── .codex-plugin/
│       │   └── plugin.json       # Codex plugin manifest
│       ├── agents/               # Generated Codex agent configs
│       ├── hooks/                # Generated Codex hooks
│       └── skills/               # Generated Codex workflow skills
├── bin/
│   └── spectre.js                # npm CLI entrypoint
├── scripts/
│   ├── sync-codex.cjs            # Canonical → Codex generator/checker
│   └── translators/              # Codex asset translators
├── src/                           # CLI, compatibility, knowledge, and doctor code
├── test/                          # Cross-cutting contract and integration tests
├── package.json
├── AGENTS.md
└── CLAUDE.md
```

## Updating

Skills update automatically when you update the plugin:

`/plugin update spectre@spectre`

## License

MIT License - see LICENSE file for details

## Support and/or Feedback

Issues: https://github.com/joenandez/spectre/issues

Email: joevfernandez@gmail.com

Socials:

- Threads: [@joenandez](https://www.threads.com/joenandez)
- X: [@joenandez](https://www.x.com/joenandez)
- LinkedIn: [@joefernandez](https://www.linkedin.com/in/joefernandez/)
