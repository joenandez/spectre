---
name: release
description: Switch persistent Spectre installs between this checkout and the public marketplace, deploy the checkout for local testing, or run the full public GitHub marketplace release workflow including changelog approval, the Substack release article, and the Spectre Typefully draft. Use when asked to activate local or public Spectre, deploy or refresh local installs, release Spectre, publish a version, ship Spectre publicly, or announce a Spectre release.
user-invocable: true
---

# Release

Internal Spectre deployment workflow. Keep local deployment and public release as explicit, separate modes.

## Arguments

Supported invocations:

```text
activate local
activate public
local
public patch
public minor
public major
public X.Y.Z
```

Treat `$ARGUMENTS` as one of these forms. `local` is the backward-compatible alias for `activate local`. `activate public` switches installed sources but does not publish; `public <version>` publishes a release. If the first argument is missing or invalid, ask which mode to run. Never infer or default to a public release.

## Shared Preflight

1. Run `git status --short` and inspect relevant staged and unstaged diffs.
2. Run:

   ```bash
   npm run sync-codex -- --quiet
   npm run sync-codex -- --check --quiet
   node .agents/skills/verify-spectre/scripts/verify.mjs
   ```

3. Stop and fix any sync, test, structure, Codex, or real-CLI failure before deploying.
4. Never stage unrelated files or use `git add -A`.

## Persistent Local Source Activation

`activate local`, `local`, and Public Mode's pre-release deployment activate persistent user-level installs from this checkout. These commands are deployment actions, not a handoff for the user to finish.

Before changing anything, run all four inventory commands and retain their JSON for the final source report:

```bash
codex plugin marketplace list --json
codex plugin list --json
claude plugin marketplace list --json
claude plugin list --json
```

The local and public catalogs intentionally share marketplace name `spectre` and plugin identity `spectre@spectre`; they are alternatives, not side-by-side installs. Mutate only that exact marketplace and plugin. For Claude Code, mutate only user scope. Never remove a project/local-scope declaration; stop if one shadows the requested user source or leaves another enabled `spectre@spectre` install.

### Codex

1. Inspect the `spectre` marketplace. If absent, add this checkout. If its source is not a local path whose real path is `$PWD`, remove the installed plugin if present, remove only the conflicting marketplace, and add this checkout:

   ```bash
   codex plugin remove spectre@spectre
   codex plugin marketplace remove spectre
   codex plugin marketplace add "$PWD"
   ```

   Run only the applicable commands: do not call `plugin remove` when the plugin is absent or `marketplace remove` when the marketplace is absent. Do not run `codex plugin marketplace upgrade` for the requested local source; Codex only upgrades Git marketplaces and reads local marketplaces directly.
2. A local marketplace source does not replace an installed same-version plugin. If `spectre@spectre` remains installed, remove its cached install, then reinstall it. If it is absent, install it directly:

   ```bash
   codex plugin remove spectre@spectre
   codex plugin add spectre@spectre
   ```

3. Rerun both Codex JSON inventory commands. Require exactly one marketplace named `spectre` with `marketplaceSource.sourceType == "local"` and a source whose real path is `$PWD`. Require exactly one enabled `spectre@spectre` entry whose marketplace source is that same local path and whose version matches `plugins/spectre-codex/.codex-plugin/plugin.json`.
4. Resolve that entry's install/cache path and run:

   ```bash
   diff -qr "$PWD/plugins/spectre-codex" "$codex_install_path"
   ```

5. Run the bundled managed-agent repair and compare generated agents to the active Codex agent files:

   ```bash
   PLUGIN_ROOT="$PWD/plugins/spectre-codex" node "$PWD/plugins/spectre-codex/skills/spectre-scope/scripts/ensure-codex-agents.mjs" --ensure --json
   for agent in "$PWD"/plugins/spectre-codex/agents/*.toml; do
     diff -q "$agent" "${CODEX_HOME:-$HOME/.codex}/agents/$(basename "$agent")"
   done
   node bin/spectre.js doctor codex --scope user --project-dir "$PWD"
   ```

Require doctor to exit successfully and report no legacy direct-install state. Treat any marketplace, install, JSON identity, version, enabled-state, byte-comparison, managed-agent comparison, or doctor failure as a failed deployment.
Existing Codex sessions may need a restart before newly installed or updated custom agents are available; report that as the only remaining interactive action.

### Claude Code

