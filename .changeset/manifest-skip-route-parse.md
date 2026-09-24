---
'@workflow/builders': patch
---

Read the workflow code literal from the flow route source when building the manifest instead of parsing the whole route, which makes manifest generation about 4x faster for bundled outputs.
