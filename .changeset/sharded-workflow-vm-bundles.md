---
'@workflow/core': patch
'workflow': patch
'@workflow/builders': patch
'@workflow/astro': patch
'@workflow/nest': patch
'@workflow/next': patch
'@workflow/nitro': patch
'@workflow/sveltekit': patch
'@workflow/vitest': patch
---

Add opt-in source-sharded Workflow VM bundles behind
`WORKFLOW_SHARD_VM_BUNDLES=1`. Production builds can select and cache only the
workflow graph needed for a replay while watch builds and the existing default
monolithic bundle remain unchanged.