1. Inspect the `spectre` marketplace. If absent, add this checkout at user scope. If its source is not a directory whose real path is `$PWD`, uninstall the user plugin if present, remove only the user marketplace declaration, and add this checkout:

   ```bash
   claude plugin uninstall spectre@spectre --scope user --keep-data --yes
   claude plugin marketplace remove spectre --scope user
   claude plugin marketplace add "$PWD" --scope user
   ```

   Run only the applicable commands. If removal exposes a project/local marketplace named `spectre`, stop instead of removing it.
2. Refresh the active local marketplace source:

   ```bash
   claude plugin marketplace update spectre
   ```

3. Marketplace refresh does not replace an installed same-version plugin. If `spectre@spectre` is installed at user scope, remove its cached install while preserving data, then reinstall it. If it is not installed, install it directly:

   ```bash
   claude plugin uninstall spectre@spectre --scope user --keep-data --yes
   claude plugin install spectre@spectre --scope user
   ```

4. Rerun both Claude JSON inventory commands. Require exactly one effective marketplace named `spectre` with `source == "directory"` and a path whose real path is `$PWD`. Require exactly one enabled user-scope `spectre@spectre` entry, no project/local-scope Spectre install, and a version matching `plugins/spectre/.claude-plugin/plugin.json`.
5. Resolve that entry's `installPath` and run:

   ```bash
   diff -qr "$PWD/plugins/spectre" "$spectre_install_path"
   ```

   A zero exit proves the installed plugin cache contains the current checkout bytes. Treat any marketplace, install, JSON identity, version, enabled-state, or byte-comparison failure as a failed deployment.
6. Existing Claude Code sessions still require `/reload-plugins`; report that as the only remaining interactive action.

## Persistent Public Source Activation

`activate public` switches persistent user-level installs to `joenandez/spectre` without creating a version, commit, tag, push, or GitHub release. It does not install from the current checkout.

Run the four inventory commands from Persistent Local Source Activation before changing anything. Apply the same exact-identity and Claude user-scope guards.

### Codex

1. If the current `spectre` marketplace is absent, add `joenandez/spectre`. If it is not a Git marketplace normalized to `https://github.com/joenandez/spectre.git`, remove the installed plugin if present, remove only the conflicting marketplace, and add the public marketplace:

   ```bash
   codex plugin remove spectre@spectre
   codex plugin marketplace remove spectre
   codex plugin marketplace add joenandez/spectre
   ```

   Run only the applicable commands. If the public marketplace is already configured, refresh it with `codex plugin marketplace upgrade spectre` instead of removing it.
2. Remove any remaining cached `spectre@spectre` install and reinstall it from the active marketplace:

   ```bash
   codex plugin remove spectre@spectre
   codex plugin add spectre@spectre
   ```

3. Rerun both Codex JSON inventory commands. Require exactly one marketplace named `spectre`, with `marketplaceSource.sourceType == "git"` and a source normalized to `https://github.com/joenandez/spectre.git`. Require exactly one enabled `spectre@spectre` entry tied to that marketplace.
4. Resolve the marketplace `root`, the plugin source declared by its `.agents/plugins/marketplace.json`, and the installed plugin source/cache path. Require the installed version to match the public marketplace and plugin manifests, then run `diff -qr` between the resolved marketplace plugin root and installed plugin root.
5. Run `ensure-codex-agents.mjs --ensure --json` from the resolved installed public plugin root and compare every bundled agent TOML to `${CODEX_HOME:-$HOME/.codex}/agents/`. Any source, identity, enabled-state, version, byte, or managed-agent mismatch fails activation.

### Claude Code

1. If the current `spectre` marketplace is absent, add `joenandez/spectre` at user scope. If it is not the GitHub marketplace `joenandez/spectre`, uninstall the user plugin if present, remove only the user marketplace declaration, and add the public marketplace:

   ```bash
   claude plugin uninstall spectre@spectre --scope user --keep-data --yes
   claude plugin marketplace remove spectre --scope user
   claude plugin marketplace add joenandez/spectre --scope user
   ```

   Run only the applicable commands. If removal exposes a project/local marketplace named `spectre`, stop instead of removing it. If the public marketplace is already configured, refresh it with `claude plugin marketplace update spectre` instead of removing it.
2. Remove any remaining cached user install while preserving data, then reinstall it from the active marketplace:

   ```bash
   claude plugin uninstall spectre@spectre --scope user --keep-data --yes
   claude plugin install spectre@spectre --scope user
   ```

3. Rerun both Claude JSON inventory commands. Require exactly one effective marketplace named `spectre`, with `source == "github"` and `repo == "joenandez/spectre"`. Require exactly one enabled user-scope `spectre@spectre` entry and no project/local-scope Spectre install.
4. Resolve the marketplace `installLocation`, the plugin source declared by its `.claude-plugin/marketplace.json`, and the installed entry's `installPath`. Require the installed version to match the public marketplace and plugin manifests, then run `diff -qr` between the resolved marketplace plugin root and `installPath`. Any source, identity, scope, enabled-state, version, or byte mismatch fails activation.
5. Existing Claude Code sessions require `/reload-plugins`; report that as the only remaining interactive action.

