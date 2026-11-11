## Instructions

We need to merge the local feature/fix branches listed in `md/branch-list.md` into a new integration branch for testing.

This is a **manual procedure**, not an automated checklist. The authoritative instructions and branch list live on local/remote `integrate-branches`. If absent from the active checkout, read them with `git show integrate-branches:md/integrate-branches.md` and `git show integrate-branches:md/branch-list.md`; do not merge that branch into the integration just to read them.

## Step 0: Preserve State and Select the Base

Before switching branches, installing dependencies, or building, inspect:

```bash
git status --short --branch
git diff -- package-lock.json
git remote -v
git worktree list
git branch -vv
date +%Y-%m-%d-%H-%M
```

- `origin` is **OverHash/azul**; `upstream` is **Ransomwave/azul**. Verify them before fetching or pushing. Never push to `upstream`.
- Preserve existing uncommitted work. Prefer a separate worktree; do not overwrite a dirty lockfile with `npm ci`, silently commit user work, reset, or discard changes. Never silently stash/pop unrelated changes.
- Record the previous local integration branch and its `MERGED-BRANCHES.md`, the original main commit, and both local feature branch tip hashes. Stop if a listed local branch is missing; do not fetch a substitute.
- For a **patch-only integration**, use the existing local `main` and do not fetch or pull.
- When the user requests an **upstream update**, fetching the release base is authorized. Verify the latest stable GitHub release, not an unreleased upstream branch head or prerelease:

```bash
BASE_TAG="$(gh api repos/Ransomwave/azul/releases/latest --jq '.tag_name')"
gh api repos/Ransomwave/azul/releases/latest --jq '{tag_name, published_at, prerelease, target_commitish}'
git fetch upstream "refs/tags/$BASE_TAG:refs/tags/$BASE_TAG"
git rev-parse "$BASE_TAG^{commit}"
```

Use the resolved release tag commit as the base. At the November 2026 update this was `v2.5.0` (`cbab6da7c610ce6a32ef92feecd6a78ed6892f9f`); do not hardcode it for future updates. Fetching does not authorize changing feature branch tips, merging extra branches, pulling, or force-pushing.

In a clean worktree for local `main`, advance it **only by fast-forward** to that release (`git merge --ff-only "$BASE_TAG"`). If main has diverged or contains work not in the release, stop and ask; never reset/rewrite it. If main is already checked out in another worktree, inspect and use that worktree safely rather than checking the same branch out twice. For a dirty active integration checkout, a typical safe setup is:

```bash
git worktree add ../azul-integration-work main
# Run the remaining commands in ../azul-integration-work.
# For an upstream update only:
git merge --ff-only "$BASE_TAG"
```

Record the actual base/main commit after any fast-forward. Do not push integration commits to main.

## Create a Fresh Integration Branch

Using local `main` (fast-forwarded to the verified stable release for an upstream update), you **MUST** start a new branch with explicit `origin` configuration. Name it `integration/YYYY-MM-DD-HH-MM` using `date`. Do not reuse a prior integration branch; if the timestamp already exists, stop and choose a fresh timestamp.

```bash
BRANCH_NAME="integration/$(date +%Y-%m-%d-%H-%M)"
git switch main
git switch -c "$BRANCH_NAME"
git config "branch.$BRANCH_NAME.remote" origin
git config --unset "branch.$BRANCH_NAME.merge" || true
```

Verify the configuration before continuing:

```bash
git config --get "branch.$BRANCH_NAME.remote"
git config --get "branch.$BRANCH_NAME.merge"
```

Before the first push, the remote **MUST** be `origin` and the merge entry **MUST NOT** exist (the second query should return no value and exit 1). Verify both explicitly before continuing. The initial `git push -u origin HEAD` below then intentionally sets tracking to **this integration branch on origin**, not main or upstream.

## Branches to Merge

Merge exactly the branches listed in `md/branch-list.md`, in the order listed:

