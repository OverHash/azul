# Integration Branch: integration/2026-11-11-13-39

Upstream stable base: `v2.5.0` (`cbab6da7c610ce6a32ef92feecd6a78ed6892f9f`).
Fetched upstream under the explicit update authorization; local main fast-forwarded to this release. No integration commits are added to main.

## Merge Checklist

| Status | # | Branch Name | Remote | Commit Hash | Description |
| ------ | - | ----------- | ------ | ----------- | ----------- |
| ☑ | 1 | feat/folder-backed-scripts | origin | 138c47e16454060ba26f26feecbacbd1b5039ac6 | Ransomwave/azul PR #39 |
| ☐ | 2 | fix/delete-orphans-script-files-only | origin | TBD | Preserve non-script orphan files |

## Merge Log

- Merged `feat/folder-backed-scripts` at `138c47e16454060ba26f26feecbacbd1b5039ac6`. Manually combined config and daemon conflicts with upstream's coalesced sourcemap/cleanup and inode-based moves; did not restore obsolete incremental sourcemap APIs. Added 2.x init-aware structural creation, directory moves, class changes and safe init-only removal (Folder demotion preserves descendants). Explicit init layout remains stable after its last child is removed. Build and all 88 tests passed, including seven fork regression tests. `liveFsSync.enabled` remains true by default.
