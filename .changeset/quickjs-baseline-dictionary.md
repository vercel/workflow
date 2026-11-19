---
"@workflow/core": minor
---

Make the QuickJS baseline snapshot reproducible, compress per-run VM snapshots against it as a zstd dictionary, and accept a baseline prebuilt at build time via `workflowEntrypoint(code, { quickjsBaseline })`.
