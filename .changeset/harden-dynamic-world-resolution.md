---
'@workflow/core': patch
---

Fail with actionable guidance when the world package named by `WORKFLOW_TARGET_WORLD` can't be loaded, instead of surfacing a raw `ERR_MODULE_NOT_FOUND` or a bundler's "expression is too dynamic" stub error.