## Activation Mode

- `activate local`: complete Shared Preflight, then Persistent Local Source Activation.
- `activate public`: complete Persistent Public Source Activation. Do not run checkout preflight as proof of public bytes; verify against the fetched public marketplace snapshot instead.

Neither activation mode bumps versions, commits, pushes, tags, creates a GitHub release, or publishes npm. Finish with `Local source active` or `Public source active`, then report for each runtime the normalized marketplace source, installed identity/version/scope, byte-comparison result, and exact mutation commands actually executed.

## Local Mode

`local` is retained as an alias for `activate local`. Follow Activation Mode exactly and do not present its executed commands as work the user still needs to run.

## Public Mode

Public mode publishes a new version to GitHub for the Claude Code and Codex marketplaces. It requires `patch`, `minor`, `major`, or an exact `X.Y.Z`.

A valid public invocation authorizes the resolved version bump, commits, local tag creation, pushes, and GitHub release publication. Do not ask for separate version, tag, push, or publication confirmation. The release-notes approval in Execution step 7 is the only user approval gate before the software release completes.

A public invocation never authorizes Substack or Typefully publication. Release Communications carries its own gates.

### Version Contract

Bump these public version surfaces in sync:

- `package.json` -> `version`
- `.claude-plugin/marketplace.json` -> top-level `version` and `plugins[0].version`
- `.agents/plugins/marketplace.json` -> top-level `version` and `plugins[0].version`
- `plugins/spectre/.claude-plugin/plugin.json` -> `version`

Do not edit `plugins/spectre/.codex-plugin/plugin.json`; that stale Claude-root Codex manifest was removed. The Codex plugin manifest is generated under `plugins/spectre-codex/.codex-plugin/plugin.json`.

### Execution

1. Resolve and report `current -> next`; continue without a confirmation gate.
2. Inspect and commit relevant non-version changes first:
   - Stage explicit files only.
   - Use a descriptive implementation commit.
   - Leave unrelated dirty files untouched.
3. Complete Shared Preflight. If sync generated new `plugins/spectre-codex/` changes, inspect and commit them before continuing.
4. Update the four Version Contract files and commit only those files with `release: vX.Y.Z`.
5. Require a clean release working tree, then run the complete release gate:

   ```bash
   node .agents/skills/verify-spectre/scripts/verify.mjs --release
   ```

   This must pass before creating or pushing a tag. In particular, GitHub authentication must be proven before irreversible release actions.

6. Complete Persistent Local Source Activation for both Codex and Claude Code from the release checkout.

7. Build a concise user-facing changelog from commits since the previous tag. Write at a 12th-grade reading level: use plain, direct English and avoid internal workflow terms unless a public reader needs them. Frame automatic behavior as what the product now does for users (for example, "Execute now dispatches ready tasks to subagents in parallel regardless of plan size"), not as a capability claim such as "Execute can run tasks in parallel." Use only non-empty `New`, `Changed`, `Fixed`, and `Removed` sections. Ask the user to approve the changelog. Write the approved text to `docs/changelog/vX.Y.Z.md` and use it as the step 9 `--notes-file` source. `docs/` is gitignored, so release-notes and article artifacts never dirty the release tree; never commit them.
8. After changelog approval, create `vX.Y.Z` and run:

   ```bash
   git push
   git push --tags
   ```

