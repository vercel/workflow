---
"@workflow/swc-plugin": major
"@workflow/builders": patch
"@workflow/cli": patch
"@workflow/next": patch
"@workflow/rollup": patch
"@workflow/nest": patch
---

**BREAKING CHANGE**: Remove `client` transform mode from SWC plugin. The `client` and `step` modes were nearly identical — both preserved step function bodies, replaced workflow bodies with throw stubs, and emitted the same JSON manifest. The only differences were the step registration mechanism (simple property assignment vs. IIFE) and whether DCE ran. Step mode now absorbs all client-mode behaviors: hoisted variable references for object property steps (so `.stepId` is accessible), and dead code elimination. All integrations that previously used `mode: 'client'` now use `mode: 'step'`.
