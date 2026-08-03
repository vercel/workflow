---
'@workflow/builders': minor
---

Add a `discoverWorkflowsInNodeModules` option (and `WORKFLOW_DISCOVER_NODE_MODULES` env var) to stop workflow discovery from descending into `node_modules`, skipping the cost of scanning third-party dependencies for workflow/step/serde code.
