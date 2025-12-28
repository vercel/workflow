---
"@workflow/world-postgres": patch
"@workflow/world-local": patch
"@workflow/sveltekit": patch
"@workflow/builders": patch
"@workflow/nitro": patch
"@workflow/utils": patch
"@workflow/world": patch
"@workflow/core": patch
"@workflow/next": patch
"@workflow/web": patch
---

Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.