9. Create the GitHub release:

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <changelog-file>
   ```

10. Verify the exact public tag and GitHub release:

    ```bash
    git ls-remote --exit-code origin refs/tags/vX.Y.Z
    gh release view vX.Y.Z --json url,tagName,targetCommitish
    ```

11. Finish with `Public release complete: vX.Y.Z`. Include the commit, tag, GitHub release URL, marketplace versions, checks run, the exact local activation commands executed, and the public consumer commands below.
12. Continue into Release Communications. Never withhold the step 11 completion line while a communications step is pending.

## Release Communications

Run only after Public Mode's software release and its remote tag/release verification pass. Activation and Local Mode never run it.

Communications are a separate track from the software release. A blocked, deferred, or failed Substack or Typefully step never invalidates a verified release; report it separately instead of reopening the release.

A public invocation authorizes writing the article artifacts and creating one private Typefully draft. It never authorizes publication. The user owns the Substack publish action. Typefully publication requires its own explicit approval; changelog approval, a supplied Substack URL, or "editing is done" is not publication approval.

### Substack article

Derive a public article from the approved changelog. Keep every factual claim, and widen the framing for readers who do not follow the repository:

- Headline and a one-line deck.
- Short opening on why this release matters.
- Three to five scannable highlights drawn from the changelog sections.
- Install-or-update call to action using the Public Consumer Commands.

Write both artifacts under the gitignored `docs/changelog/` directory:

- `docs/changelog/vX.Y.Z-substack.md` as the editable source.
- `docs/changelog/vX.Y.Z-substack.html` as a self-contained rendered artifact.

The HTML must use semantic headings, lists, and links, contain no local filesystem paths or secrets, and offer a Copy rich text control that writes both `text/html` and `text/plain` when the Clipboard API is available. It must stay usable through ordinary select-and-copy when clipboard access is unavailable. Validate it and keep it local:

```bash
subspace --json html-share validate docs/changelog/vX.Y.Z-substack.html
```

Do not publish that artifact with `html-share create`.

Open the HTML artifact in a companion, then open:

```text
https://spectreblog.substack.com/publish/post
```

in a companion labeled `Spectre Substack Editor`. The user copies, edits, and publishes. Never operate Substack's publish controls. Do not claim publication until the user supplies the resulting public `https://spectreblog.substack.com/p/...` URL.

### Spectre Typefully draft

Before any Typefully action, load and follow the installed `typefully` skill at `.agents/skills/typefully/`. If it is missing, unauthenticated, or its CLI fails, stop the social track, report the exact failure, and leave the verified release complete.

Wait for the published Substack URL. Require an `https` scheme and the `spectreblog.substack.com` host; stop and ask when either does not match. Never invent, guess, or placeholder the article URL.

Resolve social sets live with `social-sets:list`; do not rely on the configured default, which points at a different identity. Select the set named `Spectre` and confirm its connected platforms with `social-sets:get <social_set_id>`. At last check that was social set `326705` (`joenandez_1`), connecting `x` as `@SpectreBuild`, `linkedin` as `spectrebuild`, and `substack` Notes. Verify those live rather than trusting them, and ask the user when the set is absent or ambiguous.

Create exactly one private, unscheduled draft titled `Spectre vX.Y.Z release` covering every connected platform the fetch confirmed, using a single `drafts:create` that passes every confirmed platform to `--platform`. Never create one draft per platform, and never tailor copy per platform: every platform carries identical content, and the user edits per-platform variants in Typefully. Write one short highlight blurb grounded in the changelog and ending in the published Substack URL. Keep it a single post inside the tightest connected limit — `x` at 280 characters — because `substack` Notes never take a thread.

Fetch the created draft and open its native editor URL — the `private_url` the API returns, or `https://typefully.com/?a=<social_set_id>&d=<draft_id>` when it is absent — in the user's external default browser with `open "<url>"`. Never open the Typefully editor in a companion pane; Typefully sign-in fails in the embedded browser. Do not build a separate HTML preview; the native Typefully editor is the review and editing surface. Report that the remote draft is private and unpublished.

Then:

1. Show the final draft text once, with the social set, connected handles, and every platform it covers.
2. Ask explicitly whether to publish now.
3. Only after that approval, call `drafts:publish` once and verify the published result.

### Communications Report

Report separately from the release completion line:

- Substack artifact paths, validation result, and the published article URL or the reason it is still pending.
- Typefully draft URL, social set name and id, exact platforms carrying the shared content, and whether the draft is unpublished or published.
- Any social step that was skipped or blocked, with the exact failure.

## Final Command Record

Always print the exact mutation command branch executed at the end of Activation, Local, or Public Mode as an audit record. The user does not need to rerun it. Do not print templates or branches that did not run.

### Local Source Command Branches

Codex, one-time persistent user-level native plugin install from this checkout:

```bash
codex plugin marketplace add "$PWD"
codex plugin add spectre@spectre
PLUGIN_ROOT="$PWD/plugins/spectre-codex" node "$PWD/plugins/spectre-codex/skills/spectre-scope/scripts/ensure-codex-agents.mjs" --ensure --json
for agent in "$PWD"/plugins/spectre-codex/agents/*.toml; do
  diff -q "$agent" "${CODEX_HOME:-$HOME/.codex}/agents/$(basename "$agent")"
done
node bin/spectre.js doctor codex --scope user --project-dir "$PWD"
```

Codex, switch an existing public source to this checkout:

```bash
codex plugin remove spectre@spectre
codex plugin marketplace remove spectre
codex plugin marketplace add "$PWD"
codex plugin add spectre@spectre
```

