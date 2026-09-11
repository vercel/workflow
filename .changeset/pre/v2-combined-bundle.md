---
'@workflow/core': patch
'@workflow/builders': patch
'@workflow/next': patch
'@workflow/nest': patch
'@workflow/sveltekit': patch
'@workflow/nitro': patch
'@workflow/astro': patch
'@workflow/world': patch
'workflow': patch
---

Merge flow and step routes into a single combined handler that executes steps inline when possible, reducing function invocations and queue overhead.
