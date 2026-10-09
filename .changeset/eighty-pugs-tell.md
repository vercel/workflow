---
'@workflow/builders': patch
'@workflow/nitro': patch
---

Fix `vite dev` failing to start when a step reaches a Vite virtual module by resolving it through the initialized host plugin container.