Codex, refresh an existing persistent user-level install from the configured local `spectre` marketplace:

```bash
codex plugin remove spectre@spectre
codex plugin add spectre@spectre
PLUGIN_ROOT="$PWD/plugins/spectre-codex" node "$PWD/plugins/spectre-codex/skills/spectre-scope/scripts/ensure-codex-agents.mjs" --ensure --json
for agent in "$PWD"/plugins/spectre-codex/agents/*.toml; do
  diff -q "$agent" "${CODEX_HOME:-$HOME/.codex}/agents/$(basename "$agent")"
done
node bin/spectre.js doctor codex --scope user --project-dir "$PWD"
```

Then restart an existing Codex session if newly installed or updated `spectre_*` custom agents are not visible yet. The remove/add is intentional: Codex's version cache can skip same-version local source changes.

Claude Code, one-time persistent user-level install from this checkout:

```bash
claude plugin marketplace add "$PWD" --scope user
claude plugin install spectre@spectre --scope user
```

Claude Code, switch an existing public source to this checkout:

```bash
claude plugin uninstall spectre@spectre --scope user --keep-data --yes
claude plugin marketplace remove spectre --scope user
claude plugin marketplace add "$PWD" --scope user
claude plugin marketplace update spectre
claude plugin install spectre@spectre --scope user
```

Claude Code, refresh an existing persistent user-level install from the configured local `spectre` directory marketplace:

```bash
claude plugin marketplace update spectre
claude plugin uninstall spectre@spectre --scope user --keep-data --yes
claude plugin install spectre@spectre --scope user
```

Then run `/reload-plugins` in an existing Claude Code session. The uninstall/install is intentional: Claude's version cache can skip same-version local source changes.

### Public Source Command Branches

Codex, one-time install from the public marketplace:

```bash
codex plugin marketplace add joenandez/spectre
codex plugin add spectre@spectre
```

Codex, switch this checkout or another source to the public marketplace:

```bash
codex plugin remove spectre@spectre
codex plugin marketplace remove spectre
codex plugin marketplace add joenandez/spectre
codex plugin add spectre@spectre
```

Codex, refresh an already configured public marketplace:

```bash
codex plugin marketplace upgrade spectre
codex plugin remove spectre@spectre
codex plugin add spectre@spectre
```

Claude Code, one-time user-level install from the public marketplace:

```bash
claude plugin marketplace add joenandez/spectre --scope user
claude plugin install spectre@spectre --scope user
```

Claude Code, switch this checkout or another user source to the public marketplace:

```bash
claude plugin uninstall spectre@spectre --scope user --keep-data --yes
claude plugin marketplace remove spectre --scope user
claude plugin marketplace add joenandez/spectre --scope user
claude plugin install spectre@spectre --scope user
```

Claude Code, refresh an already configured public marketplace:

```bash
claude plugin marketplace update spectre
claude plugin uninstall spectre@spectre --scope user --keep-data --yes
claude plugin install spectre@spectre --scope user
```

Then run `/reload-plugins` in an existing Claude Code session.

### Public Consumer Commands

Print this section only after Public Mode completes successfully.

Codex, fresh user-level install or update from the exact published native plugin:

```bash
# Fresh install
codex plugin marketplace add joenandez/spectre
codex plugin add spectre@spectre

# Existing install
codex plugin marketplace upgrade spectre
codex plugin remove spectre@spectre
codex plugin add spectre@spectre
```

Claude Code, fresh public install:

```text
/plugin marketplace add joenandez/spectre
/plugin install spectre@spectre
```

Claude Code, update an existing public install:

```text
/plugin marketplace update spectre
/plugin update spectre@spectre
/reload-plugins
```

## Escalate If

- Local mode would require a public side effect: stop rather than broadening scope.
- Source activation reveals a project/local-scope Claude marketplace or plugin that conflicts with the requested user source: stop without removing that broader-scope state.
- Public mode has no version argument: ask for one.
- Version surfaces disagree, release gates fail, GitHub authentication is missing, or the tag already exists: stop before tagging.
- Push, GitHub release, remote tag/release verification, source activation, installed-byte comparison, managed-agent comparison, or doctor fails: fix if local and in scope; otherwise report the blocker precisely.
- The `typefully` skill is missing, unauthenticated, or its CLI fails: stop the social track and report it; never reopen the verified software release over it.
- The supplied article URL is not an `https://spectreblog.substack.com/` link, or the `Spectre` social set is missing or ambiguous: stop and ask.
- Any step would publish on Substack or Typefully without explicit approval for that publication: stop.
