---
'@workflow/nitro': patch
---

Fix `vite dev` failing to start when a step reaches a Vite virtual module. The initial dev build now runs once Vite's plugin container exists, so those ids resolve instead of erroring.
