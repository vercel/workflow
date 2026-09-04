---
'@workflow/core': patch
---

QuickJS engine: start invocations by restoring a bundle-hydrated VM-memory snapshot instead of re-evaluating the workflow bundle (~25× faster VM startup; bundles with module-scope randomness or clock reads automatically fall back to fresh evaluation). Disable with `WORKFLOW_QUICKJS_BASELINE_SNAPSHOT=0`.
