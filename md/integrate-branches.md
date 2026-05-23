## Instructions

We need to merge the local feature/fix branches listed in `md/branch-list.md` into a new integration branch for testing.

Using the local `main` branch as the starting point, you **MUST** start a new integration branch with explicit tracking to `origin` to avoid upstream tracking issues. You **MUST** start a new branch; do not reuse a prior integration branch. Name the branch `integration/YYYY-MM-DD-HH-MM`, using the `date` command to get the current date and time.

```bash
BRANCH_NAME="integration/$(date +%Y-%m-%d-%H-%M)"
git switch main
git switch -c "$BRANCH_NAME"
git config "branch.$BRANCH_NAME.remote" origin
git config --unset "branch.$BRANCH_NAME.merge" || true
```

Verify the configuration before continuing:

```bash
git config --list | grep "branch.$BRANCH_NAME"
```

The configuration **MUST** include `branch.$BRANCH_NAME.remote=origin` and **MUST NOT** include a `branch.$BRANCH_NAME.merge` entry.

## Branches to Merge

Merge exactly the branches listed in `md/branch-list.md`, in the order listed:

1. `feat/folder-backed-scripts` from `origin` (`Ransomwave/azul` PR #39)
2. `fix/delete-orphans-script-files-only` from `origin`

You **MUST NOT** include any branch that is not listed in `md/branch-list.md`.

## Critical Rules

- You **MUST NOT** use `git cherry-pick`.
- You **MUST NOT** pull or fetch.
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
| ☐      | 1   | feat/folder-backed-scripts             | origin | TBD         | Ransomwave/azul PR #39              |
| ☐      | 2   | fix/delete-orphans-script-files-only   | origin | TBD         | Preserve non-script orphan files    |

## Merge Log

- No branches merged yet.
```

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

Before the first merge, run the baseline build on the integration branch:

```bash
npm run build
```

Do not start merging until the baseline build passes.

## Step 4: Merge Each Branch Individually

For each branch, stay on the integration branch and run:

```bash
git merge BRANCH_NAME --no-ff -m "Merge BRANCH_NAME"
npm run build
git push origin HEAD
```

If the merge has conflicts:

1. Inspect both branch tips before editing conflicted files.
2. Resolve by combining the active intent of both branches, not by choosing one side wholesale.
3. Avoid resurrecting obsolete code from older ancestry.
4. Run `npm run build` after resolving conflicts.
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
grep "^| ☐ |" MERGED-BRANCHES.md | wc -l
grep "^| ☑ |" MERGED-BRANCHES.md | wc -l
grep "^## Comparison to Previous Integration Branch" MERGED-BRANCHES.md
npm run build
git log origin/main..main --oneline
git status --short --branch
```

Required final state:

- `MERGED-BRANCHES.md` has zero unchecked rows.
- `MERGED-BRANCHES.md` has exactly two checked branch rows.
- The comparison section is present.
- `npm run build` passes.
- Local `main` has not received integration commits.
- The integration branch is pushed to `origin`.
- The working tree is clean.
