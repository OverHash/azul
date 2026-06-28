# Integration Branch: integration/2026-06-28-18-05

## Merge Checklist

| Status | #   | Branch Name                          | Remote | Commit Hash | Description                      |
| ------ | --- | ------------------------------------ | ------ | ----------- | -------------------------------- |
| ☑      | 1   | feat/folder-backed-scripts           | origin | 138c47e     | Ransomwave/azul PR #39           |
| ☑      | 2   | fix/delete-orphans-script-files-only | origin | a743abf     | Preserve non-script orphan files |

## Merge Log

- Merged `feat/folder-backed-scripts` at `138c47e16454060ba26f26feecbacbd1b5039ac6` with no conflicts. Build passed. Verified folder-backed script export support in `src/config.ts`, `src/fs/fileWriter.ts`, and `src/index.ts`.
- Merged `fix/delete-orphans-script-files-only` at `a743abfeb497eac4672ec95c308d9ca4929e626a` with no conflicts. Build passed. Verified orphan cleanup only removes script files via `isScriptFileName` in `src/index.ts`.
