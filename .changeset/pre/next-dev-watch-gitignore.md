---
'@workflow/next': patch
---

Dev watcher now respects `.gitignore` and a `WORKFLOW_DEV_WATCH_IGNORED_PATHS` env var, avoiding `EMFILE: too many open files` on large monorepos.
