---
"@workflow/builders": minor
---

Prebuild the QuickJS baseline snapshot for every production build and ship it as a file next to the flow route, and fail a `WORKFLOW_VM=quickjs` build whose workflow bundle throws in the QuickJS engine.