1. `feat/folder-backed-scripts` from `origin` (`Ransomwave/azul` PR #39)
2. `fix/delete-orphans-script-files-only` from `origin`

You **MUST NOT** include any branch that is not listed in `md/branch-list.md`.

## Critical Rules

- You **MUST NOT** use `git cherry-pick`.
- You **MUST NOT** pull. Fetch is prohibited for patch-only integrations; for an explicitly requested upstream update, fetch only the release base as described above.
- You **MUST** merge only from the local copies of the branches.
- You **MUST** remain on the integration branch throughout the merge process.
- You **MUST** merge branches one by one, in order.
- You **MUST NOT** batch merges.
- You **MUST NOT** rebase the integration branch.
- You **MUST** push the integration branch to `origin` after each successful branch merge.
- You **MUST NOT** use `--ours` or `--theirs` to resolve conflicts. Resolve conflicts manually and preserve the current intent of both branch tips.

## Step 1: Create `MERGED-BRANCHES.md`

Before merging any branches, create `MERGED-BRANCHES.md` in the repository root as the persistent checklist.

Use this initial format:

```markdown
# Integration Branch: integration/YYYY-MM-DD-HH-MM

## Merge Checklist

| Status | #   | Branch Name                            | Remote | Commit Hash | Description                         |
| ------ | --- | -------------------------------------- | ------ | ----------- | ----------------------------------- |
| ☐ | 1   | feat/folder-backed-scripts             | origin | TBD         | Ransomwave/azul PR #39              |
| ☐ | 2   | fix/delete-orphans-script-files-only   | origin | TBD         | Preserve non-script orphan files    |

## Merge Log

- No branches merged yet.
```

Also record the exact base commit/release tag, build runtime, and any preserved user-work location. Use the status cell spacing above so final verification counts work.

Commit and push the initial checklist before merging any branch:

```bash
git add MERGED-BRANCHES.md
git commit -m "Initial MERGED-BRANCHES.md checklist"
git push -u origin HEAD
```

## Step 2: Verify Local Branches Exist

Before merging, verify every branch exists locally:

```bash
git branch --list feat/folder-backed-scripts
git branch --list fix/delete-orphans-script-files-only
```

If any listed branch is missing, stop and ask for guidance. Do **NOT** fetch or pull to create it.

## Step 3: Verify Baseline

Use a supported Node version (2.5.0 requires Node >=20.19; this fork was tested on Node 24.22.1). If mise has no default in a new worktree, prefix npm commands with `mise exec node@24.22.1 --`; do not modify global runtime settings. Install locked dependencies only in the clean integration worktree. Before the first merge:

```bash
npm ci
npm run build
npm test
```

Do not start merging until the baseline build and tests pass. Keep test output in a local log if lengthy. A passing TypeScript build alone does not prove sync compatibility.

## Step 4: Merge Each Branch Individually

For each branch, stay on the integration branch and run:

```bash
git merge BRANCH_NAME --no-ff -m "Merge BRANCH_NAME"
npm run build
npm test
git push origin HEAD
```

If the merge has conflicts:

1. Inspect both branch tips before editing conflicted files.
2. Resolve by combining the active intent of both branches, not by choosing one side wholesale.
3. Avoid resurrecting obsolete code from older ancestry.
4. Run `npm run build` and `npm test` after resolving conflicts.
5. Commit the conflict resolution as part of the merge.

After every successful merge and build, immediately update `MERGED-BRANCHES.md`:

- Change the branch row status from `☐` to `☑`.
- Replace `TBD` with the merged branch tip commit hash.
- Add a short merge-log entry, including any conflict notes.
- Commit and push the checklist update before moving to the next branch.

Example update command:

```bash
git add MERGED-BRANCHES.md
git commit -m "Update MERGED-BRANCHES.md: checked off BRANCH_NAME"
git push origin HEAD
```

## Branch-Specific Verification

Before and after each merge, verify that key branch changes are present.

For `feat/folder-backed-scripts`, verify folder-backed script export support remains present in:

- `src/config.ts`
- `src/fs/fileWriter.ts`
- `src/index.ts`

For `fix/delete-orphans-script-files-only`, verify orphan deletion only removes script files and preserves non-script files.

The maintained feature tips target the 2.5 stable API and carry their own regressions:

- `src/tests/folder_backed.test.ts`: all init script classes/extensions/suffixes, containing-instance creation (not an `init` child), GUID-preserving directory moves and class changes, source edits after moves, init-only removal without destroying descendants, atomic editor saves, and real watcher suppression of Studio-originated ancestor layout changes.
- `src/tests/orphan_cleanup.test.ts`: unmapped `.lua`/`.luau` files are removed; `AGENTS.md`, JSON/text/images and mapped scripts survive; per-place cleanup overrides remain respected. This suite runs independently of the folder-backed branch and also tests init-layout preservation when both branches are integrated.
- `npm test` must discover both suites after both merges. They must pass **with structural sync enabled**. Do not disable `liveFsSync` to hide an init-layout incompatibility.
- Tests must use temporary fixtures, synthetic Studio messages, and ephemeral ports. Do not reconnect/sync/push into a consumer's game for integration verification.

## Preserve Fixes for Next Time

If integration required compatibility fixes, do not leave them solely in merge resolutions. Maintain each feature branch independently against the same stable upstream base: merge the release into it without rebasing or cherry-picking, inspect any reused conflict resolution, preserve its active intent, and include its own tests. Do not merge the entire integration/checklist or the other custom feature into it. Validate each branch alone, then replay the exact ordered merges in a disposable worktree and validate the combination. Push normal fast-forward branch updates only; never force-push. Record the updated tips for the **next** integration without falsifying historical checklist hashes.

## Build and Activate Safely

- Finish with `npm run build` so `dist/cli.js` is current. The break-in-3 wrapper builds and invokes **`~/projects/azul/dist/cli.js`**; building only in another worktree does not activate the update.
- If activation requires switching `~/projects/azul`, inspect its status again. Preserve any user edits explicitly (a named stash plus a patch backup is one option), report the exact recovery reference, and do not blindly reapply an old lockfile over new dependencies. Build/install in the activated checkout and verify its CLI version. Do not leave the same integration branch checked out in two worktrees.
- CLI version probes initialize config too. To avoid editing global config, use a disposable `XDG_CONFIG_HOME` **after** mise, e.g. `mise exec node@24.22.1 -- env XDG_CONFIG_HOME=/tmp/opencode/azul-version-check node dist/cli.js --version`. Create an isolated `azul/config.json` with `{"checkForUpdates": false}` first. Check the real config's checksum before/after.
- CLI and Studio plugin must agree on **major.minor**, e.g. 2.5.x with 2.5.x. Report installation as a user step; do not install/reconnect automatically.
- **Do not run `npm run plugin:build` for offline verification**: as of 2.5.0 it performs a destructive push into Studio. To build offline, call upstream's `buildRojoProject`/`writeRojoProject` with `plugin/plugin.sourcemap.json`, `baseDir` = the plugin directory, `syncDir` = its `sync/`, and `packageRoot` = `sync/ReplicatedFirst/AzulCompanionPlugin.server.luau` resolved under that directory. Write the generated project into a temporary directory, then use Rojo 7.7.0+ `build <project> -o <artifact>.rbxm`. Verify the model's root, bundled sources, and version without executing it in a game. Report the artifact path and need to avoid duplicate installed plugins.
- Inspect config only as needed; do not change global Azul config or consumer files without checking scope. Init-layout consumers need `folderBackedScriptsWithChildren: true`; structural sync should stay enabled once compatible. Do not enable automatic `game.sourcemap.json` packing or perform an unrelated migration.

## Final `MERGED-BRANCHES.md` Section

After all branches are merged and checked off, add this section to the end of `MERGED-BRANCHES.md`:

```markdown
## Comparison to Previous Integration Branch

Previous integration branch: None found locally

No comparison was possible because there is no earlier local integration branch.
```

If a prior local integration branch exists, compare only the branch-level integration checklist against it. Do **NOT** summarize code changes.

Use this structure instead when a prior local integration branch exists:

```markdown
## Comparison to Previous Integration Branch

Previous integration branch: `integration/YYYY-MM-DD-HH-MM`

### Newly Included Branches

- `feat/folder-backed-scripts`
- `fix/delete-orphans-script-files-only`

### No Longer Included

- None

### Same Branch, Different Merged Commit

- None
```

## Final Verification

Before finishing, run:

```bash
rg '^\| ☐ \|' MERGED-BRANCHES.md | wc -l
rg '^\| ☑ \|' MERGED-BRANCHES.md | wc -l
rg '^## Comparison to Previous Integration Branch' MERGED-BRANCHES.md
npm run build
npm test
git rev-parse main
git rev-parse HEAD
git rev-parse "origin/$BRANCH_NAME"
git status --short --branch
```

Required final state:

- `MERGED-BRANCHES.md` has zero unchecked rows.
- `MERGED-BRANCHES.md` has exactly two checked branch rows.
- The comparison section is present.
- `npm run build` and all relevant tests pass; final `dist` is built in the activated wrapper checkout, or activation remains explicitly reported as pending.
- Local `main` equals the recorded base commit (an authorized upstream release fast-forward is okay); it has not received integration commits. Comparing only to stale `origin/main` is not proof either way.
- The integration branch is pushed to `origin`.
- The working tree is clean.
- Final report includes upstream release/base, branch and push status, feature verification, test results, CLI/plugin versions, preserved user work, activation status, and any plugin/config/manual Studio verification steps. Never claim real Studio behavior was validated solely by mocked IPC tests.
