# Integration Branch: integration/2026-11-11-13-39

Upstream stable base: `v2.5.0` (`cbab6da7c610ce6a32ef92feecd6a78ed6892f9f`).
Fetched upstream under the explicit update authorization; local main fast-forwarded to this release. No integration commits are added to main.

## Merge Checklist

| Status | # | Branch Name | Remote | Commit Hash | Description |
| ------ | - | ----------- | ------ | ----------- | ----------- |
| ☑ | 1 | feat/folder-backed-scripts | origin | 138c47e16454060ba26f26feecbacbd1b5039ac6 | Ransomwave/azul PR #39 |
| ☑ | 2 | fix/delete-orphans-script-files-only | origin | a743abfeb497eac4672ec95c308d9ca4929e626a | Preserve non-script orphan files |

## Merge Log

- Merged `feat/folder-backed-scripts` at `138c47e16454060ba26f26feecbacbd1b5039ac6`. Manually combined config and daemon conflicts with upstream's coalesced sourcemap/cleanup and inode-based moves; did not restore obsolete incremental sourcemap APIs. Added 2.x init-aware structural creation, directory moves, class changes and safe init-only removal (Folder demotion preserves descendants). Explicit init layout remains stable after its last child is removed. Build and all 88 tests passed, including seven fork regression tests. `liveFsSync.enabled` remains true by default.
- Merged `fix/delete-orphans-script-files-only` at `a743abfeb497eac4672ec95c308d9ca4929e626a`. Resolved import conflict using the existing upstream script-file helper import; preserved upstream per-place orphan-cleanup overrides. Build and all 89 tests passed. Regression checks preserve `AGENTS.md`, JSON, text and image files alongside mapped init/child scripts, while removing unmapped `.lua`/`.luau` scripts.

## Comparison to Previous Integration Branch

Previous integration branch: `integration/2026-06-28-18-05`

### Newly Included Branches

- None

### No Longer Included

- None

### Same Branch, Different Merged Commit

- None (both custom branch tips are unchanged).
