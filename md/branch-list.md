# from origin

- feat/folder-backed-scripts (Ransomwave/azul PR #39)
- fix/delete-orphans-script-files-only

## Maintenance baseline (2026-11-11)

Both branches independently include upstream stable `v2.5.0` and carry their own regression tests. They do not include the other custom patch or integration checklists.

| Branch | Verified tip | Independent tests |
| ------ | ------------ | ----------------- |
| feat/folder-backed-scripts | `67dac9a619295b4d32028310d81768840b344c75` | 90 passed |
| fix/delete-orphans-script-files-only | `d823621aee317538221cf1faa07e433d279dab85` | 82 passed |

Fresh ordered merges of these tips onto `v2.5.0` required **no conflict resolution** and passed all **91 tests** on Node 24.22.1 and Node 20.20.2. The combined runtime patch files match the previously tested `integration/2026-11-11-13-39` implementation. Feature regressions are in separate test files, and `npm test` discovers compiled tests from `dist` without a shell-specific glob or a hardcoded file list.

These hashes document this verification, not permanent pins. At the next integration, inspect the current local branch tips and record the actual merged hashes in the new checklist. Leave historical integration checklists unchanged.
